import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { hasPreservedDeltaCounterInputs, hasTwoSourceApiCounterInputs, PRESERVED_DELTA_COUNTER_STATE,
    TWO_SOURCE_API_INITIAL_STATE, TWO_SOURCE_API_REMEDIATION_STATE } from './engine/walk-preserved-delta-counter-state';
import { measuredNativeCounterState, type WalkResult } from './engine/navigator-walk';
import { platformCounterBaseline } from './engine/walk-platform-baselines';
import { analyzeWalkMetrics, counterBudgets } from './engine/walk-metrics';

interface CalibrationRow {
    index: number; route: string; state: string; counters: Record<string, number>; hashInputs: string[]; hashCounts: number[];
}
interface CalibrationControl {
    eventsAdded: number; cohort: string; sameDecision: boolean; sameHashInputs: boolean;
    before: Record<string, number>; after: Record<string, number>; beforeInputs: string[]; afterInputs: string[]; increases: unknown[];
}
const evidence = JSON.parse(fs.readFileSync('tests/node/synthetic/preserved-delta-counter-calibration-evidence.json', 'utf8')) as {
    admissionEvents: WalkResult['events']; phaseAdmissionEvents: Record<string, WalkResult['events']>; platforms: Record<string, {
        previousRoutesSha256: string; previousStatesSha256: string; measurements: CalibrationRow[]; controls: CalibrationControl[];
    }>;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const states = [TWO_SOURCE_API_INITIAL_STATE, TWO_SOURCE_API_REMEDIATION_STATE, PRESERVED_DELTA_COUNTER_STATE];

test('preserved DELTA input admission requires both accepted origins and the current test-only preserving decision', () => {
    assert.equal(hasPreservedDeltaCounterInputs(evidence.admissionEvents), true);
    assert.equal(measuredNativeCounterState('native-api-selected-remediation', evidence.admissionEvents), PRESERVED_DELTA_COUNTER_STATE);
    assert.equal(hasPreservedDeltaCounterInputs([]), false);
    assert.equal(hasPreservedDeltaCounterInputs(evidence.admissionEvents, 'T-FOREIGN'), false);
    for (const remove of ['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'REVIEW_RECORDED'])
        assert.equal(hasPreservedDeltaCounterInputs(evidence.admissionEvents.filter(event => event.type !== remove)), false, remove);
    for (const lane of ['code', 'api']) {
        const changed = structuredClone(evidence.admissionEvents);
        const origin = [...changed].reverse().find(value => value.type === 'REVIEW_CYCLE_RESTARTED'
            && (value.details.authoritative_review_decision as { category?: string } | undefined)?.category === 'production')!;
        const event = changed.find(value => value.type === 'REVIEW_RECORDED' && value.details.review_type === lane
            && value.details.review_execution_mode === 'DELTA' && value.details.preflight_sha256 === origin.details.preflight_sha256)!;
        event.details.review_execution_mode = 'FULL';
        assert.equal(hasPreservedDeltaCounterInputs(changed), false, lane + ': FULL is not this DELTA input set');
        event.details.review_execution_mode = 'DELTA'; event.details.receipt_sha256 = 'invalid';
        assert.equal(hasPreservedDeltaCounterInputs(changed), false, lane + ': an origin without a bound receipt is not admitted');
    }
    const foreign = structuredClone(evidence.admissionEvents);
    foreign.filter(event => event.type === 'REVIEW_CYCLE_RESTARTED').at(-1)!.details.preflight_sha256 = '9'.repeat(64);
    assert.equal(hasPreservedDeltaCounterInputs(foreign), false);
    const reentered = structuredClone(evidence.admissionEvents);
    const preserving = structuredClone([...reentered].reverse().find(event => event.type === 'REVIEW_CYCLE_RESTARTED')!);
    reentered.push({ type: 'TASK_RESET', details: {} }, structuredClone(reentered.find(event => event.type === 'TASK_MODE_ENTERED')!),
        structuredClone([...reentered].reverse().find(event => event.type === 'PREFLIGHT_CLASSIFIED')!), preserving);
    assert.equal(hasPreservedDeltaCounterInputs(reentered), false, 'A previous entry cannot supply DELTA origins after reset');
    assert.equal(hasPreservedDeltaCounterInputs(reentered.filter(event => event.type !== 'TASK_RESET')), false,
        'A repeated entry with the same frozen profile cannot borrow a previous entry\'s DELTA origins');
});

test('initial and remediated two-source profiles require current native CODE proof, not just three changed files', () => {
    for (const [phase, expected] of [['initial', TWO_SOURCE_API_INITIAL_STATE], ['remediation', TWO_SOURCE_API_REMEDIATION_STATE]] as const) {
        const events = evidence.phaseAdmissionEvents[phase];
        assert.equal(hasTwoSourceApiCounterInputs(events), true);
        assert.equal(hasTwoSourceApiCounterInputs(events, 'T-FOREIGN'), false);
        assert.equal(measuredNativeCounterState('native-api-selected-' + phase, events), expected);
        assert.equal(hasTwoSourceApiCounterInputs(events.filter(event => event.type !== 'REVIEW_RECORDED')), false);
        const foreign = structuredClone(events);
        foreign.filter(event => event.type === 'REVIEW_RECORDED').forEach(event => { event.details.preflight_sha256 = '9'.repeat(64); });
        assert.equal(hasTwoSourceApiCounterInputs(foreign), false);
        const reentered = [...events, structuredClone(events.find(event => event.type === 'TASK_MODE_ENTERED')!),
            structuredClone([...events].reverse().find(event => event.type === 'PREFLIGHT_CLASSIFIED')!)];
        assert.equal(hasTwoSourceApiCounterInputs(reentered), false);
    }
});

test('new native Windows and Linux input profiles preserve every previous limit and every subprocess ceiling', () => {
    assert.deepEqual(Object.keys(evidence.platforms).sort(), ['linux', 'win32']);
    for (const [platform, record] of Object.entries(evidence.platforms)) {
        const baseline = platformCounterBaseline(process.cwd(), platform);
        assert.equal(digest(baseline.routes), record.previousRoutesSha256, platform + ': old ordinary limits');
        assert.equal(digest(Object.fromEntries(Object.entries(baseline.states!).filter(([id]) => !states.includes(id)))),
            record.previousStatesSha256, platform + ': old admitted states');
        for (const state of states) {
            const shape = baseline.states![state];
            assert.equal(shape.inherits, state === TWO_SOURCE_API_INITIAL_STATE ? 'native-api-selected-initial' : 'native-api-selected-remediation');
            for (const metrics of Object.values(shape.routes)) for (const [name, budget] of Object.entries(metrics)) {
                assert.ok(!name.startsWith('subprocess:'), 'Existing process ceilings must be inherited unchanged');
                assert.equal(budget.growthTolerance, 0);
                if (name === 'file_hash:file') assert.equal(budget.tolerance, 0);
            }
        }
        for (const row of record.measurements) {
            assert.ok(states.includes(row.state));
            const budget = counterBudgets(baseline, row.route, row.state)!;
            for (const [name, count] of Object.entries(row.counters))
                assert.ok(budget[name] && count <= budget[name].expected + budget[name].tolerance, platform + '/' + row.route + '/' + name);
        }
    }
});

test('extra work follows distinct authenticated inputs; additional history adds no hashes, probes or processes', () => {
    for (const [platform, record] of Object.entries(evidence.platforms)) {
        assert.ok(record.measurements.length >= 25, platform);
        for (const row of record.measurements) {
            assert.equal(new Set(row.hashInputs).size, row.counters['file_hash:file'], platform + '/' + row.route);
            assert.ok(row.hashCounts.every(count => count === 1), 'The same file must not be hashed twice');
        }
        assert.ok(record.controls.length >= 8, platform);
        assert.deepEqual([...new Set(record.controls.map(control => control.cohort))].sort(), ['initial', 'preserved', 'remediation']);
        for (const control of record.controls) {
            assert.equal(control.eventsAdded, 5);
            assert.equal(control.sameDecision, true);
            assert.equal(control.sameHashInputs, true);
            assert.deepEqual(control.beforeInputs, control.afterInputs);
            assert.deepEqual(control.increases, []);
        }
    }
});

test('one hash above the new deterministic ceiling still refuses acceptance on either platform', () => {
    for (const platform of Object.keys(evidence.platforms)) for (const state of states) {
        const baseline = platformCounterBaseline(process.cwd(), platform);
        const route = evidence.platforms[platform].measurements.find(row => row.state === state)!.route;
        const ceiling = counterBudgets(baseline, route, state)!['file_hash:file'];
        const count = ceiling.expected + ceiling.tolerance;
        const result = (extra: number): WalkResult => ({ scenarioId: 'preserved-origin-extra-work-negative', steps: [{
            index: 0, route, counterState: state, status: 'BLOCKED', gate: 'build-review-context',
            taskEvents: 100, navigatorMs: 1, commandMs: 0, reason: '', output: '', command: null, workspaceSha256: '', exitCode: null,
            measurement: { work: Object.fromEntries(Array.from({ length: count + extra }, (_, index) => ['file_hash:input-' + index, 1])), phases_ms: {} }
        }] } as WalkResult);
        const scoped = { schema: 1 as const, provenance: 'Independent one-extra-hash refusal control', routes: {
            [route]: { 'file_hash:file': ceiling }
        } };
        assert.equal(analyzeWalkMetrics([result(0)], scoped, false).anomalies.length, 0);
        assert.ok(analyzeWalkMetrics([result(1)], scoped, false).anomalies.some(row => row.kind === 'counter-budget'));
    }
});
