import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectNextStepJson } from '../../../../src/gates/next-step/next-step-recommended-action';
import { readNextStepCommandExecution } from '../../../../src/gates/next-step/next-step-command-execution';
import { selectTaskCompositeAction } from '../../../../src/gates/next-step/next-step-composite-action';
import { assertCompactKeepsMandatoryNextStepLines } from '../../gates/next-step/next-step-compact-invariant';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import { splitCommandLine } from '../../../../src/core/command-line';
import { resolveCanonicalTaskPlanPath } from '../../../../src/core/task-plan-read';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { runGit } from './gate-test-helpers';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { formatNextStepCompactText } from '../../../../src/gates/next-step/next-step-command-formatters';
import {
    COMPACTION_CHECKPOINT_HINT,
    buildPlanBeforeCodeHint,
    selectNextStepHints
} from '../../../../src/gates/next-step/next-step-hints';
import { runTaskComposite } from '../../../../src/cli/commands/task-composite/task-composite-runner';
import { executeTaskCompositeOperation } from '../../../../src/cli/commands/task-composite/task-composite-actions';
import {
    OTHER_TASK_ID,
    PROVIDER_ARGS,
    TASK_ID,
    TASK_TITLE,
    cli,
    countEvents,
    createCompositeFixture,
    runPrintedCommand,
    timelineEvents,
    writeTaskEdit,
    type CompositeFixture
} from './task-composite-test-fixture';

let fixture: CompositeFixture;
const cloneWorkspace = (): string => fixture.clone();

function writeApprovedPlan(repoRoot: string, scopeFiles: string[]): void {
    const file = resolveCanonicalTaskPlanPath(repoRoot, TASK_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeTaskPlan(validateTaskPlan({
        schema_version: 1, task_id: TASK_ID, status: 'approved', goal: 'Update the agent entry rules',
        scope_files: scopeFiles, risk_level: 'low', steps: [{ id: 'one', title: 'Edit the rules' }],
        acceptance_criteria: ['Rules updated'], verification_expectations: ['Focused tests'], out_of_scope: ['Other tasks']
    })));
}

describe('task <id> start/advance composite runner', { concurrency: false }, () => {
    before(async () => { fixture = await createCompositeFixture(); });
    after(() => fixture.dispose());

    it('start enters task mode with explicit inputs and stops at the TASK_ENTRY rules to read', async () => {
        const repoRoot = cloneWorkspace();
        const fresh = resolveNextStep({ taskId: TASK_ID, repoRoot });
        // The fresh entry states the composite start with the printed provider as its one action.
        const stated = projectNextStepJson(fresh).recommended_action;
        assert.deepEqual([stated?.mode, stated?.kind], ['start', 'entry']);
        assert.match(stated?.command || '', new RegExp(`task "${TASK_ID}" start --provider `, 'u'));
        assertCompactKeepsMandatoryNextStepLines(fresh);
        const result = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS]);
        assert.equal(result.exitCode, 0, result.text);
        assert.match(result.text, /Outcome: STOPPED/u);
        assert.match(result.text, /1\. enter-task-mode: PASS/u);
        assert.match(result.text, /StopKind: agent/u);
        assert.match(result.text, /NextGate: load-rule-pack/u);
        assert.match(result.text, /--stage "TASK_ENTRY"/u);
        assert.deepEqual(timelineEvents(repoRoot).filter((entry) => /^(TASK_MODE_ENTERED|RULE_PACK_LOADED|HANDSHAKE)/u.test(entry)),
            ['TASK_MODE_ENTERED:PASS']);
        const taskMode = JSON.parse(fs.readFileSync(
            path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`), 'utf8')) as Record<string, unknown>;
        assert.equal(taskMode.provider, 'Codex');
        assert.equal(taskMode.task_summary, TASK_TITLE);
        // No plan is attached: the last step before code prints the plan hint, in the stop and in next-step text.
        const planHint = buildPlanBeforeCodeHint(`${DEFAULT_BUNDLE_NAME}/runtime/plans/${TASK_ID}.md`);
        assert.ok(result.text.split(/\r?\n/u).includes(planHint), result.text);
        const route = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.deepEqual(selectNextStepHints(route), [planHint]);
        assert.ok(formatNextStepCompactText(route).split('\n').includes(planHint));
        assert.doesNotMatch(JSON.stringify(route), /Hint:/u);
    });

    it('an attached JSON task plan suppresses the plan hint at the TASK_ENTRY rules', async () => {
        const repoRoot = cloneWorkspace();
        writeApprovedPlan(repoRoot, ['src/app.ts']);
        const result = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, '--as-json']);
        assert.equal(result.exitCode, 0, result.text);
        const parsed = JSON.parse(result.text) as { next: { next_gate: string; hints: string[] } };
        assert.equal(parsed.next.next_gate, 'load-rule-pack');
        assert.deepEqual(parsed.next.hints, []);
        assert.deepEqual(selectNextStepHints(resolveNextStep({ taskId: TASK_ID, repoRoot })), []);
    });

    it('start refuses without an explicit provider and writes nothing', async () => {
        const repoRoot = cloneWorkspace();
        const result = await cli(repoRoot, ['task', TASK_ID, 'start']);
        assert.notEqual(result.exitCode, 0);
        assert.match(result.text, /requires --provider/u);
        assert.deepEqual(timelineEvents(repoRoot), []);
    });

    it('advance never enters task mode', async () => {
        const repoRoot = cloneWorkspace();
        const result = await cli(repoRoot, ['task', TASK_ID, 'advance', '--as-json']);
        assert.equal(result.exitCode, 0, result.text);
        const parsed = JSON.parse(result.text) as {
            stop: { kind: string; reason: string }; completed: unknown[];
            next: { next_gate: string; warnings: string[]; operator_decision: string[] };
        };
        assert.equal(parsed.stop.kind, 'agent');
        assert.match(parsed.stop.reason, /task <id> start/u);
        assert.equal(parsed.next.next_gate, 'enter-task-mode');
        assert.deepEqual(parsed.next.warnings, resolveNextStep({ taskId: TASK_ID, repoRoot }).warnings);
        assert.deepEqual(parsed.next.operator_decision, []);
        assert.deepEqual(parsed.completed, []);
        assert.deepEqual(timelineEvents(repoRoot), []);
    });

    it('advance rejects custom-root flags before executing anything', async () => {
        for (const flag of ['--events-root', '--reviews-root']) {
            const repoRoot = cloneWorkspace();
            const result = await cli(repoRoot, ['task', TASK_ID, 'advance', flag, 'custom']);
            assert.notEqual(result.exitCode, 0);
            assert.ok(result.text.includes(flag));
            assert.deepEqual(timelineEvents(repoRoot), []);
        }
    });

    it('non-default navigator roots retain the single step and the original rerun line', async () => {
        const repoRoot = cloneWorkspace();
        assert.equal((await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
        await runPrintedCommand(repoRoot, 'load-rule-pack');
        const baseline = JSON.parse((await cli(repoRoot, ['next-step', TASK_ID, '--as-json'])).text);
        assert.equal(baseline.next_gate, 'handshake-diagnostics');
        assert.ok(baseline.recommended_action, 'the same default-root state must recommend advance');
        const defaultCompact = await cli(repoRoot, ['next-step', TASK_ID]);
        const defaultVerbose = await cli(repoRoot, ['next-step', TASK_ID, '--verbose']);
        assert.ok(defaultCompact.text.includes(baseline.recommended_action.command));
        assert.ok(defaultVerbose.text.includes(baseline.recommended_action.command));
        const runtime = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime');
        fs.cpSync(path.join(runtime, 'task-events'), path.join(runtime, 'custom-events'), { recursive: true });
        fs.cpSync(path.join(runtime, 'reviews'), path.join(runtime, 'custom-reviews'), { recursive: true });
        const events = ['--events-root', `${DEFAULT_BUNDLE_NAME}/runtime/custom-events`];
        const reviews = ['--reviews-root', `${DEFAULT_BUNDLE_NAME}/runtime/custom-reviews`];
        for (const { roots, options } of [
            { roots: events, options: { eventsRoot: path.join(runtime, 'custom-events') } },
            { roots: reviews, options: { reviewsRoot: path.join(runtime, 'custom-reviews') } },
            { roots: [...events, ...reviews], options: {
                eventsRoot: path.join(runtime, 'custom-events'), reviewsRoot: path.join(runtime, 'custom-reviews')
            } }
        ]) {
            const typed = resolveNextStep({ taskId: TASK_ID, repoRoot, ...options });
            assert.equal(selectTaskCompositeAction(typed, 'advance', null).kind, 'execute',
                'custom roots must preserve the typed mechanical operation, so only the root constraint can suppress advice');
            const args = ['next-step', TASK_ID, ...roots];
            const compact = await cli(repoRoot, args);
            const verbose = await cli(repoRoot, [...args, '--verbose']);
            const jsonOutput = await cli(repoRoot, [...args, '--as-json']);
            for (const output of [compact, verbose, jsonOutput]) assert.equal(output.exitCode, 0, output.text);
            const json = JSON.parse(jsonOutput.text);
            assert.deepEqual(json.commands, baseline.commands, 'custom roots must retain the eligible mechanical command');
            assert.equal(json.recommended_action, undefined);
            assert.doesNotMatch(compact.text + verbose.text, /Run mechanical steps|Single-step alternative:/u);
            assert.equal(json.navigator_command, baseline.navigator_command);
            for (const command of baseline.commands) {
                assert.ok(compact.text.includes(command.command));
                assert.ok(verbose.text.includes(command.command));
            }
        }
    });

    it('execute-effects keeps the original navigator bytes when both default roots are passed', async () => {
        const repoRoot = cloneWorkspace();
        assert.equal((await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
        await runPrintedCommand(repoRoot, 'load-rule-pack');
        writeTaskEdit(repoRoot);
        for (const gate of ['handshake-diagnostics', 'shell-smoke-preflight', 'classify-change']) await runPrintedCommand(repoRoot, gate);
        const effects = resolveNextStep({ repoRoot, taskId: TASK_ID });
        const operation = readNextStepCommandExecution(effects.commands[0])?.operation;
        assert.ok(operation?.operation_id === 'execute-next-step-effects');
        const output = await cli(repoRoot, ['gate', 'next-step', '--task-id', TASK_ID, '--execute-effects',
            '--effect-plan-sha256', operation.arguments.plan_sha256, '--events-root', `${DEFAULT_BUNDLE_NAME}/runtime/task-events`,
            '--reviews-root', `${DEFAULT_BUNDLE_NAME}/runtime/reviews`, '--as-json']);
        assert.equal(output.exitCode, 0, output.text);
        const result = JSON.parse(output.text);
        assert.equal(result.navigator_command, effects.navigator_command);
        assert.doesNotMatch(result.navigator_command, /--events-root|--reviews-root/u);
    });

    it('a stalled advance leaves fresh navigator answers at the single-step alternative', async () => {
        const repoRoot = cloneWorkspace();
        assert.equal((await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
        await runPrintedCommand(repoRoot, 'load-rule-pack');
        const run = await runTaskComposite({ repoRoot, taskId: TASK_ID, mode: 'advance', entryInputs: null,
            execute: async () => ({ passed: true, outputLines: [] }) });
        assert.equal(run.stop?.kind, 'repeated-state');
        const fresh = resolveNextStep({ repoRoot, taskId: TASK_ID });
        assert.equal(projectNextStepJson(fresh).recommended_action, undefined);
        for (const flags of [[], ['--verbose'], ['--as-json']]) {
            const answer = await cli(repoRoot, ['next-step', TASK_ID, ...flags]);
            assert.doesNotMatch(answer.text, /Run mechanical steps|Single-step alternative:|"recommended_action"/u);
            assert.ok(answer.text.includes('handshake-diagnostics'));
        }
        await runPrintedCommand(repoRoot, 'handshake-diagnostics');
        assert.ok(projectNextStepJson(resolveNextStep({ repoRoot, taskId: TASK_ID })).recommended_action);
    });

    it('an unscoped dirty workspace stops before entry; explicit planned scope enters', async () => {
        const repoRoot = cloneWorkspace();
        writeTaskEdit(repoRoot);
        const unscoped = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS]);
        assert.equal(unscoped.exitCode, 0, unscoped.text);
        assert.match(unscoped.text, /StopKind: agent/u);
        assert.match(unscoped.text, /already has 1 changed file\(s\) \(src\/app\.ts\)/u);
        assert.deepEqual(timelineEvents(repoRoot), []);
        const scoped = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, '--planned-changed-file', 'src/app.ts']);
        assert.equal(scoped.exitCode, 0, scoped.text);
        assert.match(scoped.text, /1\. enter-task-mode: PASS/u);
        assert.equal(countEvents(repoRoot, 'TASK_MODE_ENTERED'), 1);
    });

    it('an unapproved active owner is an operator boundary for start', async () => {
        const repoRoot = cloneWorkspace();
        const other = await cli(repoRoot, ['gate', 'enter-task-mode', '--task-id', OTHER_TASK_ID, '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
            '--requested-depth', '2', '--task-summary', 'Second composite fixture task', ...PROVIDER_ARGS, '--repo-root', '.']);
        assert.equal(other.exitCode, 0, other.text);
        const result = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS]);
        assert.equal(result.exitCode, 0, result.text);
        assert.match(result.text, /StopKind: operator/u);
        assert.match(result.text, new RegExp(`Unfinished tasks in this worktree: ${OTHER_TASK_ID}`, 'u'));
        assert.deepEqual(timelineEvents(repoRoot), []);
    });

    it('a protected attached plan is an operator boundary for start: no entry is attempted', async () => {
        for (const sourceCheckout of [true, false]) {
            const repoRoot = cloneWorkspace();
            if (sourceCheckout) {
                // A Garda source checkout lets agents declare orchestrator work after the operator confirms it.
                fs.writeFileSync(path.join(repoRoot, 'package.json'), `${JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2)}\n`);
                runGit(repoRoot, ['add', 'package.json']);
                runGit(repoRoot, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source checkout']);
            }
            writeApprovedPlan(repoRoot, ['src/app.ts', 'AGENTS.md']);
            const protectedEntry = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.equal(projectNextStepJson(protectedEntry).recommended_action, undefined);
            assertCompactKeepsMandatoryNextStepLines(protectedEntry);
            const result = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS]);
            assert.equal(result.exitCode, 0, result.text);
            assert.match(result.text, /Outcome: STOPPED/u);
            assert.match(result.text, /StopKind: operator/u);
            assert.match(result.text, sourceCheckout ? /NextGate: enter-task-mode/u : /NextGate: operator-maintenance/u);
            assert.doesNotMatch(result.text, /\d+\. enter-task-mode:/u, 'the composite never attempts the entry');
            assert.deepEqual(timelineEvents(repoRoot), []);
            assert.equal(fs.existsSync(path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`)), false);
        }
    });

    it('advance stops at unread rules, then runs startup gates and scaffolding effects in navigator order to the POST_PREFLIGHT rules', async () => {
        const repoRoot = cloneWorkspace();
        assert.equal((await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
        const before = timelineEvents(repoRoot);
        const atRules = await cli(repoRoot, ['task', TASK_ID, 'advance']);
        assert.match(atRules.text, /Completed: none/u);
        assert.match(atRules.text, /NextGate: load-rule-pack/u);
        assert.deepEqual(timelineEvents(repoRoot), before, 'advance must not record the rule reading itself');
        await runPrintedCommand(repoRoot, 'load-rule-pack');
        const next = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.ok(projectNextStepJson(next).recommended_action);
        assertCompactKeepsMandatoryNextStepLines(next);
        const compact = await cli(repoRoot, ['next-step', TASK_ID]);
        const verbose = await cli(repoRoot, ['next-step', TASK_ID, '--verbose']);
        const json = await cli(repoRoot, ['next-step', TASK_ID, '--as-json']);
        const recommendation = JSON.parse(json.text).recommended_action;
        assert.deepEqual(recommendation, projectNextStepJson(next).recommended_action);
        assert.ok(recommendation);
        assert.ok(compact.text.includes(recommendation.command));
        assert.ok(verbose.text.includes(recommendation.command));
        assert.match(verbose.text, /Single-step alternative:/u);
        writeTaskEdit(repoRoot);
        const rooted = await cli(repoRoot, ['next-step', TASK_ID, '--events-root', `${DEFAULT_BUNDLE_NAME}/runtime/task-events`,
            '--reviews-root', `${DEFAULT_BUNDLE_NAME}/runtime/reviews`, '--as-json']);
        const rootedRecommendation = JSON.parse(rooted.text).recommended_action;
        assert.ok(rootedRecommendation);
        assert.deepEqual(rootedRecommendation, recommendation);
        assert.doesNotMatch(rootedRecommendation.command, /--events-root|--reviews-root/u);
        const argv = splitCommandLine(rootedRecommendation.command);
        const advanced = await cli(repoRoot, [...argv.slice(argv.indexOf('task')), '--as-json']);
        assert.equal(advanced.exitCode, 0, advanced.text);
        const parsed = JSON.parse(advanced.text) as {
            outcome: string; completed: { gate: string }[]; stop: { kind: string };
            next: { next_gate: string; commands: { command: string }[]; hints: string[] };
            counters: Record<string, number>;
        };
        // Implementation is classified and compile has not run: the compaction checkpoint is printed once here.
        assert.deepEqual(parsed.next.hints, [COMPACTION_CHECKPOINT_HINT]);
        assert.ok(formatNextStepCompactText(resolveNextStep({ taskId: TASK_ID, repoRoot })).split('\n').includes(COMPACTION_CHECKPOINT_HINT));
        assert.equal(parsed.outcome, 'STOPPED');
        assert.deepEqual(parsed.completed.map((step) => step.gate),
            ['handshake-diagnostics', 'shell-smoke-preflight', 'classify-change', 'next-step-effect']);
        assert.equal(parsed.stop.kind, 'agent', JSON.stringify(parsed.stop));
        assert.equal(parsed.next.next_gate, 'load-rule-pack');
        assert.match(parsed.next.commands[0].command, /--stage "POST_PREFLIGHT"/u);
        assert.deepEqual(parsed.counters, {
            agent_invocations: 1, navigator_resolutions: 5, subgates_attempted: 4, subgates_succeeded: 4, effects_executed: 2
        });
    });

    it('a new empty or binary file is a real diff for the compaction checkpoint, although it has no changed lines', async () => {
        for (const [file, content] of [['src/empty.ts', ''], ['src/blob.bin', Buffer.from([0, 1, 2, 0, 255, 0, 7])]] as const) {
            const repoRoot = cloneWorkspace();
            assert.equal((await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
            await runPrintedCommand(repoRoot, 'load-rule-pack');
            fs.writeFileSync(path.join(repoRoot, file), content);
            const advanced = await cli(repoRoot, ['task', TASK_ID, 'advance', '--as-json']);
            assert.equal(advanced.exitCode, 0, advanced.text);
            const parsed = JSON.parse(advanced.text) as { next: { next_gate: string; hints: string[] } };
            const preflight = JSON.parse(fs.readFileSync(
                path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-preflight.json`), 'utf8'
            )) as { detection_source: string; changed_files: string[]; metrics: { changed_lines_total: number } };
            assert.deepEqual(preflight.changed_files, [file]);
            assert.equal(preflight.metrics.changed_lines_total, 0, file);
            assert.notEqual(preflight.detection_source, 'explicit_changed_files');
            assert.equal(parsed.next.next_gate, 'load-rule-pack', file);
            assert.deepEqual(parsed.next.hints, [COMPACTION_CHECKPOINT_HINT], file);
        }
    });

    it('composite startup records the same ordered gate events and preflight as individual commands', async () => {
        const individual = cloneWorkspace();
        await runPrintedCommand(individual, 'enter-task-mode', { '--provider': 'Codex', '--routed-to': 'AGENTS.md' });
        await runPrintedCommand(individual, 'load-rule-pack');
        writeTaskEdit(individual);
        await runPrintedCommand(individual, 'handshake-diagnostics');
        await runPrintedCommand(individual, 'shell-smoke-preflight');
        await runPrintedCommand(individual, 'classify-change');
        await runPrintedCommand(individual, 'next-step-effect');

        const composite = cloneWorkspace();
        assert.equal((await cli(composite, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
        await runPrintedCommand(composite, 'load-rule-pack');
        writeTaskEdit(composite);
        assert.equal((await cli(composite, ['task', TASK_ID, 'advance'])).exitCode, 0);

        assert.deepEqual(timelineEvents(composite), timelineEvents(individual));
        const readPreflight = (root: string) => JSON.parse(fs.readFileSync(
            path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-preflight.json`), 'utf8')) as Record<string, unknown>;
        const [left, right] = [readPreflight(individual), readPreflight(composite)];
        for (const key of ['changed_files', 'required_reviews', 'path_mode', 'detection_source']) {
            assert.deepEqual(right[key], left[key], key);
        }
        const scaffoldRoot = (root: string) => path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'tmp');
        const scaffolds = (root: string) => fs.readdirSync(scaffoldRoot(root))
            .filter((name) => name.startsWith(`${TASK_ID}-quality-checklist`)).sort();
        for (const name of [`${TASK_ID}-quality-checklist-answers.json`, `${TASK_ID}-quality-checklist-questions.md`]) {
            assert.ok(scaffolds(individual).includes(name), name);
        }
        assert.deepEqual(scaffolds(composite), scaffolds(individual));
        const questions = (root: string) => fs.readFileSync(path.join(scaffoldRoot(root), `${TASK_ID}-quality-checklist-questions.md`), 'utf8');
        assert.equal(questions(composite), questions(individual));
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot: composite }).next_gate,
            resolveNextStep({ taskId: TASK_ID, repoRoot: individual }).next_gate);
    });

    it('a failing sub-gate stops with its name and prefix; resume continues from persisted evidence without duplicates', async () => {
        const repoRoot = cloneWorkspace();
        assert.equal((await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
        await runPrintedCommand(repoRoot, 'load-rule-pack');
        writeTaskEdit(repoRoot);
        const failed = await runTaskComposite({
            taskId: TASK_ID, repoRoot, mode: 'advance', entryInputs: null,
            execute: async (operation, context) => operation.operation_id === 'shell-smoke-preflight'
                ? { passed: false, outputLines: ['SHELL_SMOKE_PREFLIGHT_FAILED'] }
                : executeTaskCompositeOperation(operation, context)
        });
        assert.equal(failed.outcome, 'FAILED');
        assert.equal(failed.failed?.gate, 'shell-smoke-preflight');
        assert.deepEqual(failed.completed.map((step) => step.gate), ['handshake-diagnostics']);
        assert.equal(countEvents(repoRoot, 'SHELL_SMOKE_PREFLIGHT_RECORDED'), 0);
        assert.equal(countEvents(repoRoot, 'PREFLIGHT_CLASSIFIED'), 0, 'no downstream write after the failure');

        const resumed = await cli(repoRoot, ['task', TASK_ID, 'advance', '--as-json']);
        const parsed = JSON.parse(resumed.text) as { completed: { gate: string }[] };
        assert.deepEqual(parsed.completed.map((step) => step.gate), ['shell-smoke-preflight', 'classify-change', 'next-step-effect']);
        assert.equal(countEvents(repoRoot, 'HANDSHAKE_DIAGNOSTICS_RECORDED'), 1);
        assert.equal(countEvents(repoRoot, 'SHELL_SMOKE_PREFLIGHT_RECORDED'), 1);
        assert.equal(countEvents(repoRoot, 'PREFLIGHT_CLASSIFIED'), 1);

        const events = timelineEvents(repoRoot);
        const repeated = await cli(repoRoot, ['task', TASK_ID, 'advance', '--as-json']);
        assert.deepEqual((JSON.parse(repeated.text) as { completed: unknown[] }).completed, []);
        const restarted = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS]);
        assert.match(restarted.text, /Completed: none/u);
        assert.deepEqual(timelineEvents(repoRoot), events, 'repeating start or advance adds no transition');
        assert.equal(countEvents(repoRoot, 'TASK_MODE_ENTERED'), 1);
    });

    it('next-step stays inspection-only and its output carries no execution descriptor', async () => {
        const repoRoot = cloneWorkspace();
        assert.equal((await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS])).exitCode, 0);
        await runPrintedCommand(repoRoot, 'load-rule-pack');
        const events = timelineEvents(repoRoot);
        const inspected = await cli(repoRoot, ['next-step', TASK_ID, '--as-json', '--repo-root', '.']);
        assert.equal(inspected.exitCode, 0, inspected.text);
        const parsed = JSON.parse(inspected.text) as { next_gate: string; commands: Record<string, unknown>[] };
        assert.equal(parsed.next_gate, 'handshake-diagnostics');
        assert.deepEqual(Object.keys(parsed.commands[0]).sort(), ['command', 'label']);
        assert.deepEqual(timelineEvents(repoRoot), events);
    });
});
