import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatNextStepCompactText, formatNextStepText } from '../../../../src/gates/next-step/next-step-command-formatters';
import { projectNextStepJson } from '../../../../src/gates/next-step/next-step-recommended-action';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import { resolveNextStep, type NextStepResult } from '../../../../src/gates/next-step';
import {
    attachNextStepCommandExecution,
    readNextStepCommandExecution,
    type NextStepCommandOperation
} from '../../../../src/gates/next-step/next-step-command-execution';
import { buildCommand, quoteCommandValue } from '../../../../src/gates/next-step/next-step-command-formatters';
import {
    buildCompileGateInvocation,
    buildPostPreflightRulePackBindInvocation,
    buildQualityChecklistInvocation,
    buildReviewContextArguments
} from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';
import {
    resolveNextStepCompileGateRoute,
    resolveNextStepQualityChecklistRoute,
    type NextStepCompileGateRoutingOptions
} from '../../../../src/gates/next-step/next-step-pre-review-routing';
import { selectTaskCompositeAction } from '../../../../src/cli/commands/task-composite/task-composite-actions';
import { TASK_TEST_SELECTION_STOP_REASON } from '../../../../src/gates/next-step/next-step-composite-action';
import { resolveDeclaredValidationDecisionRoute } from '../../../../src/gates/next-step/next-step-validation-routes';
import { resolveTestSelectionRoute } from '../../../../src/gates/next-step/next-step-full-suite-routing';
import { runGit } from './gate-test-helpers';
import {
    PROVIDER_ARGS,
    TASK_ID,
    cli,
    createCompositeFixture,
    runPrintedCommand,
    timelineEvents,
    writeTaskEdit,
    type CompositeFixture
} from './task-composite-test-fixture';

const PREFLIGHT = `${DEFAULT_BUNDLE_NAME}/runtime/reviews/${TASK_ID}-preflight.json`;
const PREFLIGHT_GATE_ARGUMENTS = { task_id: TASK_ID, preflight_path: PREFLIGHT, task_mode_path: null };
const VALIDATION_TO_REVIEWER_GATES = [
    'task-test-validation', 'build-review-context', 'record-review-routing', 'prepare-reviewer-launch'
] as const;
const SELECTION_REASON = `${TASK_ID} verifies src/app.ts: regression tests/app.test.cjs covers the exported constants of src/app.ts`;

interface CompositeJson {
    outcome: string;
    completed: { gate: string; output_lines: string[] }[];
    failed: { gate: string } | null;
    stop: { kind: string; reason: string } | null;
    next: { next_gate: string } | null;
    counters: Record<string, number>;
}

let fixture: CompositeFixture;

/** A clone with task tests enabled and a task test file, committed so task entry sees a clean workspace. */
async function cloneWithTaskTests(): Promise<string> {
    const repoRoot = fixture.clone();
    fs.writeFileSync(path.join(repoRoot, 'scripts', 'suite-check.cjs'), 'console.log("suite ok");\n', 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.cjs'), 'console.log("app ok");\n', 'utf8');
    const configured = await cli(repoRoot, ['workflow', 'set', '--target-root', '.', '--full-suite-command',
        'node scripts/suite-check.cjs', '--full-suite-enabled', 'true', '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', new Date().toISOString()]);
    assert.equal(configured.exitCode, 0, configured.text);
    runGit(repoRoot, ['add', '-A']);
    runGit(repoRoot, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'task tests']);
    return repoRoot;
}

function fillQualityAnswers(repoRoot: string): void {
    const answersPath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'tmp', `${TASK_ID}-quality-checklist-answers.json`);
    const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as { answers: { status: string; answer: string }[] };
    for (const answer of template.answers) {
        answer.status = 'PASS';
        answer.answer = 'The fixture edit adds one exported constant without new structure or contracts.';
    }
    fs.writeFileSync(answersPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
}

function writeSecondEdit(repoRoot: string): void {
    fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const again = "again";\n', 'utf8');
}

async function selectTaskTests(repoRoot: string): Promise<void> {
    const selected = await cli(repoRoot, ['workflow', 'set', '--task-test-command', 'node tests/app.test.cjs',
        '--focused-required-test-path', 'tests/app.test.cjs', '--task-id', TASK_ID, '--reason', SELECTION_REASON,
        '--target-root', '.']);
    assert.equal(selected.exitCode, 0, selected.text);
}

async function advance(repoRoot: string): Promise<CompositeJson & { exitCode: number }> {
    const result = await cli(repoRoot, ['task', TASK_ID, 'advance', '--as-json']);
    return { ...(JSON.parse(result.text) as CompositeJson), exitCode: result.exitCode };
}

function gates(result: CompositeJson): string[] {
    return result.completed.map((step) => step.gate);
}

async function assertRetryStaysSingleStep(repoRoot: string): Promise<void> {
    const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
    assert.equal(projectNextStepJson(result).recommended_action, undefined);
    const compact = formatNextStepCompactText(result);
    const verbose = formatNextStepText(result);
    assert.doesNotMatch(compact + verbose, /Run mechanical steps|Single-step alternative:/u);
    for (const command of result.commands) {
        assert.ok(compact.includes(command.command));
        assert.ok(verbose.includes(command.command), 'the retry or recovery command is still reachable');
    }
    const json = await cli(repoRoot, ['next-step', TASK_ID, '--as-json']);
    assert.equal(JSON.parse(json.text).recommended_action, undefined);
}

/** Starts the task and runs the startup to the POST_PREFLIGHT rules, recording the rules like the agent would. */
async function reachImplementedScope(repoRoot: string): Promise<void> {
    assert.equal((await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
    await runPrintedCommand(repoRoot, 'load-rule-pack');
    writeTaskEdit(repoRoot);
    const startup = await advance(repoRoot);
    assert.equal(startup.next?.next_gate, 'load-rule-pack');
    await runPrintedCommand(repoRoot, 'load-rule-pack');
}

function readJson(repoRoot: string, name: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', name), 'utf8')) as Record<string, unknown>;
}

function navigatorResult(commands: NextStepResult['commands']): NextStepResult {
    return {
        status: 'BLOCKED', next_gate: 'gate', title: 'title', reason: 'reason', commands,
        navigator_command: `node bin/garda.js next-step "${TASK_ID}" --repo-root "."`
    } as NextStepResult;
}

function compileOptions(overrides: Partial<NextStepCompileGateRoutingOptions> = {}): NextStepCompileGateRoutingOptions {
    return {
        ready: false, reason: 'Compile evidence is missing.', compileGatePassed: false,
        restartTaskModeCommand: 'restart', refreshPreflightCommand: 'refresh', compileCommand: 'compile',
        compileArguments: PREFLIGHT_GATE_ARGUMENTS, ...overrides
    };
}

describe('task <id> advance from an implemented scope to the reviewer boundary', { concurrency: false }, () => {
    before(async () => { fixture = await createCompositeFixture(); });
    after(() => fixture.dispose());

    it('runs only Garda-derived steps and stops at every agent input before the reviewer launch', async () => {
        const repoRoot = await cloneWithTaskTests();
        await reachImplementedScope(repoRoot);

        writeSecondEdit(repoRoot);
        const refreshed = await advance(repoRoot);
        assert.deepEqual(gates(refreshed), ['classify-change', 'next-step-effect'],
            'the unchanged rule pack is rebound inside the classify-change step, not as a separate step');
        assert.ok(refreshed.completed[0].output_lines.includes('RULE_PACK_BOUND'));
        assert.equal(refreshed.next?.next_gate, 'quality-checklist');
        assert.equal(refreshed.stop?.kind, 'agent', 'the quality answers stay with the agent');
        assert.equal((await advance(repoRoot)).completed.length, 0, 'unanswered checklist: nothing runs');

        fillQualityAnswers(repoRoot);
        const compiled = await advance(repoRoot);
        assert.deepEqual(gates(compiled), ['quality-checklist', 'compile-gate']);
        assert.equal(compiled.next?.next_gate, 'task-test-selection', 'choosing the tests is never filled in');
        assert.equal(compiled.stop?.kind, 'agent', 'test selection is a classified agent decision');
        assert.match(compiled.stop?.reason || '', /Select the task tests first.*run exactly the selected command/su);

        await selectTaskTests(repoRoot);
        const prepared = await advance(repoRoot);
        assert.equal(prepared.exitCode, 0);
        assert.deepEqual(gates(prepared), [...VALIDATION_TO_REVIEWER_GATES]);
        assert.equal(prepared.next?.next_gate, 'record-reviewer-delegation-started');
        assert.equal(prepared.stop?.kind, 'agent', JSON.stringify(prepared.stop));
        assert.deepEqual(prepared.counters, {
            agent_invocations: 1, navigator_resolutions: 5, subgates_attempted: 4, subgates_succeeded: 4, effects_executed: 0
        });
        const events = timelineEvents(repoRoot);
        assert.ok(events.includes('FULL_SUITE_VALIDATION_PASSED:PASS'));
        assert.ok(events.includes('REVIEW_PHASE_STARTED:INFO'));
        assert.equal(events.some((entry) => entry.startsWith('REVIEWER_DELEGATION_STARTED')), false, 'no reviewer launch');
        assert.equal((await advance(repoRoot)).completed.length, 0, 'the boundary is stable: nothing reruns');
    });

    it('the first task test run of a rework cycle stays mechanical beside the artifact of the earlier cycle', async () => {
        const repoRoot = await cloneWithTaskTests();
        await reachImplementedScope(repoRoot);
        writeSecondEdit(repoRoot);
        await advance(repoRoot);
        fillQualityAnswers(repoRoot);
        await advance(repoRoot);
        await selectTaskTests(repoRoot);
        assert.deepEqual(gates(await advance(repoRoot)), [...VALIDATION_TO_REVIEWER_GATES]);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const rework = "rework";\n', 'utf8');
        await runPrintedCommand(repoRoot, 'restart-coherent-cycle');
        await advance(repoRoot);
        fillQualityAnswers(repoRoot);
        await advance(repoRoot);
        await selectTaskTests(repoRoot);
        const route = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(route.next_gate, 'full-suite-validation', JSON.stringify(route.reason));
        assert.deepEqual(readNextStepCommandExecution(route.commands[0])?.operation,
            { operation_id: 'task-test-validation', arguments: { task_id: TASK_ID, preflight_path: PREFLIGHT } },
            'an earlier cycle artifact is no run of this cycle');
        assert.deepEqual(gates(await advance(repoRoot)).slice(0, 1), ['task-test-validation']);
        assert.equal(timelineEvents(repoRoot).filter((entry) => entry.startsWith('FULL_SUITE_VALIDATION_')).length, 2);
    });

    it('a task test artifact rejected for process evidence is rerun by the agent, never by advance', async () => {
        const repoRoot = await cloneWithTaskTests();
        await reachImplementedScope(repoRoot);
        writeSecondEdit(repoRoot);
        await advance(repoRoot);
        fillQualityAnswers(repoRoot);
        await advance(repoRoot);
        await selectTaskTests(repoRoot);
        const selected = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.deepEqual(readNextStepCommandExecution(selected.commands[0])?.operation,
            { operation_id: 'task-test-validation', arguments: { task_id: TASK_ID, preflight_path: PREFLIGHT } },
            'the first run of the recorded selection is mechanical');
        assert.deepEqual(gates(await advance(repoRoot)), [...VALIDATION_TO_REVIEWER_GATES]);

        const artifactPath = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-full-suite-validation.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        const damaged = { ...artifact, task_test_process_evidence: { invocations: [] } };
        fs.writeFileSync(artifactPath, `${JSON.stringify(damaged, null, 2)}\n`, 'utf8');
        const rejected = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(rejected.next_gate, 'full-suite-validation');
        assert.match(rejected.commands[0].command, /gate task-test-validation/u);
        assert.equal(readNextStepCommandExecution(rejected.commands[0]), null, 'a rejected current-cycle artifact is no first run');
        const stopped = await advance(repoRoot);
        assert.deepEqual(gates(stopped), []);
        assert.equal(stopped.stop?.kind, 'unclassified');
        assert.equal(timelineEvents(repoRoot).filter((entry) => entry.startsWith('FULL_SUITE_VALIDATION_')).length, 1);
    });

    it('records the same ordered events and evidence bindings as the individual commands', async () => {
        const individual = await cloneWithTaskTests();
        await reachImplementedScope(individual);
        writeSecondEdit(individual);
        for (const gate of ['classify-change', 'next-step-effect']) {
            await runPrintedCommand(individual, gate);
        }
        fillQualityAnswers(individual);
        await runPrintedCommand(individual, 'quality-checklist');
        await runPrintedCommand(individual, 'compile-gate');
        await selectTaskTests(individual);
        await runPrintedCommand(individual, 'full-suite-validation');
        await runPrintedCommand(individual, 'build-review-context');
        await runPrintedCommand(individual, 'record-review-routing');
        await runPrintedCommand(individual, 'prepare-reviewer-launch');

        const composite = await cloneWithTaskTests();
        await reachImplementedScope(composite);
        writeSecondEdit(composite);
        await advance(composite);
        fillQualityAnswers(composite);
        await advance(composite);
        await selectTaskTests(composite);
        await advance(composite);

        assert.deepEqual(timelineEvents(composite), timelineEvents(individual));
        const preflight = (root: string) => readJson(root, `${TASK_ID}-preflight.json`);
        for (const key of ['changed_files', 'required_reviews', 'path_mode', 'detection_source']) {
            assert.deepEqual(preflight(composite)[key], preflight(individual)[key], key);
        }
        // Only the temporary workspace root may differ.
        const context = (root: string): Record<string, unknown> => {
            const payload = readJson(root, `${TASK_ID}-code-review-context.json`);
            return { ...payload, preflight_path: path.relative(root, String(payload.preflight_path)) };
        };
        for (const key of ['review_type', 'preflight_path', 'schema_version']) {
            assert.deepEqual(context(composite)[key], context(individual)[key], key);
        }
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot: composite }).next_gate,
            resolveNextStep({ taskId: TASK_ID, repoRoot: individual }).next_gate);
    });

    it('a failed compile stops the chain and is never retried by advance for the same preflight', async () => {
        const repoRoot = await cloneWithTaskTests();
        await reachImplementedScope(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'scripts', 'build-check.cjs'), 'process.exit(1);\n', 'utf8');
        await advance(repoRoot);
        fillQualityAnswers(repoRoot);
        const failed = await advance(repoRoot);
        assert.equal(failed.outcome, 'FAILED');
        assert.equal(failed.failed?.gate, 'compile-gate');
        assert.deepEqual(gates(failed), ['quality-checklist']);
        const resumed = await advance(repoRoot);
        assert.equal(resumed.outcome, 'STOPPED');
        assert.equal(resumed.next?.next_gate, 'compile-gate');
        assert.equal(resumed.completed.length, 0, 'the agent fixes the failure or reruns the printed command itself');
        await assertRetryStaysSingleStep(repoRoot);
        assert.equal(timelineEvents(repoRoot).filter((entry) => entry.startsWith('COMPILE_GATE_FAILED')).length, 1);
    });

    it('a failing task test run stops the chain and is never retried by advance', async () => {
        const repoRoot = await cloneWithTaskTests();
        await reachImplementedScope(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.cjs'), 'process.exit(1);\n', 'utf8');
        await advance(repoRoot);
        fillQualityAnswers(repoRoot);
        await advance(repoRoot);
        await selectTaskTests(repoRoot);
        const failed = await advance(repoRoot);
        assert.equal(failed.outcome, 'FAILED');
        assert.equal(failed.failed?.gate, 'task-test-validation');
        assert.equal(failed.completed.length, 0);
        assert.notEqual(failed.exitCode, 0);
        const resumed = await advance(repoRoot);
        assert.equal(resumed.outcome, 'STOPPED');
        assert.equal(resumed.completed.length, 0, 'a failed run needs the agent: repair, reselect or materialize');
        await assertRetryStaysSingleStep(repoRoot);
        assert.equal(timelineEvents(repoRoot).filter((entry) => entry.startsWith('FULL_SUITE_VALIDATION_')).length, 1);
        assert.equal(timelineEvents(repoRoot).includes('REVIEW_PHASE_STARTED:INFO'), false);
    });
});

describe('typed validation descriptors', () => {
    it('command builders derive the typed arguments from the values they render', () => {
        const repoRoot = path.resolve('.');
        const compile = buildCompileGateInvocation(repoRoot, 'node bin/garda.js', TASK_ID, PREFLIGHT, null);
        assert.equal(compile.command, `node bin/garda.js gate compile-gate --task-id "${TASK_ID}" --preflight-path "${PREFLIGHT}" --repo-root "."`);
        assert.deepEqual(compile.arguments, PREFLIGHT_GATE_ARGUMENTS);
        const bind = buildPostPreflightRulePackBindInvocation(repoRoot, 'node bin/garda.js', TASK_ID, null);
        assert.match(bind.command, /gate bind-rule-pack-to-preflight --task-id "T-COMPOSITE-1" --preflight-path "[^"]+-preflight\.json"/u);
        assert.equal(bind.arguments.task_id, TASK_ID);
        assert.ok(bind.command.includes(`--preflight-path "${bind.arguments.preflight_path}"`));
        assert.deepEqual(buildReviewContextArguments(repoRoot, TASK_ID, 'code', 2, PREFLIGHT, null),
            { ...PREFLIGHT_GATE_ARGUMENTS, review_type: 'code', depth: 2 });
        assert.deepEqual(buildQualityChecklistInvocation(repoRoot, 'node bin/garda.js', TASK_ID, PREFLIGHT, null,
            path.join(repoRoot, 'missing-answers.json')), { command: '', arguments: null }, 'no answers: no command, no operation');
    });

    it('only the plain compile route is mechanical; routes that need agent input stay stops', () => {
        const plain = resolveNextStepCompileGateRoute(compileOptions());
        assert.deepEqual(readNextStepCommandExecution(plain!.commands[0])?.operation,
            { operation_id: 'compile-gate', arguments: PREFLIGHT_GATE_ARGUMENTS });
        for (const overrides of [
            { planDriftExtraFiles: ['src/extra.ts'] },
            { compileCommandUnconfigured: true },
            { compileCommandUnconfigured: true, retryStoredCompileCommand: true },
            { recoveryGate: 'classify-change' as const },
            { recoveryGate: 'enter-task-mode' as const },
            { compileArguments: null }
        ]) {
            const route = resolveNextStepCompileGateRoute(compileOptions(overrides));
            assert.ok(route, JSON.stringify(overrides));
            assert.ok(route.commands.every((command) => readNextStepCommandExecution(command) === null), JSON.stringify(overrides));
        }
    });

    it('a quality checklist is mechanical only after the agent completed valid answers', () => {
        const commandArguments = { task_id: TASK_ID, preflight_path: PREFLIGHT, answers_path: 'answers.json' };
        const base = {
            enabled: true, required: true, ready: false, reason: 'Missing.', status: null,
            answersTemplatePath: 'answers.json', command: 'quality', commandArguments
        };
        const complete = resolveNextStepQualityChecklistRoute(base);
        assert.deepEqual(readNextStepCommandExecution(complete!.commands[0])?.operation,
            { operation_id: 'quality-checklist', arguments: commandArguments });
        assert.deepEqual(resolveNextStepQualityChecklistRoute({ ...base, command: '', commandArguments: null })?.commands, []);
        const repair = resolveNextStepQualityChecklistRoute({ ...base, ready: true, status: 'CONFIG_ERROR' });
        assert.equal(readNextStepCommandExecution(repair!.commands[0]), null);
        const actionRequired = resolveNextStepQualityChecklistRoute({ ...base, ready: true, status: 'ACTION_REQUIRED' });
        assert.deepEqual([actionRequired?.nextGate, actionRequired?.commands], ['implementation', []]);
    });

    it('a fresh run of rejected validation evidence carries the bound check; a commandless rejection stays a stop', () => {
        const rejection = 'Foreign or stale execution facts.';
        const hint = { command: 'node tests/app.test.cjs', cases: [{ source: 'tests/app.test.cjs', case_id: 'c1', selector: 'c1' }],
            reports: [] };
        const native = resolveDeclaredValidationDecisionRoute({ cliPrefix: 'node bin/garda.js', taskId: TASK_ID, preflightPath: PREFLIGHT,
            readiness: { validationRejection: rejection, validationRecovery: { kind: 'native', hint, preflightPath: PREFLIGHT } } as never });
        assert.equal(native?.nextGate, 'project-validation-evidence');
        const nativeOperation = readNextStepCommandExecution(native!.commands![0])?.operation;
        assert.deepEqual(nativeOperation, { operation_id: 'run-intermediate-command', arguments: {
            task_id: TASK_ID, recipe_id: null, command: hint.command, command_source: 'targeted-test', preflight_path: PREFLIGHT,
            selected_cases: [JSON.stringify(hint.cases[0])], report_files: [] } });
        assert.ok(native!.commands![0].command.includes(`--selected-case ${quoteCommandValue(JSON.stringify(hint.cases[0]))}`));
        const recipe = resolveDeclaredValidationDecisionRoute({ cliPrefix: 'node bin/garda.js', taskId: TASK_ID, preflightPath: PREFLIGHT,
            readiness: { validationRejection: rejection, validationRecovery: { kind: 'recipe', recipeId: 'unit' } } as never });
        assert.deepEqual(readNextStepCommandExecution(recipe!.commands![0])?.operation?.arguments,
            { task_id: TASK_ID, recipe_id: 'unit', command: null, command_source: null, preflight_path: null,
                selected_cases: [], report_files: [] });
        const bare = resolveDeclaredValidationDecisionRoute({ cliPrefix: 'node bin/garda.js', taskId: TASK_ID, preflightPath: PREFLIGHT,
            readiness: { validationRejection: rejection } as never });
        // Without structural facts no run is guessed: an explicit operator decision, never an unmarked stop.
        assert.deepEqual([bare?.nextGate, bare?.commands, bare?.decision], ['project-validation-evidence', [], 'operator']);
        assert.equal(selectTaskCompositeAction(navigatorResult(native!.commands!), 'advance', null).kind, 'execute');
    });

    it('task test selection is a typed agent stop that names the reuse of the selected run', () => {
        const route = resolveTestSelectionRoute({ testSelectionViolations: ['No selection.'], testSelectionCommand: 'select',
            testSelectionRequiresConfirmation: false, testSelectionReconfirmsPrevious: false });
        assert.deepEqual(readNextStepCommandExecution(route!.commands[0]), { boundary: 'agent', operation: null, rendered_command: 'select' });
        const action = selectTaskCompositeAction({ ...navigatorResult(route!.commands), next_gate: 'task-test-selection' }, 'advance', null);
        assert.deepEqual(action, { kind: 'stop', stop: 'agent', reason: TASK_TEST_SELECTION_STOP_REASON });
    });

    it('the runner executes each validation operation only under a mechanical descriptor', () => {
        const operations: NextStepCommandOperation[] = [
            { operation_id: 'bind-rule-pack-to-preflight', arguments: PREFLIGHT_GATE_ARGUMENTS },
            { operation_id: 'quality-checklist', arguments: { task_id: TASK_ID, preflight_path: PREFLIGHT, answers_path: 'a.json' } },
            { operation_id: 'compile-gate', arguments: PREFLIGHT_GATE_ARGUMENTS },
            { operation_id: 'task-test-validation', arguments: { task_id: TASK_ID, preflight_path: PREFLIGHT } },
            { operation_id: 'build-review-context', arguments: { ...PREFLIGHT_GATE_ARGUMENTS, review_type: 'code', depth: 2 } },
            { operation_id: 'record-review-routing', arguments: { task_id: TASK_ID, review_type: 'code', task_mode_path: null } },
            { operation_id: 'run-intermediate-command', arguments: { task_id: TASK_ID, recipe_id: 'unit', command: null,
                command_source: null, preflight_path: null, selected_cases: [], report_files: [] } }
        ];
        for (const operation of operations) {
            const mechanical = attachNextStepCommandExecution(buildCommand('m', `m ${operation.operation_id}`), 'mechanical', operation);
            assert.deepEqual(selectTaskCompositeAction(navigatorResult([mechanical]), 'advance', null),
                { kind: 'execute', gate: operation.operation_id, operation });
            for (const boundary of ['agent', 'operator'] as const) {
                const declared = attachNextStepCommandExecution(buildCommand('d', `d ${operation.operation_id}`), boundary, operation);
                assert.deepEqual(selectTaskCompositeAction(navigatorResult([declared]), 'advance', null).kind, 'stop', boundary);
            }
        }
    });
});
