import type { NextStepCommand } from './next-step';

/**
 * Who must act on a navigator command. Only `mechanical` commands may be executed by a composite runner; an
 * `agent` command needs explicit agent input or judgment, an `operator` command needs operator approval and a
 * `terminal` command ends the lifecycle path.
 */
export type NextStepCommandBoundaryKind = 'mechanical' | 'agent' | 'operator' | 'terminal';

export interface NextStepEnterTaskModeArguments {
    task_id: string;
    entry_mode: string;
    requested_depth: string;
    task_summary: string;
}

export interface NextStepClassifyChangeArguments {
    task_id: string;
    task_intent: string;
    changed_files: string[];
    detection_source: string | null;
    use_staged: boolean;
    task_mode_path: string | null;
    output_path: string;
}

export interface NextStepExecuteEffectsArguments {
    task_id: string;
    plan_sha256: string;
    effect_kinds: string[];
}

/** A gate bound to the current preflight; `task_mode_path` is set only for a nondefault task-mode artifact. */
export interface NextStepPreflightGateArguments {
    task_id: string;
    preflight_path: string;
    task_mode_path: string | null;
}

export interface NextStepQualityChecklistArguments {
    task_id: string;
    preflight_path: string;
    /** The answers file the navigator already validated as complete; the agent wrote every answer. */
    answers_path: string;
}

export interface NextStepTaskTestValidationArguments {
    task_id: string;
    preflight_path: string;
}

export interface NextStepBuildReviewContextArguments extends NextStepPreflightGateArguments {
    review_type: string;
    depth: number;
}

export interface NextStepReviewerBookkeepingArguments extends NextStepPreflightGateArguments {
    review_type: string;
    launch_artifact_path: string;
    reviewer_identity: string | null;
    provider_invocation_id: string | null;
    controller_invocation_id: string | null;
    launch_input_mode: 'copy_paste_prompt' | 'launch_artifact_path' | null;
    launch_input_sha256: string | null;
    launch_input_artifact_path: string | null;
    review_output_path: string | null;
}

export type NextStepReviewerBookkeepingOperation = {
    operation_id: 'prepare-reviewer-launch' | 'record-reviewer-delegation-started' | 'complete-reviewer-launch'
        | 'record-review-invocation' | 'record-review-result';
    arguments: NextStepReviewerBookkeepingArguments;
};

export type NextStepCommandOperation =
    | NextStepReviewerBookkeepingOperation
    | { operation_id: 'enter-task-mode'; arguments: NextStepEnterTaskModeArguments }
    | { operation_id: 'handshake-diagnostics'; arguments: { task_id: string } }
    | { operation_id: 'shell-smoke-preflight'; arguments: { task_id: string } }
    | { operation_id: 'classify-change'; arguments: NextStepClassifyChangeArguments }
    | { operation_id: 'execute-next-step-effects'; arguments: NextStepExecuteEffectsArguments }
    | { operation_id: 'bind-rule-pack-to-preflight'; arguments: NextStepPreflightGateArguments }
    | { operation_id: 'quality-checklist'; arguments: NextStepQualityChecklistArguments }
    | { operation_id: 'compile-gate'; arguments: NextStepPreflightGateArguments }
    | { operation_id: 'task-test-validation'; arguments: NextStepTaskTestValidationArguments }
    | { operation_id: 'build-review-context'; arguments: NextStepBuildReviewContextArguments };

export type NextStepCommandOperationId = NextStepCommandOperation['operation_id'];

export interface NextStepCommandExecution {
    boundary: NextStepCommandBoundaryKind;
    /** Structured arguments the navigator derived from authenticated state; null for a stop-only boundary. */
    operation: NextStepCommandOperation | null;
    /** The exact human command the descriptor was bound to; a rewritten command loses its descriptor. */
    rendered_command: string;
}

/**
 * Typed descriptors stay outside the serialized navigator result; recommendations carry display text only.
 * Identity binding is deliberate: apart from the decision engine's frozen projection below, a copied
 * or rebuilt command carries no descriptor, which can only turn an executable step into a stop, never the reverse.
 */
const commandExecutions = new WeakMap<object, NextStepCommandExecution>();

export function attachNextStepCommandExecution(
    command: NextStepCommand,
    boundary: NextStepCommandBoundaryKind,
    operation: NextStepCommandOperation | null = null
): NextStepCommand {
    commandExecutions.set(command, Object.freeze({
        boundary,
        operation: operation ? Object.freeze(structuredClone(operation)) as NextStepCommandOperation : null,
        rendered_command: command.command
    }));
    return command;
}

export function readNextStepCommandExecution(command: NextStepCommand): NextStepCommandExecution | null {
    const execution = commandExecutions.get(command);
    return execution && execution.rendered_command === command.command ? execution : null;
}

/**
 * The decision engine publishes a frozen deep copy of the selected route. The copy keeps the descriptor only when
 * it still renders the same command text, so the projection cannot rebind a descriptor to different text.
 */
export function carryNextStepCommandExecution(source: object, copy: object): void {
    const execution = commandExecutions.get(source);
    if (execution && (copy as { command?: unknown }).command === execution.rendered_command) {
        commandExecutions.set(copy, execution);
    }
}
