import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainRecord } from '../../../../core/records';
import { isIntermediateSelection, selectionMatchesCase } from '../../../../core/intermediate-selected-cases';
import { getIntermediatePreflightSemanticSha256 } from '../../../../core/intermediate-execution-preflight-identity';
import { assessBoundTrustBoundaryMatrix, TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../../core/trust-boundary-analysis';
import { assertContainedDestination, bindContainedDestination, writeContainedFile } from '../../../../core/contained-filesystem';
import { readValidationFile, validationDigest } from '../../../../core/project-validation-identity';
import { readInvocationVerifiedEventIndex, readInvocationVerifiedTaskEventTimeline } from '../../../../gate-runtime/timeline/task-events-integrity';
import { readTaskTimelineValidationJsonLinesCompatible } from '../../../../gate-runtime/timeline/task-events-helpers';
import { appendMandatoryTaskEvent, assertValidTaskId, inspectTaskEventFile } from '../../../../gate-runtime/task-events';
import { classifiedContentFingerprint, readImmutableValidationEventSnapshot, readValidationEventSnapshot } from '../../../../gates/project-validation/attempt-evidence';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import { readExpectedRedPreparation, readExpectedRedReviewObligations, taskRequiresExpectedRed } from '../../../../gates/test-first/expected-red-evidence';
import { resolveCurrentNoOpPreflightPath } from '../../../../gates/task-mode/no-op';
import { QUALITY_CHECKLIST_ID } from '../../../../gates/quality-checklist';
import { readQualityValidationPhaseAnalysis } from '../../../../gates/review-context/review-context-trust-boundary-analysis';
import { buildFullSuiteValidationEvidence } from '../../../../gates/review-context/review-context-validation-evidence';
import { loadFullSuiteValidationConfig } from '../../../../core/full-suite-validation-config';
import { resolveDefaultReviewsPath } from '../../../gate-cli/gates-artifacts';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';
import type { RestartCoherentCycleCommandOptions, RestartReviewCycleCommandOptions } from './recovery-flow-types';
import { resolveOutputFiltersPath } from '../compile/output-budget-filter';

const PENDING_EVENT = 'REVIEW_CYCLE_VALIDATION_PENDING';
const MAXIMUM_CHECKPOINT_BYTES = 256 * 1024;
const MAXIMUM_BINDING_BYTES = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const REQUEST_FIELDS = ['allowPlanDrift', 'allowPlanDriftReason', 'taskModePath', 'preflightPath',
    'preflightOutputPath', 'changedFiles', 'includeUntracked', 'useStaged', 'taskIntent', 'impactAnalysis',
    'impactAnalysisPath', 'reviewType', 'reviewEvidenceOnly', 'commandsPath', 'outputFiltersPath', 'failTailLines'] as const;
const PATH_FIELDS = new Set(['taskModePath', 'preflightPath', 'preflightOutputPath', 'commandsPath',
    'outputFiltersPath', 'impactAnalysisPath']);

interface RecoveryCheckpointRecord {
    schema_version: 1;
    task_id: string;
    preflight_sha256: string;
    execution_identity_sha256: string;
    task_mode_path: string;
    task_mode_sha256: string;
    compile_path: string;
    compile_sha256: string;
    validation_review_type: string;
    previous_changed_files: string[];
    request: Record<string, unknown>;
    optional_skill_rebind_details: Record<string, unknown> | null;
    origin_artifacts: Array<{ path: string; sha256: string }>;
    suggested_command: string | null;
}

export interface ReviewValidationCheckpoint {
    record: RecoveryCheckpointRecord;
    artifactPath: string;
    artifactSha256: string;
    completedArtifactPath: string | null;
}

function relativePath(repoRoot: string, target: string): string {
    return path.relative(path.resolve(repoRoot), path.resolve(repoRoot, target)).replace(/\\/gu, '/');
}

function lastMatchingIndex<T>(entries: readonly T[], matches: (entry: T, index: number) => boolean): number {
    for (let index = entries.length - 1; index >= 0; index--) {
        if (matches(entries[index], index)) return index;
    }
    return -1;
}

function artifactHash(repoRoot: string, target: string): string {
    return readValidationFile(repoRoot, relativePath(repoRoot, target), MAXIMUM_BINDING_BYTES).identity.sha256;
}

function normalizedRequest(repoRoot: string, options: RestartReviewCycleCommandOptions): Record<string, unknown> {
    const entries = REQUEST_FIELDS.flatMap(key => {
        const value = options[key];
        return value === undefined ? [] : [[key, PATH_FIELDS.has(key) && typeof value === 'string'
            ? path.resolve(repoRoot, value) : value]];
    });
    return JSON.parse(JSON.stringify(Object.fromEntries(entries))) as Record<string, unknown>;
}

function parseCheckpoint(bytes: Buffer, taskId: string): RecoveryCheckpointRecord {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const keys = ['schema_version', 'task_id', 'preflight_sha256', 'execution_identity_sha256', 'task_mode_path',
        'task_mode_sha256', 'compile_path', 'compile_sha256', 'validation_review_type', 'previous_changed_files', 'request',
        'optional_skill_rebind_details', 'origin_artifacts', 'suggested_command'];
    if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')
        || value.schema_version !== 1 || value.task_id !== taskId
        || !['preflight_sha256', 'execution_identity_sha256', 'task_mode_sha256', 'compile_sha256']
            .every(key => typeof value[key] === 'string' && HASH.test(value[key]))
        || typeof value.task_mode_path !== 'string' || typeof value.compile_path !== 'string'
        || typeof value.validation_review_type !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(value.validation_review_type)
        || !Array.isArray(value.previous_changed_files) || value.previous_changed_files.some(file => typeof file !== 'string')
        || !isPlainRecord(value.request) || Object.keys(value.request).some(key => !REQUEST_FIELDS.includes(key as typeof REQUEST_FIELDS[number]))
        || (value.optional_skill_rebind_details !== null && !isPlainRecord(value.optional_skill_rebind_details))
        || !Array.isArray(value.origin_artifacts) || value.origin_artifacts.some(entry => !isPlainRecord(entry)
            || Object.keys(entry).sort().join(',') !== 'path,sha256' || typeof entry.path !== 'string'
            || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256))
        || (value.suggested_command !== null && typeof value.suggested_command !== 'string'))
        throw new Error('Invalid review-validation checkpoint schema or task binding.');
    return value as unknown as RecoveryCheckpointRecord;
}

function assertCurrentBindings(repoRoot: string, record: RecoveryCheckpointRecord,
    snapshot: ReturnType<typeof readValidationEventSnapshot>): void {
    if (snapshot.preflight_sha256 !== record.preflight_sha256
        || snapshot.execution_preflight_identity?.identity_sha256 !== record.execution_identity_sha256
        || artifactHash(repoRoot, record.task_mode_path) !== record.task_mode_sha256
        || artifactHash(repoRoot, record.compile_path) !== record.compile_sha256)
        throw new Error('Review-validation checkpoint is stale for the current task, worktree, source, policy or compile.');
}

type CheckpointHint = Record<string, unknown> & { event_type: string; details?: Record<string, unknown> };

function readCheckpointTimeline(repoRoot: string, taskId: string, timelinePath: string) {
    const timeline = readValidationFile(repoRoot, relativePath(repoRoot, timelinePath), MAXIMUM_BINDING_BYTES);
    try {
        const verified = readInvocationVerifiedTaskEventTimeline(timelinePath, taskId);
        const index = verified?.result.status === 'PASS' ? readInvocationVerifiedEventIndex(timelinePath, taskId) : null;
        if (verified?.result.status === 'PASS' && index && verified.sha256 === timeline.identity.sha256
            && readTaskTimelineValidationJsonLinesCompatible(timelinePath))
            return { identity: timeline.identity, index, events: index.events as readonly CheckpointHint[] };
    } catch { /* Optional borrowing must retain the original reader's errors and legacy behavior. */ }
    return { identity: timeline.identity, index: null, events: timeline.bytes.toString('utf8').split(/\r?\n/u).filter(Boolean)
        .map(line => JSON.parse(line) as CheckpointHint) };
}

export function readReviewValidationCheckpoint(repoRoot: string, taskId: string): ReviewValidationCheckpoint | null {
    assertValidTaskId(taskId);
    const timelinePath = path.join(resolveOrchestratorRoot(repoRoot), 'runtime/task-events', `${taskId}.jsonl`);
    const { events, index } = readCheckpointTimeline(repoRoot, taskId, timelinePath);
    const mode = index ? index.lastIndexByType.TASK_MODE_ENTERED ?? -1
        : events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED');
    const candidate = index ? index.lastIndexByType[PENDING_EVENT] ?? -1
        : lastMatchingIndex(events, (event, position) => position > mode && event.event_type === PENDING_EVENT);
    const pending = candidate > mode ? candidate : -1;
    if (pending < 0) return null;
    const priorCompletion = events.slice(pending + 1).some(event => event.event_type === 'REVIEW_CYCLE_RESTARTED'
        && event.details?.review_validation_checkpoint_sha256 === events[pending].details?.artifact_sha256);
    if (priorCompletion) {
        const preflight = getPreflightContext(resolveCurrentNoOpPreflightPath(repoRoot, taskId), taskId);
        const metrics = preflight.preflight.metrics as Record<string, unknown>;
        if (classifiedContentFingerprint(repoRoot, String(preflight.detection_source), preflight.changed_files as string[])
            !== metrics.scope_content_sha256) return null;
    }
    const snapshot = readImmutableValidationEventSnapshot(repoRoot, taskId);
    const modeIndex = snapshot.events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED');
    const pendingIndex = lastMatchingIndex(snapshot.events, (event, index) => index > modeIndex && event.event_type === PENDING_EVENT);
    if (pendingIndex < 0) return null;
    const details = snapshot.events[pendingIndex].details;
    const sha256 = details?.artifact_sha256;
    if (typeof sha256 !== 'string' || !HASH.test(sha256)) throw new Error('Missing native checkpoint artifact binding.');
    const expectedPath = resolveDefaultReviewsPath(repoRoot, `${taskId}-review-validation-checkpoint-${sha256}.json`);
    if (typeof details?.artifact_path !== 'string' || path.resolve(details.artifact_path) !== path.resolve(expectedPath))
        throw new Error('Review-validation checkpoint path differs from its native task-owned binding.');
    const retained = readValidationFile(repoRoot, relativePath(repoRoot, expectedPath), MAXIMUM_CHECKPOINT_BYTES);
    if (retained.identity.sha256 !== sha256) throw new Error('Review-validation checkpoint artifact hash changed.');
    const record = parseCheckpoint(retained.bytes, taskId);
    const completed = snapshot.events.slice(pendingIndex + 1).filter(event => event.event_type === 'REVIEW_CYCLE_RESTARTED'
        && event.details?.review_validation_checkpoint_sha256 === sha256).pop();
    if (completed && (snapshot.preflight_sha256 !== record.preflight_sha256
        || snapshot.execution_preflight_identity?.identity_sha256 !== record.execution_identity_sha256)) return null;
    const latestRestart = snapshot.events.slice(pendingIndex + 1)
        .filter(event => event.event_type === 'REVIEW_CYCLE_RESTARTED').pop();
    if (completed && latestRestart && latestRestart !== completed) {
        const latestPath = resolveDefaultReviewsPath(repoRoot, `${taskId}-review-cycle-restart.json`);
        if (path.resolve(String(latestRestart.details?.restart_artifact_path)) !== path.resolve(latestPath)
            || artifactHash(repoRoot, latestPath) !== latestRestart.details?.restart_artifact_sha256
            || latestRestart.details?.preflight_sha256 !== snapshot.preflight_sha256)
            throw new Error('Superseding review recovery has no intact current native restart artifact.');
        if (readImmutableValidationEventSnapshot(repoRoot, taskId).timeline_sha256 !== snapshot.timeline_sha256)
            throw new Error('Review recovery changed during supersession inspection.');
        return null;
    }
    assertCurrentBindings(repoRoot, record, snapshot);
    let completedArtifactPath: string | null = null;
    if (completed) {
        completedArtifactPath = resolveDefaultReviewsPath(repoRoot, `${taskId}-review-cycle-restart.json`);
        if (path.resolve(String(completed.details?.restart_artifact_path)) !== path.resolve(completedArtifactPath)
            || artifactHash(repoRoot, completedArtifactPath) !== completed.details?.restart_artifact_sha256)
            throw new Error('Completed review recovery has no intact native restart artifact.');
    } else {
        for (const artifact of record.origin_artifacts) {
            if (artifactHash(repoRoot, path.resolve(repoRoot, artifact.path)) !== artifact.sha256)
                throw new Error('Review-validation checkpoint remediation authority changed.');
        }
    }
    if (readImmutableValidationEventSnapshot(repoRoot, taskId).timeline_sha256 !== snapshot.timeline_sha256)
        throw new Error('Review-validation checkpoint timeline changed during inspection.');
    return { record, artifactPath: expectedPath, artifactSha256: sha256, completedArtifactPath };
}

export function restoreReviewRecoveryRequest(repoRoot: string, taskId: string,
    incoming: RestartReviewCycleCommandOptions, checkpoint: ReviewValidationCheckpoint): RestartReviewCycleCommandOptions {
    const merged = { ...checkpoint.record.request, ...normalizedRequest(repoRoot, incoming) };
    if (validationDigest(merged) !== validationDigest(checkpoint.record.request))
        throw new Error('Review-validation checkpoint request changed; it cannot resume a different recovery transition.');
    return { ...merged, repoRoot, taskId, emitMetrics: incoming.emitMetrics };
}

export function readReviewRecoveryValidation(repoRoot: string, taskId: string, reviewType?: string) {
    const snapshot = readValidationEventSnapshot(repoRoot, taskId);
    const preflight = JSON.parse(readValidationFile(repoRoot, relativePath(repoRoot, snapshot.preflight_path)).bytes.toString('utf8'));
    const analysis = readQualityValidationPhaseAnalysis({ repoRoot, taskId, preflight,
        preflightSha256: snapshot.preflight_sha256 });
    if (analysis.required && (analysis.status !== 'current'
        || (analysis.validation_phases && analysis.validation_phases.execution !== 'OBSERVED')))
        return { ready: false, reason: analysis.violations.join(' ') || 'Current native execution is still required.' };
    const requiredReviews = preflight.required_reviews as Record<string, boolean>;
    const evidence = buildFullSuiteValidationEvidence({ repoRoot, taskId,
        reviewType: reviewType || Object.keys(requiredReviews).find(key => requiredReviews[key]) || 'code',
        preflightPath: snapshot.preflight_path, preflightSha256: snapshot.preflight_sha256 });
    if (evidence?.required_for_review && (!evidence.available || !['PASSED', 'WARNED'].includes(evidence.status || '')
        || evidence.cycle_binding_valid !== true || evidence.violations.length > 0
        || evidence.command !== loadFullSuiteValidationConfig(repoRoot).command))
        return { ready: false, reason: evidence.violations.join(' ') || 'Current scoped full-suite validation is still required before this review.' };
    return { ready: true, reason: 'Current native validation prerequisites are observed.' };
}

function collectOriginArtifacts(repoRoot: string, taskId: string, reviewType: string) {
    return ['.md', '-receipt.json', '-findings-validation.json', '-findings-disposition.json', '-remediation-baseline.json']
        .flatMap(suffix => {
            const target = resolveDefaultReviewsPath(repoRoot, `${taskId}-${reviewType}${suffix}`);
            return fs.existsSync(target) ? [{ path: relativePath(repoRoot, target), sha256: artifactHash(repoRoot, target) }] : [];
        });
}

function readSuggestedTestCommand(repoRoot: string, taskId: string,
    snapshot: ReturnType<typeof readValidationEventSnapshot>): string | null {
    const modeIndex = snapshot.events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED');
    const cycle = snapshot.events.slice(modeIndex + 1);
    const quality = cycle.filter(event => event.event_type === 'QUALITY_CHECKLIST_RECORDED').pop()?.details;
    if (typeof quality?.artifact_path !== 'string' || typeof quality.artifact_hash !== 'string') return null;
    try {
        const retained = readValidationFile(repoRoot, relativePath(repoRoot, quality.artifact_path), MAXIMUM_BINDING_BYTES);
        if (retained.identity.sha256 !== quality.artifact_hash) return null;
        const artifact: unknown = JSON.parse(retained.bytes.toString('utf8'));
        if (!isPlainRecord(artifact) || artifact.task_id !== taskId || artifact.checklist_id !== QUALITY_CHECKLIST_ID
            || !isPlainRecord(artifact.validation_phases) || artifact.validation_phases.execution_kind !== 'task-command'
            || !Array.isArray(artifact.answers)) return null;
        const answer = artifact.answers.find(value => isPlainRecord(value) && value.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID);
        const assessment = assessBoundTrustBoundaryMatrix(answer?.trust_boundary_matrix, { repoRoot });
        const sources = assessment.source_evidence ?? [];
        if (assessment.structural_status !== 'BOUND' || assessment.violations.length || !sources.length) return null;
        for (const event of [...cycle].reverse()) {
            const details = event.details;
            const selection = details?.selected_case_selection;
            if (event.event_type !== 'INTERMEDIATE_COMMAND_STARTED' || details?.command_source !== 'targeted-test'
                || details.expected_failure === true || typeof details.command !== 'string'
                || !isIntermediateSelection(selection)) continue;
            if (sources.every(source => selectionMatchesCase(selection, source.source_identity.path, source.case_id)
                && selection.sources.some(identity => validationDigest(identity) === validationDigest(source.source_identity))))
                return details.command;
        }
    } catch {
        // An unavailable historical hint grants no authority; current validation still decides readiness.
    }
    return null;
}

export function publishReviewValidationCheckpoint(input: {
    repoRoot: string; taskId: string; taskModePath: string; options: RestartReviewCycleCommandOptions;
    previousChangedFiles: string[]; validationReviewType: string;
    optionalSkillRebindDetails: Record<string, unknown> | null;
}): ReviewValidationCheckpoint {
    const { repoRoot, taskId } = input;
    const snapshot = readValidationEventSnapshot(repoRoot, taskId);
    if (!snapshot.execution_preflight_identity) throw new Error('Pending review recovery requires native versioned execution identity.');
    const compilePath = resolveDefaultReviewsPath(repoRoot, `${taskId}-compile-gate.json`);
    const compile = JSON.parse(readValidationFile(repoRoot, relativePath(repoRoot, compilePath), MAXIMUM_CHECKPOINT_BYTES).bytes.toString('utf8'));
    if (compile.status !== 'PASSED' || compile.task_id !== taskId || compile.preflight_hash_sha256 !== snapshot.preflight_sha256
        || compile.scope_content_sha256 !== snapshot.scope_content_sha256)
        throw new Error('Pending review recovery requires current authenticated compile evidence.');
    const record: RecoveryCheckpointRecord = {
        schema_version: 1, task_id: taskId, preflight_sha256: snapshot.preflight_sha256,
        execution_identity_sha256: snapshot.execution_preflight_identity.identity_sha256,
        task_mode_path: path.resolve(input.taskModePath), task_mode_sha256: artifactHash(repoRoot, input.taskModePath),
        compile_path: compilePath, compile_sha256: artifactHash(repoRoot, compilePath),
        validation_review_type: input.validationReviewType,
        previous_changed_files: input.previousChangedFiles,
        request: normalizedRequest(repoRoot, input.options), optional_skill_rebind_details: input.optionalSkillRebindDetails,
        origin_artifacts: collectOriginArtifacts(repoRoot, taskId, String(input.options.reviewType || 'code')),
        suggested_command: readSuggestedTestCommand(repoRoot, taskId, snapshot)
    };
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    if (bytes.length > MAXIMUM_CHECKPOINT_BYTES) throw new Error('Review-validation checkpoint exceeds its byte bound.');
    const sha256 = validationDigest(bytes);
    const artifactPath = resolveDefaultReviewsPath(repoRoot, `${taskId}-review-validation-checkpoint-${sha256}.json`);
    if (fs.existsSync(artifactPath)) {
        if (artifactHash(repoRoot, artifactPath) !== sha256) throw new Error('Existing immutable checkpoint bytes changed.');
    } else writeContainedFile(repoRoot, artifactPath, bytes);
    assertCurrentBindings(repoRoot, record, snapshot);
    if (readValidationEventSnapshot(repoRoot, taskId).timeline_sha256 !== snapshot.timeline_sha256)
        throw new Error('Review recovery changed before checkpoint publication.');
    appendMandatoryTaskEvent(resolveOrchestratorRoot(repoRoot), taskId, PENDING_EVENT, 'INFO',
        'Review recovery prepared; current validation is pending, not restart completion.',
        { artifact_path: artifactPath, artifact_sha256: sha256 }, { actor: 'orchestrator' });
    return readReviewValidationCheckpoint(repoRoot, taskId)!;
}

export const COHERENT_RED_PENDING_EVENT = 'COHERENT_CYCLE_RED_PENDING';

interface CoherentRedCheckpointRecord {
    schema_version: 1;
    task_id: string;
    workspace_root: string;
    task_mode_path: string;
    task_mode_sha256: string;
    original_preflight_path: string;
    original_preflight_sha256: string;
    planned_changed_files: string[];
    request: Record<string, unknown>;
    origin_artifacts: Array<{ kind: 'commands' | 'output-filters'; path: string; sha256: string | null }>;
    optional_skill_rebind_details: Record<string, unknown>;
}

export interface CoherentRedCheckpoint {
    record: CoherentRedCheckpointRecord;
    artifactPath: string;
    artifactSha256: string;
    completedArtifactPath: string | null;
}

function parseCoherentRedCheckpoint(bytes: Buffer, taskId: string): CoherentRedCheckpointRecord {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const keys = ['schema_version', 'task_id', 'workspace_root', 'task_mode_path', 'task_mode_sha256',
        'original_preflight_path', 'original_preflight_sha256', 'planned_changed_files', 'request',
        'origin_artifacts', 'optional_skill_rebind_details'];
    if (!isPlainRecord(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')
        || value.schema_version !== 1 || value.task_id !== taskId
        || !['workspace_root', 'task_mode_path', 'original_preflight_path'].every(key => typeof value[key] === 'string')
        || !['task_mode_sha256', 'original_preflight_sha256'].every(key => typeof value[key] === 'string' && HASH.test(value[key]))
        || !Array.isArray(value.planned_changed_files) || value.planned_changed_files.some(file => typeof file !== 'string')
        || !isPlainRecord(value.request) || Object.keys(value.request).some(key => !REQUEST_FIELDS.includes(key as typeof REQUEST_FIELDS[number]))
        || !isPlainRecord(value.optional_skill_rebind_details)
        || !Array.isArray(value.origin_artifacts) || value.origin_artifacts.some(entry => !isPlainRecord(entry)
            || Object.keys(entry).sort().join(',') !== 'kind,path,sha256'
            || !['commands', 'output-filters'].includes(String(entry.kind)) || typeof entry.path !== 'string'
            || !(typeof entry.sha256 === 'string' && HASH.test(entry.sha256)
                || entry.kind === 'output-filters' && entry.sha256 === null))
        || value.origin_artifacts.filter(entry => entry.kind === 'output-filters').length !== 1
        || value.origin_artifacts.filter(entry => entry.kind === 'commands').length > 1)
        throw new Error('Invalid coherent RED checkpoint schema or task binding.');
    return value as unknown as CoherentRedCheckpointRecord;
}

function outputFiltersHash(repoRoot: string, target: string): string | null {
    const binding = bindContainedDestination(repoRoot, path.resolve(repoRoot, target));
    if (!binding.missingAt) return artifactHash(repoRoot, target);
    // Missing filter configuration is a supported passthrough source, not unbound authority.
    assertContainedDestination(binding);
    return null;
}

function coherentOriginMatches(repoRoot: string, artifact: CoherentRedCheckpointRecord['origin_artifacts'][number]): boolean {
    return (artifact.kind === 'output-filters' ? outputFiltersHash(repoRoot, artifact.path)
        : artifactHash(repoRoot, artifact.path)) === artifact.sha256;
}

/** A pending transition grants neither RED, implementation, compile nor review acceptance. */
export function readCoherentRedCheckpoint(repoRoot: string, taskId: string): CoherentRedCheckpoint | null {
    assertValidTaskId(taskId);
    const timelinePath = path.join(resolveOrchestratorRoot(repoRoot), 'runtime/task-events', `${taskId}.jsonl`);
    if (!fs.existsSync(timelinePath)) return null; // Absence grants no checkpoint authority; normal startup gates still apply.
    const timeline = readCheckpointTimeline(repoRoot, taskId, timelinePath);
    const hints = timeline.events;
    const modeIndex = timeline.index ? timeline.index.lastIndexByType.TASK_MODE_ENTERED ?? -1
        : hints.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED');
    const candidate = timeline.index?.lastIndexByType[COHERENT_RED_PENDING_EVENT] ?? -1;
    const pending = timeline.index ? (candidate > modeIndex ? hints[candidate] : undefined)
        : hints.slice(modeIndex + 1).filter(event => event.event_type === COHERENT_RED_PENDING_EVENT).at(-1);
    if (!pending) return null;
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspectTaskEventFile(timelinePath, taskId).status))
        throw new Error('Coherent RED checkpoint timeline integrity failed.');
    const sha256 = pending.details?.artifact_sha256;
    if (typeof sha256 !== 'string' || !HASH.test(sha256)) throw new Error('Missing coherent RED checkpoint native binding.');
    const artifactPath = resolveDefaultReviewsPath(repoRoot, `${taskId}-coherent-red-checkpoint-${sha256}.json`);
    if (typeof pending.details?.artifact_path !== 'string' || path.resolve(pending.details.artifact_path) !== path.resolve(artifactPath))
        throw new Error('Coherent RED checkpoint path differs from its native binding.');
    const retained = readValidationFile(repoRoot, relativePath(repoRoot, artifactPath), MAXIMUM_CHECKPOINT_BYTES);
    if (retained.identity.sha256 !== sha256) throw new Error('Coherent RED checkpoint bytes changed.');
    const record = parseCoherentRedCheckpoint(retained.bytes, taskId);
    if (record.workspace_root !== fs.realpathSync(repoRoot)
        || artifactHash(repoRoot, record.task_mode_path) !== record.task_mode_sha256)
        throw new Error('Coherent RED checkpoint workspace or task mode changed.');
    for (const artifact of record.origin_artifacts) {
        if (!coherentOriginMatches(repoRoot, artifact))
            throw new Error('Coherent RED checkpoint command or output-filter binding changed.');
    }
    const completed = hints.slice(hints.indexOf(pending) + 1).filter(event =>
        event.event_type === 'COHERENT_CYCLE_RESTARTED' && event.details?.coherent_red_checkpoint_sha256 === sha256).at(-1);
    let completedArtifactPath: string | null = null;
    if (completed) {
        completedArtifactPath = resolveDefaultReviewsPath(repoRoot, `${taskId}-coherent-cycle-restart.json`);
        if (path.resolve(String(completed.details?.restart_artifact_path)) !== path.resolve(completedArtifactPath)
            || artifactHash(repoRoot, completedArtifactPath) !== completed.details?.restart_artifact_sha256)
            throw new Error('Coherent RED recovery completion has no intact native artifact.');
        // Retiring completed state grants no execution readiness. Authenticate its artifacts and
        // the current classification before inspecting source drift; a new entry owns new validation.
        const preflightPath = resolveCurrentNoOpPreflightPath(repoRoot, taskId);
        const preflight = getPreflightContext(preflightPath, taskId);
        const preflightSha256 = artifactHash(repoRoot, preflightPath);
        const classification = hints.slice(modeIndex + 1).filter(event => event.event_type === 'PREFLIGHT_CLASSIFIED').at(-1);
        const binding = classification?.details?.intermediate_execution_preflight;
        if (!isPlainRecord(binding) || binding.schema_version !== 1
            || Object.keys(binding).sort().join(',') !== 'preflight_sha256,schema_version,semantic_sha256'
            || binding.preflight_sha256 !== preflightSha256
            || binding.semantic_sha256 !== getIntermediatePreflightSemanticSha256(preflight.preflight)
            || path.resolve(preflightPath) !== path.resolve(record.original_preflight_path))
            throw new Error('Completed coherent RED checkpoint requires an intact current native preflight binding.');
        const metrics = preflight.preflight.metrics as Record<string, unknown>;
        if (completed.details?.preflight_sha256 !== preflightSha256
            || classifiedContentFingerprint(repoRoot, String(preflight.detection_source), preflight.changed_files as string[])
                !== metrics.scope_content_sha256) {
            if (artifactHash(repoRoot, timelinePath) !== timeline.identity.sha256
                || artifactHash(repoRoot, preflightPath) !== preflightSha256
                || artifactHash(repoRoot, artifactPath) !== sha256
                || artifactHash(repoRoot, completedArtifactPath) !== completed.details?.restart_artifact_sha256
                || artifactHash(repoRoot, record.task_mode_path) !== record.task_mode_sha256
                || record.origin_artifacts.some(artifact => !coherentOriginMatches(repoRoot, artifact)))
                throw new Error('Coherent RED recovery changed during completed checkpoint retirement.');
            return null;
        }
    }
    const snapshot = readImmutableValidationEventSnapshot(repoRoot, taskId);
    if (path.resolve(snapshot.preflight_path) !== path.resolve(record.original_preflight_path)
        || snapshot.changed_files.some(file => !record.planned_changed_files.includes(file)))
        throw new Error('Coherent RED checkpoint preflight or authorized scope changed.');
    if (snapshot.timeline_sha256 !== timeline.identity.sha256
        || readImmutableValidationEventSnapshot(repoRoot, taskId).timeline_sha256 !== snapshot.timeline_sha256)
        throw new Error('Coherent RED recovery changed during checkpoint inspection.');
    return { record, artifactPath, artifactSha256: sha256, completedArtifactPath };
}

export function publishCoherentRedCheckpoint(input: {
    repoRoot: string; taskId: string; taskModePath: string; plannedChangedFiles: string[];
    options: RestartCoherentCycleCommandOptions; optionalSkillRebindDetails: Record<string, unknown>;
}): CoherentRedCheckpoint {
    const { repoRoot, taskId } = input;
    const snapshot = readValidationEventSnapshot(repoRoot, taskId);
    const request = normalizedRequest(repoRoot, input.options);
    const originArtifacts: CoherentRedCheckpointRecord['origin_artifacts'] = [];
    if (typeof request.commandsPath === 'string') originArtifacts.push({ kind: 'commands', path: request.commandsPath,
        sha256: artifactHash(repoRoot, request.commandsPath) });
    const outputFiltersPath = resolveOutputFiltersPath(repoRoot,
        typeof request.outputFiltersPath === 'string' ? request.outputFiltersPath : '');
    originArtifacts.push({ kind: 'output-filters', path: outputFiltersPath, sha256: outputFiltersHash(repoRoot, outputFiltersPath) });
    const record: CoherentRedCheckpointRecord = {
        schema_version: 1, task_id: taskId, workspace_root: fs.realpathSync(repoRoot),
        task_mode_path: path.resolve(input.taskModePath), task_mode_sha256: artifactHash(repoRoot, input.taskModePath),
        original_preflight_path: snapshot.preflight_path, original_preflight_sha256: snapshot.preflight_sha256,
        planned_changed_files: [...new Set(input.plannedChangedFiles)].sort(), request,
        origin_artifacts: originArtifacts, optional_skill_rebind_details: input.optionalSkillRebindDetails
    };
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    if (bytes.length > MAXIMUM_CHECKPOINT_BYTES) throw new Error('Coherent RED checkpoint exceeds its byte bound.');
    const sha256 = validationDigest(bytes);
    const artifactPath = resolveDefaultReviewsPath(repoRoot, `${taskId}-coherent-red-checkpoint-${sha256}.json`);
    if (fs.existsSync(artifactPath)) {
        if (artifactHash(repoRoot, artifactPath) !== sha256) throw new Error('Immutable coherent RED checkpoint changed.');
    } else writeContainedFile(repoRoot, artifactPath, bytes);
    if (readValidationEventSnapshot(repoRoot, taskId).timeline_sha256 !== snapshot.timeline_sha256)
        throw new Error('Coherent recovery changed before pending publication.');
    appendMandatoryTaskEvent(resolveOrchestratorRoot(repoRoot), taskId, COHERENT_RED_PENDING_EVENT, 'INFO',
        'Coherent recovery awaits genuine current RED before implementation or compile.',
        { artifact_path: artifactPath, artifact_sha256: sha256 }, { actor: 'orchestrator' });
    return readCoherentRedCheckpoint(repoRoot, taskId)!;
}

export function assertCoherentRecoveryRequest(repoRoot: string, options: RestartCoherentCycleCommandOptions,
    checkpoint: CoherentRedCheckpoint): void {
    if (validationDigest({ ...checkpoint.record.request, ...normalizedRequest(repoRoot, options) })
        !== validationDigest(checkpoint.record.request))
        throw new Error('Coherent RED checkpoint cannot resume a changed recovery request.');
}

interface CoherentRedCompletionReadiness {
    ready: boolean;
    reason: string;
    compileRequired?: { outputFiltersPath: string };
}

export function readCoherentRedCompletionReadiness(repoRoot: string, taskId: string,
    checkpoint: CoherentRedCheckpoint): CoherentRedCompletionReadiness {
    const snapshot = readValidationEventSnapshot(repoRoot, taskId);
    const mode = snapshot.events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED');
    const current = snapshot.events.slice(mode + 1);
    const requiresRed = taskRequiresExpectedRed(repoRoot, taskId);
    const preflight = JSON.parse(readValidationFile(repoRoot, relativePath(repoRoot, snapshot.preflight_path)).bytes.toString('utf8'));
    if (requiresRed) {
        try {
            const preparation = readExpectedRedPreparation({ repoRoot, taskId, preflightPath: snapshot.preflight_path,
                preflightSha256: snapshot.preflight_sha256 });
            const reds = preparation?.obligations.filter(item => item.case_execution?.expected_failure) ?? [];
            const implementation = current.find(event => event.event_type === 'IMPLEMENTATION_STARTED');
            if (!reds.length || implementation && reds.some(red => !red.case_execution
                || red.case_execution.event_task_sequence >= Number(implementation.integrity?.task_sequence)))
                return { ready: false, reason: 'Genuine current RED must precede implementation and compile.' };
        } catch (error) { return { ready: false, reason: String(error) }; }
    }
    const filters = checkpoint.record.origin_artifacts.find(artifact => artifact.kind === 'output-filters');
    if (!filters || !coherentOriginMatches(repoRoot, filters))
        throw new Error('Coherent RED recovery has no intact retained output-filter source.');
    const compileRequired = { outputFiltersPath: filters.path };
    let canSuggestCompile = !requiresRed || preflight.scope_category !== 'test-only';
    if (!canSuggestCompile) {
        try {
            const analysis = readQualityValidationPhaseAnalysis({ repoRoot, taskId, preflight,
                preflightSha256: snapshot.preflight_sha256 });
            canSuggestCompile = readExpectedRedReviewObligations({ repoRoot, taskId,
                preflightPath: snapshot.preflight_path, preflightSha256: snapshot.preflight_sha256 },
            analysis.validation_phases?.obligations ?? []).some(item => item.case_execution?.expected_failure);
        } catch { /* Advice cannot preempt the normal test-only implementation route before GREEN. */ }
    }
    const compileAdvice = canSuggestCompile ? { compileRequired } : {};
    const compiled = current.filter(event => ['COMPILE_GATE_PASSED', 'COMPILE_GATE_FAILED'].includes(event.event_type)).at(-1);
    const compilePath = resolveDefaultReviewsPath(repoRoot, `${taskId}-compile-gate.json`);
    if (compiled?.event_type !== 'COMPILE_GATE_PASSED' || compiled.details?.status !== 'PASSED'
        || Number(compiled.integrity?.task_sequence) <= snapshot.preflight_sequence
        || compiled.details?.preflight_hash_sha256 !== snapshot.preflight_sha256
        || compiled.details?.scope_content_sha256 !== snapshot.scope_content_sha256
        || path.resolve(String(compiled.details?.evidence_path)) !== path.resolve(compilePath))
        return { ready: false, reason: 'Current native compile must follow genuine current RED and implementation.' };
    const compile = JSON.parse(readValidationFile(repoRoot, relativePath(repoRoot, compilePath), MAXIMUM_BINDING_BYTES).bytes.toString('utf8'));
    if (compile.status !== 'PASSED' || compile.task_id !== taskId || compile.preflight_hash_sha256 !== snapshot.preflight_sha256
        || compile.scope_content_sha256 !== snapshot.scope_content_sha256
        || validationDigest(compile.compile_commands) !== validationDigest(compiled.details?.compile_commands))
        throw new Error('Coherent RED recovery compile artifact differs from its current native event.');
    for (const key of ['commands_path', 'workflow_config_path', 'compile_command_source', 'output_filters_path']) {
        if (validationDigest(compile[key] ?? null) !== validationDigest(compiled.details?.[key] ?? null))
            throw new Error('Coherent RED recovery compile artifact differs from its current native event.');
    }
    if (compile.compile_command_source !== 'workflow_config' || typeof compile.output_filters_path !== 'string')
        throw new Error('Coherent RED recovery requires native workflow-config compile authority and output-filter identity.');
    if (path.resolve(repoRoot, compile.output_filters_path) !== path.resolve(repoRoot, filters.path))
        return { ready: false, reason: 'Current native compile used a different output-filter source than the retained request.', ...compileAdvice };
    if (!requiresRed) {
        if (readValidationEventSnapshot(repoRoot, taskId).timeline_sha256 !== snapshot.timeline_sha256)
            throw new Error('Coherent recovery changed during ordinary completion inspection.');
        return { ready: true, reason: 'Current compile is observed after the operator-selected ordinary lifecycle; all remaining gates still apply.' };
    }
    const analysis = readQualityValidationPhaseAnalysis({ repoRoot, taskId, preflight, preflightSha256: snapshot.preflight_sha256 });
    try {
        const obligations = readExpectedRedReviewObligations({ repoRoot, taskId, preflightPath: snapshot.preflight_path,
            preflightSha256: snapshot.preflight_sha256 }, analysis.validation_phases?.obligations ?? []);
        const reds = obligations.filter(obligation => obligation.case_execution?.expected_failure);
        const firstImplementation = current.find(event => event.event_type === 'IMPLEMENTATION_STARTED');
        if (!reds.length || !firstImplementation || reds.some(red => !red.case_execution
            || red.case_execution.event_task_sequence >= Number(firstImplementation.integrity?.task_sequence)))
            return { ready: false, reason: 'Genuine current RED must precede implementation and compile.' };
    } catch (error) {
        return { ready: false, reason: String(error) };
    }
    if (readValidationEventSnapshot(repoRoot, taskId).timeline_sha256 !== snapshot.timeline_sha256)
        throw new Error('Coherent RED evidence changed during completion inspection.');
    return { ready: true, reason: 'Genuine current RED precedes implementation, with current compile and later GREEN observed.' };
}
