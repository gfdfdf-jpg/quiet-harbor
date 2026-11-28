import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveNextStepStartupRoute,
    type NextStepStartupRouteOptions
} from '../../../../src/gates/next-step/next-step-startup-routing';
import { resolveClassifyDecisionRoute } from '../../../../src/gates/next-step/next-step-decision-route-groups';
import {
    attachNextStepCommandExecution,
    carryNextStepCommandExecution,
    readNextStepCommandExecution,
    type NextStepCommandOperation
} from '../../../../src/gates/next-step/next-step-command-execution';
import { buildCommand } from '../../../../src/gates/next-step/next-step-command-formatters';
import { buildScopedDiffStepCommand } from '../../../../src/gates/next-step/next-step-review-command-builders';
import type { NextStepResult } from '../../../../src/gates/next-step';
import {
    SAFE_EXIT_LABEL,
    applyNextStepSafeExit,
    type NextStepRouteDecision
} from '../../../../src/gates/next-step/next-step-progress-invariant';
import { formatTaskCompositeText } from '../../../../src/cli/commands/task-composite/task-composite-command';
import {
    executeTaskCompositeOperation,
    selectTaskCompositeAction,
    type TaskCompositeEntryInputs
} from '../../../../src/cli/commands/task-composite/task-composite-actions';
import {
    runTaskComposite,
    TASK_COMPOSITE_MAX_SUBGATES
} from '../../../../src/cli/commands/task-composite/task-composite-runner';

const TASK_ID = 'T-1';
const ENTRY_INPUTS: TaskCompositeEntryInputs = {
    provider: 'Codex', routedTo: null, requestedDepth: null, taskSummary: null, plannedChangedFiles: [],
    orchestratorWork: false, workflowConfigWork: false, operatorConfirmed: null, operatorConfirmedAtUtc: null
};

function startupOptions(overrides?: Partial<NextStepStartupRouteOptions>): NextStepStartupRouteOptions {
    return {
        taskId: TASK_ID,
        enterTaskModePassed: true,
        defaultExecutionProvider: 'Codex',
        enterTaskModeCommand: 'node bin/garda.js gate enter-task-mode --task-id "T-1"',
        startupCycleReadiness: { ready: true, nextGate: 'none', title: 'ready', reason: 'ready' },
        loadRulePackPassed: true,
        rulePackStage: 'TASK_ENTRY',
        preflightExists: false,
        taskEntryRulePackCommand: 'node bin/garda.js gate load-rule-pack --task-id "T-1"',
        handshakeDiagnosticsPassed: true,
        handshakeDiagnosticsCommand: 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"',
        shellSmokePreflightPassed: true,
        shellSmokePreflightCommand: 'node bin/garda.js gate shell-smoke-preflight --task-id "T-1"',
        ...overrides
    };
}

function startupExecution(overrides: Partial<NextStepStartupRouteOptions>) {
    const route = resolveNextStepStartupRoute(startupOptions(overrides));
    assert.ok(route);
    assert.equal(route.commands.length, 1);
    return { route, execution: readNextStepCommandExecution(route.commands[0]) };
}

function navigatorResult(commands: NextStepResult['commands'], overrides: Partial<NextStepResult> = {}): NextStepResult {
    return {
        task_id: TASK_ID, status: 'BLOCKED', next_gate: 'gate', title: 'title', reason: 'reason', commands,
        navigator_command: 'node bin/garda.js next-step "T-1" --repo-root "."', ...overrides
    } as NextStepResult;
}

function mechanical(operation: NextStepCommandOperation, command = `cmd ${operation.operation_id}`) {
    return attachNextStepCommandExecution(buildCommand(operation.operation_id, command), 'mechanical', operation);
}

test('startup handshake and shell smoke carry typed mechanical operations bound to the task', () => {
    const handshake = startupExecution({ handshakeDiagnosticsPassed: false });
    assert.equal(handshake.execution?.boundary, 'mechanical');
    assert.deepEqual(handshake.execution?.operation, { operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } });
    const shell = startupExecution({ shellSmokePreflightPassed: false });
    assert.deepEqual(shell.execution?.operation, { operation_id: 'shell-smoke-preflight', arguments: { task_id: TASK_ID } });
    const readiness = startupExecution({
        startupCycleReadiness: { ready: false, nextGate: 'handshake-diagnostics', title: 't', reason: 'r' }
    });
    assert.equal(readiness.execution?.operation?.operation_id, 'handshake-diagnostics');
});

test('rule reading, approval and recovery routes are stop-only boundaries', () => {
    const rules = startupExecution({ loadRulePackPassed: false });
    assert.equal(rules.route.nextGate, 'load-rule-pack');
    assert.deepEqual([rules.execution?.boundary, rules.execution?.operation], ['agent', null]);
    const readinessRules = startupExecution({
        startupCycleReadiness: { ready: false, nextGate: 'load-rule-pack', title: 't', reason: 'r' }
    });
    assert.deepEqual([readinessRules.execution?.boundary, readinessRules.execution?.operation], ['agent', null]);
    const owners = startupExecution({ enterTaskModePassed: false, unapprovedActiveTaskOwners: ['T-9'] });
    assert.deepEqual([owners.execution?.boundary, owners.execution?.operation], ['operator', null]);
    const manifest = startupExecution({ protectedManifestRecovery: { kind: 'recovered', reason: 'r', command: 'retry' } });
    assert.deepEqual([manifest.execution?.boundary, manifest.execution?.operation], ['operator', null]);
    const adoption = startupExecution({
        profilePolicyAdoption: { reason: 'r', laneChanges: ['code'], unadoptableChanges: [], command: 'adopt' }
    });
    assert.deepEqual([adoption.execution?.boundary, adoption.execution?.operation], ['operator', null]);
    const restart = startupExecution({
        startupCycleReadiness: { ready: false, nextGate: 'restart-coherent-cycle', title: 't', reason: 'r' },
        coherentCycleRestartCommand: () => 'restart'
    });
    assert.equal(restart.execution, null);
});

test('fresh entry carries structured inputs while re-entry stays an agent-run command', () => {
    const entryArguments = { task_id: TASK_ID, entry_mode: 'EXPLICIT_TASK_EXECUTION', requested_depth: '2', task_summary: 'Summary' };
    const fresh = startupExecution({ enterTaskModePassed: false, enterTaskModeArguments: () => entryArguments });
    assert.equal(fresh.execution?.boundary, 'agent');
    assert.deepEqual(fresh.execution?.operation, { operation_id: 'enter-task-mode', arguments: entryArguments });
    const reentry = startupExecution({ enterTaskModePassed: false, enterTaskModeArguments: () => null });
    assert.deepEqual([reentry.execution?.boundary, reentry.execution?.operation], ['agent', null]);
    const foreign = startupExecution({
        enterTaskModePassed: false, enterTaskModeArguments: () => ({ ...entryArguments, task_id: 'T-2' })
    });
    assert.equal(foreign.execution?.operation, null);
});

test('startup commands carry no descriptor without a bound task id', () => {
    const route = resolveNextStepStartupRoute(startupOptions({ taskId: undefined, handshakeDiagnosticsPassed: false }));
    assert.ok(route);
    assert.equal(readNextStepCommandExecution(route.commands[0]), null);
});

test('replaced command text or a copied command loses its descriptor and never serializes', () => {
    const command = mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } });
    assert.deepEqual(JSON.parse(JSON.stringify(command)), { label: 'handshake-diagnostics', command: 'cmd handshake-diagnostics' });
    assert.equal(readNextStepCommandExecution({ ...command }), null);
    command.command = 'cmd handshake-diagnostics --other';
    assert.equal(readNextStepCommandExecution(command), null);
});

test('the fresh classify route binds typed arguments only when they are complete', () => {
    const classifyArguments = {
        task_id: TASK_ID, task_intent: 'Intent', changed_files: ['src/a.ts'], detection_source: null,
        use_staged: false, task_mode_path: null, output_path: 'garda-agent-orchestrator/runtime/reviews/T-1-preflight.json'
    };
    const route = (invocationArguments: typeof classifyArguments | null) => resolveClassifyDecisionRoute({
        preflightExists: false,
        classifyChangePassed: false,
        readFailedGateRecovery: () => null,
        resolveStrictDecompositionRoute: () => null,
        resolveProtectedScopeRoute: () => null,
        buildClassifyCommand: () => 'legacy',
        buildClassifyInvocation: () => ({ command: 'classify', arguments: invocationArguments })
    });
    const typed = route(classifyArguments);
    assert.equal(typed?.commands[0].command, 'classify');
    assert.deepEqual(readNextStepCommandExecution(typed!.commands[0])?.operation, {
        operation_id: 'classify-change', arguments: classifyArguments
    });
    assert.equal(readNextStepCommandExecution(route(null)!.commands[0]), null);
});

test('missing descriptors, choices, approvals and terminal states stop instead of executing', () => {
    const handshake = mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } });
    assert.equal(selectTaskCompositeAction(navigatorResult([handshake]), 'advance', null).kind, 'execute');
    const untyped = buildCommand('Run handshake diagnostics', 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"');
    assert.deepEqual(selectTaskCompositeAction(navigatorResult([untyped], { next_gate: 'handshake-diagnostics' }), 'advance', null),
        { kind: 'stop', stop: 'unclassified', reason: "The 'handshake-diagnostics' step has no typed execution descriptor." });
    assert.equal((selectTaskCompositeAction(navigatorResult([handshake, untyped]), 'advance', null) as { stop: string }).stop, 'agent');
    assert.equal((selectTaskCompositeAction(navigatorResult([]), 'advance', null) as { stop: string }).stop, 'agent');
    assert.equal((selectTaskCompositeAction(navigatorResult([handshake], { status: 'DONE' }), 'advance', null) as { stop: string }).stop,
        'terminal');
    assert.equal((selectTaskCompositeAction(navigatorResult([handshake], { status: 'SPLIT_REQUIRED' }), 'advance', null) as { stop: string })
        .stop, 'agent');
    const rules = attachNextStepCommandExecution(buildCommand('Load TASK_ENTRY rules', 'rules'), 'agent');
    assert.equal((selectTaskCompositeAction(navigatorResult([rules]), 'advance', null) as { stop: string }).stop, 'agent');
    const approval = attachNextStepCommandExecution(buildCommand('Approve', 'approve'), 'operator');
    assert.equal((selectTaskCompositeAction(navigatorResult([approval]), 'advance', null) as { stop: string }).stop, 'operator');
    const operatorHandshake = attachNextStepCommandExecution(buildCommand('h', 'h'), 'operator',
        { operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } });
    assert.equal((selectTaskCompositeAction(navigatorResult([operatorHandshake]), 'advance', null) as { stop: string }).stop, 'operator');
});

test('missing agent inputs block task-mode entry outside start', () => {
    const entry = attachNextStepCommandExecution(buildCommand('Enter task mode', 'enter'), 'agent', {
        operation_id: 'enter-task-mode',
        arguments: { task_id: TASK_ID, entry_mode: 'EXPLICIT_TASK_EXECUTION', requested_depth: '2', task_summary: 'Summary' }
    });
    assert.equal(selectTaskCompositeAction(navigatorResult([entry]), 'start', ENTRY_INPUTS).kind, 'execute');
    assert.equal((selectTaskCompositeAction(navigatorResult([entry]), 'advance', null) as { stop: string }).stop, 'agent');
    assert.equal((selectTaskCompositeAction(navigatorResult([entry]), 'start', null) as { stop: string }).stop, 'agent');
});

test('unclassified effect kinds are rejected before the expected-hash executor', () => {
    const effects = mechanical({
        operation_id: 'execute-next-step-effects',
        arguments: { task_id: TASK_ID, plan_sha256: 'a'.repeat(64), effect_kinds: ['kind-a', 'kind-b'] }
    });
    const shipped = selectTaskCompositeAction(navigatorResult([effects]), 'advance', null);
    assert.equal((shipped as { stop: string }).stop, 'unclassified');
    assert.match((shipped as { reason: string }).reason, /kind-a, kind-b/u);
    assert.equal((selectTaskCompositeAction(navigatorResult([effects]), 'advance', null, new Set(['kind-a'])) as { stop: string })
        .stop, 'unclassified');
    assert.equal(selectTaskCompositeAction(navigatorResult([effects]), 'advance', null, new Set(['kind-a', 'kind-b'])).kind, 'execute');
});

test('the runner re-resolves after every step and stops at the first boundary', async () => {
    const states = [
        navigatorResult([mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } })], { next_gate: 'handshake-diagnostics' }),
        navigatorResult([mechanical({ operation_id: 'shell-smoke-preflight', arguments: { task_id: TASK_ID } })], { next_gate: 'shell-smoke-preflight' }),
        navigatorResult([attachNextStepCommandExecution(buildCommand('Load rules', 'rules'), 'agent')], { next_gate: 'load-rule-pack' })
    ];
    let resolved = 0;
    const executed: string[] = [];
    const result = await runTaskComposite({
        taskId: TASK_ID, repoRoot: '.', mode: 'advance', entryInputs: null,
        resolve: () => states[resolved++],
        execute: async (operation) => { executed.push(operation.operation_id); return { passed: true, outputLines: ['OK'] }; }
    });
    assert.deepEqual(executed, ['handshake-diagnostics', 'shell-smoke-preflight']);
    assert.equal(result.outcome, 'STOPPED');
    assert.deepEqual(result.stop, { kind: 'agent', reason: "The 'load-rule-pack' step is an agent boundary." });
    assert.equal(result.next?.next_gate, 'load-rule-pack');
    assert.deepEqual(result.counters, {
        agent_invocations: 1, navigator_resolutions: 3, subgates_attempted: 2, subgates_succeeded: 2, effects_executed: 0
    });
});

test('the first failure ends the run with the failed gate and the completed prefix', async () => {
    const recovery = buildCommand('Inspect diagnostics', 'cmd repair --task-id T-1');
    const states = [
        navigatorResult([mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } })]),
        navigatorResult([mechanical({ operation_id: 'shell-smoke-preflight', arguments: { task_id: TASK_ID } })]),
        navigatorResult([recovery], { next_gate: 'repair' })
    ];
    let resolved = 0;
    const executed: string[] = [];
    const failing = await runTaskComposite({
        taskId: TASK_ID, repoRoot: '.', mode: 'advance', entryInputs: null,
        resolve: () => states[resolved++],
        execute: async (operation) => {
            executed.push(operation.operation_id);
            return { passed: operation.operation_id !== 'shell-smoke-preflight', outputLines: ['SHELL_SMOKE_FAILED'] };
        }
    });
    assert.equal(failing.outcome, 'FAILED');
    assert.deepEqual(failing.completed.map((step) => step.gate), ['handshake-diagnostics']);
    assert.equal(failing.failed?.gate, 'shell-smoke-preflight');
    assert.deepEqual(failing.failed?.output_lines, ['SHELL_SMOKE_FAILED']);
    assert.equal(resolved, 3);
    assert.deepEqual(executed, ['handshake-diagnostics', 'shell-smoke-preflight']);
    assert.deepEqual(failing.next?.commands, [recovery]);
    assert.equal(formatTaskCompositeText(failing).split(recovery.command).length, 2);
    resolved = 0;
    const throwing = await runTaskComposite({
        taskId: TASK_ID, repoRoot: '.', mode: 'advance', entryInputs: null,
        resolve: () => states[resolved++],
        execute: async () => { throw new Error('gate crashed'); }
    });
    assert.equal(throwing.failed?.error, 'gate crashed');
    assert.deepEqual(throwing.completed, []);
    assert.equal(throwing.counters.subgates_succeeded, 0);
});

test('a stale unchanged state after a passing step is blocked instead of looping', async (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-stall-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const state = navigatorResult([mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } })]);
    let executions = 0;
    const result = await runTaskComposite({
        taskId: TASK_ID, repoRoot, mode: 'advance', entryInputs: null,
        resolve: () => state,
        execute: async () => { executions += 1; return { passed: true, outputLines: [] }; }
    });
    assert.equal(executions, 1);
    assert.equal(result.stop?.kind, 'repeated-state');
    assert.equal(result.next?.stated_action, undefined);
    assert.match(formatTaskCompositeText(result), /Next action: .* next-step /u);
    assert.doesNotMatch(formatTaskCompositeText(result), /Next action: .* task .* advance/u);
});

test('the runner never exceeds its sub-gate bound', async (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-stall-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    let resolved = 0;
    const result = await runTaskComposite({
        taskId: TASK_ID, repoRoot, mode: 'advance', entryInputs: null,
        resolve: () => navigatorResult(
            [mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } })], { reason: `state ${resolved++}` }
        ),
        execute: async () => ({ passed: true, outputLines: [] })
    });
    assert.equal(result.stop?.kind, 'step-limit');
    assert.equal(result.next?.stated_action, undefined);
    assert.equal(result.counters.subgates_attempted, TASK_COMPOSITE_MAX_SUBGATES);
});

test('missing support for an unknown or mis-declared operation id stops instead of executing', () => {
    const unknown = attachNextStepCommandExecution(buildCommand('Future gate', 'future'), 'mechanical',
        { operation_id: 'future-gate', arguments: { task_id: TASK_ID } } as unknown as NextStepCommandOperation);
    assert.deepEqual(selectTaskCompositeAction(navigatorResult([unknown]), 'advance', null),
        { kind: 'stop', stop: 'unclassified', reason: "Operation 'future-gate' is not executable by the composite runner." });
    const entryArguments = { task_id: TASK_ID, entry_mode: 'EXPLICIT_TASK_EXECUTION', requested_depth: '2', task_summary: 'Summary' };
    for (const boundary of ['mechanical', 'operator'] as const) {
        const entry = attachNextStepCommandExecution(buildCommand('Enter task mode', `enter ${boundary}`), boundary,
            { operation_id: 'enter-task-mode', arguments: entryArguments });
        const action = selectTaskCompositeAction(navigatorResult([entry]), 'start', ENTRY_INPUTS);
        assert.equal(action.kind, 'stop', boundary);
    }
});

test('invalid or lost task-mode evidence recovery routes are operator boundaries without an operation', () => {
    const publication = startupExecution({ enterTaskModePassed: true, failedPublicationRecovery: { reason: 'r', command: 'reset' } });
    assert.deepEqual([publication.execution?.boundary, publication.execution?.operation], ['operator', null]);
    const lostPolicy = startupExecution({
        enterTaskModePassed: false, lostTaskModePolicyRecovery: () => ({ reason: 'r', command: 'reset' })
    });
    assert.equal(lostPolicy.route.nextGate, 'task-reset');
    assert.deepEqual([lostPolicy.execution?.boundary, lostPolicy.execution?.operation], ['operator', null]);
    const unadoptable = startupExecution({
        profilePolicyAdoption: { reason: 'r', laneChanges: [], unadoptableChanges: ['graph'], command: 'adopt' },
        taskResetPreviewCommand: 'reset'
    });
    assert.deepEqual([unadoptable.execution?.boundary, unadoptable.execution?.operation], ['operator', null]);
});

test('an executor failure for an unsupported operation is a failed step, not a crash', async () => {
    const unknown = { operation_id: 'future-gate', arguments: { task_id: TASK_ID } } as unknown as NextStepCommandOperation;
    await assert.rejects(executeTaskCompositeOperation(unknown, { repoRoot: '.', entryInputs: null }), /Unsupported composite operation: future-gate/u);
});

test('a tampered descriptor operation is rejected because its arguments and arrays are deeply frozen', () => {
    const classify = mechanical({
        operation_id: 'classify-change',
        arguments: {
            task_id: TASK_ID, task_intent: 'Intent', changed_files: ['src/a.ts'], detection_source: null,
            use_staged: false, task_mode_path: null, output_path: 'preflight.json'
        }
    });
    const operation = readNextStepCommandExecution(classify)?.operation;
    assert.ok(operation && operation.operation_id === 'classify-change');
    assert.throws(() => { operation.arguments.task_id = 'T-other'; }, TypeError);
    assert.throws(() => { operation.arguments.changed_files.push('src/b.ts'); }, TypeError);
    assert.throws(() => { operation.arguments.changed_files[0] = 'src/c.ts'; }, TypeError);
    const effects = mechanical({
        operation_id: 'execute-next-step-effects',
        arguments: { task_id: TASK_ID, plan_sha256: 'a'.repeat(64), effect_kinds: ['kind-a'] }
    });
    const effectOperation = readNextStepCommandExecution(effects)?.operation;
    assert.ok(effectOperation && effectOperation.operation_id === 'execute-next-step-effects');
    assert.throws(() => { effectOperation.arguments.effect_kinds.push('kind-b'); }, TypeError);
    assert.deepEqual(effectOperation.arguments.effect_kinds, ['kind-a']);
});

test('a replaced command text never carries its descriptor through the decision engine projection', () => {
    const source = mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } });
    const identical = { ...source };
    carryNextStepCommandExecution(source, identical);
    assert.equal(readNextStepCommandExecution(identical)?.operation?.operation_id, 'handshake-diagnostics');
    const rewritten = { ...source, command: `${source.command} --other` };
    carryNextStepCommandExecution(source, rewritten);
    assert.equal(readNextStepCommandExecution(rewritten), null);
    const untyped = buildCommand('Run handshake diagnostics', 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"');
    const copy = { ...untyped };
    carryNextStepCommandExecution(untyped, copy);
    assert.equal(readNextStepCommandExecution(copy), null);
});

test('a mechanical descriptor without an operation and an empty effect list stop as unclassified', () => {
    const noOperation = attachNextStepCommandExecution(buildCommand('Mechanical', 'mechanical'), 'mechanical');
    assert.deepEqual(selectTaskCompositeAction(navigatorResult([noOperation]), 'advance', null),
        { kind: 'stop', stop: 'unclassified', reason: 'The mechanical descriptor carries no operation.' });
    const empty = mechanical({
        operation_id: 'execute-next-step-effects', arguments: { task_id: TASK_ID, plan_sha256: 'a'.repeat(64), effect_kinds: [] }
    });
    const action = selectTaskCompositeAction(navigatorResult([empty]), 'advance', null, new Set(['kind-a']));
    assert.deepEqual(action, { kind: 'stop', stop: 'unclassified', reason: 'Effect kinds not classified as mechanical: (none).' });
});

test('a foreign task step is stopped before the runner executes it', async (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-foreign-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const executed: string[] = [];
    const result = await runTaskComposite({
        taskId: TASK_ID, repoRoot, mode: 'advance', entryInputs: null,
        resolve: () => navigatorResult([mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: 'T-2' } })],
            { next_gate: 'handshake-diagnostics' }),
        execute: async (operation) => { executed.push(operation.operation_id); return { passed: true, outputLines: [] }; }
    });
    assert.deepEqual(executed, []);
    assert.equal(result.outcome, 'STOPPED');
    assert.deepEqual(result.stop, { kind: 'unclassified', reason: "The 'handshake-diagnostics' step is bound to task 'T-2', not to 'T-1'." });
    assert.equal(result.counters.subgates_attempted, 0);
});

test('a navigator exception after a completed step is a failed run that keeps the prefix and the retry command', async () => {
    const states = [
        navigatorResult([mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } })], { next_gate: 'handshake-diagnostics' })
    ];
    let resolved = 0;
    const result = await runTaskComposite({
        taskId: TASK_ID, repoRoot: '.', mode: 'advance', entryInputs: null,
        resolve: () => {
            if (resolved >= states.length) throw new Error('navigator crashed');
            return states[resolved++];
        },
        execute: async () => ({ passed: true, outputLines: ['OK'] })
    });
    assert.equal(result.outcome, 'FAILED');
    assert.deepEqual(result.completed.map((step) => step.gate), ['handshake-diagnostics']);
    assert.deepEqual(result.failed, {
        gate: 'next-step', operation_id: 'next-step-resolution', outcome: 'FAIL', output_lines: [], error: 'navigator crashed'
    });
    assert.equal(result.navigator_command, states[0].navigator_command);
    assert.equal(result.counters.subgates_succeeded, 1);
});

test('a dirty-workspace scan failure before entry is a failed run, not an escaping exception', async (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-scan-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    // A .git file naming a missing directory makes the Git scan fail whatever contains the temp directory.
    fs.writeFileSync(path.join(repoRoot, '.git'), `gitdir: ${path.join(repoRoot, 'missing-git-dir')}
`, 'utf8');
    const entry = attachNextStepCommandExecution(buildCommand('Enter task mode', 'enter'), 'agent', {
        operation_id: 'enter-task-mode',
        arguments: { task_id: TASK_ID, entry_mode: 'EXPLICIT_TASK_EXECUTION', requested_depth: '2', task_summary: 'Summary' }
    });
    const executed: string[] = [];
    const result = await runTaskComposite({
        taskId: TASK_ID, repoRoot, mode: 'start', entryInputs: ENTRY_INPUTS,
        resolve: () => navigatorResult([entry], { next_gate: 'enter-task-mode' }),
        execute: async (operation) => { executed.push(operation.operation_id); return { passed: true, outputLines: [] }; }
    });
    assert.deepEqual(executed, []);
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.failed?.gate, 'dirty-workspace-scan');
    assert.equal(result.failed?.operation_id, 'dirty-workspace-scan');
    assert.match(result.failed?.error ?? '', /git --no-pager status .* failed/u);
    assert.equal(result.navigator_command, 'node bin/garda.js next-step "T-1" --repo-root "."');
});

/** A navigator answer as the output builder renders it: the T-403 safe exit is appended exactly as in production. */
function renderedWithSafeExit(
    commands: NextStepResult['commands'], nextGate: string, decision: NextStepRouteDecision | null = null
): NextStepResult {
    const base = navigatorResult(commands, { next_gate: nextGate });
    const rendered = applyNextStepSafeExit({
        taskId: base.task_id, navigatorCommand: base.navigator_command, status: base.status, nextGate,
        reason: base.reason, commands, decision
    });
    assert.equal(rendered.commands.at(-1)?.label, SAFE_EXIT_LABEL, 'the producer appended the safe exit');
    return navigatorResult(rendered.commands, {
        next_gate: nextGate, reason: rendered.reason, ...(decision ? { route_decision: decision } : {})
    });
}

const doctorCommand = 'node bin/garda.js doctor --target-root "."';
const stopKind = (action: ReturnType<typeof selectTaskCompositeAction>): string => (action as { stop: string }).stop;

test('an operator route plus the safe-exit preview stops as operator, never as an agent choice', async () => {
    const doctor = attachNextStepCommandExecution(buildCommand('Inspect Garda installation', doctorCommand), 'operator');
    const maintenance = renderedWithSafeExit([doctor], 'operator-maintenance');
    assert.equal(maintenance.commands.length, 2);
    for (const mode of ['start', 'advance', 'finish'] as const) {
        assert.deepEqual(selectTaskCompositeAction(maintenance, mode, mode === 'start' ? ENTRY_INPUTS : null), {
            kind: 'stop', stop: 'operator',
            reason: "The 'operator-maintenance' step is an operator decision: no agent command can progress it; the listed reopen preview is read-only."
        }, mode);
    }
    // The listed gate decides, not the descriptor of the remaining diagnostic; so does the producing route's marker.
    const agentDoctor = attachNextStepCommandExecution(buildCommand('Inspect Garda installation', doctorCommand), 'agent');
    assert.equal(stopKind(selectTaskCompositeAction(renderedWithSafeExit([agentDoctor], 'operator-maintenance'), 'advance', null)), 'operator');
    assert.equal(stopKind(selectTaskCompositeAction(renderedWithSafeExit([agentDoctor], 'gate', 'operator'), 'advance', null)), 'operator');
    // Only the preview left: the operator decides.
    assert.equal(stopKind(selectTaskCompositeAction(renderedWithSafeExit([], 'gate'), 'advance', null)), 'operator');
    // The preview stays visible in the composite answer, and nothing is executed.
    let executed = 0;
    const run = await runTaskComposite({
        taskId: TASK_ID, repoRoot: '.', mode: 'advance', entryInputs: null, resolve: () => maintenance,
        execute: async () => { executed += 1; return { passed: true, outputLines: [] }; }
    });
    assert.equal(executed, 0);
    assert.equal(run.stop?.kind, 'operator');
    assert.deepEqual(run.next?.commands.map(command => command.label), ['Inspect Garda installation', SAFE_EXIT_LABEL]);
    const text = formatTaskCompositeText(run);
    assert.match(text, /StopKind: operator/u);
    assert.ok(text.includes(`${SAFE_EXIT_LABEL}: `), text);
});

test('an agent command plus the safe-exit preview is classified exactly as the command alone', () => {
    const agentDoctor = attachNextStepCommandExecution(buildCommand('Inspect Garda installation', doctorCommand), 'agent');
    assert.deepEqual(selectTaskCompositeAction(renderedWithSafeExit([agentDoctor], 'gate'), 'advance', null),
        selectTaskCompositeAction(navigatorResult([agentDoctor]), 'advance', null));
    assert.deepEqual(selectTaskCompositeAction(renderedWithSafeExit([agentDoctor], 'gate'), 'advance', null),
        { kind: 'stop', stop: 'agent', reason: "The 'gate' step is an agent boundary." });
    // A mechanical step the invariant reads as non-progressing still runs as it did before the preview existed.
    const handshake = mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } }, doctorCommand);
    const mechanicalAction = selectTaskCompositeAction(renderedWithSafeExit([handshake], 'gate'), 'advance', null);
    assert.equal(mechanicalAction.kind, 'execute');
    // Two real commands remain a choice; a copied preview is not the producer's preview and counts as a command.
    const status = attachNextStepCommandExecution(buildCommand('Status', 'node bin/garda.js status'), 'agent');
    assert.deepEqual(selectTaskCompositeAction(renderedWithSafeExit([agentDoctor, status], 'gate'), 'advance', null), {
        kind: 'stop', stop: 'agent', reason: 'The navigator offers 2 commands; choosing between them is an agent decision.'
    });
    const rendered = renderedWithSafeExit([agentDoctor], 'gate');
    const copied = navigatorResult([agentDoctor, { ...rendered.commands[1] }], { next_gate: 'gate' });
    assert.deepEqual(selectTaskCompositeAction(copied, 'advance', null), {
        kind: 'stop', stop: 'agent', reason: 'The navigator offers 2 commands; choosing between them is an agent decision.'
    });
});

test('every scoped-diff route builder carries one mechanical descriptor bound to the rendered repo-relative paths', () => {
    const repoRoot = path.resolve(os.tmpdir(), 'garda-scoped-diff-descriptor');
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const command = buildScopedDiffStepCommand({
        repoRoot, cliPrefix: 'node bin/garda.js', taskId: TASK_ID, reviewType: 'refactor',
        preflightCommandPath: 'garda-agent-orchestrator/runtime/reviews/T-1-preflight.json', preflightSha256: 'A'.repeat(64),
        scopedDiffOutputPath: path.join(reviewsRoot, 'T-1-refactor-scoped.diff'),
        scopedDiffMetadataPath: path.join(reviewsRoot, 'T-1-refactor-scoped.json')
    });
    const execution = readNextStepCommandExecution(command);
    assert.equal(execution?.boundary, 'mechanical');
    assert.deepEqual(execution?.operation, { operation_id: 'build-scoped-diff', arguments: {
        task_id: TASK_ID, review_type: 'refactor', preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-1-preflight.json',
        output_path: 'garda-agent-orchestrator/runtime/reviews/T-1-refactor-scoped.diff',
        metadata_path: 'garda-agent-orchestrator/runtime/reviews/T-1-refactor-scoped.json', preflight_sha256: 'a'.repeat(64)
    } });
    assert.ok(command.command.includes('--output-path "garda-agent-orchestrator/runtime/reviews/T-1-refactor-scoped.diff"'));
    assert.equal(readNextStepCommandExecution({ ...command }), null);
    for (const preflightSha256 of [null, '', 'not-a-digest']) {
        const unbound = buildScopedDiffStepCommand({
            repoRoot, cliPrefix: 'node bin/garda.js', taskId: TASK_ID, reviewType: 'refactor',
            preflightCommandPath: 'garda-agent-orchestrator/runtime/reviews/T-1-preflight.json', preflightSha256,
            scopedDiffOutputPath: path.join(reviewsRoot, 'T-1-refactor-scoped.diff'),
            scopedDiffMetadataPath: path.join(reviewsRoot, 'T-1-refactor-scoped.json')
        });
        assert.equal(unbound.command, command.command);
        assert.equal(readNextStepCommandExecution(unbound), null);
    }
});
