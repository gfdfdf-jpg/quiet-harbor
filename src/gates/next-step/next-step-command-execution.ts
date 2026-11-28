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
    rule_pack_path?: string;
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
    rule_pack_path?: string;
}

/** The POST_PREFLIGHT binding; `artifact_path` is set only for a rule pack outside the default reviews root. */
export interface NextStepRulePackBindArguments extends NextStepPreflightGateArguments {
    artifact_path?: string;
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
    /** Set on the closeout run that `task <id> finish` owns; `advance` stops before it. */
    closeout?: true;
}

/** Required reviews: the attestation Garda derived from its own evidence, or the template the agent must answer. */
export interface NextStepRequiredReviewsCheckArguments extends NextStepPreflightGateArguments {
    /** Set only when Garda's persisted delegated-review evidence proves every required lane. */
    review_authorship_attestation_json: string | null;
    /** The per-lane attestation the agent must state when Garda cannot prove a lane; null when none is needed. */
    review_authorship_attestation_template: string | null;
}

/** Materializing review follow-ups: Garda-instructed rows that the rules say to create without asking. */
export interface NextStepMaterializeReviewFollowUpArguments {
    task_id: string;
    review_type: string | null;
    review_types: string[];
    disposition_artifact_path: string | null;
    receipt_path: string | null;
    artifact_path: string | null;
    reviews_root: string | null;
}

export interface NextStepBuildReviewContextArguments extends NextStepPreflightGateArguments {
    review_type: string;
    depth: number;
}

/** A lane's scoped diff: every path is the repo-relative value the rendered command shows. */
export interface NextStepBuildScopedDiffArguments {
    task_id: string;
    review_type: string;
    preflight_path: string;
    output_path: string;
    metadata_path: string;
    /** The preflight generation the navigator selected this step for; the gate refuses any other preflight bytes. */
    preflight_sha256: string;
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
    /** The attestation source a persisted launch already recorded (a recovered start or return); null otherwise. */
    attestation_source?: string | null;
    /** Present only on a Garda-owned recovery of a persisted launch transition. */
    recover_publication_sha256?: string;
}

/** Routing a delegated lane: Garda derives the planned reviewer identity; the agent supplies nothing. */
export interface NextStepRecordReviewRoutingArguments {
    task_id: string;
    review_type: string;
    task_mode_path: string | null;
}

/**
 * A fresh run of a project check the navigator already bound from authenticated state: the focused command of the
 * agent's own retained run (with its selected cases and report files, each a JSON value as the gate accepts it), or
 * an admitted declared recipe. Exactly one of `command` and `recipe_id` is set.
 */
export interface NextStepRunIntermediateCommandArguments {
    task_id: string;
    recipe_id: string | null;
    command: string | null;
    command_source: 'targeted-test' | null;
    preflight_path: string | null;
    selected_cases: string[];
    report_files: string[];
}

export type NextStepReviewerBookkeepingOperation = {
    operation_id: 'prepare-reviewer-launch' | 'record-reviewer-delegation-started' | 'complete-reviewer-launch'
        | 'record-review-invocation' | 'record-review-result';
    arguments: NextStepReviewerBookkeepingArguments;
};

export type NextStepCommandOperation =
    | NextStepReviewerBookkeepingOperation
    | { operation_id: 'enter-task-mode'; arguments: NextStepEnterTaskModeArguments }
    | { operation_id: 'handshake-diagnostics'; arguments: { task_id: string; task_mode_path?: string } }
    | { operation_id: 'shell-smoke-preflight'; arguments: { task_id: string; task_mode_path?: string } }
    | { operation_id: 'classify-change'; arguments: NextStepClassifyChangeArguments }
    | { operation_id: 'execute-next-step-effects'; arguments: NextStepExecuteEffectsArguments }
    | { operation_id: 'bind-rule-pack-to-preflight'; arguments: NextStepRulePackBindArguments }
    | { operation_id: 'quality-checklist'; arguments: NextStepQualityChecklistArguments }
    | { operation_id: 'compile-gate'; arguments: NextStepPreflightGateArguments }
    | { operation_id: 'task-test-validation'; arguments: NextStepTaskTestValidationArguments }
    | { operation_id: 'build-review-context'; arguments: NextStepBuildReviewContextArguments }
    | { operation_id: 'build-scoped-diff'; arguments: NextStepBuildScopedDiffArguments }
    | { operation_id: 'record-review-routing'; arguments: NextStepRecordReviewRoutingArguments }
    | { operation_id: 'run-intermediate-command'; arguments: NextStepRunIntermediateCommandArguments }
    | { operation_id: 'required-reviews-check'; arguments: NextStepRequiredReviewsCheckArguments }
    | { operation_id: 'materialize-review-follow-up-tasks'; arguments: NextStepMaterializeReviewFollowUpArguments }
    | { operation_id: 'completion-gate'; arguments: NextStepPreflightGateArguments }
    | { operation_id: 'task-audit-summary'; arguments: { task_id: string } };

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

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

export function attachNextStepCommandExecution(
    command: NextStepCommand,
    boundary: NextStepCommandBoundaryKind,
    operation: NextStepCommandOperation | null = null
): NextStepCommand {
    commandExecutions.set(command, Object.freeze({
        boundary,
        operation: operation ? deepFreeze(structuredClone(operation)) : null,
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
