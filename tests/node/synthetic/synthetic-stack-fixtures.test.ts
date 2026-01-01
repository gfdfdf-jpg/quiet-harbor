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
import { admittedCounterState, walkTaskSelectionPlan } from './engine/navigator-walk';
import { analyzeWalkMetrics, counterBudgets, type CounterBaseline } from './engine/walk-metrics';
import { platformCounterBaseline } from './engine/walk-platform-baselines';
import { measuredNativeCounterState, type WalkResult } from './engine/navigator-walk';
import { STACK_WALK_SCENARIOS, STACK_REVIEW_VARIANTS, stackScenario, stackAdapterRegressions, applyStackEdits, stackSourceEdit } from './engine/walk-stack-scenarios';
import { COVERAGE_WALK_SCENARIOS } from './engine/walk-coverage-scenarios';
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
    const additionalProfiles = new Set(['stack-decomposition-planning', 'stack-four-lane-native-child-tree',
        'stack-five-lane-native-child-tree', 'leaf-test-review-reuse', 'task-test-failure-repair', 'retained-task-test-failure',
        'stack-retained-broad-failure', 'stack-four-lane-task', 'task-local-full-suite-child-tree', 'task-local-expected-red',
        'declared-recipe-task-local-reviewed', 'declared-recipe-task-local-docs-only', 'matrix-test-review-reuse']);
    const apiEvidence = JSON.parse(fs.readFileSync('tests/node/synthetic/api-counter-calibration-evidence.json', 'utf8')) as { previousRouteNames: string[] };
    const nativeShapes = JSON.parse(fs.readFileSync('tests/node/synthetic/native-counter-input-shapes.json', 'utf8')) as { shapes: Array<{ id: string }> };
    const laterAcceptedProfiles = new Set(['stack-fixture-spring-maven-two-modules', 'native-api-selected-initial',
        'native-api-selected-remediation', ...nativeShapes.shapes.map(shape => shape.id)]);
    const oldRoutes = Object.fromEntries(Object.entries(baseline.routes)
        .filter(([id]) => apiEvidence.previousRouteNames.includes(id))
        .map(([id, metrics]) => [id, Object.fromEntries(Object.entries(metrics).filter(([metric]) => metric !== 'subprocess:powershell.exe'))]));
    const oldStates = Object.fromEntries(Object.entries(baseline.states ?? {}).filter(([state]) =>
        !STACK_COUNTER_STATE_IDS.has(state) && !additionalProfiles.has(state) && !laterAcceptedProfiles.has(state)));
    assert.equal(createHash('sha256').update(JSON.stringify({ routes: oldRoutes, states: oldStates })).digest('hex'),
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
    for (const state of additionalProfiles) {
        const routes = baseline.states?.[state]?.routes;
        assert.ok(routes, state);
        for (const counters of Object.values(routes)) for (const [metric, budget] of Object.entries(counters)) {
            assert.ok(!metric.startsWith('subprocess:'), state + ': subprocess ceilings must be inherited unchanged');
            assert.ok('reason' in budget && typeof budget.reason === 'string' && budget.reason.trim(), state + ': explain each required input');
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

test('Vite broad attempt binds one real task target to each invocation and keeps both when narrowed', () => {
    const manifest = STACK_MANIFESTS.find(item => item.id === 'vite-playwright')!;
    const scenario = stackScenario(manifest, 6, 'generic');
    const fixture = scenario.fixture!;
    assert.equal(fixture.taskTestInvocations!.length, 2);
    assert.deepEqual(scenario.selectionTargets, manifest.suites.map(suite => suite.target));
    const descriptor = inspectValidationCommand(scenario.testSelectionCommand!, 'test', { allowConjunction: true }).descriptor!;
    const plan = walkTaskSelectionPlan(scenario.testSelectionCommand!, scenario.selectionTargets!, fixture, 'T-WALK');
    assert.equal(descriptor.invocations.length, 2);
    for (const [index, invocation] of fixture.taskTestInvocations!.entries()) {
        assert.deepEqual(plan.targets.filter(target => target.invocation === index).map(target => target.path), invocation.targets);
        assert.ok(plan.targets.some(target => target.invocation === index));
    }
    assert.notEqual(fixture.taskTestCommand, fixture.projectTestCommand);
});

test('polyglot RED scenario executes each bound command separately before implementation', async () => {
    for (const manifest of STACK_MANIFESTS.filter(item => item.id.startsWith('polyglot-'))) {
        const scenario = stackScenario(manifest, 7, 'generic');
        const calls: string[][] = [];
        assert.equal(scenario.agentExecutesRed, true);
        assert.equal(await scenario.act!('.', 'test-first-expected-failure', [], async argv => { calls.push(argv); }), true);
        assert.equal(calls.length, 2);
        for (const [index, argv] of calls.entries()) {
            assert.ok(argv.includes('--expect-failure'));
            const command = argv[argv.indexOf('--command') + 1];
            assert.equal(command, scenario.fixture!.taskTestInvocations![index].command);
            assert.ok(!command.includes(' && '));
            const claims = argv.flatMap((value, i) => value === '--selected-case' ? [JSON.parse(argv[i + 1]).source] : []);
            assert.deepEqual(claims, scenario.fixture!.taskTestInvocations![index].targets);
        }
    }
});

test('Rust contract paths add API to mixed tasks, while protected fixes reuse refactor', () => {
    const rust = STACK_MANIFESTS.find(item => item.id === 'rust')!;
    for (const archetype of [1, 3, 5, 6, 7, 8]) {
        const scenario = stackScenario(rust, archetype, 'generic');
        assert.ok(scenario.edits.some(edit => /contract[^/]*\.rs$/iu.test(edit.path)));
        assert.equal(scenario.expectedReviews.api, 1);
        assert.ok(scenario.expectedModes.includes('api:FULL'));
    }
    assert.deepEqual(stackScenario(rust, 2, 'generic').expectedModes, ['test:FULL']);
    for (const scenario of STACK_REVIEW_VARIANTS.filter(item => item.id.endsWith('-protected-fix'))) {
        assert.deepEqual(scenario.expectedReviews, { code: 2, security: 2, refactor: 1, test: 2 });
        assert.deepEqual(scenario.expectedModes.slice(-3), ['code:DELTA', 'security:FULL', 'test:DELTA']);
    }
});

test('timeout coverage selects a task test that remains running until the configured timeout', () => {
    const scenario = COVERAGE_WALK_SCENARIOS.find(item => item.id === 'coverage-full-suite-timeout')!;
    const fixture = scenario.fixture!;
    assert.equal(scenario.testSelectionCommand, 'node tests/app.test.ts');
    assert.notEqual(scenario.testSelectionCommand, fixture.projectTestCommand);
    assert.deepEqual(scenario.selectionTargets, ['tests/app.test.ts']);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-timeout-'));
    try {
        seedWalkFixture(root, fixture);
        // The walk similarly clears node:test's parent context before executing project commands.
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const child = spawnSync(process.execPath, ['tests/app.test.ts'], { cwd: root, env, timeout: 1500, windowsHide: true, encoding: 'utf8' });
        assert.equal((child.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT',
            `status=${child.status} stdout=${child.stdout} stderr=${child.stderr}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
        assert.doesNotMatch(output, /\bPASS\b|^ok |РІСљвЂќ/mu);
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
        assert.ok(scenario.fixture!.taskTestSupport?.some(input => input.role === 'fixture' && input.targets.length === 2));
        assert.ok(scenario.fixture!.taskTestInvocations?.every(run => !run.command.includes('--implementation')));
        assert.deepEqual(scenario.expectedReviews, { code: 2, security: 1, refactor: 1, test: 1 });
        assert.ok(scenario.fix?.every(edit => !scenario.selectionTargets?.includes(edit.path)), 'The finding fix preserves TDD test bytes');
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

interface SingleRepairCounterEvidence {
    state: string; parent: string; route: string;
    previous: Record<string, { routes_sha256: string; state_ids: string[]; states_sha256: string }>;
    measurements: Array<{ platform: string; counters: Record<string, number>; hashInputs: Array<{ id: string; count: number }> }>;
    history: Array<{ platform: string; appendedEvents: number; commandsEqual: boolean; increases: unknown[];
        before: Record<string, number>; after: Record<string, number>; beforeInputs: unknown[]; afterInputs: unknown[] }>;
}
function singleRepairEvidence(): SingleRepairCounterEvidence {
    return JSON.parse(fs.readFileSync('tests/node/synthetic/single-repair-counter-calibration-evidence.json', 'utf8')) as SingleRepairCounterEvidence;
}

test('single repair handoff calibration preserves every earlier Windows and Linux budget', () => {
    const evidence = singleRepairEvidence();
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    for (const [platform, prior] of Object.entries(evidence.previous)) {
        const baseline = platformCounterBaseline(process.cwd(), platform);
        assert.equal(digest(baseline.routes), prior.routes_sha256);
        assert.equal(digest(Object.fromEntries(prior.state_ids.map(id => [id, baseline.states![id]]))), prior.states_sha256);
        assert.equal(baseline.states![evidence.state].inherits, evidence.parent);
        assert.deepEqual(Object.keys(baseline.states![evidence.state].routes), [evidence.route]);
    }
    assert.notEqual(measuredNativeCounterState(admittedCounterState(evidence.parent, []), []), evidence.state,
        'a scenario label without native admission cannot select the calibration');
});

test('single repair handoff measures 28 distinct inputs and no extra constant work after five authenticated events', () => {
    const evidence = singleRepairEvidence();
    assert.equal(evidence.measurements.length, 2);
    for (const row of evidence.measurements) {
        const baseline = platformCounterBaseline(process.cwd(), row.platform);
        const budgets = counterBudgets(baseline, evidence.route, evidence.state)!;
        assert.equal(new Set(row.hashInputs.map(input => input.id)).size, 28);
        assert.ok(row.hashInputs.every(input => input.count === 1));
        for (const [metric, value] of Object.entries(row.counters))
            assert.ok(budgets[metric] && value <= budgets[metric].expected + budgets[metric].tolerance, row.platform + '/' + metric);
        assert.equal(budgets['subprocess:git'].expected, 0);
        assert.equal(budgets['subprocess:powershell.exe'].expected, row.platform === 'win32' ? 4 : 0);
        assert.equal(budgets['subprocess:icacls.exe'].expected, row.platform === 'win32' ? 4 : 0);
    }
    assert.equal(evidence.history.length, 2);
    for (const probe of evidence.history) {
        assert.equal(probe.appendedEvents, 5); assert.equal(probe.commandsEqual, true);
        assert.deepEqual(probe.increases, []); assert.deepEqual(probe.beforeInputs, probe.afterInputs);
        for (const metric of ['file_hash:file', 'payload_reads', 'subprocess:git', 'subprocess:icacls.exe', 'subprocess:powershell.exe',
            'timeline_parse', 'timeline_verify', 'timeline_capture:file', 'timeline_payload_read:file'])
            assert.equal(probe.before[metric] ?? 0, probe.after[metric] ?? 0, probe.platform + '/' + metric);
    }
});

test('one excess hash, Git, ACL or PowerShell operation still fails the single repair handoff limits', () => {
    const evidence = singleRepairEvidence();
    for (const platform of ['win32', 'linux']) {
        const budgets = counterBudgets(platformCounterBaseline(process.cwd(), platform), evidence.route, evidence.state)!;
        for (const metric of ['file_hash:file', 'subprocess:git', 'subprocess:icacls.exe', 'subprocess:powershell.exe']) {
            const budget = budgets[metric], limit = budget.expected + budget.tolerance;
            const result = (extra: number): WalkResult => ({ scenarioId: 'single-repair-counter-oracle-negative-control', steps: [{
                index: 0, route: evidence.route, status: 'BLOCKED', gate: 'child-task', command: null,
                taskEvents: 21, navigatorMs: 1, commandMs: 0, exitCode: null, reason: '', output: '', workspaceSha256: '',
                measurement: { phases_ms: {}, work: metric === 'file_hash:file'
                    ? Object.fromEntries(Array.from({ length: limit + extra }, (_, index) => ['file_hash:input-' + index, 1]))
                    : { ['process:spawnSync:' + metric.slice('subprocess:'.length) + ':counter-control']: limit + extra } }
            }] } as WalkResult);
            const scoped: CounterBaseline = { schema: 1, provenance: 'Single-operation oracle negative control', routes: { [evidence.route]: { [metric]: budget } } };
            assert.equal(analyzeWalkMetrics([result(0)], scoped, false).anomalies.length, 0);
            assert.ok(analyzeWalkMetrics([result(1)], scoped, false).anomalies.some(row => row.kind === 'counter-budget'), platform + '/' + metric);
        }
    }
});
