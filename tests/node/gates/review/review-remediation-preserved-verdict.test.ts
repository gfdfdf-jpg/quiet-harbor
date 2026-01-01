import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { getPreservedReviewPassViolation } from '../../../../src/gates/review-remediation/review-remediation-preserved-verdict';
import { assertReviewContextContractOrThrow } from '../../../../src/cli/commands/gate-review-handlers/context/review-context-runtime-validation';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import { buildReviewFindingsValidationArtifact, getReviewFindingsValidationArtifactPath } from '../../../../src/gates/review/review-findings-validation-artifact';
import { resolveReviewContextExecutionEvidenceBindings } from '../../../../src/gates/review/review-evidence-contract';

function fixture(t: TestContext, blocked = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-preserved-verdict-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('garda-preserved-verdict-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    const write = (file: string, value: unknown) => {
        const content = JSON.stringify(value, null, 2) + '\n';
        fs.writeFileSync(file, content); return hash(content);
    };
    const taskId = 'T-REUSE', reviewType = 'code', preflight = 'a'.repeat(64), tree = 'e'.repeat(64);
    const execution = buildReviewRemediationReviewContract({ taskId, reviewType, preflightSha256: preflight, fullReviewScope: ['src/app.ts'] });
    const coverage = buildReviewCoverageContract({ reviewType, changedFiles: ['src/app.ts'] });
    const reviewContext = { schema_version: 4, task_id: taskId, review_type: reviewType,
        preflight_sha256: preflight, coverage_contract: coverage, review_execution: execution };
    const contextPath = path.join(root, 'T-REUSE-code-review-context.json');
    const contextHash = write(contextPath, reviewContext);
    const evidence = [{ location: 'src/app.ts:1', observation: 'The changed behavior was checked against the task contract.' }];
    const report = { schema_version: 2, task_id: taskId, review_type: reviewType,
        review_context_sha256: contextHash, tree_state_sha256: tree,
        review_execution: { mode: 'FULL', contract_sha256: execution.contract_sha256, covered_delta_targets: [], inspected_prior_finding_ids: [] },
        validation_notes: [{ id: 'N-001', topic: 'scope', note: 'Checked every assigned file and coverage obligation.', evidence }],
        coverage_ledger: { coverage_contract_sha256: coverage.contract_sha256,
            entries: coverage.obligations.map((obligation, index) => ({ obligation_id: obligation.id, evidence,
                finding_ids: blocked && index === 0 ? ['F-001'] : [] })) },
        findings: { critical: [], high: blocked ? [{ id: 'F-001', title: 'An unresolved isolation defect',
            description: 'The implementation still permits a cross-organization access and must be repaired.', evidence,
            coverage_obligation_ids: [coverage.obligations[0].id] }] : [], medium: [], low: [] },
        residual_risks: [], reviewer_notes: [] };
    const reviewArtifactPath = path.join(root, 'T-REUSE-code.md');
    const artifactHash = write(reviewArtifactPath, report);
    const validation = validateReviewFindingsContract({ content: fs.readFileSync(reviewArtifactPath, 'utf8'),
        expectedTaskId: taskId, expectedReviewType: reviewType, expectedReviewContextSha256: contextHash,
        expectedTreeStateSha256: tree, coverageContract: coverage, expectedReviewExecutionContract: execution });
    assert.equal(validation.valid, true, validation.violations.join(' '));
    const scope = 'b'.repeat(64), reviewScope = 'c'.repeat(64), codeScope = 'd'.repeat(64);
    const validationPath = getReviewFindingsValidationArtifactPath(reviewArtifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({ taskId, reviewType, validation,
        reviewOutputSha256: artifactHash, reviewArtifactPath, reviewArtifactSha256: artifactHash,
        reviewContextPath: contextPath, reviewContextSha256: contextHash,
        preflightPath: path.join(root, 'preflight.json'), preflightSha256: preflight,
        scopeSha256: scope, reviewScopeSha256: reviewScope, codeScopeSha256: codeScope,
        reviewTreeStateSha256: tree, coverageContract: coverage });
    const validationHash = write(validationPath, validationArtifact);
    const bindings = resolveReviewContextExecutionEvidenceBindings(reviewContext).bindings!;
    const receipt: Record<string, unknown> = { task_id: taskId, review_type: reviewType,
        preflight_sha256: preflight, scope_sha256: scope, review_scope_sha256: reviewScope,
        code_scope_sha256: codeScope, review_context_sha256: contextHash, review_tree_state_sha256: tree,
        review_output_format: 'findings_json', review_output_sha256: artifactHash, review_artifact_sha256: artifactHash,
        ...bindings,
        review_output_contract: { coverage_contract_sha256: coverage.contract_sha256, ...bindings },
        review_findings_validation: { artifact_path: validationPath.replace(/\\/gu, '/'),
            artifact_sha256: validationHash, snapshot_path: null, snapshot_sha256: null,
            status: 'accepted', accepted: true, validation_result_sha256: validationArtifact.validation_result_sha256, violation_count: 0 } };
    return { taskId, reviewType, receipt, reviewContext, reviewArtifactPath, validationPath };
}

test('preserved JSON review uses accepted findings evidence without a Markdown verdict', t => {
    const data = fixture(t);
    assert.ok(!fs.readFileSync(data.reviewArtifactPath, 'utf8').includes('REVIEW PASSED'));
    assert.equal(getPreservedReviewPassViolation(data), null);
});

test('accepted report with a blocking finding cannot preserve a PASS', t => {
    assert.match(getPreservedReviewPassViolation(fixture(t, true)) || '', /blocking/u);
});

function carried(data: ReturnType<typeof fixture>) {
    data.receipt.reused_existing_review = true;
    for (const name of ['review_context_sha256', 'review_tree_state_sha256', 'review_scope_sha256', 'code_scope_sha256',
        'review_execution_mode', 'review_execution_contract_sha256', 'review_execution_full_scope_sha256',
        'review_execution_complete_scope_lineage_sha256', 'review_execution_finding_reconciliation_sha256']) {
        data.receipt['reused_from_' + name] = data.receipt[name];
        if (!name.startsWith('review_execution_')) data.receipt[name] = '7'.repeat(64);
    }
    data.receipt.preflight_sha256 = '8'.repeat(64);
    data.receipt.scope_sha256 = '8'.repeat(64);
    return data;
}

test('carried JSON keeps the original validation bindings when the current context changes', t => {
    assert.equal(getPreservedReviewPassViolation(carried(fixture(t))), null);
});

for (const field of ['reused_from_review_context_sha256', 'reused_from_review_tree_state_sha256',
    'reused_from_review_scope_sha256', 'reused_from_code_scope_sha256', 'reused_from_review_execution_contract_sha256']) {
    test('carried JSON rejects a forged historical binding ' + field, t => {
        const data = carried(fixture(t)); data.receipt[field] = '9'.repeat(64);
        assert.ok(getPreservedReviewPassViolation(data));
    });
}

for (const field of ['review_context_sha256', 'preflight_sha256', 'scope_sha256', 'review_scope_sha256',
    'code_scope_sha256', 'review_tree_state_sha256', 'review_execution_contract_sha256', 'review_artifact_sha256']) {
    test('preserved JSON rejects mismatched ' + field, t => {
        const data = fixture(t); data.receipt[field] = '9'.repeat(64);
        assert.ok(getPreservedReviewPassViolation(data));
    });
}

test('JSON cannot fall back to a PASS string when findings validation is missing', t => {
    const data = fixture(t); delete data.receipt.review_findings_validation;
    fs.writeFileSync(data.reviewArtifactPath, '## Verdict\nREVIEW PASSED\n');
    assert.ok(getPreservedReviewPassViolation(data));
});

test('preserved JSON rejects a deleted or changed findings validation artifact', t => {
    const data = fixture(t); fs.writeFileSync(data.validationPath, '{}\n');
    assert.ok(getPreservedReviewPassViolation(data));
    fs.unlinkSync(data.validationPath);
    assert.ok(getPreservedReviewPassViolation(data));
});

for (const content of ['## Verdict\nREVIEW FAILED', '## Verdict\nREVIEW PASSED\nREVIEW FAILED', 'Examples:\nREVIEW PASSED']) {
    test('legacy preserved review rejects non-authoritative verdict ' + JSON.stringify(content), t => {
        const data = fixture(t); fs.writeFileSync(data.reviewArtifactPath, content);
        assert.ok(getPreservedReviewPassViolation({ ...data, receipt: {}, reviewContext: { schema_version: 1 } }));
    });
}

test('legacy preserved review still accepts an explicit unambiguous PASS', t => {
    const data = fixture(t); fs.writeFileSync(data.reviewArtifactPath, '## Verdict\nREVIEW PASSED');
    assert.equal(getPreservedReviewPassViolation({ ...data, receipt: {}, reviewContext: { schema_version: 1 } }), null);
});

for (const marker of [null, {}, { current_preflight_sha256: 'a'.repeat(64) }]) {
    test('launch/result boundary rejects reuse-only preservation marker ' + JSON.stringify(marker), () => {
        assert.throws(() => assertReviewContextContractOrThrow({ taskId: 'T-REUSE', reviewType: 'code',
            contextPath: 'unused-context', preflightPath: 'unused-preflight', preflightSha256: 'a'.repeat(64),
            reviewContext: { schema_version: 4, review_execution_preserved_by: marker } }), /historical reuse evidence only/u);
    });
}
