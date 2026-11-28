import { collectOrderedTimelineEvents, eventMatchesStage } from './completion-evidence';

/** Events that open a new task cycle; a review gate pass before them does not belong to the current cycle. */
const CYCLE_START_EVENTS: ReadonlySet<string> = new Set([
    'TASK_MODE_ENTERED',
    'TASK_RESET',
    'COHERENT_CYCLE_RESTARTED',
    'REVIEW_CYCLE_RESTARTED'
]);

export interface PrematureCompletionRefusal {
    readonly task_id: string;
    readonly status: 'NOT_READY';
    readonly outcome: 'REFUSED';
    readonly timeline_path: string;
    readonly reason: string;
}

/**
 * Completion always requires REVIEW_GATE_PASSED in the current cycle. Before it, the gate can only fail, and a
 * recorded COMPLETION_GATE_FAILED would make next-step restart the cycle. An agent that runs completion-gate too
 * early is refused without any state change instead. An unreadable timeline is not judged here: the gate itself
 * reports it.
 */
export function readPrematureCompletionRefusal(taskId: string, timelinePath: string): PrematureCompletionRefusal | null {
    const errors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, errors);
    if (errors.length > 0 || events.length === 0) {
        return null;
    }
    let cycleStart = -1;
    events.forEach((event, index) => {
        if (CYCLE_START_EVENTS.has(event.event_type)) cycleStart = index;
    });
    if (events.slice(cycleStart + 1).some((event) => eventMatchesStage(event, 'REVIEW_GATE_PASSED'))) {
        return null;
    }
    return {
        task_id: taskId,
        status: 'NOT_READY',
        outcome: 'REFUSED',
        timeline_path: timelinePath,
        reason: 'completion-gate needs REVIEW_GATE_PASSED in the current task cycle, and the task has not reached it. '
            + 'Nothing was recorded or changed. Run next-step and follow the gate it names.'
    };
}

export function buildOutOfOrderCompletionRefusal(taskId: string, reason: string): PrematureCompletionRefusal {
    return { task_id: taskId, status: 'NOT_READY', outcome: 'REFUSED', timeline_path: '', reason };
}

export function formatPrematureCompletionRefusal(refusal: PrematureCompletionRefusal): string {
    return [
        'COMPLETION_GATE_REFUSED',
        `TaskId: ${refusal.task_id}`,
        `Status: ${refusal.status}`,
        `Outcome: ${refusal.outcome}`,
        `Reason: ${refusal.reason}`
    ].join('\n');
}
