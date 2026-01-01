import {
    REVIEW_CAPABILITY_KEYS,
    getDefaultReviewCapabilities,
    type ReviewCapabilities,
    type ReviewCapabilityKey
} from '../../core/review-capabilities';

export type TaskRequiredReviewDeclarationSource = 'task_queue_notes' | 'task_plan' | 'task_queue_notes_and_task_plan';

export interface TaskRequiredReviewDeclaration {
    source: TaskRequiredReviewDeclarationSource;
    declared_reviews: ReviewCapabilityKey[];
    applied_reviews: ReviewCapabilityKey[];
}

export interface ResolveTaskRequiredReviewDeclarationOptions {
    taskId: string;
    notes: string | null | undefined;
    reviewCapabilities: Partial<ReviewCapabilities>;
}

const REQUIRED_REVIEWS_SENTENCE_START = /(^|[.!?]\s+|;\s*|\r?\n[ \t]*)(required\s+reviews\b|reviews(?=\s*:))/gi;
const REQUIRED_REVIEWS_DECLARATION = /^(?:required\s+reviews|reviews)\s*:\s*([^.!?;\r\n]*)(?:[.!?;\r\n]|$)/i;
const REVIEW_LANE_TOKEN = /^[a-z][a-z0-9_-]*$/i;

export class TaskRequiredReviewUnavailableError extends Error {
    constructor(taskId: string, lane: string) {
        super(`Task '${taskId}' required-review declaration cannot be honored: review lane '${lane}' `
            + `is unavailable because review-capabilities.${lane} is not enabled. `
            + 'Do not remove or narrow task review requirements to bypass this refusal. '
            + 'Resolve the capability conflict with the operator before continuing.');
        this.name = 'TaskRequiredReviewUnavailableError';
    }
}

export class TaskRequiredReviewSelectionError extends Error {
    constructor(taskId: string, lanes: readonly string[]) {
        super(`Task '${taskId}' preflight omits currently declared required reviews: ${lanes.join(', ')}. `
            + 'Refresh the preflight and affected review cycle through native recovery while preserving all task requirements. '
            + 'Do not edit preflight or receipt evidence to claim these reviews passed.');
        this.name = 'TaskRequiredReviewSelectionError';
    }
}

/** Pure comparison: existing preflights must not silently omit task-owned lanes added or previously unrecognized. */
export function assertTaskRequiredReviewSelection(taskId: string, notes: string | null | undefined,
    requiredReviews: unknown): void {
    const declaration = resolveTaskRequiredReviewDeclaration({ taskId, notes, reviewCapabilities: getDefaultReviewCapabilities() });
    const selected = requiredReviews && typeof requiredReviews === 'object' && !Array.isArray(requiredReviews)
        ? requiredReviews as Readonly<Record<string, unknown>> : {};
    const missing = (declaration?.applied_reviews || []).filter(lane => selected[lane] !== true);
    if (missing.length) throw new TaskRequiredReviewSelectionError(taskId, missing);
}

function formatAllowedReviewLanes(): string {
    return REVIEW_CAPABILITY_KEYS.join(', ');
}

function invalidDeclaration(taskId: string, reason: string): Error {
    return new Error(
        `Task '${taskId}' has invalid TASK.md required-review declaration: ${reason} `
        + `Allowed lanes: ${formatAllowedReviewLanes()}.`
    );
}

export function resolveTaskRequiredReviewDeclaration(
    options: ResolveTaskRequiredReviewDeclarationOptions
): TaskRequiredReviewDeclaration | null {
    const notes = String(options.notes || '').trim();
    if (!notes) {
        return null;
    }

    const sentenceStarts = [...notes.matchAll(REQUIRED_REVIEWS_SENTENCE_START)];
    if (sentenceStarts.length === 0) {
        return null;
    }
    const markers = new Set<string>();
    const combinedReviews = new Set<string>();
    for (const sentenceStart of sentenceStarts) {
        const marker = /^required/iu.test(sentenceStart[2]) ? 'Required reviews' : 'Reviews';
        if (markers.has(marker)) throw invalidDeclaration(options.taskId, `multiple "${marker}" declarations were found.`);
        markers.add(marker);
        const boundary = sentenceStart[1] || '';
        const markerOffset = (sentenceStart.index || 0) + boundary.length;
        const declarationMatch = REQUIRED_REVIEWS_DECLARATION.exec(notes.slice(markerOffset));
        if (!declarationMatch) {
            throw invalidDeclaration(
                options.taskId,
                'expected the exact form "Required reviews: lane, lane.".'
            );
        }

        const rawLaneList = declarationMatch[1].trim();
        if (!rawLaneList) {
            throw invalidDeclaration(options.taskId, 'the lane list is empty.');
        }

        const rawLanes = rawLaneList.split(',').map((lane) => lane.trim());
        if (rawLanes.some((lane) => !lane || !REVIEW_LANE_TOKEN.test(lane))) {
            throw invalidDeclaration(options.taskId, 'lanes must be non-empty comma-separated identifiers.');
        }

        const declaredReviews = rawLanes.map((lane) => lane.toLowerCase());
        const duplicateLane = declaredReviews.find((lane, index) => declaredReviews.indexOf(lane) !== index);
        if (duplicateLane) {
            throw invalidDeclaration(options.taskId, `lane '${duplicateLane}' is declared more than once.`);
        }
        for (const lane of declaredReviews) combinedReviews.add(lane);
    }

    return buildDeclaration(options.taskId, [...combinedReviews], options.reviewCapabilities, 'task_queue_notes',
        (reason) => invalidDeclaration(options.taskId, reason));
}

function buildDeclaration(
    taskId: string,
    declaredReviews: readonly string[],
    reviewCapabilities: Partial<ReviewCapabilities>,
    source: TaskRequiredReviewDeclarationSource,
    invalid: (reason: string) => Error
): TaskRequiredReviewDeclaration {
    const unknownLane = declaredReviews.find((lane) => !REVIEW_CAPABILITY_KEYS.includes(lane as ReviewCapabilityKey));
    if (unknownLane) {
        throw invalid(`unknown lane '${unknownLane}'.`);
    }

    const typedReviews = declaredReviews as ReviewCapabilityKey[];
    const unavailableLane = typedReviews.find((lane) => reviewCapabilities[lane] !== true);
    if (unavailableLane) {
        throw new TaskRequiredReviewUnavailableError(taskId, unavailableLane);
    }

    return {
        source,
        declared_reviews: [...typedReviews],
        applied_reviews: [...typedReviews]
    };
}

/** Lanes declared in the task's approved, authenticated JSON plan (`required_reviews`). */
export function resolveTaskPlanRequiredReviewDeclaration(options: {
    taskId: string;
    requiredReviews: readonly string[] | null | undefined;
    reviewCapabilities: Partial<ReviewCapabilities>;
}): TaskRequiredReviewDeclaration | null {
    if (!options.requiredReviews || options.requiredReviews.length === 0) {
        return null;
    }
    return buildDeclaration(options.taskId, options.requiredReviews, options.reviewCapabilities, 'task_plan',
        (reason) => new Error(`Task '${options.taskId}' has invalid task-plan required_reviews: ${reason} `
            + `Allowed lanes: ${formatAllowedReviewLanes()}.`));
}

/** Union of the Notes and plan declarations; a lane declared in either source is required. */
export function mergeTaskRequiredReviewDeclarations(
    notesDeclaration: TaskRequiredReviewDeclaration | null,
    planDeclaration: TaskRequiredReviewDeclaration | null
): TaskRequiredReviewDeclaration | null {
    if (!notesDeclaration || !planDeclaration) {
        return notesDeclaration || planDeclaration;
    }
    const lanes = [...new Set([...notesDeclaration.declared_reviews, ...planDeclaration.declared_reviews])];
    return { source: 'task_queue_notes_and_task_plan', declared_reviews: lanes, applied_reviews: [...lanes] };
}

export function applyTaskRequiredReviewDeclaration(
    requiredReviews: Record<string, boolean>,
    declaration: TaskRequiredReviewDeclaration | null
): void {
    for (const reviewType of declaration?.applied_reviews || []) {
        requiredReviews[reviewType] = true;
    }
}
