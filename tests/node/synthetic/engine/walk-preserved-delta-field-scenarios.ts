import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import type { WalkResult, WalkScenario } from './navigator-walk';
import { resolvePersistedRemediationReviewExecutionAuthority } from '../../../../src/gates/review-remediation/review-remediation-execution-authority';
import { assertReviewContextContractOrThrow } from '../../../../src/cli/commands/gate-review-handlers/context/review-context-runtime-validation';

export const PRESERVED_DELTA_FIELD_ID = 'field-onlinestore-passed-delta-after-test-repair';

/** Test only: every mutation is restored before the next native verification. Never edits the source checkout. */
export function inspectPreservedDeltaAuthority(root: string, result: WalkResult, expectedTestRepeats = 1): void {
    assert.equal(result.outcome, 'done');
    const firstTest = result.reviews.find(review => review.lane === 'test')!;
    assert.ok(firstTest && firstTest.step !== undefined);
    assert.deepEqual(result.reviews.filter(review => review.step! > firstTest.step!).map(review => review.lane), Array.from({ length: expectedTestRepeats }, () => 'test'),
        'A TEST-only repair must preserve all accepted upstream reviews, including DELTA');
    const reviewsRoot = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
    const preflightPath = path.join(reviewsRoot, 'T-WALK-preflight.json');
    const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath)).digest('hex');
    for (const lane of ['code', 'api']) {
        const contextPath = path.join(reviewsRoot, 'T-WALK-' + lane + '-review-context.json');
        const receiptPath = path.join(reviewsRoot, 'T-WALK-' + lane + '-receipt.json');
        const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(context.review_execution.mode, 'DELTA');
        assert.equal(receipt.reused_existing_review, true, 'Reuse must be recorded, not inferred from the launch count');
        assert.ok(receipt.reused_from_review_context_sha256);
        assert.ok(context.review_execution_preserved_by);
        const options = { reviewsRoot, taskId: 'T-WALK', reviewType: lane, preflightPath, preflightSha256,
            fullReviewScope: context.review_execution.full_review_scope, reviewExecution: context.review_execution,
            reviewContextPath: contextPath, receiptPath };
        // Match native next-step's observed-read lifetime; each outer call remains an independent fresh invocation.
        const resolve = () => withInvocationReadObservation(() => resolvePersistedRemediationReviewExecutionAuthority(options));
        const accepted = () => {
            const authority = resolve();
            assert.ok(authority?.preserved_current_scope, 'Preservation requires authenticated native history');
            assert.equal(authority.preserved_current_scope.current_preflight_sha256, preflightSha256);
        };
        accepted();
        const mutate = (file: string, change: (bytes: Buffer) => Buffer | string) => {
            assert.ok(path.resolve(file).startsWith(path.resolve(root) + path.sep));
            const before = fs.readFileSync(file);
            try {
                fs.writeFileSync(file, change(before));
                assert.equal(resolve(), null, 'Tampered evidence must refuse reuse');
            } finally { fs.writeFileSync(file, before); }
            accepted();
        };
        mutate(receiptPath, bytes => {
            const value = JSON.parse(bytes.toString()); value.review_artifact_sha256 = '9'.repeat(64); return JSON.stringify(value);
        });
        mutate(path.join(reviewsRoot, 'T-WALK-' + lane + '.md'), () => '## Verdict\nREVIEW FAILED\n');
        const validation = receipt.review_findings_validation;
        assert.ok(validation?.snapshot_path || validation?.artifact_path);
        mutate(validation.snapshot_path || validation.artifact_path, () => '{}\n');
        mutate(path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-WALK.jsonl'), bytes =>
            Buffer.concat([bytes, Buffer.from('{invalid\n')]));
        assert.equal(resolvePersistedRemediationReviewExecutionAuthority({ ...options, preflightSha256: '9'.repeat(64) }), null);
        assert.equal(resolvePersistedRemediationReviewExecutionAuthority({ ...options,
            reviewExecution: { ...context.review_execution, contract_sha256: '9'.repeat(64) } }), null);
        assert.throws(() => assertReviewContextContractOrThrow({ taskId: 'T-WALK', reviewType: lane,
            contextPath, preflightPath, preflightSha256, reviewContext: context, repoRoot: root }), /historical reuse evidence only/u,
        'A reuse-only historical context cannot authorize a fresh reviewer launch or result');
        const promoted = { ...context }; delete promoted.review_execution_preserved_by;
        assert.throws(() => assertReviewContextContractOrThrow({ taskId: 'T-WALK', reviewType: lane,
            contextPath, preflightPath, preflightSha256, reviewContext: promoted, repoRoot: root }), /preserv|preflight|historical|contract/iu,
        'Deleting the reuse-only marker must not promote historical execution into a fresh launch');
        for (const file of [receiptPath, path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-WALK.jsonl')]) {
            const before = fs.readFileSync(file);
            try {
                assert.throws(() => withInvocationReadObservation(() => {
                    accepted();
                    fs.writeFileSync(file, Buffer.concat([before, Buffer.from('{invalid\n')]));
                    // Internal snapshot reads may retain their first value. The invocation must refuse publication.
                    return resolvePersistedRemediationReviewExecutionAuthority(options);
                }), (error: unknown) => error instanceof Error && error.message.includes(file)
                    && /^(?:Invocation file observation changed: |Task timeline snapshot is unavailable: )/u.test(error.message),
                'A mutation after a valid cached read must invalidate the same invocation');
            } finally { fs.writeFileSync(file, before); }
            accepted();
        }
        accepted();
    }
}

export function preservedDeltaFieldScenario(): WalkScenario {
    return { id: PRESERVED_DELTA_FIELD_ID, windowsAclInput: 'inherited-trusted',
        edits: [{ path: 'src/app.ts', append: 'export const changed = true;\n' },
            { path: 'src/other.ts', append: 'export const other = true;\n' },
            { path: 'tests/app.test.ts', append: '// covered\n' }],
        requiredLanes: ['api'], failures: { api: 1, test: 1 },
        remediationSequence: [
            { reviewType: 'api', attempt: 1, edits: [{ path: 'src/app.ts', append: '// fixed\n' }] },
            { reviewType: 'test', attempt: 1, edits: [{ path: 'tests/app.test.ts', append: '// fixed\n' }] }
        ],
        expectedReviews: { code: 2, api: 2, test: 2 },
        expectedModes: ['code:FULL', 'api:FULL', 'code:DELTA', 'api:DELTA', 'test:FULL', 'test:DELTA'],
        counterState: 'native-api-selected-remediation',
        inspectResult: (root, result) => inspectPreservedDeltaAuthority(root, result) };
}
