import { buildReviewVerdictTokenSet, extractReviewVerdictSectionTokenMatch } from '../../gate-runtime/review-context';
import { readReviewArtifactTextFile } from '../../gate-runtime/review-artifacts';
import { isPlainRecord } from '../../core/records';
import { getReviewPassVerdict } from '../review-reuse/review-reuse-telemetry-normalization';
import { validateReviewFindingsValidationArtifactForReceipt } from '../review/review-findings-validation-artifact';
import { resolveLockedReviewFindingPolicyFromReceiptDisposition, reviewFindingsValidationArtifactHasBlockingFindings } from '../review/review-finding-disposition';
import { reviewEvidenceRequiresFindingsValidation } from './review-remediation-review-contract';

/** Eligibility for historical reuse only; the ordinary strict reuse validator still checks the full evidence chain. */
export function getPreservedReviewPassViolation(options: {
    taskId: string;
    reviewType: string;
    receipt: Readonly<Record<string, unknown>>;
    reviewContext: Readonly<Record<string, unknown>>;
    reviewArtifactPath: string;
}): string | null {
    const { receipt, reviewContext, reviewArtifactPath, taskId, reviewType } = options;
    if (!reviewEvidenceRequiresFindingsValidation(receipt, reviewContext)) {
        return extractReviewVerdictSectionTokenMatch(readReviewArtifactTextFile(reviewArtifactPath),
            buildReviewVerdictTokenSet(reviewType, getReviewPassVerdict(reviewType)))?.outcome === 'pass'
            ? null : 'Historical review artifact has no unambiguous PASS verdict.';
    }
    const field = (key: string) => typeof receipt[key] === 'string' ? receipt[key] as string : null;
    const output = isPlainRecord(receipt.review_output_contract) ? receipt.review_output_contract : null;
    const outputField = (key: string) => typeof output?.[key] === 'string' ? output[key] as string : null;
    const reused = receipt.reused_existing_review === true;
    const contextSha256 = reused ? field('reused_from_review_context_sha256') : field('review_context_sha256');
    const treeSha256 = reused ? field('reused_from_review_tree_state_sha256') : field('review_tree_state_sha256');
    if (!contextSha256 || !treeSha256) return 'Historical findings validation is missing its reviewed context or tree binding.';
    const validation = validateReviewFindingsValidationArtifactForReceipt({
        receipt: receipt as Record<string, unknown>, reviewArtifactPath, expectedTaskId: taskId, expectedReviewType: reviewType,
        expectedReviewOutputSha256: field('review_output_sha256') || outputField('raw_output_sha256'),
        expectedReviewArtifactSha256: field('review_artifact_sha256'),
        expectedReviewContextSha256: contextSha256,
        expectedPreflightSha256: reused ? null : field('preflight_sha256'),
        expectedScopeSha256: reused ? null : field('scope_sha256'),
        expectedReviewScopeSha256: reused ? field('reused_from_review_scope_sha256') || field('review_scope_sha256') : field('review_scope_sha256'),
        expectedCodeScopeSha256: reused ? field('reused_from_code_scope_sha256') || field('code_scope_sha256') : field('code_scope_sha256'),
        expectedReviewTreeStateSha256: treeSha256,
        expectedCoverageContractSha256: outputField('coverage_contract_sha256'),
        requireAccepted: true, preferSnapshot: true
    });
    if (!validation.valid || !validation.artifact) {
        return 'Historical findings validation is invalid: ' + validation.violations.join(' ');
    }
    return reviewFindingsValidationArtifactHasBlockingFindings(validation.artifact,
        resolveLockedReviewFindingPolicyFromReceiptDisposition(receipt as Record<string, unknown>))
        ? 'Historical findings validation contains policy-blocking findings or residual risks.' : null;
}
