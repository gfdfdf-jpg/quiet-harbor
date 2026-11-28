import { TASK_QUEUE_FILENAME } from '../orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertValidTaskId } from '../../gate-runtime/task-events-helpers';
import { TASK_ID_ALLOWED_PATTERN, TASK_ID_MAX_LENGTH } from '../task-ids';
import { assertCanonicalActiveTaskQueueIntegrity, parseCanonicalActiveTaskQueue } from '../task-md-table';
import { isPlainRecord } from '../records';
import { readTaskQueueStatusToken } from './task-queue-status';

export * from './task-queue-status';

const ACTIVE_TASK_RUNTIME_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const CASE_INSENSITIVE_TASK_ID_PATTERN = new RegExp(TASK_ID_ALLOWED_PATTERN.source, 'i');

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

export interface RuntimeTaskState {
    activeTaskIds: Set<string>;
    confirmedActiveTaskIds: Set<string>;
    ambiguousTaskIds: Set<string>;
    terminalTaskIds: Set<string>;
    staleRuntimeActiveTaskIds: Set<string>;
}

export interface ResolveActiveTaskIdsOptions {
    includeAmbiguousRuntimeTasks?: boolean;
    includeStaleRuntimeActiveTasks?: boolean;
    respectTerminalQueueStatus?: boolean;
    onDiscoveryError?: (error: unknown) => void;
}

const RUNTIME_RECOVERY_EVENTS = new Set([
    'TASK_MODE_ENTERED',
    'PREFLIGHT_CLASSIFIED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED'
]);

function isRestoredRepairParent(event: Record<string, unknown>, taskId: string): boolean {
    if (event.event_type !== 'FULL_SUITE_REPAIR_WIP_RESTORED' || event.outcome !== 'PASS' || event.task_id !== taskId
        || !isPlainRecord(event.details) || !isPlainRecord(event.details.parent_status_sync)) return false;
    const resume = event.details.parent_status_sync;
    return resume.task_id === taskId && resume.next_status === 'IN_PROGRESS'
        && ['updated', 'already_synced'].includes(String(resume.outcome));
}

function assertTaskStateFile(entryPath: string, entry: fs.Stats): void {
    if (!entry.isFile() || entry.nlink > 1) {
        throw new Error(`Task state is not a regular single-link file: ${entryPath}`);
    }
}

export function collectRuntimeTaskState(
    bundleRoot: string,
    onDiscoveryError?: ResolveActiveTaskIdsOptions['onDiscoveryError']
): RuntimeTaskState {
    const activeTaskIds = new Set<string>();
    const confirmedActiveTaskIds = new Set<string>();
    const seenTimelineTaskIds = new Map<string, string>();
    const ambiguousTaskIds = new Set<string>();
    const terminalTaskIds = new Set<string>();
    const staleRuntimeActiveTaskIds = new Set<string>();
    const taskEventsDir = path.join(bundleRoot, 'runtime', 'task-events');

    try {
        let entries: string[];
        if (onDiscoveryError) {
            let hasTaskEventsDir = true;
            for (const directory of [bundleRoot, path.dirname(taskEventsDir), taskEventsDir]) {
                const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
                if (!stat) {
                    hasTaskEventsDir = false;
                    break;
                }
                if (!stat.isDirectory()) {
                    throw new Error(`Task state path is not a local directory: ${directory}`);
                }
            }
            entries = hasTaskEventsDir ? fs.readdirSync(taskEventsDir) : [];
        } else {
            entries = fs.readdirSync(taskEventsDir);
        }
        for (const entry of entries) {
            if (!entry.endsWith('.jsonl') || entry === 'all-tasks.jsonl') {
                continue;
            }

            const rawTaskId = entry.replace(/\.jsonl$/, '').trim();
            let taskId: string;
            try {
                taskId = assertValidTaskId(rawTaskId);
            } catch {
                continue;
            }

            const taskIdKey = taskId.toLowerCase();
            const priorTimelineTaskId = seenTimelineTaskIds.get(taskIdKey);
            if (priorTimelineTaskId === undefined) {
                seenTimelineTaskIds.set(taskIdKey, taskId);
            } else {
                // A queue ID cannot authoritatively identify one of two case-equivalent timelines.
                confirmedActiveTaskIds.delete(priorTimelineTaskId);
            }

            const timelinePath = path.join(taskEventsDir, entry);
            let content: string;
            let timelineMtimeMs = 0;
            try {
                const stat = onDiscoveryError ? fs.lstatSync(timelinePath) : fs.statSync(timelinePath);
                if (onDiscoveryError) assertTaskStateFile(timelinePath, stat);
                timelineMtimeMs = stat.mtimeMs;
                content = fs.readFileSync(timelinePath, 'utf8');
            } catch (error) {
                onDiscoveryError?.(error);
                activeTaskIds.add(taskId);
                continue;
            }

            let latestStatus: string | null = null;
            let parseFailed = false;
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
                    if (onDiscoveryError && (!isPlainRecord(parsed)
                        || typeof parsed.event_type !== 'string' || !parsed.event_type.trim())) {
                        throw new Error('Missing or invalid event type.');
                    }
                    const eventType = String(parsed.event_type || '').trim().toUpperCase();
                    if (eventType) {
                        hasLifecycleEvidence = true;
                        latestEventSequence += 1;
                    }
                    if (RUNTIME_RECOVERY_EVENTS.has(eventType) || isRestoredRepairParent(parsed, taskId)) {
                        latestRestartSequence = latestEventSequence;
                    }
                    if (eventType === 'COMPLETION_GATE_PASSED') {
                        hasCompletionGatePass = true;
                        latestTerminalSequence = latestEventSequence;
                    }
                    if (eventType !== 'STATUS_CHANGED') {
                        continue;
                    }
                    const details = parsed.details;
                    if (!details || typeof details !== 'object' || Array.isArray(details)) {
                        continue;
                    }
                    const nextStatus = String((details as Record<string, unknown>).new_status || '').trim();
                    if (nextStatus) {
                        latestStatus = nextStatus;
                        if (isTaskQueueTerminalStatus(nextStatus)) {
                            latestTerminalSequence = latestEventSequence;
                        }
                    }
                } catch (error) {
                    onDiscoveryError?.(new Error(`Cannot parse task events in ${timelinePath}`, { cause: error }));
                    parseFailed = true;
                    break;
                }
            }

            const withinRuntimeGrace = timelineMtimeMs > 0
                && (Date.now() - timelineMtimeMs) <= ACTIVE_TASK_RUNTIME_GRACE_MS;
            const hasFreshLifecycleRestart = withinRuntimeGrace && latestRestartSequence > latestTerminalSequence;
            if (parseFailed) {
                activeTaskIds.add(taskId);
            } else if (isTaskQueueActiveStatus(latestStatus || '') || hasFreshLifecycleRestart) {
                activeTaskIds.add(taskId);
                if (priorTimelineTaskId === undefined) {
                    confirmedActiveTaskIds.add(taskId);
                }
                if (!withinRuntimeGrace) {
                    staleRuntimeActiveTaskIds.add(taskId);
                }
            } else if (isTaskQueueTerminalStatus(latestStatus || '') || hasCompletionGatePass) {
                terminalTaskIds.add(taskId);
            } else if (hasLifecycleEvidence) {
                ambiguousTaskIds.add(taskId);
            }
        }
    } catch (error) {
        onDiscoveryError?.(error);
    }

    return {
        activeTaskIds,
        confirmedActiveTaskIds,
        ambiguousTaskIds,
        terminalTaskIds,
        staleRuntimeActiveTaskIds
    };
}

export function resolveActiveTaskIds(
    targetRoot: string,
    bundleRoot: string,
    explicitTaskIds?: readonly string[],
    options: ResolveActiveTaskIdsOptions = {}
): Set<string> {
    const activeTaskIds = new Set<string>();
    const { respectTerminalQueueStatus } = options;
    let discoveryFailed = false;
    const onDiscoveryError = respectTerminalQueueStatus ? (error: unknown): void => {
        discoveryFailed = true;
        options.onDiscoveryError?.(error);
    } : options.onDiscoveryError;
    const includeAmbiguousRuntimeTasks = options.includeAmbiguousRuntimeTasks ?? true;
    const includeStaleRuntimeActiveTasks = options.includeStaleRuntimeActiveTasks ?? true;
    for (const explicitTaskId of explicitTaskIds || []) {
        try {
            activeTaskIds.add(assertValidTaskId(explicitTaskId));
        } catch {
            // ignore invalid explicit values in best-effort active-task discovery
        }
    }

    const runtimeTaskState = collectRuntimeTaskState(bundleRoot, onDiscoveryError);
    const mergeRuntimeTaskIds = (includeAmbiguous: boolean, terminalQueueIds?: ReadonlySet<string>): void => {
        for (const taskId of runtimeTaskState.activeTaskIds) {
            if (!includeStaleRuntimeActiveTasks && runtimeTaskState.staleRuntimeActiveTaskIds.has(taskId)) {
                continue;
            }
            if (terminalQueueIds && runtimeTaskState.confirmedActiveTaskIds.has(taskId)
                && terminalQueueIds.has(taskId.toLowerCase())) {
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

    if (!respectTerminalQueueStatus) {
        mergeRuntimeTaskIds(false);
    }

    const taskPath = path.join(targetRoot, TASK_QUEUE_FILENAME);
    let content: string | undefined;
    try {
        if (onDiscoveryError) {
            const stat = fs.lstatSync(taskPath, { throwIfNoEntry: false });
            if (stat) {
                assertTaskStateFile(taskPath, stat);
                content = fs.readFileSync(taskPath, 'utf8');
            }
        } else if (fs.existsSync(taskPath)) {
            content = fs.readFileSync(taskPath, 'utf8');
        }
    } catch (error) {
        onDiscoveryError?.(error);
    }
    if (content === undefined) {
        mergeRuntimeTaskIds(includeAmbiguousRuntimeTasks);
        return activeTaskIds;
    }

    const queue = parseCanonicalActiveTaskQueue(content);
    if (onDiscoveryError) {
        try {
            if (!queue.found) throw new Error(`${taskPath}: ${queue.unavailableReason}`);
            assertCanonicalActiveTaskQueueIntegrity(queue);
        } catch (error) {
            onDiscoveryError(error);
        }
    }
    const taskMdActiveTaskIds = new Set<string>();
    const terminalQueueIds = respectTerminalQueueStatus ? new Set<string>() : undefined;
    for (const row of queue.rows) {
        const { taskId } = row;
        const isActive = isTaskQueueActiveStatus(row.status);
        const hasLowercasePrefix = respectTerminalQueueStatus && taskId.startsWith('t-');
        try {
            if (hasLowercasePrefix && isActive) {
                throw new Error(`TASK.md line ${row.lineIndex + 1}: invalid active task ID ${JSON.stringify(taskId)}. `
                    + `Correct the task ID before retrying (${taskPath})`);
            }
            // Keep accepting existing inactive rows with a lowercase prefix during update discovery.
            if (!(hasLowercasePrefix && taskId.length <= TASK_ID_MAX_LENGTH && CASE_INSENSITIVE_TASK_ID_PATTERN.test(taskId))) {
                assertValidTaskId(taskId);
            }
        } catch (error) {
            onDiscoveryError?.(error);
            continue;
        }

        // Project-specific statuses such as DRAFT do not count as active.
        if (isActive) {
            taskMdActiveTaskIds.add(taskId);
        } else if (terminalQueueIds && isTaskQueueTerminalStatus(row.status)) {
            terminalQueueIds.add(taskId.toLowerCase());
        }
    }

    for (const taskId of taskMdActiveTaskIds) {
        if (!respectTerminalQueueStatus
            && runtimeTaskState.terminalTaskIds.has(taskId) && !runtimeTaskState.activeTaskIds.has(taskId)) {
            continue;
        }
        activeTaskIds.add(taskId);
    }

    mergeRuntimeTaskIds(includeAmbiguousRuntimeTasks, discoveryFailed ? undefined : terminalQueueIds);
    return activeTaskIds;
}
