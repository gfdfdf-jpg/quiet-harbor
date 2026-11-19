import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { inspectTrustedWindowsWriteAuthority } from '../../../src/gate-runtime/timeline/windows-acl-authority';
import { WINDOWS_ACL_NATIVE_TIMEOUT_MS, WINDOWS_ACL_OBSERVATION_BUDGET_MS, WindowsAclEvidenceUnavailableError } from '../../../src/gate-runtime/timeline/windows-acl-batch';
import { captureTaskTimelineAppendAuthority, readTaskTimelineTextFile, taskTimelineAwareFileExists } from '../../../src/gate-runtime/timeline/task-timeline-read-snapshot';

const windowsOnly = { skip: process.platform !== 'win32' };
const native = require('node:child_process') as typeof childProcess;

function fixture(t: TestContext): string {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-unavailable-acl-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'T-ACL.jsonl');
    fs.writeFileSync(file, '{}\n');
    return file;
}

function timeout(): childProcess.SpawnSyncReturns<Buffer> {
    return { pid: 0, status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
        error: Object.assign(new Error('native observation timed out'), { code: 'ETIMEDOUT' }) };
}

function unavailable(error: unknown): boolean {
    assert.ok(error instanceof WindowsAclEvidenceUnavailableError);
    assert.equal(error.code, 'GARDA_WINDOWS_ACL_UNAVAILABLE');
    assert.match(error.message, /Retry in PowerShell: & '.+icacls.exe' '.+'; then rerun/u);
    assert.doesNotMatch(error.message, /authority changed|observation changed|not trusted/u);
    return true;
}

test('a transient individual timeout retries without rebaselining or adding attempts', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    let calls = 0;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe') {
                calls++;
                assert.ok(Number(options.timeout) > 0 && Number(options.timeout) <= WINDOWS_ACL_NATIVE_TIMEOUT_MS);
                if (calls === 1) return timeout();
            }
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.equal(withInvocationReadObservation(() => inspectTrustedWindowsWriteAuthority(file)), true);
        assert.equal(calls, 3, 'one failed acquisition, one retry, one final observation');
    } finally { native.spawnSync = original; }
});

test('a transient paired timeout retries the same bound objects and still validates each final ACL', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    let pairs = 0, individuals = 0;
    let measurement: NextStepMeasurement | undefined;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe') {
                if (args.includes('/T')) { pairs++; if (pairs === 1) return timeout(); }
                else individuals++;
            }
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.equal(withNextStepMeasurement(() => withInvocationReadObservation(() => readTaskTimelineTextFile(file)),
            value => { measurement = value; }), '{}\n');
        assert.equal(pairs, 2);
        assert.equal(individuals, 2, 'both final observations stay independent');
        assert.equal(Object.entries(measurement!.work).filter(([key]) => key.startsWith('acl_batch_probe:initial:'))
            .reduce((sum, [, count]) => sum + count, 0), 1, 'one logical pair request cannot grant two batches of acquisition credit');
        assert.equal(Object.entries(measurement!.work).filter(([key]) => key.startsWith('process:') && key.split(':')[2] === 'icacls.exe')
            .reduce((sum, [, count]) => sum + count, 0), 4, 'all native attempts, including the timeout, remain measured');
        assert.equal(measurement!.work['subprocess_timeout:icacls.exe'], 1);
    } finally { native.spawnSync = original; }
});

test('paired retries never renew an exhausted observation deadline', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync, now = Date.now;
    let calls = 0, clock = now();
    try {
        Date.now = () => clock;
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe') {
                calls++;
                clock += WINDOWS_ACL_OBSERVATION_BUDGET_MS;
                return timeout();
            }
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.throws(() => withInvocationReadObservation(() => readTaskTimelineTextFile(file)), unavailable);
        assert.equal(calls, 1, 'no second native launch after the original deadline');
        assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
    } finally { native.spawnSync = original; Date.now = now; }
});

test('exhausted initial and final observations are unavailable and the next invocation can retry', windowsOnly, t => {
    for (const phase of ['initial', 'final']) {
        const file = fixture(t), original = native.spawnSync;
        let calls = 0, fail = phase === 'initial';
        try {
            native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
                if (path.basename(command).toLowerCase() === 'icacls.exe') { calls++; if (fail) return timeout(); }
                return original(command, args, options);
            }) as typeof native.spawnSync;
            assert.throws(() => withInvocationReadObservation(() => {
                assert.equal(inspectTrustedWindowsWriteAuthority(file), true);
                fail = true;
            }), unavailable);
            assert.equal(calls, phase === 'initial' ? 2 : 3);
            fail = false;
            assert.equal(withInvocationReadObservation(() => inspectTrustedWindowsWriteAuthority(file)), true);
        } finally { native.spawnSync = original; }
    }
});

test('a timed-out pair does not spawn individual fallbacks or manufacture a missing snapshot', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    let calls = 0;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe') {
                assert.ok(Number(options.timeout) > 0 && Number(options.timeout) <= WINDOWS_ACL_NATIVE_TIMEOUT_MS);
                calls++;
                return timeout();
            }
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.throws(() => withInvocationReadObservation(() => taskTimelineAwareFileExists(file)), unavailable);
        assert.equal(calls, 2, 'two bounded pair attempts, no individual fallbacks');
        assert.deepEqual(fs.readFileSync(file), Buffer.from('{}\n'));
    } finally { native.spawnSync = original; }
    assert.equal(withInvocationReadObservation(() => readTaskTimelineTextFile(file)), '{}\n');
});

test('an untrusted ACL acquired after a paired timeout still refuses the read', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    let pairs = 0;
    const change = (args: string[]) => {
        const result = original(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), args,
            { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
        assert.equal(result.status, 0, String(result.error || result.stderr));
    };
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe' && args.includes('/T') && ++pairs === 1) {
                change([file, '/grant', '*S-1-1-0:(W)']);
                return timeout();
            }
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.throws(() => withInvocationReadObservation(() => readTaskTimelineTextFile(file)), /^Error: Task timeline snapshot is unavailable:/u);
        assert.equal(withInvocationReadObservation(() => inspectTrustedWindowsWriteAuthority(file)), false, 'the acquired untrusted grant is a negative authority verdict');
        assert.equal(pairs, 2);
        assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
    } finally { native.spawnSync = original; change([file, '/remove:g', '*S-1-1-0']); }
});

test('append acquisition preserves unavailable evidence instead of reporting an authority change', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    let calls = 0;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe' && args[0] === file) { calls++; return timeout(); }
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.throws(() => captureTaskTimelineAppendAuthority(file), unavailable);
        assert.equal(calls, 2);
        assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
    } finally { native.spawnSync = original; }
    assert.ok(captureTaskTimelineAppendAuthority(file).timelineIdentity);
});

test('a compatibility catch cannot publish missing evidence after an unavailable acquisition', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe') return timeout();
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.throws(() => withInvocationReadObservation(() => {
            try { return taskTimelineAwareFileExists(file); }
            catch { return 'missing'; }
        }), unavailable);
    } finally { native.spawnSync = original; }
});

test('unavailable native principal evidence never becomes an ACL change', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'powershell.exe') return timeout();
            if (path.basename(command).toLowerCase() === 'icacls.exe') {
                const stdout = Buffer.from(file + ' UNKNOWN_ACCOUNT:(W)\r\n');
                return { pid: 0, status: 0, signal: null, stdout, stderr: Buffer.alloc(0), output: [null, stdout, Buffer.alloc(0)] };
            }
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.throws(() => withInvocationReadObservation(() => inspectTrustedWindowsWriteAuthority(file)), unavailable);
    } finally { native.spawnSync = original; }
});

test('native observations taking longer than the former timeout succeed with the same process count', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    let calls = 0;
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe') {
                calls++;
                const output = original(command, args, options);
                const slow = original(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], options);
                assert.equal(slow.status, 0, String(slow.error));
                return output;
            }
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.equal(withInvocationReadObservation(() => inspectTrustedWindowsWriteAuthority(file)), true);
        assert.equal(calls, 2);
    } finally { native.spawnSync = original; }
});

test('a real ACL change remains an integrity refusal after a transient acquisition timeout', windowsOnly, t => {
    const file = fixture(t), original = native.spawnSync;
    let calls = 0;
    const change = (args: string[]) => {
        const result = original(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), args,
            { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
        assert.equal(result.status, 0, String(result.error || result.stderr));
    };
    try {
        native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (path.basename(command).toLowerCase() === 'icacls.exe' && ++calls === 1) return timeout();
            return original(command, args, options);
        }) as typeof native.spawnSync;
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(inspectTrustedWindowsWriteAuthority(file), true);
            change([file, '/grant', '*S-1-1-0:(R)']);
        }), /Invocation Windows ACL observation changed/u);
    } finally { native.spawnSync = original; change([file, '/remove:g', '*S-1-1-0']); }
});
