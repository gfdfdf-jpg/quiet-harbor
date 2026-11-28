import assert from 'node:assert/strict';
import type { NextStepResult } from '../../../../src/gates/next-step';
import { findNextStepProgressViolation } from '../../../../src/gates/next-step/next-step-progress-invariant';

/**
 * Invariants of every navigation the walk observes, derived from the printed contract rather than from a route:
 * - T-403: a BLOCKED answer carries a progressing command unless it is a stated agent action or an operator
 *   decision (no dead end). The read-only safe-exit preview never counts as progress.
 * Only the structured result is read: rendering text here would touch lazily read artifacts and change measured work.
 * A violated invariant fails the walk at the step that printed it, whatever scenario reached that route.
 */
export function assertNavigationInvariants(result: NextStepResult): void {
    const deadEnd = findNextStepProgressViolation({ taskId: result.task_id, navigatorCommand: result.navigator_command,
        status: result.status, nextGate: result.next_gate, reason: result.reason, commands: result.commands,
        decision: result.route_decision });
    assert.equal(deadEnd, null, `T-403: no dead end (${result.next_gate}: ${result.reason})`);
}
