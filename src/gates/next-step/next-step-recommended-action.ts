import type { NextStepResult } from './next-step';
import {
    readNextStepCommandExecution,
    type NextStepCommandOperation,
    type NextStepReviewerBookkeepingArguments
} from './next-step-command-execution';
import { splitCommandLine } from '../../core/command-line';
import { quoteCommandValue as quoteShellCommandValue } from '../../core/command-quoting';
import { selectTaskCompositeAction } from './next-step-composite-action';
import { isNextStepAdvanceRecommendationUnavailable } from './next-step-composite-recommendation-context';

/**
 * The one action the navigator states. `kind` names what the composite does next: run its mechanical steps,
 * enter the task, record a real reviewer launch or return, or run the closeout; the command is the exact composite
 * invocation with every flag it expects (a placeholder marks a value only the agent or provider knows).
 */
export interface NextStepRecommendedAction {
    mode: 'start' | 'advance' | 'finish';
    kind: 'mechanical' | 'entry' | 'reviewer-started' | 'reviewer-returned' | 'closeout' | 'attestation';
    command: string;
}

const ACTION_LABELS: Readonly<Record<NextStepRecommendedAction['kind'], string>> = Object.freeze({
    mechanical: 'Run mechanical steps',
    entry: 'Start the task',
    'reviewer-started': 'Launch one fresh delegated reviewer with the prepared input, then record its start',
    'reviewer-returned': 'Record the returned review',
    closeout: 'Run closeout',
    attestation: 'Run closeout with your review authorship attestation'
});

/** Placeholders for values only the provider's real launch result supplies; the gates reject them unchanged. */
const PROVIDER_INVOCATION_ID_PLACEHOLDER = '<provider-owned invocation id from delegated reviewer launch result>';
const PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER = '<provider-owned attestation source from delegated reviewer launch result>';
const REVIEWER_IDENTITY_PLACEHOLDER = '<actual delegated reviewer identity>';

/** Entry flags `task <id> start` forwards unchanged; any other flag keeps the printed gate command. */
const START_FORWARDED_VALUE_FLAGS: ReadonlySet<string> = new Set([
    '--provider', '--routed-to', '--planned-changed-file', '--operator-confirmed', '--operator-confirmed-at-utc'
]);
const START_FORWARDED_SWITCHES: ReadonlySet<string> = new Set(['--orchestrator-work', '--workflow-config-work']);
/** Values the composite takes from the navigator's own entry descriptor. */
const START_DERIVED_VALUE_FLAGS: ReadonlySet<string> = new Set(['--task-id', '--entry-mode', '--requested-depth', '--task-summary']);

/** The label of the single stated action in the default and full navigator text. */
export function formatNextStepRecommendedActionLabel(action: NextStepRecommendedAction): string {
    return ACTION_LABELS[action.kind];
}

function compositeCommand(result: NextStepResult, mode: NextStepRecommendedAction['mode'], flags: string[] = []): string | null {
    // Reuse the navigator invocation verbatim, including its CLI prefix and repo-root argument. This substitution
    // formats the recommendation; command text never supplies execution authority or determines eligibility.
    const invocation = ` next-step "${result.task_id}" `;
    const suffix = flags.length ? ` ${flags.join(' ')}` : '';
    const command = result.navigator_command.replace(invocation, ` task "${result.task_id}" ${mode}${suffix} `);
    return command === result.navigator_command ? null : command;
}

function action(
    result: NextStepResult, mode: NextStepRecommendedAction['mode'], kind: NextStepRecommendedAction['kind'], flags: string[] = []
): NextStepRecommendedAction | null {
    const command = compositeCommand(result, mode, flags);
    return command ? { mode, kind, command } : null;
}

function singleOperation(result: NextStepResult, boundary: 'agent' | 'mechanical'): NextStepCommandOperation | null {
    if (result.commands.length !== 1) return null;
    const execution = readNextStepCommandExecution(result.commands[0]);
    return execution?.boundary === boundary ? execution.operation : null;
}

/**
 * Fresh task-mode entry: the printed entry flags that `start` forwards, or null when the printed command needs a
 * flag `start` does not take (then the gate command itself stays the stated action).
 */
function readStartFlags(result: NextStepResult): string[] | null {
    if (singleOperation(result, 'agent')?.operation_id !== 'enter-task-mode') return null;
    const tokens = splitCommandLine(result.commands[0].command);
    const gateIndex = tokens.indexOf('enter-task-mode');
    if (gateIndex < 0) return null;
    const flags: string[] = [];
    for (let index = gateIndex + 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--repo-root') { index += 1; continue; }
        if (START_DERIVED_VALUE_FLAGS.has(token)) { index += 1; continue; }
        if (START_FORWARDED_SWITCHES.has(token)) { flags.push(token); continue; }
        if (!START_FORWARDED_VALUE_FLAGS.has(token) || index + 1 >= tokens.length) return null;
        const value = tokens[index + 1];
        // An environment reference (the provider variable) stays double-quoted so the shell still expands it.
        flags.push(token, /^\$(?:env:)?[A-Z_][A-Z0-9_]*$/u.test(value) ? `"${value}"` : quoteShellCommandValue(value));
        index += 1;
    }
    return flags.includes('--provider') ? flags : null;
}

function reviewerFlags(args: NextStepReviewerBookkeepingArguments, phase: 'started' | 'returned'): string[] | null {
    if (!args.launch_input_mode || !args.launch_input_sha256) return null;
    // Values a persisted launch already recorded are printed as recorded (a recovered start repeats them exactly);
    // only values the provider's real launch result has not yet supplied stay placeholders.
    const launchRecorded = Boolean(args.provider_invocation_id || args.controller_invocation_id);
    const flags = [
        '--reviewer-phase', phase,
        '--review-type', quoteShellCommandValue(args.review_type),
        '--reviewer-identity', quoteShellCommandValue((phase === 'returned' || launchRecorded) && args.reviewer_identity
            ? args.reviewer_identity : REVIEWER_IDENTITY_PLACEHOLDER),
        ...(args.controller_invocation_id
            ? ['--controller-invocation-id', quoteShellCommandValue(args.controller_invocation_id)]
            : ['--provider-invocation-id', quoteShellCommandValue(args.provider_invocation_id || PROVIDER_INVOCATION_ID_PLACEHOLDER)]),
        '--attestation-source', quoteShellCommandValue(launchRecorded && args.attestation_source
            ? args.attestation_source : PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER),
        '--fork-context', 'false',
        '--launch-input-mode', args.launch_input_mode,
        '--launch-input-sha256', args.launch_input_sha256,
        ...(args.launch_input_mode === 'launch_artifact_path' && args.launch_input_artifact_path
            ? ['--launch-input-artifact-path', quoteShellCommandValue(args.launch_input_artifact_path)] : [])
    ];
    if (phase === 'returned') {
        if (!args.review_output_path) return null;
        flags.push('--review-output-path', quoteShellCommandValue(args.review_output_path));
    }
    return flags;
}

/** A real reviewer launch or return: the first navigator choice the `advance` reviewer phase accepts. */
function readReviewerAction(result: NextStepResult): NextStepRecommendedAction | null {
    for (const command of result.commands) {
        const execution = readNextStepCommandExecution(command);
        const operation = execution?.boundary === 'agent' ? execution.operation : null;
        if (!operation || operation.operation_id !== result.next_gate) continue;
        if (operation.operation_id === 'record-reviewer-delegation-started') {
            const flags = reviewerFlags(operation.arguments, 'started');
            return flags ? action(result, 'advance', 'reviewer-started', flags) : null;
        }
        if (['complete-reviewer-launch', 'record-review-invocation', 'record-review-result'].includes(operation.operation_id)) {
            const flags = reviewerFlags((operation as { arguments: NextStepReviewerBookkeepingArguments }).arguments, 'returned');
            return flags ? action(result, 'advance', 'reviewer-returned', flags) : null;
        }
    }
    return null;
}

/**
 * Presentation only. Eligibility, including the default effect allowlist, belongs to the runner's selector. The
 * stated action is the composite that covers the current step: `advance` for mechanical work and reviewer launch
 * or return bookkeeping, `start` for a fresh entry, `finish` for the closeout, each with the exact flags it expects
 * next. Every other step (a choice, an operator approval, a documentation or memory decision, a recovery) keeps the
 * navigator's own command.
 */
export function selectNextStepRecommendedAction(result: NextStepResult): NextStepRecommendedAction | null {
    if (result.review_cycle_block || isNextStepAdvanceRecommendationUnavailable(result)) return null;
    if (selectTaskCompositeAction(result, 'advance', null).kind === 'execute') return action(result, 'advance', 'mechanical');
    if (selectTaskCompositeAction(result, 'finish', null).kind === 'execute') return action(result, 'finish', 'closeout');
    const attestation = singleOperation(result, 'agent');
    if (attestation?.operation_id === 'required-reviews-check' && attestation.arguments.review_authorship_attestation_template) {
        return action(result, 'finish', 'attestation', [
            '--review-authorship-attestation-json', quoteShellCommandValue(attestation.arguments.review_authorship_attestation_template)
        ]);
    }
    const startFlags = readStartFlags(result);
    if (startFlags) return action(result, 'start', 'entry', startFlags);
    return readReviewerAction(result);
}

/** Existing fields and single-step commands are retained; no descriptor or executable authority is serialized. */
export function projectNextStepJson(result: NextStepResult): NextStepResult & { recommended_action?: NextStepRecommendedAction } {
    const recommended = selectNextStepRecommendedAction(result);
    const output: NextStepResult & { recommended_action?: NextStepRecommendedAction } = { ...result };
    if (recommended) output.recommended_action = recommended;
    else delete output.recommended_action;
    return output;
}
