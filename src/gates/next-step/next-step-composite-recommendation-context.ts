import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../../core/filesystem';
import { isPlainRecord } from '../../core/records';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { joinOrchestratorPath, resolvePathInsideRepo } from '../shared/helpers';
import type { NextStepResult } from './next-step';
import { readNextStepCommandExecution, type NextStepCommandOperation } from './next-step-command-execution';

// Advice can be suppressed, never authorized, by this marker. It carries no serialized execution authority.
const unavailableRecommendations = new WeakSet<object>();
const unavailableCommands = new WeakSet<object>();

function suppress(result: NextStepResult): void {
    unavailableRecommendations.add(result);
    for (const command of result.commands) unavailableCommands.add(command);
}

export function isNextStepAdvanceRecommendationUnavailable(result: NextStepResult): boolean {
    return unavailableRecommendations.has(result) || result.commands.some((command) => unavailableCommands.has(command));
}

/** The runner's existing repeated-state identity, shared without changing what it considers repeated. */
export function taskCompositeExecutableStateKey(result: NextStepResult, operation: NextStepCommandOperation): string {
    return createHash('sha256').update(JSON.stringify({
        status: result.status,
        next_gate: result.next_gate,
        reason: result.reason,
        command: result.commands[0]?.command ?? null,
        operation
    })).digest('hex');
}

function stopPath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'tmp',
        `${assertValidTaskId(taskId)}-composite-recommendation-stop.json`));
}

/** Attach resolution facts without changing the public navigator result or its command descriptors. */
export function attachNextStepCompositeRecommendationContext(
    result: NextStepResult, repoRoot: string, usesDefaultRoots: boolean
): NextStepResult {
    if (!usesDefaultRoots) {
        suppress(result);
        return result;
    }
    const operation = result.commands.length === 1 ? readNextStepCommandExecution(result.commands[0])?.operation : null;
    if (!operation) return result;
    try {
        const file = stopPath(repoRoot, result.task_id);
        if (!fs.existsSync(file)) return result;
        const safePath = resolvePathInsideRepo(file, repoRoot, { enforceInside: true });
        if (!safePath) return result;
        const stat = fs.statSync(safePath);
        if (!stat.isFile() || stat.size > 4096) return result;
        const stop: unknown = JSON.parse(fs.readFileSync(safePath, 'utf8'));
        if (isPlainRecord(stop) && stop.schema_version === 1
            && typeof stop.state_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(stop.state_sha256)
            && (stop.stop_kind === 'repeated-state' || stop.stop_kind === 'step-limit')
            && stop.state_sha256 === taskCompositeExecutableStateKey(result, operation)) {
            suppress(result);
        }
    } catch {
        // Invalid, unsafe or unreadable advice is absent; only a valid matching record suppresses this state.
    }
    return result;
}

/** Try to retain a state-specific advisory; a write failure changes only the reported warning. */
export function recordTaskCompositeRecommendationStop(
    repoRoot: string, taskId: string, result: NextStepResult, operation: NextStepCommandOperation,
    stopKind: 'repeated-state' | 'step-limit'
): string | null {
    suppress(result);
    try {
        const file = resolvePathInsideRepo(stopPath(repoRoot, taskId), repoRoot, { allowMissing: true });
        if (!file) throw new Error('The advisory record path is outside the repository.');
        writeFileAtomically(file, `${JSON.stringify({ schema_version: 1,
            state_sha256: taskCompositeExecutableStateKey(result, operation), stop_kind: stopKind })}\n`);
        return null;
    } catch (error: unknown) {
        return `Could not retain the composite stall advisory: ${error instanceof Error ? error.message : String(error)} `
            + 'If the navigator recommends advance again for this unchanged state, run the single-step command (--verbose) instead.';
    }
}
