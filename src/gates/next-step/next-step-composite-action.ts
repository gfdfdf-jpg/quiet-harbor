import type { NextStepResult } from './next-step';
import {
    readNextStepCommandExecution,
    type NextStepCommandBoundaryKind, type NextStepCommandOperation, type NextStepReviewerBookkeepingOperation
} from './next-step-command-execution';

export type TaskCompositeMode = 'start' | 'advance';

/** Explicit agent inputs for task-mode entry; the runner never derives, defaults or widens them. */
export interface TaskCompositeEntryInputs {
    provider: string;
    routedTo: string | null;
    requestedDepth: string | null;
    taskSummary: string | null;
    plannedChangedFiles: string[];
    orchestratorWork: boolean;
    workflowConfigWork: boolean;
    operatorConfirmed: string | null;
    operatorConfirmedAtUtc: string | null;
}

export interface TaskCompositeReviewerInputs {
    phase: 'started' | 'returned';
    reviewType: string;
    reviewerIdentity: string;
    providerInvocationId: string | null;
    controllerInvocationId: string | null;
    attestationSource: string;
    launchInputMode: 'copy_paste_prompt' | 'launch_artifact_path';
    launchInputSha256: string;
    launchInputArtifactPath: string | null;
    reviewOutputPath: string | null;
    forkContext: boolean;
}

export type TaskCompositeStopKind =
    | Exclude<NextStepCommandBoundaryKind, 'mechanical'>
    | 'unclassified'
    | 'repeated-state'
    | 'step-limit';

export type TaskCompositeAction =
    | { kind: 'execute'; gate: string; operation: NextStepCommandOperation }
    | { kind: 'stop'; stop: TaskCompositeStopKind; reason: string };

/**
 * Effect kinds a composite may execute through the expected-hash executor; every effect of a plan must be listed.
 * After classification the navigator materializes the quality-checklist question reference and the editable answers
 * scaffold: gate-owned files that answer nothing, change no status or scope and leave every answer to the agent.
 * Kinds that change lifecycle status, suspend work or record a decision stay visible stops until a later sub-task
 * classifies them together with their stand scenarios.
 */
export const COMPOSITE_MECHANICAL_EFFECT_KINDS: ReadonlySet<string> = new Set<string>([
    'materialize-quality-checklist-question-reference',
    'materialize-quality-checklist-answers'
]);

const SPLIT_STATUSES: ReadonlySet<NextStepResult['status']> = new Set(['DECOMPOSED', 'SPLIT_REQUIRED']);

/**
 * Operations this runner can execute directly; any other id, including one added to the navigator later, stops.
 * Startup: handshake, shell smoke, classification. Validation (each only after the agent's inputs are recorded and
 * current): POST_PREFLIGHT rebinding, recording complete quality answers, compile, the first run of the selected
 * task tests and the reviewer's review context. Preparation is the only reviewer step that needs no provider input.
 */
const DIRECTLY_EXECUTABLE_MECHANICAL_OPERATIONS: ReadonlySet<string> = new Set<NextStepCommandOperation['operation_id']>([
    'handshake-diagnostics', 'shell-smoke-preflight', 'classify-change',
    'bind-rule-pack-to-preflight', 'quality-checklist', 'compile-gate', 'task-test-validation', 'build-review-context',
    'prepare-reviewer-launch'
]);

function stop(stopKind: TaskCompositeStopKind, reason: string): TaskCompositeAction {
    return { kind: 'stop', stop: stopKind, reason };
}

function selectReviewerBookkeeping(result: NextStepResult, inputs: TaskCompositeReviewerInputs): TaskCompositeAction {
    for (const command of result.commands) {
        const execution = readNextStepCommandExecution(command);
        if (execution?.boundary !== 'agent' || !execution.operation) continue;
        const operation = execution.operation as NextStepReviewerBookkeepingOperation;
        const gate = operation.operation_id;
        const matchesPhase = inputs.phase === 'started'
            ? gate === 'record-reviewer-delegation-started'
            : gate === 'complete-reviewer-launch' || gate === 'record-review-invocation' || gate === 'record-review-result';
        if (!matchesPhase || gate !== result.next_gate) continue;
        const args = operation.arguments;
        if (args.task_id === result.task_id && args.review_type === inputs.reviewType
            && args.launch_input_mode === inputs.launchInputMode && args.launch_input_sha256 === inputs.launchInputSha256
            && (inputs.phase === 'started' || (args.reviewer_identity === inputs.reviewerIdentity
                && args.provider_invocation_id === inputs.providerInvocationId
                && args.controller_invocation_id === inputs.controllerInvocationId))) {
            return { kind: 'execute', gate, operation };
        }
    }
    return stop('agent', 'No current navigator action matches the supplied reviewer phase, lane and launch input.');
}

/**
 * Decides from the navigator's typed descriptor alone whether the next step is executable. A gate name, status,
 * label or command text never authorizes execution.
 */
export function selectTaskCompositeAction(
    result: NextStepResult,
    mode: TaskCompositeMode,
    entryInputs: TaskCompositeEntryInputs | null,
    effectAllowlist: ReadonlySet<string> = COMPOSITE_MECHANICAL_EFFECT_KINDS,
    reviewerInputs: TaskCompositeReviewerInputs | null = null
): TaskCompositeAction {
    if (result.status === 'DONE') {
        return stop('terminal', 'The task is DONE.');
    }
    if (SPLIT_STATUSES.has(result.status)) {
        return stop('agent', `The task is ${result.status}; follow the navigator's decomposition instruction.`);
    }
    if (result.status !== 'BLOCKED') {
        return stop('unclassified', `Navigator status ${result.status} has no executable step.`);
    }
    if (mode === 'advance' && reviewerInputs) return selectReviewerBookkeeping(result, reviewerInputs);
    if (result.commands.length !== 1) {
        return result.commands.length === 0
            ? stop('agent', 'The navigator offers no command; follow its instruction.')
            : stop('agent', `The navigator offers ${result.commands.length} commands; choosing between them is an agent decision.`);
    }
    const execution = readNextStepCommandExecution(result.commands[0]);
    if (!execution) {
        return stop('unclassified', `The '${result.next_gate || 'unknown'}' step has no typed execution descriptor.`);
    }
    const operation = execution.operation;
    if (!operation) {
        return execution.boundary === 'mechanical'
            ? stop('unclassified', 'The mechanical descriptor carries no operation.')
            : stop(execution.boundary, `The '${result.next_gate || 'unknown'}' step is an ${execution.boundary} boundary.`);
    }
    if (operation.operation_id === 'enter-task-mode') {
        if (execution.boundary !== 'agent') {
            // Entry consumes agent-supplied inputs; any other declared boundary is not an entry this runner may take.
            return stop(execution.boundary === 'mechanical' ? 'unclassified' : execution.boundary,
                `The 'enter-task-mode' step is declared ${execution.boundary}, not an agent-input entry.`);
        }
        return mode === 'start' && entryInputs
            ? { kind: 'execute', gate: 'enter-task-mode', operation }
            : stop('agent', 'Task-mode entry needs explicit provider and scope inputs: use task <id> start.');
    }
    if (execution.boundary !== 'mechanical') {
        return stop(execution.boundary, `The '${operation.operation_id}' step is an ${execution.boundary} boundary.`);
    }
    if (operation.operation_id === 'execute-next-step-effects') {
        const unlisted = operation.arguments.effect_kinds.filter((effectKind) => !effectAllowlist.has(effectKind));
        return unlisted.length === 0 && operation.arguments.effect_kinds.length > 0
            ? { kind: 'execute', gate: 'next-step-effect', operation }
            : stop('unclassified', `Effect kinds not classified as mechanical: ${unlisted.join(', ') || '(none)'}.`);
    }
    return DIRECTLY_EXECUTABLE_MECHANICAL_OPERATIONS.has(operation.operation_id)
        ? { kind: 'execute', gate: operation.operation_id, operation }
        : stop('unclassified', `Operation '${String(operation.operation_id)}' is not executable by the composite runner.`);
}

