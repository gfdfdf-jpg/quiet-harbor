import type { TestContext } from 'node:test';
import {
    assert, describe, it, fs, path, createTempRepo, seedRemediationRepoBase,
    initializeGitRepo, seedTaskQueue, seedInitAnswers, runEnterTaskMode,
    loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask,
    runExplicitPreflight, loadPostPreflightRulePack, readTaskTimelineEvents,
    getReviewsRoot, writeSimpleCompileCommandsFile, markAsSourceCheckout,
    writeProtectedControlPlaneManifest, runRestartCoherentCycleCommand, runCompileGateCommand,
    seedQualityChecklistIfRequired, observeCurrentReviewCycleValidation, fileSha256, EXIT_GATE_FAILURE
} from './gates-review-cycle-fixtures';
import { runIntermediateCommandCommand } from '../../../../../../src/cli/commands/gate-flows/command-run/command-run-flow';
import { resolveNextStep } from '../../../../gates/next-step/next-step-test-support';
import { buildNextStepInstruction } from '../../../../../../src/gates/next-step/next-step-command-formatters';
import { parseCommandChain } from '../../../../../../src/core/command-line';
import { readExpectedRedExecutionEvidence, readExpectedRedPreparation } from '../../../../../../src/gates/test-first/expected-red-evidence';
import type { SelectedCaseClaim } from '../../../../../../src/core/intermediate-selected-cases';
import { buildQualityChecklistAnswersTemplate } from '../../../../../../src/gates/quality-checklist';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID } from '../../../../../../src/core/trust-boundary-analysis';
import { runQualityChecklistCommand } from '../../../../../../src/cli/commands/gates';
import { resolveOutputFiltersPath } from '../../../../../../src/cli/commands/gate-flows/compile/output-budget-filter';

const TEST_SOURCE = 'tests/coherent-red.test.ts';
const SOURCE = 'src/app.ts';
const TEST_HELPER = 'tests/helpers/value.cjs';
const ALTERNATE_FILTERS = 'coherent-alternate-output-filters.json';
const FOCUSED_COMMAND = `node --experimental-strip-types --test --test-reporter=tap ${TEST_SOURCE}`;

interface CoherentFixture {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    commandsPath: string;
    outputFiltersPath: string;
}

async function runFocused(fixture: CoherentFixture, expectFailure: boolean, command = FOCUSED_COMMAND,
    selectedCases?: SelectedCaseClaim[]) {
    const nativeContext = process.env.NODE_TEST_CONTEXT;
    try {
        delete process.env.NODE_TEST_CONTEXT;
        return await runIntermediateCommandCommand({
            repoRoot: fixture.repoRoot, taskId: fixture.taskId, preflightPath: fixture.preflightPath,
            commandSource: 'targeted-test', command, expectFailure, selectedCases
        });
    } finally {
        if (nativeContext === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = nativeContext;
    }
}

function publishSelectedCaseMatrix(fixture: CoherentFixture, cases: readonly SelectedCaseClaim[]) {
    const matrix = [{ boundary_id: 'TB-SELECTED-CASE-RECOVERY', boundary: 'Invalid values to the fixture validator',
        authority_source: 'Current native selected-source execution', mutable_inputs: ['validator input and execution lineage'],
        integrity_evidence: ['preflight, selected-source and output SHA-256'],
        canonical_reconstruction: 'Reconstruct each required source and case from current native execution.',
        toctou_replay: 'Reject stale execution and partial selected-case coverage.',
        negative_paths: cases.map(claim => ({ kind: 'other', scenario: claim.case_id,
            expected_behavior: 'Reject the invalid validator input.', evidence_files: [`${claim.source}#${claim.case_id}`] })) }];
    const answers = buildQualityChecklistAnswersTemplate(fixture).answers.map(answer => ({ ...answer,
        status: 'PASS', answer: 'Inspected the current native fixture inputs and the complete selected-case validation matrix.',
        ...(answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: matrix } : {}) }));
    return runQualityChecklistCommand({ ...fixture, answersJson: JSON.stringify(answers), emitMetrics: false });
}

async function createCoherentFixture(t: TestContext, taskId: string, mixed = false, withHelper = false): Promise<CoherentFixture> {
    const repoRoot = createTempRepo(t);
    seedRemediationRepoBase(repoRoot);
    markAsSourceCheckout(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, SOURCE), 'module.exports = { value: 0 };\n');
    if (withHelper) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, TEST_HELPER)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, TEST_HELPER), "module.exports = require('../../src/app.ts');\n");
    }
    const testContent = (expected: number) => [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        withHelper ? "const { value } = require('./helpers/value.cjs');" : "const { value } = require('../src/app.ts');",
        `test('uses the required value', () => assert.equal(require('node:fs').existsSync('garda-agent-orchestrator/runtime/force-assertion-failure') ? -1 : value, ${expected}));`, ''
    ].join('\n');
    fs.writeFileSync(path.join(repoRoot, TEST_SOURCE), testContent(0));
    const commands = writeSimpleCompileCommandsFile(repoRoot, 'coherent-red');
    fs.copyFileSync(commands.outputFiltersPath, path.join(repoRoot, ALTERNATE_FILTERS));
    writeProtectedControlPlaneManifest(repoRoot);
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    const queuePath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(queuePath, fs.readFileSync(queuePath, 'utf8')
        .replace('| fixture |', '| Test-first: expected-red. |'));
    seedInitAnswers(repoRoot, 'Codex');
    const files = withHelper ? [TEST_SOURCE, TEST_HELPER] : mixed ? [TEST_SOURCE, SOURCE] : [TEST_SOURCE];
    const entered = runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Implement the required value test first',
        plannedChangedFiles: withHelper ? [TEST_SOURCE, TEST_HELPER, SOURCE] : [TEST_SOURCE, SOURCE] });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    fs.writeFileSync(path.join(repoRoot, TEST_SOURCE), testContent(2));
    if (withHelper) fs.appendFileSync(path.join(repoRoot, TEST_HELPER), '// using-test support changed\n');
    if (mixed) fs.writeFileSync(path.join(repoRoot, SOURCE), 'module.exports = { value: 1 };\n');
    const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Implement the required value test first', files);
    loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    const fixture = { repoRoot, taskId, preflightPath, ...commands };
    if (!mixed) {
        const red = await runFocused(fixture, true);
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        assert.match(red.outputLines.join('\n'), /TEST_FIRST_ASSERTION_SEMANTICS_PENDING/u);
    }
    return fixture;
}

function restartOptions(fixture: CoherentFixture) {
    return { ...fixture, operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString(), emitMetrics: false };
}

function assertNoNewRunCompile(fixture: CoherentFixture) {
    const events = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
    const mode = events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED');
    const current = events.slice(mode + 1);
    assert.equal(events.filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 2);
    assert.equal(current.some(event => event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'), true);
    assert.equal(current.some(event => event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'), true);
    assert.equal(current.some(event => event.event_type === 'PREFLIGHT_CLASSIFIED'), true);
    assert.equal(current.some(event => event.event_type === 'IMPLEMENTATION_STARTED'), false,
        'A new coherent run must request its own RED before implementation starts.');
    assert.equal(current.some(event => event.event_type === 'COMPILE_GATE_PASSED'), false,
        'Compile cannot run ahead of genuine new-run RED.');
    assert.equal(current.some(event => event.event_type === 'COHERENT_CYCLE_RESTARTED'), false);
    return events;
}

function pendingCheckpointPath(outputLines: string[]): string {
    const checkpoint = outputLines.find(line => line.startsWith('CheckpointPath: '))?.slice('CheckpointPath: '.length);
    assert.ok(checkpoint, outputLines.join('\n'));
    return checkpoint;
}

async function verifyRetainedCompileFilters(t: TestContext, kind: 'explicit' | 'default') {
    const fixture = await createCoherentFixture(t, `T-COHERENT-FILTERS-${kind.toUpperCase()}`);
    const { outputFiltersPath: explicitFilters, ...withoutFilters } = restartOptions(fixture);
    const request = kind === 'explicit' ? { ...withoutFilters, outputFiltersPath: explicitFilters } : withoutFilters;
    const expectedFilters = resolveOutputFiltersPath(fixture.repoRoot, kind === 'explicit' ? explicitFilters : '');
    const pending = await runRestartCoherentCycleCommand(request);
    assert.equal(pending.exitCode, EXIT_GATE_FAILURE, pending.outputLines.join('\n'));
    assertNoNewRunCompile(fixture);
    if (kind === 'default') {
        assert.equal(fs.existsSync(expectedFilters), false, 'The supported missing-config passthrough remains available.');
        fs.mkdirSync(path.dirname(expectedFilters), { recursive: true });
        fs.copyFileSync(explicitFilters, expectedFilters);
        await assert.rejects(runRestartCoherentCycleCommand(request), /command or output-filter binding changed/u,
            'A newly materialized filter cannot replace the retained absent configuration.');
        fs.unlinkSync(expectedFilters);
    }
    assert.equal((await runFocused(fixture, true)).exitCode, 0);
    fs.writeFileSync(path.join(fixture.repoRoot, SOURCE), 'module.exports = { value: 2 };\n');
    runExplicitPreflight(fixture.repoRoot, fixture.taskId, 'Implement the required value test first', [SOURCE, TEST_SOURCE]);
    loadPostPreflightRulePack(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
    seedQualityChecklistIfRequired(fixture.repoRoot, fixture.taskId);
    await observeCurrentReviewCycleValidation(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
    const wrongCompile = await runCompileGateCommand({ ...fixture,
        outputFiltersPath: path.join(fixture.repoRoot, ALTERNATE_FILTERS), emitMetrics: false });
    assert.equal(wrongCompile.exitCode, 0, wrongCompile.outputLines.join('\n'));
    assert.equal((await runFocused(fixture, false)).exitCode, 0);
    const premature = await runRestartCoherentCycleCommand(request);
    assert.equal(premature.exitCode, EXIT_GATE_FAILURE,
        'A passing compile with a different output-filter source cannot finalize the retained request.');
    assert.match(premature.outputLines.join('\n'), /COHERENT_CYCLE_RECOVERY_PENDING/u);
    assert.equal(readTaskTimelineEvents(fixture.repoRoot, fixture.taskId)
        .filter(event => event.event_type === 'COHERENT_CYCLE_RESTARTED').length, 0);
    const next = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
    assert.equal(next.next_gate, 'compile-gate', next.reason);
    const tokens = parseCommandChain(next.commands[0].command)[0];
    assert.ok(tokens.includes('--output-filters-path'), next.commands[0].command);
    assert.equal(path.resolve(tokens[tokens.indexOf('--output-filters-path') + 1]), path.resolve(expectedFilters));
    const compilePath = path.join(getReviewsRoot(fixture.repoRoot), `${fixture.taskId}-compile-gate.json`);
    const wrongBytes = fs.readFileSync(compilePath);
    const forged = JSON.parse(wrongBytes.toString('utf8'));
    forged.output_filters_path = expectedFilters;
    fs.writeFileSync(compilePath, JSON.stringify(forged));
    await assert.rejects(runRestartCoherentCycleCommand(request), /compile artifact differs from its current native event/u,
        'Changing only artifact metadata cannot launder the wrong native compile.');
    fs.writeFileSync(compilePath, wrongBytes);
    const correctCompile = await runCompileGateCommand({ ...fixture, outputFiltersPath: expectedFilters,
        commandsPath: path.join(fixture.repoRoot, 'non-authoritative-legacy-commands.md'), emitMetrics: false });
    assert.equal(correctCompile.exitCode, 0, correctCompile.outputLines.join('\n'));
    const correct = JSON.parse(fs.readFileSync(compilePath, 'utf8'));
    assert.equal(correct.compile_command_source, 'workflow_config', 'The workflow keeps exclusive compile-command authority.');
    assert.equal(correct.commands_path, null, 'Legacy commandsPath cannot replace the configured checks.');
    const completed = await runRestartCoherentCycleCommand(request);
    assert.equal(completed.exitCode, 0, completed.outputLines.join('\n'));
    const events = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
    assert.equal(events.filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 2);
    assert.equal(events.filter(event => event.event_type === 'COHERENT_CYCLE_RESTARTED').length, 1);
}

describe('coherent test-first recovery', () => {
    it('requires the retained explicit output-filter source before coherent completion', async t => {
        await verifyRetainedCompileFilters(t, 'explicit');
    });

    it('requires the retained default output-filter source before coherent completion', async t => {
        await verifyRetainedCompileFilters(t, 'default');
    });

    it('pauses before implementation and compile instead of borrowing RED from the previous task-mode run', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-RED-PENDING');
        const originalEvents = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
        const originalRed = originalEvents.find(event => event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED');
        assert.ok(originalRed);
        const result = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assertNoNewRunCompile(fixture);
        assert.equal(result.exitCode, EXIT_GATE_FAILURE, result.outputLines.join('\n'));
        assert.match(result.outputLines.join('\n'), /COHERENT_CYCLE_RECOVERY_PENDING/u);
        assert.match(result.outputLines.join('\n'), /RestartCompleted: false/u);
        seedQualityChecklistIfRequired(fixture.repoRoot, fixture.taskId);
        await observeCurrentReviewCycleValidation(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        const next = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(next.next_gate, 'test-first-expected-failure', next.reason);
        assert.equal(next.commands.length, 1, next.reason);
        assert.match(next.commands[0].command, /run-intermediate-command/u);
        assert.ok(next.commands[0].command.includes(FOCUSED_COMMAND));
        assert.match(next.commands[0].command, /--expect-failure/u);
        const repeated = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assert.equal(repeated.exitCode, EXIT_GATE_FAILURE);
        const events = assertNoNewRunCompile(fixture);
        assert.deepEqual(events.find(event => event.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED'), originalRed);
        assert.equal(events.filter(event => event.event_type === 'PREFLIGHT_CLASSIFIED').length, 2,
            'Pending resume must keep the current preflight instead of republishing it.');
        assert.equal((await runFocused(fixture, true)).exitCode, 0);
        const implementation = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(implementation.next_gate, 'implementation',
            'Retained compile advice cannot skip the test-only implementation phase after genuine RED.');
    });

    it('blocks mixed scope before compile with an explicit legitimate test-only RED setup requirement', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-RED-MIXED', true);
        const result = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assertNoNewRunCompile(fixture);
        assert.equal(result.exitCode, EXIT_GATE_FAILURE, result.outputLines.join('\n'));
        assert.match(result.outputLines.join('\n'), /COHERENT_CYCLE_RECOVERY_PENDING/u);
        assert.match(result.outputLines.join('\n'), /test-only/u);
        seedQualityChecklistIfRequired(fixture.repoRoot, fixture.taskId);
        await observeCurrentReviewCycleValidation(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        const next = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(next.next_gate, 'test-first-expected-failure', next.reason);
        assert.match(next.reason, /test-only/u);
        assert.equal(next.commands.length, 0, 'The navigator cannot silently narrow a mixed scope or rewind source.');
        const preflight = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(fixture.repoRoot),
            `${fixture.taskId}-preflight.json`), 'utf8'));
        assert.deepEqual([...preflight.changed_files].sort(), [SOURCE, TEST_SOURCE].sort());
    });

    it('resumes the prepared run after genuine new RED, implementation and current GREEN exactly once', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-RED-RESUME');
        const pending = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assertNoNewRunCompile(fixture);
        assert.equal(pending.exitCode, EXIT_GATE_FAILURE, pending.outputLines.join('\n'));
        const red = await runFocused(fixture, true);
        assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
        fs.writeFileSync(path.join(fixture.repoRoot, SOURCE), 'module.exports = { value: 2 };\n');
        runHandshakeForTask(fixture.repoRoot, fixture.taskId);
        runShellSmokeForTask(fixture.repoRoot, fixture.taskId);
        runExplicitPreflight(fixture.repoRoot, fixture.taskId, 'Implement the required value test first',
            [SOURCE, TEST_SOURCE]);
        loadPostPreflightRulePack(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        const compiled = await runCompileGateCommand({ ...fixture, emitMetrics: false });
        assert.equal(compiled.exitCode, 0, compiled.outputLines.join('\n'));
        const green = await runFocused(fixture, false);
        assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
        const failureSwitch = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/force-assertion-failure');
        fs.writeFileSync(failureSwitch, 'force a later failed assertion');
        assert.equal((await runFocused(fixture, false)).exitCode, 1);
        const rejected = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assert.equal(rejected.exitCode, EXIT_GATE_FAILURE, 'Newer failed execution cannot finalize the earlier GREEN.');
        assert.equal(readTaskTimelineEvents(fixture.repoRoot, fixture.taskId)
            .some(event => event.event_type === 'COHERENT_CYCLE_RESTARTED'), false);
        fs.unlinkSync(failureSwitch);
        assert.equal((await runFocused(fixture, false)).exitCode, 0);
        await observeCurrentReviewCycleValidation(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        const next = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(next.next_gate, 'restart-coherent-cycle', next.reason);
        assert.equal(next.commands.length, 1, next.reason);
        assert.match(next.commands[0].command, /restart-coherent-cycle/u);
        const resumeTokens = parseCommandChain(next.commands[0].command)[0];
        const operand = (flag: string) => resumeTokens.includes(flag) ? resumeTokens[resumeTokens.indexOf(flag) + 1] : undefined;
        assert.equal(operand('--task-mode-path'), undefined, 'Defaulted request fields must not become new resume overrides.');
        const completed = await runRestartCoherentCycleCommand({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
            taskModePath: operand('--task-mode-path'), preflightPath: operand('--preflight-path'),
            preflightOutputPath: operand('--preflight-output-path'), emitMetrics: false });
        assert.equal(completed.exitCode, 0, completed.outputLines.join('\n'));
        assert.match(completed.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/u);
        const beforeRetry = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
        const repeated = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assert.equal(repeated.exitCode, 0, repeated.outputLines.join('\n'));
        const afterRetry = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
        assert.equal(afterRetry.filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 2);
        assert.equal(afterRetry.filter(event => event.event_type === 'COHERENT_CYCLE_RESTARTED').length, 1);
        assert.deepEqual(afterRetry, beforeRetry, 'A completed retry must not publish another compile, preflight or restart.');
    });

    it('rejects altered pending bytes before another entry or compile', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-RED-TAMPER');
        const pending = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assertNoNewRunCompile(fixture);
        const checkpoint = pendingCheckpointPath(pending.outputLines);
        fs.appendFileSync(checkpoint, '\n');
        const before = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
        await assert.rejects(runRestartCoherentCycleCommand(restartOptions(fixture)), /checkpoint bytes changed/iu);
        assert.deepEqual(readTaskTimelineEvents(fixture.repoRoot, fixture.taskId), before);
    });

    for (const replacement of ['missing', 'linked'] as const) it(`rejects ${replacement} checkpoint storage without another entry`, async t => {
        const fixture = await createCoherentFixture(t, `T-COHERENT-RED-${replacement.toUpperCase()}`);
        const pending = await runRestartCoherentCycleCommand(restartOptions(fixture));
        const checkpoint = pendingCheckpointPath(pending.outputLines);
        const bytes = fs.readFileSync(checkpoint);
        fs.unlinkSync(checkpoint);
        if (replacement === 'linked') {
            const foreignPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/foreign-checkpoint.json');
            fs.writeFileSync(foreignPath, bytes);
            fs.linkSync(foreignPath, checkpoint);
        }
        const before = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
        await assert.rejects(runRestartCoherentCycleCommand(restartOptions(fixture)), /ENOENT|link|identity|regular|contained/iu);
        assert.deepEqual(readTaskTimelineEvents(fixture.repoRoot, fixture.taskId), before);
        assertNoNewRunCompile(fixture);
    });

    it('rejects a different recovery request instead of restarting the pending task again', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-RED-REQUEST');
        await runRestartCoherentCycleCommand(restartOptions(fixture));
        assertNoNewRunCompile(fixture);
        const before = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
        await assert.rejects(runRestartCoherentCycleCommand({ ...restartOptions(fixture),
            taskIntent: 'A different recovery request' }), /changed recovery request/iu);
        assert.deepEqual(readTaskTimelineEvents(fixture.repoRoot, fixture.taskId), before);
    });

    it('rejects an unclassified source change while retaining the original pending transition', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-RED-SOURCE');
        const pending = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assertNoNewRunCompile(fixture);
        const checkpoint = pendingCheckpointPath(pending.outputLines);
        const original = fs.readFileSync(checkpoint);
        fs.appendFileSync(path.join(fixture.repoRoot, TEST_SOURCE), '\n// source changed after pending publication\n');
        await assert.rejects(runRestartCoherentCycleCommand(restartOptions(fixture)), /source|scope|identity|changed/iu);
        assert.deepEqual(fs.readFileSync(checkpoint), original);
        assertNoNewRunCompile(fixture);
    });

    it('covers a changed test helper through genuine RED of its using test while retaining helper-byte freshness', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-RED-HELPER', false, true);
        const readRed = () => readExpectedRedExecutionEvidence({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
            preflightPath: fixture.preflightPath, preflightSha256: fileSha256(fixture.preflightPath) });
        const red = readRed();
        assert.ok(red, 'A helper is covered by the actual RED of the test that imports it.');
        assert.deepEqual([...new Set(red.obligations.map(item => item.source_identity.path))], [TEST_SOURCE]);
        fs.appendFileSync(path.join(fixture.repoRoot, TEST_HELPER), '\n// changed after RED\n');
        assert.throws(readRed, /scope|source|identity|changed/iu, 'Changed helper bytes cannot inherit the retained RED.');
        fs.writeFileSync(path.join(fixture.repoRoot, SOURCE), 'module.exports = { value: 2 };\n');
        runExplicitPreflight(fixture.repoRoot, fixture.taskId, 'Implement the required value test first',
            [SOURCE, TEST_SOURCE, TEST_HELPER]);
        loadPostPreflightRulePack(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        assert.equal((await runFocused(fixture, false)).exitCode, 0);
        assert.throws(() => readExpectedRedPreparation({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
            preflightPath: fixture.preflightPath, preflightSha256: fileSha256(fixture.preflightPath) }),
        /test\/support input bytes or scope changed/iu, 'Even classified helper edits cannot launder old RED.');
    });

    it('prints the owning native command when the only validation execution predates the new lineage', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-NATIVE-FRESH');
        const queuePath = path.join(fixture.repoRoot, 'TASK.md');
        fs.writeFileSync(queuePath, fs.readFileSync(queuePath, 'utf8').replace('Test-first: expected-red.', 'Ordinary cycle approved.'));
        const sensitiveSource = 'src/recovery-evidence.ts';
        fs.writeFileSync(path.join(fixture.repoRoot, sensitiveSource), 'module.exports = { checked: false };\n');
        runExplicitPreflight(fixture.repoRoot, fixture.taskId, 'Harden recovery control-plane authorization evidence', [TEST_SOURCE, sensitiveSource]);
        loadPostPreflightRulePack(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        seedQualityChecklistIfRequired(fixture.repoRoot, fixture.taskId);
        await observeCurrentReviewCycleValidation(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        const original = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId).filter(event =>
            event.event_type === 'INTERMEDIATE_COMMAND_RUN').at(-1)!;
        assert.ok(original, 'The fixture must execute the real owning check before making its lineage stale.');
        const details = original.details as Record<string, unknown>;
        const oldRecord = fs.readFileSync(String(details.artifact_path));
        fs.writeFileSync(path.join(fixture.repoRoot, sensitiveSource), 'module.exports = { checked: true };\n');
        runExplicitPreflight(fixture.repoRoot, fixture.taskId, 'Harden recovery control-plane authorization evidence', [TEST_SOURCE, sensitiveSource]);
        loadPostPreflightRulePack(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        seedQualityChecklistIfRequired(fixture.repoRoot, fixture.taskId);
        const blocked = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(blocked.next_gate, 'project-validation-evidence', blocked.reason);
        assert.equal(blocked.commands.length, 1, 'Out-of-lineage native validation needs an exact fresh-run exit.');
        assert.ok(blocked.commands[0].command.includes(String(details.command)), blocked.commands[0].command);
        assert.match(blocked.commands[0].command, /--command-source targeted-test/u);
        assert.doesNotMatch(blocked.commands[0].command, /--recipe-id|--expect-failure/u);
        assert.equal(buildNextStepInstruction(blocked), null, 'The executable fresh-run command owns the instruction.');
        const nativeContext = process.env.NODE_TEST_CONTEXT;
        try {
            delete process.env.NODE_TEST_CONTEXT;
            const green = await runIntermediateCommandCommand({ ...fixture, commandSource: 'targeted-test', command: String(details.command) });
            assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
        } finally {
            if (nativeContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = nativeContext;
        }
        assert.notEqual(resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId }).next_gate,
            'project-validation-evidence', 'A genuine fresh native execution advances the route.');
        assert.deepEqual(fs.readFileSync(String(details.artifact_path)), oldRecord);
    });

    it('keeps every required case when choosing a fresh invocation after a newer subset execution', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-CASE-COVERAGE');
        const queuePath = path.join(fixture.repoRoot, 'TASK.md');
        fs.writeFileSync(queuePath, fs.readFileSync(queuePath, 'utf8').replace('Test-first: expected-red.', 'Ordinary cycle approved.'));
        fs.writeFileSync(path.join(fixture.repoRoot, SOURCE), [
            'module.exports = { value: 2, validate(input) {',
            "if (typeof input !== 'number' || input < 0) throw new Error('invalid value'); return input; } };", ''
        ].join('\n'));
        const cases: SelectedCaseClaim[] = ['rejects first invalid input', 'rejects second invalid input']
            .map(case_id => ({ source: TEST_SOURCE, case_id, selector: TEST_SOURCE }));
        fs.writeFileSync(path.join(fixture.repoRoot, TEST_SOURCE), [
            "const test = require('node:test'), assert = require('node:assert/strict');",
            "const { validate } = require('../src/app.ts');",
            "test('rejects first invalid input', () => assert.throws(() => validate('bad'), /invalid value/));",
            "test('rejects second invalid input', () => assert.throws(() => validate(-1), /invalid value/));", ''
        ].join('\n'));
        const sensitive = 'src/recovery-evidence.ts';
        fs.writeFileSync(path.join(fixture.repoRoot, sensitive), 'module.exports = { checked: false };\n');
        const classify = () => {
            runExplicitPreflight(fixture.repoRoot, fixture.taskId, 'Validate recovery evidence', [SOURCE, TEST_SOURCE, sensitive]);
            loadPostPreflightRulePack(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        };
        classify();
        assert.equal((await runFocused(fixture, false, FOCUSED_COMMAND, cases)).exitCode, 0);
        const subset = FOCUSED_COMMAND.replace(TEST_SOURCE, `--test-name-pattern=first ${TEST_SOURCE}`);
        assert.equal((await runFocused(fixture, false, subset, [{ ...cases[0], selector: 'first' }])).exitCode, 0);
        fs.writeFileSync(path.join(fixture.repoRoot, sensitive), 'module.exports = { checked: true };\n');
        classify();
        const published = publishSelectedCaseMatrix(fixture, cases);
        assert.equal(published.exitCode, 0, published.outputLines.join('\n'));
        const next = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(next.next_gate, 'project-validation-evidence', next.reason);
        assert.equal(next.commands.length, 1, next.reason);
        const tokens = parseCommandChain(next.commands[0].command)[0];
        const actualCommand = tokens[tokens.indexOf('--command') + 1];
        assert.equal(actualCommand, FOCUSED_COMMAND, 'The newest subset invocation cannot cover both required cases.');
        const actualCases = tokens.flatMap((token, index) => token === '--selected-case'
            ? [JSON.parse(tokens[index + 1]) as SelectedCaseClaim] : []);
        assert.deepEqual(actualCases, cases, 'The fresh command must retain both authenticated case selectors.');
        assert.equal((await runFocused(fixture, false, actualCommand, actualCases)).exitCode, 0);
        assert.equal(publishSelectedCaseMatrix(fixture, cases).exitCode, 0);
        assert.equal(resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId }).next_gate, 'compile-gate');
    });

    it('navigates a pending coherent implementation refresh after a prior implementation boundary without re-entry', async t => {
        const fixture = await createCoherentFixture(t, 'T-COHERENT-PRIOR-IMPLEMENTATION');
        const oldCompile = await runCompileGateCommand({ ...fixture, emitMetrics: false });
        assert.equal(oldCompile.exitCode, 0, oldCompile.outputLines.join('\n'));
        assert.ok(readTaskTimelineEvents(fixture.repoRoot, fixture.taskId)
            .some(event => event.event_type === 'IMPLEMENTATION_STARTED'), 'The prior run must contain a genuine implementation boundary.');
        const pending = await runRestartCoherentCycleCommand(restartOptions(fixture));
        assert.equal(pending.exitCode, EXIT_GATE_FAILURE, pending.outputLines.join('\n'));
        assertNoNewRunCompile(fixture);
        assert.equal((await runFocused(fixture, true)).exitCode, 0);
        fs.writeFileSync(path.join(fixture.repoRoot, SOURCE), 'module.exports = { value: 2 };\n');
        const refresh = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(refresh.next_gate, 'classify-change', refresh.reason);
        assert.equal(refresh.commands.length, 1, refresh.reason);
        assert.ok(refresh.commands[0].command.includes(SOURCE), refresh.commands[0].command);
        assert.ok(refresh.commands[0].command.includes(TEST_SOURCE), refresh.commands[0].command);
        runExplicitPreflight(fixture.repoRoot, fixture.taskId, 'Implement the required value test first', [SOURCE, TEST_SOURCE]);
        loadPostPreflightRulePack(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        seedQualityChecklistIfRequired(fixture.repoRoot, fixture.taskId);
        await observeCurrentReviewCycleValidation(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        const readyToCompile = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(readyToCompile.next_gate, 'compile-gate', readyToCompile.reason);
        const compiled = await runCompileGateCommand({ ...fixture, emitMetrics: false });
        assert.equal(compiled.exitCode, 0, compiled.outputLines.join('\n'));
        assert.equal((await runFocused(fixture, false)).exitCode, 0);
        const finalization = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(finalization.next_gate, 'restart-coherent-cycle', finalization.reason);
        assert.equal((await runRestartCoherentCycleCommand(restartOptions(fixture))).exitCode, 0);
        const events = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
        assert.equal(events.filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 2);
        assert.equal(events.filter(event => event.event_type === 'COHERENT_CYCLE_RESTARTED').length, 1);
        fs.writeFileSync(path.join(fixture.repoRoot, SOURCE), 'module.exports = { value: 3 };\n');
        const afterCompletion = resolveNextStep({ repoRoot: fixture.repoRoot, taskId: fixture.taskId });
        assert.equal(afterCompletion.next_gate, 'restart-coherent-cycle',
            'A completed transition cannot keep granting the pending-only refresh exception.');
        const completion = events.filter(event => event.event_type === 'COHERENT_CYCLE_RESTARTED').at(-1)!;
        const completionPath = String((completion.details as Record<string, unknown>).restart_artifact_path);
        const completionBytes = fs.readFileSync(completionPath);
        fs.appendFileSync(completionPath, ' ');
        await assert.rejects(runRestartCoherentCycleCommand(restartOptions(fixture)),
            /completion has no intact native artifact/u, 'Source drift cannot hide damaged completion evidence.');
        fs.writeFileSync(completionPath, completionBytes);
        const checkpointPath = pendingCheckpointPath(pending.outputLines);
        const checkpointBytes = fs.readFileSync(checkpointPath);
        fs.appendFileSync(checkpointPath, ' ');
        await assert.rejects(runRestartCoherentCycleCommand(restartOptions(fixture)),
            /checkpoint bytes changed/u, 'Source drift cannot hide damaged checkpoint evidence.');
        fs.writeFileSync(checkpointPath, checkpointBytes);
        assert.equal(readTaskTimelineEvents(fixture.repoRoot, fixture.taskId)
            .filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 2);
        let nextCycle: Awaited<ReturnType<typeof runRestartCoherentCycleCommand>> | undefined;
        await assert.doesNotReject(async () => {
            nextCycle = await runRestartCoherentCycleCommand(restartOptions(fixture));
        }, 'The printed command must retire the completed checkpoint and prepare a genuine new run.');
        assert.equal(nextCycle!.exitCode, EXIT_GATE_FAILURE, nextCycle!.outputLines.join('\n'));
        assert.match(nextCycle!.outputLines.join('\n'), /COHERENT_CYCLE_RECOVERY_PENDING/u);
        assert.equal(readTaskTimelineEvents(fixture.repoRoot, fixture.taskId)
            .filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 3);
    });
});
