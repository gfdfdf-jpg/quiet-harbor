import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { compareWalk, isAllowedSweepHandoff, needsInjectedImplementation, observeReviewerLaunch, approvePolicyAdoption, isReviewPolicyRefusal, shouldApproveInjectedRestart,
    type WalkResult, type WalkReview, type WalkScenario, type WalkStep } from './engine/navigator-walk';
import { artifactLane, economyFacts, judgeReviewEconomy, renderReviewEconomy, reviewEconomyBound, summarizeReviewEconomy, SWEEP_EDITS,
    type EconomyFacts } from './engine/walk-economy';
import { buildSweepScenarios, mutateSweepFile, replaySweepScenarios, type SweepDisturbance, type SweepInjection } from './engine/walk-sweep';

const BUNDLE = 'garda-agent-orchestrator/runtime';
// The clean-pass baseline: code launches at 18 and records at 19, test launches at 24 and records at 25.
const CLEAN: EconomyFacts = { dependencies: {}, scope: ['src/app.ts', 'tests/app.test.ts'], reviews: [
    { lane: 'code', mode: 'FULL', launched: 18, recorded: 19 }, { lane: 'test', mode: 'FULL', launched: 24, recorded: 25 }] };
const DOCUMENT_ONLY: EconomyFacts = { reviews: [], scope: ['docs/guide.md'], dependencies: {} };
const PREFIX_BEFORE = (step: number, facts: EconomyFacts): WalkReview[] => facts.reviews.filter(review => review.launched < step)
    .map(review => ({ lane: review.lane, mode: review.mode, step: review.launched }));

function run(step: number, disturbances: string[], launches: string[], facts = CLEAN, outcome: WalkResult['outcome'] = 'done'): WalkResult {
    const reviews = [...PREFIX_BEFORE(step, facts), ...launches.map((entry, index) => {
        const [lane, mode] = entry.split(':');
        return { lane, mode, step: step + 2 + index };
    })];
    return { scenarioId: 'sweep-fixture', outcome, detail: '', steps: [], reviewsByLane: {}, reviews, events: [],
        sweep: { seed: 42, baseline: 'clean-pass', step, disturbances, applied: disturbances, economy: facts } };
}
const verdict = (...args: Parameters<typeof run>) => judgeReviewEconomy(run(...args))!;
const excess = (...args: Parameters<typeof run>) => verdict(...args).excess.map(entry => entry.kind + ':' + entry.lane);
const bound = (step: number, disturbances: string[], lane: string, facts = CLEAN) => {
    const entry = reviewEconomyBound(step, disturbances, facts).find(item => item.lane === lane)!;
    return [entry.repeats, entry.modes.join('/'), entry.rule, ...entry.questions].join(' ');
};
const artifact = (name: string) => BUNDLE + '/reviews/' + name;
const blankStep = (index: number): WalkStep => ({ index, gate: 'implementation', route: 'BLOCKED/implementation', status: 'BLOCKED', command: null,
    navigatorMs: 1, commandMs: 0, exitCode: null, output: '', reason: '', taskEvents: index, workspaceSha256: '', measurement: null });
const restartSteps = (): WalkStep[] => [...Array(32).keys()].map(index => index === 27
    ? { ...blankStep(index), gate: 'restart-coherent-cycle', route: 'BLOCKED/restart-coherent-cycle', routes: ['src/gates/next-step/next-step.ts:1:1'] }
    : index === 31 ? { ...blankStep(index), gate: null, route: 'DONE/(done)', status: 'DONE' } : blankStep(index));

test('a review repeats only when a rule says so: untouched, not yet run and in-flight lanes are not launched again', () => {
    for (const disturbance of ['stale-lock', 'repeat-last', 'fail-gate', 'wrong-gate:compile-gate']) {
        assert.deepEqual(excess(26, [disturbance], []), [], disturbance);
        assert.deepEqual(excess(26, [disturbance], ['code:FULL']), ['extra-launch:code'], disturbance);
        assert.deepEqual(excess(20, [disturbance], ['test:FULL']), [], 'The planned FULL is no repeat: ' + disturbance);
        assert.deepEqual(excess(19, [disturbance], ['code:FULL', 'test:FULL']), ['extra-launch:code'], 'An unrecorded result is simply recorded: ' + disturbance);
    }
    assert.equal(bound(12, ['edit-production'], 'code'), '0  not-run');
    assert.deepEqual(excess(12, ['edit-production'], ['code:FULL', 'test:FULL']), []);
    assert.deepEqual(excess(12, ['stale-lock'], ['code:FULL', 'code:FULL', 'test:FULL']), ['extra-launch:code'], 'A planned review runs once');
    assert.deepEqual(excess(18, ['stale-lock'], ['code:FULL', 'test:FULL']), [], 'A reviewer not yet completed is still planned');
});

test('a small production fix repeats reached passed reviews in DELTA, and a test fix repeats only the test review', () => {
    assert.equal(bound(26, ['edit-production'], 'code'), '1 DELTA small-fix');
    assert.equal(bound(26, ['edit-production'], 'test'), '1 DELTA small-fix', 'The test review covers the code its tests verify');
    assert.deepEqual(excess(26, ['edit-production'], ['code:DELTA', 'test:DELTA']), []);
    assert.deepEqual(excess(26, ['edit-production'], ['code:FULL', 'test:FULL']), ['full-where-delta:code', 'full-where-delta:test']);
    assert.deepEqual(excess(26, ['edit-production'], ['code:DELTA', 'code:DELTA', 'test:DELTA']), ['extra-launch:code']);
    assert.deepEqual(excess(26, ['edit-production'], []), [], 'Under-review is not an economy finding');
    assert.deepEqual(excess(20, ['edit-production'], ['code:FULL', 'test:FULL']), ['full-where-delta:code'], 'test has not run yet');
    assert.equal(bound(26, ['edit-test'], 'code'), '0  outside-scope');
    assert.equal(bound(26, ['edit-test'], 'test'), '1 DELTA small-fix');
    assert.deepEqual(excess(26, ['edit-test'], ['test:DELTA']), []);
    assert.deepEqual(excess(26, ['edit-test'], ['test:FULL']), ['full-where-delta:test']);
    assert.deepEqual(excess(26, ['edit-test'], ['code:DELTA', 'test:DELTA']), ['extra-launch:code']);
    assert.deepEqual(excess(20, ['edit-test'], ['test:FULL']), [], 'code keeps its result, test runs as planned');
    assert.deepEqual(excess(26, ['edit-production', 'edit-test'], ['code:DELTA', 'test:DELTA']), [], 'Combined fixes stay one small fix');
});

test('the fix size comes from the edit, the reviewed scope and the delta history, not from the observed run', () => {
    const deltas: EconomyFacts = { ...CLEAN, reviews: [{ lane: 'code', mode: 'FULL', launched: 1, recorded: 2 },
        ...[3, 5, 7].map(launched => ({ lane: 'code', mode: 'DELTA', launched, recorded: launched + 1 }))] };
    assert.equal(bound(26, ['edit-production'], 'code', deltas), '1 FULL large-fix', 'Three consecutive DELTA reviews end in FULL');
    assert.equal(bound(26, ['edit-production'], 'code', { ...deltas, reviews: deltas.reviews.slice(0, 3) }), '1 DELTA small-fix');
    assert.deepEqual(excess(26, ['edit-production'], ['code:FULL'], deltas), []);
    assert.equal(bound(26, ['edit-production'], 'code', { ...CLEAN, scope: ['tests/app.test.ts'] }), '1 FULL scope-expansion',
        'A file outside the reviewed list changes the scope');
    assert.equal(bound(26, ['edit-production'], 'code', { ...CLEAN, reviews: [...CLEAN.reviews, { lane: 'code', mode: 'DELTA', launched: 30, recorded: 31 }] }),
        '1 DELTA small-fix', 'Reviews after the disturbance do not count');
});

test('only documents changed: nothing repeats, even a review waiting to be recorded', () => {
    assert.equal(bound(19, ['edit-document'], 'code'), '0  documents');
    assert.deepEqual(excess(19, ['edit-document'], ['code:FULL', 'test:FULL']), ['extra-launch:code']);
    assert.deepEqual(excess(26, ['edit-document'], ['test:FULL']), ['extra-launch:test']);
    assert.deepEqual(excess(19, ['edit-document'], ['test:FULL']), []);
    assert.deepEqual(verdict(19, ['edit-document'], ['code:FULL', 'test:FULL']).unjudged, []);
    assert.deepEqual(excess(26, ['edit-document', 'edit-production'], ['code:DELTA', 'test:DELTA']), [], 'Documents do not make a fix larger');
});

test('changed criteria run everything FULL, once per lane; DELTA where FULL is required is not economy', () => {
    assert.equal(bound(26, ['change-criteria'], 'code'), '1 FULL criteria');
    assert.deepEqual(excess(26, ['change-criteria'], ['code:FULL', 'test:FULL']), []);
    assert.deepEqual(excess(19, ['change-criteria'], ['code:FULL', 'test:FULL']), [], 'An unrecorded review is decided by this rule too');
    assert.deepEqual(excess(26, ['change-criteria'], ['code:FULL', 'code:FULL', 'test:FULL']), ['extra-launch:code']);
    assert.deepEqual(excess(26, ['change-criteria', 'edit-production'], ['code:FULL', 'test:FULL']), [], 'Criteria outrank the small fix');
    assert.deepEqual(excess(26, ['change-criteria'], ['code:DELTA', 'test:DELTA']), ['delta-where-full:code', 'delta-where-full:test']);
});

test('lost lane evidence repeats only that lane and its dependents, the shape of the route-248 defect', () => {
    for (const kind of ['delete-artifact', 'corrupt-artifact', 'stale-artifact']) {
        const lost = kind + ':' + artifact('T-WALK-code-receipt.json');
        assert.equal(bound(26, [lost], 'code'), '1 FULL/DELTA lost-evidence');
        assert.equal(bound(26, [lost], 'test'), '0  untouched');
        assert.deepEqual(excess(26, [lost], ['code:FULL']), []);
        assert.deepEqual(excess(26, [lost], ['code:FULL', 'test:FULL']), ['extra-launch:test'], 'An ordinary restart repeats every review');
    }
    const declared: EconomyFacts = { ...CLEAN, dependencies: { test: ['code'], code: [] } };
    assert.deepEqual(excess(26, ['delete-artifact:' + artifact('T-WALK-code-receipt.json')], ['code:FULL', 'test:FULL'], declared), [], 'A declared graph re-opens its dependents');
    assert.deepEqual(excess(26, ['delete-artifact:' + artifact('T-WALK-test-receipt.json')], ['code:FULL', 'test:FULL'], declared), ['extra-launch:code'], 'Not its upstream');
    assert.deepEqual(excess(20, ['delete-artifact:' + BUNDLE + '/tmp/reviews/T-WALK/code/reviewer-launch-input.json'], ['code:FULL', 'test:FULL']), [],
        'A launch artifact belongs to its lane; test has not run yet');
    assert.deepEqual(excess(26, ['delete-artifact:' + artifact('T-WALK-code-receipt.json')], ['code:FULL', 'code:FULL']), ['extra-launch:code']);
});

test('a broken report of an open reviewer costs no new launch, a lost one repeats that lane', () => {
    const report = BUNDLE + '/tmp/reviews/T-WALK/code/review-output-' + 'a'.repeat(16) + '.md';
    assert.equal(bound(19, ['corrupt-artifact:' + report], 'code'), '0  broken-report');
    assert.equal(bound(19, ['stale-artifact:' + report], 'code'), '0  broken-report');
    assert.deepEqual(excess(19, ['corrupt-artifact:' + report], ['code:FULL', 'test:FULL']), ['extra-launch:code']);
    assert.equal(bound(19, ['delete-artifact:' + report], 'code'), '1 FULL/DELTA lost-evidence');
    assert.equal(bound(26, ['corrupt-artifact:' + report], 'code'), '1 FULL/DELTA lost-evidence', 'After recording it is stored evidence');
});

test('a finished review not yet recorded counts as passed: the edit after it follows the fix rules (operator answer 1)', () => {
    assert.equal(bound(25, ['edit-production'], 'test'), '1 DELTA small-fix', 'The unrecorded test review repeats in DELTA, as if recorded');
    assert.equal(bound(25, ['edit-production'], 'code'), '1 DELTA small-fix');
    assert.deepEqual(excess(25, ['edit-production'], ['code:FULL', 'test:FULL']), ['full-where-delta:code', 'full-where-delta:test']);
    assert.deepEqual(verdict(25, ['edit-production'], ['code:FULL', 'test:FULL']).unjudged, [], 'Nothing is left to an open question');
    assert.deepEqual(excess(25, ['edit-production'], ['code:DELTA', 'test:DELTA']), []);
    assert.deepEqual(excess(25, ['edit-production'], ['code:DELTA', 'test:FULL', 'test:FULL']), ['full-where-delta:test', 'extra-launch:test']);
    assert.equal(bound(19, ['edit-test'], 'code'), '0  outside-scope', 'Outside its scope the finished review is kept');
    assert.deepEqual(excess(19, ['edit-test'], ['code:FULL', 'test:FULL']), ['extra-launch:code']);
    assert.deepEqual(excess(19, ['edit-test'], ['test:FULL']), [], 'test has not run yet');
    assert.deepEqual(excess(19, ['edit-production'], ['code:DELTA', 'test:FULL']), []);
    assert.deepEqual(excess(19, ['edit-production'], ['code:FULL', 'test:FULL']), ['full-where-delta:code']);
    assert.equal(bound(24, ['edit-production'], 'test'), '0  not-run', 'A reviewer that had not finished is still planned: it runs once');
});

test('lost task evidence repeats no review (operator answer 2), a reset repeats every review that ran (answer 4)', () => {
    for (const kind of ['delete-artifact', 'corrupt-artifact', 'stale-artifact']) {
        for (const name of ['T-WALK-full-suite-validation.json', 'T-WALK-preflight.json']) {
            const disturbance = kind + ':' + artifact(name);
            assert.equal(bound(26, [disturbance], 'code'), '0  task-evidence', disturbance);
            assert.deepEqual(excess(26, [disturbance], []), [], disturbance);
            assert.deepEqual(excess(26, [disturbance], ['code:FULL', 'test:FULL']), ['extra-launch:code', 'extra-launch:test'], disturbance);
            assert.deepEqual(verdict(26, [disturbance], ['code:FULL', 'test:FULL']).unjudged, [], disturbance);
            assert.deepEqual(excess(20, [disturbance], ['test:FULL']), [], 'A planned review still runs once: ' + disturbance);
            assert.deepEqual(excess(20, [disturbance], ['code:FULL', 'test:FULL']), ['extra-launch:code'], disturbance);
        }
    }
    assert.deepEqual(excess(12, ['delete-artifact:' + artifact('T-WALK-preflight.json')], ['code:FULL', 'code:FULL', 'test:FULL']), ['extra-launch:code'],
        'A planned review runs once');
    assert.deepEqual(excess(26, ['delete-artifact:' + artifact('T-WALK-preflight.json'), 'edit-production'], ['code:DELTA', 'test:DELTA']), [],
        'With an edit the fix rules apply');
    assert.equal(bound(26, ['reset-task'], 'code'), '1 FULL reset');
    assert.deepEqual(excess(26, ['reset-task'], ['code:FULL', 'test:FULL']), []);
    assert.deepEqual(excess(26, ['reset-task'], ['code:DELTA', 'test:DELTA']), ['delta-where-full:code', 'delta-where-full:test']);
    assert.deepEqual(excess(26, ['reset-task'], ['code:FULL', 'code:FULL', 'test:FULL']), ['extra-launch:code']);
    assert.equal(bound(12, ['reset-task'], 'code'), '0  not-run', 'A review that never ran is planned once');
    assert.deepEqual(verdict(26, ['change-criteria', 'delete-artifact:' + artifact('T-WALK-preflight.json')], ['code:FULL', 'test:FULL']).excess, [],
        'Changed criteria still decide everything');
});

test('an edit with lost evidence repeats only that review in FULL; the edit follows the rules for the others (operator answer 3)', () => {
    const lost = 'delete-artifact:' + artifact('T-WALK-code-receipt.json');
    assert.equal(bound(26, ['edit-production', lost], 'code'), '1 FULL lost-evidence-with-fix');
    assert.equal(bound(26, ['edit-production', lost], 'test'), '1 DELTA small-fix');
    assert.deepEqual(excess(26, ['edit-production', lost], ['code:FULL', 'test:DELTA']), []);
    assert.deepEqual(excess(26, ['edit-production', lost], ['code:FULL', 'test:FULL']), ['full-where-delta:test']);
    assert.deepEqual(verdict(26, ['edit-production', lost], ['code:FULL', 'test:FULL']).unjudged, []);
    assert.deepEqual(excess(26, ['edit-production', lost], ['code:DELTA', 'test:DELTA']), ['delta-where-full:code']);
    assert.deepEqual(excess(26, ['edit-test', lost], ['code:FULL', 'test:DELTA']), [], 'The lost review repeats even outside the edit scope');
    assert.deepEqual(excess(26, ['edit-test', lost], ['code:FULL', 'code:FULL', 'test:DELTA']), ['extra-launch:code']);
    assert.equal(bound(26, ['edit-document', lost], 'code'), '1 FULL/DELTA lost-evidence', 'A document is no code change');
    assert.deepEqual(excess(26, ['edit-document', lost], ['code:FULL', 'test:FULL']), ['extra-launch:test']);
    assert.equal(bound(20, ['edit-test', 'delete-artifact:' + artifact('T-WALK-test-review-context.json')], 'code'), '0  outside-scope', 'A pending lane has no evidence to lose');
    assert.deepEqual(excess(26, ['stale-lock', 'repeat-last', lost], ['code:FULL']), []);
    assert.deepEqual(excess(26, [lost, 'delete-artifact:' + artifact('T-WALK-test-receipt.json')], ['code:FULL', 'test:FULL']), []);
    const declared: EconomyFacts = { ...CLEAN, dependencies: { test: ['code'], code: [] } };
    assert.equal(bound(26, ['edit-document', lost], 'test', declared), '1 FULL/DELTA lost-evidence', 'A declared graph re-opens dependents');
});

test('with an edit, a review depending on the lost one follows the edit rules, not the lost-evidence rule (operator answer 3)', () => {
    const lostTest = 'delete-artifact:' + artifact('T-WALK-test-receipt.json');
    const codeAfterTest: EconomyFacts = { ...CLEAN, dependencies: { code: ['test'], test: [] } };
    assert.equal(bound(26, ['edit-document', lostTest], 'code', codeAfterTest), '1 FULL/DELTA lost-evidence', 'Without an edit the graph re-opens it');
    assert.equal(bound(26, ['edit-test', lostTest], 'test', codeAfterTest), '1 FULL lost-evidence-with-fix');
    assert.equal(bound(26, ['edit-test', lostTest], 'code', codeAfterTest), '0  outside-scope', 'The test edit does not reach code');
    assert.deepEqual(excess(26, ['edit-test', lostTest], ['test:FULL', 'code:FULL'], codeAfterTest), ['extra-launch:code']);
    const lostCode = 'delete-artifact:' + artifact('T-WALK-code-receipt.json');
    const declared: EconomyFacts = { ...CLEAN, dependencies: { test: ['code'], code: [] } };
    assert.equal(bound(26, ['edit-production', lostCode], 'test', declared), '1 DELTA small-fix', 'Inside the edit scope a small fix is DELTA');
    assert.deepEqual(excess(26, ['edit-production', lostCode], ['code:FULL', 'test:FULL'], declared), ['full-where-delta:test']);
});

test('a review the rules require to repeat is a missed-review finding when the run keeps it', () => {
    const missed = (...args: Parameters<typeof run>) => verdict(...args).missed.map(entry => entry.lane + ':' + entry.rule);
    assert.deepEqual(missed(26, ['reset-task'], []), ['code:reset', 'test:reset'], 'A reset keeps no passed review');
    assert.deepEqual(missed(26, ['reset-task'], ['code:FULL', 'test:FULL']), []);
    assert.deepEqual(missed(26, ['edit-production'], []), ['code:small-fix', 'test:small-fix'], 'An edit inside a passed review repeats it');
    assert.deepEqual(missed(26, ['edit-production'], ['code:DELTA']), ['test:small-fix']);
    assert.deepEqual(missed(26, ['edit-production'], ['code:FULL', 'test:FULL']), [], 'A FULL instead of a DELTA is economy, not a missed review');
    assert.deepEqual(missed(25, ['edit-production'], ['code:DELTA']), ['test:small-fix'], 'A finished unrecorded review counts as passed');
    assert.deepEqual(missed(26, ['edit-test'], []), ['test:small-fix']);
    assert.deepEqual(missed(19, ['edit-test'], ['test:FULL']), [], 'Outside its scope the review is kept');
    const lost = (kind: string, name: string) => kind + ':' + artifact(name);
    assert.deepEqual(missed(26, [lost('delete-artifact', 'T-WALK-code-receipt.json')], []), ['code:lost-evidence'], 'Lost evidence repeats that review');
    assert.deepEqual(missed(26, [lost('corrupt-artifact', 'T-WALK-code.md')], []), ['code:lost-evidence']);
    assert.deepEqual(missed(26, [lost('delete-artifact', 'T-WALK-code-receipt.json'), 'edit-test'], ['test:DELTA']), ['code:lost-evidence-with-fix']);
    assert.deepEqual(missed(26, [lost('stale-artifact', 'T-WALK-code-receipt.json')], []), [], 'A stale timestamp loses nothing');
    assert.deepEqual(missed(26, [lost('delete-artifact', 'T-WALK-code-review-context.json')], []), [], 'Derived files: the rules do not decide');
    const declared: EconomyFacts = { ...CLEAN, dependencies: { test: ['code'], code: [] } };
    assert.deepEqual(missed(26, [lost('delete-artifact', 'T-WALK-code-receipt.json')], ['code:FULL'], declared), [], 'Dependents are not required');
    for (const disturbance of ['edit-document', 'stale-lock', lost('delete-artifact', 'T-WALK-preflight.json')]) {
        assert.deepEqual(missed(26, [disturbance], []), [], disturbance);
    }
    const result: WalkResult = { ...run(26, ['edit-production'], ['code:DELTA']), steps: restartSteps() };
    const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'clean-pass', step: 26, gate: 'required-reviews-check', disturbances: [{ kind: 'edit-production' }], economy: CLEAN } };
    const findings = compareWalk(scenario, result);
    assert.deepEqual(findings.map(entry => [entry.kind, entry.id]), [['safety', 'walk:economy:missed-review:test:sweep-fixture']]);
    assert.equal(findings[0].detail.replay, 'GARDA_SYNTHETIC_SEED=42 GARDA_SYNTHETIC_WALK_ONLY=sweep-fixture');
    const summary = summarizeReviewEconomy([{ ...result, scenarioId: 'm' }]);
    assert.deepEqual([summary.judged, summary.withinBound, summary.missedReview], [1, 0, 1]);
    assert.deepEqual([summary.groups[0].kind, summary.groups[0].lanes, summary.groups[0].rule], ['missed-review', ['test'], 'small-fix']);
});

test('a required review that has not run must launch in FULL after an ordinary disturbance', () => {
    const lostPreflight = 'delete-artifact:' + artifact('T-WALK-preflight.json');
    for (const disturbance of ['stale-lock', lostPreflight]) {
        const result = run(20, [disturbance], []);
        assert.deepEqual(judgeReviewEconomy(result)!.missed.map(entry => [entry.lane, entry.rule]), [['test', 'not-run']]);
        assert.deepEqual(verdict(20, [disturbance], ['test:FULL']).missed, []);
        assert.deepEqual(verdict(20, [disturbance], ['test:DELTA']).missed.map(entry => [entry.lane, entry.requiredMode]), [['test', 'FULL']]);
        const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
            injection: { seed: 42, baseline: 'clean-pass', step: 20, gate: 'implementation',
                disturbances: disturbance === 'stale-lock' ? [{ kind: 'stale-lock' }]
                    : [{ kind: 'delete-artifact', artifact: { path: artifact('T-WALK-preflight.json'), kind: 'preflight' } }], economy: CLEAN } };
        assert.deepEqual(compareWalk(scenario, result).map(entry => [entry.kind, entry.id]),
            [['safety', 'walk:economy:missed-review:test:sweep-fixture']]);
    }
    const first = run(14, ['edit-test'], [], DOCUMENT_ONLY);
    first.events = [{ type: 'PREFLIGHT_CLASSIFIED', details: { required_reviews: { code: false, test: true } } }];
    assert.deepEqual(judgeReviewEconomy(first)!.missed.map(entry => [entry.lane, entry.rule]), [['test', 'first-review']]);
    first.events[0].details.required_reviews = { code: false, test: false };
    assert.deepEqual(judgeReviewEconomy(first)!.missed, [], 'A first review not selected by the final preflight is not required');
    const production = run(14, ['edit-production'], [], DOCUMENT_ONLY);
    production.events = first.events;
    assert.deepEqual(judgeReviewEconomy(production)!.missed.map(entry => [entry.lane, entry.rule]), [['code', 'first-review']],
        'Production code still needs a code review if Garda incorrectly leaves it out of the preflight');
});

test('changed criteria require FULL repeats of the lanes still required at DONE', () => {
    const result = run(26, ['change-criteria'], []);
    assert.deepEqual(judgeReviewEconomy(result)!.missed.map(entry => [entry.lane, entry.rule]), [['code', 'criteria'], ['test', 'criteria']]);
    assert.deepEqual(verdict(26, ['change-criteria'], ['code:DELTA', 'test:FULL']).missed.map(entry => [entry.lane, entry.requiredMode]),
        [['code', 'FULL']], 'A DELTA does not satisfy a required FULL repeat');
    assert.deepEqual(verdict(26, ['change-criteria'], ['code:FULL', 'test:FULL']).missed, []);
    const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'clean-pass', step: 26, gate: 'required-reviews-check',
            disturbances: [{ kind: 'change-criteria' }], economy: CLEAN } };
    assert.deepEqual(compareWalk(scenario, result).map(entry => entry.id),
        ['walk:economy:missed-review:code:sweep-fixture', 'walk:economy:missed-review:test:sweep-fixture']);
    result.events = [{ type: 'PREFLIGHT_CLASSIFIED', details: { required_reviews: { code: false, test: true } } }];
    assert.deepEqual(judgeReviewEconomy(result)!.missed.map(entry => entry.lane), ['code', 'test'],
        'The observed preflight cannot silently drop a baseline requirement');
    result.sweep!.requiredAtDone = ['test'];
    assert.deepEqual(judgeReviewEconomy(result)!.missed.map(entry => entry.lane), ['test'], 'Changed criteria no longer require code');
    assert.deepEqual(verdict(20, ['change-criteria'], ['test:FULL']).missed.map(entry => [entry.lane, entry.rule]), [['code', 'criteria']]);
    const reset = run(26, ['reset-task'], ['test:FULL']);
    reset.events = result.events;
    assert.deepEqual(judgeReviewEconomy(reset)!.missed.map(entry => entry.lane), ['code'], 'A reset cannot trust Garda to drop code');
    reset.sweep!.requiredAtDone = ['test'];
    assert.deepEqual(judgeReviewEconomy(reset)!.missed, [], 'A reset can remove a formerly required lane');
});

test('an edit still requires a reached lane when its derived evidence or stale receipt is lost', () => {
    for (const [kind, name] of [['delete-artifact', 'T-WALK-code-review-context.json'],
        ['delete-artifact', '../tmp/reviews/T-WALK/code/reviewer-launch-input.json'],
        ['stale-artifact', 'T-WALK-code-receipt.json']]) {
        const lost = kind + ':' + artifact(name);
        const result = run(26, ['edit-production', lost], ['test:DELTA']);
        assert.deepEqual(judgeReviewEconomy(result)!.missed.map(entry => [entry.lane, entry.rule]), [['code', 'lost-evidence-with-fix']], lost);
        const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
            injection: { seed: 42, baseline: 'clean-pass', step: 26, gate: 'required-reviews-check',
                disturbances: [{ kind: 'edit-production' }], economy: CLEAN } };
        assert.deepEqual(compareWalk(scenario, result).map(entry => entry.id), ['walk:economy:missed-review:code:sweep-fixture']);
        assert.deepEqual(verdict(26, [lost], []).missed, [], 'The derived artifact or stale receipt alone need not lose a result');
        assert.deepEqual(verdict(26, ['edit-test', lost], ['test:DELTA']).missed, [], 'The edit does not reach code');
    }
});

test('a lane the baseline never reviewed runs once in FULL only when the change can require it', () => {
    assert.deepEqual(excess(26, ['stale-lock'], ['security:FULL']), ['extra-launch:security']);
    assert.deepEqual(excess(26, ['edit-production'], ['code:DELTA', 'test:DELTA', 'security:FULL']), ['extra-launch:security'],
        'A comment in reviewed production code does not reach the security review');
    assert.equal(reviewEconomyBound(26, ['edit-production'], CLEAN, ['security']).find(entry => entry.lane === 'security')?.rule, 'outside-scope');
    assert.deepEqual(excess(26, ['change-criteria'], ['code:FULL', 'test:FULL', 'security:FULL']), [], 'Which lanes changed criteria require is policy');
    assert.deepEqual(excess(26, ['edit-production'], ['code:FULL', 'test:FULL', 'security:FULL'], { ...CLEAN, scope: ['tests/app.test.ts'] }), [],
        'Which lanes a changed file set requires is policy');
    assert.deepEqual(excess(14, ['edit-production'], ['code:FULL', 'test:FULL'], DOCUMENT_ONLY), []);
    assert.deepEqual(excess(14, ['edit-test'], ['code:FULL', 'test:FULL'], DOCUMENT_ONLY), ['extra-launch:code']);
    assert.deepEqual(excess(14, ['edit-test'], ['test:FULL', 'test:FULL'], DOCUMENT_ONLY), ['extra-launch:test']);
    assert.deepEqual(excess(14, ['change-criteria'], ['code:FULL'], DOCUMENT_ONLY), []);
    assert.deepEqual(excess(14, ['edit-document'], ['code:FULL'], DOCUMENT_ONLY), ['extra-launch:code']);
});

test('DELTA and unknown launches are safety findings whenever FULL is required, including planned launches', () => {
    const lostCode = 'delete-artifact:' + artifact('T-WALK-code-receipt.json');
    for (const [step, disturbances, launches, expected] of [
        [26, ['reset-task'], ['code:DELTA', 'test:FULL'], 'code:reset'],
        [26, ['change-criteria'], ['code:DELTA', 'test:FULL'], 'code:criteria'],
        [26, ['edit-production', lostCode], ['code:DELTA', 'test:DELTA'], 'code:lost-evidence-with-fix'],
        [20, ['stale-lock'], ['test:DELTA'], 'test:not-run'],
        [14, ['edit-production'], ['code:DELTA', 'test:FULL'], 'code:first-review']
    ] as Array<[number, string[], string[], string]>) {
        const facts = step === 14 ? DOCUMENT_ONLY : CLEAN;
        const invalid = verdict(step, disturbances, launches, facts).excess.filter(entry => entry.kind === 'delta-where-full');
        assert.deepEqual(invalid.map(entry => entry.lane + ':' + entry.rule), [expected], disturbances.join(','));
    }
    // An adopted review-lane change keeps the passed code review: a relaunch is extra, not a FULL the rules require.
    assert.equal(reviewEconomyBound(26, ['change-policy'], CLEAN).find(entry => entry.lane === 'code')?.rule, 'policy');
    assert.deepEqual(excess(26, ['change-policy'], []), []);
    assert.deepEqual(excess(26, ['change-policy'], ['code:DELTA']), ['extra-launch:code']);
    assert.deepEqual(excess(20, ['stale-lock'], ['test:unknown']), ['unknown-mode:test']);
    assert.deepEqual(excess(26, ['reset-task'], ['code:unknown', 'test:FULL']), ['unknown-mode:code']);
    assert.deepEqual(excess(26, ['reset-task'], ['code:FULL', 'code:DELTA', 'test:FULL']),
        ['extra-launch:code', 'delta-where-full:code'], 'An extra launch must not hide the unsafe mode');
    assert.deepEqual(excess(26, [lostCode], ['code:DELTA']), [], 'The lost-evidence rule allows either mode');
    const plannedDelta: EconomyFacts = { ...CLEAN, reviews: [{ lane: 'test', mode: 'DELTA', launched: 30, recorded: 31 }] };
    assert.deepEqual(excess(26, ['stale-lock'], ['test:FULL'], plannedDelta), ['full-where-delta:test']);
    const result = run(26, ['reset-task'], ['code:DELTA', 'test:unknown']);
    const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'clean-pass', step: 26, gate: null, disturbances: [{ kind: 'reset-task' }], economy: CLEAN } };
    assert.deepEqual(compareWalk(scenario, result).filter(entry => entry.id.includes('delta-where-full') || entry.id.includes('unknown-mode'))
        .map(entry => [entry.kind, entry.id]), [['safety', 'walk:economy:delta-where-full:code:sweep-fixture'],
        ['safety', 'walk:economy:unknown-mode:test:sweep-fixture']]);
});

test('new sweep edits reach the right lanes, protected owner and scope-expansion bounds', () => {
    const four: EconomyFacts = { ...CLEAN, scope: [...CLEAN.scope, 'src/auth/session.ts', 'tests/helpers/render.ts'], reviews: [
        ...CLEAN.reviews, { lane: 'security', mode: 'FULL', launched: 20, recorded: 21 },
        { lane: 'refactor', mode: 'FULL', launched: 22, recorded: 23 }] };
    for (const kind of ['edit-test-large', 'edit-shared-test-helper']) {
        assert.equal(bound(26, [kind], 'code', four), '0  outside-scope');
        assert.equal(bound(26, [kind], 'refactor', four), '1 DELTA small-fix');
        assert.equal(bound(26, [kind], 'test', four), '1 DELTA small-fix');
        assert.deepEqual(excess(26, [kind], ['refactor:DELTA', 'test:DELTA'], four), []);
    }
    assert.equal(bound(26, ['add-test-file'], 'test', four), '1 DELTA small-fix');
    assert.equal(bound(26, ['add-test-file'], 'code', four), '0  outside-scope');
    assert.deepEqual(verdict(14, ['add-test-file'], [], DOCUMENT_ONLY).missed.map(entry => [entry.lane, entry.rule]), [['test', 'first-review']]);
    assert.deepEqual(verdict(14, ['edit-test-large'], [], DOCUMENT_ONLY).missed.map(entry => [entry.lane, entry.rule]),
        [['test', 'first-review']], 'An optional refactor lane does not become required merely by having review scope');
    const newlyRequired = reviewEconomyBound(14, ['edit-test-large'], DOCUMENT_ONLY, [], ['refactor', 'test']);
    assert.equal(newlyRequired.find(entry => entry.lane === 'refactor')?.required, 1, 'A newly required lane runs in FULL');
    assert.equal(newlyRequired.find(entry => entry.lane === 'refactor')?.requiredMode, 'FULL');
    assert.deepEqual(verdict(14, ['edit-protected'], [], DOCUMENT_ONLY).missed.map(entry => [entry.lane, entry.rule]),
        [['code', 'first-review'], ['security', 'first-review']]);
    assert.equal(bound(26, ['edit-production-large'], 'code', four), '1 FULL large-fix');
    assert.equal(bound(26, ['edit-production-large'], 'test', four), '1 FULL large-fix');
    assert.equal(bound(26, ['edit-production-large'], 'security', four), '0  outside-scope');
    assert.equal(bound(26, ['edit-protected'], 'security', four), '1 FULL protected-owner');
    assert.equal(bound(26, ['edit-protected'], 'code', four), '1 DELTA small-fix');
    assert.equal(bound(26, ['edit-protected'], 'test', four), '1 DELTA small-fix');
    assert.equal(bound(26, ['edit-protected'], 'refactor', four), '0  outside-scope');
    assert.deepEqual(excess(26, ['edit-protected'], ['code:DELTA', 'security:FULL', 'test:DELTA'], four), []);
    for (const lane of ['code', 'security', 'refactor', 'test']) assert.equal(bound(26, ['add-production-file'], lane, four), '1 FULL scope-expansion');
    assert.deepEqual(excess(26, ['add-production-file'], ['code:FULL', 'security:FULL', 'refactor:FULL', 'test:FULL'], four), []);
});

test('operator stops are rejected for routine disturbances and blocked launches remain judged', () => {
    for (const kind of ['edit-production', 'edit-test', 'edit-document', 'repeat-last', 'fail-gate', 'wrong-gate', 'change-criteria', 'change-policy', 'reset-task']) {
        const disturbance = (kind === 'wrong-gate' ? { kind, gate: 'compile-gate' } : { kind }) as SweepDisturbance;
        const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
            injection: { seed: 42, baseline: 'clean-pass', step: 26, gate: null, disturbances: [disturbance], economy: CLEAN } };
        const result = run(26, [kind === 'wrong-gate' ? 'wrong-gate:compile-gate' : kind], [], CLEAN, 'blocked');
        result.detail = 'This requires operator approval.';
        const finding = compareWalk(scenario, result).find(entry => entry.id === 'walk:operator-stop:' + kind + ':sweep-fixture');
        assert.equal(finding?.kind, 'safety', kind);
        assert.equal(finding?.detail.stopText, result.detail);
    }
    const result = run(26, ['edit-production'], ['code:FULL', 'code:FULL'], CLEAN, 'blocked');
    result.detail = 'This requires operator approval.';
    const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'clean-pass', step: 26, gate: null, disturbances: [{ kind: 'edit-production' }], economy: CLEAN } };
    assert.deepEqual(compareWalk(scenario, result).map(entry => entry.id), ['walk:operator-stop:edit-production:sweep-fixture',
        'walk:economy:full-where-delta:code:sweep-fixture', 'walk:economy:extra-launch:code:sweep-fixture']);
    const preview = run(26, ['edit-production'], [], CLEAN, 'blocked');
    preview.detail = 'Operator reset preview: node garda gate task-reset --dry-run';
    assert.equal(compareWalk(scenario, preview).find(entry => entry.id === 'walk:operator-stop:edit-production:sweep-fixture')?.detail.stopText,
        preview.detail);
    const loop = run(26, ['edit-production'], [], CLEAN, 'loop');
    loop.detail = 'Repeated routing was rejected.';
    const loopFindings = compareWalk(scenario, loop);
    assert.equal(loopFindings.find(entry => entry.id === 'walk:operator-stop:edit-production:sweep-fixture')?.detail.stopText, loop.detail);
    assert.ok(loopFindings.some(entry => entry.id === 'walk:outcome:loop:sweep-fixture'), 'Keep the independent loop diagnostic');
    const loopUnknown = run(26, ['edit-production'], ['code:unknown'], CLEAN, 'loop');
    assert.equal(compareWalk(scenario, loopUnknown).find(entry => entry.id === 'walk:economy:unknown-mode:code:sweep-fixture')?.kind, 'safety');
    const receipt = { ...scenario.injection!, disturbances: [{ kind: 'corrupt-artifact' as const,
        artifact: { kind: 'receipt' as const, path: artifact('T-WALK-code-receipt.json') } }] };
    assert.equal(isAllowedSweepHandoff(receipt, 'Restore the task evidence from its authenticated source.'), false);
    const openReport = { ...scenario.injection!, disturbances: [{ kind: 'corrupt-artifact' as const,
        artifact: { kind: 'report' as const, path: BUNDLE + '/tmp/reviews/T-WALK/code/review-output-1234.md' } }] };
    assert.equal(isAllowedSweepHandoff(openReport, 'Restore the task evidence from its authenticated source.'), false,
        'A broken open report is corrected by the same reviewer');
    const damaged = { ...scenario.injection!, disturbances: [{ kind: 'corrupt-artifact' as const,
        artifact: { kind: 'report' as const, path: artifact('T-WALK-task-mode.json') } }] };
    assert.equal(isAllowedSweepHandoff(damaged, 'Restore the task evidence from its authenticated source.'), true);
    assert.equal(isAllowedSweepHandoff(damaged, 'This requires operator approval.'), false);
    assert.equal(isAllowedSweepHandoff(damaged, 'The evidence requires operator approval.'), false);
    const history = { ...damaged, disturbances: [{ kind: 'corrupt-artifact' as const,
        artifact: { kind: 'report' as const, path: BUNDLE + '/task-events/T-WALK.jsonl' } }] };
    assert.equal(isAllowedSweepHandoff(history, 'Ask the operator to restore the task history from its authenticated source.'), true);
    for (const name of ['T-WALK-handshake.json', 'T-WALK-shell-smoke.json']) {
        const startup = { ...damaged, disturbances: [{ kind: 'delete-artifact' as const,
            artifact: { kind: 'report' as const, path: artifact(name) } }] };
        assert.equal(isAllowedSweepHandoff(startup, 'Ask the operator to preserve the task evidence and reset the task.'), false, name);
        assert.equal(isAllowedSweepHandoff(startup, 'This requires operator approval.'), false, name);
    }
    const preflight = { ...damaged, disturbances: [{ kind: 'delete-artifact' as const,
        artifact: { kind: 'preflight' as const, path: artifact('T-WALK-preflight.json') } }] };
    assert.equal(isAllowedSweepHandoff(preflight, 'Restore the task evidence from its authenticated source.'), false);
    const checklist = { ...damaged, disturbances: [{ kind: 'corrupt-artifact' as const,
        artifact: { kind: 'checklist' as const, path: artifact('T-WALK-quality-checklist.json') } }] };
    assert.equal(isAllowedSweepHandoff(checklist, 'Restore the task evidence from its authenticated source.'), false,
        'Ordinary task evidence is not authenticated task history');
    assert.equal(isAllowedSweepHandoff(scenario.injection!, 'Restore the original protected evidence.'), false);
});

test('a code-review safety floor accepts only its actual refusal and both named ways out', () => {
    const scenario: WalkScenario = { id: 'floor', edits: [], expectedReviews: {}, expectedModes: [], profile: 'docs-only',
        injection: { seed: 42, baseline: 'document-only', step: 2, gate: 'handshake-diagnostics',
            disturbances: [{ kind: 'edit-production' }] } };
    const output = 'The code-review safety floor cannot be satisfied because the configured code-review lane is inactive. '
        + 'The change touches code that requires a code review, and the task profile does not include one. '
        + 'Revert the code edit so the task stays within its profile, or ask the operator to reset the task '
        + '(garda gate task-reset) and enter it again with a profile whose review policy includes the code review.';
    const last = { ...blankStep(3), gate: 'classify-change', exitCode: 1, output };
    const stop: WalkResult = { ...run(2, ['edit-production'], [], DOCUMENT_ONLY, 'blocked'), steps: [last], detail: output };
    assert.deepEqual(compareWalk(scenario, stop).map(entry => entry.id), []);
    const incomplete = [output.replace('Revert the code edit so the task stays within its profile', 'Resolve the edit'),
        output.replace('with a profile whose review policy includes the code review', 'with a different profile')];
    const impostors: WalkResult[] = [
        ...incomplete.map(detail => ({ ...stop, detail, steps: [{ ...last, output: detail }] })),
        { ...stop, steps: [{ ...last, gate: 'compile-gate' }] },
        { ...stop, steps: [{ ...last, exitCode: 0 }] },
        { ...stop, detail: 'This requires operator approval.' },
        { ...stop, outcome: 'loop' }
    ];
    for (const candidate of impostors) {
        assert.ok(compareWalk(scenario, candidate).some(entry => entry.id === 'walk:operator-stop:edit-production:floor'));
    }
    const documents: WalkScenario = { ...scenario, injection: { ...scenario.injection!, disturbances: [{ kind: 'edit-document' }] } };
    const noCode = { ...stop, sweep: { ...stop.sweep!, disturbances: ['edit-document'], applied: ['edit-document'] } };
    assert.ok(compareWalk(documents, noCode).some(entry => entry.id === 'walk:operator-stop:edit-document:floor'),
        'An invented safety floor must not hide a stop when no code was changed');
    const notApplied = { ...stop, sweep: { ...stop.sweep!, applied: [] } };
    assert.ok(compareWalk(scenario, notApplied).some(entry => entry.id === 'walk:operator-stop:edit-production:floor'));
    const plannedCode = { ...documents, edits: [{ path: 'src/app.ts', append: '// planned code\n' }] };
    const afterImplementation = { ...noCode, steps: [{ ...blankStep(2), gate: 'implementation' }, last] };
    assert.deepEqual(compareWalk(plannedCode, afterImplementation).map(entry => entry.id), [],
        'Code in the implemented task scope can also trigger the floor');
});

test('only lost launch authority with an exact reset handoff is an honest lane-owned stop', () => {
    const guidance = 'Ask the operator to reset this task with task-reset and enter it again. '
        + 'Do not reconstruct missing or corrupt launch-control or lane-reservation evidence.';
    for (const [lane, suffix] of [['code', ''], ['code', '.lane-reservation.json'],
        ['custom-quality', ''], ['custom-quality', '.lane-reservation.json']]) {
        const file = BUNDLE + '/tmp/reviews/T-WALK/' + lane + '/reviewer-launch.json' + suffix;
        const disturbance: SweepDisturbance = { kind: 'delete-artifact', artifact: { kind: 'launch', path: file } };
        const scenario: WalkScenario = { id: 'authority', edits: [], expectedReviews: {}, expectedModes: [],
            injection: { seed: 42, baseline: 'clean-pass', step: 20, gate: 'record-review-result', disturbances: [disturbance] } };
        const stop = run(20, ['delete-artifact:' + file], [], CLEAN, 'blocked');
        stop.detail = guidance;
        assert.deepEqual(compareWalk(scenario, stop).map(entry => entry.id), [], lane + suffix);
        for (const detail of ['This requires operator approval.', 'Ask the operator to reset this task with task-reset and enter it again.',
            'Do not reconstruct missing or corrupt launch-control or lane-reservation evidence.']) {
            assert.ok(compareWalk(scenario, { ...stop, detail }).some(entry => entry.id === 'walk:operator-stop:delete-artifact:authority'));
        }
        const report = { ...scenario.injection!, disturbances: [{ kind: 'delete-artifact' as const,
            artifact: { kind: 'report' as const, path: BUNDLE + '/tmp/reviews/T-WALK/code/review-output-1234.md' } }] };
        assert.equal(isAllowedSweepHandoff(report, guidance), false);
        const input = { ...scenario.injection!, disturbances: [{ kind: 'delete-artifact' as const,
            artifact: { kind: 'launch' as const, path: BUNDLE + '/tmp/reviews/T-WALK/code/reviewer-launch-input.json' } }] };
        assert.equal(isAllowedSweepHandoff(input, guidance), false, 'A reviewer input is not launch authority');
    }
});

test('lost startup evidence before preflight cannot be hidden by an operator reset', () => {
    for (const name of ['T-WALK-handshake.json', 'T-WALK-shell-smoke.json']) {
        const file = artifact(name);
        const scenario: WalkScenario = { id: 'startup', edits: [], expectedReviews: {}, expectedModes: [],
            injection: { seed: 42, baseline: 'clean-pass', step: 3, gate: 'classify-change',
                disturbances: [{ kind: 'delete-artifact', artifact: { kind: 'report', path: file } }] } };
        const stop = run(3, ['delete-artifact:' + file], [], CLEAN, 'blocked');
        stop.detail = 'Ask the operator to preserve the task evidence and reset the task.';
        assert.ok(compareWalk(scenario, stop).some(entry => entry.id === 'walk:operator-stop:delete-artifact:startup'), name);
    }
});

test('only an edit after the current passed review gate receives modeled user approval', () => {
    const injection: SweepInjection = { seed: 42, baseline: 'clean-pass', step: 26, gate: null, disturbances: [{ kind: 'edit-production' }] };
    const event = (type: string) => ({ type, details: {} });
    assert.equal(shouldApproveInjectedRestart(injection, []), false);
    assert.equal(shouldApproveInjectedRestart(injection, [event('REVIEW_GATE_PASSED')]), true);
    assert.equal(shouldApproveInjectedRestart(injection, [event('REVIEW_GATE_PASSED_WITH_OVERRIDE')]), true);
    assert.equal(shouldApproveInjectedRestart(injection, [event('REVIEW_GATE_PASSED'), event('REVIEW_CYCLE_RESTARTED')]), false);
    assert.equal(shouldApproveInjectedRestart(injection, [event('REVIEW_GATE_PASSED'), event('IMPLEMENTATION_STARTED')]), false);
    assert.equal(shouldApproveInjectedRestart({ ...injection, disturbances: [{ kind: 'stale-lock' }] }, [event('REVIEW_GATE_PASSED')]), false);
    for (const kind of ['change-criteria', 'change-policy'] as const) {
        assert.equal(shouldApproveInjectedRestart({ ...injection, disturbances: [{ kind }] }, [event('REVIEW_GATE_PASSED')]), true);
        assert.equal(shouldApproveInjectedRestart({ ...injection, disturbances: [{ kind }] }, []), false);
    }
    assert.equal(shouldApproveInjectedRestart({ ...injection, disturbances: [{ kind: 'edit-production' }, { kind: 'reset-task' }] }, [event('REVIEW_GATE_PASSED')]), false);
});

test('an early injected edit does not replace the task\'s still-pending implementation', () => {
    for (const kind of ['edit-production', 'edit-test-large', 'add-test-file', 'add-production-file', 'edit-document', 'reset-task']) {
        assert.equal(needsInjectedImplementation([kind], false, 'compile-gate'), true, kind);
        assert.equal(needsInjectedImplementation([kind], false, 'classify-change'), false, kind);
        assert.equal(needsInjectedImplementation([kind], true, 'compile-gate'), false, kind);
    }
    assert.equal(needsInjectedImplementation(['change-criteria'], false, 'compile-gate'), false);
    assert.equal(needsInjectedImplementation(['repeat-last'], false, 'compile-gate'), false);
});

test('policy recovery follows the navigator adoption route with the modeled user approval', () => {
    const injection: SweepInjection = { seed: 42, baseline: 'clean-pass', step: 1, gate: 'load-rule-pack', disturbances: [{ kind: 'change-policy' }] };
    const refused = { ...blankStep(1), gate: 'load-rule-pack', exitCode: 3,
        output: 'Task profile policy inputs changed after preflight (review lane policy). The task keeps the review policy frozen at task-mode entry: '
            + 'revert the change, or after the operator approves it re-enter task mode with --adopt-changed-review-policy and fresh operator confirmation.' };
    assert.equal(isReviewPolicyRefusal(injection, refused), true, 'the refusal returns to the navigator instead of ending the walk');
    assert.equal(isReviewPolicyRefusal({ ...injection, disturbances: [{ kind: 'change-criteria' }] }, refused), false);
    assert.equal(isReviewPolicyRefusal(injection, { ...refused, output: 'Different failure' }), false);

    const digest = 'c'.repeat(64);
    const route = `node garda gate enter-task-mode --task-id "T-WALK" --adopt-changed-review-policy "${digest}" `
        + '--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --repo-root "."';
    assert.equal(approvePolicyAdoption(injection, 'enter-task-mode', route, '2026-11-05T12:00:00.000Z'),
        route.replace('<ISO-8601 timestamp>', '2026-11-05T12:00:00.000Z'));
    assert.equal(approvePolicyAdoption(injection, 'load-rule-pack', route), null);
    assert.equal(approvePolicyAdoption({ ...injection, disturbances: [{ kind: 'change-criteria' }] }, 'enter-task-mode', route), null);
    assert.equal(approvePolicyAdoption(injection, 'enter-task-mode', route.replace(`"${digest}"`, '""')), null,
        'only the navigator command with its digest is approved');
});

test('terminal variants judge launches, but unfinished variants cannot miss future reviews', () => {
    const blocked = verdict(26, ['edit-production'], ['code:FULL', 'code:FULL'], CLEAN, 'blocked');
    assert.deepEqual(blocked.excess.map(entry => entry.kind), ['full-where-delta', 'extra-launch']);
    assert.deepEqual(blocked.missed, []);
    assert.deepEqual(verdict(26, ['edit-production'], [], CLEAN, 'loop').missed, []);
    assert.deepEqual(excess(26, ['reset-task'], ['code:unknown'], CLEAN, 'loop'), ['unknown-mode:code']);
    const open = run(26, ['edit-production'], ['code:FULL'], CLEAN, 'blocked');
    open.reviews.at(-1)!.completed = null;
    assert.deepEqual(judgeReviewEconomy(open)!.excess.map(entry => entry.kind + ':' + entry.lane), ['full-where-delta:code'],
        'A launched reviewer counts even if it has not returned before the stop');
    const { economy: _economy, ...sweep } = run(26, ['stale-lock'], []).sweep!;
    assert.equal(judgeReviewEconomy({ ...run(26, ['stale-lock'], []), sweep }), null, 'Hand-built injections stay unjudged');
    assert.deepEqual(verdict(26, ['stale-lock'], []).observed, [], 'Reviews of the prefix ran before the disturbance');
});

test('an already-started reviewer is not a future planned launch, and an affected unfinished review needs FULL', () => {
    const inFlight: EconomyFacts = { ...CLEAN, reviews: [
        { lane: 'code', mode: 'FULL', launched: 17, completed: 18, recorded: 19 },
        { lane: 'test', mode: 'FULL', launched: 23, completed: 24, recorded: 25 }
    ] };
    assert.equal(bound(18, ['stale-lock'], 'code', inFlight), '0  untouched');
    assert.deepEqual(excess(18, ['stale-lock'], ['code:FULL'], inFlight, 'blocked'), ['extra-launch:code']);
    assert.equal(bound(18, ['edit-production'], 'code', inFlight), '1 FULL in-flight');
    assert.deepEqual(excess(18, ['edit-production'], ['code:DELTA'], inFlight, 'blocked'), ['delta-where-full:code']);
    assert.deepEqual(excess(18, ['edit-production'], ['code:FULL'], inFlight, 'blocked'), []);
});

test('review mode is captured when delegation starts, including a missing context mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-start-'));
    try {
        const file = path.join(root, BUNDLE, 'reviews/T-WALK-code-review-context.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ review_execution: { mode: 'DELTA' } }));
        assert.deepEqual(observeReviewerLaunch(root, 'T-WALK', 'code', 12), { lane: 'code', mode: 'DELTA', step: 12, completed: null });
        fs.writeFileSync(file, JSON.stringify({ review_execution: {} }));
        assert.equal(observeReviewerLaunch(root, 'T-WALK', 'code', 12).mode, 'unknown');
        fs.unlinkSync(file);
        assert.equal(observeReviewerLaunch(root, 'T-WALK', 'code', 12).mode, 'unknown');
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('garda-review-start-'));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the facts come from a passing baseline run and reach every sweep variant, keeping wrong-gate expectations separate', () => {
    const step = (index: number, gate: string | null, route: string, exitCode = 0): WalkStep => ({ ...blankStep(index), gate, route,
        status: gate ? 'BLOCKED' : 'DONE', command: gate && 'node garda gate ' + gate, exitCode });
    const steps = [step(0, 'complete-reviewer-launch', 'BLOCKED/complete-reviewer-launch/code'), step(1, 'record-review-result', 'BLOCKED/record-review-result/code', 1),
        step(2, 'record-review-result', 'BLOCKED/record-review-result/code'), step(3, 'complete-reviewer-launch', 'BLOCKED/complete-reviewer-launch/test'), step(4, 'completion-gate', 'BLOCKED/completion-gate'), step(5, null, 'DONE/(done)')];
    const result: WalkResult = { scenarioId: 'fixture', outcome: 'done', detail: '', steps, reviewsByLane: { code: 1, test: 1 }, events: [],
        reviews: [{ lane: 'code', mode: 'FULL', step: 0 }, { lane: 'test', mode: 'FULL', step: 3 }] };
    const graph = { preparation_order: ['code', 'test'], dependencies: { code: [], test: ['code'] } };
    const edits = [{ path: 'tests/app.test.ts', append: 'x\n' }, { path: 'src/app.ts', append: 'y\n' }];
    const expected: EconomyFacts = { dependencies: {}, scope: ['src/app.ts', 'tests/app.test.ts'],
        reviews: [{ lane: 'code', mode: 'FULL', launched: 0, recorded: 2 }, { lane: 'test', mode: 'FULL', launched: 3, recorded: null }] };
    assert.deepEqual(economyFacts({ edits }, result), expected, 'Only an accepted record closes a review; a refused one does not');
    const started: WalkResult = { ...result, reviews: [{ lane: 'code', mode: 'FULL', step: 0, completed: 1 },
        { lane: 'test', mode: 'FULL', step: 3, completed: null }] };
    assert.deepEqual(economyFacts({ edits }, started)!.reviews, [
        { lane: 'code', mode: 'FULL', launched: 0, completed: 1, recorded: 2 },
        { lane: 'test', mode: 'FULL', launched: 3, completed: null, recorded: null }
    ]);
    assert.deepEqual(economyFacts({ edits, dependencyGraph: graph }, result)!.dependencies, graph.dependencies);
    assert.equal(economyFacts({ edits, failures: { test: 1 } }, result), undefined, 'A failed review is judged by its scenario family');
    assert.equal(economyFacts({ edits, failureAttempts: { code: [2] } }, result), undefined);
    const scenario: WalkScenario = { id: 'fixture', edits, expectedReviews: {}, expectedModes: [] };
    const sweep = buildSweepScenarios([{ scenario, result }], 7);
    assert.ok(sweep.length > 0);
    for (const entry of sweep) assert.deepEqual(entry.injection!.economy, expected, entry.id);
    assert.ok(sweep.filter(entry => entry.injection!.undisturbed).every(entry => entry.injection!.disturbances[0].kind === 'wrong-gate'));
    assert.ok(buildSweepScenarios([{ scenario: { ...scenario, failures: { code: 1 } }, result }], 7).every(entry => !('economy' in entry.injection!)));
    const combination = sweep.find(entry => entry.injection!.disturbances.length > 1)!;
    const saved = sweep.map(entry => ({ id: entry.id, ...entry.injection! }));
    const replayBaselines = [{ scenario, result }];
    assert.deepEqual(replaySweepScenarios(replayBaselines, saved, [combination.id], 7), [combination],
        'The saved roles and original economy facts survive a fresh baseline with different observed inputs');
    assert.throws(() => replaySweepScenarios(replayBaselines, saved, [combination.id], 8), /Invalid or unknown/u);
    assert.throws(() => replaySweepScenarios(replayBaselines, saved, ['sweep-missing'], 7), /Invalid or unknown/u);
    assert.throws(() => replaySweepScenarios(replayBaselines, saved, [combination.id, combination.id], 7), /distinct/u);
    const tampered = saved.map(entry => entry.id === combination.id ? { ...entry, disturbances: [{ kind: 'edit-document' as const }] } : entry);
    assert.throws(() => replaySweepScenarios(replayBaselines, tampered, [combination.id], 7), /Invalid or unknown/u);
    const altered = { ...result, reviews: result.reviews.map(review => ({ ...review, mode: 'DELTA' })) };
    assert.throws(() => replaySweepScenarios([{ scenario, result: altered }], saved, [combination.id], 7), /baseline changed/u);
    const shifted = { ...result, steps: result.steps.map(step => step.index === combination.injection!.step
        ? { ...step, gate: 'other-gate' } : step) };
    assert.throws(() => replaySweepScenarios([{ scenario, result: shifted }], saved, [combination.id], 7), /baseline changed/u);
});

test('the bound reads the same edits the sweep writes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-economy-edit-'));
    try {
        for (const [kind, edit] of Object.entries(SWEEP_EDITS)) {
            fs.mkdirSync(path.dirname(path.join(root, edit.path)), { recursive: true });
            const newFile = edit.role === 'new-test' || edit.role === 'new-production';
            if (!newFile) fs.writeFileSync(path.join(root, edit.path), 'existing\n');
            mutateSweepFile(root, { kind: kind as keyof typeof SWEEP_EDITS });
            assert.equal(fs.readFileSync(path.join(root, edit.path), 'utf8'), (newFile ? '' : 'existing\n') + edit.append, kind);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a policy disturbance changes the active review policy and retains valid JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-economy-policy-'));
    try {
        const file = path.join(root, 'garda-agent-orchestrator/live/config/profiles.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const initial = { balanced: { review_policy: { code: true, test: true } }, 'docs-only': { review_policy: { code: false, test: false } } };
        for (const profile of ['balanced', 'docs-only']) {
            fs.writeFileSync(file, JSON.stringify({ built_in_profiles: initial }));
            fs.writeFileSync(path.join(root, 'TASK.md'), '| T-WALK | TODO | P1 | area | title | owner | date | ' + profile + ' | notes |\n');
            mutateSweepFile(root, { kind: 'change-policy' });
            const profiles = JSON.parse(fs.readFileSync(file, 'utf8')) as { built_in_profiles: Record<string, { review_policy: Record<string, unknown> }> };
            assert.equal(profiles.built_in_profiles[profile].review_policy.code, 'auto');
            const other = profile === 'balanced' ? 'docs-only' : 'balanced';
            assert.deepEqual(profiles.built_in_profiles[other], initial[other]);
        }
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('garda-economy-policy-'));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('artifacts belong to a lane by name or launch folder, everything else to the task', () => {
    for (const name of ['T-WALK-code.md', 'T-WALK-code-receipt.json', 'T-WALK-code-review-context.md', 'T-WALK-code-findings-disposition-abc.json', 'T-WALK-code-role-prompt.md']) {
        assert.equal(artifactLane(artifact(name), ['code', 'test']), 'code', name);
    }
    assert.equal(artifactLane(BUNDLE + '/tmp/reviews/T-WALK/test/reviewer-launch.json.lane-reservation.json', ['code', 'test']), 'test');
    for (const name of ['T-WALK-compile-gate.json', 'T-WALK-preflight.json', 'T-WALK-review-gate.json', 'T-WALK-task-mode.json', 'T-WALK-scoped-diff-summary.json']) {
        assert.equal(artifactLane(artifact(name), ['code', 'test']), null, name);
    }
    assert.equal(artifactLane(BUNDLE + '/tmp/T-WALK-quality-checklist-answers.json', ['code', 'test']), null);
});

test('compareWalk reports one economy finding per lane and kind with its recovery route and replay', () => {
    const result: WalkResult = { ...run(26, ['edit-production'], ['code:FULL', 'code:FULL', 'test:DELTA']), steps: restartSteps() };
    const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'clean-pass', step: 26, gate: 'required-reviews-check', disturbances: [{ kind: 'edit-production' }], economy: CLEAN } };
    const findings = compareWalk(scenario, result);
    assert.deepEqual(findings.map(entry => [entry.kind, entry.id]),
        [['economy', 'walk:economy:full-where-delta:code:sweep-fixture'], ['economy', 'walk:economy:extra-launch:code:sweep-fixture']]);
    assert.equal(findings[0].detail.route, 'BLOCKED/restart-coherent-cycle');
    assert.equal(findings[0].detail.replay, 'GARDA_SYNTHETIC_SEED=42 GARDA_SYNTHETIC_WALK_ONLY=sweep-fixture');
    assert.equal(findings[0].detail.rule, 'small-fix');
    assert.deepEqual(compareWalk({ ...scenario, injection: { ...scenario.injection!, economy: undefined } }, { ...result, sweep: { ...result.sweep!, economy: undefined } }), [],
        'A hand-built injection keeps its own expectations');
    const wrong: WalkScenario = { ...scenario, injection: { ...scenario.injection!, disturbances: [{ kind: 'wrong-gate', gate: 'compile-gate' }],
        undisturbed: { reviews: { code: 1, test: 1 }, milestones: [], restarts: {}, returnRoutes: ['BLOCKED/implementation'] } } };
    const wrongResult: WalkResult = { ...run(26, ['wrong-gate:compile-gate'], ['code:FULL']), steps: restartSteps(), reviewsByLane: { code: 2, test: 1 } };
    const wrongFindings = compareWalk(wrong, wrongResult).map(entry => entry.id);
    assert.ok(wrongFindings.includes('walk:wrong-gate-extra-reviews:code:sweep-fixture'), wrongFindings.join(', '));
    assert.ok(!wrongFindings.some(id => id.startsWith('walk:economy:')), 'A single wrong gate is not reported twice');
});

test('the report groups excess by route and disturbance, with replays, and lists no open question', () => {
    const steps = restartSteps();
    const results: WalkResult[] = [
        { ...run(26, ['edit-production'], ['code:FULL', 'test:FULL']), steps, scenarioId: 'a' },
        { ...run(26, ['edit-production'], ['code:FULL', 'test:DELTA']), steps, scenarioId: 'b' },
        { ...run(26, ['delete-artifact:' + artifact('T-WALK-preflight.json')], ['code:FULL']), steps, scenarioId: 'c' },
        { ...run(26, ['stale-lock'], []), steps, scenarioId: 'd' },
        { ...run(26, ['edit-test'], ['test:DELTA'], CLEAN, 'blocked'), steps, scenarioId: 'e' },
        { ...run(26, ['wrong-gate:compile-gate'], ['code:FULL']), steps, scenarioId: 'f' }
    ];
    const summary = summarizeReviewEconomy(results);
    assert.deepEqual([summary.judged, summary.withinBound, summary.overBound, summary.unjudged, summary.wrongGate], [5, 2, 3, 0, 1],
        'A blocked variant is judged, a single wrong gate keeps its own checks');
    assert.equal(summary.groups.length, 2);
    assert.deepEqual([summary.groups[0].route, summary.groups[0].disturbance, summary.groups[0].kind, summary.groups[0].lanes, summary.groups[0].records, summary.groups[0].variants],
        ['BLOCKED/restart-coherent-cycle', 'edit-production', 'full-where-delta', ['code', 'test'], 3, 2]);
    assert.deepEqual(summary.groups[0].source, ['src/gates/next-step/next-step.ts:1:1']);
    assert.equal(summary.groups[0].replay, 'GARDA_SYNTHETIC_SEED=42 GARDA_SYNTHETIC_WALK_ONLY=a');
    assert.deepEqual(summary.groups[0].scenarios, ['a', 'b']);
    assert.deepEqual([summary.groups[1].disturbance, summary.groups[1].kind, summary.groups[1].rule, summary.groups[1].lanes],
        ['delete-artifact', 'extra-launch', 'task-evidence', ['code']], 'Lost task evidence repeats no review');
    assert.deepEqual(summary.questions, []);
    const text = renderReviewEconomy(summary).join('\n');
    assert.match(text, /5 terminal variants were judged: 2 within the bound, 3 with launch findings, 0 keeping a review the rules require to repeat, 0 with launches left unjudged/u);
    assert.match(text, /1 single wrong-gate variants keep their walk:wrong-gate-\* checks/u);
    assert.match(text, /GARDA_SYNTHETIC_WALK_ONLY=a/u);
    assert.match(text, /### Operator questions\n\nNone\./u);
});

test('a reviewer input lost after the handoff and before the launch is counted allows one repeat of that lane only', () => {
    const handedOff: EconomyFacts = { ...CLEAN, reviews: [{ ...CLEAN.reviews[0], prepared: 16 }, { ...CLEAN.reviews[1], prepared: 22 }] };
    const template = 'delete-artifact:' + artifact('T-WALK-code-prompt-template.md');
    for (const step of [17, 18]) {
        assert.equal(bound(step, [template], 'code', handedOff), '1 FULL lost-evidence', String(step));
        assert.equal(bound(step, [template], 'test', handedOff), '0  not-run', String(step));
    }
    // Before the handoff (or without the prepared step) the copy restores and the planned FULL is no repeat.
    assert.equal(bound(16, [template], 'code', handedOff), '0  not-run');
    assert.equal(bound(18, [template], 'code'), '0  not-run');
});

test('a lost prepared prompt cannot hide a required first FULL review', () => {
    const facts: EconomyFacts = { ...CLEAN, reviews: [{ ...CLEAN.reviews[0], prepared: 16 }, CLEAN.reviews[1]] };
    const prompt = artifact('T-WALK-code-prompt-template.md');
    const disturbance = 'delete-artifact:' + prompt;
    const scenario: WalkScenario = { id: 'sweep-fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'clean-pass', step: 17, gate: 'implementation',
            disturbances: [{ kind: 'delete-artifact', artifact: { path: prompt, kind: 'report' } }], economy: facts } };
    const incomplete = run(17, [disturbance], ['test:FULL'], facts);
    assert.deepEqual(judgeReviewEconomy(incomplete)!.missed.map(entry => [entry.lane, entry.requiredMode]), [['code', 'FULL']]);
    assert.deepEqual(compareWalk(scenario, incomplete).map(entry => entry.id), ['walk:economy:missed-review:code:sweep-fixture']);
    assert.deepEqual(verdict(17, [disturbance], ['code:FULL', 'test:FULL'], facts).missed, []);
    assert.deepEqual(verdict(17, [disturbance], ['code:FULL', 'code:FULL', 'test:FULL'], facts).excess, []);
    assert.deepEqual(verdict(17, [disturbance], ['code:DELTA', 'test:FULL'], facts).missed.map(entry => entry.lane), ['code']);
    assert.deepEqual(verdict(17, [disturbance], ['test:FULL'], facts, 'blocked').missed, []);
    const earlierPassed: EconomyFacts = { ...facts, reviews: [{ lane: 'code', mode: 'FULL', launched: 1, recorded: 2 }, ...facts.reviews] };
    assert.deepEqual(verdict(17, [disturbance], ['test:FULL'], earlierPassed).missed, [], 'An earlier passed review may be kept');
});
