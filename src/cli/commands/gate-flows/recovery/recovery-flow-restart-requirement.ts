import {
    formatOutOfOrderRefusal,
    INTACT_CYCLE_FORWARD_GATES,
    readNavigatorRoute,
    routesIntactCycleElsewhere
} from '../support/out-of-order-gate-guard';

/**
 * A coherent-cycle restart discards current compile and review evidence. When the navigator routes an intact
 * cycle forward through implementation, validation, review or closeout, nothing requires it and it is refused
 * before any state change. Startup and preflight-preparation routes are not judged: a restart replays exactly
 * that work. A navigator that cannot route leaves the restart available as the recovery path.
 */
export function readUnrequiredCoherentRestart(repoRoot: string, taskId: string): string | null {
    const route = readNavigatorRoute(repoRoot, taskId);
    return routesIntactCycleElsewhere(route, 'restart-coherent-cycle', INTACT_CYCLE_FORWARD_GATES)
        ? 'Nothing requires a coherent-cycle restart. ' + formatOutOfOrderRefusal('restart-coherent-cycle', taskId, route,
            'A restart would discard the current compile and review evidence and start a new review cycle.')
        : null;
}
