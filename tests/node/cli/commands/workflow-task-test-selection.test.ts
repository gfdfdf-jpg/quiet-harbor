import { readRecordedOutOfScopeFailures, recordedOutOfScopeNotice } from '../../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { materializeRecordedOutOfScopeFollowUps, recordedOutOfScopeFollowUpViolations } from '../../../../src/gates/full-suite/recorded-out-of-scope-follow-ups';
import { formatCompletionGateResult } from '../../../../src/gates/completion/completion-reporting';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withInvocationGitReadObservation } from '../../../../src/core/invocation-git-observation';
import { withNextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { buildDefaultWorkflowConfig, normalizeOptionalQualityChecksConfig } from '../../../../src/core/workflow-config';
import { resolveWorkflowRoots } from '../../../../src/cli/commands/workflow/workflow-command-state';
import { assertTaskTestSelectionCurrent, resolveTaskTestSelectionAuthority } from '../../../../src/cli/commands/workflow/workflow-command-task-test-selection';
import { writeWorkflowConfigAuditRecord } from '../../../../src/cli/commands/workflow/workflow-command-mutation';
import { appendMandatoryTaskEvent, readTaskTimelineJsonlEntries } from '../../../../src/gate-runtime/task-events';
import { getTaskModeEvidence } from '../../../../src/gates/task-mode';
import { getCurrentWorkflowConfigChanges, getWorkflowConfigWorkViolations } from '../../../../src/gates/workflow-config/workflow-config-work';
import { writeProtectedControlPlaneManifest } from '../../../../src/gates/shared/helpers';
import { createTempRepo, initializeGitRepo, loadPostPreflightRulePack, loadTaskEntryRulePack, runClassifyChangeCommand,
    runEnterTaskMode, runGit, runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, writeBalancedProfilesConfig } from './gate-test-helpers';
import { buildOperatorConfirmationArgs } from './operator-confirmation-test-helpers';
import { runCompileGateCommand, runFullSuiteValidationCommand } from '../../../../src/cli/commands/gates';
import { getFullSuiteTestSelectionViolations } from '../../../../src/gates/full-suite/full-suite-test-selection';
import { buildTaskTestSelectionCommand } from '../../../../src/gates/next-step/next-step-full-suite-routing';
import { parseCommandChain } from '../../../../src/core/command-line';
import { validationDigest } from '../../../../src/core/project-validation-identity';
import { loadTaskFullSuiteConfig } from '../../../../src/gates/full-suite/task-full-suite-config';
import { taskTestExecutionProofSatisfied } from '../../../../src/gates/full-suite/task-test-execution-proof';
import { resolveNextStep } from '../../../../src/gates/next-step/next-step';
import { buildFullSuiteValidationEvidence } from '../../../../src/gates/review-context/review-context-validation-evidence';
import { fileSha256 } from '../../../../src/gate-runtime/hash';
import { collectFullSuiteValidationEvidence } from '../../../../src/gates/completion/completion-full-suite-evidence';
import { collectOrderedTimelineEvents } from '../../../../src/gates/completion/completion-evidence';
import { buildReportTaskDetail } from '../../../../src/reports/report-data/task-detail';
import { parseCanonicalActiveTaskQueue, replaceTaskMdTableCell } from '../../../../src/core/task-md-table';
import { isExpectedRedTestScope } from '../../../../src/gates/test-first/expected-red-scope';
import { checkRequiredReviews, validatePreflightForReview } from '../../../../src/gates/required-reviews/required-reviews-check';
import { runCompletionGate } from '../../../../src/gates/completion';

const TASK_ID = 'T-TEST-SELECTION-1';
const TARGET = 'tests/widget.test.js';
const SECOND_TARGET = 'tests/widget-regression.test.js';
const SOURCE = 'src/widget.js';
const HELD_TASK_ID = 'T-TEST-SELECTION-HELD';
const HELD_SOURCE = 'src/held-widget.js';
const HELD_TARGET = 'tests/held-widget.test.js';
const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

function capture<T>(run: () => T): T {
    const log = console.log;
    console.log = () => undefined;
    try { return run(); } finally { console.log = log; }
}

function fixture(options: { prompt?: boolean; legacy?: boolean; enabled?: boolean; heldOwner?: boolean; noPlanned?: boolean; disableQuality?: boolean; unrelatedFailure?: boolean; afterCompile?: boolean; broadConfigured?: boolean; suppressTestReview?: boolean } = {}) {
    const root = createTempRepo();
    const bundle = path.join(root, 'garda-agent-orchestrator');
    const configPath = path.join(bundle, 'live/config/workflow-config.json');
    const originalCwd = process.cwd();
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, SOURCE), 'export const widget = 1;\n');
    fs.writeFileSync(path.join(root, HELD_SOURCE), 'export const heldWidget = 2;\n');
    fs.writeFileSync(path.join(root, HELD_TARGET), "require('node:test').test('held widget', () => {});\n");
    for (const target of [TARGET, SECOND_TARGET]) {
        fs.writeFileSync(path.join(root, target), "const test = require('node:test'); const assert = require('node:assert/strict'); test('widget', () => assert.equal(1, 1));\n");
    }
    if (options.unrelatedFailure) fs.writeFileSync(path.join(root, SECOND_TARGET), "require('node:test').test('ModuleBoundaryTest', () => { throw new Error('module debt'); });\n");
    fs.writeFileSync(path.join(root, 'TASK.md'), '# Tasks\n\n## Active Queue\n\n'
        + '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n'
        + '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
        + `| ${TASK_ID} | 🟦 TODO | P1 | app | Update widget behavior | fixture | 2026-10-07 | balanced | fixture |\n`);
    fs.writeFileSync(path.join(root, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# routed workflow fixture\n');
    seedInitAnswers(root);
    writeBalancedProfilesConfig(root);
    if (options.suppressTestReview) {
        const profilesPath = path.join(bundle, 'live/config/profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
        profiles.built_in_profiles.balanced.review_policy.test = false;
        fs.writeFileSync(profilesPath, JSON.stringify(profiles));
    }
    const config = buildDefaultWorkflowConfig();
    config.optional_quality_checks = normalizeOptionalQualityChecksConfig(config.optional_quality_checks);
    if (options.disableQuality) config.optional_quality_checks.enabled = false;
    config.full_suite_validation.enabled = options.enabled !== false;
    if (options.afterCompile) config.full_suite_validation.placement = 'after_compile_before_reviews';
    if (options.noPlanned) {
        config.compile_gate.command = `node --check ${TARGET}`;
        config.full_suite_validation.command = `node --test ${SECOND_TARGET}`;
    }
    if (options.broadConfigured) config.full_suite_validation.command = `node --test ${TARGET} ${SECOND_TARGET}`;
    config.task_test_selection.require_operator_confirmation = options.prompt === true;
    const input: Record<string, unknown> = { ...config };
    if (options.legacy) delete input.task_test_selection;
    fs.writeFileSync(configPath, JSON.stringify(input, null, 2) + '\n');
    initializeGitRepo(root);
    writeProtectedControlPlaneManifest(root);
    process.chdir(root);
    try {
        if (options.heldOwner) {
            fs.appendFileSync(path.join(root, 'TASK.md'), `| ${HELD_TASK_ID} | TODO | P1 | app | Preserve held widget | fixture | 2026-10-07 | balanced | HUMAN HOLD: preserve existing source. |\n`);
            const owner = capture(() => runEnterTaskMode({ repoRoot: root, taskId: HELD_TASK_ID,
                entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: '2', taskSummary: 'Preserve the held owner scope.',
                plannedChangedFiles: [HELD_SOURCE, HELD_TARGET] }));
            assert.equal(owner.exitCode, 0, owner.outputLines.join('\n'));
        }
        const entry = capture(() => runEnterTaskMode({ repoRoot: root, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: '2', taskSummary: 'Update widget behavior and its owning tests.',
            ...(options.noPlanned ? {} : { plannedChangedFiles: [SOURCE, TARGET] }),
            ...(options.heldOwner ? { allowedActiveTasks: [HELD_TASK_ID], operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString() } : {}) }));
        assert.equal(entry.exitCode, 0);
    } catch (error) {
        process.chdir(originalCwd);
        fs.rmSync(root, { recursive: true, force: true });
        throw error;
    }
    const result = { root, bundle, configPath, config,
        timeline: path.join(bundle, 'runtime/task-events', `${TASK_ID}.jsonl`),
        cleanup() { process.chdir(originalCwd); fs.rmSync(root, { recursive: true, force: true }); } };
    if (!options.noPlanned && options.enabled !== false) prepareChangedTestPreflight(result);
    return result;
}

function prepareChangedTestPreflight(f: ReturnType<typeof fixture>, newTarget?: string): string {
    assert.equal(capture(() => loadTaskEntryRulePack(f.root, TASK_ID)).exitCode, 0);
    capture(() => runHandshakeForTask(f.root, TASK_ID));
    capture(() => runShellSmokeForTask(f.root, TASK_ID));
    if (newTarget) fs.writeFileSync(path.join(f.root, newTarget), "require('node:test').test('new test', () => {});\n");
    else fs.appendFileSync(path.join(f.root, TARGET), '// current task test change\n');
    return classifyCurrent(f);
}

function classifyCurrent(f: ReturnType<typeof fixture>): string {
    assert.equal(capture(() => loadTaskEntryRulePack(f.root, TASK_ID)).exitCode, 0);
    capture(() => runHandshakeForTask(f.root, TASK_ID));
    capture(() => runShellSmokeForTask(f.root, TASK_ID));
    const preflightPath = path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-preflight.json`);
    capture(() => runClassifyChangeCommand({ repoRoot: f.root, taskId: TASK_ID,
        taskIntent: 'Update widget behavior and its owning tests.', includeUntracked: true,
        outputPath: preflightPath, emitMetrics: false }));
    return preflightPath;
}

function selector(root: string, options: { command?: string; targets?: string[]; reason?: string; extra?: string[] } = {}) {
    return ['set', '--target-root', root, '--task-id', TASK_ID,
        '--reason', options.reason ?? `${TASK_ID} ${TARGET} covers ${SOURCE} behavior`,
        '--full-suite-command', options.command ?? `node --test ${TARGET}`,
        ...(options.targets ?? [TARGET]).flatMap(target => ['--focused-required-test-path', target]),
        ...(options.extra ?? [])];
}

function select(root: string, options?: Parameters<typeof selector>[1]) {
    return capture(() => handleWorkflow(selector(root, options), PACKAGE_JSON));
}

test('product targets are refused as tests while unknown-stack test targets remain selectable', () => {
    const f = fixture();
    try {
        for (const product of [SOURCE, 'src/engine.qz']) {
            fs.appendFileSync(path.join(f.root, product), '// changed product\n');
            classifyCurrent(f);
            assert.throws(() => select(f.root, { command: `quartz-run ${product} ${TARGET}`, targets: [product, TARGET],
                reason: `${TASK_ID} verifies ${product} behavior` }), /product code.*test target.*focused-required-test-path/isu);
        }
        fs.mkdirSync(path.join(f.root, 'qa'), { recursive: true });
        const target = 'qa/engine.qt';
        fs.writeFileSync(path.join(f.root, target), 'assert engine behavior\n');
        classifyCurrent(f);
        const accepted = select(f.root, { command: `quartz-run ${target} ${TARGET}`, targets: [target, TARGET],
            reason: `${TASK_ID} verifies ${SOURCE} behavior` });
        assert.ok(accepted && accepted.action === 'set');
    } finally { f.cleanup(); }
});

test('expected RED cannot hide a changed product file behind a target or fixture mapping', () => {
    const f = fixture();
    try {
        fs.appendFileSync(path.join(f.root, SOURCE), '// product implementation changed\n');
        const preflightPath = classifyCurrent(f);
        const selection = select(f.root, { extra: ['--task-test-plan', JSON.stringify({
            support: [{ path: SOURCE, role: 'fixture', targets: [TARGET] }] })] });
        assert.ok(selection && selection.action === 'set');
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.equal(isExpectedRedTestScope(preflight, f.root, TASK_ID, [SOURCE, TARGET]), false);
        assert.equal(isExpectedRedTestScope({ ...preflight, scope_category: 'test-only', declared_test_paths: [SOURCE, TARGET] },
            f.root, TASK_ID), false);
    } finally { f.cleanup(); }
});

for (const mapping of ['symbolic', 'support'] as const) {
    test(`${mapping} mapping requires test review at classification, review gate and completion`, () => {
        const f = fixture({ noPlanned: true, suppressTestReview: true });
        try {
            fs.appendFileSync(path.join(f.root, SOURCE), '// changed product behavior\n');
            if (mapping === 'support') fs.appendFileSync(path.join(f.root, SECOND_TARGET), '// changed runnable test claimed as fixture\n');
            const preflightPath = classifyCurrent(f);
            const plan = mapping === 'symbolic'
                ? { targets: [{ path: TARGET, entrypoint: 'check', reason: 'Runs unchanged widget regression.' }] }
                : { support: [{ path: SECOND_TARGET, role: 'fixture', targets: [TARGET] }] };
            const selected = select(f.root, { command: mapping === 'symbolic' ? 'make check' : `node --test ${TARGET}`,
                reason: `${TASK_ID} ${TARGET} verifies ${SOURCE} behavior`, extra: ['--task-test-plan', JSON.stringify(plan)] });
            assert.ok(selected && selected.action === 'set');
            if (mapping === 'support') assert.deepEqual(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.plan?.support.map(item => item.path), [SECOND_TARGET]);
            // Old preflights (or policies suppressing the lane) cannot bypass either consumer.
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
            assert.equal(preflight.required_reviews.test, false);
            const validated = validatePreflightForReview(preflightPath, TASK_ID);
            const review = checkRequiredReviews({ repoRoot: f.root, validatedPreflight: { ...validated,
                required_reviews: { ...validated.required_reviews, test: false } }, preflightPayload: preflight });
            assert.match(review.violations.join('\n'), /semantic.*test review.*restart-coherent-cycle/isu);
            const completion = runCompletionGate({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
            assert.match(completion.violations.join('\n'), /semantic.*test review.*restart-coherent-cycle/isu);
            // A native refresh incorporates the requirement into the frozen review snapshot.
            classifyCurrent(f);
            const refreshed = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
            assert.equal(refreshed.required_reviews.test, true);
            assert.equal(refreshed.effective_review_snapshot.required_reviews.test, true);
        } finally { f.cleanup(); }
    });
}

test('native compile gate refuses a narrower task command than configured mandatory compilation', async () => {
    const f = fixture({ noPlanned: true });
    try {
        const preflightPath = prepareChangedTestPreflight(f);
        assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
        const refused = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath,
            compileCommand: `node --check ${SOURCE}`, emitMetrics: false });
        assert.notEqual(refused.exitCode, 0);
        assert.match(refused.outputLines.join('\n'), /configured mandatory compile command.*--compile-command/isu);
        const accepted = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath,
            compileCommand: f.config.compile_gate.command, emitMetrics: false });
        assert.equal(accepted.exitCode, 0, accepted.outputLines.join('\n'));
    } finally { f.cleanup(); }
});

test('without planned files a current changed test is selected and native validation proceeds', async () => {
    const f = fixture({ noPlanned: true });
    try {
        let preflightPath = prepareChangedTestPreflight(f);
        const before = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.deepEqual(before.changed_files, [TARGET]);
        assert.equal(getFullSuiteTestSelectionViolations(f.root, f.config.full_suite_validation.command, before.changed_files).length, 1);
        const routed = buildTaskTestSelectionCommand('node garda.js', TASK_ID, [TARGET], false)
            .replace('<command that runs only this task\'s tests and required regressions>', `node --test ${TARGET}`)
            .replace('<task behavior and regression relationships>', 'the current widget test behavior');
        const result = capture(() => handleWorkflow(parseCommandChain(routed)[0].slice(3), PACKAGE_JSON));
        assert.ok(result && result.action === 'set' && result.audit_path);
        const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8').trim().split('\n').at(-1)!).details;
        assert.match(audit.task_test_selection_authority.preflight_sha256, /^[a-f0-9]{64}$/u);
        assert.deepEqual(getFullSuiteTestSelectionViolations(f.root, `node --test ${TARGET}`, before.changed_files), []);
        preflightPath = classifyCurrent(f);
        assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
        const compile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        const suite = await runFullSuiteValidationCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
        assert.equal(suite.exitCode, 0, suite.outputText);
    } finally { f.cleanup(); }
});

test('a module command is task-scoped, runs in the gate, and expires when changed tests differ',
    { skip: process.platform !== 'win32' }, async () => {
        const f = fixture({ noPlanned: true, disableQuality: true });
        try {
            const target = 'backend/application/src/test/java/example/PartnerIsolationPostgresIntegrationTest.java';
            const other = 'backend/application/src/test/java/example/OtherIntegrationTest.java';
            fs.mkdirSync(path.dirname(path.join(f.root, target)), { recursive: true });
            fs.mkdirSync(path.join(f.root, 'backend/other'), { recursive: true });
            fs.writeFileSync(path.join(f.root, 'backend/pom.xml'), '<project><modules><module>application</module><module>other</module></modules></project>');
            fs.writeFileSync(path.join(f.root, 'backend/application/pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(f.root, 'backend/other/pom.xml'), '<project></project>');
            fs.appendFileSync(path.join(f.root, '.gitignore'), '\n**/target/\n');
            fs.writeFileSync(path.join(f.root, 'backend/write-report.cjs'), `const fs = require('node:fs'); if (fs.existsSync('garda-agent-orchestrator/runtime/maven-proof-enabled')) { fs.mkdirSync('backend/application/target/surefire-reports', {recursive:true}); fs.writeFileSync('backend/application/target/surefire-reports/TEST-example.PartnerIsolationPostgresIntegrationTest.xml', '<testsuite><testcase classname="example.PartnerIsolationPostgresIntegrationTest" name="regression" time="' + process.hrtime.bigint() + '"/></testsuite>'); }\n`);
            fs.writeFileSync(path.join(f.root, 'backend/mvnw.cmd'), '@echo off\r\necho %* > garda-agent-orchestrator\\runtime\\maven-invocation.txt\r\nnode backend/write-report.cjs\r\n');
            fs.writeFileSync(path.join(f.root, target), 'package example; class PartnerIsolationPostgresIntegrationTest {}\n');
            assert.equal(capture(() => loadTaskEntryRulePack(f.root, TASK_ID)).exitCode, 0);
            capture(() => runHandshakeForTask(f.root, TASK_ID));
            capture(() => runShellSmokeForTask(f.root, TASK_ID));
            let preflightPath = classifyCurrent(f);
            const configBefore = fs.readFileSync(f.configPath);
            assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
            const initialCompile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
            assert.equal(initialCompile.exitCode, 0, initialCompile.outputLines.join('\n'));
            const selectionRoute = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
            assert.equal(selectionRoute.next_gate, 'task-test-selection', JSON.stringify(selectionRoute));
            assert.match(selectionRoute.commands[0].command, /workflow set.*--task-id.*--focused-required-test-path/u);
            assert.ok(!selectionRoute.commands[0].command.includes(f.config.full_suite_validation.command));
            assert.ok(selectionRoute.reason.includes(f.config.full_suite_validation.command));
            assert.ok(selectionRoute.commands[0].command.includes(target));
            const command = 'backend/mvnw.cmd -f backend/pom.xml -pl application -am -Dtest=PartnerIsolationPostgresIntegrationTest verify';
            const reason = `${TASK_ID} verifies partner isolation behavior`;
            for (const invalid of [
                'backend/mvnw.cmd -f backend/pom.xml -pl other -am verify',
                command.replace('PartnerIsolationPostgresIntegrationTest', 'OtherTest'),
                'backend/mvnw.cmd -f backend/pom.xml -pl application -am package'
            ]) assert.throws(() => select(f.root, { command: invalid, targets: [target], reason }), /rejected/i, invalid);
            const selection = select(f.root, { command, targets: [target], reason });
            assert.ok(selection && selection.action === 'set');
            assert.deepEqual(fs.readFileSync(f.configPath), configBefore);
            assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).config.command, command);
            assert.equal(loadTaskFullSuiteConfig(f.root, 'T-OTHER-TASK').config.command, f.config.full_suite_validation.command);
            assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
            const compile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
            assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
            const missingProof = await runFullSuiteValidationCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
            assert.equal(missingProof.exitCode, 0, 'Generic process PASS does not require an adapter report');
            assert.match(missingProof.outputText, /Maven adapter finding/u);
            fs.writeFileSync(path.join(f.bundle, 'runtime/maven-proof-enabled'), 'enabled');
            const suite = await runFullSuiteValidationCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
            assert.equal(suite.exitCode, 0, suite.outputText);
            assert.match(fs.readFileSync(path.join(f.bundle, 'runtime/maven-invocation.txt'), 'utf8'), /-pl application -am -Dtest=PartnerIsolationPostgresIntegrationTest verify/u);
            const artifact = JSON.parse(fs.readFileSync(path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-full-suite-validation.json`), 'utf8'));
            assert.equal(artifact.command, command);
            assert.equal(artifact.command_provenance.source, 'task_scoped_test_selection');
            assert.equal(artifact.task_test_execution_proof.length, 1);
            const review = buildFullSuiteValidationEvidence({ repoRoot: f.root, taskId: TASK_ID, reviewType: 'test',
                preflightPath, preflightSha256: fileSha256(preflightPath) });
            assert.equal(review?.command, command);
            assert.equal(review?.cycle_binding_valid, true, review?.mismatch_reason || '');
            const detail = buildReportTaskDetail({ repoRoot: f.root, taskId: TASK_ID });
            assert.equal(detail.full_suite_validation.command, command);
            assert.equal(detail.full_suite_validation.freshness, 'current');
            const errors: string[] = [];
            const completedSuite = collectFullSuiteValidationEvidence({ enabled: true, required: true,
                reviewsRoot: path.join(f.bundle, 'runtime/reviews'), taskId: TASK_ID, repoRoot: f.root,
                timelinePath: f.timeline, orderedEvents: collectOrderedTimelineEvents(f.timeline, errors),
                expectedPreflightPath: preflightPath, expectedPreflightSha256: fileSha256(preflightPath)!,
                expectedCompileGateTimestamp: artifact.cycle_binding.compile_gate_timestamp,
                expectedCommand: loadTaskFullSuiteConfig(f.root, TASK_ID).config.command,
                fullSuiteNotRequiredForDocsOnly: false, errors });
            assert.equal(completedSuite.status, 'PASSED');
            assert.deepEqual(errors, []);
            fs.writeFileSync(path.join(f.root, other), 'class OtherIntegrationTest {}\n');
            preflightPath = classifyCurrent(f);
            assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'stale');
            assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
            const recompile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
            assert.equal(recompile.exitCode, 0, recompile.outputLines.join('\n'));
            const route = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
            assert.equal(route.next_gate, 'task-test-selection', JSON.stringify(route));
            assert.ok(route.commands.some(item => item.command.includes('--focused-required-test-path') && item.command.includes(other)));
            assert.deepEqual(fs.readFileSync(f.configPath), configBefore);
        } finally { f.cleanup(); }
    });

test('without planned files an added untracked test is a current task target', () => {
    const f = fixture({ noPlanned: true });
    try {
        const target = 'tests/new-widget.test.js';
        const preflightPath = prepareChangedTestPreflight(f, target);
        assert.deepEqual(JSON.parse(fs.readFileSync(preflightPath, 'utf8')).changed_files, [target]);
        const result = select(f.root, { command: `node --test ${target}`, targets: [target],
            reason: `${TASK_ID} verifies the new widget behavior` });
        assert.ok(result && result.action === 'set' && result.audit_path);
        const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8').trim().split('\n').at(-1)!).details;
        assert.match(audit.task_test_selection_authority.preflight_sha256, /^[a-f0-9]{64}$/u);
    } finally { f.cleanup(); }
});

test('explicitly keeping the configured command needs one selection and survives an unchanged preflight', async () => {
    const f = fixture({ noPlanned: true, disableQuality: true });
    try {
        fs.appendFileSync(path.join(f.root, SOURCE), '// Task source-only change.\n');
        classifyCurrent(f);
        const before = fs.readFileSync(f.configPath);
        assert.throws(() => select(f.root, { command: f.config.full_suite_validation.command, targets: [],
            reason: `${TASK_ID} verifies the widget behavior against the configured regression suite` }), /at least one/u);
        const result = select(f.root, { command: f.config.full_suite_validation.command, targets: [SECOND_TARGET],
            reason: `${TASK_ID} ${SECOND_TARGET} verifies ${SOURCE} against the configured regression suite` });
        assert.ok(result && result.action === 'set');
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
        classifyCurrent(f);
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        assert.throws(() => select(f.root, { command: 'node --test --test-skip-pattern=widget tests/another.test.js',
            targets: [], reason: `${TASK_ID} verifies widget regressions` }), /at least one/i);
        const preflightPath = path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-preflight.json`);
        assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
        const compile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        const suite = await runFullSuiteValidationCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
        assert.equal(suite.exitCode, 0, suite.outputText);
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        fs.writeFileSync(path.join(f.root, 'README.md'), '# Current task documentation\n');
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current',
            'An ordinary documentation extension preserves the task selection on unchanged code.');
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        fs.appendFileSync(path.join(f.root, SOURCE), '// A production edit still expires the selection.\n');
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'stale',
            'A documentation extension cannot hide a simultaneous production edit.');
    } finally { f.cleanup(); }
});

async function nativeSuite(input: Parameters<typeof runFullSuiteValidationCommand>[0]) {
    const context = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try { return await runFullSuiteValidationCommand(input); }
    finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
}

test('authenticated legacy selection projects facts and fresh execution records the common process contract without rewriting history', async () => {
    const f = fixture({ disableQuality: true, noPlanned: true, afterCompile: true });
    try {
        prepareChangedTestPreflight(f);
        select(f.root);
        const event = readTaskTimelineJsonlEntries(f.timeline).filter(entry => entry.record?.event_type === 'TASK_TEST_SELECTION_RECORDED').at(-1)!;
        const authority = structuredClone((event.record!.details as Record<string, unknown>).task_test_selection_authority) as Record<string, unknown>;
        delete authority.validation_plan;
        appendMandatoryTaskEvent(f.bundle, TASK_ID, 'TASK_TEST_SELECTION_RECORDED', 'PASS', 'Historical selection fixture.',
            { task_test_selection_authority: authority }, { actor: 'task-selection-command' });
        const oldBytes = fs.readFileSync(f.timeline, 'utf8');
        const selected = loadTaskFullSuiteConfig(f.root, TASK_ID).selection;
        assert.equal(selected.status, 'current'); assert.equal(selected.plan, undefined); assert.ok(selected.legacyPlan);
        const preflightPath = path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-preflight.json`);
        assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
        const compile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        const run = await nativeSuite({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
        assert.equal(run.exitCode, 0, run.outputText);
        const artifact = JSON.parse(fs.readFileSync(path.join(f.bundle, `runtime/reviews/${TASK_ID}-full-suite-validation.json`), 'utf8'));
        assert.equal(artifact.task_test_process_evidence.selection_sha256, validationDigest(selected.legacyPlan));
        assert.equal(artifact.task_test_process_evidence.invocations.length, 1);
        assert.ok(fs.readFileSync(f.timeline, 'utf8').startsWith(oldBytes));
        const review = buildFullSuiteValidationEvidence({ repoRoot: f.root, taskId: TASK_ID, reviewType: 'test', preflightPath,
            preflightSha256: fileSha256(preflightPath) });
        assert.equal(review?.cycle_binding_valid, true, JSON.stringify(review));
        assert.equal(review?.validation_plan_origin, 'authenticated_legacy_projection');
    } finally { f.cleanup(); }
});

for (const failure of ['selected method', 'earlier reactor module'] as const) {
    test(`Maven ${failure} failure retains remediation without successful proof, then accepts the fixed rerun`,
        { skip: process.platform !== 'win32' }, async () => {
            const f = fixture({ noPlanned: true, disableQuality: true, afterCompile: true });
            try {
                const target = 'backend/application/src/test/java/example/StatusTest.java';
                const report = 'backend/application/target/surefire-reports/TEST-example.StatusTest.xml';
                const outside = 'backend/upstream/src/test/java/example/DependencyTest.java';
                fs.mkdirSync(path.dirname(path.join(f.root, target)), { recursive: true });
                fs.mkdirSync(path.dirname(path.join(f.root, outside)), { recursive: true });
                fs.writeFileSync(path.join(f.root, 'backend/pom.xml'), '<project><modules><module>upstream</module><module>application</module></modules></project>');
                for (const module of ['application', 'upstream']) fs.writeFileSync(path.join(f.root, 'backend', module, 'pom.xml'), '<project/>');
                fs.writeFileSync(path.join(f.root, outside), 'package example; class DependencyTest {}\n');
                const runner = `const fs = require('node:fs');
const fixed = fs.readFileSync('${target}', 'utf8').includes('// fixed');
if (!fixed && ${failure === 'earlier reactor module'}) {
    console.error('FAIL ${outside}:1 DependencyTest: reactor stopped before application'); process.exitCode = 1;
} else {
    fs.mkdirSync('backend/application/target/surefire-reports', {recursive:true});
    fs.writeFileSync('${report}', '<testsuite><testcase classname="example.StatusTest" name="status" time="' + process.hrtime.bigint() + '">' + (fixed ? '' : '<failure message="wrong status"/>') + '</testcase></testsuite>');
    if (!fixed) { console.error('FAIL ${target}:1 StatusTest#status: wrong status'); process.exitCode = 1; }
}
`;
                fs.writeFileSync(path.join(f.root, 'backend/check-status.cjs'), runner);
                fs.writeFileSync(path.join(f.root, 'backend/mvnw.cmd'), '@echo off\r\nnode backend/check-status.cjs\r\n');
                fs.appendFileSync(path.join(f.root, '.gitignore'), '\n**/target/\n');
                assert.equal(runGit(f.root, ['add', 'backend', '.gitignore']).status, 0);
                assert.equal(runGit(f.root, ['commit', '-qm', 'Seed disposable Maven reactor']).status, 0);
                fs.writeFileSync(path.join(f.root, target), 'package example; class StatusTest {} // failing status\n');
                let preflightPath = classifyCurrent(f);
                const command = 'backend/mvnw.cmd -f backend/pom.xml -pl application -am -Dtest=StatusTest verify';
                const choose = () => select(f.root, { command, targets: [target], reason: `${TASK_ID} verifies the changed StatusTest behavior` });
                choose();
                const compile = async () => {
                    assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
                    const result = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
                    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
                };
                await compile();
                const suitePath = path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-full-suite-validation.json`);
                const failed = await nativeSuite({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
                assert.notEqual(failed.exitCode, 0, failed.outputText);
                const artifact = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
                assert.equal(artifact.status, 'FAILED');
                assert.equal(taskTestExecutionProofSatisfied(command, [target], artifact.task_test_execution_proof), false);
                assert.equal(artifact.out_of_scope_failure_detected, failure === 'earlier reactor module');
                const route = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
                assert.equal(route.next_gate, failure === 'selected method' ? 'implementation' : 'task-test-selection', route.reason);
                if (failure === 'earlier reactor module') {
                    assert.match(route.reason, /DependencyTest.*entire failed run/su);
                    assert.ok(route.commands.some(item => item.command.includes('materialize-full-suite-repair-task')));
                } else assert.match(route.reason, /already failed.*fix the failures in the selected task tests/su);
                fs.appendFileSync(path.join(f.root, target), '// fixed\n');
                preflightPath = classifyCurrent(f);
                choose();
                await compile();
                const passed = await nativeSuite({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
                assert.equal(passed.exitCode, 0, passed.outputText);
                const accepted = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
                assert.equal(accepted.status, 'PASSED');
                assert.equal(taskTestExecutionProofSatisfied(command, [target], accepted.task_test_execution_proof), true);
                const next = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
                assert.notEqual(next.next_gate, 'full-suite-validation', next.reason);
                assert.notEqual(next.next_gate, 'implementation', next.reason);
                assert.notEqual(next.next_gate, 'task-test-selection', next.reason);
                delete accepted.task_test_process_evidence;
                fs.writeFileSync(suitePath, JSON.stringify(accepted));
                const withoutProof = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
                assert.equal(withoutProof.next_gate, 'full-suite-validation', withoutProof.reason);
            } finally { f.cleanup(); }
        });
}

for (const enabled of [true, false]) {
    test(`navigation probes 100 changed tests ${enabled ? 'once when required' : 'never when the gate is disabled'}`, async () => {
        const f = fixture({ noPlanned: true, disableQuality: true, afterCompile: true, enabled });
        const native = require('node:fs') as { existsSync: typeof fs.existsSync };
        const exists = native.existsSync;
        try {
            const targets = [TARGET, ...Array.from({ length: 99 }, (_, index) => `tests/status-${index}.test.js`)];
            fs.appendFileSync(path.join(f.root, TARGET), '// current task test change\n');
            for (const target of targets.slice(1)) fs.writeFileSync(path.join(f.root, target), "require('node:test').test('status', () => {});\n");
            const preflightPath = classifyCurrent(f);
            assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
            const compile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
            assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
            const absoluteTargets = new Set(targets.map(target => path.join(f.root, target)));
            const states = enabled ? ['missing', 'current'] as const : ['disabled'] as const;
            for (const state of states) {
                if (state === 'current') select(f.root, { command: `node --test ${targets.join(' ')}`, targets, reason: `${TASK_ID} verifies all changed status regressions` });
                const probes = new Map<string, number>();
                native.existsSync = ((value: fs.PathLike) => {
                    const file = String(value);
                    // Count this selection walk; workspace freshness has its own pre-existing probes.
                    if (absoluteTargets.has(file) && new Error().stack?.includes('getChangedTestPaths')) {
                        probes.set(file, (probes.get(file) ?? 0) + 1);
                    }
                    return exists(value);
                }) as typeof exists;
                try {
                    const route = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
                    if (state === 'disabled') {
                        assert.equal(route.full_suite_validation.enabled, false);
                        assert.notEqual(route.next_gate, 'task-test-selection', route.reason);
                        assert.notEqual(route.next_gate, 'full-suite-validation', route.reason);
                    } else assert.equal(route.next_gate, state === 'current' ? 'full-suite-validation' : 'task-test-selection', route.reason);
                    const expected = state === 'disabled' ? 0 : targets.length;
                    assert.equal(probes.size, expected);
                    assert.equal([...probes.values()].reduce((total, count) => total + count, 0), expected);
                } finally { native.existsSync = exists; }
            }
        } finally { native.existsSync = exists; f.cleanup(); }
    });
}

async function runBroadFailure(f: ReturnType<typeof fixture>, includeRegression = false) {
    const preflightPath = prepareChangedTestPreflight(f);
    const command = `node --test ${TARGET} ${SECOND_TARGET}`;
    select(f.root, { command, targets: includeRegression ? [TARGET, SECOND_TARGET] : [TARGET],
        reason: `${TASK_ID} ${TARGET} covers ${TARGET}; ${SECOND_TARGET} guards ${TARGET}` });
    assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
    const compile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
    assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
    const suite = await nativeSuite({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
    assert.notEqual(suite.exitCode, 0, suite.outputText);
    return { preflightPath, command };
}

test('broad outside failure can be narrowed, remains authenticated after narrow PASS, and is visible in completion', async () => {
    const f = fixture({ noPlanned: true, disableQuality: true, unrelatedFailure: true });
    try {
        const { preflightPath, command } = await runBroadFailure(f);
        const route = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
        assert.equal(route.next_gate, 'task-test-selection', route.reason);
        assert.ok(!route.commands[0].command.includes(command));
        assert.match(route.commands[0].command, /<command that runs only this task's tests and required regressions>/u);
        assert.ok(route.commands[0].command.includes(TARGET));
        assert.equal(route.commands.length, 4);
        assert.match(route.commands[1].command, /materialize-review-follow-up-tasks.*recorded-out-of-scope/u);
        assert.ok(select(f.root));
        const records = readRecordedOutOfScopeFailures(f.root, TASK_ID);
        assert.equal(records.length, 1);
        assert.equal(records[0].command, command);
        assert.deepEqual(records[0].failing_tests, [SECOND_TARGET]);
        assert.equal(records[0].task_mode_entry_sha256.length, 64);
        assert.equal(records[0].artifact_sha256.length, 64);
        assert.equal(resolveNextStep({ repoRoot: f.root, taskId: TASK_ID }).next_gate, 'materialize-review-follow-up-tasks');
        assert.equal(materializeRecordedOutOfScopeFollowUps(f.root, TASK_ID).exitCode, 0);
        const narrow = await nativeSuite({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
        assert.equal(narrow.exitCode, 0, narrow.outputText);
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
        assert.deepEqual(readRecordedOutOfScopeFailures(f.root, TASK_ID), records);
        assert.equal(recordedOutOfScopeFollowUpViolations(f.root, TASK_ID).length, 0);
        assert.equal(materializeRecordedOutOfScopeFollowUps(f.root, TASK_ID).exitCode, 0);
        assert.deepEqual(recordedOutOfScopeFollowUpViolations(f.root, TASK_ID), []);
        assert.equal(materializeRecordedOutOfScopeFollowUps(f.root, TASK_ID).exitCode, 0);
        const queuePath = path.join(f.root, 'TASK.md');
        const queue = fs.readFileSync(queuePath, 'utf8');
        assert.equal((queue.match(/Resolve recorded out-of-scope test failures/gu) ?? []).length, 1);
        fs.writeFileSync(queuePath, queue.replace(/out_of_scope_failure=[a-f0-9]{64}/u, 'removed_binding'));
        assert.equal(recordedOutOfScopeFollowUpViolations(f.root, TASK_ID).length, 1);
        fs.writeFileSync(queuePath, queue);
        const text = formatCompletionGateResult({ outcome: 'PASS', task_id: TASK_ID, status: 'PASSED',
            recorded_out_of_scope_failures_notice: recordedOutOfScopeNotice(f.root, TASK_ID) });
        assert.match(text, /Task completed with recorded out-of-scope failures/);
        assert.ok(text.includes(SECOND_TARGET));
    } finally { f.cleanup(); }
});

for (const format of ['old-format', 'old event with artifact refs', 'Maven noise', 'legacy noisy refs'] as const) {
    test(`${format} broad failure narrows without attribution prerequisites and completes with a distinct follow-up`, async () => {
        const f = fixture({ noPlanned: true, disableQuality: true, unrelatedFailure: true, afterCompile: true, broadConfigured: true });
        try {
            const { preflightPath, command } = await runBroadFailure(f);
            const failure = [...readTaskTimelineJsonlEntries(f.timeline)].reverse().find(entry => entry.record?.event_type === 'FULL_SUITE_VALIDATION_FAILED')!;
            const details = { ...failure.record!.details as Record<string, unknown> };
            const artifactPath = String(details.artifact_path);
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            for (const record of [artifact, details]) {
                if (record === artifact && format === 'old event with artifact refs') continue;
                delete record.out_of_scope_failure_refs;
                delete record.out_of_scope_audit_verdict;
                delete record.out_of_scope_failure_detected;
            }
            const noise = ['14:19:54.151 [main] WARN Consumer inbox processing failed',
                'org.hibernate.tool.schema.spi.CommandAcceptanceException: Error executing DDL',
                '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.2:test'];
            if (format === 'Maven noise') artifact.failure_chunks = [noise];
            if (format === 'legacy noisy refs') {
                artifact.out_of_scope_failure_refs = ['14:19:54.151', 'java.lang.RuntimeException', 'org.apache.maven.plugins'];
                details.out_of_scope_failure_refs = artifact.out_of_scope_failure_refs;
            }
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
            details.artifact_sha256 = fileSha256(artifactPath)!;
            appendMandatoryTaskEvent(f.bundle, TASK_ID, 'FULL_SUITE_VALIDATION_FAILED', 'FAIL', 'Older Garda failure evidence.', details, { actor: 'gate' });
            const route = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
            assert.equal(route.next_gate, 'task-test-selection', route.reason);
            assert.match(route.commands[0].command, /<command that runs only this task's tests and required regressions>/u);
            assert.ok(route.commands[0].command.includes(TARGET));
            assert.ok(!route.commands[0].command.includes(command));
            assert.throws(() => select(f.root, { command: `node --test ${HELD_TARGET}`, targets: [HELD_TARGET],
                reason: `${TASK_ID} ${HELD_TARGET} guards ${TARGET}` }), /declared test target|changed test|in-scope failing test|include|excludes/i);
            select(f.root);
            const [record] = readRecordedOutOfScopeFailures(f.root, TASK_ID);
            assert.equal(record.command, command);
            assert.equal(record.failure_event_sha256.length, 64);
            const attributed = format === 'legacy noisy refs' || format === 'old event with artifact refs';
            assert.equal(record.attribution, attributed ? 'attributed' : 'not attributed');
            assert.deepEqual(record.failing_tests, artifact.out_of_scope_failure_refs ?? []);
            assert.equal(resolveNextStep({ repoRoot: f.root, taskId: TASK_ID }).next_gate, 'materialize-review-follow-up-tasks');
            assert.equal(materializeRecordedOutOfScopeFollowUps(f.root, TASK_ID).exitCode, 0);
            assert.deepEqual(recordedOutOfScopeFollowUpViolations(f.root, TASK_ID), []);
            const rows = parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(f.root, 'TASK.md'), 'utf8')).rows;
            const followUp = rows.find(row => row.notes.includes('out_of_scope_follow_up=grouped'))!;
            assert.equal(followUp.taskId, TASK_ID + '-1');
            assert.ok(followUp.notes.includes(`Failed command: ${command}`));
            assert.ok(followUp.notes.includes(`Artifact: ${record.artifact_path}`));
            if (!attributed) assert.match(followUp.notes, /Tests: not attributed/u);
            const narrowRoute = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
            assert.equal(narrowRoute.next_gate, 'full-suite-validation', narrowRoute.reason);
            const run = await nativeSuite({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
            assert.equal(run.exitCode, 0, run.outputText);
            const passed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            const errors: string[] = [];
            const evidence = collectFullSuiteValidationEvidence({ enabled: true, required: true,
                reviewsRoot: path.join(f.bundle, 'runtime/reviews'), taskId: TASK_ID, repoRoot: f.root,
                timelinePath: f.timeline, orderedEvents: collectOrderedTimelineEvents(f.timeline, errors),
                expectedPreflightPath: preflightPath, expectedPreflightSha256: fileSha256(preflightPath)!,
                expectedCompileGateTimestamp: passed.cycle_binding.compile_gate_timestamp,
                expectedCommand: `node --test ${TARGET}`, fullSuiteNotRequiredForDocsOnly: false, errors });
            assert.equal(evidence.status, 'PASSED');
            assert.deepEqual(errors, []);
            assert.equal(readRecordedOutOfScopeFailures(f.root, TASK_ID).length, 1);
            assert.match(recordedOutOfScopeNotice(f.root, TASK_ID), /completed with recorded out-of-scope failures/u);
            assert.equal(readTaskTimelineJsonlEntries(f.timeline).filter(entry => entry.record?.event_type === 'FULL_SUITE_VALIDATION_FAILED').length, 2);
        } finally { f.cleanup(); }
    });
}

test('a narrowed failing run belongs to the task and cannot drop its required targets', async () => {
    const f = fixture({ noPlanned: true, disableQuality: true, unrelatedFailure: true, afterCompile: true });
    try {
        await runBroadFailure(f);
        select(f.root);
        assert.equal(materializeRecordedOutOfScopeFollowUps(f.root, TASK_ID).exitCode, 0);
        fs.writeFileSync(path.join(f.root, TARGET), "require('node:test').test('own failure', () => { throw new Error('fix this task'); });\n");
        const preflightPath = classifyCurrent(f);
        select(f.root);
        assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
        const compile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        const failed = await nativeSuite({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
        assert.notEqual(failed.exitCode, 0, failed.outputText);
        const route = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
        assert.equal(route.next_gate, 'implementation', route.reason);
        assert.throws(() => select(f.root, { command: `node --test ${HELD_TARGET}`, targets: [HELD_TARGET],
            reason: `${TASK_ID} ${HELD_TARGET} guards ${TARGET}` }), /earlier failed selection.*no exact argv association/u);
        assert.equal(readRecordedOutOfScopeFailures(f.root, TASK_ID).length, 1);
    } finally { f.cleanup(); }
});

test('workflow explain describes task-scoped selection and conditional confirmation', () => {
    const f = fixture();
    try {
        const result = capture(() => handleWorkflow(['explain', '--target-root', f.root, '--json'], PACKAGE_JSON));
        assert.ok(result && result.action === 'explain');
        const explanation = result.explanation.join('\n');
        assert.match(explanation, /selector records a task-scoped command/u);
        assert.match(explanation, /confirmation is required when task_test_selection.require_operator_confirmation is enabled/u);
        assert.doesNotMatch(explanation, /selector writes the shared/u);
    } finally { f.cleanup(); }
});

test('recorded outside failures refuse parent, unrelated, ambiguous and non-grouped follow-up bindings even with signed events', async () => {
    const f = fixture({ noPlanned: true, disableQuality: true, unrelatedFailure: true });
    try {
        await runBroadFailure(f);
        select(f.root);
        const record = readRecordedOutOfScopeFailures(f.root, TASK_ID)[0];
        assert.ok(record);
        const taskPath = path.join(f.root, 'TASK.md');
        const original = fs.readFileSync(taskPath, 'utf8');
        const parent = parseCanonicalActiveTaskQueue(original).rows.find(row => row.taskId === TASK_ID)!;
        const marker = `out_of_scope_parent=${TASK_ID} out_of_scope_failure=${record.failure_event_sha256}`;
        const notes = `Child of \`${TASK_ID}\`. out_of_scope_follow_up=grouped; ${marker}`;
        const childId = `${TASK_ID}-1`;
        const row = (id: string, value: string) => `| ${id} | TODO | P1 | tests | Resolve recorded out-of-scope test failures | fixture | 2026-11-06 | balanced | ${value} |\n`;
        const variants = [
            { name: 'parent itself', id: TASK_ID,
                queue: original.replace(parent.rawLine, replaceTaskMdTableCell(parent.rawLine, 8, notes)!) },
            { name: 'unrelated task', id: 'T-UNRELATED-1', queue: original + row('T-UNRELATED-1', notes) },
            { name: 'prefix sibling', id: `${TASK_ID}0-1`, queue: original + row(`${TASK_ID}0-1`, notes) },
            { name: 'grandchild', id: `${childId}-1`, queue: original + row(`${childId}-1`, notes) },
            { name: 'review follow-up type', id: `${TASK_ID}-F1`, queue: original + row(`${TASK_ID}-F1`, notes) },
            { name: 'missing grouped type', id: childId, queue: original + row(childId, notes.replace('out_of_scope_follow_up=grouped;', '')) },
            { name: 'wrong grouped type', id: childId, queue: original + row(childId, notes.replace('=grouped;', '=grouped-forged;')) },
            { name: 'wrong parent relation', id: childId, queue: original + row(childId, notes.replace(`Child of \`${TASK_ID}\`.`, 'Child of `T-OTHER`.')) },
            { name: 'duplicate task id', id: childId, queue: original + row(childId, notes) + row(childId, notes) },
            { name: 'duplicate claim on parent', id: childId,
                queue: original.replace(parent.rawLine, replaceTaskMdTableCell(parent.rawLine, 8, marker)!) + row(childId, notes) }
        ];
        for (const variant of variants) {
            fs.writeFileSync(taskPath, variant.queue);
            const before = fs.readFileSync(f.timeline);
            const result = materializeRecordedOutOfScopeFollowUps(f.root, TASK_ID);
            assert.equal(result.exitCode, 1, variant.name);
            assert.match(result.outputLines.join('\n'), /(?:Invalid or ambiguous|queue is missing or ambiguous).*gate materialize-review-follow-up-tasks/u, variant.name);
            assert.deepEqual(fs.readFileSync(f.timeline), before, variant.name);
            assert.equal(fs.readFileSync(taskPath, 'utf8'), variant.queue, variant.name);
            appendMandatoryTaskEvent(f.bundle, TASK_ID, 'OUT_OF_SCOPE_FOLLOW_UP_MATERIALIZED', 'PASS', 'Old invalid binding.', {
                bindings: [{ failure_event_sha256: record.failure_event_sha256, task_id: variant.id }]
            }, { actor: 'gate' });
            const violations = withInvocationReadObservation(() => recordedOutOfScopeFollowUpViolations(f.root, TASK_ID));
            assert.equal(violations.length, 1, variant.name);
            assert.match(violations[0], /gate materialize-review-follow-up-tasks.*--review-type recorded-out-of-scope/u);
        }
        fs.writeFileSync(taskPath, original);
        assert.equal(materializeRecordedOutOfScopeFollowUps(f.root, TASK_ID).exitCode, 0);
        const created = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8')).rows.filter(task => task.notes.includes(marker));
        assert.equal(created.length, 1);
        assert.equal(created[0].taskId, childId);
        assert.match(created[0].notes, /out_of_scope_follow_up=grouped;/u);
        assert.deepEqual(recordedOutOfScopeFollowUpViolations(f.root, TASK_ID), []);
        assert.equal(materializeRecordedOutOfScopeFollowUps(f.root, TASK_ID).exitCode, 0);
        assert.equal(parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8')).rows.length, 2);
    } finally { f.cleanup(); }
});

test('a selected regression failure is in task scope and cannot be dropped by narrowing', async () => {
    const f = fixture({ noPlanned: true, disableQuality: true, unrelatedFailure: true });
    try {
        const { command, preflightPath } = await runBroadFailure(f, true);
        // Re-recording the same broad command cannot erase the failed regression relationship.
        assert.ok(select(f.root, { command, targets: [TARGET] }));
        assert.deepEqual(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.targets, [TARGET, SECOND_TARGET]);
        const repeat = await nativeSuite({ repoRoot: f.root, taskId: TASK_ID, preflightPath });
        assert.notEqual(repeat.exitCode, 0, repeat.outputText);
        assert.throws(() => select(f.root), /every test target of the earlier failed selection must still run under the new command.*could not be shown to run.*no exact argv association/su);
        assert.deepEqual(readRecordedOutOfScopeFailures(f.root, TASK_ID), []);
    } finally { f.cleanup(); }
});

test('a production scope or content change re-asks selection; an equivalent preflight refresh keeps it', () => {
    const f = fixture();
    try {
        select(f.root);
        classifyCurrent(f);
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
        fs.writeFileSync(path.join(f.root, 'src/extra.js'), 'export const extra = 1;\n');
        classifyCurrent(f);
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'stale');
        }), measurement => {
            assert.equal(Object.entries(measurement.work).filter(([key]) => /^subprocess\..*\.git$/u.test(key))
                .reduce((sum, [, count]) => sum + count, 0), 0, 'An already changed preflight rejects without Git.');
        });
        assert.equal(resolveNextStep({ repoRoot: f.root, taskId: TASK_ID }).task_id, TASK_ID);
        select(f.root);
        fs.appendFileSync(path.join(f.root, 'src/extra.js'), '// revised production behavior\n');
        classifyCurrent(f);
        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'stale');
    } finally { f.cleanup(); }
});

for (const mutation of ['pom', 'duplicate-source', 'compiled-class'] as const) {
    test(`generic Maven selection binds declared inputs without scanning ${mutation} outside git_staged_only scope`, () => {
        const f = fixture({ noPlanned: true });
        try {
            const target = 'src/test/java/example/StatusTest.java';
            fs.mkdirSync(path.dirname(path.join(f.root, target)), { recursive: true });
            fs.writeFileSync(path.join(f.root, 'pom.xml'), '<project/>');
            fs.writeFileSync(path.join(f.root, target), 'package example; class StatusTest {}');
            assert.equal(runGit(f.root, ['add', 'pom.xml', target]).status, 0);
            assert.equal(runGit(f.root, ['commit', '-qm', 'Seed focused Maven fixture']).status, 0);
            fs.appendFileSync(path.join(f.root, target), '\n// task regression\n');
            assert.equal(runGit(f.root, ['add', target]).status, 0);
            classifyCurrent(f);
            const preflightPath = path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-preflight.json`);
            capture(() => runClassifyChangeCommand({ repoRoot: f.root, taskId: TASK_ID, useStaged: true,
                includeUntracked: false, taskIntent: 'Update Status test behavior.', outputPath: preflightPath, emitMetrics: false }));
            assert.equal(JSON.parse(fs.readFileSync(preflightPath, 'utf8')).detection_source, 'git_staged_only');
            select(f.root, { command: 'mvn -o -Dtest=StatusTest test', targets: [target],
                reason: `${TASK_ID} verifies current changed Status test behavior`,
                extra: ['--task-test-plan', JSON.stringify({ support: [{ path: 'pom.xml', role: 'config', targets: [target] }] })] });
            assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
            if (mutation === 'pom') {
                fs.writeFileSync(path.join(f.root, 'pom.xml'), '<project><build><testSourceDirectory>other-tests</testSourceDirectory></build></project>');
            } else {
                const extra = mutation === 'duplicate-source' ? 'src/test/java/other/StatusTest.java' : 'target/test-classes/other/StatusTest.class';
                fs.mkdirSync(path.dirname(path.join(f.root, extra)), { recursive: true });
                fs.writeFileSync(path.join(f.root, extra), mutation === 'duplicate-source' ? 'package other; class StatusTest {}' : 'class bytes');
            }
            assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, mutation === 'pom' ? 'stale' : 'current');
        } finally { f.cleanup(); }
    });
}

test('selection binds each declared config once and rejects changes without rerunning command admission', () => {
    const measurements: number[] = [];
    for (const count of [1, 100]) {
        const f = fixture({ noPlanned: true });
        try {
            const module = 'backend/application';
            const targets = Array.from({ length: count }, (_, index) => `${module}/src/test/java/example/Status${index}Test.java`);
            fs.mkdirSync(path.dirname(path.join(f.root, targets[0])), { recursive: true });
            fs.writeFileSync(path.join(f.root, 'backend/pom.xml'), '<project><modules><module>application</module></modules></project>');
            fs.writeFileSync(path.join(f.root, module, 'pom.xml'), '<project/>');
            // Unchanged runner configuration is outside the task's changed-file scope.
            assert.equal(runGit(f.root, ['add', 'backend/pom.xml', module + '/pom.xml']).status, 0);
            assert.equal(runGit(f.root, ['commit', '-qm', 'Seed disposable Maven configuration']).status, 0);
            for (const target of targets) fs.writeFileSync(path.join(f.root, target), `package example; class ${path.basename(target, '.java')} {}`);
            classifyCurrent(f);
            const command = 'mvn -f backend/pom.xml -pl application -Dtest=' + targets.map(target => path.basename(target, '.java')).join(',') + ' verify';
            select(f.root, { command, targets, reason: `${TASK_ID} verifies current changed Status test behavior`,
                extra: ['--task-test-plan', JSON.stringify({ support: ['backend/pom.xml', module + '/pom.xml']
                    .map(path => ({ path, role: 'config', targets })) })] });
            withNextStepMeasurement(() => withInvocationReadObservation(() => {
                const selection = loadTaskFullSuiteConfig(f.root, TASK_ID).selection;
                assert.equal(selection.status, 'current');
                assert.equal(selection.targets.length, count);
                // Equivalent callers share the admission and its dependencies during this invocation.
                assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
            }), measurement => measurements.push(measurement.work['file_hash:' + path.join(f.root, 'backend/pom.xml')] ?? 0));
            for (const pom of ['backend/pom.xml', module + '/pom.xml']) {
                const absolute = path.join(f.root, pom), original = fs.readFileSync(absolute);
                try {
                    assert.throws(() => withInvocationReadObservation(() => {
                        assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
                        fs.appendFileSync(absolute, '<!-- changed after observation -->');
                    }), /changed|identity|observation/iu);
                    assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'stale');
                } finally { fs.writeFileSync(absolute, original); }
            }
        } finally { f.cleanup(); }
    }
    assert.equal(measurements[0], 1);
    assert.equal(measurements[1], measurements[0]);
});

test('narrowing an outside failure cannot drop a current changed test', async () => {
    const f = fixture({ noPlanned: true, disableQuality: true, unrelatedFailure: true });
    try {
        await runBroadFailure(f);
        assert.throws(() => select(f.root, { command: `node --test ${HELD_TARGET}`, targets: [HELD_TARGET],
            reason: `${TASK_ID} ${HELD_TARGET} guards ${TARGET}` }), /declared test target|changed test|in-scope failing test|excludes|include/i);
        assert.deepEqual(readRecordedOutOfScopeFailures(f.root, TASK_ID), []);
    } finally { f.cleanup(); }
});

test('a selection bound to an older HEAD is rejected without rebuilding Git scope observations', () => {
    const f = fixture();
    try {
        select(f.root);
        fs.appendFileSync(path.join(f.root, SOURCE), '// committed production change\n');
        assert.equal(runGit(f.root, ['add', SOURCE]).status, 0);
        assert.equal(runGit(f.root, ['commit', '-qm', 'Move disposable fixture HEAD']).status, 0);
        const native = require('node:child_process') as typeof import('node:child_process');
        const spawn = native.spawnSync, exec = native.execFileSync;
        let gitCalls = 0;
        native.spawnSync = ((...args: Parameters<typeof spawn>) => { if (/^git(?:\.exe)?$/iu.test(path.basename(args[0]))) gitCalls++; return spawn(...args); }) as typeof spawn;
        native.execFileSync = ((...args: Parameters<typeof exec>) => { if (/^git(?:\.exe)?$/iu.test(path.basename(args[0]))) gitCalls++; return exec(...args); }) as typeof exec;
        try {
            withInvocationReadObservation(() => assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'stale'));
            assert.equal(gitCalls, 0);
        } finally { native.spawnSync = spawn; native.execFileSync = exec; }
    } finally { f.cleanup(); }
});

test('reviewed selection uses its exact preflight pin without Git and never authorizes a fresh run after source changes', () => {
    const f = fixture();
    const native = require('node:child_process') as typeof import('node:child_process');
    const spawn = native.spawnSync, exec = native.execFileSync;
    try {
        select(f.root);
        const pin = fileSha256(path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-preflight.json`))!;
        fs.appendFileSync(path.join(f.root, SOURCE), '// later source change\n');
        let gitCalls = 0;
        native.spawnSync = ((...args: Parameters<typeof spawn>) => { if (/^git(?:\.exe)?$/iu.test(path.basename(args[0]))) gitCalls++; return spawn(...args); }) as typeof spawn;
        native.execFileSync = ((...args: Parameters<typeof exec>) => { if (/^git(?:\.exe)?$/iu.test(path.basename(args[0]))) gitCalls++; return exec(...args); }) as typeof exec;
        try {
            withInvocationGitReadObservation(() => withInvocationReadObservation(() => {
                assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID, pin).selection.status, 'current');
                assert.equal(gitCalls, 0, 'inspection of the reviewed tree must not calculate current Git scope');
                assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'stale');
                assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID, '0'.repeat(64)).selection.status, 'stale');
            }));
        } finally { native.spawnSync = spawn; native.execFileSync = exec; }
        assert.equal(runGit(f.root, ['add', SOURCE]).status, 0);
        assert.equal(runGit(f.root, ['commit', '-qm', 'Move reviewed selection fixture HEAD']).status, 0);
        withInvocationReadObservation(() => assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID, pin).selection.status, 'stale'));
    } finally { native.spawnSync = spawn; native.execFileSync = exec; f.cleanup(); }
});

test('current split-checkpoint selection reuses Git observations without a per-call HEAD diff', async () => {
    const f = fixture({ noPlanned: true, disableQuality: true, afterCompile: true });
    const native = require('node:child_process') as typeof import('node:child_process');
    const spawn = native.spawnSync;
    try {
        const parent = 'T-TEST-SELECTION';
        fs.appendFileSync(path.join(f.root, SOURCE), '// checkpoint source change\n');
        fs.appendFileSync(path.join(f.root, TARGET), '// checkpoint test change\n');
        assert.equal(runGit(f.root, ['add', SOURCE, TARGET]).status, 0);
        assert.equal(runGit(f.root, ['commit', '-qm', `checkpoint(split): preserve ${parent} dirty diff before decomposition`]).status, 0);
        const checkpoint = String(runGit(f.root, ['rev-parse', 'HEAD']).stdout).trim();
        const taskPath = path.join(f.root, 'TASK.md');
        const taskText = fs.readFileSync(taskPath, 'utf8');
        const queue = parseCanonicalActiveTaskQueue(taskText);
        const row = queue.rows.find(item => item.taskId === TASK_ID)!;
        fs.writeFileSync(taskPath, taskText.replace(row.rawLine, replaceTaskMdTableCell(row.rawLine, 8,
            `Checkpoint: \`${checkpoint}\`. Checkpoint files: \`${SOURCE}\`, \`${TARGET}\`.`)!)
            + `| ${parent} | DECOMPOSED | P1 | app | Parent | fixture | 2026-11-06 | balanced | Split checkpoint \`${checkpoint}\`. Children: \`${TASK_ID}\`. |\n`);
        const preflightPath = classifyCurrent(f);
        assert.match(JSON.parse(fs.readFileSync(preflightPath, 'utf8')).detection_source, /^git_split_checkpoint:/u);
        select(f.root);
        assert.equal(capture(() => loadPostPreflightRulePack(f.root, TASK_ID, preflightPath)).exitCode, 0);
        const compile = await runCompileGateCommand({ repoRoot: f.root, taskId: TASK_ID, preflightPath, emitMetrics: false });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        let headDiffs = 0;
        native.spawnSync = ((...args: Parameters<typeof spawn>) => {
            if (/^git(?:\.exe)?$/iu.test(path.basename(args[0])) && args[1]?.includes('--quiet') && args[1].includes('HEAD')) headDiffs++;
            return spawn(...args);
        }) as typeof spawn;
        for (let call = 0; call < 2; call++) {
            const result = resolveNextStep({ repoRoot: f.root, taskId: TASK_ID });
            assert.equal(result.next_gate, 'full-suite-validation', result.reason);
            assert.equal(headDiffs, 0);
        }
        for (const target of [SOURCE, TARGET]) {
            const absolute = path.join(f.root, target), bytes = fs.readFileSync(absolute);
            try {
                assert.throws(() => withInvocationGitReadObservation(() => withInvocationReadObservation(() => {
                    assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
                    fs.appendFileSync(absolute, '// changed during invocation\n');
                    assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
                })), /changed|identity|observation/iu);
                assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'stale');
            } finally { fs.writeFileSync(absolute, bytes); }
        }
    } finally { native.spawnSync = spawn; f.cleanup(); }
});

test('memoized selection readers reject target mutation before their invocation returns', () => {
    const f = fixture();
    try {
        select(f.root);
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.status, 'current');
            fs.appendFileSync(path.join(f.root, TARGET), '// replaced during observation\n');
            loadTaskFullSuiteConfig(f.root, TASK_ID);
        }), /changed|identity|observation/i);
    } finally { f.cleanup(); }
});

test('changed-file authority rejects stale preflights, changed worktrees, and new task entries', () => {
    for (const mutation of ['artifact', 'new-preflight', 'worktree', 'cycle'] as const) {
        const f = fixture({ noPlanned: true });
        try {
            const preflightPath = prepareChangedTestPreflight(f);
            const roots = resolveWorkflowRoots({ targetRoot: f.root });
            const next = JSON.parse(JSON.stringify(f.config)); next.full_suite_validation.command = `node --test ${TARGET}`;
            const authority = resolveTaskTestSelectionAuthority({ taskId: TASK_ID,
                taskTestSelectionReason: `${TASK_ID} verifies the current widget test behavior`, focusedRequiredTestPath: [TARGET] },
                roots, f.config, next, ['full_suite_validation.command']);
            assert.ok(authority?.preflight_sha256);
            if (mutation === 'artifact') fs.appendFileSync(preflightPath, ' ');
            if (mutation === 'new-preflight') classifyCurrent(f);
            if (mutation === 'worktree') fs.appendFileSync(path.join(f.root, TARGET), '// later edit\n');
            if (mutation === 'cycle') {
                const restarted = capture(() => runEnterTaskMode({ repoRoot: f.root, taskId: TASK_ID,
                    entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: '2', taskSummary: 'Restart widget task.' }));
                assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
            }
            assert.throws(() => assertTaskTestSelectionCurrent(roots, authority), /preflight|worktree|cycle/i, mutation);
            if (mutation !== 'new-preflight') {
                assert.throws(() => select(f.root, { reason: `${TASK_ID} verifies the current widget test behavior` }),
                    /preflight|worktree|cycle/i, mutation);
            }
        } finally { f.cleanup(); }
    }
});

test('staged preflight authority rejects a later unstaged edit to the selected test', () => {
    const f = fixture({ noPlanned: true });
    try {
        const preflightPath = prepareChangedTestPreflight(f);
        runGit(f.root, ['add', '--', TARGET]);
        capture(() => runClassifyChangeCommand({ repoRoot: f.root, taskId: TASK_ID,
            taskIntent: 'Update widget behavior and its owning tests.', useStaged: true,
            outputPath: preflightPath, emitMetrics: false }));
        const roots = resolveWorkflowRoots({ targetRoot: f.root });
        const next = JSON.parse(JSON.stringify(f.config)); next.full_suite_validation.command = `node --test ${TARGET}`;
        const authority = resolveTaskTestSelectionAuthority({ taskId: TASK_ID,
            taskTestSelectionReason: `${TASK_ID} verifies the current widget test behavior`, focusedRequiredTestPath: [TARGET] },
            roots, f.config, next, ['full_suite_validation.command']);
        assert.ok(authority?.preflight_sha256);
        fs.appendFileSync(path.join(f.root, TARGET), '// unstaged edit\n');
        assert.throws(() => assertTaskTestSelectionCurrent(roots, authority), /worktree/i);
    } finally { f.cleanup(); }
});

test('without planned files unchanged regressions need a relationship to a current changed file', () => {
    const f = fixture({ noPlanned: true });
    try {
        prepareChangedTestPreflight(f);
        assert.throws(() => select(f.root, { command: `node --test ${SECOND_TARGET}`, targets: [SECOND_TARGET],
            reason: `${TASK_ID} verifies widget regressions` }), /explicit relationship/i);
        const result = select(f.root, { command: `node --test ${TARGET} ${SECOND_TARGET}`, targets: [SECOND_TARGET],
            reason: `${TASK_ID} ${SECOND_TARGET} guards ${TARGET} behavior` });
        assert.ok(result && result.action === 'set');
    } finally { f.cleanup(); }
});


test('task selection defaults to autonomous for current and legacy configs and publishes an honest cycle-bound audit', () => {
    for (const legacy of [false, true]) {
        const f = fixture({ legacy });
        try {
            const mode = getTaskModeEvidence(f.root, TASK_ID);
            const before = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
            const entry = readTaskTimelineJsonlEntries(f.timeline).at(-2)
                ?? readTaskTimelineJsonlEntries(f.timeline).at(-1);
            const result = select(f.root);
            assert.ok(result && result.action === 'set' && result.audit_path);
            assert.deepEqual(result.changed_fields, ['task_test_selection.command']);
            const after = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
            assert.deepEqual(after, before);
            const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8').trim().split('\n').at(-1)!);
            assert.equal(audit.actor, 'task-selection-command');
            const authority = audit.details.task_test_selection_authority;
            assert.equal(authority.origin, 'task_scoped_test_selection');
            assert.equal(authority.require_operator_confirmation, false);
            assert.equal(authority.workspace_root, fs.realpathSync.native(f.root));
            assert.equal(authority.task_mode_artifact_sha256, mode.evidence_hash);
            assert.ok(authority.task_mode_entry_sha256.match(/^[a-f0-9]{64}$/u));
            assert.ok(authority.workspace_fingerprint.match(/^[a-f0-9]{64}$/u));
            assert.equal(authority.targets[0].path, TARGET);
            assert.ok(Date.parse(authority.decision_utc) <= Date.now());
            assert.equal(authority.operator_confirmed_at_utc, undefined);
            assert.ok(entry);
            const events = readTaskTimelineJsonlEntries(f.timeline);
            assert.equal(events.at(-1)?.record?.event_type, 'TASK_TEST_SELECTION_RECORDED');
            assert.equal(loadTaskFullSuiteConfig(f.root, TASK_ID).config.command, `node --test ${TARGET}`);
            assert.equal(loadTaskFullSuiteConfig(f.root, HELD_TASK_ID).config.command, before.full_suite_validation.command);
            const changes = getCurrentWorkflowConfigChanges(f.root, mode.workflow_config_file_hashes);
            assert.deepEqual(getWorkflowConfigWorkViolations({
                taskModeEvidence: mode, changedFiles: changes.changed_files, phaseLabel: 'selector compatibility',
                repoRoot: f.root, currentFileHashes: changes.current_file_hashes,
                baselineFileHashes: mode.workflow_config_file_hashes
            }), []);
        } finally { f.cleanup(); }
    }
});

test('current task selection preserves an approved disjoint held owner and binds both current cycles', () => {
    const f = fixture({ heldOwner: true });
    try {
        const heldSource = fs.readFileSync(path.join(f.root, HELD_SOURCE));
        const heldMode = getTaskModeEvidence(f.root, HELD_TASK_ID);
        const currentMode = getTaskModeEvidence(f.root, TASK_ID);
        const queue = fs.readFileSync(path.join(f.root, 'TASK.md'));
        const result = select(f.root);
        assert.ok(result && result.action === 'set' && result.changed);
        const audit = JSON.parse(fs.readFileSync(result.audit_path!, 'utf8').trim().split('\n').at(-1)!);
        assert.equal(audit.details.task_test_selection_authority.task_id, TASK_ID);
        for (const [id, mode] of [[TASK_ID, currentMode], [HELD_TASK_ID, heldMode]] as const) {
            const events = readTaskTimelineJsonlEntries(path.join(f.bundle, 'runtime/task-events', `${id}.jsonl`));
            assert.equal(events.some(item => item.record?.event_type === 'TASK_TEST_SELECTION_RECORDED'), id === TASK_ID);
            const changes = getCurrentWorkflowConfigChanges(f.root, mode.workflow_config_file_hashes);
            assert.deepEqual(getWorkflowConfigWorkViolations({ taskModeEvidence: mode, changedFiles: changes.changed_files,
                phaseLabel: 'approved held-owner selection compatibility', repoRoot: f.root,
                currentFileHashes: changes.current_file_hashes, baselineFileHashes: mode.workflow_config_file_hashes }), []);
        }
        assert.deepEqual(fs.readFileSync(path.join(f.root, HELD_SOURCE)), heldSource);
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'TASK.md')), queue);
        assert.equal(getTaskModeEvidence(f.root, HELD_TASK_ID).evidence_hash, heldMode.evidence_hash);
        assert.equal(getTaskModeEvidence(f.root, TASK_ID).evidence_hash, currentMode.evidence_hash);
    } finally { f.cleanup(); }
});

test('held-owner selection rejects orphan runtime owners and physical scope overlap before writes', () => {
    for (const mutation of ['orphan', 'overlap'] as const) {
        const f = fixture({ heldOwner: true });
        try {
            const before = fs.readFileSync(f.configPath);
            if (mutation === 'orphan') {
                const taskPath = path.join(f.root, 'TASK.md');
                fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').split('\n')
                    .filter(line => !line.startsWith(`| ${HELD_TASK_ID} |`)).join('\n'));
            } else {
                fs.unlinkSync(path.join(f.root, SOURCE));
                fs.linkSync(path.join(f.root, HELD_SOURCE), path.join(f.root, SOURCE));
            }
            assert.throws(() => select(f.root), /current active task|owner|scope/i, mutation);
            assert.deepEqual(fs.readFileSync(f.configPath), before);
        } finally { f.cleanup(); }
    }
});

test('restarting a held owner invalidates prepared selection and publication without rebinding frozen authority', () => {
    const f = fixture({ heldOwner: true });
    try {
        const roots = resolveWorkflowRoots({ targetRoot: f.root });
        const next = JSON.parse(JSON.stringify(f.config)); next.full_suite_validation.command = `node --test ${TARGET}`;
        const authority = resolveTaskTestSelectionAuthority({ taskId: TASK_ID,
            taskTestSelectionReason: `${TASK_ID} ${TARGET} covers ${SOURCE}`, focusedRequiredTestPath: [TARGET] },
            roots, f.config, next, ['full_suite_validation.command']);
        assert.ok(authority);
        const before = fs.readFileSync(f.configPath);
        const receiverMode = fs.readFileSync(path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`));
        const restarted = capture(() => runEnterTaskMode({ repoRoot: f.root, taskId: HELD_TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: '2', taskSummary: 'Restart the held owner in a new cycle.',
            plannedChangedFiles: [HELD_SOURCE, HELD_TARGET], allowedActiveTasks: [TASK_ID],
            operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() }));
        assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
        assert.throws(() => assertTaskTestSelectionCurrent(roots, authority), /owner|current active task/i);
        const auditPath = path.join(f.bundle, 'runtime/workflow-config-audit.jsonl');
        const auditBefore = fs.existsSync(auditPath) ? fs.readFileSync(auditPath) : null;
        assert.throws(() => writeWorkflowConfigAuditRecord(f.bundle, f.configPath,
            ['full_suite_validation.command'], before.toString(), JSON.stringify(next),
            { targetRoot: f.root, taskTestSelection: authority }), /owner|current active task|changed task cycle/i);
        assert.deepEqual(fs.existsSync(auditPath) ? fs.readFileSync(auditPath) : null, auditBefore);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        assert.deepEqual(fs.readFileSync(path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`)), receiverMode);
    } finally { f.cleanup(); }
});

test('rejects missing and stale prompt confirmation and preserves unrelated settings guard', () => {
    const f = fixture({ prompt: true });
    try {
        const before = fs.readFileSync(f.configPath);
        assert.throws(() => select(f.root), /operator/i);
        assert.throws(() => select(f.root, { extra: ['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', '2000-01-01T00:00:00Z'] }), /fresh|old|expired|age/i);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        const result = select(f.root, { extra: buildOperatorConfirmationArgs() });
        assert.ok(result && result.action === 'set' && result.changed);
        assert.throws(() => capture(() => handleWorkflow(['set', '--target-root', f.root,
            '--task-test-selection-require-operator-confirmation', 'false'], PACKAGE_JSON)), /operator/i);
        const off = capture(() => handleWorkflow(['set', '--target-root', f.root,
            '--task-test-selection-require-operator-confirmation', 'false', ...buildOperatorConfirmationArgs()], PACKAGE_JSON));
        assert.ok(off && off.action === 'set');
        assert.equal(off.task_test_selection.require_operator_confirmation, false);
        for (const [flag, value] of [['--full-suite-enabled', 'false'], ['--full-suite-timeout-ms', '1000'],
            ['--full-suite-timeout-retry-count', '0'], ['--review-execution-policy', 'parallel_all']]) {
            assert.throws(() => capture(() => handleWorkflow(['set', '--target-root', f.root, flag, value], PACKAGE_JSON)), /operator/i);
        }
    } finally { f.cleanup(); }
});

test('selector rejects gate-disable and no-op piggyback requests before all writes', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.configPath);
        const timeline = fs.readFileSync(f.timeline);
        for (const extra of [['--full-suite-enabled', 'false'], ['--full-suite-enabled', 'true'],
            ['--full-suite-timeout-ms', String(f.config.full_suite_validation.timeout_ms)],
            ['--task-test-selection-require-operator-confirmation', 'false'], ['--garda-self-guard', 'on'],
            ['--optional-check-rule-id', 'code_simplification', '--optional-check-rule-enabled', 'true'],
            ['--optional-check-rule-id', 'code_simplification'], ['--optional-check-rule-enabled', 'true']]) {
            assert.throws(() => select(f.root, { extra }), /only full_suite_validation.command/i);
        }
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        assert.deepEqual(fs.readFileSync(f.timeline), timeline);
        assert.equal(fs.existsSync(path.join(f.bundle, 'runtime/workflow-config-audit.jsonl')), false);
    } finally { f.cleanup(); }
});

test('selector rejects empty authority, unrelated and linked targets, no-op interpreters and foreign commands', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.configPath);
        for (const command of ['true', `node -e "console.log('${TARGET}')"`,
            `node --test ${TARGET} && true`, `bash -c "node --test ${TARGET}"`,
            `node --test /tmp/${TARGET}`, `node --test ../${TARGET}`]) {
            assert.throws(() => select(f.root, { command }), /rejected/i, command);
        }
        assert.throws(() => select(f.root, { reason: 'because it is available' }), /--reason/i);
        assert.throws(() => select(f.root, { reason: `${TASK_ID} verifies <task behavior and regression relationships>` }), /--reason/i);
        assert.throws(() => select(f.root, { command: `node --test ${SECOND_TARGET}`, targets: [SECOND_TARGET] }), /explicit relationship/i);
        assert.throws(() => select(f.root, { targets: [TARGET, TARGET] }), /duplicate/i);
        assert.throws(() => select(f.root, { targets: [SOURCE], command: `node --test ${SOURCE}` }), /product code.*test target/i);
        const link = path.join(f.root, 'tests/linked.test.js');
        fs.linkSync(path.join(f.root, TARGET), link);
        assert.throws(() => select(f.root), /without links/i);
        fs.unlinkSync(link);
        fs.symlinkSync(path.join(f.root, TARGET), link);
        assert.throws(() => select(f.root, { targets: ['tests/linked.test.js'], command: 'node --test tests/linked.test.js',
            reason: `${TASK_ID} tests/linked.test.js covers ${SOURCE}` }), /without links/i);
        fs.unlinkSync(link);
        const partial = selector(f.root).filter((_, i, args) => i !== args.indexOf('--reason') && i !== args.indexOf('--reason') + 1);
        assert.throws(() => capture(() => handleWorkflow(partial, PACKAGE_JSON)), /--task-id and --reason are required/i);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
    } finally { f.cleanup(); }
});

test('explicit multiple targets use native validation and broader commands keep their declared task targets', () => {
    const f = fixture();
    try {
        const result = select(f.root, { command: `node --test ${TARGET} ${SECOND_TARGET}`, targets: [TARGET, SECOND_TARGET],
            reason: `${TASK_ID} ${TARGET} covers ${SOURCE}; ${SECOND_TARGET} guards ${SOURCE} regression` });
        assert.ok(result && result.action === 'set' && result.audit_path);
        const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8').trim().split('\n').at(-1)!).details;
        assert.deepEqual(audit.task_test_selection_authority.targets.map((item: { path: string }) => item.path), [TARGET, SECOND_TARGET]);
        assert.ok(select(f.root, { command: `node --test ${TARGET} ${SECOND_TARGET}` }));
        assert.deepEqual(loadTaskFullSuiteConfig(f.root, TASK_ID).selection.targets, [TARGET]);
    } finally { f.cleanup(); }
});

test('missing, tampered, terminal and foreign task evidence never authorizes selector writes', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.configPath);
        const artifact = path.join(f.bundle, 'runtime/reviews', `${TASK_ID}-task-mode.json`);
        const mode = fs.readFileSync(artifact);
        fs.unlinkSync(artifact);
        assert.throws(() => select(f.root), /task-mode evidence/i);
        fs.writeFileSync(artifact, mode);
        const timeline = fs.readFileSync(f.timeline);
        fs.appendFileSync(f.timeline, '{invalid}\n');
        assert.throws(() => select(f.root), /native task timeline/i);
        fs.writeFileSync(f.timeline, timeline);
        const raw = JSON.parse(mode.toString()); raw.task_id = 'T-FOREIGN';
        fs.writeFileSync(artifact, JSON.stringify(raw));
        assert.throws(() => select(f.root), /task-mode evidence/i);
        fs.writeFileSync(artifact, mode);
        const foreign = { ...resolveWorkflowRoots({ targetRoot: f.root }), bundleRoot: path.dirname(f.bundle) };
        assert.throws(() => resolveTaskTestSelectionAuthority({ taskId: TASK_ID, taskTestSelectionReason: `${TASK_ID} covers ${SOURCE}`,
            focusedRequiredTestPath: [TARGET] }, foreign, f.config, f.config, ['full_suite_validation.command']), /canonical worktree/i);
        appendMandatoryTaskEvent(f.bundle, TASK_ID, 'STATUS_CHANGED', 'PASS', 'Terminal fixture.',
            { old_status: 'IN_PROGRESS', new_status: 'DONE' });
        assert.throws(() => select(f.root), /current active task/i);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
    } finally { f.cleanup(); }
});

test('rejects stale prepared authority after independent target, source and task changes', () => {
    const f = fixture();
    try {
        const roots = resolveWorkflowRoots({ targetRoot: f.root });
        const next = JSON.parse(JSON.stringify(f.config)); next.full_suite_validation.command = `node --test ${TARGET}`;
        const prepare = () => resolveTaskTestSelectionAuthority({ taskId: TASK_ID,
            taskTestSelectionReason: `${TASK_ID} covers ${SOURCE}`, focusedRequiredTestPath: [TARGET] },
            roots, f.config, next, ['full_suite_validation.command']);
        const targetAuthority = prepare();
        assert.ok(targetAuthority);
        fs.appendFileSync(path.join(f.root, TARGET), '// changed\n');
        assert.throws(() => assertTaskTestSelectionCurrent(roots, targetAuthority), /changed before publication|preflight.*stale/i);
        classifyCurrent(f);
        const sourceAuthority = prepare();
        assert.ok(sourceAuthority);
        fs.appendFileSync(path.join(f.root, SOURCE), '// independent source change\n');
        assert.throws(() => assertTaskTestSelectionCurrent(roots, sourceAuthority), /changed before publication|preflight.*stale/i);
        classifyCurrent(f);
        const taskAuthority = prepare();
        assert.ok(taskAuthority);
        capture(() => runEnterTaskMode({ repoRoot: f.root, taskId: TASK_ID, entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: '2', taskSummary: 'Update widget behavior in a fresh cycle.', plannedChangedFiles: [SOURCE, TARGET] }));
        assert.throws(() => assertTaskTestSelectionCurrent(roots, taskAuthority), /changed before publication|preflight.*task-mode cycle/i);
    } finally { f.cleanup(); }
});

test('selector rejects an invalid task timeline without modifying shared config', () => {
    const f = fixture();
    const before = fs.readFileSync(f.configPath);
    try {
        fs.appendFileSync(f.timeline, '{invalid}\n');
        assert.throws(() => select(f.root), /timeline/i);
        assert.deepEqual(fs.readFileSync(f.configPath), before);
        assert.equal(fs.existsSync(path.join(f.bundle, 'runtime/workflow-config-audit.jsonl')), false);
        assert.equal(readTaskTimelineJsonlEntries(f.timeline).some(item => item.record?.event_type === 'TASK_TEST_SELECTION_RECORDED'), false);
    } finally { f.cleanup(); }
});

test('disabled test gate never receives autonomous selection', () => {
    const f = fixture({ enabled: false });
    try { assert.throws(() => select(f.root), /enabled test gate/i); } finally { f.cleanup(); }
});
