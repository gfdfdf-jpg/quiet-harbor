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
    readNextStepCommandExecution,
    type NextStepCommandOperation
} from '../../../../src/gates/next-step/next-step-command-execution';
import { buildCommand } from '../../../../src/gates/next-step/next-step-command-formatters';
import type { NextStepResult } from '../../../../src/gates/next-step';
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
        status: 'BLOCKED', next_gate: 'gate', title: 'title', reason: 'reason', commands,
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
    const manifest = startupExecution({ protectedManifestRecovery: { recovered: true, reason: 'r', command: 'retry' } });
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
    const states = [
        navigatorResult([mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } })]),
        navigatorResult([mechanical({ operation_id: 'shell-smoke-preflight', arguments: { task_id: TASK_ID } })]),
        navigatorResult([mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: 'T-unreachable' } })])
    ];
    let resolved = 0;
    const failing = await runTaskComposite({
        taskId: TASK_ID, repoRoot: '.', mode: 'advance', entryInputs: null,
        resolve: () => states[resolved++],
        execute: async (operation) => ({ passed: operation.operation_id !== 'shell-smoke-preflight', outputLines: ['SHELL_SMOKE_FAILED'] })
    });
    assert.equal(failing.outcome, 'FAILED');
    assert.deepEqual(failing.completed.map((step) => step.gate), ['handshake-diagnostics']);
    assert.equal(failing.failed?.gate, 'shell-smoke-preflight');
    assert.deepEqual(failing.failed?.output_lines, ['SHELL_SMOKE_FAILED']);
    assert.equal(resolved, 2);
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
});

test('the runner never exceeds its sub-gate bound', async (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-stall-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    let resolved = 0;
    const result = await runTaskComposite({
        taskId: TASK_ID, repoRoot, mode: 'advance', entryInputs: null,
        resolve: () => navigatorResult([mechanical({ operation_id: 'handshake-diagnostics', arguments: { task_id: `T-${resolved++}` } })]),
        execute: async () => ({ passed: true, outputLines: [] })
    });
    assert.equal(result.stop?.kind, 'step-limit');
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
