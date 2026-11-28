import { quoteCommandValue } from '../../core/command-quoting';
import type { NextStepCommand, NextStepStatus } from './next-step';
// A leaf module: the parent-audit navigation graph must not load with the invariant (restore-child RSS budget).
import { PARENT_SOURCE_PREREQUISITES_REASON } from '../parent-audit/parent-audit-source-prerequisites-reason';

/**
 * T-403: the no-dead-end invariant of the navigator. A BLOCKED answer must carry a command that can move the task on
 * (an agent command: not a read-only diagnostic, not operator-only, not the safe-exit preview itself), unless its step is
 * one of two explicit, justified exemptions, named by a marker the producing route sets (`decision`) or, for gates whose
 * producers all share one purpose, by the lists below. The safe-exit preview never counts as progress: it is the fallback the
 * invariant exists to make visible, so checks that run on a rendered answer still see a route that needed it.
 */

/** The agent's own stated work: the reason must name the action (edit the files, fill the answers, run the check). */
export const AGENT_ACTION_GATES: readonly string[] = Object.freeze([
    'implementation',
    'quality-checklist',
    'test-first-expected-failure',
    'await-project-validation',
    'activate-optional-skill',
    'optional-skill-remediation',
    'materialize-planned-scope',
    'child-task',
    'task-plan-integrity',
    'full-suite-repair-child-scope',
    'post-done-drift',
    // Create and link the parent-derived child task rows the decision artifact names.
    'strict-decomposition-split-routing',
    // The reason carries the command template; the agent declares the actual project command it names.
    'run-intermediate-command'
]);

/**
 * Legitimate operator decisions: no agent command exists and none may be invented (an agent must not approve these).
 * Each entry says why; such a route still gets the read-only reopen preview as its only stated command.
 */
export interface OperatorDecisionGate {
    why: string;
    /** The route always carries a real command today: a regression to the preview alone must stay visible. */
    requiresCommand?: boolean;
}

export const OPERATOR_DECISION_GATES: Readonly<Record<string, OperatorDecisionGate>> = Object.freeze({
    'operator-maintenance': { why: 'the protected Garda bundle may only be changed by the operator' },
    'task-metadata-validation': { why: 'the operator alone changes the task row, its required reviews or its capabilities' },
    'decomposed-parent-obligations': { why: 'a damaged parent decomposition reference is repaired by the operator' },
    'manual-scope-selection': { why: 'the operator chooses the scope the agent must not derive from the whole workspace' },
    'follow-up-scope-evidence': { why: 'the operator decides whether missing follow-up scope evidence is accepted' },
    'post-review-source-mutation-guard': {
        why: 'the operator decides whether a post-review edit is restored, kept or moved', requiresCommand: true
    },
    'split-required-latch': { why: 'the gate-owned split latch artifact is invalid: only the operator repairs or resets it' },
    'test-first-expected-red-stale': { why: 'the stale retained RED marker is removed only with operator approval' }
});

/**
 * Marker a producing route sets for an operator decision that does not follow from its gate name. Agent actions have no
 * marker: every agent-action producer is named by its gate in AGENT_ACTION_GATES, so no route can claim one by itself.
 */
export type NextStepRouteDecision = 'operator';

/**
 * The cause is outside the task: the stated retry of next-step is the progressing command. `git-observation`: an
 * unreadable Git index. `validation-inspection`: declared validation inputs changed between two reads of one inspection
 * (a typed race); stable inputs pass the fresh inspection, so the retry cannot repeat on unchanged inputs.
 */
export const NEXT_STEP_RETRY_GATES: readonly string[] = Object.freeze(['git-observation', 'validation-inspection']);

export const SAFE_EXIT_LABEL = 'Preview the task reopen (read-only, operator decision)';

/**
 * The safe-exit previews this module appended, bound to the command text they were created with. Identity binding is
 * deliberate: a copied or rebuilt entry is no longer the preview to its consumers, so it is counted as an ordinary
 * command, which can only turn a step into a stop, never a stop into an executable step.
 */
const safeExitCommands = new WeakMap<object, string>();

/** True only for the read-only reopen preview that applyNextStepSafeExit appended, unchanged. */
export function isNextStepSafeExitCommand(command: NextStepCommand): boolean {
    return command.label === SAFE_EXIT_LABEL && safeExitCommands.get(command) === command.command;
}

/** Sub-commands that only report state: running them cannot change the route. */
const DIAGNOSTIC_SUB_COMMANDS: readonly string[] = Object.freeze(['doctor', 'status', 'why-blocked']);

/** `--confirm` executes a reset or repair the operator alone may approve; `--operator-confirmed <yes>` is the exact command an agent runs once the operator approved. */
const OPERATOR_ONLY_FLAG = /(?:^|\s)--confirm(?:\s|=|$)/u;

export interface NextStepProgressSubject {
    taskId: string;
    navigatorCommand: string;
    status: NextStepStatus;
    nextGate: string | null;
    reason: string;
    commands: NextStepCommand[];
    /** Set by the producing route for an operator decision its gate name does not imply. */
    decision?: NextStepRouteDecision | null;
}

function readCliPrefix(navigatorCommand: string): string | null {
    const index = navigatorCommand.indexOf(' next-step ');
    return index > 0 ? navigatorCommand.slice(0, index) : null;
}

function readNextStepTaskId(rest: string): string {
    const token = rest.split(/\s+/u)[1] ?? '';
    return token.replace(/^["']|["']$/gu, '');
}

/**
 * Read-only for the invariant: doctor, status, why-blocked, and a plain rerun of this task's navigator. A navigator run
 * of another task, with --execute-effects, or on a retry gate (the cause is outside the task) is a stated step.
 */
function isDiagnosticCommand(command: string, cliPrefix: string | null, subject: NextStepProgressSubject): boolean {
    const text = command.trim();
    const rest = cliPrefix && text.startsWith(`${cliPrefix} `) ? text.slice(cliPrefix.length + 1) : text;
    const subCommand = rest.split(/\s+/u)[0] ?? '';
    if (subCommand === 'next-step') {
        return !/(?:^|\s)--execute-effects(?:\s|$)/u.test(rest)
            && readNextStepTaskId(rest) === subject.taskId
            && !(subject.nextGate !== null && NEXT_STEP_RETRY_GATES.includes(subject.nextGate));
    }
    return DIAGNOSTIC_SUB_COMMANDS.includes(subCommand);
}

function isOperatorDecisionGate(nextGate: string | null): boolean {
    return nextGate !== null && Object.prototype.hasOwnProperty.call(OPERATOR_DECISION_GATES, nextGate);
}

/** The parent-acceptance prerequisite the operator repairs: a gate-less route identified by its exported reason. */
function isParentSourcePrerequisiteDecision(subject: Pick<NextStepProgressSubject, 'nextGate' | 'reason'>): boolean {
    return subject.nextGate === null && subject.reason.includes(PARENT_SOURCE_PREREQUISITES_REASON);
}

/** A legitimate operator decision: a listed gate, the producing route's `decision` marker or the parent prerequisite. */
export function isNextStepOperatorDecision(subject: Pick<NextStepProgressSubject, 'nextGate' | 'reason' | 'decision'>): boolean {
    return subject.decision === 'operator' || isOperatorDecisionGate(subject.nextGate) || isParentSourcePrerequisiteDecision(subject);
}

function isAgentAction(subject: NextStepProgressSubject): boolean {
    return subject.nextGate !== null && AGENT_ACTION_GATES.includes(subject.nextGate);
}

/** An agent command that can change the route: not the safe-exit preview, not a diagnostic, not operator-only. */
function hasProgressingCommand(subject: NextStepProgressSubject): boolean {
    const cliPrefix = readCliPrefix(subject.navigatorCommand);
    return subject.commands.some(entry => entry.label !== SAFE_EXIT_LABEL
        && !isDiagnosticCommand(entry.command, cliPrefix, subject)
        && !OPERATOR_ONLY_FLAG.test(entry.command));
}

/**
 * Returns why the answer is a dead end, or null. Works on a rendered answer too: the safe-exit preview is ignored, so a
 * route that needed the fallback is reported. Operator decisions and agent actions are the only exemptions.
 */
export function findNextStepProgressViolation(subject: NextStepProgressSubject): string | null {
    if (subject.status !== 'BLOCKED') {
        return null;
    }
    const gate = subject.nextGate ?? 'none';
    if (isAgentAction(subject)) {
        return subject.reason.trim() ? null : `BLOCKED agent-action route '${gate}' names no action.`;
    }
    const listed = subject.nextGate !== null && isOperatorDecisionGate(subject.nextGate)
        ? OPERATOR_DECISION_GATES[subject.nextGate] : null;
    if (isNextStepOperatorDecision(subject)) {
        if (!subject.reason.trim()) {
            return `BLOCKED operator-decision route '${gate}' states no decision.`;
        }
        return listed?.requiresCommand && subject.commands.every(entry => entry.label === SAFE_EXIT_LABEL)
            ? `BLOCKED operator-decision route '${gate}' lost the command it always carries.` : null;
    }
    if (hasProgressingCommand(subject)) {
        return null;
    }
    const stated = subject.commands.filter(entry => entry.label !== SAFE_EXIT_LABEL).map(entry => entry.command);
    return stated.length === 0
        ? `BLOCKED route '${gate}' has no command.`
        : `BLOCKED route '${gate}' offers no agent command that can progress (only diagnostics or operator-only): ${stated.join(' | ')}`;
}

/**
 * Gives an answer without an agent command the universal safe exit: the read-only reopen preview. It adds no authority:
 * the operator alone may run the confirmed reset it previews. Answers that already progress are returned as is.
 */
export function applyNextStepSafeExit<T extends NextStepProgressSubject>(subject: T): T {
    const cliPrefix = readCliPrefix(subject.navigatorCommand);
    const exempt = subject.status !== 'BLOCKED' || isAgentAction(subject);
    if (!cliPrefix || exempt || hasProgressingCommand(subject) || subject.commands.some(entry => entry.label === SAFE_EXIT_LABEL)) {
        return subject;
    }
    const preview = `${cliPrefix} gate task-reset --task-id ${quoteCommandValue(subject.taskId)} --reopen --dry-run --repo-root "."`;
    const safeExit: NextStepCommand = { label: SAFE_EXIT_LABEL, command: preview };
    safeExitCommands.set(safeExit, preview);
    return {
        ...subject,
        reason: `${subject.reason.trim()} No agent command can progress this state: the operator decides. `
            + 'The command below is a read-only preview (--dry-run) of what a task reopen would reset. '
            + 'Only the operator may run it with --confirm in place of --dry-run, after explicit approval.',
        commands: [...subject.commands, safeExit]
    };
}
