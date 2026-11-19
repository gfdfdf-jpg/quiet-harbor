import { inspectTaskEventFile } from './task-events-integrity';
import { withTaskTimelineFileReadSnapshot } from './task-timeline-read-snapshot';

/** Verify that the caller's event projection came from the same authenticated snapshot. */
export function isMatchingVerifiedTaskTimeline<T>(options: {
    timelinePath: string;
    taskId: string;
    expectedEvents: readonly T[];
    readEvents: () => readonly T[];
}): boolean {
    if (!options.timelinePath || !options.taskId) return false;
    try {
        return withTaskTimelineFileReadSnapshot(options.timelinePath, () => {
            const events = options.readEvents();
            return JSON.stringify(events) === JSON.stringify(options.expectedEvents)
                && inspectTaskEventFile(options.timelinePath, options.taskId).status === 'PASS';
        });
    } catch {
        return false;
    }
}
