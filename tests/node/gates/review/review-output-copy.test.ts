import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasReviewerOutputCopy, preserveReviewerOutput, restoreReviewerOutput } from '../../../../src/gates/review/review-output-copy';

test('retained reviewer bytes are digest-bound and restored only to the task-owned path', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-output-copy-test-'));
    try {
        const directory = path.join(repoRoot, 'garda-agent-orchestrator/runtime/tmp/reviews/T-COPY/code');
        fs.mkdirSync(directory, { recursive: true });
        const outputPath = path.join(directory, 'review-output-aaaaaaaaaaaaaaaa.md');
        const original = Buffer.from('{"findings":{"high":[]}}\n');
        fs.writeFileSync(outputPath, original);
        const input = { repoRoot, taskId: 'T-COPY', reviewType: 'code', outputPath };
        const copy = preserveReviewerOutput(input);
        assert.ok(copy);
        assert.equal(copy.sha256, createHash('sha256').update(original).digest('hex'));
        assert.equal(copy.sourceMtimeUtc, fs.statSync(outputPath).mtime.toISOString());
        assert.equal(copy.sourceMtimeMs, fs.statSync(outputPath).mtimeMs);
        assert.equal(hasReviewerOutputCopy({ ...input, sha256: copy.sha256 }), true);
        fs.writeFileSync(outputPath, '{ corrupt');
        assert.equal(restoreReviewerOutput({ ...input, sha256: copy.sha256 }), 'restored');
        assert.deepEqual(fs.readFileSync(outputPath), original);
        assert.equal(restoreReviewerOutput({ ...input, outputPath: path.join(repoRoot, 'other.md'), sha256: copy.sha256 }), 'lost');
        const unboundOutput = path.join(directory, 'other.md');
        fs.writeFileSync(unboundOutput, original);
        assert.equal(preserveReviewerOutput({ ...input, outputPath: unboundOutput }), null);
        const cache = path.join(repoRoot, 'garda-agent-orchestrator/runtime/tmp/.reviewer-output-cache', input.taskId, copy.sha256);
        fs.writeFileSync(cache, 'tampered');
        fs.unlinkSync(outputPath);
        assert.equal(hasReviewerOutputCopy({ ...input, sha256: copy.sha256 }), false);
        assert.equal(restoreReviewerOutput({ ...input, sha256: copy.sha256 }), 'lost');
        assert.equal(fs.existsSync(outputPath), false);

        // Older open tasks may still need a verified copy written before task-scoped storage existed.
        const legacy = path.join(repoRoot, 'garda-agent-orchestrator/runtime/tmp/.reviewer-output-cache', copy.sha256);
        fs.writeFileSync(legacy, original);
        assert.equal(restoreReviewerOutput({ ...input, sha256: copy.sha256 }), 'restored');
        assert.deepEqual(fs.readFileSync(outputPath), original);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
