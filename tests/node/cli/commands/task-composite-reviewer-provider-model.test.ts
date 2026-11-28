import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import type { TaskCompositeRunResult } from '../../../../src/cli/commands/task-composite/task-composite-runner';
import { handleTaskComposite } from '../../../../src/cli/commands/task-composite/task-composite-command';
import {
    cli, createCompositeFixture, countEvents, PROVIDER_ARGS, runPrintedCommand, TASK_ID, writeTaskEdit
} from './task-composite-test-fixture';
import { buildNoFindingsJsonReviewReport } from './gates/review-result/gates-command-review-result-fixtures';

async function advance(repoRoot: string, args: string[] = []): Promise<TaskCompositeRunResult> {
    const result = await cli(repoRoot, ['task', TASK_ID, 'advance', '--as-json', ...args]);
    const parsed = JSON.parse(result.text) as TaskCompositeRunResult;
    assert.equal(result.exitCode, parsed.outcome === 'FAILED' ? EXIT_GATE_FAILURE : 0, result.text);
    return parsed;
}

function handoffValue(result: TaskCompositeRunResult, key: string): string {
    const prefix = `${key}: `;
    const value = result.completed.flatMap(step => step.output_lines).find(line => line.startsWith(prefix))?.slice(prefix.length);
    assert.ok(value, `Missing ${key} in preparation output`);
    return value;
}

describe('composite reviewer provider and model', () => {
    it('records the declared cross-provider reviewer in the launch artifact and the accepted receipt', async () => {
        const fixture = await createCompositeFixture();
        try {
            const repoRoot = fixture.clone();
            const quality = await cli(repoRoot, ['workflow', 'set', '--optional-checks', 'off',
                '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
            assert.equal(quality.exitCode, 0, quality.text);
            const entry = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS]);
            assert.equal(entry.exitCode, 0, entry.text);
            await runPrintedCommand(repoRoot, 'load-rule-pack');
            writeTaskEdit(repoRoot);
            await advance(repoRoot);
            await runPrintedCommand(repoRoot, 'load-rule-pack');
            const prepared = await advance(repoRoot);
            assert.equal(prepared.next?.next_gate, 'record-reviewer-delegation-started');
            const launchPath = handoffValue(prepared, 'ReviewerLaunchArtifactPath');
            const outputPath = handoffValue(prepared, 'ReviewOutputPath');
            const contextPath = handoffValue(prepared, 'ReviewContextPath');
            const shared = [
                '--review-type', 'code', '--reviewer-identity', 'agent:codex-sol-fixture',
                '--provider-invocation-id', 'codex-exec-fixture', '--attestation-source', 'codex-exec:openai/gpt-6.2-sol',
                '--launch-input-mode', 'launch_artifact_path',
                '--launch-input-artifact-path', handoffValue(prepared, 'ReviewerLaunchInputArtifactPath'),
                '--launch-input-sha256', handoffValue(prepared, 'ReviewerLaunchInputArtifactSha256'), '--fork-context', 'false'
            ];

            const invalid = await advance(repoRoot, ['--reviewer-phase', 'started', ...shared, '--reviewer-provider', 'Codex\nSol']);
            assert.match(invalid.failed?.error || '', /--reviewer-provider must be/u);
            assert.equal(countEvents(repoRoot, 'REVIEWER_DELEGATION_STARTED'), 0);

            const start = await advance(repoRoot, ['--reviewer-phase', 'started', ...shared,
                '--reviewer-provider', 'Codex', '--reviewer-model', 'gpt-6.2-sol']);
            assert.ok(!start.failed, JSON.stringify(start.failed));
            const startedArtifact = JSON.parse(fs.readFileSync(launchPath, 'utf8')) as Record<string, unknown>;
            assert.equal(startedArtifact.reviewer_provider, 'Codex');
            assert.equal(startedArtifact.reviewer_model, 'gpt-6.2-sol');

            fs.writeFileSync(outputPath, JSON.stringify(buildNoFindingsJsonReviewReport(contextPath, TASK_ID)), 'utf8');
            // Garda distrusts a delegated review that completes less than 10 s after delegation start.
            await delay(Math.max(0, Date.parse(String(startedArtifact.delegation_started_at_utc)) + 10_500 - Date.now()));
            const returnedArgs = ['--reviewer-phase', 'returned', '--review-output-path', outputPath, ...shared];
            await assert.rejects(handleTaskComposite(TASK_ID, 'advance', [...returnedArgs, '--reviewer-model', 'other-model',
                '--repo-root', repoRoot]), /with --reviewer-phase started/u);
            const recorded = await advance(repoRoot, returnedArgs);
            assert.ok(recorded.completed.some(({ gate }) => gate === 'record-review-result'), JSON.stringify(recorded));
            assert.equal(countEvents(repoRoot, 'REVIEW_RECORDED'), 1);

            const receiptPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${TASK_ID}-code-receipt.json`);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
            assert.equal(receipt.reviewer_provider, 'Codex');
            assert.equal(receipt.reviewer_model, 'gpt-6.2-sol');
            assert.equal(receipt.reviewer_identity, 'agent:codex-sol-fixture');
        } finally {
            fixture.dispose();
        }
    });
});
