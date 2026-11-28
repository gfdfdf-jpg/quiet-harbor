import {
    assert, it, fs, path, createTempRepo, getReviewsRoot, initializeGitRepo,
    seedRemediationRepoBase, writeCurrentReviewCycleValidationSource, writeReviewCapabilitiesConfig,
    writeProfilesConfig, writeSimpleCompileCommandsFile, seedTaskQueue, seedInitAnswers, runEnterTaskMode,
    loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask, runExplicitPreflight,
    prepareCurrentReviewCycleValidation, loadPostPreflightRulePack, writeCompilePassEvidence,
    writeReceiptBackedReviewArtifact, buildCurrentReviewCycleCaseResolutions, runRestartReviewCycleCommand,
    readTaskTimelineEvents, runBuildReviewContextCommand, prepareScopedDiffFixture, getOrchestratorRoot
} from './gates-review-cycle-fixtures';
import { handleRecordReviewResult } from '../../../../../../src/cli/commands/gate-review-handlers';
import { readPreservedReviewContextCopy } from '../../../../../../src/gates/review/review-artifact-recovery';
import { taskIntentSha256 } from '../../../../../../src/gates/review-context/review-context-task-criteria-binding';
import { fileSha256 } from '../../../../../../src/gates/shared/helpers';

it('keeps code/db/security PASS after wording refinement, audits both intents and hands the new intent to the next reviewer', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-intent-refinement';
    const original = 'Export personal data securely';
    const refined = 'Export personal data securely: authentication, authorization, encrypted archive integrity and current-access revocation';
    try {
        seedRemediationRepoBase(repoRoot);
        writeCurrentReviewCycleValidationSource(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'intent-refinement');
        fs.mkdirSync(path.join(repoRoot, 'db'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'db/schema.sql'), 'create table exports(id integer primary key);\n');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'), `\n## Operator Decisions\n\n- ${taskId} operator decision (2026-11-12): Export personal data with authentication, authorization, encrypted archive integrity and current-access revocation.\n`);
        seedInitAnswers(repoRoot, 'Codex');
        const changedFiles = ['src/app.ts', 'db/schema.sql', 'tests/app.test.ts'];
        runEnterTaskMode({ repoRoot, taskId, taskSummary: original, plannedChangedFiles: changedFiles });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 1;\n');
        fs.writeFileSync(path.join(repoRoot, 'db/schema.sql'), 'create table exports(id bigint primary key);\n');
        fs.writeFileSync(path.join(repoRoot, 'tests/app.test.ts'), 'it("checks export", () => {});\n');
        const preflightPath = runExplicitPreflight(repoRoot, taskId, original, changedFiles);
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const reviewsRoot = getReviewsRoot(repoRoot);
        const passed = [];
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
            passed.push({ lane, contextPath, context, sha256: fileSha256(contextPath)!, receiptSnapshotPath,
                receiptSnapshot: fs.readFileSync(receiptSnapshotPath) });
        }
        const before = readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'REVIEW_RECORDED').length;
        const restart = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
            changedFiles, taskIntent: refined });
        assert.equal(restart.exitCode, 0, restart.outputLines.join('\n'));
        const artifact = JSON.parse(fs.readFileSync(path.join(reviewsRoot, `${taskId}-review-remediation-cycle.json`), 'utf8'));
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
        for (const { lane, contextPath, context, sha256, receiptSnapshotPath, receiptSnapshot } of passed) {
            assert.ok(artifact.authoritative_review_decision.preserved_review_types.includes(lane), JSON.stringify(artifact.authoritative_review_decision));
            const decision = artifact.authoritative_review_decision.lane_decisions.find((entry: { review_type: string }) => entry.review_type === lane);
            assert.ok(decision.reuse_eligible && !decision.invalidated, JSON.stringify(decision));
            assert.equal(artifact.review_reuse.launch_required_review_types.includes(lane), false, JSON.stringify(artifact.review_reuse));
            prepareScopedDiffFixture(repoRoot, preflightPath, lane);
            const kept = await runBuildReviewContextCommand({ repoRoot, reviewType: lane, depth: 3, preflightPath, outputPath: contextPath });
            assert.ok(kept.reusedReviewEvidence || kept.outputLines.includes('CurrentPassReviewEvidence: True'), kept.outputLines.join('\n'));
            assert.deepEqual(fs.readFileSync(receiptSnapshotPath), receiptSnapshot);
            const preserved = readPreservedReviewContextCopy({ repoRoot, taskId, reviewType: lane, contextPath }, sha256);
            assert.ok(preserved, `original ${lane} context must remain available`);
            assert.equal(JSON.parse(preserved.toString('utf8')).task_criteria.task_intent.text, original);
            assert.equal(context.task_criteria_binding.task_intent, original);
        }
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const update = [...events].reverse().find(event => event.event_type === 'REVIEW_CYCLE_RESTARTED')?.details as Record<string, unknown>;
        assert.deepEqual(update.task_intent_update, { task_id: taskId, previous_task_intent: original, task_intent: refined,
            previous_task_intent_sha256: taskIntentSha256(taskId, original), task_intent_sha256: taskIntentSha256(taskId, refined) });
        assert.equal(events.filter(event => event.event_type === 'REVIEW_RECORDED'
            && !(event.details as Record<string, unknown>)?.reused_existing_review).length, before, 'zero extra fresh reviews');
        prepareScopedDiffFixture(repoRoot, preflightPath, 'refactor');
        const nextContextPath = path.join(reviewsRoot, `${taskId}-refactor-review-context.json`);
        const next = await runBuildReviewContextCommand({ repoRoot, reviewType: 'refactor', depth: 3, preflightPath, outputPath: nextContextPath });
        assert.ok(fs.existsSync(nextContextPath), next.outputLines.join('\n'));
        const nextContext = JSON.parse(fs.readFileSync(nextContextPath, 'utf8'));
        assert.equal(nextContext.task_criteria.task_intent.text, refined);
        assert.equal(nextContext.task_criteria_binding.sha256, passed[0].context.task_criteria_binding.sha256);
        // The same empty-source-delta path must fail closed when durable requirements really change.
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'), `- ${taskId} operator decision (2026-11-13): Exports must additionally include archived consent history.\n`);
        const changedCriteria = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath,
            outputFiltersPath, changedFiles, taskIntent: refined });
        assert.equal(changedCriteria.exitCode, 0, changedCriteria.outputLines.join('\n'));
        const reset = JSON.parse(fs.readFileSync(path.join(reviewsRoot, `${taskId}-review-remediation-cycle.json`), 'utf8'));
        assert.ok(reset.authoritative_review_decision.lane_decisions.every((lane: { mode: string; invalidated: boolean; reuse_eligible: boolean }) =>
            lane.mode === 'FULL' && lane.invalidated && !lane.reuse_eligible), JSON.stringify(reset.authoritative_review_decision));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
