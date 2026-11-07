import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTaskFamily, type WalkResult, type WalkScenario } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import type { EconomyFacts } from '../../../../synthetic/engine/walk-economy';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';

// Lost review evidence repeats that review. After REVIEW_GATE_PASSED the navigator restarts the coherent cycle; that
// restart records the reviews whose receipt or report it found lost, so the new cycle cannot bring their old result
// back from an immutable snapshot through historical reuse.

// The clean-pass baseline: code launches at 18 and records at 19, test launches at 24 and records at 25.
const CLEAN: EconomyFacts = { dependencies: {}, scope: ['src/app.ts', 'tests/app.test.ts'], reviews: [
    { lane: 'code', mode: 'FULL', launched: 18, recorded: 19 }, { lane: 'test', mode: 'FULL', launched: 24, recorded: 25 }] };

const describe = (result: WalkResult): string => result.scenarioId + ': ' + result.outcome + ' ' + result.detail.slice(0, 400)
    + ' routes=' + result.steps.filter(step => !step.reusedPrefix).map(step => step.route + (step.exitCode ? '(exit ' + step.exitCode + ')' : '')).join(' > ');

test('a review whose receipt or report was lost after the review gate repeats instead of returning from its snapshot',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const lost = [['code', 'T-WALK-code-receipt.json', 'receipt'], ['test', 'T-WALK-test.md', 'report']] as const;
        const variants: WalkScenario[] = lost.map(([lane, file, kind]) => ({ ...baseline, id: 'lost-' + lane + '-after-review-gate',
            expectedReviews: {}, expectedModes: [],
            injection: { seed: 0, baseline: baseline.id, step: 29, gate: 'doc-impact-gate', economy: CLEAN,
                disturbances: [{ kind: 'delete-artifact', artifact: { path: 'garda-agent-orchestrator/runtime/reviews/' + file, kind } }] } }));
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const results = await walkTaskFamily(template, baseline, variants);
            for (const [lane] of lost) {
                const result = results.find(candidate => candidate.scenarioId === 'lost-' + lane + '-after-review-gate');
                assert.ok(result, lane);
                assert.equal(result.outcome, 'done', describe(result));
                const after = result.reviews.filter(review => (review.step ?? -1) >= 28).map(review => review.lane + ':' + review.mode);
                assert.deepEqual(after.filter(entry => entry.startsWith(lane + ':')).length, 1, 'the lost review repeats once: ' + describe(result));
                assert.deepEqual(compareWalk(variants.find(variant => variant.id === result.scenarioId)!, result)
                    .map(finding => finding.id + ': ' + finding.summary), [], describe(result));
            }
        } finally { removeWalkDirectory(template); }
    });

// Operator answer 3: an edit together with lost evidence of one review repeats only that review in FULL; the edit follows
// the ordinary rules for every other review. The economy judgment of compareWalk reports both a review launched beyond
// those rules and a review the rules require but the run kept.
test('an edit together with one deleted or damaged review receipt repeats that review in FULL and follows the edit rules for the others',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const cases = [['code', 'edit-production', 'delete-artifact'], ['test', 'edit-test', 'delete-artifact'],
            ['code', 'edit-production', 'corrupt-artifact']] as const;
        const variants: WalkScenario[] = cases.map(([lane, edit, loss]) => ({ ...baseline, id: edit + '-with-' + loss + '-' + lane + '-receipt',
            expectedReviews: {}, expectedModes: [],
            injection: { seed: 0, baseline: baseline.id, step: 27, gate: 'required-reviews-check', economy: CLEAN,
                disturbances: [{ kind: edit }, { kind: loss, artifact: {
                    path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-' + lane + '-receipt.json', kind: 'receipt' } }] } }));
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const results = await walkTaskFamily(template, baseline, variants);
            for (const variant of variants) {
                const result = results.find(candidate => candidate.scenarioId === variant.id);
                assert.ok(result, variant.id);
                assert.equal(result.outcome, 'done', describe(result));
                const lane = cases.find(([, edit]) => variant.id.startsWith(edit + '-'))![0];
                const after = result.reviews.filter(review => (review.step ?? -1) >= 26).map(review => review.lane + ':' + review.mode);
                assert.deepEqual(after.filter(entry => entry.startsWith(lane + ':')), [lane + ':FULL'],
                    'the review with the lost receipt repeats once in FULL: ' + describe(result));
                assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), [], describe(result));
            }
        } finally { removeWalkDirectory(template); }
    });
