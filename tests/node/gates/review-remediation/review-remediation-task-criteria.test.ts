import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { computeTaskCriteriaBinding } from '../../../../src/gates/review-context/review-context-task-criteria-binding';
import { preserveReviewContextCopy } from '../../../../src/gates/review/review-artifact-recovery';
import { resolveFailedReviewTaskCriteriaChange } from '../../../../src/gates/review-remediation/review-remediation-task-criteria';
import type { ReviewRemediationBaselineArtifact } from '../../../../src/gates/review-remediation/review-remediation-baseline';

test('lost context criteria require the signed baseline and exact cached context bytes', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-lost-criteria-'));
    const taskId = 'T-1';
    try {
        const task = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(task, '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |\n'
            + '|---|---|---|---|---|---|---|---|---|\n| T-1 | TODO | P1 | app | Test | me | now | balanced | Exact result |\n');
        const reviews = path.join(repoRoot, 'runtime', 'reviews');
        fs.mkdirSync(reviews, { recursive: true });
        const contextPath = path.join(reviews, `${taskId}-code-review-context.json`);
        const binding = computeTaskCriteriaBinding({ repoRoot, taskId, preflight: { task_intent: 'Test' } });
        const text = JSON.stringify({ task_criteria_binding: binding });
        const sha = crypto.createHash('sha256').update(text).digest('hex');
        const baselineSha256 = 'b'.repeat(64);
        const baseline = { review_type: 'code', bindings: { context: { review_context_path: contextPath,
            review_context_sha256: sha } } } as unknown as ReviewRemediationBaselineArtifact;
        const options = { repoRoot, taskId, baseline, baselineSha256, currentTaskIntent: 'Test' };
        fs.writeFileSync(contextPath, text);
        preserveReviewContextCopy({ repoRoot, taskId, reviewType: 'code', contextPath }, text);
        fs.unlinkSync(contextPath);
        assert.equal(resolveFailedReviewTaskCriteriaChange(options), true, 'a copy cannot authenticate itself');
        appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'review', {
            task_id: taskId, review_type: 'code', review_context_path: contextPath, review_context_sha256: sha,
            remediation_baseline_snapshot_sha256: baselineSha256
        });
        assert.equal(resolveFailedReviewTaskCriteriaChange(options), false);
        assert.equal(resolveFailedReviewTaskCriteriaChange({ ...options, baselineSha256: 'c'.repeat(64) }), true);
        const cache = path.join(repoRoot, 'runtime', 'tmp', '.review-context-cache', taskId, sha);
        fs.writeFileSync(cache, '{"forged":true}');
        assert.equal(resolveFailedReviewTaskCriteriaChange(options), true, 'an older event cannot authenticate a changed copy');
        appendTaskEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'route', {
            review_type: 'code', review_context_sha256: sha, task_criteria_binding_schema: binding.schema,
            task_criteria_binding_sha256: binding.sha256
        }, { actor: 'orchestrator' });
        assert.equal(resolveFailedReviewTaskCriteriaChange(options), true, 'a later route cannot prove an earlier review');
        appendTaskEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'review bound to the route', {
            task_id: taskId, review_type: 'code', review_context_path: contextPath, review_context_sha256: sha,
            remediation_baseline_snapshot_sha256: baselineSha256
        });
        fs.unlinkSync(cache);
        assert.equal(resolveFailedReviewTaskCriteriaChange(options), false, 'signed criteria survive loss of both context and copy');
        fs.writeFileSync(task, fs.readFileSync(task, 'utf8').replace('Exact result', 'Exact  result'));
        assert.equal(resolveFailedReviewTaskCriteriaChange(options), true);
        fs.writeFileSync(task, fs.readFileSync(task, 'utf8').replace('Exact  result', 'Exact result'));
        fs.appendFileSync(path.join(repoRoot, 'runtime', 'task-events', `${taskId}.jsonl`), '{broken\n');
        assert.equal(resolveFailedReviewTaskCriteriaChange(options), true, 'a broken timeline proves nothing');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
