import {
    attachNextStepCommandExecution,
    type NextStepMaterializeReviewFollowUpArguments
} from './next-step-command-execution';
import { buildCommand } from './next-step-command-formatters';
import type { NextStepCommand } from './next-step';

/**
 * The follow-up materialization command and its typed step, rendered from the same arguments. Garda instructs these
 * rows from its own accepted dispositions and recorded failures, and the rules say to create them without asking,
 * so the step is mechanical. An operator-confirmed recovery is never built here.
 */
export function buildFollowUpMaterializationCommand(
    label: string,
    cliPrefix: string,
    args: NextStepMaterializeReviewFollowUpArguments
): NextStepCommand {
    const parts = [`${cliPrefix} gate materialize-review-follow-up-tasks`, `--task-id "${args.task_id}"`];
    if (args.review_type === 'recorded-out-of-scope') parts.push(`--review-type ${args.review_type}`);
    else if (args.review_type !== null) parts.push(`--review-type "${args.review_type}"`);
    if (args.review_types.length) parts.push(`--review-types "${args.review_types.join(',')}"`);
    if (args.disposition_artifact_path !== null) parts.push(`--disposition-artifact-path "${args.disposition_artifact_path}"`);
    if (args.receipt_path !== null) parts.push(`--receipt-path "${args.receipt_path}"`);
    if (args.artifact_path !== null) parts.push(`--artifact-path "${args.artifact_path}"`);
    if (args.reviews_root !== null) parts.push(`--reviews-root "${args.reviews_root}"`);
    parts.push('--repo-root "."');
    return attachNextStepCommandExecution(buildCommand(label, parts.join(' ')), 'mechanical', {
        operation_id: 'materialize-review-follow-up-tasks', arguments: args
    });
}
