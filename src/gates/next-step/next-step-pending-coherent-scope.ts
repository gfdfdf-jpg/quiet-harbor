import { hasProtectedCoherentScopeReceipt } from '../../core/auth/protected-coherent-scope';
import { MISSING_PENDING_SCOPE_STARTUP, readPendingCoherentScopeStartup,
    readPendingCoherentScope } from '../../cli/commands/gate-flows/recovery/recovery-flow-pending-coherent-scope';
import { buildCommand, quoteCommandValue } from './next-step-command-formatters';
import type { NextStepStartupRoute } from './next-step-startup-routing';

export function resolvePendingCoherentScopeRoute(input: {
    repoRoot: string; taskId: string; taskModePath: string; timelinePath: string; plannedFiles: () => string[];
    hasPendingHint: boolean; cliPrefix: string;
}): NextStepStartupRoute | null {
    const { repoRoot, taskId, hasPendingHint, cliPrefix } = input;
    const task = quoteCommandValue(taskId);
    try {
        if (!hasPendingHint && !hasProtectedCoherentScopeReceipt(repoRoot, taskId)) return null;
        const pending = readPendingCoherentScope({ ...input, plannedFiles: input.plannedFiles() });
        if (!pending) return null;
        if (pending.authority.classification && !readPendingCoherentScopeStartup(input).smoke)
            throw new Error(MISSING_PENDING_SCOPE_STARTUP);
        const resume = `${cliPrefix} gate restart-coherent-cycle --task-id ${task}`
            + ` --resume-pending-scope "${pending.pending.request_sha256}" --repo-root "."`;
        return {
            status: 'BLOCKED', nextGate: 'restart-coherent-cycle',
            title: 'Resume the approved coherent scope restart.',
            reason: 'The admitted scope expansion is waiting for its original recovery request to finish.',
            commands: [buildCommand('Resume pending scope restart', resume)]
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const preview = `${cliPrefix} gate task-reset --task-id ${task} --reopen --dry-run --repo-root "."`;
        const reset = `${cliPrefix} gate task-reset --task-id ${task} --reopen --one-action --confirm`
            + ' --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --repo-root "."';
        return {
            status: 'BLOCKED', nextGate: 'task-reset',
            title: 'Ask the operator to reset the task and enter task mode again.',
            reason: `Preserve any evidence needed for audit. Preview the reset with ${preview} `
                + `before obtaining explicit confirmation for a one-action task reset. ${reason}`,
            commands: [{ ...buildCommand('Reset task after operator confirmation', reset), execution_boundary: 'operator' }]
        };
    }
}
