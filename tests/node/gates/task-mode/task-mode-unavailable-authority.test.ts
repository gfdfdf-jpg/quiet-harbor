import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { getTaskModeEvidence } from '../../../../src/gates/task-mode';
import { resolveRuntimeReviewerIdentity } from '../../../../src/gates/review/reviewer-routing';
import { WindowsAclEvidenceUnavailableError } from '../../../../src/gate-runtime/timeline/windows-acl-batch';

const windowsOnly = { skip: process.platform !== 'win32' };
const native = require('node:child_process') as typeof childProcess;

function fixture(t: TestContext): { root: string; artifact: string } {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-mode-unavailable-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = path.join(root, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(path.join(runtime, 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(runtime, 'reviews'));
    fs.writeFileSync(path.join(runtime, 'init-answers.json'), JSON.stringify({ SourceOfTruth: 'Codex' }));
    const artifact = path.join(runtime, 'reviews', 'T-ACL-task-mode.json');
    fs.writeFileSync(artifact, JSON.stringify({ status: 'PASSED', outcome: 'PASS', task_id: 'T-ACL',
        event_source: 'enter-task-mode', entry_mode: 'EXPLICIT_TASK_EXECUTION', requested_depth: 2, effective_depth: 2,
        task_summary: 'Verify available authority', provider: 'Codex', canonical_source_of_truth: 'Codex',
        execution_provider_source: 'provider_entrypoint', runtime_identity_status: 'resolved', routed_to: 'AGENTS.md' }));
    return { root, artifact };
}

test('unavailable artifact authority cannot become missing JSON or legacy reviewer identity', windowsOnly, t => {
    for (const active of [false, true]) {
        const { root, artifact } = fixture(t), original = native.spawnSync;
        const run = <T>(callback: () => T) => active ? withInvocationReadObservation(callback) : callback();
        let calls = 0;
        try {
            native.spawnSync = ((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
                if (path.basename(command).toLowerCase() === 'icacls.exe'
                    && (args[0] === artifact || args[0] === path.dirname(artifact))) {
                    calls++;
                    return { pid: 0, status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
                        output: [null, Buffer.alloc(0), Buffer.alloc(0)],
                        error: Object.assign(new Error('ACL acquisition timeout'), { code: 'ETIMEDOUT' }) };
                }
                return original(command, args, options);
            }) as typeof native.spawnSync;
            assert.throws(() => run(() => getTaskModeEvidence(root, 'T-ACL', artifact)), WindowsAclEvidenceUnavailableError);
            assert.throws(() => run(() => resolveRuntimeReviewerIdentity({ repoRoot: root, taskId: 'T-ACL', taskModePath: artifact })),
                WindowsAclEvidenceUnavailableError);
            assert.ok(calls <= 4, 'unavailable evidence must not add native fallback processes');
        } finally { native.spawnSync = original; }
        assert.equal(run(() => getTaskModeEvidence(root, 'T-ACL', artifact)).evidence_status, 'PASS');
        assert.equal(run(() => resolveRuntimeReviewerIdentity({ repoRoot: root, taskId: 'T-ACL', taskModePath: artifact })).identity_status,
            'resolved');
    }
});

test('unavailable artifact content is not mislabeled invalid JSON', windowsOnly, t => {
    const { root, artifact } = fixture(t), nativeFs = require('node:fs') as typeof fs, original = nativeFs.readFileSync;
    const failure = new WindowsAclEvidenceUnavailableError(artifact);
    try {
        nativeFs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
            if (file === artifact) throw failure;
            return Reflect.apply(original, nativeFs, [file, ...args]);
        }) as typeof nativeFs.readFileSync;
        assert.throws(() => getTaskModeEvidence(root, 'T-ACL', artifact), error => error === failure);
    } finally { nativeFs.readFileSync = original; }
    assert.equal(getTaskModeEvidence(root, 'T-ACL', artifact).evidence_status, 'PASS');
});
