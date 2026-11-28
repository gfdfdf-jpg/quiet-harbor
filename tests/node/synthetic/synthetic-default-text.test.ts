import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import { getProviderRuntimeEnvironmentKeys } from '../../../src/core/provider-registry';
import { resolveNextStep, type NextStepResult } from '../../../src/gates/next-step';
import { COMPACTION_CHECKPOINT_HINT, buildPlanBeforeCodeHint } from '../../../src/gates/next-step/next-step-hints';
import {
    TASK_ID,
    cli,
    createCompositeFixture,
    writeTaskEdit,
    type CompositeFixture
} from '../cli/commands/task-composite-test-fixture';
import { buildResult } from '../gates/next-step/next-step-presentation-fixture';
import { assertNavigationInvariants } from './engine/walk-navigation-invariants';
import { splitCommandLine } from '../../../src/core/command-line';
import { runGit } from '../cli/commands/gate-test-helpers';
import {
    assertEachCommandPrintedOnce,
    assertMemoryAdviceMatchesArgv,
    requireSingleActionFooter,
    run,
    cliArgs,
    walkOrdinaryTask,
    offeredCommand,
    printedArgv,
    readDefaultText,
    runPrinted,
    type ParsedNavigatorText
} from './engine/default-text-consumer';

// Backfill group 1 (stand audit 2026-11-22): the DEFAULT navigator text is judged the way an agent consumes it. Real
// stdout is captured at each boundary, only agent-owned values are filled, and the printed argv runs verbatim. The
// general text-driven walk and the executable default text while blocked belong to the parallel lanes A and B; these
// cases are the smallest consumer the boundary assertions need.

let fixturePromise: Promise<CompositeFixture> | null = null;
const workspace = async (): Promise<string> => (await (fixturePromise ??= createCompositeFixture())).clone();
after(async () => { if (fixturePromise) (await fixturePromise).dispose(); });

const PLAN_PATH = `${DEFAULT_BUNDLE_NAME}/runtime/plans/${TASK_ID}.md`;

async function withProviderEnv<T>(env: Record<string, string>, action: () => Promise<T>): Promise<T> {
    const keys = [...getProviderRuntimeEnvironmentKeys()];
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, env);
    try { return await action(); } finally {
        for (const key of keys) {
            const value = saved.get(key);
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

function enteredProvider(root: string): string {
    const taskMode = JSON.parse(fs.readFileSync(path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`), 'utf8')) as { provider: string };
    return taskMode.provider;
}

function providerToken(parsed: ParsedNavigatorText): string {
    const argv = offeredCommand(parsed).argv;
    return argv[argv.indexOf('--provider') + 1];
}

interface ProviderCase { name: string; env: Record<string, string>; printed: string | 'placeholder'; agent: string }
const GLOBAL_CODEX_HOME = path.join(path.sep, 'users', 'operator', '.codex');
const PROVIDER_CASES: ProviderCase[] = [
    { name: 'Claude session with a global CODEX_HOME', env: { CLAUDECODE: '1', CODEX_HOME: GLOBAL_CODEX_HOME }, printed: 'Claude', agent: 'Claude' },
    { name: 'genuine Codex session', env: { CODEX_THREAD_ID: 'thread-1', CODEX_HOME: GLOBAL_CODEX_HOME }, printed: 'Codex', agent: 'Codex' },
    { name: 'session markers of two providers', env: { CLAUDECODE: '1', CODEX_THREAD_ID: 'thread-1' }, printed: 'placeholder', agent: 'Codex' },
    { name: 'no session marker, only a global CODEX_HOME', env: { CODEX_HOME: GLOBAL_CODEX_HOME }, printed: 'placeholder', agent: 'Claude' },
    { name: 'explicit override beats every session marker', env: { GARDA_EXECUTION_PROVIDER: 'Claude', CODEX_THREAD_ID: 'thread-1' }, printed: 'Claude', agent: 'Claude' }
];

test('first entry names the provider only from session markers: the printed command is correct or a fillable placeholder, and it runs verbatim', async () => {
    for (const scenario of PROVIDER_CASES) {
        const root = await workspace();
        await withProviderEnv(scenario.env, async () => {
            const parsed = await readDefaultText(root, TASK_ID);
            assert.equal(parsed.nextGate, 'enter-task-mode', scenario.name);
            const printed = providerToken(parsed);
            if (scenario.printed === 'placeholder') {
                assert.match(printed, /^\$(?:env:)?GARDA_EXECUTION_PROVIDER$/u, `${scenario.name}: the provider is left for the agent to name`);
                assert.match(parsed.reason, /execution provider|provider you run in/iu, scenario.name);
            } else {
                assert.equal(printed, scenario.printed, `${scenario.name}: ${parsed.raw}`);
            }
            const result = await runPrinted(root, offeredCommand(parsed), { [printed]: scenario.agent });
            assert.equal(result.exitCode, 0, `${scenario.name}:\n${result.text}`);
            assert.equal(enteredProvider(root), scenario.printed === 'placeholder' ? scenario.agent : scenario.printed, scenario.name);
        });
    }
});

interface BoundaryExpectation {
    gate: string; primary: string | null; commands: number; repoWork: boolean; planHint: boolean; compactionHint: boolean;
}

function assertBoundaryText(parsed: ParsedNavigatorText, expected: BoundaryExpectation): void {
    const context = `${expected.gate}\n${parsed.raw}`;
    assert.equal(parsed.nextGate, expected.gate, context);
    assert.equal(parsed.primary?.label ?? null, expected.primary, context);
    assert.equal(parsed.commands.length, expected.commands, context);
    assert.equal(parsed.headingAlternatives, expected.commands > 1, context);
    assert.equal(parsed.commandsNone, !expected.primary && expected.commands === 0, context);
    assertEachCommandPrintedOnce(parsed);
    // The compact CLI pointer and the task-start guidance appear only where the agent works on the repository itself.
    assert.equal(/^Compact: /mu.test(parsed.raw), expected.repoWork, context);
    if (!expected.repoWork) assert.doesNotMatch(parsed.raw, /^TaskStart(?:SkillCatalog|ReviewSuggestion|ReviewPolicy): /mu, context);
    assert.equal(parsed.hints.includes(buildPlanBeforeCodeHint(PLAN_PATH)), expected.planHint, context);
    assert.equal(parsed.hints.includes(COMPACTION_CHECKPOINT_HINT), expected.compactionHint, context);
    if (expected.commands === 0 && !expected.primary) assert.match(parsed.raw, /^Instruction: /mu, `A step without a command keeps its Instruction line\n${context}`);
}

test('default text at the startup boundaries states one action, prints each command once, scopes its guidance to the step, and every printed command runs verbatim', async () => {
    const root = await workspace();
    await withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, async () => {
        const entry = await readDefaultText(root, TASK_ID);
        assertBoundaryText(entry, { gate: 'enter-task-mode', primary: 'Start the task', commands: 0, repoWork: false, planHint: false, compactionHint: false });
        assert.equal((await runPrinted(root, offeredCommand(entry))).exitCode, 0);

        // TASK_ENTRY rules: the plan hint names the plan path the navigator reads; it is a repository-work step.
        const rules = await readDefaultText(root, TASK_ID);
        assertBoundaryText(rules, { gate: 'load-rule-pack', primary: null, commands: 1, repoWork: true, planHint: true, compactionHint: false });
        assert.equal((await runPrinted(root, offeredCommand(rules))).exitCode, 0);

        writeTaskEdit(root);
        const mechanical = await readDefaultText(root, TASK_ID);
        assertBoundaryText(mechanical, { gate: 'handshake-diagnostics', primary: 'Run mechanical steps', commands: 0, repoWork: false, planHint: false, compactionHint: false });
        const advance = await runPrinted(root, offeredCommand(mechanical));
        assert.equal(advance.exitCode, 0, advance.text);

        // POST_PREFLIGHT rules after a real diff: the repeat-safe compaction hint, but no plan hint and no repository pointer.
        const postPreflight = await readDefaultText(root, TASK_ID);
        assertBoundaryText(postPreflight, { gate: 'load-rule-pack', primary: null, commands: 1, repoWork: false, planHint: false, compactionHint: true });
        assert.equal((await runPrinted(root, offeredCommand(postPreflight))).exitCode, 0);

        // A step without a command: the agent works in the repository, so the pointer and the Instruction line are printed.
        const checklist = await readDefaultText(root, TASK_ID);
        assertBoundaryText(checklist, { gate: 'quality-checklist', primary: null, commands: 0, repoWork: true, planHint: false, compactionHint: false });
    });
});

test('a new empty file is a real diff: the compaction checkpoint hint is printed after its classification, a planned-only start prints none', async () => {
    const root = await workspace();
    await withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, async () => {
        assert.equal((await runPrinted(root, offeredCommand(await readDefaultText(root, TASK_ID)))).exitCode, 0);
        assert.equal((await runPrinted(root, offeredCommand(await readDefaultText(root, TASK_ID)))).exitCode, 0);
        const beforeEdit = await readDefaultText(root, TASK_ID);
        assert.ok(!beforeEdit.hints.includes(COMPACTION_CHECKPOINT_HINT), 'no diff exists yet');
        fs.writeFileSync(path.join(root, 'src', 'empty.ts'), '', 'utf8');
        const advance = await runPrinted(root, offeredCommand(await readDefaultText(root, TASK_ID)));
        assert.equal(advance.exitCode, 0, advance.text);
        const afterClassify = await readDefaultText(root, TASK_ID);
        assert.equal(afterClassify.nextGate, 'load-rule-pack', afterClassify.raw);
        assert.ok(afterClassify.hints.includes(COMPACTION_CHECKPOINT_HINT), `An empty new file has no changed lines but is a diff:\n${afterClassify.raw}`);
    });
});

test('classify-change prints a short summary that names its preflight artifact; the full JSON stays behind --as-json', async () => {
    const root = await workspace();
    await withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, async () => {
        assert.equal((await runPrinted(root, offeredCommand(await readDefaultText(root, TASK_ID)))).exitCode, 0);
        assert.equal((await runPrinted(root, offeredCommand(await readDefaultText(root, TASK_ID)))).exitCode, 0);
        writeTaskEdit(root);
        // The individual gates the composite runs internally: take each from the navigator's own printed single-step command.
        for (const gate of ['handshake-diagnostics', 'shell-smoke-preflight']) {
            const next = resolveNextStep({ taskId: TASK_ID, repoRoot: root });
            assert.equal(next.next_gate, gate, next.reason);
            assert.equal((await cli(root, printedArgv(next.commands[0].command))).exitCode, 0);
        }
        const classify = resolveNextStep({ taskId: TASK_ID, repoRoot: root });
        assert.equal(classify.next_gate, 'classify-change', classify.reason);
        const summary = await cli(root, printedArgv(classify.commands[0].command));
        assert.equal(summary.exitCode, 0, summary.text);
        const preflightPath = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-preflight.json`);
        const artifact = fs.readFileSync(preflightPath, 'utf8');
        assert.match(summary.text, /^CLASSIFY_CHANGE_PASSED$/mu);
        assert.match(summary.text, /^PreflightPath: .*T-COMPOSITE-1-preflight\.json$/mu);
        assert.match(summary.text, /^PreflightSha256: [0-9a-f]{64}$/mu);
        assert.doesNotMatch(summary.text, /"changed_files"|"triggers"|"metrics"/u, 'the summary does not echo the JSON');
        assert.ok(artifact.length > summary.text.length * 2, `The summary (${summary.text.length}) replaces a much larger artifact (${artifact.length})`);
        const full = await cli(root, [...printedArgv(classify.commands[0].command), '--as-json']);
        assert.equal(full.exitCode, 0, full.text);
        assert.deepEqual(JSON.parse(full.text), JSON.parse(fs.readFileSync(preflightPath, 'utf8')), '--as-json prints the published preflight');
    });
});

test('walk navigation invariants refuse a shared test command before the task selected its tests and repeated alternatives', () => {
    const base = buildResult();
    const suiteWith = (patch: Record<string, unknown>) => ({ ...base.full_suite_validation, ...patch }) as NextStepResult['full_suite_validation'];
    const unselected = buildResult({ full_suite_validation: suiteWith({ config_source: 'project_command_reference',
        command: '', performance_guidance_note: null, timeout_forecast_note: null, recommended_timeout_seconds: null }) });
    assertNavigationInvariants(unselected);
    assertNavigationInvariants(base);
    for (const leaked of [{ command: 'node scripts/run-tests.cjs tests/other-task-only.test.ts' }, { performance_guidance_note: 'mode=optimized_sharded' },
        { timeout_forecast_note: 'forecast from another task' }, { recommended_timeout_seconds: 900 }]) {
        assert.throws(() => assertNavigationInvariants({ ...unselected, full_suite_validation: { ...unselected.full_suite_validation, ...leaked } as NextStepResult['full_suite_validation'] }), /No shared test command|command-derived/u);
    }
    assert.throws(() => assertNavigationInvariants({ ...unselected, reason: 'Select tests; reference to narrow from: node other.js' }), /reference command/u);
    const command = base.commands[0];
    assert.throws(() => assertNavigationInvariants({ ...base, commands: [command, { ...command, label: 'Same command again' }] }), /distinct commands/u);
});

test('a covered boundary requires one actual next-action footer', () => {
    const action = 'node garda-agent-orchestrator/bin/garda.js gate handshake-diagnostics --task-id "T"';
    requireSingleActionFooter('NextGate: handshake-diagnostics\nNext action: ' + action + '\n');
    assert.throws(() => requireSingleActionFooter('Commands:\n  Run: ' + action + '\n'), /Expected one executable/u);
    assert.throws(() => requireSingleActionFooter('Commands:\n  Run: ' + action + '\nNext action: ' + action + '\n'), /must appear once/u);
});

test('project-memory advice that disagrees with its printed argv is refused by the text property', () => {
    const base = 'node garda-agent-orchestrator/bin/garda.js gate project-memory-impact --task-id "T" --mode "x" --preflight-path "p.json" --confirm-updated';
    const skipped = ' --skipped-memory-file "docs/project-memory/architecture.md" --repo-root "."';
    const hint = 'No candidate memory file is edited. The command records a review without edits: --confirm-updated confirms the review evidence.';
    const good = `Next: x\nProjectMemory: y\nHint: ${hint}\nCommands:\n  Confirm: ${base}${skipped}\n`;
    assert.equal(assertMemoryAdviceMatchesArgv(good), true);
    // Old behavior: the review-without-edits command described as an update.
    assert.throws(() => assertMemoryAdviceMatchesArgv(good.replace(hint, 'The command updates the memory files.')), /disagree|without edits/u);
    // A command that lists an updated file cannot be described as a review without edits.
    assert.throws(() => assertMemoryAdviceMatchesArgv(good.replace(skipped, ' --updated-memory-file "docs/project-memory/architecture.md" --repo-root "."')), /disagree/u);
    assert.throws(() => assertMemoryAdviceMatchesArgv(good.replace('Hint:', 'Hint: docs/project-memory/other.md:3 (x) ')), /candidate the command lists/u);
    assert.equal(assertMemoryAdviceMatchesArgv('Commands:\n  Run: node garda-agent-orchestrator/bin/garda.js gate compile-gate --task-id "T"\n'), false);
});

test('the printed closeout runs: memory advice matches its argv, staging names exactly the task files and the commit command commits only them', async () => {
    const root = await workspace();
    await withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, async () => {
        const memoryTexts: string[] = [];
        await run(root, ['workflow', 'set', '--project-memory-enabled', 'true', '--project-memory-mode', 'strict',
            '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(), '--target-root', '.']);
        const done = await walkOrdinaryTask(root, true, true,
            { docsPath: 'README.md', onText: text => { if (assertMemoryAdviceMatchesArgv(text)) memoryTexts.push(text); } });
        assert.equal(done.outcome, 'DONE', done.output);
        assert.ok(memoryTexts.length, 'The walk executed a project-memory confirmation with candidate advice.');
        const order = [...done.output.matchAll(/^ {2}\d+\. (.+)$/gmu)].map(match => match[1]);
        const staging = order.find(entry => entry.startsWith('git add -- '));
        const commit = order.find(entry => entry.includes('gate human-commit'));
        assert.ok(staging, `The final report states the staging step:\n${done.output}`);
        assert.ok(commit, `The final report states the commit command:\n${done.output}`);
        const preflight = JSON.parse(fs.readFileSync(path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-preflight.json`), 'utf8')) as { changed_files: string[] };
        const staged = splitCommandLine(staging).slice(3);
        assert.deepEqual([...staged].sort(), [...preflight.changed_files].sort(), 'staging names exactly the task changed files');
        // Runtime output and TASK.md bookkeeping exist beside the task files: the stated step stages none of them.
        assert.equal(runGit(root, ['add', '--', ...staged]).status, 0);
        const cached = runGit(root, ['diff', '--cached', '--name-only']).stdout.split(/\r?\n/u).filter(Boolean).sort();
        assert.deepEqual(cached, [...staged].sort(), 'only the stated paths are staged');
        // The operator's confirmation time is the one placeholder the modeled operator fills in.
        const committed = await cli(root, cliArgs(commit).map(arg => /^<ISO-8601[^>]*>$/u.test(arg) ? new Date().toISOString() : arg));
        assert.equal(committed.exitCode, 0, `${commit}\n${committed.text}`);
        const files = runGit(root, ['show', '--name-only', '--format=', 'HEAD']).stdout.split(/\r?\n/u).filter(Boolean).sort();
        assert.deepEqual(files, [...staged].sort(), 'the commit holds exactly the staged task files');
        assert.ok(!files.includes('TASK.md') && !files.some(file => file.includes('/runtime/')), 'no bookkeeping or runtime output is committed');
    });
});

test('a Git observation failure is refused on stdout with its failing command and a task-bound retry, writes nothing, and the retry proceeds once Git is readable', async () => {
    const root = await workspace();
    await withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, async () => {
        assert.equal((await runPrinted(root, offeredCommand(await readDefaultText(root, TASK_ID)))).exitCode, 0);
        assert.equal((await runPrinted(root, offeredCommand(await readDefaultText(root, TASK_ID)))).exitCode, 0);
        writeTaskEdit(root);
        assert.equal((await runPrinted(root, offeredCommand(await readDefaultText(root, TASK_ID)))).exitCode, 0);
        const timeline = path.join(root, DEFAULT_BUNDLE_NAME, 'runtime', 'task-events', `${TASK_ID}.jsonl`);
        const indexPath = path.join(root, '.git', 'index');
        const indexBefore = fs.readFileSync(indexPath);
        const evidenceBefore = fs.readFileSync(timeline);
        fs.writeFileSync(indexPath, 'Invalid disposable Git index.');
        const refused = await readDefaultText(root, TASK_ID);
        assert.equal(refused.nextGate, 'git-observation', refused.raw);
        assert.match(refused.reason, /git .*failed/u, 'the refusal names the failing Git command');
        assert.match(refused.reason, /Workspace authority and planned effects were not accepted/u);
        // The retry is stated on stdout, executable verbatim and bound to this task.
        const retry = offeredCommand(refused);
        assert.ok(retry.argv.includes(TASK_ID), `The retry names the task: ${retry.text}`);
        // The composite runner refuses as well and neither writes task evidence.
        const advance = await cli(root, ['task', TASK_ID, 'advance']);
        assert.doesNotMatch(advance.text, /Outcome: STOPPED[\s\S]*NextGate: (?!git-observation)/u);
        assert.deepEqual(fs.readFileSync(timeline), evidenceBefore, 'no task evidence is written while Git is unreadable');
        assert.deepEqual(fs.readFileSync(indexPath), Buffer.from('Invalid disposable Git index.'), 'the Git index is never rewritten by the refusal');
        fs.writeFileSync(indexPath, indexBefore);
        const stillRefused = await runPrinted(root, retry);
        assert.equal(stillRefused.exitCode, 0, stillRefused.text);
        const proceeded = await readDefaultText(root, TASK_ID);
        assert.notEqual(proceeded.nextGate, 'git-observation', 'the retry proceeds once Git is readable');
    });
});
