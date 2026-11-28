import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readInvocationFileBytes } from '../../core/invocation-file-observation';
import { parseParentCompletionPolicy, type ParentCompletionPolicy } from '../../core/parent-completion-policy';

import { assertValidTaskId } from '../../gate-runtime/task-events';
import {
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    stringSha256,
    toStringArray
} from '../shared/helpers';
import {
    normalizeStrictDecompositionWorkPackageContract,
    STRICT_DECOMPOSITION_REVIEW_TYPES,
    validateStrictDecompositionWorkPackageFindingSources,
    type StrictDecompositionReviewType,
    type StrictDecompositionWorkPackageContract
} from './strict-decomposition-work-package-contract';
import { normalizeStrictDecompositionTaskPlan, type StrictDecompositionTaskPlan } from './strict-decomposition-plan';
import {
    assessStrictDecompositionPlanConformance,
    normalizeStrictDecompositionPlanCapRevision,
    normalizeStrictDecompositionPlanDispositions,
    normalizeStrictDecompositionRecheckBaseline,
    resolveEffectiveStrictDecompositionFileCap,
    type StrictDecompositionPlanCapRevision,
    type StrictDecompositionPlanDisposition,
    type StrictDecompositionRecheckBaseline
} from './strict-decomposition-plan-conformance';

export {
    STRICT_DECOMPOSITION_REVIEW_TYPES,
    type StrictDecompositionReviewType,
    type StrictDecompositionWorkPackageContract
} from './strict-decomposition-work-package-contract';

export const STRICT_DECOMPOSITION_DECISIONS = Object.freeze([
    'atomic',
    'single-cycle',
    'split-required'
] as const);

export type StrictDecompositionDecision = (typeof STRICT_DECOMPOSITION_DECISIONS)[number];

export interface StrictDecompositionProposedChild {
    task_id: string;
    profile: string;
}

export interface StrictDecompositionDecisionArtifact {
    parent_completion_policy?: ParentCompletionPolicy;
    timestamp_utc: string;
    event_source: 'strict-decomposition-decision';
    task_id: string;
    status: 'PASSED';
    outcome: 'PASS';
    decision: StrictDecompositionDecision;
    task_profile: string;
    task_summary: string;
    task_summary_sha256: string;
    reason: string;
    scope_risk: string;
    expected_review_types: StrictDecompositionReviewType[];
    expected_review_types_declared_none: boolean;
    atomicity_constraints: string[];
    proposed_children: StrictDecompositionProposedChild[];
    work_package_contract: StrictDecompositionWorkPackageContract | null;
    work_package_contract_sha256: string | null;
    estimated_changed_files?: number;
    plan_dispositions?: StrictDecompositionPlanDisposition[];
    plan_cap_revision?: StrictDecompositionPlanCapRevision;
    task_plan?: StrictDecompositionTaskPlan;
    recheck_baseline?: StrictDecompositionRecheckBaseline;
}

export interface BuildStrictDecompositionDecisionArtifactOptions {
    parentCompletionPolicy?: unknown;
    taskId: unknown;
    decision: unknown;
    taskSummary: unknown;
    taskProfile?: unknown;
    reason: unknown;
    scopeRisk: unknown;
    expectedReviewTypes?: unknown;
    atomicityConstraints?: unknown;
    proposedChildTaskIds?: unknown;
    workPackageContract?: unknown;
    estimatedChangedFiles?: unknown;
    planDispositions?: unknown;
    planCapRevision?: unknown;
    taskPlan?: unknown;
    recheckBaseline?: unknown;
}

export interface StrictDecompositionDecisionEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    evidence_outcome: string | null;
    evidence_task_id: string | null;
    evidence_source: string | null;
    decision: string | null;
    task_profile: string | null;
    task_summary_sha256: string | null;
    expected_review_types: string[];
    proposed_child_task_ids: string[];
    child_task_profile: string | null;
    work_package_task_ids: string[];
    work_package_root_cause_areas: string[];
    finding_obligation_ids: string[];
    work_package_contract_sha256: string | null;
    reason: string | null;
    estimated_changed_files: number | null;
    plan_file_cap: number | null;
    recheck_baseline: StrictDecompositionRecheckBaseline | null;
}

function normalizeShortKebab(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function normalizeStrictDecompositionDecision(value: unknown): StrictDecompositionDecision {
    const normalized = normalizeShortKebab(value);
    if (STRICT_DECOMPOSITION_DECISIONS.includes(normalized as StrictDecompositionDecision)) {
        return normalized as StrictDecompositionDecision;
    }
    throw new Error(`Decision must be one of: ${STRICT_DECOMPOSITION_DECISIONS.join(', ')}.`);
}

function normalizeExpectedReviewTypes(value: unknown): {
    expected_review_types: StrictDecompositionReviewType[];
    expected_review_types_declared_none: boolean;
} {
    const rawValues = toStringArray(value, { trimValues: true })
        .flatMap((entry) => String(entry).split(/[\r\n,;]+/))
        .map((entry) => normalizeShortKebab(entry))
        .filter(Boolean);
    const uniqueValues = [...new Set(rawValues)];

    if (uniqueValues.length === 0) {
        throw new Error('ExpectedReviewType is required; pass at least one review type or "none".');
    }
    if (uniqueValues.includes('none')) {
        if (uniqueValues.length > 1) {
            throw new Error('ExpectedReviewType "none" cannot be combined with concrete review types.');
        }
        return {
            expected_review_types: [],
            expected_review_types_declared_none: true
        };
    }

    const invalidValues = uniqueValues.filter(
        (entry) => !STRICT_DECOMPOSITION_REVIEW_TYPES.includes(entry as StrictDecompositionReviewType)
    );
    if (invalidValues.length > 0) {
        throw new Error(
            `ExpectedReviewType contains unsupported value(s): ${invalidValues.join(', ')}. ` +
            `Valid values: ${STRICT_DECOMPOSITION_REVIEW_TYPES.join(', ')}, none.`
        );
    }
    return {
        expected_review_types: uniqueValues as StrictDecompositionReviewType[],
        expected_review_types_declared_none: false
    };
}

function normalizeAtomicityConstraints(value: unknown): string[] {
    const constraints = toStringArray(value, { trimValues: true })
        .flatMap((entry) => String(entry).split(/[\r\n;]+/))
        .map((entry) => entry.trim())
        .filter(Boolean);
    const uniqueConstraints = [...new Set(constraints)];
    if (uniqueConstraints.length === 0) {
        throw new Error('AtomicityConstraint is required; use "none" only when there is no atomicity constraint.');
    }
    for (const constraint of uniqueConstraints) {
        if (constraint.length < 4) {
            throw new Error('AtomicityConstraint entries must be at least 4 characters.');
        }
    }
    return uniqueConstraints;
}

function normalizeProposedChildTaskIds(taskId: string, decision: StrictDecompositionDecision, value: unknown): string[] {
    const childIds = toStringArray(value, { trimValues: true })
        .flatMap((entry) => String(entry).split(/[\r\n,;]+/))
        .map((entry) => entry.trim())
        .filter(Boolean);
    const uniqueChildIds = [...new Set(childIds)];

    if (decision === 'split-required' && childIds.length !== uniqueChildIds.length) {
        throw new Error('Decision split-required requires unique ProposedChildTaskId values.');
    }
    if (decision === 'split-required' && uniqueChildIds.length < 2) {
        throw new Error('Decision split-required requires at least two ProposedChildTaskId values.');
    }

    return uniqueChildIds.map((childId) => {
        const normalizedChildId = assertValidTaskId(childId);
        if (!normalizedChildId.toLowerCase().startsWith(`${taskId.toLowerCase()}-`)) {
            throw new Error(`ProposedChildTaskId '${normalizedChildId}' must be parent-derived from '${taskId}'.`);
        }
        if (normalizedChildId.toLowerCase() === taskId.toLowerCase()) {
            throw new Error('ProposedChildTaskId must not equal the parent task id.');
        }
        return normalizedChildId;
    });
}

const MAX_ESTIMATED_CHANGED_FILES = 10000;

function isAbsentOption(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export function normalizeEstimatedChangedFiles(value: unknown): number | null {
    if (isAbsentOption(value)) return null;
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_ESTIMATED_CHANGED_FILES) {
        throw new Error(`EstimatedChangedFiles must be an integer from 1 to ${MAX_ESTIMATED_CHANGED_FILES}.`);
    }
    return parsed;
}

function validateNonEmptyField(value: unknown, label: string, minimumLength = 12): string {
    const text = String(value || '').trim();
    if (text.length < minimumLength) {
        throw new Error(`${label} is required and must be at least ${minimumLength} characters.`);
    }
    return text;
}

export function resolveStrictDecompositionDecisionArtifactPath(
    repoRoot: string,
    taskId: string,
    artifactPath = ''
): string {
    const explicitPath = String(artifactPath || '').trim();
    if (explicitPath) {
        const resolvedPath = resolvePathInsideRepo(explicitPath, repoRoot, {
            allowMissing: true,
            enforceInside: true
        });
        if (!resolvedPath) {
            throw new Error('StrictDecompositionDecisionArtifactPath must not be empty.');
        }
        if (!isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })) {
            throw new Error(`StrictDecompositionDecisionArtifactPath must stay inside repo root after realpath resolution: ${normalizePath(resolvedPath)}`);
        }
        return resolvedPath;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-strict-decomposition-decision.json`));
}

export function buildStrictDecompositionDecisionArtifact(
    options: BuildStrictDecompositionDecisionArtifactOptions
): StrictDecompositionDecisionArtifact {
    const taskId = assertValidTaskId(options.taskId);
    const decision = normalizeStrictDecompositionDecision(options.decision);
    const taskProfile = normalizeShortKebab(options.taskProfile || 'strict');
    if (!taskProfile) {
        throw new Error('TaskProfile is required for guarded decomposition decisions.');
    }
    const taskSummary = validateNonEmptyField(options.taskSummary, 'TaskSummary');
    const reason = validateNonEmptyField(options.reason, 'Reason');
    const scopeRisk = validateNonEmptyField(options.scopeRisk, 'ScopeRisk');
    const expectedReviews = normalizeExpectedReviewTypes(options.expectedReviewTypes);
    const atomicityConstraints = normalizeAtomicityConstraints(options.atomicityConstraints);
    const rawProposedChildTaskIds = toStringArray(options.proposedChildTaskIds, { trimValues: true })
        .flatMap((entry) => String(entry).split(/[\r\n,;]+/))
        .map((entry) => entry.trim())
        .filter(Boolean);
    let proposedChildTaskIds = rawProposedChildTaskIds.length > 0 || decision !== 'split-required'
        ? normalizeProposedChildTaskIds(taskId, decision, rawProposedChildTaskIds)
        : [];
    const workPackageContract = decision === 'split-required'
        ? normalizeStrictDecompositionWorkPackageContract(
            taskId,
            options.workPackageContract,
            expectedReviews.expected_review_types,
            taskProfile
        )
        : null;
    const childProfile = workPackageContract?.work_packages[0]?.profile || 'strict';
    if (decision !== 'split-required' && options.workPackageContract != null) {
        throw new Error('WorkPackageContract is only allowed for decision split-required.');
    }
    if (workPackageContract) {
        const contractTaskIds = workPackageContract.work_packages.map((entry) => entry.task_id);
        if (proposedChildTaskIds.length === 0) {
            proposedChildTaskIds = normalizeProposedChildTaskIds(taskId, decision, contractTaskIds);
        } else if (
            proposedChildTaskIds.length !== contractTaskIds.length
            || proposedChildTaskIds.some((childTaskId) => !contractTaskIds.includes(childTaskId))
        ) {
            throw new Error('ProposedChildTaskId values must exactly match WorkPackageContract work package task ids.');
        }
    }
    const workPackageContractSha256 = workPackageContract
        ? stringSha256(JSON.stringify(workPackageContract))
        : null;
    const estimatedChangedFiles = normalizeEstimatedChangedFiles(options.estimatedChangedFiles);
    const planDispositions = normalizeStrictDecompositionPlanDispositions(options.planDispositions);
    const planCapRevision = normalizeStrictDecompositionPlanCapRevision(options.planCapRevision);
    const taskPlan = normalizeStrictDecompositionTaskPlan(options.taskPlan);
    const recheckBaseline = normalizeStrictDecompositionRecheckBaseline(options.recheckBaseline);
    const planViolations = assessStrictDecompositionPlanConformance({
        decision, taskId, plan: taskPlan, estimatedChangedFiles, planDispositions, planCapRevision, recheckBaseline
    });
    if (planViolations.length > 0) {
        throw new Error(planViolations.join(' '));
    }
    const proposedChildren = proposedChildTaskIds.map((childTaskId) => ({
        task_id: childTaskId,
        profile: childProfile
    }));

    return {
        timestamp_utc: new Date().toISOString(),
        ...(decision === 'split-required' && options.parentCompletionPolicy !== undefined
            ? { parent_completion_policy: parseParentCompletionPolicy(options.parentCompletionPolicy) } : {}),
        event_source: 'strict-decomposition-decision',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        decision,
        task_profile: taskProfile,
        task_summary: taskSummary,
        task_summary_sha256: stringSha256(taskSummary) || '',
        reason,
        scope_risk: scopeRisk,
        expected_review_types: expectedReviews.expected_review_types,
        expected_review_types_declared_none: expectedReviews.expected_review_types_declared_none,
        atomicity_constraints: atomicityConstraints,
        proposed_children: proposedChildren,
        work_package_contract: workPackageContract,
        work_package_contract_sha256: workPackageContractSha256,
        // Legacy decisions omit these fields; their rechecks rely only on what they recorded.
        ...(estimatedChangedFiles !== null ? { estimated_changed_files: estimatedChangedFiles } : {}),
        ...(planDispositions.length > 0 ? { plan_dispositions: planDispositions } : {}),
        ...(planCapRevision !== null && taskPlan?.file_cap
            ? { plan_cap_revision: { file_cap: taskPlan.file_cap, justification: planCapRevision } } : {}),
        ...(taskPlan !== null ? { task_plan: taskPlan } : {}),
        ...(recheckBaseline !== null ? { recheck_baseline: recheckBaseline } : {})
    };
}

function buildUnknownEvidence(taskId: string | null): StrictDecompositionDecisionEvidenceResult {
    return {
        task_id: taskId,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        evidence_outcome: null,
        evidence_task_id: null,
        evidence_source: null,
        decision: null,
        task_profile: null,
        task_summary_sha256: null,
        expected_review_types: [],
        proposed_child_task_ids: [],
        child_task_profile: null,
        work_package_task_ids: [],
        work_package_root_cause_areas: [],
        finding_obligation_ids: [],
        work_package_contract_sha256: null,
        reason: null,
        estimated_changed_files: null,
        plan_file_cap: null,
        recheck_baseline: null
    };
}

export function getStrictDecompositionDecisionEvidence(
    repoRoot: string,
    taskId: string | null,
    artifactPath = '',
    expectedTaskSummary = '',
    expectedTaskProfile = '',
    expectedSplitSummary = expectedTaskSummary
): StrictDecompositionDecisionEvidenceResult {
    const result = buildUnknownEvidence(taskId);
    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    result.task_id = resolvedTaskId;
    const resolvedPath = resolveStrictDecompositionDecisionArtifactPath(repoRoot, resolvedTaskId, artifactPath);
    result.evidence_path = normalizePath(resolvedPath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        return result;
    }

    let artifactObject: Record<string, unknown>;
    try {
        const bytes = readInvocationFileBytes(resolvedPath);
        artifactObject = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        result.evidence_hash = createHash('sha256').update(bytes).digest('hex');
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        return result;
    }

    result.evidence_status = String(artifactObject.status || '').trim().toUpperCase();
    result.evidence_outcome = String(artifactObject.outcome || '').trim().toUpperCase();
    result.evidence_task_id = String(artifactObject.task_id || '').trim() || null;
    result.evidence_source = String(artifactObject.event_source || '').trim() || null;
    result.decision = String(artifactObject.decision || '').trim() || null;
    result.task_profile = String(artifactObject.task_profile || '').trim() || null;
    result.task_summary_sha256 = String(artifactObject.task_summary_sha256 || '').trim().toLowerCase() || null;
    result.expected_review_types = toStringArray(artifactObject.expected_review_types, { trimValues: true });
    result.proposed_child_task_ids = Array.isArray(artifactObject.proposed_children)
        ? artifactObject.proposed_children
            .map((entry) => (
                entry && typeof entry === 'object'
                    ? String((entry as Record<string, unknown>).task_id || '').trim()
                    : ''
            ))
            .filter(Boolean)
        : [];
    const rawWorkPackageContract = artifactObject.work_package_contract;
    if (rawWorkPackageContract && typeof rawWorkPackageContract === 'object' && !Array.isArray(rawWorkPackageContract)) {
        const contractRecord = rawWorkPackageContract as Record<string, unknown>;
        result.work_package_task_ids = Array.isArray(contractRecord.work_packages)
            ? contractRecord.work_packages.map((entry) => (
                entry && typeof entry === 'object'
                    ? String((entry as Record<string, unknown>).task_id || '').trim()
                    : ''
            )).filter(Boolean)
            : [];
        result.work_package_root_cause_areas = Array.isArray(contractRecord.work_packages)
            ? contractRecord.work_packages.map((entry) => (
                entry && typeof entry === 'object'
                    ? String((entry as Record<string, unknown>).root_cause_area || '').trim()
                    : ''
            )).filter(Boolean)
            : [];
        result.finding_obligation_ids = Array.isArray(contractRecord.finding_obligations)
            ? contractRecord.finding_obligations.map((entry) => (
                entry && typeof entry === 'object'
                    ? String((entry as Record<string, unknown>).obligation_id || '').trim()
                    : ''
            )).filter(Boolean)
            : [];
    }
    result.work_package_contract_sha256 = String(artifactObject.work_package_contract_sha256 || '').trim().toLowerCase() || null;
    result.reason = String(artifactObject.reason || '').trim() || null;

    if (result.evidence_task_id !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        return result;
    }
    if ((result.evidence_source || '').toLowerCase() !== 'strict-decomposition-decision') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        return result;
    }
    if (result.evidence_status !== 'PASSED' || result.evidence_outcome !== 'PASS') {
        result.evidence_status = 'EVIDENCE_NOT_PASS';
        return result;
    }
    if (Array.isArray(artifactObject.proposed_children)) {
        for (const child of artifactObject.proposed_children) {
            if (!child || typeof child !== 'object') {
                result.evidence_status = 'EVIDENCE_INVALID: Proposed child entries must be objects.';
                return result;
            }
        }
    }

    let recordedSummarySha: string;
    try {
        const rebuiltArtifact = buildStrictDecompositionDecisionArtifact({
            taskId: resolvedTaskId,
            decision: artifactObject.decision,
            taskProfile: artifactObject.task_profile,
            taskSummary: artifactObject.task_summary,
            reason: artifactObject.reason,
            scopeRisk: artifactObject.scope_risk,
            expectedReviewTypes: (artifactObject.expected_review_types_declared_none === true)
                ? ['none']
                : artifactObject.expected_review_types,
            atomicityConstraints: artifactObject.atomicity_constraints,
            proposedChildTaskIds: Array.isArray(artifactObject.proposed_children)
                ? artifactObject.proposed_children.map((entry) => (
                    entry && typeof entry === 'object'
                        ? String((entry as Record<string, unknown>).task_id || '')
                        : ''
                ))
                : [],
            workPackageContract: artifactObject.work_package_contract,
            parentCompletionPolicy: artifactObject.parent_completion_policy,
            estimatedChangedFiles: artifactObject.estimated_changed_files,
            planDispositions: artifactObject.plan_dispositions,
            planCapRevision: artifactObject.plan_cap_revision,
            taskPlan: artifactObject.task_plan,
            recheckBaseline: artifactObject.recheck_baseline
        });
        recordedSummarySha = rebuiltArtifact.task_summary_sha256;
        result.estimated_changed_files = rebuiltArtifact.estimated_changed_files ?? null;
        result.plan_file_cap = resolveEffectiveStrictDecompositionFileCap(rebuiltArtifact.task_plan ?? null,
            rebuiltArtifact.plan_cap_revision?.justification ?? null);
        result.recheck_baseline = rebuiltArtifact.recheck_baseline ?? null;
        if (result.work_package_contract_sha256 !== rebuiltArtifact.work_package_contract_sha256) {
            throw new Error('WorkPackageContract sha256 is missing or mismatched.');
        }
        const childProfile = rebuiltArtifact.proposed_children[0]?.profile || 'strict';
        if (Array.isArray(artifactObject.proposed_children)) {
            for (const child of artifactObject.proposed_children) {
                const declaredProfile = (child as Record<string, unknown>).profile;
                if (typeof declaredProfile !== 'string' || declaredProfile.trim().toLowerCase() !== childProfile) {
                    throw new Error(`Proposed child profile must be ${childProfile}.`);
                }
            }
        }
        result.child_task_profile = rebuiltArtifact.proposed_children.length > 0 ? childProfile : null;
        if (rebuiltArtifact.work_package_contract) {
            const sourceViolations = validateStrictDecompositionWorkPackageFindingSources(
                repoRoot,
                resolvedTaskId,
                rebuiltArtifact.work_package_contract
            );
            if (sourceViolations.length > 0) {
                throw new Error(sourceViolations.join(' '));
            }
        }
    } catch (error) {
        result.evidence_status = error instanceof Error
            ? `EVIDENCE_INVALID: ${error.message}`
            : 'EVIDENCE_INVALID';
        return result;
    }

    const isSplit = result.decision === 'split-required';
    const expectedSummaryText = String((isSplit ? expectedSplitSummary : expectedTaskSummary) || '').trim();
    if (expectedSummaryText || isSplit) {
        if (!result.task_summary_sha256) {
            result.evidence_status = 'EVIDENCE_TASK_SUMMARY_HASH_MISSING';
            return result;
        }
        if ((isSplit && result.task_summary_sha256 !== recordedSummarySha)
            || (expectedSummaryText && result.task_summary_sha256 !== stringSha256(expectedSummaryText))) {
            result.evidence_status = 'EVIDENCE_TASK_SUMMARY_MISMATCH';
            return result;
        }
    }

    const expectedProfile = normalizeShortKebab(expectedTaskProfile);
    if (expectedProfile && normalizeShortKebab(result.task_profile) !== expectedProfile) {
        result.evidence_status = 'EVIDENCE_TASK_PROFILE_MISMATCH';
        return result;
    }

    result.evidence_status = 'PASS';
    return result;
}
