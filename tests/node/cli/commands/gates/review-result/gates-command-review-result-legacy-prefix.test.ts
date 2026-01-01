import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import { inspectTaskEventFile } from '../../../../../../src/gate-runtime/task-events-integrity';
import {
    createTempRepo, seedPromptBoundReviewFixture, prepareReviewerLaunchForTest,
    recordReviewerDelegationStartedForTest, launchArtifactInputArgsForTest, runCliWithCapturedOutput
} from '../review-launch/gates-command-review-launch-fixtures';
import { buildNoFindingsJsonReviewReport } from './gates-command-review-result-fixtures';

/** A task started before task-event integrity existed: its history keeps an unsigned prefix after the update. */
function timelinePath(repoRoot: string, taskId: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
}

function seedLegacyPrefix(repoRoot: string, taskId: string): void {
    fs.mkdirSync(path.dirname(timelinePath(repoRoot, taskId)), { recursive: true });
    fs.writeFileSync(timelinePath(repoRoot, taskId), `${JSON.stringify({ timestamp_utc: '2026-01-01T00:00:00.000Z',
        task_id: taskId, event_type: 'TASK_NOTE', outcome: 'INFO', actor: 'orchestrator', message: 'Written before integrity.',
        details: {} })}\n`, 'utf8');
}

function readTimelineLines(repoRoot: string, taskId: string): string[] {
    return fs.readFileSync(timelinePath(repoRoot, taskId), 'utf8').split('\n').filter(line => line.trim());
}

async function preparedLegacyPrefixFixture(repoRoot: string, taskId: string) {
    seedLegacyPrefix(repoRoot, taskId);
    const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId, provider: 'Claude' });
    await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity: fixture.reviewerIdentity,
        launchArtifactPath: fixture.launchArtifactPath });
    assert.equal(inspectTaskEventFile(timelinePath(repoRoot, taskId), taskId).status, 'PASS_WITH_LEGACY_PREFIX');
    const launch = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
    const outputPath = String(launch.review_output_path);
    fs.writeFileSync(outputPath, JSON.stringify(buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId)));
    const checkArgs = ['gate', 'record-review-result', '--check-only', '--task-id', taskId, '--review-type', 'code',
        '--review-output-path', outputPath, '--repo-root', repoRoot];
    return { fixture, outputPath, checkArgs };
}

it('self-checks a reviewer draft on an authenticated history with a legacy prefix and signed current launch evidence', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-LEGACY-PREFIX-CHECK';
    try {
        const { fixture, outputPath, checkArgs } = await preparedLegacyPrefixFixture(repoRoot, taskId);
        const prepared = await runCliWithCapturedOutput(checkArgs, { cwd: repoRoot });
        assert.equal(prepared.exitCode, 0, prepared.errors.join('\n'));
        assert.match(prepared.logs.join('\n'), /REVIEW_OUTPUT_SELF_CHECK_PASSED: code/u);

        await recordReviewerDelegationStartedForTest({ repoRoot, taskId, reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath, providerInvocationId: 'provider-legacy-prefix',
            attestationSource: 'provider.spawn_agent' });
        // The delegated reviewer writes its report after delegation starts.
        fs.writeFileSync(outputPath, fs.readFileSync(outputPath));
        const started = await runCliWithCapturedOutput(checkArgs, { cwd: repoRoot });
        assert.equal(started.exitCode, 0, started.errors.join('\n'));

        const complete = await runCliWithCapturedOutput([
            'gate', 'complete-reviewer-launch', '--task-id', taskId, '--review-type', 'code',
            '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity, '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
            '--provider-invocation-id', 'provider-legacy-prefix', '--attestation-source', 'provider.spawn_agent',
            ...launchArtifactInputArgsForTest(fixture.launchArtifactPath), '--fork-context', 'false', '--record-invocation'
        ], { cwd: repoRoot });
        assert.equal(complete.exitCode, 0, complete.errors.join('\n'));
        const completed = await runCliWithCapturedOutput(checkArgs, { cwd: repoRoot });
        assert.equal(completed.exitCode, 0, completed.errors.join('\n'));

        const recorded = await runCliWithCapturedOutput([
            'gate', 'record-review-result', '--task-id', taskId, '--review-type', 'code',
            '--preflight-path', fixture.preflightPath, '--review-output-path', outputPath,
            '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(recorded.exitCode, 0, [...recorded.errors, ...recorded.logs].join('\n'));
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), true);
        assert.equal(inspectTaskEventFile(timelinePath(repoRoot, taskId), taskId).status, 'PASS_WITH_LEGACY_PREFIX');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('refuses a self-check whose only prepared launch is an unsigned legacy-prefix event', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-LEGACY-PREFIX-FORGED';
    try {
        const { checkArgs } = await preparedLegacyPrefixFixture(repoRoot, taskId);
        // Legacy-prefix content is not chained: rewrite it as the signed launch event, then cut the chain before that event.
        const lines = readTimelineLines(repoRoot, taskId);
        const preparedIndex = lines.findIndex(line => (JSON.parse(line) as Record<string, unknown>).event_type === 'REVIEWER_LAUNCH_PREPARED');
        assert.ok(preparedIndex > 0);
        const forged = JSON.parse(lines[preparedIndex]) as Record<string, unknown>;
        delete forged.integrity;
        fs.writeFileSync(timelinePath(repoRoot, taskId), [JSON.stringify(forged), ...lines.slice(1, preparedIndex), ''].join('\n'), 'utf8');
        assert.equal(inspectTaskEventFile(timelinePath(repoRoot, taskId), taskId).status, 'PASS_WITH_LEGACY_PREFIX');

        const check = await runCliWithCapturedOutput(checkArgs, { cwd: repoRoot });
        assert.notEqual(check.exitCode, 0);
        assert.match(check.errors.join('\n'), /requires a prepared launch bound to this review context/u);
        assert.doesNotMatch(check.logs.join('\n'), /REVIEW_OUTPUT_SELF_CHECK_PASSED/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('refuses a self-check when an unsigned event follows the start of the integrity chain', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-LEGACY-PREFIX-UNSIGNED-SUFFIX';
    try {
        const { checkArgs } = await preparedLegacyPrefixFixture(repoRoot, taskId);
        const lines = readTimelineLines(repoRoot, taskId);
        fs.writeFileSync(timelinePath(repoRoot, taskId), [...lines, lines[0], ''].join('\n'), 'utf8');
        assert.equal(inspectTaskEventFile(timelinePath(repoRoot, taskId), taskId).status, 'FAILED');

        const check = await runCliWithCapturedOutput(checkArgs, { cwd: repoRoot });
        assert.notEqual(check.exitCode, 0);
        assert.match(check.errors.join('\n'), /requires an intact task event history/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
