import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTaskFamily, type WalkScenario } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import type { SweepDisturbance } from '../../../../synthetic/engine/walk-sweep';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';

// The stand's corrupt-artifact disturbance, applied to the code lane's recreated reviewer templates.
function corruptTemplate(name: 'prompt-template' | 'output-template'): SweepDisturbance {
    return { kind: 'corrupt-artifact', artifact: { path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-' + name + '.md', kind: 'report' } };
}

test('reviewer templates changed before the launch is prepared are rebuilt, never reused, and cost no review',
    { timeout: 900_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        // Step 16 of the clean-pass baseline is the code lane's prepare-reviewer-launch; no reviewer has started yet.
        const variant: WalkScenario = { ...baseline, id: 'handoff-inputs-corrupt-s16', expectedReviews: {}, expectedModes: [],
            injection: { seed: 0, baseline: baseline.id, step: 17, gate: 'prepare-reviewer-launch',
                disturbances: [corruptTemplate('prompt-template'), corruptTemplate('output-template')] } };
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const results = await walkTaskFamily(template, baseline, [variant]);
            const result = results.find(entry => entry.scenarioId === variant.id);
            assert.ok(result);
            assert.equal(result.outcome, 'done', result.detail.slice(0, 600));
            assert.deepEqual(result.reviewsByLane, { code: 1, test: 1 });
            const refusals = result.steps.filter(step => step.gate === 'prepare-reviewer-launch' && step.exitCode);
            assert.equal(refusals.length, 1, 'next-step must not name the refused launch gate again');
            assert.match(refusals[0].output, /prepare-reviewer-launch cannot continue because reviewer prompt template artifact is stale/u);
            const next = result.steps[result.steps.indexOf(refusals[0]) + 1];
            assert.equal(next.gate, 'build-review-context');
            assert.match(next.reason, /prepare-reviewer-launch refused the current 'code' reviewer handoff inputs and would refuse again/u);
            assert.equal(next.exitCode, 0, next.output.slice(0, 600));
            assert.doesNotMatch(next.output, /REVIEW_CONTEXT_REFUSED/u);
            assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), []);
        } finally { removeWalkDirectory(template); }
    });
