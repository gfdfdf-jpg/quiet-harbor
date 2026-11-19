import {
    emitReviewerHandoffInputsRejectedEventAsync,
    gateHelpers,
    normalizePath
} from './review-launch-entrypoints';
import {
    preserveReviewerHandoffInputs,
    restoreProvenReviewerHandoffInputs,
    restoreReviewerHandoffInputsBeforeHandoff
} from '../../../../gates/review/review-prompt-artifact';
import { canRestoreReviewerInputsBeforeHandoff } from '../../../../gates/review/review-artifact-recovery';

/**
 * Bind the reviewer prompt and handoff artifacts of a review context in a launch gate. A refusal is unchanged, and it
 * is also recorded as authenticated REVIEWER_HANDOFF_INPUTS_REJECTED telemetry, so next-step routes this lane to its
 * recovery instead of naming the refused gate again: a context rebuild before a launch attempt exists, the
 * failed-launch recovery of the existing attempt afterwards. Disposable digest-checked input copies are kept
 * during preparation; they never replace launch authority. Before the handoff a copy always restores; after it the
 * reviewer has read the inputs from disk, so a copy restores only an input that a gate-signed result already proved
 * intact after the run. Otherwise the refusal stands and only this review repeats.
 */
export async function bindReviewerHandoffInputsOrRecordRejection<T>(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    contextPath: string;
    contextSha256: string | (() => string);
    gateName: 'prepare-reviewer-launch' | 'record-reviewer-delegation-started' | 'complete-reviewer-launch'
        | 'record-review-result' | 'record-review-receipt' | 'record-review-invocation';
    reviewContext?: Record<string, unknown>;
}, bind: () => T): Promise<T> {
    try {
        let result: T;
        try {
            result = bind();
        } catch (error) {
            const cacheOptions = options.reviewContext ? { ...options, reviewContext: options.reviewContext } : null;
            const restored = cacheOptions && (options.gateName === 'prepare-reviewer-launch'
                && canRestoreReviewerInputsBeforeHandoff({ ...options,
                    contextSha256: typeof options.contextSha256 === 'function' ? options.contextSha256() : options.contextSha256 })
                ? restoreReviewerHandoffInputsBeforeHandoff(cacheOptions)
                : restoreProvenReviewerHandoffInputs(cacheOptions));
            if (!restored) throw error;
            result = bind();
        }
        if (options.gateName === 'prepare-reviewer-launch' && options.reviewContext) {
            preserveReviewerHandoffInputs({ ...options, reviewContext: options.reviewContext });
        }
        return result;
    } catch (error: unknown) {
        await emitReviewerHandoffInputsRejectedEventAsync(
            gateHelpers.joinOrchestratorPath(options.repoRoot, ''),
            options.taskId,
            options.reviewType,
            {
                gate: options.gateName,
                reviewContextPath: normalizePath(options.contextPath),
                reviewContextSha256: typeof options.contextSha256 === 'function' ? options.contextSha256() : options.contextSha256,
                reason: error instanceof Error ? error.message : String(error)
            }
        );
        throw error;
    }
}
