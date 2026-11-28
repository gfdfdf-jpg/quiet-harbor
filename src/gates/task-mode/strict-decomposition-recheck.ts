import { normalizePath } from '../shared/helpers';
import type { StrictDecompositionRecheckBaseline } from './strict-decomposition-plan-conformance';

export interface StrictDecompositionFailedReviewState {
    failedNonTestReviewCount: number;
    maxFailedNonTestReviews: number;
}

export interface StrictDecompositionRecheckInput {
    estimatedChangedFiles: number | null;
    planFileCap: number | null;
    baseline: StrictDecompositionRecheckBaseline | null;
    currentChangedFiles: number | null;
    readFailedReviews: () => StrictDecompositionFailedReviewState | null;
    /** Repo-relative inputs this navigation reads; a baseline from other inputs is not comparable. */
    navigationInputs?: { preflightPath: string; eventsRoot: string } | null;
}

export interface StrictDecompositionRecheckTrigger {
    kind: 'changed-files' | 'failed-reviews' | 'inputs';
    detail: string;
    currentChangedFiles: number | null;
    failedNonTestReviewCount: number | null;
}

/** The failed-review checkpoints sit at a third of the review-cycle guard, so the agent re-decides well before it. */
const FAILED_REVIEW_CHECKPOINT_DIVISOR = 3;

function readMetricNumber(preflight: Record<string, unknown>, field: string): number | null {
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const value = metrics[field];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

function readCompanionScopeChangedFilesCount(preflight: Record<string, unknown>): number | null {
    const triggers = preflight.triggers && typeof preflight.triggers === 'object' && !Array.isArray(preflight.triggers)
        ? preflight.triggers as Record<string, unknown>
        : {};
    if (triggers.ui_i18n_companion_scope !== true && triggers.ui_i18n_review_trigger_suppressed !== true) {
        return null;
    }
    return readMetricNumber(preflight, 'review_trigger_effective_changed_files_count')
        ?? readMetricNumber(preflight, 'companion_scope_effective_changed_files_count');
}

/** The same changed-file count the decomposition risk signals read from the current preflight. */
export function readStrictDecompositionPreflightChangedFilesCount(preflight: Record<string, unknown> | null): number | null {
    if (!preflight) return null;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)).size
        : null;
    return readCompanionScopeChangedFilesCount(preflight)
        ?? readMetricNumber(preflight, 'changed_files_count')
        ?? changedFiles;
}

/** The next failed-review count that requires a re-decision, or null when only the review-cycle guard applies. */
export function resolveStrictDecompositionFailedReviewCheckpoint(
    baselineFailedNonTestReviewCount: number,
    maxFailedNonTestReviews: number
): number | null {
    const step = Math.floor(maxFailedNonTestReviews / FAILED_REVIEW_CHECKPOINT_DIVISOR);
    const checkpoint = baselineFailedNonTestReviewCount + step;
    return step >= 1 && checkpoint < maxFailedNonTestReviews ? checkpoint : null;
}

function assessChangedFiles(input: StrictDecompositionRecheckInput): StrictDecompositionRecheckTrigger | null {
    const current = input.currentChangedFiles;
    if (current === null) return null;
    // A decision with a baseline but no estimate gives the recheck no limit; it is asked again once work exists.
    if (input.baseline && input.estimatedChangedFiles === null && current > 0) {
        return {
            kind: 'changed-files',
            detail: `The decision recorded no changed-file estimate, and the current preflight changes ${current} files.`,
            currentChangedFiles: current,
            failedNonTestReviewCount: null
        };
    }
    const limits = [
        input.estimatedChangedFiles === null ? null : { value: input.estimatedChangedFiles, label: 'the recorded estimate' },
        input.planFileCap === null ? null : { value: input.planFileCap, label: 'the planned file cap' }
    ].filter((entry): entry is { value: number; label: string } => entry !== null);
    const exceeded = limits.filter((limit) => current > limit.value);
    if (exceeded.length === 0) return null;
    return {
        kind: 'changed-files',
        detail: `The current preflight changes ${current} files, more than ${exceeded
            .map((limit) => `${limit.label} of ${limit.value}`).join(' and ')}.`,
        currentChangedFiles: current,
        failedNonTestReviewCount: null
    };
}

function assessFailedReviews(input: StrictDecompositionRecheckInput): StrictDecompositionRecheckTrigger | null {
    // Reviews bind a current preflight. Without one next-step refreshes it first, and the check runs on that navigation.
    if (!input.baseline || input.currentChangedFiles === null) return null;
    const state = input.readFailedReviews();
    if (!state) return null;
    const checkpoint = resolveStrictDecompositionFailedReviewCheckpoint(
        input.baseline.failed_non_test_review_count,
        state.maxFailedNonTestReviews
    );
    if (checkpoint === null || state.failedNonTestReviewCount < checkpoint) return null;
    return {
        kind: 'failed-reviews',
        detail: `${state.failedNonTestReviewCount} non-test reviews have failed (${input.baseline.failed_non_test_review_count} when the decision was recorded); `
            + `the re-decision checkpoint is ${checkpoint}, below the review-cycle guard limit of ${state.maxFailedNonTestReviews}.`,
        currentChangedFiles: input.currentChangedFiles,
        failedNonTestReviewCount: state.failedNonTestReviewCount
    };
}

function sameRepoPath(left: string, right: string): boolean {
    const normalize = (value: string) => normalizePath(value).replace(/\/+$/u, '');
    return process.platform === 'win32'
        ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
        : normalize(left) === normalize(right);
}

function assessInputs(input: StrictDecompositionRecheckInput): StrictDecompositionRecheckTrigger | null {
    const recorded = input.baseline;
    const navigation = input.navigationInputs;
    if (!recorded || !navigation) return null;
    const mismatches = [
        recorded.preflight_path && !sameRepoPath(recorded.preflight_path, navigation.preflightPath)
            ? `preflight ${recorded.preflight_path} (navigation reads ${navigation.preflightPath})` : null,
        recorded.events_root && !sameRepoPath(recorded.events_root, navigation.eventsRoot)
            ? `events root ${recorded.events_root} (navigation reads ${navigation.eventsRoot})` : null
    ].filter((entry): entry is string => entry !== null);
    if (mismatches.length === 0) return null;
    return {
        kind: 'inputs',
        detail: `The decision's changed-file and failed-review baseline was read from ${mismatches.join(' and ')}, so it cannot be compared with this navigation.`,
        currentChangedFiles: input.currentChangedFiles,
        failedNonTestReviewCount: null
    };
}

/** Whether the recorded atomic or single-cycle decision still holds for the current scope and review history. */
export function assessStrictDecompositionRecheck(input: StrictDecompositionRecheckInput): StrictDecompositionRecheckTrigger | null {
    return assessInputs(input) ?? assessChangedFiles(input) ?? assessFailedReviews(input);
}
