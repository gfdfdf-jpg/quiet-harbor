import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import { readReviewOutputCorrectionArtifact } from '../../../../../../src/gates/review/review-output-correction';
import {
    createTempRepo, seedPromptBoundReviewFixture, prepareReviewerLaunchForTest,
    recordReviewerDelegationStartedForTest, launchArtifactInputArgsForTest,
    runCliWithCapturedOutput, readTaskTimelineEvents
} from '../review-launch/gates-command-review-launch-fixtures';
import { buildNoFindingsJsonReviewReport } from './gates-command-review-result-fixtures';

it('preserves the attested controller invocation when a Codex report requires correction', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-CONTROLLER-CORRECTION';
    // These launches are isolated CLI fixtures, never production review evidence.
    const controllerId = '/root/unit-controller-correction';
    try {
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId, provider: 'Codex' });
        const { launchArtifactPath, reviewerIdentity } = fixture;
        await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity, launchArtifactPath });
        await recordReviewerDelegationStartedForTest({
            repoRoot, taskId, reviewerIdentity, launchArtifactPath,
            controllerInvocationId: controllerId, attestationSource: 'collaboration.spawn_agent'
        });
        const prepared = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const outputPath = String(prepared.review_output_path);
        assert.ok(path.isAbsolute(outputPath));
        const report = buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId);
        report.unexpected = true;
        const rejectedBytes = `${JSON.stringify(report, null, 2)}\n`;
        fs.writeFileSync(outputPath, rejectedBytes, 'utf8');
        const complete = await runCliWithCapturedOutput([
            'gate', 'complete-reviewer-launch', '--task-id', taskId, '--review-type', 'code',
            '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity, '--reviewer-launch-artifact-path', launchArtifactPath,
            '--controller-invocation-id', controllerId, '--attestation-source', 'collaboration.spawn_agent',
            ...launchArtifactInputArgsForTest(launchArtifactPath), '--fork-context', 'false', '--record-invocation'
        ], { cwd: repoRoot });
        assert.equal(complete.exitCode, 0, complete.errors.join('\n'));
        const launch = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(launch.controller_invocation_id, controllerId);
        assert.equal(launch.provider_invocation_id, undefined);
        const invocation = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse().find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        assert.equal((invocation?.details as Record<string, unknown>).provider_invocation_id, controllerId);
        const rejected = await runCliWithCapturedOutput([
            'gate', 'record-review-result', '--task-id', taskId, '--review-type', 'code',
            '--preflight-path', fixture.preflightPath, '--review-output-path', outputPath,
            '--repo-root', repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.notEqual(rejected.exitCode, 0);
        const correction = readReviewOutputCorrectionArtifact(
            path.join(fixture.reviewsRoot, `${taskId}-code-output-correction.json`)
        );
        assert.ok(correction.artifact, [...rejected.errors, ...rejected.logs].join('\n'));
        assert.deepEqual(correction.violations, []);
        assert.equal(correction.artifact?.transport_binding?.provider_invocation_id, controllerId);
        assert.equal(correction.artifact?.transport_binding?.session_availability, 'pending');
        assert.equal(correction.artifact?.recovery.selected_transport, 'live_reviewer_continuation');
        assert.equal(correction.artifact?.recovery.available_transports.includes('live_reviewer_continuation'), true);
        assert.equal(fs.readFileSync(outputPath, 'utf8'), rejectedBytes);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.writeFileSync(outputPath, JSON.stringify(buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId)));
        const check = await runCliWithCapturedOutput(['gate', 'record-review-result', '--check-only', '--task-id', taskId,
            '--review-type', 'code', '--review-output-path', outputPath, '--repo-root', repoRoot], { cwd: repoRoot });
        assert.equal(check.exitCode, 0, check.errors.join('\n'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('checks a reviewer draft without writing evidence or changing any task files', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-SELF-CHECK';
    try {
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId, provider: 'Claude' });
        const { launchArtifactPath, reviewerIdentity } = fixture;
        await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity, launchArtifactPath });
        await recordReviewerDelegationStartedForTest({ repoRoot, taskId, reviewerIdentity, launchArtifactPath,
            providerInvocationId: 'provider-self-check', attestationSource: 'provider.spawn_agent' });
        const launch = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const outputPath = String(launch.review_output_path);
        const report = buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId);
        const args = ['gate', 'record-review-result', '--check-only', '--task-id', taskId, '--review-type', 'code',
            '--review-output-path', outputPath, '--repo-root', repoRoot];
        const snapshot = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true })
            .flatMap(entry => entry.isDirectory() ? snapshot(path.join(directory, entry.name))
                : [path.relative(repoRoot, path.join(directory, entry.name)) + ':' +
                    fs.readFileSync(path.join(directory, entry.name)).toString('base64')]).sort();
        fs.writeFileSync(outputPath, '{ malformed json');
        const beforeMalformed = snapshot(repoRoot);
        const malformed = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.notEqual(malformed.exitCode, 0);
        assert.match(malformed.errors.join('\n'), /Invalid JSON:/u);
        assert.deepEqual(snapshot(repoRoot), beforeMalformed);
        report.unexpected = true;
        fs.writeFileSync(outputPath, JSON.stringify(report));
        const beforeInvalid = snapshot(repoRoot);
        const invalid = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.notEqual(invalid.exitCode, 0);
        assert.match(invalid.errors.join('\n'), /unknown field 'unexpected'/u);
        assert.deepEqual(snapshot(repoRoot), beforeInvalid);
        delete report.unexpected;
        report.tree_state_sha256 = 'a'.repeat(64);
        fs.writeFileSync(outputPath, JSON.stringify(report));
        const beforeWrongBinding = snapshot(repoRoot);
        const wrongBinding = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.notEqual(wrongBinding.exitCode, 0);
        assert.match(wrongBinding.errors.join('\n'), /tree_state_sha256/iu);
        assert.deepEqual(snapshot(repoRoot), beforeWrongBinding);
        report.tree_state_sha256 = buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId).tree_state_sha256;
        fs.writeFileSync(outputPath, JSON.stringify(report));
        const beforeValid = snapshot(repoRoot);
        const valid = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.equal(valid.exitCode, 0, valid.errors.join('\n'));
        assert.match(valid.logs.join('\n'), /REVIEW_OUTPUT_SELF_CHECK_PASSED/u);
        assert.deepEqual(snapshot(repoRoot), beforeValid);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

it('self-checks a custom launch path before and after resolving its planned reviewer identity', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-SELF-CHECK-CUSTOM';
    const plannedIdentity = `agent:pending:${taskId}-code`;
    try {
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId, provider: 'Claude', reviewerIdentity: plannedIdentity });
        const launchArtifactPath = path.join(path.dirname(fixture.launchArtifactPath), 'custom-reviewer-launch.json');
        await prepareReviewerLaunchForTest({ repoRoot, taskId, reviewerIdentity: plannedIdentity, launchArtifactPath });
        const launch = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const outputPath = String(launch.review_output_path);
        fs.writeFileSync(outputPath, JSON.stringify(buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId)));
        const args = ['gate', 'record-review-result', '--check-only', '--task-id', taskId, '--review-type', 'code',
            '--review-output-path', outputPath, '--repo-root', repoRoot];
        const prepared = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.equal(prepared.exitCode, 0, prepared.errors.join('\n'));
        await recordReviewerDelegationStartedForTest({ repoRoot, taskId, reviewerIdentity: 'agent:resolved-reviewer',
            launchArtifactPath, providerInvocationId: 'custom-provider-invocation', attestationSource: 'provider.spawn_agent' });
        const started = await runCliWithCapturedOutput(args, { cwd: repoRoot });
        assert.equal(started.exitCode, 0, started.errors.join('\n'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
