import NATIVE_COUNTER_SHAPES from './native-counter-input-shapes.json';
import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredNativeCounterState, type WalkResult } from './engine/navigator-walk';
import { platformCounterBaseline } from './engine/walk-platform-baselines';
import { counterBudgets, analyzeWalkMetrics, counterIdentities, verdictResult, type CounterBaseline } from './engine/walk-metrics';

function fixture(growing: boolean): WalkResult {
    return { scenarioId: 'native-acl-subjects', outcome: 'done', detail: '', reviewsByLane: {}, reviews: [], events: [], steps: [0, 1, 2].map(i => ({
        index: i, route: 'BLOCKED/unit', status: 'BLOCKED', gate: 'unit', command: null, taskEvents: i * 10,
        navigatorMs: 1, commandMs: 0, exitCode: null, reason: '', output: '', workspaceSha256: '',
        measurement: { phases_ms: {}, work: {
            'process:spawnSync:powershell.exe:principal-query': growing ? 4 + i : 2 * (2 + i),
            ...Object.fromEntries(Array.from({ length: growing ? 2 : 2 + i }, (_, j) =>
                ['acl_probe:initial:/tmp/garda-walk-subjects/protected-' + j, 1]))
        } }
    })) } as WalkResult;
}
const budgets: CounterBaseline = { schema: 1, provenance: 'ACL subject-set and excess-work negative controls', routes: {
    'BLOCKED/unit': { 'subprocess:powershell.exe': { expected: 8, tolerance: 0, constantWithEvents: true, growthTolerance: 0 } }
} };

test('native input profiles require authenticated entry facts or already admitted parent/recipe facts', () => {
    assert.equal(measuredNativeCounterState(undefined, []), undefined);
    assert.equal(measuredNativeCounterState(undefined, [{ type: 'TASK_MODE_ENTERED', details: { profile_policy_snapshot_required: true } }]), undefined);
    const events = [{ type: 'TASK_MODE_ENTERED', details: { profile_policy_snapshot_required: true, profile_policy_snapshot_hash: 'a'.repeat(64) } }];
    const shape = NATIVE_COUNTER_SHAPES.shapes.find(row => row.base_state === null && row.review_types?.length);
    assert.ok(shape);
    const preflight = { type: 'PREFLIGHT_CLASSIFIED', details: { required_reviews: Object.fromEntries(shape.review_types!.map(lane => [lane, true])) } };
    assert.equal(measuredNativeCounterState(undefined, [...events, preflight]), shape.id);
    assert.equal(measuredNativeCounterState(undefined, [], true), 'native-v4-pre-entry');
    assert.equal(measuredNativeCounterState(undefined, [{ type: 'TASK_MODE_ENTERED', details: {} }], true), undefined);
    assert.equal(measuredNativeCounterState('unmeasured-family', []), 'unmeasured-family');
    assert.equal(measuredNativeCounterState('native-child-tree', []), 'native-v4-native-child-tree');
    assert.equal(measuredNativeCounterState('native-api-selected-initial', events), 'native-api-selected-initial');
});

test('PowerShell identities include actual ACL subjects, while same-subject extra queries still fail', () => {
    const changed = fixture(false), extra = fixture(true);
    assert.notDeepEqual(counterIdentities(changed.steps[0])['subprocess:powershell.exe'],
        counterIdentities(changed.steps[1])['subprocess:powershell.exe']);
    assert.equal(analyzeWalkMetrics([changed], budgets, false).anomalies.length, 0);
    assert.ok(analyzeWalkMetrics([extra], budgets, false).anomalies.some(item => item.kind === 'counter-growth'));
    const reduced = verdictResult(changed);
    assert.deepEqual(counterIdentities(reduced.steps[1]), counterIdentities(changed.steps[1]),
        'Shard reduction retains every authority input used by growth attribution.');
    assert.equal(analyzeWalkMetrics([reduced], budgets, false).anomalies.length, 0);
    const over = fixture(false);
    over.steps[2].measurement!.work['process:spawnSync:powershell.exe:principal-query'] = 9;
    assert.ok(analyzeWalkMetrics([over], budgets, false).anomalies.some(item => item.kind === 'counter-budget'));
});


test('Linux measured budgets keep ordinary and same-state Git ceilings and prohibit Windows ACL tools', () => {
    const root = process.cwd(), windows = platformCounterBaseline(root, 'win32'), linux = platformCounterBaseline(root, 'linux');
    assert.ok(Object.keys(linux.routes).length > 100);
    assert.match(linux.provenance, /native Linux/u);
    for (const state of [undefined, ...Object.keys(windows.states ?? {})]) for (const route of Object.keys(linux.routes)) {
        const measured = counterBudgets(linux, route, state)!, reference = counterBudgets(windows, route, state);
        assert.equal(measured['subprocess:icacls.exe'].expected + measured['subprocess:icacls.exe'].tolerance, 0);
        assert.equal(measured['subprocess:powershell.exe'].expected + measured['subprocess:powershell.exe'].tolerance, 0);
        const git = measured['subprocess:git'], cap = reference?.['subprocess:git'];
        if (git) assert.ok(git.expected + git.tolerance <= (cap ? cap.expected + cap.tolerance : 0), route + '/' + state);
        for (const budget of Object.values(measured)) assert.equal(budget.growthTolerance ?? 0, 0);
    }
});
