import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTempRepo, fs, launchArtifactInputArgsForTest, prepareReviewerLaunchForTest, readTaskTimelineEvents,
    recordReviewerDelegationStartedForTest, runCliWithCapturedOutput, seedPromptBoundReviewFixture, seedRoutedReviewerLaunchFixture
} from './gates-command-review-launch-fixtures';

test('a refused prepare cannot restore a damaged prompt after delegation started', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-active-prepare-input';
    try {
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath });
        await recordReviewerDelegationStartedForTest({ repoRoot, taskId, reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath });
        const started = fs.readFileSync(fixture.launchArtifactPath, 'utf8');
        const launch = JSON.parse(started) as Record<string, unknown>;
        fs.writeFileSync(fixture.reviewerPromptPath, 'Changed input the reviewer may have read.\n');
        fs.writeFileSync(fixture.launchArtifactPath, JSON.stringify({ ...launch, attestation_state: 'prepared' }));
        const refused = await runCliWithCapturedOutput(['gate', 'prepare-reviewer-launch', '--task-id', taskId,
            '--review-type', 'code', '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity, '--reviewer-launch-artifact-path', fixture.launchArtifactPath],
        { cwd: repoRoot });
        assert.notEqual(refused.exitCode, 0);
        assert.equal(fs.readFileSync(fixture.reviewerPromptPath, 'utf8'), 'Changed input the reviewer may have read.\n');
        fs.writeFileSync(fixture.launchArtifactPath, started);
        const retry = await runCliWithCapturedOutput(['gate', 'prepare-reviewer-launch', '--task-id', taskId,
            '--review-type', 'code', '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity, '--reviewer-launch-artifact-path', fixture.launchArtifactPath],
        { cwd: repoRoot });
        assert.notEqual(retry.exitCode, 0);
        assert.equal(fs.readFileSync(fixture.reviewerPromptPath, 'utf8'), 'Changed input the reviewer may have read.\n');
        const completed = await runCliWithCapturedOutput(['gate', 'complete-reviewer-launch', '--task-id', taskId,
            '--review-type', 'code', '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity, '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-305', '--attestation-source', 'test_provider_controller',
            ...launchArtifactInputArgsForTest(fixture.launchArtifactPath), '--fork-context', 'false'], { cwd: repoRoot });
        assert.notEqual(completed.exitCode, 0);
        assert.match(completed.errors.join('\n'), /prompt.*stale/iu);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('routing signs the criteria fingerprint together with the reviewer context', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-routed-criteria-binding';
    try {
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const context = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
            task_criteria_binding: { sha256: string; schema: string };
        };
        const route = readTaskTimelineEvents(repoRoot, taskId).find(event => event.event_type === 'REVIEWER_DELEGATION_ROUTED');
        assert.ok(route);
        const details = route.details as Record<string, unknown>;
        assert.equal(details.task_criteria_binding_sha256, context.task_criteria_binding.sha256);
        assert.equal(details.task_criteria_binding_schema, context.task_criteria_binding.schema);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('a prepare retry restores its exact prompt copy before any reviewer starts', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-prepared-prompt-recovery';
    try {
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath });
        const original = fs.readFileSync(fixture.reviewerPromptPath, 'utf8');
        fs.writeFileSync(fixture.reviewerPromptPath, 'damage\n');
        await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath });
        assert.equal(fs.readFileSync(fixture.reviewerPromptPath, 'utf8'), original);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
