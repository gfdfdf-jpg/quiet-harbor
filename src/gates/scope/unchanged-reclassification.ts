import { readJsonFile } from '../../core/json';
import { isPlainRecord } from '../../core/records';
import { findLatestTimelineEvent, type TimelineEventEntry } from '../completion/completion-evidence';
import { isSha256 } from '../review-reuse/review-reuse-telemetry-normalization';
import { fileSha256 } from '../shared/helpers';

/**
 * Classification facts that decide the reviewed scope and the review obligations. A reclassification that records
 * the same values describes the same reviewed tree; one whose values differ is a real scope change.
 */
const RECLASSIFICATION_SCOPE_FIELDS = [
    'mode',
    'code_changed',
    'changed_files_count',
    'changed_lines_total',
    'scope_sha256',
    'scope_content_sha256',
    'task_criteria_sha256',
    'required_reviews'
] as const;

const CLASSIFICATION_CYCLE_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED'
]);

function normalizeSha256(value: unknown): string | null {
    return isSha256(value) ? String(value).trim().toLowerCase() : null;
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    if (isPlainRecord(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function hasRecordedValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = readJsonFile(filePath);
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** A classification written by classify-change for this task into the signed timeline, not a hand-written line. */
function isSignedClassification(entry: TimelineEventEntry, taskId: string): boolean {
    const integrity: unknown = entry.integrity;
    return entry.event_type === 'PREFLIGHT_CLASSIFIED'
        && entry.actor === 'gate'
        && entry.outcome === 'INFO'
        && entry.task_id === taskId
        && isPlainRecord(integrity)
        && isSha256(integrity.event_sha256);
}

/**
 * Completion violations carry per-round facts (timeline sequences, artifact hashes, timestamps) that change on every
 * rerun of the same failure; they are masked so the same failure keeps the same signature.
 *
 * Deliberately broad: every 64-hex value is masked, so two failures whose texts differ only by a hash share one
 * signature. Narrowing it to known per-round fields would let a rerun that only re-hashed its evidence look like a new
 * failure and slip past the bound. A merge can only make the once-per-failure stop trip sooner, never let completion
 * pass: the stop refuses another unchanged-tree rerun, names both failures and offers the user-approved cycle restart;
 * the reviews stay valid while the tree is unchanged, and MAX_IDENTICAL_RECLASSIFICATIONS caps the chain whatever the
 * texts say.
 */
export function normalizeCompletionViolation(violation: string): string {
    return violation
        .replace(/\b[0-9a-f]{64}\b/giu, '<sha256>')
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/gu, '<timestamp>')
        .replace(/\bseq(?:uence)?[ =:]*(?:\d+|unknown)\b/giu, 'seq <n>');
}

/** The violations a completion failure recorded, normalized and order-independent; equal signatures mean the same failure. */
function completionFailureSignature(entry: TimelineEventEntry): string {
    const violations = Array.isArray(entry.details?.violations)
        ? entry.details.violations.map((value) => normalizeCompletionViolation(String(value))).sort()
        : [];
    return stableJson(violations);
}

/** At most this many identical reclassifications follow one reviewed classification, whatever the failures say. */
export const MAX_IDENTICAL_RECLASSIFICATIONS = 2;

export interface UnchangedReclassificationReadiness {
    reason: string;
    reviewedPreflightSequence: number;
    /** The completion failure the reclassification followed, when that was its boundary. */
    completionFailure: TimelineEventEntry | null;
}

/**
 * Proves from the signed timeline alone that `latestPreflight` only re-recorded the classification before it: both are
 * signed classify-change events of this task, the earlier one was compiled and reached a review or completion boundary
 * in the same task-mode entry, and both record identical scope fingerprints, task criteria and required reviews. Such a
 * refresh opens no new execution cycle; the earlier classification stays the cycle's preflight stage. Any differing or
 * missing fact returns null.
 */
export function readUnchangedReclassificationFromTimeline(
    events: readonly TimelineEventEntry[],
    latestPreflight: TimelineEventEntry,
    taskId: string
): UnchangedReclassificationReadiness | null {
    if (!isSignedClassification(latestPreflight, taskId)) return null;
    const reviewedPreflight = findLatestTimelineEvent(events, (entry) => (
        entry.event_type === 'PREFLIGHT_CLASSIFIED' && entry.sequence < latestPreflight.sequence
    ));
    if (!reviewedPreflight || !isSignedClassification(reviewedPreflight, taskId)) return null;
    const between = events.filter((entry) => (
        entry.sequence > reviewedPreflight.sequence && entry.sequence < latestPreflight.sequence
    ));
    if (between.some((entry) => entry.event_type === 'TASK_MODE_ENTERED')
        || !between.some((entry) => entry.event_type === 'COMPILE_GATE_PASSED')
        || !between.some((entry) => CLASSIFICATION_CYCLE_BOUNDARY_EVENTS.has(entry.event_type))) {
        return null;
    }
    for (const field of RECLASSIFICATION_SCOPE_FIELDS) {
        const reviewedValue = reviewedPreflight.details?.[field];
        if (!hasRecordedValue(reviewedValue) || stableJson(reviewedValue) !== stableJson(latestPreflight.details?.[field])) {
            return null;
        }
    }
    const completionFailure = [...between].reverse().find((entry) => entry.event_type === 'COMPLETION_GATE_FAILED') ?? null;
    return {
        reason: `Latest PREFLIGHT_CLASSIFIED (seq ${latestPreflight.sequence}) re-records the reviewed classification ` +
            `(seq ${reviewedPreflight.sequence}) with identical scope, content, criteria and review fingerprints; ` +
            'it opens no new execution cycle, so passed reviews stay reusable for the unchanged tree.',
        reviewedPreflightSequence: reviewedPreflight.sequence,
        completionFailure
    };
}

export type ReclassificationBoundStop =
    | { kind: 'repeated-failure'; failureSequence: number; earlierFailureSequence: number; earlierReclassificationSequence: number }
    | { kind: 'cap'; count: number; reviewedPreflightSequence: number };

/**
 * Bounds identical reclassifications so an unchanged-tree rerun cannot loop. `events` must be the whole signed task
 * history. Two rules, the first that trips wins:
 * - once per completion failure: when the latest identical reclassification follows a completion failure whose
 *   normalized violations an earlier identical reclassification already answered, the rerun did not change the verdict;
 * - a hard cap: at most MAX_IDENTICAL_RECLASSIFICATIONS identical reclassifications in a row follow one reviewed
 *   classification, whatever the failure texts say.
 */
export function findReclassificationBoundStop(
    events: readonly TimelineEventEntry[],
    taskId: string
): ReclassificationBoundStop | null {
    const latest = findLatestTimelineEvent(events, (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED');
    const current = latest ? readUnchangedReclassificationFromTimeline(events, latest, taskId) : null;
    if (!latest || !current) return null;
    const chain: UnchangedReclassificationReadiness[] = [];
    for (let entry: TimelineEventEntry | undefined = latest; entry;) {
        const link = readUnchangedReclassificationFromTimeline(events, entry, taskId);
        if (!link) break;
        chain.push(link);
        const previousSequence = link.reviewedPreflightSequence;
        entry = events.find((candidate) => candidate.sequence === previousSequence);
    }
    if (current.completionFailure) {
        const signature = completionFailureSignature(current.completionFailure);
        const earlier = chain.slice(1).find((link) => link.completionFailure
            && completionFailureSignature(link.completionFailure) === signature);
        if (earlier?.completionFailure) {
            const earlierReclassification = chain[chain.indexOf(earlier) - 1];
            return {
                kind: 'repeated-failure',
                failureSequence: current.completionFailure.sequence,
                earlierFailureSequence: earlier.completionFailure.sequence,
                earlierReclassificationSequence: earlierReclassification.reviewedPreflightSequence
            };
        }
    }
    if (chain.length > MAX_IDENTICAL_RECLASSIFICATIONS) {
        return { kind: 'cap', count: chain.length, reviewedPreflightSequence: chain[chain.length - 1].reviewedPreflightSequence };
    }
    return null;
}

/**
 * Explains why another unchanged-tree rerun is refused, or returns null when the bound holds. `historyErrors` are the
 * errors of reading the whole history: an unreadable history cannot prove the bound, so it refuses too (fail closed).
 */
export function describeReclassificationBoundStop(
    events: readonly TimelineEventEntry[],
    historyErrors: readonly string[],
    taskId: string
): string | null {
    if (historyErrors.length > 0) {
        return `the full task history could not be read to check the rerun bound (${historyErrors.join('; ')}).`;
    }
    const stop = findReclassificationBoundStop(events, taskId);
    if (!stop) return null;
    if (stop.kind === 'repeated-failure') {
        return `COMPLETION_GATE_FAILED (seq ${stop.failureSequence}) repeated the violations of COMPLETION_GATE_FAILED `
            + `(seq ${stop.earlierFailureSequence}), which the agent already answered with the identical reclassification `
            + `(seq ${stop.earlierReclassificationSequence}).`;
    }
    return `it is identical reclassification ${stop.count} of the reviewed classification (seq ${stop.reviewedPreflightSequence}); `
        + `at most ${MAX_IDENTICAL_RECLASSIFICATIONS} reruns of the unchanged cycle are allowed.`;
}

/**
 * The live check for the current preflight: the timeline proof above, plus the preflight file is the one the latest
 * event classified and still carries the classified scope fingerprints.
 */
export function readUnchangedReclassificationReadiness(
    preflightPath: string,
    events: readonly TimelineEventEntry[],
    latestPreflight: TimelineEventEntry,
    taskId: string
): UnchangedReclassificationReadiness | null {
    const currentPreflight = readJsonRecord(preflightPath);
    const latestOutputSha256 = normalizeSha256(latestPreflight.details?.output_sha256);
    if (!currentPreflight || !latestOutputSha256 || fileSha256(preflightPath) !== latestOutputSha256) {
        return null;
    }
    const metrics = isPlainRecord(currentPreflight.metrics) ? currentPreflight.metrics : {};
    const scopeSha256 = normalizeSha256(metrics.scope_sha256);
    const scopeContentSha256 = normalizeSha256(metrics.scope_content_sha256);
    if (!scopeSha256 || !scopeContentSha256
        || scopeSha256 !== normalizeSha256(latestPreflight.details?.scope_sha256)
        || scopeContentSha256 !== normalizeSha256(latestPreflight.details?.scope_content_sha256)) {
        return null;
    }
    return readUnchangedReclassificationFromTimeline(events, latestPreflight, taskId);
}

/**
 * Removes every trailing PREFLIGHT_CLASSIFIED that only re-recorded the classification before it, so completion's
 * stage sequence keeps the reviewed classification as the cycle's preflight stage. Real changes stay in place.
 */
export function withoutUnchangedReclassifications(events: readonly TimelineEventEntry[], taskId: string): TimelineEventEntry[] {
    let remaining = [...events];
    for (;;) {
        const latest = findLatestTimelineEvent(remaining, (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED');
        if (!latest || !readUnchangedReclassificationFromTimeline(remaining, latest, taskId)) return remaining;
        remaining = remaining.filter((entry) => entry.sequence !== latest.sequence);
    }
}
