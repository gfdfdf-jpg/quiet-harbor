import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand, runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { readValidationFile } from '../../../../src/core/project-validation-identity';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { readExpectedRedExecutionEvidence, readExpectedRedReviewObligations, readRetainedExpectedRedRejection } from '../../../../src/gates/test-first/expected-red-evidence';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';
import { readTaskTimelineEvents } from '../../cli/commands/gate-test-helpers';

const TASK = 'T-OPAQUE-RED', TARGET = 'qa/purchase.case', SUPPORT = 'qa/membership.fixture';
const RUNNER = 'tools/quartz', SOURCE = 'components/behavior.qz';

function fixture(mutation?: string, explicitCases = true) {
    const repoRoot = createTempRepo();
    const write = (file: string, bytes: string) => {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, file), bytes);
    };
    write(SOURCE, 'before\n'); write(SUPPORT, 'membership\n');
    write(RUNNER, "const fs = require('node:fs');\n"
        + `console.log('opaque behavior observation');\n`
        + (mutation ? `fs.appendFileSync(${JSON.stringify(mutation)}, 'mutated during execution');\n` : '')
        + `process.exitCode = fs.readFileSync(${JSON.stringify(SOURCE)}, 'utf8').startsWith('after') ? 0 : 7;\n`);
    seedTaskQueue(repoRoot, TASK, 'TODO', 'default', 'Test-first: expected-red.');
    seedInitAnswers(repoRoot);
    const workflow = buildDefaultWorkflowConfig();
    workflow.full_suite_validation.enabled = true;
    write('garda-agent-orchestrator/live/config/workflow-config.json', JSON.stringify(workflow));
    initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Opaque production input TDD', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK); runHandshakeForTask(repoRoot, TASK); runShellSmokeForTask(repoRoot, TASK);
    write(TARGET, 'assert purchase behavior\n');
    const preflightPath = path.join(repoRoot, `garda-agent-orchestrator/runtime/reviews/${TASK}-preflight.json`);
    const classify = (implemented = false) => {
        const result = runClassifyChangeCommand({ repoRoot, taskId: TASK, taskIntent: 'Opaque production input TDD',
            changedFiles: [TARGET, ...(implemented ? [SOURCE] : [])], outputPath: preflightPath, emitMetrics: false });
        assert.ok(fs.existsSync(preflightPath), result.outputText);
    };
    classify();
    const command = `node ${RUNNER} --input ${TARGET} --data ${SUPPORT} --implementation ${SOURCE}`;
    const previous = process.cwd();
    try {
        process.chdir(repoRoot);
        handleSet({ targetRoot: repoRoot, taskId: TASK, fullSuiteCommand: command,
            focusedRequiredTestPath: [TARGET], taskTestSelectionReason: `${TASK} verifies the current purchase behavior`,
            taskTestPlan: JSON.stringify({ support: [
                { path: SUPPORT, role: 'fixture', targets: [TARGET] }, { path: RUNNER, role: 'runner', targets: [TARGET] }
            ] }), json: true });
    } finally { process.chdir(previous); }
    // The declaration becomes part of the authenticated test-only classification.
    classify();
    const options = () => ({ repoRoot, taskId: TASK, preflightPath,
        preflightSha256: readValidationFile(repoRoot, path.relative(repoRoot, preflightPath).replace(/\\/gu, '/')).identity.sha256 });
    const run = (expectFailure = false, overrideCommand = command) => runIntermediateCommandCommand({
        repoRoot, taskId: TASK, commandSource: 'targeted-test', command: overrideCommand, preflightPath, expectFailure,
        ...(explicitCases ? { selectedCases: [JSON.stringify({ source: TARGET, case_id: 'purchase', selector: TARGET })] } : {})
    });
    const implement = () => { write(SOURCE, 'after\n'); classify(true); };
    return { repoRoot, write, classify, implement, run, options };
}

for (const explicitCases of [true, false]) test(`retains opaque implementation operands after RED with explicit cases=${explicitCases}`, async t => {
    const f = fixture(undefined, explicitCases); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    assert.equal((await f.run(true)).exitCode, 0);
    assert.ok(readExpectedRedExecutionEvidence(f.options())?.obligations.length);
    f.implement();
    assert.equal(readRetainedExpectedRedRejection(f.options()), null);
    assert.throws(() => readExpectedRedReviewObligations(f.options()), /GREEN|successful execution/u);
    const green = await f.run(); assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
    const obligations = readExpectedRedReviewObligations(f.options());
    assert.equal(obligations.length, 2);
    assert.ok(obligations[0].case_execution!.event_task_sequence < obligations[1].case_execution!.event_task_sequence);
    assert.equal(obligations[0].source_identity.sha256, obligations[1].source_identity.sha256);
});

test('rejects recording RED after the implementation has entered the task scope', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    f.implement();
    await assert.rejects(() => f.run(true), /before implementation|test-only/u);
});

for (const input of [TARGET, SUPPORT, RUNNER]) test(`retained RED rejects changed immutable input ${input}`, async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    assert.equal((await f.run(true)).exitCode, 0);
    fs.appendFileSync(path.join(f.repoRoot, input), '\nchanged after RED\n');
    f.implement();
    assert.match(readRetainedExpectedRedRejection(f.options()) ?? '', /no longer current|changed|unavailable/iu);
});

test('retained RED verifies the original output hash after the implementation changes', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    assert.equal((await f.run(true)).exitCode, 0);
    const event = readTaskTimelineEvents(f.repoRoot, TASK).find(item => item.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED')!;
    fs.appendFileSync(String((event.details as Record<string, unknown>).output_artifact_path), 'tampered');
    f.implement();
    assert.match(readRetainedExpectedRedRejection(f.options()) ?? '', /output artifact size or sha256/u);
});

for (const input of [TARGET, SUPPORT, SOURCE]) test(`rejects mutation during RED execution of ${input}`, async t => {
    const f = fixture(input); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    await f.run(true);
    f.implement();
    assert.throws(() => readExpectedRedReviewObligations(f.options()), /changed during execution|expected-RED|source-content/iu);
});

test('a GREEN command with a different invocation cannot satisfy historical RED', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    assert.equal((await f.run(true)).exitCode, 0); f.implement();
    assert.equal((await f.run(false, `node ${RUNNER} --input ${TARGET} --other-command`)).exitCode, 0);
    assert.throws(() => readExpectedRedReviewObligations(f.options()), /GREEN|successful execution/u);
});
