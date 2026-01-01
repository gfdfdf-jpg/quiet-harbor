import * as path from 'node:path';

import { isPathRealpathInsideRoot, joinOrchestratorPath } from '../../core/orchestrator-paths';
import { validateReviewRemediationBaselineArtifact } from './review-remediation-baseline';
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
    const history = collectRemediationLaneHistory({ repoRoot: options.repoRoot, taskId: options.taskId });
    if (history.integrity.status !== 'PASS') return [];
    const reviewsRoot = joinOrchestratorPath(options.repoRoot, 'runtime/reviews');
    const candidates: RemediationOriginCandidate[] = [];
    for (const reviewType of new Set(options.requiredReviewTypes)) {
        const lane = history.lanes.get(reviewType);
        const details = lane?.details;
        const snapshotPathValue = String(details?.remediation_baseline_snapshot_path || '').trim();
        const snapshotSha256 = String(details?.remediation_baseline_snapshot_sha256 || '').trim().toLowerCase();
        if (!lane || !details || !snapshotPathValue || !/^[0-9a-f]{64}$/u.test(snapshotSha256)) continue;
        const snapshotPath = path.resolve(options.repoRoot, snapshotPathValue);
        const expectedName = `${options.taskId}-${reviewType}-remediation-baseline-${snapshotSha256}.json`.toLowerCase();
        if (path.basename(snapshotPath).toLowerCase() !== expectedName
            || !isPathRealpathInsideRoot(snapshotPath, reviewsRoot, { allowMissing: false })) continue;
        const baseline = validateReviewRemediationBaselineArtifact({
            artifactPath: snapshotPath,
            expectedArtifactSha256: snapshotSha256,
            expectedTaskId: options.taskId,
            expectedReviewType: reviewType,
            // A kept (REUSE) review keeps the baseline of the review it reused, bound to the tree that review saw.
            expectedReviewTreeStateSha256: lane.reviewedTree.trim() || null
        });
        if (!baseline.valid || !baseline.artifact) continue;
        const receipt = readAuthenticatedRemediationLaneReceipt({
            repoRoot: options.repoRoot, taskId: options.taskId, reviewType, details,
            timingEvents: history.timingEvents, trustedReceipts: history.trustedReceipts
        });
        if (!receipt.authenticated) continue;
        candidates.push({
            reviewType,
            sequence: lane.sequence,
            failed: !receipt.passed || baseline.artifact.fix_now_items.length > 0
        });
    }
    return candidates.sort((left, right) => right.sequence - left.sequence);
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
