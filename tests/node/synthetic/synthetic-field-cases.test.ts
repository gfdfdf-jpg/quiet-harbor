import './engine/walk-route-observer';
import test from 'node:test';
import { calibrationCounterBaseline } from './engine/walk-counter-history';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { FIELD_CASE_IDS, R144_FIELD_CASE_IDS, FIELD_CASE_SCENARIOS, FIELD_LEGACY_GARDA_COMMIT, FIELD_LEGACY_GARDA_TREE, FIELD_TWO_MODULE_COUNTER_STATE, fieldSpringScenario } from './engine/walk-field-cases';
import { walkRunPlan } from './engine/walk-plan';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { parseCommandChain } from '../../../src/core/command-line';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWindowsBatchCommandLine, spawnShellCommand } from '../../../src/core/subprocess';
import { readValidationFile } from '../../../src/core/project-validation-identity';
import { splitCommandLine } from '../../../src/core/command-line';
import { handleGate } from '../../../src/cli/commands/gate-command';
import { createWalkTemplate, walkTask, type WalkScenario } from './engine/navigator-walk';
import { removeWalkDirectory } from './engine/walk-checkpoint';
import { captureWalkOutput } from './engine/walk-output';

test('field OP-036: a generated coherent restart retains unchanged declared tests for selection',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(scenario => scenario.id === 'clean-pass');
        assert.ok(baseline);
        const targets = ['tests/app.test.ts', 'tests/auth.test.cjs'];
        const modePath = 'garda-agent-orchestrator/runtime/reviews/T-WALK-task-mode.json';
        const handshakePath = 'garda-agent-orchestrator/runtime/reviews/T-WALK-handshake.json';
        let disturbed = false;
        let observedRestart = false;
        let verifiedMode = false;
        const scenario: WalkScenario = {
            ...baseline,
            id: 'field-onlinestore-op036-coherent-restart-targets',
            // The declared tests remain unchanged while the unrelated implementation changes.
            edits: baseline.edits.filter(edit => edit.path === 'src/app.ts'),
            selectionTargets: targets,
            testSelectionCommand: 'node --test tests/app.test.ts tests/auth.test.cjs',
            inspectNavigation: result => {
                if (result.next_gate !== 'restart-coherent-cycle') return;
                const command = result.commands[0]?.command ?? '';
                assert.ok(command.includes('restart-coherent-cycle'));
                for (const target of targets) assert.ok(!command.includes(target), command);
                observedRestart = true;
            },
            execute: async (_root, step) => {
                if (step.gate !== 'enter-task-mode') return false;
                const argv = splitCommandLine(step.command);
                const gate = argv.indexOf('gate');
                assert.ok(gate >= 0);
                argv.push(...targets.flatMap(target => ['--planned-changed-file', target]));
                step.command = argv.map(arg => JSON.stringify(arg)).join(' ');
                const output: string[] = [];
                const previousExitCode = process.exitCode;
                try {
                    process.exitCode = 0;
                    await captureWalkOutput(output, () => handleGate(argv.slice(gate + 1)));
                    step.exitCode = Number(process.exitCode ?? 0);
                    step.output = output.join('\n');
                } finally {
                    process.exitCode = previousExitCode;
                }
                assert.equal(step.exitCode, 0, step.output);
                return true;
            },
            prepare: async (root, steps) => {
                const last = steps.at(-1);
                if (!disturbed && last?.gate === 'compile-gate' && last.exitCode === 0) {
                    fs.unlinkSync(path.join(root, handshakePath));
                    disturbed = true;
                }
                if (!verifiedMode && last?.gate === 'restart-coherent-cycle' && last.exitCode === 0) {
                    const mode = JSON.parse(fs.readFileSync(path.join(root, modePath), 'utf8')) as { planned_changed_files: string[] };
                    for (const target of targets) assert.ok(mode.planned_changed_files.includes(target), JSON.stringify(mode.planned_changed_files));
                    verifiedMode = true;
                }
            },
            inspectResult: (_root, result) => {
                assert.equal(result.outcome, 'done', result.detail);
                assert.ok(observedRestart && verifiedMode);
                const restart = result.steps.find(step => step.gate === 'restart-coherent-cycle' && step.exitCode === 0);
                assert.ok(restart);
                assert.ok(result.steps.some(step => step.index > restart.index && step.gate === 'task-test-selection' && step.exitCode === 0));
                assert.ok(result.steps.some(step => step.index > restart.index && step.gate === 'full-suite-validation' && step.exitCode === 0));
                assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode), ['code:FULL', 'test:FULL']);
            }
        };
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const result = await walkTask(template, scenario);
            assert.equal(result.outcome, 'done', `${result.detail}\n${result.steps.map(step => `${step.gate}:${step.exitCode}`).join(' > ')}`);
        } finally {
            removeWalkDirectory(template);
        }
    });

test('field-cases are permanent full/sweep scenarios with two own modules and independent result oracles', () => {
    assert.equal(FIELD_CASE_SCENARIOS.length, 7 + R144_FIELD_CASE_IDS.length);
    assert.ok(!new Set<string>(FIELD_CASE_IDS).has('field-onlinestore-t006-6'));
    assert.match(FIELD_LEGACY_GARDA_COMMIT, /^[a-f0-9]{40}$/u);
    assert.match(FIELD_LEGACY_GARDA_TREE, /^[a-f0-9]{40}$/u);
    assert.deepEqual(walkRunPlan({ GARDA_SYNTHETIC_WALK_ONLY: 'field-cases', GARDA_SYNTHETIC_WALK_LEVEL: 'full' },
        WALK_SCENARIOS.map(item => item.id)).only, [...FIELD_CASE_IDS]);
    for (const level of ['full', 'sweep']) {
        const plan = walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: level }, WALK_SCENARIOS.map(item => item.id));
        for (const id of FIELD_CASE_IDS) assert.ok(plan.scenarioIds.includes(id), id);
    }
    for (const scenario of FIELD_CASE_SCENARIOS) {
        if ((R144_FIELD_CASE_IDS as readonly string[]).includes(scenario.id)) {
            // Each final-review defect keeps its source finding, an independent result oracle and an exact review contract.
            assert.match(scenario.disturbanceReason ?? '', /^R\d-\d/u, scenario.id);
            assert.ok(scenario.inspectResult, scenario.id);
            assert.equal(Object.values(scenario.expectedReviews).reduce((sum, count) => sum + count, 0), scenario.expectedModes.length, scenario.id);
            continue;
        }
        if (scenario.id === 'field-onlinestore-t022-1-closeout') {
            assert.ok(scenario.inspectResult && scenario.enforceReviewExpectations);
            assert.deepEqual(scenario.expectedModes.slice(-3), ['security:FULL', 'refactor:DELTA', 'test:DELTA']);
            continue;
        }
        if (scenario.id === 'field-onlinestore-t006-7-1-audit-only') {
            assert.ok(scenario.inspectNavigation && scenario.inspectResult);
            assert.deepEqual(scenario.expectedModes, ['test:FULL']);
            continue;
        }
        if (scenario.id === 'field-onlinestore-passed-delta-after-test-repair') {
            assert.deepEqual(scenario.expectedReviews, { code: 2, api: 2, test: 2 });
            assert.equal(scenario.remediationSequence?.length, 2);
            assert.ok(scenario.inspectResult);
            continue;
        }
        assert.equal(scenario.counterState, FIELD_TWO_MODULE_COUNTER_STATE);
        assert.ok(scenario.inspectResult); assert.equal(scenario.expectedBlockedGate, undefined);
        assert.equal(scenario.selectionTargets?.length, 2);
        assert.match(scenario.fixture!.files['pom.xml'], /<relativePath\/>/u);
        assert.match(scenario.fixture!.files['pom.xml'], /jacoco-maven-plugin.*<excludes>/u);
        assert.match(scenario.fixture!.files['pom.xml'], /<module>a<\/module><module>b<\/module>/u);
        assert.match(scenario.fixture!.taskTestCommand, /-Dtest=A,B/u);
        assert.deepEqual(scenario.expectedModes, ['code:FULL', 'test:FULL']);
    }
});

test('field command argv keeps both module and test lists as exact tokens, including the Windows cmd entrypoint', () => {
    const fixture = FIELD_CASE_SCENARIOS[0].fixture!;
    const [argv] = parseCommandChain(fixture.taskTestCommand);
    assert.ok(argv.includes('a,b')); assert.ok(argv.includes('-Dtest=A,B'));
    assert.match(fixture.files['mvnw.cmd'], /%\*/u);
    assert.equal(argv[0].endsWith('.cmd'), process.platform === 'win32');
    const [caret] = parseCommandChain(FIELD_CASE_SCENARIOS.find(item => item.id === 'field-cmd-call-argv')!.fixture!.taskTestCommand);
    assert.ok(caret.includes('-Dstand.literal=left^&right'));
});

test('field CALL negative control: quoted caret and ampersand reach the real Windows child unchanged', async () => {
    assert.doesNotMatch(buildWindowsBatchCommandLine('C:\\fixture\\runner.cmd', ['left^&right']), /\bcall\b/iu);
    // Other operating systems still check command construction; the report explicitly limits native OS claims.
    if (process.platform !== 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-field-argv-'));
    try {
        const executable = path.join(root, 'runner.cmd');
        fs.writeFileSync(executable, '@echo off\r\n"' + process.execPath + '" "' + path.join(root, 'argv.cjs') + '" %*\r\n');
        fs.writeFileSync(path.join(root, 'argv.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
        const argv = ['a,b', '-Dtest=A,B', 'left^&right', 'two words'];
        const result = await spawnShellCommand(executable, argv, { cwd: root, timeoutMs: 10000 });
        assert.equal(result.exitCode, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout.trim()), argv);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('selection input contract rejects traversal and junction escape before reading target bytes', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stand-contained-'));
    try {
        const root = path.join(parent, 'repo'), outside = path.join(parent, 'outside');
        fs.mkdirSync(root); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'target.case'), 'external assertion');
        assert.throws(() => readValidationFile(root, '../outside/target.case'), /inside|relative|travers|contain/iu);
        fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => readValidationFile(root, 'linked/target.case'), /symlink|junction|inside|contain/iu);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('two-module field calibration preserves every old profile and keeps work constant with five extra events', () => {
    const baseline = calibrationCounterBaseline('tests/node/synthetic', JSON.parse(fs.readFileSync('tests/node/synthetic/walk-counter-baseline.json', 'utf8')), 'win32');
    const states = baseline.states;
    assert.ok(states);
    const evidence = JSON.parse(fs.readFileSync('tests/node/synthetic/field-spring-two-module-calibration.json', 'utf8'));
    const apiEvidence = JSON.parse(fs.readFileSync('tests/node/synthetic/api-counter-calibration-evidence.json', 'utf8')) as { previousRouteNames: string[] };
    const nativeShapes = JSON.parse(fs.readFileSync('tests/node/synthetic/native-counter-input-shapes.json', 'utf8')) as { shapes: Array<{ id: string }> };
    const independentlyAccepted = new Set(['native-api-selected-initial', 'native-api-selected-remediation', ...nativeShapes.shapes.map(shape => shape.id)]);
    // Keep the original fingerprint unchanged; later independently sealed additions are not part of that historical input set.
    const oldRoutes = Object.fromEntries(Object.entries(baseline.routes as Record<string, Record<string, unknown>>)
        .filter(([id]) => apiEvidence.previousRouteNames.includes(id))
        .map(([id, metrics]) => [id, Object.fromEntries(Object.entries(metrics).filter(([metric]) => metric !== 'subprocess:powershell.exe'))]));
    const oldStates = Object.fromEntries(Object.entries(states).filter(([id]) => id !== FIELD_TWO_MODULE_COUNTER_STATE && !independentlyAccepted.has(id)));
    assert.equal(createHash('sha256').update(JSON.stringify({ routes: oldRoutes, states: oldStates })).digest('hex'), evidence.old_profiles_sha256);
    assert.equal(states[FIELD_TWO_MODULE_COUNTER_STATE].inherits, evidence.parent_state);
    assert.deepEqual(evidence.controls.map((control: { modules: number; changed_files: string[] }) => [control.modules, control.changed_files.length]), [[1, 2], [2, 4]]);
    const metrics = ['file_hash:file', 'file_probes:realpathSync', 'file_probes:fstatSync', 'file_probes:lstatSync'];
    for (const control of evidence.controls) {
        assert.equal(control.history_control.events_added, 5);
        for (const key of metrics) assert.equal(control.history_control.after[key], control.history_control.before[key]);
    }
    assert.equal(evidence.controls[1].history_control.before['file_hash:file'] - evidence.controls[0].history_control.before['file_hash:file'], 2);
    assert.equal(fieldSpringScenario('single-module-control', 1).selectionTargets!.length, 1);
    for (const counters of Object.values(states[FIELD_TWO_MODULE_COUNTER_STATE].routes) as Array<Record<string, { tolerance: number; growthTolerance: number }>>) {
        for (const [key, budget] of Object.entries(counters)) {
            assert.ok(!key.startsWith('subprocess:'));
            assert.equal(budget.tolerance, 0);
            assert.equal(budget.growthTolerance, 0);
        }
    }
});
