import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand, runIntermediateCommandCommand, runCompileGateCommand, runLoadRulePackCommand } from '../../../../src/cli/commands/gates';
import { readValidationFile } from '../../../../src/core/project-validation-identity';
import { fileSha256 } from '../../../../src/gates/shared/helpers';
import { inspectReviewerFocusedValidationCommand, validateReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';
import { findReviewFocusedFindingTestPaths, detectMissingFocusedValidationEvidenceFailureReason } from '../../../../src/gates/next-step/next-step-review-artifact-failure-detection';
import { readFocusedTestRequiredByReview, readPostReviewFocusedIntermediateEvidence } from '../../../../src/gates/next-step/next-step-focused-intermediate-evidence';
import { buildTestFirstExpectedFailureRoute } from '../../../../src/gates/next-step/next-step-test-first-routing';
import { readExpectedRedExecutionEvidence, readExpectedRedReviewObligations } from '../../../../src/gates/test-first/expected-red-evidence';
import { readNativeCaseObligations } from '../../../../src/gates/review/native-case-semantics';
import { inspectQualityValidationPhases } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { taskCompileDeclaration } from '../../../../src/gates/compile/compile-gate';
import { runCliWithCapturedOutput } from '../../cli/commands/gate-test-cli-capture';
import { getProjectDiscovery } from '../../../../src/materialization/project-discovery';
import { genericBoundCommandTargets } from '../../../../src/core/task-validation-plan';
import { readImmutableValidationEventSnapshot } from '../../../../src/gates/project-validation/attempt-evidence';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../../cli/commands/gates/preflight/gates-preflight-fixtures';

const TASK = 'T-FALLBACKS';
const TARGETS = ['probes/Покупка.orbit', 'satellites/Refund.quasar'];

function matrix() {
    return [{ boundary_id: 'TB-ORBIT', boundary: 'Opaque runner to retained process evidence',
        authority_source: 'Current task and preflight', mutable_inputs: ['runner output'],
        integrity_evidence: ['Current source and process hashes'], canonical_reconstruction: 'Reconstruct the bound invocation.',
        toctou_replay: 'Reject stale source identities.', negative_paths: [{ kind: 'other', scenario: 'Payment isolation',
            expected_behavior: 'Isolate each payment.', evidence_files: TARGETS.map(target => `${target}#${target}`) }] }];
}

function fixture(testFirst = false, targets = TARGETS, adapter = false, baseline: Record<string, string> = {}) {
    const repoRoot = createTempRepo();
    for (const relative of ['package.json', 'src/app.ts', 'tests/app.test.ts']) {
        const file = path.join(repoRoot, relative);
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    if (adapter) fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'orbital-node-adapter',
        scripts: { test: `node --test ${targets.join(' ')}` } }));
    for (const [relative, content] of Object.entries(baseline)) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, relative)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, relative), content);
    }
    seedTaskQueue(repoRoot, TASK); seedInitAnswers(repoRoot);
    const configRoot = path.join(repoRoot, 'garda-agent-orchestrator/live/config');
    fs.mkdirSync(configRoot, { recursive: true });
    fs.copyFileSync(path.resolve('template/config/profiles.json'), path.join(configRoot, 'profiles.json'));
    fs.writeFileSync(path.join(configRoot, 'paths.json'), JSON.stringify({
        file_roles: Object.fromEntries(targets.map(target => [target, 'test'])) }));
    if (testFirst) {
        const queue = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').replace('| fixture |', '| Test-first: expected-red. |'));
    }
    initializeGitRepo(repoRoot);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK, entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2, taskSummary: 'Opaque validation of two task targets', provider: 'Codex' });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, TASK); runHandshakeForTask(repoRoot, TASK); runShellSmokeForTask(repoRoot, TASK);
    for (const target of targets) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, target)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, target), adapter
            ? "require('node:test')('isolates payment', () => require('node:assert/strict').equal(2, 2));\n" : 'isolates payment\n');
    }
    const runner = 'orbital-engine';
    // This is an invented runner protocol, with no test reporter or known extension.
    fs.writeFileSync(path.join(repoRoot, runner), "const fs = require('node:fs'); console.log('orbital observation'); process.exitCode = fs.existsSync('engine-ready') ? 0 : 7;\n");
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/task-events');
    const preflightPath = path.join(reviewsRoot, `${TASK}-preflight.json`);
    const classify = (changedFiles = targets) => {
        runClassifyChangeCommand({ repoRoot, taskId: TASK, taskIntent: 'Opaque validation of two task targets',
            changedFiles, outputPath: preflightPath });
        return JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    };
    const preflight = classify();
    if (!adapter) {
        const discovery = getProjectDiscovery(repoRoot);
        assert.deepEqual(discovery.suggestedCompileGateCommands, []);
        assert.equal(discovery.suggestedFullSuiteValidationCommand, null);
    }
    const command = `node ${adapter ? '--test' : runner} "${targets[0]}" "${targets[1]}"`;
    const sources = () => targets.map(source => ({ source_identity: readValidationFile(repoRoot, source).identity,
        case_id: source, selector: source, syntax_status: 'UNRESOLVED' as const }));
    const run = (expectFailure = false) => runIntermediateCommandCommand({ repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command, preflightPath, expectFailure });
    return { repoRoot, reviewsRoot, eventsRoot, preflightPath, preflight, command, sources, run, classify };
}

test('missing-focused recovery accepts arbitrary paths and both canonical marker forms', () => {
    for (const target of [...TARGETS, 'backend/src/test/java/PaymentTest.java', 'checks/test_payment.py']) {
        for (const [key, action] of [['test', 'run-and-record-focused-test'], ['target', 'run-and-record-focused-validation']]) {
            const marker = `[garda:evidence-only:missing-focused-validation] ${key}=${target}; action=${action}`;
            const markdown = `## Findings by Severity\n- High: ${marker}\n`;
            assert.deepEqual(findReviewFocusedFindingTestPaths(markdown), [target]);
            assert.equal(detectMissingFocusedValidationEvidenceFailureReason(markdown), 'missing auditable focused validation evidence');
        }
    }
    for (const target of ['../escape.orbit', '/outside.orbit', 'C:/outside.orbit', 'probes/../escape.orbit']) {
        assert.deepEqual(findReviewFocusedFindingTestPaths(`## Findings by Severity\n- High: [garda:evidence-only:missing-focused-validation] target=${target}; action=run-and-record-focused-validation`), []);
    }
});

test('focused validation binds two opaque targets and recovery requires all recorded targets', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(f.repoRoot, 'engine-ready'), 'ready');
    const reviewArtifactPath = path.join(f.reviewsRoot, 'missing-focused.md');
    fs.writeFileSync(reviewArtifactPath, '## Findings by Severity\n' + TARGETS.map(target =>
        `- High: [garda:evidence-only:missing-focused-validation] target=${target}; action=run-and-record-focused-validation`).join('\n'));
    assert.ok(readFocusedTestRequiredByReview({ taskId: TASK, reviewType: 'code', reviewArtifactPath }));
    const before = Date.now() - 1000;
    const evidence = () => readPostReviewFocusedIntermediateEvidence({ ...f, taskId: TASK, reviewType: 'code', reviewArtifactPath,
        reviewResultRecordedAtUtc: new Date(before).toISOString(), reviewerProvenanceTaskSequence: 0,
        changedFiles: TARGETS, expectedPreflightPath: f.preflightPath,
        expectedPreflightSha256: fileSha256(f.preflightPath) });
    const partial = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command: `node orbital-engine "${TARGETS[0]}"`, preflightPath: f.preflightPath });
    assert.equal(partial.exitCode, 0, partial.outputLines.join('\n'));
    assert.equal(evidence().available, false, 'One of two targets cannot close focused recovery.');
    const run = await f.run(); assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
    const inspection = inspectReviewerFocusedValidationCommand(f.command, f.repoRoot, TASK);
    assert.equal(inspection.syntax_supported, true, inspection.violations.join('\n'));
    assert.equal(evidence().available, true);
});

test('a failed opaque focused attempt declares both targets without granting a passed claim', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const run = await f.run(); assert.equal(run.exitCode, 7, run.outputLines.join('\n'));
    const inspection = inspectReviewerFocusedValidationCommand(f.command, f.repoRoot, TASK);
    assert.equal(inspection.syntax_supported, true, inspection.violations.join('\n'));
    assert.equal(inspection.process_passed, false);
    assert.deepEqual(inspection.targets, TARGETS);
    const hash = 'a'.repeat(64), evidence = [{ location: `${TARGETS[0]}:1`, observation: 'This changed test covers the task behavior.' }];
    const claimedPass = validateReviewFindingsReport({ schema_version: 2, task_id: TASK, review_type: 'code',
        review_context_sha256: hash, tree_state_sha256: hash,
        validation_notes: [{ id: 'N-001', topic: 'focused-self-validation', note: 'Attempted both task targets.',
            command: f.command, command_outcome: 'passed', diagnostics: 'The runner supposedly completed successfully.', evidence }],
        review_execution: { mode: 'FULL', contract_sha256: hash, covered_delta_targets: [], inspected_prior_finding_ids: [] },
        coverage_ledger: { coverage_contract_sha256: hash, entries: [{ obligation_id: 'FILE-001', result: 'no-finding', evidence, finding_ids: [] }] },
        findings: { critical: [], high: [], medium: [], low: [] }, residual_risks: [], reviewer_notes: []
    }, { repoRoot: f.repoRoot, expectedTaskId: TASK, expectedReviewType: 'code',
        expectedReviewContextSha256: hash, expectedTreeStateSha256: hash, expectedCoverageObligationIds: ['FILE-001'],
        expectedChangedFilePaths: TARGETS });
    assert.ok(claimedPass.violations.some(reason => reason.includes('requires a current authenticated successful process observation')),
        claimedPass.violations.join('\n'));
    const event = readImmutableValidationEventSnapshot(f.repoRoot, TASK).events.at(-1)!;
    const binding = event.details!.selected_case_binding;
    assert.deepEqual(genericBoundCommandTargets(f.command, binding, TARGETS), TARGETS);
    if (process.platform === 'win32') assert.deepEqual(
        genericBoundCommandTargets(f.command, binding, TARGETS.map(target => target.toLowerCase())), TARGETS);
    assert.deepEqual(genericBoundCommandTargets('orbital-engine other.target', binding, TARGETS), []);
    const tampered = structuredClone(binding) as { after: Array<unknown> };
    tampered.after[0] = null;
    assert.deepEqual(genericBoundCommandTargets(f.command, tampered, TARGETS), []);
});

test('a review may require an unchanged related target with an unfamiliar extension', async t => {
    const regression = 'archives/related.nebula';
    const f = fixture(false, TARGETS, false, { [regression]: 'related baseline regression\n' });
    t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(f.repoRoot, 'engine-ready'), 'ready');
    const reviewArtifactPath = path.join(f.reviewsRoot, 'regression.md');
    fs.writeFileSync(reviewArtifactPath, '## Findings by Severity\n- High: '
        + `[garda:evidence-only:missing-focused-validation] target=${regression}; action=run-and-record-focused-validation`);
    const before = new Date(Date.now() - 1000).toISOString();
    const command = `node orbital-engine ${regression}`;
    const run = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command, preflightPath: f.preflightPath });
    assert.equal(run.exitCode, 0, run.outputLines.join('\n'));
    assert.equal(readPostReviewFocusedIntermediateEvidence({ ...f, taskId: TASK, reviewType: 'code', reviewArtifactPath,
        reviewResultRecordedAtUtc: before, reviewerProvenanceTaskSequence: 0, changedFiles: TARGETS,
        expectedPreflightPath: f.preflightPath, expectedPreflightSha256: fileSha256(f.preflightPath) }).available, true);
    const explicit = await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command, preflightPath: f.preflightPath,
        selectedCases: [{ source: regression, case_id: 'related regression', selector: regression }] });
    assert.equal(explicit.exitCode, 0, explicit.outputLines.join('\n'));
    assert.equal(inspectReviewerFocusedValidationCommand(command, f.repoRoot, TASK).syntax_supported, true);
});

test('generic RED without a reporter retains two targets, then requires the same GREEN invocation', async t => {
    const f = fixture(true); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    assert.equal(f.preflight.scope_category, 'test-only');
    const route = () => buildTestFirstExpectedFailureRoute({ ...f, taskId: TASK,
        taskEntry: { taskId: TASK, status: 'TODO', area: 'test', title: 'opaque', profile: 'balanced', notes: 'Test-first: expected-red.' },
        preflightCommandPath: f.preflightPath, cliPrefix: 'garda', workspaceReady: true });
    assert.ok(route()?.commands.length, 'Generic RED must offer a runnable command template.');
    const red = await f.run(true); assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
    const options = { ...f, taskId: TASK, preflightSha256: fileSha256(f.preflightPath) };
    assert.equal(readExpectedRedExecutionEvidence(options)?.obligations.length, 2);
    assert.equal(route()?.nextGate, 'implementation');
    assert.throws(() => readExpectedRedReviewObligations(options), /GREEN|successful/u);
    fs.writeFileSync(path.join(f.repoRoot, 'engine-ready'), 'ready');
    assert.equal((await runIntermediateCommandCommand({ repoRoot: f.repoRoot, taskId: TASK,
        commandSource: 'targeted-test', command: f.command + ' --different-invocation', preflightPath: f.preflightPath })).exitCode, 0);
    assert.throws(() => readExpectedRedReviewObligations(options), /GREEN|successful/u);
    const green = await f.run(); assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
    const obligations = readExpectedRedReviewObligations(options);
    assert.equal(obligations.length, 4);
    assert.ok(obligations.every(item => item.result_status === 'UNRESOLVED'));
});

test('checklist cases bind opaque executions without a TAP report', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(f.repoRoot, 'engine-ready'), 'ready');
    assert.equal((await f.run()).exitCode, 0);
    const obligations = readNativeCaseObligations({ ...f, taskId: TASK, preflightSha256: fileSha256(f.preflightPath)!,
        scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources() });
    assert.equal(obligations.length, 2);
    assert.ok(obligations.every(item => item.execution === 'OBSERVED' && item.result_status === 'UNRESOLVED'));
    const phases = inspectQualityValidationPhases({ ...f, taskId: TASK, preflightSha256: fileSha256(f.preflightPath),
        matrixRequired: true, matrix: matrix() });
    assert.equal(phases?.phases.execution, 'OBSERVED', JSON.stringify(phases?.phases.execution_diagnostics));
    assert.equal(phases?.phases.obligations.length, 2);
});

test('mixed implementation scope cannot hide a newly added test without its own RED', async t => {
    const f = fixture(true); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const red = await f.run(true); assert.equal(red.exitCode, 0, red.outputLines.join('\n'));
    const extra = 'probes/added.test.cjs';
    fs.writeFileSync(path.join(f.repoRoot, extra), 'another declared regression\n');
    fs.writeFileSync(path.join(f.repoRoot, 'engine-ready'), 'implemented');
    const preflight = f.classify([...TARGETS, extra, 'engine-ready']);
    assert.equal(preflight.scope_category, 'mixed');
    const green = await f.run(); assert.equal(green.exitCode, 0, green.outputLines.join('\n'));
    assert.throws(() => readExpectedRedReviewObligations({ ...f, taskId: TASK,
        preflightSha256: fileSha256(f.preflightPath) }), /expected-RED|Expected-RED|expected-red/u);
});

test('the Node adapter also retains both declared targets as successful process evidence', async t => {
    const targets = ['probes/payment.test.cjs', 'satellites/refund.test.cjs'];
    const f = fixture(false, targets, true); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const result = await f.run(); assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    const inspected = inspectReviewerFocusedValidationCommand(f.command, f.repoRoot, TASK);
    assert.equal(inspected.syntax_supported, true, inspected.violations.join('\n'));
    const obligations = readNativeCaseObligations({ ...f, taskId: TASK, preflightSha256: fileSha256(f.preflightPath)!,
        scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources() });
    assert.equal(obligations.length, 2);
    assert.ok(obligations.every(item => item.execution === 'OBSERVED'));
});

test('compile N/A cannot mask a mandatory configured build or an unresolved declaration', () => {
    assert.throws(() => taskCompileDeclaration('', 'This interpreter has no separate compile phase.', 'orbital-build'), /mandatory/u);
    assert.throws(() => taskCompileDeclaration('orbital-build', 'This interpreter has no separate compile phase.', null), /not both/u);
    assert.throws(() => taskCompileDeclaration('', 'no', null), /Explain/u);
    assert.throws(() => taskCompileDeclaration('', '<why this stack has no separate compile phase>', null), /Explain/u);
    assert.throws(() => taskCompileDeclaration('<compile>', '', null), /placeholder/u);
    assert.deepEqual(taskCompileDeclaration('orbital-assemble --module payment', '', null),
        { kind: 'command', command: 'orbital-assemble --module payment' });
});

test('an unattempted opaque checklist stays pending with executable recovery', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    assert.throws(() => readNativeCaseObligations({ ...f, taskId: TASK, preflightSha256: fileSha256(f.preflightPath)!,
        scopeContentSha256: f.preflight.metrics.scope_content_sha256, sources: f.sources() }), /gate run-intermediate-command/u);
    const phases = inspectQualityValidationPhases({ ...f, taskId: TASK, preflightSha256: fileSha256(f.preflightPath),
        matrixRequired: true, matrix: matrix() });
    assert.equal(phases?.phases.structural, 'BOUND');
    assert.equal(phases?.phases.execution, 'PENDING');
});

test('compile accepts a task-local justified absence of a separate compile phase', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId: TASK, stage: 'POST_PREFLIGHT',
        preflightPath: f.preflightPath,
        loadedRuleFiles: ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'], emitMetrics: false });
    const result = await runCompileGateCommand({ repoRoot: f.repoRoot, taskId: TASK, preflightPath: f.preflightPath,
        ...{ compileNotApplicableReason: 'Orbital sources are interpreted by the selected runner; this stack has no separate compile phase.' } });
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    const record = JSON.parse(fs.readFileSync(path.join(f.reviewsRoot, `${TASK}-compile-gate.json`), 'utf8'));
    assert.equal(record.compile_command_source, 'task_local');
    assert.equal(record.compile_declaration.kind, 'not_applicable');
    assert.deepEqual(record.compile_commands, []);
});

test('compile CLI runs the task-local command and records its actual invocation', async t => {
    const f = fixture(); t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
    const helper = 'orbital-assembler';
    fs.writeFileSync(path.join(f.repoRoot, helper), "const fs=require('node:fs');fs.appendFileSync('.git/task-compile-runs','run\\n');console.log('orbital assembly complete');\n");
    runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId: TASK, stage: 'POST_PREFLIGHT', preflightPath: f.preflightPath,
        loadedRuleFiles: ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'], emitMetrics: false });
    const workflow = path.join(f.repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
    const before = fs.existsSync(workflow) ? fs.readFileSync(workflow) : null;
    const result = await runCliWithCapturedOutput(['gate', 'compile-gate', '--repo-root', f.repoRoot, '--task-id', TASK,
        '--preflight-path', f.preflightPath, '--compile-command', `node ${helper}`]);
    assert.equal(result.exitCode, 0, [...result.logs, ...result.errors].join('\n'));
    const record = JSON.parse(fs.readFileSync(path.join(f.reviewsRoot, `${TASK}-compile-gate.json`), 'utf8'));
    assert.equal(record.compile_command_source, 'task_local');
    assert.deepEqual(record.compile_declaration, { kind: 'command', command: `node ${helper}` });
    assert.equal(record.invocation_executions[0].exit_code, 0);
    assert.deepEqual(record.invocation_executions[0].argv, [helper]);
    assert.deepEqual(fs.existsSync(workflow) ? fs.readFileSync(workflow) : null, before);
    const repeated = await runCliWithCapturedOutput(['gate', 'compile-gate', '--repo-root', f.repoRoot, '--task-id', TASK,
        '--preflight-path', f.preflightPath]);
    assert.equal(repeated.exitCode, 0, [...repeated.logs, ...repeated.errors].join('\n'));
    assert.equal(fs.readFileSync(path.join(f.repoRoot, '.git/task-compile-runs'), 'utf8'), 'run\nrun\n',
        'The retained declaration executes again; an old PASS cannot replace the process.');
    assert.deepEqual(fs.existsSync(workflow) ? fs.readFileSync(workflow) : null, before);
    fs.writeFileSync(path.join(f.repoRoot, helper), "console.error('required assembly failed'); process.exitCode = 9;\n");
    f.classify([...TARGETS, helper]);
    runLoadRulePackCommand({ repoRoot: f.repoRoot, taskId: TASK, stage: 'POST_PREFLIGHT', preflightPath: f.preflightPath,
        loadedRuleFiles: ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'], emitMetrics: false });
    const failed = await runCompileGateCommand({ repoRoot: f.repoRoot, taskId: TASK,
        preflightPath: f.preflightPath, compileCommand: `node ${helper}` });
    assert.notEqual(failed.exitCode, 0, failed.outputLines.join('\n'));
    const waiver = await runCompileGateCommand({ repoRoot: f.repoRoot, taskId: TASK, preflightPath: f.preflightPath,
        compileNotApplicableReason: 'The interpreted stack has no separate compile phase.' });
    assert.notEqual(waiver.exitCode, 0, 'N/A must not erase the failed required task-local compile.');
    assert.match(waiver.outputLines.join('\n'), /failed required compile/u);
});
