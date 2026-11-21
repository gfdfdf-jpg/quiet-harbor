import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { compareWalk, createWalkTemplate, walkTask, type WalkScenario, type WalkStep } from '../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';
import { removeWalkDirectory } from '../../synthetic/engine/walk-checkpoint';
import type { SweepDisturbance } from '../../synthetic/engine/walk-sweep';

// Sweep 5 (clean-pass s20): after the code review was recorded its reviewer-launch-input.json was lost. next-step
// relaunched the code reviewer, then offered reuse of the superseded review; build-review-context accepted and
// skipped the rebuild, and next-step offered the same reuse forever. The attested fresh launch must be recorded.
test('a reviewer relaunched after losing its launch input records the fresh result instead of looping on reuse',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const clean = WALK_SCENARIOS.find(scenario => scenario.id === 'clean-pass')!;
            const baseline = await walkTask(template, clean);
            assert.equal(baseline.outcome, 'done', baseline.detail);
            const checkpoint = baseline.steps.find(step => step.gate === 'build-review-context' && step.command?.includes('--review-type "test"'));
            assert.ok(checkpoint, 'clean-pass prepares the test context after recording the code review');
            const at = checkpoint.index, gate = String(checkpoint.gate);
            for (const kind of ['delete-artifact', 'corrupt-artifact', 'stale-artifact'] as const) {
                const disturbance: SweepDisturbance = { kind, artifact: {
                    path: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/code/reviewer-launch-input.json', kind: 'launch' } };
                const scenario: WalkScenario = { ...clean, id: 'lost-launch-input-after-review-' + kind,
                    injection: { seed: 1, baseline: clean.id, step: at, gate, disturbances: [disturbance] } };
                const result = await walkTask(template, scenario);
                assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id + ': ' + finding.summary), [], kind);
                assert.equal(result.outcome, 'done', kind + ': ' + result.detail);
                const after: WalkStep[] = result.steps.filter(step => step.index > at);
                const relaunch = after.findIndex(step => step.gate === 'complete-reviewer-launch' && step.command?.includes('--review-type "code"'));
                assert.ok(relaunch >= 0, kind + ': the lost launch input is replaced by a fresh audited code launch');
                assert.equal(after[relaunch + 1]?.gate, 'record-review-result', kind + ': the fresh code result is recorded next');
                assert.equal(after.filter(step => step.gate === 'build-review-context' && step.command?.includes('--review-type "code"')).length, 0,
                    kind + ': no reuse of the superseded code review is offered');
                assert.equal(result.reviewsByLane.code, 2, kind + ': lost launch evidence costs one fresh code review');
                assert.equal(result.reviewsByLane.test, 1, kind);
            }
        } finally { removeWalkDirectory(template); }
    });
