import * as fs from 'node:fs';
import * as path from 'node:path';

import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { readReviewArtifactFileSha256 } from '../../gate-runtime/review-artifacts';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { getSafeWorktreePathState } from '../workspace/worktree-path-state';
import { buildReviewDependencyDiagnostics, type ReviewDependencyTimelineEvent } from '../review/review-dependencies';
import { collectRemediationLaneHistory, readAuthenticatedRemediationLaneReceipt } from './review-remediation-scope-review-types';

/**
 * Whether a delegated reviewer demonstrably finished before the workspace left the tree its context binds. Its
 * returned output must be older than every reviewed file that changed since; a reviewed file that is gone, a
 * staged review tree (the reviewer reads the worktree, not the index) or an unreadable output proves nothing.
 * Only such a passed result may be recorded against its reviewed tree after the workspace changed (a failed one
 * always may): otherwise the reviewer could have read the changed files instead of the reviewed ones, and the
 * review repeats. Without any changed reviewed file the result is simply current.
 */
export function reviewerFinishedBeforeWorkspaceChange(options: {
    repoRoot: string;
    /** The parsed review context, or its path (an unreadable context proves nothing). */
    reviewContext: Record<string, unknown> | string;
    reviewOutputPath: string;
    /** Only a completed launch authenticated against the timeline may supply this original timestamp. */
    authenticatedOutputMtimeMs?: number | null;
}): boolean {
    let reviewContext: unknown = options.reviewContext;
    if (typeof reviewContext === 'string') {
        try {
            reviewContext = JSON.parse(fs.readFileSync(reviewContext, 'utf8'));
        } catch {
            return false;
        }
    }
    const treeState = isPlainRecord(reviewContext) && isPlainRecord(reviewContext.tree_state) ? reviewContext.tree_state : null;
    if (!treeState || treeState.use_staged !== false || !Array.isArray(treeState.entries)) {
        return false;
    }
    let outputMtimeMs: number;
    if (options.authenticatedOutputMtimeMs != null) {
        outputMtimeMs = options.authenticatedOutputMtimeMs;
        if (!Number.isFinite(outputMtimeMs)) return false;
    } else {
        try {
            outputMtimeMs = fs.statSync(path.resolve(options.repoRoot, options.reviewOutputPath)).mtimeMs;
        } catch {
            return false;
        }
    }
    return treeState.entries.every((entry) => {
        if (!isPlainRecord(entry) || !isPlainRecord(entry.worktree)) {
            return false;
        }
        const relativePath = String(entry.path || '');
        const reviewed = entry.worktree;
        try {
            const current: Record<string, unknown> = { ...getSafeWorktreePathState(options.repoRoot, relativePath) };
            if (current.status === reviewed.status && current.sha256 === reviewed.sha256 && current.mode === reviewed.mode) {
                return true;
            }
            return fs.lstatSync(path.resolve(options.repoRoot, relativePath)).mtimeMs > outputMtimeMs;
        } catch {
            return false;
        }
    });
}

/**
 * Upstream reviews of a finished delegated review, judged on the tree that review saw instead of the current
 * workspace. record-review-result accepts such a result's upstream reviews exactly when this is ready, and
 * next-step routes a finished review to record-review-result only when it is, so the two cannot disagree.
 *
 * build-review-context and the launch gates admit a dependent review only after its upstream reviews passed on
 * the then-current tree, which is the tree the dependent review's context binds. An upstream review that the
 * ordinary check finds stale for freshness only (the workspace changed after the reviewer started) therefore
 * still counts when its latest REVIEW_RECORDED of the current compile cycle precedes this review's reviewer
 * invocation, passed, and its receipt and review artifact are still the authenticated ones that event recorded.
 * A lost upstream context also permits recording the already-finished reviewer, but only when its authenticated
 * launch was prepared after that upstream pass: preparation itself checked the then-current upstream context.
 * The upstream receipt and report must still be the exact authenticated bytes. This does not make the lost review
 * valid again; a declared dependency graph may still require the dependent review to repeat on recovery.
 */
export function resolveReviewedTreeUpstreamReadiness(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewContextSha256: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    taskModePath?: string | null;
}): { ready: boolean; reason: string } {
    const contextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(contextSha256)) {
        return { ready: false, reason: 'the reviewed context has no content hash' };
    }
    const timelinePath = joinOrchestratorPath(options.repoRoot, 'runtime/task-events/' + options.taskId + '.jsonl');
    const events: ReviewDependencyTimelineEvent[] = [];
    let compilePosition = -1;
    let invocationPosition = -1;
    let invocationAuthenticated = false;
    let preparedPosition = -1;
    const recorded = new Map<string, { position: number; outcome: string; actor: string; details: Record<string, unknown> }>();
    const integrity = inspectTaskEventFile(timelinePath, options.taskId, {
        onIntegrityEvent: (event) => {
            const position = events.length;
            const details = isPlainRecord(event.details) ? event.details : null;
            const eventType = String(event.event_type || '').trim().toUpperCase();
            const outcome = String(event.outcome || '').trim().toUpperCase();
            const eventReviewType = String(details?.review_type || '').trim().toLowerCase();
            events.push({ event_type: eventType, task_id: String(event.task_id || ''), outcome, sequence: position, details });
            if (eventType === 'COMPILE_GATE_PASSED') {
                compilePosition = position;
            } else if (eventType === 'REVIEWER_LAUNCH_PREPARED' && event.actor === 'orchestrator' && outcome === 'INFO'
                && details && details.task_id === options.taskId && eventReviewType === options.reviewType
                && String(details.review_context_sha256 || '').trim().toLowerCase() === contextSha256) {
                preparedPosition = position;
            } else if (eventType === 'REVIEWER_INVOCATION_ATTESTED' && details && eventReviewType === options.reviewType
                && String(details.review_context_sha256 || '').trim().toLowerCase() === contextSha256) {
                invocationPosition = position;
                invocationAuthenticated = event.actor === 'orchestrator' && outcome === 'INFO' && details.task_id === options.taskId;
            } else if (eventType === 'REVIEW_RECORDED' && details && eventReviewType) {
                recorded.set(eventReviewType, { position, outcome, actor: String(event.actor || ''), details });
            }
        }
    });
    if (integrity.status !== 'PASS') {
        return { ready: false, reason: `the task timeline cannot be authenticated (${integrity.status})` };
    }
    const blocked = buildReviewDependencyDiagnostics({
        taskId: options.taskId,
        preflightPath: options.preflightPath,
        preflightPayload: options.preflightPayload,
        reviewType: options.reviewType,
        timelineEvents: events,
        taskModePath: options.taskModePath
    }).statuses.filter((status) => status.dependencyEdge && !status.ready);
    if (blocked.length === 0) {
        return { ready: true, reason: 'every upstream review is current' };
    }
    const unsupported = blocked.find((status) => status.blockerCode !== 'stale_freshness' && status.blockerCode !== 'missing_context');
    if (unsupported) {
        return { ready: false, reason: `'${unsupported.reviewType}': ${unsupported.reason}` };
    }
    if (invocationPosition < 0 || compilePosition < 0 || invocationPosition < compilePosition) {
        return { ready: false, reason: `no reviewer invocation of the current compile cycle binds the '${options.reviewType}' context` };
    }
    const history = collectRemediationLaneHistory({ repoRoot: options.repoRoot, taskId: options.taskId });
    for (const { reviewType: upstreamReviewType, blockerCode } of blocked) {
        const event = recorded.get(upstreamReviewType);
        if (!event || event.position < compilePosition || event.position > invocationPosition || event.outcome !== 'PASS') {
            return { ready: false, reason: `'${upstreamReviewType}' did not pass in this compile cycle before the '${options.reviewType}' reviewer started` };
        }
        const canonicalReceipt = path.join(path.dirname(options.preflightPath), `${options.taskId}-${upstreamReviewType}-receipt.json`);
        const canonicalArtifact = path.join(path.dirname(options.preflightPath), `${options.taskId}-${upstreamReviewType}.md`);
        if (blockerCode === 'missing_context' && (preparedPosition < compilePosition || !invocationAuthenticated || event.actor !== 'gate'
            || event.position >= preparedPosition || preparedPosition >= invocationPosition
            || path.resolve(options.repoRoot, String(event.details.receipt_path || '')) !== path.resolve(canonicalReceipt)
            || path.resolve(options.repoRoot, String(event.details.review_artifact_path || '')) !== path.resolve(canonicalArtifact)
            || !receiptMatches(options.repoRoot, event.details))) {
            return { ready: false, reason: `the '${upstreamReviewType}' pass or the dependent launch cannot be authenticated before the context was lost` };
        }
        const receipt = readAuthenticatedRemediationLaneReceipt({
            repoRoot: options.repoRoot, taskId: options.taskId, reviewType: upstreamReviewType, details: event.details,
            timingEvents: history.timingEvents, trustedReceipts: history.trustedReceipts
        });
        if (history.integrity.status !== 'PASS' || !receipt.authenticated || !receipt.passed
            || !artifactMatches(options.repoRoot, event.details)) {
            return { ready: false, reason: `the '${upstreamReviewType}' evidence is not the authenticated passed review it recorded` };
        }
    }
    return { ready: true, reason: 'every stale upstream review passed before the reviewer started on the reviewed tree' };
}

/** A lost context can reopen a closed review stage only for the exact authenticated passed receipt it bound. */
export function hasAuthenticatedPassedReceiptForLostContext(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    contextSha256: string;
}): boolean {
    const history = collectRemediationLaneHistory({ repoRoot: options.repoRoot, taskId: options.taskId });
    const lane = history.lanes.get(options.reviewType);
    const details = lane?.details;
    if (history.integrity.status !== 'PASS' || !details || details.review_context_sha256 !== options.contextSha256) return false;
    let latestRecordIsGatePass = false;
    const timeline = joinOrchestratorPath(options.repoRoot, `runtime/task-events/${options.taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timeline, options.taskId, { onIntegrityEvent: (event) => {
        if (event.event_type !== 'REVIEW_RECORDED' || !isPlainRecord(event.details)
            || event.details.review_type !== options.reviewType) return;
        latestRecordIsGatePass = event.actor === 'gate' && event.outcome === 'PASS'
            && event.details.task_id === options.taskId && event.details.review_context_sha256 === options.contextSha256
            && isPlainRecord(event.integrity) && Number(event.integrity.task_sequence) === lane?.sequence;
    } });
    if (inspection.status !== 'PASS' || !latestRecordIsGatePass) return false;
    const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`);
    if (path.resolve(options.repoRoot, String(details.receipt_path || '')) !== path.resolve(receiptPath)
        || readReviewArtifactFileSha256(receiptPath) !== details.receipt_sha256) return false;
    const receipt = readAuthenticatedRemediationLaneReceipt({ ...options, details,
        timingEvents: history.timingEvents, trustedReceipts: history.trustedReceipts });
    return receipt.authenticated && receipt.passed;
}

function receiptMatches(repoRoot: string, details: Record<string, unknown>): boolean {
    const receiptPath = String(details.receipt_path || '').trim();
    const expected = String(details.receipt_sha256 || '').trim().toLowerCase();
    return Boolean(receiptPath && /^[a-f0-9]{64}$/u.test(expected)
        && readReviewArtifactFileSha256(path.resolve(repoRoot, receiptPath)) === expected);
}

function artifactMatches(repoRoot: string, details: Record<string, unknown>): boolean {
    const artifactPath = String(details.review_artifact_path || '').trim();
    const expected = String(details.review_artifact_sha256 || '').trim().toLowerCase();
    if (!artifactPath || !/^[a-f0-9]{64}$/u.test(expected)) {
        return false;
    }
    return String(readReviewArtifactFileSha256(path.resolve(repoRoot, artifactPath)) || '').trim().toLowerCase() === expected;
}
