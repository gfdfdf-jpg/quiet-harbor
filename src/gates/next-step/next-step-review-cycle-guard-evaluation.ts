import * as path from 'node:path';
import { countNextStepWork } from '../../core/next-step-measurement';
import { evaluateReviewCycleGuard } from '../../core/review-cycle-guard';
import { readInvocationVerifiedEventIndex } from '../../gate-runtime/timeline/task-events-integrity';
import { normalizedEventsOfType } from '../../gate-runtime/timeline/task-verified-event-index';
import { readNormalizedReviewCycleGuardConfig } from './next-step-review-cycle-guard-config';
import { readCapturedClosedReviewGuard } from '../review-attempts/review-closed-cycle-capture';
import { readCurrentReviewCyclePreflightFingerprints } from './next-step-review-cycle-scope';
import { readReviewCycleGuardAttempts } from './next-step-review-cycle-guard-attempts';
import { buildReviewCycleAttemptDiagnostics, extendReviewCycleGuardEvaluation } from './next-step-review-cycle-guard-diagnostics';
import type { ReviewCycleGuardReadEvaluationResult } from './next-step-review-cycle-guard-types';
export function readReviewCycleGuardEvaluation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string
): ReviewCycleGuardReadEvaluationResult {
    const reviewCycleGuardConfig = readNormalizedReviewCycleGuardConfig(repoRoot);
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const verified = reviewCycleGuardConfig.enabled ? readInvocationVerifiedEventIndex(timelinePath, taskId) : null;
    // With no recorded attempts the verified timeline is sufficient to evaluate the empty history.
    // Only histories with review evidence need to authenticate a derived summary and its producer code.
    if (!reviewCycleGuardConfig.enabled
        || (verified && normalizedEventsOfType(verified.normalizedEvents, 'REVIEW_RECORDED')?.length === 0)) {
        const diagnostics = buildReviewCycleAttemptDiagnostics([], reviewCycleGuardConfig.excluded_review_types);
        const evaluation = evaluateReviewCycleGuard(reviewCycleGuardConfig, {
            attempts: [],
            timelineValid: true
        });
        return {
            evaluation: extendReviewCycleGuardEvaluation(evaluation, evaluation, diagnostics, false),
            latestFailedReview: null
        };
    }

    const closed = readCapturedClosedReviewGuard({ repoRoot, eventsRoot, taskId, config: reviewCycleGuardConfig });
    if (closed) return closed;
    const reviewCycleAttempts = readReviewCycleGuardAttempts(
        repoRoot,
        timelinePath,
        taskId,
        reviewCycleGuardConfig,
        readCurrentReviewCyclePreflightFingerprints(eventsRoot, taskId)
    );
    const evaluation = evaluateReviewCycleGuard(
        reviewCycleGuardConfig,
        {
            attempts: reviewCycleAttempts.attempts,
            timelineValid: reviewCycleAttempts.timelineValid
        }
    );
    const currentScopeEvaluation = evaluateReviewCycleGuard(
        reviewCycleGuardConfig,
        {
            attempts: reviewCycleAttempts.attempts.filter((attempt) => (countNextStepWork('visit:next-step-review-cycle-guard-evaluation:event:111'), attempt.currentScope)),
            timelineValid: reviewCycleAttempts.timelineValid
        }
    );
    const diagnostics = buildReviewCycleAttemptDiagnostics(
        reviewCycleAttempts.attempts,
        reviewCycleGuardConfig.excluded_review_types
    );

    return {
        evaluation: extendReviewCycleGuardEvaluation(
            evaluation,
            currentScopeEvaluation,
            diagnostics,
            evaluation.violations.length > 0 || currentScopeEvaluation.violations.length > 0
        ),
        latestFailedReview: reviewCycleAttempts.latestFailedReview,
        lostCurrentResultReviewTypes: reviewCycleAttempts.lostCurrentResultReviewTypes
    };
}
