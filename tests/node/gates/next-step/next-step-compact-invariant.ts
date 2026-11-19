import assert from 'node:assert/strict';

import type { NextStepResult } from '../../../../src/gates/next-step';
import { projectNextStepJson, selectNextStepRecommendedAction } from '../../../../src/gates/next-step/next-step-recommended-action';
import {
    MULTIPLE_COMMANDS_HEADING,
    buildNextStepInstruction,
    formatNextStepCompactText,
    formatNextStepText,
    isNextStepRepositoryWorkStep
} from '../../../../src/gates/next-step/next-step-command-formatters';

/** Lines the default (compact) answer must print exactly as the full text prints them. */
const MANDATORY_LINE_PREFIXES = Object.freeze([
    'OperatorDecisionRequired:', 'ReviewCycleBlock:', 'ReviewCycleCounts:', 'ReviewCycleLimits:', 'LatestFailedReview:',
    'OperatorChoices:', 'AutoSplitPromptArtifact:', 'AutoSplitInstructions:', 'AutoSplitConstraints:',
    'RequiredReviews:', 'ReviewLaunchableBatch:', 'BlockedReviewLanes:', 'ReviewFailedCurrent:', 'NextReview:',
    'ReviewBlockedBy:', 'BlockedReviewerLaunches:', 'MarkdownWorkingPlanPath:', 'MarkdownWorkingPlanSha256:',
    'FinalUserReportPath:', 'CopyPasteFinalUserReportSha256:', 'FinalUserReportInstruction:', 'CloseoutArtifact:',
    'CloseoutMarkdown:', 'AfterCommand:', 'Hint:', 'OperatorBoundary:', 'Known non-blocking notes:',
    'TaskStartSkillSuggestion:', 'TaskStartSkillCatalog:', 'TaskStartReviewSuggestion:', 'TaskStartReviewCatalog:',
    'TaskStartReviewPolicy:', 'OptionalSkillPendingActivation:', 'OptionalSkillSelectedDetails:', 'OptionalSkillSelectedSources:'
]);
/** Headings whose indented `  - ` / `  N. ` entries are mandatory too. */
const MANDATORY_LIST_HEADINGS = Object.freeze([
    'Warnings:', 'OperatorChoiceGuidance:', 'FinalReportOrder:', 'OptionalSkillActivationCommands:', 'OptionalSkillDeclineCommands:'
]);
/**
 * The executor's working plan and the advisory task-start skill and review guidance are compact content only where
 * the agent itself works on the repository (implementation, a step without a command, TASK_ENTRY rules); on every
 * other step they stay in the full text. On those steps they are mandatory like every other line.
 */
const REPOSITORY_WORK_ONLY_PREFIXES = Object.freeze([
    'MarkdownWorkingPlanPath:', 'MarkdownWorkingPlanSha256:', 'TaskStartSkillSuggestion:', 'TaskStartSkillCatalog:',
    'TaskStartReviewSuggestion:', 'TaskStartReviewCatalog:', 'TaskStartReviewPolicy:'
]);
/**
 * The optional-skill details and instruction are compact content on repository-work steps and on every step that
 * prints an optional-skill activation or decline command, next to that command; elsewhere they are full text only.
 */
const OPTIONAL_SKILL_DETAIL_PREFIXES = Object.freeze([
    'OptionalSkillPendingActivation:', 'OptionalSkillSelectedDetails:', 'OptionalSkillSelectedSources:'
]);
const OPTIONAL_SKILL_INSTRUCTION = 'OptionalSkillTaskStartInstruction:';

/** The warning, operator-decision, review and artifact lines of the full text, which the compact text must keep. */
export function collectMandatoryNextStepLines(fullText: string): string[] {
    const lines = fullText.split('\n');
    const mandatory: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (MANDATORY_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))) mandatory.push(line);
        if (MANDATORY_LIST_HEADINGS.includes(line)) {
            mandatory.push(line);
            while (index + 1 < lines.length && /^ {2}(?:- |\d+\. )/u.test(lines[index + 1])) {
                index += 1;
                mandatory.push(lines[index]);
            }
        }
    }
    return mandatory;
}

/**
 * Fails when a warning, operator-decision, review-navigation, guidance or artifact line of the full text is missing
 * from the compact answer on a step where it is compact content, or when a command becomes unreachable, the
 * "run exactly one" heading of alternatives, the instruction of a step without a command, the optional-skill
 * instruction next to its commands, or the verbatim final report.
 */
export function assertCompactKeepsMandatoryNextStepLines(result: NextStepResult, fullText = formatNextStepText(result)): void {
    const compactText = formatNextStepCompactText(result);
    const compactLines = new Set(compactText.split('\n'));
    const repositoryWork = isNextStepRepositoryWorkStep(result);
    const skills = result.optional_skill_selection;
    const skillCommandOnStep = Boolean(skills && (skills.activation_commands.length > 0 || skills.decline_commands.length > 0));
    const skillLinesRequired = repositoryWork || skillCommandOnStep;
    for (const line of collectMandatoryNextStepLines(fullText)) {
        if (!repositoryWork && REPOSITORY_WORK_ONLY_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
        if (!skillLinesRequired && OPTIONAL_SKILL_DETAIL_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
        assert.ok(compactLines.has(line), `compact next-step answer drops a mandatory line of the full text: ${line}`);
    }
    for (const warning of result.warnings) {
        assert.ok(compactText.includes(`  - ${warning}`), `compact next-step answer drops warning: ${warning}`);
    }
    const recommended = selectNextStepRecommendedAction(result);
    if (recommended) {
        // Reconstruct the original two command lines without copying the result: hints are bound to its identity.
        const single = result.commands[0];
        const previous = compactText.replace(`Run mechanical steps: ${recommended.command}\nSingle step: --verbose.`,
            `Commands:\n  ${single.label}: ${single.command}`).replace(
            'AfterCommand: rerun the Navigator after the command above completes.',
            `AfterCommand: rerun ${result.navigator_command} after the command above completes.`);
        assert.notEqual(previous, compactText, 'the previous-text reconstruction must change the recommendation');
        assert.ok(previous.includes(`Commands:\n  ${single.label}: ${single.command}`));
        assert.ok(compactText.length <= previous.length, 'the composite recommendation must not grow the compact answer');
        assert.ok(compactText.split('\n').length <= previous.split('\n').length, 'the composite must not add compact lines');
    }
    for (const command of result.commands) {
        if (recommended) {
            assert.ok(compactLines.has(`Run mechanical steps: ${recommended.command}`));
            assert.equal(compactText.split(recommended.command).length - 1, 1, 'print the composite exactly once');
            assert.ok(compactLines.has('Single step: --verbose.'), 'the single-step command must remain reachable');
            assert.ok(fullText.includes(`Single-step alternative:\n  ${command.label}: ${command.command}`));
            assert.ok(!compactText.includes(command.command), 'compact must not offer a second command to run');
            assert.deepEqual(projectNextStepJson(result).commands, result.commands);
        } else {
            assert.ok(compactText.includes(`  ${command.label}: ${command.command}`), `compact next-step answer drops command: ${command.label}`);
        }
    }
    if (result.commands.length > 1) {
        assert.ok(compactLines.has(MULTIPLE_COMMANDS_HEADING), 'compact next-step answer does not mark its commands as alternatives');
    }
    const instruction = result.status !== 'DONE' && result.commands.length === 0 ? buildNextStepInstruction(result) : null;
    if (instruction) {
        assert.ok(compactLines.has(`Instruction: ${instruction}`), 'compact next-step answer drops the instruction of a step without a command');
    }
    if (skills && skillLinesRequired) {
        const fullInstruction = fullText.split('\n').find((line) => line.startsWith(OPTIONAL_SKILL_INSTRUCTION));
        const skillCommands = skillCommandOnStep || /^OptionalSkill(?:Activation|Decline)Commands:$/mu.test(fullText)
            || skills.pending_activation_skill_ids.length > 0;
        const expected = skillCommands
            ? fullInstruction
            : `${OPTIONAL_SKILL_INSTRUCTION} see --verbose (decision=${skills.decision || 'unknown'})`;
        assert.ok(expected && compactLines.has(expected), `compact next-step answer drops the optional-skill instruction: ${expected}`);
    }
    if (result.final_report) {
        assert.ok(compactText.includes(`CopyPasteFinalUserReport:\n${result.final_report.final_user_report_body}`),
            'compact next-step answer drops the verbatim final user report');
    }
}
