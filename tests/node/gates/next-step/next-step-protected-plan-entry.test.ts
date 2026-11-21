import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveCanonicalTaskPlanPath } from '../../../../src/core/task-plan-read';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { runEnterTaskModeCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { resolveNextStep } from '../../../../src/gates/next-step/next-step';
import { readNextStepCommandExecution } from '../../../../src/gates/next-step/next-step-command-execution';
import { formatNextStepCompactText, formatNextStepText } from '../../../../src/gates/next-step/next-step-command-formatters';
import { buildEnterTaskModeCommand } from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';
import { selectTaskPlanScopeProtection } from '../../../../src/gates/task-mode/task-mode-plan-protection';
import { initializeGitRepo, seedInitAnswers } from '../../cli/commands/gate-test-helpers';
import { TASK_ID, makeTempRepo, reviewsRoot } from './next-step-completion-fixtures';

const PROTECTED_FILE = 'AGENTS.md';
const WORKFLOW_CONFIG = 'garda-agent-orchestrator/live/config/workflow-config.json';
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

/** A Garda source checkout lets agents declare orchestrator work; an application workspace keeps the self-guard on. */
function workspace(t: TestContext, scopeFiles: string[] | null, sourceCheckout = true): string {
    const repoRoot = makeTempRepo();
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    seedInitAnswers(repoRoot, 'Codex');
    if (sourceCheckout) {
        fs.writeFileSync(path.join(repoRoot, 'package.json'), `${JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2)}\n`);
    }
    fs.writeFileSync(path.join(repoRoot, PROTECTED_FILE), '# Rules\n');
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/runtime/\nTASK.md\n');
    initializeGitRepo(repoRoot);
    if (scopeFiles) {
        const file = resolveCanonicalTaskPlanPath(repoRoot, TASK_ID);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, serializeTaskPlan(validateTaskPlan({
            schema_version: 1, task_id: TASK_ID, status: 'approved', goal: 'Update the agent entry rules',
            scope_files: scopeFiles, risk_level: 'low', steps: [{ id: 'one', title: 'Edit the rules' }],
            acceptance_criteria: ['Rules updated'], verification_expectations: ['Focused tests'], out_of_scope: ['Other tasks']
        })));
    }
    return repoRoot;
}

function enter(repoRoot: string, extra: Record<string, unknown> = {}): ReturnType<typeof runEnterTaskModeCommand> {
    return runEnterTaskModeCommand({ repoRoot, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Update the agent entry rules', provider: 'Codex', emitMetrics: false, ...extra });
}

/** Both navigator texts name an operator-boundary command explicitly, next to the printed command. */
function assertOperatorBoundaryPrinted(result: ReturnType<typeof resolveNextStep>): void {
    const line = `OperatorBoundary: ${result.commands[0].label} - an operator step: ask the operator, run it only after `
        + 'their explicit approval, and never supply the approval yourself.';
    assert.ok(formatNextStepCompactText(result).split('\n').includes(line), formatNextStepCompactText(result));
    assert.ok(formatNextStepText(result).split('\n').includes(line));
}

function entryError(repoRoot: string, extra: Record<string, unknown> = {}): Error {
    try {
        const result = enter(repoRoot, extra);
        assert.fail(`entry was accepted: ${result.outputLines.join('\n')}`);
    } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        return error as Error;
    }
}

test('an attached plan with protected files stops task-mode entry without --orchestrator-work', (t) => {
    const repoRoot = workspace(t, ['src/app.ts', PROTECTED_FILE]);
    const error = entryError(repoRoot);
    assert.match(error.message, /Planned task scope includes protected orchestrator files: AGENTS\.md\./u);
    assert.match(error.message, /Re-run enter-task-mode with --orchestrator-work/u);
    assert.match(error.message, /--operator-confirmed-at-utc "<ISO-8601 timestamp>"/u);
    assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`)), false, 'no task-mode evidence');
});

test('declaring orchestrator work for a protected plan still requires the operator confirmation', (t) => {
    const repoRoot = workspace(t, ['src/app.ts', PROTECTED_FILE]);
    const error = entryError(repoRoot, { orchestratorWork: true });
    assert.doesNotMatch(error.message, /Planned task scope includes protected orchestrator files/u);
    assert.match(error.message, /Ask the operator to approve this protected task-mode entry/u);
    assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`)), false);
});

test('under the Garda self-guard a protected plan stops at entry and the navigator routes to operator maintenance', (t) => {
    const repoRoot = workspace(t, ['src/app.ts', PROTECTED_FILE], false);
    const error = entryError(repoRoot);
    assert.match(error.message, /Garda self-guard is on[\s\S]*Planned protected files: AGENTS\.md\./u);
    assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`)), false);
    // The entry gate refuses this plan whatever the flags, so the navigator must not print an entry command.
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.equal(result.next_gate, 'operator-maintenance', result.reason);
    assert.equal(result.title, 'Garda self-guard blocks agent-owned protected control-plane work.');
    assert.match(result.reason, /attached task plan includes protected Garda control-plane files: AGENTS\.md\./u);
    assert.equal(result.commands.length, 1);
    assert.match(result.commands[0].command, / doctor --target-root "\."$/u);
    assert.doesNotMatch(result.commands[0].command, /enter-task-mode|--orchestrator-work|--operator-confirmed/u);
    assert.equal(readNextStepCommandExecution(result.commands[0])?.boundary, 'operator');
    assertOperatorBoundaryPrinted(result);
});

test('a plan without protected files enters task mode as before', (t) => {
    const repoRoot = workspace(t, ['src/app.ts']);
    const result = enter(repoRoot);
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
});

test('the first-entry route prints orchestrator work and the confirmation placeholder for a protected plan', (t) => {
    const repoRoot = workspace(t, ['src/app.ts', PROTECTED_FILE]);
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.equal(result.next_gate, 'enter-task-mode', result.reason);
    assert.match(result.reason, /attached task plan includes protected orchestrator files: AGENTS\.md/u);
    assert.match(result.reason, /fresh operator confirmation/u);
    assert.equal(result.commands.length, 1);
    const [command] = result.commands;
    assert.match(command.command, / --orchestrator-work /u);
    assert.doesNotMatch(command.command, /--workflow-config-work/u);
    assert.match(command.command, /--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"/u);
    // The confirmation is the operator's: the step is an operator boundary with no executable entry operation.
    const execution = readNextStepCommandExecution(command);
    assert.equal(execution?.boundary, 'operator');
    assert.equal(execution?.operation, null);
    assertOperatorBoundaryPrinted(result);
});

test('the first-entry route stays unchanged without a protected plan', (t) => {
    for (const scopeFiles of [null, ['src/app.ts']]) {
        const repoRoot = workspace(t, scopeFiles);
        const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
        assert.equal(result.next_gate, 'enter-task-mode', result.reason);
        assert.equal(result.title, 'Enter task mode first.');
        assert.doesNotMatch(result.commands[0].command, /--orchestrator-work|--operator-confirmed/u);
        // An agent-boundary entry command carries no operator-boundary line.
        assert.doesNotMatch(formatNextStepCompactText(result) + formatNextStepText(result), /^OperatorBoundary:/mu);
    }
});

test('the protected-plan entry command names workflow-config files with --workflow-config-work', (t) => {
    const repoRoot = workspace(t, null);
    const workflowConfig = 'garda-agent-orchestrator/live/config/workflow-config.json';
    const command = buildEnterTaskModeCommand(repoRoot, 'garda', TASK_ID, null, 'Codex', null, [], undefined,
        { protectedFiles: [PROTECTED_FILE, workflowConfig], workflowConfigFiles: [workflowConfig] });
    assert.match(command, new RegExp(`--orchestrator-work --planned-changed-file "${workflowConfig}" --workflow-config-work `, 'u'));
    assert.equal(command.match(/--operator-confirmed /gu)?.length, 1);
    assert.match(command, /--operator-confirmed-at-utc "<ISO-8601 timestamp>"/u);
});

test('plan scope entries are normalized like the planned-file flags before the protected check', (t) => {
    const repoRoot = workspace(t, null);
    const absolute = path.join(repoRoot, PROTECTED_FILE);
    for (const entry of ['src/../AGENTS.md', absolute, absolute.split(path.sep).join('/'), `.${path.sep}AGENTS.md`]) {
        assert.deepEqual(selectTaskPlanScopeProtection(repoRoot, [entry]).protectedFiles, [PROTECTED_FILE], entry);
    }
    assert.deepEqual(selectTaskPlanScopeProtection(repoRoot, ['docs/../src/gates/x.ts']).protectedFiles, ['src/gates/x.ts']);
    assert.deepEqual(selectTaskPlanScopeProtection(repoRoot, [`docs/../${WORKFLOW_CONFIG}`]).workflowConfigFiles, [WORKFLOW_CONFIG]);
    assert.throws(() => selectTaskPlanScopeProtection(repoRoot, ['../outside.md']),
        /scope_files must name paths inside the repo root/u);
});

test('plan directories and globs that can reach protected roots count as protected; ordinary ones do not', (t) => {
    const sourceRoot = workspace(t, null);
    for (const entry of ['src/gates', 'src', 'src/**', 'src/gat*', 'src/gates/**/*.ts', '**/AGENTS.md', '*.md', 'AGENTS.m?']) {
        assert.deepEqual(selectTaskPlanScopeProtection(sourceRoot, [entry]).protectedFiles, [entry], entry);
    }
    assert.deepEqual(selectTaskPlanScopeProtection(sourceRoot, ['docs', 'docs/**', 'tests/node/**/*.ts', 'README.md']).protectedFiles, []);
    const applicationRoot = workspace(t, null, false);
    assert.deepEqual(selectTaskPlanScopeProtection(applicationRoot, ['garda-agent-orchestrator', 'garda-agent-orchestrator/**']).protectedFiles,
        ['garda-agent-orchestrator', 'garda-agent-orchestrator/**']);
    assert.deepEqual(selectTaskPlanScopeProtection(applicationRoot,
        ['src', 'src/gates', 'src/**/*.ts', 'app/[id]/page.tsx', 'docs/guide.md']).protectedFiles, []);
});

test('a plan glob that can reach protected roots stops entry, and the navigator declares orchestrator work', (t) => {
    const repoRoot = workspace(t, ['src/app.ts', 'src/**']);
    assert.match(entryError(repoRoot).message, /Planned task scope includes protected orchestrator files: src\/\*\*\./u);
    assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`)), false);
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.equal(result.title, 'Enter task mode for protected orchestrator work after operator confirmation.', result.reason);
    assert.match(result.reason, /protected orchestrator files: src\/\*\*\./u);
    assert.match(result.commands[0].command, / --orchestrator-work /u);
});

test('the navigator names a protected file that the plan reaches through a non-canonical path', (t) => {
    const repoRoot = workspace(t, ['src/app.ts', 'src/../AGENTS.md']);
    // Entry already refuses a non-canonical scope entry while it captures the workspace baseline.
    assert.ok(entryError(repoRoot).message);
    assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`)), false);
    const result = resolveNextStep({ repoRoot, taskId: TASK_ID });
    assert.equal(result.title, 'Enter task mode for protected orchestrator work after operator confirmation.', result.reason);
    assert.match(result.reason, /protected orchestrator files: AGENTS\.md\./u);
});

test('a plan-only workflow-config file gets a suggested entry command that names it as a planned file', (t) => {
    const repoRoot = workspace(t, ['src/app.ts', WORKFLOW_CONFIG]);
    const error = entryError(repoRoot);
    assert.match(error.message, new RegExp(`Planned task scope includes workflow config files: ${escapeRegExp(WORKFLOW_CONFIG)}\\.`, 'u'));
    const suggested = /Suggested command: (.*)$/u.exec(error.message)?.[1] ?? '';
    assert.match(suggested, / --orchestrator-work /u);
    assert.match(suggested, / --workflow-config-work /u);
    assert.match(suggested, new RegExp(`--planned-changed-file ["']?${escapeRegExp(WORKFLOW_CONFIG)}["']?`, 'u'));
    // Following the suggestion passes the planned-scope checks; ownership and operator confirmation remain.
    const followed = entryError(repoRoot, { orchestratorWork: true, workflowConfigWork: true, plannedChangedFiles: [WORKFLOW_CONFIG] });
    assert.doesNotMatch(followed.message, /Planned task scope includes|requires the planned task scope to include/u);
    assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`)), false);
});
