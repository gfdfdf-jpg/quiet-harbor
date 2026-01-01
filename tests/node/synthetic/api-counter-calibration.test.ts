import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { admittedCounterState, type WalkResult } from './engine/navigator-walk';
import { analyzeWalkMetrics, counterBudgets, type CounterBaseline } from './engine/walk-metrics';

const root = path.resolve('tests/node/synthetic');
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'api-counter-calibration-evidence.json'), 'utf8')) as {
    previousRouteNames: string[]; previousRoutesSha256: string; previousStatesSha256: string;
    measurements: Array<{ state: string; route: string; counters: Record<string, number>; hashInputs: string[] }>;
    probes: Array<{ route: string; appendedEvents: number; commandsEqual: boolean;
        before: Record<string, number>; after: Record<string, number>; beforeInputs: string[]; afterInputs: string[] }>;
};
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'walk-counter-baseline.json'), 'utf8')) as CounterBaseline;
const states = ['native-api-selected-initial', 'native-api-selected-remediation'];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('API calibration preserves all prior budgets and subprocess ceilings', () => {
    assert.equal(digest(Object.fromEntries(Object.entries(baseline.routes).filter(([route]) => evidence.previousRouteNames.includes(route)).map(([route, metrics]) =>
        [route, Object.fromEntries(Object.entries(metrics).filter(([name]) => name !== 'subprocess:powershell.exe'))]))), evidence.previousRoutesSha256);
    assert.equal(digest(Object.fromEntries(Object.entries(baseline.states!).filter(([id]) => !states.includes(id) && !id.startsWith('native-v4-')))),
        evidence.previousStatesSha256);
    for (const id of states) for (const [route, metrics] of Object.entries(baseline.states![id].routes)) {
        assert.ok(route.endsWith('/api'));
        for (const [metric, budget] of Object.entries(metrics)) {
            assert.ok(!metric.startsWith('subprocess:'));
            assert.equal(budget.growthTolerance, 0);
        }
    }
});

test('API calibrated file hashes are distinct authenticated inputs, constant after five extra events', () => {
    assert.equal(evidence.probes.length, 6);
    for (const probe of evidence.probes) {
        assert.equal(probe.appendedEvents, 5);
        assert.equal(probe.commandsEqual, true);
        assert.deepEqual(probe.afterInputs, probe.beforeInputs);
        assert.equal(new Set(probe.beforeInputs).size, probe.before['file_hash:file']);
        for (const counter of ['file_hash:file', 'subprocess:git', 'subprocess:icacls.exe', 'timeline_parse', 'timeline_verify'])
            assert.equal(probe.after[counter], probe.before[counter], probe.route + '/' + counter);
    }
    for (const row of evidence.measurements.filter(row => row.route.endsWith('/api'))) {
        const budgets = counterBudgets(baseline, row.route, row.state)!;
        assert.equal(new Set(row.hashInputs).size, row.counters['file_hash:file']);
        for (const [metric, value] of Object.entries(row.counters))
            assert.ok(budgets[metric] && value <= budgets[metric].expected + budgets[metric].tolerance, row.route + '/' + metric);
    }
});

test('an API state needs native preflight admission and a native restart changes its phase', () => {
    assert.equal(admittedCounterState(states[0], []), undefined);
    const admitted = [{ type: 'PREFLIGHT_CLASSIFIED', details: { changed_files_count: 2,
        required_reviews: { code: true, api: true, test: true } } }];
    assert.equal(admittedCounterState(states[0], admitted), states[0]);
    assert.equal(admittedCounterState(states[1], admitted), states[0]);
    assert.equal(admittedCounterState(states[0], [...admitted, { type: 'REVIEW_CYCLE_RESTARTED', details: {} }]), states[1]);
    admitted[0].details.required_reviews.api = false;
    assert.equal(admittedCounterState(states[0], admitted), undefined);
});

test('one additional API hash still fails the deterministic work limit', () => {
    const route = 'BLOCKED/build-review-context/api';
    const budget = counterBudgets(baseline, route, states[0])!['file_hash:file'];
    const limit = budget.expected + budget.tolerance;
    const fixture = (extra: boolean): WalkResult => ({ scenarioId: 'api-calibration-negative-control', steps: [{
        index: 0, route, counterState: states[0], status: 'BLOCKED', gate: 'build-review-context', taskEvents: 30,
        navigatorMs: 1, commandMs: 0, reason: '', output: '', command: null, workspaceSha256: '', exitCode: null,
        measurement: { work: Object.fromEntries(Array.from({ length: limit + Number(extra) }, (_, i) => ['file_hash:input-' + i, 1])), phases_ms: {} }
    }] } as WalkResult);
    const scoped: CounterBaseline = { schema: 1, provenance: 'API one-extra-operation negative control',
        routes: { [route]: { 'file_hash:file': budget } } };
    assert.equal(analyzeWalkMetrics([fixture(false)], scoped, false).anomalies.length, 0);
    assert.ok(analyzeWalkMetrics([fixture(true)], scoped, false).anomalies.some(item => item.kind === 'counter-budget'));
});
