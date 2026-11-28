import assert from 'node:assert/strict';
import type { NextStepResult } from '../../../../src/gates/next-step';
import { findNextStepProgressViolation } from '../../../../src/gates/next-step/next-step-progress-invariant';

/**
 * Invariants of every navigation the walk observes, derived from the printed contract rather than from a route:
 * - no shared test command before this task selected its tests (1ab17cb5): another active task's command, estimate
 *   or timeout note must never be shown as if it belonged to this task;
 * - route alternatives are distinct commands (eb59395c: a command is never printed twice);
 * - T-403: a BLOCKED answer carries a progressing command unless it is a stated agent action (no dead end).
 * Only the structured result is read: rendering text here would touch lazily read artifacts and change measured work.
 * A violated invariant fails the walk at the step that printed it, whatever scenario reached that route.
 */
export function assertNavigationInvariants(result: NextStepResult): void {
    const suite = result.full_suite_validation;
    if (suite.config_source === 'project_command_reference') {
        const where = `${result.next_gate}: ${result.reason}`;
        assert.equal(suite.command, '', `No shared test command before the task selects its tests (${where})`);
        assert.equal(suite.performance_guidance_note, null, `No command-derived performance note (${where})`);
        assert.equal(suite.timeout_forecast_note, null, `No command-derived timeout note (${where})`);
        assert.equal(suite.recommended_timeout_seconds, null, `No command-derived timeout (${where})`);
        assert.ok(!result.reason.includes('reference to narrow from'), `The selection route carries no reference command (${where})`);
    }
    const commands = result.commands.map(entry => entry.command);
    assert.equal(new Set(commands).size, commands.length, `Route alternatives are distinct commands: ${commands.join(' | ')}`);
    const deadEnd = findNextStepProgressViolation({ taskId: result.task_id, navigatorCommand: result.navigator_command,
        status: result.status, nextGate: result.next_gate, reason: result.reason, commands: result.commands,
        decision: result.route_decision });
    assert.equal(deadEnd, null, `T-403: no dead end (${result.next_gate}: ${result.reason})`);
}

/**
 * OP-045 (ad781a28): after an attested fix_now failure on the unchanged reviewed tree the agent must implement the fix
 * first. Routing it through validation refresh (compile, checklist, test selection and execution) before any edit sends
 * it back toward review without work. The walk checks this on the very first answer after the failure.
 */
export const VALIDATION_BEFORE_REMEDIATION: ReadonlySet<string> = new Set([
    'compile-gate', 'quality-checklist', 'task-test-selection', 'full-suite-validation', 'run-intermediate-command', 'project-validation-evidence'
]);
export function assertRemediationBeforeValidation(result: NextStepResult, fixPending: boolean): void {
    if (!fixPending) return;
    assert.ok(!VALIDATION_BEFORE_REMEDIATION.has(String(result.next_gate)),
        `OP-045: a fix_now failure on the unchanged tree routes to remediation, not to ${result.next_gate}: ${result.reason}`);
}
