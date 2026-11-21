import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appendMandatoryTaskEventAsync } from '../../../../../../src/gate-runtime/task-events';
import {
    assert, describe, it, fs, path, createTempRepo, seedRemediationRepoBase,
    initializeGitRepo, seedTaskQueue, seedInitAnswers, runEnterTaskMode,
    loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask,
    runExplicitPreflight, loadPostPreflightRulePack, runCompileGateCommand,
    writeSimpleCompileCommandsFile, prepareCurrentReviewCycleValidation,
    writeCurrentReviewCycleValidationSource, writeReceiptBackedReviewArtifact,
    buildCurrentReviewCycleCaseResolutions, readTaskTimelineEvents, getReviewsRoot,
    buildDefaultRemediationImpactAnalysis, runRestartReviewCycleCommandRaw,
    TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH, prepareScopedDiffFixture, runBuildReviewContextCommand
} from './gates-review-cycle-fixtures';
import { runIntermediateCommandCommand } from '../../../../../../src/cli/commands/gate-flows/command-run/command-run-flow';
import { runFullSuiteValidationCommand, runQualityChecklistCommand } from '../../../../../../src/cli/commands/gates';
import {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES, isOptionalQualityCheckRuleActiveForScope
} from '../../../../../../src/core/workflow-config';
import {
    assessTrustBoundaryAnalysisApplicability, TRUST_BOUNDARY_ANALYSIS_RULE_ID
} from '../../../../../../src/core/trust-boundary-analysis';
import { selectConfiguredTaskTests } from '../../../../task-test-selection-fixtures';
import { resolveNextStep } from '../../../../gates/next-step/next-step-test-support';
import { rebuildAndPersistIndex } from '../../../../../../src/gate-runtime/reviews-index';
import { readReviewCycleGuardEvaluation } from '../../../../../../src/gates/next-step/next-step-review-cycle-guard-evaluation';
import {
    readReviewRecoveryValidation, readReviewValidationCheckpoint
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-validation-checkpoint';

async function createRecoveryFixture(t: TestContext, taskId: string,
    fullSuite: boolean | 'before_test_review' = false, customMode = false,
    unrelatedLastSource?: 'typecheck' | 'targeted-test', recoveryLane: 'code' | 'test' = 'code') {
    const repoRoot = createTempRepo(t);
    seedRemediationRepoBase(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 1;\n');
    writeCurrentReviewCycleValidationSource(repoRoot);
    const remediationFile = recoveryLane === 'test' ? 'tests/leaf-remediation.test.ts' : 'src/app.ts';
    const writeRemediation = (value: number) => fs.writeFileSync(path.join(repoRoot, remediationFile),
        recoveryLane === 'test'
            ? `const test = require('node:test'); const assert = require('node:assert/strict');\ntest('leaf coverage', () => assert.equal(${value}, ${value}));\n`
            : `export const value = ${value};\n`);
    if (recoveryLane === 'test') {
        writeRemediation(1);
        const profilesPath = path.join(repoRoot, 'garda-agent-orchestrator/live/config/profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
        profiles.built_in_profiles.balanced.review_policy = {
            ...profiles.built_in_profiles.balanced.review_policy,
            code: false, db: false, security: false, refactor: false
        };
        fs.writeFileSync(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`);
    }
    const unrelatedFile = 'tests/unrelated-recovery-validation.test.ts';
    if (unrelatedLastSource === 'targeted-test') {
        fs.writeFileSync(path.join(repoRoot, unrelatedFile),
            "const test = require('node:test'); const assert = require('node:assert/strict');\ntest('unrelated check', () => assert.equal(1, 1));\n");
    }
    const commands = writeSimpleCompileCommandsFile(repoRoot, 'selected-case-recovery');
    if (fullSuite) {
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.full_suite_validation = { ...config.full_suite_validation, enabled: true,
            placement: fullSuite === 'before_test_review' ? fullSuite : 'after_compile_before_reviews',
            command: `node --experimental-strip-types --test --test-reporter=tap ${TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH}`
                + (recoveryLane === 'test' ? ` && node --experimental-strip-types --test --test-reporter=tap ${remediationFile}` : '') };
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot, 'Codex');
    const taskModePath = customMode ? path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`) : undefined;
    runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Recover selected-case review validation', artifactPath: taskModePath });
    loadTaskEntryRulePack(repoRoot, taskId, taskModePath);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    writeRemediation(2);
    const preflightPath = runExplicitPreflight(repoRoot, taskId,
        'Recover selected-case review validation', [remediationFile], `${taskId}-preflight.json`, taskModePath);
    await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
    loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath);
    const compile = await runCompileGateCommand({ repoRoot, taskId, taskModePath, preflightPath, ...commands, emitMetrics: false });
    assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
    if (fullSuite) await runCurrentScopedSuite({ repoRoot, taskId, preflightPath });
    const quality = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-quality-checklist.json`), 'utf8'));
    const matrix = quality.answers.find((answer: { rule_id: string }) => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID)
        .trust_boundary_matrix;
    if (unrelatedLastSource) {
        const context = process.env.NODE_TEST_CONTEXT;
        try {
            delete process.env.NODE_TEST_CONTEXT;
            const extra = await runIntermediateCommandCommand({ repoRoot, taskId, preflightPath,
                commandSource: unrelatedLastSource, command: unrelatedLastSource === 'typecheck'
                    ? `node --check ${TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH}`
                    : `node --experimental-strip-types --test --test-reporter=tap ${unrelatedFile}` });
            assert.equal(extra.exitCode, 0, extra.outputLines.join('\n'));
        } finally {
            if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
            else process.env.NODE_TEST_CONTEXT = context;
        }
    }
    if (customMode) {
        prepareScopedDiffFixture(repoRoot, preflightPath, 'code');
        await runBuildReviewContextCommand({ repoRoot, reviewType: 'code', depth: 2, preflightPath, taskModePath });
    }
    writeReceiptBackedReviewArtifact(repoRoot, taskId, recoveryLane, `${recoveryLane.toUpperCase()} REVIEW FAILED`, undefined,
        { findingSeverity: 'high', preserveExistingReviewContext: customMode,
            caseResolutions: buildCurrentReviewCycleCaseResolutions(repoRoot, taskId) });
    rebuildAndPersistIndex(getReviewsRoot(repoRoot));
    const guard = readReviewCycleGuardEvaluation(repoRoot,
        path.join(getReviewsRoot(repoRoot), '..', 'task-events'), taskId);
    assert.deepEqual(guard.evaluation.violations, [], JSON.stringify(guard.evaluation));
    const failedReview = fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-${recoveryLane}.md`));
    writeRemediation(3);
    const restartOptions = {
        repoRoot, taskId, taskModePath, preflightPath, ...commands, reviewType: recoveryLane, emitMetrics: false,
        impactAnalysis: buildDefaultRemediationImpactAnalysis([remediationFile], preflightPath)
    };
    return { repoRoot, taskId, preflightPath, matrix, failedReview, restartOptions };
}

async function runCurrentScopedSuite(fixture: { repoRoot: string; taskId: string; preflightPath: string }) {
    const context = process.env.NODE_TEST_CONTEXT;
    try {
        delete process.env.NODE_TEST_CONTEXT;
        selectConfiguredTaskTests(fixture.repoRoot, fixture.taskId, fixture.preflightPath);
        const suite = await runFullSuiteValidationCommand(fixture);
        assert.equal(suite.exitCode, 0, suite.outputText);
    } finally {
        if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = context;
    }
}

async function runSelectedValidation(fixture: Awaited<ReturnType<typeof createRecoveryFixture>>,
    command = `node --experimental-strip-types --test --test-reporter=tap ${TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH}`) {
    const { repoRoot, taskId, preflightPath } = fixture;
    const context = process.env.NODE_TEST_CONTEXT;
    try {
        delete process.env.NODE_TEST_CONTEXT;
        return await runIntermediateCommandCommand({ repoRoot, taskId, preflightPath,
            commandSource: 'targeted-test', command });
    } finally {
        if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = context;
    }
}

async function runCurrentValidation(fixture: Awaited<ReturnType<typeof createRecoveryFixture>>) {
    const { repoRoot, taskId, preflightPath, matrix } = fixture;
    const execution = await runSelectedValidation(fixture);
    assert.equal(execution.exitCode, 0, execution.outputLines.join('\n'));
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    const answers = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
        .filter(rule => rule.enabled !== false
            && (isOptionalQualityCheckRuleActiveForScope(rule, preflight.scope_category, preflight.changed_files)
                || (rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID
                    && assessTrustBoundaryAnalysisApplicability(preflight).required)))
        .map(rule => ({ rule_id: rule.id, status: 'PASS',
            answer: `Checked ${rule.id} against the isolated native recovery fixture and genuine selected assertion.`,
            evidence_files: [TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH], actions_taken: [], actions_required: [],
            ...(rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: matrix } : {}) }));
    const quality = runQualityChecklistCommand({ repoRoot, taskId, preflightPath,
        answersJson: JSON.stringify(answers), emitMetrics: false });
    assert.equal(quality.exitCode, 0, quality.outputLines.join('\n'));
}

function recoveryEventCounts(repoRoot: string, taskId: string) {
    const events = readTaskTimelineEvents(repoRoot, taskId);
    return Object.fromEntries(['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_CYCLE_RESTARTED']
        .map(type => [type, events.filter(event => event.event_type === type).length]));
}

async function restartWithoutValidation(fixture: Awaited<ReturnType<typeof createRecoveryFixture>>,
    options: Parameters<typeof runRestartReviewCycleCommandRaw>[0] = fixture.restartOptions) {
    const before = recoveryEventCounts(fixture.repoRoot, fixture.taskId);
    const result = await runRestartReviewCycleCommandRaw(options);
    assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
    assert.match(result.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/u);
    assert.doesNotMatch(result.outputLines.join('\n'), /REVIEW_CYCLE_RECOVERY_PENDING/u);
    assert.deepEqual(recoveryEventCounts(fixture.repoRoot, fixture.taskId), {
        ...before, PREFLIGHT_CLASSIFIED: before.PREFLIGHT_CLASSIFIED + 1,
        COMPILE_GATE_PASSED: before.COMPILE_GATE_PASSED + 1,
        REVIEW_CYCLE_RESTARTED: before.REVIEW_CYCLE_RESTARTED + 1
    });
    assert.equal(readReviewValidationCheckpoint(fixture.repoRoot, fixture.taskId), null);
    return result;
}

async function buildCurrentContext(fixture: Awaited<ReturnType<typeof createRecoveryFixture>>, reviewType = 'code') {
    prepareScopedDiffFixture(fixture.repoRoot, fixture.preflightPath, reviewType);
    return runBuildReviewContextCommand({ repoRoot: fixture.repoRoot,
        reviewType, depth: 2, preflightPath: fixture.preflightPath, taskModePath: fixture.restartOptions.taskModePath });
}

describe('native selected-case review recovery in the completed cycle', () => {
    it('completes restart before validation and keeps current execution required before contexts', { concurrency: false }, async t => {
        const fixture = await createRecoveryFixture(t, 'T-SELECTED-RECOVERY');
        const { repoRoot, taskId } = fixture;
        await restartWithoutValidation(fixture);
        const restarted = recoveryEventCounts(repoRoot, taskId);
        assert.deepEqual(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code.md`)), fixture.failedReview);
        await assert.rejects(buildCurrentContext(fixture), /selected|execution|quality|validation|GREEN/iu);
        const waiting = resolveNextStep({ repoRoot, taskId });
        assert.notEqual(waiting.next_gate, 'restart-review-cycle', waiting.reason);
        assert.notEqual(waiting.next_gate, 'restart-coherent-cycle', waiting.reason);
        await runCurrentValidation(fixture);
        const built = await buildCurrentContext(fixture);
        assert.equal(built.reviewType, 'code', built.outputLines.join('\n'));
        assert.deepEqual(recoveryEventCounts(repoRoot, taskId), restarted);
    });

    it('preserves a custom task-mode artifact binding without another task entry', { concurrency: false }, async t => {
        const fixture = await createRecoveryFixture(t, 'T-CUSTOM-RECOVERY', false, true);
        const taskModePath = String(fixture.restartOptions.taskModePath);
        const original = fs.readFileSync(taskModePath);
        await restartWithoutValidation(fixture);
        assert.deepEqual(fs.readFileSync(taskModePath), original);
        const decision = resolveNextStep(fixture);
        const modeArtifact = decision.present_artifacts.find(artifact => artifact.key === 'task-mode');
        assert.ok(modeArtifact);
        assert.equal(path.resolve(fixture.repoRoot, modeArtifact.path), path.resolve(taskModePath));
        await runCurrentValidation(fixture);
        const built = await buildCurrentContext(fixture);
        assert.equal(built.reviewType, 'code', built.outputLines.join('\n'));
    });

    it('accepts an omitted default preflight without a resumable request', { concurrency: false }, async t => {
        const fixture = await createRecoveryFixture(t, 'T-IMPLICIT-PREFLIGHT-RECOVERY');
        await restartWithoutValidation(fixture, { ...fixture.restartOptions, preflightPath: undefined });
        await runCurrentValidation(fixture);
        const built = await buildCurrentContext(fixture);
        assert.equal(built.reviewType, 'code', built.outputLines.join('\n'));
    });

    it('authenticates the actual alternate preflight and refuses the stale default snapshot', { concurrency: false }, async t => {
        const fixture = await createRecoveryFixture(t, 'T-ALTERNATE-RECOVERY');
        const { repoRoot, taskId } = fixture;
        const original = fs.readFileSync(fixture.preflightPath);
        const alternate = path.join(getReviewsRoot(repoRoot), `${taskId}-alternate-preflight.json`);
        await restartWithoutValidation(fixture, { ...fixture.restartOptions, preflightOutputPath: alternate });
        const classified = readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'PREFLIGHT_CLASSIFIED').at(-1);
        const details = classified?.details as Record<string, unknown>;
        assert.equal(path.resolve(String(details.output_path)), path.resolve(alternate));
        const payload = JSON.parse(fs.readFileSync(alternate, 'utf8'));
        assert.deepEqual(details.effective_review_snapshot, payload.effective_review_snapshot);
        // Navigator uses the canonical filename. It must never treat its older bytes as the alternate classification.
        assert.throws(() => resolveNextStep({ repoRoot, taskId }),
            /effective review snapshot does not match the latest PREFLIGHT_CLASSIFIED/u);
        const actual = { ...fixture, preflightPath: alternate };
        await runCurrentValidation(actual);
        const built = await buildCurrentContext(actual);
        assert.equal(built.reviewType, 'code', built.outputLines.join('\n'));
        assert.deepEqual(fs.readFileSync(fixture.preflightPath), original);
        assert.equal(recoveryEventCounts(repoRoot, taskId).REVIEW_CYCLE_RESTARTED, 1);
    });

    for (const source of ['typecheck', 'targeted-test'] as const) {
        it(`retains selected-case validation after an unrelated ${source}`, { concurrency: false }, async t => {
            const fixture = await createRecoveryFixture(t, `T-COMMAND-${source.toUpperCase()}`, false, false, source);
            await restartWithoutValidation(fixture);
            await assert.rejects(buildCurrentContext(fixture), /selected|execution|quality|validation|GREEN/iu);
            await runCurrentValidation(fixture);
            const built = await buildCurrentContext(fixture);
            assert.equal(built.reviewType, 'code', built.outputLines.join('\n'));
        });
    }

    it('retains later failed and unfinished execution vetoes after the completed restart', { concurrency: false }, async t => {
        const fixture = await createRecoveryFixture(t, 'T-RECOVERY-ATTEMPTS');
        await restartWithoutValidation(fixture);
        await runCurrentValidation(fixture);
        const failed = await runSelectedValidation(fixture,
            `node --experimental-strip-types --test --test-reporter=missing-recovery-reporter ${TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH}`);
        assert.notEqual(failed.exitCode, 0, failed.outputLines.join('\n'));
        await assert.rejects(buildCurrentContext(fixture), /selected|execution|quality|validation|GREEN/iu);
        await runCurrentValidation(fixture);
        const latestStart = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId)
            .filter(event => event.event_type === 'INTERMEDIATE_COMMAND_STARTED').at(-1);
        assert.ok(latestStart?.details);
        await appendMandatoryTaskEventAsync(path.join(fixture.repoRoot, 'garda-agent-orchestrator'), fixture.taskId,
            'INTERMEDIATE_COMMAND_STARTED', 'STARTED', 'Model interruption after native command capture.',
            { ...latestStart.details, execution_id: randomUUID(),
                artifact_path: path.join(getReviewsRoot(fixture.repoRoot), `${fixture.taskId}-unfinished.json`) }, { actor: 'gate' });
        await assert.rejects(buildCurrentContext(fixture), /selected|execution|quality|validation|GREEN/iu);
        await runCurrentValidation(fixture);
        const built = await buildCurrentContext(fixture);
        assert.equal(built.reviewType, 'code', built.outputLines.join('\n'));
    });

    async function checkScopedSuite(t: TestContext, taskId: string,
        placement: true | 'before_test_review', lane: 'code' | 'test') {
        const fixture = await createRecoveryFixture(t, taskId, placement, false, undefined, lane);
        const { repoRoot } = fixture;
        await restartWithoutValidation(fixture);
        await runCurrentValidation(fixture);
        const selection = resolveNextStep(fixture);
        assert.equal(selection.next_gate, 'task-test-selection', selection.reason);
        selectConfiguredTaskTests(repoRoot, taskId, fixture.preflightPath);
        const waiting = resolveNextStep(fixture);
        assert.equal(waiting.next_gate, 'full-suite-validation', waiting.reason);
        assert.match(waiting.commands[0].command, /gate (?:full-suite|task-test)-validation/u);
        assert.equal(readReviewRecoveryValidation(repoRoot, taskId, lane).ready, false);
        const before = recoveryEventCounts(repoRoot, taskId);
        await runCurrentScopedSuite(fixture);
        assert.equal(readReviewRecoveryValidation(repoRoot, taskId, lane).ready, true);
        const built = await buildCurrentContext(fixture, lane);
        assert.equal(built.reviewType, lane, built.outputLines.join('\n'));
        assert.deepEqual(recoveryEventCounts(repoRoot, taskId), before);
    }

    it('routes the before-test suite after re-selecting tests in the completed recovery', { concurrency: false }, async t => {
        await checkScopedSuite(t, 'T-TEST-LANE-SUITE', 'before_test_review', 'test');
    });

    it('does not move the before-test suite ahead of code review', { concurrency: false }, async t => {
        const fixture = await createRecoveryFixture(t, 'T-CODE-LANE-SUITE', 'before_test_review');
        await restartWithoutValidation(fixture);
        await runCurrentValidation(fixture);
        const built = await buildCurrentContext(fixture);
        assert.equal(built.reviewType, 'code', built.outputLines.join('\n'));
        assert.equal(recoveryEventCounts(fixture.repoRoot, fixture.taskId).REVIEW_CYCLE_RESTARTED, 1);
    });

    it('keeps the configured scoped suite after re-selecting tests in the completed recovery', { concurrency: false }, async t => {
        await checkScopedSuite(t, 'T-RECOVERY-SUITE', true, 'code');
    });
});
