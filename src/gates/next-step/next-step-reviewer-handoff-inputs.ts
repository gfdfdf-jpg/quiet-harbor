import * as path from 'node:path';
import { LIFECYCLE_EVENT_TYPES } from '../../gate-runtime/timeline/lifecycle-event-types';
import { inspectTaskEventFile, readTaskTimelineRouteQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { readTaskTimelineJsonlEntries } from '../../gate-runtime/timeline/task-events-helpers';
import { routeLatestLaneEvent } from '../../gate-runtime/timeline/task-route-query';
import {
    findReviewerLaunchInputRefusal,
    restoreProvenLaneReviewerInputs,
    restoreProvenReviewerHandoffInputs
} from '../review/review-prompt-artifact';
import { fileSha256, normalizePath } from '../shared/helpers';
import { safeReadJson } from '../task-audit/task-audit-summary-collectors';
import { withNextStepReviewEvidenceSnapshot } from './next-step-review-timeline-evidence';
import { buildReviewDependencyDiagnostics } from '../review/review-dependencies';
import { findLostReviewGateEvidence } from '../review/review-artifact-recovery';
import { readDependencyTimelineEvents } from '../../cli/commands/gate-review-handlers/result/review-dependency-timeline';

/**
 * The launch gates that bind a review context's reviewer handoff inputs. prepare-reviewer-launch binds them while no
 * launch attempt exists, so a rebuilt context loses nothing; the later gates bind them for an existing attempt,
 * which then has to be closed as a failed launch before a fresh one is prepared.
 */
const REVIEWER_HANDOFF_INPUT_PREPARE_GATE = 'prepare-reviewer-launch';
export const REVIEWER_HANDOFF_INPUT_ATTEMPT_GATES: readonly string[] = Object.freeze([
    'record-reviewer-delegation-started',
    'complete-reviewer-launch',
    'record-review-invocation',
    'record-review-result',
    'record-review-receipt'
]);
const REVIEWER_HANDOFF_INPUT_GATES = new Set([REVIEWER_HANDOFF_INPUT_PREPARE_GATE, ...REVIEWER_HANDOFF_INPUT_ATTEMPT_GATES]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function laneOf(event: Readonly<Record<string, unknown>>): string {
    const details = isPlainRecord(event.details) ? event.details : {};
    return String(details.review_type ?? details.reviewType ?? '').trim().toLowerCase();
}

/** Compare exactly the spelling stored by the dependency gate, including UNC normalization. */
export function matchesRecordedUpstreamContextPath(recorded: unknown, contextPath: string): boolean {
    return recorded === normalizePath(contextPath);
}

function readLatestHandoffInputRejection(
    eventsRoot: string,
    taskId: string,
    reviewType: string
): Readonly<Record<string, unknown>> | null {
    return withNextStepReviewEvidenceSnapshot(eventsRoot, taskId, () => {
        const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
        const status = inspectTaskEventFile(timelinePath, taskId).status;
        if (status !== 'PASS' && status !== 'PASS_WITH_LEGACY_PREFIX') {
            return null;
        }
        const type = LIFECYCLE_EVENT_TYPES.REVIEWER_HANDOFF_INPUTS_REJECTED;
        const query = readTaskTimelineRouteQuery(timelinePath, taskId);
        if (query) {
            return routeLatestLaneEvent(query, type, reviewType);
        }
        const lines = readTaskTimelineJsonlEntries(timelinePath);
        for (let index = lines.length - 1; index >= 0; index--) {
            const event = lines[index].record;
            if (event && String(event.event_type || '').trim() === type && laneOf(event) === reviewType) {
                return event;
            }
        }
        return null;
    });
}

/** The dependency gate would restore this upstream lane from a copy its recorded result proved intact. */
function upstreamInputsRestorable(
    options: { repoRoot: string; taskId: string; dependencyOptions?: { preflightPath: string } },
    upstreamReviewType: string
): boolean {
    return Boolean(options.dependencyOptions) && restoreProvenLaneReviewerInputs({
        repoRoot: options.repoRoot, taskId: options.taskId, reviewType: upstreamReviewType,
        reviewsRoot: path.dirname(options.dependencyOptions?.preflightPath || ''), dryRun: true
    });
}

/**
 * The refusal that a launch gate already recorded for the current review context and would repeat now, or null.
 * Only an authenticated REVIEWER_HANDOFF_INPUTS_REJECTED event bound to this exact review context starts the check,
 * so an ordinary launch costs next-step no extra file reads. The decision itself is the launch gates' own check.
 */
export function findRecordedReviewerHandoffInputRefusal(options: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewType: string;
    contextPath: string;
    gateName: string;
    upstreamOnly?: boolean;
    dependencyOptions?: { preflightPath: string; preflightPayload: Record<string, unknown>; taskModePath?: string | null };
}): string | { upstreamReviewType: string; refusal: string } | null {
    if (!options.upstreamOnly && !REVIEWER_HANDOFF_INPUT_GATES.has(options.gateName)) {
        return null;
    }
    const rejection = readLatestHandoffInputRejection(options.eventsRoot, options.taskId, options.reviewType);
    if (!rejection) {
        return null;
    }
    const details = isPlainRecord(rejection.details) ? rejection.details : {};
    const rejectedContextSha256 = String(details.review_context_sha256 || '').trim().toLowerCase();
    const upstreamReviewType = String(details.upstream_review_type || '').trim();
    if (upstreamReviewType && options.dependencyOptions) {
        if (rejection.actor !== 'gate' || rejection.outcome !== 'FAIL' || details.task_id !== options.taskId
            || details.gate !== 'upstream-review-dependency' || !isPlainRecord(rejection.integrity)
            || !rejection.integrity.event_sha256) return null;
        const requiredReviews = isPlainRecord(options.dependencyOptions.preflightPayload.required_reviews)
            ? options.dependencyOptions.preflightPayload.required_reviews : {};
        if (!Object.hasOwn(requiredReviews, upstreamReviewType) || requiredReviews[upstreamReviewType] !== true
            || /[\\/]/u.test(upstreamReviewType)) return null;
        const upstreamContextPath = path.join(path.dirname(options.dependencyOptions.preflightPath),
            `${options.taskId}-${upstreamReviewType}-review-context.json`);
        // Check the native binding before diagnostics, including the old legacy reader's possible backfill.
        if (!matchesRecordedUpstreamContextPath(details.review_context_path, upstreamContextPath)
            || !/^[0-9a-f]{64}$/u.test(rejectedContextSha256) || fileSha256(upstreamContextPath) !== rejectedContextSha256) return null;
        const diagnostics = buildReviewDependencyDiagnostics({ ...options.dependencyOptions,
            taskId: options.taskId, reviewType: options.reviewType,
            timelineEvents: readDependencyTimelineEvents(path.join(options.eventsRoot, `${options.taskId}.jsonl`)) });
        const lost = diagnostics.statuses.find(status => status.dependencyEdge && status.reviewType === upstreamReviewType
            && !status.ready && findLostReviewGateEvidence([status.reason]));
        if (!lost || upstreamInputsRestorable(options, lost.reviewType)) return null;
        return { upstreamReviewType: lost.reviewType, refusal: lost.reason };
    }
    if (options.upstreamOnly && !String(details.reason || '').startsWith(`ReviewType '${options.reviewType}' is blocked until upstream reviews`)) return null;
    if (!/^[0-9a-f]{64}$/u.test(rejectedContextSha256) || fileSha256(options.contextPath) !== rejectedContextSha256) {
        return null;
    }
    const reviewContext = safeReadJson(options.contextPath);
    if (!reviewContext) {
        return null;
    }
    if (String(details.reason || '').startsWith(`ReviewType '${options.reviewType}' is blocked until upstream reviews`)
        && options.dependencyOptions) {
        const diagnostics = buildReviewDependencyDiagnostics({
            ...options.dependencyOptions,
            taskId: options.taskId,
            reviewType: options.reviewType,
            timelineEvents: readDependencyTimelineEvents(path.join(options.eventsRoot, `${options.taskId}.jsonl`))
        });
        const lost = diagnostics.statuses.find(status => !status.ready && findLostReviewGateEvidence([status.reason]));
        if (lost && !upstreamInputsRestorable(options, lost.reviewType)) {
            return { upstreamReviewType: lost.reviewType, refusal: lost.reason };
        }
    }
    if (options.upstreamOnly) return null;
    // The gate restores an input after the handoff only when a recorded result proved it intact after the run.
    if (options.gateName !== REVIEWER_HANDOFF_INPUT_PREPARE_GATE && restoreProvenReviewerHandoffInputs({
        repoRoot: options.repoRoot, contextPath: options.contextPath, reviewContext, taskId: options.taskId,
        reviewType: options.reviewType, dryRun: true
    })) return null;
    return findReviewerLaunchInputRefusal({
        repoRoot: options.repoRoot,
        contextPath: options.contextPath,
        reviewContext,
        gateName: options.gateName
    });
}
