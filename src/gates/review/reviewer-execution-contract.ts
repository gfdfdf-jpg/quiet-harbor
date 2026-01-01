export {
    REVIEWER_FOCUSED_SELF_VALIDATION_TOPIC, REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER,
    REVIEWER_MISSING_FOCUSED_TEST_ACTION, REVIEWER_MISSING_FOCUSED_VALIDATION_ACTION,
    REVIEWER_MISSING_FOCUSED_TEST_MARKER_TEMPLATE, REVIEWER_MISSING_FOCUSED_VALIDATION_MARKER_TEMPLATE,
    buildReviewerFocusedSelfValidationContractLines
} from '../../core/templates';

export function buildReviewerTerminalContractLines(): string[] {
    return [
        '- This reviewer-only handoff is not task implementation under repository AGENTS/start-task rules: do not open TASK.md or `.agents/workflows/start-task.md`, do not enter task mode, and do not act as the orchestrator.',
        '- Reviewer terminal contract: inspect only the authenticated scope, write exactly one review JSON object to ReviewOutputPath, and run the read-only record-review-result --check-only command in the launch handoff. Fix every diagnostic and repeat until it passes, then return that same object and stop.',
        '- Never invoke Garda navigation, launch, invocation, result recording, receipt, TASK.md, or project-memory commands; record-review-result --check-only is the required read-only exception.',
        '- Never launch a reviewer, subagent, or descendant agent, and never mutate source files, task state, reviewer control evidence, receipts, or other handoff artifacts.',
        '- The launcher/main agent exclusively owns delegation telemetry, result recording, downstream routing, completion, and cleanup after your single output is written.'
    ];
}
