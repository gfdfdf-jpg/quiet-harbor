import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { compareWalk, createWalkTemplate, walkTask, type WalkScenario, type WalkStep } from '../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';
import { createTempRepo, getOrchestratorRoot } from '../../cli/commands/gate-test-helpers';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { findReviewGateStaleUpstreamRecovery } from '../../../../src/gates/next-step/next-step-review-evidence';
import { matchesRecordedUpstreamContextPath } from '../../../../src/gates/next-step/next-step-reviewer-handoff-inputs';
import { normalizePath } from '../../../../src/gates/shared/helpers';

test('an upstream refusal binds the same normalized UNC path that the dependency gate records', () => {
    const context = '\\\\wsl.localhost\\Ubuntu\\repo\\runtime\\reviews\\T-WALK-code-review-context.json';
    const recorded = '/wsl.localhost/Ubuntu/repo/runtime/reviews/T-WALK-code-review-context.json';
    assert.equal(normalizePath(context), recorded);
    assert.equal(matchesRecordedUpstreamContextPath(recorded, context), true);
    assert.equal(matchesRecordedUpstreamContextPath(recorded + '.other', context), false);
});

test('an authenticated dependency-order failure requires a new cycle, and a newer compile clears that recovery', () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-order-recovery';
    const root = getOrchestratorRoot(repoRoot);
    try {
        appendTaskEvent(root, taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Compile fixture.', {});
        const violation = "Required review 'test' started before upstream review 'code' completed. Downstream review dependency order is invalid.";
        appendTaskEvent(root, taskId, 'REVIEW_GATE_FAILED', 'FAIL', 'Order rejected.', { violations: [violation] });
        const input = { repoRoot, eventsRoot: path.join(root, 'runtime/task-events'), taskId,
            requiredReviewTypes: ['code', 'test'], requiredReviews: { code: true, test: true },
            policyMode: 'strict_sequential' as const, reviewStates: [] };
        assert.deepEqual(findReviewGateStaleUpstreamRecovery(input), { kind: 'dependency-order', violation });
        appendTaskEvent(root, taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Fresh cycle fixture.', {});
        assert.equal(findReviewGateStaleUpstreamRecovery(input), null);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('lost or corrupt upstream context during downstream review is restored without repeating either review',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const clean = WALK_SCENARIOS.find(scenario => scenario.id === 'clean-pass')!;
            const baseline = await walkTask(template, clean);
            assert.equal(baseline.outcome, 'done', baseline.detail);
            const checkpoint = baseline.steps.find(step => step.gate === 'record-review-routing'
                && step.command?.includes('--review-type "test"'));
            assert.ok(checkpoint, 'downstream context was created, but routing has not run');
            for (const kind of ['delete-artifact', 'corrupt-artifact'] as const) {
                const scenario: WalkScenario = { ...clean, id: 'lost-upstream-context-during-test-' + kind,
                    injection: { seed: 1, baseline: clean.id, step: checkpoint.index, gate: checkpoint.gate!, disturbances: [{
                        kind, artifact: {
                            path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-review-context.json', kind: 'context'
                        }
                    }] } };
                const result = await walkTask(template, scenario);
                if (result.outcome !== 'done') fs.writeFileSync(path.join(os.tmpdir(), 'garda-lost-upstream-failure.json'), JSON.stringify(result));
                assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id + ': ' + finding.summary), []);
                assert.equal(result.outcome, 'done', result.detail);
                const recovery: WalkStep | undefined = result.steps.find(step => step.index > checkpoint.index && step.gate === 'next-step-effect'
                    && /Restore the authenticated code review context/u.test(step.reason));
                assert.ok(recovery);
                assert.equal(recovery.exitCode, 0, recovery.output);
                assert.ok(result.steps.some(step => step.index > recovery.index && step.gate === 'required-reviews-check' && step.exitCode === 0));
                assert.equal(result.reviewsByLane.code, 1, 'the recorded code review is kept');
                assert.equal(result.reviewsByLane.test, 1, 'the planned test review runs once');
            }
        } finally {
            fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
