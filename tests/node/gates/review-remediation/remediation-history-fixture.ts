import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildReviewReceiptReviewerInvocationProvenance } from '../../../../src/gate-runtime/review-context';
import { fileSha256 } from '../../../../src/core/file-hashing';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { seedAuthenticatedReviewerLaunchFixture } from '../next-step/next-step-reviewer-launch-fixtures';

export function authenticateRemediationReceiptFixture(options: {
    repoRoot: string; taskId: string; reviewType: string; receipt: Record<string, unknown>; receiptPath: string;
    contextPath: string; artifactPath: string; validationPath: string; dispositionPath: string; fullReviewScope: string[];
    validationArtifact?: object; dispositionArtifact?: object;
}): (baselinePath: string) => string {
    const root = path.join(options.repoRoot, 'garda-agent-orchestrator');
    const receipt = options.receipt;
    const validation = JSON.parse(fs.readFileSync(options.validationPath, 'utf8'));
    if (!validation.validation_result.bindings.execution) {
        const contract = buildReviewRemediationReviewContract({ taskId: options.taskId, reviewType: options.reviewType,
            preflightSha256: validation.validation_result.bindings.scope.preflight_sha256, fullReviewScope: options.fullReviewScope });
        validation.validation_result.bindings.execution = { review_execution_mode: contract.mode,
            review_execution_contract_sha256: contract.contract_sha256, review_execution_full_scope_sha256: contract.full_review_scope_sha256,
            review_execution_complete_scope_lineage_sha256: contract.complete_scope_lineage_sha256,
            review_execution_finding_reconciliation_sha256: sha256RedactedJsonPayload(contract.finding_reconciliation) };
        validation.validation_result_sha256 = sha256RedactedJsonPayload(validation.validation_result);
        fs.writeFileSync(options.validationPath, JSON.stringify(validation, null, 2) + '\n');
        if (options.validationArtifact) Object.assign(options.validationArtifact, validation);
        const disposition = JSON.parse(fs.readFileSync(options.dispositionPath, 'utf8'));
        disposition.source_validation.artifact_sha256 = fileSha256(options.validationPath);
        disposition.source_validation.validation_result_sha256 = validation.validation_result_sha256;
        fs.writeFileSync(options.dispositionPath, JSON.stringify(disposition, null, 2) + '\n');
        if (options.dispositionArtifact) Object.assign(options.dispositionArtifact, disposition);
    }
    const validationHash = fileSha256(options.validationPath)!;
    const validationSnapshot = options.validationPath.replace(/\.json$/u, '-' + validationHash + '.json');
    fs.copyFileSync(options.validationPath, validationSnapshot);
    const identity = String(receipt.reviewer_identity || 'agent:remediation-' + options.reviewType);
    let provenance: ReturnType<typeof buildReviewReceiptReviewerInvocationProvenance> | null = null;
    seedAuthenticatedReviewerLaunchFixture({ repoRoot: options.repoRoot, taskId: options.taskId, reviewType: options.reviewType,
        reviewerIdentity: identity, reviewContextPath: options.contextPath,
        reviewTreeStateSha256: String(receipt.review_tree_state_sha256), uniqueAttempt: true,
        appendEvent(_repo, task, type, outcome, details) {
            const event = appendTaskEvent(root, task, type, outcome || 'INFO', type, details, { passThru: true });
            assert.ok(event?.integrity);
            if (type === 'REVIEWER_INVOCATION_ATTESTED') provenance = buildReviewReceiptReviewerInvocationProvenance(type, event.integrity, details!);
            return { task_sequence: event.integrity.task_sequence, prev_event_sha256: event.integrity.prev_event_sha256,
                event_sha256: String(event.integrity.event_sha256) };
        }
    });
    assert.ok(provenance);
    Object.assign(receipt, {
        reviewer_identity: identity, reviewer_execution_mode: 'delegated_subagent', trust_level: 'INDEPENDENT_AUDITED',
        reviewer_provenance: provenance, ...validation.validation_result.bindings.execution, reused_existing_review: false,
        review_result_recorded_at_utc: new Date().toISOString(), recorded_at_utc: new Date().toISOString(),
        review_findings_validation: { artifact_path: options.validationPath.replace(/\\/gu, '/'), artifact_sha256: validationHash,
            snapshot_path: validationSnapshot.replace(/\\/gu, '/'), snapshot_sha256: validationHash,
            validation_result_sha256: validation.validation_result_sha256, status: validation.validation_result.status,
            accepted: validation.validation_result.accepted, violation_count: validation.validation_result.violations.length }
    });
    fs.writeFileSync(options.receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    return (baselinePath) => {
        const baselineHash = fileSha256(baselinePath)!;
        const baselineSnapshot = baselinePath.replace(/\.json$/u, '-' + baselineHash + '.json');
        fs.copyFileSync(baselinePath, baselineSnapshot);
        const receiptHash = fileSha256(options.receiptPath)!;
        const receiptSnapshot = options.receiptPath.replace(/\.json$/u, '-' + receiptHash + '.json');
        fs.copyFileSync(options.receiptPath, receiptSnapshot);
        appendTaskEvent(root, options.taskId, 'REVIEW_RECORDED', 'PASS', 'Retained authenticated remediation unit fixture.', {
            ...receipt, receipt_path: options.receiptPath, receipt_sha256: receiptHash,
            receipt_snapshot_path: receiptSnapshot, receipt_snapshot_sha256: receiptHash,
            review_artifact_path: options.artifactPath,
            remediation_baseline_snapshot_path: baselineSnapshot, remediation_baseline_snapshot_sha256: baselineHash
        });
        return baselineSnapshot;
    };
}
