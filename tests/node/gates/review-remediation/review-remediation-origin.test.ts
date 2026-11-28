import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { iterateRemediationOriginCandidates } from '../../../../src/gates/review-remediation/review-remediation-origin';

test('semantic origin lookup skips unusable data, authenticates candidates and stops before unused older receipts', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-origin-read-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reviews = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
    fs.mkdirSync(reviews, { recursive: true });
    const historyModule = require('../../../../src/gates/review-remediation/review-remediation-scope-review-types') as Record<string, (...args: unknown[]) => unknown>;
    const baselineModule = require('../../../../src/gates/review-remediation/review-remediation-baseline') as Record<string, (...args: unknown[]) => unknown>;
    const lanes = new Map(['code', 'security', 'test'].map((lane, index) => {
        const hash = String(index + 1).repeat(64);
        const file = path.join(reviews, `T-ORIGIN-${lane}-remediation-baseline-${hash}.json`);
        fs.writeFileSync(file, JSON.stringify({ usable: lane !== 'test' }));
        return [lane, { sequence: index + 1, reviewedTree: 'a'.repeat(64), details: {
            remediation_baseline_snapshot_path: file, remediation_baseline_snapshot_sha256: hash
        } }];
    }));
    let validTimeline = true, validBaseline = true;
    const validated: string[] = [], receipts: string[] = [];
    context.mock.method(historyModule, 'collectRemediationLaneHistory', () => ({
        integrity: { status: validTimeline ? 'PASS' : 'FAIL' }, lanes, timingEvents: [], trustedReceipts: new Set()
    }));
    context.mock.method(baselineModule, 'validateReviewRemediationBaselineArtifact', (options: { expectedReviewType: string }) => {
        validated.push(options.expectedReviewType);
        return { valid: validBaseline || options.expectedReviewType === 'code', artifact: { fix_now_items: [] } };
    });
    context.mock.method(historyModule, 'readAuthenticatedRemediationLaneReceipt', (options: { reviewType: string }) => {
        receipts.push(options.reviewType);
        return { authenticated: true, passed: true };
    });
    const options = { repoRoot: root, taskId: 'T-ORIGIN', requiredReviewTypes: ['code', 'security', 'test'],
        mayIncludeBaseline: (value: unknown) => typeof value === 'object' && value !== null && 'usable' in value && value.usable === true };
    const candidates = iterateRemediationOriginCandidates(options);
    assert.deepEqual(candidates.next().value, { reviewType: 'security', sequence: 2, failed: false });
    assert.deepEqual(validated, ['security']);
    assert.deepEqual(receipts, ['security']);
    candidates.return(undefined);

    validated.length = receipts.length = 0;
    validBaseline = false;
    assert.deepEqual([...iterateRemediationOriginCandidates(options)], [{ reviewType: 'code', sequence: 1, failed: false }]);
    assert.deepEqual(validated, ['security', 'code']);
    assert.deepEqual(receipts, ['code'], 'an applicable but invalid baseline cannot authorize a receipt');

    validTimeline = false;
    validated.length = receipts.length = 0;
    assert.deepEqual([...iterateRemediationOriginCandidates(options)], []);
    assert.deepEqual(validated, []);
    assert.deepEqual(receipts, []);
});
