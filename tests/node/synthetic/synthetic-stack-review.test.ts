import './engine/walk-route-observer';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { STACK_MANIFESTS } from './engine/walk-stack-fixtures';
import { stackScenario } from './engine/walk-stack-scenarios';
import { STACK_COMPACT_REVIEW_SCENARIOS, STACK_DEEP_REVIEW_SCENARIOS, STACK_REVIEW_FAMILIES,
    stackReviewDifferences, stackReviewExpectation, stackReviewResults, stackReviewRotation } from './engine/walk-stack-review-scenarios';
import { walkRunPlan } from './engine/walk-plan';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { compareWalk, type WalkResult } from './engine/navigator-walk';
import { acceptStandBaseline, fileDigest } from './engine/stand-baselines';
import { buildStandSummary, renderStandSummary } from './engine/stand-summary';
import type { WalkReport } from './engine/walk-report';
import { WalkProgressGuard } from './engine/walk-progress';

const ids = WALK_SCENARIOS.map(scenario => scenario.id);
const seed = '1785881697';

test('role classification refinement is progress; repeated or oscillating semantic states still loop', () => {
    const guard = new WalkProgressGuard(2);
    assert.equal(guard.observe('tree', 'quality-checklist', '', 'quality', 'T', 'code'), false);
    assert.equal(guard.observe('tree', 'quality-checklist', '', 'quality', 'T', 'code'), false);
    assert.equal(guard.observe('tree', 'quality-checklist', '', 'quality', 'T', 'mixed'), false);
    assert.equal(guard.observe('tree', 'quality-checklist', '', 'quality', 'T', 'code'), true);
    assert.equal(guard.observe('tree', 'quality-checklist', '', 'quality', 'T', 'mixed'), false);
    assert.equal(guard.observe('tree', 'quality-checklist', '', 'quality', 'T', 'mixed'), true);
});

test('full has exactly three compact review/error scenarios on every stack; deep families belong to sweep', () => {
    assert.equal(STACK_COMPACT_REVIEW_SCENARIOS.length, 57);
    assert.equal(new Set(ids).size, ids.length);
    const full = walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'full' }, ids);
    for (const manifest of STACK_MANIFESTS) for (const family of ['review-edit', 'lost-evidence', 'reset-and-wrong-gate'])
        assert.ok(full.scenarioIds.includes(`stack-${manifest.id}-${family}`));
    assert.ok(!full.scenarioIds.some(id => id.startsWith('deep-stack-')));
    for (const manifest of STACK_MANIFESTS) for (const family of STACK_REVIEW_FAMILIES)
        assert.ok(STACK_DEEP_REVIEW_SCENARIOS.some(scenario => scenario.id === `deep-stack-${manifest.id}-${family}`
            || scenario.id.startsWith(`deep-stack-${manifest.id}-${family}-`)));
});

test('every seeded family contains unknown plus N rotated stacks and all required shapes; replay is exact', () => {
    for (const value of [0, 1, 1785881697, 0xffffffff]) {
        const rotation = stackReviewRotation(value, 3, []);
        assert.deepEqual(rotation, stackReviewRotation(value, 3, []));
        for (const family of rotation.families) {
            assert.equal(family.stacks.length, 4);
            assert.ok(family.stacks.includes('unknown-quartz'));
            const selected = STACK_MANIFESTS.filter(manifest => family.stacks.includes(manifest.id));
            assert.ok(selected.some(manifest => manifest.id.startsWith('polyglot-')));
            assert.ok(selected.some(manifest => manifest.adapter));
            assert.ok(family.stacks.some(id => ['spring-maven', 'java-gradle', 'kotlin-gradle', 'dotnet', 'go', 'rust', 'node', 'pnpm-nx', 'elixir', 'swift'].includes(id)));
            assert.ok(family.scenarios.every(id => ids.includes(id)));
        }
    }
    assert.notDeepEqual(stackReviewRotation(1), stackReviewRotation(2));
    assert.throws(() => stackReviewRotation(1, 2), /3\.\.18/u);
    assert.throws(() => stackReviewRotation(-1), /uint32/u);
    const sweep = walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'sweep', GARDA_SYNTHETIC_SEED: seed }, ids);
    assert.deepEqual(sweep.scenarioIds.filter(id => id.startsWith('deep-stack-')), ids.filter(id =>
        sweep.reviewRotation.families.some(family => family.scenarios.includes(id))));
    const only = 'deep-stack-unknown-quartz-report-correction';
    assert.deepEqual(walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'full', GARDA_SYNTHETIC_WALK_ONLY: only }, ids).scenarioIds, [only]);
    assert.equal(walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'sweep', GARDA_SYNTHETIC_WALK_ONLY: only }, ids).runSweep, false,
        'A selected deep case must not launch unrelated checkpoint baselines');
});

test('review expectations use shared rule bounds: small DELTA, large FULL, unaffected lanes and declared dependents', () => {
    assert.deepEqual(stackReviewExpectation(['edit-production']).modes.slice(4), ['code:DELTA', 'test:DELTA']);
    assert.deepEqual(stackReviewExpectation(['edit-production-large']).modes.slice(4), ['code:FULL', 'test:FULL']);
    const lost = stackReviewExpectation(['delete-artifact:garda-agent-orchestrator/runtime/reviews/T-WALK-security-receipt.json'], { test: ['security'] });
    assert.deepEqual(lost.bounds.filter(bound => bound.repeats).map(bound => bound.lane), ['security', 'test']);
    assert.deepEqual(stackReviewExpectation(['reset-task']).modes.slice(4), ['code:FULL', 'security:FULL', 'refactor:FULL', 'test:FULL']);
    // A recorded review's lost context is a derived lane file: a repeat is permitted (FULL only) but never required.
    const context = stackReviewExpectation(['delete-artifact:garda-agent-orchestrator/runtime/reviews/T-WALK-test-review-context.json'], {}, undefined, 'required');
    assert.deepEqual(context.modes, ['code:FULL', 'security:FULL', 'refactor:FULL', 'test:FULL']);
    assert.deepEqual(context.bounds.filter(bound => bound.repeats).map(bound => [bound.lane, bound.required, bound.modes.join('|')]), [['test', 0, 'FULL|DELTA']]);
    const deep = (id: string) => STACK_DEEP_REVIEW_SCENARIOS.find(scenario => scenario.id === 'deep-stack-unknown-quartz-' + id)!;
    const quartz = stackScenario(STACK_MANIFESTS.find(manifest => manifest.id === 'unknown-quartz')!, 8, 'generic');
    for (const family of ['lost-context', 'corrupt-context']) {
        assert.deepEqual(deep(family).expectedModes, quartz.expectedModes, family);
        assert.equal(deep(family).expectedReviews.test, 1, family);
    }
    // Lost or corrupt recorded evidence (receipt, report) still requires exactly one test repeat, in either mode.
    for (const family of ['lost-receipt', 'corrupt-receipt', 'lost-report', 'corrupt-report']) {
        assert.equal(deep(family).expectedReviews.test, 2, family);
        assert.match(deep(family).expectedModes.at(-1)!, /^test:FULL\|test:DELTA$/u, family);
    }
});

test('Rust compact reviews retain API and add performance only for the large edit', () => {
    const edit = STACK_COMPACT_REVIEW_SCENARIOS.find(scenario => scenario.id === 'stack-rust-review-edit')!;
    assert.deepEqual(edit.expectedReviews, { code: 3, security: 1, refactor: 1, api: 1, test: 3, performance: 1 });
    assert.deepEqual(edit.expectedModes, ['code:FULL', 'security:FULL', 'refactor:FULL', 'api:FULL', 'test:FULL',
        'code:DELTA', 'test:DELTA', 'code:FULL', 'performance:FULL', 'test:FULL']);
    const reviews = edit.expectedModes.map(mode => { const [lane, value] = mode.split(':'); return { lane, mode: value }; });
    const result: WalkResult = { scenarioId: edit.id, outcome: 'done', detail: '', steps: [], events: [],
        reviewsByLane: edit.expectedReviews, reviews };
    for (const lane of ['api', 'performance']) {
        const missing = { ...result, reviews: reviews.filter(review => review.lane !== lane) };
        assert.ok(compareWalk(edit, missing).some(finding => finding.id.startsWith('walk:modes:')), `Missing ${lane} must fail`);
    }
    const lost = STACK_COMPACT_REVIEW_SCENARIOS.find(scenario => scenario.id === 'stack-rust-lost-evidence')!;
    assert.equal(lost.expectedReviews.api, 1);
    assert.equal(lost.expectedReviews.performance, undefined);
    const reset = STACK_COMPACT_REVIEW_SCENARIOS.find(scenario => scenario.id === 'stack-rust-reset-and-wrong-gate')!;
    assert.equal(reset.expectedReviews.api, 2);
    assert.equal(reset.expectedReviews.performance, undefined);
});

test('injected compact cases still reject extra reviews, wrong modes, missed reviews and missing DONE', () => {
    const scenario = STACK_COMPACT_REVIEW_SCENARIOS.find(scenario => scenario.id === 'stack-unknown-quartz-reset-and-wrong-gate')!;
    const reviews = scenario.expectedModes.map(mode => { const [lane, value] = mode.split(':'); return { lane, mode: value }; });
    const result: WalkResult = { scenarioId: scenario.id, outcome: 'done', detail: '', steps: [], events: [],
        reviewsByLane: scenario.expectedReviews, reviews,
        sweep: { seed: 0, baseline: 'oracle', step: 0, disturbances: ['reset-task', 'wrong-gate:completion-gate'], applied: ['reset-task', 'wrong-gate:completion-gate'] } };
    assert.ok(!compareWalk(scenario, result).some(finding => /walk:(?:reviews|modes):/u.test(finding.id)));
    for (const changed of [reviews.slice(1), [...reviews, { lane: 'code', mode: 'FULL' }],
        reviews.map((review, index) => index === 4 ? { ...review, mode: 'DELTA' } : review)]) {
        assert.ok(compareWalk(scenario, { ...result, reviews: changed }).some(finding => finding.id.startsWith('walk:modes:')));
    }
    assert.ok(compareWalk(scenario, { ...result, outcome: 'blocked' }).length);
});

test('deep wrong gates cover every legacy gate/checkpoint; policy changes cover an open reviewer', () => {
    const unknown = STACK_DEEP_REVIEW_SCENARIOS.filter(scenario => scenario.id.startsWith('deep-stack-unknown-quartz-'));
    assert.equal(unknown.filter(scenario => scenario.id.startsWith('deep-stack-unknown-quartz-wrong-gate-')).length, 35);
    const policy = unknown.filter(scenario => scenario.id.startsWith('deep-stack-unknown-quartz-policy-change-'));
    assert.equal(policy.length, 4);
    assert.ok(policy.some(scenario => scenario.injection?.gate === 'record-review-result' && scenario.injection.checkpoint?.lane === 'code'));
    for (const scenario of STACK_COMPACT_REVIEW_SCENARIOS.filter(scenario => scenario.id.endsWith('-lost-evidence'))) {
        assert.ok(scenario.dependencyGraph!.preparation_order.includes('db'));
        assert.deepEqual(scenario.dependencyGraph!.dependencies.test, ['security']);
    }
});

test('deep policy changes accept only the frozen-policy refusal answered by the approved adoption, and keep review counts', () => {
    const policy = STACK_DEEP_REVIEW_SCENARIOS.filter(scenario => /^deep-stack-[a-z0-9-]+-policy-change-/u.test(scenario.id));
    assert.equal(policy.length, STACK_MANIFESTS.length * 4);
    assert.ok(policy.every(scenario => scenario.enforceReviewExpectations && scenario.expectedRoutes?.length === 1));
    const scenario = policy.find(item => item.id === 'deep-stack-unknown-quartz-policy-change-record-code')!;
    const reviews = scenario.expectedModes.map(mode => { const [lane, value] = mode.split(':'); return { lane, mode: value.split('|')[0] }; });
    const step = (index: number, gate: string, exitCode: number, command: string, output = '') => ({ index, gate, status: 'BLOCKED', command,
        exitCode, output, navigatorMs: 1, commandMs: 0, reason: '', taskEvents: index, workspaceSha256: '', measurement: null,
        routes: index === 1 ? [scenario.expectedRoutes![0]] : [] }) as WalkResult['steps'][number];
    const refusal = step(0, 'load-rule-pack', 3, 'node garda gate load-rule-pack --stage "POST_PREFLIGHT"',
        'RULE_PACK_LOAD_FAILED\nStage: POST_PREFLIGHT\nViolations:\n- Task profile policy inputs changed after preflight (review lane policy).');
    const adoption = step(1, 'enter-task-mode', 0, 'node garda gate enter-task-mode --task-id "T-WALK" --adopt-changed-review-policy "' + 'a'.repeat(64) + '" --x');
    const result = (steps: WalkResult['steps']): WalkResult => ({ scenarioId: scenario.id, outcome: 'done', detail: '', steps, events: [],
        reviewsByLane: scenario.expectedReviews, reviews,
        sweep: { seed: 0, baseline: 'oracle', step: 0, disturbances: ['change-policy'], applied: ['change-policy'] } });
    const failed = (steps: WalkResult['steps']) => compareWalk(scenario, result(steps)).filter(finding => /^walk:(?:gate-failed|missing-source-route|reviews|modes):/u.test(finding.id)).map(finding => finding.id);
    assert.deepEqual(failed([refusal, adoption]), []);
    // Unanswered, answered by a failed adoption, or a different load-rule-pack failure: still a safety finding.
    assert.ok(failed([refusal, { ...adoption, command: 'node garda gate enter-task-mode --task-id "T-WALK" --x' }]).includes('walk:gate-failed:load-rule-pack:' + scenario.id));
    assert.ok(failed([refusal, { ...adoption, exitCode: 1 }]).includes('walk:gate-failed:load-rule-pack:' + scenario.id));
    assert.ok(failed([{ ...refusal, output: 'RULE_PACK_LOAD_FAILED\n- Loaded rule file is missing.' }, adoption]).includes('walk:gate-failed:load-rule-pack:' + scenario.id));
    // Passed reviews are kept: a repeated code review is still an economy finding, and the adoption route is required.
    assert.ok(failed([refusal, adoption]).length === 0 && compareWalk(scenario, { ...result([refusal, adoption]),
        reviewsByLane: { ...scenario.expectedReviews, code: 2 } }).some(finding => finding.id.startsWith('walk:reviews:1->2:code:')));
    assert.ok(failed([refusal, { ...adoption, routes: [] }]).some(id => id.startsWith('walk:missing-source-route:')));
});

test('stack pillar exposes per-stack counts and modes and cannot hide a product failure', () => {
    const result: WalkResult = { scenarioId: 'stack-unknown-quartz-review-edit', outcome: 'done', detail: '', steps: [], events: [],
        reviewsByLane: { code: 3, test: 3 }, reviews: [{ lane: 'code', mode: 'DELTA' }] };
    const stacks = stackReviewResults([result], [{ id: 'walk:modes:' + result.scenarioId }]);
    assert.equal(stacks.find(stack => stack.stack === 'unknown-quartz')?.verdict, 'FAIL');
    assert.equal(stacks.find(stack => stack.stack === 'rust')?.verdict, 'INCOMPLETE');
    assert.equal(stackReviewResults([result], [{ id: 'walk:counter:budget:' + result.scenarioId }])
        .find(stack => stack.stack === 'unknown-quartz')?.verdict, 'PASS', 'Speed findings stay in the speed pillar');
    const summary = buildStandSummary({ level: 'short', final: true, partial: true, timingRequested: false, baselineProblems: [],
        checks: ['walk', 'economy', 'policy-reuse', 'contract', 'fixture-contract'].map(id => ({ id, status: 'PASS', log: '' })),
        walk: { findings: [], anomalies: [], stackReviewLogic: stacks, scenarios: [] } as unknown as WalkReport });
    assert.equal(summary.pillars.review_logic.verdict, 'FAIL');
    assert.match(renderStandSummary(summary), /unknown-quartz \| FAIL/u);
});

test('cross-stack comparison matches the same subcase and distinguishes an actual review difference', () => {
    const ordinary = { outcome: 'done', reviews: [{ lane: 'test', mode: 'FULL' }] } as WalkResult;
    const unreachable = { ...ordinary, reviews: [...ordinary.reviews, ...ordinary.reviews] };
    const results = ['unknown-quartz', 'python'].flatMap(stack => [
        { ...ordinary, scenarioId: `deep-stack-${stack}-report-correction` },
        { ...unreachable, scenarioId: `deep-stack-${stack}-report-correction-unreachable` }]);
    assert.deepEqual(stackReviewDifferences(results), []);
    results[0] = { ...results[0], outcome: 'loop' };
    const differences = stackReviewDifferences(results);
    assert.equal(differences.length, 1);
    assert.equal(differences[0].caseId, 'report-correction');
    assert.equal(differences[0].family, 'report-correction');
});

test('a cross-stack difference becomes permanent only through a reasoned baseline decision', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stack-review-baseline-'));
    try {
        const target = path.join(root, 'stack-review-cases.json'), candidate = path.join(root, 'candidate.json');
        fs.writeFileSync(target, '{"schema_version":1,"cases":[]}');
        fs.writeFileSync(path.join(root, 'baseline-policy.json'), '{"schema_version":1,"files":{}}');
        const forced = { stack: 'ruby', family: 'policy-change' as const };
        fs.writeFileSync(candidate, JSON.stringify({ schema_version: 1, cases: [forced] }));
        const decision = { kind: 'review-cases' as const, candidate, reason: '', release: '1.4.4', sourceCommit: 'a'.repeat(40), expectedSha256: fileDigest(target) };
        assert.throws(() => acceptStandBaseline(root, decision), /written reason/u);
        const receipt = acceptStandBaseline(root, { ...decision, reason: 'Retain the observed stack/family difference for every future sweep; review rules unchanged.' });
        assert.ok(fs.existsSync(receipt));
        const rotation = stackReviewRotation(1785881697, 3, [forced]);
        assert.ok(rotation.families.find(family => family.family === forced.family)!.stacks.includes(forced.stack));
        fs.writeFileSync(candidate, '{"cases":[{"stack":"invented","family":"policy-change"}]}');
        assert.throws(() => acceptStandBaseline(root, { ...decision, reason: 'Invalid pair', expectedSha256: fileDigest(target) }), /known stack/u);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
