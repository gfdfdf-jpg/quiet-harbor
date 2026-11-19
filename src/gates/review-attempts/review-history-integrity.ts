import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { countNextStepWork } from '../../core/next-step-measurement';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { joinOrchestratorPath } from '../shared/helpers';
import { getReviewFindingsValidationArtifactPath, normalizeReviewFindingsValidationReceiptReference,
    validateReviewFindingsValidationArtifactForReceipt } from '../review/review-findings-validation-artifact';
import { resolveLockedReviewFindingPolicyFromReceiptDisposition,
    reviewFindingsValidationArtifactHasBlockingFindings } from '../review/review-finding-disposition';
import { createReviewAttemptArtifactIndex, type ReviewAttemptSnapshotReader } from './review-attempt-artifact-index';

interface ReviewCycleArtifactVerdictResult { failed: boolean | null; invalidSnapshot: boolean; }
function normalizeReviewCycleSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function resolveReviewCycleReviewsRoot(repoRoot: string): string {
    return path.resolve(joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')));
}

function validateReviewCycleReceiptSnapshotBinding(
    artifactIndex: ReviewAttemptSnapshotReader,
    taskId: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    reviewArtifactSnapshotSha256: string
): boolean {
    const receiptSnapshotPath = details?.receipt_snapshot_path ?? details?.receiptSnapshotPath;
    const receiptSnapshotSha256 = normalizeReviewCycleSha256(details?.receipt_snapshot_sha256 ?? details?.receiptSnapshotSha256);
    const hasReceiptSnapshotEvidence = Boolean(String(receiptSnapshotPath || '').trim() || receiptSnapshotSha256);
    if (!hasReceiptSnapshotEvidence) {
        return true;
    }
    if (!receiptSnapshotSha256) {
        return false;
    }
    const receiptResult = artifactIndex.readJsonSnapshot(
        receiptSnapshotPath,
        `${taskId}-${reviewType}-receipt-${receiptSnapshotSha256}.json`,
        receiptSnapshotSha256
    );
    const receipt = receiptResult.record;
    if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
        return false;
    }
    return normalizeReviewCycleSha256(receipt.review_artifact_sha256) === reviewArtifactSnapshotSha256;
}

export function resolveValidatedReviewCycleArtifactForVerdict(options: {
    artifactIndex: ReviewAttemptSnapshotReader;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
}): { content: string | null; resolvedPath: string | null; invalidSnapshot: boolean } {
    const snapshotPathText = String(
        options.details?.review_artifact_snapshot_path
        || options.details?.reviewArtifactSnapshotPath
        || ''
    ).trim();
    if (!snapshotPathText) {
        return { content: null, resolvedPath: null, invalidSnapshot: false };
    }
    const snapshotSha256 = normalizeReviewCycleSha256(
        options.details?.review_artifact_snapshot_sha256
        ?? options.details?.reviewArtifactSnapshotSha256
    );
    if (!snapshotSha256) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    const recordedArtifactSha256 = normalizeReviewCycleSha256(
        options.details?.review_artifact_sha256
        ?? options.details?.reviewArtifactSha256
    );
    if (recordedArtifactSha256 && recordedArtifactSha256 !== snapshotSha256) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    const expectedFileName = `${options.taskId}-${options.reviewType}-artifact-${snapshotSha256}.md`;
    const snapshotResult = options.artifactIndex.readTextSnapshot(
        snapshotPathText,
        expectedFileName,
        snapshotSha256
    );
    if (!snapshotResult.valid || snapshotResult.content === null) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    if (!validateReviewCycleReceiptSnapshotBinding(
        options.artifactIndex,
        options.taskId,
        options.reviewType,
        options.details,
        snapshotSha256
    )) {
        return { content: null, resolvedPath: null, invalidSnapshot: true };
    }
    return {
        content: snapshotResult.content,
        resolvedPath: path.resolve(resolveReviewCycleReviewsRoot(options.repoRoot), expectedFileName),
        invalidSnapshot: false
    };
}

function readValidatedReviewCycleReceiptSnapshot(options: {
    artifactIndex: ReviewAttemptSnapshotReader;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
    reviewArtifactSha256: string;
}): { receipt: Record<string, unknown> | null; invalidSnapshot: boolean } {
    const receiptSnapshotSha256 = normalizeReviewCycleSha256(
        options.details?.receipt_snapshot_sha256 ?? options.details?.receiptSnapshotSha256
    );
    const receiptSnapshotPath = options.details?.receipt_snapshot_path ?? options.details?.receiptSnapshotPath;
    if (!receiptSnapshotSha256 && !String(receiptSnapshotPath || '').trim()) {
        return { receipt: null, invalidSnapshot: false };
    }
    if (!receiptSnapshotSha256) {
        return { receipt: null, invalidSnapshot: true };
    }
    const receiptResult = options.artifactIndex.readJsonSnapshot(
        receiptSnapshotPath,
        `${options.taskId}-${options.reviewType}-receipt-${receiptSnapshotSha256}.json`,
        receiptSnapshotSha256
    );
    const receipt = receiptResult.record;
    if (!receipt || receipt.task_id !== options.taskId || receipt.review_type !== options.reviewType) {
        return { receipt: null, invalidSnapshot: true };
    }
    if (normalizeReviewCycleSha256(receipt.review_artifact_sha256) !== options.reviewArtifactSha256) {
        return { receipt: null, invalidSnapshot: true };
    }
    return { receipt, invalidSnapshot: false };
}

export function getReviewCycleValidationArtifactVerdict(options: {
    artifactIndex: ReviewAttemptSnapshotReader;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
    reviewArtifactSha256: string;
}): ReviewCycleArtifactVerdictResult | null {
    const receiptResult = readValidatedReviewCycleReceiptSnapshot(options);
    if (receiptResult.invalidSnapshot) {
        return { failed: null, invalidSnapshot: true };
    }
    if (!receiptResult.receipt || !receiptResult.receipt.review_findings_validation) {
        return null;
    }
    return getReviewCycleValidationVerdictFromReceipt(options, receiptResult.receipt);
}

function getReviewCycleValidationVerdictFromReceipt(options: {
    taskId: string; reviewType: string; details: Record<string, unknown> | null; reviewArtifactSha256: string;
}, receipt: Record<string, unknown>): ReviewCycleArtifactVerdictResult {
    const reusedExistingReview = receipt.reused_existing_review === true;
    const validationResult = validateReviewFindingsValidationArtifactForReceipt({
        receipt,
        reviewArtifactPath: String(options.details?.review_artifact_path ?? options.details?.reviewArtifactPath ?? ''),
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: typeof receipt.review_output_sha256 === 'string'
            ? receipt.review_output_sha256
            : null,
        expectedReviewArtifactSha256: options.reviewArtifactSha256,
        expectedReviewContextPath: reusedExistingReview
            ? null
            : String(options.details?.review_context_path ?? options.details?.reviewContextPath ?? '').trim() || null,
        expectedReviewContextSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receipt.reused_from_review_context_sha256)
            : normalizeReviewCycleSha256(options.details?.review_context_sha256 ?? options.details?.reviewContextSha256),
        expectedPreflightSha256: reusedExistingReview
            ? null
            : normalizeReviewCycleSha256(options.details?.preflight_sha256 ?? options.details?.preflightSha256),
        expectedScopeSha256: reusedExistingReview
            ? null
            : normalizeReviewCycleSha256(options.details?.scope_sha256 ?? options.details?.scopeSha256),
        expectedReviewScopeSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receipt.reused_from_review_scope_sha256)
            : normalizeReviewCycleSha256(options.details?.review_scope_sha256 ?? options.details?.reviewScopeSha256),
        expectedCodeScopeSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receipt.reused_from_code_scope_sha256)
            : normalizeReviewCycleSha256(options.details?.code_scope_sha256 ?? options.details?.codeScopeSha256),
        expectedReviewTreeStateSha256: reusedExistingReview
            ? normalizeReviewCycleSha256(receipt.reused_from_review_tree_state_sha256)
            : normalizeReviewCycleSha256(options.details?.review_tree_state_sha256 ?? options.details?.reviewTreeStateSha256),
        requireAccepted: true,
        preferSnapshot: true
    });
    if (!validationResult.valid) {
        return { failed: null, invalidSnapshot: true };
    }
    const policyResolution = resolveLockedReviewFindingPolicyFromReceiptDisposition(receipt);
    return {
        failed: reviewFindingsValidationArtifactHasBlockingFindings(validationResult.artifact, policyResolution),
        invalidSnapshot: false
    };
}

type HistorySnapshotKind = 'report' | 'receipt' | 'findings_validation';
interface LostHistorySnapshot { kind: HistorySnapshotKind; sha256: string; observed_sha256: string | null; }
export interface RecordedHistoryLoss {
    recorded_event_sha256: string;
    review_type: string;
    missing_snapshots: LostHistorySnapshot[];
}

function snapshotCommitment(reviewsRoot: string, taskId: string, lane: string,
    details: Record<string, unknown>, kind: HistorySnapshotKind): { file: string; sha256: string } | null {
    const validation = kind === 'findings_validation'
        ? normalizeReviewFindingsValidationReceiptReference(details.review_findings_validation) : null;
    const prefix = kind === 'report' ? 'review_artifact' : 'receipt';
    const sha256 = kind === 'findings_validation' ? validation?.snapshot_sha256 : normalizeReviewCycleSha256(details[`${prefix}_snapshot_sha256`]);
    const originalSha = kind === 'findings_validation' ? validation?.artifact_sha256 : normalizeReviewCycleSha256(details[`${prefix}_sha256`]);
    const candidate = String(kind === 'findings_validation' ? validation?.snapshot_path || '' : details[`${prefix}_snapshot_path`] || '').trim();
    if (!sha256 || originalSha !== sha256 || !candidate || !/^[a-z0-9_-]+$/u.test(lane)) return null;
    if (validation && (validation.status !== 'accepted' || !validation.accepted || validation.violation_count !== 0
        || validation.artifact_path !== getReviewFindingsValidationArtifactPath(String(details.review_artifact_path || '')))) return null;
    const suffix = kind === 'report' ? 'artifact' : kind === 'receipt' ? 'receipt' : 'findings-validation';
    const file = path.resolve(reviewsRoot, `${taskId}-${lane}-${suffix}-${sha256}.${kind === 'report' ? 'md' : 'json'}`);
    const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(reviewsRoot, candidate);
    const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    return comparable(file) === comparable(resolved) ? { file, sha256 } : null;
}

function observeSnapshot(file: string): { sha256: string | null } | null {
    try {
        const parent = path.dirname(file), actual = fs.realpathSync(parent), expected = path.resolve(parent);
        if ((process.platform === 'win32' ? actual.toLowerCase() : actual)
            !== (process.platform === 'win32' ? expected.toLowerCase() : expected)) return null;
        const before = fs.lstatSync(file);
        if (!before.isFile() || before.isSymbolicLink()) return null;
        const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        const after = fs.lstatSync(file);
        return before.dev === after.dev && before.ino === after.ino && before.size === after.size
            && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs ? { sha256 } : null;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' && fs.existsSync(path.dirname(file)) ? { sha256: null } : null;
    }
}

/** Capture only the current lane's exact missing immutable files, from a verified task timeline. */
export function captureLostReviewHistorySnapshots(options: {
    reviewsRoot: string; taskId: string; reviewType: string;
}): RecordedHistoryLoss[] {
    const events: Array<Readonly<Record<string, unknown>>> = [];
    const timeline = path.join(path.dirname(options.reviewsRoot), 'task-events', `${options.taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timeline, options.taskId, { onIntegrityEvent: event => events.push(event) });
    if (!inspection.status.startsWith('PASS') || inspection.violations.length) return [];
    let laneEvents: Array<Readonly<Record<string, unknown>>> = [];
    for (const event of events) {
        if (['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED'].includes(String(event.event_type))) laneEvents = [];
        const details = event.details as Record<string, unknown> | undefined;
        if (event.event_type === 'REVIEW_RECORDED' && event.actor === 'gate' && event.outcome === 'PASS'
            && details?.review_type === options.reviewType && details.task_id === options.taskId) laneEvents.push(event);
    }
    const current = laneEvents.at(-1);
    if (!current) return [];
    const details = current.details as Record<string, unknown>;
    const integrity = current.integrity as Record<string, unknown> | undefined;
    const recordedEventSha256 = normalizeReviewCycleSha256(integrity?.event_sha256);
    if (!recordedEventSha256 || details.task_id !== options.taskId) return [];
    const missing: LostHistorySnapshot[] = [];
    const kinds: HistorySnapshotKind[] = ['report', 'receipt'];
    if (details.review_findings_validation) kinds.push('findings_validation');
    for (const kind of kinds) {
        const commitment = snapshotCommitment(options.reviewsRoot, options.taskId, options.reviewType, details, kind);
        if (!commitment) return [];
        const observed = observeSnapshot(commitment.file);
        if (!observed) return [];
        if (observed.sha256 !== commitment.sha256)
            missing.push({ kind, sha256: commitment.sha256, observed_sha256: observed.sha256 });
    }
    if (!missing.length) return [];
    return laneEvents.flatMap(event => {
        const eventDetails = event.details as Record<string, unknown>;
        const eventIntegrity = event.integrity as Record<string, unknown> | undefined;
        const eventSha = normalizeReviewCycleSha256(eventIntegrity?.event_sha256);
        if (!eventSha) return [];
        const shared = missing.filter(entry => {
            const commitment = snapshotCommitment(options.reviewsRoot, options.taskId, options.reviewType, eventDetails, entry.kind);
            return commitment?.sha256 === entry.sha256;
        });
        return shared.length ? [{ recorded_event_sha256: eventSha,
            review_type: options.reviewType, missing_snapshots: shared }] : [];
    });
}

function recoveredHistoryLoss(options: {
    repoRoot: string; reviewsRoot: string; taskId: string; lane: string; details: Record<string, unknown>;
    event: { integrity?: unknown }; sequence: number; events: readonly { event_type?: unknown; actor?: unknown;
        outcome?: unknown; details?: unknown; integrity?: unknown }[]; artifactIndex: ReviewAttemptSnapshotReader;
}): boolean {
    const eventIntegrity = options.event.integrity as Record<string, unknown> | undefined;
    const eventSha = normalizeReviewCycleSha256(eventIntegrity?.event_sha256);
    if (!eventSha) return false;
    for (let restartIndex = options.sequence + 1; restartIndex < options.events.length; restartIndex += 1) {
        const restart = options.events[restartIndex];
        const details = restart.details as Record<string, unknown> | undefined;
        if (['TASK_RESET', 'TASK_DISCARDED', 'TASK_MODE_ENTERED'].includes(String(restart.event_type))) return false;
        if (restart.event_type !== 'REVIEW_CYCLE_RESTARTED' || restart.actor !== 'orchestrator' || restart.outcome !== 'PASS'
            || details?.task_id !== options.taskId || details.status !== 'PASSED'
            || details.detection_source !== 'review_evidence_only'
            || !Array.isArray(details.invalidated_review_types) || !details.invalidated_review_types.includes(options.lane)
            || !Array.isArray(details.lost_review_history_snapshots)) continue;
        const loss = details.lost_review_history_snapshots.find((entry: RecordedHistoryLoss) =>
            entry?.recorded_event_sha256 === eventSha && entry.review_type === options.lane);
        if (!loss || !Array.isArray(loss.missing_snapshots) || loss.missing_snapshots.length === 0) continue;
        const lost = new Set<HistorySnapshotKind>();
        let validLoss = true;
        for (const entry of loss.missing_snapshots as LostHistorySnapshot[]) {
            if (!entry || !['report', 'receipt', 'findings_validation'].includes(entry.kind) || lost.has(entry.kind)) { validLoss = false; break; }
            const commitment = snapshotCommitment(options.reviewsRoot, options.taskId, options.lane, options.details, entry.kind);
            const observed = commitment && observeSnapshot(commitment.file);
            if (!commitment || !observed || entry.sha256 !== commitment.sha256
                || !(entry.observed_sha256 === null || normalizeReviewCycleSha256(entry.observed_sha256) === entry.observed_sha256)
                || entry.observed_sha256 === commitment.sha256 || observed.sha256 !== entry.observed_sha256) { validLoss = false; break; }
            lost.add(entry.kind);
        }
        if (!validLoss) continue;
        const report = snapshotCommitment(options.reviewsRoot, options.taskId, options.lane, options.details, 'report');
        const receipt = snapshotCommitment(options.reviewsRoot, options.taskId, options.lane, options.details, 'receipt');
        if (!report || !receipt) continue;
        if (!lost.has('report') && !options.artifactIndex.readTextSnapshot(report.file, path.basename(report.file), report.sha256).valid) continue;
        let receiptRecord = options.details;
        if (!lost.has('receipt')) {
            const result = options.artifactIndex.readJsonSnapshot(receipt.file, path.basename(receipt.file), receipt.sha256);
            if (!result.valid || !result.record) continue;
            receiptRecord = result.record;
        }
        if (receiptRecord.task_id !== options.taskId || receiptRecord.review_type !== options.lane
            || normalizeReviewCycleSha256(receiptRecord.review_artifact_sha256) !== report.sha256
            || !receiptRecord.review_findings_validation) continue;
        if (lost.has('findings_validation')) {
            const eventReference = normalizeReviewFindingsValidationReceiptReference(options.details.review_findings_validation);
            const receiptReference = normalizeReviewFindingsValidationReceiptReference(receiptRecord.review_findings_validation);
            if (!eventReference || !receiptReference || JSON.stringify(eventReference) !== JSON.stringify(receiptReference)) continue;
        } else if (getReviewCycleValidationVerdictFromReceipt({ taskId: options.taskId, reviewType: options.lane,
            details: options.details, reviewArtifactSha256: report.sha256 }, receiptRecord).invalidSnapshot) continue;
        for (let i = restartIndex + 1; i < options.events.length; i += 1) {
            const event = options.events[i], fresh = event.details as Record<string, unknown> | undefined;
            if (['TASK_RESET', 'TASK_DISCARDED', 'TASK_MODE_ENTERED'].includes(String(event.event_type))) break;
            if (event.event_type !== 'REVIEW_RECORDED' || event.actor !== 'gate' || event.outcome !== 'PASS'
                || fresh?.task_id !== options.taskId || fresh.review_type !== options.lane
                || fresh.reused_existing_review === true || fresh.review_execution_mode !== 'FULL') continue;
            const readOptions = { artifactIndex: options.artifactIndex, repoRoot: options.repoRoot,
                taskId: options.taskId, reviewType: options.lane, details: fresh };
            const artifact = resolveValidatedReviewCycleArtifactForVerdict(readOptions);
            const digest = normalizeReviewCycleSha256(fresh.review_artifact_snapshot_sha256);
            const validation = digest && getReviewCycleValidationArtifactVerdict({ ...readOptions, reviewArtifactSha256: digest });
            if (!artifact.invalidSnapshot && artifact.content !== null && validation && !validation.invalidSnapshot
                && validation.failed === false) return true;
        }
    }
    return false;
}

/** Full-history enforcement for explicit audit/completion, independent of guard policy or verdict. */
export function getReviewHistoryIntegrityViolations(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    timelineEvents: readonly { event_type?: unknown; actor?: unknown; outcome?: unknown; details?: unknown; integrity?: unknown }[];
    includeSuperseded?: boolean;
}): string[] {
    return withReviewArtifactReadBarrier(options.reviewsRoot, () => {
        const artifactIndex = createReviewAttemptArtifactIndex(options.reviewsRoot, options.taskId);
        const violations: string[] = [];
        const recordDetails = (event: { details?: unknown }): Record<string, unknown> | null => (
            event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown> : null);
        const laneOf = (details: Record<string, unknown> | null): string => String(details?.review_type || details?.reviewType || '')
            .trim().toLowerCase();
        // Recovery can inspect only the latest result of each lane. A full audit opts in to checking every
        // committed snapshot, including earlier results that the review-cycle guard no longer relies on.
        const latestRecordedSequenceByLane = new Map<string, number>();
        for (const [sequence, event] of options.timelineEvents.entries()) {
            if (event.event_type === 'REVIEW_RECORDED') latestRecordedSequenceByLane.set(laneOf(recordDetails(event)), sequence);
        }
        for (const [sequence, event] of options.timelineEvents.entries()) {
            countNextStepWork('visit:review_history_integrity_event');
            if (event.event_type !== 'REVIEW_RECORDED') continue;
            const details = recordDetails(event);
            // Legacy attempts without an immutable snapshot commitment remain diagnostic-only.
            const snapshotPath = String(details?.review_artifact_snapshot_path || details?.reviewArtifactSnapshotPath || '').trim();
            if (!snapshotPath) continue;
            const reviewType = laneOf(details);
            if (!options.includeSuperseded && reviewType && (latestRecordedSequenceByLane.get(reviewType) ?? -1) > sequence) continue;
            let invalid = !reviewType;
            try {
                const artifact = resolveValidatedReviewCycleArtifactForVerdict({ artifactIndex,
                    repoRoot: options.repoRoot, taskId: options.taskId, reviewType, details });
                invalid ||= artifact.invalidSnapshot;
                if (!invalid) {
                    const digest = normalizeReviewCycleSha256(details?.review_artifact_snapshot_sha256
                        ?? details?.reviewArtifactSnapshotSha256)!;
                    const validation = getReviewCycleValidationArtifactVerdict({ artifactIndex,
                        repoRoot: options.repoRoot, taskId: options.taskId, reviewType, details,
                        reviewArtifactSha256: digest });
                    invalid ||= validation?.invalidSnapshot === true;
                }
            } catch {
                invalid = true;
            }
            if (invalid && options.includeSuperseded && details) {
                try {
                    invalid = !recoveredHistoryLoss({ repoRoot: options.repoRoot, reviewsRoot: options.reviewsRoot,
                        taskId: options.taskId, lane: reviewType, details, event, sequence,
                        events: options.timelineEvents, artifactIndex });
                } catch { invalid = true; }
            }
            if (invalid) violations.push(
                `Recorded review history integrity failed at event ${sequence} (${reviewType || 'unknown lane'}): `
                + 'the committed report, receipt or findings-validation snapshot is missing, changed or has invalid bindings.'
            );
        }
        return violations;
    });
}
