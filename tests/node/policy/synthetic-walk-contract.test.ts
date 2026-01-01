// The route observer must instrument next-step before any scenario module imports it.
import '../synthetic/engine/walk-route-observer';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { beginRouteObservation, extractRoutes, observeRouteConstruction, reachedRoutePoints, readRouteInventory, routeCoverage } from '../synthetic/engine/walk-routes';
import { analyzeWalkMetrics, anomalyFindings, fittedGrowth, verdictResult, workCounters, type CounterBaseline } from '../synthetic/engine/walk-metrics';
import { walkFixtureByteNormalizer } from '../synthetic/engine/walk-byte-normalization';
import { buildWalkReport } from '../synthetic/engine/walk-report';
import { applicableDisturbances, artifactKind, buildSweepScenarios, captureArtifactReads, hasHumanRecovery, isActionableIntegrityRefusal, isCompletedSweepReset,
    isOutOfOrderRefusal, isUncaughtGateError, missingWalkMilestones, mutateSweepFile, sweepApplicability, walkMilestones, WRONG_GATES, wrongGateArgv,
    resetPlannedFiles, wrongGateCheckpoints } from '../synthetic/engine/walk-sweep';
import { GATE_COMMANDS } from '../../../src/compat/shim-registry';
import type { WalkResult, WalkScenario, WalkStep } from '../synthetic/engine/navigator-walk';
import { restoreWalkCheckpoint } from '../synthetic/engine/walk-checkpoint';
import { walkWorkspaceFingerprint, walkNonGitWorkspaceFingerprint, WalkProgressGuard } from '../synthetic/engine/walk-progress';
import { admittedCounterState, compareWalk, fillProviderValues, inspectWalkTaskEvents, isExpectedWalkRefusal, isWalkEffectReinspection, scenarioDisturbanceLabels, WALK_PROVIDER } from '../synthetic/engine/navigator-walk';
import { quoteProviderForCommand, usesPowerShellEnvironmentSyntax } from '../../../src/gates/next-step/next-step-lifecycle-command-builders';
import { matchesDisturbanceSelection, SAMPLE_WALK_SCENARIOS, walkRunPlan } from '../synthetic/engine/walk-plan';
import { WALK_SCENARIOS } from '../synthetic/engine/walk-scenarios';
import { captureWalkOutput } from '../synthetic/engine/walk-output';
import { formatOutOfOrderRefusal } from '../../../src/cli/commands/gate-flows/support/out-of-order-gate-guard';

test('non-Git refusal progress hashes source changes but not runtime bookkeeping', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-non-git-progress-'));
    try {
        fs.writeFileSync(path.join(root, 'source.ts'), 'original');
        const runtime = path.join(root, 'garda-agent-orchestrator/runtime');
        fs.mkdirSync(runtime, { recursive: true });
        const first = walkNonGitWorkspaceFingerprint(root);
        fs.writeFileSync(path.join(runtime, 'task-events.jsonl'), 'metadata');
        assert.equal(walkNonGitWorkspaceFingerprint(root), first);
        fs.writeFileSync(path.join(root, 'source.ts'), 'changed');
        assert.notEqual(walkNonGitWorkspaceFingerprint(root), first);
        fs.writeFileSync(path.join(root, 'source.ts'), 'original');
        assert.equal(walkNonGitWorkspaceFingerprint(root), first);
        fs.renameSync(path.join(root, 'source.ts'), path.join(root, 'renamed.ts'));
        assert.notEqual(walkNonGitWorkspaceFingerprint(root), first);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('route extraction handles executable assignments and conditional gates, ignoring comments, types and event labels', () => {
    const inventory = extractRoutes(`
        // next_gate: 'comment'
        interface Type { nextGate: 'type-only'; status: 'BLOCKED' }
        const ignored = { text: "nextGate: 'not-a-gate'" };
        const a = { status: 'BLOCKED', nextGate: flag ? 'alpha' : 'beta', reason: 'why' };
        const b = { status: flag ? 'BLOCKED' : 'READY', 'next_gate': (flag || 'fallback') as const };
        const c = result('BLOCKED', 'some-command');
        const d = { nextGate: forward.nextGate, reason: forward.reason };
        const alias = 'gamma';
        const e = { nextGate: flag === 'condition-is-not-a-gate' ? alias : 'alpha', status: 'READY' };
    `, 'fixture.ts');
    assert.deepEqual(inventory.gates, ['alpha', 'beta', 'fallback', 'gamma']);
    assert.equal(inventory.points.length, 4);
    assert.equal(inventory.points.filter(entry => entry.blocked).length, 2);
    const coverage = routeCoverage(inventory, [{ gate: 'alpha', status: 'BLOCKED', routes: [inventory.points[0].id] }], []);
    assert.equal(coverage.gates.find(entry => entry.id === 'gate:alpha')?.steps, 1);
    const repeatedObservation = { gate: 'alpha', status: 'BLOCKED', routes: [inventory.points[0].id], stepId: 'same-step' };
    const deduplicated = routeCoverage(inventory, [repeatedObservation, repeatedObservation], []);
    assert.equal(deduplicated.gates.find(entry => entry.id === 'gate:alpha')?.steps, 1);
    assert.equal(deduplicated.blocked.find(entry => entry.id === inventory.points[0].id)?.steps, 1);
    assert.ok(coverage.unaccounted.includes('gate:beta'));
    assert.equal(routeCoverage(inventory, [], [{ id: 'gate:beta', reason: 'Hard to reach' }]).invalidExemptions.length, 1);
    assert.equal(routeCoverage(inventory, [], [{ id: 'removed-route', reason: 'Requires a real provider.' }]).invalidExemptions.length, 1);
});

test('the real route inventory cannot silently shrink to the paths the walker already knows', () => {
    const inventory = readRouteInventory(path.resolve('.'));
    assert.ok(inventory.gates.length >= 69, 'Source inventory lost gates');
    assert.ok(inventory.points.filter(entry => entry.blocked).length >= 148, 'Source inventory lost BLOCKED routes');
    for (const gate of ['source-runtime-remediation', 'test-first-expected-red-stale', 'recover-task-mode-protected-manifest',
        'full-suite-repair-child-handoff', 'strict-decomposition-wip-capture', 'post-done-drift', 'review-evidence-refresh', 'parent-audit', 'next-step']) {
        assert.ok(inventory.gates.includes(gate), gate);
    }
    assert.equal(new Set(inventory.points.map(entry => entry.id)).size, inventory.points.length);
    assert.ok(inventory.points.some(entry => entry.file === 'src/gates/parent-audit/parent-audit-navigation.ts' && entry.blocked),
        'The native parent-audit route builder outside next-step must be counted and observed');
    assert.deepEqual(inventory.points.flatMap(entry => entry.unresolvedGates ?? []), []);
    assert.deepEqual(inventory.points.flatMap(entry => entry.unresolvedStatuses ?? []), []);
});

test('an imported or computed future gate fails source accounting even when no walk reaches it', () => {
    const inventory = extractRoutes('const added = { status: "BLOCKED", nextGate: flag ? IMPORTED_GATE : `new-${phase}` };', 'future.ts');
    assert.deepEqual(inventory.gates, []);
    assert.deepEqual(inventory.points[0].unresolvedGates, ['IMPORTED_GATE', '`new-${phase}`']);
    assert.equal(routeCoverage(inventory, [], []).unaccounted.filter(id => id.startsWith('unresolved-source-gate:')).length, 2);
    const status = extractRoutes('const added = { status: IMPORTED_STATUS, nextGate: "alpha" };', 'future-status.ts');
    assert.ok(routeCoverage(status, [{ gate: 'alpha', status: 'DONE' }], []).unaccounted.some(id => id.startsWith('unresolved-source-status:')));
});

test('shorthand and statically computed route properties cannot hide future routes', () => {
    const inventory = extractRoutes('const status = "BLOCKED", nextGate = "shorthand"; const a = { status, nextGate }; const b = { ["status"]: "BLOCKED", ["next_gate"]: "computed" };', 'properties.ts');
    assert.deepEqual(inventory.gates, ['computed', 'shorthand']);
    assert.equal(inventory.points.filter(point => point.blocked).length, 2);
    const assigned = extractRoutes('out.next_gate = "assigned"; out["status"] = "BLOCKED";', 'assignments.ts');
    assert.deepEqual(assigned.gates, ['assigned']);
    assert.equal(assigned.points.filter(point => point.blocked).length, 1);
});

test('coverage follows the selected object through spreads and projections, excluding identical rejected candidates', () => {
    beginRouteObservation();
    observeRouteConstruction(() => ({ nextGate: 'compile-gate', status: 'BLOCKED', reason: 'same' }), 'rejected');
    const selected = observeRouteConstruction(() => ({ nextGate: 'compile-gate', status: 'BLOCKED', reason: 'same' }), 'selected');
    const spread = observeRouteConstruction(() => ({ ...selected }), '');
    const clone = observeRouteConstruction(() => Object.fromEntries(Object.entries(spread)), '');
    const projected = observeRouteConstruction(() => ({ nextGate: clone.nextGate, status: clone.status, reason: clone.reason }), 'wrapper');
    const output = observeRouteConstruction(() => ({ next_gate: projected.nextGate, status: projected.status, reason: projected.reason }), 'renderer');
    assert.deepEqual(reachedRoutePoints(output as unknown as Parameters<typeof reachedRoutePoints>[0]), ['renderer', 'selected', 'wrapper']);
    const empty = { next_gate: 'compile-gate', status: 'BLOCKED', reason: 'same' };
    assert.deepEqual(reachedRoutePoints(empty), [], 'Matching text alone is not execution evidence');
});

test('coverage follows appended detail on the same route but not a different decision', () => {
    beginRouteObservation();
    const selected = observeRouteConstruction(() => ({ nextGate: 'restart-review-cycle', status: 'BLOCKED',
        title: 'Restart the review', reason: 'Original reason.' }), 'selected');
    const extended = observeRouteConstruction(() => ({ ...selected, reason: selected.reason + ' Additional guidance.' }), 'wrapper');
    assert.deepEqual(reachedRoutePoints(extended as unknown as Parameters<typeof reachedRoutePoints>[0]), ['selected', 'wrapper']);
    const different = observeRouteConstruction(() => ({ ...selected, title: 'Different decision',
        reason: selected.reason + ' Additional guidance.' }), 'different');
    assert.deepEqual(reachedRoutePoints(different as unknown as Parameters<typeof reachedRoutePoints>[0]), ['different']);
});

function step(index: number, ms = 10, count = 2): WalkStep {
    return { index, gate: 'compile-gate', route: 'BLOCKED/compile-gate', status: 'BLOCKED', command: 'node garda gate compile-gate',
        navigatorMs: ms, coreMs: ms - 1, outsideCoreMs: 1, commandMs: 0, exitCode: 0, output: '', reason: 'compile',
        taskEvents: index * 100, workspaceSha256: '', measurement: { phases_ms: { total: ms - 1 }, work: { 'file_hash:C:/fixture/file.ts': count } } };
}
function result(steps: WalkStep[]): WalkResult {
    return { scenarioId: 'fixture', outcome: 'done', detail: '', steps, reviews: [], reviewsByLane: {}, events: [] };
}
const BASELINE: CounterBaseline = { schema: 1, provenance: 'Independent test budget', routes: {
    'BLOCKED/compile-gate': { 'file_hash:file': { expected: 2, tolerance: 0, constantWithEvents: true } }
} };

test('timeline byte budgets normalize fixture paths while retaining actual payload growth', () => {
    const short = 'C:/Users/user0/AppData/Local/Temp/garda-walk-123456';
    const long = 'C:/Users/user0/AppData/Local/Temp/long fixture ü/garda-walk-abcdef';
    const payload = (root: string) => Buffer.from(JSON.stringify({
        forward: root + '/events.jsonl', native: root.replace(/\//gu, '\\') + '\\task-mode.json',
        embedded: JSON.stringify({ path: root.replace(/\//gu, '\\') + '\\artifact.json' }), other: 'retain me'
    }));
    const shortBytes = payload(short), longBytes = payload(long);
    const reference = walkFixtureByteNormalizer(short)(shortBytes);
    assert.notEqual(shortBytes.length, longBytes.length);
    assert.equal(walkFixtureByteNormalizer(long)(longBytes), reference);
    assert.equal(walkFixtureByteNormalizer(long)(Buffer.concat([longBytes, Buffer.from('é')])), reference + 2);
    const history = (root: string) => Buffer.from(JSON.stringify(Array.from({ length: 2_000 }, () => root + '/event')));
    assert.equal(walkFixtureByteNormalizer(long)(history(long)), walkFixtureByteNormalizer(short)(history(short)),
        'Many path occurrences are counted without changing other history bytes');
    const measured = { ...step(0), measurement: { phases_ms: {}, work: { timeline_bytes: longBytes.length,
        timeline_bytes_normalized: reference } } };
    assert.equal(workCounters(measured).timeline_bytes, reference);
    const budget: CounterBaseline = { schema: 1, provenance: 'fixture', routes: {
        'BLOCKED/compile-gate': { timeline_bytes: { expected: reference, tolerance: 0, constantWithEvents: false } }
    } };
    const larger = { ...measured, measurement: { phases_ms: {}, work: { timeline_bytes: longBytes.length + 2,
        timeline_bytes_normalized: reference + 2 } } };
    assert.ok(analyzeWalkMetrics([result([larger])], budget, false).anomalies
        .some(entry => entry.metric === 'timeline_bytes' && entry.kind === 'counter-budget'));
    const failed = { ...measured, measurement: { phases_ms: {}, work: { timeline_bytes: longBytes.length,
        timeline_bytes_normalized: reference, timeline_bytes_normalization_failed: 1 } } };
    assert.equal(workCounters(failed).timeline_bytes, longBytes.length);
    assert.ok(analyzeWalkMetrics([result([failed])], budget, false).anomalies
        .some(entry => entry.metric === 'timeline_bytes_normalization_failed' && entry.kind === 'missing-baseline'));
});

test('per-file counters aggregate the same way under a Windows drive and a POSIX root, and the route counter set stays bounded', () => {
    const work = (root: string) => ({ ['timeline_capture:' + root + '/runtime/task-events/T-WALK.jsonl']: 1,
        ['timeline_payload_read:' + root + '/runtime/reviews/T-WALK-task-mode.json']: 2, ['file_hash:' + root + '/src/a.ts']: 3,
        ['visit:verified_timeline_index_event']: 4, timeline_parse: 1 });
    const windows = workCounters({ ...step(0), measurement: { phases_ms: {}, work: work('C:/Temp/garda-walk-AbC123') } });
    const linux = workCounters({ ...step(0), measurement: { phases_ms: {}, work: work('/tmp/garda-walk-xYz789') } });
    assert.deepEqual(linux, windows);
    assert.deepEqual(Object.keys(linux).sort(), ['file_hash:file', 'timeline_capture:file', 'timeline_parse', 'timeline_payload_read:file',
        'visit:verified_timeline_index_event']);
    // Twenty scenarios on twenty Linux fixture roots measure one counter set, not twenty.
    const results = Array.from({ length: 20 }, (_unused, index) => ({ ...result([{ ...step(0),
        measurement: { phases_ms: {}, work: work('/tmp/garda-walk-' + index) } }]), scenarioId: 'linux-' + index }));
    const [route] = analyzeWalkMetrics(results, BASELINE, false).routes;
    assert.equal(Object.keys(route.counters).length, 5);
    assert.ok(route.growthByScenario.every(entry => Object.keys(entry.counters).length === 5));
});

test('the merge projection keeps every work key a verdict reads and yields the identical report', () => {
    const steps = [0, 1, 2].map(index => ({ ...step(index, 10 + index), measurement: { phases_ms: { total: 9 },
        io: { lstatSync: { count: 12 }, existsSync: { count: 3 } }, work: {
            ['payload_read:/tmp/garda-walk-a/TASK.md']: 1 + index, ['file_hash:/tmp/garda-walk-a/src/' + index + '.ts']: 2,
            ['process:git:' + index]: 1, ['subprocess_timeout:git']: index === 2 ? 1 : 0, ['timeline_capture:/tmp/garda-walk-a/T.jsonl']: 1,
            timeline_parse: 1, ['root_chain_probe:lstatSync:0/3']: 2, ['root_chain_probe:lstatSync:1/3']: 2, ['root_chain_probe:lstatSync:2/3']: 2,
            ['visit:derivation_descriptor_value']: 4000 + index, ['native_realpath_observation:/tmp/garda-walk-a']: 1,
            ['artifact_json_parse:/tmp/garda-walk-a/x.json']: index } } }) as unknown as WalkStep);
    const raw = [result(steps)];
    const projected = raw.map(verdictResult);
    assert.deepEqual(Object.keys(projected[0].steps[0].measurement!.work).filter(key => /visit:derivation|native_realpath|artifact_json/u.test(key)), []);
    assert.ok(Object.keys(raw[0].steps[0].measurement!.work).some(key => key.startsWith('visit:derivation')), 'The stored record is not mutated');
    for (const baseline of [BASELINE, { ...BASELINE, routes: { 'BLOCKED/compile-gate': { payload_reads: { expected: 1, tolerance: 0, constantWithEvents: true },
        'subprocess:git': { expected: 0, tolerance: 0, constantWithEvents: true }, 'file_probes:lstatSync': { expected: 1, tolerance: 0, constantWithEvents: false } } } }]) {
        assert.deepEqual(analyzeWalkMetrics(projected, baseline, false), analyzeWalkMetrics(raw, baseline, false));
    }
    assert.deepEqual(JSON.parse(JSON.stringify(buildWalkReport(projected, []))), JSON.parse(JSON.stringify(buildWalkReport(raw, []))));
});

test('a declared handoff requires the exact terminal gate, status and guidance, even if a walk reaches DONE', () => {
    const scenario: WalkScenario = { id: 'handoff', edits: [], expectedReviews: {}, expectedModes: [],
        expectedBlockedGate: null, expectedGuidance: /Restore its original approved bytes/u };
    const blocked: WalkResult = { ...result([{ ...step(0), gate: null, status: 'BLOCKED', command: null }]),
        outcome: 'blocked', detail: 'Restore its original approved bytes.' };
    assert.deepEqual(compareWalk(scenario, blocked), []);
    const effectHandoff: WalkResult = { ...blocked, steps: [{ ...step(0), gate: 'next-step-effect',
        effectResult: { gate: null, status: 'BLOCKED', route: 'BLOCKED/(none)', routes: [], reason: blocked.detail } }] };
    assert.deepEqual(compareWalk(scenario, effectHandoff), [], 'The selected result of executed effects is the actual handoff');
    assert.equal(buildWalkReport([effectHandoff], []).scenarios[0].terminalRoute, 'BLOCKED/(none)');
    const visited = { ...scenario, expectedBlockedGate: undefined, expectedGates: ['activate-optional-skill'] };
    assert.ok(compareWalk(visited, result([step(0)])).some(finding => finding.id === 'walk:missing-route:handoff:activate-optional-skill'));
    assert.deepEqual(compareWalk(visited, result([{ ...step(0), gate: 'activate-optional-skill' }])), []);
    for (const changed of [
        { ...blocked, outcome: 'done' as const }, { ...blocked, detail: 'Missing evidence.' },
        { ...blocked, steps: [{ ...blocked.steps[0], gate: 'task-reset' }] },
        { ...blocked, steps: [{ ...blocked.steps[0], status: 'DECOMPOSED' }] }
    ]) assert.ok(compareWalk(scenario, changed).some(finding => finding.id === 'walk:missing-handoff:handoff'));
});

test('counter spikes and event growth fail independently of noisy time; quiet mode promotes time flags', () => {
    const results = [result([step(0), step(1), step(2, 3000, 4)])];
    const loaded = analyzeWalkMetrics(results, BASELINE, false);
    assert.ok(loaded.anomalies.some(entry => entry.kind === 'counter-budget' && entry.severity === 'failure'));
    assert.ok(loaded.anomalies.some(entry => entry.kind === 'counter-growth' && entry.severity === 'failure'));
    assert.ok(loaded.anomalies.some(entry => entry.kind === 'time-spike' && entry.severity === 'warning'));
    assert.ok(analyzeWalkMetrics(results, BASELINE, true).anomalies.some(entry => entry.kind === 'time-spike' && entry.severity === 'failure'));
    assert.equal(fittedGrowth([{ events: 0, value: 2 }, { events: 100, value: 3 }, { events: 200, value: 4 }]), 1);
    const split = [result([step(0)]), { ...result([step(2, 3000)]), scenarioId: 'different-task' }];
    assert.equal(analyzeWalkMetrics(split, BASELINE, false).anomalies.some(entry => entry.kind === 'time-growth'), false);
    const exact = analyzeWalkMetrics([result([{ ...step(0, 10, 2), taskEvents: 1 }, { ...step(1, 30, 3), taskEvents: 2 }])], BASELINE, false);
    assert.equal(exact.routes[0].wall_ms.median, 20, 'Even-size medians average their middle observations');
    assert.ok(exact.anomalies.some(entry => entry.kind === 'counter-growth'), 'Exact counters need no noisy-time minimum event span');
    assert.equal(exact.anomalies.some(entry => entry.kind === 'time-growth'), false);
    const differentDecisions = result([{ ...step(0, 10, 2), routes: ['source:A'] },
        { ...step(1, 10, 4), routes: ['source:B'] }, { ...step(2, 10, 4), routes: ['source:B'] }]);
    assert.equal(analyzeWalkMetrics([differentDecisions], BASELINE, false).anomalies.some(entry => entry.kind === 'counter-growth'), false,
        'Different source decisions sharing a gate name must not create a spurious history slope');
});

test('a timed-out subprocess retry is a timing observation, while any other extra call still fails its budget', () => {
    const baseline: CounterBaseline = { schema: 1, provenance: 'Independent test budget', routes: {
        'BLOCKED/compile-gate': { 'subprocess:icacls.exe': { expected: 2, tolerance: 0, constantWithEvents: true } } } };
    const acl = (index: number, calls: number, timeouts: number): WalkStep => ({ ...step(index), measurement: { phases_ms: { total: 9 },
        work: { 'process:spawnSync:icacls.exe:aaaa': calls, ...timeouts ? { 'subprocess_timeout:icacls.exe': timeouts } : {} } } });
    const retried = [result([acl(0, 2, 0), acl(1, 3, 1), acl(2, 2, 0)])];
    for (const quiet of [false, true]) {
        const { anomalies } = analyzeWalkMetrics(retried, baseline, quiet);
        assert.deepEqual(anomalies.filter(entry => entry.kind.startsWith('counter')), [], 'A timed-out attempt and its retry are not work growth');
        const timeout = anomalies.filter(entry => entry.kind === 'time-subprocess-timeout');
        assert.equal(timeout.length, 1);
        assert.deepEqual([timeout[0].metric, timeout[0].observed, timeout[0].step], ['subprocess_timeout:icacls.exe', 1, 1]);
        assert.equal(timeout[0].severity, quiet ? 'failure' : 'warning', 'Quiet mode promotes the timeout like any time flag');
    }
    const extra = analyzeWalkMetrics([result([acl(0, 2, 0), acl(1, 3, 0)])], baseline, false).anomalies;
    assert.ok(extra.some(entry => entry.kind === 'counter-budget' && entry.observed === 3), 'An extra call without a timeout still fails');
    const twoExtra = analyzeWalkMetrics([result([acl(0, 4, 1)])], baseline, false).anomalies;
    assert.ok(twoExtra.some(entry => entry.kind === 'counter-budget' && entry.observed === 3), 'Only the timed-out attempt is set aside');
});

interface SelectionCounterCalibration {
    unchangedSubprocessBudgetSha256: string;
    changes: Array<{ route: string; state?: string; metric: string; expected: number; tolerance: number;
        previousExpected?: number; previousLimit?: number; observed: number; limit: number;
        constantWithEvents: boolean; growthTolerance: number; reason: string; commits: string[] }>;
    historyProbes: Array<{ historyAdded: number; before: Record<string, number>; after: Record<string, number> }>;
}

function readSelectionCounterCalibration(): SelectionCounterCalibration {
    return JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-calibration-evidence.json', 'utf8'))
        .release144SelectionCounterCalibration as SelectionCounterCalibration;
}

/** Historical ledger tests keep testing their original limits; the current ledger is tested separately below. */
function preSelectionCounterBaseline(): CounterBaseline {
    const baseline = JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-baseline.json', 'utf8')) as CounterBaseline;
    for (const change of readSelectionCounterCalibration().changes) {
        const counters = change.state ? baseline.states![change.state].routes[change.route] : baseline.routes[change.route];
        if (change.previousExpected === undefined) delete counters[change.metric];
        else counters[change.metric] = { ...counters[change.metric], expected: change.previousExpected,
            tolerance: change.previousLimit! - change.previousExpected };
    }
    return baseline;
}

test('selection calibration retains subprocess limits and rejects work above each measured bound', () => {
    const baseline = JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-baseline.json', 'utf8')) as CounterBaseline;
    const calibration = readSelectionCounterCalibration();
    const nativeShapes = JSON.parse(fs.readFileSync('tests/node/synthetic/native-counter-input-shapes.json', 'utf8')) as { shapes: Array<{ id: string }> };
    const laterProfiles = new Set(['stack-fixture-spring-maven-two-modules', 'native-api-selected-initial',
        'native-api-selected-remediation', ...nativeShapes.shapes.map(shape => shape.id)]);
    const sections: Record<string, { routes: CounterBaseline['routes'] }> = { ordinary: baseline, ...baseline.states };
    // Preserve the original fingerprint: later sealed profiles and the newly observed PowerShell metric
    // have their own calibrations. Every current subprocess ceiling is exercised by the test below.
    const subprocessBudgets = Object.entries(sections).filter(([state]) => !laterProfiles.has(state))
        .flatMap(([state, section]) => Object.entries(section.routes)
        .flatMap(([route, metrics]) => Object.entries(metrics).filter(([metric]) => metric.startsWith('subprocess:') && metric !== 'subprocess:powershell.exe')
            .map(([metric, budget]) => [state + '|' + route + '|' + metric, budget] as const)))
        .sort(([a], [b]) => a.localeCompare(b));
    assert.equal(createHash('sha256').update(JSON.stringify(subprocessBudgets)).digest('hex'), calibration.unchangedSubprocessBudgetSha256);
    assert.ok(calibration.changes.some(change => change.metric === 'visit:verified_timeline_selected_event'
        && change.route === 'BLOCKED/task-test-selection'));
    for (const change of calibration.changes) {
        assert.ok(!change.metric.startsWith('subprocess:'), change.metric);
        assert.ok(change.reason.length > 0 && change.commits.length > 0);
        assert.equal(change.expected + change.tolerance, change.limit);
        assert.equal(change.limit, change.observed);
        assert.equal(change.growthTolerance, 0);
        if (change.previousExpected !== undefined && change.metric !== 'visit:timeline_cloned_event') {
            if (change.metric === 'payload_reads') assert.ok(change.tolerance <= change.previousLimit! - change.previousExpected);
            else assert.equal(change.previousLimit! - change.previousExpected, change.tolerance);
        }
        const budget = (change.state ? baseline.states![change.state].routes[change.route] : baseline.routes[change.route])[change.metric];
        assert.deepEqual(budget, { expected: change.expected, tolerance: change.tolerance,
            constantWithEvents: change.constantWithEvents, growthTolerance: change.growthTolerance });
        const workKey = change.metric === 'payload_reads' ? 'payload_read:fixture'
            : change.metric === 'file_hash:file' ? 'file_hash:fixture' : change.metric;
        const measurement: NonNullable<WalkStep['measurement']> = change.metric.startsWith('file_probes:')
            ? { phases_ms: {}, work: {}, io: { [change.metric.slice('file_probes:'.length)]: {
                count: change.limit + 1, total_ms: 0, max_ms: 0, throws: 0 } } }
            : { phases_ms: {}, work: { [workKey]: change.limit + 1 } };
        const over = { ...step(0), route: change.route, counterState: change.state, measurement };
        assert.ok(analyzeWalkMetrics([result([over])], baseline, false).anomalies
            .some(entry => entry.kind === 'counter-budget' && entry.metric === change.metric), change.route + '/' + change.metric);
    }
    for (const probe of calibration.historyProbes) {
        assert.equal(probe.after.timeline_events - probe.before.timeline_events, probe.historyAdded);
        for (const metric of Object.keys(probe.before).filter(metric => metric.startsWith('subprocess:')
            || metric.startsWith('file_probes:') || ['file_hash:file', 'payload_reads'].includes(metric))) {
            assert.equal(probe.after[metric], probe.before[metric], metric);
        }
        assert.equal(probe.before['visit:timeline_cloned_event'] ?? 0, 0);
        assert.equal(probe.after['visit:timeline_cloned_event'] ?? 0, 0);
    }
});

test('all current subprocess calibration sections reject one extra call', () => {
    const baseline = JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-baseline.json', 'utf8')) as CounterBaseline;
    const sections: Record<string, { routes: CounterBaseline['routes'] }> = { ordinary: baseline, ...baseline.states };
    const currentBudgets = Object.entries(sections).flatMap(([state, section]) => Object.entries(section.routes)
        .flatMap(([route, metrics]) => Object.entries(metrics).filter(([metric]) => metric.startsWith('subprocess:'))
            .map(([metric, budget]) => [state + '|' + route + '|' + metric, budget] as const)))
        .sort(([a], [b]) => a.localeCompare(b));
    // Lock the complete separately accepted surface too; the original calibration hash above stays unchanged.
    assert.equal(createHash('sha256').update(JSON.stringify(currentBudgets)).digest('hex'),
        '9c0adc6eea0b010b785fb4b0fb779636c421aac5aaf158e3c0da669a7188e052');
    const programs = new Set<string>();
    for (const [state, section] of Object.entries(sections)) for (const [route, metrics] of Object.entries(section.routes)) {
        for (const [metric, budget] of Object.entries(metrics)) {
            if (!metric.startsWith('subprocess:')) continue;
            const program = metric.slice('subprocess:'.length), limit = budget.expected + budget.tolerance;
            programs.add(program);
            for (const extra of [0, 1]) {
                const current = { ...step(0), route, counterState: state === 'ordinary' ? undefined : state,
                    measurement: { phases_ms: {}, work: { ['process:spawnSync:' + program + ':calibration-control']: limit + extra } } };
                const failures = analyzeWalkMetrics([result([current])], baseline, false).anomalies
                    .filter(entry => entry.kind === 'counter-budget' && entry.metric === metric);
                assert.equal(failures.length, extra, state + '/' + route + '/' + metric);
            }
        }
    }
    assert.ok(programs.has('git'));
    assert.ok(programs.has('icacls.exe'));
    assert.ok(programs.has('powershell.exe'));
});

test('review fixes calibrate unique payload reads and the actual selection and native-ref routes', () => {
    const calibration = readSelectionCounterCalibration() as SelectionCounterCalibration & { reviewFixes: {
        payload: { before: number; after: number; namedInputs: Record<string, { before: number; after: number }>;
            changes: Array<{ route: string; before: number; after: number; witnessId: string }> };
        selectionRouteChanges: Array<{ metric: string; after: number; witnessId: string }>;
        nativeRefCalibration: Array<{ route: string; referenceCommit: string; disposition: string;
            acceptedNativeRefReads: Array<[string, number]>;
            control: { route: string; nativeGit: number; commandGit: number; savedGit: number } }>;
        freshnessRereads: Array<{ source: string; checks: string }>;
        witnesses: Record<string, { route: string; command: string; counters: Record<string, number> }>;
    } };
    const fixes = calibration.reviewFixes;
    assert.ok(fixes.payload.after < fixes.payload.before);
    assert.equal(Object.keys(fixes.payload.namedInputs).length, 6);
    for (const input of Object.values(fixes.payload.namedInputs)) {
        assert.ok(input.before > 1);
        assert.equal(input.after, 1);
    }
    assert.equal(fixes.payload.changes.length, 22);
    for (const change of fixes.payload.changes) {
        assert.ok(change.after < change.before, change.route);
        const witness = fixes.witnesses[change.witnessId];
        assert.equal(witness.route, change.route);
        assert.equal(witness.counters.payload_reads, change.after);
        const budget = calibration.changes.find(row => row.route === change.route && row.metric === 'payload_reads')!;
        assert.equal(budget.limit, change.after);
        assert.equal(budget.tolerance, 0);
    }
    assert.equal(fixes.selectionRouteChanges.length, 13);
    for (const change of fixes.selectionRouteChanges) {
        const witness = fixes.witnesses[change.witnessId];
        assert.equal(witness.route, 'BLOCKED/task-test-selection');
        assert.match(witness.command, /--full-suite-command/u);
        assert.match(witness.command, /--focused-required-test-path/u);
        assert.equal(witness.counters[change.metric], change.after);
    }
    assert.equal(fixes.nativeRefCalibration.length, 37);
    for (const entry of fixes.nativeRefCalibration) {
        assert.equal(entry.referenceCommit, '9cc56c65');
        assert.equal(entry.control.route, entry.route);
        assert.equal(entry.control.commandGit - entry.control.nativeGit, entry.control.savedGit);
        assert.ok(entry.control.savedGit >= 0);
        if (entry.control.savedGit) {
            assert.equal(entry.disposition, 'accepted native-ref reads replacing Git subprocesses');
            assert.ok(entry.acceptedNativeRefReads.some(([file, count]) => file.endsWith('/HEAD') && count === 1));
        } else {
            assert.equal(entry.disposition, 'retired native-ref attribution on this route');
        }
    }
    assert.ok(fixes.freshnessRereads.length >= 5);
    for (const reread of fixes.freshnessRereads) {
        assert.ok(fs.existsSync(reread.source));
        assert.ok(reread.checks.length > 0);
    }
});

test('numeric and source-set envelopes stay finite and never permit constant-work growth', () => {
    const baseline = preSelectionCounterBaseline();
    const evidence = JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-calibration-evidence.json', 'utf8')) as {
        finishTolerance: { changes: Array<{ route: string; metric: string; previousLimit: number; additionalTolerance: number }> };
        round7CounterCalibration: {
            byteComparison: { oldTimeline: number; oldTaskMode: number; oldTotal: number; currentTimeline: number;
                currentTaskMode: number; currentTotal: number; contributions: Array<{ timelineBytes: number; taskModeBytes: number }> };
            aclBatchComparison: { absent: Record<string, number>; present: Record<string, number> };
            changes: Array<{ route: string; metric: string; previousExpected: number; expected: number; tolerance: number;
                previousLimit: number; limit: number }>;
        };
        release144TimelineCalibration: {
            changes: Array<{ route: string; state?: string; metric: string; previousExpected: number; expected: number;
                tolerance: number; previousLimit: number; observed: number; limit: number; commits: string[]; reason: string }>;
        };
    };
    const calibration = evidence.round7CounterCalibration;
    assert.deepEqual(calibration.changes, [
        { route: 'BLOCKED/run-intermediate-command', metric: 'timeline_bytes',
            previousExpected: 84711, expected: 90135, tolerance: 4096, previousLimit: 88807, limit: 94231 },
        { route: 'BLOCKED/load-rule-pack', metric: 'file_probes:lstatSync',
            previousExpected: 399, expected: 401, tolerance: 244, previousLimit: 643, limit: 645 },
        { route: 'BLOCKED/load-rule-pack', metric: 'file_probes:realpathSync.native',
            previousExpected: 400, expected: 402, tolerance: 191, previousLimit: 591, limit: 593 },
        { route: 'BLOCKED/run-intermediate-command', metric: 'file_probes:lstatSync',
            previousExpected: 649, expected: 651, tolerance: 0, previousLimit: 649, limit: 651 },
        { route: 'BLOCKED/run-intermediate-command', metric: 'file_probes:realpathSync.native',
            previousExpected: 609, expected: 611, tolerance: 0, previousLimit: 609, limit: 611 }
    ]);
    const bytes = calibration.byteComparison;
    assert.equal(bytes.oldTimeline + bytes.oldTaskMode, bytes.oldTotal);
    assert.equal(bytes.currentTimeline + bytes.currentTaskMode, bytes.currentTotal);
    assert.equal(bytes.oldTimeline + bytes.contributions.reduce((sum, entry) => sum + entry.timelineBytes, 0), bytes.currentTimeline);
    assert.equal(bytes.oldTaskMode + bytes.contributions.reduce((sum, entry) => sum + entry.taskModeBytes, 0), bytes.currentTaskMode);
    assert.equal(bytes.oldTotal, calibration.changes[0].previousExpected);
    assert.equal(bytes.currentTotal, calibration.changes[0].expected);
    for (const metric of ['file_probes:lstatSync', 'file_probes:realpathSync.native']) {
        assert.equal(calibration.aclBatchComparison.present[metric] - calibration.aclBatchComparison.absent[metric], 2);
    }
    assert.equal(calibration.aclBatchComparison.present.payload_reads, calibration.aclBatchComparison.absent.payload_reads);
    for (const recalibration of calibration.changes) {
        const budget = baseline.routes[recalibration.route][recalibration.metric];
        assert.equal(recalibration.previousLimit, recalibration.previousExpected + recalibration.tolerance);
        assert.equal(budget.expected, recalibration.expected);
        assert.equal(budget.tolerance, recalibration.tolerance);
        assert.equal(budget.expected + budget.tolerance, recalibration.limit);
        if (recalibration.metric.startsWith('file_probes:')) {
            const name = recalibration.metric.slice('file_probes:'.length);
            const measurement: NonNullable<WalkStep['measurement']> = { phases_ms: {}, work: {},
                io: { [name]: { count: recalibration.limit + 1, total_ms: 0, max_ms: 0, throws: 0 } } };
            assert.ok(analyzeWalkMetrics([result([{ ...step(0), route: recalibration.route, measurement }])], baseline, false).anomalies
                .some(entry => entry.kind === 'counter-budget' && entry.metric === recalibration.metric));
        }
    }
    for (const change of evidence.finishTolerance.changes) {
        const budget = baseline.routes[change.route][change.metric];
        const limit = budget.expected + budget.tolerance;
        const recalibration = calibration.changes.find(entry => entry.route === change.route && entry.metric === change.metric);
        const releaseCalibration = evidence.release144TimelineCalibration.changes.find(entry => !entry.state
            && entry.route === change.route && entry.metric === change.metric);
        if (recalibration) {
            assert.equal(change.previousLimit, recalibration.previousExpected);
            assert.equal(change.additionalTolerance, recalibration.tolerance);
            assert.equal(recalibration.previousLimit, recalibration.previousExpected + recalibration.tolerance);
            assert.equal(budget.expected, recalibration.expected);
            assert.equal(budget.tolerance, recalibration.tolerance);
            assert.equal(limit, recalibration.limit);
        }
        const previousLimit = change.previousLimit + change.additionalTolerance
            + (recalibration ? recalibration.expected - recalibration.previousExpected : 0);
        if (releaseCalibration) assert.equal(releaseCalibration.previousLimit, previousLimit);
        assert.equal(limit, previousLimit + (releaseCalibration ? releaseCalibration.limit - releaseCalibration.previousLimit : 0));
        const measurement: NonNullable<WalkStep['measurement']> = change.metric === 'timeline_bytes'
            ? { phases_ms: {}, work: { timeline_bytes: limit + 1 } }
            : { phases_ms: {}, work: {}, io: { lstatSync: { count: limit + 1, total_ms: 0, max_ms: 0, throws: 0 } } };
        const over = { ...step(0), route: change.route, measurement };
        assert.ok(analyzeWalkMetrics([result([over])], baseline, false).anomalies
            .some(entry => entry.kind === 'counter-budget' && entry.metric === change.metric));
    }
    for (const routes of [baseline.routes, ...Object.values(baseline.states ?? {}).map(state => state.routes)]) {
        for (const counters of Object.values(routes)) for (const budget of Object.values(counters)) {
            if (budget.constantWithEvents) assert.equal(budget.growthTolerance ?? 0, 0);
        }
    }
    const route = 'DONE/(done)', hash = baseline.routes[route]['file_hash:file'];
    const growing = [0, 1].map(index => ({ ...step(index, 10, hash.expected + index), route }));
    assert.ok(analyzeWalkMetrics([result(growing)], baseline, false).anomalies.some(entry => entry.kind === 'counter-growth'));
});

test('1.4.4 timeline calibrations are attributed and stop at the observed limit', () => {
    const baseline = preSelectionCounterBaseline();
    const evidence = JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-calibration-evidence.json', 'utf8')) as {
        release144TimelineCalibration: { changes: Array<{ route: string; state?: string; metric: string; previousExpected: number;
            expected: number; tolerance: number; previousLimit: number; observed: number; limit: number; commits: string[]; reason: string;
            oldObserved?: number; eventTypeDeltas?: Record<string, number>; taskModeAddedBytes?: number }> };
    };
    for (const change of evidence.release144TimelineCalibration.changes) {
        const budget = (change.state ? baseline.states?.[change.state]?.routes[change.route] : baseline.routes[change.route])?.[change.metric];
        assert.ok(budget, change.route);
        assert.equal(change.previousExpected + change.tolerance, change.previousLimit);
        assert.ok(change.expected >= change.previousExpected);
        assert.ok(change.commits.length > 0 && change.reason.length > 0);
        assert.equal(budget.expected, change.expected);
        assert.equal(budget.tolerance, change.tolerance);
        assert.equal(budget.expected + budget.tolerance, change.limit);
        assert.equal(change.limit, change.observed);
        if (change.eventTypeDeltas && change.oldObserved !== undefined && change.taskModeAddedBytes !== undefined) {
            const accountedBytes = Object.values(change.eventTypeDeltas).reduce((sum, bytes) => sum + bytes, 0) + change.taskModeAddedBytes;
            assert.equal(accountedBytes, change.observed - change.oldObserved, change.route);
        }
        assert.equal(budget.growthTolerance ?? 0, 0);
        const over = { ...step(0), route: change.route, counterState: change.state,
            measurement: { phases_ms: {}, work: { timeline_bytes: change.limit + 1 } } };
        assert.ok(analyzeWalkMetrics([result([over])], baseline, false).anomalies
            .some(entry => entry.kind === 'counter-budget' && entry.metric === change.metric));
    }
});

test('1.4.4 preflight snapshot ACL calibrations are attributed and bounded', () => {
    const baseline = preSelectionCounterBaseline();
    const evidence = JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-calibration-evidence.json', 'utf8')) as {
        release144SnapshotAclCalibration: { changes: Array<{ route: string; state?: string; metric: string;
            previousExpected: number; expected: number; tolerance: number; previousLimit: number; observed: number;
            limit: number; commits: string[]; reason: string;
            measurements: Array<{ oldObserved: number; observed: number; snapshotCount?: number; additionalAclSiblingCount?: number }> }> };
    };
    for (const change of evidence.release144SnapshotAclCalibration.changes) {
        const budget = (change.state ? baseline.states?.[change.state]?.routes[change.route] : baseline.routes[change.route])?.[change.metric];
        assert.ok(budget, change.route);
        assert.equal(change.previousExpected + change.tolerance, change.previousLimit);
        assert.ok(change.expected >= change.previousExpected);
        assert.ok(change.commits.includes('057c596c') && change.reason.length > 0);
        assert.ok(change.measurements.length > 0);
        assert.ok(change.measurements.every(measurement => measurement.observed - measurement.oldObserved
            === 2 * (measurement.additionalAclSiblingCount ?? measurement.snapshotCount ?? 1)));
        assert.equal(Math.max(...change.measurements.map(measurement => measurement.observed)), change.observed);
        assert.equal(budget.expected, change.expected);
        assert.equal(budget.tolerance, change.tolerance);
        assert.equal(budget.expected + budget.tolerance, change.limit);
        assert.equal(change.limit, change.observed);
        assert.equal(budget.growthTolerance ?? 0, 0);
        const probe = change.metric.replace(/^file_probes:/u, '');
        const over = { ...step(0), route: change.route, counterState: change.state,
            measurement: { phases_ms: {}, work: {}, io: { [probe]: { count: change.limit + 1, total_ms: 0, max_ms: 0, throws: 0 } } } };
        assert.ok(analyzeWalkMetrics([result([over])], baseline, false).anomalies
            .some(entry => entry.kind === 'counter-budget' && entry.metric === change.metric));
    }
});

test('growth means the same inputs cost more with history; a new evidence file is a reported state difference', () => {
    const fixture = 'C:/Temp/garda-walk-AbC123/';
    const withHashes = (index: number, events: number, files: Record<string, number>): WalkStep => ({ ...step(index), taskEvents: events,
        measurement: { phases_ms: { total: 9 }, work: Object.fromEntries(Object.entries(files).map(([file, count]) => ['file_hash:' + fixture + file, count])) } });
    const budget: CounterBaseline = { schema: 1, provenance: 'Independent test budget', routes: {
        'BLOCKED/compile-gate': { 'file_hash:file': { expected: 10, tolerance: 0, constantWithEvents: true } } } };
    const newEvidence = analyzeWalkMetrics([result([withHashes(0, 8, { 'TASK.md': 1 }), withHashes(1, 12, { 'TASK.md': 1, 'runtime/receipt.json': 1 })])], budget, false);
    assert.equal(newEvidence.anomalies.some(entry => entry.kind === 'counter-growth'), false);
    const cohort = newEvidence.routes[0].evidenceCohorts[0];
    assert.deepEqual(cohort.added, ['file_hash:runtime/receipt.json']);
    assert.deepEqual(cohort.cohorts.map(entry => entry.values), [[1], [2]]);
    const repeated = analyzeWalkMetrics([result([withHashes(0, 8, { 'TASK.md': 1 }), withHashes(1, 12, { 'TASK.md': 3 })])], budget, false);
    assert.ok(repeated.anomalies.some(entry => entry.kind === 'counter-growth' && entry.severity === 'failure'),
        'Hashing the same input more often as history grows remains a failure');
});

test('parent timeline sets and separate child histories do not create false scalar growth', () => {
    const route = 'BLOCKED/compile-gate';
    const baseline: CounterBaseline = { schema: 1, provenance: 'Independent timeline count contract', routes: {
        [route]: { timeline_parse: { expected: 4, tolerance: 0, constantWithEvents: true },
            timeline_verify: { expected: 4, tolerance: 0, constantWithEvents: true } }
    } };
    const timelines = (index: number, names: string[], count: number): WalkStep => ({ ...step(index), taskId: 'parent',
        measurement: { phases_ms: {}, work: { timeline_parse: count, timeline_verify: count,
            ...Object.fromEntries(names.map(name => ['timeline_capture:C:/Temp/garda-walk-AbC123/' + name + '.jsonl', 1])) } } });
    const first = timelines(0, ['parent'], 1), accepted = timelines(1, ['parent', 'child1', 'child2'], 3);
    const measured = analyzeWalkMetrics([result([first, accepted])], baseline, false);
    assert.equal(measured.anomalies.some(entry => entry.kind === 'counter-growth'), false);
    assert.deepEqual(measured.routes[0].evidenceCohorts.find(cohort => cohort.counter === 'timeline_parse')?.cohorts.map(cohort => cohort.values), [[1], [3]]);
    const repeated = analyzeWalkMetrics([result([accepted, timelines(2, ['parent', 'child1', 'child2'], 4)])], baseline, false);
    assert.equal(repeated.anomalies.filter(entry => entry.kind === 'counter-growth').length, 2,
        'Both scalar counters retain zero tolerance over identical timeline inputs');
    const children = [0, 1].map(index => ({ ...step(index, 10, 2 + index), taskId: 'child-' + index }));
    assert.equal(analyzeWalkMetrics([result(children)], BASELINE, false).anomalies.some(entry => entry.kind === 'counter-growth'), false);
    assert.ok(analyzeWalkMetrics([result(children.map(entry => ({ ...entry, taskId: 'same-child' })))], BASELINE, false)
        .anomalies.some(entry => entry.kind === 'counter-growth'));
});

test('separately measured states leave ordinary budgets and constant-work growth checks intact', () => {
    const route = 'BLOCKED/compile-gate';
    const baseline: CounterBaseline = { ...BASELINE, states: { 'additional-evidence': {
        provenance: 'Controlled unchanged-input probe, five extra events; constant work unchanged.',
        routes: { [route]: { 'file_hash:file': { expected: 4, tolerance: 0, constantWithEvents: true, growthTolerance: 0 } } }
    } } };
    const measuredSteps = [step(0, 10, 4), step(1, 10, 4)].map(entry => ({ ...entry, counterState: 'additional-evidence' }));
    const measured = result(measuredSteps);
    assert.equal(analyzeWalkMetrics([measured], baseline, false).anomalies.length, 0);
    assert.ok(analyzeWalkMetrics([{ ...result([step(0, 10, 4)]), counterState: 'additional-evidence' }], baseline, false).anomalies
        .some(entry => entry.kind === 'counter-budget'), 'An ordinary state retains its smaller budget');
    assert.ok(analyzeWalkMetrics([result([step(0, 10, 3), step(1, 10, 4)].map(entry => ({ ...entry, counterState: 'additional-evidence' })))], baseline, false).anomalies
        .some(entry => entry.kind === 'counter-growth'), 'A measured state still fails growth below its absolute budget');
    assert.ok(analyzeWalkMetrics([{ ...measured, steps: [{ ...step(0, 10, 4), route: 'BLOCKED/new-route' }] }], baseline, false).anomalies
        .some(entry => entry.kind === 'missing-baseline'), 'A state does not exempt other uncalibrated routes');
    assert.deepEqual(baseline.routes, BASELINE.routes);
});

test('a calibration family cannot raise budgets before its native state admission', () => {
    for (const state of ['declared-recipe-reviewed', 'declared-recipe-docs-only']) {
        assert.equal(admittedCounterState(state, []), undefined);
        assert.equal(admittedCounterState(state, [{ type: 'TASK_MODE_ENTERED', details: {} }]), undefined);
        assert.equal(admittedCounterState(state, [], 'T-WALK', [], true), state,
            'Audited workflow admission precedes task entry; a scenario label or task entry alone is insufficient');
    }
    assert.equal(admittedCounterState('test-first-recorded-red', []), undefined);
    const red = [{ type: 'TEST_FIRST_EXPECTED_FAILURE_RECORDED', details: {} }];
    assert.equal(admittedCounterState('test-first-recorded-red', red), 'test-first-recorded-red');
    assert.equal(admittedCounterState('optional-skill-activation', red), undefined);
    assert.equal(admittedCounterState('unmeasured-state', red), undefined);
    const entry = [{ type: 'TASK_MODE_ENTERED', details: {} }];
    assert.equal(admittedCounterState('native-child-tree', entry), undefined, 'Parent entry precedes native decomposition');
    assert.equal(admittedCounterState('native-child-tree', [], 'T-WALK-1'), undefined);
    assert.equal(admittedCounterState('native-child-tree', [], 'T-WALK-1', entry), undefined);
    assert.equal(admittedCounterState('native-child-tree', [], 'T-WALK-1', [{ type: 'STRICT_DECOMPOSITION_DECISION_RECORDED', details: {} }]), 'native-child-tree');
    assert.equal(admittedCounterState('full-suite-child-tree', [], 'T-WALK-F1', [{ type: 'FULL_SUITE_REPAIR_TASK_MATERIALIZED', details: {} }]), 'full-suite-child-tree');
    assert.equal(admittedCounterState('native-child-tree', entry, 'T-WALK-1'), 'native-child-tree');
    assert.equal(admittedCounterState('native-child-tree', [{ type: 'STRICT_DECOMPOSITION_DECISION_RECORDED', details: {} }]), 'native-child-tree');
});

test('counter budgets and growth judge undisturbed runs only; disturbed variants are reported without failing', () => {
    const route = 'BLOCKED/unbudgeted-fixture-route';
    const heavy = (index: number) => ({ ...step(index, 10, 500), route });
    const disturbed: WalkResult = { ...result([heavy(0), heavy(1)]), scenarioId: 'sweep-fixture',
        sweep: { seed: 1, baseline: 'clean-pass', step: 0, disturbances: ['edit-production'], applied: ['edit-production'] } };
    const report = buildWalkReport([disturbed], []);
    assert.deepEqual(report.anomalies, [], 'A disturbed run must not produce judged anomalies');
    assert.deepEqual(anomalyFindings(report.anomalies), []);
    assert.equal(report.disturbed.results, 1);
    assert.ok(report.disturbed.overBudget.some(entry => entry.kind === 'missing-baseline' && entry.route === route && entry.records === 1));
    const undisturbed = buildWalkReport([{ ...disturbed, scenarioId: 'fixture', sweep: undefined }], []);
    assert.ok(anomalyFindings(undisturbed.anomalies).some(entry => entry.id.startsWith('walk:missing-baseline:fixture:')),
        'The same work on an undisturbed run still fails');
    assert.equal(undisturbed.disturbed.results, 0);
    const familyFault = buildWalkReport([{ ...disturbed, scenarioId: 'family-fault', sweep: undefined,
        disturbances: ['Delete the frozen task plan after real task-mode entry'] }], []);
    assert.deepEqual(familyFault.anomalies, []);
    assert.equal(familyFault.disturbed.results, 1);
    assert.ok(familyFault.disturbed.overBudget.some(entry => entry.route === route));
});

test('sweep enumerates every applicable single disturbance and seeded combinations reproducibly', () => {
    const first = step(0), second = step(1);
    second.reads = [{ path: 'bundle/runtime/T-preflight.json', kind: 'preflight' }];
    const scenario: WalkScenario = { id: 'fixture', edits: [], expectedReviews: {}, expectedModes: [] };
    const baselines = [{ scenario, result: result([first, second]) }];
    const a = buildSweepScenarios(baselines, 42), b = buildSweepScenarios(baselines, 42);
    assert.deepEqual(a, b);
    const checkpoints = wrongGateCheckpoints(baselines[0].result);
    for (const current of [first, second]) {
        const singles = a.filter(entry => entry.injection?.step === current.index && entry.injection.disturbances.length === 1);
        assert.equal(singles.length, applicableDisturbances(current, current.index ? first : undefined, checkpoints.includes(current.index)).length);
    }
    assert.ok(a.some(entry => entry.injection!.disturbances.length >= 2));
    assert.notDeepEqual(a, buildSweepScenarios(baselines, 43));
    const effectCommand = { ...first, command: 'node garda.js next-step T-1 --effect-plan-sha256 abc', exitCode: 0 };
    assert.ok(applicableDisturbances(second, effectCommand).some(entry => entry.kind === 'repeat-last'));
});

test('a reset re-entry scope includes the task and combined edit paths, not arbitrary artifacts', () => {
    const scenario: WalkScenario = { id: 'fixture', edits: [{ path: 'src/app.ts', append: 'x' }], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'fixture', step: 2, gate: 'compile-gate', disturbances: [
            { kind: 'reset-task' }, { kind: 'edit-production' }, { kind: 'edit-test' }, { kind: 'change-criteria' },
            { kind: 'corrupt-artifact', artifact: { kind: 'preflight', path: 'runtime/T-WALK-preflight.json' } }
        ] } };
    assert.deepEqual(resetPlannedFiles(scenario), ['src/app.ts', 'tests/app.test.ts']);
});

test('only a completed reset or an already-empty TODO task counts as reset', () => {
    assert.equal(isCompletedSweepReset('RESET_COMPLETE\nTaskId: T-WALK'), true);
    const empty = 'ALREADY_RESET\nTaskId: T-WALK\nPreviousStatus: TODO\nTargetStatus: TODO\nNote: Task already TODO with no remaining artifacts.';
    assert.equal(isCompletedSweepReset(empty), true);
    assert.equal(isCompletedSweepReset(empty.replace('PreviousStatus: TODO', 'PreviousStatus: IN_PROGRESS')), false);
    assert.equal(isCompletedSweepReset(empty.replace('no remaining artifacts', 'remaining artifacts')), false);
    assert.equal(isCompletedSweepReset('TASK_RESET_DISABLED\nTargetStatus: TODO'), false);
    assert.equal(isCompletedSweepReset('DRY_RUN\nTargetStatus: TODO'), false);
});

test('wrong gates run at each checkpoint as singles without changing other sweep variants', () => {
    const gates = ['implementation', 'quality-checklist', 'record-review-result', 'record-review-result', 'completion-gate', null];
    const steps = gates.map((gate, index) => ({ ...step(index), gate, status: gate ? 'BLOCKED' : 'DONE', route: gate ? 'BLOCKED/' + gate : 'DONE/(done)' }));
    steps[1].reads = [{ path: 'bundle/runtime/T-preflight.json', kind: 'preflight' }];
    const baseline: WalkResult = { ...result(steps), reviewsByLane: { code: 1, test: 1 },
        events: ['IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED', 'REVIEW_RECORDED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED'].map(type => ({ type, details: {} })) };
    const scenario: WalkScenario = { id: 'fixture', edits: [], expectedReviews: {}, expectedModes: [] };
    assert.deepEqual(wrongGateCheckpoints(baseline), [0, 2, 4]);
    const sweep = buildSweepScenarios([{ scenario, result: baseline }], 42);
    const wrong = sweep.filter(entry => entry.injection!.disturbances.some(item => item.kind === 'wrong-gate'));
    assert.equal(wrong.length, 5 + 5 + 4, 'Every wrong gate except the named one at each checkpoint');
    assert.ok(!wrong.some(entry => entry.injection!.step === 4 && entry.injection!.disturbances[0].kind === 'wrong-gate'
        && entry.injection!.disturbances[0].gate === 'completion-gate'), 'The named gate is not a wrong gate');
    assert.ok(wrong.every(entry => entry.injection!.disturbances.length === 1), 'Wrong gates are never combined');
    assert.ok(!wrong.some(entry => [1, 3].includes(entry.injection!.step)), 'Only checkpoints get wrong gates');
    assert.deepEqual(wrong.find(entry => entry.injection!.step === 2)?.injection!.undisturbed,
        { reviews: { code: 1, test: 1 }, milestones: ['COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED'],
            restarts: {}, returnRoutes: ['BLOCKED/record-review-result'] });
    const early = wrong.find(entry => entry.injection!.step === 2 && entry.injection!.disturbances[0].kind === 'wrong-gate'
        && entry.injection!.disturbances[0].gate === 'completion-gate');
    assert.deepEqual(early?.injection!.undisturbed?.returnRoutes, ['BLOCKED/record-review-result', 'DONE/(done)'],
        'Early legitimate work may advance to the step the baseline reaches after that gate');
    assert.ok(sweep.filter(entry => !wrong.includes(entry)).every(entry => !entry.injection!.undisturbed));
    // The same steps without checkpoint gates produce exactly the other variants, combinations and IDs included.
    const plain = buildSweepScenarios([{ scenario, result: { ...baseline, steps: steps.map(item => ({ ...item, gate: item.gate && 'other-gate' })) } }], 42);
    assert.deepEqual(sweep.filter(entry => !wrong.includes(entry)).map(entry => [entry.id, entry.injection!.disturbances]),
        plain.map(entry => [entry.id, entry.injection!.disturbances]));
    assert.ok(sweepApplicability(baseline)[3].omitted.some(reason => reason.startsWith('wrong-gate: not a wrong-gate checkpoint')));
    for (const gate of WRONG_GATES) {
        const argv = wrongGateArgv(gate, { taskId: 'T-WALK', preflightPath: 'bundle/runtime/reviews/T-WALK-preflight.json',
            taskIntent: 'Change the status renderer', changedFiles: ['tests/app.test.ts', 'src/app.ts', 'src/app.ts'] });
        assert.ok(GATE_COMMANDS.includes(argv[0]) && argv[0] === gate, gate);
        assert.deepEqual(argv.slice(-2), ['--repo-root', '.']);
        assert.ok(!argv.some(value => /<[^>]+>/u.test(value)), 'No placeholder in ' + gate);
    }
    assert.deepEqual(wrongGateArgv('restart-coherent-cycle', { taskId: 'T', preflightPath: 'p', taskIntent: 'i', changedFiles: ['b', 'a', 'b'] })
        .filter((_value, index, argv) => argv[index - 1] === '--changed-file'), ['a', 'b']);
});

test('a wrong gate may refuse, but DONE after it must keep reviews and final-cycle evidence and a crash is a finding', () => {
    const events = (...types: string[]) => types.map(type => ({ type, details: {} }));
    const milestones = walkMilestones(events('IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED', 'FULL_SUITE_VALIDATION_PASSED',
        'REVIEW_RECORDED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED', 'COMPILE_GATE_PASSED'));
    assert.deepEqual(milestones, ['COMPILE_GATE_PASSED', 'FULL_SUITE_VALIDATION_PASSED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED']);
    const full = events('IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED', 'FULL_SUITE_VALIDATION_PASSED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED');
    assert.deepEqual(missingWalkMilestones(full, milestones), []);
    assert.deepEqual(missingWalkMilestones(events('IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED', 'FULL_SUITE_VALIDATION_PASSED',
        'COHERENT_CYCLE_RESTARTED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED'), milestones),
    ['COMPILE_GATE_PASSED', 'FULL_SUITE_VALIDATION_PASSED'], 'Evidence before a restart does not count');
    assert.deepEqual(missingWalkMilestones(events('COMPILE_GATE_PASSED', 'IMPLEMENTATION_STARTED', 'FULL_SUITE_VALIDATION_PASSED',
        'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED'), milestones), ['COMPILE_GATE_PASSED'], 'A compile before the implementation does not count');
    assert.deepEqual(missingWalkMilestones(events('IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED',
        'FULL_SUITE_VALIDATION_PASSED', 'COMPLETION_GATE_PASSED'), milestones), ['REVIEW_GATE_PASSED'], 'Order follows the baseline');

    const scenario: WalkScenario = { id: 'wrong', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'clean-pass', step: 0, gate: 'compile-gate', disturbances: [{ kind: 'wrong-gate', gate: 'completion-gate' }],
            undisturbed: { reviews: { code: 1, test: 1 }, milestones, restarts: { REVIEW_CYCLE_RESTARTED: 1 }, returnRoutes: ['BLOCKED/compile-gate'] } } };
    const refused = { gate: 'completion-gate', command: 'garda gate completion-gate', exitCode: 1, threw: true, uncaught: false, ms: 1,
        output: 'Error: Completion gate failed: required reviews are missing.' };
    const done: WalkResult = { ...result([{ ...step(0), wrongGate: refused }, step(1)]), reviewsByLane: { code: 1, test: 1 },
        events: [...events('REVIEW_CYCLE_RESTARTED'), ...full],
        sweep: { ...scenario.injection!, disturbances: ['wrong-gate:completion-gate'], applied: ['wrong-gate:completion-gate'] } };
    assert.deepEqual(compareWalk(scenario, done), [], 'A refusal followed by the full undisturbed work is the expected result');
    const ids = (value: WalkResult) => compareWalk(scenario, value).map(finding => finding.id);
    assert.deepEqual(ids({ ...done, reviewsByLane: { code: 1 } }), ['walk:wrong-gate-fewer-reviews:test:wrong']);
    assert.deepEqual(ids({ ...done, events: events('REVIEW_CYCLE_RESTARTED', 'IMPLEMENTATION_STARTED', 'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED') }),
        ['walk:wrong-gate-skipped:FULL_SUITE_VALIDATION_PASSED:wrong']);
    // A mistake must never cost a new review cycle, a rollback or a reset, whatever the terminal outcome.
    const blocked: WalkResult = { ...done, outcome: 'blocked', detail: 'Ask the operator to approve a new review cycle.' };
    assert.deepEqual(ids({ ...blocked, reviewsByLane: { code: 2, test: 1 } }), ['walk:operator-stop:wrong-gate:wrong', 'walk:wrong-gate-extra-reviews:code:wrong']);
    assert.deepEqual(ids({ ...done, reviewsByLane: { code: 1, test: 1, security: 1 } }), ['walk:wrong-gate-extra-reviews:security:wrong']);
    assert.deepEqual(ids({ ...blocked, events: [...done.events, ...events('COHERENT_CYCLE_RESTARTED', 'TASK_RESET')] }),
        ['walk:operator-stop:wrong-gate:wrong', 'walk:wrong-gate-restart:COHERENT_CYCLE_RESTARTED+TASK_RESET:wrong']);
    assert.deepEqual(ids({ ...done, events: [...events('REVIEW_CYCLE_RESTARTED'), ...done.events] }),
        ['walk:wrong-gate-restart:REVIEW_CYCLE_RESTARTED:wrong'], 'A restart beyond the baseline count is new');
    // Right after the wrong gate next-step must name the same step (or the step its legitimate work leads to).
    const elsewhere = { ...step(1), route: 'BLOCKED/load-rule-pack', gate: 'load-rule-pack' };
    assert.deepEqual(ids({ ...done, steps: [done.steps[0], elsewhere] }), ['walk:wrong-gate-not-returned:wrong']);
    assert.deepEqual(ids({ ...blocked, steps: [done.steps[0]] }), ['walk:operator-stop:wrong-gate:wrong', 'walk:wrong-gate-not-returned:wrong']);
    assert.deepEqual(ids({ ...done, steps: [done.steps[0], { ...step(1), reusedPrefix: true }] }), ['walk:wrong-gate-not-returned:wrong'],
        'A shared prefix step is not the navigation after the wrong gate');
    assert.deepEqual(ids({ ...done, reviewsByLane: { code: 1 }, outcome: 'blocked', detail: 'Ask the operator to approve a new review cycle.' }),
        ['walk:operator-stop:wrong-gate:wrong'], 'A wrong gate must return to the workflow without asking the operator');
    const crash = { ...refused, uncaught: true, output: "TypeError: Cannot read properties of undefined (reading 'lanes')" };
    assert.deepEqual(ids({ ...done, steps: [{ ...step(0), wrongGate: crash }, step(1)] }), ['walk:wrong-gate-crashed:completion-gate:wrong:0']);
    assert.equal(isUncaughtGateError(crash.output), true);
    assert.equal(isUncaughtGateError('Error: x\n    at y (file.ts:1:1)\nTypeError: z is not a function'), true);
    assert.equal(isUncaughtGateError(refused.output), false);
    assert.equal(isUncaughtGateError('Error: Required reviews are missing; the type error lane is not a function of this task.'), false);
});

test('artifact discovery observes descriptor readers and excludes outputs; digest names replay by their unique role', async () => {
    for (const report of ['compile-gate', 'full-suite-validation', 'doc-impact-gate', 'project-memory-impact', 'task-mode', 'rule-pack']) {
        assert.equal(artifactKind('bundle/runtime/reviews/T-WALK-' + report + '.json'), 'report', report);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-sweep-contract-'));
    const directory = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
    fs.mkdirSync(directory, { recursive: true });
    const receipt = path.join(directory, 'T-WALK-code-receipt-' + 'a'.repeat(64) + '.json');
    fs.writeFileSync(receipt, JSON.stringify({ task_id: 'T-WALK', preflight_sha256: 'c'.repeat(64) }));
    const preflight = path.join(directory, 'T-WALK-preflight.json'); fs.writeFileSync(preflight, '{}');
    try {
        const captured = await captureArtifactReads(root, async () => {
            const descriptor = fs.openSync(receipt, 'r');
            try { fs.readSync(descriptor, Buffer.alloc(10), 0, 10, 0); } finally { fs.closeSync(descriptor); }
            fs.statSync(preflight); // A cached reader's metadata dependency is still an artifact input.
            const output = path.join(directory, 'new-report.json');
            fs.writeFileSync(output, '{}'); fs.readFileSync(output);
        });
        assert.equal(captured.reads.length, 2);
        assert.equal(captured.reads[0].kind, 'receipt');
        assert.equal(captured.reads[1].kind, 'preflight');
        const fresh = receipt.replace('a'.repeat(64), 'b'.repeat(64));
        fs.renameSync(receipt, fresh);
        mutateSweepFile(root, { kind: 'stale-artifact', artifact: captured.reads[0] });
        const stale = JSON.parse(fs.readFileSync(fresh, 'utf8'));
        assert.equal(stale.task_id, 'T-WALK', 'Staleness must not become a foreign-task disturbance');
        assert.equal(stale.preflight_sha256, '0'.repeat(64));
        assert.throws(() => mutateSweepFile(root, { kind: 'delete-artifact', artifact: { kind: 'receipt', path: '../escape.json' } }), /escapes/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace evidence is stable across probes and changes when an untracked file changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-progress-'));
    fs.writeFileSync(path.join(root, 'new.ts'), 'export const value = 1;\n');
    try {
        const status = '?? new.ts\0';
        const first = walkWorkspaceFingerprint(root, status, '');
        assert.equal(walkWorkspaceFingerprint(root, status, ''), first);
        fs.appendFileSync(path.join(root, 'new.ts'), '// fixed\n');
        assert.notEqual(walkWorkspaceFingerprint(root, status, ''), first);
        assert.notEqual(walkWorkspaceFingerprint(root, status, 'tracked edit'), walkWorkspaceFingerprint(root, status, ''));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a multi-gate cycle is a loop even when it keeps appending telemetry and changing command hashes', () => {
    const guard = new WalkProgressGuard();
    for (let cycle = 0; cycle < 3; cycle++) {
        assert.equal(guard.observe('same workspace', 'build-review-context', 'code', 'build-review-context'), false);
        assert.equal(guard.observe('same workspace', 'required-reviews-check', '', 'required-reviews-check'), false);
    }
    assert.equal(guard.observe('same workspace', 'build-review-context', 'code', 'build-review-context'), true);
    assert.equal(guard.observe('changed workspace', 'build-review-context', 'code', 'build-review-context'), false);
    assert.equal(guard.observe('same workspace', 'build-review-context', 'test', 'build-review-context'), false);
});

test('one approved policy adoption permits refresh while repeated adoptions and recovery cycles still loop', () => {
    const guard = new WalkProgressGuard(1), digest = 'a'.repeat(64);
    const visit = (task = 'T-1') => guard.observe('same workspace', 'quality-checklist', '', 'quality-checklist', task);
    assert.equal(visit(), false);
    assert.equal(visit('T-2'), false);
    guard.adoptReviewPolicy('T-1', digest);
    assert.equal(visit(), false, 'the approved policy needs one new checklist cycle');
    assert.equal(visit('T-2'), true, 'another task gains no refresh allowance');
    guard.adoptReviewPolicy('T-1', digest);
    assert.equal(visit(), true, 'repeating the same approval cannot hide a loop');
    assert.throws(() => guard.adoptReviewPolicy('T-1', 'unapproved'), /approved policy digest/u);
});

test('a refusal must name an action, not merely mention an operator or an artifact', () => {
    assert.equal(hasHumanRecovery('Operator unavailable; task artifact is missing.'), false);
    assert.equal(hasHumanRecovery('The task reset configuration is disabled.'), false);
    assert.equal(hasHumanRecovery('Evidence is corrupt. Restore the task artifact from its authenticated source.'), true);
    assert.equal(hasHumanRecovery('Task reset is disabled. Run garda workflow set --task-reset-enabled true after operator confirmation.'), true);
    assert.equal(hasHumanRecovery('Run garda gate invented-repair --task-id T-1.'), false);
    assert.equal(hasHumanRecovery('COMPILE_GATE_FAILED. Run next-step.'), false);
    assert.equal(hasHumanRecovery('No operator confirmation is required. Run next-step.'), false);
    assert.equal(hasHumanRecovery('Operator approval is not required. Run next-step.'), false);
    assert.equal(hasHumanRecovery('Prior operator approval was granted. Run next-step.'), false);
    assert.equal(hasHumanRecovery('No operator task-reset is required. Run next-step.'), false);
    assert.equal(hasHumanRecovery('Preserve the task evidence. Run next-step.'), false);
    assert.equal(hasHumanRecovery('Repair the workspace. Run next-step.'), false);
    assert.equal(hasHumanRecovery('COMPILE_GATE_REFUSED. next-step routes the current cycle to \'compile-gate\'. Run garda.js next-step.', 'compile-gate'), false);
    assert.equal(hasHumanRecovery('Run garda gate build-review-context before continuing.', 'compile-gate'), false);
    assert.equal(hasHumanRecovery('Ask the operator to approve a new review cycle.'), true);
    assert.equal(hasHumanRecovery('Use the explicit operator task-reset command.'), true);
    assert.equal(hasHumanRecovery('Run garda workflow set --task-reset-enabled true --operator-confirmed yes.'), true);
    assert.equal(isActionableIntegrityRefusal('The immutable launch is already active. Complete it or record-reviewer-launch-failed before retrying.', 'prepare-reviewer-launch'), true);
    assert.equal(isActionableIntegrityRefusal('The artifact is missing. Rerun prepare-reviewer-launch.', 'prepare-reviewer-launch'), false);
    assert.equal(isActionableIntegrityRefusal("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code. Run and record those reviews first. Details: missing prompt artifact.", 'build-review-context'), true);
    assert.equal(hasHumanRecovery('Run and record those reviews first.'), false, 'A review instruction must name its actual upstream lanes');
});

test('an error word cannot excuse a thrown recovery command, while an actionable terminal refusal is accepted', () => {
    const scenario: WalkScenario = { id: 'fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'fixture', step: 0, gate: 'compile-gate', disturbances: [] } };
    const thrown = { ...step(0), threw: true, exitCode: 1, output: 'Error: Invalid missing artifact.' };
    const completed = { ...result([thrown]), sweep: { ...scenario.injection!, disturbances: [], applied: [] } };
    assert.ok(compareWalk(scenario, completed).some(finding => finding.id === 'walk:command-threw:fixture:0'));
    assert.match(String(compareWalk(scenario, completed)[0].detail.replay), /GARDA_SYNTHETIC_SEED=42/u);
    const refused: WalkResult = { ...completed, outcome: 'blocked',
        detail: 'Restore the task artifact from its authenticated source before continuing.' };
    assert.ok(compareWalk(scenario, refused).some(finding => finding.id === 'walk:command-threw:fixture:0'),
        'A later human handoff cannot excuse an earlier unactionable exception');
    const actionable: WalkResult = { ...refused, steps: [{ ...thrown, output: 'Evidence is corrupt. Restore the task artifact from its authenticated source before continuing.' }] };
    assert.deepEqual(compareWalk(scenario, actionable), []);
    const recoverable = { ...thrown, output: 'Prompt artifact is stale. Rebuild review context before launching or attesting a reviewer.' };
    assert.deepEqual(compareWalk(scenario, { ...completed, outcome: 'loop', steps: [recoverable] }).map(finding => finding.id),
        ['walk:outcome:loop:fixture'], 'An actionable refusal does not hide a loop or become a second thrown-command finding');
    const programmingError = { ...thrown, output: 'TypeError: Cannot read properties of undefined. Restore the task artifact.' };
    assert.ok(compareWalk(scenario, { ...completed, steps: [programmingError] }).some(finding => finding.id === 'walk:command-threw:fixture:0'));
    const exception: WalkResult = { ...refused, outcome: 'exception' };
    assert.ok(compareWalk(scenario, exception).some(finding => finding.id === 'walk:outcome:exception:fixture'));
    const repeated: WalkResult = { ...completed, steps: [{ ...step(0), repeatedCommand: {
        command: 'node garda.js gate compile-gate', exitCode: 1, output: 'Missing artifact.', threw: true, ms: 1
    } }] };
    assert.ok(compareWalk(scenario, repeated).some(finding => finding.id === 'walk:repeated-command-failed:fixture:0'));
});

test('native repair imperatives must identify a different registered recovery action', () => {
    assert.equal(isActionableIntegrityRefusal('Prepared launch is immutable. Record-reviewer-launch-failed before creating a new audited attempt.', 'prepare-reviewer-launch'), true);
    assert.equal(hasHumanRecovery('Record-reviewer-launch-failed before retrying.', 'record-reviewer-launch-failed'), false);
    assert.equal(hasHumanRecovery('Invented-repair before retrying.', 'prepare-reviewer-launch'), false);
    assert.equal(isActionableIntegrityRefusal('Prompt artifact is stale. Rebuild review context before launching or attesting a reviewer.', 'prepare-reviewer-launch'), true);
    assert.equal(hasHumanRecovery('Rebuild review context before retrying.', 'build-review-context'), false);
    assert.equal(hasHumanRecovery('Rebuild the artifact before retrying.'), false);
});

test('continuing past a valid refusal is a stand finding, and an uncaught exception remains a failure', () => {
    const scenario: WalkScenario = { id: 'fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'fixture', step: 0, gate: 'compile-gate', disturbances: [] } };
    const refusal = { ...step(0), exitCode: 1, threw: false, output: 'Handshake evidence missing. Ask the operator to run handshake-diagnostics before implementation gates.' };
    const loop: WalkResult = { ...result([refusal]), outcome: 'loop', sweep: { ...scenario.injection!, disturbances: [], applied: [] } };
    const findings = compareWalk(scenario, loop);
    assert.deepEqual(findings.map(finding => finding.id), ['walk:ignored-refusal:fixture']);
    assert.equal(findings[0].detail.classification, 'stand');
    assert.equal(findings[0].detail.refusalOutput, refusal.output);
    assert.ok(compareWalk(scenario, { ...loop, outcome: 'exception' }).some(finding => finding.id === 'walk:outcome:exception:fixture'));
    const selfRoute = { ...refusal, output: "compile-gate is out of order: next-step routes the current cycle to 'compile-gate'. Run next-step." };
    assert.deepEqual(compareWalk(scenario, { ...loop, steps: [selfRoute] }).map(finding => finding.id), ['walk:outcome:loop:fixture']);
    assert.deepEqual(compareWalk(scenario, { ...loop, outcome: 'blocked', detail: selfRoute.output, steps: [selfRoute] }).map(finding => finding.id),
        ['walk:outcome:blocked:fixture']);
});

test('a loop after reset with an already selected scope remains a loop finding', () => {
    const scenario: WalkScenario = { id: 'reset-loop', edits: [{ path: 'src/app.ts', append: 'x' }], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'fixture', step: 0, gate: 'classify-change', disturbances: [{ kind: 'reset-task' }] } };
    const output = 'Workspace already contained modified files before task-mode entry: src/app.ts. '
        + 'Clean/stash unrelated changes, or rerun classify-change with --use-staged or explicit --changed-file scope after entering task mode.';
    const refused = { ...step(0), gate: 'classify-change', exitCode: 1, output };
    const loop: WalkResult = { ...result([refused]), outcome: 'loop', sweep: { ...scenario.injection!, disturbances: ['reset-task'], applied: ['reset-task'] } };
    assert.deepEqual(compareWalk(scenario, loop).map(finding => finding.id),
        ['walk:operator-stop:reset-task:reset-loop', 'walk:outcome:loop:reset-loop']);
});

test('a declared artifact loss accepts only its named refusal with a concrete operator recovery', () => {
    const scenario: WalkScenario = { id: 'fixture', edits: [], expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Delete the startup artifact after its native gate passed.',
        expectedBlockedGate: 'classify-change', expectedGuidance: /reset the task \(garda gate task-reset\), then enter it again/u };
    const refusal = { ...step(0), gate: 'classify-change', status: 'BLOCKED', exitCode: 1,
        output: 'Ask the operator to preserve the task evidence and source work, reset the task (garda gate task-reset), then enter it again.' };
    assert.equal(isExpectedWalkRefusal(scenario, refusal), true);
    for (const other of [
        { ...refusal, exitCode: 0 }, { ...refusal, status: 'READY' }, { ...refusal, gate: 'compile-gate' },
        { ...refusal, output: 'Invalid JSON. Run classify-change again.' }
    ]) assert.equal(isExpectedWalkRefusal(scenario, other), false);
    assert.equal(isExpectedWalkRefusal({ ...scenario, disturbanceReason: undefined }, refusal), false);
    assert.equal(isExpectedWalkRefusal({ ...scenario, expectedGuidance: /invalid JSON/u }, refusal), false);
});

test('a stale effect plan may name read-only inspection, while repeating rejected execution stays a failure', () => {
    const scenario: WalkScenario = { id: 'fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'fixture', step: 0, gate: 'compile-gate', disturbances: [] } };
    const output = 'Next-step effect plan is stale: expected old, found <none>. Rerun next-step inspection.';
    const repeated = { command: 'node garda.js gate next-step --execute-effects --effect-plan-sha256 "old"', exitCode: 1, output, threw: true, ms: 1 };
    const completed: WalkResult = { ...result([{ ...step(0), repeatedCommand: repeated }]), sweep: { ...scenario.injection!, disturbances: [], applied: [] } };
    assert.deepEqual(compareWalk(scenario, completed), []);
    for (const rejected of [
        { ...repeated, command: 'node garda.js gate next-step' },
        { ...repeated, output: 'Next-step effect plan is stale: expected old. Rerun next-step --execute-effects.' }
    ]) {
        assert.ok(compareWalk(scenario, { ...completed, steps: [{ ...step(0), repeatedCommand: rejected }] })
            .some(finding => finding.id === 'walk:repeated-command-failed:fixture:0'));
    }
});

test('a repeated gate may end in the out-of-order refusal only for itself and only when it changed nothing', () => {
    const scenario: WalkScenario = { id: 'fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'fixture', step: 0, gate: 'compile-gate', disturbances: [] } };
    const route = { nextGate: 'full-suite-validation', status: 'BLOCKED', lane: '', commands: [],
        navigatorCommand: 'node garda-agent-orchestrator/bin/garda.js next-step --task-id "T-WALK" --repo-root "."' };
    const output = ['COMPILE_GATE_REFUSED', 'TaskId: T-WALK', formatOutOfOrderRefusal('compile-gate', 'T-WALK', route,
        'The current compile pass is still valid; compiling again would invalidate the full-suite and review evidence bound to it.')].join('\n');
    assert.equal(isOutOfOrderRefusal(output, 'compile-gate'), true);
    assert.equal(isOutOfOrderRefusal(output, 'build-review-context'), false, 'The refusal must name the gate that ran');
    assert.equal(isOutOfOrderRefusal(output.replace('COMPILE_GATE_REFUSED\n', ''), 'compile-gate'), false);
    assert.equal(isOutOfOrderRefusal(output.replace('Nothing was changed. ', ''), 'compile-gate'), false);
    assert.equal(isOutOfOrderRefusal(output.replace(/: node garda[^\n]*$/u, '.').replace('Run next-step and follow the gate it names', 'Retry'), 'compile-gate'), false);
    const lane = formatOutOfOrderRefusal('build-review-context', 'T-WALK', { ...route, nextGate: 'record-review-routing', lane: 'test' }, 'In progress.');
    assert.equal(isOutOfOrderRefusal(['REVIEW_CONTEXT_REFUSED', lane].join('\n'), 'build-review-context'), true);
    const repeated = { command: 'node garda.js gate compile-gate --task-id "T-WALK"', exitCode: 1, output, ms: 1, stateUnchanged: true };
    const completed: WalkResult = { ...result([{ ...step(0), repeatedCommand: repeated }]), sweep: { ...scenario.injection!, disturbances: [], applied: [] } };
    assert.deepEqual(compareWalk(scenario, completed), []);
    for (const rejected of [{ ...repeated, stateUnchanged: false }, { ...repeated, stateUnchanged: undefined },
        { ...repeated, command: 'node garda.js gate build-review-context --review-type "code"' }]) {
        assert.ok(compareWalk(scenario, { ...completed, steps: [{ ...step(0), repeatedCommand: rejected }] })
            .some(finding => finding.id === 'walk:repeated-command-failed:fixture:0'), JSON.stringify(rejected.stateUnchanged));
    }
});

test('post-DONE isolation is an explicit human handoff, without authorizing a stale lifecycle command', () => {
    const reason = 'Post-DONE workspace drift detected. Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task with operator confirmation.';
    assert.equal(hasHumanRecovery(reason), true);
    assert.equal(hasHumanRecovery('Post-DONE drift detected. Rerun completion-gate.', 'completion-gate'), false);
    const scenario: WalkScenario = { id: 'fixture', edits: [], expectedReviews: {}, expectedModes: [],
        injection: { seed: 42, baseline: 'fixture', step: 0, gate: 'post-done-drift', disturbances: [] } };
    const legacy: WalkResult = { ...result([{ ...step(0), gate: 'post-done-drift', command: null, reason }]), outcome: 'agent_stuck',
        sweep: { ...scenario.injection!, disturbances: [], applied: [] } };
    assert.deepEqual(compareWalk(scenario, legacy).map(finding => finding.id), ['walk:ignored-instruction:fixture']);
    assert.deepEqual(compareWalk(scenario, { ...legacy, outcome: 'blocked', detail: reason }), []);
});

test('pre-entry scope isolation and authenticated stdin transport are concrete refusals, not same-command retries', () => {
    const entry = 'Workspace already contained modified files before task-mode entry: src/app.ts. '
        + 'Clean/stash unrelated changes, or rerun classify-change with --use-staged or explicit --changed-file scope after entering task mode.';
    assert.equal(hasHumanRecovery(entry, 'classify-change'), true);
    assert.equal(hasHumanRecovery('Workspace already contained modified files before task-mode entry: src/app.ts. Rerun classify-change.', 'classify-change'), false);
    const timing = "Review output path-mode timing is impossible for 'code'. "
        + 'Safe recovery: rerun record-review-result by piping the same delegated reviewer output through stdin after delegation evidence exists. '
        + 'node garda.js gate record-review-result --review-output-stdin';
    assert.equal(hasHumanRecovery(timing, 'record-review-result'), false, 'A runnable recovery is not a human handoff');
    assert.equal(hasHumanRecovery(timing.replace('--review-output-stdin', '--review-output-path old.json'), 'record-review-result'), false);
    assert.equal(hasHumanRecovery('Review output path-mode timing is impossible. Rerun record-review-result.', 'record-review-result'), false);
    assert.equal(isActionableIntegrityRefusal('REVIEW_GATE_FAILED\nRecovery after REVIEW_GATE_PASSED: run next-step to continue closing.', 'required-reviews-check'), true);
    assert.equal(isActionableIntegrityRefusal('REVIEW_GATE_FAILED\nRecovery after REVIEW_GATE_PASSED: run required-reviews-check again.', 'required-reviews-check'), false);
    const closedCycle = "restart-review-cycle cannot continue after the current task-mode cycle already reached 'REVIEW_GATE_PASSED' in 'runtime/task-events/T-WALK.jsonl'. ";
    assert.equal(isActionableIntegrityRefusal(closedCycle + 'Run restart-coherent-cycle to begin a fresh coherent cycle from task entry before rebuilding review contexts.', 'restart-review-cycle'), true);
    assert.equal(isActionableIntegrityRefusal(closedCycle + 'Run restart-review-cycle again.', 'restart-review-cycle'), false);
});

test('checkpoint restore preserves native identities and evidence timestamps', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-checkpoint-target-'));
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-checkpoint-snapshot-'));
    fs.mkdirSync(path.join(target, 'private'));
    const file = path.join(target, 'private/evidence.json');
    fs.writeFileSync(file, '{"task_id":"T-WALK"}');
    fs.utimesSync(file, new Date(1234567890000), new Date(1234567890000));
    const same = path.join(target, 'private/snapshot.md');
    fs.writeFileSync(same, 'digest-named'); fs.utimesSync(same, new Date(1234567890000), new Date(1234567890000));
    const index = path.join(target, 'garda-agent-orchestrator/runtime/reviews/reviews-index.json');
    fs.mkdirSync(path.dirname(index), { recursive: true }); fs.writeFileSync(index, '{}');
    const before = fs.statSync(file), sameBefore = fs.statSync(same), directory = fs.statSync(path.dirname(file)), root = fs.statSync(target);
    fs.cpSync(target, snapshot, { recursive: true, preserveTimestamps: true });
    fs.writeFileSync(file, 'changed'); fs.writeFileSync(path.join(target, 'extra.json'), 'extra');
    fs.writeFileSync(index, '{"later":true}');
    // An earlier variant rewrote identical bytes later; the next variant must not inherit that mtime.
    fs.writeFileSync(same, 'digest-named'); fs.utimesSync(same, new Date(1234567990000), new Date(1234567990000));
    try {
        restoreWalkCheckpoint(snapshot, target);
        assert.equal(fs.statSync(target).ino, root.ino);
        assert.equal(fs.statSync(path.dirname(file)).ino, directory.ino);
        assert.equal(fs.statSync(file).ino, before.ino);
        assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
        assert.equal(fs.statSync(same).ino, sameBefore.ino);
        assert.equal(fs.statSync(same).mtimeMs, sameBefore.mtimeMs);
        assert.equal(fs.readFileSync(index, 'utf8'), '{}');
        assert.equal(fs.readFileSync(file, 'utf8'), '{"task_id":"T-WALK"}');
        assert.equal(fs.existsSync(path.join(target, 'extra.json')), false);
    } finally {
        fs.rmSync(target, { recursive: true, force: true });
        fs.rmSync(snapshot, { recursive: true, force: true });
    }
});

test('gate output capture cannot swallow an earlier failed Node test or change the reported test count', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-output-'));
    const fixture = path.join(root, 'capture.test.cjs');
    fs.writeFileSync(fixture, [
        "const test = require('node:test'); const assert = require('node:assert/strict');",
        'const { captureWalkOutput } = require(' + JSON.stringify(require.resolve('../synthetic/engine/walk-output')) + ');',
        "test('early failure remains visible', () => assert.fail('sentinel failure'));",
        "test('gate capture overlaps reporting', async () => captureWalkOutput([], () => new Promise(resolve => setTimeout(resolve, 25))));"
    ].join('\n'));
    try {
        const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
        const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fixture], { encoding: 'utf8', env, windowsHide: true });
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.match(run.stdout, /not ok 1 - early failure remains visible/u);
        assert.match(run.stdout, /# tests 2/u);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('gate output capture retains text and buffer errors and restores streams on rejection', async () => {
    const original = process.stderr.write, captured: string[] = [];
    await assert.rejects(captureWalkOutput(captured, async () => {
        console.error('gate error'); process.stderr.write(Buffer.from('buffer detail'));
        throw new Error('recovery command threw');
    }), /recovery command threw/u);
    assert.deepEqual(captured, ['gate error', 'buffer detail']);
    assert.equal(process.stderr.write, original);
});

test('a run without walk variables walks only the sample; full and sweep need an explicit request', () => {
    const ids = WALK_SCENARIOS.map(entry => entry.id);
    const discovery = walkRunPlan({}, ids);
    assert.equal(discovery.level, 'sample');
    assert.deepEqual(discovery.scenarioIds, [...SAMPLE_WALK_SCENARIOS]);
    assert.equal(discovery.runSweep, false);
    assert.ok(discovery.timeoutMs <= 1_800_000, 'A normal run must stay inside a shard budget');
    // Deep stack-review families rotate by seed and run only at the sweep level.
    assert.deepEqual(walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'full' }, ids).scenarioIds, ids.filter(id => !id.startsWith('deep-stack-')));
    assert.equal(walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'sweep' }, ids).runSweep, true);
    assert.deepEqual(walkRunPlan({ GARDA_SYNTHETIC_WALK_ONLY: 'document-only' }, ids).scenarioIds, ['document-only']);
    assert.equal(walkRunPlan({ GARDA_SYNTHETIC_WALK_ONLY: 'sweep-clean-pass-s1-dabc-seed1' }, ids).runSweep, true);
    const wrongGates = walkRunPlan({ GARDA_SYNTHETIC_WALK_DISTURBANCE: 'wrong-gate' }, ids);
    assert.deepEqual([wrongGates.disturbance, wrongGates.scenarioIds, wrongGates.runSweep], ['wrong-gate', [], true]);
    const combined = walkRunPlan({ GARDA_SYNTHETIC_WALK_DISTURBANCE: 'edit-production,change-criteria' }, ids);
    assert.equal(combined.disturbance, 'edit-production,change-criteria');
    assert.equal(matchesDisturbanceSelection(combined.disturbance, ['stale-lock', 'change-criteria']), true);
    assert.equal(matchesDisturbanceSelection(combined.disturbance, ['reset-task']), false);
    assert.equal(matchesDisturbanceSelection(null, ['reset-task']), true);
    assert.throws(() => walkRunPlan({ GARDA_SYNTHETIC_WALK_DISTURBANCE: 'edit-production,' }, ids), /Invalid GARDA_SYNTHETIC_WALK_DISTURBANCE/u);
    assert.equal(discovery.disturbance, null);
    assert.throws(() => walkRunPlan({ GARDA_SYNTHETIC_WALK_DISTURBANCE: 'Wrong Gate' }, ids), /Invalid GARDA_SYNTHETIC_WALK_DISTURBANCE/u);
    assert.throws(() => walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'everything' }, ids), /Invalid GARDA_SYNTHETIC_WALK_LEVEL/u);
    assert.throws(() => walkRunPlan({ GARDA_SYNTHETIC_WALK_ONLY: 'no-such-scenario' }, ids), /Unknown scenario selection/u);
    assert.throws(() => walkRunPlan({ GARDA_SYNTHETIC_WALK_JOBS: '25' }, ids), /1\.\.24/u);
    for (const id of SAMPLE_WALK_SCENARIOS) assert.ok(ids.includes(id), id);
});

test('provider placeholders are filled in both the PowerShell and the POSIX shell form', () => {
    // Linux CI has no provider marker, so next-step prints the POSIX environment reference.
    assert.equal(usesPowerShellEnvironmentSyntax({}, 'win32'), true);
    assert.equal(usesPowerShellEnvironmentSyntax({}, 'linux'), false);
    const command = (provider: string) => 'node garda.js gate enter-task-mode --task-id "T-WALK" --provider ' + provider + ' --repo-root "."';
    for (const placeholder of ['"$env:GARDA_EXECUTION_PROVIDER"', '"$GARDA_EXECUTION_PROVIDER"', quoteProviderForCommand(null)]) {
        assert.equal(fillProviderValues(command(placeholder), 'walk-task-0', ['src/app.ts']), command('"' + WALK_PROVIDER + '"'), placeholder);
    }
    assert.equal(fillProviderValues(command('"Claude"'), 'walk-task-0', []), command('"Claude"'));
});


test('a consumed built-in disturbance stays reported outside ordinary work calibration', () => {
    const scenario = WALK_SCENARIOS.find(entry => entry.id === 'post-done-document-drift')!;
    assert.ok(scenario);
    assert.match(scenarioDisturbanceLabels(scenario).join(' '), /after-done-edit/u);
    assert.deepEqual(scenarioDisturbanceLabels({ ...scenario, disturbances: [], disturbanceReason: 'explicit injected loss' }), ['explicit injected loss']);
    assert.deepEqual(scenarioDisturbanceLabels({ ...scenario, disturbances: [], disturbanceReason: undefined }), []);
});

test('unreadable event diagnostics preserve a native refusal but cannot admit calibration or certify DONE', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-event-read-'));
    try {
        const file = path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-WALK.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ event_type: 'SKILL_SELECTED' }) + '\n{broken\n');
        const inspected = inspectWalkTaskEvents(root);
        assert.ok(inspected.error);
        assert.deepEqual(inspected.events, []);
        assert.equal(admittedCounterState('optional-skill-activation', inspected.events), undefined);
        const scenario: WalkScenario = { id: 'event-read', edits: [], expectedReviews: {}, expectedModes: [],
            expectedBlockedGate: 'task-events-summary', expectedGuidance: /repair original timeline/u };
        const result: WalkResult = { scenarioId: scenario.id, outcome: 'blocked', detail: 'repair original timeline',
            eventReadError: inspected.error, events: [], reviews: [], reviewsByLane: {}, steps: [{
                index: 0, gate: 'task-events-summary', status: 'BLOCKED', command: null, reason: 'repair original timeline',
                navigatorMs: 0, commandMs: 0, exitCode: null, output: '', taskEvents: 0, workspaceSha256: '', measurement: null,
                eventReadError: inspected.error
            }] };
        assert.deepEqual(compareWalk(scenario, result), []);
        assert.ok(compareWalk({ ...scenario, expectedBlockedGate: undefined }, { ...result, outcome: 'done' })
            .some(finding => finding.id === 'walk:accepted-corrupt-events:event-read'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('effect reinspection requires the native typed refusal and still retains failed-step diagnostics', () => {
    const { NextStepEffectPlanStaleError } = require('../../../src/gates/next-step/next-step-effects') as typeof import('../../../src/gates/next-step/next-step-effects');
    assert.equal(isWalkEffectReinspection(new NextStepEffectPlanStaleError('Rerun next-step inspection.')), true);
    assert.equal(isWalkEffectReinspection(new Error('Rerun next-step inspection.')), false);
    assert.equal(isWalkEffectReinspection('NextStepEffectPlanStaleError'), false);
});

test('unchanged work in different children has distinct progress, while returning to a stalled child still fails', () => {
    const guard = new WalkProgressGuard(1);
    assert.equal(guard.observe('same', 'implementation', '', 'instruction', 'T-CHILD-1'), false);
    assert.equal(guard.observe('same', 'implementation', '', 'instruction', 'T-CHILD-2'), false);
    assert.equal(guard.observe('same', 'implementation', '', 'instruction', 'T-CHILD-1'), true);
});

test('invalid JSON is an integrity refusal only with a concrete different recovery action', () => {
    assert.equal(isActionableIntegrityRefusal("Task-mode evidence is invalid JSON at 'T-1-task-mode.json'. Preserve the evidence and ask the operator to reset the task, then enter it again.", 'enter-task-mode'), true);
    assert.equal(isActionableIntegrityRefusal("Task-mode evidence is invalid JSON at 'T-1-task-mode.json'.", 'enter-task-mode'), false);
    assert.equal(isActionableIntegrityRefusal("Task-mode evidence is invalid JSON at 'T-1-task-mode.json'. Rerun enter-task-mode.", 'enter-task-mode'), false);
});
