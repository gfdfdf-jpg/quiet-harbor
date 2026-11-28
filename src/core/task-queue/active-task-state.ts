import { TASK_QUEUE_FILENAME } from '../orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertValidTaskId } from '../../gate-runtime/task-events-helpers';
import { parseCanonicalActiveTaskQueue } from '../task-md-table';
import { isPlainRecord } from '../records';
import { taskIdsEqualCaseInsensitive } from '../task-ids';
import { readTaskQueueStatusToken } from './task-queue-status';

export * from './task-queue-status';

const ACTIVE_TASK_RUNTIME_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function isTaskQueueActiveStatus(statusCell: string | null): boolean {
    const statusToken = readTaskQueueStatusToken(statusCell);
    return statusToken === 'IN_PROGRESS'
        || statusToken === 'IN_REVIEW';
}

export function isTaskQueueDoneStatus(statusCell: string | null): boolean {
    return readTaskQueueStatusToken(statusCell) === 'DONE';
}

export function isTaskQueueBlockedStatus(statusCell: string | null): boolean {
    return readTaskQueueStatusToken(statusCell) === 'BLOCKED';
}

export function isTaskQueueSplitRequiredStatus(statusCell: string | null): boolean {
    return readTaskQueueStatusToken(statusCell) === 'SPLIT_REQUIRED';
}

export function isTaskQueueDecomposedStatus(statusCell: string | null): boolean {
    return readTaskQueueStatusToken(statusCell) === 'DECOMPOSED';
}

export function isTaskQueueTerminalStatus(statusCell: string | null): boolean {
    const statusToken = readTaskQueueStatusToken(statusCell);
    return statusToken === 'DONE'
        || statusToken === 'BLOCKED'
        || statusToken === 'SPLIT_REQUIRED'
        || statusToken === 'DECOMPOSED';
}

/** `missing` means the task-events directory is confirmed absent; any other read failure is `unknown`. */
export type RuntimeTaskDiscoveryStatus = 'complete' | 'missing' | 'unknown';

export interface RuntimeTaskState {
    activeTaskIds: Set<string>;
    confirmedActiveTaskIds: Set<string>;
    ambiguousTaskIds: Set<string>;
    terminalTaskIds: Set<string>;
    staleRuntimeActiveTaskIds: Set<string>;
    discoveryStatus: RuntimeTaskDiscoveryStatus;
    discoveryErrors: string[];
}

/**
 * Known IDs stay usable for diagnostics even when discovery is `unknown`;
 * an `unknown` result never proves that no other active task exists.
 */
export interface ActiveTaskDiscovery {
    activeTaskIds: Set<string>;
    discoveryStatus: 'complete' | 'unknown';
    discoveryErrors: string[];
    runtimeDiscoveryStatus: RuntimeTaskDiscoveryStatus;
}

export interface ResolveActiveTaskIdsOptions {
    includeAmbiguousRuntimeTasks?: boolean;
    includeStaleRuntimeActiveTasks?: boolean;
    respectTerminalQueueStatus?: boolean;
}

const RUNTIME_RECOVERY_EVENTS = new Set([
    'TASK_MODE_ENTERED',
    'PREFLIGHT_CLASSIFIED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED'
]);

/** Record ownership folds case, so a restoration naming the task in another case still restarts it. */
function isSameTaskIdValue(value: unknown, taskId: string): boolean {
    return typeof value === 'string' && taskIdsEqualCaseInsensitive(value, taskId);
}

function isRestoredRepairParent(event: Record<string, unknown>, taskId: string): boolean {
    if (event.event_type !== 'FULL_SUITE_REPAIR_WIP_RESTORED' || event.outcome !== 'PASS' || !isSameTaskIdValue(event.task_id, taskId)
        || !isPlainRecord(event.details) || !isPlainRecord(event.details.parent_status_sync)) return false;
    const resume = event.details.parent_status_sync;
    return isSameTaskIdValue(resume.task_id, taskId) && resume.next_status === 'IN_PROGRESS'
        && ['updated', 'already_synced'].includes(String(resume.outcome));
}

function isMissingPathError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * ENOENT alone is not proof of absence: a dangling link anywhere on the path reports it too.
 * Absence is confirmed only when the nearest existing ancestor is a real directory without the entry.
 */
function isConfirmedAbsentPath(targetPath: string): boolean {
    const target = path.resolve(targetPath);
    const ancestor = findNearestExistingPath(target);
    if (ancestor === undefined) {
        return false;
    }
    if (ancestor === null) {
        return true;
    }
    if (ancestor === target) {
        return false;
    }
    try {
        // The nearest existing entry may be a valid link to a directory; a dangling one throws here.
        return fs.statSync(ancestor).isDirectory();
    } catch {
        return false;
    }
}

/** The nearest path whose entry exists, null when nothing on the path exists, undefined when an entry cannot be read. */
function findNearestExistingPath(targetPath: string): string | null | undefined {
    let current = path.resolve(targetPath);
    for (;;) {
        try {
            fs.lstatSync(current);
            return current;
        } catch (error) {
            if (!isMissingPathError(error)) {
                return undefined;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return null;
            }
            current = parent;
        }
    }
}

const MISSING_TASK_EVENTS_ENTRY = '\0missing-task-events-entry';

/**
 * The first entry strictly below the bundle on the way to `targetPath` that is a link (junctions included), or null.
 * Entries are checked one by one with lstat, so no spelling or case comparison decides the identity; a link above the
 * bundle keeps the whole bundle together and is allowed. Read failures other than a missing entry propagate.
 */
function findLinkedBundleComponent(bundleRoot: string, targetPath: string): string | null {
    const resolvedBundleRoot = path.resolve(bundleRoot);
    const relativeTarget = path.relative(resolvedBundleRoot, path.resolve(targetPath));
    if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        return null;
    }
    let current = resolvedBundleRoot;
    for (const segment of relativeTarget.split(path.sep)) {
        current = path.join(current, segment);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) {
                return current;
            }
        } catch (error) {
            if (isMissingPathError(error)) {
                return null;
            }
            throw error;
        }
    }
    return null;
}

/**
 * A linked task-events entry, or a linked runtime ancestor, may point at another inventory, so only the real
 * runtime/task-events directory of this bundle is authoritative.
 */
function describeTaskEventsContainmentError(bundleRoot: string, taskEventsDir: string): string | null {
    try {
        if (fs.lstatSync(taskEventsDir).isSymbolicLink()) {
            return `runtime task-events directory: is a link, so its inventory may belong to another runtime (${taskEventsDir})`;
        }
        const linkedAncestor = findLinkedBundleComponent(bundleRoot, path.dirname(taskEventsDir));
        if (linkedAncestor) {
            return `runtime task-events directory: resolves through a linked runtime ancestor (${linkedAncestor}), `
                + 'so its inventory may belong to another runtime';
        }
        return null;
    } catch (error) {
        if (isMissingPathError(error) && isConfirmedAbsentPath(taskEventsDir)) {
            return describeMissingTaskEventsContainmentError(bundleRoot, taskEventsDir) ?? MISSING_TASK_EVENTS_ENTRY;
        }
        return describeDiscoveryError('runtime task-events directory entry', error);
    }
}

/**
 * Absence proves nothing when the existing part of the path leaves this bundle: a linked runtime without task-events
 * would otherwise read as missing, and cleanup would then delete inside the link target.
 */
function describeMissingTaskEventsContainmentError(bundleRoot: string, taskEventsDir: string): string | null {
    try {
        const linkedAncestor = findLinkedBundleComponent(bundleRoot, taskEventsDir);
        return linkedAncestor
            ? `runtime task-events directory: is absent under a linked runtime ancestor (${linkedAncestor}), `
                + 'so its absence does not prove this runtime has no tasks'
            : null;
    } catch (error) {
        return describeDiscoveryError('runtime task-events ancestor', error);
    }
}

/**
 * Timelines and the task queue are authoritative only as regular files with a single link: a symbolic or hard link
 * may share another task's or workspace's contents, and a special file (for example a FIFO) cannot be read safely.
 */
function isSingleLinkRegularFile(entry: fs.Stats): boolean {
    return entry.isFile() && entry.nlink <= 1;
}

function describeDiscoveryError(source: string, error: unknown): string {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    return `${source}: ${code ? `${code} ` : ''}${message}`;
}

type TimelineRecordClassification = 'own' | 'foreign' | 'malformed';

function isValidTaskIdValue(value: string): boolean {
    try {
        assertValidTaskId(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Malformed discriminators cannot be lifecycle evidence; another task's records are ignored for this timeline.
 * An own record without a non-blank event type is incomplete, so it cannot be skipped behind earlier terminal evidence.
 */
function classifyTimelineRecord(record: unknown, taskId: string): TimelineRecordClassification {
    if (!isPlainRecord(record)) {
        return 'malformed';
    }
    const eventType = record.event_type;
    const recordTaskId = record.task_id;
    if ((eventType !== undefined && eventType !== null && typeof eventType !== 'string')
        || (recordTaskId !== undefined && typeof recordTaskId !== 'string')) {
        // Only an omitted task_id is a legacy record; an explicit null is not an identity.
        return 'malformed';
    }
    if (typeof recordTaskId === 'string' && !taskIdsEqualCaseInsensitive(recordTaskId, taskId)) {
        // Only a valid other task ID names another owner; an empty or invalid ID is corruption, not a foreign record.
        return isValidTaskIdValue(recordTaskId) ? 'foreign' : 'malformed';
    }
    return typeof eventType === 'string' && eventType.trim() ? 'own' : 'malformed';
}

export function collectRuntimeTaskState(bundleRoot: string): RuntimeTaskState {
    const activeTaskIds = new Set<string>();
    const confirmedActiveTaskIds = new Set<string>();
    const ambiguousTaskIds = new Set<string>();
    const terminalTaskIds = new Set<string>();
    const staleRuntimeActiveTaskIds = new Set<string>();
    const discoveryErrors: string[] = [];
    const buildState = (discoveryStatus: RuntimeTaskDiscoveryStatus): RuntimeTaskState => ({
        activeTaskIds,
        confirmedActiveTaskIds,
        ambiguousTaskIds,
        terminalTaskIds,
        staleRuntimeActiveTaskIds,
        discoveryStatus,
        discoveryErrors
    });
    const taskEventsDir = path.join(bundleRoot, 'runtime', 'task-events');

    // The entry type is checked before enumeration, so a linked inventory is never followed.
    const containmentError = describeTaskEventsContainmentError(bundleRoot, taskEventsDir);
    if (containmentError === MISSING_TASK_EVENTS_ENTRY) {
        return buildState('missing');
    }
    if (containmentError) {
        discoveryErrors.push(containmentError);
        return buildState('unknown');
    }
    let entries: string[];
    try {
        entries = fs.readdirSync(taskEventsDir);
    } catch (error) {
        if (isMissingPathError(error) && isConfirmedAbsentPath(taskEventsDir)) {
            return buildState('missing');
        }
        discoveryErrors.push(describeDiscoveryError('runtime task-events directory', error));
        return buildState('unknown');
    }

    const firstTimelineTaskIds = new Map<string, string>();
    const conflictedTimelineTaskIds = new Map<string, Set<string>>();
    try {
        for (const entry of entries) {
            // Case-insensitive filesystems open T-1.JSONL through the usual T-1.jsonl path, so the extension match folds case.
            const normalizedEntry = entry.toLowerCase();
            if (!normalizedEntry.endsWith('.jsonl') || normalizedEntry === 'all-tasks.jsonl') {
                continue;
            }

            const rawTaskId = entry.slice(0, -'.jsonl'.length).trim();
            let taskId: string;
            try {
                taskId = assertValidTaskId(rawTaskId);
            } catch {
                continue;
            }
            const timelineKey = taskId.toLowerCase();
            const firstTaskId = firstTimelineTaskIds.get(timelineKey);
            if (firstTaskId !== undefined) {
                // Case-equivalent timelines cannot both be authoritative; the conflict is resolved after the scan.
                const conflicted = conflictedTimelineTaskIds.get(timelineKey) ?? new Set([firstTaskId]);
                conflicted.add(taskId);
                conflictedTimelineTaskIds.set(timelineKey, conflicted);
                continue;
            }
            firstTimelineTaskIds.set(timelineKey, taskId);
            if (entry !== `${taskId}.jsonl`) {
                // A folded extension or trimmed name is not the timeline that writers own (on a case-sensitive
                // filesystem it is a different file), so it may only keep the task protected, never release it.
                activeTaskIds.add(taskId);
                continue;
            }

            const timelinePath = path.join(taskEventsDir, entry);
            let content: string;
            let timelineMtimeMs = 0;
            try {
                const timelineEntry = fs.lstatSync(timelinePath);
                if (!isSingleLinkRegularFile(timelineEntry)) {
                    // A linked, hard-linked or special timeline may carry another task's history; keep the task protected.
                    activeTaskIds.add(taskId);
                    continue;
                }
                timelineMtimeMs = timelineEntry.mtimeMs;
                content = fs.readFileSync(timelinePath, 'utf8');
            } catch {
                activeTaskIds.add(taskId);
                continue;
            }

            let latestStatus: string | null = null;
            let parseFailed = false;
            let hasOwnRecord = false;
            let hasForeignRecord = false;
            let hasLifecycleEvidence = false;
            let hasCompletionGatePass = false;
            let latestEventSequence = -1;
            let latestRestartSequence = -1;
            let latestTerminalSequence = -1;
            for (const rawLine of content.split('\n')) {
                const line = rawLine.trim();
                if (!line) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(line) as Record<string, unknown>;
                    const recordClassification = classifyTimelineRecord(parsed, taskId);
                    if (recordClassification === 'malformed') {
                        parseFailed = true;
                        break;
                    }
                    if (recordClassification === 'foreign') {
                        hasForeignRecord = true;
                        continue;
                    }
                    hasOwnRecord = true;
                    const eventType = typeof parsed.event_type === 'string' ? parsed.event_type.trim().toUpperCase() : '';
                    if (eventType) {
                        hasLifecycleEvidence = true;
                        latestEventSequence += 1;
                    }
                    if (RUNTIME_RECOVERY_EVENTS.has(eventType) || isRestoredRepairParent(parsed, taskId)) {
                        latestRestartSequence = latestEventSequence;
                    }
                    if (eventType === 'COMPLETION_GATE_PASSED') {
                        if (parsed.outcome !== undefined && parsed.outcome !== 'PASS' && parsed.outcome !== 'INFO') {
                            // The completion writer records PASS (a failure is COMPLETION_GATE_FAILED) and the neutral
                            // audit append records INFO; any other outcome contradicts the record and cannot prove completion.
                            parseFailed = true;
                            break;
                        }
                        hasCompletionGatePass = true;
                        latestTerminalSequence = latestEventSequence;
                    }
                    if (eventType !== 'STATUS_CHANGED') {
                        continue;
                    }
                    const rawStatus = isPlainRecord(parsed.details) ? parsed.details.new_status : undefined;
                    const nextStatus = typeof rawStatus === 'string' ? rawStatus.trim() : '';
                    if (!nextStatus || !readTaskQueueStatusToken(nextStatus)) {
                        // An incomplete, malformed or unrecognized transition cannot prove the task left an active state.
                        parseFailed = true;
                        break;
                    }
                    latestStatus = nextStatus;
                    if (isTaskQueueTerminalStatus(nextStatus)) {
                        latestTerminalSequence = latestEventSequence;
                    }
                } catch {
                    parseFailed = true;
                    break;
                }
            }

            if (hasForeignRecord && !hasOwnRecord) {
                // A timeline holding only another task's records gives no authority for this task.
                parseFailed = true;
            }

            const withinRuntimeGrace = timelineMtimeMs > 0
                && (Date.now() - timelineMtimeMs) <= ACTIVE_TASK_RUNTIME_GRACE_MS;
            const hasFreshLifecycleRestart = withinRuntimeGrace && latestRestartSequence > latestTerminalSequence;
            if (parseFailed) {
                activeTaskIds.add(taskId);
            } else if (isTaskQueueActiveStatus(latestStatus || '')) {
                activeTaskIds.add(taskId);
                confirmedActiveTaskIds.add(taskId);
                if (!withinRuntimeGrace) {
                    staleRuntimeActiveTaskIds.add(taskId);
                }
            } else if (hasFreshLifecycleRestart) {
                activeTaskIds.add(taskId);
                confirmedActiveTaskIds.add(taskId);
            } else if (isTaskQueueTerminalStatus(latestStatus || '') || hasCompletionGatePass) {
                terminalTaskIds.add(taskId);
            } else if (hasLifecycleEvidence) {
                ambiguousTaskIds.add(taskId);
            }
        }
    } catch (error) {
        // Keep the IDs found so far for diagnostics, but never report a partial scan as complete.
        protectConflictedTimelines();
        discoveryErrors.push(describeDiscoveryError('runtime task-events scan', error));
        return buildState('unknown');
    }

    protectConflictedTimelines();
    return buildState('complete');

    /** Conflicting timelines give no stale, terminal or ambiguous authority, so every spelling stays fully active. */
    function protectConflictedTimelines(): void {
        for (const taskIds of conflictedTimelineTaskIds.values()) {
            for (const taskId of taskIds) {
                activeTaskIds.add(taskId);
                confirmedActiveTaskIds.delete(taskId);
                staleRuntimeActiveTaskIds.delete(taskId);
                terminalTaskIds.delete(taskId);
                ambiguousTaskIds.delete(taskId);
            }
        }
    }
}

/** Best-effort diagnostic view; authority consumers must use resolveActiveTaskDiscovery and check its status. */
export function resolveActiveTaskIds(
    targetRoot: string,
    bundleRoot: string,
    explicitTaskIds?: readonly string[],
    options: ResolveActiveTaskIdsOptions = {}
): Set<string> {
    return resolveActiveTaskDiscovery(targetRoot, bundleRoot, explicitTaskIds, options).activeTaskIds;
}

/** Returns null for complete discovery, otherwise the shared refusal diagnostic for `operation`. */
export function describeIncompleteActiveTaskDiscovery(discovery: ActiveTaskDiscovery, operation: string): string | null {
    if (discovery.discoveryStatus === 'complete') {
        return null;
    }
    return `Active task discovery is unknown, so ${operation} is refused: hidden active tasks cannot be excluded. `
        + `Known active tasks: ${[...discovery.activeTaskIds].sort().join(', ') || 'none'}. `
        + `Discovery errors: ${discovery.discoveryErrors.join('; ')}`;
}

export function assertActiveTaskDiscoveryComplete(discovery: ActiveTaskDiscovery, operation: string): void {
    const diagnostic = describeIncompleteActiveTaskDiscovery(discovery, operation);
    if (diagnostic) {
        throw new Error(diagnostic);
    }
}

export function resolveActiveTaskDiscovery(
    targetRoot: string,
    bundleRoot: string,
    explicitTaskIds?: readonly string[],
    options: ResolveActiveTaskIdsOptions = {}
): ActiveTaskDiscovery {
    const activeTaskIds = new Set<string>();
    const includeAmbiguousRuntimeTasks = options.includeAmbiguousRuntimeTasks ?? true;
    const includeStaleRuntimeActiveTasks = options.includeStaleRuntimeActiveTasks ?? true;
    for (const explicitTaskId of explicitTaskIds || []) {
        try {
            activeTaskIds.add(assertValidTaskId(explicitTaskId));
        } catch {
            // ignore invalid explicit values in best-effort active-task discovery
        }
    }

    const runtimeTaskState = collectRuntimeTaskState(bundleRoot);
    // A missing TASK.md has no queue to read; one that exists but cannot be read hides queue-only active tasks.
    const buildDiscovery = (queueError: string | null = null): ActiveTaskDiscovery => ({
        activeTaskIds,
        discoveryStatus: runtimeTaskState.discoveryStatus === 'unknown' || queueError ? 'unknown' : 'complete',
        discoveryErrors: queueError ? [...runtimeTaskState.discoveryErrors, queueError] : [...runtimeTaskState.discoveryErrors],
        runtimeDiscoveryStatus: runtimeTaskState.discoveryStatus
    });
    const mergeRuntimeTaskIds = (includeAmbiguous: boolean, terminalQueueIds?: ReadonlySet<string>): void => {
        for (const taskId of runtimeTaskState.activeTaskIds) {
            if (!includeStaleRuntimeActiveTasks && runtimeTaskState.staleRuntimeActiveTaskIds.has(taskId)) {
                continue;
            }
            if (terminalQueueIds?.has(taskId.toLowerCase()) && runtimeTaskState.confirmedActiveTaskIds.has(taskId)) {
                continue;
            }
            activeTaskIds.add(taskId);
        }
        if (includeAmbiguous) {
            for (const taskId of runtimeTaskState.ambiguousTaskIds) {
                activeTaskIds.add(taskId);
            }
        }
    };

    if (!options.respectTerminalQueueStatus) {
        mergeRuntimeTaskIds(false);
    }

    const taskPath = path.join(targetRoot, TASK_QUEUE_FILENAME);
    try {
        if (!isSingleLinkRegularFile(fs.lstatSync(taskPath))) {
            // A linked queue may belong to another workspace and a special file cannot be read safely, so neither can
            // prove which local tasks are inactive; the entry is not opened.
            mergeRuntimeTaskIds(includeAmbiguousRuntimeTasks);
            return buildDiscovery('task queue TASK.md: is a link or not a regular single-link file, so it cannot prove '
                + `which local tasks are inactive (${taskPath})`);
        }
    } catch (error) {
        // Only a confirmed absence means there is no queue; any other lookup failure hides queue-only active tasks.
        mergeRuntimeTaskIds(includeAmbiguousRuntimeTasks);
        return isMissingPathError(error) && isConfirmedAbsentPath(taskPath)
            ? buildDiscovery()
            : buildDiscovery(describeDiscoveryError('task queue TASK.md', error));
    }

    let content: string;
    try {
        content = fs.readFileSync(taskPath, 'utf8');
    } catch (error) {
        // Known runtime and explicit IDs stay usable for diagnostics; the unknown status refuses destructive use.
        mergeRuntimeTaskIds(includeAmbiguousRuntimeTasks);
        return buildDiscovery(describeDiscoveryError('task queue TASK.md', error));
    }

    const taskMdActiveTaskIds = new Set<string>();
    const queue = parseCanonicalActiveTaskQueue(content);
    const terminalQueueIds = options.respectTerminalQueueStatus && runtimeTaskState.discoveryStatus !== 'unknown'
        && !queue.diagnostics?.length
        ? new Set(queue.rows.filter(row => isTaskQueueTerminalStatus(row.status)).map(row => row.taskId.toLowerCase()))
        : undefined;
    let queueError: string | null = null;
    for (const row of queue.rows) {
        if (!isTaskQueueActiveStatus(row.status)) {
            continue;
        }
        try {
            taskMdActiveTaskIds.add(assertValidTaskId(row.taskId));
        } catch {
            if (options.respectTerminalQueueStatus && row.taskId.startsWith('t-')) {
                queueError ??= `TASK.md line ${row.lineIndex + 1}: invalid active task ID ${JSON.stringify(row.taskId)}. `
                    + `Correct the task ID before retrying (${taskPath})`;
            }
        }
    }

    for (const taskId of taskMdActiveTaskIds) {
        if (!options.respectTerminalQueueStatus
            && runtimeTaskState.terminalTaskIds.has(taskId) && !runtimeTaskState.activeTaskIds.has(taskId)) {
            continue;
        }
        activeTaskIds.add(taskId);
    }

    mergeRuntimeTaskIds(includeAmbiguousRuntimeTasks, terminalQueueIds);
    return buildDiscovery(queueError);
}
