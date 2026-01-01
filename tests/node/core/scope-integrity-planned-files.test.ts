import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { captureWorkspacePlannedFiles, publishWorkspacePlannedFiles, observeWorkspacePlannedFiles,
    assertWorkspacePlannedFilesCurrent } from '../../../src/core/workspace-planned-files';

const root = () => path.join(os.tmpdir(), 'p3-pure-visibility-' + randomUUID());

test('P3 exact visibility keeps immutable sources and does not inherit another repository', () => {
    const repo = root(), files = ['bin/source.sh'];
    publishWorkspacePlannedFiles(repo, 'T-ONE', files);
    files.push('bin/foreign.sh');
    assert.deepEqual(captureWorkspacePlannedFiles(repo).paths, ['bin/source.sh']);
    assert.deepEqual(captureWorkspacePlannedFiles(root()).paths, []);
    assert.throws(() => publishWorkspacePlannedFiles(repo, 'T-ONE', ['../foreign.sh']), /Invalid/u);
});

test('P3 active child visibility survives reading parent task evidence in the same invocation', () => {
    const repo = root();
    withInvocationReadObservation(() => {
        observeWorkspacePlannedFiles(repo, 'T-CHILD', ['bin/child.sh']);
        const captured = captureWorkspacePlannedFiles(repo);
        observeWorkspacePlannedFiles(repo, 'T-PARENT', ['bin/parent.sh']);
        assert.deepEqual(captureWorkspacePlannedFiles(repo).paths, ['bin/child.sh']);
        assertWorkspacePlannedFilesCurrent(repo, captured);
    });
});

test('P3 native scope publication invalidates a generation in another asynchronous context', async () => {
    const repo = root();
    publishWorkspacePlannedFiles(repo, 'T-ONE', ['bin/one.sh']);
    let publish!: () => void;
    const changed = new Promise<void>(resolve => { publish = resolve; });
    const reading = assert.rejects(withInvocationReadObservation(async () => {
        const captured = captureWorkspacePlannedFiles(repo);
        await changed;
        assertWorkspacePlannedFilesCurrent(repo, captured);
    }), /planned-source scope changed/u);
    publishWorkspacePlannedFiles(repo, 'T-ONE', ['bin/two.sh']);
    publish();
    await reading;
});

test('P3 unchanged native re-entry expires the prior publication generation', () => {
    const repo = root();
    publishWorkspacePlannedFiles(repo, 'T-ONE', ['bin/one.sh']);
    const before = captureWorkspacePlannedFiles(repo);
    publishWorkspacePlannedFiles(repo, 'T-ONE', ['bin/one.sh']);
    assert.equal(captureWorkspacePlannedFiles(repo).digest, before.digest, 'semantic visibility is unchanged');
    assert.throws(() => assertWorkspacePlannedFilesCurrent(repo, before), /planned-source scope changed/u);
});

test('P3 hydrated native entry identity expires old readers without a native publication in this process', () => {
    const repo = root();
    observeWorkspacePlannedFiles(repo, 'T-ONE', ['bin/one.sh'], '', 'a'.repeat(64));
    const before = captureWorkspacePlannedFiles(repo);
    observeWorkspacePlannedFiles(repo, 'T-ONE', ['bin/one.sh'], '', 'b'.repeat(64));
    assert.equal(captureWorkspacePlannedFiles(repo).digest, before.digest);
    assert.throws(() => assertWorkspacePlannedFilesCurrent(repo, before), /planned-source scope changed/u);
});
