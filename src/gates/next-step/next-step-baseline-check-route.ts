import { readBaselineCheckDecision } from '../full-suite/baseline-checks';
import { buildCommand } from './next-step-command-formatters';
import type { NextStepDecisionRoutePayload } from './next-step-decision-route-groups';

/**
 * Declared baseline checks, after the validation phase and until all required reviews passed: a red check routes to
 * fixing it and then to task test validation, which evaluates the checks again on the current tree (a run that did not
 * finish needs only that rerun). A compiled scope without an evaluation routes to task test validation.
 */
export function resolveBaselineCheckRoute(options: {
    repoRoot: string;
    taskId: string;
    taskTestValidationCommand: string;
    navigatorCommand: string;
}): NextStepDecisionRoutePayload | null {
    const decision = readBaselineCheckDecision(options.repoRoot, options.taskId);
    if (!decision || decision.reviewed) return null;
    const command = buildCommand('Run task test validation to evaluate the declared baseline checks on the current tree',
        options.taskTestValidationCommand);
    if (decision.failures.length) {
        const reasons = decision.failures.map(failure => `Declared baseline check "${failure.command}" is red: ${failure.reason}.`);
        const onlyRerun = decision.failures.every(failure => failure.didNotFinish);
        return {
            status: 'BLOCKED', nextGate: 'implementation',
            title: 'Make the declared project check green again.',
            reason: `${reasons.join(' ')} ${onlyRerun ? 'The run did not finish: remove the cause and rerun.' : 'Fix it in this task so the check passes.'}`
                + ' Then run task test validation; if it asks for a new compile pass first, follow next-step.',
            commands: [command]
        };
    }
    if (!decision.missing.length) return null;
    return {
        status: 'BLOCKED', nextGate: 'full-suite-validation',
        title: 'Evaluate the declared project checks before reviews.',
        reason: `Declared baseline checks have no result for the current compiled scope: ${decision.missing.map(entry => `"${entry}"`).join(', ')}. `
            + 'Task test validation runs them on the current tree; each must be green.',
        commands: [command]
    };
}
