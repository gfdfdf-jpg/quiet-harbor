import { readImmutableRouteOrderedWitnesses } from './next-step-route-query-readers';
import { readInvocationVerifiedEventIndex, readTaskTimelineRouteQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { routeLatestNormalizedSequence } from '../../gate-runtime/timeline/task-route-query';
import { readVerifiedOriginalEntryRefresh, readVerifiedRecoverySequence, type VerifiedTaskEventIndex } from '../../gate-runtime/timeline/task-verified-event-index';
import { countNextStepWork } from '../../core/next-step-measurement';
import { formatInstalledBundleMaintenanceGuidance } from '../protected-control-plane/installed-bundle-guard';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    isGardaSelfGuardDenyAgentEntryForBundle
} from '../../core/workflow-config';
import {
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    resolveTaskResetAvailability
} from '../../core/task-reset-availability';
import type {
    TaskQueueEntry
} from '../../core/task-queue-read';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    buildCoherentCycleRestartCommand
} from '../completion/completion-reporting';
import {
    collectOrderedTimelineEvents,
    type TimelineEventEntry
} from '../completion/completion-evidence';
import {
    getPostPreflightRulePackRebindDecision,
    getPostPreflightSequenceEvidence,
    getRulePackEvidence,
    getRulePackEvidenceViolations,
    type PostPreflightRulePackRebindDecision
} from '../rule-pack/rule-pack';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    fileSha256,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    buildCompileEvidenceDocsOnlyExtensionReadiness,
    readCurrentGitWorkspaceSnapshot
} from './next-step-compile-full-suite-readiness';
import {
    buildBundleRelativePath
} from './next-step-command-formatters';
import {
    buildClassifyChangeCommand,
    buildOrchestratorWorkRestartCommand,
    getTaskModePlannedChangedFiles,
    resolveAuthenticatedSplitCheckpointCommandScope,
    readCurrentStagedChangedFiles
} from './next-step-lifecycle-command-builders';
import {
    collectImmutableTimelineEvents,
    findLatestTimelineEvent,
    getTimelineEventDetailString
} from './next-step-timeline-readers';
import { isPlainRecord } from '../../core/records';
import {
    describeReclassificationBoundStop,
    readUnchangedReclassificationReadiness
} from '../scope/unchanged-reclassification';
import { COHERENT_RED_PENDING_EVENT, readCoherentRedCheckpoint, readReviewValidationCheckpoint } from '../../cli/commands/gate-flows/recovery/recovery-flow-validation-checkpoint';
import { PreflightSupersededError } from '../task-mode/no-op';
import { isTaskEntryRulePackLoadedEvent } from '../preflight/pre-preflight-cycle-anchor';
import {
    filterProtectedRestartScopeGeneratedRuntimeArtifacts,
    readCurrentProtectedScopeBeforePreflight
} from './next-step-protected-scope';
import {
    getWorkflowConfigChangedFiles,
    normalizeWorkflowConfigFileHashes,
    taskMetadataAllowsWorkflowConfigWork
} from '../workflow-config/workflow-config-work-paths';
import { getCurrentWorkflowConfigChanges } from '../workflow-config/workflow-config-work-changes';
import { evaluateProtectedControlPlaneManifest } from '../protected-control-plane/protected-control-plane';
import {
    computePreflightCauseWitness,
    hasProtectedOrchestratorWorkRecoverySignal,
    hasProtectedPreflightRecoverySignal,
    hasWorkflowConfigWorkRecoverySignal,
    PREFLIGHT_CAUSE_WITNESS_FIELD
} from '../preflight/preflight-cause-witness';

export interface FailedGateRecovery {
    nextGate: string;
    title: string;
    reason: string;
    label?: string;
    command?: string;
    /** T-403: the recorded cause is gone in the current files; the caller re-offers the failed classification. */
    resolvedFailure?: boolean;
}

export interface RulePackReadiness {
    ready: boolean;
    reason: string;
    rebind: PostPreflightRulePackRebindDecision | null;
}

export interface CoherentCycleReadiness {
    ready: boolean;
    reason: string;
    command: string | null;
    reviewRestartOrigin?: string;
    pendingRedPreflightSuperseded?: boolean;
    /** The identical-reclassification rerun bound tripped (or could not be checked): a terminal stop, not a restart. */
    reclassificationBoundReached?: boolean;
    /**
     * Set on a ready result when the latest preflight was refreshed in the original task entry after the only
     * compile pass. That pass cannot anchor the refreshed preflight, so the compile route must run compile-gate again.
     */
    compilePassBeforePreflight?: { compileSequence: number; preflightSequence: number };
}

const COHERENT_CYCLE_BOUNDARY_EVENTS = new Set([
    'IMPLEMENTATION_STARTED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

const RESTART_COMPLETED_EVENT_TYPES = new Set([
    'COHERENT_CYCLE_RESTARTED',
    'REVIEW_CYCLE_RESTARTED'
]);

function resolveBundleRootForNextStep(repoRoot: string): string {
    return path.join(repoRoot, resolveBundleNameForTarget(repoRoot));
}

/**
 * T-403 live re-evaluation of a protected classification failure (OP-056). The cause is gone only when, with the inputs
 * classify-change itself uses, the workflow-config files match the task-mode baseline again, the protected manifest
 * matches (or none exists) and no protected path is in the current scope. A resolved cause approves nothing: the
 * caller only re-offers classify-change, which runs all of its checks again.
 */
export function isProtectedPreflightFailureResolved(
    repoRoot: string,
    taskMode: Record<string, unknown>,
    readWorkspaceSnapshot: () => ReturnType<typeof readCurrentGitWorkspaceSnapshot> = () => readCurrentGitWorkspaceSnapshot(repoRoot, true)
): boolean {
    const baseline = normalizeWorkflowConfigFileHashes(taskMode.workflow_config_file_hashes);
    if (!baseline || Object.keys(baseline).length === 0) {
        return false;
    }
    // An unreadable Git workspace proves nothing: the scope reader would treat it as "no changed files".
    const snapshot = readWorkspaceSnapshot();
    if (!snapshot) {
        return false;
    }
    const workflowConfigChanges = getCurrentWorkflowConfigChanges(repoRoot, baseline, { allowProtectedManifestFallback: false });
    if (workflowConfigChanges.scan_error || workflowConfigChanges.changed_files.length > 0) {
        return false;
    }
    const manifestStatus = evaluateProtectedControlPlaneManifest(repoRoot, null, true).status;
    if (manifestStatus !== 'MATCH' && manifestStatus !== 'MISSING') {
        return false;
    }
    return readCurrentProtectedScopeBeforePreflight(repoRoot, snapshot, () => snapshot, taskMode) === null;
}

/**
 * The failed classification is re-offered once per observed resolution. A protected PREFLIGHT_FAILED earlier in this
 * task-mode epoch means a retry already failed: a further re-offer needs a new resolution, that is, a content change of
 * the inputs the live re-evaluation reads since the latest failure recorded their witness (the operator's rollback, or a
 * manifest refresh). A retry that failed while the cause was still present therefore does not block the re-offer after
 * the rollback, but a retry that failed after the cause was observed gone (the content unchanged since) does, so an
 * endless retry loop stops. A missing recorded witness or an unreadable current one counts as unchanged (fail closed).
 */
export function isResolvedRetryExhausted(
    events: readonly TimelineEventEntry[],
    latestFailure: TimelineEventEntry,
    taskModeSequence: number,
    readCurrentCauseWitness: () => string | null
): boolean {
    const earlier = events.some((entry) => {
        if (entry.event_type !== 'PREFLIGHT_FAILED' || entry.sequence >= latestFailure.sequence || entry.sequence < taskModeSequence) {
            return false;
        }
        return hasProtectedPreflightRecoverySignal(getTimelineEventDetailString(entry, 'error'));
    });
    if (!earlier) {
        return false;
    }
    const recorded = getTimelineEventDetailString(latestFailure, PREFLIGHT_CAUSE_WITNESS_FIELD).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(recorded)) {
        return true;
    }
    const current = readCurrentCauseWitness();
    return current === null || current === recorded;
}

function isGardaSelfGuardDenyAgentEntry(repoRoot: string): boolean {
    return isGardaSelfGuardDenyAgentEntryForBundle(
        isOrchestratorSourceCheckout(repoRoot),
        resolveBundleRootForNextStep(repoRoot)
    );
}

export function readPostPreflightRulePackReadiness(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    rulePackPath: string,
    taskModePath: string
): RulePackReadiness {
    const rebind = getPostPreflightRulePackRebindDecision(repoRoot, taskId, preflightPath, {
        artifactPath: rulePackPath,
        taskModePath
    });
    const evidence = getRulePackEvidence(repoRoot, taskId, 'POST_PREFLIGHT', {
        preflightPath,
        artifactPath: rulePackPath,
        taskModePath
    });
    const sequenceEvidence = getPostPreflightSequenceEvidence(repoRoot, taskId, preflightPath, {
        artifactPath: rulePackPath,
        taskModePath
    });
    const violations = [
        ...getRulePackEvidenceViolations(evidence),
        ...sequenceEvidence.violations
    ];
    if (violations.length === 0 && evidence.binding_equivalent_to_current_preflight && sequenceEvidence.binding_equivalent_to_current_preflight) {
        return {
            ready: true,
            reason: 'POST_PREFLIGHT rule-pack evidence is current for the latest preflight.',
            rebind: null
        };
    }
    if (violations.length === 0) {
        violations.push('POST_PREFLIGHT rule-pack evidence is not bound to the latest preflight.');
    }
    return {
        ready: false,
        reason: violations.join(' '),
        rebind
    };
}

function hasDirtyBaselineRecoverySignal(
    event: NonNullable<ReturnType<typeof findLatestTimelineEvent>>,
    message: string
): boolean {
    const reasonCode = String(event.details?.preflight_failure_reason_code || '').trim();
    if (reasonCode === 'dirty_baseline_requires_explicit_scope') {
        return true;
    }
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('workspace already contained modified files before task-mode entry')
        && normalized.includes('--use-staged')
        && normalized.includes('--changed-file');
}

function hasProtectedBaselineDriftRecoverySignal(message: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('protected pre-existing workspace edits changed outside task scope')
        && normalized.includes('restart task mode');
}

function normalizeEventPathList(value: unknown): string[] {
    return [...new Set((Array.isArray(value) ? value : [])
        .map((entry) => normalizePath(entry))
        .filter(Boolean))]
        .sort();
}

function readProtectedPreflightAuthorizedScope(
    event: NonNullable<ReturnType<typeof findLatestTimelineEvent>>
): string[] {
    if (String(event.details?.preflight_failure_reason_code || '').trim() !== 'protected_scope_requires_orchestrator_work') {
        return [];
    }
    const authorizedFiles = normalizeEventPathList(event.details?.authorized_scope_changed_files);
    const protectedFiles = normalizeEventPathList(event.details?.changed_protected_files);
    if (
        authorizedFiles.length === 0
        || protectedFiles.length === 0
        || protectedFiles.some((entry) => !authorizedFiles.includes(entry))
    ) {
        return [];
    }
    return authorizedFiles;
}

function readLegacyProtectedPreflightAuthorizedScope(
    repoRoot: string,
    taskId: string,
    errorText: string
): string[] {
    const failureMarker = 'Preflight scope touches protected orchestrator control-plane files without task-mode --orchestrator-work:';
    const recoveryMarker = '. Restart task mode as orchestrator work before preflight classification. Suggested command:';
    const failureStart = errorText.indexOf(failureMarker);
    const recoveryStart = errorText.indexOf(recoveryMarker, failureStart + failureMarker.length);
    if (failureStart < 0 || recoveryStart < 0) {
        return [];
    }
    const protectedFiles = normalizeEventPathList(
        errorText
            .slice(failureStart + failureMarker.length, recoveryStart)
            .split(',')
    );
    const suggestedCommand = errorText.slice(recoveryStart + recoveryMarker.length).trim();
    const normalizedPlannedFiles = readCanonicalProtectedRestartCommandScope(
        repoRoot,
        taskId,
        suggestedCommand
    );
    return protectedFiles.length > 0
        && protectedFiles.every((entry) => normalizedPlannedFiles.includes(entry))
        ? normalizedPlannedFiles
        : [];
}

function readProtectedManifestDriftAuthorizedScope(
    repoRoot: string,
    taskId: string,
    errorText: string
): string[] {
    const failureMarker = 'Trusted protected control-plane manifest drift detected before preflight classification:';
    const recoveryMarker = '. Restart task mode with:';
    const failureStart = errorText.indexOf(failureMarker);
    const recoveryStart = errorText.indexOf(recoveryMarker, failureStart + failureMarker.length);
    if (failureStart < 0 || recoveryStart < 0) {
        return [];
    }
    const driftFiles = normalizeEventPathList(
        errorText
            .slice(failureStart + failureMarker.length, recoveryStart)
            .split(',')
    );
    if (driftFiles.length === 0) {
        return [];
    }
    return readCanonicalProtectedRestartCommandScope(
        repoRoot,
        taskId,
        errorText.slice(recoveryStart + recoveryMarker.length).trim()
    );
}

function readCanonicalProtectedRestartCommandScope(
    repoRoot: string,
    taskId: string,
    suggestedCommand: string
): string[] {
    if (
        !/^node (?:bin|garda-agent-orchestrator\/bin)\/garda\.js gate enter-task-mode\b/.test(normalizePath(suggestedCommand))
        || /[;&|`\r\n]/.test(suggestedCommand)
        || suggestedCommand.includes('$(')
        || !suggestedCommand.includes('--orchestrator-work')
    ) {
        return [];
    }
    const taskMatches = [...suggestedCommand.matchAll(/--task-id\s+"([^"\r\n]+)"/g)];
    if (taskMatches.length !== 1 || taskMatches[0][1] !== taskId) {
        return [];
    }
    const plannedFiles = [...suggestedCommand.matchAll(/--planned-changed-file\s+"([^"\r\n]+)"/g)]
        .map((match) => normalizePath(match[1]))
        .filter(Boolean);
    if (plannedFiles.length === 0 || new Set(plannedFiles).size !== plannedFiles.length) {
        return [];
    }
    for (const plannedFile of plannedFiles) {
        if (path.isAbsolute(plannedFile)) {
            return [];
        }
        try {
            const resolvedPath = resolvePathInsideRepo(plannedFile, repoRoot, {
                allowMissing: true,
                enforceInside: true
            });
            if (!resolvedPath || normalizePath(path.relative(repoRoot, resolvedPath)) !== plannedFile) {
                return [];
            }
        } catch {
            return [];
        }
    }
    const normalizedPlannedFiles = [...plannedFiles].sort();
    return normalizedPlannedFiles;
}

function parseDirtyBaselineFilesFromError(errorText: string): string[] {
    const marker = 'Workspace already contained modified files before task-mode entry:';
    const start = errorText.indexOf(marker);
    if (start < 0) {
        return [];
    }
    const afterMarker = errorText.slice(start + marker.length);
    const end = afterMarker.indexOf('. This run is invalid');
    const listText = end >= 0 ? afterMarker.slice(0, end) : afterMarker;
    return [...new Set(listText
        .split(',')
        .map((entry) => normalizePath(entry))
        .filter(Boolean))]
        .sort();
}

function parseWorkflowConfigFilesFromError(errorText: string): string[] {
    const marker = '--workflow-config-work:';
    const start = errorText.indexOf(marker);
    if (start < 0) {
        return [];
    }
    const afterMarker = errorText.slice(start + marker.length);
    const end = afterMarker.indexOf('. Re-enter task mode');
    const listText = end >= 0 ? afterMarker.slice(0, end) : afterMarker;
    return getWorkflowConfigChangedFiles(listText
        .split(',')
        .map((entry) => normalizePath(entry))
        .filter(Boolean));
}

function formatPathList(paths: string[]): string {
    if (paths.length === 0) {
        return '[none]';
    }
    const preview = paths.slice(0, 12).join(', ');
    return paths.length > 12
        ? `[${preview}, ... +${paths.length - 12} more]`
        : `[${preview}]`;
}

function buildDirtyBaselineFailedPreflightRecovery(input: {
    repoRoot: string;
    taskId: string;
    cliPrefix: string;
    taskMode: Record<string, unknown>;
    taskModePath: string | null;
    preflightCommandPath: string;
    rulePackCommandPath?: string | null;
    latestPreflightFailure: NonNullable<ReturnType<typeof findLatestTimelineEvent>>;
    errorText: string;
}): FailedGateRecovery {
    const splitCheckpointScope = resolveAuthenticatedSplitCheckpointCommandScope(input.repoRoot, input.taskId);
    if (splitCheckpointScope?.violation) {
        const candidateFiles = [
            ...normalizeEventPathList(input.latestPreflightFailure.details?.pre_task_modified_files),
            ...normalizeEventPathList(input.latestPreflightFailure.details?.current_workspace_changed_files)
        ];
        return {
            nextGate: 'manual-scope-selection',
            title: 'Choose explicit preflight scope after split-checkpoint authentication failed.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${input.latestPreflightFailure.sequence}) reports dirty pre-task files, ` +
                `but the split-checkpoint task scope is not authenticated: ${splitCheckpointScope.violation} ` +
                'Do not recover with an inferred dirty workspace scope. Restart task mode with a corrected task checkpoint, ' +
                'or choose an explicit bounded operator scope after inspecting ownership. ' +
                `Candidate dirty paths needing operator/user scope selection: ${formatPathList([...new Set(candidateFiles)].sort())}.`
        };
    }
    if (splitCheckpointScope) {
        return {
            nextGate: 'classify-change',
            title: 'Recover failed classify-change with authenticated split-checkpoint scope.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${input.latestPreflightFailure.sequence}) reports dirty pre-task files. ` +
                `The task has an authenticated split-checkpoint scope ${formatPathList(splitCheckpointScope.changedFiles)}, ` +
                'so recovery can use the checkpoint detection source and exact --changed-file arguments instead of repeating the failed unscoped command.',
            label: 'Classify authenticated split-checkpoint scope',
            command: buildClassifyChangeCommand({
                repoRoot: input.repoRoot,
                cliPrefix: input.cliPrefix,
                taskId: input.taskId,
                taskMode: input.taskMode,
                taskModePath: input.taskModePath,
                preflightCommandPath: input.preflightCommandPath,
                rulePackCommandPath: input.rulePackCommandPath,
                includePlannedScope: false,
                changedFiles: splitCheckpointScope.changedFiles,
                detectionSource: splitCheckpointScope.detectionSource
            })
        };
    }

    const stagedFiles = readCurrentStagedChangedFiles(input.repoRoot) || [];
    if (stagedFiles.length > 0) {
        return {
            nextGate: 'classify-change',
            title: 'Recover failed classify-change with staged scope.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${input.latestPreflightFailure.sequence}) reports dirty pre-task files, ` +
                `and the current staged scope is available ${formatPathList(stagedFiles)}. ` +
                'Rerun classify-change with --use-staged so the recovery scope is explicit instead of repeating the failed unscoped command.',
            label: 'Classify staged scope',
            command: buildClassifyChangeCommand({
                repoRoot: input.repoRoot,
                cliPrefix: input.cliPrefix,
                taskId: input.taskId,
                taskMode: input.taskMode,
                taskModePath: input.taskModePath,
                preflightCommandPath: input.preflightCommandPath,
                rulePackCommandPath: input.rulePackCommandPath,
                includePlannedScope: false,
                changedFiles: []
            })
        };
    }

    const plannedChangedFiles = getTaskModePlannedChangedFiles(input.taskMode);
    if (plannedChangedFiles.length > 0) {
        return {
            nextGate: 'classify-change',
            title: 'Recover failed classify-change with explicit task scope.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${input.latestPreflightFailure.sequence}) reports dirty pre-task files. ` +
                `Task-mode planned scope is available ${formatPathList(plannedChangedFiles)}, so recovery can use explicit ` +
                '--changed-file arguments instead of repeating the failed unscoped command.',
            label: 'Classify explicit task scope',
            command: buildClassifyChangeCommand({
                repoRoot: input.repoRoot,
                cliPrefix: input.cliPrefix,
                taskId: input.taskId,
                taskMode: input.taskMode,
                taskModePath: input.taskModePath,
                preflightCommandPath: input.preflightCommandPath,
                rulePackCommandPath: input.rulePackCommandPath,
                includePlannedScope: false,
                changedFiles: plannedChangedFiles
            })
        };
    }

    const preTaskModifiedFiles = normalizeEventPathList(input.latestPreflightFailure.details?.pre_task_modified_files);
    const fallbackPreTaskModifiedFiles = preTaskModifiedFiles.length > 0
        ? preTaskModifiedFiles
        : parseDirtyBaselineFilesFromError(input.errorText);
    const currentWorkspaceFiles = normalizeEventPathList(input.latestPreflightFailure.details?.current_workspace_changed_files);
    const candidateFiles = fallbackPreTaskModifiedFiles.length > 0
        ? fallbackPreTaskModifiedFiles
        : currentWorkspaceFiles;
    return {
        nextGate: 'manual-scope-selection',
        title: 'Choose explicit preflight scope for dirty-baseline recovery.',
        reason:
            `Latest PREFLIGHT_FAILED event (seq ${input.latestPreflightFailure.sequence}) reports dirty pre-task files, ` +
            'but next-step cannot safely infer which paths belong to this task. Stage the task-owned subset and rerun the navigator, ' +
            'or rerun classify-change with explicit --changed-file entries for the task-owned paths. ' +
            `Candidate dirty paths needing operator/user scope selection: ${formatPathList(candidateFiles)}.`
    };
}

function isSha256(value: unknown): value is string {
    return /^[0-9a-f]{64}$/u.test(String(value || '').trim().toLowerCase());
}

function resolveEventPath(repoRoot: string, value: unknown): string | null {
    const rawPath = String(value || '').trim();
    if (!rawPath) {
        return null;
    }
    try {
        return resolvePathInsideRepo(rawPath, repoRoot, { allowMissing: true, enforceInside: true });
    } catch {
        return null;
    }
}

function validateRestartCompletedEvent(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string,
    restartEvent: NonNullable<ReturnType<typeof findLatestTimelineEvent>>
): string[] {
    const details = restartEvent.details || {};
    const violations: string[] = [];
    if (String(details.task_id || '').trim() !== taskId) {
        violations.push('task_id does not match the current task');
    }
    for (const [fieldName, label] of [
        ['task_mode_sha256', 'task-mode'],
        ['preflight_sha256', 'preflight'],
        ['compile_evidence_sha256', 'compile evidence']
    ] as const) {
        if (!isSha256(details[fieldName])) {
            violations.push(`${label} hash is missing or invalid`);
        }
    }
    if (!Number.isInteger(Number(details.detected_changed_files_count)) || Number(details.detected_changed_files_count) < 0) {
        violations.push('detected_changed_files_count is missing or invalid');
    }
    if (!Number.isInteger(Number(details.elapsed_ms)) || Number(details.elapsed_ms) < 0) {
        violations.push('elapsed_ms is missing or invalid');
    }
    if (!String(details.restart_reason || '').trim()) {
        violations.push('restart_reason is missing');
    }
    if (!String(details.next_step_summary || '').trim()) {
        violations.push('next_step_summary is missing');
    }

    const taskModePath = resolveEventPath(repoRoot, details.task_mode_path);
    if (!taskModePath) {
        violations.push('task_mode_path is missing or outside the repository');
    } else if (!isSha256(details.task_mode_sha256) || !fs.existsSync(taskModePath) || fileSha256(taskModePath) !== details.task_mode_sha256) {
        violations.push('task-mode hash does not match the current artifact');
    }

    const eventPreflightPath = resolveEventPath(repoRoot, details.preflight_path);
    const normalizedExpectedPreflightPath = normalizePath(path.resolve(preflightPath));
    if (!eventPreflightPath) {
        violations.push('preflight_path is missing or outside the repository');
    } else if (normalizePath(path.resolve(eventPreflightPath)) !== normalizedExpectedPreflightPath) {
        violations.push('preflight_path does not match the latest preflight');
    } else if (!isSha256(details.preflight_sha256) || !fs.existsSync(eventPreflightPath) || fileSha256(eventPreflightPath) !== details.preflight_sha256) {
        violations.push('preflight hash does not match the current artifact');
    }

    const compileEvidencePath = resolveEventPath(repoRoot, details.compile_evidence_path);
    const normalizedExpectedCompileEvidencePath = normalizePath(path.resolve(reviewsRoot, `${taskId}-compile-gate.json`));
    if (!compileEvidencePath) {
        violations.push('compile_evidence_path is missing or outside the repository');
    } else if (normalizePath(path.resolve(compileEvidencePath)) !== normalizedExpectedCompileEvidencePath) {
        violations.push('compile_evidence_path does not match the latest compile evidence artifact');
    } else if (!isSha256(details.compile_evidence_sha256) || !fs.existsSync(compileEvidencePath) || fileSha256(compileEvidencePath) !== details.compile_evidence_sha256) {
        violations.push('compile evidence hash does not match the current artifact');
    }

    return violations;
}

export function readFailedGateRecovery(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    cliPrefix: string,
    taskMode: Record<string, unknown> | null,
    taskModePath: string | null,
    preflightCommandPath: string,
    taskEntry: TaskQueueEntry | null = null,
    rulePackCommandPath?: string | null
): FailedGateRecovery | null {
    if (!taskMode) {
        return null;
    }

    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = readOrderedRouteEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return null;
    }

    const latestPreflightFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_FAILED'
    );
    if (!latestPreflightFailure) {
        return null;
    }

    const latestPreflightSuccess = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (latestPreflightSuccess && latestPreflightSuccess.sequence > latestPreflightFailure.sequence) {
        return null;
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskMode && latestTaskMode.sequence > latestPreflightFailure.sequence) {
        return null;
    }

    const errorText = getTimelineEventDetailString(latestPreflightFailure, 'error');
    const hasProtectedRecoverySignal = hasProtectedOrchestratorWorkRecoverySignal(errorText);
    const hasWorkflowConfigRecoverySignal = hasWorkflowConfigWorkRecoverySignal(errorText);
    const hasDirtyBaselineSignal = hasDirtyBaselineRecoverySignal(latestPreflightFailure, errorText);
    const hasProtectedBaselineDriftSignal = hasProtectedBaselineDriftRecoverySignal(errorText);
    if (!hasProtectedRecoverySignal && !hasWorkflowConfigRecoverySignal && !hasDirtyBaselineSignal && !hasProtectedBaselineDriftSignal) {
        return null;
    }
    if (hasProtectedBaselineDriftSignal) {
        const plannedChangedFiles = getTaskModePlannedChangedFiles(taskMode);
        if (plannedChangedFiles.length === 0) {
            return {
                nextGate: 'manual-scope-selection',
                title: 'Choose explicit scope before restarting task mode.',
                reason:
                    `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) reports protected pre-existing baseline drift, ` +
                    'but task-mode has no planned changed files. Do not restart from the full current workspace scope.'
            };
        }
        if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
            return {
                nextGate: 'operator-maintenance',
                title: 'Garda self-guard blocks agent-owned protected baseline recovery.',
                reason:
                    `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) reports protected pre-existing baseline drift. ` +
                    formatInstalledBundleMaintenanceGuidance(cliPrefix, taskId),
                label: 'Inspect Garda installation',
                command: `${cliPrefix} doctor --target-root "."`
            };
        }
        const workflowConfigRecovery = taskMode?.workflow_config_work === true;
        return {
            nextGate: 'enter-task-mode',
            title: 'Restart task mode after protected baseline drift.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) reports protected pre-existing baseline drift. ` +
                `Restart task mode with the existing planned scope ${formatPathList(plannedChangedFiles)} so baseline evidence is refreshed ` +
                'without including other dirty workspace files, after fresh operator approval.',
            label: 'Restart task mode with planned scope',
            command: buildOrchestratorWorkRestartCommand(
                repoRoot,
                cliPrefix,
                taskId,
                taskMode,
                plannedChangedFiles,
                workflowConfigRecovery
            )
        };
    }
    if (hasDirtyBaselineSignal && !hasProtectedRecoverySignal && !hasWorkflowConfigRecoverySignal) {
        const currentProtectedScope = readCurrentProtectedScopeBeforePreflight(
            repoRoot,
            null,
            () => readCurrentGitWorkspaceSnapshot(repoRoot, true),
            taskMode
        );
        const currentProtectedScopeNeedsTaskModeRestart = currentProtectedScope
            && (
                taskMode?.orchestrator_work !== true
                || (currentProtectedScope.workflowConfigFiles.length > 0 && taskMode?.workflow_config_work !== true)
            );
        if (currentProtectedScope && currentProtectedScopeNeedsTaskModeRestart) {
            const workflowConfigRecovery = currentProtectedScope.workflowConfigFiles.length > 0 && taskMode?.workflow_config_work !== true;
            if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
                return {
                    nextGate: 'operator-maintenance',
                    title: 'Garda self-guard blocks agent-owned protected control-plane recovery.',
                    reason:
                        `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) reports dirty pre-task files, ` +
                        `but current protected control-plane scope is present: ${formatPathList(currentProtectedScope.protectedFiles)}. ` +
                        formatInstalledBundleMaintenanceGuidance(cliPrefix, taskId),
                    label: 'Inspect Garda installation',
                    command: `${cliPrefix} doctor --target-root "."`
                };
            }
            return {
                nextGate: 'enter-task-mode',
                title: workflowConfigRecovery
                    ? 'Recover failed classify-change as workflow-config work.'
                    : 'Recover failed classify-change as orchestrator work.',
                reason:
                    `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) reports dirty pre-task files, ` +
                    `but current protected control-plane scope must be recovered first: ${formatPathList(currentProtectedScope.protectedFiles)}. ` +
                    `Run the protected task-mode restart before any dirty-baseline classify-change recovery.`,
                label: workflowConfigRecovery
                    ? 'Restart task mode with workflow-config work'
                    : 'Restart task mode with orchestrator work',
                command: buildOrchestratorWorkRestartCommand(
                    repoRoot,
                    cliPrefix,
                    taskId,
                    taskMode,
                    currentProtectedScope.changedFiles,
                    workflowConfigRecovery
                )
            };
        }
        return buildDirtyBaselineFailedPreflightRecovery({
            repoRoot,
            taskId,
            cliPrefix,
            taskMode,
            taskModePath,
            preflightCommandPath,
            rulePackCommandPath,
            latestPreflightFailure,
            errorText
        });
    }
    // The route-ordered witnesses keep one event per type: the retry bound reads the complete timeline.
    if (!isResolvedRetryExhausted(collectImmutableTimelineEvents(timelinePath, []), latestPreflightFailure,
            latestTaskMode?.sequence ?? 0, () => computePreflightCauseWitness(repoRoot))
        && isProtectedPreflightFailureResolved(repoRoot, taskMode)) {
        return {
            nextGate: 'classify-change',
            title: 'Retry the failed classification: its recorded cause is resolved.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) reported a protected ${hasWorkflowConfigRecoverySignal ? 'workflow-config' : 'control-plane'} change, `
                + 'but the current files no longer show it: the workflow-config files match the task-mode baseline, the protected manifest matches '
                + 'and no protected path is in the task scope. Rerun the failed classification; it repeats all of its checks.',
            resolvedFailure: true
        };
    }
    if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
        return {
            nextGate: 'operator-maintenance',
            title: 'Garda self-guard blocks agent-owned protected control-plane recovery.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected ${hasWorkflowConfigRecoverySignal ? 'workflow-config' : 'control-plane'} recovery signal. ` +
                formatInstalledBundleMaintenanceGuidance(cliPrefix, taskId),
            label: 'Inspect Garda installation',
            command: `${cliPrefix} doctor --target-root "."`
        };
    }
    if (hasWorkflowConfigRecoverySignal && !taskMetadataAllowsWorkflowConfigWork(taskEntry)) {
        const taskResetAvailability = resolveTaskResetAvailability(repoRoot);
        if (!taskResetAvailability.enabled) {
            return {
                nextGate: 'operator-maintenance',
                title: 'Enable audited task reset for workflow-config baseline recovery.',
                reason:
                    `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) requires a fresh task-mode baseline after an operator workflow-config update, ` +
                    'but this task does not own workflow-config policy changes and audited task reset is unavailable.',
                label: 'Enable task reset',
                command: taskResetAvailability.remediationCommand
            };
        }
        return {
            nextGate: 'task-reset',
            title: 'Reset stale task mode after an operator workflow-config update.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) requires a fresh task-mode baseline after an operator workflow-config update. ` +
                'This task does not own workflow-config policy changes, so upgrading it into --workflow-config-work would violate the task ownership contract. ' +
                'Reset the stale lifecycle evidence for rerun, then rerun next-step to enter task mode against the approved config baseline.',
            label: 'Reset task for fresh workflow-config baseline',
            command: `${cliPrefix} gate task-reset --task-id "${taskId}" --reopen --confirm --repo-root "."`
        };
    }
    const splitCheckpointScope = resolveAuthenticatedSplitCheckpointCommandScope(repoRoot, taskId);
    if (splitCheckpointScope?.violation) {
        return {
            nextGate: 'manual-scope-selection',
            title: 'Choose protected recovery scope after split-checkpoint authentication failed.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected recovery signal, ` +
                `but the split-checkpoint task scope is not authenticated: ${splitCheckpointScope.violation} ` +
                'Do not recover with the full current workspace scope.'
        };
    }
    const structuredAuthorizedScope = splitCheckpointScope
        ? []
        : readProtectedPreflightAuthorizedScope(latestPreflightFailure);
    const legacyAuthorizedScope = splitCheckpointScope || structuredAuthorizedScope.length > 0
        ? []
        : readLegacyProtectedPreflightAuthorizedScope(repoRoot, taskId, errorText);
    const reportedAuthorizedScope = structuredAuthorizedScope.length > 0
        ? structuredAuthorizedScope
        : splitCheckpointScope
            ? []
            : legacyAuthorizedScope.length > 0
                ? legacyAuthorizedScope
                : readProtectedManifestDriftAuthorizedScope(repoRoot, taskId, errorText);
    const currentWorkspace = splitCheckpointScope || reportedAuthorizedScope.length > 0
        ? null
        : readCurrentGitWorkspaceSnapshot(repoRoot, true);
    const reportedWorkflowConfigFiles = hasWorkflowConfigRecoverySignal
        ? parseWorkflowConfigFilesFromError(errorText)
        : [];
    const currentChangedFiles = splitCheckpointScope
        ? splitCheckpointScope.changedFiles
        : reportedAuthorizedScope.length > 0
            ? reportedAuthorizedScope
        : filterProtectedRestartScopeGeneratedRuntimeArtifacts(repoRoot, [
            ...(Array.isArray(currentWorkspace?.changed_files) ? currentWorkspace.changed_files : []),
            ...reportedWorkflowConfigFiles
        ]);

    return {
        nextGate: 'enter-task-mode',
        title: hasWorkflowConfigRecoverySignal
            ? 'Recover failed classify-change as workflow-config work.'
            : 'Recover failed classify-change as orchestrator work.',
        reason:
            `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected ${hasWorkflowConfigRecoverySignal ? 'workflow-config' : 'control-plane'} recovery signal. ` +
            (reportedAuthorizedScope.length > 0
                ? 'Run the deterministic recovery command rebuilt from the authenticated failed-classification scope before reclassifying, after fresh operator approval for protected task-mode entry.'
                : 'Run the deterministic recovery command rebuilt from current task-mode and workspace state before reclassifying, after fresh operator approval for protected task-mode entry.'),
        label: hasWorkflowConfigRecoverySignal
            ? 'Restart task mode with workflow-config work'
            : 'Restart task mode with orchestrator work',
        command: buildOrchestratorWorkRestartCommand(
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            currentChangedFiles,
            hasWorkflowConfigRecoverySignal
        )
    };
}

function getDefaultCommandsPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md'));
}

function getDefaultOutputFiltersPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/config/output-filters.json'));
}

function isOriginalEntryImplementationRefresh(events: TimelineEventEntry[], preflightSequence: number,
    allowPendingCoherentRefresh = false): boolean {
    const index = recoveryIndices.get(events);
    const captured = index ? readVerifiedOriginalEntryRefresh(index, preflightSequence, allowPendingCoherentRefresh) : null;
    if (captured !== null) return captured;
    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED' && entry.sequence < preflightSequence
    );
    if (!latestTaskMode) {
        return false;
    }
    const pending = allowPendingCoherentRefresh ? findLatestTimelineEvent(events, entry =>
        entry.event_type === COHERENT_RED_PENDING_EVENT && entry.sequence > latestTaskMode.sequence
        && entry.sequence < preflightSequence) : null;
    const completed = pending ? findLatestTimelineEvent(events, entry =>
        entry.event_type === 'COHERENT_CYCLE_RESTARTED' && entry.sequence > pending.sequence
        && entry.sequence < preflightSequence) : null;
    const pendingCurrentRun = !!pending && !completed;
    const earlierBoundaries = events.filter(
        (entry) => (countNextStepWork('visit:next-step-preflight-recovery:event:826'), entry.sequence < preflightSequence && COHERENT_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
            && (!pendingCurrentRun || entry.sequence > latestTaskMode.sequence))
    );
    // This exception only selects workspace refresh. Readiness/finalization still authenticate
    // the pending checkpoint, current source and all gates; current review/completion barriers remain.
    return (earlierBoundaries.length > 0 || pendingCurrentRun) && earlierBoundaries.every(
        (entry) => entry.event_type === 'IMPLEMENTATION_STARTED' && entry.sequence > latestTaskMode.sequence
    );
}

export function readPendingPreflightRefresh(eventsRoot: string, taskId: string): {
    nextGate: 'load-rule-pack' | 'handshake-diagnostics' | 'shell-smoke-preflight' | 'classify-change' | 'restart-coherent-cycle';
    reason: string;
    /** The latest coherent-cycle boundary; REVIEW_PHASE_STARTED means reviews of this cycle are under way. */
    boundaryEventType?: string;
} | null {
    const errors: string[] = [];
    const events = readOrderedRouteEvents(path.join(eventsRoot, `${taskId}.jsonl`), errors);
    if (errors.length > 0 || events.length === 0) return null;
    const boundary = findLatestTimelineEvent(events, entry => COHERENT_CYCLE_BOUNDARY_EVENTS.has(entry.event_type));
    if (!boundary) return null;
    if (!isOriginalEntryImplementationRefresh(events, events[events.length - 1].sequence + 1, true)) {
        return {
            boundaryEventType: boundary.event_type,
            nextGate: 'restart-coherent-cycle',
            reason: 'The pending workspace refresh follows a review, completion or re-entry boundary. Rebuild its diagnostic prefix and durable restart evidence together before reclassification.'
        };
    }
    const taskEntryRules = findLatestTimelineEvent(events, isTaskEntryRulePackLoadedEvent);
    if (!taskEntryRules || taskEntryRules.sequence <= boundary.sequence) {
        return {
            nextGate: 'load-rule-pack',
            reason: 'Refresh TASK_ENTRY rules after IMPLEMENTATION_STARTED so the new diagnostic prefix can supersede the previous shell-smoke evidence without resetting task mode.'
        };
    }
    const handshake = findLatestTimelineEvent(events, entry =>
        entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED' && entry.sequence > boundary.sequence);
    if (!handshake || handshake.outcome !== 'PASS') {
        return {
            nextGate: 'handshake-diagnostics',
            reason: 'Refresh handshake after IMPLEMENTATION_STARTED before classifying the changed workspace in the original task entry.'
        };
    }
    const shellSmoke = findLatestTimelineEvent(events, entry =>
        entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED' && entry.sequence > handshake.sequence);
    if (!shellSmoke || shellSmoke.outcome !== 'PASS') {
        return {
            nextGate: 'shell-smoke-preflight',
            reason: 'Refresh shell smoke after the current implementation handshake before reclassifying workspace scope.'
        };
    }
    return {
        nextGate: 'classify-change',
        reason: 'Current implementation handshake and shell smoke cover the pending preflight refresh; retain the original task entry.'
    };
}

export function readCoherentCycleReadiness(
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null,
    taskIntent: string | null = null
): CoherentCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = readOrderedRouteEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.',
            command: null
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.',
            command: null
        };
    }

    const restartOrigin = latestPreflight.details?.review_restart_origin;
    if (taskModePath && latestPreflight.actor === 'gate' && latestPreflight.outcome === 'INFO'
        && latestPreflight.task_id === taskId && latestPreflight.integrity
        && isPlainRecord(restartOrigin) && typeof restartOrigin.review_type === 'string'
        && /^[a-z][a-z0-9-]*$/u.test(restartOrigin.review_type)
        && isSha256(restartOrigin.task_mode_sha256)
        && isSha256(latestPreflight.details?.output_sha256)
        && resolveEventPath(repoRoot, latestPreflight.details?.output_path) === path.resolve(preflightPath)
        && !events.some(entry => entry.sequence > latestPreflight.sequence && (
            RESTART_COMPLETED_EVENT_TYPES.has(entry.event_type)
            || entry.event_type === 'TASK_MODE_ENTERED'
            || entry.event_type === 'REVIEW_PHASE_STARTED'
            || entry.event_type === 'REVIEW_GATE_PASSED'
            || entry.event_type === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
            || entry.event_type === 'COMPLETION_GATE_FAILED'
            || entry.event_type === 'COMPLETION_GATE_PASSED'
        ))
        && fileSha256(preflightPath) === latestPreflight.details?.output_sha256
        && fileSha256(taskModePath) === restartOrigin.task_mode_sha256) {
        return {
            ready: false,
            reason: 'The current preflight belongs to an unfinished review remediation restart. '
                + 'Retry that restart so it can verify the original review and finish publishing the current review decisions.',
            command: null,
            reviewRestartOrigin: restartOrigin.review_type
        };
    }

    const latestBoundary = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence < latestPreflight.sequence && COHERENT_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
    );
    const lowerBoundExclusive = latestBoundary?.sequence ?? Number.NEGATIVE_INFINITY;
    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
            && entry.sequence > lowerBoundExclusive
            && entry.sequence < latestPreflight.sequence
        )
    );
    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            && entry.sequence > lowerBoundExclusive
            && entry.sequence < latestPreflight.sequence
        )
    );

    const violations: string[] = [];
    if (!latestHandshake) {
        violations.push('HANDSHAKE_DIAGNOSTICS_RECORDED is missing before the latest PREFLIGHT_CLASSIFIED inside the latest execution cycle');
    }
    if (!latestShellSmoke) {
        violations.push('SHELL_SMOKE_PREFLIGHT_RECORDED is missing before the latest PREFLIGHT_CLASSIFIED inside the latest execution cycle');
    }
    if (latestHandshake && latestShellSmoke && latestShellSmoke.sequence < latestHandshake.sequence) {
        violations.push('SHELL_SMOKE_PREFLIGHT_RECORDED predates HANDSHAKE_DIAGNOSTICS_RECORDED inside the latest execution cycle');
    }

    if (violations.length === 0) {
        if (events.some(event => event.event_type === 'COHERENT_CYCLE_RED_PENDING')) {
            try {
                const checkpoint = readCoherentRedCheckpoint(repoRoot, taskId);
                if (checkpoint && !checkpoint.completedArtifactPath) return { ready: true,
                    reason: 'Authenticated coherent recovery awaits current RED and validation; normal gates remain mandatory.',
                    command: null };
            } catch (error) {
                const pendingRedPreflightSuperseded = error instanceof PreflightSupersededError
                    && findLatestTimelineEvent(events, entry => entry.event_type === COHERENT_RED_PENDING_EVENT
                        || entry.event_type === 'COHERENT_CYCLE_RESTARTED')?.event_type === COHERENT_RED_PENDING_EVENT;
                return { ready: false, reason: `Coherent RED checkpoint rejected: ${String(error)}`, command: null,
                    pendingRedPreflightSuperseded };
            }
        }
        if (events.some(event => event.event_type === 'REVIEW_CYCLE_VALIDATION_PENDING')) {
            try {
                const checkpoint = readReviewValidationCheckpoint(repoRoot, taskId);
                if (checkpoint && !checkpoint.completedArtifactPath) return {
                    ready: true,
                    reason: 'Authenticated review recovery is prepared and awaits current validation; restart completion is still pending.',
                    command: null
                };
            } catch (error) {
                return { ready: false, reason: `Review recovery checkpoint rejected: ${String(error)}`, command: null };
            }
        }
        const latestCompilePass = findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'COMPILE_GATE_PASSED' && entry.sequence > latestPreflight.sequence
        );
        if (latestBoundary?.event_type === 'IMPLEMENTATION_STARTED' && !latestCompilePass) {
            if (!isOriginalEntryImplementationRefresh(events, latestPreflight.sequence)) {
                // Re-entry still owes its durable restart receipt after the next compile, so compiling first would
                // only be repeated by the restart. Recover through the real restart flow right away.
                const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
                const taskModePayload = taskModePath ? safeReadJson(taskModePath) : null;
                return {
                    ready: false,
                    reason: `Latest PREFLIGHT_CLASSIFIED (seq ${latestPreflight.sequence}) follows IMPLEMENTATION_STARTED ` +
                        `(seq ${latestBoundary.sequence}), but no compile pass belongs to the refreshed preflight cycle. ` +
                        'Run restart-coherent-cycle to rebuild ordered implementation and compile evidence before reviews or completion.',
                    command: buildCoherentCycleRestartCommand(repoRoot, taskId, normalizePath(preflightPath), taskModePath,
                        typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
                            ? compileEvidence.commands_path.trim() : getDefaultCommandsPath(repoRoot),
                        typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
                            ? compileEvidence.output_filters_path.trim() : getDefaultOutputFiltersPath(repoRoot),
                        { requiresOperatorConfirmation: isPlainRecord(taskModePayload)
                            && (taskModePayload.orchestrator_work === true || taskModePayload.workflow_config_work === true), taskIntent })
                };
            }
            // The original task entry refreshed its preflight (for example after a failed compile or an edit
            // before any review). No restart is owed: compile-gate runs again after the new preflight and
            // records a fresh, correctly ordered pass. A compile artifact that still binds the same preflight
            // bytes is the one thing that could hide this, so report the older pass for the compile route.
            const compilePassBeforePreflight = findLatestTimelineEvent(
                events,
                (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
            );
            if (compilePassBeforePreflight) {
                return {
                    ready: true,
                    reason: 'Latest preflight has current-cycle handshake and shell-smoke evidence; compile must run again after it.',
                    command: null,
                    compilePassBeforePreflight: {
                        compileSequence: compilePassBeforePreflight.sequence,
                        preflightSequence: latestPreflight.sequence
                    }
                };
            }
        }
        if (latestBoundary && latestCompilePass && !isOriginalEntryImplementationRefresh(events, latestPreflight.sequence)) {
            const restartCompletedEvent = findLatestTimelineEvent(
                events,
                (entry) => RESTART_COMPLETED_EVENT_TYPES.has(entry.event_type) && entry.sequence > latestCompilePass.sequence
            );
            if (!restartCompletedEvent) {
                const compileAnchor = ` after COMPILE_GATE_PASSED (seq ${latestCompilePass.sequence})`;
                const cycleAnchor = ` after latest ${latestBoundary.event_type} (seq ${latestBoundary.sequence})`;
                const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
                const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
                    ? compileEvidence.commands_path.trim()
                    : getDefaultCommandsPath(repoRoot);
                const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
                    ? compileEvidence.output_filters_path.trim()
                    : getDefaultOutputFiltersPath(repoRoot);
                const taskModePayload = taskModePath ? safeReadJson(taskModePath) : null;
                const requiresOperatorConfirmation = isPlainRecord(taskModePayload)
                    && (taskModePayload.orchestrator_work === true || taskModePayload.workflow_config_work === true);
                return {
                    ready: false,
                    reason:
                        `Latest restarted compile cycle${cycleAnchor} has no persisted restart-completed event${compileAnchor}. ` +
                        'Rerun restart-coherent-cycle so long compile recovery cannot advance from stdout-only success.',
                    command: buildCoherentCycleRestartCommand(
                        repoRoot,
                        taskId,
                        normalizePath(preflightPath),
                        taskModePath,
                        commandsPath,
                        outputFiltersPath,
                        { requiresOperatorConfirmation, taskIntent }
                    )
                };
            }
            const restartEventViolations = validateRestartCompletedEvent(
                repoRoot,
                reviewsRoot,
                taskId,
                preflightPath,
                restartCompletedEvent
            );
            if (restartEventViolations.length > 0) {
                const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
                const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
                    ? compileEvidence.commands_path.trim()
                    : getDefaultCommandsPath(repoRoot);
                const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
                    ? compileEvidence.output_filters_path.trim()
                    : getDefaultOutputFiltersPath(repoRoot);
                const taskModePayload = taskModePath ? safeReadJson(taskModePath) : null;
                const requiresOperatorConfirmation = isPlainRecord(taskModePayload)
                    && (taskModePayload.orchestrator_work === true || taskModePayload.workflow_config_work === true);
                return {
                    ready: false,
                    reason:
                        `Latest restart-completed event ${restartCompletedEvent.event_type} (seq ${restartCompletedEvent.sequence}) is not valid durable recovery evidence: ` +
                        `${restartEventViolations.join('; ')}. Rerun restart-coherent-cycle to refresh task-mode, preflight, compile, and restart evidence together.`,
                    command: buildCoherentCycleRestartCommand(
                        repoRoot,
                        taskId,
                        normalizePath(preflightPath),
                        taskModePath,
                        commandsPath,
                        outputFiltersPath,
                        { requiresOperatorConfirmation, taskIntent }
                    )
                };
            }
        }
        return {
            ready: true,
            reason: 'Latest preflight has current-cycle handshake and shell-smoke evidence.',
            command: null
        };
    }

    const restartCompletedEventAfterLatestPreflight = findLatestTimelineEvent(
        events,
        (entry) => RESTART_COMPLETED_EVENT_TYPES.has(entry.event_type) && entry.sequence > latestPreflight.sequence
    );
    if (restartCompletedEventAfterLatestPreflight) {
        const restartEventViolations = validateRestartCompletedEvent(
            repoRoot,
            reviewsRoot,
            taskId,
            preflightPath,
            restartCompletedEventAfterLatestPreflight
        );
        if (restartEventViolations.length === 0) {
            return {
                ready: true,
                reason:
                    `Latest preflight is covered by valid persisted ${restartCompletedEventAfterLatestPreflight.event_type} ` +
                    `(seq ${restartCompletedEventAfterLatestPreflight.sequence}).`,
                command: null
            };
        }

        const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
        const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
            ? compileEvidence.commands_path.trim()
            : getDefaultCommandsPath(repoRoot);
        const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
            ? compileEvidence.output_filters_path.trim()
            : getDefaultOutputFiltersPath(repoRoot);
        const taskModePayload = taskModePath ? safeReadJson(taskModePath) : null;
        const requiresOperatorConfirmation = isPlainRecord(taskModePayload)
            && (taskModePayload.orchestrator_work === true || taskModePayload.workflow_config_work === true);
        return {
            ready: false,
            reason:
                `Latest restart-completed event ${restartCompletedEventAfterLatestPreflight.event_type} ` +
                `(seq ${restartCompletedEventAfterLatestPreflight.sequence}) is not valid durable recovery evidence: ` +
                `${restartEventViolations.join('; ')}. Rerun restart-coherent-cycle to refresh task-mode, preflight, compile, and restart evidence together.`,
            command: buildCoherentCycleRestartCommand(
                repoRoot,
                taskId,
                normalizePath(preflightPath),
                taskModePath,
                commandsPath,
                outputFiltersPath,
                { requiresOperatorConfirmation, taskIntent }
            )
        };
    }

    const preflightPayload = safeReadJson(preflightPath);
    const latestBoundaryType = String(latestBoundary?.event_type || '').trim();
    if (
        isPlainRecord(preflightPayload)
        && [
            'REVIEW_GATE_PASSED',
            'REVIEW_GATE_PASSED_WITH_OVERRIDE',
            'COMPLETION_GATE_FAILED'
        ].includes(latestBoundaryType)
    ) {
        const docsOnlyExtensionReadiness = buildCompileEvidenceDocsOnlyExtensionReadiness(
            repoRoot,
            reviewsRoot,
            taskId,
            preflightPayload
        );
        if (docsOnlyExtensionReadiness) {
            return {
                ready: true,
                reason:
                    `Latest preflight was refreshed after ${latestBoundaryType}, but the refreshed scope only adds ordinary docs/closeout files ` +
                    'while implementation/test/config domains remain bound to the latest compile evidence. ' +
                    docsOnlyExtensionReadiness.reason,
                command: null
            };
        }
        const unchangedReclassification = readUnchangedReclassificationReadiness(preflightPath, events, latestPreflight, taskId);
        // Route witnesses keep only the latest boundaries; the rerun bound needs the whole signed history. An unreadable
        // history cannot prove the bound holds, so it stops like a tripped bound (fail closed).
        const fullHistoryErrors: string[] = [];
        const fullHistory = unchangedReclassification
            ? collectOrderedTimelineEvents(timelinePath, fullHistoryErrors)
            : [];
        const boundDetail = unchangedReclassification
            ? describeReclassificationBoundStop(fullHistory, fullHistoryErrors, taskId)
            : null;
        if (unchangedReclassification && boundDetail) {
            const repeatedTaskMode = taskModePath ? safeReadJson(taskModePath) : null;
            // Another round on the unchanged tree would loop, and a silent restart would drop passed reviews: stop
            // with the cause named and leave the new review cycle to the user.
            return {
                ready: false,
                reason: `Latest PREFLIGHT_CLASSIFIED (seq ${latestPreflight.sequence}) re-records the reviewed classification again, but `
                    + `${boundDetail} Rerunning the unchanged cycle does not change that verdict. Fix the violations completion-gate `
                    + 'names; the passed reviews stay valid while the tree is unchanged. Restart the cycle with new reviews only after '
                    + 'the user approves it.',
                command: buildCoherentCycleRestartCommand(
                    repoRoot,
                    taskId,
                    normalizePath(preflightPath),
                    taskModePath,
                    getDefaultCommandsPath(repoRoot),
                    getDefaultOutputFiltersPath(repoRoot),
                    {
                        requiresOperatorConfirmation: isPlainRecord(repeatedTaskMode)
                            && (repeatedTaskMode.orchestrator_work === true || repeatedTaskMode.workflow_config_work === true),
                        requiresReviewRestartApproval: true,
                        taskIntent
                    }
                ),
                reclassificationBoundReached: true
            };
        }
        if (unchangedReclassification) {
            return {
                ready: true,
                reason: `Latest preflight was refreshed after ${latestBoundaryType}. ${unchangedReclassification.reason}`,
                command: null
            };
        }
    }

    const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
    const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
        ? compileEvidence.commands_path.trim()
        : getDefaultCommandsPath(repoRoot);
    const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
        ? compileEvidence.output_filters_path.trim()
        : getDefaultOutputFiltersPath(repoRoot);
    const taskModePayload = taskModePath ? safeReadJson(taskModePath) : null;
    const requiresOperatorConfirmation = isPlainRecord(taskModePayload)
        && (taskModePayload.orchestrator_work === true || taskModePayload.workflow_config_work === true);
    const cycleAnchor = latestBoundary
        ? ` after latest ${latestBoundary.event_type} (seq ${latestBoundary.sequence})`
        : '';

    return {
        ready: false,
        reason: `Latest PREFLIGHT_CLASSIFIED (seq ${latestPreflight.sequence}) is not in a coherent preflight cycle${cycleAnchor}: ${violations.join('; ')}. Run restart-coherent-cycle before compile/review/completion so expensive review work is not launched against stage-sequence evidence that completion-gate will reject.`,
        command: buildCoherentCycleRestartCommand(
            repoRoot,
            taskId,
            normalizePath(preflightPath),
            taskModePath,
            commandsPath,
            outputFiltersPath,
            { requiresOperatorConfirmation, taskIntent }
        )
    };
}

export function resolveActiveTaskModeArtifactPath(
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    taskId: string
): string {
    const defaultTaskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = readOrderedRouteEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return defaultTaskModePath;
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    const rawArtifactPath = latestTaskMode?.details?.artifact_path ?? latestTaskMode?.details?.artifactPath;
    const artifactPath = typeof rawArtifactPath === 'string' ? rawArtifactPath.trim() : '';
    if (!artifactPath) {
        return defaultTaskModePath;
    }
    return resolvePathInsideRepo(artifactPath, repoRoot, { allowMissing: true }) || defaultTaskModePath;
}

function getLatestTimelineSequence(eventsRoot: string, taskId: string, eventType: string): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    // The fused verified-pass fact answers compatible native streams; the bounded route query covers the rest.
    const index = readInvocationVerifiedEventIndex(timelinePath, taskId);
    const captured = index ? readVerifiedRecoverySequence(index, eventType) : null;
    if (captured) return captured.sequence;
    const query = readTaskTimelineRouteQuery(timelinePath, taskId);
    if (query) return routeLatestNormalizedSequence(query, eventType);
    const errors: string[] = [];
    const events = readOrderedRouteEvents(timelinePath, errors);
    let latestSequence: number | null = null;
    for (const event of events) {
        countNextStepWork('visit:next-step-preflight-recovery:event:1163');
        if (event.event_type !== eventType) {
            continue;
        }
        const sequence = event.integrity?.task_sequence ?? event.sequence;
        if (!Number.isFinite(sequence)) {
            continue;
        }
        latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
    }
    return latestSequence;
}

export function isLatestCompletionCurrent(eventsRoot: string, taskId: string): boolean {
    const latestCompletionSequence = getLatestTimelineSequence(eventsRoot, taskId, 'COMPLETION_GATE_PASSED');
    if (latestCompletionSequence == null) {
        return false;
    }
    const latestTaskModeSequence = getLatestTimelineSequence(eventsRoot, taskId, 'TASK_MODE_ENTERED');
    return latestTaskModeSequence == null || latestCompletionSequence >= latestTaskModeSequence;
}

const recoveryIndices = new WeakMap<TimelineEventEntry[], VerifiedTaskEventIndex>();
function readOrderedRouteEvents(timelinePath: string, errors: string[]): TimelineEventEntry[] {
    const events = readImmutableRouteOrderedWitnesses(timelinePath, errors, 'preflight');
    const index = readInvocationVerifiedEventIndex(timelinePath, path.basename(timelinePath, '.jsonl'));
    if (index) recoveryIndices.set(events, index);
    return events;
}
