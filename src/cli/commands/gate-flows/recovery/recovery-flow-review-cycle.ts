import { resolveRestartTaskIntent } from '../../../../gates/review-context/review-context-task-criteria-binding';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileRoleBindings } from '../../../../core/file-role-bindings';
import { readValidationFile } from '../../../../core/project-validation-identity';
import { sha256RedactedJsonPayload } from '../../../../core/redaction';
import { classifyChange, getClassificationConfig } from '../../../../gates/preflight/classify-change';
import type { ResolvedClassificationConfig } from '../../../../gates/preflight/classify-change';
import { buildReviewTreeState } from '../../../../gates/review/review-tree-state';
import { isSafeOrdinaryDocumentationPath } from '../../../../gates/preflight/classify-change-doc-safety';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import { getReviewExecutionPreparationBatches, resolveReviewExecutionPolicyModeFromPreflight } from '../../../../core/review-execution-policy';
import { resolveCompiledReviewDependencyGraphFromPreflight } from '../../../../core/review-dependency-graph';
import { type TokenEconomyConfig } from '../../../../gates/review-context/review-context-token-economy';
import { resolveTaskProfileReviewTriggerPolicy } from '../../../../policy/task-profile-policy-snapshot';
import {
    collectReviewRemediationProtectedBoundarySignals,
    hasReviewRemediationPolicySourceChange,
    resolveReviewRemediationModePolicyFromSnapshot,
    resolveReviewRemediationScopeReviewTypes,
    type ReviewRemediationProtectedBoundarySignal
} from '../../../../policy/review-remediation-mode-policy';
import { buildScopedDiff, resolveMetadataPath as resolveScopedDiffMetadataPath, resolveOutputPath as resolveScopedDiffOutputPath } from '../../../../gates/preflight/build-scoped-diff';
import { getPreflightContext, getWorkspaceSnapshot } from '../../../../gates/compile/compile-gate';
import {
    assessExplicitIgnoredRemediationTargets,
    readTaskReviewArtifactTexts,
    type IgnoredRemediationTargetAssessment
} from '../../../../gates/review-remediation/ignored-remediation-targets';
import {
    getReviewRemediationBaselineArtifactPath
} from '../../../../gates/review-remediation/review-remediation-baseline';
import {
    classifyReviewRemediationDelta,
    resolveRemediationTaskRoleConfig,
    type ReviewRemediationFileDelta
} from '../../../../gates/review-remediation/review-remediation-delta';
import { collectReviewRemediationScopeReviewTypes, mentionsReviewSecurityWord as mentionsSecurityWord,
    readAuthenticatedRemediationLaneReceipt, collectRemediationLaneHistory, laneRecordCoversTree } from '../../../../gates/review-remediation/review-remediation-scope-review-types';
import {
    collectLostRecordedReviewEvidenceTypes,
    collectUnpassedRestartInvalidatedReviewTypes,
    describeReviewEvidenceOnlyRestartRepeats
} from '../../../../gates/review-remediation/review-evidence-only-restart-scope';
import { readReviewEvidenceOnlyRestartReadiness } from '../../../../gates/next-step/next-step-review-evidence-only-restart';
import { captureLostReviewHistorySnapshots } from '../../../../gates/review-attempts/review-history-integrity';
import { findReviewContextRecoveryCandidates } from '../../../../gates/review/review-artifact-recovery';
import type { ReviewArtifactState } from '../../../../gates/next-step/next-step-review-artifact-readers';
import { hasAuthenticatedPassedReceiptForLostContext } from '../../../../gates/review-remediation/reviewed-tree-upstream-reviews';
import { getReviewLifecycleGuard } from '../../../../gates/review/review-lifecycle-guard';
import { resolveRemediationOriginReviewType } from '../../../../gates/review-remediation/review-remediation-origin';
import { resolveReviewRestartApproval } from './recovery-flow-review-restart-approval';
import {
    resolveAuthoritativeReviewRemediationDecision,
    type AuthoritativeReviewRemediationDecision,
    type ReviewRemediationDecisionClassification,
    type ReviewRemediationModePolicyValidationInputs,
    type ReviewRemediationReusableReceipt
} from '../../../../gates/review-remediation/review-remediation-recovery-routing';
import { buildReviewContextPreflightDiffExpectations } from '../../../../gates/review-context/review-context-contract';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    type CompileGateCommandOptions
} from '../compile/compile-flow';
import { buildNextStepRecoveryCommand } from '../compile/compile-flow-shared-evidence';
import { resolveDefaultReviewsPath } from '../../../gate-cli/gates-artifacts';
import {
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';
import {
    runBuildReviewContextCommand,
    readTimelineEventsSummary,
    type BuildReviewContextCommandResult
} from '../../gate-build-handlers';
import {
    bindAuthoritativeRemediationDecisionToPreflight,
    buildAuthenticatedRemediationReviewExecution
} from '../review-context/review-context-flow';
import {
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from '../task-mode/task-mode-flow';
import { resolveGateExecutionPath } from '../../../../gates/isolation/isolation-sandbox';
import { resolveRuntimeReviewerIdentity } from '../../../../gates/review/reviewer-routing';
import {
    assessReviewRemediationScopeBoundary,
    classifyReviewRemediationFix,
    getTaskManualValidationBoundaryFiles,
    REMEDIATION_IMPACT_ANALYSIS_TOPICS,
    resolveCurrentRemediationChangedFiles,
    resolveReviewRemediationClassifyChangedFiles,
    resolveReviewRemediationImpactAnalysis,
    writeReviewRemediationCycleArtifact
} from './recovery-flow-remediation';
import {
    getEffectiveDepthFromPreflight,
    getReviewCyclePrePreflightRefreshPlan,
    normalizeRuleFileList,
    resolveReviewCycleReplayScope
} from './recovery-flow-replay-scope';
import { buildReviewCycleRestartedOutput } from './recovery-flow-rendering';
import { normalizeChangedFiles } from './recovery-flow-shared';
import type {
    RestartReviewCycleCommandOptions,
    ReviewRemediationImpactAnalysis
} from './recovery-flow-types';
import {
    buildOptionalSkillRebindDetails,
    readRestartOptionalSkillActivationSnapshot,
    readRestartOptionalSkillDeclineSnapshot,
    rebindRestartOptionalSkillActivationsForCurrentCycle,
    rebindRestartOptionalSkillDeclinesForCurrentCycle
} from './recovery-flow-optional-skills';
import {
    appendRestartCompletedEvidence,
    collectRequiredRestartReviewTypes as collectRequiredReviewTypes,
    ensureRestartStepPassed as ensureStepPassed,
    requireRestartArtifactSha256 as requireArtifactSha256,
    resolveRecoveryPreflightPath
} from './recovery-flow-restart-evidence';
import { runRecoveryFlowPreflightPipeline } from './recovery-flow-preflight-pipeline';
import { NativeCaseExecutionUnavailableError } from '../../../../gates/review/native-case-semantics';
import { ExpectedRedEvidenceError } from '../../../../gates/test-first/expected-red-evidence';
import { resolveAuthoritativeReviewValidationObligations } from '../../../../gates/review-context/review-context-coverage';
function isCaseExecutionPrerequisite(error: unknown): boolean {
    return error instanceof NativeCaseExecutionUnavailableError || error instanceof ExpectedRedEvidenceError && error.needsGreen;
}
function getDependencyBlockReason(error: unknown, reviewType: string): string | null {
    const message = error instanceof Error ? error.message : String(error);
    const isUpstreamReviewBlock = message.includes(
        `ReviewType '${reviewType}' is blocked until upstream reviews pass for the current cycle:`
    );
    const isTrustBoundaryPrerequisiteBlock = message.includes(
        'Review context cannot be built because required trust-boundary analysis is'
    );
    if (!isUpstreamReviewBlock && !isTrustBoundaryPrerequisiteBlock && !isCaseExecutionPrerequisite(error)) {
        return null;
    }
    return message.trim();
}

export interface RuntimeReviewRemediationModeGuards {
    protectedBoundarySignals: ReviewRemediationProtectedBoundarySignal[];
    scopeReviewTypes: string[] | null;
    taskCriteriaChanged: boolean;
    policyChanged: boolean;
    uncertainCrossFileImpact: boolean;
}

/**
 * Review-domain triggers raised by the remediation delta files alone, using the
 * same classifier and frozen trigger policy as preflight. Task-wide triggers and
 * required review lanes describe the whole task, not what changed after the
 * authenticated review baseline. If the delta cannot be classified, the task-wide
 * preflight triggers are kept and the result is marked unclassified, which forces
 * FULL even when the preflight raised no protected signal.
 */
export function resolveRemediationDeltaReviewTriggers(options: {
    repoRoot: string;
    remediationDeltaFiles: readonly string[];
    profilePolicySnapshot?: unknown;
    preflightPayload?: unknown;
    classificationConfig?: ResolvedClassificationConfig;
}): { triggersPayload: unknown; classified: boolean } {
    if (options.remediationDeltaFiles.length === 0) {
        return { triggersPayload: {}, classified: true };
    }
    try {
        // With a frozen trigger policy the classifier tolerates an unreadable paths.json and drops the
        // project's domain triggers; load it once without the policy so a broken file fails closed.
        assertProtectedTriggerRegexesCompile(getClassificationConfig(options.repoRoot));
        const snapshot = options.profilePolicySnapshot as { review_trigger_policy?: unknown } | null | undefined;
        const reviewTriggerPolicy = snapshot && typeof snapshot === 'object' && snapshot.review_trigger_policy !== undefined
            ? resolveTaskProfileReviewTriggerPolicy(snapshot as Parameters<typeof resolveTaskProfileReviewTriggerPolicy>[0])
            : undefined;
        const classification = classifyChange({
            normalizedFiles: [...options.remediationDeltaFiles],
            repoRoot: options.repoRoot,
            isSourceCheckout: gateHelpers.isOrchestratorSourceCheckout(options.repoRoot),
            classificationConfig: options.classificationConfig
                ?? getClassificationConfig(options.repoRoot, reviewTriggerPolicy ? { reviewTriggerPolicy } : {})
        });
        return { triggersPayload: { triggers: classification.triggers, scope_category: classification.scope_category }, classified: true };
    } catch {
        return { triggersPayload: options.preflightPayload, classified: false };
    }
}

// Classification skips an invalid pattern with a warning, which would silently drop a protected signal.
function assertProtectedTriggerRegexesCompile(config: ReturnType<typeof getClassificationConfig>): void {
    for (const patterns of [config.db_trigger_regexes, config.security_trigger_regexes, config.api_trigger_regexes,
        config.dependency_trigger_regexes, config.infra_trigger_regexes]) {
        patterns.forEach((pattern) => new RegExp(pattern, 'i'));
    }
}

/**
 * FULL/DELTA guards for a remediation review. Every input is scoped to the files
 * changed after the authenticated review baseline: an unchanged protected file
 * elsewhere in the task scope, or a lane merely being required, does not force FULL.
 */
function resolveOrdinaryDocumentTest(repoRoot: string, profilePolicySnapshot: unknown): (filePath: string) => boolean {
    try {
        assertProtectedTriggerRegexesCompile(getClassificationConfig(repoRoot));
        const reviewTriggerPolicy = resolveTaskProfileReviewTriggerPolicy(
            profilePolicySnapshot as Parameters<typeof resolveTaskProfileReviewTriggerPolicy>[0]);
        const config = getClassificationConfig(repoRoot, { reviewTriggerPolicy });
        return (filePath) => isSafeOrdinaryDocumentationPath(filePath, config);
    } catch {
        return () => false;
    }
}

export function resolveRuntimeReviewRemediationModeGuards(options: {
    remediationDeltaFiles: readonly string[];
    remediationDeltaTriggers?: unknown;
    remediationDeltaClassified?: boolean;
    remediationDeltaSecurityWord?: boolean;
    remediationDeltaSecretChanged?: boolean;
    remediationFileDeltas?: readonly ReviewRemediationFileDelta[];
    repoRoot?: string;
    remediationProductionChanged?: boolean;
    authenticatedTaskCriteria?: string | null;
    currentTaskCriteria?: string | null;
    /** Task criteria changed: the shared binding rule, or the older card comparison when no binding was recorded. */
    linkedTaskCardChanged?: boolean;
    /** The failed review's context recorded a criteria binding, which already compared the task intent. */
    taskCriteriaBindingRecorded?: boolean;
}): RuntimeReviewRemediationModeGuards {
    const protectedBoundarySignals = collectReviewRemediationProtectedBoundarySignals({
        changedFiles: options.remediationDeltaFiles,
        preflight: options.remediationDeltaTriggers
    });
    if (options.remediationDeltaSecretChanged && !protectedBoundarySignals.includes('secret')) {
        protectedBoundarySignals.push('secret');
        protectedBoundarySignals.sort();
    }
    // The older summary comparison stays only for a failed review whose context records no criteria binding.
    const criteriaComparisonRequested = options.taskCriteriaBindingRecorded !== true
        && (options.authenticatedTaskCriteria !== undefined || options.currentTaskCriteria !== undefined);
    const authenticatedTaskCriteria = String(options.authenticatedTaskCriteria || '').trim();
    const currentTaskCriteria = String(options.currentTaskCriteria || '').trim();
    const criteriaBindingChanged = criteriaComparisonRequested
        && (
            !authenticatedTaskCriteria
            || !currentTaskCriteria
            || authenticatedTaskCriteria !== currentTaskCriteria
        );
    return {
        protectedBoundarySignals,
        scopeReviewTypes: options.remediationDeltaClassified === false
            ? null
            : collectReviewRemediationScopeReviewTypes({ repoRoot: options.repoRoot,
                triggers: (options.remediationDeltaTriggers as { triggers?: Record<string, unknown> })?.triggers ?? {},
                fileDeltas: options.remediationFileDeltas ?? [], securityWord: options.remediationDeltaSecurityWord === true,
                productionChanged: options.remediationProductionChanged,
                scopeCategory: (options.remediationDeltaTriggers as { scope_category?: string })?.scope_category }),
        taskCriteriaChanged:
            protectedBoundarySignals.includes('task_criteria_or_policy') || criteriaBindingChanged || options.linkedTaskCardChanged === true,
        policyChanged: hasReviewRemediationPolicySourceChange(options.remediationDeltaFiles, options.repoRoot),
        uncertainCrossFileImpact: options.remediationDeltaClassified === false
    };
}

export function resolveRuntimeDecisionInputs(options: {
    repoRoot: string;
    taskId: string;
    remediationReviewType: string;
    requiredReviewTypes: readonly string[];
    remediationFixClassification: {
        category: string;
        reason: string;
        blocked_before_reuse: boolean;
        invalidated_review_types: string[];
    };
    profilePolicySnapshot: unknown;
    currentChangedFiles: readonly string[];
    reviewTriggerPolicy: {
        file_roles?: FileRoleBindings;
        test_path_regexes: readonly string[];
        test_refactor_structural_path_regexes: readonly string[];
        test_refactor_changed_lines_threshold: number;
    };
    allowAuthenticatedDelta: boolean;
    preflightPayload?: unknown;
    preflightPath?: string;
    authenticatedTaskCriteria?: string | null;
    currentTaskCriteria?: string | null;
    /** The intent the new preflight is classified with; enables the shared task-criteria binding rule. */
    currentTaskIntent?: string | null;
    carriedInvalidatedReviewTypes?: readonly string[];
}): {
    currentReviewType: string;
    classification: ReviewRemediationDecisionClassification;
    modePolicyValidationInputs: ReviewRemediationModePolicyValidationInputs | null;
} {
    const currentReviewType = options.remediationReviewType
        || options.remediationFixClassification.invalidated_review_types[0]
        || options.requiredReviewTypes[0]
        || '';
    if (!currentReviewType) {
        throw new Error('Review remediation decision requires at least one current required review lane.');
    }
    const buildFullFallback = (reason: string): {
        currentReviewType: string;
        classification: ReviewRemediationDecisionClassification;
        modePolicyValidationInputs: null;
    } => {
        // Without an authenticated delta nothing proves which reviews the fix left unaffected:
        // the runtime classification rests on the agent's own impact analysis.
        const invalidatedReviewTypes = [...new Set([...options.requiredReviewTypes, currentReviewType])];
        return {
            currentReviewType,
            modePolicyValidationInputs: null,
            classification: {
                source: 'runtime_fix',
                classification: {
                    category: options.remediationFixClassification.category,
                    reason,
                    blocked_before_reuse: false,
                    invalidated_review_types: invalidatedReviewTypes
                }
            }
        };
    };
    if (options.allowAuthenticatedDelta && options.remediationReviewType) {
        const reviewArtifactPath = resolveDefaultReviewsPath(
            options.repoRoot,
            `${options.taskId}-${currentReviewType}.md`
        );
        const baselineArtifactPath = getReviewRemediationBaselineArtifactPath(reviewArtifactPath);
        if (!fs.existsSync(baselineArtifactPath) || !fs.statSync(baselineArtifactPath).isFile()) {
            return buildFullFallback('Authenticated remediation baseline is unavailable; FULL review is required.');
        }
        const { integrity: timelineIntegrity, lanes: laneReviews, timingEvents, trustedReceipts,
            authenticatedPreflightSha256 } = collectRemediationLaneHistory({
            repoRoot: options.repoRoot, taskId: options.taskId
        });
        const recordedEventDetails = laneReviews.get(currentReviewType)?.details;
        const consecutiveDeltaReviews = laneReviews.get(currentReviewType)?.depth ?? 0;
        if (timelineIntegrity.status !== 'PASS') {
            return buildFullFallback(
                `Task timeline cannot authenticate remediation snapshot lineage (${timelineIntegrity.status}); FULL review is required.`
            );
        }
        if (!recordedEventDetails) {
            return buildFullFallback(
                'Review telemetry does not bind an immutable remediation snapshot; FULL review is required.'
            );
        }
        const originReceipt = recordedEventDetails.receipt_sha256 ? readAuthenticatedRemediationLaneReceipt({
            repoRoot: options.repoRoot, taskId: options.taskId, reviewType: currentReviewType,
            details: recordedEventDetails, timingEvents, trustedReceipts
        }) : null;
        if (originReceipt && !originReceipt.authenticated) {
            return buildFullFallback('The baseline review receipt cannot be authenticated; every required review needs FULL.');
        }
        const recordedReviewExecutionMode = String(
            recordedEventDetails.review_execution_mode || ''
        ).trim().toUpperCase();
        if (!['FULL', 'DELTA'].includes(recordedReviewExecutionMode)) {
            return buildFullFallback(
                `Review telemetry contains unsupported review execution mode `
                + `'${recordedReviewExecutionMode || 'missing'}'; FULL review is required.`
            );
        }
        if (
            !String(recordedEventDetails.remediation_baseline_snapshot_path || '').trim()
            || !String(recordedEventDetails.remediation_baseline_snapshot_sha256 || '').trim()
        ) {
            return buildFullFallback(
                'Latest authenticated review telemetry does not bind an immutable remediation snapshot; '
                + 'FULL review is required.'
            );
        }
        const baselineSnapshotPath = path.resolve(
            options.repoRoot,
            String(recordedEventDetails.remediation_baseline_snapshot_path)
        );
        const baselineSnapshotSha256 = String(
            recordedEventDetails.remediation_baseline_snapshot_sha256 || ''
        ).trim().toLowerCase();
        const reviewsRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, 'runtime/reviews');
        const expectedFileName = (
            `${options.taskId}-${currentReviewType}-remediation-baseline-${baselineSnapshotSha256}.json`
        ).toLowerCase();
        if (
            !/^[0-9a-f]{64}$/u.test(baselineSnapshotSha256)
            || !gateHelpers.isPathRealpathInsideRoot(baselineSnapshotPath, reviewsRoot, { allowMissing: false })
            || path.basename(baselineSnapshotPath).toLowerCase() !== expectedFileName
        ) {
            return buildFullFallback(
                'Review telemetry contains an unsafe or invalid remediation snapshot binding; FULL review is required.'
            );
        }
        try {
            assertProtectedTriggerRegexesCompile(getClassificationConfig(options.repoRoot));
            let taskRolePreflightText: string | undefined;
            let taskRoleConfig: ResolvedClassificationConfig | undefined;
            const payload = options.preflightPayload as { declared_test_paths?: unknown } | null | undefined;
            if (options.preflightPath && authenticatedPreflightSha256 && Array.isArray(payload?.declared_test_paths)
                && payload.declared_test_paths.length > 0) {
                try {
                    const retained = readValidationFile(options.repoRoot,
                        path.relative(options.repoRoot, options.preflightPath).replace(/\\/gu, '/'), 1024 * 1024);
                    const snapshot = options.profilePolicySnapshot as { review_trigger_policy?: unknown } | null | undefined;
                    const policy = snapshot && typeof snapshot === 'object' && snapshot.review_trigger_policy !== undefined
                        ? resolveTaskProfileReviewTriggerPolicy(snapshot as Parameters<typeof resolveTaskProfileReviewTriggerPolicy>[0])
                        : undefined;
                    const config = getClassificationConfig(options.repoRoot, policy ? { reviewTriggerPolicy: policy } : {});
                    taskRoleConfig = resolveRemediationTaskRoleConfig({ repoRoot: options.repoRoot, taskId: options.taskId,
                        preflightText: retained.bytes.toString('utf8'), authenticatedPreflightHashes: [authenticatedPreflightSha256],
                        config: { ...config, file_roles: options.reviewTriggerPolicy.file_roles ?? config.file_roles,
                            test_trigger_regexes: [...options.reviewTriggerPolicy.test_path_regexes] } });
                    taskRolePreflightText = retained.bytes.toString('utf8');
                } catch {
                    // Missing, stale, foreign or unsafe declarations grant no task-local role.
                }
            }
            const modePolicyResolution = resolveReviewRemediationModePolicyFromSnapshot(
                options.profilePolicySnapshot
            );
            let deltaModeGuards: RuntimeReviewRemediationModeGuards | null = null;
            const resolveDeltaModeGuards = (remediationDeltaFiles: readonly string[], remediationDeltaLines: readonly string[],
                fileDeltas: readonly ReviewRemediationFileDelta[] = [], redactedChangedLine = false, linkedTaskCardChanged = false,
                taskCriteriaBindingRecorded = false) => {
                const deltaTriggers = resolveRemediationDeltaReviewTriggers({
                    repoRoot: options.repoRoot,
                    remediationDeltaFiles,
                    profilePolicySnapshot: options.profilePolicySnapshot,
                    preflightPayload: options.preflightPayload,
                    classificationConfig: taskRoleConfig
                });
                deltaModeGuards = resolveRuntimeReviewRemediationModeGuards({
                    repoRoot: options.repoRoot, remediationFileDeltas: fileDeltas,
                    remediationDeltaFiles,
                    remediationDeltaTriggers: deltaTriggers.triggersPayload,
                    remediationDeltaClassified: deltaTriggers.classified,
                    remediationDeltaSecretChanged: redactedChangedLine,
                    remediationDeltaSecurityWord: deltaTriggers.classified && mentionsSecurityWord(
                        remediationDeltaLines,
                        getClassificationConfig(options.repoRoot).security_trigger_name_tokens ?? []
                    ),
                    authenticatedTaskCriteria: options.authenticatedTaskCriteria,
                    currentTaskCriteria: options.currentTaskCriteria,
                    linkedTaskCardChanged,
                    taskCriteriaBindingRecorded
                });
                if (deltaTriggers.classified) {
                    if (fileDeltas.length && fileDeltas.every((entry) => entry.operation === 'added' && entry.category === 'leaf_test')) {
                        deltaModeGuards.protectedBoundarySignals = [];
                    }
                }
                return deltaModeGuards;
            };
            let delta = classifyReviewRemediationDelta({
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                reviewType: currentReviewType,
                baselineArtifactPath: baselineSnapshotPath,
                baselineArtifactSha256: baselineSnapshotSha256,
                currentChangedFiles: options.currentChangedFiles,
                testPathRegexes: options.reviewTriggerPolicy.test_path_regexes,
                fileRoles: taskRoleConfig?.file_roles ?? options.reviewTriggerPolicy.file_roles,
                structuralTestPathRegexes: options.reviewTriggerPolicy.test_refactor_structural_path_regexes,
                structuralTestChangedLinesThreshold:
                    options.reviewTriggerPolicy.test_refactor_changed_lines_threshold,
                isOrdinaryDocument: taskRoleConfig
                    ? (filePath) => isSafeOrdinaryDocumentationPath(filePath, taskRoleConfig!)
                    : resolveOrdinaryDocumentTest(options.repoRoot, options.profilePolicySnapshot),
                currentTaskIntent: options.currentTaskIntent,
                modePolicy: modePolicyResolution.policy,
                modePolicyLegacyFallback: modePolicyResolution.legacy_fallback,
                consecutiveDeltaReviews,
                resolveModeGuards: resolveDeltaModeGuards
            });
            if (taskRolePreflightText !== undefined) {
                const { classification_sha256: _previousHash, ...withoutHash } = delta;
                const withTaskRoles = { ...withoutHash, task_role_preflight_text: taskRolePreflightText };
                delta = { ...withTaskRoles, classification_sha256: sha256RedactedJsonPayload(withTaskRoles) };
            }
            const modeGuards: RuntimeReviewRemediationModeGuards = deltaModeGuards
                ?? resolveDeltaModeGuards(delta.documents_only ? [] : delta.changed_files, []);
            const baseline = JSON.parse(fs.readFileSync(baselineSnapshotPath, 'utf8')) as Record<string, unknown>;
            const bindings = baseline.bindings as Record<string, unknown> | undefined;
            const policy = bindings?.policy as Record<string, unknown> | undefined;
            const laneDeltas: NonNullable<typeof delta.lane_deltas> = {};
            if (!delta.full_review_required) {
                for (const reviewType of options.carriedInvalidatedReviewTypes ?? []) {
                    const review = laneReviews.get(reviewType);
                    if (!review || reviewType === currentReviewType
                        || laneRecordCoversTree(review, delta.baseline.review_tree_state_sha256)) continue;
                    const carried = resolveRuntimeDecisionInputs({ ...options, remediationReviewType: reviewType,
                        carriedInvalidatedReviewTypes: [] });
                    if (carried.classification.source !== 'delta' || !carried.modePolicyValidationInputs?.originReviewPassed) continue;
                    const candidate = carried.classification.delta;
                    const reached = resolveReviewRemediationScopeReviewTypes(candidate.mode_policy_assessment);
                    if (candidate.full_review_required || !candidate.mode_policy_assessment?.delta_eligible_review_types.includes(reviewType)
                        || !reached?.includes(reviewType)
                        || carried.classification.baselineProfilePolicySnapshotSha256 !== String(policy?.profile_policy_snapshot_sha256 || '').trim().toLowerCase()
                        || JSON.stringify(candidate.scope.full_review_scope) !== JSON.stringify(delta.scope.full_review_scope)) continue;
                    laneDeltas[reviewType] = candidate;
                }
            }
            if (Object.keys(laneDeltas).length) {
                const { classification_sha256: _previousHash, ...withoutHash } = delta;
                const withLaneDeltas = { ...withoutHash, lane_deltas: laneDeltas };
                delta = { ...withLaneDeltas, classification_sha256: sha256RedactedJsonPayload(withLaneDeltas) };
            }
            return {
                currentReviewType,
                modePolicyValidationInputs: {
                    consecutiveDeltaReviews,
                    protectedBoundarySignals: modeGuards.protectedBoundarySignals,
                    scopeReviewTypes: modeGuards.scopeReviewTypes,
                    deltaReadyReviewTypes: [...laneReviews.entries()]
                        .filter(([reviewType, review]) => {
                            if (!laneRecordCoversTree(review, delta.baseline.review_tree_state_sha256)
                                || review.depth >= modePolicyResolution.policy.max_consecutive_delta_reviews) return false;
                            const receipt = readAuthenticatedRemediationLaneReceipt({ repoRoot: options.repoRoot, taskId: options.taskId,
                                reviewType, details: review.details, timingEvents, trustedReceipts });
                            return receipt.authenticated && receipt.passed;
                        })
                        .map(([reviewType]) => reviewType).concat(Object.keys(laneDeltas)),
                    taskCriteriaChanged: modeGuards.taskCriteriaChanged,
                    policyChanged: modeGuards.policyChanged,
                    uncertainCrossFileImpact: modeGuards.uncertainCrossFileImpact,
                    lostEvidenceReviewTypes: collectLostRecordedReviewEvidenceTypes({ repoRoot: options.repoRoot, reviewsRoot, taskId: options.taskId })
                        .filter((reviewType) => options.requiredReviewTypes.includes(reviewType)),
                    // The baseline was validated against its recorded hash by the delta classification above.
                    originReviewPassed: originReceipt?.passed === true
                        && Array.isArray(baseline.fix_now_items) && baseline.fix_now_items.length === 0
                },
                classification: {
                    source: 'delta',
                    delta,
                    profilePolicySnapshot: options.profilePolicySnapshot,
                    baselineProfilePolicySnapshotSha256: String(
                        policy?.profile_policy_snapshot_sha256 || ''
                    ).trim().toLowerCase()
                }
            };
        } catch (error: unknown) {
            return buildFullFallback(
                `Authenticated remediation snapshot could not be validated: ${error instanceof Error ? error.message : String(error)} FULL review is required.`
            );
        }
    }
    if (options.allowAuthenticatedDelta) {
        return buildFullFallback('The fix has no authenticated failed-review origin; every required review needs FULL.');
    }
    return {
        currentReviewType,
        modePolicyValidationInputs: null,
        classification: {
            source: 'runtime_fix',
            classification: {
                category: options.remediationFixClassification.category,
                reason: options.remediationFixClassification.reason,
                blocked_before_reuse: options.remediationFixClassification.blocked_before_reuse,
                invalidated_review_types: options.remediationFixClassification.invalidated_review_types
            }
        }
    };
}

function requireReadyAuthoritativeDecision(
    decision: AuthoritativeReviewRemediationDecision
): AuthoritativeReviewRemediationDecision {
    if (decision.status === 'BLOCKED') {
        throw new Error(
            `Review remediation authoritative decision is blocked: ${decision.blocked_reasons.join(' ')}`
        );
    }
    return decision;
}

export function buildReviewEvidenceOnlyRestartPlan(
    invalidatedReviewTypes: readonly string[],
    remediationReviewType: string,
    carriedReviewTypes: readonly string[] = []
): {
    launchRequiredReviewTypes: string[];
    pendingReviewTypes: string[];
    pendingReason: string;
    nextStep: string;
} {
    const normalizedInvalidatedReviewTypes = [...new Set(invalidatedReviewTypes
        .map((reviewType) => String(reviewType || '').trim().toLowerCase())
        .filter(Boolean))];
    const restartReviewTypes = normalizedInvalidatedReviewTypes.length > 0
        ? normalizedInvalidatedReviewTypes
        : [String(remediationReviewType || '').trim().toLowerCase()].filter(Boolean);
    const reviewLaneSummary = restartReviewTypes.join(', ');
    const affectedReviewType = String(remediationReviewType || '').trim().toLowerCase() || restartReviewTypes[0] || '';
    const carried = restartReviewTypes.filter((reviewType) => reviewType !== affectedReviewType
        && carriedReviewTypes.includes(reviewType));
    const repeats = describeReviewEvidenceOnlyRestartRepeats(affectedReviewType, {
        carriedReviewTypes: carried,
        dependentReviewTypes: restartReviewTypes.filter((reviewType) => reviewType !== affectedReviewType
            && !carried.includes(reviewType))
    });
    return {
        launchRequiredReviewTypes: [...restartReviewTypes],
        pendingReviewTypes: [...restartReviewTypes],
        pendingReason: `failed delegated reviewer evidence repeats ${repeats}`,
        nextStep: restartReviewTypes.length === 1
            ? `Rerun next-step to materialize preserved review evidence and prepare one fresh '${reviewLaneSummary}' reviewer launch.`
            : `Rerun next-step to materialize preserved review evidence and prepare fresh reviewer launches for invalidated lanes: ${reviewLaneSummary}.`
    };
}

export async function runRestartReviewCycleCommand(
    options: RestartReviewCycleCommandOptions
): Promise<{ outputLines: string[]; exitCode: number }> {
    const startedAt = Date.now();
    const {
        repoRoot,
        resolvedTaskId,
        previousTaskMode,
        resolvedTaskModePath,
        resolvedPreflightPath,
        previousPreflight
    } = runRecoveryFlowPreflightPipeline(options);
    // Refuse before any state change: a write after REVIEW_GATE_PASSED reopens reviews only with the user's approval,
    // whichever restart then applies the review rules to it.
    let reviewRestartApproval: ReturnType<typeof resolveReviewRestartApproval>;
    try {
        reviewRestartApproval = resolveReviewRestartApproval({
            repoRoot, taskId: resolvedTaskId, preflightPath: resolvedPreflightPath,
            taskMode: previousTaskMode as unknown as Record<string, unknown>,
            approved: options.reviewRestartApproved, approvedAtUtc: options.reviewRestartApprovedAtUtc,
            gate: 'restart-review-cycle'
        });
    } catch (error: unknown) {
        return {
            outputLines: ['REVIEW_CYCLE_RESTART_REFUSED', `TaskId: ${resolvedTaskId}`, error instanceof Error ? error.message : String(error)],
            exitCode: EXIT_GATE_FAILURE
        };
    }
    const reviewEvidenceOnly = options.reviewEvidenceOnly === true;
    const remediationReviewType = String(options.reviewType || '').trim().toLowerCase();
    const verifiedClosedContextRecovery = (): boolean => {
        if (!reviewEvidenceOnly || !remediationReviewType || reviewRestartApproval.required
            || !['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE'].includes(reviewRestartApproval.blockingEvent || '')) return false;
        const lifecycle = getReviewLifecycleGuard(repoRoot, resolvedTaskId, 'restart-review-cycle', 'review_gate');
        if (lifecycle.status !== 'BLOCK' || lifecycle.blocking_event !== reviewRestartApproval.blockingEvent) return false;
        const required = collectRequiredReviewTypes(previousPreflight.preflight.required_reviews as Record<string, boolean>);
        if (!required.includes(remediationReviewType)) return false;
        const reviewsRoot = path.dirname(resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`));
        const contextPath = path.join(reviewsRoot, `${resolvedTaskId}-${remediationReviewType}-review-context.json`);
        const candidate = findReviewContextRecoveryCandidates({ repoRoot,
            eventsRoot: gateHelpers.joinOrchestratorPath(repoRoot, 'runtime/task-events'), taskId: resolvedTaskId,
            states: [{ reviewType: remediationReviewType, contextPath } as ReviewArtifactState] })[0];
        return Boolean(candidate && !candidate.copyAvailable && gateHelpers.fileSha256(contextPath) !== candidate.sha256
            && hasAuthenticatedPassedReceiptForLostContext({ repoRoot, reviewsRoot, taskId: resolvedTaskId,
                reviewType: remediationReviewType, contextSha256: candidate.sha256 })
            && readReviewEvidenceOnlyRestartReadiness({ repoRoot, reviewsRoot,
                eventsRoot: gateHelpers.joinOrchestratorPath(repoRoot, 'runtime/task-events'), taskId: resolvedTaskId,
                reviewType: remediationReviewType, preflight: previousPreflight.preflight, preflightPath: resolvedPreflightPath,
                taskMode: previousTaskMode as unknown as Record<string, unknown> }).ready);
    };
    const replayScope = resolveReviewCycleReplayScope(options, previousPreflight, previousTaskMode);
    const previousChangedFiles = normalizeChangedFiles(previousPreflight.changed_files as unknown[]);
    let currentRemediationChangedFiles = reviewEvidenceOnly
        ? []
        : resolveCurrentRemediationChangedFiles(repoRoot, replayScope, previousTaskMode.dirty_workspace_baseline);
    const taskModeArtifactRelativePath = resolvedTaskModePath
        ? gateHelpers.normalizePath(path.relative(repoRoot, path.resolve(resolvedTaskModePath)))
        : '';
    const taskModeIndexRelativePath = taskModeArtifactRelativePath
        ? gateHelpers.normalizePath(path.join(path.dirname(taskModeArtifactRelativePath), 'reviews-index.json'))
        : '';
    const baseAllowedBoundaryFiles = [
        ...(previousTaskMode.dirty_workspace_baseline?.changed_files || []),
        taskModeArtifactRelativePath,
        taskModeIndexRelativePath,
        ...getTaskManualValidationBoundaryFiles(resolvedTaskId, currentRemediationChangedFiles)
    ].filter(Boolean);
    if (!previousTaskMode.profile_policy_snapshot) {
        throw new Error('Review-cycle recovery requires the authenticated task profile policy snapshot.');
    }
    const frozenReviewTriggerPolicy = resolveTaskProfileReviewTriggerPolicy(previousTaskMode.profile_policy_snapshot);
    const reviewTriggerPolicy = { ...frozenReviewTriggerPolicy, file_roles: getClassificationConfig(repoRoot, {
        reviewTriggerPolicy: frozenReviewTriggerPolicy
    }).file_roles };
    let ignoredRemediationTargetAssessment: IgnoredRemediationTargetAssessment = {
        targets: [],
        allowedBoundaryFiles: [],
        violations: []
    };
    let scopeBoundary = assessReviewRemediationScopeBoundary(
        previousChangedFiles,
        currentRemediationChangedFiles,
        baseAllowedBoundaryFiles,
        reviewTriggerPolicy.test_path_regexes,
        reviewTriggerPolicy.file_roles,
        resolveOrdinaryDocumentTest(repoRoot, previousTaskMode.profile_policy_snapshot)
    );
    let remediationFixClassification = classifyReviewRemediationFix(
        scopeBoundary,
        [],
        undefined,
        reviewTriggerPolicy.test_path_regexes,
        undefined,
        {
            testRefactorChangedLinesThreshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
            testRefactorStructuralPathRegexes: reviewTriggerPolicy.test_refactor_structural_path_regexes
        }
    );
    let remediationImpactAnalysis: ReviewRemediationImpactAnalysis;
    // Reclassify with the current preflight's intent unless the agent names a new one.
    const taskSummary = String(options.taskIntent || resolveRestartTaskIntent({
        repoRoot, taskId: resolvedTaskId, preflight: previousPreflight.preflight, taskMode: previousTaskMode
    }) || '').trim();
    if (!taskSummary) {
        throw new Error('Task intent could not be resolved for review-cycle restart.');
    }
    // The older criteria comparison (failed-review contexts without a criteria binding) keeps its own inputs.
    const legacyTaskCriteria = String(options.taskIntent || previousTaskMode.task_summary || '').trim();
    try {
        const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
        const optionalSkillActivationSnapshot = readRestartOptionalSkillActivationSnapshot(
            orchestratorRoot,
            resolvedTaskId
        );
        const optionalSkillDeclineSnapshot = readRestartOptionalSkillDeclineSnapshot(
            orchestratorRoot,
            resolvedTaskId
        );
        const refreshedPreflightPath = resolveRecoveryPreflightPath(
            repoRoot,
            resolvedTaskId,
            options.preflightOutputPath || resolvedPreflightPath,
            'PreflightOutputPath'
        );
        const closedContextRecovery = verifiedClosedContextRecovery();
        const prePreflightRefreshPlan = getReviewCyclePrePreflightRefreshPlan(repoRoot, resolvedTaskId, {
            reviewGateReopenApproved: reviewRestartApproval.required,
            verifiedLostReviewContextRecovery: closedContextRecovery
        });
        try {
            remediationImpactAnalysis = resolveReviewRemediationImpactAnalysis(
                repoRoot,
                options,
                scopeBoundary.currentChangedFiles
            );
        } catch (error: unknown) {
            const artifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'BLOCKED',
                reason: 'missing_or_incomplete_remediation_impact_analysis',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                    ? gateHelpers.fileSha256(resolvedPreflightPath)
                    : null,
                detection_source: replayScope.detectionSource,
                impact_analysis: {
                    status: 'BLOCKED',
                    reason: error instanceof Error ? error.message : String(error),
                    required_topics: [...REMEDIATION_IMPACT_ANALYSIS_TOPICS],
                    affected_files: scopeBoundary.currentChangedFiles
                },
                remediation_fix_classification: remediationFixClassification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: scopeBoundary.currentChangedFiles,
                    expanded_files: scopeBoundary.expandedFiles,
                    expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                    allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
                },
                refresh_points: {
                    preflight: 'not_run_impact_analysis_blocked',
                    post_preflight_rule_pack: 'not_run_impact_analysis_blocked',
                    compile: 'not_run_impact_analysis_blocked',
                    review_contexts: 'not_run_impact_analysis_blocked'
                },
                reuse_boundaries: {
                    non_test_changes_must_stay_within_previous_preflight_scope: true,
                    test_only_expansion_allowed: true,
                    expanded_non_test_files_block_reuse: true
                }
            });
            throw new Error(
                `${error instanceof Error ? error.message : String(error)} ` +
                `Artifact: ${gateHelpers.normalizePath(artifactPath)}.`
            );
        }

        ignoredRemediationTargetAssessment = assessExplicitIgnoredRemediationTargets({
            repoRoot,
            taskId: resolvedTaskId,
            currentChangedFiles: scopeBoundary.currentChangedFiles,
            explicitChangedFiles: replayScope.changedFiles ?? [],
            guardedTargets: remediationImpactAnalysis.ignored_remediation_targets ?? [],
            impactAnalysisSummary: remediationImpactAnalysis.summary,
            reviewEvidenceTexts: readTaskReviewArtifactTexts(repoRoot, resolvedTaskId),
            taskMode: previousTaskMode as unknown as Record<string, unknown>
        });
        if (ignoredRemediationTargetAssessment.violations.length > 0) {
            const artifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'BLOCKED',
                reason: 'ignored_remediation_target_invalid',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                    ? gateHelpers.fileSha256(resolvedPreflightPath)
                    : null,
                detection_source: replayScope.detectionSource,
                impact_analysis: remediationImpactAnalysis,
                ignored_remediation_targets: {
                    status: 'BLOCKED',
                    targets: ignoredRemediationTargetAssessment.targets,
                    violations: ignoredRemediationTargetAssessment.violations
                },
                remediation_fix_classification: remediationFixClassification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: scopeBoundary.currentChangedFiles,
                    expanded_files: scopeBoundary.expandedFiles,
                    expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                    allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
                },
                refresh_points: {
                    preflight: 'not_run_ignored_remediation_target_blocked',
                    post_preflight_rule_pack: 'not_run_ignored_remediation_target_blocked',
                    compile: 'not_run_ignored_remediation_target_blocked',
                    review_contexts: 'not_run_ignored_remediation_target_blocked'
                },
                reuse_boundaries: {
                    non_test_changes_must_stay_within_previous_preflight_scope: true,
                    test_only_expansion_allowed: true,
                    explicit_ignored_remediation_targets_require_hash_and_review_relevance: true,
                    expanded_non_test_files_block_reuse: true
                }
            });
            throw new Error(
                `restart-review-cycle blocked ignored remediation target evidence: ` +
                `${ignoredRemediationTargetAssessment.violations.join('; ')}. ` +
                `Artifact: ${gateHelpers.normalizePath(artifactPath)}.`
            );
        }
        currentRemediationChangedFiles = normalizeChangedFiles([
            ...currentRemediationChangedFiles,
            ...ignoredRemediationTargetAssessment.allowedBoundaryFiles
        ]);
        scopeBoundary = assessReviewRemediationScopeBoundary(
            previousChangedFiles,
            currentRemediationChangedFiles,
            [
                ...baseAllowedBoundaryFiles,
                ...ignoredRemediationTargetAssessment.allowedBoundaryFiles
            ],
            reviewTriggerPolicy.test_path_regexes,
            reviewTriggerPolicy.file_roles,
            resolveOrdinaryDocumentTest(repoRoot, previousTaskMode.profile_policy_snapshot)
        );
        remediationImpactAnalysis = {
            ...remediationImpactAnalysis,
            affected_files: normalizeChangedFiles(scopeBoundary.currentChangedFiles)
        };
        remediationFixClassification = classifyReviewRemediationFix(
            scopeBoundary,
            [],
            remediationImpactAnalysis,
            reviewTriggerPolicy.test_path_regexes,
            undefined,
            {
                testRefactorChangedLinesThreshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
                testRefactorStructuralPathRegexes: reviewTriggerPolicy.test_refactor_structural_path_regexes
            }
        );

        if (scopeBoundary.status === 'BLOCKED' && reviewEvidenceOnly) {
            const artifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'BLOCKED',
                reason: 'failed_review_remediation_scope_expanded',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                    ? gateHelpers.fileSha256(resolvedPreflightPath)
                    : null,
                detection_source: replayScope.detectionSource,
                impact_analysis: remediationImpactAnalysis,
                remediation_fix_classification: remediationFixClassification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: scopeBoundary.currentChangedFiles,
                    expanded_files: scopeBoundary.expandedFiles,
                    expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                    allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
                },
                refresh_points: {
                    preflight: 'not_run_scope_blocked',
                    post_preflight_rule_pack: 'not_run_scope_blocked',
                    compile: 'not_run_scope_blocked',
                    review_contexts: 'not_run_scope_blocked'
                },
                reuse_boundaries: {
                    non_test_changes_must_stay_within_previous_preflight_scope: true,
                    test_only_expansion_allowed: true,
                    expanded_non_test_files_block_reuse: true
                }
            });
            throw new Error(
                `restart-review-cycle blocked failed-review remediation because non-test files outside the failed review scope changed: ` +
                `${scopeBoundary.expandedNonTestFiles.join(', ')}. ` +
                `Artifact: ${gateHelpers.normalizePath(artifactPath)}. ` +
                'Refresh the normal preflight/classification path or split the expanded work into a separate task.'
            );
        }

        if (reviewEvidenceOnly) {
            if (!remediationReviewType) {
                throw new Error('review-evidence-only restart requires --review-type.');
            }
            const requiredReviews = previousPreflight.preflight.required_reviews as Record<string, boolean>;
            const requiredReviewTypes = collectRequiredReviewTypes(requiredReviews);
            const reviewExecutionPolicyMode = resolveReviewExecutionPolicyModeFromPreflight(previousPreflight.preflight);
            const reviewDependencyGraph = resolveCompiledReviewDependencyGraphFromPreflight(
                previousPreflight.preflight,
                reviewExecutionPolicyMode
            );
            if (!requiredReviewTypes.includes(remediationReviewType)) {
                throw new Error(
                    `review-evidence-only restart review type '${remediationReviewType}' is not required by the current preflight.`
                );
            }
            const compileEvidencePath = resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`);
            const reviewsRoot = path.dirname(compileEvidencePath);
            const restartReadiness = readReviewEvidenceOnlyRestartReadiness({
                repoRoot,
                reviewsRoot,
                eventsRoot: gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')),
                taskId: resolvedTaskId,
                reviewType: remediationReviewType,
                preflight: previousPreflight.preflight,
                preflightPath: resolvedPreflightPath,
                taskMode: previousTaskMode as unknown as Record<string, unknown>
            });
            if (!restartReadiness.ready) {
                throw new Error(`review-evidence-only restart is blocked: ${restartReadiness.reason}`);
            }
            // A passed review gate still protects against late review writes. For a verified lost context,
            // refresh compile under the existing rules before the narrow restart opens the review stage again.
            let compileRefreshedAfterReviewGate = false;
            if (closedContextRecovery) {
                if (!verifiedClosedContextRecovery()) throw new Error('The lost review-context recovery evidence changed. Rerun next-step.');
                const compile = await runCompileGateCommand({ repoRoot, taskId: resolvedTaskId,
                    taskModePath: resolvedTaskModePath || undefined, preflightPath: resolvedPreflightPath,
                    commandsPath: options.commandsPath, outputFiltersPath: options.outputFiltersPath,
                    failTailLines: options.failTailLines, emitMetrics: options.emitMetrics } as CompileGateCommandOptions);
                ensureStepPassed('compile-gate', compile);
                compileRefreshedAfterReviewGate = true;
            }
            const currentPreflightSha256 = requireArtifactSha256(resolvedPreflightPath, 'preflight');
            const carriedReviewTypes = collectUnpassedRestartInvalidatedReviewTypes({
                reviewsRoot,
                taskId: resolvedTaskId,
                requiredReviewTypes
            });

            remediationFixClassification = classifyReviewRemediationFix(
                scopeBoundary,
                requiredReviewTypes,
                remediationImpactAnalysis,
                reviewTriggerPolicy.test_path_regexes,
                previousPreflight.preflight,
                {
                    testRefactorChangedLinesThreshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
                    testRefactorStructuralPathRegexes: reviewTriggerPolicy.test_refactor_structural_path_regexes,
                    reviewEvidenceOnly: true,
                    remediationReviewType,
                    carriedInvalidatedReviewTypes: carriedReviewTypes,
                    reviewDependencyGraph
                }
            );
            const evidenceOnlyDecisionInputs = resolveRuntimeDecisionInputs({
                repoRoot,
                taskId: resolvedTaskId,
                remediationReviewType,
                requiredReviewTypes,
                remediationFixClassification,
                profilePolicySnapshot: previousTaskMode.profile_policy_snapshot,
                currentChangedFiles: [],
                reviewTriggerPolicy,
                allowAuthenticatedDelta: false
            });
            const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
                requireReadyAuthoritativeDecision(resolveAuthoritativeReviewRemediationDecision({
                    taskId: resolvedTaskId,
                    currentReviewType: evidenceOnlyDecisionInputs.currentReviewType,
                    classification: evidenceOnlyDecisionInputs.classification,
                    modePolicyValidationInputs: evidenceOnlyDecisionInputs.modePolicyValidationInputs,
                    requiredReviews,
                    reviewExecutionPolicyMode,
                    reviewDependencyGraph,
                    carriedInvalidatedReviewTypes: carriedReviewTypes
                })),
                currentPreflightSha256
            );
            const effectiveDepth = getEffectiveDepthFromPreflight(previousTaskMode, previousPreflight);
            const evidenceOnlyRestartPlan = buildReviewEvidenceOnlyRestartPlan(
                authoritativeDecision.invalidated_review_types,
                remediationReviewType,
                carriedReviewTypes
            );
            const lostReviewHistorySnapshots = captureLostReviewHistorySnapshots({
                reviewsRoot, taskId: resolvedTaskId, reviewType: remediationReviewType
            });
            const nextStep = evidenceOnlyRestartPlan.nextStep;
            const remediationArtifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'PASSED',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: currentPreflightSha256,
                refreshed_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                refreshed_preflight_sha256: currentPreflightSha256,
                detection_source: 'review_evidence_only',
                impact_analysis: remediationImpactAnalysis,
                remediation_fix_classification: remediationFixClassification,
                authoritative_review_decision: authoritativeDecision,
                authoritative_review_classification: evidenceOnlyDecisionInputs.classification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: [],
                    expanded_files: [],
                    expanded_non_test_files: [],
                    allowed_test_only_expansion_files: []
                },
                refresh_points: {
                    preflight: 'reused_current',
                    post_preflight_rule_pack: 'reused_current',
                    compile: compileRefreshedAfterReviewGate ? 'rerun_after_review_gate' : 'reused_current',
                    review_contexts: 'deferred_to_navigator'
                },
                review_reuse: {
                    review_execution_policy: reviewExecutionPolicyMode,
                    prepared_review_types: [],
                    launch_required_review_types: evidenceOnlyRestartPlan.launchRequiredReviewTypes,
                    reused_review_types: authoritativeDecision.reused_review_types,
                    pending_review_types: evidenceOnlyRestartPlan.pendingReviewTypes,
                    pending_reason: evidenceOnlyRestartPlan.pendingReason
                }
            });
            const restartArtifactPath = appendRestartCompletedEvidence({
                repoRoot,
                taskId: resolvedTaskId,
                eventType: 'REVIEW_CYCLE_RESTARTED',
                artifactSuffix: '-review-cycle-restart.json',
                message: 'Delegated reviewer evidence-only cycle restarted without source or compile replay.',
                taskModePath: resolvedTaskModePath,
                preflightPath: resolvedPreflightPath,
                compileEvidencePath,
                detectionSource: 'review_evidence_only',
                plannedChangedFilesCount: previousChangedFiles.length,
                detectedChangedFilesCount: 0,
                elapsedMs: Date.now() - startedAt,
                restartReason: 'failed_delegated_reviewer_evidence_only',
                nextStepSummary: nextStep,
                extraDetails: {
                    remediation_artifact_path: gateHelpers.normalizePath(remediationArtifactPath),
                    remediation_artifact_sha256: requireArtifactSha256(remediationArtifactPath, 'review-remediation-cycle'),
                    impact_analysis_source: remediationImpactAnalysis.source,
                    affected_files_count: 0,
                    remediation_category: remediationFixClassification.category,
                    invalidated_review_types: authoritativeDecision.invalidated_review_types,
                    lost_review_history_snapshots: lostReviewHistorySnapshots,
                    preserved_review_types: authoritativeDecision.preserved_review_types,
                    authoritative_review_decision: authoritativeDecision,
                    authoritative_review_classification: evidenceOnlyDecisionInputs.classification,
                    review_contexts_refresh_status: 'deferred_to_navigator',
                    review_execution_policy_mode: reviewExecutionPolicyMode,
                    prepared_review_types: [],
                    launch_required_review_types: evidenceOnlyRestartPlan.launchRequiredReviewTypes,
                    reused_review_types: authoritativeDecision.reused_review_types,
                    pending_review_types: evidenceOnlyRestartPlan.pendingReviewTypes,
                    pending_reason: evidenceOnlyRestartPlan.pendingReason
                }
            });
            return {
                outputLines: buildReviewCycleRestartedOutput({
                    taskId: resolvedTaskId,
                    navigatorCommand: buildNextStepRecoveryCommand(repoRoot, resolvedTaskId),
                    preflightPath: resolvedPreflightPath,
                    remediationArtifactPath,
                    restartArtifactPath,
                    detectionSource: 'review_evidence_only',
                    affectedFilesCount: 0,
                    impactAnalysisSource: remediationImpactAnalysis.source,
                    remediationCategory: remediationFixClassification.category,
                    invalidatedReviewTypes: authoritativeDecision.invalidated_review_types,
                    preservedReviewTypes: authoritativeDecision.preserved_review_types,
                    scopeBoundaryStatus: scopeBoundary.status,
                    previousFilesCount: previousChangedFiles.length,
                    currentFilesCount: 0,
                    expandedNonTestFiles: [],
                    reviewContextsRefreshStatus: 'deferred_to_navigator',
                    effectiveDepth,
                    reviewExecutionPolicyMode,
                    preparedResults: [],
                    launchRequiredReviewTypes: evidenceOnlyRestartPlan.launchRequiredReviewTypes,
                    reusedReviewTypes: authoritativeDecision.reused_review_types,
                    pendingReviewTypes: evidenceOnlyRestartPlan.pendingReviewTypes,
                    pendingReason: evidenceOnlyRestartPlan.pendingReason,
                    nextStep,
                    preflightMode: previousPreflight.preflight.mode,
                    preflightScopeCategory: previousPreflight.preflight.scope_category,
                    preflightChangedFilesCount: previousPreflight.changed_files_count,
                    preflightRequiredReviewTypes: requiredReviewTypes,
                    refreshPoints: {
                        preflight: 'reused_current',
                        postPreflightRulePack: 'reused_current',
                        compile: compileRefreshedAfterReviewGate ? 'rerun_after_review_gate' : 'reused_current'
                    }
                }),
                exitCode: 0
            };
        }

        if (prePreflightRefreshPlan.rerunHandshakeDiagnostics) {
            ensureStepPassed('handshake-diagnostics', runHandshakeDiagnosticsCommand({
                repoRoot,
                taskId: resolvedTaskId,
                provider: previousTaskMode.provider || undefined,
                taskModePath: resolvedTaskModePath,
                allowCurrentShellSmokePrecheck: true,
                emitMetrics: options.emitMetrics
            }));
        }

        if (prePreflightRefreshPlan.rerunShellSmokePreflight) {
            ensureStepPassed('shell-smoke-preflight', runShellSmokePreflightCommand({
                repoRoot,
                taskId: resolvedTaskId,
                provider: previousTaskMode.provider || undefined,
                taskModePath: resolvedTaskModePath,
                emitMetrics: options.emitMetrics
            }));
        }

        const previousRequiredReviewTypes = collectRequiredReviewTypes(previousPreflight.preflight.required_reviews as Record<string, boolean>);
        // The published form has no --review-type: measure the fix against the review next-step names, the newest
        // failed review with an authenticated baseline, else the newest passed one; with neither every review runs FULL.
        const originReviewType = remediationReviewType || resolveRemediationOriginReviewType({
            repoRoot, taskId: resolvedTaskId, requiredReviewTypes: previousRequiredReviewTypes
        }) || '';
        const preflightDecisionInputs = resolveRuntimeDecisionInputs({
            repoRoot, taskId: resolvedTaskId, remediationReviewType: originReviewType,
            requiredReviewTypes: previousRequiredReviewTypes,
            remediationFixClassification, profilePolicySnapshot: previousTaskMode.profile_policy_snapshot,
            currentChangedFiles: scopeBoundary.currentChangedFiles, reviewTriggerPolicy,
            allowAuthenticatedDelta: true, preflightPayload: previousPreflight.preflight, preflightPath: resolvedPreflightPath,
            authenticatedTaskCriteria: previousTaskMode.task_summary, currentTaskCriteria: legacyTaskCriteria,
            currentTaskIntent: taskSummary
        });
        const remediationRequiredReviewTypes = preflightDecisionInputs.classification.source === 'delta'
            ? preflightDecisionInputs.classification.delta.mode_policy_assessment?.full_review_types ?? [] : [];
        runClassifyChangeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            outputPath: refreshedPreflightPath,
            taskIntent: taskSummary,
            remediationRequiredReviewTypes: [...new Set([...previousRequiredReviewTypes, ...remediationRequiredReviewTypes])],
            changedFiles: resolveReviewRemediationClassifyChangedFiles(
                replayScope,
                scopeBoundary,
                ignoredRemediationTargetAssessment.allowedBoundaryFiles
            ),
            useStaged: replayScope.useStaged,
            includeUntracked: replayScope.includeUntracked,
            emitMetrics: options.emitMetrics
        });
        const refreshedPreflight = getPreflightContext(refreshedPreflightPath, resolvedTaskId);
        const refreshedRequiredReviews = refreshedPreflight.preflight.required_reviews as Record<string, boolean>;
        const effectiveDepth = getEffectiveDepthFromPreflight(previousTaskMode, refreshedPreflight);
        const reviewExecutionPolicyMode = resolveReviewExecutionPolicyModeFromPreflight(refreshedPreflight.preflight);
        const reviewDependencyGraph = resolveCompiledReviewDependencyGraphFromPreflight(
            refreshedPreflight.preflight,
            reviewExecutionPolicyMode
        );

        ensureStepPassed('load-rule-pack (POST_PREFLIGHT)', runLoadRulePackCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            stage: 'POST_PREFLIGHT',
            preflightPath: refreshedPreflightPath,
            loadedRuleFiles: normalizeRuleFileList(refreshedRequiredReviews, effectiveDepth),
            emitMetrics: options.emitMetrics
        }));

        const optionalSkillActivationRebind = await rebindRestartOptionalSkillActivationsForCurrentCycle({
            orchestratorRoot,
            taskId: resolvedTaskId,
            snapshot: optionalSkillActivationSnapshot
        });
        const optionalSkillDeclineRebind = await rebindRestartOptionalSkillDeclinesForCurrentCycle({
            orchestratorRoot,
            taskId: resolvedTaskId,
            snapshot: optionalSkillDeclineSnapshot
        });
        const compileResult = await runCompileGateCommand({
            allowPlanDrift: options.allowPlanDrift,
            allowPlanDriftReason: options.allowPlanDriftReason,
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            preflightPath: refreshedPreflightPath,
            commandsPath: options.commandsPath,
            outputFiltersPath: options.outputFiltersPath,
            failTailLines: options.failTailLines,
            emitMetrics: options.emitMetrics
        } as CompileGateCommandOptions);
        ensureStepPassed('compile-gate', compileResult);
        const remediationWorkspaceSnapshot = getWorkspaceSnapshot(
            repoRoot,
            String(refreshedPreflight.detection_source || replayScope.detectionSource),
            replayScope.includeUntracked ?? !replayScope.useStaged,
            normalizeChangedFiles(refreshedPreflight.changed_files as unknown[])
        ) as Record<string, unknown>;

        const requiredReviewBatches = getReviewExecutionPreparationBatches(
            refreshedRequiredReviews,
            reviewExecutionPolicyMode,
            reviewDependencyGraph
        );
        const requiredReviewTypes = requiredReviewBatches.flat();
        // This restart measures only its own fix; a review an earlier restart reopened stays owed until it passes.
        const carriedInvalidatedReviewTypes = collectUnpassedRestartInvalidatedReviewTypes({
            reviewsRoot: path.dirname(resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`)),
            taskId: resolvedTaskId,
            requiredReviewTypes
        });
        remediationFixClassification = classifyReviewRemediationFix(
            scopeBoundary,
            requiredReviewTypes,
            remediationImpactAnalysis,
            reviewTriggerPolicy.test_path_regexes,
            refreshedPreflight.preflight,
            {
                testRefactorChangedLinesThreshold: reviewTriggerPolicy.test_refactor_changed_lines_threshold,
                testRefactorStructuralPathRegexes: reviewTriggerPolicy.test_refactor_structural_path_regexes,
                changedFileStats: remediationWorkspaceSnapshot.changed_file_stats,
                reviewDependencyGraph
            }
        );
        const authoritativeDecisionInputs = resolveRuntimeDecisionInputs({
            repoRoot,
            taskId: resolvedTaskId,
            remediationReviewType: originReviewType,
            requiredReviewTypes,
            remediationFixClassification,
            profilePolicySnapshot: previousTaskMode.profile_policy_snapshot,
            currentChangedFiles: scopeBoundary.currentChangedFiles,
            reviewTriggerPolicy,
            allowAuthenticatedDelta: true,
            preflightPayload: refreshedPreflight.preflight,
            preflightPath: refreshedPreflightPath,
            authenticatedTaskCriteria: previousTaskMode.task_summary,
            currentTaskCriteria: legacyTaskCriteria,
            currentTaskIntent: taskSummary,
            carriedInvalidatedReviewTypes
        });
        const preliminaryAuthoritativeDecisionWithoutPreflight = requireReadyAuthoritativeDecision(
            resolveAuthoritativeReviewRemediationDecision({
                taskId: resolvedTaskId,
                currentReviewType: authoritativeDecisionInputs.currentReviewType,
                classification: authoritativeDecisionInputs.classification,
                modePolicyValidationInputs: authoritativeDecisionInputs.modePolicyValidationInputs,
                requiredReviews: refreshedRequiredReviews,
                reviewExecutionPolicyMode,
                reviewDependencyGraph,
                carriedInvalidatedReviewTypes
            })
        );
        const refreshedPreflightSha256 = requireArtifactSha256(
            refreshedPreflightPath,
            'refreshed-preflight'
        );
        const preliminaryAuthoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
            preliminaryAuthoritativeDecisionWithoutPreflight,
            refreshedPreflightSha256
        );
        const preliminaryLaneDecisionByType = new Map(
            preliminaryAuthoritativeDecision.lane_decisions.map((decision) => [decision.review_type, decision])
        );
        const refreshedFullReviewScope = normalizeChangedFiles(
            refreshedPreflight.preflight.changed_files as unknown[]
        );
        const sharedTokenEconomyConfigPath = resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'token-economy.json'));
        const sharedTokenEconomyConfigData: TokenEconomyConfig | null = (
            fs.existsSync(sharedTokenEconomyConfigPath)
            && fs.statSync(sharedTokenEconomyConfigPath).isFile()
        )
            ? JSON.parse(fs.readFileSync(sharedTokenEconomyConfigPath, 'utf8')) as TokenEconomyConfig
            : null;
        const sharedRuleContextSectionsCache = new Map();
        const sharedRuleFileContentCache = new Map<string, string>();
        const sharedRuntimeReviewerIdentity = resolveRuntimeReviewerIdentity({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            taskModeEvidence: previousTaskMode,
            allowLegacyFallback: true
        });
        const preparedResults: BuildReviewContextCommandResult[] = [];
        const reusableReceipts: ReviewRemediationReusableReceipt[] = [];
        const launchRequiredReviewTypes: string[] = [];
        let pendingReviewTypes: string[] = [];
        let pendingReason: string | null = null;
        let pendingCaseExecution = false;

        for (let batchIndex = 0; batchIndex < requiredReviewBatches.length; batchIndex += 1) {
            const reviewBatch = requiredReviewBatches[batchIndex];
            const batchTimelineSummary = readTimelineEventsSummary(
                gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`))
            );
            const batchResults = await Promise.all(reviewBatch.map(async (reviewType) => {
                try {
                    const laneDecision = preliminaryLaneDecisionByType.get(reviewType);
                    if (!laneDecision) {
                        throw new Error(`Authoritative remediation decision is missing required lane '${reviewType}'.`);
                    }
                    // Fresh contexts would immediately become stale when the pending
                    // selected-case execution changes. Preserve reuse probes, but defer
                    // new preparation until the shared semantic owner has current GREEN.
                    if (!laneDecision.reuse_eligible) {
                        for (const semanticLane of requiredReviewTypes) {
                            resolveAuthoritativeReviewValidationObligations({
                                repoRoot, reviewType: semanticLane,
                                preflight: refreshedPreflight.preflight,
                                preflightPath: refreshedPreflightPath,
                                taskModePath: String(previousTaskMode.evidence_path || '').trim() || undefined
                            });
                        }
                    }
                    const scopedDiffExpected = buildReviewContextPreflightDiffExpectations(
                        refreshedPreflight.preflight,
                        reviewType
                    ).expectedScopedDiff;
                    const scopedDiffMetadataPath = scopedDiffExpected
                        ? resolveScopedDiffMetadataPath('', refreshedPreflightPath, reviewType, repoRoot)
                        : '';
                    if (scopedDiffExpected) {
                        buildScopedDiff({
                            reviewType,
                            preflightPath: refreshedPreflightPath,
                            pathsConfigPath: resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'paths.json')),
                            outputPath: resolveScopedDiffOutputPath('', refreshedPreflightPath, reviewType, repoRoot),
                            metadataPath: scopedDiffMetadataPath,
                            repoRoot,
                            useStaged: replayScope.useStaged
                        });
                    }
                    const preliminaryExecution = buildAuthenticatedRemediationReviewExecution({
                        taskId: resolvedTaskId,
                        reviewType,
                        preflightSha256: refreshedPreflightSha256,
                        fullReviewScope: refreshedFullReviewScope,
                        authoritativeDecision: preliminaryAuthoritativeDecision,
                        authoritativeClassification: authoritativeDecisionInputs.classification,
                        persistedDecisionSha256: preliminaryAuthoritativeDecision.decision_sha256
                    });
                    const prepared = await runBuildReviewContextCommand({
                        repoRoot,
                        reviewType,
                        depth: String(effectiveDepth),
                        preflightPath: refreshedPreflightPath,
                        preflightPayload: refreshedPreflight.preflight,
                        taskModePath: String(previousTaskMode.evidence_path || '').trim() || undefined,
                        taskModeEvidence: previousTaskMode,
                        runtimeReviewerIdentity: sharedRuntimeReviewerIdentity,
                        tokenEconomyConfigPath: sharedTokenEconomyConfigPath,
                        tokenEconomyConfigData: sharedTokenEconomyConfigData,
                        scopedDiffMetadataPath,
                        timelineEventsSummary: batchTimelineSummary,
                        reviewReuseAuthority: preliminaryExecution,
                        ruleContextSectionsCache: sharedRuleContextSectionsCache,
                        ruleFileContentCache: sharedRuleFileContentCache
                    });
                    return {
                        reviewType,
                        prepared,
                        dependencyBlockReason: null,
                        error: null
                    };
                } catch (error: unknown) {
                    return {
                        reviewType,
                        prepared: null,
                        dependencyBlockReason: getDependencyBlockReason(error, reviewType),
                        error
                    };
                }
            }));

            const unexpectedFailure = batchResults.find((result) => result.error && !result.dependencyBlockReason);
            if (unexpectedFailure) {
                throw unexpectedFailure.error;
            }

            for (const result of batchResults) {
                if (!result.prepared) {
                    continue;
                }
                preparedResults.push(result.prepared);
                if (result.prepared.acceptedReviewEvidenceKind) {
                    reusableReceipts.push({
                        review_type: result.reviewType,
                        reuse_status: 'ACCEPTED',
                        findings_satisfied: true,
                        evidence_kind: result.prepared.acceptedReviewEvidenceKind,
                        reason: result.prepared.acceptedReviewEvidenceKind === 'REUSED'
                            ? 'build-review-context accepted authenticated current-cycle reuse evidence'
                            : 'build-review-context accepted fresh authenticated current-cycle review evidence'
                    });
                } else {
                    reusableReceipts.push({
                        review_type: result.reviewType,
                        reuse_status: 'REJECTED',
                        findings_satisfied: false,
                        reason: result.prepared.outputLines.find((line) => line.startsWith('ReviewReuseReason:'))
                            ?.slice('ReviewReuseReason:'.length).trim()
                            || 'build-review-context did not accept authenticated satisfied reuse evidence'
                    });
                    launchRequiredReviewTypes.push(result.reviewType);
                }
            }

            const dependencyBlockedResult = batchResults.find((result) => result.dependencyBlockReason);
            if (dependencyBlockedResult) {
                pendingReviewTypes = requiredReviewTypes.slice(requiredReviewTypes.indexOf(dependencyBlockedResult.reviewType));
                pendingReason = dependencyBlockedResult.dependencyBlockReason;
                pendingCaseExecution = isCaseExecutionPrerequisite(dependencyBlockedResult.error);
                break;
            }
        }

        const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
            requireReadyAuthoritativeDecision(resolveAuthoritativeReviewRemediationDecision({
                taskId: resolvedTaskId,
                currentReviewType: authoritativeDecisionInputs.currentReviewType,
                classification: authoritativeDecisionInputs.classification,
                modePolicyValidationInputs: authoritativeDecisionInputs.modePolicyValidationInputs,
                requiredReviews: refreshedRequiredReviews,
                reviewExecutionPolicyMode,
                reviewDependencyGraph,
                reusableReceipts,
                carriedInvalidatedReviewTypes
            })),
            refreshedPreflightSha256
        );
        const reusedReviewTypes = authoritativeDecision.reused_review_types;
        const finalLaneDecisionByType = new Map(
            authoritativeDecision.lane_decisions.map((decision) => [decision.review_type, decision])
        );

        for (let index = 0; index < preparedResults.length; index += 1) {
            const preparedResult = preparedResults[index];
            if (!launchRequiredReviewTypes.includes(preparedResult.reviewType)) {
                continue;
            }
            const laneDecision = finalLaneDecisionByType.get(preparedResult.reviewType);
            if (!laneDecision || laneDecision.mode === 'REUSE') {
                throw new Error(
                    `Final authoritative remediation decision has no executable FULL/DELTA lane `
                    + `'${preparedResult.reviewType}'.`
                );
            }
            const reviewExecution = buildAuthenticatedRemediationReviewExecution({
                taskId: resolvedTaskId,
                reviewType: preparedResult.reviewType,
                preflightSha256: refreshedPreflightSha256,
                fullReviewScope: refreshedFullReviewScope,
                authoritativeDecision,
                authoritativeClassification: authoritativeDecisionInputs.classification,
                persistedDecisionSha256: authoritativeDecision.decision_sha256
            });
            const scopedDiffExpected = buildReviewContextPreflightDiffExpectations(
                refreshedPreflight.preflight,
                preparedResult.reviewType
            ).expectedScopedDiff;
            preparedResults[index] = await runBuildReviewContextCommand({
                repoRoot,
                reviewType: preparedResult.reviewType,
                depth: String(effectiveDepth),
                preflightPath: refreshedPreflightPath,
                preflightPayload: refreshedPreflight.preflight,
                taskModePath: String(previousTaskMode.evidence_path || '').trim() || undefined,
                taskModeEvidence: previousTaskMode,
                runtimeReviewerIdentity: sharedRuntimeReviewerIdentity,
                tokenEconomyConfigPath: sharedTokenEconomyConfigPath,
                tokenEconomyConfigData: sharedTokenEconomyConfigData,
                scopedDiffMetadataPath: scopedDiffExpected
                    ? resolveScopedDiffMetadataPath(
                        '',
                        refreshedPreflightPath,
                        preparedResult.reviewType,
                        repoRoot
                    )
                    : '',
                timelineEventsSummary: readTimelineEventsSummary(
                    gateHelpers.joinOrchestratorPath(
                        repoRoot,
                        path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`)
                    )
                ),
                reviewReuseBlockedReason: laneDecision.reason,
                reviewExecutionContract: reviewExecution.contract,
                reviewExecutionValidationAuthority: reviewExecution.validationAuthority,
                ruleContextSectionsCache: sharedRuleContextSectionsCache,
                ruleFileContentCache: sharedRuleFileContentCache
            });
        }

        const pendingOnTrustBoundaryPrerequisite = pendingReason?.includes(
            'Review context cannot be built because required trust-boundary analysis is'
        ) === true;
        const reviewContextsRefreshStatus = pendingReviewTypes.length > 0
            ? pendingOnTrustBoundaryPrerequisite || pendingCaseExecution
                ? 'partially_prepared_prerequisite_blocked'
                : 'partially_prepared_dependency_blocked'
            : 'prepared_or_reused';
        const nextStep = pendingReviewTypes.length > 0
            ? pendingCaseExecution
                ? 'Rerun next-step to record current selected-case execution before building review contexts; all pending reviews remain required.'
                : pendingOnTrustBoundaryPrerequisite
                ? 'Rerun next-step to refresh the mandatory trust-boundary checklist before building review contexts.'
                : 'Launch and record the prepared upstream reviews first, then rerun restart-review-cycle to materialize the remaining downstream review contexts.'
            : launchRequiredReviewTypes.length > 0
                ? 'Launch and record the prepared review types in dependency-safe order, then rerun required-reviews-check, doc-impact-gate, and completion-gate.'
                : 'All required review evidence is already current-cycle. Rerun required-reviews-check, doc-impact-gate, and completion-gate.';
        const remediationArtifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
            schema_version: 1,
            task_id: resolvedTaskId,
            status: 'PASSED',
            previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
            previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                ? gateHelpers.fileSha256(resolvedPreflightPath)
                : null,
            refreshed_preflight_path: gateHelpers.normalizePath(refreshedPreflightPath),
            refreshed_preflight_sha256: fs.existsSync(refreshedPreflightPath)
                ? gateHelpers.fileSha256(refreshedPreflightPath)
                : null,
            detection_source: replayScope.detectionSource,
            impact_analysis: remediationImpactAnalysis,
            ignored_remediation_targets: {
                status: ignoredRemediationTargetAssessment.violations.length > 0 ? 'BLOCKED' : 'OK',
                targets: ignoredRemediationTargetAssessment.targets,
                violations: ignoredRemediationTargetAssessment.violations
            },
            remediation_fix_classification: remediationFixClassification,
            authoritative_review_decision: authoritativeDecision,
            authoritative_review_classification: authoritativeDecisionInputs.classification,
            remediation_scope: {
                status: scopeBoundary.status,
                previous_changed_files: scopeBoundary.previousChangedFiles,
                current_changed_files: scopeBoundary.currentChangedFiles,
                expanded_files: scopeBoundary.expandedFiles,
                expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
            },
            refresh_points: {
                preflight: 'refreshed',
                post_preflight_rule_pack: 'reloaded',
                compile: 'rerun',
                review_contexts: reviewContextsRefreshStatus
            },
            review_reuse: {
                review_execution_policy: reviewExecutionPolicyMode,
                prepared_review_types: preparedResults.map((result) => result.reviewType),
                launch_required_review_types: launchRequiredReviewTypes,
                reused_review_types: reusedReviewTypes,
                pending_review_types: pendingReviewTypes,
                pending_reason: pendingReason
            },
            reuse_boundaries: {
                non_test_changes_must_stay_within_previous_preflight_scope: true,
                test_only_expansion_allowed: true,
                explicit_ignored_remediation_targets_require_hash_and_review_relevance: true,
                expanded_non_test_files_block_reuse: true
            }
        });
        const restartArtifactPath = appendRestartCompletedEvidence({
            repoRoot,
            taskId: resolvedTaskId,
            eventType: 'REVIEW_CYCLE_RESTARTED',
            artifactSuffix: '-review-cycle-restart.json',
            message: 'Review remediation cycle restarted after compile gate pass.',
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            compileEvidencePath: resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`),
            detectionSource: replayScope.detectionSource,
            plannedChangedFilesCount: previousChangedFiles.length,
            detectedChangedFilesCount: scopeBoundary.currentChangedFiles.length,
            elapsedMs: Date.now() - startedAt,
            restartReason: 'failed_review_remediation_cycle',
            nextStepSummary: nextStep,
            extraDetails: {
                remediation_artifact_path: gateHelpers.normalizePath(remediationArtifactPath),
                remediation_artifact_sha256: requireArtifactSha256(remediationArtifactPath, 'review-remediation-cycle'),
                impact_analysis_source: remediationImpactAnalysis.source,
                affected_files_count: scopeBoundary.currentChangedFiles.length,
                remediation_category: remediationFixClassification.category,
                invalidated_review_types: authoritativeDecision.invalidated_review_types,
                preserved_review_types: authoritativeDecision.preserved_review_types,
                authoritative_review_decision: authoritativeDecision,
                authoritative_review_classification: authoritativeDecisionInputs.classification,
                review_tree_state_sha256: buildReviewTreeState({
                    repoRoot, detectionSource: refreshedPreflight.preflight.detection_source,
                    includeUntracked: ['git_staged_plus_untracked', 'git_auto', 'explicit_changed_files']
                        .includes(String(refreshedPreflight.preflight.detection_source)),
                    changedFiles: refreshedFullReviewScope, metrics: refreshedPreflight.preflight.metrics as Record<string, unknown>,
                    reviewTriggerPolicy
                }).tree_state_sha256,
                review_contexts_refresh_status: reviewContextsRefreshStatus,
                review_execution_policy_mode: reviewExecutionPolicyMode,
                prepared_review_types: preparedResults.map((result) => result.reviewType),
                launch_required_review_types: launchRequiredReviewTypes,
                reused_review_types: reusedReviewTypes,
                pending_review_types: pendingReviewTypes,
                pending_reason: pendingReason,
                ...(reviewRestartApproval.required ? {
                    review_restart_approved: true,
                    review_restart_approved_at_utc: reviewRestartApproval.approvedAtUtc,
                    review_restart_after_event: reviewRestartApproval.blockingEvent,
                    review_restart_changed_files: reviewRestartApproval.changedFilesAfterReviewGate
                } : {}),
                ...(buildOptionalSkillRebindDetails(optionalSkillActivationRebind, optionalSkillDeclineRebind) || {})
            }
        });

        return {
            outputLines: buildReviewCycleRestartedOutput({
                taskId: resolvedTaskId,
                navigatorCommand: buildNextStepRecoveryCommand(repoRoot, resolvedTaskId),
                preflightPath: refreshedPreflightPath,
                remediationArtifactPath,
                restartArtifactPath,
                detectionSource: replayScope.detectionSource,
                affectedFilesCount: scopeBoundary.currentChangedFiles.length,
                impactAnalysisSource: remediationImpactAnalysis.source,
                remediationCategory: remediationFixClassification.category,
                invalidatedReviewTypes: authoritativeDecision.invalidated_review_types,
                preservedReviewTypes: authoritativeDecision.preserved_review_types,
                scopeBoundaryStatus: scopeBoundary.status,
                previousFilesCount: scopeBoundary.previousChangedFiles.length,
                currentFilesCount: scopeBoundary.currentChangedFiles.length,
                expandedNonTestFiles: scopeBoundary.expandedNonTestFiles,
                reviewContextsRefreshStatus,
                effectiveDepth,
                reviewExecutionPolicyMode,
                preparedResults,
                launchRequiredReviewTypes,
                reusedReviewTypes,
                pendingReviewTypes,
                pendingReason,
                nextStep,
                preflightMode: refreshedPreflight.preflight.mode,
                preflightScopeCategory: refreshedPreflight.preflight.scope_category,
                preflightChangedFilesCount: refreshedPreflight.changed_files_count,
                preflightRequiredReviewTypes: collectRequiredReviewTypes(refreshedRequiredReviews)
            }),
            exitCode: 0
        };
    } catch (error: unknown) {
        return {
            outputLines: [
                'REVIEW_CYCLE_RESTART_FAILED',
                `TaskId: ${resolvedTaskId}`,
                error instanceof Error ? error.message : String(error)
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
}
