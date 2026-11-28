import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDeclaredBaselineChecks } from '../../core/full-suite-validation-config';
import { createInvocationReadMemoKey, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { stringSha256 } from '../../gate-runtime/hash';
import { appendMandatoryTaskEvent, inspectTaskEventFile, readTaskTimelineJsonlEntries, withTaskTimelineReadSnapshot,
    type TaskTimelineJsonlEntry } from '../../gate-runtime/task-events';
import { executeCommandAsync } from '../../cli/gate-cli/gates-subprocess';
import { runWipGit } from '../shared/wip-git';

/**
 * Declared baseline checks (workflow-config `baseline_checks.commands`) are project checks no Garda gate runs itself,
 * such as a plan or documentation validator. There is no comparison: every declared check must be green.
 * - Entry: before enter-task-mode changes anything, each declared check without a green entry result for this task runs
 *   on the tree as found. A red check stops the entry; the project fixes it first (separately) or removes it from the
 *   declaration. A later entry does not run a check that was already green at an earlier entry of the task.
 * - Task test validation: before the reviews each declared check runs again on the current tree; red is this task's
 *   failure. Evaluation stops once all required reviews passed (REVIEW_GATE_PASSED).
 * Garda never moves, rewrites or restores project files for this.
 */
export const BASELINE_CHECK_RECORDED_EVENT = 'BASELINE_CHECK_RECORDED';
export const BASELINE_CHECK_EVALUATED_EVENT = 'BASELINE_CHECK_EVALUATED';
export const BASELINE_CHECK_TIMEOUT_MS = 120_000;
const EXCERPT_LINES = 40;
const EXCERPT_LINE_CHARS = 400;

export type BaselineCheckVerdict = 'GREEN' | 'RED';

export interface BaselineCheckRun {
    command: string;
    started: boolean;
    exit_code: number | null;
    timed_out: boolean;
    cancelled: boolean;
    /** A signal that ended the process; its exit code then says nothing about the check. */
    termination_signal: string | null;
    /** The first lines of the (secret-masked) output, for the operator. */
    output_excerpt: string[];
    error?: string;
}

/** Runs one declared check in the normal project environment: the repository root and the inherited environment. */
export async function runBaselineCheck(repoRoot: string, command: string, timeoutMs = BASELINE_CHECK_TIMEOUT_MS): Promise<BaselineCheckRun> {
    try {
        const result = await executeCommandAsync(command, { cwd: path.resolve(repoRoot), timeoutMs });
        const startError = result.invocations?.find(invocation => invocation.executionError !== undefined)?.executionError;
        return {
            command, started: startError === undefined, exit_code: result.exitCode, timed_out: result.timedOut, cancelled: result.cancelled,
            termination_signal: result.terminationSignal ?? result.invocations?.find(invocation => invocation.terminationSignal)?.terminationSignal ?? null,
            output_excerpt: result.outputLines.map(line => line.replace(/\r/gu, '').trimEnd()).filter(Boolean).slice(0, EXCERPT_LINES)
                .map(line => line.length > EXCERPT_LINE_CHARS ? line.slice(0, EXCERPT_LINE_CHARS) + '...' : line),
            ...(startError !== undefined ? { error: startError } : {})
        };
    } catch (error) {
        return { command, started: false, exit_code: null, timed_out: false, cancelled: false, termination_signal: null,
            output_excerpt: [], error: error instanceof Error ? error.message : String(error) };
    }
}

/** Why a run is red, or null when it is green (started, exit code 0, not timed out, cancelled or signalled). */
export function redRunReason(run: BaselineCheckRun, timeoutMs = BASELINE_CHECK_TIMEOUT_MS): string | null {
    if (!run.started || run.exit_code === null) return `it could not start (${run.error ?? 'no exit code'})`;
    if (run.timed_out) return `it timed out after ${timeoutMs} ms`;
    if (run.cancelled) return 'it was cancelled';
    if (run.termination_signal) return `it was terminated by signal ${run.termination_signal}`;
    if (run.exit_code !== 0) return `it exited ${run.exit_code}`;
    return null;
}

/** A red run that says nothing about the project (it did not finish): only a rerun is needed after removing the cause. */
const runDidNotFinish = (run: BaselineCheckRun) => !run.started || run.exit_code === null || run.timed_out || run.cancelled || !!run.termination_signal;

const entrySha256 = (entry: TaskTimelineJsonlEntry) => stringSha256(entry.rawLine.trim()) ?? '';
const eventType = (entry: TaskTimelineJsonlEntry) => String(entry.record?.event_type ?? '');
const gateDetails = (entry: TaskTimelineJsonlEntry): Record<string, unknown> | null =>
    entry.record?.actor === 'gate' && isPlainRecord(entry.record.details) ? entry.record.details : null;
const eventsRootOf = (repoRoot: string) => joinOrchestratorPath(repoRoot, 'runtime/task-events');

function readSignedEntries(repoRoot: string, taskId: string): readonly TaskTimelineJsonlEntry[] {
    const eventsRoot = eventsRootOf(repoRoot);
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fs.existsSync(timelinePath)) return [];
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const { status } = inspectTaskEventFile(timelinePath, taskId);
        if (status !== 'PASS' && status !== 'PASS_WITH_LEGACY_PREFIX') return [];
        return readTaskTimelineJsonlEntries(timelinePath).filter(entry => entry.record?.integrity);
    });
}

/** Signed entries of the current task-mode cycle, from its TASK_MODE_ENTERED on. */
function readCurrentCycle(repoRoot: string, taskId: string) {
    const entries = readSignedEntries(repoRoot, taskId);
    const start = entries.map(eventType).lastIndexOf('TASK_MODE_ENTERED');
    if (start < 0) return null;
    const cycle = entries.slice(start);
    const compileIndex = cycle.map(entry => entry.record?.outcome === 'PASS' ? eventType(entry) : '').lastIndexOf('COMPILE_GATE_PASSED');
    return { entries: cycle, entrySha256: entrySha256(cycle[0]), compileIndex };
}

/** Commands that were green at an earlier task-mode entry of this task (bound to that signed entry). */
function readEntryGreenCommands(entries: readonly TaskTimelineJsonlEntry[]): Set<string> {
    const entered = new Set(entries.filter(entry => eventType(entry) === 'TASK_MODE_ENTERED').map(entrySha256));
    return new Set(entries.flatMap(entry => {
        const details = gateDetails(entry);
        return eventType(entry) === BASELINE_CHECK_RECORDED_EVENT && entry.record?.outcome === 'PASS' && details?.verdict === 'GREEN'
            && typeof details.command === 'string' && entered.has(String(details.task_mode_entry_sha256)) ? [details.command] : [];
    }));
}

function readHead(repoRoot: string): string | null {
    try { return runWipGit(repoRoot, ['rev-parse', 'HEAD']).trim() || null; } catch { return null; }
}

const runFields = (run: BaselineCheckRun) => ({
    exit_code: run.exit_code, timed_out: run.timed_out, cancelled: run.cancelled, termination_signal: run.termination_signal,
    output_excerpt: run.output_excerpt, ...(run.error ? { error: run.error } : {})
});

export interface PreparedEntryBaselineChecks {
    timeoutMs: number;
    head_commit: string | null;
    runs: Array<{ command: string; run: BaselineCheckRun; red: string | null }>;
}

/**
 * Runs before enter-task-mode changes anything (the task queue status included): each declared check without a green
 * result at an earlier entry of this task runs once on the tree as found. Null when no check is declared.
 */
export async function prepareTaskEntryBaselineChecks(repoRoot: string, taskId: string,
    timeoutMs = BASELINE_CHECK_TIMEOUT_MS): Promise<PreparedEntryBaselineChecks | null> {
    const commands = loadDeclaredBaselineChecks(repoRoot);
    if (!commands.length) return null;
    const green = readEntryGreenCommands(readSignedEntries(repoRoot, taskId));
    const runs: PreparedEntryBaselineChecks['runs'] = [];
    for (const command of commands.filter(entry => !green.has(entry))) {
        const run = await runBaselineCheck(repoRoot, command, timeoutMs);
        runs.push({ command, run, red: redRunReason(run, timeoutMs) });
    }
    return { timeoutMs, head_commit: readHead(repoRoot), runs };
}

/** The one instruction for a check that is red before the task. */
export function entryRedInstruction(command: string): string {
    return `Project check ${command} is red before this task. Fix it first (separately), or remove it from baseline_checks `
        + '(workflow set --baseline-checks), then run enter-task-mode again.';
}

/**
 * A red entry run stops the entry before it changes anything. Nothing is written to the task timeline (a task that was
 * never entered must not look started); the refusal lines name each red check with the instruction. Null when nothing is red.
 */
export function refuseRedTaskEntryBaselineChecks(prepared: PreparedEntryBaselineChecks | null): string[] | null {
    const red = prepared?.runs.filter(entry => entry.red) ?? [];
    if (!red.length) return null;
    const lines = ['TASK_MODE_ENTRY_REFUSED'];
    for (const { command, run, red: reason } of red) {
        lines.push(`BaselineCheck: ${command} -> RED before this task (${reason}).`, ...run.output_excerpt.slice(0, 10).map(line => `    ${line}`),
            entryRedInstruction(command));
    }
    return lines;
}

/** After a successful entry: the green entry runs are signed and bound to this task-mode entry. */
export function recordTaskEntryBaselineChecks(repoRoot: string, taskId: string, prepared: PreparedEntryBaselineChecks | null): string[] {
    if (!prepared) return [];
    const cycle = readCurrentCycle(repoRoot, taskId);
    if (!cycle) return ['BaselineChecks: not recorded; the task has no task-mode entry.'];
    const lines: string[] = [];
    for (const { command, run, red } of prepared.runs) {
        if (red) continue;
        appendMandatoryTaskEvent(joinOrchestratorPath(repoRoot, ''), taskId, BASELINE_CHECK_RECORDED_EVENT, 'PASS',
            'A declared project check is green at task-mode entry.',
            { task_mode_entry_sha256: cycle.entrySha256, head_commit: prepared.head_commit, command, verdict: 'GREEN', reason: null, ...runFields(run) },
            { actor: 'gate' });
        lines.push(`BaselineCheck: ${command} -> GREEN at task-mode entry.`);
    }
    return lines;
}

export interface BaselineCheckDecision {
    /** Declared checks whose latest evaluation is red. */
    failures: Array<{ command: string; reason: string; didNotFinish: boolean }>;
    /** Declared checks without an evaluation of the current compiled scope (none before a compile pass). */
    missing: string[];
    /** All required reviews passed in this task-mode cycle: nothing is evaluated or routed any more. */
    reviewed: boolean;
}

const DECISION = createInvocationReadMemoKey<BaselineCheckDecision | null>('baseline-check-decision');

/**
 * The one decision review admission, next-step and completion share. Null when no check is declared. Until all required
 * reviews passed, every declared check needs a green evaluation after the latest compile pass. After that only the
 * evaluations before it count; a check declared later is not evaluated for this task.
 */
export function readBaselineCheckDecision(repoRoot: string, taskId: string): BaselineCheckDecision | null {
    if (!taskId) return null;
    return memoizeInvocationRead(DECISION, JSON.stringify([path.resolve(repoRoot), taskId]), () => {
        const commands = loadDeclaredBaselineChecks(repoRoot);
        if (!commands.length) return null;
        const cycle = readCurrentCycle(repoRoot, taskId);
        if (!cycle) return { failures: [], missing: commands, reviewed: false };
        // Every code change needs a new compile pass before task tests; evaluations bind to the latest one.
        const anchor = cycle.compileIndex;
        if (anchor < 0) return { failures: [], missing: commands, reviewed: false };
        const compileSha256 = entrySha256(cycle.entries[anchor]);
        // Frozen only by a review gate pass after the latest compile; a compile after it (a new review cycle) unfreezes.
        const frozenAt = cycle.entries.findIndex((entry, index) => index > anchor
            && eventType(entry) === 'REVIEW_GATE_PASSED' && entry.record?.outcome === 'PASS');
        const decision: BaselineCheckDecision = { failures: [], missing: [], reviewed: frozenAt >= 0 };
        const evaluations = cycle.entries.slice(0, frozenAt < 0 ? undefined : frozenAt);
        const currentEvaluations = evaluations.slice(anchor + 1).reverse();
        for (const command of commands) {
            const isCommandEvaluation = (entry: TaskTimelineJsonlEntry) => eventType(entry) === BASELINE_CHECK_EVALUATED_EVENT
                && gateDetails(entry)?.command === command && gateDetails(entry)?.task_mode_entry_sha256 === cycle.entrySha256;
            const latest = currentEvaluations.find(entry => isCommandEvaluation(entry)
                && gateDetails(entry)?.compile_event_sha256 === compileSha256);
            if (!latest) {
                // A check introduced after the review pass has no evaluation in the frozen history.
                if (!decision.reviewed || evaluations.some(isCommandEvaluation)) decision.missing.push(command);
                continue;
            }
            const details = gateDetails(latest) ?? {};
            if (latest.record?.outcome === 'PASS' && details.verdict === 'GREEN') continue;
            decision.failures.push({ command, reason: typeof details.reason === 'string' ? details.reason : 'the check is red',
                didNotFinish: details.did_not_finish === true });
        }
        return decision;
    }).value;
}

/** Review admission until all required reviews passed: every declared check needs a green result of the current compiled scope. */
export function baselineCheckReviewAdmissionViolations(repoRoot: string, taskId: string): string[] {
    const decision = readBaselineCheckDecision(repoRoot, taskId);
    if (!decision) return [];
    return [
        ...decision.failures.map(failure => `declared baseline check "${failure.command}" is red (${failure.reason})`),
        ...decision.missing.map(command => `declared baseline check "${command}" has no result for the current compiled scope`)
    ].map(text => `${text}; run task test validation and make it green before the review.`);
}

/** Completion refuses a declared check whose latest result is red or that has no result. */
export function baselineCheckCompletionViolations(repoRoot: string, taskId: string): string[] {
    const decision = readBaselineCheckDecision(repoRoot, taskId);
    if (!decision) return [];
    return [
        ...decision.failures.map(failure => `Declared baseline check "${failure.command}" is red in this task and has no later green result.`),
        ...decision.missing.map(command => `Declared baseline check "${command}" has no result for the current compiled scope.`)
    ].map(text => `${text} Follow next-step: it runs task test validation, which evaluates the check on the current tree.`);
}

/**
 * Task test validation step: runs each declared check on the current tree and records GREEN or RED. Once all required
 * reviews passed in this cycle nothing is evaluated again, so the feature never sends a reviewed task back.
 */
export async function evaluateBaselineChecks(repoRoot: string, taskId: string, timeoutMs = BASELINE_CHECK_TIMEOUT_MS): Promise<{ lines: string[]; failed: boolean }> {
    const commands = loadDeclaredBaselineChecks(repoRoot);
    if (!commands.length) return { lines: [], failed: false };
    const cycle = readCurrentCycle(repoRoot, taskId);
    if (!cycle) return { lines: ['BaselineChecks: FAILED; the task has no task-mode entry.'], failed: true };
    if (cycle.compileIndex < 0) return { lines: ['BaselineChecks: FAILED; run compile-gate before task test validation.'], failed: true };
    if (readBaselineCheckDecision(repoRoot, taskId)?.reviewed) {
        return { lines: ['BaselineChecks: not evaluated again; all required reviews already passed in this task-mode cycle.'], failed: false };
    }
    const compileSha256 = entrySha256(cycle.entries[cycle.compileIndex]);
    const head = readHead(repoRoot);
    const lines: string[] = [];
    let failed = false;
    for (const command of commands) {
        const run = await runBaselineCheck(repoRoot, command, timeoutMs);
        const red = redRunReason(run, timeoutMs);
        const didNotFinish = runDidNotFinish(run);
        appendMandatoryTaskEvent(joinOrchestratorPath(repoRoot, ''), taskId, BASELINE_CHECK_EVALUATED_EVENT, red ? 'FAIL' : 'PASS',
            `Declared baseline check evaluated: ${red ? 'RED' : 'GREEN'}.`,
            { task_mode_entry_sha256: cycle.entrySha256, compile_event_sha256: compileSha256, head_commit: head,
                command, verdict: red ? 'RED' : 'GREEN', reason: red,
                did_not_finish: didNotFinish, ...runFields(run) }, { actor: 'gate' });
        if (!red) {
            lines.push(`BaselineCheck: ${command} -> GREEN.`);
            continue;
        }
        failed = true;
        lines.push(`BaselineCheck: ${command} -> RED (${red}); a red declared check is a failure of this task.`,
            ...run.output_excerpt.slice(0, 10).map(line => `    ${line}`),
            didNotFinish
                ? '  Next: the run did not finish; remove the cause (for example a hang or a missing tool), then follow next-step to rerun task test validation.'
                : '  Next: fix this failure in this task, then follow next-step to rerun task test validation.');
    }
    return { lines, failed };
}
