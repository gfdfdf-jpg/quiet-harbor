import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsNative from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { NextStepResult } from '../../../../src/gates/next-step';
import { attachNextStepCommandExecution, type NextStepCommandOperation } from '../../../../src/gates/next-step/next-step-command-execution';
import { selectTaskCompositeAction } from '../../../../src/gates/next-step/next-step-composite-action';
import { projectNextStepJson, selectNextStepRecommendedAction } from '../../../../src/gates/next-step/next-step-recommended-action';
import { formatNextStepCompactText, formatNextStepText } from '../../../../src/gates/next-step/next-step-command-formatters';
import { runTaskComposite, TASK_COMPOSITE_MAX_SUBGATES } from '../../../../src/cli/commands/task-composite/task-composite-runner';
import { attachNextStepCompositeRecommendationContext, taskCompositeExecutableStateKey } from '../../../../src/gates/next-step/next-step-composite-recommendation-context';
import { joinOrchestratorPath } from '../../../../src/core/orchestrator-paths';
import { formatTaskCompositeText } from '../../../../src/cli/commands/task-composite/task-composite-command';
import { assertCompactKeepsMandatoryNextStepLines } from './next-step-compact-invariant';
import { buildResult, buildReviewCycleBlock } from './next-step-presentation-fixture';
import { attachNextStepHints, COMPACTION_CHECKPOINT_HINT } from '../../../../src/gates/next-step/next-step-hints';

const TASK_ID = 'T-TEXT-1';
const operation: NextStepCommandOperation = { operation_id: 'handshake-diagnostics', arguments: { task_id: TASK_ID } };
const commandText = `node bin/garda.js gate handshake-diagnostics --task-id "${TASK_ID}" --repo-root "."`;
const mechanical = (op: NextStepCommandOperation = operation) => attachNextStepCommandExecution(
    { label: 'Run handshake diagnostics', command: commandText }, 'mechanical', op);
const entry: NextStepCommandOperation = { operation_id: 'enter-task-mode', arguments: {
    task_id: TASK_ID, entry_mode: 'EXPLICIT_TASK_EXECUTION', requested_depth: '2', task_summary: 'Summary'
} };
const effects = (effect_kinds: string[]): NextStepCommandOperation => ({ operation_id: 'execute-next-step-effects',
    arguments: { task_id: TASK_ID, plan_sha256: 'a'.repeat(64), effect_kinds } });

const rewritten = mechanical();
rewritten.command += ' --rewritten';
const cases: Array<[string, Partial<NextStepResult>, boolean]> = [
    ['mechanical', { commands: [mechanical()] }, true],
    ['default allowed effect', { commands: [mechanical(effects(['materialize-quality-checklist-answers']))] }, true],
    ['mixed effects', { commands: [mechanical(effects(['materialize-quality-checklist-answers', 'unknown']))] }, false],
    ['empty effects', { commands: [mechanical(effects([]))] }, false],
    ['operator', { commands: [attachNextStepCommandExecution({ label: 'Approve', command: 'approve' }, 'operator')] }, false],
    ['agent with operation', { commands: [attachNextStepCommandExecution({ label: 'Choose', command: 'choose' }, 'agent', operation)] }, false],
    ['unclassified', { commands: [{ label: 'Run', command: commandText }] }, false],
    ['nonblocked status', { status: 'READY', commands: [mechanical()] }, false],
    ['terminal descriptor', { commands: [attachNextStepCommandExecution({ label: 'End', command: 'end' }, 'terminal')] }, false],
    ['mechanical without operation', { commands: [attachNextStepCommandExecution({ label: 'Run', command: commandText }, 'mechanical')] }, false],
    ['split', { status: 'SPLIT_REQUIRED', commands: [mechanical()] }, false],
    ['decomposed', { status: 'DECOMPOSED', commands: [mechanical()] }, false],
    ['terminal', { status: 'DONE', commands: [] }, false],
    ['terminal with command', { status: 'DONE', commands: [mechanical()] }, false],
    ['zero commands', { commands: [] }, false],
    ['several commands', { commands: [mechanical(), mechanical()] }, false],
    ['copied descriptor lost', { commands: [{ ...mechanical() }] }, false],
    ['rewritten descriptor lost', { commands: [rewritten] }, false],
    ['ordinary fresh entry', { next_gate: 'enter-task-mode', commands: [attachNextStepCommandExecution(
        { label: 'Enter', command: 'enter --provider Codex --planned-changed-file src/a.ts' }, 'agent', entry)] }, false],
    ['protected fresh entry', { next_gate: 'enter-task-mode', commands: [attachNextStepCommandExecution(
        { label: 'Protected entry', command: 'enter --orchestrator-work --operator-confirmed yes' }, 'operator', entry)] }, false],
];

for (const [name, overrides, eligible] of cases) {
    test(`recommendation, all presentations and runner first decision agree: ${name}`, async () => {
        const result = buildResult(overrides);
        const recommendation = selectNextStepRecommendedAction(result);
        assert.equal(selectTaskCompositeAction(result, 'advance', null).kind === 'execute', eligible);
        assert.equal(Boolean(recommendation), eligible);
        const compact = formatNextStepCompactText(result);
        const verbose = formatNextStepText(result);
        const json = projectNextStepJson(result);
        assert.equal(compact.includes('Run mechanical steps:'), eligible);
        assert.equal(verbose.includes('Single-step alternative:'), eligible);
        assert.deepEqual(json.recommended_action, recommendation ?? undefined);
        const { recommended_action: _displayOnly, ...existing } = json;
        assert.deepEqual(existing, result, 'every existing field, including commands, is unchanged');
        assert.doesNotMatch(JSON.stringify(json), /"(?:operation_id|effect_kinds|rendered_command|boundary)":/u);
        assertCompactKeepsMandatoryNextStepLines(result);
        if (recommendation) {
            assert.ok(verbose.indexOf(recommendation.command) < verbose.indexOf('Single-step alternative:'));
            for (const command of result.commands) {
                assert.equal(verbose.split(command.command).length - 1, 1);
                assert.ok(!compact.includes(command.command));
            }
        }
        let resolutions = 0;
        const executed: NextStepCommandOperation[] = [];
        const run = await runTaskComposite({ taskId: TASK_ID, repoRoot: '.', mode: 'advance', entryInputs: null,
            resolve: () => resolutions++ === 0 ? result : buildResult({ status: 'DONE', commands: [] }),
            execute: async (selected) => { executed.push(selected); return { passed: true, outputLines: [] }; } });
        assert.equal(executed.length, eligible ? 1 : 0, 'the first runner decision must match the recommendation');
        if (!eligible) {
            assert.equal(run.counters.subgates_attempted, 0);
            // Reinspect the same state after a zero-execution stop: it cannot recommend another empty advance.
            assert.equal(selectNextStepRecommendedAction(result), null);
            assert.equal(projectNextStepJson(result).recommended_action, undefined);
            assert.match(formatTaskCompositeText(run), /Instruction: rerun the Navigator below for the full instruction and artifact lines/u);
        }
    });
}

test('compact eligible real gate invocations never grow and preserve warnings, hints and navigation', () => {
    const operations: NextStepCommandOperation[] = [operation,
        { operation_id: 'shell-smoke-preflight', arguments: { task_id: TASK_ID } },
        { operation_id: 'compile-gate', arguments: { task_id: TASK_ID, preflight_path: 'reviews/preflight.json', task_mode_path: null } }
    ];
    for (const op of operations) {
        const command = attachNextStepCommandExecution({ label: `Run ${op.operation_id}`,
            command: `node bin/garda.js gate ${op.operation_id} --task-id "${TASK_ID}" --repo-root "."` }, 'mechanical', op);
        const result = buildResult({ commands: [command], warnings: ['Keep this warning.'] });
        // Losing only the descriptor produces the old compact presentation for exactly the same state.
        const previous = formatNextStepCompactText({ ...result, commands: [{ ...command }] });
        const compact = formatNextStepCompactText(result);
        assert.ok(compact.length <= previous.length, `${op.operation_id}: ${compact.length} > ${previous.length}`);
        assert.ok(compact.split('\n').length <= previous.split('\n').length);
        assertCompactKeepsMandatoryNextStepLines(result);
    }
});

test('an unsupported navigator invocation falls back to the single-step command without throwing', () => {
    const result = buildResult({ commands: [mechanical()], navigator_command: 'unsupported invocation' });
    assert.equal(selectNextStepRecommendedAction(result), null);
    assert.equal(projectNextStepJson(result).recommended_action, undefined);
    assert.ok(formatNextStepCompactText(result).includes(commandText));
    assert.ok(formatNextStepText(result).includes(commandText));
});

test('non-default resolution roots suppress advice without changing JSON or the single step', () => {
    const result = buildResult({ commands: [mechanical()] });
    const before = JSON.stringify(result);
    attachNextStepCompositeRecommendationContext(result, '.', false);
    assert.equal(selectNextStepRecommendedAction(result), null);
    assert.equal(projectNextStepJson(result).recommended_action, undefined);
    assert.ok(formatNextStepCompactText(result).includes(commandText));
    assert.ok(formatNextStepText(result).includes(commandText));
    assert.equal(JSON.stringify(projectNextStepJson(result)), before, 'the resolution marker never serializes');
    assert.equal(selectNextStepRecommendedAction({ ...result }), null, 'a shallow copy keeps its commands and root constraint');
    assertCompactKeepsMandatoryNextStepLines(result);
});

function advisoryFixture(t: TestContext) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-record-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const file = joinOrchestratorPath(repoRoot, path.join('runtime', 'tmp', `${TASK_ID}-composite-recommendation-stop.json`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const state = () => buildResult({ commands: [mechanical()], next_gate: 'handshake-diagnostics' });
    const record = { schema_version: 1, state_sha256: taskCompositeExecutableStateKey(state(), operation), stop_kind: 'repeated-state' };
    return { repoRoot, file, state, record };
}

function assertRecordRecommendation(fixture: ReturnType<typeof advisoryFixture>, expected: boolean): void {
    const result = attachNextStepCompositeRecommendationContext(fixture.state(), fixture.repoRoot, true);
    assert.equal(Boolean(selectNextStepRecommendedAction(result)), expected);
    assert.equal(Boolean(projectNextStepJson(result).recommended_action), expected);
    assert.equal(formatNextStepCompactText(result).includes('Run mechanical steps:'), expected);
    assert.equal(formatNextStepText(result).includes('Single-step alternative:'), expected);
    assertCompactKeepsMandatoryNextStepLines(result);
}

const recordCases: Array<[string, (record: ReturnType<typeof advisoryFixture>['record']) => string, boolean]> = [
    ['matching', (record) => JSON.stringify(record), false],
    ['matching step-limit', (record) => JSON.stringify({ ...record, stop_kind: 'step-limit' }), false],
    ['different state', (record) => JSON.stringify({ ...record, state_sha256: 'b'.repeat(64) }), true],
    ['oversized', (record) => JSON.stringify(record) + ' '.repeat(4097), true],
    ['unparseable', () => '{', true],
    ['wrong schema', (record) => JSON.stringify({ ...record, schema_version: 2 }), true],
    ['missing digest', (record) => JSON.stringify({ ...record, state_sha256: null }), true],
    ['invalid digest', (record) => JSON.stringify({ ...record, state_sha256: 'invalid' }), true],
    ['invalid stop kind', (record) => JSON.stringify({ ...record, stop_kind: 'agent' }), true],
    ['null', () => 'null', true],
    ['array', (record) => JSON.stringify([record]), true]
];
for (const [name, content, expected] of recordCases) {
    test(`stall record ${name}: ${expected ? 'recommendation remains available' : 'only matching state is suppressed'}`, (t) => {
        const fixture = advisoryFixture(t);
        fs.writeFileSync(fixture.file, content(fixture.record));
        assertRecordRecommendation(fixture, expected);
    });
}

test('an unreadable advisory record counts as absent', (t) => {
    const fixture = advisoryFixture(t);
    fs.writeFileSync(fixture.file, JSON.stringify(fixture.record));
    const readFile = fsNative.readFileSync;
    t.mock.method(fsNative, 'readFileSync', (...args: Parameters<typeof fsNative.readFileSync>) => {
        if (args[0] === fixture.file) throw Object.assign(new Error('Record is unreadable.'), { code: 'EACCES' });
        return readFile(...args);
    });
    assertRecordRecommendation(fixture, true);
});

test('only a contained matching record suppresses advice', async (t) => {
    const fixture = advisoryFixture(t);
    fs.writeFileSync(fixture.file, JSON.stringify(fixture.record));
    assertRecordRecommendation(fixture, false);
    fs.unlinkSync(fixture.file);
    fs.rmdirSync(path.dirname(fixture.file));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, path.basename(fixture.file)), JSON.stringify(fixture.record));
    await t.test('an external directory link makes the record absent', (linkTest) => {
        try {
            fs.symlinkSync(outside, path.dirname(fixture.file), process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error: unknown) {
            const code = (error as NodeJS.ErrnoException).code;
            if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EINVAL'].includes(code || '')) {
                linkTest.skip(`Directory links are unavailable on this platform: ${code}.`);
                return;
            }
            throw error;
        }
        assertRecordRecommendation(fixture, true);
    });
});

test('an unwritable record leaves the stop unchanged and warns how to override a repeated recommendation', async (t) => {
    const fixture = advisoryFixture(t);
    fs.mkdirSync(fixture.file);
    fs.writeFileSync(path.join(fixture.file, 'keep.txt'), 'Keep this directory.');
    const current = () => attachNextStepCompositeRecommendationContext(
        { ...fixture.state(), warnings: ['Keep navigator warning.'] }, fixture.repoRoot, true);
    const run = await runTaskComposite({ taskId: TASK_ID, repoRoot: fixture.repoRoot, mode: 'advance', entryInputs: null,
        resolve: current, execute: async () => ({ passed: true, outputLines: [] }) });
    assert.deepEqual(run.stop, { kind: 'repeated-state', reason: "'handshake-diagnostics' passed but the navigator still requires it unchanged." });
    assert.equal(run.outcome, 'STOPPED');
    assert.equal(run.failed, null);
    assert.equal(run.counters.subgates_attempted, 1);
    assert.equal(run.counters.subgates_succeeded, 1);
    assert.equal(run.next?.warnings[0], 'Keep navigator warning.');
    const warning = run.next?.warnings[1];
    assert.ok(warning);
    assert.match(warning, /^Could not retain the composite stall advisory:/u);
    assert.ok(warning.endsWith('If the navigator recommends advance again for this unchanged state, run the single-step command (--verbose) instead.'));
    assert.ok(formatTaskCompositeText(run).includes(`  - ${warning}`));
    assert.deepEqual(JSON.parse(JSON.stringify(run)).next.warnings, ['Keep navigator warning.', warning]);
    assertRecordRecommendation(fixture, true);
    assert.equal(fs.readFileSync(path.join(fixture.file, 'keep.txt'), 'utf8'), 'Keep this directory.');
});

for (const kind of ['repeated-state', 'step-limit'] as const) {
    test(`a fresh navigator suppresses unchanged advance after ${kind}`, async (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-advice-'));
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        let executed = 0;
        const state = (index: number) => buildResult({ commands: [mechanical()], reason: `Mechanical state ${index}.` });
        const current = () => state(kind === 'repeated-state' ? 0 : executed);
        const run = await runTaskComposite({ taskId: TASK_ID, repoRoot, mode: 'advance', entryInputs: null,
            resolve: current, execute: async () => { executed++; return { passed: true, outputLines: [] }; } });
        assert.equal(run.stop?.kind, kind);
        assert.equal(run.counters.subgates_attempted, kind === 'repeated-state' ? 1 : TASK_COMPOSITE_MAX_SUBGATES);
        const fresh = attachNextStepCompositeRecommendationContext(current(), repoRoot, true);
        assert.equal(selectTaskCompositeAction(fresh, 'advance', null).kind, 'execute', 'runner execution permissions are unchanged');
        assert.equal(selectNextStepRecommendedAction(fresh), null);
        assert.equal(projectNextStepJson(fresh).recommended_action, undefined);
        assert.doesNotMatch(formatNextStepCompactText(fresh) + formatNextStepText(fresh), /Run mechanical steps|Single-step alternative:/u);
        assertCompactKeepsMandatoryNextStepLines(fresh);
        const changed = attachNextStepCompositeRecommendationContext(state(executed + 1), repoRoot, true);
        assert.ok(selectNextStepRecommendedAction(changed), 'a different state is not suppressed by the old advisory');
    });
}

test('a review-cycle block suppresses recommendations even on a mechanical descriptor', () => {
    const result = buildResult({ commands: [mechanical()], review_cycle_block: buildReviewCycleBlock() });
    assert.equal(selectTaskCompositeAction(result, 'advance', null).kind, 'execute', 'runner permissions stay unchanged');
    assert.equal(selectNextStepRecommendedAction(result), null);
    assert.equal(projectNextStepJson(result).recommended_action, undefined);
    assert.doesNotMatch(formatNextStepCompactText(result) + formatNextStepText(result), /Run mechanical steps|Single-step alternative:/u);
    assertCompactKeepsMandatoryNextStepLines(result);
});

test('a serialized recommendation never survives loss of its typed descriptor', () => {
    const original = buildResult({ commands: [mechanical()] });
    const json = JSON.stringify(projectNextStepJson(original));
    assert.ok(JSON.parse(json).recommended_action);
    const replayed = JSON.parse(json) as NextStepResult;
    assert.equal(selectNextStepRecommendedAction(replayed), null);
    assert.equal(projectNextStepJson(replayed).recommended_action, undefined);
    assert.doesNotMatch(formatNextStepCompactText(replayed) + formatNextStepText(replayed), /Run mechanical steps|Single-step alternative:/u);
    assert.ok(formatNextStepCompactText(replayed).includes(commandText), 'the single step remains visible');
});

test('an eligible rebinding keeps the identity-bound compaction hint without growing compact text', () => {
    const result = attachNextStepHints(buildResult({ next_gate: 'bind-rule-pack-to-preflight', commands: [mechanical({
        operation_id: 'bind-rule-pack-to-preflight', arguments: { task_id: TASK_ID, preflight_path: 'reviews/preflight.json', task_mode_path: null }
    })] }), { taskId: TASK_ID, repoRoot: '.', taskModePlanAttached: false, preflightChangedFileCount: 1 });
    assert.ok(selectNextStepRecommendedAction(result));
    assert.ok(formatNextStepCompactText(result).split('\n').includes(COMPACTION_CHECKPOINT_HINT));
    assertCompactKeepsMandatoryNextStepLines(result);
});
