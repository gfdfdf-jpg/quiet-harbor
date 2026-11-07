import './engine/walk-route-observer';
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
test('four pillars remain red while incomplete; omitted/busy timing cannot become a Speed PASS', () => {
    const running = buildStandSummary({ ...summaryInput(), final: false, walk: undefined });
    assert.equal(running.state, 'running');
    assert.ok(Object.values(running.pillars).every(pillar => pillar.verdict === 'FAIL'));
    const report = buildStandSummary(summaryInput());
    assert.equal(report.pillars.navigator_correctness.verdict, 'PASS');
    assert.equal(report.pillars.stack_independence.verdict, 'PASS');
    assert.equal(report.pillars.review_logic.verdict, 'PASS');
    assert.equal(report.pillars.speed.verdict, 'FAIL');
    assert.equal(report.speed.step_timing, 'INCONCLUSIVE');
    const busy = buildStandSummary({ ...summaryInput(), timingRequested: true,
        quiet: { quiet: false, duration_ms: 30000, host_cpu_percent: 40, heavy_processes: ['node'], reasons: ['machine busy'] } });
    assert.match(renderStandSummary(busy), /machine busy/u);
});
test('counter failures and known review findings remain failures in the consolidated report', () => {
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
    assert.throws(() => acceptStandBaseline(root, { kind: 'timing', candidate: target, reason: 'attempt', release: '1.4.4', sourceCommit: 'a'.repeat(40), expectedSha256: fileDigest(target) }), /complete quiet/u);
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
