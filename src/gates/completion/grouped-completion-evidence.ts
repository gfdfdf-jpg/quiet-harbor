import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import {
    computeProtectedSnapshotDigest, fileSha256, getProtectedControlPlaneRoots, joinOrchestratorPath,
    scanProtectedPathHashes
} from '../shared/helpers';

export const GROUPED_PUBLICATION_AUTHORIZED_EVENT = 'REVIEW_FOLLOW_UP_PUBLICATION_AUTHORIZED';
export const GROUPED_COMPLETION_QUEUE_STATUS = 'IN_REVIEW';

export function isGroupedPublicationAuthorization(
    event: Readonly<Record<string, unknown>>, taskId: string, completionSha256: unknown
): boolean {
    const details = isPlainRecord(event.details) ? event.details : null;
    return typeof completionSha256 === 'string' && /^[a-f0-9]{64}$/u.test(completionSha256)
        && event.event_type === GROUPED_PUBLICATION_AUTHORIZED_EVENT && event.actor === 'gate' && event.outcome === 'PASS'
        && details?.task_id === taskId && details.completion_event_sha256 === completionSha256
        && details.queue_status_before === GROUPED_COMPLETION_QUEUE_STATUS
        && typeof event.timestamp_utc === 'string' && Number.isFinite(Date.parse(event.timestamp_utc))
        && new Date(event.timestamp_utc).toISOString() === event.timestamp_utc;
}

export function groupedCompletionPaths(repoRoot: string, taskId: string) {
    const reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const reviewPath = (suffix: string) => path.join(reviewsRoot, taskId + '-' + suffix + '.json');
    return {
        reviewsRoot,
        preflightPath: reviewPath('preflight'),
        timelinePath: joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', taskId + '.jsonl')),
        compileEvidencePath: reviewPath('compile-gate'),
        reviewEvidencePath: reviewPath('review-gate'),
        docImpactPath: reviewPath('doc-impact'),
        taskModePath: reviewPath('task-mode'),
        rulePackPath: reviewPath('rule-pack'),
        handshakePath: reviewPath('handshake'),
        shellSmokePath: reviewPath('shell-smoke'),
        noOpArtifactPath: reviewPath('no-op')
    };
}

export function usesCanonicalGroupedCompletionEvidence(
    repoRoot: string, taskId: string, options: Readonly<Record<string, unknown>>
): boolean {
    return Object.entries(groupedCompletionPaths(repoRoot, taskId)).every(([key, expected]) =>
        !options[key] || path.resolve(repoRoot, String(options[key])) === path.resolve(expected));
}

function captureGroupedCompletionFiles(repoRoot: string, taskId: string) {
    const paths = groupedCompletionPaths(repoRoot, taskId);
    const preflight = fileSha256(paths.preflightPath);
    const compile = fileSha256(paths.compileEvidencePath);
    if (!preflight || !compile) return null;
    return {
        preflight_sha256: preflight,
        compile_sha256: compile,
        protected_sha256: computeProtectedSnapshotDigest(scanProtectedPathHashes(
            repoRoot, getProtectedControlPlaneRoots(repoRoot), { readOnly: true, noCache: true }))
    };
}

export function captureGroupedCompletionEvidence(repoRoot: string, taskId: string) {
    const { timelinePath } = groupedCompletionPaths(repoRoot, taskId);
    let lastHash: unknown;
    const inspection = inspectTaskEventFile(timelinePath, taskId, {
        onIntegrityEvent(event) { if (isPlainRecord(event.integrity)) lastHash = event.integrity.event_sha256; }
    });
    const files = captureGroupedCompletionFiles(repoRoot, taskId);
    return files && typeof lastHash === 'string' && inspection.violations.length === 0
        ? { ...files, timeline_predecessor_sha256: lastHash } : null;
}

export type GroupedCompletionEvidence = NonNullable<ReturnType<typeof captureGroupedCompletionEvidence>>;

const GROUPED_COMPLETION_INVALIDATION_EVENTS = new Set([
    'TASK_MODE_ENTERED', 'TASK_DISCARDED', 'TASK_RESET', 'PREFLIGHT_CLASSIFIED',
    'COMPILE_GATE_PASSED', 'COMPILE_GATE_FAILED', 'REVIEW_RECORDED',
    'REVIEW_GATE_FAILED', 'REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'COMPLETION_GATE_FAILED'
]);

export function readFreshGroupedCompletion(
    repoRoot: string, taskId: string, options: { allowPendingAuthorization?: boolean } = {}
) {
    const paths = groupedCompletionPaths(repoRoot, taskId);
    let completion: Readonly<Record<string, unknown>> | undefined;
    let authorizedAtUtc: string | null = null;
    const inspection = inspectTaskEventFile(paths.timelinePath, taskId, { onIntegrityEvent(event) {
        if (event.event_type === 'COMPLETION_GATE_PASSED') {
            completion = event;
            authorizedAtUtc = null;
        } else if (GROUPED_COMPLETION_INVALIDATION_EVENTS.has(String(event.event_type))) {
            completion = undefined;
            authorizedAtUtc = null;
        } else if (isPlainRecord(completion?.integrity)
            && isGroupedPublicationAuthorization(event, taskId, completion.integrity.event_sha256)) {
            authorizedAtUtc = String(event.timestamp_utc);
        }
    } });
    const details = isPlainRecord(completion?.details) ? completion.details : null;
    const integrity = isPlainRecord(completion?.integrity) ? completion.integrity : null;
    if (inspection.violations.length || (!authorizedAtUtc && !options.allowPendingAuthorization)
        || completion?.actor !== 'gate' || completion.outcome !== 'PASS'
        || details?.grouped_follow_up_closeout !== true || typeof integrity?.event_sha256 !== 'string'
        || typeof details.preflight_path !== 'string' || path.resolve(details.preflight_path) !== path.resolve(paths.preflightPath)
        || typeof details.timeline_path !== 'string' || path.resolve(details.timeline_path) !== path.resolve(paths.timelinePath)) return null;
    const bound = isPlainRecord(details.grouped_completion_evidence) ? details.grouped_completion_evidence : null;
    if (!bound || bound.timeline_predecessor_sha256 !== integrity.prev_event_sha256) return null;
    const files = captureGroupedCompletionFiles(repoRoot, taskId);
    if (!files || files.preflight_sha256 !== bound.preflight_sha256 || files.compile_sha256 !== bound.compile_sha256
        || files.protected_sha256 !== bound.protected_sha256) return null;
    return { eventSha256: integrity.event_sha256, preflightPath: paths.preflightPath,
        authorized: Boolean(authorizedAtUtc), authorizedAtUtc, recoveryVerificationRequired: details.grouped_recovery_verification_required === true };
}
