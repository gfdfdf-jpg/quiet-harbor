import * as path from 'node:path';

import { isPathRealpathInsideRoot, joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { validateReviewRemediationBaselineArtifact } from './review-remediation-baseline';
import { readReviewValidationBytes } from '../review-context/review-validation-invocation';
import { collectRemediationLaneHistory, readAuthenticatedRemediationLaneReceipt } from './review-remediation-scope-review-types';

export interface RemediationOriginCandidate {
    reviewType: string;
    /** Task-event sequence of the review's latest REVIEW_RECORDED. */
    sequence: number;
    /** A failed review owns the remediation; a passed one (baseline without fix-now items) anchors a later change. */
    failed: boolean;
}

/**
 * Reviews a restart can measure a fix against: the latest REVIEW_RECORDED of the review binds an authenticated
 * remediation baseline snapshot of the tree it reviewed, and its receipt authenticates. A baseline file left behind
 * by an earlier attempt, or a review recorded without a baseline (such as one recorded by Garda 1.4.3), is not one.
 * Newest record first, so the choice never depends on the order of the review list.
 */
export function collectRemediationOriginCandidates(options: {
    repoRoot: string;
    taskId: string;
    requiredReviewTypes: readonly string[];
}): RemediationOriginCandidate[] {
    return [...iterateRemediationOriginCandidates(options)];
}

/** Validate in newest-first order so a consumer taking the first usable origin need not read older, unused evidence. */
export function* iterateRemediationOriginCandidates(options: {
    repoRoot: string;
    taskId: string;
    requiredReviewTypes: readonly string[];
    /** Reject unused candidates before authenticating their referenced artifacts; this never admits a candidate. */
    mayIncludeBaseline?: (baseline: unknown) => boolean;
}): Generator<RemediationOriginCandidate> {
    const history = collectRemediationLaneHistory({ repoRoot: options.repoRoot, taskId: options.taskId });
    if (history.integrity.status !== 'PASS') return;
    const reviewsRoot = joinOrchestratorPath(options.repoRoot, 'runtime/reviews');
    const reviewTypes = [...new Set(options.requiredReviewTypes)].sort((left, right) =>
        (history.lanes.get(right)?.sequence ?? -1) - (history.lanes.get(left)?.sequence ?? -1));
    for (const reviewType of reviewTypes) {
        const lane = history.lanes.get(reviewType);
        const authenticated = lane
            ? authenticateLaneRecord({ ...options, reviewsRoot, history, reviewType, lane })
            : null;
        if (!lane || !authenticated) continue;
        yield {
            reviewType,
            sequence: lane.sequence,
            failed: !authenticated.receiptPassed || authenticated.fixNowItemCount > 0
        };
    }
}

type RemediationLaneHistory = ReturnType<typeof collectRemediationLaneHistory>;
type RemediationLane = NonNullable<ReturnType<RemediationLaneHistory['lanes']['get']>>;

/** The latest record of a lane binds an authenticated baseline of the tree it reviewed and an authenticated receipt. */
function authenticateLaneRecord(options: {
    repoRoot: string;
    taskId: string;
    reviewsRoot: string;
    history: RemediationLaneHistory;
    reviewType: string;
    lane: RemediationLane;
    mayIncludeBaseline?: (baseline: unknown) => boolean;
}): { receiptPassed: boolean; fixNowItemCount: number } | null {
    const { lane, reviewType } = options;
    const details = lane.details;
    const snapshotPathValue = String(details?.remediation_baseline_snapshot_path || '').trim();
    const snapshotSha256 = String(details?.remediation_baseline_snapshot_sha256 || '').trim().toLowerCase();
    if (!details || !snapshotPathValue || !/^[0-9a-f]{64}$/u.test(snapshotSha256)) return null;
    const snapshotPath = path.resolve(options.repoRoot, snapshotPathValue);
    const expectedName = `${options.taskId}-${reviewType}-remediation-baseline-${snapshotSha256}.json`.toLowerCase();
    if (path.basename(snapshotPath).toLowerCase() !== expectedName
        || !isPathRealpathInsideRoot(snapshotPath, options.reviewsRoot, { allowMissing: false })) return null;
    if (options.mayIncludeBaseline) {
        try {
            if (!options.mayIncludeBaseline(JSON.parse(readReviewValidationBytes(snapshotPath).toString('utf8')))) return null;
        } catch { return null; }
    }
    const baseline = validateReviewRemediationBaselineArtifact({
        artifactPath: snapshotPath,
        expectedArtifactSha256: snapshotSha256,
        expectedTaskId: options.taskId,
        expectedReviewType: reviewType,
        // A kept (REUSE) review keeps the baseline of the review it reused, bound to the tree that review saw.
        expectedReviewTreeStateSha256: lane.reviewedTree.trim() || null
    });
    if (!baseline.valid || !baseline.artifact) return null;
    const receipt = readAuthenticatedRemediationLaneReceipt({
        repoRoot: options.repoRoot, taskId: options.taskId, reviewType, details,
        timingEvents: options.history.timingEvents, trustedReceipts: options.history.trustedReceipts
    });
    if (!receipt.authenticated) return null;
    return { receiptPassed: receipt.passed, fixNowItemCount: baseline.artifact.fix_now_items.length };
}

/**
 * The latest recorded review of `reviewType` is an authenticated failure with fix_now items, recorded for the current
 * preflight on the reviewed tree that is still current, with no later task, preflight or review-cycle boundary.
 * Such a failure stays the owner of the next step even when its review context was rebuilt afterwards (a rebuilt
 * context changes the context and coverage hashes the receipt is checked against, but not the reviewed code).
 * `currentReceiptSha256` must be the hash of the receipt file in place, which must be that record's receipt.
 */
export function hasRecordedFixNowFailureOnReviewedTree(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    reviewTreeStateSha256: string;
    currentReceiptSha256: string;
}): boolean {
    const history = collectRemediationLaneHistory({ repoRoot: options.repoRoot, taskId: options.taskId });
    if (history.integrity.status !== 'PASS') return false;
    const lane = history.lanes.get(options.reviewType);
    const details = lane?.details;
    const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();
    if (!lane || !details || lane.sequence <= history.latestCycleBoundarySequence
        || normalized(details.preflight_sha256) !== normalized(options.preflightSha256)
        || normalized(details.receipt_sha256) !== normalized(options.currentReceiptSha256)
        || normalized(details.review_tree_state_sha256) !== normalized(options.reviewTreeStateSha256)
        || normalized(lane.reviewedTree) !== normalized(options.reviewTreeStateSha256)) return false;
    const authenticated = authenticateLaneRecord({ ...options, history, lane,
        reviewsRoot: joinOrchestratorPath(options.repoRoot, 'runtime/reviews') });
    return Boolean(authenticated && !authenticated.receiptPassed && authenticated.fixNowItemCount > 0);
}

/** Events after which a failed review no longer owns the remediation of its task cycle. */
const OPEN_REMEDIATION_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
    'TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED', 'PREFLIGHT_FAILED', 'COHERENT_CYCLE_RESTARTED',
    'REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'COMPLETION_GATE_FAILED', 'COMPLETION_GATE_PASSED'
]);

/**
 * The latest recorded review of `reviewType` is an authenticated fix_now failure (receipt in place, delegated
 * invocation attestation and trusted timing, remediation baseline bound to the reviewed tree) whose remediation is
 * still open on the current preflight: every later preflight was refreshed by restart-review-cycle for this failed
 * lane (a completed REVIEW_CYCLE_RESTARTED bound to that preflight, or a classification that names this lane as its
 * review restart origin), and no later task, coherent-cycle or review-gate boundary, reviewer launch, recorded review
 * or review phase of another lane exists (the failed lane's own re-review phase may have opened). A fix that
 * continues after such a restart is still the fix of this failure, not a new change after accepted reviews.
 */
export function hasOpenFixNowRemediationOnCurrentPreflight(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    currentReceiptSha256: string;
}): boolean {
    const history = collectRemediationLaneHistory({ repoRoot: options.repoRoot, taskId: options.taskId });
    if (history.integrity.status !== 'PASS') return false;
    const lane = history.lanes.get(options.reviewType);
    const details = lane?.details;
    const normalized = (value: unknown): string => String(value || '').trim().toLowerCase();
    const currentPreflightSha256 = normalized(options.preflightSha256);
    if (!lane || !details || lane.sequence <= 0 || !/^[0-9a-f]{64}$/u.test(currentPreflightSha256)
        || normalized(details.receipt_sha256) !== normalized(options.currentReceiptSha256)) return false;

    let open = true;
    let refreshed = false;
    let latestPreflightSha256 = normalized(details.preflight_sha256);
    let latestPreflightOwned = true;
    const timelinePath = joinOrchestratorPath(options.repoRoot, 'runtime/task-events/' + options.taskId + '.jsonl');
    const integrity = inspectTaskEventFile(timelinePath, options.taskId, {
        onIntegrityEvent: (event) => {
            const sequence = Number(isPlainRecord(event.integrity) ? event.integrity.task_sequence : 0) || 0;
            if (!open || sequence <= lane.sequence) return;
            const eventType = String(event.event_type || '');
            const eventDetails = isPlainRecord(event.details) ? event.details : {};
            // After the restart, the re-review of the failed lane may open its phase; any reviewer launch, recorded
            // review or other lane's phase belongs to the new cycle, and a change then follows the review rules.
            const laterReview = eventType === 'REVIEW_RECORDED' || eventType.startsWith('REVIEWER_')
                || (eventType === 'REVIEW_PHASE_STARTED' && normalized(eventDetails.review_type) !== options.reviewType);
            if (OPEN_REMEDIATION_TERMINAL_EVENT_TYPES.has(eventType) || (refreshed && laterReview)) {
                open = false;
            } else if (eventType === 'PREFLIGHT_STARTED') {
                refreshed = true;
                latestPreflightOwned = false;
                latestPreflightSha256 = '';
            } else if (eventType === 'PREFLIGHT_CLASSIFIED') {
                refreshed = true;
                const origin = isPlainRecord(eventDetails.review_restart_origin) ? eventDetails.review_restart_origin : null;
                latestPreflightSha256 = event.actor === 'gate' ? normalized(eventDetails.output_sha256) : '';
                latestPreflightOwned = Boolean(latestPreflightSha256) && normalized(origin?.review_type) === options.reviewType;
            } else if (eventType === 'REVIEW_CYCLE_RESTARTED') {
                const decision = isPlainRecord(eventDetails.authoritative_review_decision)
                    ? eventDetails.authoritative_review_decision : {};
                // Only a completed remediation restart of this failed lane, bound to the preflight it refreshed.
                open = event.outcome === 'PASS' && eventDetails.status === 'PASSED'
                    && eventDetails.restart_reason === 'failed_review_remediation_cycle'
                    && normalized(decision.current_review_type) === options.reviewType
                    && Boolean(latestPreflightSha256)
                    && normalized(eventDetails.preflight_sha256) === latestPreflightSha256;
                refreshed = true;
                latestPreflightOwned = open;
            }
        }
    });
    if (integrity.status !== 'PASS' || !open || !refreshed || !latestPreflightOwned
        || latestPreflightSha256 !== currentPreflightSha256) return false;
    const authenticated = authenticateLaneRecord({ ...options, history, lane,
        reviewsRoot: joinOrchestratorPath(options.repoRoot, 'runtime/reviews') });
    return Boolean(authenticated && !authenticated.receiptPassed && authenticated.fixNowItemCount > 0);
}

/**
 * The review a restart without `--review-type` measures the fix against, as next-step chooses it: the newest failed
 * review owns the remediation; without one, the newest passed review anchors a change made after reviews passed.
 */
export function resolveRemediationOriginReviewType(options: {
    repoRoot: string;
    taskId: string;
    requiredReviewTypes: readonly string[];
}): string | null {
    const candidates = collectRemediationOriginCandidates(options);
    return (candidates.find((candidate) => candidate.failed) ?? candidates[0])?.reviewType ?? null;
}
