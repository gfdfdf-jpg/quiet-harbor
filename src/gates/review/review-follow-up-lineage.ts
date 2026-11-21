import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isGroupedPublicationAuthorization } from '../completion/grouped-completion-evidence';
import { isPlainRecord } from '../../core/records';
import { readInvocationTextFile } from '../../core/invocation-file-observation';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { parseCanonicalActiveTaskQueue, type CanonicalActiveTaskQueueParseResult } from '../../core/task-md-table';
import {
    createTaskTimelineMemoizationKey, memoizeTaskTimelineSnapshot, withTaskTimelineReadSnapshot
} from '../../gate-runtime/timeline/task-timeline-read-snapshot';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { readReviewArtifactFileSha256 } from '../../gate-runtime/review-artifacts';
import { isPathRealpathInsideRoot, joinOrchestratorPath } from '../shared/helpers';

export const GROUPED_PUBLICATION_EVENT = 'REVIEW_FOLLOW_UP_CHILD_PUBLISHED';
export const REVIEW_FOLLOW_UP_LANES_RECOVERED_EVENT_TYPE = 'REVIEW_FOLLOW_UP_LANES_RECOVERED';

export interface PublishedLane {
    review_type: string;
    receipt_sha256: string;
    retained_reviews: readonly { cycle_id: string; receipt_sha256: string }[];
    item_count: number;
    item_fingerprints_sha256: string;
    source_binding_sha256: string;
    artifact_path: string;
    artifact_sha256: string;
}

export interface GroupedPublication {
    child_task_id: string;
    group_fingerprint: string;
    snapshot_hash: string;
    cycle_id: string;
    lanes: readonly PublishedLane[];
    completion_event_sha256?: string;
}

type Row = { taskId: string; notes?: string | null };

export function isParentFollowUpTaskId(parentTaskId: string, taskId: string): boolean {
    const prefix = `${parentTaskId}-F`;
    return taskId.startsWith(prefix) && /^[1-9][0-9]*$/u.test(taskId.slice(prefix.length));
}

export function isGroupedChildIdCandidate(parentTaskId: string, taskId: string): boolean {
    const prefix = parentTaskId.toLowerCase() + '-f';
    return taskId.toLowerCase().startsWith(prefix) && /^[1-9][0-9]*$/u.test(taskId.slice(prefix.length));
}

export function groupedQueueHasUnambiguousRows(taskId: string, queue: CanonicalActiveTaskQueueParseResult): boolean {
    return queue.found && !queue.diagnostics?.some(({ taskId: rowId }) => rowId
        && (rowId.toLowerCase() === taskId.toLowerCase() || isGroupedChildIdCandidate(taskId, rowId)));
}

const publicationMemo = createTaskTimelineMemoizationKey<GroupedPublication[] | null>('grouped-follow-up-publications');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function isPublishedLane(value: unknown): value is PublishedLane {
    return isPlainRecord(value) && typeof value.review_type === 'string' && /^[a-z][a-z0-9_-]*$/u.test(value.review_type)
        && typeof value.artifact_path === 'string' && !!value.artifact_path && !path.isAbsolute(value.artifact_path)
        && typeof value.item_count === 'number' && Number.isSafeInteger(value.item_count) && value.item_count > 0
        && isHash(value.receipt_sha256) && isHash(value.artifact_sha256)
        && isHash(value.source_binding_sha256) && isHash(value.item_fingerprints_sha256)
        && Array.isArray(value.retained_reviews) && value.retained_reviews.every(ref =>
            isPlainRecord(ref) && isHash(ref.cycle_id) && isHash(ref.receipt_sha256));
}

function collectPublications(timelinePath: string, taskId: string): GroupedPublication[] | null {
    const latest = new Map<string, GroupedPublication>();
    const groupedCompletions = new Set<string>();
    let groupedCompletionHash: string | null = null;
    const inspection = inspectTaskEventFile(timelinePath, taskId, { onIntegrityEvent(event) {
        if (event.event_type === 'COMPLETION_GATE_PASSED') {
            groupedCompletionHash = event.actor === 'gate' && event.outcome === 'PASS'
                && isPlainRecord(event.details) && event.details.grouped_follow_up_closeout === true
                && isPlainRecord(event.integrity) && isHash(event.integrity.event_sha256)
                ? event.integrity.event_sha256 : null;
        } else if (groupedCompletionHash && isGroupedPublicationAuthorization(event, taskId, groupedCompletionHash)) {
            groupedCompletions.add(groupedCompletionHash);
        }
        if (event.event_type !== GROUPED_PUBLICATION_EVENT) return;
        const details = event.details;
        if (event.actor !== 'orchestrator' || event.outcome !== 'PASS' || !isPlainRecord(details)
            || details.task_id !== taskId || !isPlainRecord(details.publication)) throw new Error('Invalid grouped publication event.');
        const digest = createHash('sha256').update(JSON.stringify(details.publication, null, 2) + '\n').digest('hex');
        if (details.publication_sha256 !== digest) throw new Error('Invalid grouped publication digest.');
        if (!isHash(details.completion_event_sha256) || !groupedCompletions.has(details.completion_event_sha256)
            || latest.size) throw new Error('Invalid grouped publication completion binding.');
        const { child_task_id, lanes, group_fingerprint, snapshot_hash, cycle_id } = details.publication;
        if (typeof child_task_id !== 'string' || !child_task_id.startsWith(taskId + '-F')
            || !/^[1-9][0-9]*$/u.test(child_task_id.slice(taskId.length + 2))
            || !isHash(group_fingerprint) || !isHash(snapshot_hash) || !isHash(cycle_id)
            || !Array.isArray(lanes) || !lanes.length || !lanes.every(isPublishedLane)
            || new Set(lanes.map(lane => lane.review_type)).size !== lanes.length) throw new Error('Invalid grouped child publication.');
        if (child_task_id !== taskId + '-F1' || details.child_task_id !== child_task_id) {
            throw new Error('Invalid initial grouped child identity.');
        }
        latest.set(child_task_id, { child_task_id, group_fingerprint, snapshot_hash, cycle_id, lanes,
            completion_event_sha256: details.completion_event_sha256 });
    } });
    return inspection.violations.length || !['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status)
        ? null : [...latest.values()];
}

export function readGroupedPublications(repoRoot: string, taskId: string) {
    const eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const timelinePath = path.join(eventsRoot, taskId + '.jsonl');
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        const snapshot = memoizeTaskTimelineSnapshot(timelinePath, publicationMemo, taskId, () => collectPublications(timelinePath, taskId));
        return snapshot.valid && snapshot.value ? new Map(snapshot.value.map(child => [child.child_task_id, child])) : null;
    });
}

type Publications = ReadonlyMap<string, GroupedPublication>;

/** Index authenticated publication lanes by their canonical artifact path. */
export function latestPublishedLanes(publications: Publications) {
    const byPath = new Map<string, PublishedLane>();
    for (const child of publications.values()) {
        for (const lane of child.lanes) byPath.set(lane.artifact_path, lane);
    }
    return byPath;
}

function childRegistryMatches(taskId: string, publication: GroupedPublication, rows: readonly Row[]): boolean {
    const children = rows.filter(row => isGroupedChildIdCandidate(taskId, row.taskId));
    if (children.length !== 1 || children[0].taskId !== publication.child_task_id) return false;
    const notes = children[0].notes || '';
    if (['group_fingerprint', 'snapshot_sha256', 'cycle'].some(key => notes.split('review_follow_up_' + key + '=').length !== 2)
        || !notes.includes(`review_follow_up_group_fingerprint=${publication.group_fingerprint}.`)
        || !notes.includes(`review_follow_up_snapshot_sha256=${publication.snapshot_hash}.`)
        || !notes.includes(`review_follow_up_cycle=${publication.cycle_id}.`)
        || notes.split('review_follow_up_lane_binding=').length - 1 !== publication.lanes.length
        || notes.split('review_follow_up_lane_artifact=').length - 1 !== publication.lanes.length) return false;
    return publication.lanes.every(lane =>
        notes.includes(`review_follow_up_lane_binding=${lane.review_type}:${lane.item_count}:${lane.item_fingerprints_sha256}:${lane.source_binding_sha256}.`)
        && notes.includes(`review_follow_up_lane_artifact=${lane.review_type}:\`${lane.artifact_path}\`.`));
}

function publishedArtifactMatches(repoRoot: string, lane: PublishedLane): boolean {
    const artifactPath = path.resolve(repoRoot, lane.artifact_path);
    return isPathRealpathInsideRoot(artifactPath, repoRoot) && readReviewArtifactFileSha256(artifactPath) === lane.artifact_sha256;
}

export function groupedPublicationMatchesQueue(
    repoRoot: string, taskId: string, publication: GroupedPublication, queue: CanonicalActiveTaskQueueParseResult
): boolean {
    return groupedQueueHasUnambiguousRows(taskId, queue) && childRegistryMatches(taskId, publication, queue.rows)
        && publication.lanes.every(lane => publishedArtifactMatches(repoRoot, lane));
}

export function checkGroupedPublicationRegistry(repoRoot: string, taskId: string, rows?: readonly Row[]) {
    const publications = readGroupedPublications(repoRoot, taskId);
    if (!publications?.size) return publications;
    try {
        // Queue maps used by navigation and audit can collapse two rows with the same ID.
        const canonicalQueue = parseCanonicalActiveTaskQueue(readInvocationTextFile(path.join(repoRoot, TASK_QUEUE_FILENAME)));
        if (!groupedQueueHasUnambiguousRows(taskId, canonicalQueue)) return null;
        return [...publications.values()].every(publication => childRegistryMatches(taskId, publication, canonicalQueue.rows)
            && (!rows || childRegistryMatches(taskId, publication, rows)))
            && [...latestPublishedLanes(publications).values()].every(lane => publishedArtifactMatches(repoRoot, lane))
            ? publications : null;
    } catch {
        return null;
    }
}

/** Only an integrity-bound current completion can authorize the final queue transition. */
export function readGroupedCompletionMarker(eventsRoot: string, taskId: string) {
    type Marker = { preflightPath: string; eventSha256: string; authorized: boolean };
    let marker: Marker | null = null;
    const inspection = inspectTaskEventFile(path.join(eventsRoot, taskId + '.jsonl'), taskId, { onIntegrityEvent(event) {
        if (event.event_type === 'COMPLETION_GATE_PASSED') {
            const details = event.details;
            const hash = isPlainRecord(event.integrity) ? event.integrity.event_sha256 : null;
            marker = event.actor === 'gate' && event.outcome === 'PASS' && isPlainRecord(details)
                && details.grouped_follow_up_closeout === true && typeof details.preflight_path === 'string'
                && isHash(hash) ? { preflightPath: details.preflight_path, eventSha256: hash, authorized: false } : null;
        } else if (marker && isGroupedPublicationAuthorization(event, taskId, marker.eventSha256)) {
            marker.authorized = true;
        } else if (['TASK_MODE_ENTERED', 'TASK_DISCARDED', 'TASK_RESET', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_RECORDED',
            'COMPILE_GATE_FAILED', 'REVIEW_GATE_FAILED', 'REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'COMPLETION_GATE_FAILED'].includes(String(event.event_type))) marker = null;
    } });
    return inspection.violations.length === 0 ? marker as Marker | null : null;
}

export function readGroupedCompletionForCloseout(eventsRoot: string, taskId: string) {
    return readGroupedCompletionMarker(eventsRoot, taskId)?.preflightPath ?? null;
}
