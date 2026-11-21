import {
    assert, it, fs, path, createTempRepo, getReviewsRoot, initializeGitRepo,
    seedRemediationRepoBase, writeCurrentReviewCycleValidationSource, writeReviewCapabilitiesConfig,
    writeProfilesConfig, writeWorkflowConfig, writeSimpleCompileCommandsFile, seedTaskQueue, seedInitAnswers, runEnterTaskMode,
    loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask, runExplicitPreflight,
    prepareCurrentReviewCycleValidation, loadPostPreflightRulePack, writeCompilePassEvidence,
    writeReceiptBackedReviewArtifact, buildCurrentReviewCycleCaseResolutions, runRestartReviewCycleCommand, runRestartCoherentCycleCommand,
    readTaskTimelineEvents, runBuildReviewContextCommand, prepareScopedDiffFixture, getOrchestratorRoot
} from './gates-review-cycle-fixtures';
import { handleRecordReviewResult } from '../../../../../../src/cli/commands/gate-review-handlers';
import { hasTaskCriteriaChanged } from '../../../../../../src/gates/review-context/review-context-task-criteria-binding';

for (const intentPath of ['agent', 'operator', 'confirm-supplement']) it(`intent authority: ${intentPath === 'confirm-supplement' ? 'operator can confirm the same words as an earlier agent supplement' : intentPath === 'operator' ? 'operator change repeats every mandatory lane in FULL' : 'agent supplement preserves accepted code/db/security reviews'}`, async () => {
    const operatorConfirmed = intentPath !== 'agent';
    const repoRoot = createTempRepo();
    const taskId = `T-intent-authority-${operatorConfirmed ? 'operator' : 'agent'}`;
    const original = 'Export personal data securely';
    const refined = original + '; require the recorded acceptance examples to cover empty input';
    try {
        seedRemediationRepoBase(repoRoot);
        writeCurrentReviewCycleValidationSource(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        writeWorkflowConfig(repoRoot, 'parallel_all');
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'intent-refinement');
        fs.mkdirSync(path.join(repoRoot, 'db'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'db/schema.sql'), 'create table exports(id integer primary key);\n');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs/intent.md'), 'Existing behavior notes.\n');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'), `\n## Operator Decisions\n\n- ${taskId} operator decision (2026-11-12): Export personal data with authentication, authorization, encrypted archive integrity and current-access revocation.\n`);
        seedInitAnswers(repoRoot, 'Codex');
        const changedFiles = ['src/app.ts', 'db/schema.sql', 'tests/app.test.ts', 'docs/intent.md'];
        runEnterTaskMode({ repoRoot, taskId, taskSummary: original, plannedChangedFiles: changedFiles });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 1;\n');
        fs.writeFileSync(path.join(repoRoot, 'db/schema.sql'), 'create table exports(id bigint primary key);\n');
        fs.writeFileSync(path.join(repoRoot, 'tests/app.test.ts'), 'it("checks export", () => {});\n');
        fs.appendFileSync(path.join(repoRoot, 'docs/intent.md'), 'Document current behavior.\n');
        const preflightPath = runExplicitPreflight(repoRoot, taskId, original, changedFiles);
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const reviewsRoot = getReviewsRoot(repoRoot);
        const passed: Array<{ lane: string; context: { task_criteria_binding: unknown }; receiptSnapshotPath: string; receiptSnapshot: Buffer }> = [];
        for (const lane of ['code', 'db', 'security']) {
            const contextPath = path.join(reviewsRoot, `${taskId}-${lane}-review-context.json`);
            writeReceiptBackedReviewArtifact(repoRoot, taskId, lane, lane === 'code' ? 'REVIEW PASSED' : `${lane.toUpperCase()} REVIEW PASSED`,
                undefined, { authenticatedNavigatorLaunch: true, skipReceipt: true,
                    caseResolutions: buildCurrentReviewCycleCaseResolutions(repoRoot, taskId) });
            const launch = JSON.parse(fs.readFileSync(path.join(getOrchestratorRoot(repoRoot),
                'runtime/tmp/reviews', taskId, lane, 'reviewer-launch.json'), 'utf8'));
            const outputPath = path.resolve(repoRoot, launch.review_output_path);
            fs.copyFileSync(path.join(reviewsRoot, `${taskId}-${lane}.md`), outputPath);
            await handleRecordReviewResult(['--task-id', taskId, '--review-type', lane, '--preflight-path', preflightPath,
                '--review-context-path', contextPath, '--review-output-path', outputPath,
                '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', launch.reviewer_identity, '--repo-root', repoRoot]);
            const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            const baseline = JSON.parse(fs.readFileSync(path.join(reviewsRoot, `${taskId}-${lane}-remediation-baseline.json`), 'utf8'));
            const receiptSnapshotPath = path.resolve(repoRoot, baseline.bindings.receipt.snapshot_path);
            passed.push({ lane, context, receiptSnapshotPath,
                receiptSnapshot: fs.readFileSync(receiptSnapshotPath) });
        }
        const before = readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'REVIEW_RECORDED').length;
        const taskQueueBefore = fs.readFileSync(path.join(repoRoot, 'TASK.md'));
        if (intentPath === 'operator') fs.appendFileSync(path.join(repoRoot, 'docs/intent.md'), 'Clarify the existing boundary example.\n'.repeat(8));
        if (intentPath === 'confirm-supplement') {
            const supplement = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
                changedFiles, taskIntent: refined });
            assert.equal(supplement.exitCode, 0, supplement.outputLines.join('\n'));
            assert.equal(readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'TASK_INTENT_UPDATED').length, 0);
        }
        // Exactly the same wording travels through both paths. Only operator confirmation differs.
        const restart = operatorConfirmed
            ? await runRestartCoherentCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
                changedFiles, taskIntent: refined, operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() })
            : await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
                changedFiles, taskIntent: refined });
        assert.equal(restart.exitCode, 0, restart.outputLines.join('\n'));
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'TASK_INTENT_UPDATED').length,
            operatorConfirmed ? 1 : 0);
        assert.deepEqual(fs.readFileSync(path.join(repoRoot, 'TASK.md')), taskQueueBefore);
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
        const currentPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        const required = Object.entries(currentPreflight.required_reviews).filter(([, value]) => value === true).map(([lane]) => lane);
        assert.ok(['code', 'db', 'security', 'test'].every(lane => required.includes(lane)));
        for (const lane of required) {
            const contextPath = path.join(reviewsRoot, `${taskId}-${lane}-review-context.json`);
            prepareScopedDiffFixture(repoRoot, preflightPath, lane);
            const built = await runBuildReviewContextCommand({ repoRoot, reviewType: lane, depth: 3, preflightPath, outputPath: contextPath });
            assert.ok(fs.existsSync(contextPath), built.outputLines.join('\n'));
            const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            assert.equal(context.task_criteria.task_intent.text, refined);
            assert.equal(hasTaskCriteriaChanged(passed[0].context.task_criteria_binding, context.task_criteria_binding), operatorConfirmed);
            const prior = passed.find(review => review.lane === lane);
            if (prior) {
                assert.equal(!!built.reusedReviewEvidence || built.outputLines.includes('CurrentPassReviewEvidence: True'), !operatorConfirmed,
                    `${lane}: ${built.outputLines.join('\n')}`);
                assert.deepEqual(fs.readFileSync(prior.receiptSnapshotPath), prior.receiptSnapshot);
            }
            if (operatorConfirmed) assert.equal(context.review_execution.mode, 'FULL', lane);
        }
        const freshAfter = readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'REVIEW_RECORDED'
            && !(event.details as Record<string, unknown>)?.reused_existing_review).length;
        assert.equal(freshAfter, before, 'context reconstruction cannot launch or invent fresh reviews');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
