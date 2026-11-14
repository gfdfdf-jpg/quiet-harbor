import { countNextStepWork } from '../../core/next-step-measurement';
import { readInvocationVerifiedEventIndex } from '../../gate-runtime/timeline/task-events-integrity';
import { verifiedEventPosition } from '../../gate-runtime/timeline/task-verified-event-index';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveBundleRootForTarget } from '../../core/constants';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile, readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { evaluateProtectedControlPlaneManifest, normalizePath } from '../shared/helpers';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../task-mode/task-mode-evidence';
import type {
    NextStepCommand,
    NextStepStatus
} from './';
import { buildCommand, quoteCommandValue } from './next-step-command-formatters';

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readPathList(value: unknown): string[] {
    return Array.isArray(value) ? value.map((entry) => normalizePath(entry)).filter(Boolean) : [];
}

function formatFailureReason(value: unknown): string {
    return String(value || 'unavailable').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 1000) || 'unavailable';
}

function lastMatchingEvent(events: readonly (Readonly<Record<string, unknown>> | null)[], type: string, outcome: string): Readonly<Record<string, unknown>> | null {
    for (let index = events.length - 1; index >= 0; index--) {
        countNextStepWork('visit:next-step-startup-routing:candidate');
        const event = events[index];
        if (event?.event_type === type && event.outcome === outcome) return event;
    }
    return null;
}

function latestEventDetails(eventsRoot: string, taskId: string, eventType: string, outcome: string): Record<string, unknown> | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timelinePath, taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') return null;
    const indexed = readInvocationVerifiedEventIndex(timelinePath, taskId);
    const entries = indexed ? indexed.byType[eventType] ?? [] : readTaskTimelineJsonlEntries(timelinePath);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:next-step-startup-routing:event:39');
        const item = entries[index];
        const event = indexed ? item as Readonly<Record<string, unknown>> : (item as { record: Readonly<Record<string, unknown>> | null }).record;
        if (event?.event_type === eventType && event.outcome === outcome) {
            return event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown> : null;
        }
    }
    return null;
}

function recoveryEventDetails(eventsRoot: string, taskId: string): Record<string, unknown> | null {
    return latestEventDetails(eventsRoot, taskId, 'TASK_MODE_PROTECTED_MANIFEST_RECOVERED', 'PASS');
}

function trustedFailureArtifact(eventsRoot: string, taskId: string, failurePath: string, failure: Record<string, unknown>): boolean {
    const details = latestEventDetails(eventsRoot, taskId, 'TASK_MODE_ENTRY_FAILED', 'FAIL');
    const attemptPath = path.resolve(String(details?.artifact_path || ''));
    const reviewsRoot = path.dirname(failurePath);
    const expectedAttemptName = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-task-mode-entry-failure-[0-9a-f-]{36}\\.json$`, 'iu');
    return failure.schema_version === 1
        && failure.task_id === taskId && failure.status === 'BLOCKED'
        && /^[0-9a-f-]{36}$/iu.test(String(failure.attempt_id || ''))
        && !!details && path.dirname(attemptPath) === reviewsRoot && expectedAttemptName.test(path.basename(attemptPath))
        && normalizePath(String(details.current_artifact_path || '')) === normalizePath(failurePath)
        && String(details.current_artifact_sha256 || '') === fileSha256(failurePath)
        && fs.existsSync(attemptPath)
        && String(details.artifact_sha256 || '') === fileSha256(attemptPath)
        && fileSha256(attemptPath) === fileSha256(failurePath)
        && String(details.attempt_id || '') === String(failure.attempt_id || '')
        && String(details.timestamp_utc || '') === String(failure.timestamp_utc || '')
        && String(details.manifest_status || '') === String(failure.manifest_status || '')
        && normalizePath(String(details.manifest_path || '')) === normalizePath(String(failure.manifest_path || ''))
        && String(details.observed_protected_snapshot_sha256 || '') === String(failure.observed_protected_snapshot_sha256 || '')
        && JSON.stringify(details.requested_entry) === JSON.stringify(failure.requested_entry);
}

function buildValidatedFreshEntryCommand(cliPrefix: string, taskId: string, value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    if (String(input.taskId || '') !== taskId) return null;
    const parts = [
        `${cliPrefix} gate enter-task-mode`, `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(String(input.entryMode || 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(String(input.requestedDepth || '2'))}`,
        `--task-summary ${quoteCommandValue(String(input.taskSummary || ''))}`,
        `--provider ${quoteCommandValue(String(input.provider || ''))}`
    ];
    for (const [flag, key] of [
        ['--effective-depth', 'effectiveDepth'], ['--start-banner', 'startBanner'], ['--routed-to', 'routedTo'],
        ['--actor', 'actor'], ['--plan-path', 'planPath'], ['--artifact-path', 'artifactPath'],
        ['--metrics-path', 'metricsPath']
    ] as const) {
        const field = String(input[key] || '').trim();
        if (field) parts.push(`${flag} ${quoteCommandValue(field)}`);
    }
    if (input.orchestratorWork === true) parts.push('--orchestrator-work');
    if (input.workflowConfigWork === true) parts.push('--workflow-config-work');
    if (input.orchestratorWork === true || input.workflowConfigWork === true) {
        parts.push('--operator-confirmed yes', '--operator-confirmed-at-utc "<ISO-8601 timestamp>"');
    }
    if (input.emitMetrics === false || String(input.emitMetrics || '').trim().toLowerCase() === 'false') {
        parts.push('--emit-metrics false');
    }
    for (const file of readPathList(input.plannedChangedFiles)) parts.push(`--planned-changed-file ${quoteCommandValue(file)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function readTaskModeProtectedManifestRecoveryRoute(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    cliPrefix: string
): {
    recovered: boolean; reason: string; command: string;
} | null {
    const reviewsRoot = path.join(resolveBundleRootForTarget(repoRoot), 'runtime', 'reviews');
    const failurePath = path.join(reviewsRoot, `${taskId}-task-mode-entry-failure.json`);
    const failure = readJsonRecord(failurePath);
    if (!failure) return null;
    if (!trustedFailureArtifact(eventsRoot, taskId, failurePath, failure)) return null;
    const taskMode = readJsonRecord(path.join(reviewsRoot, `${taskId}-task-mode.json`));
    if (taskMode && Date.parse(String(taskMode.timestamp_utc || '')) > Date.parse(String(failure.timestamp_utc || ''))) return null;
    const recoveryPath = path.join(reviewsRoot, `${taskId}-task-mode-entry-recovery.json`);
    const recovery = readJsonRecord(recoveryPath);
    const eventDetails = recoveryEventDetails(eventsRoot, taskId);
    const requestedEntry = failure.requested_entry;
    const freshEntryCommand = buildValidatedFreshEntryCommand(cliPrefix, taskId, requestedEntry);
    const recoveryMatchesFailure = recovery
        && recovery.schema_version === 1
        && String(recovery.task_id || '') === taskId
        && recovery.status === 'RECOVERED'
        && recovery.status_after === 'MATCH'
        && normalizePath(String(recovery.failure_artifact_path || '')) === normalizePath(failurePath)
        && String(recovery.failure_artifact_sha256 || '') === fileSha256(failurePath)
        && eventDetails
        && normalizePath(String(eventDetails.artifact_path || '')) === normalizePath(recoveryPath)
        && String(eventDetails.artifact_sha256 || '') === fileSha256(recoveryPath)
        && String(eventDetails.failure_artifact_sha256 || '') === String(recovery.failure_artifact_sha256 || '')
        && String(eventDetails.inspected_protected_snapshot_sha256 || '') === String(recovery.inspected_protected_snapshot_sha256 || '')
        && String(eventDetails.operator_confirmed_at_utc || '') === String(recovery.operator_confirmed_at_utc || '')
        && JSON.stringify(eventDetails.requested_entry) === JSON.stringify(requestedEntry)
        && JSON.stringify(recovery.requested_entry) === JSON.stringify(requestedEntry)
        && Date.parse(String(recovery.timestamp_utc || '')) >= Date.parse(String(failure.timestamp_utc || ''))
        && evaluateProtectedControlPlaneManifest(repoRoot, null, true).status === 'MATCH'
        && freshEntryCommand;
    if (recoveryMatchesFailure) {
        return { recovered: true, reason: 'Confirmed protected-manifest recovery is recorded; retry task-mode entry with fresh authorization.', command: freshEntryCommand };
    }
    const affected = readPathList(failure.affected_protected_paths);
    return {
        recovered: false,
        reason: `Task-mode entry failed because protected manifest status is ${String(failure.manifest_status || 'unknown')}. Failure reason: ${formatFailureReason(failure.reason)}. Manifest: ${String(failure.manifest_path || 'unknown')}. Affected paths: ${affected.join(', ') || 'unavailable'}. Inspect read-only with: ${String(failure.inspection_command || '')}. Explicit operator confirmation is required before mutation.`,
        command: `${cliPrefix} gate recover-task-mode-protected-manifest --task-id ${quoteCommandValue(taskId)} --inspected-protected-snapshot-sha256 ${quoteCommandValue(String(failure.observed_protected_snapshot_sha256 || '<sha256-from-failure>'))} --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --repo-root "."`
    };
}

export function readFailedTaskModePublicationRecoveryRoute(
    repoRoot: string, eventsRoot: string, taskId: string, cliPrefix: string, reviewsRoot: string, taskModePath: string
): { reason: string; command: string } | null {
    const runtimeRoot = path.join(resolveBundleRootForTarget(repoRoot), 'runtime');
    const canonicalTaskModePath = path.join(runtimeRoot, 'reviews', `${taskId}-task-mode.json`);
    if (path.resolve(eventsRoot) !== path.resolve(runtimeRoot, 'task-events')
        || path.resolve(reviewsRoot) !== path.resolve(runtimeRoot, 'reviews')
        || path.resolve(taskModePath) !== path.resolve(canonicalTaskModePath) || fs.existsSync(taskModePath)) return null;
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timelinePath, taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') return null;
    const indexed = readInvocationVerifiedEventIndex(timelinePath, taskId);
    const events = indexed?.byType.TASK_MODE_ENTERED ?? (indexed ? [] : readTaskTimelineJsonlEntries(timelinePath).map(entry => entry.record));
    const entry = lastMatchingEvent(events, 'TASK_MODE_ENTERED', 'PASS');
    const entryDetails = entry?.details;
    if (!entry || !isPlainRecord(entry.integrity) || !isPlainRecord(entryDetails)
        || path.resolve(String(entryDetails.artifact_path || '')) !== path.resolve(taskModePath)) return null;
    const failures = indexed?.byType.TASK_MODE_ENTRY_FAILED ?? (indexed ? [] : events);
    const failure = lastMatchingEvent(failures, 'TASK_MODE_ENTRY_FAILED', 'FAIL');
    if (!failure || (indexed ? verifiedEventPosition(failure)! <= verifiedEventPosition(entry)! : events.indexOf(failure) <= events.indexOf(entry))) return null;
    if (!isPlainRecord(failure.integrity)) return null;
    const failureDetails = isPlainRecord(failure.details) ? failure.details : null;
    return {
        reason: 'Task-mode publication failed after TASK_MODE_ENTERED and invalidated its artifact. '
            + `Failure: ${formatFailureReason(failureDetails?.reason)}. `
            + 'Startup gates and ordinary re-entry cannot recover the missing frozen policy snapshot. '
            + 'Preserve the task evidence and source work, preview the explicit operator reset, then reopen and enter the task again.',
        command: `${cliPrefix} gate task-reset --task-id ${quoteCommandValue(taskId)} --reopen --dry-run --repo-root "."`
    };
}

/**
 * TASK_MODE_ENTERED pinned a profile policy snapshot, but its artifact is now missing, unreadable or no longer
 * matches the recorded evidence. A frozen policy is never regenerated and enter-task-mode refuses to replace it,
 * so recommending re-entry would recommend a command that refuses. The way out is an operator reset and re-entry.
 */
const UNPARSEABLE_TIMELINE_LINE = /^Task timeline contains invalid JSON at line (\d+)\.$/u;

/**
 * No gate appends to a timeline that fails integrity, so every later route (effects included) would repeat forever.
 * Only the operator can repair task history, and Garda never edits or trusts it. When the only violations are
 * unparseable lines, those bytes are no authenticated event and every authenticated event still verifies: removing
 * exactly those lines keeps every passed review. Any other violation means authenticated history itself changed.
 * Both routes name the side-effect-free reset preview as their executable command. Called only when the task audit
 * already reports a failed integrity status, so a healthy timeline costs nothing; the inspection is the invocation's
 * memoized read.
 */
export function readTaskTimelineIntegrityRoute(
    timelinePath: string, taskId: string, cliPrefix: string
): { status: 'BLOCKED'; nextGate: string; title: string; reason: string; commands: NextStepCommand[] } | null {
    const inspection = inspectTaskEventFile(timelinePath, taskId);
    // A read failure or a concurrent change is no evidence about content; its gate reports it on the next read.
    if (inspection.status !== 'FAILED' || inspection.violations.length === 0
        || inspection.violations.some(violation => /^Task timeline (?:read failed|snapshot changed)/u.test(violation))) return null;
    const commands = [buildCommand('Preview task reset after preserving evidence',
        `${cliPrefix} gate task-reset --task-id ${quoteCommandValue(taskId)} --reopen --dry-run --repo-root "."`)];
    const lines = inspection.violations.map(violation => UNPARSEABLE_TIMELINE_LINE.exec(violation)?.[1] ?? null);
    if (inspection.parse_errors > 0 && lines.every(line => line !== null)) {
        return {
            status: 'BLOCKED',
            nextGate: 'task-reset',
            title: 'Ask the operator to remove unparseable task timeline lines.',
            reason: `Task timeline ${normalizePath(timelinePath)} has ${lines.length} unparseable line(s): ${lines.join(', ')}. `
                + 'They are no authenticated event and every authenticated event still verifies, but no gate can append to a timeline '
                + 'that fails integrity, so the task cannot continue. Ask the operator to keep a copy of the timeline, remove exactly '
                + `these lines, run ${cliPrefix} repair rebuild-indexes --confirm --repo-root ".", then run next-step: every passed `
                + 'review is kept. Garda never edits task history itself. If the operator does not repair it, the alternative is an '
                + 'audited task reset, which repeats the reviews; the command below only previews it.',
            commands
        };
    }
    return {
        status: 'BLOCKED',
        nextGate: 'task-reset',
        title: 'Ask the operator to restore authentic task history.',
        reason: `Task timeline ${normalizePath(timelinePath)} fails integrity: ${inspection.violations.slice(0, 3).join(' ')} `
            + 'Authenticated task history changed, so no gate can append and Garda trusts none of it. Ask the operator to '
            + 'restore the authentic timeline from a preserved copy, run '
            + `${cliPrefix} repair rebuild-indexes --confirm --repo-root ".", then run next-step: reviews whose evidence `
            + 'is intact are kept. Without an authentic copy, preserve the evidence and source work and reset the task, which '
            + 'repeats the reviews; the command below only previews it.',
        commands
    };
}

export function readLostTaskModePolicyRecoveryRoute(
    repoRoot: string, eventsRoot: string, taskId: string, cliPrefix: string, reviewsRoot: string, taskModePath: string
): { reason: string; command: string } | null {
    const runtimeRoot = path.join(resolveBundleRootForTarget(repoRoot), 'runtime');
    if (path.resolve(eventsRoot) !== path.resolve(runtimeRoot, 'task-events')
        || path.resolve(reviewsRoot) !== path.resolve(runtimeRoot, 'reviews')
        || path.resolve(taskModePath) !== path.resolve(runtimeRoot, 'reviews', `${taskId}-task-mode.json`)) return null;
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timelinePath, taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') return null;
    const entry = readTaskTimelineJsonlEntries(timelinePath).map(item => item.record).reverse()
        .find(event => event?.event_type === 'TASK_MODE_ENTERED' && event.outcome === 'PASS');
    if (!entry || !isPlainRecord(entry.integrity) || !isPlainRecord(entry.details)
        || path.resolve(String(entry.details.artifact_path || '')) !== path.resolve(taskModePath)) return null;
    const evidence = getTaskModeEvidence(repoRoot, taskId, taskModePath);
    if (!evidence.timeline_declares_profile_policy_snapshot
        || evidence.evidence_status === 'PASS' && evidence.profile_policy_snapshot_status === 'PASS') return null;
    const state = !fs.existsSync(taskModePath) ? 'missing'
        : evidence.profile_policy_snapshot_status === 'PASS' ? 'no longer authentic' : 'unreadable or invalid';
    const violations = [...new Set([...evidence.profile_policy_snapshot_violations, ...getTaskModeEvidenceViolations(evidence)])];
    return {
        reason: `The task-mode artifact that pins this task's profile policy is ${state}: ${normalizePath(taskModePath)}. `
            + (violations.length ? `Evidence: ${violations.join(' ').slice(0, 600)} ` : '')
            + 'Garda never regenerates a frozen task policy, and enter-task-mode refuses to replace it. '
            + 'Ask the operator to preserve the task evidence and source work, reset the task, then enter it again.',
        command: `${cliPrefix} gate task-reset --task-id ${quoteCommandValue(taskId)} --reopen --dry-run --repo-root "."`
    };
}

export interface NextStepStartupCycleReadiness {
    ready: boolean;
    nextGate: string | null;
    title: string;
    reason: string;
}

export interface NextStepStartupRoute {
    status: NextStepStatus;
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface NextStepStartupRouteOptions {
    enterTaskModePassed: boolean;
    unapprovedActiveTaskOwners?: string[];
    defaultExecutionProvider: string | null;
    enterTaskModeCommand: string;
    startupCycleReadiness: NextStepStartupCycleReadiness;
    loadRulePackPassed: boolean;
    rulePackStage: string | null;
    preflightExists: boolean;
    taskEntryRulePackCommand: string;
    handshakeDiagnosticsPassed: boolean;
    handshakeDiagnosticsCommand: string;
    shellSmokePreflightPassed: boolean;
    shellSmokePreflightCommand: string;
    /** Built only when lost startup evidence after preflight routes the coherent-cycle restart. */
    coherentCycleRestartCommand?: () => string;
    protectedManifestRecovery?: { recovered: boolean; reason: string; command: string } | null;
    failedPublicationRecovery?: { reason: string; command: string } | null;
    /** Evaluated only where re-entry would otherwise be recommended, so ordinary routing does no extra work. */
    lostTaskModePolicyRecovery?: () => { reason: string; command: string } | null;
    /**
     * A still-current POST_PREFLIGHT refusal for changed task profile policy, with what adopting it would change.
     * Only reverting the change or operator-approved adoption (task-mode re-entry) resolves it.
     */
    profilePolicyAdoption?: { reason: string; laneChanges: string[]; unadoptableChanges: string[]; command: string } | null;
    /** Side-effect-free preview of the operator reset an unadoptable policy change leaves as the Garda way out. */
    taskResetPreviewCommand?: string;
    /** Finish only an already-started review on the frozen policy before considering adoption. */
    pendingPolicyReview?: () => NextStepStartupRoute | null;
}

function commandForStartupCycleGate(
    readiness: NextStepStartupCycleReadiness,
    options: NextStepStartupRouteOptions
): NextStepCommand {
    if (readiness.nextGate === 'load-rule-pack') {
        return buildCommand('Load TASK_ENTRY rules', options.taskEntryRulePackCommand);
    }
    if (readiness.nextGate === 'handshake-diagnostics') {
        return buildCommand('Run handshake diagnostics', options.handshakeDiagnosticsCommand);
    }
    if (readiness.nextGate === 'restart-coherent-cycle' && options.coherentCycleRestartCommand) {
        return buildCommand('Restart coherent cycle', options.coherentCycleRestartCommand());
    }
    return buildCommand('Run shell smoke preflight', options.shellSmokePreflightCommand);
}

export function resolveNextStepStartupRoute(
    options: NextStepStartupRouteOptions
): NextStepStartupRoute | null {
    if (options.protectedManifestRecovery) {
        return {
            status: 'BLOCKED',
            nextGate: options.protectedManifestRecovery.recovered ? 'enter-task-mode' : 'recover-task-mode-protected-manifest',
            title: options.protectedManifestRecovery.recovered
                ? 'Retry task mode after confirmed protected-manifest recovery.'
                : 'Protected-manifest task-mode recovery requires operator confirmation.',
            reason: options.protectedManifestRecovery.reason,
            commands: [buildCommand(
                options.protectedManifestRecovery.recovered ? 'Enter task mode' : 'Recover protected manifest after operator confirmation',
                options.protectedManifestRecovery.command
            )]
        };
    }
    if (options.unapprovedActiveTaskOwners?.length) {
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Confirm work alongside unfinished tasks.',
            reason: `Unfinished tasks in this worktree: ${options.unapprovedActiveTaskOwners.join(', ')}. `
                + 'Ask the operator to confirm working in this workspace while preserving existing changes. '
                + 'After confirmation, use the task-mode command below with an explicit planned file scope; '
                + 'the approval is recorded for this task and reused by later gates.',
            commands: [buildCommand('Enter task mode after operator confirmation', options.enterTaskModeCommand)]
        };
    }
    if (options.failedPublicationRecovery) {
        return {
            status: 'BLOCKED',
            nextGate: 'task-reset',
            title: 'Preview recovery of failed task-mode publication.',
            reason: options.failedPublicationRecovery.reason,
            commands: [buildCommand('Preview task reset after preserving evidence', options.failedPublicationRecovery.command)]
        };
    }
    const lostTaskModePolicy = options.enterTaskModePassed ? null : options.lostTaskModePolicyRecovery?.() ?? null;
    if (lostTaskModePolicy) {
        return {
            status: 'BLOCKED',
            nextGate: 'task-reset',
            title: 'Ask the operator to reset the task: its pinned task-mode policy is lost.',
            reason: lostTaskModePolicy.reason,
            commands: [buildCommand('Preview task reset after preserving evidence', lostTaskModePolicy.command)]
        };
    }
    if (!options.enterTaskModePassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Enter task mode first.',
            reason: options.defaultExecutionProvider
                ? 'No TASK_MODE_ENTERED event exists for this task.'
                : 'No TASK_MODE_ENTERED event exists for this task, and runtime provider could not be detected from GARDA_EXECUTION_PROVIDER or known provider environment markers. Set GARDA_EXECUTION_PROVIDER to the current execution provider before running the command; do not use SourceOfTruth as a runtime-provider fallback.',
            commands: [
                buildCommand('Enter task mode', options.enterTaskModeCommand)
            ]
        };
    }

    const pendingPolicyReview = options.pendingPolicyReview?.();
    if (pendingPolicyReview) return pendingPolicyReview;

    const adoption = options.profilePolicyAdoption;
    if (adoption && adoption.unadoptableChanges.length > 0) {
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Revert the review-policy change, or ask the operator to reset the task.',
            reason: `${adoption.reason} The change also alters ${adoption.unadoptableChanges.join(', ')}, which a running task `
                + 'cannot adopt. Reloading rules or refreshing preflight keeps refusing: revert the change to the profile '
                + 'configuration and rerun the navigator, or ask the operator to reset the task.',
            commands: options.taskResetPreviewCommand
                ? [buildCommand('Preview task reset after preserving evidence', options.taskResetPreviewCommand)] : []
        };
    }
    if (adoption) {
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Ask the operator to approve the changed review policy, or revert it.',
            reason: `${adoption.reason} Review lanes would change: ${adoption.laneChanges.join('; ')}. `
                + 'Reloading rules or refreshing preflight keeps refusing. Revert the change and rerun the navigator, '
                + 'or show the operator these lane changes and, after a yes, run the command below with the time of that approval. '
                + 'The command carries the digest of exactly these changes and is refused if the policy changes again; '
                + 'the navigator then refreshes rules, preflight and reviews.',
            commands: [buildCommand('Adopt the changed review lanes after operator confirmation', adoption.command)]
        };
    }

    if (!options.startupCycleReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: options.startupCycleReadiness.nextGate || 'startup-readiness',
            title: options.startupCycleReadiness.title,
            reason: options.startupCycleReadiness.reason,
            commands: options.startupCycleReadiness.nextGate === 'startup-evidence-recovery'
                ? [] : [commandForStartupCycleGate(options.startupCycleReadiness, options)]
        };
    }

    if (
        !options.loadRulePackPassed
        || options.rulePackStage !== 'TASK_ENTRY' && !options.preflightExists
    ) {
        return {
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files.',
            reason: 'Task execution must record the loaded core workflow rule pack before preflight.',
            commands: [
                buildCommand('Load TASK_ENTRY rules', options.taskEntryRulePackCommand)
            ]
        };
    }

    if (!options.handshakeDiagnosticsPassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics.',
            reason: 'Runtime identity and reviewer launchability have not been recorded.',
            commands: [
                buildCommand('Run handshake diagnostics', options.handshakeDiagnosticsCommand)
            ]
        };
    }

    if (!options.shellSmokePreflightPassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight.',
            reason: 'CLI launchability and filesystem probes have not been recorded.',
            commands: [
                buildCommand('Run shell smoke preflight', options.shellSmokePreflightCommand)
            ]
        };
    }

    return null;
}
