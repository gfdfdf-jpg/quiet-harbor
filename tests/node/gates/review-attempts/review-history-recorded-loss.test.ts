import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { captureLostReviewHistorySnapshots } from '../../../../src/gates/review-attempts/review-history-integrity';

test('a restart records every reference to the same lost snapshot but not unrelated older damage', t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-shared-history-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const taskId = 'T-LOSS', reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const reportSha = digest('shared report');
    const report = path.join(reviewsRoot, `${taskId}-code-artifact-${reportSha}.md`);
    fs.writeFileSync(report, 'shared report');
    const receipts = ['first', 'second'].map(text => {
        const sha = digest(text), file = path.join(reviewsRoot, `${taskId}-code-receipt-${sha}.json`);
        fs.writeFileSync(file, text);
        appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'review', {
            task_id: taskId, review_type: 'code', review_artifact_snapshot_path: report,
            review_artifact_snapshot_sha256: reportSha, review_artifact_sha256: reportSha,
            receipt_snapshot_path: file, receipt_snapshot_sha256: sha, receipt_sha256: sha
        }, { actor: 'gate' });
        return file;
    });
    fs.unlinkSync(report);
    fs.unlinkSync(receipts[0]);
    const recorded = captureLostReviewHistorySnapshots({ reviewsRoot, taskId, reviewType: 'code' });
    assert.equal(recorded.length, 2);
    for (const entry of recorded) assert.deepEqual(entry.missing_snapshots,
        [{ kind: 'report', sha256: reportSha, observed_sha256: null }]);
    fs.writeFileSync(report, 'changed report');
    const changed = captureLostReviewHistorySnapshots({ reviewsRoot, taskId, reviewType: 'code' });
    assert.equal(changed.length, 2);
    assert.equal(changed[0].missing_snapshots[0].observed_sha256, digest('changed report'));
});

test('findings-validation loss is recorded only for the event-bound canonical snapshot', t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-validation-history-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const taskId = 'T-LOSS', reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const reportSha = digest('report'), receiptSha = digest('receipt'), validationSha = digest('validation');
    const report = path.join(reviewsRoot, `${taskId}-code-artifact-${reportSha}.md`);
    const receipt = path.join(reviewsRoot, `${taskId}-code-receipt-${receiptSha}.json`);
    const validation = path.join(reviewsRoot, `${taskId}-code-findings-validation-${validationSha}.json`);
    const artifact = path.join(reviewsRoot, `${taskId}-code.md`).replace(/\\/gu, '/');
    fs.writeFileSync(report, 'report');
    fs.writeFileSync(receipt, 'receipt');
    fs.writeFileSync(validation, 'changed');
    const reference = { artifact_path: artifact.replace(/\.md$/u, '-findings-validation.json'),
        artifact_sha256: validationSha, snapshot_path: validation.replace(/\\/gu, '/'), snapshot_sha256: validationSha,
        status: 'accepted', accepted: true, validation_result_sha256: digest('result'), violation_count: 0 };
    const details = { task_id: taskId, review_type: 'code', review_artifact_path: artifact,
        review_artifact_snapshot_path: report, review_artifact_snapshot_sha256: reportSha, review_artifact_sha256: reportSha,
        receipt_snapshot_path: receipt, receipt_snapshot_sha256: receiptSha, receipt_sha256: receiptSha,
        review_findings_validation: reference };
    appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'review', details, { actor: 'gate' });
    const recorded = captureLostReviewHistorySnapshots({ reviewsRoot, taskId, reviewType: 'code' });
    assert.deepEqual(recorded[0].missing_snapshots,
        [{ kind: 'findings_validation', sha256: validationSha, observed_sha256: digest('changed') }]);
    reference.snapshot_path = path.join(reviewsRoot, 'wrong.json');
    appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'review', details, { actor: 'gate' });
    assert.deepEqual(captureLostReviewHistorySnapshots({ reviewsRoot, taskId, reviewType: 'code' }), []);
});
