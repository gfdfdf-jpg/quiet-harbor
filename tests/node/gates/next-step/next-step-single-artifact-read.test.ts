import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { buildRequiredReviewsCheckCommand } from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';
import { readNativeParentArtifactInput } from '../../../../src/gates/task-audit/task-audit-summary-lifecycle';
import { safeReadJson } from '../../../../src/gates/task-audit/task-audit-summary-review-common';
import { buildReviewIntegrityAttestation } from '../../../../src/gates/task-audit/task-audit-summary-review-integrity';

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-single-artifact-read-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reviewsRoot = path.join(root, 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, 'T-READ-preflight.json');
    const preflight = { task_id: 'T-READ', required_reviews: { code: true, test: true } };
    fs.writeFileSync(preflightPath, JSON.stringify(preflight));
    return { root, reviewsRoot, preflightPath, preflight };
}

test('preflight consumers share one payload and preserve the command and transaction bytes', t => {
    const { root, preflightPath, preflight } = fixture(t);
    const command = () => buildRequiredReviewsCheckCommand(root, 'garda', 'T-READ', preflightPath, null, { code: true });
    const expectedCommand = command();
    assert.match(expectedCommand, /review-authorship-attestation-json/u);
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        assert.deepEqual(safeReadJson(preflightPath), preflight);
        assert.equal(command(), expectedCommand);
        assert.equal(command(), expectedCommand);
        assert.equal(readNativeParentArtifactInput(root, preflightPath)?.toString('utf8'), JSON.stringify(preflight));
    }), measurement => {
        assert.equal(measurement.work['payload_read:' + preflightPath], 1);
        assert.equal(measurement.work['file_hash:' + preflightPath], 1);
    });
});

test('a preflight edited after the initial read is rejected at invocation exit', t => {
    const { root, preflightPath } = fixture(t);
    assert.throws(() => withInvocationReadObservation(() => {
        buildRequiredReviewsCheckCommand(root, 'garda', 'T-READ', preflightPath, null);
        fs.writeFileSync(preflightPath, '{"task_id":"T-READ","required_reviews":{}}');
    }), /Invocation file observation changed/u);
});

test('a receipt edited between invocations is rechecked by review integrity', t => {
    const { reviewsRoot } = fixture(t);
    const receiptPath = path.join(reviewsRoot, 'T-READ-code-receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify({ task_id: 'T-READ', review_type: 'code' }));
    const inspect = () => withInvocationReadObservation(() => buildReviewIntegrityAttestation({
        requiredReviews: { code: true }, reviewsRoot, taskId: 'T-READ', scopeCategory: null, reviewTrustSummary: null
    }));
    assert.ok(!inspect().observed_issues.includes('code: missing or invalid review receipt'));
    fs.writeFileSync(receiptPath, JSON.stringify({ task_id: 'T-OTHER', review_type: 'code' }));
    assert.ok(inspect().observed_issues.includes('code: missing or invalid review receipt'));
});

test('parent artifact admission keeps missing, non-file and size checks', t => {
    const { root, reviewsRoot } = fixture(t);
    const missing = path.join(reviewsRoot, 'missing.json');
    const oversized = path.join(reviewsRoot, 'oversized.json');
    const fd = fs.openSync(oversized, 'w');
    try { fs.ftruncateSync(fd, 16 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
    withInvocationReadObservation(() => {
        assert.equal(readNativeParentArtifactInput(root, missing), null);
        assert.throws(() => readNativeParentArtifactInput(root, reviewsRoot), /Unsafe transaction path/u);
        assert.throws(() => readNativeParentArtifactInput(root, oversized), /oversized/u);
    });
});

test('parent artifact admission rejects a hard-linked preflight', t => {
    const { root, reviewsRoot, preflightPath } = fixture(t);
    try { fs.linkSync(preflightPath, path.join(reviewsRoot, 'linked-preflight.json')); }
    catch (error: unknown) {
        if (['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) {
            t.skip('Hard links are unavailable on this filesystem');
            return;
        }
        throw error;
    }
    withInvocationReadObservation(() => {
        assert.throws(() => readNativeParentArtifactInput(root, preflightPath), /Unsafe transaction path|Invalid or oversized/u);
    });
});
