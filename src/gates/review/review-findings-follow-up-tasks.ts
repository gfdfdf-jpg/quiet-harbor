import { withRecoverableFileTransaction, type RecoverableFileTransaction } from '../../core/recoverable-file-transaction';
import { GROUPED_COMPLETION_QUEUE_STATUS, readFreshGroupedCompletion } from '../completion/grouped-completion-evidence';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { getCompletionGateFinalizationLockPath } from '../locks/finalization-lock';
import {
    checkGroupedPublicationRegistry, groupedPublicationMatchesQueue, groupedQueueHasUnambiguousRows,
    isGroupedChildIdCandidate, isParentFollowUpTaskId, readGroupedCompletionForCloseout,
    GROUPED_PUBLICATION_EVENT,
    REVIEW_FOLLOW_UP_LANES_RECOVERED_EVENT_TYPE, type GroupedPublication
} from './review-follow-up-lineage';
import { hasAuthenticatedIntermediateGroupedReceiptSource } from './review-grouped-receipt-source';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { writeTaskQueueFile } from '../../core/task-queue/task-queue-repository';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget
} from '../../core/constants';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import { isPlainRecord } from '../../core/records';
import {
    assertCanonicalTaskId,
    buildExactTaskIdReferencePattern,
    isCanonicalTaskId,
    isReviewFindingsFollowUpTaskId
} from '../../core/task-ids';
import {
    buildLegacyReviewFollowUpTaskClosurePolicySnapshot,
    getReviewFollowUpTaskClosurePolicySnapshotViolations,
    type ReviewFollowUpTaskClosurePolicySnapshot
} from '../../core/review-follow-up-task-closure-policy';
import { resolveCompiledReviewDependencyGraphFromPreflight } from '../../core/review-dependency-graph';
import { allocateParentDerivedTaskIds } from '../../core/task-id-allocation';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell,
    type CanonicalActiveTaskQueueRow
} from '../../core/task-md-table';
import {
    withTaskQueueStatusSyncLock
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import { buildOperatorNextActionBlock } from '../shared/operator-action-output';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    discoverGroupedFollowUpArtifactPaths,
    extractParentFollowUpArtifactPaths,
    publishedFollowUpArtifactMatchesCurrentTaskQueue,
    readReviewArtifactState,
    resolveRetainedGroupedObligations,
    type PriorGroupedPublication,
    type RetainedReviewReference,
    resolveAuthenticatedReviewFollowUpSources,
    resolveAuthenticatedReviewReceiptSnapshot,
    resolveFollowUpArtifactPath as resolveReviewFollowUpEvidencePath,
    type CurrentReviewFollowUpMaterializationBinding
} from '../next-step/next-step-review-artifact-readers';
import { normalizeReviewReceiptEvidenceFields } from './review-evidence-contract';
import { reviewStateHasSatisfiedEvidence } from '../next-step/next-step-review-evidence';
import { readCurrentCompileGateEvidence } from '../review-context/review-context-validation-evidence';
import {
    REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION,
    REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE,
    type ReviewFindingsDispositionArtifact,
    type ReviewFindingsDispositionArtifactItem
} from './review-findings-disposition-artifact';
import {
    validateReviewFindingsValidationArtifact,
    validateReviewFindingsValidationArtifactForReceipt,
    type NormalizedReviewFindingInventoryEntry,
    type NormalizedReviewResidualRiskInventoryEntry,
    type ReviewFindingsValidationArtifact
} from './review-findings-validation-artifact';
import type { ReviewFollowUpMaterializationMode } from '../../policy/profile-resolver';
import { parseOperatorConfirmationYes, validateFreshOperatorConfirmation } from '../../core/operator-confirmation';
import { appendMandatoryTaskEvent } from '../../gate-runtime/task-events';
import {
    buildReviewFollowUpAttemptInputSha256,
    buildReviewFollowUpBlockedAttemptRecord,
    getReviewFollowUpBlockedAttemptPath,
    type ReviewFollowUpAttemptBindingInput
} from './review-follow-up-attempt-binding';
export const REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE = 'review_findings_follow_up_tasks';
export const REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION = 1;

const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const EVIDENCE_ONLY_FINDING_ID = 'F-000';
const REVIEW_TYPE_TOKEN_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const REVIEW_TYPE_MAX_LENGTH = 64;
const MATERIALIZED_PARENT_NOTE_SUFFIX_PATTERN =
    /(?:\s+Review follow-up tasks materialized: `[^`\r\n]+`(?:, `[^`\r\n]+`)*; artifact `[^`\r\n]+`\.)+$/u;

type ReviewFollowUpMaterializationStatus =
    | 'MATERIALIZED'
    | 'ALREADY_MATERIALIZED'
    | 'NOT_REQUIRED'
    | 'BLOCKED';

type ReviewFindingFollowUpItemStatus =
    | 'created'
    | 'already_materialized'
    | 'not_required'
    | 'requires_fix_now'
    | 'blocked';

type SourceInventoryEntry =
    | {
        kind: 'finding';
        finding: NormalizedReviewFindingInventoryEntry;
    }
    | {
        kind: 'residual_risk';
        residual_risk: NormalizedReviewResidualRiskInventoryEntry;
    };

interface SourceInventoryIndex {
    findings: Map<string, NormalizedReviewFindingInventoryEntry>;
    residual_risks: Map<string, NormalizedReviewResidualRiskInventoryEntry>;
}

type ReviewFindingSeverity = typeof REVIEW_FINDING_SEVERITIES[number];

export type GroupedAdmissionRefusalCode = 'current_registry' | 'reuse_ambiguous' | 'reuse_bindings' | 'confirmed_lane';

interface FollowUpObligation {
    disposition_item: ReviewFindingsDispositionArtifactItem;
    source_inventory: SourceInventoryEntry;
    title: string;
    description: string;
    evidence_locations: string[];
    remediation: string;
    fingerprint: string;
}

export interface FollowUpMaterializationContext {
    mode: ReviewFollowUpMaterializationMode;
    parent_profile: string | null;
    task_profile: string | null;
    task_profile_source: string;
    snapshot_hash: string | null;
    cycle_id: string | null;
    preflight_sha256: string | null;
    compile_gate_timestamp: string | null;
    group_fingerprint: string | null;
    review_follow_up_task_closure_policy: ReviewFollowUpTaskClosurePolicySnapshot;
    review_follow_up_task_closure_policy_source: 'preflight_profile_policy_snapshot' | 'legacy_default';
    diagnostics: string[];
}

interface MaterializedTaskReference {
    task_id: string;
    fingerprint: string;
}

interface TaskQueueMaterializationResult {
    outcome:
        | 'updated'
        | 'already_materialized'
        | 'not_required'
        | 'task_file_missing'
        | 'task_not_found'
        | 'write_failed';
    task_path: string;
    created: MaterializedTaskReference[];
    reused: MaterializedTaskReference[];
    blocked_fingerprints: string[];
    error_message: string | null;
    rollback_content: string | null;
    previous_publication?: GroupedPublication;
    prerequisite_failed?: boolean;
    // Set only for grouped-row registry and reuse admission refusals, which repeat
    // on unchanged inputs. Every other refusal and every failure leaves it unset.
    admission_refusal_code?: GroupedAdmissionRefusalCode;
}

export interface ReviewFindingsFollowUpTaskMaterializationItem {
    source_item_id: string;
    source_item_kind: ReviewFindingsDispositionArtifactItem['kind'];
    severity: ReviewFindingsDispositionArtifactItem['severity'];
    action: ReviewFindingsDispositionArtifactItem['action'];
    source_rule: string;
    source_policy: string;
    blocking: boolean;
    fingerprint: string | null;
    materialization_status: ReviewFindingFollowUpItemStatus;
    task_id: string | null;
    title: string | null;
    description: string | null;
    evidence_locations: string[];
    remediation: string | null;
}

export interface ReviewFindingsFollowUpTasksArtifact {
    schema_version: typeof REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION;
    artifact_type: typeof REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE;
    task_id: string;
    review_type: string;
    status: ReviewFollowUpMaterializationStatus;
    created_at_utc: string;
    materialization_policy: FollowUpMaterializationContext;
    source_disposition: {
        artifact_path: string;
        artifact_sha256: string | null;
        disposition_result_sha256: string | null;
    };
    source_validation: {
        artifact_path: string | null;
        artifact_sha256: string | null;
        validation_result_sha256: string | null;
        status: 'accepted' | 'rejected' | 'unknown';
        accepted: boolean | null;
    };
    source_receipt: {
        receipt_path: string | null;
        receipt_sha256: string | null;
    };
    retained_reviews?: RetainedReviewReference[];
    items: ReviewFindingsFollowUpTaskMaterializationItem[];
    summary: {
        item_count: number;
        follow_up_obligation_count: number;
        created_task_count: number;
        reused_task_count: number;
        blocked_task_count: number;
        not_required_count: number;
    };
    violations: string[];
}

export interface ReviewFindingsFollowUpTaskMaterializationResult {
    prerequisite_failed?: boolean;
    status: ReviewFollowUpMaterializationStatus;
    task_id: string;
    review_type: string;
    artifact_path: string;
    created_task_ids: string[];
    reused_task_ids: string[];
    violations: string[];
    output_lines: string[];
    // Set on BLOCKED results refused by grouped-row registry or reuse admission.
    admission_refusal_code?: GroupedAdmissionRefusalCode;
}

export interface MaterializeReviewFindingsFollowUpTasksOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    dispositionArtifactPath?: string | null;
    receiptPath?: string | null;
    artifactPath?: string | null;
    reviewsRoot?: string | null;
}

function nowIso(): string {
    return new Date().toISOString();
}

function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
}

function sha256TextPayload(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').toLowerCase();
}

function normalizeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function resolveParentTaskProfile(repoRoot: string, taskId: string): string | null {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }
    const parsed = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8'));
    return parsed.rows.find((row) => row.taskId === taskId)?.profile?.trim().toLowerCase() || null;
}

function resolveFollowUpTaskProfileContext(
    parentProfile: string | null,
    snapshot: Record<string, unknown> | null
): Pick<FollowUpMaterializationContext, 'parent_profile' | 'task_profile' | 'task_profile_source' | 'diagnostics'> {
    const assignment = snapshot && isPlainRecord(snapshot.review_follow_up_task_profile_assignment)
        ? snapshot.review_follow_up_task_profile_assignment
        : null;
    const assignedParent = assignment ? normalizeText(assignment.parent_profile).toLowerCase() : '';
    const assignedProfile = assignment ? normalizeText(assignment.profile).toLowerCase() : '';
    const source = assignment ? normalizeText(assignment.source).toLowerCase() : '';
    if (
        assignedParent
        && assignedProfile
        && ['one_level_lighter', 'inherit_parent', 'fixed_profile', 'safe_inherit_parent'].includes(source)
    ) {
        return {
            parent_profile: assignedParent,
            task_profile: assignedProfile,
            task_profile_source: source,
            diagnostics: parentProfile && parentProfile !== assignedParent
                ? [
                    `Current TASK.md parent profile '${parentProfile}' differs from frozen profile '${assignedParent}'; ` +
                    `follow-up profile remains frozen as '${assignedProfile}'.`
                ]
                : []
        };
    }
    return {
        parent_profile: parentProfile,
        task_profile: parentProfile,
        task_profile_source: 'legacy_safe_inherit_parent',
        diagnostics: [
            'Legacy or missing follow-up task profile assignment inherited the parent TASK.md profile.'
        ]
    };
}

function resolveFollowUpMaterializationContext(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string
): FollowUpMaterializationContext {
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const parentProfile = resolveParentTaskProfile(repoRoot, taskId);
    const initialTaskProfileContext = resolveFollowUpTaskProfileContext(parentProfile, null);
    const legacyClosurePolicy = buildLegacyReviewFollowUpTaskClosurePolicySnapshot();
    const fallback: FollowUpMaterializationContext = {
        mode: 'per_finding',
        ...initialTaskProfileContext,
        snapshot_hash: null,
        cycle_id: null,
        preflight_sha256: null,
        compile_gate_timestamp: null,
        group_fingerprint: null,
        review_follow_up_task_closure_policy: legacyClosurePolicy,
        review_follow_up_task_closure_policy_source: 'legacy_default',
        diagnostics: [
            ...initialTaskProfileContext.diagnostics,
            'Legacy or missing profile snapshot review_follow_up_policy defaulted to per_finding.'
        ]
    };
    const read = readJsonFile(preflightPath, 'Preflight artifact');
    const snapshot = read.value && isPlainRecord(read.value.profile_policy_snapshot)
        ? read.value.profile_policy_snapshot
        : null;
    const taskProfileContext = resolveFollowUpTaskProfileContext(parentProfile, snapshot);
    const closurePolicyValue = snapshot?.review_follow_up_task_closure_policy;
    const closurePolicyViolations = getReviewFollowUpTaskClosurePolicySnapshotViolations(closurePolicyValue);
    const closurePolicy = closurePolicyViolations.length === 0
        ? {
            ...(closurePolicyValue as unknown as ReviewFollowUpTaskClosurePolicySnapshot),
            diagnostics: [
                ...(closurePolicyValue as unknown as ReviewFollowUpTaskClosurePolicySnapshot).diagnostics
            ]
        }
        : legacyClosurePolicy;
    const closurePolicySource = closurePolicyViolations.length === 0
        ? 'preflight_profile_policy_snapshot' as const
        : 'legacy_default' as const;
    const closurePolicyDiagnostics = closurePolicyViolations.length === 0
        ? []
        : [
            'Preflight closure-policy snapshot is missing or invalid; descendant materialization uses legacy fail-closed defaults.'
        ];
    const policy = snapshot && isPlainRecord(snapshot.review_follow_up_policy)
        ? snapshot.review_follow_up_policy
        : null;
    const mode = policy?.schema_version === 1
        && (policy.materialization_mode === 'per_finding' || policy.materialization_mode === 'grouped_by_parent')
        ? policy.materialization_mode
        : null;
    if (!mode) {
        return {
            ...fallback,
            review_follow_up_task_closure_policy: closurePolicy,
            review_follow_up_task_closure_policy_source: closurePolicySource,
            diagnostics: [
                ...taskProfileContext.diagnostics,
                ...closurePolicyDiagnostics,
                'Legacy or missing profile snapshot review_follow_up_policy defaulted to per_finding.'
            ]
        };
    }
    const snapshotHash = normalizeHash(snapshot?.snapshot_hash);
    const compileGatePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    const compileRead = readJsonFile(compileGatePath, 'Compile gate artifact');
    const compileGate = compileRead.value && isPlainRecord(compileRead.value)
        ? compileRead.value
        : null;
    const compileGateEvidence = readCurrentCompileGateEvidence(repoRoot, taskId);
    const canonicalCompileTimestamp = compileGateEvidence.timeline_timestamp_utc
        || compileGateEvidence.artifact_timestamp_utc;
    const compileTimestamp = compileGate?.status === 'PASSED'
        && normalizeText(compileGate.task_id) === taskId
        ? normalizeText(canonicalCompileTimestamp)
        : '';
    const compilePreflightSha256 = normalizeHash(compileGate?.preflight_hash_sha256);
    const currentPreflightSha256 = fs.existsSync(preflightPath) ? fileSha256(preflightPath) : null;
    const cycleId = compileTimestamp
        && compilePreflightSha256
        && compilePreflightSha256 === currentPreflightSha256
        ? sha256JsonPayload({
            schema_version: 1,
            preflight_sha256: compilePreflightSha256,
            compile_gate_timestamp: compileTimestamp
        })
        : null;
    if (mode === 'grouped_by_parent' && (!snapshotHash || !cycleId)) {
        return {
            mode,
            ...taskProfileContext,
            snapshot_hash: snapshotHash,
            cycle_id: null,
            preflight_sha256: compilePreflightSha256,
            compile_gate_timestamp: compileTimestamp || null,
            group_fingerprint: null,
            review_follow_up_task_closure_policy: closurePolicy,
            review_follow_up_task_closure_policy_source: closurePolicySource,
            diagnostics: [
                ...taskProfileContext.diagnostics,
                ...closurePolicyDiagnostics,
                'Grouped follow-up policy requires snapshot_hash and a current preflight-bound compile cycle; materialization is blocked.'
            ]
        };
    }
    return {
        mode,
        ...taskProfileContext,
        snapshot_hash: snapshotHash,
        cycle_id: cycleId,
        preflight_sha256: compilePreflightSha256,
        compile_gate_timestamp: compileTimestamp || null,
        group_fingerprint: mode === 'grouped_by_parent'
            ? sha256JsonPayload({
                schema_version: 1,
                parent_task_id: taskId,
                snapshot_hash: snapshotHash,
                cycle_id: cycleId,
                materialization_mode: mode
            })
            : null,
        review_follow_up_task_closure_policy: closurePolicy,
        review_follow_up_task_closure_policy_source: closurePolicySource,
        diagnostics: [
            ...taskProfileContext.diagnostics,
            ...closurePolicyDiagnostics
        ]
    };
}

function normalizeText(value: unknown): string {
    return String(value || '').trim();
}

function assertReviewTypeToken(value: unknown): string {
    const reviewType = normalizeText(value).toLowerCase();
    if (!reviewType) {
        throw new Error('ReviewType must not be empty.');
    }
    if (reviewType.length > REVIEW_TYPE_MAX_LENGTH) {
        throw new Error(`ReviewType must be ${REVIEW_TYPE_MAX_LENGTH} characters or fewer.`);
    }
    if (!REVIEW_TYPE_TOKEN_PATTERN.test(reviewType)) {
        throw new Error('ReviewType must be a file-safe token matching <letter>[a-z0-9_-]*.');
    }
    return reviewType;
}

function isReviewTypeToken(value: unknown): boolean {
    try {
        assertReviewTypeToken(value);
        return true;
    } catch {
        return false;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readJsonFile(filePath: string, label: string): { value: Record<string, unknown> | null; violations: string[] } {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return {
            value: null,
            violations: [`${label} is missing: ${normalizePath(filePath)}.`]
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            return {
                value: null,
                violations: [`${label} must contain a JSON object: ${normalizePath(filePath)}.`]
            };
        }
        return { value: parsed, violations: [] };
    } catch {
        return {
            value: null,
            violations: [`${label} is not valid JSON: ${normalizePath(filePath)}.`]
        };
    }
}

function resolveInputPathInsideRepo(repoRoot: string, inputPath: string, label: string): string {
    const rawPath = String(inputPath || '').trim();
    if (!rawPath) {
        throw new Error(`${label} must not be empty.`);
    }
    const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(repoRoot, rawPath);
    const root = path.resolve(repoRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`${label} escapes repo root: ${inputPath}`);
    }
    return resolved;
}

function resolveFollowUpArtifactPath(repoRoot: string, reviewsRoot: string, inputPath: string): string {
    const resolved = resolveInputPathInsideRepo(repoRoot, inputPath, 'ArtifactPath');
    const root = path.resolve(reviewsRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`ArtifactPath must stay inside reviews root: ${inputPath}`);
    }
    if (!path.basename(resolved).endsWith('-follow-ups.json')) {
        throw new Error('ArtifactPath must be a follow-up JSON artifact path ending in -follow-ups.json.');
    }
    return resolved;
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

function buildNextStepCommand(repoRoot: string, taskId: string): string {
    return `${buildCliPrefix(repoRoot)} next-step "${taskId}" --repo-root "."`;
}

function formatOutput(params: {
    repoRoot: string;
    taskId: string;
    status: ReviewFollowUpMaterializationStatus;
    marker: string;
    action: string;
    reason?: string | null;
    artifactPath: string;
    violations: readonly string[];
}): string[] {
    const blocked = params.status === 'BLOCKED';
    return [
        ...buildOperatorNextActionBlock({
            status: params.status,
            gate: 'review-findings-follow-up-tasks',
            action: params.action,
            reason: params.reason,
            command: blocked ? null : buildNextStepCommand(params.repoRoot, params.taskId),
            commandReference: blocked ? 'resolve blockers listed in details before retrying materialization' : null,
            detailsPath: params.artifactPath,
            detailsHint: blocked ? `${params.violations.length} blocker(s) recorded in the materialization artifact.` : null
        }),
        '',
        params.marker,
        `ArtifactPath: ${normalizePath(params.artifactPath)}`,
        ...(params.violations.length > 0
            ? ['Violations:', ...params.violations.map((violation) => `- ${violation}`)]
            : [])
    ];
}

function getFallbackArtifactPath(repoRoot: string, taskId: string, reviewType: string): string {
    const safeTaskId = isCanonicalTaskId(taskId) ? normalizeText(taskId) : 'UNKNOWN-TASK';
    const safeReviewType = isReviewTypeToken(reviewType) ? assertReviewTypeToken(reviewType) : 'unknown-review';
    return joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${safeTaskId}-${safeReviewType}-findings-follow-ups.json`)
    );
}

export function getReviewFindingsFollowUpTasksArtifactPath(dispositionArtifactPath: string): string {
    const normalized = String(dispositionArtifactPath || '').trim();
    if (/-findings-disposition\.json$/u.test(normalized)) {
        return normalized.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json');
    }
    return normalized.replace(/\.json$/u, '-follow-ups.json');
}

function parseDispositionArtifact(value: Record<string, unknown>): ReviewFindingsDispositionArtifact | null {
    if (
        value.schema_version !== REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION
        || value.artifact_type !== REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE
        || !isPlainRecord(value.source_validation)
        || !Array.isArray(value.items)
        || !value.items.every((item) => isPlainRecord(item))
        || !isPlainRecord(value.policy)
        || !isPlainRecord(value.disposition_result)
        || typeof value.disposition_result_sha256 !== 'string'
    ) {
        return null;
    }
    return value as unknown as ReviewFindingsDispositionArtifact;
}

function isReviewFindingSeverity(value: unknown): value is ReviewFindingSeverity {
    return typeof value === 'string' && (REVIEW_FINDING_SEVERITIES as readonly string[]).includes(value);
}

function expectedSourceRuleForItem(
    artifact: ReviewFindingsDispositionArtifact,
    item: ReviewFindingsDispositionArtifactItem
): string | null {
    const policy = artifact.policy as unknown as Record<string, unknown>;
    const closurePolicy = isPlainRecord(policy.review_follow_up_task_closure_policy)
        ? policy.review_follow_up_task_closure_policy
        : null;
    const basePolicy = isPlainRecord(policy.base_review_finding_policy)
        ? policy.base_review_finding_policy
        : null;
    const baseFindings = basePolicy && isPlainRecord(basePolicy.findings)
        ? basePolicy.findings
        : null;
    const effectivePolicy = isPlainRecord(policy.review_finding_policy)
        ? policy.review_finding_policy
        : null;
    const effectiveFindings = effectivePolicy && isPlainRecord(effectivePolicy.findings)
        ? effectivePolicy.findings
        : null;
    if (
        isReviewFindingsFollowUpTaskId(artifact.task_id)
        && item.kind === 'finding'
        && item.severity === 'low'
        && closurePolicy?.skip_low_findings === true
        && baseFindings?.low !== effectiveFindings?.low
        && item.action === 'ignore'
    ) {
        return 'review_follow_up_task_closure_policy.skip_low_findings';
    }
    const baseAction = item.kind === 'residual_risk'
        ? basePolicy?.residual_risk
        : (isReviewFindingSeverity(item.severity) ? baseFindings?.[item.severity] : null);
    if (
        isReviewFindingsFollowUpTaskId(artifact.task_id)
        && closurePolicy?.forbid_child_tasks === true
        && baseAction === 'create_follow_up'
        && item.action === 'fix_now'
    ) {
        return 'review_follow_up_task_closure_policy.forbid_child_tasks';
    }
    if (item.kind === 'residual_risk') {
        return 'review_finding_policy.residual_risk';
    }
    if (isReviewFindingSeverity(item.severity)) {
        return `review_finding_policy.findings.${item.severity}`;
    }
    return null;
}

function expectedClosurePolicyActionForItem(
    artifact: ReviewFindingsDispositionArtifact,
    item: ReviewFindingsDispositionArtifactItem
): string | null {
    if (
        !isReviewFindingsFollowUpTaskId(artifact.task_id)
        || item.kind !== 'finding'
        || item.severity !== 'low'
    ) {
        return null;
    }
    const policy = artifact.policy as unknown as Record<string, unknown>;
    const closurePolicy = isPlainRecord(policy.review_follow_up_task_closure_policy)
        ? policy.review_follow_up_task_closure_policy
        : null;
    return closurePolicy?.eligible === true
        && closurePolicy.valid === true
        && closurePolicy.skip_low_findings === true
        ? 'ignore'
        : null;
}

function expectedMaterializationStatusForAction(action: unknown): string | null {
    if (action === 'fix_now') {
        return 'requires_fix_now';
    }
    if (action === 'create_follow_up') {
        return 'pending_follow_up_materialization';
    }
    if (action === 'ignore') {
        return 'audited_ignored';
    }
    return null;
}

function dispositionItemKey(kind: ReviewFindingsDispositionArtifactItem['kind'], severity: string, id: string): string {
    return `${kind}:${severity}:${id}`;
}

function dispositionResultItemKeys(artifact: ReviewFindingsDispositionArtifact): Array<{
    key: string;
    path: string;
    id: string;
    action: string | null;
}> {
    const result = artifact.disposition_result as unknown as Record<string, unknown>;
    const keys: Array<{ key: string; path: string; id: string; action: string | null }> = [];
    const findings = isPlainRecord(result.findings) ? result.findings : {};
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        const bucket = findings[severity];
        if (!isPlainRecord(bucket) || !Array.isArray(bucket.ids)) {
            continue;
        }
        const action = typeof bucket.action === 'string' ? bucket.action : null;
        for (const rawId of bucket.ids) {
            const id = normalizeText(rawId);
            if (!id) {
                continue;
            }
            keys.push({
                key: dispositionItemKey('finding', severity, id),
                path: `disposition_result.findings.${severity}`,
                id,
                action
            });
        }
    }

    const residualRiskBucket = result.residual_risks;
    if (isPlainRecord(residualRiskBucket) && Array.isArray(residualRiskBucket.ids)) {
        const action = typeof residualRiskBucket.action === 'string' ? residualRiskBucket.action : null;
        for (const rawId of residualRiskBucket.ids) {
            const id = normalizeText(rawId);
            if (!id) {
                continue;
            }
            keys.push({
                key: dispositionItemKey('residual_risk', 'residual_risk', id),
                path: 'disposition_result.residual_risks',
                id,
                action
            });
        }
    }

    return keys;
}

function validateDispositionArtifactShape(params: {
    artifact: ReviewFindingsDispositionArtifact;
    artifactPath: string;
    taskId: string;
    reviewType: string;
}): string[] {
    const { artifact, artifactPath, taskId, reviewType } = params;
    const violations: string[] = [];
    if (artifact.task_id !== taskId) {
        violations.push(
            `Review findings disposition artifact task_id mismatch: expected ${taskId}, found ${artifact.task_id || 'missing'}.`
        );
    }
    if (artifact.review_type !== reviewType) {
        violations.push(
            `Review findings disposition artifact review_type mismatch: expected ${reviewType}, found ${artifact.review_type || 'missing'}.`
        );
    }
    if (artifact.derivation_source !== 'garda_locked_policy_evaluation') {
        violations.push('Review findings disposition artifact derivation_source must be garda_locked_policy_evaluation.');
    }
    const sourceValidation = artifact.source_validation;
    if (sourceValidation.status !== 'accepted' || sourceValidation.accepted !== true) {
        violations.push('Review findings disposition artifact must be bound to an accepted system validation artifact.');
    }
    if (!sourceValidation.artifact_path) {
        violations.push('Review findings disposition artifact source_validation.artifact_path is missing.');
    }
    if (!normalizeHash(sourceValidation.artifact_sha256)) {
        violations.push('Review findings disposition artifact source_validation.artifact_sha256 is missing or invalid.');
    }
    if (!normalizeHash(sourceValidation.validation_result_sha256)) {
        violations.push('Review findings disposition artifact source_validation.validation_result_sha256 is missing or invalid.');
    }
    const actualDispositionResultSha256 = sha256RedactedJsonPayload(artifact.disposition_result);
    if (artifact.disposition_result_sha256 !== actualDispositionResultSha256) {
        violations.push(
            `Review findings disposition artifact '${normalizePath(artifactPath)}' disposition_result_sha256 mismatch: ` +
            `expected ${actualDispositionResultSha256}, found ${artifact.disposition_result_sha256 || 'missing'}.`
        );
    }
    const artifactPolicySource = normalizeText(artifact.policy.policy_source);
    if (!artifactPolicySource) {
        violations.push('Review findings disposition artifact policy.policy_source is missing.');
    }
    const artifactPolicy = artifact.policy as unknown as Record<string, unknown>;
    const dispositionResult = artifact.disposition_result as unknown as Record<string, unknown>;
    const policyClosureValue = artifactPolicy.review_follow_up_task_closure_policy;
    const resultClosureValue = dispositionResult.review_follow_up_task_closure_policy;
    if (policyClosureValue !== undefined || resultClosureValue !== undefined) {
        const policyClosureViolations = getReviewFollowUpTaskClosurePolicySnapshotViolations(policyClosureValue);
        const resultClosureViolations = getReviewFollowUpTaskClosurePolicySnapshotViolations(resultClosureValue);
        violations.push(...policyClosureViolations.map((violation) => (
            `Review findings disposition artifact policy ${violation}`
        )));
        violations.push(...resultClosureViolations.map((violation) => (
            `Review findings disposition result ${violation}`
        )));
        if (
            policyClosureViolations.length === 0
            && resultClosureViolations.length === 0
            && sha256JsonPayload(policyClosureValue) !== sha256JsonPayload(resultClosureValue)
        ) {
            violations.push(
                'Review findings disposition policy and disposition_result closure-policy snapshots must match.'
            );
        }
    }
    const dispositionResultItems = dispositionResultItemKeys(artifact);
    const dispositionResultActionsByItemKey = new Map<string, string>();
    for (const resultItem of dispositionResultItems) {
        if (resultItem.action) {
            dispositionResultActionsByItemKey.set(resultItem.key, resultItem.action);
        }
    }
    const dispositionItemKeys = new Set<string>();
    for (const item of artifact.items) {
        const itemId = normalizeText(item.id);
        if (!itemId) {
            violations.push('Review findings disposition item is missing id.');
        }
        if (item.kind !== 'finding' && item.kind !== 'residual_risk') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid kind.`);
        }
        if (item.kind === 'finding' && !isReviewFindingSeverity(item.severity)) {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid finding severity.`);
        }
        if (item.kind === 'residual_risk' && item.severity !== 'residual_risk') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' residual risk severity must be residual_risk.`);
        }
        if (item.action !== 'fix_now' && item.action !== 'create_follow_up' && item.action !== 'ignore') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid action.`);
        }
        const key = item.kind === 'residual_risk'
            ? dispositionItemKey('residual_risk', 'residual_risk', itemId)
            : isReviewFindingSeverity(item.severity)
                ? dispositionItemKey('finding', item.severity, itemId)
                : null;
        const dispositionResultAction = key
            ? dispositionResultActionsByItemKey.get(key) || null
            : null;
        if (!dispositionResultAction) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' is not present in disposition_result.`
            );
        } else if (item.action !== dispositionResultAction) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' action '${item.action}' does not match ` +
                `disposition_result action '${dispositionResultAction}'.`
            );
        }
        const expectedClosurePolicyAction = expectedClosurePolicyActionForItem(artifact, item);
        if (expectedClosurePolicyAction && item.action !== expectedClosurePolicyAction) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' must use action ` +
                `'${expectedClosurePolicyAction}' under frozen skip_low_findings closure policy.`
            );
        }
        const expectedSourceRule = expectedSourceRuleForItem(artifact, item);
        if (!expectedSourceRule || normalizeText(item.source_rule) !== expectedSourceRule) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' source_rule must be ` +
                `${expectedSourceRule || 'valid for its kind and severity'}.`
            );
        }
        if (normalizeText(item.policy_source) !== artifactPolicySource) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' policy_source must match the disposition artifact policy_source.`
            );
        }
        const expectedBlocking = item.action === 'fix_now';
        if (typeof item.blocking !== 'boolean') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' blocking flag must be boolean.`);
        } else if (item.blocking !== expectedBlocking) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' blocking flag does not match action '${item.action}'.`
            );
        }
        if (key) {
            if (dispositionItemKeys.has(key)) {
                violations.push(`Review findings disposition item '${item.id || 'missing'}' is duplicated.`);
            }
            dispositionItemKeys.add(key);
        }
        const expectedMaterializationStatus = expectedMaterializationStatusForAction(item.action);
        if (expectedMaterializationStatus && item.materialization_status !== expectedMaterializationStatus) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' materialization_status must be ` +
                `${expectedMaterializationStatus} for action '${item.action}'.`
            );
        }
        if (item.audit_status !== 'retained_in_disposition_artifact') {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' audit_status must be retained_in_disposition_artifact.`
            );
        }
    }
    for (const resultItem of dispositionResultItems) {
        if (!dispositionItemKeys.has(resultItem.key)) {
            violations.push(
                `Review findings ${resultItem.path} id '${resultItem.id}' is missing a matching disposition item.`
            );
        }
    }
    return violations;
}

function validateValidationInventoryShape(artifact: ReviewFindingsValidationArtifact): string[] {
    const violations: string[] = [];
    const inventory = artifact.validation_result.normalized_inventory as unknown;
    if (!isPlainRecord(inventory)) {
        return ['Review findings validation artifact normalized_inventory must be an object.'];
    }
    if (!isPlainRecord(inventory.findings_by_severity)) {
        violations.push('Review findings validation artifact normalized_inventory.findings_by_severity must be an object.');
    } else {
        const seenFindingIds = new Set<string>();
        for (const severity of REVIEW_FINDING_SEVERITIES) {
            const bucket = inventory.findings_by_severity[severity];
            if (!Array.isArray(bucket)) {
                violations.push(
                    `Review findings validation artifact normalized_inventory.findings_by_severity.${severity} must be an array.`
                );
                continue;
            }
            bucket.forEach((entry, index) => {
                if (!isPlainRecord(entry)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} must be an object.`
                    );
                    return;
                }
                const id = normalizeText(entry.id);
                if (!id) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing id.`
                    );
                } else {
                    if (seenFindingIds.has(id)) {
                        violations.push(
                            `Review findings validation artifact duplicate finding inventory id '${id}' for severity '${severity}'.`
                        );
                    }
                    seenFindingIds.add(id);
                }
                if (entry.severity !== severity) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} has mismatched severity.`
                    );
                }
                if (!normalizeText(entry.title)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing title.`
                    );
                }
                if (!normalizeText(entry.description)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing description.`
                    );
                }
                if (!Array.isArray(entry.evidence_locations)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} evidence_locations must be an array.`
                    );
                }
                if (!Array.isArray(entry.coverage_obligation_ids)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} coverage_obligation_ids must be an array.`
                    );
                }
            });
        }
    }
    if (!Array.isArray(inventory.residual_risks)) {
        violations.push('Review findings validation artifact normalized_inventory.residual_risks must be an array.');
    } else {
        const seenResidualRiskIds = new Set<string>();
        inventory.residual_risks.forEach((entry, index) => {
            if (!isPlainRecord(entry)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} must be an object.`
                );
                return;
            }
            const id = normalizeText(entry.id);
            if (!id) {
                violations.push(`Review findings validation artifact residual risk inventory entry ${index} is missing id.`);
            } else {
                if (seenResidualRiskIds.has(id)) {
                    violations.push(
                        `Review findings validation artifact duplicate residual risk inventory id '${id}'.`
                    );
                }
                seenResidualRiskIds.add(id);
            }
            if (!normalizeText(entry.description)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} is missing description.`
                );
            }
            if (!Array.isArray(entry.evidence_locations)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} evidence_locations must be an array.`
                );
            }
        });
    }
    return violations;
}

function validateDispositionInventoryCompleteness(params: {
    disposition: ReviewFindingsDispositionArtifact;
    validation: ReviewFindingsValidationArtifact;
}): string[] {
    const violations: string[] = [];
    const resultKeys = new Set(
        dispositionResultItemKeys(params.disposition).map((item) => item.key)
    );
    const dispositionItemKeys = new Set(
        params.disposition.items.map((item) => dispositionItemKey(item.kind, item.severity, item.id))
    );
    const inventory = params.validation.validation_result.normalized_inventory;

    for (const severity of REVIEW_FINDING_SEVERITIES) {
        for (const finding of inventory.findings_by_severity[severity]) {
            if (finding.id === EVIDENCE_ONLY_FINDING_ID) {
                continue;
            }
            const key = dispositionItemKey('finding', severity, finding.id);
            if (!resultKeys.has(key)) {
                violations.push(
                    `Accepted validation inventory finding '${finding.id}' at severity '${severity}' is missing from disposition_result.`
                );
            }
            if (!dispositionItemKeys.has(key)) {
                violations.push(
                    `Accepted validation inventory finding '${finding.id}' at severity '${severity}' is missing a disposition item.`
                );
            }
        }
    }

    for (const residualRisk of inventory.residual_risks) {
        const key = dispositionItemKey('residual_risk', 'residual_risk', residualRisk.id);
        if (!resultKeys.has(key)) {
            violations.push(
                `Accepted validation inventory residual risk '${residualRisk.id}' is missing from disposition_result.`
            );
        }
        if (!dispositionItemKeys.has(key)) {
            violations.push(
                `Accepted validation inventory residual risk '${residualRisk.id}' is missing a disposition item.`
            );
        }
    }

    return violations;
}

function sourceFindingIndexKey(id: string, severity: string): string {
    return `${severity}\0${id}`;
}

function buildSourceInventoryIndex(artifact: ReviewFindingsValidationArtifact): SourceInventoryIndex {
    const findings = new Map<string, NormalizedReviewFindingInventoryEntry>();
    const findingsBySeverity = artifact.validation_result.normalized_inventory.findings_by_severity;
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        for (const finding of findingsBySeverity[severity]) {
            findings.set(sourceFindingIndexKey(finding.id, finding.severity), finding);
        }
    }

    const residualRisks = new Map<string, NormalizedReviewResidualRiskInventoryEntry>();
    for (const residualRisk of artifact.validation_result.normalized_inventory.residual_risks) {
        residualRisks.set(residualRisk.id, residualRisk);
    }

    return {
        findings,
        residual_risks: residualRisks
    };
}

function findSourceInventoryEntry(
    index: SourceInventoryIndex,
    item: ReviewFindingsDispositionArtifactItem
): SourceInventoryEntry | null {
    if (item.kind === 'finding') {
        const finding = index.findings.get(sourceFindingIndexKey(item.id, item.severity));
        return finding ? { kind: 'finding', finding } : null;
    }
    const residualRisk = index.residual_risks.get(item.id);
    return residualRisk ? { kind: 'residual_risk', residual_risk: residualRisk } : null;
}

function sourceTitle(entry: SourceInventoryEntry): string {
    if (entry.kind === 'finding') {
        return entry.finding.title;
    }
    return entry.residual_risk.description.split(/[.?!]\s/u)[0] || entry.residual_risk.description;
}

function sourceDescription(entry: SourceInventoryEntry): string {
    return entry.kind === 'finding'
        ? entry.finding.description
        : entry.residual_risk.description;
}

function sourceEvidenceLocations(entry: SourceInventoryEntry): string[] {
    return entry.kind === 'finding'
        ? [...entry.finding.evidence_locations]
        : [...entry.residual_risk.evidence_locations];
}

function buildRemediationText(item: ReviewFindingsDispositionArtifactItem): string {
    const severity = item.severity === 'residual_risk'
        ? 'residual risk'
        : `${item.severity} finding`;
    return `Address accepted ${severity} ${item.id} according to ${item.source_rule}; keep validation and receipt hashes in the follow-up notes.`;
}

function buildFingerprint(params: {
    taskId: string;
    reviewType: string;
    item: ReviewFindingsDispositionArtifactItem;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
}): string {
    return sha256JsonPayload({
        schema_version: 1,
        parent_task_id: params.taskId,
        review_type: params.reviewType,
        item_id: params.item.id,
        item_kind: params.item.kind,
        severity: params.item.severity,
        action: params.item.action,
        source_rule: params.item.source_rule,
        validation_artifact_sha256: params.validationArtifactSha256,
        validation_result_sha256: params.validationResultSha256,
        disposition_artifact_sha256: params.dispositionArtifactSha256,
        disposition_result_sha256: params.dispositionResultSha256
    });
}

export function buildObligations(params: {
    taskId: string;
    reviewType: string;
    disposition: ReviewFindingsDispositionArtifact;
    validation: ReviewFindingsValidationArtifact;
    dispositionArtifactSha256: string;
}): { obligations: FollowUpObligation[]; items: ReviewFindingsFollowUpTaskMaterializationItem[]; violations: string[] } {
    const obligations: FollowUpObligation[] = [];
    const items: ReviewFindingsFollowUpTaskMaterializationItem[] = [];
    const violations: string[] = [];
    const validationArtifactSha256 = params.disposition.source_validation.artifact_sha256;
    const validationResultSha256 = params.disposition.source_validation.validation_result_sha256;
    const sourceInventoryIndex = buildSourceInventoryIndex(params.validation);

    for (const item of params.disposition.items) {
        const sourceInventory = findSourceInventoryEntry(sourceInventoryIndex, item);
        if (!sourceInventory) {
            violations.push(
                `Review findings disposition item '${item.id}' is not present in the accepted validation inventory.`
            );
            items.push(buildArtifactItem({
                item,
                status: blockedStatusForDispositionItem(item),
                taskId: null,
                fingerprint: null,
                title: null,
                description: null,
                evidenceLocations: [],
                remediation: null
            }));
            continue;
        }

        const title = sourceTitle(sourceInventory);
        const description = sourceDescription(sourceInventory);
        const evidenceLocations = sourceEvidenceLocations(sourceInventory);
        const remediation = buildRemediationText(item);
        const fingerprint = buildFingerprint({
            taskId: params.taskId,
            reviewType: params.reviewType,
            item,
            validationArtifactSha256,
            validationResultSha256,
            dispositionArtifactSha256: params.dispositionArtifactSha256,
            dispositionResultSha256: params.disposition.disposition_result_sha256
        });

        if (item.action === 'create_follow_up') {
            obligations.push({
                disposition_item: item,
                source_inventory: sourceInventory,
                title,
                description,
                evidence_locations: evidenceLocations,
                remediation,
                fingerprint
            });
            continue;
        }

        items.push(buildArtifactItem({
            item,
            status: materializationStatusForNonFollowUpItem(item),
            taskId: null,
            fingerprint,
            title,
            description,
            evidenceLocations,
            remediation
        }));
    }

    return { obligations, items, violations };
}

function materializationStatusForNonFollowUpItem(
    item: ReviewFindingsDispositionArtifactItem
): ReviewFindingFollowUpItemStatus {
    return item.action === 'fix_now' ? 'requires_fix_now' : 'not_required';
}

function blockedStatusForDispositionItem(
    item: ReviewFindingsDispositionArtifactItem
): ReviewFindingFollowUpItemStatus {
    return item.action === 'create_follow_up'
        ? 'blocked'
        : materializationStatusForNonFollowUpItem(item);
}

function buildArtifactItem(params: {
    item: ReviewFindingsDispositionArtifactItem;
    status: ReviewFindingFollowUpItemStatus;
    taskId: string | null;
    fingerprint: string | null;
    title: string | null;
    description: string | null;
    evidenceLocations: readonly string[];
    remediation: string | null;
}): ReviewFindingsFollowUpTaskMaterializationItem {
    return {
        source_item_id: params.item.id,
        source_item_kind: params.item.kind,
        severity: params.item.severity,
        action: params.item.action,
        source_rule: params.item.source_rule,
        source_policy: params.item.policy_source,
        blocking: params.item.blocking,
        fingerprint: params.fingerprint,
        materialization_status: params.status,
        task_id: params.taskId,
        title: params.title,
        description: params.description,
        evidence_locations: [...params.evidenceLocations],
        remediation: params.remediation
    };
}

function sanitizeTaskCell(value: unknown, fallback: string, maxLength = 180): string {
    const text = String(value || '').trim() || fallback;
    const compact = text
        .replace(/[\u0000-\u001F\u007F]/gu, ' ')
        .replace(/\|/gu, '/')
        .replace(/\s+/gu, ' ')
        .trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function priorityForSeverity(severity: ReviewFindingsDispositionArtifactItem['severity'], fallback: string): string {
    if (severity === 'critical' || severity === 'high') {
        return 'P1';
    }
    if (severity === 'medium' || severity === 'residual_risk') {
        return 'P2';
    }
    if (severity === 'low') {
        return 'P3';
    }
    return fallback || 'P2';
}

function evidenceNote(evidenceLocations: readonly string[]): string {
    const firstLocations = evidenceLocations.slice(0, 3).map((entry) => sanitizeTaskCell(entry, 'unknown evidence', 80));
    if (firstLocations.length === 0) {
        return 'none recorded';
    }
    const suffix = evidenceLocations.length > firstLocations.length
        ? `, +${evidenceLocations.length - firstLocations.length} more`
        : '';
    return `${firstLocations.join(', ')}${suffix}`;
}

function buildTaskTitle(reviewType: string, obligation: FollowUpObligation): string {
    const severity = obligation.disposition_item.severity === 'residual_risk'
        ? 'residual risk'
        : obligation.disposition_item.severity;
    return sanitizeTaskCell(
        `[${reviewType}] Follow up ${severity} ${obligation.disposition_item.id}: ${obligation.title}`,
        `Follow up ${reviewType} review finding ${obligation.disposition_item.id}`,
        140
    );
}

function buildTaskNotes(params: {
    parentTaskId: string;
    reviewType: string;
    obligation: FollowUpObligation;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
    taskProfile: string;
    taskProfileSource: string;
}): string {
    const item = params.obligation.disposition_item;
    return sanitizeTaskCell([
        `Child of \`${params.parentTaskId}\`.`,
        `Follow-up from accepted \`${params.reviewType}\` ${item.kind} \`${item.id}\` severity \`${item.severity}\`.`,
        `Evidence: ${evidenceNote(params.obligation.evidence_locations)}.`,
        `Remediation: ${params.obligation.remediation}`,
        `validation_sha256=${params.validationArtifactSha256};`,
        `validation_result_sha256=${params.validationResultSha256};`,
        `receipt_sha256=${params.receiptSha256};`,
        `disposition_sha256=${params.dispositionArtifactSha256};`,
        `disposition_result_sha256=${params.dispositionResultSha256};`,
        `review_follow_up_task_profile=${params.taskProfile};`,
        `review_follow_up_task_profile_source=${params.taskProfileSource};`,
        `review_follow_up_fingerprint=${params.obligation.fingerprint}.`
    ].join(' '), 'Review follow-up task.', 1200);
}

function extractGroupedFingerprint(notes: string): string | null {
    return normalizeHash(String(notes || '').match(/review_follow_up_group_fingerprint=([0-9a-f]{64})/iu)?.[1] || null);
}

interface GroupedLaneBinding {
    reviewType: string;
    itemCount: number;
    itemFingerprintsSha256: string;
    sourceBindingSha256: string;
    artifactPath: string | null;
}

function buildGroupedSourceBindingSha256(params: {
    reviewType: string;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
    retainedReviews?: RetainedReviewReference[];
}): string {
    return sha256JsonPayload({
        schema_version: 1,
        review_type: params.reviewType,
        validation_artifact_sha256: params.validationArtifactSha256,
        validation_result_sha256: params.validationResultSha256,
        receipt_sha256: params.receiptSha256,
        disposition_artifact_sha256: params.dispositionArtifactSha256,
        disposition_result_sha256: params.dispositionResultSha256,
        ...(params.retainedReviews?.length ? { retained_reviews: params.retainedReviews } : {})
    });
}

function extractGroupedLaneBindings(notes: string): Map<string, GroupedLaneBinding> {
    const bindings = new Map<string, GroupedLaneBinding>();
    const artifactPaths = new Map<string, string>();
    const artifactMatcher = /review_follow_up_lane_artifact=([a-z0-9_-]+):`([^`\r\n]+)`\./giu;
    for (const match of String(notes || '').matchAll(artifactMatcher)) {
        artifactPaths.set(match[1].toLowerCase(), normalizePath(match[2]));
    }
    const matcher = /review_follow_up_lane_binding=([a-z0-9_-]+):([0-9]+):([0-9a-f]{64}):([0-9a-f]{64})\./giu;
    for (const match of String(notes || '').matchAll(matcher)) {
        const itemCount = Number.parseInt(match[2], 10);
        const itemFingerprintsSha256 = normalizeHash(match[3]);
        const sourceBindingSha256 = normalizeHash(match[4]);
        if (Number.isSafeInteger(itemCount) && itemCount >= 0 && itemFingerprintsSha256 && sourceBindingSha256) {
            bindings.set(match[1].toLowerCase(), {
                reviewType: match[1].toLowerCase(),
                itemCount,
                itemFingerprintsSha256,
                sourceBindingSha256,
                artifactPath: artifactPaths.get(match[1].toLowerCase()) || null
            });
        }
    }
    return bindings;
}

function buildGroupedTaskNotes(params: {
    parentTaskId: string;
    context: FollowUpMaterializationContext;
    reviewType: string;
    obligations: readonly FollowUpObligation[];
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
    artifactPath: string;
    retainedReviews?: RetainedReviewReference[];
    existingNotes?: string;
}): string {
    const bindings = extractGroupedLaneBindings(normalizeText(params.existingNotes));
    const reviewType = params.reviewType.toLowerCase();
    const itemFingerprints = [...new Set(params.obligations.map((obligation) => obligation.fingerprint))].sort();
    bindings.set(reviewType, {
        reviewType,
        itemCount: itemFingerprints.length,
        itemFingerprintsSha256: sha256JsonPayload(itemFingerprints),
        sourceBindingSha256: buildGroupedSourceBindingSha256(params),
        artifactPath: normalizePath(params.artifactPath)
    });
    const base = [
        `Child of \`${params.parentTaskId}\`.`,
        'Grouped deferred review findings and residual risks for one task-owned review cycle.',
        `review_follow_up_group_fingerprint=${params.context.group_fingerprint}.`,
        `review_follow_up_snapshot_sha256=${params.context.snapshot_hash}.`,
        `review_follow_up_cycle=${params.context.cycle_id}.`,
        `review_follow_up_task_profile=${params.context.task_profile}.`,
        `review_follow_up_task_profile_source=${params.context.task_profile_source}.`
    ].join(' ');
    const laneBindings = [...bindings.values()]
        .sort((left, right) => left.reviewType.localeCompare(right.reviewType))
        .flatMap((binding) => [
            `review_follow_up_lane_binding=${binding.reviewType}:${binding.itemCount}:` +
            `${binding.itemFingerprintsSha256}:${binding.sourceBindingSha256}.`,
            ...(binding.artifactPath
                ? [`review_follow_up_lane_artifact=${binding.reviewType}:\`${binding.artifactPath}\`.`]
                : [])
        ]);
    // Full per-item evidence remains in the hash-bound follow-up artifact. TASK.md
    // stores one fixed-size digest per review lane, so queue navigation cost is
    // bounded by the configured lane set instead of the number of findings.
    return sanitizeTaskCell([
        base,
        ...laneBindings
    ].join(' '), 'Grouped review follow-up task.', 4096);
}

function extractExistingFingerprint(notes: string): string | null {
    return normalizeHash(String(notes || '').match(/review_follow_up_fingerprint=([0-9a-f]{64})/iu)?.[1] || null);
}

function currentGroupedBinding(params: {
    reviewsRoot: string;
    taskId: string;
    context: FollowUpMaterializationContext;
}): CurrentReviewFollowUpMaterializationBinding {
    return {
        mode: params.context.mode,
        snapshotHash: params.context.snapshot_hash || '',
        cycleId: params.context.cycle_id || '',
        groupFingerprint: params.context.group_fingerprint,
        preflightPath: path.join(params.reviewsRoot, `${params.taskId}-preflight.json`),
        preflightSha256: params.context.preflight_sha256 || '',
        compileTimestamp: params.context.compile_gate_timestamp || ''
    };
}

function authenticatedGroupedReuse(params: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    context: FollowUpMaterializationContext;
    receiptPath: string;
}) {
    const receiptSha256 = fileSha256(params.receiptPath);
    const resolved = resolveAuthenticatedReviewReceiptSnapshot({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        reviewType: params.reviewType,
        followUpArtifact: {
            source_receipt: { receipt_path: params.receiptPath, receipt_sha256: receiptSha256 }
        },
        currentMaterializationBinding: currentGroupedBinding(params)
    });
    if (!resolved.evidence) return resolved;
    const evidence = resolved.evidence;
    const fields = normalizeReviewReceiptEvidenceFields(evidence.receipt);
    if (!fields.reusedExistingReview) {
        return { evidence: null, diagnostics: ['Grouped follow-up recovery requires authenticated reused review evidence.'] };
    }
    const validation = validateReviewFindingsValidationArtifactForReceipt({
        receipt: evidence.receipt,
        reviewArtifactPath: evidence.reviewArtifactPath,
        expectedTaskId: params.taskId,
        expectedReviewType: params.reviewType,
        expectedReviewArtifactSha256: evidence.reviewArtifactSha256,
        expectedReviewContextSha256: fields.reusedFromReviewContextSha256,
        expectedReviewScopeSha256: fields.reusedFromReviewScopeSha256,
        expectedCodeScopeSha256: fields.reusedFromCodeScopeSha256,
        expectedReviewTreeStateSha256: fields.reusedFromReviewTreeStateSha256,
        requireAccepted: true,
        preferSnapshot: true
    });
    return validation.valid ? resolved : { evidence: null, diagnostics: validation.violations };
}

function groupedRowHasCompleteRegistry(params: {
    repoRoot: string;
    parentTaskId: string;
    parentNotes: string;
    row: CanonicalActiveTaskQueueRow;
    priorPublication?: PriorGroupedPublication;
    allowUnmaterializedReviewType?: string;
    allowUnmaterializedFreshLanes?: boolean;
    confirmedUnmaterializedReviewTypes?: readonly string[];
}): boolean {
    const bindings = extractGroupedLaneBindings(params.row.notes);
    const lanePaths = [...bindings.values()].map((binding) => resolveReviewFollowUpEvidencePath(params.repoRoot, binding.artifactPath));
    if (lanePaths.length === 0 || lanePaths.some((artifactPath) => !artifactPath)) return false;
    const parentPaths = extractParentFollowUpArtifactPaths(params.parentNotes, params.row.taskId)
        .map((artifactPath) => resolveReviewFollowUpEvidencePath(params.repoRoot, artifactPath));
    if (parentPaths.some((artifactPath) => !artifactPath)) return false;
    const discovered = discoverGroupedFollowUpArtifactPaths({
        repoRoot: params.repoRoot, reviewsRoot: path.dirname(lanePaths[0] as string),
        parentTaskId: params.parentTaskId, childTaskId: params.row.taskId,
        snapshotHash: normalizeHash(params.row.notes.match(/review_follow_up_snapshot_sha256=([0-9a-f]{64})/iu)?.[1]) || '',
        priorPublication: params.priorPublication,
        allowUnmaterializedReviewType: params.allowUnmaterializedReviewType,
        allowUnmaterializedFreshLanes: params.allowUnmaterializedFreshLanes,
        allowConfirmedUnmaterializedReviewTypes: params.confirmedUnmaterializedReviewTypes
    });
    return discovered.diagnostics.length === 0
        && JSON.stringify([...new Set([...parentPaths, ...discovered.paths])].sort()) === JSON.stringify(lanePaths.sort());
}

function groupedRowMatchesAuthenticatedReuse(params: {
    repoRoot: string;
    parentTaskId: string;
    context: FollowUpMaterializationContext;
    row: CanonicalActiveTaskQueueRow;
    parentNotes: string;
    priorPublication?: PriorGroupedPublication;
    confirmedUnmaterializedReviewTypes?: readonly string[];
}): boolean {
    const snapshotHash = normalizeHash(params.row.notes.match(/review_follow_up_snapshot_sha256=([0-9a-f]{64})/iu)?.[1]);
    if (snapshotHash !== params.context.snapshot_hash) return false;
    const bindings = extractGroupedLaneBindings(params.row.notes);
    if (!groupedRowHasCompleteRegistry(params)) return false;
    return [...bindings.values()].every((binding) => {
        if (!binding.artifactPath) return false;
        let artifactPath: string;
        try {
            artifactPath = resolveInputPathInsideRepo(params.repoRoot, binding.artifactPath, 'FollowUpArtifactPath');
        } catch { return false; }
        const artifact = readJsonFile(artifactPath, 'Follow-up artifact').value;
        const sourceReceipt = isPlainRecord(artifact?.source_receipt) ? artifact.source_receipt : null;
        const receiptPathText = normalizeText(sourceReceipt?.receipt_path);
        if (!artifact || !receiptPathText) return false;
        let receiptPath: string;
        try {
            receiptPath = resolveInputPathInsideRepo(params.repoRoot, receiptPathText, 'ReceiptPath');
        } catch { return false; }
        const sourceReceiptSha256 = normalizeHash(sourceReceipt?.receipt_sha256);
        const currentReceipt = resolveAuthenticatedReviewReceiptSnapshot({
            repoRoot: params.repoRoot, taskId: params.parentTaskId, reviewType: binding.reviewType,
            followUpArtifact: { source_receipt: { receipt_path: receiptPath, receipt_sha256: fileSha256(receiptPath) } },
            currentMaterializationBinding: currentGroupedBinding({
                reviewsRoot: path.dirname(artifactPath), taskId: params.parentTaskId, context: params.context
            })
        });
        if (!currentReceipt.evidence) return false;
        if (!normalizeReviewReceiptEvidenceFields(currentReceipt.evidence.receipt).reusedExistingReview) {
            // A lane reviewed freshly in this cycle carries no reuse evidence. Its
            // binding must belong to the current group and to the exact current
            // authenticated receipt, then pass the same source and queue checks.
            const canonicalReceiptPath = path.join(
                path.dirname(artifactPath), `${params.parentTaskId}-${binding.reviewType}-receipt.json`
            );
            if (params.priorPublication) {
                // Discovery authenticated the historical publication and the current review, including strict reuse.
                return params.priorPublication.historicalLanes.has(binding.reviewType)
                    && path.resolve(receiptPath) === path.resolve(canonicalReceiptPath)
                    && path.basename(artifactPath) === params.parentTaskId + '-' + binding.reviewType + '-findings-follow-ups.json';
            }
            if (extractGroupedFingerprint(params.row.notes) !== params.context.group_fingerprint
                || path.resolve(receiptPath) !== path.resolve(canonicalReceiptPath)
                || sourceReceiptSha256 !== currentReceipt.evidence.receiptSha256) return false;
            const freshSources = resolveAuthenticatedReviewFollowUpSources({
                repoRoot: params.repoRoot, parentTaskId: params.parentTaskId, reviewType: binding.reviewType,
                followUpArtifact: artifact, followUpArtifactPath: artifactPath, receiptEvidence: currentReceipt.evidence,
                currentMaterializationBinding: currentGroupedBinding({
                    reviewsRoot: path.dirname(artifactPath), taskId: params.parentTaskId, context: params.context
                })
            });
            if (!freshSources.dispositionArtifact || !freshSources.dispositionArtifactSha256) return false;
            return publishedFollowUpArtifactMatchesCurrentTaskQueue({
                artifact, dispositionArtifact: freshSources.dispositionArtifact as unknown as Record<string, unknown>,
                dispositionArtifactSha256: freshSources.dispositionArtifactSha256,
                repoRoot: params.repoRoot, taskId: params.parentTaskId, reviewType: binding.reviewType,
                expectedFollowUpCount: binding.itemCount, materializationMode: 'grouped_by_parent',
                followUpArtifactPath: artifactPath,
                expectedGroupedChildTaskId: params.row.taskId,
                queueGroupFingerprint: params.context.group_fingerprint || undefined
            });
        }
        const reused = authenticatedGroupedReuse({
            repoRoot: params.repoRoot, reviewsRoot: path.dirname(artifactPath), taskId: params.parentTaskId,
            reviewType: binding.reviewType, context: params.context, receiptPath
        });
        if (!reused.evidence) return false;
        if (sourceReceiptSha256 !== reused.evidence.receiptSha256
            && sourceReceiptSha256 !== normalizeReviewReceiptEvidenceFields(reused.evidence.receipt).reusedFromReceiptSha256
            && !hasAuthenticatedIntermediateGroupedReceiptSource({
                repoRoot: params.repoRoot, taskId: params.parentTaskId, reviewType: binding.reviewType,
                receipt: reused.evidence.receipt, receiptPath: reused.evidence.canonicalReceiptPath,
                receiptSha256: reused.evidence.receiptSha256, sourceReceiptPath: receiptPath, sourceReceiptSha256
            })) return false;
        const sources = resolveAuthenticatedReviewFollowUpSources({
            repoRoot: params.repoRoot, parentTaskId: params.parentTaskId, reviewType: binding.reviewType,
            followUpArtifact: artifact, followUpArtifactPath: artifactPath, receiptEvidence: reused.evidence,
            currentMaterializationBinding: currentGroupedBinding({
                reviewsRoot: path.dirname(artifactPath), taskId: params.parentTaskId, context: params.context
            })
        });
        if (!sources.dispositionArtifact || !sources.dispositionArtifactSha256) return false;
        return publishedFollowUpArtifactMatchesCurrentTaskQueue({
                artifact, dispositionArtifact: sources.dispositionArtifact as unknown as Record<string, unknown>,
                dispositionArtifactSha256: sources.dispositionArtifactSha256,
                repoRoot: params.repoRoot, taskId: params.parentTaskId, reviewType: binding.reviewType,
                expectedFollowUpCount: binding.itemCount, materializationMode: 'grouped_by_parent',
                followUpArtifactPath: artifactPath,
                expectedGroupedChildTaskId: params.row.taskId,
                // During lane-by-lane recovery, the child can already have the new
                // group while a validated lane artifact still retains its old cycle.
                queueGroupFingerprint: extractGroupedFingerprint(params.row.notes) === params.context.group_fingerprint
                    ? params.context.group_fingerprint || undefined : undefined
            });
    });
}

function appendParentFollowUpNote(existingNotes: string, childTaskIds: readonly string[], artifactPath: string): string {
    const newTaskIds = childTaskIds.filter((taskId) => !buildExactTaskIdReferencePattern(taskId).test(existingNotes));
    const normalizedArtifactPath = normalizePath(artifactPath);
    const artifactAlreadyLinked = existingNotes.includes(`artifact \`${normalizedArtifactPath}\`.`);
    if (newTaskIds.length === 0 && artifactAlreadyLinked) {
        return existingNotes;
    }
    const linkedTaskIds = newTaskIds.length > 0 ? newTaskIds : [...new Set(childTaskIds)];
    if (linkedTaskIds.length === 0) {
        return existingNotes;
    }
    const suffix = `Review follow-up tasks materialized: ${linkedTaskIds.map((taskId) => `\`${taskId}\``).join(', ')}; artifact \`${normalizedArtifactPath}\`.`;
    return existingNotes.trim() ? `${existingNotes.trim()} ${suffix}` : suffix;
}

function sourceParentNotes(notes: string): string {
    return String(notes || '').replace(MATERIALIZED_PARENT_NOTE_SUFFIX_PATTERN, '').trim();
}

function findInsertionLineIndex(parentRow: CanonicalActiveTaskQueueRow, rows: readonly CanonicalActiveTaskQueueRow[]): number {
    return rows.reduce((lineIndex, row) => {
        if (isParentFollowUpTaskId(parentRow.taskId, row.taskId)) {
            return Math.max(lineIndex, row.lineIndex);
        }
        return lineIndex;
    }, parentRow.lineIndex);
}

interface FollowUpQueueLane {
    reviewsRoot: string;
    reviewType: string;
    artifactPath: string;
    obligations: readonly FollowUpObligation[];
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
    reusedReview: boolean;
    retainedReviews?: RetainedReviewReference[];
}

function groupedRowAdmitsLane(params: {
    repoRoot: string;
    parentTaskId: string;
    parentNotes: string;
    row: CanonicalActiveTaskQueueRow;
    context: FollowUpMaterializationContext;
    lane: FollowUpQueueLane;
    confirmedUnmaterializedReviewTypes?: readonly string[];
}): boolean {
    // Each incoming lane is checked against the unchanged current child exactly
    // as a single-lane run would check it: a reused lane keeps the strict
    // registry and authenticated-reuse checks, a fresh lane keeps only its own
    // fresh-lane allowance. Operator-confirmed never-materialized lanes are the
    // only extra allowance, and every lane already bound is still checked.
    return groupedRowHasCompleteRegistry({
        repoRoot: params.repoRoot, parentTaskId: params.parentTaskId,
        parentNotes: params.parentNotes, row: params.row,
        allowUnmaterializedReviewType: params.lane.reusedReview ? undefined : params.lane.reviewType,
        allowUnmaterializedFreshLanes: !params.lane.reusedReview,
        confirmedUnmaterializedReviewTypes: params.confirmedUnmaterializedReviewTypes
    }) && (!params.lane.reusedReview || groupedRowMatchesAuthenticatedReuse({
        repoRoot: params.repoRoot, parentTaskId: params.parentTaskId,
        parentNotes: params.parentNotes, row: params.row, context: params.context,
        confirmedUnmaterializedReviewTypes: params.confirmedUnmaterializedReviewTypes
    }));
}

function confirmedUnmaterializedLaneViolation(params: {
    repoRoot: string;
    parentTaskId: string;
    parentNotes: string;
    row: CanonicalActiveTaskQueueRow | undefined;
    activeLanes: readonly FollowUpQueueLane[];
    confirmedReviewTypes: readonly string[];
    rows: readonly CanonicalActiveTaskQueueRow[];
}): string | null {
    if (!params.row) {
        return 'Operator-confirmed lane recovery requires an existing current-group grouped child.';
    }
    if (!/TODO/iu.test(params.row.status)) {
        return `Grouped follow-up task '${params.row.taskId}' is no longer pending and must not be mutated.`;
    }
    const childRows = params.rows.filter((row) => isParentFollowUpTaskId(params.parentTaskId, row.taskId));
    // A parent artifact link to any child, current or not, means the lane was
    // published at some point, so it cannot be confirmed as never materialized.
    const parentLinkedPaths = new Map<string, string>();
    for (const match of String(params.parentNotes || '').matchAll(
        /Review follow-up tasks materialized:\s*([^;\r\n]+);\s*artifact\s+`([^`\r\n]+)`\./giu
    )) {
        const resolved = resolveReviewFollowUpEvidencePath(params.repoRoot, normalizePath(match[2]));
        parentLinkedPaths.set(path.resolve(resolved || path.resolve(params.repoRoot, match[2])), match[1].trim());
    }
    for (const reviewType of params.confirmedReviewTypes) {
        const lane = params.activeLanes.find((candidate) => candidate.reviewType === reviewType);
        if (!lane) {
            return `Operator-confirmed lane '${reviewType}' has no authenticated pending obligations in this batch.`;
        }
        const bindingRow = childRows.find((row) => extractGroupedLaneBindings(row.notes).has(reviewType));
        if (bindingRow) {
            return `Operator-confirmed lane '${reviewType}' is already bound to '${bindingRow.taskId}'.`;
        }
        const linkedChildren = parentLinkedPaths.get(path.resolve(lane.artifactPath));
        if (linkedChildren) {
            return `Operator-confirmed lane '${reviewType}' artifact is already linked from the parent to ${linkedChildren}.`;
        }
        let artifactEntryExists = true;
        try {
            fs.lstatSync(lane.artifactPath);
        } catch (error) {
            artifactEntryExists = !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
        }
        if (artifactEntryExists) {
            return `Operator-confirmed lane '${reviewType}' has a follow-up artifact entry; confirmation covers only ` +
                'lanes whose follow-up artifact was never published.';
        }
    }
    return null;
}

function materializeTaskQueueRows(params: {
    repoRoot: string;
    parentTaskId: string;
    lanes: readonly PreparedFollowUpLane[];
    materializationContext: FollowUpMaterializationContext;
    confirmedUnmaterializedReviewTypes?: readonly string[];
    stageFirstQueueWrite?: (content: string) => void;
}): TaskQueueMaterializationResult {
    const taskPath = path.join(params.repoRoot, TASK_QUEUE_FILENAME);
    const activeLanes = params.lanes.filter((lane) => lane.obligations.length > 0);
    const allObligations = activeLanes.flatMap((lane) => [...lane.obligations]);
    const allFingerprints = allObligations.map((obligation) => obligation.fingerprint);
    // An empty fresh review can still own earlier obligations in a grouped child.
    if (allObligations.length === 0 && (params.materializationContext.mode !== 'grouped_by_parent' || !fs.existsSync(taskPath))) {
        return {
            outcome: 'not_required',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: [],
            error_message: null,
            rollback_content: null
        };
    }
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: allFingerprints,
            error_message: null,
            rollback_content: null
        };
    }

    return withTaskQueueStatusSyncLock<TaskQueueMaterializationResult>(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: allFingerprints,
            error_message: message,
            rollback_content: null
        }),
        () => {
            const original = fs.readFileSync(taskPath, 'utf8');
            const newline = original.includes('\r\n') ? '\r\n' : '\n';
            const lines = original.split(/\r?\n/);
            const parsed = parseCanonicalActiveTaskQueue(original);
            if (!parsed.found) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    created: [],
                    reused: [],
                    blocked_fingerprints: allFingerprints,
                    error_message: parsed.unavailableReason || 'Canonical Active Queue table not found.',
                    rollback_content: null
                };
            }
            const parentRow = parsed.rows.find((row) => row.taskId === params.parentTaskId);
            if (!parentRow) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    created: [],
                    reused: [],
                    blocked_fingerprints: allFingerprints,
                    error_message: null,
                    rollback_content: null
                };
            }
            const closurePolicy = params.materializationContext.review_follow_up_task_closure_policy;
            if (
                isReviewFindingsFollowUpTaskId(params.parentTaskId)
                && closurePolicy.eligible
            ) {
                const expectedSourceNotesSha256 = normalizeHash(closurePolicy.source_notes_sha256);
                const currentNotesSha256 = sha256TextPayload(parentRow.notes);
                const preMaterializationNotesSha256 = sha256TextPayload(sourceParentNotes(parentRow.notes));
                const matchesCurrentCycle = expectedSourceNotesSha256 === currentNotesSha256;
                const matchesIdempotentRerun = expectedSourceNotesSha256 === preMaterializationNotesSha256;
                if (!expectedSourceNotesSha256 || (!matchesCurrentCycle && !matchesIdempotentRerun)) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused: [],
                        blocked_fingerprints: allFingerprints,
                        error_message:
                            `Current TASK.md parent notes for '${params.parentTaskId}' do not match the frozen ` +
                            'review follow-up closure-policy source_notes_sha256; descendant materialization is blocked.',
                        rollback_content: null
                    };
                }
            }
            const childTaskProfile = params.materializationContext.task_profile || parentRow.profile;

            if (params.materializationContext.mode === 'grouped_by_parent') {
                const groupFingerprint = params.materializationContext.group_fingerprint;
                if (!groupFingerprint) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused: [],
                        blocked_fingerprints: allFingerprints,
                        error_message: 'Grouped materialization context is missing its deterministic group fingerprint.',
                        rollback_content: null
                    };
                }
                const currentGroupedRows = parsed.rows.filter((row) => (
                    isParentFollowUpTaskId(params.parentTaskId, row.taskId)
                    && extractGroupedFingerprint(row.notes) === groupFingerprint
                ));
                if (currentGroupedRows.length > 1) {
                    return {
                        outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                        blocked_fingerprints: allFingerprints,
                        error_message: 'Multiple children claim the current grouped materialization; recovery is ambiguous.',
                        rollback_content: null
                    };
                }
                const currentGroupedRow = currentGroupedRows[0];
                const confirmedReviewTypes = params.confirmedUnmaterializedReviewTypes || [];
                const confirmationViolation = confirmedReviewTypes.length > 0
                    ? confirmedUnmaterializedLaneViolation({
                        repoRoot: params.repoRoot, parentTaskId: params.parentTaskId,
                        parentNotes: parentRow.notes, row: currentGroupedRow, activeLanes, confirmedReviewTypes,
                        rows: parsed.rows
                    })
                    : null;
                if (confirmationViolation) {
                    return {
                        outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                        blocked_fingerprints: allFingerprints,
                        error_message: confirmationViolation,
                        rollback_content: null,
                        admission_refusal_code: 'confirmed_lane'
                    };
                }
                const publications = checkGroupedPublicationRegistry(params.repoRoot, params.parentTaskId, parsed.rows);
                if (!publications) {
                    return {
                        outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                        blocked_fingerprints: allFingerprints, rollback_content: null,
                        error_message: 'Existing grouped child has incomplete or inconsistent authenticated lane registry (publication lineage).',
                        admission_refusal_code: currentGroupedRow ? 'current_registry' : 'reuse_bindings'
                    };
                }
                const registered = extractGroupedLaneBindings(currentGroupedRow?.notes || '');
                const incoming = params.lanes.filter(lane => lane.obligations.length || registered.has(lane.reviewType));
                if (currentGroupedRow && incoming.some((lane) => !groupedRowAdmitsLane({
                    repoRoot: params.repoRoot, parentTaskId: params.parentTaskId,
                    parentNotes: parentRow.notes, row: currentGroupedRow,
                    context: params.materializationContext, lane,
                    confirmedUnmaterializedReviewTypes: confirmedReviewTypes
                }))) {
                    return {
                        outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                        blocked_fingerprints: allFingerprints,
                        error_message: 'Current grouped child has incomplete or inconsistent authenticated lane registry.', rollback_content: null,
                        admission_refusal_code: 'current_registry'
                    };
                }
                const children = parsed.rows.filter(row => isParentFollowUpTaskId(params.parentTaskId, row.taskId));
                const priorRows = currentGroupedRow ? [] : children.filter(row => extractGroupedFingerprint(row.notes));
                const reusableRows = currentGroupedRow ? [] : priorRows.filter(row => groupedRowMatchesAuthenticatedReuse({
                    repoRoot: params.repoRoot, parentTaskId: params.parentTaskId,
                    context: params.materializationContext, row, parentNotes: parentRow.notes
                }));
                if (children.length > 1 || reusableRows.length > 1) {
                    return {
                        outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                        blocked_fingerprints: allFingerprints,
                        error_message: 'Authenticated grouped reuse matches multiple child tasks; recovery is ambiguous.',
                        rollback_content: null,
                        admission_refusal_code: 'reuse_ambiguous'
                    };
                }
                const groupedRow = currentGroupedRow || reusableRows[0];
                if (!groupedRow && children.length > 0) {
                    return {
                        outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                        blocked_fingerprints: allFingerprints,
                        error_message: 'Existing grouped child has incomplete or inconsistent authenticated reuse bindings.',
                        rollback_content: null,
                        admission_refusal_code: 'reuse_bindings'
                    };
                }
                // A bound lane with an empty new disposition still publishes its retained obligations.
                const bound = extractGroupedLaneBindings(groupedRow?.notes || '');
                const finalLanes = params.lanes.filter(lane => lane.obligations.length || bound.has(lane.reviewType));
                if (finalLanes.length) {
                    const violations = validateGroupedRequiredReviewCompletion({
                        repoRoot: params.repoRoot, reviewsRoot: finalLanes[0].reviewsRoot,
                        taskId: params.parentTaskId, reviewTypes: finalLanes.map(lane => lane.reviewType),
                        materializationContext: params.materializationContext, lanes: params.lanes,
                        requireWholeGroup: !currentGroupedRow || Boolean(params.stageFirstQueueWrite)
                    });
                    if (violations.length) return {
                        outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                        blocked_fingerprints: allFingerprints, rollback_content: null, prerequisite_failed: true,
                        error_message: violations.join(' ')
                    };
                }
                const groupedNotesFor = (existingNotes: string | undefined): string => activeLanes.reduce<string | undefined>(
                    (notes, lane) => buildGroupedTaskNotes({
                        parentTaskId: params.parentTaskId,
                        context: params.materializationContext,
                        reviewType: lane.reviewType,
                        obligations: lane.obligations,
                        validationArtifactSha256: lane.validationArtifactSha256,
                        validationResultSha256: lane.validationResultSha256,
                        dispositionArtifactSha256: lane.dispositionArtifactSha256,
                        dispositionResultSha256: lane.dispositionResultSha256,
                        receiptSha256: lane.receiptSha256,
                        retainedReviews: lane.retainedReviews,
                        artifactPath: normalizePath(path.relative(params.repoRoot, lane.artifactPath)),
                        existingNotes: notes
                    }),
                    existingNotes
                ) as string;
                const parentNotesFor = (childTaskId: string): string => activeLanes.reduce(
                    (notes, lane) => appendParentFollowUpNote(notes, [childTaskId], lane.artifactPath),
                    parentRow.notes
                );
                if (groupedRow) {
                    if (!/^(?:🟦\s*)?TODO$/iu.test(groupedRow.status)) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            created: [],
                            reused: [],
                            blocked_fingerprints: allFingerprints,
                            error_message: `Grouped follow-up task '${groupedRow.taskId}' is no longer pending and must not be mutated.`,
                            rollback_content: null
                        };
                    }
                    for (const lane of params.lanes.filter(candidate => bound.has(candidate.reviewType))) {
                        const artifact = readJsonFile(lane.artifactPath, 'Bound grouped lane').value;
                        const retained = artifact && resolveRetainedGroupedObligations({
                            repoRoot: params.repoRoot, taskId: params.parentTaskId, reviewType: lane.reviewType,
                            followUpArtifactPath: lane.artifactPath, artifact
                        });
                        if (!retained || path.resolve(params.repoRoot, bound.get(lane.reviewType)?.artifactPath || '')
                            !== path.resolve(lane.artifactPath)) {
                            return {
                                outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                                blocked_fingerprints: allFingerprints, rollback_content: null,
                                error_message: 'Bound grouped lane obligations cannot be authenticated at their registered path.'
                            };
                        }
                        if (retained.references.length) {
                            lane.retainedReviews = retained.references;
                            for (const item of lane.obligations) retained.obligations.delete(item.fingerprint);
                            lane.obligations = [...lane.obligations, ...retained.obligations.values()];
                            if (!activeLanes.includes(lane)) activeLanes.push(lane);
                            allObligations.push(...retained.obligations.values());
                        }
                    }
                    const nextNotes = groupedNotesFor(groupedRow.notes);
                    const highestPriority = [
                        groupedRow.priority,
                        ...allObligations.map((obligation) => (
                            priorityForSeverity(obligation.disposition_item.severity, parentRow.priority)
                        ))
                    ].sort()[0] || parentRow.priority;
                    const priorityUpdatedLine = replaceTaskMdTableCell(
                        groupedRow.rawLine,
                        2,
                        ` ${highestPriority} `
                    );
                    const updatedLine = priorityUpdatedLine
                        ? replaceTaskMdTableCell(priorityUpdatedLine, 8, ` ${nextNotes} `)
                        : null;
                    if (!updatedLine) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            created: [],
                            reused: [],
                            blocked_fingerprints: allFingerprints,
                            error_message: 'Failed to update grouped TASK.md follow-up priority and notes.',
                            rollback_content: null
                        };
                    }
                    lines[groupedRow.lineIndex] = updatedLine;
                    const nextParentNotes = parentNotesFor(groupedRow.taskId);
                    const updatedParentLine = replaceTaskMdTableCell(
                        parentRow.rawLine,
                        8,
                        ` ${nextParentNotes} `
                    );
                    if (!updatedParentLine) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            created: [],
                            reused: [],
                            blocked_fingerprints: allFingerprints,
                            error_message: 'Failed to update grouped TASK.md parent artifact registry.',
                            rollback_content: null
                        };
                    }
                    lines[parentRow.lineIndex] = updatedParentLine;
                    const nextContent = formatActiveTaskQueueTable(lines.join(newline));
                    if (nextContent !== original && publications.has(groupedRow.taskId)) {
                        return { outcome: 'write_failed', task_path: normalizePath(taskPath), created: [], reused: [],
                            blocked_fingerprints: allFingerprints, rollback_content: null,
                            error_message: 'Published rebind evidence does not authorize changing the grouped child.' };
                    }
                    if (nextContent !== original) {
                        writeTaskQueueFile(taskPath, nextContent);
                    }
                    return {
                        previous_publication: publications.get(groupedRow.taskId),
                        outcome: nextContent === original ? 'already_materialized' : 'updated',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused: allObligations.map((obligation) => ({
                            task_id: groupedRow.taskId,
                            fingerprint: obligation.fingerprint
                        })),
                        blocked_fingerprints: [],
                        error_message: null,
                        rollback_content: nextContent !== original ? original : null
                    };
                }

                if (!allObligations.length) {
                    return { outcome: 'not_required', task_path: normalizePath(taskPath), created: [], reused: [],
                        blocked_fingerprints: [], error_message: null, rollback_content: null };
                }
                // No child exists for the current group yet, so every incoming lane
                // is bound to one new child in this single TASK.md write.
                const [groupedTaskId] = allocateParentDerivedTaskIds({
                    parentTaskId: params.parentTaskId,
                    existingTaskIds: parsed.rows.map((row) => row.taskId),
                    kind: 'followup',
                    count: 1
                });
                const highestPriority = allObligations
                    .map((obligation) => priorityForSeverity(obligation.disposition_item.severity, parentRow.priority))
                    .sort()[0] || parentRow.priority;
                const groupedNotes = groupedNotesFor(undefined);
                const groupedTaskLine = `| ${[
                    groupedTaskId,
                    'TODO',
                    highestPriority,
                    sanitizeTaskCell(parentRow.area, 'workflow/review-follow-up-tasks', 80),
                    'Address grouped deferred review findings and residual risks',
                    sanitizeTaskCell(parentRow.owner, 'gpt-5.5', 80),
                    nowIso().slice(0, 10),
                    sanitizeTaskCell(childTaskProfile, parentRow.profile || 'balanced', 40),
                    groupedNotes
                ].join(' | ')} |`;
                const nextParentNotes = parentNotesFor(groupedTaskId);
                const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${nextParentNotes} `);
                if (!updatedParentLine) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused: [],
                        blocked_fingerprints: allFingerprints,
                        error_message: 'Failed to replace TASK.md parent notes cell.',
                        rollback_content: null
                    };
                }
                lines[parentRow.lineIndex] = updatedParentLine;
                lines.splice(findInsertionLineIndex(parentRow, parsed.rows) + 1, 0, groupedTaskLine);
                const nextContent = formatActiveTaskQueueTable(lines.join(newline));
                if (params.stageFirstQueueWrite) params.stageFirstQueueWrite(nextContent);
                else writeTaskQueueFile(taskPath, nextContent);
                return {
                    outcome: 'updated',
                    task_path: normalizePath(taskPath),
                    created: allObligations.map((obligation) => ({
                        task_id: groupedTaskId,
                        fingerprint: obligation.fingerprint
                    })),
                    reused: [],
                    blocked_fingerprints: [],
                    error_message: null,
                    rollback_content: original
                };
            }

            if (activeLanes.length !== 1) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    created: [],
                    reused: [],
                    blocked_fingerprints: allFingerprints,
                    error_message: 'Several review lanes can be materialized together only in grouped_by_parent mode.',
                    rollback_content: null
                };
            }
            const [lane] = activeLanes;
            const existingByFingerprint = new Map<string, string>();
            for (const row of parsed.rows) {
                if (!isParentFollowUpTaskId(params.parentTaskId, row.taskId)) {
                    continue;
                }
                const fingerprint = extractExistingFingerprint(row.notes);
                if (fingerprint) {
                    existingByFingerprint.set(fingerprint, row.taskId);
                }
            }

            const reused: MaterializedTaskReference[] = [];
            const toCreate: FollowUpObligation[] = [];
            for (const obligation of lane.obligations) {
                const existingTaskId = existingByFingerprint.get(obligation.fingerprint);
                if (existingTaskId) {
                    reused.push({
                        task_id: existingTaskId,
                        fingerprint: obligation.fingerprint
                    });
                    continue;
                }
                toCreate.push(obligation);
            }

            const allocatedTaskIds = allocateParentDerivedTaskIds({
                parentTaskId: params.parentTaskId,
                existingTaskIds: parsed.rows.map((row) => row.taskId),
                kind: 'followup',
                count: toCreate.length
            });
            const created: MaterializedTaskReference[] = [];
            const today = nowIso().slice(0, 10);
            const insertedRows = toCreate.map((obligation, index) => {
                const taskId = allocatedTaskIds[index];
                created.push({
                    task_id: taskId,
                    fingerprint: obligation.fingerprint
                });
                const row = [
                    taskId,
                    'TODO',
                    priorityForSeverity(obligation.disposition_item.severity, parentRow.priority),
                    sanitizeTaskCell(parentRow.area, 'workflow/review-follow-up-tasks', 80),
                    buildTaskTitle(lane.reviewType, obligation),
                    sanitizeTaskCell(parentRow.owner, 'gpt-5.5', 80),
                    today,
                    sanitizeTaskCell(childTaskProfile, parentRow.profile || 'balanced', 40),
                    buildTaskNotes({
                        parentTaskId: params.parentTaskId,
                        reviewType: lane.reviewType,
                        obligation,
                        validationArtifactSha256: lane.validationArtifactSha256,
                        validationResultSha256: lane.validationResultSha256,
                        dispositionArtifactSha256: lane.dispositionArtifactSha256,
                        dispositionResultSha256: lane.dispositionResultSha256,
                        receiptSha256: lane.receiptSha256,
                        taskProfile: childTaskProfile,
                        taskProfileSource: params.materializationContext.task_profile_source
                    })
                ];
                return `| ${row.join(' | ')} |`;
            });

            if (created.length > 0) {
                const nextParentNotes = appendParentFollowUpNote(
                    parentRow.notes,
                    created.map((item) => item.task_id),
                    lane.artifactPath
                );
                const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${nextParentNotes} `);
                if (!updatedParentLine) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused,
                        blocked_fingerprints: toCreate.map((obligation) => obligation.fingerprint),
                        error_message: 'Failed to replace TASK.md parent notes cell.',
                        rollback_content: null
                    };
                }
                lines[parentRow.lineIndex] = updatedParentLine;
                const insertionLineIndex = findInsertionLineIndex(parentRow, parsed.rows);
                lines.splice(insertionLineIndex + 1, 0, ...insertedRows);
            }

            const nextContent = formatActiveTaskQueueTable(lines.join(newline));
            if (nextContent !== original) {
                writeTaskQueueFile(taskPath, nextContent);
            }

            return {
                outcome: created.length > 0 ? 'updated' : 'already_materialized',
                task_path: normalizePath(taskPath),
                created,
                reused,
                blocked_fingerprints: [],
                error_message: null,
                rollback_content: nextContent !== original ? original : null
            };
        }
    );
}

function rollbackTaskQueueRows(taskPath: string, rollbackContent: string | null): string | null {
    if (rollbackContent === null) {
        return null;
    }
    try {
        writeTaskQueueFile(taskPath, rollbackContent);
        return null;
    } catch (error) {
        return `TASK.md rollback failed after follow-up artifact write failure: ${errorMessage(error)}.`;
    }
}

function buildMaterializationItems(params: {
    baseItems: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    obligations: readonly FollowUpObligation[];
    queueResult: TaskQueueMaterializationResult | null;
}): ReviewFindingsFollowUpTaskMaterializationItem[] {
    const created = new Map((params.queueResult?.created || []).map((item) => [item.fingerprint, item.task_id]));
    const reused = new Map((params.queueResult?.reused || []).map((item) => [item.fingerprint, item.task_id]));
    const blockedFingerprints = new Set(params.queueResult?.blocked_fingerprints || []);
    const obligationItems = params.obligations.map((obligation) => {
        const taskId = created.get(obligation.fingerprint) || reused.get(obligation.fingerprint) || null;
        const status: ReviewFindingFollowUpItemStatus = created.has(obligation.fingerprint)
            ? 'created'
            : (reused.has(obligation.fingerprint)
                ? 'already_materialized'
                : (blockedFingerprints.has(obligation.fingerprint) ? 'blocked' : 'blocked'));
        return buildArtifactItem({
            item: obligation.disposition_item,
            status,
            taskId,
            fingerprint: obligation.fingerprint,
            title: obligation.title,
            description: obligation.description,
            evidenceLocations: obligation.evidence_locations,
            remediation: obligation.remediation
        });
    });
    return [...params.baseItems, ...obligationItems].sort((left, right) => (
        `${left.source_item_kind}:${left.source_item_id}`.localeCompare(`${right.source_item_kind}:${right.source_item_id}`)
    ));
}

function toValidationStatus(artifact: ReviewFindingsValidationArtifact | null): 'accepted' | 'rejected' | 'unknown' {
    if (!artifact) {
        return 'unknown';
    }
    return artifact.validation_result.status;
}

function buildArtifact(params: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    status: ReviewFollowUpMaterializationStatus;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
    validationArtifactPath: string | null;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    receiptPath: string | null;
    receiptSha256: string | null;
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    violations: readonly string[];
}): ReviewFindingsFollowUpTasksArtifact {
    const createdTaskCount = new Set(params.items
        .filter((item) => item.materialization_status === 'created')
        .map((item) => item.task_id)
        .filter(Boolean)).size;
    const reusedTaskCount = new Set(params.items
        .filter((item) => item.materialization_status === 'already_materialized')
        .map((item) => item.task_id)
        .filter(Boolean)).size;
    const blockedTaskCount = params.items.filter((item) => (
        item.materialization_status === 'blocked'
        || item.materialization_status === 'requires_fix_now'
    )).length;
    const notRequiredCount = params.items.filter((item) => item.materialization_status === 'not_required').length;
    return {
        schema_version: REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION,
        artifact_type: REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE,
        task_id: params.taskId,
        review_type: params.reviewType,
        status: params.status,
        created_at_utc: nowIso(),
        materialization_policy: resolveFollowUpMaterializationContext(
            params.repoRoot,
            path.dirname(params.dispositionArtifactPath),
            params.taskId
        ),
        source_disposition: {
            artifact_path: normalizePath(params.dispositionArtifactPath),
            artifact_sha256: params.dispositionArtifactSha256,
            disposition_result_sha256: params.dispositionResultSha256
        },
        source_validation: {
            artifact_path: params.validationArtifactPath ? normalizePath(params.validationArtifactPath) : null,
            artifact_sha256: params.validationArtifactSha256,
            validation_result_sha256: params.validationResultSha256,
            status: toValidationStatus(params.validationArtifact),
            accepted: params.validationArtifact ? params.validationArtifact.validation_result.accepted : null
        },
        source_receipt: {
            receipt_path: params.receiptPath ? normalizePath(params.receiptPath) : null,
            receipt_sha256: params.receiptSha256
        },
        items: [...params.items],
        summary: {
            item_count: params.items.length,
            follow_up_obligation_count: params.items.filter((item) => item.action === 'create_follow_up').length,
            created_task_count: createdTaskCount,
            reused_task_count: reusedTaskCount,
            blocked_task_count: blockedTaskCount,
            not_required_count: notRequiredCount
        },
        violations: [...params.violations]
    };
}

function deriveReceiptPath(params: {
    repoRoot: string;
    explicitReceiptPath?: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    dispositionArtifactPath: string;
}): string | null {
    if (params.explicitReceiptPath) {
        return resolveInputPathInsideRepo(params.repoRoot, params.explicitReceiptPath, 'ReceiptPath');
    }
    const reviewArtifactPath = normalizeText(
        params.validationArtifact?.validation_result.bindings.output.review_artifact_path || ''
    );
    if (reviewArtifactPath && /\.md$/u.test(reviewArtifactPath)) {
        return resolveInputPathInsideRepo(params.repoRoot, reviewArtifactPath, 'ReviewArtifactPath')
            .replace(/\.md$/u, '-receipt.json');
    }
    if (/-findings-disposition\.json$/u.test(params.dispositionArtifactPath)) {
        return params.dispositionArtifactPath.replace(/-findings-disposition\.json$/u, '-receipt.json');
    }
    return null;
}

function hasFixNowMaterializationItems(
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[]
): boolean {
    return items.some((item) => item.materialization_status === 'requires_fix_now');
}

function validateHashField(
    violations: string[],
    subject: string,
    actual: unknown,
    expected: string | null
): void {
    const normalizedActual = normalizeHash(actual);
    if (!expected) {
        return;
    }
    if (normalizedActual !== expected) {
        violations.push(`${subject} mismatch: expected ${expected}, found ${normalizedActual || 'missing'}.`);
    }
}

function validatePathField(
    violations: string[],
    subject: string,
    actual: unknown,
    expectedPath: string
): void {
    const actualText = normalizeText(actual);
    if (!actualText) {
        violations.push(`${subject} is missing.`);
        return;
    }
    const normalizedActual = normalizePath(path.isAbsolute(actualText) ? path.resolve(actualText) : actualText);
    const normalizedExpected = normalizePath(expectedPath);
    if (normalizedActual !== normalizedExpected) {
        violations.push(`${subject} mismatch: expected ${normalizedExpected}, found ${normalizedActual}.`);
    }
}

function validateReceiptEvidence(params: {
    receipt: Record<string, unknown> | null;
    receiptPath: string | null;
    taskId: string;
    reviewType: string;
    validationArtifactPath: string;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
}): { receiptSha256: string | null; violations: string[] } {
    const violations: string[] = [];
    const receiptSha256 = params.receiptPath ? fileSha256(params.receiptPath) : null;
    if (!params.receiptPath || !params.receipt) {
        return {
            receiptSha256,
            violations: ['Review receipt is required to carry receipt hash evidence for materialized follow-up tasks.']
        };
    }
    if (normalizeText(params.receipt.task_id) !== params.taskId) {
        violations.push(`Review receipt task_id mismatch: expected ${params.taskId}, found ${normalizeText(params.receipt.task_id) || 'missing'}.`);
    }
    if (normalizeText(params.receipt.review_type) !== params.reviewType) {
        violations.push(`Review receipt review_type mismatch: expected ${params.reviewType}, found ${normalizeText(params.receipt.review_type) || 'missing'}.`);
    }
    const validationReference = isPlainRecord(params.receipt.review_findings_validation)
        ? params.receipt.review_findings_validation
        : null;
    if (!validationReference) {
        violations.push('Review receipt is missing review_findings_validation evidence.');
    } else {
        validatePathField(violations, 'Review receipt review_findings_validation.artifact_path', validationReference.artifact_path, normalizePath(params.validationArtifactPath));
        validateHashField(violations, 'Review receipt review_findings_validation.artifact_sha256', validationReference.artifact_sha256, params.validationArtifactSha256);
        validateHashField(violations, 'Review receipt review_findings_validation.validation_result_sha256', validationReference.validation_result_sha256, params.validationResultSha256);
        if (validationReference.accepted !== true) {
            violations.push('Review receipt review_findings_validation.accepted must be true.');
        }
        if (validationReference.status !== 'accepted') {
            violations.push('Review receipt review_findings_validation.status must be accepted.');
        }
    }
    const dispositionReference = isPlainRecord(params.receipt.review_findings_disposition_artifact)
        ? params.receipt.review_findings_disposition_artifact
        : null;
    if (!dispositionReference) {
        violations.push('Review receipt is missing review_findings_disposition_artifact evidence.');
    } else {
        validatePathField(violations, 'Review receipt review_findings_disposition_artifact.artifact_path', dispositionReference.artifact_path, normalizePath(params.dispositionArtifactPath));
        validateHashField(violations, 'Review receipt review_findings_disposition_artifact.artifact_sha256', dispositionReference.artifact_sha256, params.dispositionArtifactSha256);
        validateHashField(violations, 'Review receipt review_findings_disposition_artifact.disposition_result_sha256', dispositionReference.disposition_result_sha256, params.dispositionResultSha256);
    }
    const embeddedDisposition = isPlainRecord(params.receipt.review_findings_disposition)
        ? params.receipt.review_findings_disposition
        : null;
    if (!embeddedDisposition) {
        violations.push('Review receipt is missing review_findings_disposition evidence.');
    } else {
        validateHashField(
            violations,
            'Review receipt review_findings_disposition payload sha256',
            sha256RedactedJsonPayload(embeddedDisposition),
            params.dispositionResultSha256
        );
    }
    const contract = isPlainRecord(params.receipt.review_output_contract)
        ? params.receipt.review_output_contract
        : null;
    if (!contract) {
        violations.push('Review receipt is missing review_output_contract evidence.');
    } else {
        validateHashField(violations, 'Review receipt review_output_contract.validation_artifact_sha256', contract.validation_artifact_sha256, params.validationArtifactSha256);
        validateHashField(violations, 'Review receipt review_output_contract.validation_result_sha256', contract.validation_result_sha256, params.validationResultSha256);
        validateHashField(violations, 'Review receipt review_output_contract.disposition_artifact_sha256', contract.disposition_artifact_sha256, params.dispositionArtifactSha256);
        validateHashField(violations, 'Review receipt review_output_contract.disposition_result_sha256', contract.disposition_result_sha256, params.dispositionResultSha256);
    }
    return { receiptSha256, violations };
}

function validateDispositionClosurePolicyBinding(params: {
    disposition: ReviewFindingsDispositionArtifact;
    materializationContext: FollowUpMaterializationContext;
}): string[] {
    const policy = params.disposition.policy as unknown as Record<string, unknown>;
    const dispositionClosurePolicy = policy.review_follow_up_task_closure_policy;
    const currentClosurePolicy = params.materializationContext.review_follow_up_task_closure_policy;
    if (dispositionClosurePolicy === undefined) {
        return currentClosurePolicy.eligible || currentClosurePolicy.configured
            ? [
                'Review findings disposition artifact is missing the frozen follow-up task closure-policy binding.'
            ]
            : [];
    }
    const violations = getReviewFollowUpTaskClosurePolicySnapshotViolations(dispositionClosurePolicy);
    if (violations.length > 0) {
        return violations.map((violation) => (
            `Review findings disposition closure-policy binding ${violation}`
        ));
    }
    if (sha256JsonPayload(dispositionClosurePolicy) !== sha256JsonPayload(currentClosurePolicy)) {
        return [
            'Review findings disposition closure-policy snapshot does not match the frozen current preflight snapshot.'
        ];
    }
    return [];
}

function validateGroupedSourceCycleEvidence(params: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    materializationContext: FollowUpMaterializationContext;
    validationArtifact: ReviewFindingsValidationArtifact;
    receipt: Record<string, unknown> | null;
    receiptPath: string | null;
}): string[] {
    if (params.materializationContext.mode !== 'grouped_by_parent') {
        return [];
    }
    const violations: string[] = [];
    const expectedPreflightSha256 = params.materializationContext.preflight_sha256;
    const expectedCompileTimestamp = params.materializationContext.compile_gate_timestamp;
    if (!expectedPreflightSha256 || !expectedCompileTimestamp) {
        return ['Grouped follow-up source evidence cannot be bound because the current materialization cycle is incomplete.'];
    }

    const reused = params.receipt?.reused_existing_review === true && params.receiptPath
        ? authenticatedGroupedReuse({
            repoRoot: params.repoRoot, reviewsRoot: params.reviewsRoot, taskId: params.taskId,
            reviewType: params.reviewType, context: params.materializationContext, receiptPath: params.receiptPath
        })
        : null;
    if (reused && !reused.evidence) return reused.diagnostics;
    if (!reused) {
        validateHashField(
            violations,
            'Review findings validation preflight_sha256',
            params.validationArtifact.validation_result.bindings.scope.preflight_sha256,
            expectedPreflightSha256
        );
    }
    validateHashField(
        violations,
        'Review receipt preflight_sha256',
        params.receipt?.preflight_sha256,
        expectedPreflightSha256
    );

    const contextBinding = params.validationArtifact.validation_result.bindings.context;
    const contextPathText = reused?.evidence?.reviewContextPath || normalizeText(contextBinding.review_context_path);
    const expectedContextSha256 = reused?.evidence
        ? fileSha256(reused.evidence.reviewContextPath)
        : normalizeHash(contextBinding.review_context_sha256);
    if (!contextPathText || !expectedContextSha256) {
        violations.push('Grouped follow-up source validation is missing its review context path or sha256 binding.');
        return violations;
    }

    let contextPath: string;
    try {
        contextPath = resolveInputPathInsideRepo(params.repoRoot, contextPathText, 'ReviewContextPath');
    } catch (error: unknown) {
        violations.push(error instanceof Error ? error.message : String(error));
        return violations;
    }
    const normalizedReviewsRoot = `${normalizePath(path.resolve(params.reviewsRoot)).replace(/\/$/u, '')}/`;
    if (!normalizePath(contextPath).startsWith(normalizedReviewsRoot)) {
        violations.push(`ReviewContextPath must stay inside the reviews root: ${normalizedReviewsRoot}`);
        return violations;
    }
    const contextRead = readJsonFile(contextPath, 'Review context artifact');
    violations.push(...contextRead.violations);
    validateHashField(
        violations,
        'Review context artifact sha256',
        fileSha256(contextPath),
        expectedContextSha256
    );
    validateHashField(
        violations,
        'Review receipt review_context_sha256',
        params.receipt?.review_context_sha256,
        expectedContextSha256
    );
    if (!contextRead.value) {
        return violations;
    }
    if (normalizeText(contextRead.value.task_id) !== params.taskId) {
        violations.push('Review context task_id does not match the grouped follow-up parent task.');
    }
    if (normalizeText(contextRead.value.review_type) !== params.reviewType) {
        violations.push('Review context review_type does not match the grouped follow-up source lane.');
    }
    const preflightPath = path.join(params.reviewsRoot, `${params.taskId}-preflight.json`);
    const preflightRead = readJsonFile(preflightPath, 'Preflight artifact');
    violations.push(...preflightRead.violations);
    if (!preflightRead.value) {
        return violations;
    }
    try {
        const dependencyGraph = resolveCompiledReviewDependencyGraphFromPreflight(preflightRead.value);
        if (
            dependencyGraph
            && (
                dependencyGraph.full_suite_barrier.enabled !== true
                || !dependencyGraph.full_suite_barrier.before_review_ids.includes(params.reviewType)
            )
        ) {
            return violations;
        }
    } catch (error: unknown) {
        violations.push(
            `Grouped follow-up source full-suite policy binding is invalid: ${errorMessage(error)}`
        );
        return violations;
    }
    const fullSuite = isPlainRecord(contextRead.value.full_suite_validation)
        ? contextRead.value.full_suite_validation
        : null;
    const cycleBinding = fullSuite && isPlainRecord(fullSuite.cycle_binding)
        ? fullSuite.cycle_binding
        : null;
    if (!fullSuite || fullSuite.cycle_binding_valid !== true || fullSuite.matches_current_preflight !== true
        || fullSuite.matches_current_compile_gate !== true) {
        violations.push('Review context full-suite evidence is not valid for the current preflight and compile cycle.');
    }
    validateHashField(
        violations,
        'Review context full-suite preflight_sha256',
        cycleBinding?.preflight_sha256,
        expectedPreflightSha256
    );
    const contextCompileTimestamp = normalizeText(
        fullSuite?.compile_gate_timestamp_utc || cycleBinding?.compile_gate_timestamp
    );
    if (contextCompileTimestamp !== expectedCompileTimestamp) {
        violations.push(
            `Review context compile gate timestamp mismatch: expected ${expectedCompileTimestamp}, ` +
            `found ${contextCompileTimestamp || 'missing'}.`
        );
    }
    return violations;
}

function needsCompleteGroup(
    supplied: readonly string[], expected: ReadonlySet<string>, requireExactSet: boolean
): boolean {
    return [...expected].some(type => !supplied.includes(type))
        || (requireExactSet && supplied.some(type => !expected.has(type)));
}

function validateGroupedRequiredReviewCompletion(params: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewTypes: readonly string[];
    materializationContext: FollowUpMaterializationContext;
    lanes?: readonly PreparedFollowUpLane[];
    requireWholeGroup?: boolean;
}): string[] {
    if (params.materializationContext.mode !== 'grouped_by_parent') {
        return [];
    }
    const canonicalReviewsRoot = joinOrchestratorPath(params.repoRoot, path.join('runtime', 'reviews'));
    if (path.resolve(params.reviewsRoot) !== path.resolve(canonicalReviewsRoot)) {
        return ['Grouped follow-up publication requires the canonical reviews root.'];
    }
    const preflightPath = path.join(canonicalReviewsRoot, `${params.taskId}-preflight.json`);
    const preflightRead = readJsonFile(preflightPath, 'Preflight artifact');
    if (!preflightRead.value) {
        return [...preflightRead.violations, 'Grouped follow-up materialization requires the current preflight artifact.'];
    }
    const preflightSha256 = fileSha256(preflightPath);
    if (!preflightSha256 || preflightSha256 !== params.materializationContext.preflight_sha256) {
        return ['Grouped follow-up preflight changed before required review completion could be verified.'];
    }
    const eventsRoot = joinOrchestratorPath(params.repoRoot, path.join('runtime', 'task-events'));
    const requiredReviews = isPlainRecord(preflightRead.value.required_reviews)
        ? preflightRead.value.required_reviews
        : {};
    const reviewReadinessViolations: string[] = [];
    const configuredRequiredReviewTypes = Object.keys(requiredReviews)
        .filter((key) => requiredReviews[key] === true)
        .sort();
    const timelinePath = path.join(eventsRoot, params.taskId + '.jsonl');
    let completionPassed = false;
    let groupedCloseout = false;
    const recordedReceipts = new Map<string, string>();
    const inspection = inspectTaskEventFile(timelinePath, params.taskId, { onIntegrityEvent(event) {
        switch (event.event_type) {
        case 'COMPLETION_GATE_PASSED':
            completionPassed = event.outcome === 'PASS' && event.actor === 'gate';
            groupedCloseout = isPlainRecord(event.details) && event.details.grouped_follow_up_closeout === true;
            break;
        case 'COMPLETION_GATE_FAILED':
        case 'TASK_MODE_ENTERED':
        case 'PREFLIGHT_CLASSIFIED':
        case 'COMPILE_GATE_PASSED':
        case 'COMPILE_GATE_FAILED':
            recordedReceipts.clear();
            completionPassed = false;
            break;
        case 'REVIEW_RECORDED': {
            const details = isPlainRecord(event.details) ? event.details : {};
            const lane = normalizeText(details.review_type ?? details.reviewType).toLowerCase();
            const receiptHash = normalizeHash(details.receipt_sha256 ?? details.receiptSha256);
            if (event.actor === 'gate' && event.outcome === 'PASS' && lane && receiptHash) {
                recordedReceipts.set(lane, receiptHash);
            } else if (lane) recordedReceipts.delete(lane);
            completionPassed = false;
            break;
        }
        case 'REVIEW_GATE_FAILED':
        case 'REVIEW_GATE_PASSED':
        case 'REVIEW_GATE_PASSED_WITH_OVERRIDE':
            completionPassed = false;
        }
    } });
    const requiresBoundCompletion = groupedCloseout || configuredRequiredReviewTypes.length > 0;
    if (!completionPassed || inspection.violations.length
        || (requiresBoundCompletion && !readFreshGroupedCompletion(params.repoRoot, params.taskId))
        || fs.existsSync(getCompletionGateFinalizationLockPath(params.reviewsRoot, params.taskId))) {
        reviewReadinessViolations.push('Grouped follow-up publication requires a current passing completion gate with finalization finished.');
    }
    for (const reviewType of params.reviewTypes) {
        if (configuredRequiredReviewTypes.length && requiredReviews[reviewType] !== true) {
            reviewReadinessViolations.push(`Grouped follow-up review lane '${reviewType}' is not configured in current required_reviews.`);
        }
    }
    const expectedLaneTypes = new Set<string>();
    for (const reviewType of configuredRequiredReviewTypes) {
        const state = readReviewArtifactState(
            params.reviewsRoot,
            params.taskId,
            reviewType,
            preflightPath,
            preflightSha256,
            preflightRead.value,
            params.repoRoot
        );
        if (!state.ready || !reviewStateHasSatisfiedEvidence(
            params.repoRoot,
            eventsRoot,
            params.taskId,
            state
        )) {
            reviewReadinessViolations.push(
                `Grouped follow-up required review lane '${reviewType}' is not complete with independently ` +
                'attested evidence for the current cycle: ' +
                `${state.violations.join(' ') || state.failureReason || 'review evidence is not ready'}.`
            );
        }
        if ((state.reviewFindingsDisposition?.counts_by_action.create_follow_up ?? 0) > 0) {
            expectedLaneTypes.add(reviewType);
        }
    }
    if (params.requireWholeGroup && needsCompleteGroup(params.reviewTypes, expectedLaneTypes, requiresBoundCompletion)) {
        reviewReadinessViolations.push('Grouped follow-up publication requires every deferred review lane: ' +
            [...expectedLaneTypes].sort().join(', ') + '.');
    }
    for (const lane of params.lanes || []) {
        const receiptPath = path.join(canonicalReviewsRoot, `${params.taskId}-${lane.reviewType}-receipt.json`);
        const dispositionPath = path.join(canonicalReviewsRoot, `${params.taskId}-${lane.reviewType}-findings-disposition.json`);
        const artifactPath = getReviewFindingsFollowUpTasksArtifactPath(dispositionPath);
        const canonical = prepareFollowUpLane({
            repoRoot: params.repoRoot, taskId: params.taskId, reviewType: lane.reviewType, receiptPath
        }, true).lane;
        if (!canonical || lane.receiptPath !== receiptPath || lane.dispositionArtifactPath !== dispositionPath
            || lane.artifactPath !== artifactPath
            || (groupedCloseout && lane.receiptSha256 !== recordedReceipts.get(lane.reviewType))
            || buildGroupedSourceBindingSha256(lane) !== buildGroupedSourceBindingSha256(canonical)
            || lane.materializationContext.group_fingerprint !== canonical.materializationContext.group_fingerprint
            || sha256JsonPayload(lane.obligations.map(item => item.fingerprint).sort())
                !== sha256JsonPayload(canonical.obligations.map(item => item.fingerprint).sort())) {
            reviewReadinessViolations.push(`Grouped follow-up lane '${lane.reviewType}' does not match its canonical recorded receipt, disposition and obligations.`);
        }
    }
    return reviewReadinessViolations;
}

function tryWriteFollowUpArtifact(filePath: string, artifact: unknown, repoRoot: string, label: string): string | null {
    return tryWriteFollowUpArtifactContent(filePath, `${JSON.stringify(artifact, null, 2)}\n`, repoRoot, label);
}

function tryWriteFollowUpArtifactContent(
    filePath: string,
    content: string | Buffer,
    repoRoot: string,
    label: string
): string | null {
    let temporaryPath: string | null = null;
    try {
        const parentPath = fs.realpathSync(path.dirname(filePath));
        resolveInputPathInsideRepo(fs.realpathSync(repoRoot), parentPath, 'Follow-up artifact parent');
        if (fs.existsSync(filePath)) {
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Follow-up artifact path is an unsafe file link.');
        }
        temporaryPath = path.join(parentPath, `.garda-follow-up-${randomUUID()}.tmp`);
        fs.writeFileSync(temporaryPath, content, typeof content === 'string' ? { encoding: 'utf8', flag: 'wx' } : { flag: 'wx' });
        // Rename replaces the directory entry rather than following a substituted
        // destination link between the ownership check and the final write.
        fs.renameSync(temporaryPath, path.join(parentPath, path.basename(filePath)));
        return null;
    } catch (error) {
        return `${label} write failed: ${errorMessage(error)}`;
    } finally {
        if (temporaryPath && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

function buildBlockedResult(params: {
    suppressDiagnostic?: boolean;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPath: string;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
    validationArtifactPath: string | null;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    receiptPath: string | null;
    receiptSha256: string | null;
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    violations: readonly string[];
}): ReviewFindingsFollowUpTaskMaterializationResult {
    const violations = [...params.violations];
    const artifact = buildArtifact({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        reviewType: params.reviewType,
        status: 'BLOCKED',
        dispositionArtifactPath: params.dispositionArtifactPath,
        dispositionArtifactSha256: params.dispositionArtifactSha256,
        dispositionResultSha256: params.dispositionResultSha256,
        validationArtifactPath: params.validationArtifactPath,
        validationArtifactSha256: params.validationArtifactSha256,
        validationResultSha256: params.validationResultSha256,
        validationArtifact: params.validationArtifact,
        receiptPath: params.receiptPath,
        receiptSha256: params.receiptSha256,
        items: params.items,
        violations
    });
    // Rejected mutable evidence cannot decide whether prior provenance survives.
    // Diagnostics always use a separate path and never authorize recovery.
    const diagnosticPath = params.artifactPath.replace(/\.json$/iu, '') + '-blocked.json';
    const writeViolation = params.suppressDiagnostic ? null : tryWriteFollowUpArtifact(
        diagnosticPath, artifact, params.repoRoot, 'Review findings follow-up blocked diagnostic'
    );
    if (writeViolation) {
        violations.push(writeViolation);
    }
    return {
        status: 'BLOCKED',
        task_id: params.taskId,
        review_type: params.reviewType,
        artifact_path: normalizePath(diagnosticPath),
        created_task_ids: [],
        reused_task_ids: [],
        violations,
        output_lines: formatOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            status: 'BLOCKED',
            marker: 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_BLOCKED',
            action: 'Resolve review findings follow-up materialization blockers, then rerun this gate.',
            reason: violations.join(' '),
            artifactPath: diagnosticPath,
            violations
        })
    };
}

interface PreparedFollowUpLane extends FollowUpQueueLane {
    suppressDiagnostic: boolean;
    taskId: string;
    dispositionArtifactPath: string;
    disposition: ReviewFindingsDispositionArtifact;
    validationArtifactPath: string;
    validationArtifact: ReviewFindingsValidationArtifact;
    receiptPath: string | null;
    materializationContext: FollowUpMaterializationContext;
    baseItems: ReviewFindingsFollowUpTaskMaterializationItem[];
}

type FollowUpLanePreparation =
    | { blocked: ReviewFindingsFollowUpTaskMaterializationResult; lane: null }
    | { blocked: null; lane: PreparedFollowUpLane };

function buildPreparedLaneBlockedResult(
    repoRoot: string,
    lane: PreparedFollowUpLane,
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[],
    violations: readonly string[]
): ReviewFindingsFollowUpTaskMaterializationResult {
    return buildBlockedResult({
        suppressDiagnostic: lane.suppressDiagnostic,
        repoRoot,
        taskId: lane.taskId,
        reviewType: lane.reviewType,
        artifactPath: lane.artifactPath,
        dispositionArtifactPath: lane.dispositionArtifactPath,
        dispositionArtifactSha256: lane.dispositionArtifactSha256,
        dispositionResultSha256: lane.dispositionResultSha256,
        validationArtifactPath: lane.validationArtifactPath,
        validationArtifactSha256: lane.validationArtifactSha256,
        validationResultSha256: lane.validationResultSha256,
        validationArtifact: lane.validationArtifact,
        receiptPath: lane.receiptPath,
        receiptSha256: lane.receiptSha256,
        items,
        violations
    });
}

function prepareFollowUpLane(
    options: MaterializeReviewFindingsFollowUpTasksOptions, suppressDiagnostic = false
): FollowUpLanePreparation {
    const repoRoot = path.resolve(options.repoRoot || '.');
    let taskId = normalizeText(options.taskId);
    let reviewType = normalizeText(options.reviewType).toLowerCase();
    let reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    let dispositionArtifactPath = '';
    let artifactPath = getFallbackArtifactPath(repoRoot, taskId, reviewType);
    const blocked = (result: ReviewFindingsFollowUpTaskMaterializationResult): FollowUpLanePreparation => (
        { blocked: result, lane: null }
    );

    try {
        taskId = assertCanonicalTaskId(taskId);
        reviewType = assertReviewTypeToken(reviewType);
        artifactPath = getFallbackArtifactPath(repoRoot, taskId, reviewType);
        reviewsRoot = options.reviewsRoot
            ? resolveInputPathInsideRepo(repoRoot, options.reviewsRoot, 'ReviewsRoot')
            : reviewsRoot;
        dispositionArtifactPath = options.dispositionArtifactPath
            ? resolveInputPathInsideRepo(repoRoot, options.dispositionArtifactPath, 'DispositionArtifactPath')
            : path.join(reviewsRoot, `${taskId}-${reviewType}-findings-disposition.json`);
        artifactPath = options.artifactPath
            ? resolveFollowUpArtifactPath(repoRoot, reviewsRoot, options.artifactPath)
            : resolveFollowUpArtifactPath(
                repoRoot,
                reviewsRoot,
                getReviewFindingsFollowUpTasksArtifactPath(dispositionArtifactPath)
            );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const blockedTaskId = isCanonicalTaskId(taskId) ? taskId : 'UNKNOWN-TASK';
        const blockedReviewType = isReviewTypeToken(reviewType) ? assertReviewTypeToken(reviewType) : 'unknown-review';
        return blocked(buildBlockedResult({
            suppressDiagnostic,
            repoRoot,
            taskId: blockedTaskId,
            reviewType: blockedReviewType,
            artifactPath,
            dispositionArtifactPath: dispositionArtifactPath || normalizePath(path.resolve(repoRoot, String(options.dispositionArtifactPath || ''))),
            dispositionArtifactSha256: null,
            dispositionResultSha256: null,
            validationArtifactPath: null,
            validationArtifactSha256: null,
            validationResultSha256: null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        }));
    }

    const dispositionRead = readJsonFile(dispositionArtifactPath, 'Review findings disposition artifact');
    const dispositionArtifactSha256 = fileSha256(dispositionArtifactPath);
    const disposition = dispositionRead.value ? parseDispositionArtifact(dispositionRead.value) : null;
    const parsedDispositionViolations = disposition
        ? validateDispositionArtifactShape({ artifact: disposition, artifactPath: dispositionArtifactPath, taskId, reviewType })
        : ['Review findings disposition artifact has invalid shape.'];
    const initialViolations = [
        ...dispositionRead.violations,
        ...(dispositionRead.value ? parsedDispositionViolations : [])
    ];

    if (!disposition || initialViolations.length > 0 || !dispositionArtifactSha256) {
        return blocked(buildBlockedResult({
            suppressDiagnostic,
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition?.disposition_result_sha256 || null,
            validationArtifactPath: disposition?.source_validation.artifact_path || null,
            validationArtifactSha256: disposition?.source_validation.artifact_sha256 || null,
            validationResultSha256: disposition?.source_validation.validation_result_sha256 || null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: initialViolations
        }));
    }

    let validationArtifactPath = '';
    try {
        validationArtifactPath = resolveInputPathInsideRepo(
            repoRoot,
            disposition.source_validation.artifact_path || '',
            'ValidationArtifactPath'
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return blocked(buildBlockedResult({
            suppressDiagnostic,
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath: disposition.source_validation.artifact_path || null,
            validationArtifactSha256: disposition.source_validation.artifact_sha256 || null,
            validationResultSha256: disposition.source_validation.validation_result_sha256 || null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        }));
    }
    const validationResult = validateReviewFindingsValidationArtifact({
        artifactPath: validationArtifactPath,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        requireAccepted: true,
        expectedArtifactSha256: disposition.source_validation.artifact_sha256,
        expectedValidationResultSha256: disposition.source_validation.validation_result_sha256
    });
    const validationArtifact = validationResult.artifact;
    let receiptPath: string | null = null;
    try {
        receiptPath = deriveReceiptPath({
            repoRoot,
            explicitReceiptPath: options.receiptPath,
            validationArtifact,
            dispositionArtifactPath
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return blocked(buildBlockedResult({
            suppressDiagnostic,
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact?.validation_result_sha256 || disposition.source_validation.validation_result_sha256,
            validationArtifact,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        }));
    }
    const receiptRead = receiptPath
        ? readJsonFile(receiptPath, 'Review receipt')
        : { value: null, violations: ['Review receipt path could not be derived from validation or disposition artifact bindings.'] };
    const receiptValidation = validateReceiptEvidence({
        receipt: receiptRead.value,
        receiptPath,
        taskId,
        reviewType,
        validationArtifactPath,
        validationArtifactSha256: validationResult.artifact_sha256,
        validationResultSha256: validationArtifact?.validation_result_sha256 || null,
        dispositionArtifactPath,
        dispositionArtifactSha256,
        dispositionResultSha256: disposition.disposition_result_sha256
    });
    const materializationContext = resolveFollowUpMaterializationContext(repoRoot, reviewsRoot, taskId);
    const canonicalReviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const canonicalGrouped = path.resolve(reviewsRoot) !== path.resolve(canonicalReviewsRoot)
        && resolveFollowUpMaterializationContext(repoRoot, canonicalReviewsRoot, taskId).mode === 'grouped_by_parent';
    const dispositionClosurePolicyViolations = validateDispositionClosurePolicyBinding({
        disposition,
        materializationContext
    });
    const groupedSourceCycleViolations = validationArtifact
        ? validateGroupedSourceCycleEvidence({
            repoRoot,
            reviewsRoot,
            taskId,
            reviewType,
            materializationContext,
            validationArtifact,
            receipt: receiptRead.value,
            receiptPath
        })
        : [];
    const validationInventoryViolations = validationArtifact
        ? validateValidationInventoryShape(validationArtifact)
        : [];
    const dispositionInventoryViolations = validationArtifact && validationInventoryViolations.length === 0
        ? validateDispositionInventoryCompleteness({ disposition, validation: validationArtifact })
        : [];
    const sourceViolations = [
        ...validationResult.violations,
        ...validationInventoryViolations,
        ...dispositionInventoryViolations,
        ...receiptRead.violations,
        ...receiptValidation.violations,
        ...dispositionClosurePolicyViolations,
        ...groupedSourceCycleViolations,
        ...(canonicalGrouped ? ['Grouped follow-up publication requires the canonical reviews root.'] : [])
    ];
    if (validationArtifact && validationArtifact.validation_result.status !== 'accepted') {
        sourceViolations.push(
            `Review findings validation artifact status must be accepted before follow-up materialization; ` +
            `found ${validationArtifact.validation_result.status}.`
        );
    }
    if (validationArtifact && validationArtifact.validation_result.accepted !== true) {
        sourceViolations.push('Review findings validation artifact accepted flag must be true before follow-up materialization.');
    }
    // Lanes rejected before queue admission still report their review-readiness blockers.
    if ((sourceViolations.length > 0 || disposition.summary.fix_now_count > 0)
        && disposition.items.some(item => item.action === 'create_follow_up')) {
        sourceViolations.push(...validateGroupedRequiredReviewCompletion({
            repoRoot, reviewsRoot, taskId, reviewTypes: [reviewType], materializationContext
        }));
    }
    if (!validationArtifact || sourceViolations.length > 0 || !validationResult.artifact_sha256 || !receiptValidation.receiptSha256) {
        return blocked(buildBlockedResult({
            suppressDiagnostic,
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact?.validation_result_sha256 || disposition.source_validation.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items: [],
            violations: sourceViolations
        }));
    }

    const built = buildObligations({
        taskId,
        reviewType,
        disposition,
        validation: validationArtifact,
        dispositionArtifactSha256
    });
    const lane: PreparedFollowUpLane = {
        suppressDiagnostic,
        reviewsRoot,
        taskId,
        reviewType,
        artifactPath,
        obligations: built.obligations,
        validationArtifactSha256: validationResult.artifact_sha256,
        validationResultSha256: validationArtifact.validation_result_sha256,
        dispositionArtifactSha256,
        dispositionResultSha256: disposition.disposition_result_sha256,
        receiptSha256: receiptValidation.receiptSha256,
        reusedReview: receiptRead.value?.reused_existing_review === true,
        dispositionArtifactPath,
        disposition,
        validationArtifactPath,
        validationArtifact,
        receiptPath,
        materializationContext,
        baseItems: built.items
    };
    if (built.violations.length > 0) {
        return blocked(buildPreparedLaneBlockedResult(repoRoot, lane, built.items, built.violations));
    }

    const closurePolicy = materializationContext.review_follow_up_task_closure_policy;
    const isFollowUpTask = isReviewFindingsFollowUpTaskId(taskId);
    const legacyNestedFollowUpBlocked = isFollowUpTask
        && (!closurePolicy.eligible || !closurePolicy.valid);
    const descendantMaterializationForbidden = isFollowUpTask
        && (closurePolicy.forbid_child_tasks || legacyNestedFollowUpBlocked);
    if (descendantMaterializationForbidden && built.obligations.length > 0) {
        const items = buildMaterializationItems({
            baseItems: built.items,
            obligations: built.obligations,
            queueResult: blockedQueueResultFor(repoRoot, built.obligations)
        });
        return blocked(buildPreparedLaneBlockedResult(repoRoot, lane, items, [legacyNestedFollowUpBlocked
            ? `Legacy review follow-up task '${taskId}' has no valid explicit closure-policy provenance; ` +
                'nested follow-up materialization remains fail-closed after receipt, context, and tree evidence validation.'
            : `Frozen review follow-up task closure policy forbids child tasks for '${taskId}'; ` +
                'every would-be descendant remains an explicit current-task remediation blocker.']));
    }

    if (hasFixNowMaterializationItems(built.items)) {
        const items = buildMaterializationItems({
            baseItems: built.items,
            obligations: built.obligations,
            queueResult: blockedQueueResultFor(repoRoot, built.obligations)
        });
        return blocked(buildPreparedLaneBlockedResult(repoRoot, lane, items, []));
    }
    return { blocked: null, lane };
}

function blockedQueueResultFor(
    repoRoot: string,
    obligations: readonly FollowUpObligation[]
): TaskQueueMaterializationResult {
    return {
        outcome: 'not_required',
        task_path: normalizePath(path.join(repoRoot, TASK_QUEUE_FILENAME)),
        created: [],
        reused: [],
        blocked_fingerprints: obligations.map((obligation) => obligation.fingerprint),
        error_message: null,
        rollback_content: null
    };
}

function readPublishedFollowUpArtifactBytes(filePath: string): Buffer | null {
    try {
        const stat = fs.lstatSync(filePath);
        return stat.isFile() && !stat.isSymbolicLink() ? fs.readFileSync(filePath) : null;
    } catch {
        return null;
    }
}

function restorePublishedFollowUpArtifact(
    filePath: string,
    previousBytes: Buffer | null,
    repoRoot: string
): string | null {
    if (previousBytes) {
        return tryWriteFollowUpArtifactContent(
            filePath, previousBytes, repoRoot, 'Review findings follow-up artifact restore'
        );
    }
    try {
        // Unlinking removes only the directory entry this run published.
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return null;
    } catch (error) {
        return `Review findings follow-up artifact restore failed: ${errorMessage(error)}`;
    }
}

interface CommitFollowUpLaneOptions {
    confirmedUnmaterializedReviewTypes?: readonly string[];
    // Runs after every lane artifact is published; a returned violation rolls the
    // whole commit back like a publication failure.
    afterPublish?: (queueResult: TaskQueueMaterializationResult) => string | null;
}

function commitPreparedFollowUpLanes(
    repoRoot: string,
    lanes: readonly PreparedFollowUpLane[],
    commitOptions: CommitFollowUpLaneOptions = {}
): ReviewFindingsFollowUpTaskMaterializationResult[] {
    const first = lanes[0];
    let publication: GroupedPublication | undefined;
    const eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    try {
        const results = withTaskQueueStatusSyncLock(path.join(repoRoot, TASK_QUEUE_FILENAME),
            message => lanes.map(lane => buildPreparedLaneBlockedResult(repoRoot, lane, lane.baseItems, [message])),
            () => {
                if (!readGroupedCompletionForCloseout(eventsRoot, first.taskId)) {
                    return publishPreparedFollowUpLanes(repoRoot, lanes, commitOptions);
                }
                if (lanes.some(lane => lane.materializationContext.mode !== 'grouped_by_parent')) {
                    throw new Error('Current follow-up mode differs from the authenticated grouped completion.');
                }
                const prepared = publishCurrentGroupedFollowUp(repoRoot, lanes, commitOptions);
                publication = prepared.committed;
                return prepared.results;
            });
        if (publication) recordCurrentGroupedPublication(repoRoot, lanes, publication);
        return results;
    } catch (error) {
        return lanes.map(lane => buildPreparedLaneBlockedResult(repoRoot, { ...lane, suppressDiagnostic: true },
            lane.baseItems, [errorMessage(error)]));
    }
}

function taskQueueContainsCommittedGroupedRows(
    taskId: string, before: Buffer | null, current: Buffer | null, expectedSha256: string
): boolean {
    if (!before || !current) return false;
    const original = before.toString('utf8');
    const originalQueue = parseCanonicalActiveTaskQueue(original);
    const currentQueue = parseCanonicalActiveTaskQueue(current.toString('utf8'));
    if (!groupedQueueHasUnambiguousRows(taskId, originalQueue) || !groupedQueueHasUnambiguousRows(taskId, currentQueue)) return false;
    const { rows: originalRows } = originalQueue;
    const { rows: currentRows } = currentQueue;
    const parents = originalRows.filter(row => row.taskId === taskId);
    const currentParents = currentRows.filter(row => row.taskId === taskId);
    const currentChildren = currentRows.filter(row => isGroupedChildIdCandidate(taskId, row.taskId));
    if (parents.length !== 1 || currentParents.length !== 1 || currentChildren.length !== 1
        || currentChildren[0].taskId !== taskId + '-F1'
        || originalRows.some(row => isGroupedChildIdCandidate(taskId, row.taskId))) return false;
    const parent = parents[0];
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/u);
    lines[parent.lineIndex] = currentParents[0].rawLine;
    lines.splice(findInsertionLineIndex(parent, originalRows) + 1, 0, currentChildren[0].rawLine);
    return sha256TextPayload(formatActiveTaskQueueTable(lines.join(newline))) === expectedSha256;
}

function assertGroupedParentInReview(taskId: string, rows: readonly CanonicalActiveTaskQueueRow[]): void {
    const parents = rows.filter(row => row.taskId.toLowerCase() === taskId.toLowerCase());
    if (parents.length !== 1 || parents[0].taskId !== taskId
        || readTaskQueueStatusToken(parents[0].status) !== GROUPED_COMPLETION_QUEUE_STATUS) {
        throw new Error('Grouped follow-up publication requires a unique canonical parent in IN_REVIEW.');
    }
}

function assertGroupedLaneInputsUnchanged(lanes: readonly PreparedFollowUpLane[]): void {
    for (const lane of lanes) {
        const inputs = [
            ['receipt', lane.receiptPath, lane.receiptSha256],
            ['disposition', lane.dispositionArtifactPath, lane.dispositionArtifactSha256],
            ['validation', lane.validationArtifactPath, lane.validationArtifactSha256]
        ] as const;
        for (const [kind, filePath, expected] of inputs) {
            const bytes = filePath ? readPublishedFollowUpArtifactBytes(filePath) : null;
            if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
                throw new Error(`Grouped follow-up lane '${lane.reviewType}' ${kind} changed before publication.`);
            }
        }
    }
}

interface JournaledGroupedPublication {
    transaction: RecoverableFileTransaction;
    stageQueue: (content: string) => void;
    recovering: boolean;
    createdAtUtc: string;
    artifactHashes: Map<string, string>;
}

function publishCurrentGroupedFollowUp(
    repoRoot: string, lanes: readonly PreparedFollowUpLane[], options: CommitFollowUpLaneOptions
): { results: ReviewFindingsFollowUpTaskMaterializationResult[]; committed: GroupedPublication | undefined } {
    const first = lanes[0];
    const { taskId } = first;
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const journalBase = path.join(reviewsRoot, taskId + '-grouped-publication');
    const preflight = readJsonFile(path.join(reviewsRoot, taskId + '-preflight.json'), 'Preflight artifact').value;
    const reviewTypes = preflight && isPlainRecord(preflight.required_reviews) ? Object.keys(preflight.required_reviews) : [];
    const files: Record<string, string> = { queue: taskPath };
    for (const type of new Set([...reviewTypes, ...lanes.map(lane => lane.reviewType)])) {
        if (isReviewTypeToken(type)) files['lane-' + type] = path.join(reviewsRoot, taskId + '-' + type + '-findings-follow-ups.json');
    }

    let committed: GroupedPublication | undefined;
    const results = withRecoverableFileTransaction({
        root: repoRoot, lockPath: journalBase + '.lock', journalPath: journalBase + '-journal.json', files,
        recoverCommitPoint: {
            id: 'queue',
            matchesPublishedBytes: (before, current, expectedSha256) =>
                taskQueueContainsCommittedGroupedRows(taskId, before, current, expectedSha256)
        }
    }, transaction => {
        const completion = readFreshGroupedCompletion(repoRoot, taskId);
        if (!completion?.authorizedAtUtc) throw new Error('Grouped follow-up publication requires unchanged canonical completion evidence.');
        const registry = checkGroupedPublicationRegistry(repoRoot, taskId);
        if (!registry) throw new Error('Grouped follow-up publication conflicts with its authenticated registry.');
        const [existing] = registry.values();
        if (existing?.completion_event_sha256 === completion.eventSha256) {
            if (!lanes.every(lane => existing.lanes.some(recorded =>
                recorded.review_type === lane.reviewType && recorded.receipt_sha256 === lane.receiptSha256
                && recorded.source_binding_sha256 === buildGroupedSourceBindingSha256(lane)
                && recorded.artifact_path === normalizePath(path.relative(repoRoot, lane.artifactPath))
                && lane.receiptPath === path.join(reviewsRoot, taskId + '-' + lane.reviewType + '-receipt.json')
                && recorded.item_fingerprints_sha256 === sha256JsonPayload(lane.obligations.map(item => item.fingerprint).sort())))) {
                throw new Error('Grouped follow-up retry differs from authenticated publication.');
            }
            return lanes.map<ReviewFindingsFollowUpTaskMaterializationResult>(lane => ({ status: 'ALREADY_MATERIALIZED', task_id: taskId, review_type: lane.reviewType,
                artifact_path: normalizePath(lane.artifactPath), created_task_ids: [], reused_task_ids: [existing.child_task_id],
                violations: [], output_lines: ['REVIEW_FINDINGS_FOLLOW_UP_TASKS_ALREADY_MATERIALIZED'] }));
        }
        const currentQueue = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8'));
        const group = first.materializationContext.group_fingerprint;
        const children = currentQueue.rows.filter(row => isGroupedChildIdCandidate(taskId, row.taskId));
        const child = children.find(row => row.taskId === taskId + '-F1'
            && extractGroupedFingerprint(row.notes) === group);
        if (child && options.confirmedUnmaterializedReviewTypes?.length) {
            return publishPreparedFollowUpLanes(repoRoot, lanes, options);
        }
        assertGroupedParentInReview(taskId, currentQueue.rows);
        if (!groupedQueueHasUnambiguousRows(taskId, currentQueue) || children.length > 1 || (!child && children.length)) {
            throw new Error('Existing follow-up child does not match the current grouped publication cycle.');
        }
        let stagedQueue: string | undefined;
        const artifactHashes = new Map<string, string>();
        const results = publishPreparedFollowUpLanes(repoRoot, lanes, options, {
            transaction, stageQueue: content => { stagedQueue = content; }, recovering: Boolean(child),
            createdAtUtc: completion.authorizedAtUtc, artifactHashes
        });
        if (results.some(result => result.status === 'BLOCKED')) return results;

        const childId = results.flatMap(result => [...result.created_task_ids, ...result.reused_task_ids])[0];
        if (!childId) return results;
        const publishedLanes = lanes.filter(lane => lane.obligations.length).map(lane => ({
            review_type: lane.reviewType, receipt_sha256: lane.receiptSha256, retained_reviews: [],
            item_count: lane.obligations.length,
            item_fingerprints_sha256: sha256JsonPayload(lane.obligations.map(item => item.fingerprint).sort()),
            source_binding_sha256: buildGroupedSourceBindingSha256(lane),
            artifact_path: normalizePath(path.relative(repoRoot, lane.artifactPath)),
            artifact_sha256: artifactHashes.get(lane.reviewType) || ''
        }));
        const publication: GroupedPublication = { child_task_id: childId, group_fingerprint: group!,
            snapshot_hash: first.materializationContext.snapshot_hash!, cycle_id: first.materializationContext.cycle_id!,
            lanes: publishedLanes };
        const liveQueue = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8'));
        assertGroupedParentInReview(taskId, liveQueue.rows);
        const publishedQueue = stagedQueue === undefined ? liveQueue : parseCanonicalActiveTaskQueue(stagedQueue);
        if (!groupedQueueHasUnambiguousRows(taskId, liveQueue)
            || !groupedPublicationMatchesQueue(repoRoot, taskId, publication, publishedQueue)
            || readFreshGroupedCompletion(repoRoot, taskId)?.eventSha256 !== completion.eventSha256) {
            throw new Error('Grouped child publication or its completion evidence changed before commit.');
        }
        assertGroupedLaneInputsUnchanged(lanes);
        if (stagedQueue !== undefined) transaction.write(taskPath, stagedQueue);
        committed = { ...publication, completion_event_sha256: completion.eventSha256 };
        return results;
    });
    return { results, committed };
}

function recordCurrentGroupedPublication(
    repoRoot: string, lanes: readonly PreparedFollowUpLane[], committed: GroupedPublication
): void {
    const { taskId } = lanes[0];
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const { completion_event_sha256, ...publication } = committed;
    const publicationSha256 = sha256JsonPayload(publication);
    appendMandatoryTaskEvent(joinOrchestratorPath(repoRoot, ''), taskId, GROUPED_PUBLICATION_EVENT, 'PASS',
        'Published the grouped review follow-up after validated completion.', {
            task_id: taskId, child_task_id: publication.child_task_id, completion_event_sha256,
            publication, publication_sha256: publicationSha256
        }, {
            actor: 'orchestrator',
            emitOnce: true,
            withCanonicalAppend: append => withTaskQueueStatusSyncLock(taskPath, message => { throw new Error(message); }, () => {
                if (readFreshGroupedCompletion(repoRoot, taskId)?.eventSha256 !== completion_event_sha256) {
                    throw new Error('Grouped completion evidence changed before recording publication.');
                }
                const queue = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8'));
                assertGroupedParentInReview(taskId, queue.rows);
                if (!groupedPublicationMatchesQueue(repoRoot, taskId, publication, queue)) {
                    throw new Error('Grouped follow-up bytes or queue bindings changed before recording publication.');
                }
                const registry = checkGroupedPublicationRegistry(repoRoot, taskId, queue.rows);
                const existing = registry?.get(publication.child_task_id);
                if (!registry || (existing && (existing.completion_event_sha256 !== completion_event_sha256
                    || sha256JsonPayload({
                        child_task_id: existing.child_task_id, group_fingerprint: existing.group_fingerprint,
                        snapshot_hash: existing.snapshot_hash, cycle_id: existing.cycle_id, lanes: existing.lanes
                    }) !== publicationSha256))) {
                    throw new Error('Concurrent grouped publication differs from the authenticated publication.');
                }
                assertGroupedLaneInputsUnchanged(lanes);
                append();
            })
        });
}

function publishPreparedFollowUpLanes(
    repoRoot: string,
    lanes: readonly PreparedFollowUpLane[],
    commitOptions: CommitFollowUpLaneOptions,
    journal?: JournaledGroupedPublication
): ReviewFindingsFollowUpTaskMaterializationResult[] {
    const [firstLane] = lanes;
    const materializationContext = firstLane.materializationContext;
    const queueResult = materializeTaskQueueRows({
        repoRoot,
        parentTaskId: firstLane.taskId,
        lanes,
        materializationContext,
        confirmedUnmaterializedReviewTypes: commitOptions.confirmedUnmaterializedReviewTypes,
        stageFirstQueueWrite: journal?.stageQueue
    });
    if (queueResult.previous_publication && queueResult.outcome === 'already_materialized') {
        return lanes.map(lane => ({
            status: 'ALREADY_MATERIALIZED', task_id: lane.taskId, review_type: lane.reviewType,
            artifact_path: normalizePath(lane.artifactPath), created_task_ids: [],
            reused_task_ids: [queueResult.previous_publication!.child_task_id], violations: [],
            output_lines: ['REVIEW_FINDINGS_FOLLOW_UP_TASKS_ALREADY_MATERIALIZED']
        }));
    }
    if (queueResult.prerequisite_failed) {
        return lanes.map(lane => ({
            status: 'BLOCKED', task_id: lane.taskId, review_type: lane.reviewType, artifact_path: normalizePath(lane.artifactPath),
            created_task_ids: [], reused_task_ids: [], violations: [queueResult.error_message!],
            prerequisite_failed: true, output_lines: [queueResult.error_message!]
        }));
    }
    const queueViolations = ['task_file_missing', 'task_not_found', 'write_failed'].includes(queueResult.outcome)
        ? [`TASK.md follow-up task materialization failed: ${queueResult.outcome}${queueResult.error_message ? ` (${queueResult.error_message})` : ''}.`]
        : [];
    if (queueViolations.length > 0) {
        return lanes.map((lane) => ({
            ...buildPreparedLaneBlockedResult(repoRoot, lane, buildMaterializationItems({
                baseItems: lane.baseItems,
                obligations: lane.obligations,
                queueResult
            }), queueViolations),
            ...(queueResult.admission_refusal_code ? { admission_refusal_code: queueResult.admission_refusal_code } : {})
        }));
    }

    const published: Array<{ artifactPath: string; previousBytes: Buffer | null }> = [];
    const laneOutcomes: Array<{
        lane: PreparedFollowUpLane;
        status: ReviewFollowUpMaterializationStatus;
        created: MaterializedTaskReference[];
        reused: MaterializedTaskReference[];
    }> = [];
    const rollBackPublication = (failureViolation: string): ReviewFindingsFollowUpTaskMaterializationResult[] => {
        // Restore lanes already published by this run so no lane artifact keeps
        // claiming a TASK.md binding that the rollback below removes.
        const restoreViolations = published.reverse()
            .map((entry) => restorePublishedFollowUpArtifact(entry.artifactPath, entry.previousBytes, repoRoot))
            .filter((violation): violation is string => Boolean(violation));
        const rollbackViolation = rollbackTaskQueueRows(queueResult.task_path, queueResult.rollback_content);
        const rollbackNote = rollbackViolation
            || (queueResult.rollback_content === null
                ? 'No TASK.md rollback was required after follow-up artifact write failure.'
                : 'TASK.md changes were rolled back after follow-up artifact write failure.');
        const failureQueueResult: TaskQueueMaterializationResult = rollbackViolation
            ? queueResult
            : {
                ...queueResult,
                outcome: 'write_failed',
                created: [],
                blocked_fingerprints: queueResult.created.map((item) => item.fingerprint),
                error_message: failureViolation,
                rollback_content: null
            };
        const restoreNotes = published.length > 0 && restoreViolations.length === 0
            ? [`${published.length} lane follow-up artifact(s) published by this run were restored.`]
            : [];
        return lanes.map((failedLane) => buildPreparedLaneBlockedResult(repoRoot, failedLane, buildMaterializationItems({
            baseItems: failedLane.baseItems,
            obligations: failedLane.obligations,
            queueResult: failureQueueResult
        }), [
            failureViolation,
            rollbackNote,
            ...restoreViolations,
            ...restoreNotes
        ]));
    };
    for (const lane of lanes) {
        const laneFingerprints = new Set(lane.obligations.map((obligation) => obligation.fingerprint));
        const created = queueResult.created.filter((item) => laneFingerprints.has(item.fingerprint));
        const reused = queueResult.reused.filter((item) => laneFingerprints.has(item.fingerprint));
        const status: ReviewFollowUpMaterializationStatus = lane.obligations.length === 0
            ? 'NOT_REQUIRED'
            : (created.length > 0 ? 'MATERIALIZED' : 'ALREADY_MATERIALIZED');
        const recoveringCreatedLane = journal?.recovering && lane.obligations.length > 0;
        const artifact = buildArtifact({
            repoRoot,
            taskId: lane.taskId,
            reviewType: lane.reviewType,
            status: recoveringCreatedLane ? 'MATERIALIZED' : status,
            dispositionArtifactPath: lane.dispositionArtifactPath,
            dispositionArtifactSha256: lane.dispositionArtifactSha256,
            dispositionResultSha256: lane.dispositionResultSha256,
            validationArtifactPath: lane.validationArtifactPath,
            validationArtifactSha256: lane.validationArtifactSha256,
            validationResultSha256: lane.validationResultSha256,
            validationArtifact: lane.validationArtifact,
            receiptPath: lane.receiptPath,
            receiptSha256: lane.receiptSha256,
            items: buildMaterializationItems({
                baseItems: lane.baseItems,
                obligations: lane.obligations,
                queueResult: recoveringCreatedLane ? { ...queueResult, created: queueResult.reused, reused: [] } : queueResult
            }),
            violations: []
        });
        if (lane.retainedReviews?.length) artifact.retained_reviews = lane.retainedReviews;
        if (journal) {
            const bytes = JSON.stringify({ ...artifact, created_at_utc: journal.createdAtUtc }, null, 2) + '\n';
            if (journal.recovering) {
                if (!readPublishedFollowUpArtifactBytes(lane.artifactPath)?.equals(Buffer.from(bytes, 'utf8'))) {
                    throw new Error('Existing grouped artifact differs from the canonical first publication: ' + normalizePath(lane.artifactPath));
                }
            } else {
                journal.transaction.write(lane.artifactPath, bytes);
            }
            journal.artifactHashes.set(lane.reviewType, sha256TextPayload(bytes));
            laneOutcomes.push({ lane, status, created, reused });
            continue;
        }
        const previousBytes = readPublishedFollowUpArtifactBytes(lane.artifactPath);
        const artifactWriteViolation = tryWriteFollowUpArtifact(
            lane.artifactPath,
            artifact,
            repoRoot,
            'Review findings follow-up materialization artifact'
        );
        if (artifactWriteViolation) {
            return rollBackPublication(artifactWriteViolation);
        }
        published.push({ artifactPath: lane.artifactPath, previousBytes });
        laneOutcomes.push({ lane, status, created, reused });
    }
    const afterPublishViolation = commitOptions.afterPublish?.(queueResult);
    if (afterPublishViolation) return rollBackPublication(afterPublishViolation);

    return laneOutcomes.map(({ lane, status, created, reused }) => {
        const marker = status === 'MATERIALIZED'
            ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_MATERIALIZED'
            : (status === 'ALREADY_MATERIALIZED'
                ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_ALREADY_MATERIALIZED'
                : 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_NOT_REQUIRED');
        return {
            status,
            task_id: lane.taskId,
            review_type: lane.reviewType,
            artifact_path: normalizePath(lane.artifactPath),
            created_task_ids: [...new Set(created.map((item) => item.task_id))],
            reused_task_ids: [...new Set(reused.map((item) => item.task_id))],
            violations: [],
            output_lines: [
                ...formatOutput({
                    repoRoot,
                    taskId: lane.taskId,
                    status,
                    marker,
                    action: status === 'NOT_REQUIRED'
                        ? 'Continue through the navigator; no deferred review findings required follow-up tasks.'
                        : 'Continue through the navigator with review follow-up tasks linked in TASK.md.',
                    reason: status === 'MATERIALIZED'
                        ? `${created.length} follow-up task(s) created.`
                        : (status === 'ALREADY_MATERIALIZED'
                            ? `${reused.length} follow-up task(s) already linked.`
                            : 'Disposition artifact contained no create_follow_up obligations.'),
                    artifactPath: lane.artifactPath,
                    violations: []
                }),
                `FollowUpTaskProfile: ${materializationContext.task_profile || '<unavailable>'} ` +
                `(source=${materializationContext.task_profile_source}, ` +
                `parent=${materializationContext.parent_profile || '<unavailable>'})`,
                ...materializationContext.diagnostics.map((diagnostic) => `FollowUpTaskProfileDiagnostic: ${diagnostic}`)
            ]
        };
    });
}

function resolveFollowUpAttemptBindingInput(params: {
    repoRoot: string;
    taskId: string;
    reviewTypes: readonly string[];
    reviewsRoot?: string | null;
}): ReviewFollowUpAttemptBindingInput | null {
    try {
        return {
            repoRoot: params.repoRoot,
            reviewsRoot: params.reviewsRoot
                ? resolveInputPathInsideRepo(params.repoRoot, params.reviewsRoot, 'ReviewsRoot')
                : joinOrchestratorPath(params.repoRoot, path.join('runtime', 'reviews')),
            taskId: assertCanonicalTaskId(normalizeText(params.taskId)),
            reviewTypes: params.reviewTypes.map((reviewType) => assertReviewTypeToken(normalizeText(reviewType).toLowerCase()))
        };
    } catch {
        return null;
    }
}

function recordFollowUpAttemptOutcome(params: {
    input: ReviewFollowUpAttemptBindingInput | null;
    inputSha256: string | null;
    result: ReviewFindingsFollowUpTaskBatchMaterializationResult;
    confirmedReviewTypes: readonly string[];
}): void {
    // Only the exact standard batch command that the navigator prescribes is ever
    // recorded, so explicit paths, another reviews root or the single-lane form can
    // never change what the navigator prescribes.
    if (!params.input || params.result.lane_results.some(lane => lane.prerequisite_failed)) return;
    const standardReviewsRoot = joinOrchestratorPath(params.input.repoRoot, path.join('runtime', 'reviews'));
    if (path.resolve(params.input.reviewsRoot) !== path.resolve(standardReviewsRoot)) return;
    const recordPath = getReviewFollowUpBlockedAttemptPath(params.input.reviewsRoot, params.input.taskId);
    const refusalCode = params.result.status === 'BLOCKED' ? params.result.admission_refusal_code : undefined;
    if (refusalCode && params.inputSha256) {
        // The record only lets the navigator stop repeating a command that grouped
        // registry or reuse admission already refused against the same inputs; it
        // never authorizes materialization.
        tryWriteFollowUpArtifact(recordPath, buildReviewFollowUpBlockedAttemptRecord({
            taskId: params.input.taskId,
            reviewTypes: params.input.reviewTypes,
            reviewsRoot: normalizePath(path.relative(params.input.repoRoot, params.input.reviewsRoot)),
            confirmedReviewTypes: params.confirmedReviewTypes,
            refusalCode,
            inputSha256: params.inputSha256,
            violations: params.result.violations
        }), params.input.repoRoot, 'Review follow-up blocked attempt record');
        return;
    }
    try {
        // Any other outcome clears an earlier record so the navigator keeps
        // prescribing the command, as it did before records existed.
        if (fs.existsSync(recordPath)) fs.unlinkSync(recordPath);
    } catch {
        // A stale record cannot match changed inputs, so a failed cleanup is harmless.
    }
}

export function materializeReviewFindingsFollowUpTasks(
    options: MaterializeReviewFindingsFollowUpTasksOptions
): ReviewFindingsFollowUpTaskMaterializationResult {
    const prepared = prepareFollowUpLane(options);
    return prepared.blocked || commitPreparedFollowUpLanes(path.resolve(options.repoRoot || '.'), [prepared.lane])[0];
}

export interface MaterializeReviewFindingsFollowUpTaskBatchOptions {
    repoRoot: string;
    taskId: string;
    reviewTypes: readonly string[];
    reviewsRoot?: string | null;
    // Operator-confirmed recovery for lanes that were never materialized into the
    // existing current-group child. Requires genuine, fresh operator confirmation.
    operatorConfirmedUnmaterializedLanes?: readonly string[];
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
}

export { REVIEW_FOLLOW_UP_LANES_RECOVERED_EVENT_TYPE };
export const OPERATOR_CONFIRMED_UNMATERIALIZED_LANES_OPTION = '--operator-confirmed-unmaterialized-lanes';
const UNMATERIALIZED_LANE_RECOVERY_CONFIRMATION_MAX_AGE_MS = 10 * 60 * 1000;
const UNMATERIALIZED_LANE_RECOVERY_INSTRUCTION =
    'Ask the operator to confirm that the listed lanes never had a follow-up artifact in this review cycle ' +
    '(it was never published, not deleted). Only after that approval rerun with --operator-confirmed yes and ' +
    '--operator-confirmed-at-utc "<ISO-8601 timestamp of the approval>". Do not edit evidence or TASK.md registries.';

interface UnmaterializedLaneRecovery {
    reviewTypes: string[];
    confirmedAtUtc: string | null;
    violations: string[];
}

function resolveUnmaterializedLaneRecovery(
    options: MaterializeReviewFindingsFollowUpTaskBatchOptions,
    batchReviewTypes: readonly string[]
): UnmaterializedLaneRecovery {
    const reviewTypes = [...new Set((options.operatorConfirmedUnmaterializedLanes || [])
        .map((reviewType) => normalizeText(reviewType).toLowerCase())
        .filter(Boolean))].sort();
    const instruction = UNMATERIALIZED_LANE_RECOVERY_INSTRUCTION;
    const confirmationSupplied = options.operatorConfirmed !== undefined || options.operatorConfirmedAtUtc !== undefined;
    if (reviewTypes.length === 0) {
        return {
            reviewTypes,
            confirmedAtUtc: null,
            violations: confirmationSupplied
                ? [`--operator-confirmed applies to follow-up materialization only with ${OPERATOR_CONFIRMED_UNMATERIALIZED_LANES_OPTION}.`]
                : []
        };
    }
    const violations = reviewTypes.flatMap((reviewType) => (
        !isReviewTypeToken(reviewType)
            ? [`Operator-confirmed lane '${reviewType}' is not a valid review type.`]
            : (batchReviewTypes.includes(reviewType)
                ? []
                : [`Operator-confirmed lane '${reviewType}' is not part of this --review-types batch.`])
    ));
    const actionLabel = 'Grouped review follow-up lane recovery';
    try {
        const rawConfirmed = String(options.operatorConfirmed ?? '').trim();
        const confirmed = rawConfirmed ? parseOperatorConfirmationYes(rawConfirmed) : false;
        const confirmedAtUtc = String(options.operatorConfirmedAtUtc ?? '').trim();
        if (confirmed && confirmedAtUtc && Number.isFinite(Date.parse(confirmedAtUtc))
            && Date.now() - Date.parse(confirmedAtUtc) > UNMATERIALIZED_LANE_RECOVERY_CONFIRMATION_MAX_AGE_MS) {
            throw new Error(
                `${actionLabel} operator confirmation is stale (older than ten minutes); ask the user for fresh approval. ` +
                instruction
            );
        }
        validateFreshOperatorConfirmation({
            actionLabel,
            confirmed,
            confirmedAtUtc,
            requireConfirmedAtUtc: true,
            instruction
        });
        return { reviewTypes, confirmedAtUtc, violations };
    } catch (error) {
        return { reviewTypes, confirmedAtUtc: null, violations: [...violations, errorMessage(error)] };
    }
}

export interface ReviewFindingsFollowUpTaskBatchMaterializationResult {
    status: ReviewFollowUpMaterializationStatus;
    task_id: string;
    review_types: string[];
    artifact_paths: string[];
    created_task_ids: string[];
    reused_task_ids: string[];
    violations: string[];
    output_lines: string[];
    lane_results: ReviewFindingsFollowUpTaskMaterializationResult[];
    admission_refusal_code?: GroupedAdmissionRefusalCode;
}

export const REVIEW_FOLLOW_UP_BATCH_MAX_LANES = 64;

export function parseReviewFollowUpBatchReviewTypes(value: unknown): string[] {
    return [...new Set(String(value ?? '').split(',')
        .map((reviewType) => reviewType.trim().toLowerCase())
        .filter(Boolean))];
}

function combineBatchLaneResults(params: {
    repoRoot: string;
    taskId: string;
    reviewTypes: readonly string[];
    laneResults: readonly ReviewFindingsFollowUpTaskMaterializationResult[];
    extraViolations?: readonly string[];
}): ReviewFindingsFollowUpTaskBatchMaterializationResult {
    const blockedLanes = params.laneResults.filter((result) => result.status === 'BLOCKED');
    const violations = [
        ...(params.extraViolations || []),
        ...blockedLanes.flatMap((result) => result.violations.map((violation) => `[${result.review_type}] ${violation}`))
    ];
    const status: ReviewFollowUpMaterializationStatus = violations.length > 0 || blockedLanes.length > 0
        ? 'BLOCKED'
        : (params.laneResults.some((result) => result.status === 'MATERIALIZED')
            ? 'MATERIALIZED'
            : (params.laneResults.some((result) => result.status === 'ALREADY_MATERIALIZED')
                ? 'ALREADY_MATERIALIZED'
                : 'NOT_REQUIRED'));
    const createdTaskIds = [...new Set(params.laneResults.flatMap((result) => result.created_task_ids))];
    const reusedTaskIds = [...new Set(params.laneResults.flatMap((result) => result.reused_task_ids))];
    const detailsResult = blockedLanes[0] || params.laneResults[0];
    const detailsPath = detailsResult?.artifact_path
        || getFallbackArtifactPath(params.repoRoot, params.taskId, params.reviewTypes[0] || 'unknown-review');
    const marker = status === 'BLOCKED'
        ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_BLOCKED'
        : (status === 'MATERIALIZED'
            ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_MATERIALIZED'
            : (status === 'ALREADY_MATERIALIZED'
                ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_ALREADY_MATERIALIZED'
                : 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_NOT_REQUIRED'));
    const profileLines = status === 'BLOCKED'
        ? []
        : (params.laneResults[0]?.output_lines || []).filter((line) => (
            line.startsWith('FollowUpTaskProfile: ') || line.startsWith('FollowUpTaskProfileDiagnostic: ')
        ));
    return {
        status,
        task_id: params.taskId,
        review_types: [...params.reviewTypes],
        artifact_paths: params.laneResults.map((result) => result.artifact_path),
        created_task_ids: createdTaskIds,
        reused_task_ids: reusedTaskIds,
        violations,
        ...(status === 'BLOCKED' && blockedLanes.length > 0 && blockedLanes[0].admission_refusal_code
            && blockedLanes.every((result) => result.admission_refusal_code === blockedLanes[0].admission_refusal_code)
            ? { admission_refusal_code: blockedLanes[0].admission_refusal_code }
            : {}),
        output_lines: [
            ...formatOutput({
                repoRoot: params.repoRoot,
                taskId: params.taskId,
                status,
                marker,
                action: status === 'BLOCKED'
                    ? 'Resolve review findings follow-up materialization blockers, then rerun this gate for the same review lanes.'
                    : 'Continue through the navigator with review follow-up tasks linked in TASK.md.',
                reason: status === 'BLOCKED'
                    ? violations.join(' ')
                    : `${params.laneResults.length} review lane(s) bound to grouped follow-up task(s) ` +
                        `${[...createdTaskIds, ...reusedTaskIds.filter((taskId) => !createdTaskIds.includes(taskId))]
                            .join(', ') || '<none>'}.`,
                artifactPath: detailsPath,
                violations
            }),
            `ReviewTypes: ${params.reviewTypes.join(', ')}`,
            ...params.laneResults.map((result) => (
                `LaneResult: ${result.review_type} ${result.status} ${normalizePath(result.artifact_path)}`
            )),
            ...profileLines
        ],
        lane_results: [...params.laneResults]
    };
}

function buildRejectedBatchInputResult(params: {
    taskId: string;
    reviewTypes: readonly string[];
    violations: readonly string[];
}): ReviewFindingsFollowUpTaskBatchMaterializationResult {
    return {
        status: 'BLOCKED',
        task_id: params.taskId,
        review_types: [...params.reviewTypes],
        artifact_paths: [],
        created_task_ids: [],
        reused_task_ids: [],
        violations: [...params.violations],
        output_lines: [
            ...buildOperatorNextActionBlock({
                status: 'BLOCKED',
                gate: 'review-findings-follow-up-tasks',
                action: 'Correct the --review-types lane list, then rerun this gate.',
                reason: params.violations.join(' '),
                command: null,
                commandReference: 'fix the lane list before retrying materialization'
            }),
            '',
            'REVIEW_FINDINGS_FOLLOW_UP_TASKS_BLOCKED',
            'Violations:',
            ...params.violations.map((violation) => `- ${violation}`)
        ],
        lane_results: []
    };
}

/**
 * Materializes the deferred items of several review lanes into one grouped child
 * in one TASK.md transaction. Each lane passes the same source, receipt, cycle and
 * required-review checks as a single-lane run before anything is written. An
 * existing current child keeps the strict per-lane registry and reuse checks.
 */
export function materializeReviewFindingsFollowUpTaskBatch(
    options: MaterializeReviewFindingsFollowUpTaskBatchOptions
): ReviewFindingsFollowUpTaskBatchMaterializationResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = normalizeText(options.taskId);
    const reviewTypes = [...new Set(options.reviewTypes.map((reviewType) => normalizeText(reviewType).toLowerCase()))]
        .filter(Boolean)
        .sort();
    const inputViolations = [
        ...(reviewTypes.length === 0 ? ['At least one review type is required for follow-up materialization.'] : []),
        ...(reviewTypes.length > REVIEW_FOLLOW_UP_BATCH_MAX_LANES
            ? [`At most ${REVIEW_FOLLOW_UP_BATCH_MAX_LANES} review lanes can be materialized together.`]
            : []),
        ...(reviewTypes.includes('recorded-out-of-scope')
            ? ['recorded-out-of-scope follow-ups are materialized separately with --review-type recorded-out-of-scope.']
            : [])
    ];
    if (inputViolations.length > 0) {
        return buildRejectedBatchInputResult({ taskId, reviewTypes, violations: inputViolations });
    }
    const recovery = resolveUnmaterializedLaneRecovery(options, reviewTypes);
    if (recovery.violations.length > 0) {
        // A missing, stale or invalid confirmation writes nothing and records no attempt.
        return buildRejectedBatchInputResult({ taskId, reviewTypes, violations: recovery.violations });
    }
    const attemptInput = resolveFollowUpAttemptBindingInput({
        repoRoot, taskId, reviewTypes, reviewsRoot: options.reviewsRoot
    });
    const attemptInputSha256 = attemptInput ? buildReviewFollowUpAttemptInputSha256(attemptInput) : null;
    const result = materializePreparedFollowUpTaskBatch({
        repoRoot, taskId, reviewTypes, options, attemptInput, recovery
    });
    recordFollowUpAttemptOutcome({
        input: attemptInput, inputSha256: attemptInputSha256, result, confirmedReviewTypes: recovery.reviewTypes
    });
    return result;
}

function materializePreparedFollowUpTaskBatch(params: {
    repoRoot: string;
    taskId: string;
    reviewTypes: readonly string[];
    options: MaterializeReviewFindingsFollowUpTaskBatchOptions;
    attemptInput: ReviewFollowUpAttemptBindingInput | null;
    recovery: UnmaterializedLaneRecovery;
}): ReviewFindingsFollowUpTaskBatchMaterializationResult {
    const { repoRoot, taskId, reviewTypes } = params;
    // Each lane uses its standard receipt path, exactly as the navigator checks
    // before it prescribes the batch.
    const preparations = reviewTypes.map((reviewType) => prepareFollowUpLane({
        repoRoot, taskId, reviewType, reviewsRoot: params.options.reviewsRoot,
        receiptPath: params.attemptInput
            ? path.join(params.attemptInput.reviewsRoot, `${params.attemptInput.taskId}-${reviewType}-receipt.json`)
            : null
    }));
    const blockedResults = preparations
        .map((preparation) => preparation.blocked)
        .filter((result): result is ReviewFindingsFollowUpTaskMaterializationResult => Boolean(result));
    if (blockedResults.length > 0) {
        return combineBatchLaneResults({ repoRoot, taskId, reviewTypes, laneResults: blockedResults });
    }
    const lanes = preparations
        .map((preparation) => preparation.lane)
        .filter((lane): lane is PreparedFollowUpLane => Boolean(lane));
    const [firstLane] = lanes;
    const contextViolations = (lanes.length > 1 || params.recovery.reviewTypes.length > 0) && (
        firstLane.materializationContext.mode !== 'grouped_by_parent'
        || lanes.some((lane) => (
            lane.materializationContext.mode !== firstLane.materializationContext.mode
            || lane.materializationContext.group_fingerprint !== firstLane.materializationContext.group_fingerprint
            || lane.materializationContext.snapshot_hash !== firstLane.materializationContext.snapshot_hash
        ))
    )
        ? ['Several review lanes can be materialized together only in grouped_by_parent mode with one current group binding.']
        : [];
    if (contextViolations.length > 0) {
        return combineBatchLaneResults({
            repoRoot,
            taskId,
            reviewTypes,
            laneResults: lanes.map((lane) => buildPreparedLaneBlockedResult(repoRoot, lane, lane.baseItems, contextViolations))
        });
    }
    const recoveredLanes = params.recovery.reviewTypes;
    let recoveredChildTaskId: string | null = null;
    const combined = combineBatchLaneResults({
        repoRoot,
        taskId: firstLane.taskId,
        reviewTypes,
        laneResults: commitPreparedFollowUpLanes(repoRoot, lanes, recoveredLanes.length ? {
            confirmedUnmaterializedReviewTypes: recoveredLanes,
            afterPublish: (queueResult) => {
                const context = firstLane.materializationContext;
                recoveredChildTaskId = queueResult.reused[0]?.task_id || null;
                try {
                    appendMandatoryTaskEvent(
                        joinOrchestratorPath(repoRoot, ''),
                        firstLane.taskId,
                        REVIEW_FOLLOW_UP_LANES_RECOVERED_EVENT_TYPE,
                        'PASS',
                        'Operator-confirmed never-materialized review lanes were bound to the current grouped follow-up task.',
                        {
                            task_id: firstLane.taskId,
                            child_task_id: recoveredChildTaskId,
                            recovered_review_types: recoveredLanes,
                            batch_review_types: [...reviewTypes],
                            recovered_artifact_paths: lanes
                                .filter((lane) => recoveredLanes.includes(lane.reviewType))
                                .map((lane) => normalizePath(path.relative(repoRoot, lane.artifactPath))),
                            materialization_mode: context.mode,
                            snapshot_hash: context.snapshot_hash,
                            cycle_id: context.cycle_id,
                            group_fingerprint: context.group_fingerprint,
                            preflight_sha256: context.preflight_sha256,
                            compile_gate_timestamp: context.compile_gate_timestamp,
                            operator_confirmed_at_utc: params.recovery.confirmedAtUtc
                        },
                        { actor: 'orchestrator' }
                    );
                    return null;
                } catch (error) {
                    return `Operator-confirmed lane recovery event could not be recorded: ${errorMessage(error)}`;
                }
            }
        } : {})
    });
    if (recoveredLanes.length === 0 || combined.status === 'BLOCKED') {
        return combined;
    }
    return {
        ...combined,
        output_lines: [
            ...combined.output_lines,
            `OperatorConfirmedLaneRecovery: lanes=${recoveredLanes.join(',')} child=${recoveredChildTaskId || '<unknown>'} ` +
            `confirmed_at_utc=${params.recovery.confirmedAtUtc} event=${REVIEW_FOLLOW_UP_LANES_RECOVERED_EVENT_TYPE}`
        ]
    };
}
