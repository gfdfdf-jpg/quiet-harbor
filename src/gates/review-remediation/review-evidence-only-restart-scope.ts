import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { isPathRealpathInsideRoot } from '../../core/orchestrator-paths';
import {
    isAcceptedReviewTimelineRecord,
    resolveReviewDependencyDownstreamReachability,
    reviewDependenciesInvalidateDownstream,
    type CompiledReviewDependencyGraph
} from '../../core/review-dependency-graph';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { readInvocationVerifiedTaskEventTimeline } from '../../gate-runtime/timeline/task-events-integrity';
import { readRestartReviewClassification } from './review-remediation-classification-evidence';
import {
    resolvePersistedReviewRemediationLaneDecision,
    type ReviewRemediationDecisionClassification,
    type ReviewRemediationLaneDecision
} from './review-remediation-recovery-routing';

const TASK_ENTRY_BOUNDARY_EVENT_TYPES = new Set(['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED']);

function readVerifiedTaskEvents(timelinePath: string, taskId: string): readonly Readonly<Record<string, unknown>>[] | null {
    const verified = readInvocationVerifiedTaskEventTimeline(timelinePath, taskId);
    if (verified) {
        return verified.result.status.startsWith('PASS') ? verified.events.map((entry) => entry.event) : null;
    }
    const events: Readonly<Record<string, unknown>>[] = [];
    const inspection = inspectTaskEventFile(timelinePath, taskId, {
        onIntegrityEvent: (event) => { events.push(event); }
    });
    return inspection.status.startsWith('PASS') ? events : null;
}

const FAILED_VERDICT = /(?:^|\s)FAILED$/u;

/**
 * REVIEW_RECORDED is always written with outcome PASS, a failed review included: the verdict lives in the details
 * (the sealed cadence flag, the verdict token and the findings disposition).
 */
export function isPassedReviewRecordedEvent(event: Readonly<Record<string, unknown>>): boolean {
    const details = isPlainRecord(event.details) ? event.details : {};
    return event.event_type === 'REVIEW_RECORDED' && event.actor === 'gate' && event.outcome === 'PASS'
        && details.cadence_failed !== true
        && !FAILED_VERDICT.test(String(details.verdict_token || details.status || '').trim().toUpperCase())
        && isAcceptedReviewTimelineRecord(event as unknown as Parameters<typeof isAcceptedReviewTimelineRecord>[0]);
}

function readLaneReviewType(lane: Readonly<Record<string, unknown>>): string {
    return String(lane.review_type || '').trim().toLowerCase();
}

// Lanes are read as the receipt readers read them: an older restart can repeat more lanes than it recorded.
function readRestartInvalidatedReviewTypes(
    details: Readonly<Record<string, unknown>>,
    reviewsRoot: string,
    taskId: string
): string[] {
    const decision = details.authoritative_review_decision;
    const lanes = isPlainRecord(decision) && Array.isArray(decision.lane_decisions)
        ? decision.lane_decisions.filter(isPlainRecord)
        : [];
    if (lanes.length === 0) {
        return Array.isArray(details.invalidated_review_types)
            ? details.invalidated_review_types.map((entry) => String(entry || '').trim().toLowerCase())
            : [];
    }
    let classification: unknown;
    try {
        classification = readRestartReviewClassification({ reviewsRoot, taskId, details });
    } catch {
        return lanes.map(readLaneReviewType);
    }
    return lanes
        .map((lane) => resolvePersistedReviewRemediationLaneDecision(
            classification as ReviewRemediationDecisionClassification | undefined,
            lane as unknown as ReviewRemediationLaneDecision
        ))
        .filter((lane) => lane.invalidated && !lane.satisfied)
        .map((lane) => lane.review_type);
}

/**
 * Required reviews that a restart of this task entry invalidated and that have no fresh PASS since.
 * A materialized reuse is not a pass here: it is exactly what such a lane must not rely on. Every required
 * review is returned when the timeline cannot be authenticated, so an unreadable history repeats in FULL.
 */
export function collectUnpassedRestartInvalidatedReviewTypes(options: {
    reviewsRoot: string;
    taskId: string;
    requiredReviewTypes: readonly string[];
}): string[] {
    const timelinePath = path.join(path.dirname(options.reviewsRoot), 'task-events', `${options.taskId}.jsonl`);
    const events = readVerifiedTaskEvents(timelinePath, options.taskId);
    if (!events) {
        return [...options.requiredReviewTypes];
    }
    const unpassed = new Set<string>();
    for (const event of events) {
        const eventType = String(event.event_type || '');
        const details = isPlainRecord(event.details) ? event.details : {};
        if (TASK_ENTRY_BOUNDARY_EVENT_TYPES.has(eventType)) {
            unpassed.clear();
        } else if (eventType === 'REVIEW_RECORDED') {
            if (isPassedReviewRecordedEvent(event) && details.reused_existing_review !== true) {
                unpassed.delete(String(details.review_type || '').trim().toLowerCase());
            }
        } else if (eventType === 'REVIEW_CYCLE_RESTARTED' && event.outcome === 'PASS'
            && details.task_id === options.taskId && details.status === 'PASSED') {
            for (const reviewType of readRestartInvalidatedReviewTypes(details, options.reviewsRoot, options.taskId)) {
                unpassed.add(reviewType);
            }
        }
    }
    return options.requiredReviewTypes.filter((reviewType) => unpassed.has(reviewType));
}

function fileMatchesSha256(filePath: string, expectedSha256: string): boolean {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') === expectedSha256;
    } catch {
        return false;
    }
}

/**
 * Reviews whose latest gate REVIEW_RECORDED in the current task entry passed, but its receipt or review artifact is
 * missing or no longer holds the recorded bytes. A later failed record supersedes an earlier pass. A coherent restart
 * records lost evidence, so the next cycle cannot bring the old result back from an immutable snapshot.
 */
export function collectLostRecordedReviewEvidenceTypes(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
}): string[] {
    const timelinePath = path.join(path.dirname(options.reviewsRoot), 'task-events', `${options.taskId}.jsonl`);
    const events = readVerifiedTaskEvents(timelinePath, options.taskId);
    if (!events) {
        return [];
    }
    const latest = new Map<string, Readonly<Record<string, unknown>>>();
    for (const event of events) {
        if (TASK_ENTRY_BOUNDARY_EVENT_TYPES.has(String(event.event_type || ''))) {
            latest.clear();
        } else if (event.event_type === 'REVIEW_RECORDED' && event.actor === 'gate') {
            const details = isPlainRecord(event.details) ? event.details : {};
            latest.set(String(details.review_type || '').trim().toLowerCase(), event);
        }
    }
    const lost: string[] = [];
    const matchesBoundFile = (value: unknown, sha256: string): boolean => {
        const resolved = path.resolve(options.repoRoot, String(value).trim());
        return isPathRealpathInsideRoot(resolved, options.repoRoot, { allowMissing: true })
            && isPathRealpathInsideRoot(resolved, options.reviewsRoot, { allowMissing: true })
            && fileMatchesSha256(resolved, sha256);
    };
    for (const [reviewType, event] of latest) {
        if (!isPassedReviewRecordedEvent(event)) continue;
        const details = isPlainRecord(event.details) ? event.details : {};
        const bound = [['receipt_path', 'receipt_sha256'], ['review_artifact_path', 'review_artifact_sha256']].filter(([pathKey, shaKey]) => (
            String(details[pathKey] || '').trim() && /^[0-9a-f]{64}$/u.test(String(details[shaKey] || '').trim().toLowerCase())
        ));
        const validation = isPlainRecord(details.review_findings_validation) ? details.review_findings_validation : null;
        const validationPath = String(validation?.artifact_path || '').trim();
        const validationSha = String(validation?.artifact_sha256 || '').trim().toLowerCase();
        const validationLost = !!validationPath && /^[0-9a-f]{64}$/u.test(validationSha)
            && !matchesBoundFile(validationPath, validationSha);
        if (reviewType && (validationLost || bound.some(([pathKey, shaKey]) => !matchesBoundFile(
            details[pathKey], String(details[shaKey]).trim().toLowerCase()
        )))) {
            lost.push(reviewType);
        }
    }
    return lost.sort();
}

export interface ReviewEvidenceOnlyRestartScope {
    /** Every review the restart repeats, in the order of requiredReviewTypes. */
    reviewTypes: string[];
    carriedReviewTypes: string[];
    dependentReviewTypes: string[];
}

/**
 * Dependents repeat only under a graph declared by the profile: an implied graph orders reviews,
 * it does not say that one review depends on the result of another.
 */
export function resolveReviewEvidenceOnlyRestartScope(options: {
    reviewType: string;
    requiredReviewTypes: readonly string[];
    carriedReviewTypes?: readonly string[];
    dependencyGraph?: CompiledReviewDependencyGraph | null;
}): ReviewEvidenceOnlyRestartScope {
    const carriedReviewTypes = options.requiredReviewTypes.filter((reviewType) => (
        reviewType !== options.reviewType && options.carriedReviewTypes?.includes(reviewType)
    ));
    const seeds = [options.reviewType, ...carriedReviewTypes];
    const reached = options.dependencyGraph && reviewDependenciesInvalidateDownstream(options.dependencyGraph)
        ? resolveReviewDependencyDownstreamReachability(options.dependencyGraph, seeds).affected_review_ids
        : seeds;
    const reviewTypes = options.requiredReviewTypes.filter((reviewType) => reached.includes(reviewType));
    return {
        reviewTypes,
        carriedReviewTypes,
        dependentReviewTypes: reviewTypes.filter((reviewType) => !seeds.includes(reviewType))
    };
}

function quoteReviewTypes(reviewTypes: readonly string[]): string {
    return reviewTypes.map((reviewType) => `'${reviewType}'`).join(', ');
}

/** The exact repeat set, for route texts and pending reasons: "only 'code'", or the review and what it brings along. */
export function describeReviewEvidenceOnlyRestartRepeats(
    reviewType: string,
    scope: Pick<ReviewEvidenceOnlyRestartScope, 'carriedReviewTypes' | 'dependentReviewTypes'>
): string {
    const additions = [
        scope.carriedReviewTypes.length > 0
            ? `the reviews an earlier restart invalidated that have not passed since (${quoteReviewTypes(scope.carriedReviewTypes)}, `
                + 'in the mode that restart chose)'
            : '',
        scope.dependentReviewTypes.length > 0
            ? `the reviews that depend on ${scope.carriedReviewTypes.length > 0 ? 'them' : 'it'} in the declared review graph `
                + `(${quoteReviewTypes(scope.dependentReviewTypes)})`
            : ''
    ].filter(Boolean);
    return additions.length > 0 ? `'${reviewType}' and ${additions.join(' and ')}` : `only '${reviewType}'`;
}
