import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { NextStepResult } from '../../../../src/gates/next-step';
import {
    formatNextStepCompactText,
    formatNextStepOperatorDecisionLines,
    formatNextStepText,
    isNextStepRepositoryWorkStep
} from '../../../../src/gates/next-step/next-step-command-formatters';
import { formatTaskCompositeText } from '../../../../src/cli/commands/task-composite/task-composite-command';
import {
    COMPACTION_CHECKPOINT_HINT,
    attachNextStepHints,
    buildNextStepHintInputs,
    buildPlanBeforeCodeHint,
    resolveNextStepHintStep,
    selectNextStepHints
} from '../../../../src/gates/next-step/next-step-hints';
import { readOptionalMarkdownWorkingPlan, resolveMarkdownWorkingPlanPath } from '../../../../src/gates/task-mode/task-mode-plan';
import {
    assertCompactKeepsMandatoryNextStepLines,
    collectMandatoryNextStepLines
} from './next-step-compact-invariant';

import { buildResult, buildReviewCycleBlock, COMPILE_COMMAND, LONG_TEST_COMMAND } from './next-step-presentation-fixture';

function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}

test('the full text prints a single command once, under Next action, and keeps its Commands entry', () => {
    const text = formatNextStepText(buildResult());

    assert.equal(occurrences(text, COMPILE_COMMAND), 1);
    assert.match(text, /^ {2}Command: node bin\/garda\.js gate compile-gate /mu);
    assert.equal((text.match(/^Commands:$/gmu) || []).length, 1);
    assert.match(text, /^ {2}Run compile gate: the Command under Next action above$/mu);
});

test('the full text still prints every command of a multi-command route in Commands', () => {
    const commands = [
        { label: 'Retry the gate', command: `${COMPILE_COMMAND} --retry` },
        { label: 'Reset the task', command: 'node bin/garda.js gate task-reset --task-id "T-TEXT-1" --reopen --dry-run --repo-root "."' }
    ];
    const text = formatNextStepText(buildResult({ commands }));

    for (const command of commands) {
        assert.equal(occurrences(text, `  ${command.label}: ${command.command}`), 1);
        assert.equal(occurrences(text, command.command), 1);
    }
    assert.match(text, /^ {2}Command: none$/mu);
    assert.match(text, /^ {2}CommandReference: choose one of the 2 Commands entries below$/mu);
});

test('two or more commands are printed as alternatives to run exactly one of, in every text', () => {
    const commands = [
        { label: 'Run this task compile command', command: COMPILE_COMMAND },
        { label: 'Record no separate compile phase', command: 'node bin/garda.js gate compile-gate --task-id "T-TEXT-1" --no-compile --repo-root "."' }
    ];
    const result = buildResult({ commands });
    const compact = formatNextStepCompactText(result);
    const full = formatNextStepText(result);
    const afterCommand = 'AfterCommand: rerun node bin/garda.js next-step "T-TEXT-1" --repo-root "." after the chosen command completes.';

    for (const text of [compact, full]) {
        assert.equal((text.match(/^Commands \(run exactly one, then rerun the Navigator\):$/gmu) || []).length, 1);
        assert.doesNotMatch(text, /^Commands:$/mu);
        assert.ok(text.split('\n').includes(afterCommand));
    }
    assertCompactKeepsMandatoryNextStepLines(result);
    // A single command keeps the plain heading and the singular wording.
    const single = formatNextStepCompactText(buildResult());
    assert.match(single, /^Commands:$/mu);
    assert.match(single, /after the command above completes\.$/mu);
    const decision = formatNextStepCompactText(buildResult({ commands, review_cycle_block: buildReviewCycleBlock() }));
    assert.match(decision, /^AfterCommand: after the operator-approved chosen command completes, rerun /mu);
});

test('the compact reason keeps at least the text the old 1,200-character bound kept', () => {
    for (const length of [1_172, 1_199, 1_200]) {
        const reason = 'r'.repeat(length);
        assert.ok(formatNextStepCompactText(buildResult({ reason })).includes(`\nReason: ${reason}\n`), String(length));
    }
    for (const length of [1_201, 5_000]) {
        const compact = formatNextStepCompactText(buildResult({ reason: 'r'.repeat(length) }));
        // The old bound printed 1,197 characters and `...`; the compact text keeps those 1,197 and names --as-json.
        assert.ok(compact.includes(`\nReason: ${'r'.repeat(1_197)}... (full reason: --as-json)\n`), String(length));
    }
});

test('TaskTestPerformance does not repeat the TaskTestValidation command', () => {
    const text = formatNextStepText(buildResult());

    assert.equal(occurrences(text, LONG_TEST_COMMAND), 1);
    assert.ok(text.includes(`TaskTestValidation: enabled=true; placement=after_compile_before_reviews; command="${LONG_TEST_COMMAND}";`));
    assert.ok(text.includes('TaskTestPerformance: mode=optimized_sharded; optimized=true; '
        + 'boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command=TaskTestValidation command'));
});

test('TaskTestPerformance keeps an optimized command that differs from the task test command', () => {
    const fullSuite = buildResult().full_suite_validation;
    const note = 'mode=optimized_sharded; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; '
        + 'optimized_command="npm run test:other"';
    const text = formatNextStepText(buildResult({ full_suite_validation: { ...fullSuite, performance_guidance_note: note } }));

    assert.ok(text.includes(`TaskTestPerformance: ${note}`));
});

function buildOptionalSkills(
    overrides: Partial<NonNullable<NextStepResult['optional_skill_selection']>> = {}
): NonNullable<NextStepResult['optional_skill_selection']> {
    return {
        artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-TEXT-1-optional-skill-selection.json',
        artifact_present: true,
        artifact_violations: [],
        timeline_invalid_json: false,
        current_policy_mode: 'optional',
        policy_mode: 'optional',
        decision: 'selected',
        selection_phase: 'post_diff',
        path_evidence_source: 'actual_changed_files',
        post_diff_self_check: false,
        selected_skill_ids: ['node-backend'],
        selected_skill_sources: [],
        selected_skill_details: [],
        activated_skill_ids: [],
        declined_skill_ids: [],
        pending_activation_skill_ids: ['node-backend'],
        recommended_missing_pack_ids: [],
        as_is_reason: null,
        changed_paths: [],
        changed_paths_count: 0,
        visible_summary_line: null,
        activation_commands: [],
        decline_commands: [],
        skill_catalog_path: null,
        task_start_instruction: 'Activate the pending skill before implementation.',
        ...overrides
    };
}

test('an optional-skill activation command that is also the route command is printed once', () => {
    const activation = 'node bin/garda.js gate activate-optional-skill --task-id "T-TEXT-1" --skill-id "node-backend" --repo-root "."';
    const decline = 'node bin/garda.js gate decline-optional-skill --task-id "T-TEXT-1" --skill-id "node-backend" --repo-root "."';
    const text = formatNextStepText(buildResult({
        next_gate: 'activate-optional-skill',
        commands: [{ label: 'Activate optional skill node-backend', command: activation }],
        optional_skill_selection: buildOptionalSkills({ activation_commands: [activation], decline_commands: [decline] })
    }));

    assert.equal(occurrences(text, activation), 1);
    assert.doesNotMatch(text, /^OptionalSkillActivationCommands:$/mu);
    assert.ok(text.includes(`OptionalSkillDeclineCommands:\n  - ${decline}\n`));
});

const DECISION_WARNINGS = [
    'Review cycle limit reached: failed non-test reviews 2/2.',
    'Workspace has unrelated untracked files; keep them out of the task scope.'
];

test('the compact answer carries status, gate, title, reason, every command, review navigation and warnings', () => {
    const commands = [
        { label: 'Record continuation', command: 'node bin/garda.js gate record-review-cycle-continuation --task-id "T-TEXT-1" --decision "allow_one_more_cycle" --repo-root "."' },
        { label: 'Record split', command: 'node bin/garda.js gate record-review-cycle-split-decision --task-id "T-TEXT-1" --repo-root "."' }
    ];
    const result = buildResult({
        next_gate: 'review-cycle-operator-decision',
        title: 'Ask the operator how to continue the review cycle.',
        reason: 'The review cycle reached its limit.\nAsk the operator to choose one recovery path.',
        commands,
        warnings: DECISION_WARNINGS,
        review_cycle_block: buildReviewCycleBlock()
    });
    const compact = formatNextStepCompactText(result);

    assert.equal(compact.split('\n')[0], 'GARDA_NEXT_STEP');
    for (const line of [
        'Task: T-TEXT-1',
        'Status: BLOCKED',
        'NextGate: review-cycle-operator-decision',
        'Next: Ask the operator how to continue the review cycle.',
        'Reason: The review cycle reached its limit. Ask the operator to choose one recovery path.',
        'RequiredReviews: code, test',
        'ReviewLaunchableBatch: code',
        'BlockedReviewLanes: test blocked by code',
        'NextReview: code',
        'OperatorDecisionRequired: true',
        'OperatorChoices: allow_one_more_cycle, split_task, raise_limits',
        'Navigator: node bin/garda.js next-step "T-TEXT-1" --repo-root "."'
    ]) {
        assert.ok(compact.split('\n').includes(line), `${line}\n---\n${compact}`);
    }
    for (const command of commands) assert.ok(compact.includes(`  ${command.label}: ${command.command}\n`));
    for (const warning of DECISION_WARNINGS) assert.ok(compact.includes(`  - ${warning}\n`));
    assert.doesNotMatch(compact, /^(?:Next action:|TaskTestValidation:|TaskTestPerformance:|ReviewCycleCountsByType:|ReviewCycleTopScopeHashesByType:)/mu);
    assertCompactKeepsMandatoryNextStepLines(result);
});

test('a warning or operator-decision line of the full text is never missing from the compact answer', () => {
    const result = buildResult({ warnings: DECISION_WARNINGS, review_cycle_block: buildReviewCycleBlock(), commands: [] });
    const mandatory = collectMandatoryNextStepLines(formatNextStepText(result));

    for (const expected of ['Warnings:', `  - ${DECISION_WARNINGS[0]}`, 'OperatorDecisionRequired: true', 'OperatorChoiceGuidance:',
        '  - split_task: record a manual split decision and continue in child tasks.', 'ReviewCycleLimits: max_total_non_test_reviews=6; max_failed_non_test_reviews=2']) {
        assert.ok(mandatory.includes(expected), expected);
    }
    assertCompactKeepsMandatoryNextStepLines(result);
});

test('the compact answer stays within 4K characters on a large pre-compile step and keeps the final report verbatim', () => {
    const largeOptionalSkills = buildOptionalSkills({
        visible_summary_line: `Optional skills: selected ${'x'.repeat(300)}`,
        selected_skill_details: Array.from({ length: 6 }, (_, index) => ({
            id: `skill-${index}`, pack: 'pack', source: 'catalog', allowed_skill_path: `garda-agent-orchestrator/live/skills/skill-${index}/SKILL.md`
        })),
        task_start_instruction: 'y'.repeat(600)
    });
    const result = buildResult({ optional_skill_selection: largeOptionalSkills, reason: 'r'.repeat(5_000) });
    const compact = formatNextStepCompactText(result);
    const full = formatNextStepText(result);

    assert.ok(compact.length <= 4_000, `compact answer is ${compact.length} characters`);
    assert.ok(full.length > compact.length);
    assert.ok(compact.includes(`  Run compile gate: ${COMPILE_COMMAND}\n`));
    assert.match(compact, /^Reason: r+\.\.\. \(full reason: --as-json\)$/mu);
    assert.equal(/^Reason: (r*)\.\.\./mu.exec(compact)?.[1].length, 1_197);

    const done = buildResult({
        status: 'DONE', next_gate: null, commands: [],
        final_report: {
            final_user_report_path: 'garda-agent-orchestrator/runtime/reviews/T-TEXT-1-final-user-report.md',
            final_user_report_sha256: 'b'.repeat(64),
            final_user_report_body: 'Task T-TEXT-1 is DONE.\nReviews: code PASS.',
            closeout_json_path: 'garda-agent-orchestrator/runtime/reviews/T-TEXT-1-final-closeout.json',
            closeout_markdown_path: 'garda-agent-orchestrator/runtime/reviews/T-TEXT-1-final-closeout.md',
            required_order: ['short summary', 'CopyPasteFinalUserReport', 'commit command and permission question']
        } as NonNullable<NextStepResult['final_report']>
    });
    assert.ok(formatNextStepCompactText(done).includes('CopyPasteFinalUserReport:\nTask T-TEXT-1 is DONE.\nReviews: code PASS.\n'));
    assertCompactKeepsMandatoryNextStepLines(done);
});

test('a review-cycle stop prints the block reason once: in ReviewCycleBlock, not again in Reason', () => {
    const block = buildReviewCycleBlock();
    const result = buildResult({ commands: [], review_cycle_block: block, reason: `${block.reason} Ask the operator for a recovery path.` });
    const compact = formatNextStepCompactText(result);

    assert.equal(compact.split(block.reason).length - 1, 1);
    assert.ok(compact.includes('\nReason: (see ReviewCycleBlock reason) Ask the operator for a recovery path.\n'));
    assert.ok(compact.includes(`\nReviewCycleBlock: reason=${JSON.stringify(block.reason)};`));
    assertCompactKeepsMandatoryNextStepLines(result);
});

test('a task composite stop prints warnings and operator decisions with the same lines as the compact answer', () => {
    const result = buildResult({ warnings: DECISION_WARNINGS, review_cycle_block: buildReviewCycleBlock(), commands: [] });
    const compactLines = formatNextStepCompactText(result).split('\n');
    const text = formatTaskCompositeText({
        schema_version: 1, task_id: 'T-TEXT-1', mode: 'advance', outcome: 'STOPPED', completed: [], failed: null,
        stop: { kind: 'agent', reason: 'The navigator offers no command; follow its instruction.' },
        next: {
            status: result.status, next_gate: result.next_gate, title: result.title, reason: result.reason, commands: [],
            navigator_command: result.navigator_command, warnings: [...result.warnings],
            operator_decision: formatNextStepOperatorDecisionLines(result), hints: []
        },
        navigator_command: result.navigator_command,
        counters: { agent_invocations: 1, navigator_resolutions: 1, subgates_attempted: 0, subgates_succeeded: 0, effects_executed: 0 }
    });

    const decisionLines = collectMandatoryNextStepLines(formatNextStepText(result))
        .filter((line) => !/^(?:Required|ReviewLaunchable|BlockedReview|NextReview|AfterCommand)/u.test(line));
    assert.ok(decisionLines.length >= 8);
    for (const line of decisionLines) {
        assert.ok(compactLines.includes(line), line);
        assert.ok(text.split('\n').includes(line), `composite stop drops: ${line}`);
    }
});

test('a step without a command keeps its Instruction line in the compact answer', () => {
    const result = buildResult({ next_gate: 'implementation', title: 'Implement task changes before compile.', commands: [] });
    const compact = formatNextStepCompactText(result);

    assert.ok(compact.includes('\nCommands: none\nInstruction: make the code or test change described in Reason, then rerun the Navigator.\n'));
    assertCompactKeepsMandatoryNextStepLines(result);
});

test('optional-skill commands come with their task-start instruction; otherwise a one-line pointer', () => {
    const activation = 'node bin/garda.js gate activate-optional-skill --task-id "T-TEXT-1" --skill-id "node-backend" --repo-root "."';
    const details = [{ id: 'node-backend', pack: 'core', source: 'catalog', allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md' }];
    const actionable = buildResult({ optional_skill_selection: buildOptionalSkills({ activation_commands: [activation], selected_skill_details: details }) });
    const compact = formatNextStepCompactText(actionable);
    assert.ok(compact.includes('\nOptionalSkillTaskStartInstruction: Activate the pending skill before implementation.\n'));
    assert.ok(compact.includes('\nOptionalSkillSelectedDetails: node-backend:catalog:garda-agent-orchestrator/live/skills/node-backend/SKILL.md\n'));
    assert.ok(compact.includes(`\nOptionalSkillActivationCommands:\n  - ${activation}\n`));
    assertCompactKeepsMandatoryNextStepLines(actionable);

    const asIs = buildResult({
        next_gate: 'implementation', commands: [],
        optional_skill_selection: buildOptionalSkills({ decision: 'as_is', pending_activation_skill_ids: [], selected_skill_ids: [] })
    });
    assert.ok(formatNextStepCompactText(asIs).includes('\nOptionalSkillTaskStartInstruction: see --verbose (decision=as_is)\n'));
    assert.ok(formatNextStepText(asIs).includes('\nOptionalSkillTaskStartInstruction: Activate the pending skill before implementation.\n'));
    assertCompactKeepsMandatoryNextStepLines(asIs);
});

test('optional-skill details and instruction are compact content only on repository-work steps or next to a skill command', () => {
    const activation = 'node bin/garda.js gate activate-optional-skill --task-id "T-TEXT-1" --skill-id "node-backend" --repo-root "."';
    const details = [{ id: 'node-backend', pack: 'core', source: 'catalog', allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md' }];
    const nothingToAct = buildOptionalSkills({ pending_activation_skill_ids: [], selected_skill_details: details });
    // A review-phase step prints no skill command, so the skill lines cannot change what the agent does there.
    const onReviewStep = buildResult({ next_gate: 'record-review-result', optional_skill_selection: nothingToAct });
    assert.doesNotMatch(formatNextStepCompactText(onReviewStep), /^OptionalSkill/mu);
    assert.match(formatNextStepText(onReviewStep), /^OptionalSkillSelectedDetails: node-backend:catalog:/mu);
    assert.match(formatNextStepText(onReviewStep), /^OptionalSkillTaskStartInstruction: Activate the pending skill/mu);
    assertCompactKeepsMandatoryNextStepLines(onReviewStep);

    const onWorkStep = buildResult({ next_gate: 'implementation', commands: [], optional_skill_selection: nothingToAct });
    assert.match(formatNextStepCompactText(onWorkStep), /^OptionalSkillSelectedDetails: node-backend:catalog:/mu);
    assertCompactKeepsMandatoryNextStepLines(onWorkStep);

    // A pending skill whose activation command is listed on a gate step keeps its details and instruction there.
    const withCommand = buildResult({ optional_skill_selection: buildOptionalSkills({ activation_commands: [activation], selected_skill_details: details }) });
    const compact = formatNextStepCompactText(withCommand);
    assert.equal(isNextStepRepositoryWorkStep(withCommand), false);
    assert.ok(compact.includes('\nOptionalSkillPendingActivation: node-backend\n'));
    assert.ok(compact.includes('\nOptionalSkillTaskStartInstruction: Activate the pending skill before implementation.\n'));
    assert.ok(compact.includes(`\nOptionalSkillActivationCommands:\n  - ${activation}\n`));
    assertCompactKeepsMandatoryNextStepLines(withCommand);

    // The activation command is the route command itself: its instruction stays on the step too.
    const asRouteCommand = buildResult({
        next_gate: 'activate-optional-skill', commands: [{ label: 'Activate optional skill', command: activation }],
        optional_skill_selection: buildOptionalSkills({ activation_commands: [activation], pending_activation_skill_ids: [] })
    });
    const routeCompact = formatNextStepCompactText(asRouteCommand);
    assert.ok(routeCompact.includes('\nOptionalSkillTaskStartInstruction: Activate the pending skill before implementation.\n'));
    assert.doesNotMatch(routeCompact, /^OptionalSkillActivationCommands:/mu);
    assertCompactKeepsMandatoryNextStepLines(asRouteCommand);
});

test('task-start guidance is compact content on repository-work steps; known non-blocking notes on every step', () => {
    const guided: Partial<NextStepResult> = {
        task_start_guidance: {
            phase: 'pre_implementation',
            skill: { mode: 'catalog', suggested_skill_ids: [], activation_commands: [], catalog_path: 'garda-agent-orchestrator/live/config/skills-headlines.json' },
            review: { mode: 'catalog', omitted_lane_count: 0, lanes: [{ id: 'code', display_label: 'Code review', selection: 'available', profile_state: 'required', skill_ids: [] }] }
        } as unknown as NextStepResult['task_start_guidance'],
        known_non_blocking_signals: [{ id: 'provider-placeholders', source: 'reviewer-launch', action_required: false, summary: 'Provider-owned placeholders are external values.' }]
    };
    const guidancePrefixes = ['TaskStartSkillCatalog: relevant=none;', 'TaskStartReviewCatalog: code:Code review:available:profile_required;',
        'TaskStartReviewPolicy: guidance never makes a lane mandatory'];
    const onWorkStep = buildResult({ ...guided, next_gate: 'implementation', commands: [] });
    const workLines = formatNextStepCompactText(onWorkStep).split('\n');
    for (const prefix of [...guidancePrefixes, 'Known non-blocking notes: ']) {
        assert.ok(workLines.some((line) => line.startsWith(prefix)), prefix);
    }
    assertCompactKeepsMandatoryNextStepLines(onWorkStep);

    // Compile and later gates of the same cycle: the guidance cannot change what the agent does there.
    for (const next_gate of ['compile-gate', 'record-review-result', 'quality-checklist']) {
        const onGateStep = buildResult({ ...guided, next_gate });
        const gateLines = formatNextStepCompactText(onGateStep).split('\n');
        assert.ok(!gateLines.some((line) => line.startsWith('TaskStart')), next_gate);
        assert.ok(gateLines.some((line) => line.startsWith('Known non-blocking notes: ')), next_gate);
        const verboseLines = formatNextStepText(onGateStep).split('\n');
        for (const prefix of guidancePrefixes) assert.ok(verboseLines.some((line) => line.startsWith(prefix)), `--verbose ${prefix}`);
        assertCompactKeepsMandatoryNextStepLines(onGateStep);
    }
});

test('the Markdown working plan is compact content only on repository-work steps', () => {
    const plan = { working_plan_path: 'garda-agent-orchestrator/runtime/plans/T-TEXT-1.md', working_plan_sha256: 'd'.repeat(64) } as
        NonNullable<NextStepResult['markdown_working_plan']>;
    const onCommandStep = buildResult({ markdown_working_plan: plan });
    const onWorkStep = buildResult({ markdown_working_plan: plan, next_gate: 'implementation', commands: [] });

    assert.doesNotMatch(formatNextStepCompactText(onCommandStep), /^MarkdownWorkingPlan/mu);
    assert.match(formatNextStepText(onCommandStep), /^MarkdownWorkingPlanPath: garda-agent-orchestrator\/runtime\/plans\/T-TEXT-1\.md$/mu);
    assert.match(formatNextStepCompactText(onWorkStep), /^MarkdownWorkingPlanPath: garda-agent-orchestrator\/runtime\/plans\/T-TEXT-1\.md$/mu);
    assert.match(formatNextStepCompactText(onWorkStep), /^MarkdownWorkingPlanSha256: d{64}$/mu);
    assertCompactKeepsMandatoryNextStepLines(onCommandStep);
    assertCompactKeepsMandatoryNextStepLines(onWorkStep);
});

test('the compact CLI pointer belongs only to steps where the agent works in the repository itself', () => {
    assert.equal(isNextStepRepositoryWorkStep(buildResult()), false);
    assert.equal(isNextStepRepositoryWorkStep(buildResult({ commands: [] })), true);
    assert.equal(isNextStepRepositoryWorkStep(buildResult({ next_gate: 'implementation' })), true);
    assert.equal(isNextStepRepositoryWorkStep(buildResult({ status: 'DONE', commands: [] })), false);
});

const PLAN_PATH = 'garda-agent-orchestrator/runtime/plans/T-TEXT-1.md';
const HINT_INPUTS = { repoRoot: path.resolve('/repo-hint-fixture'), taskId: 'T-TEXT-1' };
const missing = (...keys: string[]) => keys.map((key) => ({ key, path: `garda-agent-orchestrator/runtime/reviews/T-TEXT-1-${key}.json`, exists: false }));
const taskEntryRules = (): NextStepResult => buildResult({
    next_gate: 'load-rule-pack', title: 'Record TASK_ENTRY rule files for the current task-mode cycle.',
    commands: [{ label: 'Load TASK_ENTRY rules', command: 'node bin/garda.js gate load-rule-pack --task-id "T-TEXT-1" --stage "TASK_ENTRY" --repo-root "."' }],
    missing_artifacts: missing('preflight', 'compile-gate')
});
const postPreflightRules = (): NextStepResult => buildResult({
    next_gate: 'load-rule-pack', title: 'Read and record POST_PREFLIGHT rule files.',
    commands: [{ label: 'Load POST_PREFLIGHT rules', command: 'node bin/garda.js gate load-rule-pack --task-id "T-TEXT-1" --stage "POST_PREFLIGHT" --repo-root "."' }],
    missing_artifacts: missing('compile-gate')
});

test('hint steps: plan check at TASK_ENTRY rules, compaction checkpoint at the first POST_PREFLIGHT rules after a real diff', () => {
    assert.equal(resolveNextStepHintStep(taskEntryRules(), null), 'implementation-start');
    assert.equal(resolveNextStepHintStep(postPreflightRules(), 3), 'compaction-checkpoint');
    assert.equal(resolveNextStepHintStep({ ...postPreflightRules(), next_gate: 'bind-rule-pack-to-preflight' }, 3), 'compaction-checkpoint');
    // A baseline preflight before code, a later cycle after the first compile, and every other step get no hint.
    assert.equal(resolveNextStepHintStep(postPreflightRules(), 0), null);
    assert.equal(resolveNextStepHintStep({ ...postPreflightRules(), missing_artifacts: [] }, 3), null);
    assert.equal(resolveNextStepHintStep(buildResult(), 3), null);
    assert.equal(resolveNextStepHintStep(buildResult({ next_gate: 'classify-change', missing_artifacts: missing('preflight') }), null), null);
    assert.equal(resolveNextStepHintStep({ ...taskEntryRules(), status: 'DONE' }, null), null);
});

test('the hints are one short line each and are printed by the compact text, the full text and a composite stop', () => {
    const plan = buildPlanBeforeCodeHint(PLAN_PATH);
    assert.ok(plan.length < 200 && COMPACTION_CHECKPOINT_HINT.length <= 220, `${plan.length} / ${COMPACTION_CHECKPOINT_HINT.length}`);
    assert.doesNotMatch(plan + COMPACTION_CHECKPOINT_HINT, /\n/u);

    const atEntry = attachNextStepHints(taskEntryRules(), { ...HINT_INPUTS, taskModePlanAttached: false, preflightChangedFileCount: null });
    const atCheckpoint = attachNextStepHints(postPreflightRules(), { ...HINT_INPUTS, taskModePlanAttached: true, preflightChangedFileCount: 2 });
    assert.deepEqual(selectNextStepHints(atEntry), [plan]);
    assert.deepEqual(selectNextStepHints(atCheckpoint), [COMPACTION_CHECKPOINT_HINT]);
    for (const [result, hint] of [[atEntry, plan], [atCheckpoint, COMPACTION_CHECKPOINT_HINT]] as const) {
        assert.ok(formatNextStepCompactText(result).split('\n').includes(hint));
        assert.ok(formatNextStepText(result).split('\n').includes(hint));
        assertCompactKeepsMandatoryNextStepLines(result);
        const composite = formatTaskCompositeText({
            schema_version: 1, task_id: 'T-TEXT-1', mode: 'advance', outcome: 'STOPPED', completed: [], failed: null,
            stop: { kind: 'agent', reason: 'Rule reading is an agent step.' },
            next: { status: result.status, next_gate: result.next_gate, title: result.title, reason: result.reason,
                commands: result.commands, navigator_command: result.navigator_command, warnings: [], operator_decision: [],
                hints: selectNextStepHints(result) },
            navigator_command: result.navigator_command,
            counters: { agent_invocations: 1, navigator_resolutions: 1, subgates_attempted: 0, subgates_succeeded: 0, effects_executed: 0 }
        });
        assert.ok(composite.split('\n').includes(hint));
    }
    // The hints stay out of the serialized result.
    assert.doesNotMatch(JSON.stringify(atEntry) + JSON.stringify(atCheckpoint), /Hint:/u);
    // The compact CLI pointer also belongs to the last step before code.
    assert.equal(isNextStepRepositoryWorkStep(atEntry), true);
    assert.equal(isNextStepRepositoryWorkStep(atCheckpoint), false);
});

test('the compaction hint is conditional on the agent not having compacted yet, so a repeat after a resume is safe', () => {
    assert.equal(COMPACTION_CHECKPOINT_HINT, 'Hint: if you have not compacted since the implementation, this is a good moment: '
        + 'compact and re-read the rules, or suggest it to the operator; if declined or already done, continue.');
    assert.match(COMPACTION_CHECKPOINT_HINT, /^Hint: if you have not compacted since the implementation/u);
    assert.match(COMPACTION_CHECKPOINT_HINT, /if declined or already done, continue\.$/u);
});

test('no plan hint when a JSON plan is attached or a Markdown working plan exists', () => {
    const attached = attachNextStepHints(taskEntryRules(), { ...HINT_INPUTS, taskModePlanAttached: true, preflightChangedFileCount: null });
    const markdown = attachNextStepHints({
        ...taskEntryRules(),
        markdown_working_plan: { working_plan_path: PLAN_PATH, working_plan_sha256: 'c'.repeat(64) } as NonNullable<NextStepResult['markdown_working_plan']>
    }, { ...HINT_INPUTS, taskModePlanAttached: false, preflightChangedFileCount: null });
    assert.deepEqual(selectNextStepHints(attached), []);
    assert.deepEqual(selectNextStepHints(markdown), []);
    assert.doesNotMatch(formatNextStepCompactText(attached), /^Hint:/mu);
});

test('hint inputs come from already-read navigator state; a planned-only preflight is not a real diff', () => {
    const base = { ...HINT_INPUTS };
    const diff = { changed_lines_total: 12, rename_count: 0 };
    assert.deepEqual(buildNextStepHintInputs({ ...base, taskMode: { plan: null }, preflight: null }),
        { taskModePlanAttached: false, preflightChangedFileCount: null, ...HINT_INPUTS });
    assert.equal(buildNextStepHintInputs({ ...base, taskMode: { plan: { plan_path: 'p' } }, preflight: null }).taskModePlanAttached, true);
    assert.equal(buildNextStepHintInputs({ ...base, taskMode: null, preflight: { changed_files: ['a', 'b'], metrics: diff } })
        .preflightChangedFileCount, 2);
    assert.equal(buildNextStepHintInputs({ ...base, taskMode: null,
        preflight: { changed_files: ['a'], metrics: { changed_lines_total: 0, rename_count: 1 } } }).preflightChangedFileCount, 1);
    assert.equal(buildNextStepHintInputs({ ...base, taskMode: null,
        preflight: { changed_files: ['a'], metrics: diff, zero_diff_guard: { zero_diff_detected: true } } }).preflightChangedFileCount, 0);
    // Classified from planned --changed-file hints before any code exists: files are listed, no line changed.
    const plannedOnly = buildNextStepHintInputs({ ...base, taskMode: null,
        preflight: { changed_files: ['src/app.ts'], metrics: { changed_lines_total: 0, rename_count: 0 },
            zero_diff_guard: { zero_diff_detected: false } } });
    assert.equal(plannedOnly.preflightChangedFileCount, 0);
    assert.deepEqual(selectNextStepHints(attachNextStepHints(postPreflightRules(), plannedOnly)), []);
    const explicitPlanned = buildNextStepHintInputs({ ...base, taskMode: null,
        preflight: { detection_source: 'explicit_changed_files', changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 0, rename_count: 0 }, zero_diff_guard: { zero_diff_detected: false } } });
    assert.equal(explicitPlanned.preflightChangedFileCount, 0);
    assert.deepEqual(selectNextStepHints(attachNextStepHints(postPreflightRules(), explicitPlanned)), []);
    assert.equal(buildNextStepHintInputs({ ...base, taskMode: null, preflight: { changed_files: ['a'] } }).preflightChangedFileCount, 0);
});

test('files read from the workspace are a real diff without changed lines: a new empty or binary file gets the hint', () => {
    const noLines = { changed_lines_total: 0, rename_count: 0 };
    for (const [detection_source, file] of [
        ['git_auto', 'src/empty.ts'], ['git_auto', 'src/blob.bin'], ['git_staged_only', 'src/blob.bin'],
        ['git_staged_plus_untracked', 'src/empty.ts'], ['git_auto_current_workspace', 'src/empty.ts']
    ] as const) {
        const inputs = buildNextStepHintInputs({ ...HINT_INPUTS, taskMode: null,
            preflight: { detection_source, changed_files: [file], metrics: noLines, zero_diff_guard: { zero_diff_detected: false } } });
        assert.equal(inputs.preflightChangedFileCount, 1, `${detection_source} ${file}`);
        assert.deepEqual(selectNextStepHints(attachNextStepHints(postPreflightRules(), inputs)), [COMPACTION_CHECKPOINT_HINT]);
    }
    // A workspace classification without files, or one the zero-diff guard marks as baseline only, is still no diff.
    assert.equal(buildNextStepHintInputs({ ...HINT_INPUTS, taskMode: null,
        preflight: { detection_source: 'git_auto', changed_files: [], metrics: noLines } }).preflightChangedFileCount, 0);
    assert.equal(buildNextStepHintInputs({ ...HINT_INPUTS, taskMode: null,
        preflight: { detection_source: 'git_auto', changed_files: ['src/app.ts'], metrics: noLines, zero_diff_guard: { zero_diff_detected: true } } })
        .preflightChangedFileCount, 0);
});

test('the plan hint names the path the navigator reads, also with a custom reviews root', (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-plan-hint-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const customReviewsRoot = path.join(repoRoot, 'custom', 'reviews');
    fs.mkdirSync(customReviewsRoot, { recursive: true });
    const inputs = buildNextStepHintInputs({ repoRoot, taskId: 'T-TEXT-1', taskMode: null, preflight: null });
    const [hint] = selectNextStepHints(attachNextStepHints(taskEntryRules(), inputs));
    const expected = path.relative(repoRoot, resolveMarkdownWorkingPlanPath(repoRoot, 'T-TEXT-1')).replace(/\\/gu, '/');

    assert.equal(hint, buildPlanBeforeCodeHint(expected));
    assert.equal(expected, PLAN_PATH);
    assert.doesNotMatch(hint, /custom\/plans/u);
    // A plan written there is the one the navigator reads.
    fs.mkdirSync(path.dirname(path.join(repoRoot, expected)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, expected), '# Plan\n');
    assert.equal(readOptionalMarkdownWorkingPlan(repoRoot, 'T-TEXT-1')?.working_plan_path.replace(/\\/gu, '/').endsWith(expected), true);
});
