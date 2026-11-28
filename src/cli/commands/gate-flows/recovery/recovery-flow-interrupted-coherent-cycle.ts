import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isPlainRecord } from '../../../../core/records';
import {
    inspectTaskEventFile,
    type TaskEventAppendState,
    withTaskTimelineReadSnapshot
} from '../../../../gate-runtime/task-events';
import { TASK_EVENT_INTEGRITY_SCHEMA_VERSION } from '../../../../gate-runtime/timeline/task-events-helpers';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import {
    collectOrderedTimelineEvents,
    findLatestTimelineEvent,
    type TimelineEventEntry
} from '../../../../gates/completion/completion-evidence';
import { readPreflightWorkspaceReadiness } from '../../../../gates/next-step/next-step-preflight-workspace-readiness';
import { getRulePackEvidence, getRulePackEvidenceViolations } from '../../../../gates/rule-pack/rule-pack';
import * as gateHelpers from '../../../../gates/shared/helpers';
import type { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import {
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from '../../../../gates/workspace/dirty-worktree-protection';
import { createWorkspaceSnapshotRequest } from '../../../../gates/workspace/workspace-snapshot-cache';
import { assertSingleActiveImplementationOwner } from '../../../../gates/workspace/active-implementation-ownership';
import { evaluateCompileProtectedManifestGuard, evaluateCompileWorkflowConfigGuard } from '../compile/compile-flow-scope-guards';
import { readConfiguredCompileGateCommandForCompileGate } from '../compile/compile-flow-shared-evidence';
import { resolveOutputFiltersPath } from '../compile/output-budget-filter';
import { evaluateGateFlowStartupDiagnostics } from '../support/gate-flow-runtime';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';

const LIFECYCLE_BOUNDARY_EVENTS = new Set([
    'IMPLEMENTATION_STARTED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);
const RESTART_EVENTS = new Set(['COHERENT_CYCLE_RESTARTED', 'REVIEW_CYCLE_RESTARTED']);

interface CompileRecoveryBindings {
    taskModeSha256: string;
    preflightSha256: string;
    compileEvidenceSha256: string;
}

export interface InterruptedCompileRecovery extends CompileRecoveryBindings {
    compileSequence: number;
    failedCompileSequence: number;
    passedShellSmokeSequence: number;
    expectedPreviousState: TaskEventAppendState;
    validateBeforeCanonicalAppend: () => void;
}

interface RecoveryInput {
    repoRoot: string;
    taskId: string;
    timelinePath: string;
    taskModePath: string;
    taskMode: ReturnType<typeof getTaskModeEvidence>;
    preflightPath: string;
    compileEvidencePath: string;
    outputFiltersPath?: string;
}

interface VerifiedEvent {
    type: string;
    actor: string;
    outcome: string;
    details: Record<string, unknown>;
    sequence: number;
}

function pathMatches(value: unknown, expectedPath: string): boolean {
    return typeof value === 'string' && path.isAbsolute(value)
        && gateHelpers.normalizePath(path.resolve(value)) === gateHelpers.normalizePath(path.resolve(expectedPath));
}

function isGateEvent(event: VerifiedEvent | undefined, outcome: string): event is VerifiedEvent {
    return event?.actor === 'gate' && event.outcome === outcome;
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
        && value === new Date(value).toISOString();
}

function readCompileRecoveryBindings(
    input: RecoveryInput,
    preflightEvent: VerifiedEvent,
    rulePackEvent: VerifiedEvent,
    compile: VerifiedEvent
): CompileRecoveryBindings | null {
    const { repoRoot, taskId, taskMode, taskModePath, preflightPath, compileEvidencePath, timelinePath } = input;
    if (![taskModePath, preflightPath, compileEvidencePath].every(file =>
        gateHelpers.isPathRealpathInsideRoot(file, repoRoot, { allowMissing: false }))) return null;
    const taskModeSha256 = gateHelpers.fileSha256(taskModePath);
    const preflightSha256 = gateHelpers.fileSha256(preflightPath);
    const compileText = fs.readFileSync(compileEvidencePath, 'utf8');
    const compileEvidenceSha256 = gateHelpers.stringSha256(compileText);
    const artifact: unknown = JSON.parse(compileText);
    const { event_type: eventType, timestamp_utc: eventTime, ...details } = compile.details;

    if (!isPlainRecord(artifact) || !taskModeSha256 || !preflightSha256 || !compileEvidenceSha256
        || eventType !== 'compile_gate_check' || !isCanonicalUtcTimestamp(eventTime)
        || !isCanonicalUtcTimestamp(artifact.timestamp_utc) || artifact.timestamp_utc < eventTime
        || details.task_id !== taskId || details.status !== 'PASSED' || details.exit_code !== 0
        || taskMode.plan !== null || details.plan_drift !== null
        || !isDeepStrictEqual(artifact, { ...details, timestamp_utc: artifact.timestamp_utc,
            event_source: 'compile-gate', outcome: 'PASS', error: null })
        || !pathMatches(details.evidence_path, compileEvidencePath)
        || !pathMatches(details.preflight_path, preflightPath)
        || details.preflight_hash_sha256 !== preflightSha256
        || preflightEvent.details.output_sha256 !== preflightSha256
        || !isPlainRecord(details.task_mode) || details.task_mode.evidence_hash !== taskModeSha256
        || taskMode.evidence_hash !== taskModeSha256) return null;

    const preflight = getPreflightContext(preflightPath, taskId);
    const rulePack = getRulePackEvidence(repoRoot, taskId, 'POST_PREFLIGHT', { preflightPath, taskModePath });
    if (!isPlainRecord(details.rule_pack) || !rulePack.evidence_hash
        || !pathMatches(rulePackEvent.details.artifact_path, rulePack.evidence_path ?? '')
        || details.rule_pack.evidence_hash !== rulePack.evidence_hash
        || getRulePackEvidenceViolations(rulePack).length > 0
        || evaluateGateFlowStartupDiagnostics({ repoRoot, taskId, taskModePath, timelinePath, preflightPath }).length > 0) return null;

    if (!['explicit_changed_files', 'git_auto'].includes(preflight.detection_source)
        || !preflight.include_untracked || preflight.preflight.include_untracked === false) return null;
    const workspaceSnapshotRequest = createWorkspaceSnapshotRequest(repoRoot);
    // An explicit scope alone cannot detect edits to a previously clean input outside that scope.
    workspaceSnapshotRequest.read('git_auto', true, []);
    const globalReadiness = readPreflightWorkspaceReadiness(repoRoot, preflight.preflight, {
        allowDocsOnlyDelta: false,
        plannedChangedFiles: taskMode.planned_changed_files,
        dirtyWorkspaceBaselineChangedFiles: taskMode.dirty_workspace_baseline?.changed_files,
        dirtyWorkspaceBaselineFileHashes: Object.fromEntries(Object.entries(taskMode.dirty_workspace_baseline?.file_hashes ?? {})
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        workspaceSnapshotRequest
    });
    if (!globalReadiness.ready || globalReadiness.acceptedCloseoutOnlyDeltaFiles?.length) return null;
    const workspace = workspaceSnapshotRequest.read(preflight.detection_source, preflight.include_untracked, preflight.authorized_files);
    if (!preflight.scope_sha256 || !preflight.scope_content_sha256
        || preflightEvent.details.scope_sha256 !== workspace.scope_sha256
        || preflightEvent.details.scope_content_sha256 !== workspace.scope_content_sha256
        || details.scope_detection_source !== workspace.detection_source
        || details.scope_include_untracked !== workspace.include_untracked
        || details.scope_authorized_files_sha256 !== workspace.authorized_files_sha256
        || details.scope_changed_files_sha256 !== workspace.changed_files_sha256
        || details.scope_changed_lines_total !== workspace.changed_lines_total
        || details.scope_sha256 !== workspace.scope_sha256
        || details.scope_content_sha256 !== workspace.scope_content_sha256) return null;

    const configured = readConfiguredCompileGateCommandForCompileGate(repoRoot);
    if (details.compile_command_source !== 'workflow_config' || !configured.command
        || !isDeepStrictEqual(details.compile_commands, [configured.command])
        || !pathMatches(details.workflow_config_path, configured.configPath)
        || !pathMatches(details.output_filters_path, resolveOutputFiltersPath(repoRoot, input.outputFiltersPath || ''))
        || !Array.isArray(details.invocation_executions) || details.invocation_executions.length === 0
        || !details.invocation_executions.every(result => isPlainRecord(result) && result.exit_code === 0
            && result.execution_error === null && result.timed_out === false && result.cancelled === false)) return null;

    const protectedSnapshot = gateHelpers.scanProtectedPathHashes(repoRoot, gateHelpers.getProtectedControlPlaneRoots(repoRoot),
        { readOnly: true, noCache: true });
    const triggers: unknown = preflight.preflight.triggers;
    if (!isPlainRecord(triggers)
        || triggers.protected_control_plane_snapshot_sha256 !== gateHelpers.computeProtectedSnapshotDigest(protectedSnapshot)) return null;
    const guardInput = { repoRoot, taskModeEvidence: taskMode, phaseLabel: 'coherent-cycle compile recovery',
        preflightChangedFiles: preflight.authorized_files };
    const { guard } = evaluateCompileProtectedManifestGuard({ ...guardInput, preflight: preflight.preflight,
        buildRestartCommand: () => '' });
    const workflow = evaluateCompileWorkflowConfigGuard({ ...guardInput, baselineFileHashes: taskMode.workflow_config_file_hashes });
    if (guard.status === 'BLOCK' || workflow.scanError || workflow.violations.length > 0
        || detectProtectedDirtyWorkspaceDrift(repoRoot, getProtectedDirtyWorkspaceScopeFromPreflight(preflight.preflight)).status === 'DRIFT_DETECTED')
        return null;

    assertSingleActiveImplementationOwner(repoRoot, taskId, 'compile gate');
    return { taskModeSha256, preflightSha256, compileEvidenceSha256 };
}

function readCurrentInterruptedCompile(input: RecoveryInput): InterruptedCompileRecovery | null {
    const events: VerifiedEvent[] = [];
    let lastEventHash: string | null = null;
    const inspection = inspectTaskEventFile(input.timelinePath, input.taskId, {
        onIntegrityEvent: event => {
            const integrity = event.integrity;
            if (!isPlainRecord(integrity) || integrity.schema_version !== TASK_EVENT_INTEGRITY_SCHEMA_VERSION
                || typeof integrity.task_sequence !== 'number' || typeof integrity.event_sha256 !== 'string') return;
            lastEventHash = integrity.event_sha256;
            events.push({ type: String(event.event_type), actor: String(event.actor), outcome: String(event.outcome),
                details: isPlainRecord(event.details) ? event.details : {}, sequence: integrity.task_sequence });
        }
    });
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) || !lastEventHash) return null;
    events.reverse();
    const latest = (type: string, after = 0) => events.find(event => event.type === type && event.sequence > after);
    const taskMode = latest('TASK_MODE_ENTERED');
    const lastReset = latest('TASK_RESET');
    if (!isGateEvent(taskMode, 'PASS') || !pathMatches(taskMode.details.artifact_path, input.taskModePath)
        || !events.some(event => event.sequence > (lastReset?.sequence ?? 0) && event.sequence < taskMode.sequence
            && event.actor === 'gate'
            && LIFECYCLE_BOUNDARY_EVENTS.has(event.type))
        || events.some(event => event.sequence > taskMode.sequence
            && (RESTART_EVENTS.has(event.type) || event.type === 'TASK_RESET' || event.type === 'TASK_INTENT_UPDATED'
                || (event.type !== 'IMPLEMENTATION_STARTED' && LIFECYCLE_BOUNDARY_EVENTS.has(event.type))))) return null;

    const taskEntry = events.find(event => event.type === 'RULE_PACK_LOADED' && event.sequence > taskMode.sequence
        && event.details.stage === 'TASK_ENTRY');
    const handshake = latest('HANDSHAKE_DIAGNOSTICS_RECORDED');
    const shellSmoke = latest('SHELL_SMOKE_PREFLIGHT_RECORDED');
    const preflight = latest('PREFLIGHT_CLASSIFIED');
    if (!isGateEvent(taskEntry, 'PASS') || !isGateEvent(handshake, 'PASS') || handshake.sequence <= taskEntry.sequence
        || !isGateEvent(shellSmoke, 'PASS') || shellSmoke.sequence <= handshake.sequence
        || !isGateEvent(preflight, 'INFO') || preflight.sequence <= shellSmoke.sequence
        || preflight.details.review_restart_origin != null
        || !pathMatches(preflight.details.output_path, input.preflightPath)) return null;

    const rulePack = events.find(event => event.type === 'RULE_PACK_LOADED' && event.details.stage === 'POST_PREFLIGHT');
    const implementation = latest('IMPLEMENTATION_STARTED');
    const compile = events.find(event => event.type === 'COMPILE_GATE_PASSED' || event.type === 'COMPILE_GATE_FAILED');
    if (!isGateEvent(rulePack, 'PASS') || rulePack.sequence <= preflight.sequence
        || !pathMatches(rulePack.details.preflight_path, input.preflightPath)
        || !isGateEvent(implementation, 'INFO') || implementation.sequence <= rulePack.sequence
        || !pathMatches(implementation.details.preflight_path, input.preflightPath)
        || !isGateEvent(compile, 'PASS') || compile.type !== 'COMPILE_GATE_PASSED'
        || compile.sequence <= implementation.sequence) return null;

    const failedCompile = latest('COMPILE_GATE_FAILED', rulePack.sequence);
    if (!isGateEvent(failedCompile, 'FAIL') || failedCompile.sequence >= implementation.sequence
        || failedCompile.details.preflight_hash_sha256 !== compile.details.preflight_hash_sha256
        || !pathMatches(failedCompile.details.preflight_path, input.preflightPath)) return null;

    const bindings = readCompileRecoveryBindings(input, preflight, rulePack, compile);
    if (!bindings) return null;
    return {
        ...bindings,
        passedShellSmokeSequence: shellSmoke.sequence,
        failedCompileSequence: failedCompile.sequence,
        compileSequence: compile.sequence,
        expectedPreviousState: { matching_events: inspection.matching_events, parse_errors: inspection.parse_errors,
            last_integrity_sequence: inspection.last_integrity_sequence, last_event_sha256: lastEventHash },
        validateBeforeCanonicalAppend: () => {
            if (!isDeepStrictEqual(bindings, readCompileRecoveryBindings(input, preflight, rulePack, compile))) {
                throw new Error('Current compile or recovery inputs changed before coherent-cycle finalization.');
            }
        }
    };
}

/** Finish an already recovered cycle without replacing its preflight or focused validation evidence. */
export function readInterruptedCompileRecovery(input: RecoveryInput): InterruptedCompileRecovery | null {
    try {
        return withTaskTimelineReadSnapshot(path.dirname(input.timelinePath), input.taskId,
            () => readCurrentInterruptedCompile(input));
    } catch {
        return null;
    }
}

const PRIOR_CYCLE_BOUNDARY_EVENTS = new Set([
    'IMPLEMENTATION_STARTED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'REVIEW_CYCLE_RESTARTED',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

export interface InterruptedCoherentCycleReadiness {
    ready: boolean;
    reason: string;
    failedShellSmokeSequence: number | null;
    passedShellSmokeSequence: number | null;
    compileSequence: number | null;
}

function eventPassed(entry: TimelineEventEntry): boolean {
    return entry.outcome === 'PASS' || entry.details?.passed === true;
}

function eventFailed(entry: TimelineEventEntry): boolean {
    return entry.outcome === 'FAIL' || entry.details?.passed === false;
}

function eventPathMatches(entry: TimelineEventEntry, key: string, expectedPath: string): boolean {
    const value = String(entry.details?.[key] || '').trim();
    return Boolean(value)
        && gateHelpers.normalizePath(path.resolve(value)) === gateHelpers.normalizePath(path.resolve(expectedPath));
}

function failure(reason: string): InterruptedCoherentCycleReadiness {
    return {
        ready: false,
        reason,
        failedShellSmokeSequence: null,
        passedShellSmokeSequence: null,
        compileSequence: null
    };
}

export function readInterruptedCoherentCycleReadiness(input: {
    repoRoot: string;
    taskId: string;
    taskModePath: string;
    preflightPath: string;
    compileEvidencePath: string;
}): InterruptedCoherentCycleReadiness {
    const timelinePath = path.join(
        resolveOrchestratorRoot(input.repoRoot),
        'runtime',
        'task-events',
        `${input.taskId}.jsonl`
    );
    const errors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, errors);
    if (errors.length > 0 || events.length === 0) {
        return failure('task timeline is missing or invalid');
    }

    const latestTaskMode = findLatestTimelineEvent(events, (entry) => entry.event_type === 'TASK_MODE_ENTERED');
    if (!latestTaskMode || !eventPassed(latestTaskMode) || !eventPathMatches(latestTaskMode, 'artifact_path', input.taskModePath)) {
        return failure('latest task-mode evidence does not match the current task-mode artifact');
    }
    const priorBoundary = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence < latestTaskMode.sequence && PRIOR_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
    );
    if (!priorBoundary) {
        return failure('no prior lifecycle boundary proves that startup was part of a coherent-cycle restart');
    }

    const taskEntryRules = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'RULE_PACK_LOADED'
            && entry.sequence > latestTaskMode.sequence
            && String(entry.details?.stage || '').trim().toUpperCase() === 'TASK_ENTRY'
    );
    const handshake = taskEntryRules
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
                && entry.sequence > taskEntryRules.sequence
                && eventPassed(entry)
        )
        : null;
    if (!taskEntryRules || !handshake) {
        return failure('current task-mode cycle lacks passed TASK_ENTRY rules or handshake evidence');
    }

    const failedShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            && entry.sequence > handshake.sequence
            && eventFailed(entry)
    );
    const passedShellSmoke = failedShellSmoke
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
                && entry.sequence > failedShellSmoke.sequence
                && eventPassed(entry)
        )
        : null;
    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            && entry.sequence > handshake.sequence
    );
    if (!failedShellSmoke || !passedShellSmoke || latestShellSmoke?.sequence !== passedShellSmoke.sequence) {
        return failure('no failed-then-passed shell-smoke sequence proves recovery from an interrupted restart');
    }

    const preflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
            && entry.sequence > passedShellSmoke.sequence
            && eventPathMatches(entry, 'output_path', input.preflightPath)
    );
    const postPreflightRules = preflight
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'RULE_PACK_LOADED'
                && entry.sequence > preflight.sequence
                && String(entry.details?.stage || '').trim().toUpperCase() === 'POST_PREFLIGHT'
        )
        : null;
    const implementationStarted = postPreflightRules
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'IMPLEMENTATION_STARTED'
                && entry.sequence > postPreflightRules.sequence
        )
        : null;
    const compilePass = implementationStarted
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
                && entry.sequence > implementationStarted.sequence
                && eventPassed(entry)
                && eventPathMatches(entry, 'evidence_path', input.compileEvidencePath)
        )
        : null;
    if (!preflight || !postPreflightRules || !implementationStarted || !compilePass) {
        return failure('recovered startup is not followed by matching preflight, POST_PREFLIGHT rules, and compile evidence');
    }

    if (events.some(entry => entry.event_type === 'COMPILE_GATE_FAILED' && entry.sequence > preflight.sequence)) {
        return failure('a failed compile in this preflight cycle requires compile recovery validation');
    }

    const laterRestartCompletion = findLatestTimelineEvent(
        events,
        (entry) => ['COHERENT_CYCLE_RESTARTED', 'REVIEW_CYCLE_RESTARTED'].includes(entry.event_type)
            && entry.sequence > compilePass.sequence
    );
    if (laterRestartCompletion) {
        return failure('restart completion is already recorded after the current compile evidence');
    }

    return {
        ready: true,
        reason: 'failed shell-smoke was retried successfully and current preflight/compile evidence completes the interrupted restart',
        failedShellSmokeSequence: failedShellSmoke.sequence,
        passedShellSmokeSequence: passedShellSmoke.sequence,
        compileSequence: compilePass.sequence
    };
}
