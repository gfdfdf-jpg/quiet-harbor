import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { getWindowsSystemDirectory } from '../../../src/core/windows-native-environment';
import { assertInvocationDependenciesCurrent, registerInvocationDependency, withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { inspectTrustedWindowsWriteAuthority, inspectTrustedWindowsDirectoryFilePair } from '../../../src/gate-runtime/timeline/windows-acl-authority';
import { captureInvocationMemoTrace, installDerivationIoGuard, replayDerivationObservations } from '../../../src/core/derivation-observation-recorder';
import { parseAclEntries } from '../../../src/gate-runtime/timeline/windows-acl-batch';
import { taskTimelineAwareFileExists, withTaskTimelineFileReadSnapshot, readTaskTimelineTextFile, readTaskTimelineBoundedJsonlTail } from '../../../src/gate-runtime/timeline/task-timeline-read-snapshot';

const windowsOnly = { skip: process.platform !== 'win32' };
function fixture(t: TestContext, count = 3): string[] {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-acl-batch-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return Array.from({ length: count }, (_, index) => {
        const file = path.join(root, `file ${index}.txt`);
        fs.writeFileSync(file, 'unchanged');
        return file;
    });
}
function icacls(args: string[]): void {
    const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'), args,
        { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    assert.equal(result.status, 0, String(result.stderr || result.stdout || result.error));
}
function assertTrusted(files: string[]): void {
    for (const file of files) assert.equal(inspectTrustedWindowsWriteAuthority(file), true);
}

test('independent native ACL readers never prefetch sibling authority', windowsOnly, t => {
    const files = fixture(t);
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        assertTrusted(files); assertTrusted(files);
    }), value => { measurement = value; });
    for (const file of files) for (const phase of ['initial', 'final'])
        assert.equal(measurement!.work[`acl_probe:${phase}:${file}`], 1);
    assert.equal(measurement!.work['subprocess.spawnSync.icacls.exe'], 6);
});

test('owned immediate exists and text readers acquire their root/file pair together', windowsOnly, t => {
    const files = fixture(t);
    for (const read of [() => taskTimelineAwareFileExists(files[0]), () => readTaskTimelineTextFile(files[0])]) {
        const expected = read();
        let measurement: NextStepMeasurement | undefined;
        const value = withNextStepMeasurement(() => withInvocationReadObservation<boolean | string>(read), result => { measurement = result; });
        assert.equal(value, expected);
        assert.equal(measurement!.work['subprocess.spawnSync.icacls.exe'], 3);
    }
});

test('owned bounded tail reader preserves authenticated content with one paired initial probe', windowsOnly, t => {
    const files = fixture(t), file = path.join(path.dirname(files[0]), 'T-PAIR.jsonl');
    fs.writeFileSync(file, '{"value":1}\n');
    const read = () => readTaskTimelineBoundedJsonlTail(file, { maxBytes: 1024, maxLines: 10, maxEvents: 10, maxParseAttempts: 10 });
    const expected = read();
    let measurement: NextStepMeasurement | undefined;
    const value = withNextStepMeasurement(() => withInvocationReadObservation(read), result => { measurement = result; });
    assert.deepEqual(value, expected);
    assert.equal(measurement!.work['subprocess.spawnSync.icacls.exe'], 3);
});

test('owned initial pair supports bounded nested evidence without retaining sibling authority', windowsOnly, t => {
    const files = fixture(t), parent = path.dirname(files[0]), child = path.join(parent, 'evidence');
    fs.mkdirSync(child);
    const nested = path.join(child, 'receipt.json'); fs.writeFileSync(nested, '{}');
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        assert.equal(taskTimelineAwareFileExists(files[0]), true);
    }), value => { measurement = value; });
    assert.equal(measurement!.work['subprocess.spawnSync.icacls.exe'], 3);
    for (const phase of ['initial', 'final']) {
        assert.equal(measurement!.work[`acl_probe:${phase}:${parent}`], 1);
        assert.equal(measurement!.work[`acl_probe:${phase}:${files[0]}`], 1);
        assert.equal(measurement!.work[`acl_probe:${phase}:${nested}`] || 0, 0);
    }
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(taskTimelineAwareFileExists(files[0]), true);
            icacls([nested, '/grant', '*S-1-1-0:(R)']);
            assertTrusted([nested]);
            icacls([nested, '/remove:g', '*S-1-1-0']);
        }), /Invocation Windows ACL observation changed/);
    } finally { icacls([nested, '/remove:g', '*S-1-1-0']); }
});

test('first sibling ACL read observes a change even if that change is restored before final validation', windowsOnly, t => {
    const files = fixture(t), target = files[1];
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assertTrusted([files[0]]);
            icacls([target, '/grant', '*S-1-1-0:(R)']);
            assertTrusted([target]);
            icacls([target, '/remove:g', '*S-1-1-0']);
        }), /Invocation Windows ACL observation changed/);
    } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
});

test('public lazy snapshot observes file ACL at first read inside its callback', windowsOnly, t => {
    const files = fixture(t), target = files[1];
    try {
        assert.throws(() => withInvocationReadObservation(() => withTaskTimelineFileReadSnapshot(target, () => {
            icacls([target, '/grant', '*S-1-1-0:(R)']);
            assert.equal(taskTimelineAwareFileExists(target), true);
            icacls([target, '/remove:g', '*S-1-1-0']);
        })), /Invocation Windows ACL observation changed/);
    } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
});

test('owned pair never rebaselines an already observed directory', windowsOnly, t => {
    const files = fixture(t), parent = path.dirname(files[0]);
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assertTrusted([parent]);
            icacls([parent, '/grant', '*S-1-1-0:(R)']);
            assert.equal(taskTimelineAwareFileExists(files[0]), true);
        }), /Invocation Windows ACL observation changed/);
    } finally { icacls([parent, '/remove:g', '*S-1-1-0']); }
});

test('owned pair never makes unrelated sibling ACLs into authority', windowsOnly, t => {
    const files = fixture(t), target = files[1];
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(taskTimelineAwareFileExists(files[0]), true);
            icacls([target, '/grant', '*S-1-1-0:(R)']);
            assertTrusted([target]);
            icacls([target, '/remove:g', '*S-1-1-0']);
        }), /Invocation Windows ACL observation changed/);
    } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
});

test('batched ACLs reject a read-only grant change although all write verdicts remain trusted', windowsOnly, t => {
    const files = fixture(t), target = files[1];
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(taskTimelineAwareFileExists(target), true);
            icacls([target, '/grant', '*S-1-1-0:(R)']);
        }), /Invocation Windows ACL observation changed/);
    } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
    assert.equal(withInvocationReadObservation(() => inspectTrustedWindowsWriteAuthority(target)), true);
});

test('each explicit validation barrier captures fresh sibling ACLs and failure remains sticky', windowsOnly, t => {
    const files = fixture(t), target = files[2];
    let failure: unknown;
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assertTrusted(files);
            assertInvocationDependenciesCurrent();
            icacls([target, '/grant', '*S-1-1-0:(R)']);
            try { assertInvocationDependenciesCurrent(); } catch (error: unknown) { failure = error; }
            assert.ok(failure instanceof Error);
            icacls([target, '/remove:g', '*S-1-1-0']);
        }), error => error === failure);
    } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
});

test('batched ACLs reject object replacement with unchanged content and permissions', windowsOnly, t => {
    const files = fixture(t), target = files[1];
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(taskTimelineAwareFileExists(target), true);
        fs.renameSync(target, target + '.old');
        fs.writeFileSync(target, 'unchanged');
    }), /Invocation Windows ACL observation changed/);
});

test('a paired observation remains recorded and replay rejects either changed ACL', windowsOnly, t => {
    installDerivationIoGuard();
    const files = fixture(t), parent = path.dirname(files[0]);
    for (const target of [parent, files[0]]) {
        try { assert.throws(() => withInvocationReadObservation(() => {
            const captured = captureInvocationMemoTrace(() => inspectTrustedWindowsDirectoryFilePair(parent, files[0]));
            assert.equal(captured.outcome.returned, true);
            assert.deepEqual(captured.trace.nonCacheableReasons, []);
            assert.equal(captured.trace.observations.length, 2);
            assert.equal(replayDerivationObservations(captured.trace), true);
            icacls([target, '/grant', '*S-1-1-0:(R)']);
            assert.equal(replayDerivationObservations(captured.trace), false);
        }), /Invocation Windows ACL observation changed/);
        } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
    }
});

test('unsupported directories and missing paths retain original read behavior', windowsOnly, t => {
    for (const scenario of ['many', 'unicode', 'junction', 'missing-file', 'missing-root']) {
        const files = fixture(t, scenario === 'many' ? 129 : 3), parent = path.dirname(files[0]);
        if (scenario === 'unicode') fs.writeFileSync(path.join(parent, 'имя.txt'), 'content');
        if (scenario === 'junction') fs.symlinkSync(parent, path.join(parent, 'link'), 'junction');
        const target = scenario === 'missing-file' ? path.join(parent, 'missing.txt')
            : scenario === 'missing-root' ? path.join(parent, 'missing', 'missing.txt') : files[0];
        const expected = taskTimelineAwareFileExists(target);
        let measurement: NextStepMeasurement | undefined;
        const value = withNextStepMeasurement(() => withInvocationReadObservation(() => taskTimelineAwareFileExists(target)),
            result => { measurement = result; });
        assert.equal(value, expected, scenario);
        assert.equal(measurement!.work['acl_batch_hit:initial'] || 0, 0, scenario);
    }
});

test('partial, failed, changed-membership and replaced-object group acquisitions fall back', windowsOnly, t => {
    const native = require('node:child_process') as typeof childProcess, original = native.spawnSync;
    try {
        for (const scenario of ['truncated', 'failure', 'membership', 'nested-membership', 'replacement']) {
            const files = fixture(t), parent = path.dirname(files[0]);
            if (scenario === 'nested-membership') fs.mkdirSync(path.join(parent, 'child'));
            let grouped = 0, individual = 0;
            native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
                const result = original(command, args, options);
                if (!command.toLowerCase().endsWith('icacls.exe')) return result;
                if (!args.includes('/T')) { individual++; return result; }
                grouped++;
                if (scenario === 'truncated') return { ...result, stdout: Buffer.from('partial') };
                if (scenario === 'failure') return { ...result, status: 1 };
                if (scenario === 'membership') fs.writeFileSync(path.join(parent, 'added.txt'), 'new');
                if (scenario === 'nested-membership') fs.writeFileSync(path.join(parent, 'child/added.txt'), 'new');
                if (scenario === 'replacement') {
                    fs.renameSync(files[0], files[0] + '.old');
                    fs.writeFileSync(files[0], 'unchanged');
                }
                return result;
            }) as typeof native.spawnSync;
            assert.equal(withInvocationReadObservation(() => taskTimelineAwareFileExists(files[0])), true, scenario);
            assert.equal(grouped, 1, scenario);
            assert.equal(individual, 4, scenario);
        }
    } finally { native.spawnSync = original; }
});

test('large leaf directories retain individual ACL reads including native retries', windowsOnly, t => {
    const files = fixture(t, 129);
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => assert.equal(taskTimelineAwareFileExists(files[0]), true)), value => { measurement = value; });
    const work = measurement!.work;
    assert.equal(work['acl_batch_hit:initial'] || 0, 0);
    assert.equal(Object.keys(work).filter(key => key.startsWith('acl_batch_probe:')).length, 0);
    let attempts = 0;
    for (const target of [path.dirname(files[0]), files[0]]) for (const phase of ['initial', 'final']) {
        const count = work[`acl_probe:${phase}:${target}`];
        assert.ok(count >= 1 && count <= 2, 'retain each check and its existing transient-timeout retry');
        attempts += count;
    }
    assert.equal(work['subprocess.spawnSync.icacls.exe'], attempts);
});

test('a dependency discovered during validation cannot reuse an earlier final ACL batch', windowsOnly, t => {
    const files = fixture(t), target = files[1];
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assertTrusted([files[0]]);
            registerInvocationDependency({}, () => {
                assertTrusted([target]);
                icacls([target, '/grant', '*S-1-1-0:(R)']);
            });
        }), /Invocation Windows ACL observation changed/);
    } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
});

test('unrecognized group output falls back to all individual native ACL checks', windowsOnly, t => {
    const files = fixture(t);
    const native = require('node:child_process') as typeof childProcess, original = native.spawnSync;
    let grouped = 0, individual = 0;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            const result = original(command, args, options);
            if (!command.toLowerCase().endsWith('icacls.exe')) return result;
            if (args.includes('/T')) {
                grouped++;
                return { ...result, stdout: Buffer.from('incomplete ACL output') };
            }
            individual++;
            return result;
        }) as typeof native.spawnSync;
        withInvocationReadObservation(() => assert.equal(taskTimelineAwareFileExists(files[0]), true));
        assert.equal(grouped, 1);
        assert.equal(individual, 4);
    } finally { native.spawnSync = original; }
});

test('a mutation between existing validators cannot hide behind an earlier final sibling listing', windowsOnly, t => {
    const files = fixture(t), target = files[1];
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assertTrusted([files[0]]);
            registerInvocationDependency({}, () => icacls([target, '/grant', '*S-1-1-0:(R)']));
            assertTrusted([target]);
        }), /Invocation Windows ACL observation changed/);
    } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
});

test('immediate pair readers reject an explicit untrusted writer on either object', windowsOnly, t => {
    const files = fixture(t), parent = path.dirname(files[0]);
    for (const target of [parent, files[0]]) {
        try {
            icacls([target, '/grant', '*S-1-1-0:(W)']);
            assert.throws(() => withInvocationReadObservation(() => taskTimelineAwareFileExists(files[0])),
                /trusted owner\/DACL|snapshot is unavailable/);
        } finally { icacls([target, '/remove:g', '*S-1-1-0']); }
    }
});

test('grouped evidence retains SID fallback and exact descriptor comparison', windowsOnly, t => {
    const files = fixture(t), parent = path.dirname(files[0]), target = files[0];
    const native = require('node:child_process') as typeof childProcess, original = native.spawnSync;
    const record = Buffer.from(target + ' GARDA_UNKNOWN_ACCOUNT:(W)\r\n');
    let descriptors = 0, grouped = 0;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'powershell.exe' && options?.env?.GARDA_ACL_TARGET === target) {
                const stdout = JSON.stringify({ trusted: true, descriptor: ++descriptors === 1 ? 'O:SYG:SYD:(A;;FA;;;SY)' : 'O:SYG:SYD:(A;;FR;;;SY)' });
                return { pid: 0, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
            }
            const result = original(command, args, options);
            if (!command.toLowerCase().endsWith('icacls.exe') || !Buffer.isBuffer(result.stdout)) return result;
            if (args.includes('/T')) {
                grouped++;
                const parsed = parseAclEntries(result.stdout, [parent, ...files]);
                assert.ok(parsed);
                const previous = parsed.get(target)!;
                const start = result.stdout.indexOf(previous);
                assert.ok(start >= 0);
                return { ...result, stdout: Buffer.concat([result.stdout.subarray(0, start), record, result.stdout.subarray(start + previous.length)]) };
            }
            if (args[0] === target) return { ...result, stdout: Buffer.concat([record,
                Buffer.from('\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n')]) };
            return result;
        }) as typeof native.spawnSync;
        assert.throws(() => withInvocationReadObservation(() => assert.equal(taskTimelineAwareFileExists(target), true)),
            /Invocation Windows ACL observation changed/);
        assert.equal(grouped, 1);
        assert.equal(descriptors, 2);
    } finally { native.spawnSync = original; }
});


function wideAclFixture(t: TestContext, aceCount: number): string[] {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-acl-wide-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const principals = [
        'S-1-1-0', 'S-1-2-0', 'S-1-2-1',
        ...[1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20].map(id => `S-1-5-${id}`),
        ...[10, 14, 21].map(id => `S-1-5-64-${id}`), 'S-1-5-80-0', 'S-1-5-113', 'S-1-5-114',
        'S-1-15-2-1', 'S-1-15-2-2', ...[1, 2, 3, 4, 5, 6].map(id => `S-1-18-${id}`),
        ...[544, 545, 546, 558, 559, 562, 568, 573, 578, 580, 581].map(id => `S-1-5-32-${id}`)
    ];
    let granted = 0;
    for (const sid of principals) {
        const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'),
            [root, '/grant', `*${sid}:(OI)(CI)(R)`], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (result.status === 1332) continue; // Some well-known accounts are absent on a particular host.
        assert.equal(result.status, 0, String(result.error || result.stderr));
        if (++granted === aceCount) break;
    }
    assert.ok(granted > 0, 'The fixture must have inheritable ACL entries.');
    const nameLength = 252 - root.length - 1;
    assert.ok(nameLength >= 32, 'The fixture must leave room for wide native paths.');
    return Array.from({ length: 120 }, (_, index) => {
        const prefix = `T-WIDE-${String(index).padStart(3, '0')}-`;
        const file = path.join(root, prefix + 'x'.repeat(nameLength - prefix.length - 5) + '.json');
        fs.writeFileSync(file, 'unchanged');
        return file;
    });
}

function assertNativeOverflow(parent: string, boundary: number): number {
    const native = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'), [parent, '/T'],
        { maxBuffer: 4 * 1024 * 1024, timeout: 5000, windowsHide: true });
    assert.equal(native.status, 0, String(native.error));
    assert.ok(native.stdout.length > boundary, `The fixture must exceed ${boundary} bytes of native ACL output.`);
    const overflow = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'), [parent, '/T'],
        { maxBuffer: boundary, timeout: 5000, windowsHide: true });
    assert.equal((overflow.error as NodeJS.ErrnoException | undefined)?.code, 'ENOBUFS');
    return native.stdout.length;
}

test('bounded wide ACL records do not repeat individual acquisition after the old native buffer overflow', windowsOnly, t => {
    const files = wideAclFixture(t, 14), parent = path.dirname(files[0]);
    assert.ok(assertNativeOverflow(parent, 256 * 1024) < 1024 * 1024);
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        assert.equal(taskTimelineAwareFileExists(files[0]), true);
    }), value => { measurement = value; });
    assert.equal(measurement!.work['subprocess.spawnSync.icacls.exe'], 3);
});

test('current native batch overflow falls back to individual ACL checks', windowsOnly, t => {
    const files = wideAclFixture(t, 46), parent = path.dirname(files[0]);
    assertNativeOverflow(parent, 1024 * 1024);
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        assert.equal(taskTimelineAwareFileExists(files[0]), true);
    }), value => { measurement = value; });
    assert.equal(measurement!.work['acl_batch_fallback:native-read'], 1);
    assert.equal(measurement!.work['subprocess.spawnSync.icacls.exe'], 5);
});
