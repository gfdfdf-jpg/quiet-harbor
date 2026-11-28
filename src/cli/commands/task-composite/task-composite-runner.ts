import {
    recordTaskCompositeRecommendationStop,
    taskCompositeExecutableStateKey as executableStateKey
} from '../../../gates/next-step/next-step-composite-recommendation-context';
import { resolveNextStep, type NextStepResult } from '../../../gates/next-step';
import { readNextStepCommandExecution, type NextStepCommandOperation } from '../../../gates/next-step/next-step-command-execution';
import { buildNextStepInstruction, formatNextStepOperatorDecisionLines, formatNextStepTestPlanLines, isOnlySafeExit } from '../../../gates/next-step/next-step-command-formatters';
import { selectNextStepHints } from '../../../gates/next-step/next-step-hints';
import { selectNextStepRecommendedAction } from '../../../gates/next-step/next-step-recommended-action';
import { quoteCommandValue } from '../../../core/command-quoting';
import { resolveGardaCliPrefix } from '../../../core/garda-cli-prefix';
import {
    executeTaskCompositeOperation,
    readUnscopedDirtyWorkspaceFiles,
    type TaskCompositeOperationOutcome
} from './task-composite-actions';
import {
    COMPOSITE_MECHANICAL_EFFECT_KINDS, selectTaskCompositeAction,
    type TaskCompositeCloseoutInputs, type TaskCompositeEntryInputs, type TaskCompositeMode, type TaskCompositeReviewerInputs,
    type TaskCompositeStopKind
} from '../../../gates/next-step/next-step-composite-action';

/** A composite never needs more sub-gates than the longest mechanical startup chain plus its recoveries. */
export const TASK_COMPOSITE_MAX_SUBGATES = 12;

export interface TaskCompositeStepRecord {
    gate: string;
    operation_id: NextStepCommandOperation['operation_id'];
    outcome: 'PASS' | 'FAIL';
    output_lines: string[];
}

/** What failed outside a gate: the navigator itself or the pre-entry workspace scan, plus any executed operation. */
export type TaskCompositeFailureSource = NextStepCommandOperation['operation_id'] | 'next-step-resolution' | 'dirty-workspace-scan';

export interface TaskCompositeNextAction {
    status: NextStepResult['status'];
    next_gate: string | null;
    title: string;
    reason: string;
    commands: { label: string; command: string }[];
    navigator_command: string;
    /** Every navigator warning plus any warning about retaining the composite stall advisory. */
    warnings: string[];
    /** The compact operator-decision lines of a review-cycle stop; empty when no decision is pending. */
    operator_decision: string[];
    /** One-line navigator hints for this step (advice only; never checked by Garda). */
    hints: string[];
    stated_action?: string;
    instruction?: string | null;
}

export interface TaskCompositeCounters {
    agent_invocations: 1;
    navigator_resolutions: number;
    subgates_attempted: number;
    subgates_succeeded: number;
    effects_executed: number;
}

export interface TaskCompositeRunResult {
    schema_version: 1;
    task_id: string;
    mode: TaskCompositeMode;
    outcome: 'STOPPED' | 'FAILED';
    completed: TaskCompositeStepRecord[];
    failed: (Omit<TaskCompositeStepRecord, 'operation_id'> & { operation_id: TaskCompositeFailureSource; error: string | null }) | null;
    stop: { kind: TaskCompositeStopKind; reason: string } | null;
    next: TaskCompositeNextAction | null;
    /** The navigator to rerun after any outcome, as the last resolution printed it. */
    navigator_command: string | null;
    counters: TaskCompositeCounters;
    /**
     * `finish` only: the canonical final report the navigator returned for the DONE task (its report body, order and
     * commit guidance, unchanged), or null when the run stopped earlier. `finish` never commits.
     */
    final_report?: NextStepResult['final_report'];
}

export interface TaskCompositeRunOptions {
    taskId: string;
    repoRoot: string;
    mode: TaskCompositeMode;
    entryInputs: TaskCompositeEntryInputs | null;
    reviewerInputs?: TaskCompositeReviewerInputs | null;
    closeoutInputs?: TaskCompositeCloseoutInputs | null;
    /** Test seams; production uses the navigator, the existing gate entry points and the shipped allowlist. */
    resolve?: (options: { taskId: string; repoRoot: string }) => NextStepResult;
    execute?: typeof executeTaskCompositeOperation;
    effectAllowlist?: ReadonlySet<string>;
}

function projectNextAction(result: NextStepResult): TaskCompositeNextAction {
    const recommended = selectNextStepRecommendedAction(result);
    return {
        status: result.status,
        next_gate: result.next_gate,
        title: result.title,
        reason: result.reason,
        commands: result.commands.map((command) => ({ label: command.label, command: command.command })),
        navigator_command: result.navigator_command,
        // Resolver seams may return a partial result; a missing list is an empty one.
        warnings: [...(result.warnings ?? [])],
        operator_decision: formatNextStepOperatorDecisionLines(result),
        hints: [...selectNextStepHints(result), ...formatNextStepTestPlanLines(result)],
        ...(recommended ? { stated_action: recommended.command } : {}),
        // The reopen preview alone does not replace the route's own instruction.
        ...(isOnlySafeExit(result.commands) ? { instruction: buildNextStepInstruction(result) } : {})
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function buildScopedStartRetry(repoRoot: string, taskId: string, inputs: TaskCompositeEntryInputs): string {
    const flags = [
        '--provider', quoteCommandValue(inputs.provider),
        ...(inputs.routedTo ? ['--routed-to', quoteCommandValue(inputs.routedTo)] : []),
        ...(inputs.requestedDepth ? ['--requested-depth', quoteCommandValue(inputs.requestedDepth)] : []),
        ...(inputs.taskSummary ? ['--task-summary', quoteCommandValue(inputs.taskSummary)] : []),
        ...(inputs.orchestratorWork ? ['--orchestrator-work'] : []),
        ...(inputs.workflowConfigWork ? ['--workflow-config-work'] : []),
        ...(inputs.operatorConfirmed ? ['--operator-confirmed', quoteCommandValue(inputs.operatorConfirmed)] : []),
        ...(inputs.operatorConfirmedAtUtc ? ['--operator-confirmed-at-utc', quoteCommandValue(inputs.operatorConfirmedAtUtc)] : []),
        '--planned-changed-file', '"<task-owned-file>"', '--repo-root', '"."'
    ];
    return [resolveGardaCliPrefix(repoRoot), 'task', quoteCommandValue(taskId), 'start', ...flags].join(' ');
}

function projectFailureRecovery(current: NextStepResult, taskId: string, failedGate: string): TaskCompositeNextAction | null {
    if (current.task_id !== taskId || (current.status !== 'READY' && current.status !== 'BLOCKED')
        || !current.next_gate || current.next_gate === failedGate || !current.commands.length) return null;
    if (current.commands.some(command => {
        const operation = readNextStepCommandExecution(command)?.operation;
        return operation && operation.arguments.task_id !== taskId;
    })) return null;
    return projectNextAction(current);
}

function suppressStalledAction(next: TaskCompositeNextAction, warning: string | null): void {
    if (warning) next.warnings.push(warning);
    delete next.stated_action;
    delete next.instruction;
    next.commands = [];
}

/**
 * Runs mechanical navigator steps until the first boundary. Every step is chosen by a fresh authenticated
 * navigator resolution and executed through the existing gate entry point; nothing is retried or rolled back.
 */
export async function runTaskComposite(options: TaskCompositeRunOptions): Promise<TaskCompositeRunResult> {
    const resolve = options.resolve ?? resolveNextStep;
    const execute = options.execute ?? executeTaskCompositeOperation;
    const effectAllowlist = options.effectAllowlist ?? COMPOSITE_MECHANICAL_EFFECT_KINDS;
    const counters: TaskCompositeCounters = {
        agent_invocations: 1,
        navigator_resolutions: 0,
        subgates_attempted: 0,
        subgates_succeeded: 0,
        effects_executed: 0
    };
    const completed: TaskCompositeStepRecord[] = [];
    const executedStates = new Set<string>();
    let navigatorCommand: string | null = null;
    let reviewerBoundary: string | null = null;
    let finalReport: NextStepResult['final_report'] = null;
    const finish = (
        outcome: TaskCompositeRunResult['outcome'],
        fields: Pick<TaskCompositeRunResult, 'failed' | 'stop' | 'next'>
    ): TaskCompositeRunResult => ({
        schema_version: 1, task_id: options.taskId, mode: options.mode, outcome, completed, ...fields,
        navigator_command: navigatorCommand, counters,
        // A report is returned only with the terminal stop of a fresh resolution; a failure never reports DONE.
        ...(options.mode === 'finish'
            ? { final_report: outcome === 'STOPPED' && fields.stop?.kind === 'terminal' ? finalReport : null } : {})
    });

    const infrastructureFailure = (
        gate: string, source: TaskCompositeFailureSource, error: unknown
    ): TaskCompositeRunResult => finish('FAILED', {
        failed: { gate, operation_id: source, outcome: 'FAIL', output_lines: [], error: errorMessage(error) },
        stop: null,
        next: null
    });

    for (;;) {
        let result: NextStepResult;
        try {
            result = resolve({ taskId: options.taskId, repoRoot: options.repoRoot });
        } catch (error: unknown) {
            return infrastructureFailure('next-step', 'next-step-resolution', error);
        }
        counters.navigator_resolutions += 1;
        navigatorCommand = result.navigator_command;
        finalReport = result.status === 'DONE' ? result.final_report ?? null : null;
        const next = projectNextAction(result);
        if (reviewerBoundary) {
            return finish('STOPPED', { failed: null, stop: { kind: 'agent', reason: reviewerBoundary }, next });
        }
        const action = selectTaskCompositeAction(
            result, options.mode, options.entryInputs, effectAllowlist, options.reviewerInputs, options.closeoutInputs
        );
        if (action.kind === 'stop') {
            return finish('STOPPED', { failed: null, stop: { kind: action.stop, reason: action.reason }, next });
        }
        if (action.operation.arguments.task_id !== options.taskId) {
            return finish('STOPPED', {
                failed: null,
                stop: {
                    kind: 'unclassified',
                    reason: `The '${action.gate}' step is bound to task '${action.operation.arguments.task_id}', not to '${options.taskId}'.`
                },
                next
            });
        }
        const stateKey = executableStateKey(result, action.operation);
        if (executedStates.has(stateKey)) {
            const warning = recordTaskCompositeRecommendationStop(options.repoRoot, options.taskId, result, action.operation, 'repeated-state');
            suppressStalledAction(next, warning);
            return finish('STOPPED', {
                failed: null,
                stop: { kind: 'repeated-state', reason: `'${action.gate}' passed but the navigator still requires it unchanged.` },
                next
            });
        }
        if (counters.subgates_attempted >= TASK_COMPOSITE_MAX_SUBGATES) {
            const warning = recordTaskCompositeRecommendationStop(options.repoRoot, options.taskId, result, action.operation, 'step-limit');
            suppressStalledAction(next, warning);
            return finish('STOPPED', {
                failed: null,
                stop: { kind: 'step-limit', reason: `Stopped after ${TASK_COMPOSITE_MAX_SUBGATES} sub-gates.` },
                next
            });
        }
        if (action.operation.operation_id === 'enter-task-mode') {
            let unscoped: string[];
            try {
                unscoped = readUnscopedDirtyWorkspaceFiles(options.repoRoot, options.entryInputs!);
            } catch (error: unknown) {
                return infrastructureFailure('dirty-workspace-scan', 'dirty-workspace-scan', error);
            }
            if (unscoped.length > 0) {
                const command = buildScopedStartRetry(options.repoRoot, options.taskId, options.entryInputs!);
                next.commands = [{ label: 'Start with the planned task scope', command }];
                next.stated_action = command;
                return finish('STOPPED', {
                    failed: null,
                    stop: {
                        kind: 'agent',
                        reason: `The workspace already has ${unscoped.length} changed file(s) (${unscoped.slice(0, 5).join(', ')}). `
                            + 'Pass the task scope with --planned-changed-file, or isolate the existing changes first.'
                    },
                    next
                });
            }
        }
        executedStates.add(stateKey);
        counters.subgates_attempted += 1;
        let outcome: TaskCompositeOperationOutcome;
        try {
            outcome = await execute(action.operation, {
                repoRoot: options.repoRoot, entryInputs: options.entryInputs, reviewerInputs: options.reviewerInputs,
                closeoutInputs: options.closeoutInputs
            });
        } catch (error: unknown) {
            return infrastructureFailure(action.gate, action.operation.operation_id, error);
        }
        const record: TaskCompositeStepRecord = {
            gate: action.gate,
            operation_id: action.operation.operation_id,
            outcome: outcome.passed ? 'PASS' : 'FAIL',
            output_lines: outcome.outputLines
        };
        if (!outcome.passed) {
            let recovery: TaskCompositeNextAction | null = null;
            try {
                const current = resolve({ taskId: options.taskId, repoRoot: options.repoRoot });
                counters.navigator_resolutions += 1;
                recovery = projectFailureRecovery(current, options.taskId, action.gate);
            } catch { /* Preserve the failed gate and its diagnostics if recovery cannot be resolved. */ }
            return finish('FAILED', { failed: { ...record, error: null }, stop: null, next: recovery });
        }
        counters.subgates_succeeded += 1;
        if (action.operation.operation_id === 'execute-next-step-effects') {
            counters.effects_executed += action.operation.arguments.effect_kinds.length;
        }
        completed.push(record);
        switch (action.operation.operation_id) {
            case 'prepare-reviewer-launch':
                reviewerBoundary = 'Use the exact prepared launch input to launch one fresh delegated reviewer.';
                break;
            case 'record-reviewer-delegation-started':
                reviewerBoundary = 'Wait for the delegated reviewer to return.';
                break;
            case 'record-review-result':
                reviewerBoundary = 'Check the accepted receipt and findings before releasing the reviewer.';
                break;
        }
    }
}
