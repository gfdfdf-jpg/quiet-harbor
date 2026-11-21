import {
    materializeReviewFindingsFollowUpTaskBatch,
    materializeReviewFindingsFollowUpTasks,
    parseReviewFollowUpBatchReviewTypes
} from '../../../../gates/review/review-findings-follow-up-tasks';
import { materializeRecordedOutOfScopeFollowUps } from '../../../../gates/full-suite/recorded-out-of-scope-follow-ups';
import {
    EXIT_GATE_FAILURE,
    EXIT_SUCCESS
} from '../../../exit-codes';
import {
    normalizePathValue,
    parseRequiredText
} from '../../cli-helpers';
import type { ParsedOptionsRecord } from '../../shared-command-utils';

export interface ReviewFollowUpTaskCommandResult {
    outputLines: string[];
    exitCode: number;
}

function runBatchMaterializeReviewFollowUpTasksCommand(
    repoRoot: string,
    options: ParsedOptionsRecord
): ReviewFollowUpTaskCommandResult {
    if (options.reviewType || options.dispositionArtifactPath || options.receiptPath || options.artifactPath) {
        throw new Error(
            '--review-types derives each lane\'s disposition, receipt and follow-up artifact paths; ' +
            'do not combine it with --review-type, --disposition-artifact-path, --receipt-path or --artifact-path.'
        );
    }
    const result = materializeReviewFindingsFollowUpTaskBatch({
        repoRoot,
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        reviewTypes: parseReviewFollowUpBatchReviewTypes(parseRequiredText(options.reviewTypes, 'ReviewTypes')),
        reviewsRoot: options.reviewsRoot ? String(options.reviewsRoot) : null,
        operatorConfirmedUnmaterializedLanes: options.operatorConfirmedUnmaterializedLanes !== undefined
            ? parseReviewFollowUpBatchReviewTypes(options.operatorConfirmedUnmaterializedLanes)
            : undefined,
        operatorConfirmed: options.operatorConfirmed,
        operatorConfirmedAtUtc: options.operatorConfirmedAtUtc
    });
    return {
        outputLines: result.output_lines,
        exitCode: result.status === 'BLOCKED' ? EXIT_GATE_FAILURE : EXIT_SUCCESS
    };
}

export function runMaterializeReviewFollowUpTasksCommand(
    options: ParsedOptionsRecord
): ReviewFollowUpTaskCommandResult {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    if (options.reviewTypes !== undefined) {
        return runBatchMaterializeReviewFollowUpTasksCommand(repoRoot, options);
    }
    if (options.operatorConfirmedUnmaterializedLanes !== undefined || options.operatorConfirmed !== undefined
        || options.operatorConfirmedAtUtc !== undefined) {
        throw new Error('--operator-confirmed-unmaterialized-lanes and its operator confirmation apply only to the --review-types batch form.');
    }
    if (options.reviewType === 'recorded-out-of-scope') {
        return materializeRecordedOutOfScopeFollowUps(repoRoot, parseRequiredText(options.taskId, 'TaskId'));
    }
    const result = materializeReviewFindingsFollowUpTasks({
        repoRoot,
        taskId: parseRequiredText(options.taskId, 'TaskId'),
        reviewType: parseRequiredText(options.reviewType, 'ReviewType'),
        dispositionArtifactPath: options.dispositionArtifactPath
            ? String(options.dispositionArtifactPath)
            : null,
        receiptPath: options.receiptPath ? String(options.receiptPath) : null,
        artifactPath: options.artifactPath ? String(options.artifactPath) : null,
        reviewsRoot: options.reviewsRoot ? String(options.reviewsRoot) : null
    });
    return {
        outputLines: result.output_lines,
        exitCode: result.status === 'BLOCKED' ? EXIT_GATE_FAILURE : EXIT_SUCCESS
    };
}
