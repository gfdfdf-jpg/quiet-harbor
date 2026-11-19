import '../../../../src/bin/garda/derivation-source-receipts';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { handleTaskAuditSummary } from '../../../../src/cli/commands/gate-task-handlers';
import { buildTaskAuditSummary, type TaskAuditSummaryResult } from '../../../../src/gates/task-audit/task-audit-summary';
import { getReviewHistoryIntegrityViolations } from '../../../../src/gates/review-attempts/review-history-integrity';
import { createAuthenticatedNextStepHistoryFixture, completeAuthenticatedHistoryFixture,
    type AuthenticatedHistoryFixture } from '../next-step/next-step-authenticated-history-fixture';
import { getReviewsRoot, readTaskTimelineEvents } from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';

test('full history inspection checks a superseded report while recovery can inspect the current lane', t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-audit-history-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const taskId = 'T-HISTORY', reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const event = (content: string) => {
        const sha = createHash('sha256').update(content).digest('hex');
        const file = path.join(reviewsRoot, `${taskId}-code-artifact-${sha}.md`);
        fs.writeFileSync(file, content);
        return { file, event: { event_type: 'REVIEW_RECORDED', details: { review_type: 'code',
            review_artifact_snapshot_path: file, review_artifact_snapshot_sha256: sha } } };
    };
    const earlier = event('earlier report'), current = event('current report');
    const options = { repoRoot, reviewsRoot, taskId, timelineEvents: [earlier.event, current.event] };
    for (const damage of ['tampered', 'missing'] as const) {
        if (damage === 'tampered') fs.writeFileSync(earlier.file, 'different bytes');
        else fs.unlinkSync(earlier.file);
        assert.deepEqual(getReviewHistoryIntegrityViolations(options), []);
        assert.equal(getReviewHistoryIntegrityViolations({ ...options, includeSuperseded: true }).length, 1);
    }
});

async function auditThroughHandler(fixture: AuthenticatedHistoryFixture): Promise<{
    exitCode: number; summary: TaskAuditSummaryResult;
}> {
    const outputPath = path.join(getReviewsRoot(fixture.repoRoot), 'closed-history-audit-output.json');
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await handleTaskAuditSummary(['--repo-root', fixture.repoRoot, '--task-id', fixture.taskId,
            '--as-json', '--output-path', outputPath]);
        return { exitCode: Number(process.exitCode),
            summary: JSON.parse(fs.readFileSync(outputPath, 'utf8')) as TaskAuditSummaryResult };
    } finally {
        process.exitCode = previousExitCode;
    }
}

test('A8 explicit audit blocks corrupted current and superseded receipts and restores PASS after repair', { timeout: 600_000 }, async () => {
    const fixture = await createAuthenticatedNextStepHistoryFixture(2, 1);
    await completeAuthenticatedHistoryFixture(fixture);
    const accepted = await auditThroughHandler(fixture);
    assert.equal(accepted.exitCode, 0);
    assert.equal(accepted.summary.status, 'PASS', JSON.stringify(accepted.summary.blockers));
    assert.equal(accepted.summary.final_closeout.status, 'READY');

    const receiptPath = fixture.historicalArtifacts[0];
    assert.equal(fixture.artifactCycles[path.resolve(receiptPath)], 0);
    const events = readTaskTimelineEvents(fixture.repoRoot, fixture.taskId);
    const recorded = events.findIndex(event => event.event_type === 'REVIEW_RECORDED'
        && path.resolve(String((event.details as Record<string, unknown>)?.receipt_snapshot_path || '')) === path.resolve(receiptPath));
    assert.ok(recorded >= 0, 'The corrupted receipt must be bound by the actual authenticated timeline.');
    assert.ok(events.slice(recorded + 1).some(event => event.event_type === 'REVIEW_CYCLE_RESTARTED'),
        'The receipt must belong to a cycle closed by a real restart.');
    // A completed task's full audit authenticates even the superseded immutable receipt.
    const superseded = fs.readFileSync(receiptPath);
    try {
        fs.appendFileSync(receiptPath, ' ');
        const supersededSummary = buildTaskAuditSummary(fixture);
        assert.equal(supersededSummary.status, 'BLOCKED', JSON.stringify(supersededSummary.blockers));
        assert.equal(supersededSummary.blockers.some(blocker => blocker.gate === 'review-history-integrity'), true);
    } finally {
        fs.writeFileSync(receiptPath, superseded);
    }

    const oldReport = fixture.historicalArtifacts.find(file => /-[a-f0-9]{64}\.md$/u.test(file));
    assert.ok(oldReport);
    const oldReportBytes = fs.readFileSync(oldReport);
    try {
        fs.unlinkSync(oldReport);
        const missingSummary = buildTaskAuditSummary(fixture);
        assert.equal(missingSummary.status, 'BLOCKED');
        assert.ok(missingSummary.blockers.some(blocker => blocker.gate === 'review-history-integrity'));
    } finally {
        fs.writeFileSync(oldReport, oldReportBytes);
    }

    // The latest result of the lane is what the task relies on: its corrupted snapshot still blocks the audit.
    const currentRecorded = [...events].reverse().find(event => event.event_type === 'REVIEW_RECORDED'
        && (event.details as Record<string, unknown>)?.review_type === 'code');
    const currentReceiptPath = path.resolve(fixture.repoRoot,
        String((currentRecorded?.details as Record<string, unknown>)?.receipt_snapshot_path || ''));
    assert.notEqual(currentReceiptPath, path.resolve(receiptPath));
    const original = fs.readFileSync(currentReceiptPath);
    try {
        fs.appendFileSync(currentReceiptPath, ' ');
        const blockedSummary = buildTaskAuditSummary(fixture);
        assert.equal(blockedSummary.status, 'BLOCKED');
        assert.equal(blockedSummary.final_closeout.status, 'NOT_READY');
        assert.equal(blockedSummary.final_closeout.artifact_state, 'NOT_READY');
        assert.ok(blockedSummary.blockers.some(blocker => blocker.gate === 'review-history-integrity'));
        const blocked = await auditThroughHandler(fixture);
        assert.notEqual(blocked.exitCode, 0, 'Reporting missing/invalid without a failing command is insufficient.');
        assert.equal(blocked.summary.status, 'BLOCKED');
        assert.equal(blocked.summary.final_closeout.status, 'NOT_READY');
        assert.ok(['REMOVED', 'NOT_READY'].includes(blocked.summary.final_closeout.artifact_state));
        assert.equal(fs.existsSync(accepted.summary.final_closeout.artifact_paths.json), false,
            'Explicit audit must not leave the previously materialized READY closeout behind.');
    } finally {
        fs.writeFileSync(currentReceiptPath, original);
    }
    const restored = await auditThroughHandler(fixture);
    assert.equal(restored.exitCode, 0);
    assert.equal(restored.summary.status, 'PASS', JSON.stringify(restored.summary.blockers));
    assert.equal(restored.summary.final_closeout.status, 'READY');
    assert.equal(restored.summary.final_closeout.artifact_state, 'MATERIALIZED');

    // Historical FAIL outcomes and old diagnostic-only attempts are not integrity failures.
    const historyViolations = getReviewHistoryIntegrityViolations({ ...fixture,
        reviewsRoot: getReviewsRoot(fixture.repoRoot),
        timelineEvents: [...events, { event_type: 'REVIEW_RECORDED', details: { review_type: 'code' } }] });
    assert.deepEqual(historyViolations, []);
});
