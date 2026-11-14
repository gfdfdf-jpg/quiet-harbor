import { collectRemediationOriginCandidates } from '../review-remediation/review-remediation-origin';
import type { ReviewArtifactState } from './next-step-review-artifact-readers';

/**
 * Recovery when the workspace changes while reviews of the current cycle are under way (after
 * REVIEW_PHASE_STARTED, before REVIEW_GATE_PASSED) and no failed review owns a remediation.
 *
 * The operator's rules treat such a change like a fix after a failed review: a passed review the change does not
 * reach is kept, a small fix inside its scope repeats it in DELTA, a large one in FULL, and a change that cannot
 * be authenticated or classified repeats every review in FULL. A reviewer that had already finished is a passed
 * review too: its result is recorded first, against the tree it reviewed.
 */
export interface ScopeChangeAfterReviewRecovery {
    nextGate: 'record-review-result' | 'restart-review-cycle';
    title: string;
    label: string;
    reason: string;
    command: string;
}

/**
 * The passed review whose authenticated baseline anchors the change. Only a review whose latest REVIEW_RECORDED binds
 * a baseline without fix-now items qualifies: a baseline file left by an earlier failed attempt, or a review that
 * passed without one (for example under Garda 1.4.3), would send every review to FULL. Among several, the newest
 * record wins, whatever the order of the review list. Lanes whose receipt or baseline is gone are skipped, so lost
 * evidence of one review does not make the change unauthenticated for the others; with no candidate the ordinary
 * coherent restart remains.
 */
export function resolvePassedReviewRemediationOrigin(options: {
    repoRoot: string;
    taskId: string;
    requiredReviewTypes: readonly string[];
    reviewStates: readonly ReviewArtifactState[];
}): string | null {
    const intactReviewTypes = options.requiredReviewTypes.filter((reviewType) => {
        const state = options.reviewStates.find((entry) => entry.reviewType === reviewType);
        // The change itself moves the scope fingerprints a receipt is checked against, so a reached review is not
        // `ready`; its evidence is intact when it still validates against the scope it reviewed (frozen validation).
        const intact = state?.ready === true
            || (state?.frozenReviewFindingsValidationAccepted === true && Boolean(state.frozenReviewFindingsDisposition));
        // A review kept through REUSE by an earlier restart still counts: its record keeps the reused review's baseline.
        return Boolean(state && state.receiptExists && intact && !state.failed);
    });
    if (intactReviewTypes.length === 0) return null;
    return collectRemediationOriginCandidates({
        repoRoot: options.repoRoot, taskId: options.taskId, requiredReviewTypes: intactReviewTypes
    }).find((candidate) => !candidate.failed)?.reviewType ?? null;
}

export function buildRecordFinishedReviewRecovery(options: {
    reviewType: string;
    command: string;
}): ScopeChangeAfterReviewRecovery {
    return {
        nextGate: 'record-review-result',
        title: `Record the finished '${options.reviewType}' review before handling the change.`,
        label: 'Record delegated review output file, then close reviewer',
        reason: `The delegated '${options.reviewType}' reviewer finished on its reviewed tree before the workspace changed. `
            + 'A finished review is a passed review followed by a fix, not a review that never ran: record its result now; '
            + 'it is bound to the tree it reviewed, not to the changed workspace. Then rerun next-step: the change is '
            + 'measured against the recorded review, which is kept when the change does not reach its scope and repeats '
            + 'in DELTA or FULL when it does.',
        command: options.command
    };
}

export function buildPassedReviewRemediationRecovery(options: {
    originReviewType: string;
    passedReviewTypes: readonly string[];
    command: string;
}): ScopeChangeAfterReviewRecovery {
    return {
        nextGate: 'restart-review-cycle',
        title: 'Restart the review cycle for the change made after passed reviews.',
        label: 'Restart the review cycle for the change: replace all eight <analysis> fields with task-specific details '
            + '(at least 120 characters total; name an affected file)',
        reason: `Files changed after review(s) ${options.passedReviewTypes.map((reviewType) => `'${reviewType}'`).join(', ')} `
            + 'passed and before the review gate closed. restart-review-cycle measures the change against the authenticated '
            + `'${options.originReviewType}' review baseline: a review the change does not reach is kept, a small fix inside a `
            + 'review\'s scope repeats it in DELTA, a large fix in FULL, and a change that cannot be authenticated or classified '
            + 'repeats every review in FULL. It keeps the task-mode authorization, refreshes the diagnostic prefix and preflight, '
            + 'reloads POST_PREFLIGHT rules, reruns compile and prepares only the reviews that must repeat.',
        command: options.command
    };
}
