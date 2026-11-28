/**
 * Optional, operator-declared reviewer provider and model (for example a cross-provider reviewer launched from a
 * Claude orchestrator). They are recorded once at delegation start into the reviewer launch artifact, whose hash the
 * invocation attestation binds, and are copied from there into the review receipt. They are descriptive metadata:
 * no trust, reuse or freshness decision reads them, and absent values keep every artifact unchanged.
 */
export interface ReviewerProviderModel {
    reviewer_provider?: string;
    reviewer_model?: string;
}

const REVIEWER_PROVIDER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,127}$/u;

const FIELDS = ['reviewer_provider', 'reviewer_model'] as const;

function isReviewerProviderModelValue(value: unknown): value is string {
    return typeof value === 'string' && value === value.trim() && REVIEWER_PROVIDER_MODEL_PATTERN.test(value);
}

/** Validates the CLI values; an absent or empty option yields no field. */
export function parseReviewerProviderModelOptions(options: { reviewerProvider?: unknown; reviewerModel?: unknown }): ReviewerProviderModel {
    const parsed: ReviewerProviderModel = {};
    const entries: Array<[typeof FIELDS[number], unknown, string]> = [
        ['reviewer_provider', options.reviewerProvider, '--reviewer-provider'],
        ['reviewer_model', options.reviewerModel, '--reviewer-model']
    ];
    for (const [field, raw, flag] of entries) {
        if (raw === undefined || raw === null) continue;
        const value = String(raw).trim();
        if (!value) continue;
        if (!isReviewerProviderModelValue(value)) {
            throw new Error(`${flag} must be 1-128 characters of letters, digits, spaces and . _ : / @ + ( ) -, starting with a letter or digit.`);
        }
        parsed[field] = value;
    }
    return parsed;
}

/** Reads only well-formed values from a hash-bound record (launch artifact or receipt). */
export function readReviewerProviderModel(record: Readonly<Record<string, unknown>> | null | undefined): ReviewerProviderModel {
    const result: ReviewerProviderModel = {};
    for (const field of FIELDS) {
        const value = record?.[field];
        if (isReviewerProviderModelValue(value)) result[field] = value;
    }
    return result;
}

/** A recovery or repeated command may not change values already persisted for the same launch attempt. */
export function findReviewerProviderModelConflict(
    persisted: ReviewerProviderModel,
    requested: ReviewerProviderModel
): string | null {
    for (const field of FIELDS) {
        if (requested[field] !== undefined && persisted[field] !== requested[field]) {
            return `${field} '${requested[field]}' does not match the persisted launch attempt value '${persisted[field] ?? 'none'}'.`;
        }
    }
    return null;
}

export function formatReviewerProviderModel(value: ReviewerProviderModel): string | null {
    const parts = [value.reviewer_provider, value.reviewer_model].filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(' ') : null;
}
