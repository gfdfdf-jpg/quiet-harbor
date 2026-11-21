import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProtectedControlPlaneRoots, testPathPrefix } from '../shared/helpers';

const MAX_EXAMPLE_ROOTS = 4;

/** The task-mode entry gate's own predicate: planned files under these roots need --orchestrator-work. */
export function plannedFilesNeedOrchestratorWork(repoRoot: string, plannedFiles: readonly string[]): boolean {
    const roots = getProtectedControlPlaneRoots(repoRoot);
    return plannedFiles.some(file => testPathPrefix(file, roots));
}

/**
 * Fresh entry whose planned files the navigator cannot know: say before the call which existing paths
 * task-mode entry treats as protected, and that declaring them still needs the operator's confirmation.
 */
export function withProtectedEntryScopeHint<T extends { reason: string; commands: ReadonlyArray<{ command: string }> }>(
    repoRoot: string,
    route: T
): T {
    const entryCommands = route.commands.filter(item => /\bgate enter-task-mode\b/u.test(item.command));
    if (!entryCommands.length || entryCommands.some(item => item.command.includes('--orchestrator-work'))) return route;
    const examples = getProtectedControlPlaneRoots(repoRoot)
        .filter(root => fs.existsSync(path.join(repoRoot, root)))
        .sort((left, right) => left.split('/').filter(Boolean).length - right.split('/').filter(Boolean).length
            || left.localeCompare(right))
        .slice(0, MAX_EXAMPLE_ROOTS);
    if (!examples.length) return route;
    return {
        ...route,
        reason: `${route.reason} If your planned files include protected orchestrator files (for example ${examples.join(', ')}), `
            + 'entry is refused without --orchestrator-work: ask the operator to confirm orchestrator work, then add '
            + '--orchestrator-work --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" and a '
            + '--planned-changed-file flag for each planned file. Never supply the confirmation without the operator\'s answer.'
    };
}
