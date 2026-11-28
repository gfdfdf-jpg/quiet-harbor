import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { RetryableInvocationError } from '../../../../src/core/retryable-invocation-error';
import * as snapshots from '../../../../src/gates/workspace/workspace-snapshot-cache';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { resolveNextStep, type NextStepResult } from '../../../../src/gates/next-step';
import {
    attachNextStepCommandExecution,
    type NextStepCommandOperation
} from '../../../../src/gates/next-step/next-step-command-execution';
import { buildCommand } from '../../../../src/gates/next-step/next-step-command-formatters';
import { executeTaskCompositeOperation } from '../../../../src/cli/commands/task-composite/task-composite-actions';
import { formatTaskCompositeText, resolveTaskCompositeExitCode } from '../../../../src/cli/commands/task-composite/task-composite-command';
import { runTaskComposite, type TaskCompositeRunResult } from '../../../../src/cli/commands/task-composite/task-composite-runner';
import { TASK_ID, createCompositeFixture, type CompositeFixture } from './task-composite-test-fixture';

const EFFECT_KIND = 'materialize-quality-checklist-answers';
const NAVIGATOR_COMMAND = `node bin/garda.js next-step "${TASK_ID}" --repo-root "."`;

let fixture: CompositeFixture;

/** Every file of the workspace outside .git with its content hash, so any write after a refusal changes it. */
function workspaceFingerprint(repoRoot: string): string[] {
    const entries: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.name === '.git') continue;
            if (entry.isDirectory()) visit(entryPath);
            else entries.push(`${path.relative(repoRoot, entryPath)}:${createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex')}`);
        }
    };
    visit(repoRoot);
    return entries.sort();
}

function effectsOperation(planSha256: string): NextStepCommandOperation {
    return { operation_id: 'execute-next-step-effects', arguments: { task_id: TASK_ID, plan_sha256: planSha256, effect_kinds: [EFFECT_KIND] } };
}

function effectsNavigatorResult(planSha256: string): NextStepResult {
    const command = attachNextStepCommandExecution(buildCommand('Apply effects', 'apply'), 'mechanical', effectsOperation(planSha256));
    return {
        status: 'BLOCKED', next_gate: 'next-step-effect', title: 'title', reason: 'reason', commands: [command],
        navigator_command: NAVIGATOR_COMMAND
    } as NextStepResult;
}

function failedRun(overrides: Partial<TaskCompositeRunResult>): TaskCompositeRunResult {
    return {
        schema_version: 1, task_id: TASK_ID, mode: 'advance', outcome: 'FAILED', completed: [], failed: null, stop: null, next: null,
        navigator_command: NAVIGATOR_COMMAND,
        counters: { agent_invocations: 1, navigator_resolutions: 1, subgates_attempted: 1, subgates_succeeded: 0, effects_executed: 0 },
        ...overrides
    };
}

describe('composite executor and runner failure paths', { concurrency: false }, () => {
    before(async () => { fixture = await createCompositeFixture(); });
    after(() => fixture.dispose());

    it('a refused workspace observation executes nothing and fails the effect step with its retry text', async (t) => {
        const repoRoot = fixture.clone();
        t.mock.method(snapshots, 'createDeferredWorkspaceSnapshotRequest', () => {
            throw new RetryableInvocationError('Workspace snapshot cache generation changed during authenticated snapshot resolution; retry the invocation.');
        });
        const outcome = await executeTaskCompositeOperation(effectsOperation('a'.repeat(64)), { repoRoot, entryInputs: null });
        assert.equal(outcome.passed, false);
        assert.equal(outcome.outputLines.length, 2);
        assert.match(outcome.outputLines[0], /Retry the workspace observation/u);
        const run = await runTaskComposite({
            taskId: TASK_ID, repoRoot, mode: 'advance', entryInputs: null, resolve: () => effectsNavigatorResult('a'.repeat(64))
        });
        assert.equal(run.outcome, 'FAILED');
        assert.equal(run.failed?.gate, 'next-step-effect');
        assert.equal(run.failed?.error, null);
        assert.deepEqual(run.failed?.output_lines, outcome.outputLines);
        assert.deepEqual(run.completed, []);
        assert.equal(run.counters.effects_executed, 0);
        assert.equal(resolveTaskCompositeExitCode(run), EXIT_GATE_FAILURE);
    });

    it('a stale effect plan hash throws through the runner as a failed step and writes nothing', async () => {
        const repoRoot = fixture.clone();
        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const before = workspaceFingerprint(repoRoot);
        const run = await runTaskComposite({
            taskId: TASK_ID, repoRoot, mode: 'advance', entryInputs: null, resolve: () => effectsNavigatorResult('b'.repeat(64))
        });
        assert.equal(run.outcome, 'FAILED');
        assert.equal(run.failed?.gate, 'next-step-effect');
        assert.match(run.failed?.error ?? '', /Next-step effect plan is stale: expected b{64}, found (?:<none>|[a-f0-9]{64})/u);
        assert.deepEqual(run.completed, []);
        assert.equal(run.counters.effects_executed, 0);
        assert.deepEqual(workspaceFingerprint(repoRoot), before, 'the refused plan wrote no file');
    });

    it('exit status separates normal boundary stops from failures and stalls', () => {
        const stop = (kind: NonNullable<TaskCompositeRunResult['stop']>['kind']): TaskCompositeRunResult =>
            failedRun({ outcome: 'STOPPED', stop: { kind, reason: 'reason' } });
        assert.equal(resolveTaskCompositeExitCode(failedRun({})), EXIT_GATE_FAILURE);
        for (const kind of ['agent', 'operator', 'terminal', 'unclassified'] as const) {
            assert.equal(resolveTaskCompositeExitCode(stop(kind)), 0, kind);
        }
        for (const kind of ['repeated-state', 'step-limit'] as const) {
            assert.equal(resolveTaskCompositeExitCode(stop(kind)), EXIT_GATE_FAILURE, kind);
        }
    });

    it('the failure text names the gate, the error, the bounded output tail and the recovery command', () => {
        const outputLines = Array.from({ length: 60 }, (_unused, index) => `line ${index + 1}`);
        const text = formatTaskCompositeText(failedRun({
            completed: [{ gate: 'handshake-diagnostics', operation_id: 'handshake-diagnostics', outcome: 'PASS', output_lines: [] }],
            failed: { gate: 'shell-smoke-preflight', operation_id: 'shell-smoke-preflight', outcome: 'FAIL', output_lines: outputLines, error: 'boom' }
        }));
        const lines = text.split('\n');
        assert.ok(lines.includes('Outcome: FAILED'));
        assert.ok(lines.includes('  1. handshake-diagnostics: PASS'));
        assert.ok(lines.includes('FailedGate: shell-smoke-preflight'));
        assert.ok(lines.includes('Error: boom'));
        assert.ok(lines.includes('FailureOutput:'));
        assert.ok(lines.includes('  line 60') && lines.includes('  line 21'));
        assert.ok(!lines.includes('  line 20'), 'only the last 40 lines are shown');
        assert.ok(lines.includes(`Recovery: rerun the navigator: ${NAVIGATOR_COMMAND}`));
        assert.ok(!lines.includes(`Navigator: ${NAVIGATOR_COMMAND}`), 'a failed run prints the recovery line instead of the plain navigator line');
    });

    it('a navigator exception is reported with the failed source and the preceding prefix in the text', async () => {
        let resolved = 0;
        const run = await runTaskComposite({
            taskId: TASK_ID, repoRoot: '.', mode: 'advance', entryInputs: null,
            resolve: () => {
                if (resolved++ === 0) {
                    return {
                        status: 'BLOCKED', next_gate: 'handshake-diagnostics', title: 't', reason: 'r', navigator_command: NAVIGATOR_COMMAND,
                        commands: [attachNextStepCommandExecution(buildCommand('h', 'h'), 'mechanical',
                            { operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } })]
                    } as NextStepResult;
                }
                throw new Error('navigator crashed');
            },
            execute: async () => ({ passed: true, outputLines: [] })
        });
        const text = formatTaskCompositeText(run);
        assert.match(text, /1\. handshake-diagnostics: PASS/u);
        assert.match(text, /FailedGate: next-step\n/u);
        assert.match(text, /Error: navigator crashed/u);
        assert.match(text, /Recovery: rerun the navigator: /u);
        assert.equal(resolveTaskCompositeExitCode(run), EXIT_GATE_FAILURE);
    });
});
