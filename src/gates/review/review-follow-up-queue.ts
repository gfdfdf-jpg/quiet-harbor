import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { countNextStepWork } from '../../core/next-step-measurement';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { normalizePath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { readTaskQueueEntries, type TaskQueueEntry } from '../../core/task-queue-read';
import type { ReviewFollowUpMaterializationMode } from '../../policy/profile-resolver';

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

export function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

export function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
}

function extractReviewFollowUpFingerprint(notes: string): string | null {
    return normalizeSha256(String(notes || '').match(/review_follow_up_fingerprint=([0-9a-f]{64})/iu)?.[1] || null);
}

function extractGroupedReviewFollowUpFingerprint(notes: string): string | null {
    return normalizeSha256(
        String(notes || '').match(/review_follow_up_group_fingerprint=([0-9a-f]{64})/iu)?.[1] || null
    );
}

export function extractGroupedReviewFollowUpSnapshotHash(notes: string): string | null {
    return normalizeSha256(
        String(notes || '').match(/review_follow_up_snapshot_sha256=([0-9a-f]{64})/iu)?.[1] || null
    );
}

export function extractGroupedReviewFollowUpCycleId(notes: string): string | null {
    return normalizeSha256(
        String(notes || '').match(/review_follow_up_cycle=([0-9a-f]{64})/iu)?.[1] || null
    );
}

interface GroupedReviewFollowUpLaneBinding {
    itemCount: number;
    itemFingerprintsSha256: string;
    sourceBindingSha256: string;
    artifactPath: string | null;
}

function extractGroupedReviewFollowUpLaneBindings(notes: string): Map<string, GroupedReviewFollowUpLaneBinding> {
    const bindings = new Map<string, GroupedReviewFollowUpLaneBinding>();
    const artifactPaths = new Map<string, string>();
    const artifactMatcher = /review_follow_up_lane_artifact=([a-z0-9_-]+):`([^`\r\n]+)`\./giu;
    for (const match of String(notes || '').matchAll(artifactMatcher)) {
        artifactPaths.set(match[1].toLowerCase(), normalizePath(match[2]));
    }
    const matcher = /review_follow_up_lane_binding=([a-z0-9_-]+):([0-9]+):([0-9a-f]{64}):([0-9a-f]{64})\./giu;
    for (const match of String(notes || '').matchAll(matcher)) {
        const itemCount = Number.parseInt(match[2], 10);
        const itemFingerprintsSha256 = normalizeSha256(match[3]);
        const sourceBindingSha256 = normalizeSha256(match[4]);
        if (Number.isSafeInteger(itemCount) && itemCount >= 0 && itemFingerprintsSha256 && sourceBindingSha256) {
            bindings.set(match[1].toLowerCase(), {
                itemCount,
                itemFingerprintsSha256,
                sourceBindingSha256,
                artifactPath: artifactPaths.get(match[1].toLowerCase()) || null
            });
        }
    }
    return bindings;
}

function isParentFollowUpTaskId(parentTaskId: string, taskId: string): boolean {
    const prefix = `${parentTaskId}-F`;
    if (!taskId.startsWith(prefix)) {
        return false;
    }
    return /^[1-9][0-9]*$/u.test(taskId.slice(prefix.length));
}

export interface TaskQueueFollowUpFingerprintIndex {
    groupedByTask: Map<string, Map<string, GroupedReviewFollowUpLaneBinding>>;
    groupedFingerprintByTask: Map<string, string>;
    perFindingByTask: Map<string, string>;
}

export function buildTaskQueueFollowUpFingerprintIndex(
    taskEntries: ReadonlyMap<string, TaskQueueEntry>,
    parentTaskId: string
): TaskQueueFollowUpFingerprintIndex | null {
    const groupedByTask = new Map<string, Map<string, GroupedReviewFollowUpLaneBinding>>();
    const groupedFingerprintByTask = new Map<string, string>();
    const perFindingByTask = new Map<string, string>();
    for (const row of taskEntries.values()) {
        countNextStepWork('visit:next-step-review-artifact-readers:event:1595');
        if (!isParentFollowUpTaskId(parentTaskId, row.taskId)) {
            continue;
        }
        const notes = row.notes || '';
        const fingerprint = extractReviewFollowUpFingerprint(notes);
        if (fingerprint) {
            perFindingByTask.set(row.taskId, fingerprint);
        }
        const groupedBindings = extractGroupedReviewFollowUpLaneBindings(notes);
        if (groupedBindings.size > 0) {
            groupedByTask.set(row.taskId, groupedBindings);
        }
        const groupedFingerprint = extractGroupedReviewFollowUpFingerprint(notes);
        if (groupedFingerprint) {
            groupedFingerprintByTask.set(row.taskId, groupedFingerprint);
        }
    }
    return { groupedByTask, groupedFingerprintByTask, perFindingByTask };
}

export function readTaskQueueFollowUpFingerprintIndex(
    repoRoot: string,
    parentTaskId: string
): TaskQueueFollowUpFingerprintIndex | null {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    if (!fileExists(taskPath)) {
        return null;
    }
    return buildTaskQueueFollowUpFingerprintIndex(readTaskQueueEntries(repoRoot), parentTaskId);
}

function taskQueueHasFollowUpFingerprint(
    taskQueueFollowUpFingerprints: ReadonlyMap<string, string>,
    parentTaskId: string,
    taskId: string,
    fingerprint: string
): boolean {
    return (
        isParentFollowUpTaskId(parentTaskId, taskId)
        && taskQueueFollowUpFingerprints.get(taskId) === fingerprint
    );
}

function taskQueueHasGroupedFollowUpBinding(
    taskQueueGroupedFollowUpBindings: ReadonlyMap<string, ReadonlyMap<string, GroupedReviewFollowUpLaneBinding>>,
    taskQueueGroupedFollowUpFingerprints: ReadonlyMap<string, string>,
    parentTaskId: string,
    taskId: string,
    groupFingerprint: string,
    reviewType: string,
    itemFingerprints: readonly string[],
    sourceBindingSha256: string,
    artifactPath: string
): boolean {
    const binding = taskQueueGroupedFollowUpBindings.get(taskId)?.get(reviewType.toLowerCase());
    return (
        isParentFollowUpTaskId(parentTaskId, taskId)
        && taskQueueGroupedFollowUpFingerprints.get(taskId) === groupFingerprint
        && binding?.itemCount === itemFingerprints.length
        && binding.itemFingerprintsSha256 === sha256JsonPayload([...itemFingerprints].sort())
        && binding.sourceBindingSha256 === sourceBindingSha256
        && binding.artifactPath === normalizePath(artifactPath)
    );
}

function buildGroupedReviewFollowUpSourceBindingSha256(
    artifact: Record<string, unknown>,
    reviewType: string
): string | null {
    const sourceDisposition = isPlainRecord(artifact.source_disposition) ? artifact.source_disposition : null;
    const sourceValidation = isPlainRecord(artifact.source_validation) ? artifact.source_validation : null;
    const sourceReceipt = isPlainRecord(artifact.source_receipt) ? artifact.source_receipt : null;
    const validationArtifactSha256 = normalizeSha256(sourceValidation?.artifact_sha256);
    const validationResultSha256 = normalizeSha256(sourceValidation?.validation_result_sha256);
    const receiptSha256 = normalizeSha256(sourceReceipt?.receipt_sha256);
    const dispositionArtifactSha256 = normalizeSha256(sourceDisposition?.artifact_sha256);
    const dispositionResultSha256 = normalizeSha256(sourceDisposition?.disposition_result_sha256);
    if (
        !validationArtifactSha256
        || !validationResultSha256
        || !receiptSha256
        || !dispositionArtifactSha256
        || !dispositionResultSha256
    ) {
        return null;
    }
    return sha256JsonPayload({
        schema_version: 1,
        review_type: reviewType,
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationResultSha256,
        receipt_sha256: receiptSha256,
        disposition_artifact_sha256: dispositionArtifactSha256,
        disposition_result_sha256: dispositionResultSha256
    });
}

function dispositionFollowUpItemKey(item: Record<string, unknown>): string | null {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    const severity = typeof item.severity === 'string' ? item.severity.trim() : '';
    const action = typeof item.action === 'string' ? item.action.trim() : '';
    const sourceRule = typeof item.source_rule === 'string' ? item.source_rule.trim() : '';
    if (!id || !kind || !severity || action !== 'create_follow_up' || !sourceRule) {
        return null;
    }
    return [id, kind, severity, action, sourceRule].join('\u0000');
}

function followUpArtifactItemKey(item: Record<string, unknown>): string | null {
    const id = typeof item.source_item_id === 'string' ? item.source_item_id.trim() : '';
    const kind = typeof item.source_item_kind === 'string' ? item.source_item_kind.trim() : '';
    const severity = typeof item.severity === 'string' ? item.severity.trim() : '';
    const action = typeof item.action === 'string' ? item.action.trim() : '';
    const sourceRule = typeof item.source_rule === 'string' ? item.source_rule.trim() : '';
    if (!id || !kind || !severity || action !== 'create_follow_up' || !sourceRule) {
        return null;
    }
    return [id, kind, severity, action, sourceRule].join('\u0000');
}

function buildDispositionFollowUpFingerprint(params: {
    taskId: string;
    reviewType: string;
    item: Record<string, unknown>;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
}): string | null {
    const id = typeof params.item.id === 'string' ? params.item.id.trim() : '';
    const kind = typeof params.item.kind === 'string' ? params.item.kind.trim() : '';
    const severity = typeof params.item.severity === 'string' ? params.item.severity.trim() : '';
    const action = typeof params.item.action === 'string' ? params.item.action.trim() : '';
    const sourceRule = typeof params.item.source_rule === 'string' ? params.item.source_rule.trim() : '';
    if (!id || !kind || !severity || action !== 'create_follow_up' || !sourceRule) {
        return null;
    }
    return sha256JsonPayload({
        schema_version: 1,
        parent_task_id: params.taskId,
        review_type: params.reviewType,
        item_id: id,
        item_kind: kind,
        severity,
        action,
        source_rule: sourceRule,
        validation_artifact_sha256: params.validationArtifactSha256,
        validation_result_sha256: params.validationResultSha256,
        disposition_artifact_sha256: params.dispositionArtifactSha256,
        disposition_result_sha256: params.dispositionResultSha256
    });
}

function buildExpectedDispositionFollowUpFingerprintIndex(params: {
    dispositionArtifact: Record<string, unknown>;
    dispositionArtifactSha256: string;
    taskId: string;
    reviewType: string;
    expectedFollowUpCount: number;
    extraItems?: Record<string, unknown>[];
}): Map<string, string> | null {
    if (params.dispositionArtifact.task_id !== params.taskId || params.dispositionArtifact.review_type !== params.reviewType) {
        return null;
    }
    const sourceValidation = isPlainRecord(params.dispositionArtifact.source_validation)
        ? params.dispositionArtifact.source_validation
        : null;
    const validationArtifactSha256 = normalizeSha256(sourceValidation?.artifact_sha256);
    const validationResultSha256 = normalizeSha256(sourceValidation?.validation_result_sha256);
    const dispositionResultSha256 = normalizeSha256(params.dispositionArtifact.disposition_result_sha256);
    if (!validationArtifactSha256 || !validationResultSha256 || !dispositionResultSha256) {
        return null;
    }
    const dispositionItems = Array.isArray(params.dispositionArtifact.items)
        ? params.dispositionArtifact.items.filter((item): item is Record<string, unknown> => (
            isPlainRecord(item) && item.action === 'create_follow_up'
        ))
        : [];
    dispositionItems.push(...(params.extraItems || []));
    if (dispositionItems.length !== params.expectedFollowUpCount) {
        return null;
    }
    const expected = new Map<string, string>();
    for (const item of dispositionItems) {
        const key = dispositionFollowUpItemKey(item);
        const fingerprint = buildDispositionFollowUpFingerprint({
            taskId: params.taskId,
            reviewType: params.reviewType,
            item,
            validationArtifactSha256,
            validationResultSha256,
            dispositionArtifactSha256: params.dispositionArtifactSha256,
            dispositionResultSha256
        });
        if (!key || !fingerprint || expected.has(key)) {
            return null;
        }
        expected.set(key, fingerprint);
    }
    return expected;
}

export function followUpArtifactMatchesCurrentTaskQueue(params: {
    artifact: Record<string, unknown>;
    dispositionArtifact: Record<string, unknown>;
    dispositionArtifactSha256: string;
    repoRoot?: string;
    taskId: string;
    reviewType: string;
    expectedFollowUpCount: number;
    materializationMode: ReviewFollowUpMaterializationMode;
    followUpArtifactPath: string;
    taskQueueFollowUpFingerprintIndex?: TaskQueueFollowUpFingerprintIndex | null;
    queueGroupFingerprint?: string;
    expectedGroupedChildTaskId?: string;
}): boolean {
    if (!params.repoRoot) {
        return false;
    }
    if (params.artifact.task_id !== params.taskId || params.artifact.review_type !== params.reviewType) {
        return false;
    }
    if (Array.isArray(params.artifact.violations) && params.artifact.violations.length > 0) {
        return false;
    }
    const sourceCount = Array.isArray(params.dispositionArtifact.items)
        ? params.dispositionArtifact.items.filter(item => isPlainRecord(item) && item.action === 'create_follow_up').length : 0;
    const expectedCount = sourceCount;
    // Callers may hold either the review-only disposition count or the complete lane registry count.
    if (params.expectedFollowUpCount !== sourceCount && params.expectedFollowUpCount !== expectedCount) return false;
    const items = Array.isArray(params.artifact.items) ? params.artifact.items : [];
    const followUpItems = items.filter((item): item is Record<string, unknown> => (
        isPlainRecord(item) && item.action === 'create_follow_up'
    ));
    const summary = isPlainRecord(params.artifact.summary) ? params.artifact.summary : null;
    const materializationPolicy = isPlainRecord(params.artifact.materialization_policy)
        ? params.artifact.materialization_policy
        : null;
    if ((materializationPolicy?.mode || 'per_finding') !== params.materializationMode) {
        return false;
    }
    const summaryFollowUpCount = typeof summary?.follow_up_obligation_count === 'number'
        ? summary.follow_up_obligation_count
        : null;
    if (summaryFollowUpCount !== expectedCount) {
        return false;
    }
    if (followUpItems.length !== expectedCount) {
        return false;
    }
    const expectedFingerprints = buildExpectedDispositionFollowUpFingerprintIndex({
        dispositionArtifact: params.dispositionArtifact,
        dispositionArtifactSha256: params.dispositionArtifactSha256,
        taskId: params.taskId,
        reviewType: params.reviewType,
        expectedFollowUpCount: expectedCount,
        extraItems: []
    });
    if (!expectedFingerprints || expectedFingerprints.size !== expectedCount) {
        return false;
    }
    if (followUpItems.length === 0) {
        return expectedCount === 0 && params.artifact.status === 'NOT_REQUIRED';
    }
    const taskQueueFollowUpFingerprintIndex = params.taskQueueFollowUpFingerprintIndex
        ?? readTaskQueueFollowUpFingerprintIndex(params.repoRoot, params.taskId);
    if (!taskQueueFollowUpFingerprintIndex) {
        return false;
    }
    const sourceItemKeys = new Set<string>();
    const taskIds = new Set<string>();
    const fingerprints = new Set<string>();
    const itemsMatch = followUpItems.every((item) => {
        const taskId = typeof item.task_id === 'string' ? item.task_id.trim() : '';
        const fingerprint = normalizeSha256(item.fingerprint);
        const sourceItemKey = followUpArtifactItemKey(item);
        const expectedFingerprint = sourceItemKey ? expectedFingerprints.get(sourceItemKey) : null;
        const materializationStatus = typeof item.materialization_status === 'string'
            ? item.materialization_status
            : '';
        if (
            !taskId
            || !fingerprint
            || !sourceItemKey
            || sourceItemKeys.has(sourceItemKey)
            || (params.materializationMode === 'per_finding' && taskIds.has(taskId))
            || fingerprints.has(fingerprint)
        ) {
            return false;
        }
        sourceItemKeys.add(sourceItemKey);
        taskIds.add(taskId);
        fingerprints.add(fingerprint);
        return (
            ['created', 'already_materialized'].includes(materializationStatus)
            && fingerprint === expectedFingerprint
            && (params.materializationMode === 'grouped_by_parent'
                ? true
                : taskQueueHasFollowUpFingerprint(
                    taskQueueFollowUpFingerprintIndex.perFindingByTask,
                    params.taskId,
                    taskId,
                    fingerprint as string
                ))
        );
    });
    if (!itemsMatch || sourceItemKeys.size !== expectedFingerprints.size) {
        return false;
    }
    if (params.materializationMode !== 'grouped_by_parent') {
        return true;
    }
    const [groupedTaskId] = [...taskIds];
    const groupFingerprint = normalizeSha256(materializationPolicy?.group_fingerprint);
    const sourceBindingSha256 = buildGroupedReviewFollowUpSourceBindingSha256(params.artifact, params.reviewType);
    return (
        taskIds.size === 1
        && Boolean(groupedTaskId)
        && (!params.expectedGroupedChildTaskId || groupedTaskId === params.expectedGroupedChildTaskId)
        && ![...taskQueueFollowUpFingerprintIndex.groupedFingerprintByTask].some(([childId, fingerprint]) =>
            childId !== groupedTaskId && fingerprint === (params.queueGroupFingerprint || groupFingerprint))
        && Boolean(groupFingerprint)
        && Boolean(sourceBindingSha256)
        && taskQueueHasGroupedFollowUpBinding(
            taskQueueFollowUpFingerprintIndex.groupedByTask,
            taskQueueFollowUpFingerprintIndex.groupedFingerprintByTask,
            params.taskId,
            groupedTaskId,
            params.queueGroupFingerprint || groupFingerprint as string,
            params.reviewType,
            [...fingerprints],
            sourceBindingSha256 as string,
            normalizePath(path.relative(params.repoRoot, params.followUpArtifactPath))
        )
    );
}

