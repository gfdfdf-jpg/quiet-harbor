import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { runGit } from '../../../src/core/git-helpers';
import { collectGitChangeClassificationSnapshot } from '../../../src/core/git-change-classification';
import { tryReadSmallInvocationGitBatch, withInvocationGitReadObservation } from '../../../src/core/invocation-git-observation';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { captureInvocationMemoTrace, installDerivationIoGuard, replayDerivationObservations } from '../../../src/core/derivation-observation-recorder';

function fixture(t: TestContext, content = 'before\n'): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-small-blob-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    runGit(root, ['init', '-q']);
    fs.writeFileSync(path.join(root, 'file.txt'), content);
    runGit(root, ['add', 'file.txt']);
    // An unborn index is sufficient to exercise the real classification and blob reader.
    fs.writeFileSync(path.join(root, 'file.txt'), 'after\n');
    return root;
}

function observed(root: string): { value: ReturnType<typeof collectGitChangeClassificationSnapshot>; measurement: NextStepMeasurement } {
    let measurement: NextStepMeasurement | undefined;
    const value = withNextStepMeasurement(() => withInvocationGitReadObservation(() =>
        withInvocationReadObservation(() => collectGitChangeClassificationSnapshot(root))), result => { measurement = result; });
    return { value, measurement: measurement! };
}

test('small Git blobs share one bounded content batch and still revalidate the native output', t => {
    const root = fixture(t), expected = collectGitChangeClassificationSnapshot(root);
    const native = require('node:child_process') as typeof childProcess, original = native.execFileSync;
    const calls: string[][] = [];
    try {
        native.execFileSync = ((command: string, args: string[], options: childProcess.ExecFileSyncOptions) => {
            if (args.includes('cat-file')) calls.push([...args]);
            return original(command, args, options);
        }) as typeof native.execFileSync;
        const { value, measurement } = observed(root);
        assert.deepEqual(value, expected);
        assert.equal(measurement.work.git_small_blob_batch, 1);
        assert.equal(measurement.work.git_small_blob_batch_fallback || 0, 0);
        assert.equal(calls.length, 2, 'one complete native batch initially and again at the freshness barrier');
        assert.ok(calls.every(args => args.includes('--batch') && !args.includes('--batch-check')));
    } finally { native.execFileSync = original; }
});

test('large Git blobs retain classification parity through the original bounded reader', t => {
    const root = fixture(t, 'x'.repeat(2 * 1024 * 1024));
    const expected = collectGitChangeClassificationSnapshot(root);
    const { value, measurement } = observed(root);
    assert.deepEqual(value, expected);
    assert.equal(measurement.work.git_small_blob_batch_fallback, 1);
});

test('accepted small blob bytes remain a live Git dependency through final validation', t => {
    const root = fixture(t);
    const native = require('node:child_process') as typeof childProcess, original = native.execFileSync;
    let changed = false, reads = 0;
    try {
        native.execFileSync = ((command: string, args: string[], options: childProcess.ExecFileSyncOptions) => {
            const result = original(command, args, options);
            if (!args.includes('cat-file') || !args.includes('--batch') || !Buffer.isBuffer(result)) return result;
            reads++;
            if (!changed) return result;
            const copy = Buffer.from(result), start = copy.indexOf(0x0a) + 1;
            copy[start] ^= 1;
            return copy;
        }) as typeof native.execFileSync;
        assert.throws(() => withInvocationGitReadObservation(() => withInvocationReadObservation(() => {
            collectGitChangeClassificationSnapshot(root);
            changed = true;
        })), /Invocation Git observation changed/);
        assert.equal(reads, 2);
    } finally { native.execFileSync = original; }
});

test('incomplete optional Git content is discarded before the original checked reader is used', t => {
    const root = fixture(t), expected = collectGitChangeClassificationSnapshot(root);
    const native = require('node:child_process') as typeof childProcess, original = native.execFileSync;
    let declined = 0;
    try {
        native.execFileSync = ((command: string, args: string[], options: childProcess.ExecFileSyncOptions) => {
            const result = original(command, args, options);
            if (args.includes('cat-file') && args.includes('--batch') && options.maxBuffer === 1024 * 1024) {
                declined++;
                assert.ok(Buffer.isBuffer(result));
                return result.subarray(0, result.length - 1);
            }
            return result;
        }) as typeof native.execFileSync;
        const { value, measurement } = observed(root);
        assert.deepEqual(value, expected);
        assert.equal(declined, 1, 'an unaccepted partial probe is not later presented as authority');
        assert.equal(measurement.work.git_small_blob_batch_fallback, 1);
    } finally { native.execFileSync = original; }
});

test('accepted and declined small Git probes remain recorded and replayable without native guard exceptions', t => {
    installDerivationIoGuard();
    for (const [content, accepted] of [['small\n', true], ['x'.repeat(2 * 1024 * 1024), false]] as const) {
        const root = fixture(t, content);
        const objectId = runGit(root, ['ls-files', '--stage']).split(/\s/u)[1];
        withInvocationGitReadObservation(() => withInvocationReadObservation(() => {
            const captured = captureInvocationMemoTrace(() => tryReadSmallInvocationGitBatch(root, [objectId], 5000, () => true));
            assert.equal(captured.outcome.returned, true);
            if (captured.outcome.returned) assert.equal(Buffer.isBuffer(captured.outcome.value), accepted);
            assert.deepEqual(captured.trace.nonCacheableReasons, []);
            assert.equal(captured.trace.observations.length, 1);
            assert.equal(replayDerivationObservations(captured.trace), true);
        }));
    }
});

test('malformed size headers and extra header fields decline the optional Git probe', t => {
    const root = fixture(t), expected = collectGitChangeClassificationSnapshot(root);
    const native = require('node:child_process') as typeof childProcess, original = native.execFileSync;
    try {
        for (const suffix of ['junk', ' extra']) {
            native.execFileSync = ((command: string, args: string[], options: childProcess.ExecFileSyncOptions) => {
                const result = original(command, args, options);
                if (args.includes('cat-file') && args.includes('--batch') && options.maxBuffer === 1024 * 1024 && Buffer.isBuffer(result)) {
                    const end = result.indexOf(0x0a);
                    return Buffer.concat([result.subarray(0, end), Buffer.from(suffix), result.subarray(end)]);
                }
                return result;
            }) as typeof native.execFileSync;
            const { value, measurement } = observed(root);
            assert.deepEqual(value, expected);
            assert.equal(measurement.work.git_small_blob_batch_fallback, 1);
        }
    } finally { native.execFileSync = original; }
});
