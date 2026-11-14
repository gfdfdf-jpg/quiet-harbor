import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureWorkspacePlannedFiles, publishWorkspacePlannedFiles, assertWorkspacePlannedFilesCurrent } from '../../../../src/core/workspace-planned-files';
import { RetryableInvocationError } from '../../../../src/core/retryable-invocation-error';
import { runCliMainWithHandling } from '../../../../src/cli/main';
import { resolveNextStep } from '../../../../src/gates/next-step';
import * as snapshots from '../../../../src/gates/workspace/workspace-snapshot-cache';
import { makeTempRepo, seedStartedTask, TASK_ID, eventsRoot } from './next-step-review-cycle-fixtures';

test('a real retained-generation refusal is machine-readable through both next-step CLI aliases', async t => {
    const repoRoot = makeTempRepo();
    seedStartedTask(repoRoot, TASK_ID);
    const timeline = path.join(eventsRoot(repoRoot), TASK_ID + '.jsonl');
    const before = fs.readFileSync(timeline);
    const failGeneration = () => {
        const captured = captureWorkspacePlannedFiles(repoRoot);
        publishWorkspacePlannedFiles(repoRoot, TASK_ID, ['src/app.ts']);
        assertWorkspacePlannedFilesCurrent(repoRoot, captured);
        throw new Error('The freshness guard must refuse the expired generation');
    };
    t.mock.method(snapshots, 'createDeferredWorkspaceSnapshotRequest', failGeneration);
    const aliases = [['next-step', TASK_ID], ['gate', 'next-step', '--task-id', TASK_ID]];
    for (const alias of [...aliases, ...aliases.map(argv => [...argv, '--execute-effects', '--effect-plan-sha256', 'a'.repeat(64)])]) {
        let stdout = '';
        const errors: string[] = [];
        const write = t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; });
        const stderr = t.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values.join(' ')); });
        const previous = process.exitCode;
        try {
            process.exitCode = 0;
            await runCliMainWithHandling([...alias, '--repo-root', repoRoot, '--as-json']);
            assert.ok(stdout.trim(), errors.join('\n'));
            const result = JSON.parse(stdout) as ReturnType<typeof resolveNextStep> & { retryable?: boolean };
            assert.equal(result.task_id, TASK_ID);
            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.next_gate, 'git-observation');
            assert.equal(result.retryable, true);
            assert.match(result.reason, /planned-source scope changed/u);
            assert.equal(result.commands.length, 1);
            assert.equal(result.commands[0].command, result.navigator_command);
            assert.match(result.commands[0].command, /next-step/u);
            assert.doesNotMatch(result.commands[0].command, /--execute-effects/u);
            assert.equal(process.exitCode, 0);
            assert.deepEqual(errors, []);
        } finally { write.mock.restore(); stderr.mock.restore(); process.exitCode = previous; }
    }
    assert.deepEqual(fs.readFileSync(timeline), before, 'A refused inspection must publish no effects');
});

test('a workspace snapshot generation refusal also returns a fresh inspection without accepting an effect plan', t => {
    const repoRoot = makeTempRepo();
    seedStartedTask(repoRoot, TASK_ID);
    t.mock.method(snapshots, 'createDeferredWorkspaceSnapshotRequest', () => {
        throw new RetryableInvocationError('Workspace snapshot cache generation changed during authenticated snapshot resolution; retry the invocation.');
    });
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.next_gate, 'git-observation');
    assert.equal(result.retryable, true);
    assert.match(result.reason, /snapshot cache generation changed/u);
    assert.equal(result.commands[0].command, result.navigator_command);
});

test('unexpected navigator errors remain fatal instead of becoming retry instructions', t => {
    const repoRoot = makeTempRepo();
    seedStartedTask(repoRoot, TASK_ID);
    t.mock.method(snapshots, 'createDeferredWorkspaceSnapshotRequest', () => { throw new Error('Unexpected navigator defect; retry the invocation.'); });
    assert.throws(() => resolveNextStep({ repoRoot, taskId: TASK_ID }), /Unexpected navigator defect/u);
});
