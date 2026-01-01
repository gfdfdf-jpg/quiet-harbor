import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/timeline/task-events-integrity';
import * as repairSchemas from '../full-suite/full-suite-repair-contracts';
import { normalizeReviewReceiptEvidenceFields } from '../review/review-evidence-contract';
import { followUpArtifactMatchesCurrentTaskQueue } from '../review/review-follow-up-queue';
import { validateHistoricalReviewRecordedTelemetryEventMatch } from '../review-reuse/review-reuse-telemetry';
import { pathsEqual } from '../review-reuse/review-reuse-telemetry-normalization';
import { isPathRealpathInsideRoot, joinOrchestratorPath, resolvePathInsideRepo } from '../shared/path-utils';
import { readReviewValidationBytes } from './review-validation-invocation';

// This is the exact suffix written by follow-up materialization, not a general Notes exemption.
const NOTE_SUFFIX = /(?:^|\s)(Review follow-up tasks materialized: (`[^`\r\n]+`(?:, `[^`\r\n]+`)*); artifact `([^`\r\n]+)`\.)$/u;
const REPAIR_NOTE_SUFFIX = /(?:^|\s)(Parent WIP suspended for the validated full-suite repair child handoff at `([^`\r\n]+)`\.)$/u;

function readBoundJson(repoRoot: string, rawPath: unknown, expectedSha256?: string): Record<string, unknown> | null {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
    try {
        const filePath = resolvePathInsideRepo(rawPath, repoRoot, { allowMissing: false, enforceInside: true });
        if (!filePath || !isPathRealpathInsideRoot(filePath, repoRoot, { allowMissing: false })) return null;
        const bytes = readReviewValidationBytes(filePath);
        if (expectedSha256 && createHash('sha256').update(bytes).digest('hex') !== expectedSha256) return null;
        const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function hash(value: unknown): string {
    const text = typeof value === 'string' ? value.toLowerCase() : '';
    return /^[0-9a-f]{64}$/u.test(text) ? text : '';
}

function verifiedTaskEvents(repoRoot: string, taskId: string): Readonly<Record<string, unknown>>[] | null {
    const events: Readonly<Record<string, unknown>>[] = [];
    const timeline = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const inspection = inspectTaskEventFile(timeline, taskId, { onIntegrityEvent: (event) => events.push(event) });
    return ['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) ? events : null;
}

/** The WIP note is also bookkeeping, but only when the native materialization event binds its exact manifest. */
function isMaterializedRepairNote(repoRoot: string, taskId: string, manifestPath: string): boolean {
    const events = verifiedTaskEvents(repoRoot, taskId);
    if (!events) return false;
    for (const event of events.reverse()) {
        const details = isPlainRecord(event.details) ? event.details : null;
        if (event.actor !== 'orchestrator' || event.event_type !== 'FULL_SUITE_REPAIR_TASK_MATERIALIZED'
            || event.outcome !== 'BLOCKED' || event.task_id !== taskId || !details
            || !pathsEqual(String(details.wip_manifest_path || ''), manifestPath)) continue;
        const artifactHash = hash(details.artifact_sha256);
        if (!artifactHash) continue;
        const artifact = readBoundJson(repoRoot, details.artifact_path, artifactHash);
        if (!artifact || artifact.status !== 'MATERIALIZED' || artifact.task_id !== taskId
            || ![repairSchemas.REPAIR_ARTIFACT_SCHEMA_VERSION, repairSchemas.LEGACY_REPAIR_ARTIFACT_SCHEMA_VERSION].includes(Number(artifact.schema_version))
            || !Array.isArray(artifact.violations) || artifact.violations.length !== 0
            || !pathsEqual(String(artifact.wip_manifest_path || ''), manifestPath)) continue;
        const manifestHash = hash(artifact.wip_manifest_sha256);
        const manifest = manifestHash ? readBoundJson(repoRoot, manifestPath, manifestHash) : null;
        if (!manifest || manifest.task_id !== taskId || manifest.kind !== 'full_suite_repair_wip' || manifest.status !== 'suspended'
            || ![repairSchemas.WIP_MANIFEST_SCHEMA_VERSION, repairSchemas.LEGACY_WIP_MANIFEST_SCHEMA_VERSION].includes(Number(manifest.schema_version))
            || !hash(artifact.full_suite_artifact_sha256) || hash(artifact.full_suite_artifact_sha256) !== hash(manifest.full_suite_artifact_sha256)
            || !pathsEqual(String(artifact.full_suite_artifact_path || ''), String(manifest.full_suite_artifact_path || ''))
            || !Array.isArray(manifest.child_task_ids)
            || manifest.child_task_ids.length < 1 || !Array.isArray(artifact.child_task_ids)
            || JSON.stringify(manifest.child_task_ids) !== JSON.stringify(artifact.child_task_ids)
            || JSON.stringify(details.child_task_ids) !== JSON.stringify(artifact.child_task_ids)) continue;
        return true;
    }
    return false;
}

/** Authenticate the exact note against its recorded receipt, disposition and materialized child rows. */
function isMaterializedNote(repoRoot: string, taskId: string, childIds: string[], artifactPath: string): boolean {
    if (!childIds.length || new Set(childIds).size !== childIds.length || childIds.some((id) => {
        const prefix = `${taskId}-F`;
        return !id.startsWith(prefix) || !/^[1-9][0-9]*$/u.test(id.slice(prefix.length));
    })) return false;
    const artifact = readBoundJson(repoRoot, artifactPath);
    if (!artifact || artifact.schema_version !== 1 || artifact.artifact_type !== 'review_findings_follow_up_tasks'
        || artifact.task_id !== taskId || !['MATERIALIZED', 'ALREADY_MATERIALIZED'].includes(String(artifact.status))
        || !Array.isArray(artifact.violations) || artifact.violations.length !== 0) return false;
    const reviewType = typeof artifact.review_type === 'string' ? artifact.review_type : '';
    const sourceReceipt = isPlainRecord(artifact.source_receipt) ? artifact.source_receipt : null;
    const sourceDisposition = isPlainRecord(artifact.source_disposition) ? artifact.source_disposition : null;
    const policy = isPlainRecord(artifact.materialization_policy) ? artifact.materialization_policy : null;
    const summary = isPlainRecord(artifact.summary) ? artifact.summary : null;
    const receiptHash = hash(sourceReceipt?.receipt_sha256);
    const dispositionHash = hash(sourceDisposition?.artifact_sha256);
    const receiptPath = typeof sourceReceipt?.receipt_path === 'string' ? sourceReceipt.receipt_path : '';
    const mode = policy?.mode === 'grouped_by_parent' ? 'grouped_by_parent' : policy?.mode === 'per_finding' ? 'per_finding' : null;
    const count = summary?.follow_up_obligation_count;
    const items = Array.isArray(artifact.items) ? artifact.items.filter(isPlainRecord) : [];
    if (!reviewType || !receiptHash || !receiptPath || !dispositionHash || !mode
        || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1
        || childIds.some((id) => !items.some((item) => item.action === 'create_follow_up' && item.task_id === id
            && ['created', 'already_materialized'].includes(String(item.materialization_status))))) return false;

    const events = verifiedTaskEvents(repoRoot, taskId);
    if (!events) return false;
    for (const event of events.reverse()) {
        const details = isPlainRecord(event.details) ? event.details : null;
        if (event.actor !== 'gate' || event.event_type !== 'REVIEW_RECORDED' || event.outcome !== 'PASS'
            || details?.task_id !== taskId || details.review_type !== reviewType
            || !pathsEqual(String(details.receipt_path || ''), receiptPath) || hash(details.receipt_sha256) !== receiptHash
            || hash(details.receipt_snapshot_sha256) !== receiptHash) continue;
        const receipt = readBoundJson(repoRoot, details.receipt_snapshot_path, receiptHash);
        if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) continue;
        const dispositionRef = isPlainRecord(receipt.review_findings_disposition_artifact)
            ? receipt.review_findings_disposition_artifact : null;
        if (hash(dispositionRef?.artifact_sha256) !== dispositionHash
            || !pathsEqual(String(dispositionRef?.artifact_path || ''), String(sourceDisposition?.artifact_path || ''))) continue;
        const disposition = readBoundJson(repoRoot, dispositionRef?.snapshot_path, dispositionHash)
            || readBoundJson(repoRoot, dispositionRef?.artifact_path, dispositionHash);
        if (!disposition) continue;
        const fields = normalizeReviewReceiptEvidenceFields(receipt);
        const telemetry = validateHistoricalReviewRecordedTelemetryEventMatch({
            event, repoRoot, taskId, reviewType, receiptPath, receiptSha256: receiptHash,
            reviewContextSha256: fields.reviewContextSha256, reviewArtifactSha256: fields.reviewArtifactSha256,
            reviewerExecutionMode: fields.reviewerExecutionMode, reviewerIdentity: fields.reviewerIdentity,
            reviewerProvenance: fields.reviewerProvenance as unknown as Record<string, unknown> | null,
            verifyReceiptSnapshot: true
        });
        if (!telemetry.matched) continue;
        if (followUpArtifactMatchesCurrentTaskQueue({
            artifact, dispositionArtifact: disposition, dispositionArtifactSha256: dispositionHash,
            repoRoot, taskId, reviewType, expectedFollowUpCount: count, materializationMode: mode,
            followUpArtifactPath: path.resolve(repoRoot, artifactPath)
        })) return true;
    }
    return false;
}

/** Leave unverified or edited suffixes in the criteria so they fail closed. */
export function taskCriteriaNotes(repoRoot: string, taskId: string, notes: string): string {
    let result = notes;
    for (;;) {
        const repairSuffix = REPAIR_NOTE_SUFFIX.exec(result);
        if (repairSuffix) {
            try {
                if (!isMaterializedRepairNote(repoRoot, taskId, repairSuffix[2])) break;
            } catch {
                break;
            }
            result = result.slice(0, repairSuffix.index).trimEnd();
            continue;
        }
        const suffix = NOTE_SUFFIX.exec(result);
        if (!suffix) break;
        const ids = [...suffix[2].matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
        try {
            if (!isMaterializedNote(repoRoot, taskId, ids, suffix[3])) break;
        } catch {
            break;
        }
        result = result.slice(0, suffix.index).trimEnd();
    }
    return result;
}
