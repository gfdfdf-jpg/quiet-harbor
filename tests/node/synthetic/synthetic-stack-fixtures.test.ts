import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { captureIntermediateSelection } from '../../../src/core/intermediate-selected-cases';
import { inspectValidationCommand } from '../../../src/core/validation-command-contract';
import { NODE_WALK_FIXTURE, seedWalkFixture, walkFixtureTemplateKey } from './engine/walk-fixture';
import { STACK_MANIFESTS, STACK_FIXTURE_ROOT, stackInvocations, stackFixture, stackExecutionViolations,
    readStackExecutions, stackMatrixIdentity, stackSelectedCases, blockingStackObservations, STACK_COUNTER_STATE_IDS, type StackTaskPlan, type StackManifest, type StackMode } from './engine/walk-stack-fixtures';
import { admittedCounterState } from './engine/navigator-walk';
import type { CounterBaseline } from './engine/walk-metrics';
import { STACK_WALK_SCENARIOS, stackScenario, stackAdapterRegressions, applyStackEdits, stackSourceEdit } from './engine/walk-stack-scenarios';
import { UNKNOWN_STACK_CONTRACT_SCENARIOS, UNKNOWN_GATE_OBLIGATIONS } from './engine/walk-unknown-stack-contract';
import { assertWalkResumeIdentity } from './engine/walk-run-store';

function fixtureRun(manifest: StackManifest, archetype: number, mode: StackMode, check: (root: string, plan: StackTaskPlan) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stack-runner-'));
    try {
        seedWalkFixture(root, stackFixture(manifest, mode)); fs.mkdirSync(path.join(root, '.git'));
        const scenario = stackScenario(manifest, archetype, mode);
        const plan: StackTaskPlan = { archetype, mode, invocations: stackInvocations(manifest, archetype) };
        scenario.configure!(root); applyStackEdits(root, scenario.edits);
        check(root, plan);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function run(root: string, technology: string, argv: string[]): number | null {
    const child = spawnSync(process.execPath, [path.join(STACK_FIXTURE_ROOT, 'runner.cjs'), technology, ...argv],
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    assert.ifError(child.error); assert.notEqual(child.status, null, child.stderr);
    return child.status;
}

test('matrix has nine distinct task specifications on 19 real project shapes, plus every declared adapter peer', () => {
    assert.equal(STACK_MANIFESTS.length, 19); assert.equal(STACK_WALK_SCENARIOS.length, 198);
    assert.equal(new Set(STACK_WALK_SCENARIOS.map(scenario => scenario.id)).size, 198);
    for (const manifest of STACK_MANIFESTS) {
        for (const mode of manifest.adapter ? ['generic', 'auto'] : ['generic']) {
            const scenarios = STACK_WALK_SCENARIOS.filter(scenario => scenario.id.startsWith('stack-' + manifest.id + '-a') && scenario.id.endsWith('-' + mode));
            assert.equal(scenarios.length, 9); assert.equal(new Set(scenarios.map(scenario => scenario.taskTitle)).size, 9);
            assert.equal(new Set(scenarios.map(scenario => JSON.stringify(scenario.edits))).size, 9);
            assert.deepEqual(scenarios[3].expectedReviews, {}); assert.equal(scenarios[3].profile, 'docs-only');
            assert.deepEqual(scenarios[1].expectedModes, ['test:FULL']);
            assert.ok(scenarios[8].expectedTaskReviews?.['T-WALK-1']);
        }
        if (!['node', 'vite-playwright', 'pnpm-nx', 'polyglot-maven-ts'].includes(manifest.id))
            assert.equal('package.json' in stackFixture(manifest, 'generic').files, false, manifest.id);
    }
});

test('stack calibration preserves every legacy budget and needs native task admission', () => {
    const baseline = JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-baseline.json', 'utf8')) as CounterBaseline;
    const evidence = JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-calibration-evidence.json', 'utf8')) as {
        universalMergeStackCalibration: { oldRoutesAndStatesSha256: string }
    };
    const oldStates = Object.fromEntries(Object.entries(baseline.states ?? {}).filter(([state]) => !STACK_COUNTER_STATE_IDS.has(state)));
    assert.equal(createHash('sha256').update(JSON.stringify({ routes: baseline.routes, states: oldStates })).digest('hex'),
        evidence.universalMergeStackCalibration.oldRoutesAndStatesSha256);
    for (const state of STACK_COUNTER_STATE_IDS) {
        assert.equal(admittedCounterState(state, []), undefined);
        assert.equal(admittedCounterState(state, [{ type: 'TASK_MODE_ENTERED', details: {} }]), state);
        const routes = baseline.states?.[state]?.routes;
        assert.ok(routes);
        for (const counters of Object.values(routes)) for (const [metric, budget] of Object.entries(counters)) {
            assert.ok(!metric.startsWith('subprocess:'), 'New input shapes retain existing Git/ACL limits');
            assert.equal(budget.growthTolerance ?? 0, 0);
        }
    }
    assert.equal(admittedCounterState('stack-fixture-unmeasured-a1-a6', [{ type: 'TASK_MODE_ENTERED', details: {} }]), undefined);
});

test('all fixture runners execute only their declared own targets and validate the scripted source patch', () => {
    for (const manifest of STACK_MANIFESTS) fixtureRun(manifest, 1, 'generic', (root, plan) => {
        for (const invocation of plan.invocations) assert.equal(run(root, invocation.technology, invocation.argv), 0, manifest.id);
        assert.deepEqual(stackExecutionViolations(root, plan), [], manifest.id);
        assert.equal(readStackExecutions(root).length, plan.invocations.length);
    });
});

test('every stack case mapping is admitted by native literal intermediate-source binding', () => {
    for (const manifest of STACK_MANIFESTS) fixtureRun(manifest, 3, 'generic', (root, plan) => {
        for (const invocation of plan.invocations) {
            const admission = inspectValidationCommand(invocation.command, 'validation');
            assert.ok(admission.descriptor, admission.violation ?? manifest.id);
            const selection = captureIntermediateSelection(root, admission.descriptor, stackSelectedCases(invocation));
            assert.deepEqual(selection.cases.map(claim => claim.source), invocation.targets);
        }
    });
});

test('A3 selects two components, and both polyglot combinations require two technologies in one task', () => {
    for (const manifest of STACK_MANIFESTS) assert.equal(stackInvocations(manifest, 3).flatMap(run => run.targets).length, 2, manifest.id);
    for (const manifest of STACK_MANIFESTS.filter(manifest => manifest.id.startsWith('polyglot-'))) fixtureRun(manifest, 3, 'generic', (root, plan) => {
        assert.equal(plan.invocations.length, 2);
        assert.equal(stackFixture(manifest, 'generic').projectTestCommand.split(' && ').length, 2,
            'The deliberate broad A6 attempt also declares one command per technology');
        const [first, second] = plan.invocations;
        assert.equal(run(root, first.technology, first.argv), 0);
        assert.ok(stackExecutionViolations(root, plan).includes('missing-green:' + second.technology), 'Partial GREEN cannot complete the task');
        assert.equal(run(root, second.technology, second.argv), 0);
        assert.deepEqual(stackExecutionViolations(root, plan), []);
    });
});

test('own failure requires a source repair, and opaque RED precedes implementation on unchanged tests', () => {
    const unknown = STACK_MANIFESTS.find(manifest => manifest.id === 'unknown-quartz')!;
    for (const archetype of [5, 7]) fixtureRun(unknown, archetype, 'generic', (root, plan) => {
        const invocation = plan.invocations[0]; assert.equal(run(root, invocation.technology, invocation.argv), 1);
        const before = fs.readFileSync(path.join(root, invocation.targets[0]), 'utf8');
        const suite = unknown.suites[0];
        applyStackEdits(root, [stackSourceEdit(suite, archetype, archetype === 5)]);
        assert.equal(run(root, invocation.technology, invocation.argv), 0);
        assert.equal(fs.readFileSync(path.join(root, invocation.targets[0]), 'utf8'), before);
        assert.deepEqual(stackExecutionViolations(root, plan), []);
    });
});

test('reviewer RED quotes a real own failure and GREEN keeps the same test bytes', () => {
    const manifest = STACK_MANIFESTS.find(item => item.id === 'unknown-quartz')!;
    fixtureRun(manifest, 7, 'generic', (root, plan) => {
        const invocation = plan.invocations[0], target = invocation.targets[0];
        const fixture = stackFixture(manifest, 'generic', plan.invocations);
        assert.equal(run(root, invocation.technology, invocation.argv), 1);
        const red = readStackExecutions(root).at(-1)!;
        assert.ok(fixture.failedCaseQuote!(root, target, target, red.output));
        assert.equal(fixture.passedCaseQuote(root, target, target, red.output), undefined);
        applyStackEdits(root, [stackSourceEdit(manifest.suites[0], 7, false)]);
        assert.equal(run(root, invocation.technology, invocation.argv), 0);
        const green = readStackExecutions(root).at(-1)!;
        assert.equal(red.checks[0].testSha256, green.checks[0].testSha256);
        assert.notEqual(red.checks[0].sourceSha256, green.checks[0].sourceSha256);
        assert.ok(fixture.failedCaseQuote!(root, target, target, red.output));
        assert.equal(fixture.failedCaseQuote!(root, target, target, green.output), undefined);
        assert.ok(fixture.passedCaseQuote(root, target, target, green.output));
    });
});

test('A9 child answers and case evidence stay inside the child component', async () => {
    for (const manifest of STACK_MANIFESTS) {
        const scenario = stackScenario(manifest, 9, 'generic');
        assert.equal(await scenario.act!('.', 'child-task', [], async () => {}), true);
        assert.deepEqual(scenario.edits.map(edit => edit.path), [manifest.suites[0].source, manifest.suites[0].target]);
        const second = manifest.suites[1], technology = manifest.technologies.find(tech => tech.id === second.technology)!;
        const fixture = stackFixture(manifest, 'generic', [{ technology: technology.id, command: '',
            argv: technology.secondArgv, targets: [second.target] }]);
        assert.equal(fixture.primarySource, second.source);
        assert.equal(fixture.primaryTest, second.target);
        assert.deepEqual(fixture.cases.map(claim => claim.source), [second.target]);
    }
});

test('fake-runner negative controls expose no-op, ignored selectors, stale reports, zero/skipped cases, dropped modules and report disagreement', () => {
    const manifest = STACK_MANIFESTS.find(manifest => manifest.id === 'spring-maven')!;
    const controls = { noop: 'zero-cases', 'ignored-selector': 'wrong-target-set', 'stale-report': 'stale-adapter-report',
        'zero-tests': 'zero-cases', skipped: 'skipped-case', 'dropped-second-module': 'wrong-target-set',
        'output-report-disagreement': 'process-report-disagreement' };
    for (const [variant, expected] of Object.entries(controls)) fixtureRun(manifest, variant === 'ignored-selector' ? 1 : 3, 'auto', (root, plan) => {
        plan.runnerVariant = variant; fs.writeFileSync(path.join(root, '.git/stand-task.json'), JSON.stringify(plan));
        for (const invocation of plan.invocations) run(root, invocation.technology, invocation.argv);
        assert.ok(stackExecutionViolations(root, plan).includes(expected), variant);
        if (['stale-report', 'output-report-disagreement'].includes(variant))
            assert.deepEqual(blockingStackObservations(stackExecutionViolations(root, plan)), [], 'Optional adapter disagreement stays visible without downgrading core PASS');
    });
});

test('wrong module/filter is refused; generic opaque evidence needs no recognized PASS token', () => {
    const manifest = STACK_MANIFESTS.find(manifest => manifest.id === 'unknown-quartz')!;
    fixtureRun(manifest, 1, 'generic', (root, plan) => {
        const invocation = plan.invocations[0]; assert.equal(run(root, invocation.technology, [...invocation.argv, '--wrong-module']), 1);
        fs.unlinkSync(path.join(root, '.git/stand-invocations.jsonl'));
        assert.equal(run(root, invocation.technology, invocation.argv), 0);
        const output = readStackExecutions(root)[0].output;
        assert.doesNotMatch(output, /\bPASS\b|^ok |✔/mu);
        assert.ok(stackFixture(manifest, 'generic', plan.invocations).passedCaseQuote(root, invocation.targets[0], invocation.targets[0], output));
        fs.appendFileSync(path.join(root, invocation.targets[0]), '# changed after execution\n');
        assert.equal(stackFixture(manifest, 'generic').passedCaseQuote(root, invocation.targets[0], invocation.targets[0], output), undefined);
    });
});

test('runner cwd is bound to the declared repository root', () => {
    const manifest = STACK_MANIFESTS.find(manifest => manifest.id === 'unknown-quartz')!;
    fixtureRun(manifest, 1, 'generic', (root, plan) => {
        plan.repoRoot = path.dirname(root);
        fs.writeFileSync(path.join(root, '.git/stand-task.json'), JSON.stringify(plan));
        const invocation = plan.invocations[0];
        assert.equal(run(root, invocation.technology, invocation.argv), 1);
        assert.match(readStackExecutions(root)[0].error, /cwd differs/u);
        assert.ok(stackExecutionViolations(root, plan).includes('wrong-command-or-cwd'));
    });
});

test('adapter PASS cannot be weaker; missing peers are explicitly incomplete', () => {
    const generic = { scenarioId: 'stack-node-a1-generic', outcome: 'done', reviews: [{ lane: 'test', mode: 'FULL' }] };
    const adapter = { ...generic, scenarioId: 'stack-node-a1-auto' };
    assert.deepEqual(stackAdapterRegressions([generic, adapter]), []);
    assert.equal(stackAdapterRegressions([generic, { ...adapter, outcome: 'blocked' }]).length, 1);
    assert.equal(stackAdapterRegressions([generic, { ...adapter, reviews: [] }]).length, 1);
    assert.equal(stackAdapterRegressions([adapter]).length, 1);
});

test('resume identity seals runner bytes, manifests, task specifications, mode and oracle version', () => {
    const identity = stackMatrixIdentity();
    for (const field of ['inputs', 'fixtures', 'tasks', 'oracleVersion']) {
        const changed = { ...identity as Record<string, unknown>, [field]: 'changed' };
        assert.throws(() => assertWalkResumeIdentity(identity, changed), /resume refused/u);
    }
    assert.doesNotThrow(() => assertWalkResumeIdentity(identity, stackMatrixIdentity()));
});

test('legacy descriptor retains exact Node files and opaque gate-tour declares every required native route', () => {
    assert.equal(NODE_WALK_FIXTURE.files['src/app.ts'], 'export function renderStatus() {\n    return "ready";\n}\n');
    assert.equal(NODE_WALK_FIXTURE.projectTestCommand, 'node scripts/full-suite-check.cjs');
    for (const scenario of UNKNOWN_STACK_CONTRACT_SCENARIOS) {
        assert.equal(scenario.expectedBlockedGate, undefined);
        for (const gate of Object.values(UNKNOWN_GATE_OBLIGATIONS).flat()) assert.ok(scenario.expectedGates?.includes(gate));
        assert.equal('package.json' in scenario.fixture!.files, false);
        assert.notEqual(walkFixtureTemplateKey(scenario.fixture!), walkFixtureTemplateKey(
            stackFixture(STACK_MANIFESTS.find(manifest => manifest.id === 'unknown-quartz')!, 'generic')),
        'Unconfigured/renamed tours must never poison the ordinary template cache');
    }
    assert.notEqual(walkFixtureTemplateKey(UNKNOWN_STACK_CONTRACT_SCENARIOS[0].fixture!),
        walkFixtureTemplateKey(UNKNOWN_STACK_CONTRACT_SCENARIOS[1].fixture!));
});
