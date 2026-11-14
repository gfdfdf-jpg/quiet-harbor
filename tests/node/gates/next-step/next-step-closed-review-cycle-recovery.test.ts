import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTask, type WalkScenario } from '../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';
import type { SweepDisturbance } from '../../synthetic/engine/walk-sweep';

// After REVIEW_GATE_PASSED an authenticated context copy is restored without a new review-phase write.
// Other lost review evidence still takes the existing restart route.
const REVIEWS = 'garda-agent-orchestrator/runtime/reviews/';

test('lost review evidence after the review gate passed restarts the coherent cycle instead of a refused review write', { timeout: 1_800_000, concurrency: false }, async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const clean = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass')!;
        const baseline = await walkTask(template, clean);
        assert.equal(baseline.outcome, 'done', baseline.detail);
        const passed = baseline.steps.findIndex(step => step.gate === 'doc-impact-gate');
        assert.ok(passed > 0, 'The baseline must reach doc-impact-gate after the review gate passed');
        for (const file of ['T-WALK-code-review-context.json', 'T-WALK-code-findings-validation.json']) {
            const disturbance: SweepDisturbance = { kind: 'delete-artifact', artifact: { path: REVIEWS + file, kind: file.includes('context') ? 'context' : 'report' } };
            const scenario: WalkScenario = { ...clean, id: 'closed-cycle-lost-' + file, expectedReviews: {}, expectedModes: [],
                injection: { seed: 1, baseline: 'clean-pass', step: passed, gate: 'doc-impact-gate', disturbances: [disturbance] } };
            const result = await walkTask(template, scenario);
            assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id + ': ' + finding.summary), [], file);
            const refused = result.steps.filter(step => step.index > passed && step.exitCode && /already contains REVIEW_GATE_PASSED/u.test(step.output));
            assert.deepEqual(refused.map(step => step.gate), [], file + ': no review-phase command may be suggested after the gate passed');
            if (file.includes('context')) {
                assert.ok(result.steps.some(step => step.index > passed && step.gate === 'next-step-effect' && step.exitCode === 0
                    && /Restore the authenticated code review context/u.test(step.reason)), file);
                assert.equal(result.reviews.length, 2, file + ': the two recorded reviews are kept');
            } else {
                assert.ok(result.steps.some(step => step.index > passed && step.gate === 'restart-coherent-cycle' && step.exitCode === 0), file);
            }
            assert.equal(result.outcome, 'done', file + ': ' + result.detail);
        }
    } finally {
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
