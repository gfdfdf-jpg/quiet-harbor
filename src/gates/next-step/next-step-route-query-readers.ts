import * as path from 'node:path';
import { collectOrderedTimelineEvents, type TimelineEventEntry } from '../completion/completion-evidence';
import { readTaskTimelineRouteQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { routePreflightWitnesses, routeSplitWitnesses } from '../../gate-runtime/timeline/task-route-query';
import { createInvocationReadMemoKey, memoizeInvocationRead } from '../../core/invocation-read-observation';
const WITNESSES = createInvocationReadMemoKey<TimelineEventEntry[]>('next-step-route-witnesses');
export function readRouteOrderedWitnesses(timelinePath: string, errors: string[], purpose: 'preflight' | 'split'): TimelineEventEntry[] {
    const taskId = path.basename(timelinePath, '.jsonl');
    const query = readTaskTimelineRouteQuery(timelinePath, taskId);
    if (!query) return collectOrderedTimelineEvents(timelinePath, errors);
    return purpose === 'preflight' ? routePreflightWitnesses(query) : routeSplitWitnesses(query);
}

/** Invocation-private read view; the existing public reader still returns fresh mutable copies. */
export function readImmutableRouteOrderedWitnesses(timelinePath: string, errors: string[], purpose: 'preflight' | 'split'): TimelineEventEntry[] {
    const taskId = path.basename(timelinePath, '.jsonl');
    const query = readTaskTimelineRouteQuery(timelinePath, taskId);
    if (!query) return collectOrderedTimelineEvents(timelinePath, errors);
    return memoizeInvocationRead(WITNESSES, JSON.stringify([path.resolve(timelinePath), purpose]), () => {
        const events = purpose === 'preflight' ? routePreflightWitnesses(query, false) : routeSplitWitnesses(query);
        // Private navigation consumers only read; do not share mutable public query arrays.
        for (const event of events) {
            if (event.integrity) Object.freeze(event.integrity);
            Object.freeze(event);
        }
        return Object.freeze(events) as unknown as TimelineEventEntry[];
    }).value;
}
