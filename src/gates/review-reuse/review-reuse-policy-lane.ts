import { stringSha256 } from '../../gate-runtime/hash';
import {
    buildReviewContextHandoffArtifacts,
    type ReviewContextHandoffArtifactPaths,
    type ReviewSkillBinding
} from '../review-context/review-context-artifacts';
import {
    buildReviewLaneArtifactEvidence,
    type ReviewContextLaneBinding
} from '../review-context/review-context-lane';
import type { ReviewCoverageContract } from '../review/review-coverage-ledger';
import { computeReviewContextReuseHash, computeReviewRuleContextReuseHash } from './review-reuse';

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Compare an authenticated old custom-lane context with a new one while retaining the original integrity hashes.
 * Only the snapshot provenance in the lane binding may differ. Rebuild the instruction contract with the old
 * binding so that any other instruction, coverage, criteria, routing or scope change still prevents reuse.
 */
export function matchesReviewPolicyLaneReuse(options: {
    previousContextText: string | null | undefined;
    currentContext: Record<string, unknown>;
    receipt: Record<string, unknown>;
}): boolean {
    try {
        const text = options.previousContextText;
        if (!text || stringSha256(text) !== options.receipt.review_context_sha256) return false;
        const previous = record(JSON.parse(text));
        const oldLane = record(previous?.review_lane);
        const newLane = record(options.currentContext.review_lane);
        const rule = record(options.currentContext.rule_context);
        const coverage = record(options.currentContext.coverage_contract);
        const selectedSkill = record(rule?.selected_skill);
        if (!previous || !oldLane || !newLane || !rule || !coverage || !selectedSkill
            || oldLane.built_in !== false || newLane.built_in !== false
            || oldLane.profile_snapshot_sha256 === newLane.profile_snapshot_sha256) return false;

        const { binding_sha256: oldHash, ...oldBody } = oldLane;
        const { binding_sha256: newHash, ...newBody } = newLane;
        if (typeof oldHash !== 'string' || oldHash !== stringSha256(JSON.stringify(oldBody))
            || typeof newHash !== 'string' || newHash !== stringSha256(JSON.stringify(newBody))) return false;
        const semanticFields = ['schema_version', 'review_type', 'selection', 'built_in', 'catalog_sha256',
            'lane_definition_sha256', 'skill_ids', 'coverage_category_ids', 'reviewer_role', 'verdict_tokens'];
        if (semanticFields.some(field => JSON.stringify(oldLane[field]) !== JSON.stringify(newLane[field]))) return false;
        const evidence = buildReviewLaneArtifactEvidence(oldLane as unknown as ReviewContextLaneBinding);
        if (Object.entries(evidence).some(([field, value]) => options.receipt[field] !== value)) return false;
        if (computeReviewContextReuseHash(previous) !== options.receipt.review_context_reuse_sha256
            || computeReviewRuleContextReuseHash(previous) !== options.receipt.review_rule_context_sha256) return false;

        const pathFields = ['artifact_path', 'role_prompt_artifact', 'prompt_template_artifact',
            'output_template_artifact', 'evidence_manifest_artifact'];
        if (pathFields.some(field => typeof rule[field] !== 'string' || !rule[field])) return false;
        const paths: ReviewContextHandoffArtifactPaths = {
            ruleContextArtifactPath: String(rule.artifact_path),
            rolePromptArtifactPath: String(rule.role_prompt_artifact),
            promptTemplateArtifactPath: String(rule.prompt_template_artifact),
            outputTemplateArtifactPath: String(rule.output_template_artifact),
            evidenceManifestArtifactPath: String(rule.evidence_manifest_artifact)
        };
        const buildInstructionHash = (lane: Record<string, unknown>): string => buildReviewContextHandoffArtifacts({
            reviewType: String(newLane.review_type),
            selectedSkill: selectedSkill as unknown as ReviewSkillBinding,
            paths,
            ruleContextSections: { source_file_count: 0, summary: null, source_files: [] },
            promptArtifactText: '',
            stripExamplesApplied: false,
            stripCodeBlocksApplied: false,
            coverageContract: coverage as unknown as ReviewCoverageContract,
            reviewLaneBinding: lane as unknown as ReviewContextLaneBinding
        }).ruleContextArtifact.instruction_contract_sha256;
        if (buildInstructionHash(newLane) !== rule.instruction_contract_sha256) return false;
        const comparable = {
            ...options.currentContext,
            review_lane: oldLane,
            rule_context: { ...rule, instruction_contract_sha256: buildInstructionHash(oldLane) }
        };
        return computeReviewContextReuseHash(comparable) === options.receipt.review_context_reuse_sha256
            && computeReviewRuleContextReuseHash(comparable) === options.receipt.review_rule_context_sha256;
    } catch {
        return false;
    }
}
