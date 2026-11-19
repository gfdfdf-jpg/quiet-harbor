import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';

export interface TestOnlyReviewPreservationOptions {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
}

/** Historical claims only: this does not accept a review or resolve current test cases. */
export interface TestOnlyReviewPreservation {
    readonly task_id: string;
    readonly review_type: string;
    readonly entry_sequence: number;
    readonly restart_sequence: number;
    readonly preflight_sha256: string;
    readonly decision_sha256: string;
    readonly baseline_sha256: string;
    readonly original_validation_obligations: readonly QualityValidationObligation[];
}
