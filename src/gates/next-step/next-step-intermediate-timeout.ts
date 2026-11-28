import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { readValidationFile } from '../../core/project-validation-identity';
import { readImmutableValidationEventSnapshot } from '../project-validation/attempt-evidence';
import { buildCommand, quoteCommandValue } from './next-step-command-formatters';
import { attachNextStepCommandExecution } from './next-step-command-execution';
import type { NextStepDecisionRoutePayload } from './next-step-decision-route-groups';

const MINUTE_MS = 60_000;

export interface TimedOutIntermediateAttempt {
    readonly command: string;
    readonly durationMs: number;
    /** Twice the observed run time, rounded up to whole minutes: the limit offered for operator confirmation. */
    readonly suggestedTimeoutMs: number;
}

/**
 * The latest targeted-test attempt of the current preflight when it timed out and nothing ran after it.
 * Only an attempt whose retained artifact still matches its recorded hash and says `timed_out` counts.
 */
export function readTimedOutIntermediateAttempt(repoRoot: string, taskId: string): TimedOutIntermediateAttempt | null {
    try {
        const snapshot = readImmutableValidationEventSnapshot(repoRoot, taskId);
        const latest = [...snapshot.events].reverse().find(event => event.event_type === 'INTERMEDIATE_COMMAND_STARTED'
            || event.event_type === 'INTERMEDIATE_COMMAND_RUN');
        const details = latest?.details;
        if (latest?.event_type !== 'INTERMEDIATE_COMMAND_RUN' || !isPlainRecord(details)
            || details.command_source !== 'targeted-test' || typeof details.command !== 'string'
            || typeof details.artifact_path !== 'string' || typeof details.artifact_sha256 !== 'string'
            || String(details.preflight_sha256 || '').toLowerCase() !== snapshot.preflight_sha256.toLowerCase()) return null;
        const retained = readValidationFile(repoRoot,
            path.relative(repoRoot, path.resolve(repoRoot, details.artifact_path)).replace(/\\/gu, '/'));
        if (retained.identity.sha256 !== details.artifact_sha256) return null;
        const record: unknown = JSON.parse(retained.bytes.toString('utf8'));
        if (!isPlainRecord(record) || record.task_id !== taskId || record.command !== details.command
            || record.timed_out !== true || record.status !== 'FAILED') return null;
        const durationMs = Number(record.duration_ms);
        if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
        return { command: details.command, durationMs,
            suggestedTimeoutMs: Math.ceil((durationMs * 2) / MINUTE_MS) * MINUTE_MS };
    } catch {
        // Unreadable validation evidence grants nothing; the ordinary route keeps its own diagnostics.
        return null;
    }
}

function namesAttemptCommand(route: NextStepDecisionRoutePayload, command: string): boolean {
    const quoted = `--command ${quoteCommandValue(command)}`;
    return (route.commands ?? []).some(entry => entry.command.includes(' gate run-intermediate-command ')
        && entry.command.includes(quoted) && !/\s--timeout-ms\s/u.test(entry.command));
}

/**
 * A targeted-test run that timed out fails the same way when it is offered again unchanged. Offer the same
 * invocation with an explicit longer limit as an operator-confirmed step, and the `--selected-case` split
 * as the alternative. The default limit itself is never changed.
 */
export function resolveTimedOutIntermediateRoute(options: {
    route: NextStepDecisionRoutePayload;
    /** Read only when the route offers the intermediate command. */
    readAttempt: () => TimedOutIntermediateAttempt | null;
    cliPrefix: string;
    taskId: string;
    preflightCommandPath: string;
}): NextStepDecisionRoutePayload {
    const { route } = options;
    if (!['run-intermediate-command', 'project-validation-evidence'].includes(route.nextGate || '')) return route;
    const attempt = options.readAttempt();
    if (!attempt) return route;
    const offered = (route.commands ?? []).find(entry => entry.command.includes(' gate run-intermediate-command '));
    if (offered ? !namesAttemptCommand(route, attempt.command) : route.nextGate !== 'run-intermediate-command') return route;
    const base = offered?.command ?? `${options.cliPrefix} gate run-intermediate-command --task-id ${quoteCommandValue(options.taskId)}`
        + ` --command-source targeted-test --command ${quoteCommandValue(attempt.command)}`
        + ` --preflight-path ${quoteCommandValue(options.preflightCommandPath)} --repo-root "."`;
    const withTimeout = base.replace(/ --repo-root "\."$/u, '') + ` --timeout-ms ${attempt.suggestedTimeoutMs} --repo-root "."`;
    const seconds = Math.round(attempt.durationMs / 1000);
    return {
        status: 'BLOCKED',
        nextGate: 'run-intermediate-command',
        title: 'Confirm a longer limit for the timed-out project check, or split it.',
        reason: `${route.reason} The last run of this check for the current preflight timed out after ${seconds} s; `
            + 'running it again unchanged fails the same way. With operator confirmation, run it with the explicit '
            + `limit below (twice the observed run time). Alternatively split the check into smaller runs with `
            + '--selected-case so that each one finishes within the default limit.',
        commands: [attachNextStepCommandExecution(
            buildCommand('Run the check with an operator-confirmed longer limit', withTimeout), 'operator')]
    };
}
