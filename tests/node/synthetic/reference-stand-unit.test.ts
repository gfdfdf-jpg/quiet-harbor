import { admittedCounterState, type WalkResult } from './engine/navigator-walk';
import { analyzeWalkMetrics, counterBudgets, workCounters, type CounterBaseline } from './engine/walk-metrics';
import './engine/walk-route-observer';
import { canonicalizeTempRoot, installRootChainProbes, REFERENCE_ROOT_CHAIN_DIRECTORIES, rootChainProbes } from './engine/walk-root-chain';
import { spawnSync } from 'node:child_process';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { readInvocationFileContent } from '../../../src/core/invocation-file-observation';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acceptStandBaseline, expectationManifest, fileDigest, inspectBaselinePolicy } from './engine/stand-baselines';
import { buildStandSummary, renderStandSummary, type SummaryInput } from './engine/stand-summary';
import { checkpointInputs, compareTiming, measureCheckpoint, timingCheckpointMatches, timingDistribution, unexpectedMutations, type TimingEnvironment, type TimingManifest } from './engine/step-timing';
import { assertWalkResumeIdentity, atomicWalkJson, walkHash } from './engine/walk-run-store';
import { walkRunPlan } from './engine/walk-plan';
import type { WalkReport } from './engine/walk-report';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { configureTimingSession, finishTimingSession, sampleTimingCheckpoint, type TimingBaseline, type TimingReport } from './engine/step-timing-session';
import { TIMING_PROTOCOL, type TimingRow } from './engine/step-timing';
import { contractSelections } from './engine/stand-contract';

const data = path.resolve('tests/node/synthetic');
const manifest = JSON.parse(fs.readFileSync(path.join(data, 'step-timing-manifest.json'), 'utf8')) as TimingManifest;
function temporary(run: (root: string) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-reference-unit-'));
    try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function summaryInput(): SummaryInput {
    return { level: 'short', final: true, partial: false, baselineProblems: [], timingRequested: false,
        checks: ['walk', 'contract', 'fixture-contract', 'economy', 'policy-reuse'].map(id => ({ id, status: 'PASS', log: id + '.log' })),
        walk: { findings: [], anomalies: [], scenarios: [], coverage: {}, economy: {}, executedSteps: 0 } as unknown as WalkReport };
}
test('short and legacy sample select identical representative walks; full stays explicit', () => {
    const ids = ['clean-pass', 'test-failed-fixed-in-source', 'stack-unknown-quartz-a7-generic-gate-tour', 'stack-polyglot-maven-ts-a3-generic', 'extra'];
    assert.deepEqual(walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'short' }, ids), walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'sample' }, ids));
    assert.equal(walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'full' }, ids).scenarioIds.length, 5);
});
test('contract parts select each case once without matching the file ancestor, and include future literal cases', () => {
    const source = fs.readFileSync(path.resolve('tests/node/policy/stack-universal-gates-contract.test.ts'), 'utf8');
    const parts = contractSelections(source + "\ntest('future literal contract case', () => {});\n");
    for (const name of ['unknown stack literal selection, native execution and consumers (rename=false)',
        'integrity refusal: chronology', 'universal-fallbacks dependency: complete opaque gate tour (rename=false)',
        'universal-fallbacks dependency: complete opaque gate tour (rename=true)', 'future literal contract case']) {
        assert.equal(parts.filter(part => new RegExp(part.pattern, 'u').test(name)).length, 1, name);
    }
    assert.ok(parts.every(part => !new RegExp(part.pattern, 'u').test('tests/node/policy/stack-universal-gates-contract.test.js')));
    assert.ok(!new RegExp(parts[0].pattern, 'u').test('universal-fallbacks dependency: complete opaque gate tour (rename=true)'));
});
test('every timing checkpoint names an executable scenario and every required family has a checkpoint', () => {
    assert.equal(new Set(manifest.checkpoints.map(checkpoint => checkpoint.key)).size, manifest.checkpoints.length);
    for (const checkpoint of manifest.checkpoints) assert.ok(WALK_SCENARIOS.some(scenario => scenario.id === checkpoint.scenario), checkpoint.scenario);
    for (const family of [...manifest.required_families, 'quality-cadence', 'polyglot-invocation-2']) {
        assert.ok(manifest.checkpoints.some(checkpoint => checkpoint.key.startsWith(family + '/')), family);
    }
});
test('short permits inconclusive timing while full and measured timing failures stay red', () => {
    const running = buildStandSummary({ ...summaryInput(), final: false, walk: undefined });
    assert.equal(running.state, 'running');
    assert.ok(Object.values(running.pillars).every(pillar => pillar.verdict === 'FAIL'));
    const report = buildStandSummary(summaryInput());
    assert.equal(report.pillars.navigator_correctness.verdict, 'PASS');
    assert.equal(report.pillars.stack_independence.verdict, 'PASS');
    assert.equal(report.pillars.review_logic.verdict, 'PASS');
    assert.equal(report.pillars.speed.verdict, 'PASS');
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.speed.step_timing, 'INCONCLUSIVE');
    const busy = buildStandSummary({ ...summaryInput(), timingRequested: true,
        quiet: { quiet: false, duration_ms: 30000, host_cpu_percent: 40, heavy_processes: ['node'], reasons: ['machine busy'] } });
    assert.match(renderStandSummary(busy), /machine busy/u);
    assert.equal(busy.verdict, 'PASS');
    assert.equal(busy.pillars.speed.assessment, 'INCONCLUSIVE');
    for (const level of ['full', 'sweep']) {
        assert.equal(buildStandSummary({ ...summaryInput(), level }).pillars.speed.verdict, 'FAIL');
    }
    for (const verdict of ['FAIL', 'UNBASELINED', 'INCOMPLETE'] as const) {
        assert.equal(buildStandSummary({ ...summaryInput(), timing: { verdict } as TimingReport }).verdict, 'FAIL');
    }
});
test('counter failures and known review findings remain failures in the consolidated report', () => {
    // Oracle inputs, not fabricated lifecycle evidence: removing budget enforcement must make this test red.
    const fixture = (growing: boolean): WalkResult => ({ scenarioId: 'unit-budget-control', steps: [0, 100, 200].map((taskEvents, index) => ({
        index, taskEvents, route: 'READY/unit', gate: 'unit', status: 'READY', command: 'node garda gate unit', navigatorMs: 1,
        measurement: { work: { timeline_parse: growing ? index + 1 : 1 }, io: {}, phases_ms: {} }
    })) } as unknown as WalkResult);
    const baseline: CounterBaseline = { schema: 1, provenance: 'Independent unit negative controls', routes: { 'READY/unit': {
        timeline_parse: { expected: 10, tolerance: 0, constantWithEvents: true, growthTolerance: 0 }
    } } };
    assert.deepEqual(analyzeWalkMetrics([fixture(false)], baseline, false).anomalies, []);
    assert.ok(analyzeWalkMetrics([fixture(true)], baseline, false).anomalies.some(item => item.kind === 'counter-growth' && item.severity === 'failure'));
    baseline.routes['READY/unit'].timeline_parse.expected = 1;
    assert.ok(analyzeWalkMetrics([fixture(true)], baseline, false).anomalies.some(item => item.kind === 'counter-budget' && item.severity === 'failure'));
    baseline.routes = {};
    assert.ok(analyzeWalkMetrics([fixture(false)], baseline, false).anomalies.some(item => item.kind === 'missing-baseline'));
    const input = summaryInput();
    input.walk!.anomalies = [{ severity: 'failure', kind: 'counter-budget', route: 'READY/test', metric: 'timeline_parse', observed: 2, limit: 1 } as WalkReport['anomalies'][number]];
    input.walk!.findings = [{ id: 'walk:reviews:1->2:code:example', layer: 'walk', kind: 'economy', summary: 'extra review', detail: {} }];
    const report = buildStandSummary(input);
    assert.equal(report.pillars.speed.assessment, 'FAIL');
    assert.equal(report.pillars.review_logic.verdict, 'FAIL');
    assert.match(renderStandSummary(report), /timeline_parse=2 > 1/u);
});
test('nearest-rank p95, even median and relative/absolute growth limits are exact', () => {
    assert.deepEqual(timingDistribution(Array.from({ length: 100 }, (_, index) => index + 1)), { median_ms: 50.5, p95_ms: 95 });
    const limits = manifest.limits;
    assert.equal(compareTiming({ median_ms: 120, p95_ms: 150 }, { median_ms: 100, p95_ms: 100 }, limits).verdict, 'PASS');
    assert.equal(compareTiming({ median_ms: 120.001, p95_ms: 150 }, { median_ms: 100, p95_ms: 100 }, limits).verdict, 'FAIL');
    assert.equal(compareTiming({ median_ms: 0, p95_ms: 0 }, { median_ms: 0, p95_ms: 0 }, limits).median.delta_percent, null);
    assert.equal(compareTiming({ median_ms: 1100, p95_ms: 1150.01 }, { median_ms: 1000, p95_ms: 1000 }, limits).p95.verdict, 'FAIL');
    assert.throws(() => timingDistribution([NaN]), /Invalid/u);
});
test('a failed-execution checkpoint cannot be covered by the earlier initial selection', () => {
    const checkpoint = { ...manifest.checkpoints[0], scenario: 'opaque', next_gate: 'task-test-selection', require_prior: [{ gate: 'full-suite-validation', failed: true }] };
    const result = { next_gate: 'task-test-selection', status: 'BLOCKED', reason: 'select' };
    assert.equal(timingCheckpointMatches(checkpoint, 'opaque', result, []), false);
    assert.equal(timingCheckpointMatches(checkpoint, 'opaque', result, [{ gate: 'full-suite-validation', exitCode: 0, command: 'run' }]), false);
    assert.equal(timingCheckpointMatches(checkpoint, 'opaque', result, [{ gate: 'full-suite-validation', exitCode: 1, command: 'run' }]), true);
    const repair = { ...checkpoint, require_prior: [{ gate: 'quality-checklist' }] };
    assert.equal(timingCheckpointMatches(repair, 'opaque', result, [{ gate: 'quality-checklist', exitCode: null, command: null }]), false);
    assert.equal(timingCheckpointMatches(repair, 'opaque', result, [{ gate: 'quality-checklist', exitCode: 0, command: 'gate quality-checklist' }]), true);
});
test('the timing boundary executes five warmups and retains all 100 calls; a mutation invalidates the entire series', () => temporary(root => {
    const fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture); fs.writeFileSync(path.join(fixture, 'target.case'), 'assert behavior\n');
    const expected = { gate: 'selection', command: 'task command' };
    let calls = 0;
    const options = { checkpoint: manifest.checkpoints[0], manifest, root: fixture, identity: (value: typeof expected) => value,
        expected, counters: {}, environment: { power_plan: 'unit-protocol-check' } as TimingEnvironment, output: path.join(root, 'output') };
    const row = measureCheckpoint({ ...options, resolve: () => { calls++; return expected; } });
    assert.equal(calls, 105); assert.equal(row.samples_ms.length, 100);
    // Monitoring is real and the machine is unreserved: this is a protocol unit, never a performance acceptance.
    assert.notEqual(row.verdict, 'PASS');
    const invalid = measureCheckpoint({ ...options, resolve: () => { fs.appendFileSync(path.join(fixture, 'target.case'), 'mutation\n'); return expected; } });
    assert.equal(invalid.verdict, 'INCONCLUSIVE'); assert.ok(invalid.issues.some(issue => issue.startsWith('Checkpoint mutated:')));
}));
test('checkpoint identities preserve target bytes/history and detect undeclared resolver writes', () => temporary(root => {
    const runtime = path.join(root, 'garda-agent-orchestrator/runtime'); fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(root, 'target.case'), 'assert at_utc=one\n');
    atomicWalkJson(path.join(runtime, 'entry.json'), { at_utc: 'one', targets: ['target.case'], lanes: ['code'] });
    const first = checkpointInputs(root, manifest);
    atomicWalkJson(path.join(runtime, 'entry.json'), { at_utc: 'two', targets: ['target.case'], lanes: ['code'] });
    const second = checkpointInputs(root, manifest);
    assert.deepEqual(first.semantic, second.semantic);
    assert.deepEqual(unexpectedMutations(first, second, []), ['garda-agent-orchestrator/runtime/entry.json']);
    assert.deepEqual(unexpectedMutations(first, second, ['garda-agent-orchestrator/runtime/entry.json']), []);
    fs.writeFileSync(path.join(root, 'target.case'), 'assert at_utc=two\n');
    assert.notDeepEqual(second.semantic, checkpointInputs(root, manifest).semantic);
    atomicWalkJson(path.join(runtime, 'entry.json'), { at_utc: 'two', targets: ['other.case'], lanes: ['code'] });
    assert.notDeepEqual(second.semantic, checkpointInputs(root, manifest).semantic);
}));
test('baseline edits require an explicit written decision and retain previous evidence', () => temporary(root => {
    for (const file of ['baseline-policy.json', 'walk-counter-baseline.json', 'step-timing-baseline.json', 'step-timing-manifest.json']) fs.copyFileSync(path.join(data, file), path.join(root, file));
    const target = path.join(root, 'walk-counter-baseline.json'), candidate = path.join(root, 'candidate.json');
    const original = fs.readFileSync(target, 'utf8'); fs.writeFileSync(candidate, original);
    const decision = { kind: 'counters' as const, candidate, reason: '', release: '1.4.4', sourceCommit: 'a'.repeat(40), expectedSha256: fileDigest(target) };
    assert.throws(() => acceptStandBaseline(root, decision), /written reason/u);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    const malformed = JSON.parse(original) as { routes: Record<string, unknown> };
    malformed.routes = { broken: { 'subprocess:git': { expected: 0, tolerance: null, constantWithEvents: true } } };
    fs.writeFileSync(candidate, JSON.stringify(malformed));
    assert.throws(() => acceptStandBaseline(root, { ...decision, reason: 'Malformed candidate must never disable deterministic limits.' }), /finite nonnegative/u);
    const raisedState = JSON.parse(original) as { routes: Record<string, Record<string, { expected: number; tolerance: number }>>; states: Record<string, unknown> };
    const [route, budgets] = Object.entries(raisedState.routes).find(([, values]) => Object.keys(values).some(key => key.startsWith('subprocess:')))!;
    const [counter, budget] = Object.entries(budgets).find(([key]) => key.startsWith('subprocess:'))!;
    raisedState.states['unit-new-state'] = { provenance: 'Unit negative control', routes: { [route]: { [counter]: { ...budget,
        expected: budget.expected + budget.tolerance + 1, tolerance: 0 } } } };
    fs.writeFileSync(candidate, JSON.stringify(raisedState));
    assert.throws(() => acceptStandBaseline(root, { ...decision, reason: 'A new state must not raise an inherited subprocess ceiling.' }), /Subprocess ceilings/u);
    fs.writeFileSync(candidate, original);
    const evidence = acceptStandBaseline(root, { ...decision, reason: 'Independent repeat confirms the unchanged deterministic ceiling.' });
    const receipt = JSON.parse(fs.readFileSync(evidence, 'utf8')) as { previous: unknown; reason: string };
    assert.deepEqual(receipt.previous, JSON.parse(original));
    assert.match(receipt.reason, /Independent/u);
    assert.throws(() => acceptStandBaseline(root, { ...decision, reason: 'another decision' }), /changed since review/u);
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'baseline-policy.json'), 'utf8')) as { files: Record<string, string> };
    assert.equal(policy.files['walk-counter-baseline.json'], fileDigest(target));
}));
test('an empty/unquiet timing candidate cannot be accepted; existing source expectations are sealed', () => temporary(root => {
    fs.copyFileSync(path.join(data, 'step-timing-baseline.json'), path.join(root, 'step-timing-baseline.json'));
    const target = path.join(root, 'step-timing-baseline.json');
    const attempt = () => acceptStandBaseline(root, { kind: 'timing', candidate: target, reason: 'attempt', release: '1.4.4', sourceCommit: 'a'.repeat(40), expectedSha256: fileDigest(target) });
    // Both refusals are asserted independently of where this suite runs: GitHub Actions exports GITHUB_ACTIONS=true,
    // and the CI refusal precedes the quiet-measurement refusal.
    const ci = process.env.GITHUB_ACTIONS;
    try {
        delete process.env.GITHUB_ACTIONS;
        assert.throws(attempt, /complete quiet/u);
        process.env.GITHUB_ACTIONS = 'true';
        assert.throws(attempt, /CI timing cannot supply a baseline/u);
    } finally {
        if (ci === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = ci;
    }
    assert.equal(fileDigest(target), fileDigest(path.join(data, 'step-timing-baseline.json')), 'A refused timing candidate leaves the baseline unchanged');
    assert.deepEqual(inspectBaselinePolicy(data), []);
    assert.ok(Object.keys(expectationManifest(data)).length > 20);
}));
test('resume identity refuses changed protocol, source, fixture or environment', () => {
    const original = { source: 'a', fixture: 'b', environment: 'c', protocol: { samples: 100 } };
    assert.doesNotThrow(() => assertWalkResumeIdentity(original, original));
    for (const replacement of [{ ...original, source: 'd' }, { ...original, fixture: 'd' }, { ...original, environment: 'd' }, { ...original, protocol: { samples: 99 } }]) {
        assert.throws(() => assertWalkResumeIdentity(original, replacement), /refused/u);
    }
});

test('format-only baseline decisions preserve every value and cannot accept timing measurements', () => temporary(root => {
    fs.copyFileSync(path.join(data, 'step-timing-baseline.json'), path.join(root, 'step-timing-baseline.json'));
    fs.copyFileSync(path.join(data, 'baseline-policy.json'), path.join(root, 'baseline-policy.json'));
    const target = path.join(root, 'step-timing-baseline.json'), candidate = path.join(root, 'candidate.json');
    const previous = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
    const decision = { kind: 'timing' as const, candidate, reason: 'Normalize CRLF placeholder to canonical JSON; no timing measurement accepted.',
        release: '1.4.4', sourceCommit: 'a'.repeat(40), expectedSha256: fileDigest(target), formatOnly: true };
    fs.writeFileSync(candidate, JSON.stringify({ ...previous, acceptable_for_baseline: true }));
    assert.throws(() => acceptStandBaseline(root, decision), /cannot change baseline values/u);
    assert.equal(fileDigest(target), decision.expectedSha256);
    fs.writeFileSync(candidate, JSON.stringify(previous));
    const receipt = JSON.parse(fs.readFileSync(acceptStandBaseline(root, decision), 'utf8')) as { accepted: unknown; formatOnly: boolean };
    assert.deepEqual(receipt.accepted, previous);
    assert.equal(receipt.formatOnly, true);
}));
test('timing resume preserves completed failures and invalid attempts instead of retrying until green', () => temporary(root => {
    const work = path.join(root, 'work.json'); atomicWalkJson(work, { anomalies: [] });
    const config = { output: root, manifest, environment: { power_plan: 'protocol-unit' } as TimingEnvironment,
        quiet: { quiet: true, duration_ms: 30000, host_cpu_percent: 0, heavy_processes: [], reasons: [] },
        source: { sourceCommit: 'a'.repeat(40), packageHash: 'b'.repeat(64), harnessHash: 'c'.repeat(64), release: 'unit-protocol' },
        selected: manifest.checkpoints.slice(0, 3).map(checkpoint => checkpoint.key),
        baseline: JSON.parse(fs.readFileSync(path.join(data, 'step-timing-baseline.json'), 'utf8')) as TimingBaseline, workReportPath: work };
    assert.equal(TIMING_PROTOCOL.samples, 100);
    configureTimingSession(config);
    for (const [index, checkpoint] of manifest.checkpoints.slice(0, 3).entries()) {
        const samples = index === 0 ? Array.from({ length: 100 }, () => 1000) : [];
        const rawFile = path.join(root, 'raw', index + '.json'); atomicWalkJson(rawFile, { samples_ms: samples, unit_only: true });
        const row: TimingRow = { ...checkpoint, samples_ms: samples, semantic_inputs_sha256: 'unit', raw_inputs_manifest_sha256: 'unit',
            limits: manifest.limits, verdict: index === 0 ? 'FAIL' : 'INCONCLUSIVE', issues: index === 0 ? [] : ['Checkpoint mutated'],
            counters: {}, raw_manifest: 'raw/' + index + '.json' };
        atomicWalkJson(path.join(root, 'series', walkHash(row.key) + '.json'), { row, digest: index === 2 ? 'corrupt' : walkHash(row), raw_sha256: fileDigest(rawFile) });
    }
    configureTimingSession(config);
    let calls = 0;
    const expected = { next_gate: manifest.checkpoints[0].next_gate, status: 'BLOCKED', commands: [], reason: 'unit' };
    sampleTimingCheckpoint(root, manifest.checkpoints[0].scenario, expected, () => { calls++; return expected; }, null, 'unit',
        () => { throw new Error('A completed attempt must not be measured again'); }, []);
    finishTimingSession();
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'step-timing.json'), 'utf8')) as TimingReport;
    assert.equal(calls, 0); assert.equal(saved.routes.length, 2); assert.equal(saved.routes[0].verdict, 'FAIL');
    assert.equal(saved.routes[1].samples_ms.length, 0); assert.ok(saved.missing_routes.includes(config.selected[2]));
    assert.equal(saved.acceptable_for_baseline, false);
    const baselineIdentity = saved.baseline_identity as { artifact: string; sha256: string };
    assert.equal(baselineIdentity.artifact, 'baseline.json');
    assert.equal(baselineIdentity.sha256, fileDigest(path.join(root, baselineIdentity.artifact)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, baselineIdentity.artifact), 'utf8')), config.baseline);
    assert.ok(!('routes' in baselineIdentity), 'Progress polling must not repeatedly parse all accepted raw release inputs');
}));


test('measured child input shapes inherit accepted ceilings without changing the parent', () => temporary(root => {
    for (const file of ['baseline-policy.json', 'walk-counter-baseline.json']) fs.copyFileSync(path.join(data, file), path.join(root, file));
    const target = path.join(root, 'walk-counter-baseline.json'), candidate = path.join(root, 'candidate.json');
    const before = JSON.parse(fs.readFileSync(target, 'utf8')) as CounterBaseline;
    const inherited = counterBudgets(before, 'BLOCKED/compile-gate', 'native-child-tree')!;
    const next = structuredClone(before);
    next.states!['unit-child-shape'] = { inherits: 'native-child-tree', provenance: 'Four child review lanes add bound receipts.',
        routes: { 'BLOCKED/compile-gate': { payload_reads: { expected: 1000, tolerance: 0, constantWithEvents: true } } } };
    assert.deepEqual(counterBudgets(next, 'BLOCKED/compile-gate', 'unit-child-shape')!['subprocess:icacls.exe'], inherited['subprocess:icacls.exe']);
    assert.deepEqual(before.states!['native-child-tree'], next.states!['native-child-tree']);
    const decision = { kind: 'counters' as const, candidate, reason: 'Measure new child inputs, retaining native child subprocess ceilings.',
        release: '1.4.4', sourceCommit: 'a'.repeat(40), expectedSha256: fileDigest(target) };
    const raised = structuredClone(next);
    const ceiling = inherited['subprocess:icacls.exe'];
    raised.states!['unit-child-shape'].routes['BLOCKED/compile-gate']['subprocess:icacls.exe'] = {
        ...ceiling, expected: ceiling.expected + ceiling.tolerance + 1, tolerance: 0 };
    fs.writeFileSync(candidate, JSON.stringify(raised));
    assert.throws(() => acceptStandBaseline(root, decision), /Subprocess ceilings/u);
    fs.writeFileSync(candidate, JSON.stringify(next));
    assert.ok(acceptStandBaseline(root, decision));
}));

test('counter input-shape inheritance rejects cycles and unknown parents', () => {
    const baseline: CounterBaseline = { schema: 1, provenance: 'unit', routes: {}, states: {
        child: { provenance: 'unit', inherits: 'missing', routes: {} } } };
    assert.throws(() => counterBudgets(baseline, 'route', 'child'), /Unknown counter parent/u);
    baseline.states!.child.inherits = 'child';
    assert.throws(() => counterBudgets(baseline, 'route', 'child'), /inheritance cycle/u);
});


test('new measured input profiles require native planning, four-lane preflight or parent split facts', () => {
    const entry = [{ type: 'TASK_MODE_ENTERED', details: { task_profile: 'strict', planned_source_visibility_sha256: 'a'.repeat(64) } }];
    assert.equal(admittedCounterState('stack-decomposition-planning', []), undefined);
    assert.equal(admittedCounterState('stack-decomposition-planning', entry), 'stack-decomposition-planning');
    for (const state of ['stack-four-lane-native-child-tree', 'stack-five-lane-native-child-tree']) {
        assert.equal(admittedCounterState(state, entry, 'T-WALK-1'), undefined);
        assert.equal(admittedCounterState(state, [], 'T-WALK-1', [{ type: 'STRICT_DECOMPOSITION_DECISION_RECORDED', details: {} }]), state);
        assert.equal(admittedCounterState(state, entry), undefined);
    }
    assert.equal(admittedCounterState('leaf-test-review-reuse', entry), undefined);
    assert.equal(admittedCounterState('leaf-test-review-reuse', [{ type: 'PREFLIGHT_CLASSIFIED', details: {
        required_reviews: { code: true, security: true, refactor: true, test: true } } }]), 'leaf-test-review-reuse');
    assert.equal(admittedCounterState('matrix-test-review-reuse', entry), undefined);
    assert.equal(admittedCounterState('matrix-test-review-reuse', [{ type: 'TASK_MODE_ENTERED', details: {
        task_profile: 'balanced', planned_source_visibility_sha256: 'a'.repeat(64) } }]), undefined);
    assert.equal(admittedCounterState('matrix-test-review-reuse', [{ type: 'TASK_MODE_ENTERED', details: {
        task_profile: 'balanced', planned_source_visibility_sha256: 'a'.repeat(64),
        profile_policy_snapshot_required: true, profile_policy_snapshot_hash: 'b'.repeat(64) } }]), 'matrix-test-review-reuse');
    assert.equal(admittedCounterState('matrix-test-review-reuse', [{ type: 'TASK_MODE_ENTERED', details: {
        task_profile: 'balanced', planned_source_visibility_sha256: 'a'.repeat(64),
        profile_policy_snapshot_required: true, profile_policy_snapshot_hash: 'b'.repeat(64) } },
    { type: 'PREFLIGHT_CLASSIFIED', details: { changed_files_count: 0 } }]), 'matrix-test-review-reuse');
    assert.equal(admittedCounterState('matrix-test-review-reuse', [{ type: 'PREFLIGHT_CLASSIFIED', details: {
        required_reviews: { code: true, security: true, refactor: false, test: true } } }]), undefined);
    assert.equal(admittedCounterState('matrix-test-review-reuse', [{ type: 'PREFLIGHT_CLASSIFIED', details: {
        required_reviews: { code: true, security: true, refactor: true, test: true } } }]), 'matrix-test-review-reuse');
    for (const state of ['declared-recipe-task-local-reviewed', 'declared-recipe-task-local-docs-only']) {
        assert.equal(admittedCounterState(state, entry, 'T-WALK', [], false), undefined);
        assert.equal(admittedCounterState(state, [], 'T-WALK', [], true), state);
    }
    const failure = { type: 'FULL_SUITE_VALIDATION_FAILED', details: { status: 'FAILED', exit_code: 1 } };
    const compile = { type: 'COMPILE_GATE_PASSED', details: {} };
    assert.equal(admittedCounterState('task-test-failure-repair', []), undefined);
    assert.equal(admittedCounterState('task-test-failure-repair', [failure]), undefined);
    assert.equal(admittedCounterState('task-test-failure-repair', [failure, compile]), undefined);
    assert.equal(admittedCounterState('task-test-failure-repair', [compile, failure]), 'task-test-failure-repair');
    assert.equal(admittedCounterState('task-test-failure-repair', [
        compile, { ...failure, details: { status: 'PASSED', exit_code: 0 } }]), undefined);
    const followUp = { type: 'OUT_OF_SCOPE_FOLLOW_UP_MATERIALIZED', details: { bindings: [{}] } };
    const retained = { ...failure, details: { ...failure.details, output_artifact_path: 'runtime/failure.log' } };
    assert.notEqual(admittedCounterState('stack-fixture-unknown-quartz-gate-tour', [followUp]), 'retained-task-test-failure');
    assert.notEqual(admittedCounterState('stack-fixture-unknown-quartz-gate-tour', [retained]), 'retained-task-test-failure');
    assert.equal(admittedCounterState('stack-fixture-unknown-quartz-gate-tour', [retained, followUp]), 'retained-task-test-failure');
    const selection = { type: 'TASK_TEST_SELECTION_RECORDED', details: {} };
    assert.equal(admittedCounterState('stack-retained-broad-failure', [selection, retained]), undefined);
    assert.equal(admittedCounterState('stack-retained-broad-failure', [retained, selection]), 'stack-retained-broad-failure');
    assert.equal(admittedCounterState('full-suite-out-of-scope-narrow', [retained, selection]), 'stack-retained-broad-failure');
    assert.equal(admittedCounterState('stack-four-lane-task', []), undefined);
    assert.equal(admittedCounterState('stack-four-lane-cmake-task', [{ type: 'TASK_MODE_ENTERED', details: {} }]), 'stack-fixture-cmake-planning');
    assert.equal(admittedCounterState('stack-four-lane-task', [{ type: 'PREFLIGHT_CLASSIFIED', details: {
        required_reviews: { code: true, security: true, refactor: true, test: true } } }]), 'stack-four-lane-task');
    assert.equal(admittedCounterState('task-local-full-suite-child-tree', [], 'T-WALK-F1'), undefined);
    assert.equal(admittedCounterState('task-local-full-suite-child-tree', [failure]), undefined);
    assert.equal(admittedCounterState('task-local-full-suite-child-tree', [failure,
        { type: 'TASK_TEST_SELECTION_RECORDED', details: { task_test_selection_authority: { validation_plan: {} } } }]), 'task-local-full-suite-child-tree');
    assert.equal(admittedCounterState('task-local-full-suite-child-tree', [], 'T-WALK-F1',
        [{ type: 'FULL_SUITE_REPAIR_TASK_MATERIALIZED', details: {} }]), 'task-local-full-suite-child-tree');
    assert.equal(admittedCounterState('task-local-expected-red', []), undefined);
    assert.equal(admittedCounterState('task-local-expected-red', [{ type: 'PREFLIGHT_CLASSIFIED', details: {
        code_changed: true, changed_files_count: 1, required_reviews: { code: false, test: true }, scope_sha256: 'b'.repeat(64) } }]), 'task-local-expected-red');
    assert.equal(admittedCounterState('task-local-expected-red',
        [{ type: 'TEST_FIRST_EXPECTED_FAILURE_RECORDED', details: {} }]), 'task-local-expected-red');
});

// Root-chain normalization. Oracle: one authenticated ancestor capture plus its exit validation probes each directory
// above the disposable root with 4 lstat and 2 realpath calls (invocation-file-observation.ts capturePath).
function chainStep(directories: number, options: { walks?: number; lstat?: number; partial?: number } = {}): WalkResult {
    const walks = options.walks ?? 1, work: Record<string, number> = {};
    for (let level = 0; level < directories; level++) {
        work['root_chain_probe:lstatSync:' + level + '/' + directories] = 4 * walks + (level === 0 ? options.partial ?? 0 : 0);
        work['root_chain_probe:realpathSync:' + level + '/' + directories] = 2 * walks;
    }
    const io = { lstatSync: { count: (options.lstat ?? 100) + 4 * walks * directories + (options.partial ?? 0) },
        realpathSync: { count: 10 + 2 * walks * directories } };
    return { scenarioId: 'unit-root-chain', steps: [{ index: 0, taskEvents: 1, route: 'READY/unit', gate: 'unit', status: 'READY',
        command: 'node garda gate unit', navigatorMs: 1, measurement: { work, io, phases_ms: {} } }] } as unknown as WalkResult;
}
const chainBaseline: CounterBaseline = { schema: 1, provenance: 'Independent root-chain negative controls', routes: { 'READY/unit': {
    'file_probes:lstatSync': { expected: 100 + 4 * REFERENCE_ROOT_CHAIN_DIRECTORIES, tolerance: 0, constantWithEvents: true },
    'file_probes:realpathSync': { expected: 10 + 2 * REFERENCE_ROOT_CHAIN_DIRECTORIES, tolerance: 0, constantWithEvents: true } } } };
const chainFailures = (result: WalkResult) => analyzeWalkMetrics([result], chainBaseline, false).anomalies
    .filter(item => item.severity === 'failure').map(item => item.kind + ':' + item.metric + '=' + item.observed);

test('file-probe budgets compare the same navigator work equally at any root depth', () => {
    for (const directories of [2, REFERENCE_ROOT_CHAIN_DIRECTORIES, REFERENCE_ROOT_CHAIN_DIRECTORIES + 1, 12]) {
        assert.deepEqual(chainFailures(chainStep(directories)), [], 'chain of ' + directories);
        assert.deepEqual(workCounters(chainStep(directories).steps[0]), workCounters(chainStep(REFERENCE_ROOT_CHAIN_DIRECTORIES).steps[0]));
    }
    // Without the stand's labels nothing is normalized: the deeper root's raw probes fail as before.
    const unlabeled = chainStep(REFERENCE_ROOT_CHAIN_DIRECTORIES + 1);
    unlabeled.steps[0].measurement!.work = {};
    assert.deepEqual(chainFailures(unlabeled), ['counter-budget:file_probes:lstatSync=132', 'counter-budget:file_probes:realpathSync=26']);
});

test('an extra probe at the same root depth still fails its budget', () => {
    for (const directories of [REFERENCE_ROOT_CHAIN_DIRECTORIES, REFERENCE_ROOT_CHAIN_DIRECTORIES + 1, 3]) {
        assert.deepEqual(chainFailures(chainStep(directories, { lstat: 101 })), ['counter-budget:file_probes:lstatSync=129'], 'outside the chain');
        // One more probe of a single chain directory is not an ancestor walk; it stays ordinary work.
        const partial = chainStep(directories, { partial: 1 });
        assert.deepEqual(chainFailures(partial), ['counter-budget:file_probes:lstatSync=129'], 'on the chain');
        const raw = 101 + 4 * directories;
        assert.deepEqual(analyzeWalkMetrics([partial], chainBaseline, false).anomalies[0].rootChain,
            { directories, walks: 4, probes: raw - 100, adjustment: 4 * (directories - REFERENCE_ROOT_CHAIN_DIRECTORIES) });
    }
});

test('doubled ancestor work still fails at every root depth', () => {
    for (const directories of [2, REFERENCE_ROOT_CHAIN_DIRECTORIES, REFERENCE_ROOT_CHAIN_DIRECTORIES + 1]) {
        assert.deepEqual(chainFailures(chainStep(directories, { walks: 2 })), ['counter-budget:file_probes:lstatSync=156',
            'counter-budget:file_probes:realpathSync=38'], 'chain of ' + directories);
    }
});

test('untrustworthy root-chain labels fail instead of normalizing', () => {
    const inflated = chainStep(REFERENCE_ROOT_CHAIN_DIRECTORIES + 1);
    inflated.steps[0].measurement!.io!.realpathSync.count = 3; // Fewer probes measured than labeled.
    assert.ok(chainFailures(inflated).includes('missing-baseline:root_chain_unverified=1'));
    const mixed = chainStep(REFERENCE_ROOT_CHAIN_DIRECTORIES);
    mixed.steps[0].measurement!.work['root_chain_probe:lstatSync:0/9'] = 1;
    assert.ok(chainFailures(mixed).includes('missing-baseline:root_chain_unverified=1'));
});

/** Real product reads under one TMP spelling, prepared the way the stand prepares every walk process. */
function measureProductWalk(spelling: string, options: { scopes?: number; canonicalize?: boolean } = {}) {
    Object.assign(process.env, { TMP: spelling, TEMP: spelling, TMPDIR: spelling });
    const temp = options.canonicalize === false ? os.tmpdir() : canonicalizeTempRoot();
    const input = path.join(temp, 'garda-walk-unit', 'input.txt');
    fs.mkdirSync(path.dirname(input), { recursive: true }); fs.writeFileSync(input, 'unit');
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => {
        for (let scope = 0; scope < (options.scopes ?? 1); scope++) withInvocationReadObservation(() => readInvocationFileContent(input));
    }, value => { measurement = value; });
    const step = { measurement } as unknown as WalkResult['steps'][number];
    return { temp, counters: workCounters(step), chain: rootChainProbes(measurement!.work, measurement!.io), raw: measurement!.io! };
}
function withTempEnvironment(run: (root: string) => void) {
    const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
    installRootChainProbes();
    try { temporary(root => run(fs.realpathSync.native(root))); } finally {
        for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
}
/** Other spellings of one existing directory: separators, trailing separator, drive/name case, 8.3, symlinked alias. */
function spellingsOf(directory: string): string[] {
    const spellings = [directory, directory + path.sep];
    if (process.platform === 'win32') {
        const forward = directory.split(path.sep).join('/');
        spellings.push(forward, forward + '/', directory[0].toLowerCase() + directory.slice(1),
            directory.toLowerCase(), directory.toUpperCase());
        try {
            const short = String(spawnSync('cmd.exe', ['/d', '/c', 'for %I in ("' + directory + '") do @echo %~sI'],
                { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true }).stdout ?? '').trim();
            if (short && short !== directory && fs.existsSync(short)) spellings.push(short);
        } catch { /* 8.3 names can be disabled per volume; the other spellings still apply. */ }
    } else {
        const alias = directory + '-alias';
        fs.symlinkSync(directory, alias, 'dir');
        spellings.push(directory.replace(/\/([^/]+)$/u, '/./$1'), directory.replace(/^\//u, '//'), alias);
    }
    return spellings;
}

test('the product ancestor walk is labeled and normalized identically under two temp depths', () => withTempEnvironment(root => {
    const shallow = measureProductWalk(path.join(root, 'a')), deep = measureProductWalk(path.join(root, 'a', 'b', 'c'));
    assert.equal(deep.chain.probes.lstatSync.directories, shallow.chain.probes.lstatSync.directories + 2);
    // The real per-directory cost: initial capture plus exit validation.
    for (const run of [shallow, deep]) {
        assert.equal(run.chain.problem, undefined);
        assert.equal(run.chain.probes.lstatSync.walks, 4); assert.equal(run.chain.probes.realpathSync.walks, 2);
    }
    assert.equal(deep.raw.lstatSync.count - shallow.raw.lstatSync.count, 8);
    assert.equal(deep.raw.realpathSync.count - shallow.raw.realpathSync.count, 4);
    for (const probe of ['file_probes:lstatSync', 'file_probes:realpathSync']) assert.equal(deep.counters[probe], shallow.counters[probe], probe);
    // Two invocation scopes authenticate the chain twice: the normalized count grows by a full reference walk.
    const doubled = measureProductWalk(path.join(root, 'a', 'b', 'c'), { scopes: 2 });
    assert.equal(doubled.chain.probes.lstatSync.walks, 8);
    assert.ok(doubled.counters['file_probes:lstatSync'] >= deep.counters['file_probes:lstatSync'] + 4 * REFERENCE_ROOT_CHAIN_DIRECTORIES);
}));

test('every spelling of one temp root measures identical raw and normalized probes', () => withTempEnvironment(root => {
    const directory = path.join(root, 'a', 'b');
    fs.mkdirSync(directory, { recursive: true });
    const spellings = spellingsOf(directory);
    assert.ok(spellings.length >= (process.platform === 'win32' ? 7 : 5));
    const reference = measureProductWalk(directory);
    assert.equal(reference.chain.problem, undefined);
    for (const spelling of spellings) {
        const run = measureProductWalk(spelling);
        assert.equal(run.temp, directory, spelling);
        assert.equal(run.chain.problem, undefined, spelling);
        assert.deepEqual(run.chain.probes, reference.chain.probes, spelling);
        assert.deepEqual(run.counters, reference.counters, spelling);
        for (const probe of ['lstatSync', 'realpathSync']) assert.equal(run.raw[probe].count, reference.raw[probe].count, spelling + ' ' + probe);
    }
    // Both slash spellings of the deeper root give one comparison too.
    const deep = path.join(directory, 'c');
    fs.mkdirSync(deep);
    const back = measureProductWalk(deep), forward = measureProductWalk(deep.split(path.sep).join('/'));
    assert.deepEqual(forward.counters, back.counters);
    for (const probe of ['file_probes:lstatSync', 'file_probes:realpathSync']) assert.equal(back.counters[probe], reference.counters[probe], probe);
}));

test('work measured under a non-canonical temp spelling is refused, not normalized', () => withTempEnvironment(root => {
    const directory = path.join(root, 'a');
    fs.mkdirSync(directory);
    let alias = directory[0].toLowerCase() + directory.slice(1);
    if (process.platform !== 'win32') { alias = directory + '-alias'; fs.symlinkSync(directory, alias, 'dir'); }
    const raw = measureProductWalk(alias, { canonicalize: false });
    // The product authenticates the lexical and the canonical chain: spelling-dependent work.
    assert.ok(raw.raw.lstatSync.count > measureProductWalk(directory).raw.lstatSync.count);
    assert.match(raw.chain.problem ?? '', /non-canonical/u);
    assert.equal(raw.counters.root_chain_unverified, 1);
}));
