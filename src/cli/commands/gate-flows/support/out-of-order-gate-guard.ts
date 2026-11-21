import { splitCommandLine } from '../../../../core/command-line';
import { resolveNextStep } from '../../../../gates/next-step/next-step';

/**
 * Out-of-order guard for gates an agent may run instead of the one next-step named. Next-step inspection is
 * side-effect free, so asking it changes nothing. A gate is refused only when the navigator positively routes an
 * intact cycle elsewhere; a navigator that cannot route (it throws, or needs effects executed first) never blocks
 * the gate, so recovery paths stay available.
 */
export interface NavigatorRoute {
    readonly nextGate: string | null;
    readonly status: string;
    /** --review-type of the named command, when it has one. */
    readonly lane: string;
    readonly navigatorCommand: string;
    readonly commands: readonly string[];
}

/** Steps of one lane's reviewer launch after its context exists. */
export const REVIEW_LAUNCH_GATES: readonly string[] = Object.freeze([
    'record-review-routing',
    'prepare-reviewer-launch',
    'record-reviewer-delegation-started',
    'complete-reviewer-launch',
    'record-review-result'
]);

/** Gates after every required review is recorded. */
export const POST_REVIEW_GATES: readonly string[] = Object.freeze([
    'required-reviews-check',
    'doc-impact-gate',
    'project-memory-impact',
    'completion-gate'
]);

/** Gates of an intact cycle after its compile pass. */
export const POST_COMPILE_GATES: readonly string[] = Object.freeze([
    'full-suite-validation',
    'build-review-context',
    ...REVIEW_LAUNCH_GATES,
    ...POST_REVIEW_GATES
]);

/** Gates of an intact cycle moving forward through implementation, validation, review and closeout. */
export const INTACT_CYCLE_FORWARD_GATES: readonly string[] = Object.freeze([
    'implementation',
    'compile-gate',
    ...POST_COMPILE_GATES
]);

export function readNavigatorRoute(repoRoot: string, taskId: string): NavigatorRoute | null {
    let result: ReturnType<typeof resolveNextStep>;
    try {
        result = resolveNextStep({ repoRoot, taskId });
    } catch {
        return null;
    }
    const commands = result.commands.map((entry) => entry.command);
    let lane = '';
    if (commands[0]) {
        try {
            const argv = splitCommandLine(commands[0]);
            const index = argv.indexOf('--review-type');
            lane = index >= 0 ? String(argv[index + 1] || '') : '';
        } catch {
            lane = '';
        }
    }
    return {
        nextGate: result.next_gate,
        status: result.status,
        lane,
        navigatorCommand: result.navigator_command || '',
        commands
    };
}

export function routeNamesGate(route: NavigatorRoute, gate: string): boolean {
    const pattern = new RegExp(`\\bgate\\s+${gate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=\\s|$)`, 'u');
    return route.nextGate === gate || route.commands.some((command) => pattern.test(command));
}

/** The navigator routes an intact cycle to one of `gates`, and does not name `gate` itself. */
export function routesIntactCycleElsewhere(route: NavigatorRoute | null, gate: string, gates: readonly string[]): route is NavigatorRoute {
    return !!route && route.status === 'BLOCKED' && gates.includes(String(route.nextGate)) && !routeNamesGate(route, gate);
}

export function formatOutOfOrderRefusal(gate: string, taskId: string, route: NavigatorRoute, consequence: string): string {
    return `${gate} is out of order for task '${taskId}': next-step routes the current cycle to `
        + `'${route.nextGate}${route.lane ? ` (${route.lane})` : ''}'. ${consequence} Nothing was changed. `
        + 'Run next-step and follow the gate it names'
        + (route.navigatorCommand ? `: ${route.navigatorCommand}` : '.');
}
