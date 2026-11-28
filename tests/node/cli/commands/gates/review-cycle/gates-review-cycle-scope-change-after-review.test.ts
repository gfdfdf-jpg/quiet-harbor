import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTaskFamily, type WalkResult, type WalkScenario } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import type { EconomyFacts } from '../../../../synthetic/engine/walk-economy';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';

// A change while reviews are under way follows the operator's review rules through the real navigator and gates:
// kept outside a review's scope, DELTA for a small fix inside it, and a finished review is recorded, not relaunched.

// The clean-pass baseline includes the task's test selection before the two delegated reviews.
const CLEAN: EconomyFacts = { dependencies: {}, scope: ['src/app.ts', 'tests/app.test.ts'], reviews: [
    { lane: 'code', mode: 'FULL', launched: 18, completed: 19, recorded: 20 },
    { lane: 'test', mode: 'FULL', launched: 24, completed: 25, recorded: 26 }] };

interface Case {
    kind: 'edit-production' | 'edit-test' | 'edit-document';
    step: number;
    gate: string;
    /** Every review the task recorded, in order; the baseline records code:FULL and test:FULL. */
    reviews: string[];
}

const CASES: Case[] = [
    // Both reviews passed: a small production fix repeats both in DELTA.
    { kind: 'edit-production', step: 27, gate: 'required-reviews-check', reviews: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA'] },
    // Both reviews passed: a small test fix repeats only the test review in DELTA.
    { kind: 'edit-test', step: 27, gate: 'required-reviews-check', reviews: ['code:FULL', 'test:FULL', 'test:DELTA'] },
    // The code reviewer finished, unrecorded: a document change records it and repeats nothing.
    { kind: 'edit-document', step: 20, gate: 'record-review-result', reviews: ['code:FULL', 'test:FULL'] },
    // Operator answer 1: the finished code review is recorded against its tree, then the small fix repeats it in DELTA.
    { kind: 'edit-production', step: 20, gate: 'record-review-result', reviews: ['code:FULL', 'code:DELTA', 'test:FULL'] },
    // Operator answer 1: the finished test review is recorded; the small fix repeats code and test in DELTA.
    { kind: 'edit-production', step: 26, gate: 'record-review-result', reviews: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA'] },
    // Operator answer 1 for a test fix: the finished test review is recorded against its tree (its upstream code
    // review counts on that tree); the small test fix repeats only the test review, in DELTA.
    { kind: 'edit-test', step: 26, gate: 'record-review-result', reviews: ['code:FULL', 'test:FULL', 'test:DELTA'] }
];

const describe = (result: WalkResult): string => result.scenarioId + ': ' + result.outcome + ' ' + result.detail.slice(0, 400)
    + ' routes=' + result.steps.filter(step => !step.reusedPrefix).map(step => step.route + (step.exitCode ? '(exit ' + step.exitCode + ')' : '')).join(' > ');

test('a change after passed or finished reviews repeats only the reviews it reaches, in DELTA when small',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const variants: WalkScenario[] = CASES.map(entry => ({ ...baseline, id: entry.kind + '-s' + entry.step,
            expectedReviews: {}, expectedModes: [],
            injection: { seed: 0, baseline: baseline.id, step: entry.step, gate: entry.gate, disturbances: [{ kind: entry.kind }], economy: CLEAN } }));
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            // A checkpoint family shares one injection step, so each step walks its own family.
            const results: WalkResult[] = [];
            for (const step of [...new Set(CASES.map(entry => entry.step))]) {
                results.push(...await walkTaskFamily(template, baseline, variants.filter(variant => variant.injection?.step === step)));
                // Output keeps the test runner from treating a long family walk as an idle shard.
                console.log('Walk completed at step ' + step);
            }
            for (const entry of CASES) {
                const variant = variants.find(candidate => candidate.id === entry.kind + '-s' + entry.step)!;
                const result = results.find(candidate => candidate.scenarioId === variant.id);
                assert.ok(result, variant.id);
                assert.equal(result.outcome, 'done', describe(result));
                assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode), entry.reviews, describe(result));
                assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), [], describe(result));
                assert.ok(!result.steps.some(step => !step.reusedPrefix && step.gate === 'restart-coherent-cycle'),
                    'No coherent restart throws the reviews away: ' + describe(result));
            }
        } finally { removeWalkDirectory(template); }
    });
