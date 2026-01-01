import * as fs from 'node:fs';
import * as path from 'node:path';
import { joinOrchestratorPath } from '../../../../core/orchestrator-paths';
import { assertFreshReviewPolicyInputs } from '../../../../gates/required-reviews/required-reviews-check-contracts';

import { sha256RedactedJsonPayload } from '../../../../core/redaction';
import { isPlainRecord } from '../../../../core/records';
import {
    buildReviewContext
} from '../../../../gates/review-context/build-review-context';
import { readReviewContextChangedFiles } from '../../../../gates/review-context/review-context-diff';
import { fileSha256 } from '../../../../gates/shared/helpers';
import { assertReviewLifecycleGuardFromEntries } from '../../../../gates/review/review-lifecycle-guard';
import {
    assertRequiredUpstreamReviewDependencies
} from '../../../../gates/review/review-dependencies';
import {
    computeReviewContextReuseHash
} from '../../../../gates/review-reuse/review-reuse';
import {
    EVIDENCE_ONLY_CARRIED_LANE_REASON_CODE,
    getAuthoritativeReviewRemediationDecisionViolations,
    resolvePersistedReviewRemediationLaneDecision,
    type ReviewRemediationLaneDecision,
    type AuthoritativeReviewRemediationDecision,
    type ReviewRemediationDecisionClassification
} from '../../../../gates/review-remediation/review-remediation-recovery-routing';
import { resolveEvidenceOnlyCarriedLaneOrigin } from '../../../../gates/review-remediation/review-remediation-execution-authority';
import {
    buildReviewRemediationReviewContract,
    getReviewRemediationReviewContractViolations,
    resolveFixPreservedTreeStateSha256s,
    type ReviewRemediationAuthoritativeDecisionBinding,
    type ReviewRemediationReviewContract,
    type ReviewRemediationReviewContractValidationAuthority
} from '../../../../gates/review-remediation/review-remediation-review-contract';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events';
import { readRestartReviewClassification } from '../../../../gates/review-remediation/review-remediation-classification-evidence';
import { collectUnpassedRestartInvalidatedReviewTypes } from '../../../../gates/review-remediation/review-evidence-only-restart-scope';
import { validateReviewRemediationBaselineArtifact } from '../../../../gates/review-remediation/review-remediation-baseline';
import {
    buildAcceptedCurrentPassReviewContextCommandResult,
    buildGeneratedReviewContextCommandResult,
    resolveBuildReviewContextCommandInputs,
    type BuildReviewContextCommandOptions,
    type BuildReviewContextCommandResult
} from './review-context-command-binding';
import {
    emitCurrentPassReviewContextReuseAccepted,
    emitGeneratedReviewContextPreparationTelemetry
} from './review-context-telemetry';
import {
    tryAcceptCurrentPassReviewEvidence
} from './review-context-flow-current-pass-reuse';
import {
    tryReuseReviewEvidence,
    type ReviewReuseResult
} from './review-context-flow-historical-reuse';

export {
    readTimelineEventsSummary,
    type BuildReviewContextCommandOptions,
    type BuildReviewContextCommandResult
} from './review-context-command-binding';

function taskEventSequence(event: Record<string, unknown>): number {
    return isPlainRecord(event.integrity)
        ? Number(event.integrity.task_sequence) || 0
        : 0;
}

export interface AuthenticatedFreshPassReviewEvidence {
    reviewRecordedSequence: number;
    remediationMode: string | null;
    authoritativeDecisionSha256: string | null;
    classificationSha256: string | null;
}

function hasAuthenticatedFreshPassAfterBoundary(options: {
    evidence: AuthenticatedFreshPassReviewEvidence | null;
    boundarySequence: number;
    authoritativeDecision?: AuthoritativeReviewRemediationDecision | null;
    laneMode?: unknown;
}): boolean {
    const evidence = options.evidence;
    if (!evidence || evidence.reviewRecordedSequence <= options.boundarySequence) {
        return false;
    }
    if (!options.authoritativeDecision) {
        return true;
    }
    return evidence.remediationMode === String(options.laneMode || '').trim().toUpperCase()
        && evidence.authoritativeDecisionSha256 === options.authoritativeDecision.decision_sha256
        && evidence.classificationSha256 === options.authoritativeDecision.classification_sha256;
}

export interface PersistedRemediationReusePolicy {
    blockedReason: string;
    preservedScopeMismatchReason: string;
    reviewExecutionContract?: ReviewRemediationReviewContract | null;
    reviewExecutionValidationAuthority?: ReviewRemediationReviewContractValidationAuthority | null;
    remediationFixBaseTreeStateSha256s?: readonly string[];
    persistedRemediationReuseRequired?: boolean;
    acceptsPreservedCurrentPassContract?: boolean;
    failClosed?: boolean;
}

export function bindAuthoritativeRemediationDecisionToPreflight(
    decision: AuthoritativeReviewRemediationDecision,
    preflightSha256: string
): ReviewRemediationAuthoritativeDecisionBinding {
    const normalizedPreflightSha256 = String(preflightSha256 || '').trim().toLowerCase();
    if ('preflight_sha256' in decision) {
        const existingBinding = decision as ReviewRemediationAuthoritativeDecisionBinding;
        const violations = getAuthoritativeReviewRemediationDecisionViolations(existingBinding);
        if (existingBinding.preflight_sha256 !== normalizedPreflightSha256) {
            violations.push('authoritative remediation decision preflight_sha256 is stale.');
        }
        if (violations.length > 0) {
            throw new Error(`Persisted authoritative remediation decision is invalid: ${violations.join(' ')}`);
        }
        return existingBinding;
    }
    const decisionWithoutHash = {
        ...decision,
        preflight_sha256: normalizedPreflightSha256
    } as Record<string, unknown>;
    delete decisionWithoutHash.decision_sha256;
    return {
        ...decisionWithoutHash,
        decision_sha256: sha256RedactedJsonPayload(decisionWithoutHash)
    } as unknown as ReviewRemediationAuthoritativeDecisionBinding;
}

function emptyPersistedRemediationReusePolicy(
    overrides: Partial<PersistedRemediationReusePolicy> = {}
): PersistedRemediationReusePolicy {
    return {
        blockedReason: '',
        preservedScopeMismatchReason: '',
        ...overrides
    };
}

export function buildAuthenticatedRemediationReviewExecution(options: {
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    fullReviewScope: readonly string[];
    authoritativeDecision: AuthoritativeReviewRemediationDecision;
    authoritativeClassification: ReviewRemediationDecisionClassification;
    persistedDecisionSha256?: string | null;
}): {
    contract: ReviewRemediationReviewContract;
    validationAuthority: ReviewRemediationReviewContractValidationAuthority;
} {
    const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
        options.authoritativeDecision,
        options.preflightSha256
    );
    const contract = buildReviewRemediationReviewContract({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.preflightSha256,
        fullReviewScope: options.fullReviewScope,
        authoritativeDecision,
        classification: options.authoritativeClassification
    });
    const validationAuthority: ReviewRemediationReviewContractValidationAuthority = {
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.preflightSha256,
        mode: contract.mode,
        fullReviewScope: options.fullReviewScope,
        persistedDecisionSha256: options.persistedDecisionSha256
            ?? options.authoritativeDecision.decision_sha256,
        authoritativeDecisionSha256: options.authoritativeDecision.decision_sha256,
        authoritativeClassificationSha256: options.authoritativeDecision.classification_sha256,
        authoritativeDecision,
        authoritativeClassification: options.authoritativeClassification
    };
    const violations = getReviewRemediationReviewContractViolations(contract, validationAuthority);
    if (violations.length > 0) {
        throw new Error(`Authenticated remediation review execution is invalid: ${violations.join(' ')}`);
    }
    return { contract, validationAuthority };
}

/**
 * A failed baseline review always repeats, so its lane is executable. A passed baseline review (authenticated
 * baseline without fix-now items) is kept when the change does not reach its scope; it then authorizes the kept
 * lanes without an execution contract of its own.
 */
function isKeptPassedRemediationOrigin(
    classification: ReviewRemediationDecisionClassification,
    lane: ReviewRemediationLaneDecision
): boolean {
    if (lane.mode !== 'REUSE' || lane.invalidated || classification.source !== 'delta') return false;
    const validation = validateReviewRemediationBaselineArtifact({
        artifactPath: classification.delta.baseline.artifact_path,
        expectedArtifactSha256: classification.delta.baseline.artifact_sha256,
        expectedTaskId: classification.delta.task_id,
        expectedReviewType: classification.delta.review_type,
        expectedReviewTreeStateSha256: classification.delta.baseline.review_tree_state_sha256
    });
    return validation.valid && validation.artifact?.fix_now_items.length === 0;
}

function buildKeptPassedOriginAuthority(options: {
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    fullReviewScope: readonly string[];
    authoritativeDecision: AuthoritativeReviewRemediationDecision;
    authoritativeClassification: ReviewRemediationDecisionClassification;
}): ReviewRemediationReviewContractValidationAuthority {
    const authoritativeDecision = bindAuthoritativeRemediationDecisionToPreflight(
        options.authoritativeDecision,
        options.preflightSha256
    );
    return {
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.preflightSha256,
        // The kept origin is not reviewed again; this authority only names the decision that kept the other lanes.
        mode: 'FULL',
        fullReviewScope: options.fullReviewScope,
        persistedDecisionSha256: options.authoritativeDecision.decision_sha256,
        authoritativeDecisionSha256: options.authoritativeDecision.decision_sha256,
        authoritativeClassificationSha256: options.authoritativeDecision.classification_sha256,
        authoritativeDecision,
        authoritativeClassification: options.authoritativeClassification
    };
}

export function resolvePersistedRemediationReusePolicy(options: {
    events: Record<string, unknown>[];
    taskId: string;
    reviewType: string;
    preflightPath: string;
    timelinePath: string;
    preflightPayload?: Record<string, unknown> | null;
    authenticatedFreshPassReviewEvidence?: AuthenticatedFreshPassReviewEvidence | null;
}): PersistedRemediationReusePolicy {
    const resolvedPreflightSha256 = fileSha256(options.preflightPath);
    if (!resolvedPreflightSha256) {
        return emptyPersistedRemediationReusePolicy();
    }
    const preflightSha256 = resolvedPreflightSha256.toLowerCase();
    let preflightPayload = options.preflightPayload || null;
    if (!preflightPayload) {
        try {
            preflightPayload = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8')) as Record<string, unknown>;
        } catch {
            preflightPayload = null;
        }
    }
    const fullReviewScope = readReviewContextChangedFiles(preflightPayload?.changed_files);
    const hasMatchingRestartEvent = options.events.some((event) => {
        const details = isPlainRecord(event.details) ? event.details : {};
        return String(event.event_type || '').trim() === 'REVIEW_CYCLE_RESTARTED'
            && String(details.task_id || '').trim() === options.taskId
            && String(details.preflight_sha256 || '').trim().toLowerCase() === preflightSha256;
    });
    if (
        hasMatchingRestartEvent
        && !inspectTaskEventFile(options.timelinePath, options.taskId).status.startsWith('PASS')
    ) {
        return emptyPersistedRemediationReusePolicy({
            blockedReason:
                'review reuse blocked because the persisted remediation timeline failed hash-chain integrity validation',
            failClosed: true
        });
    }
    for (let index = options.events.length - 1; index >= 0; index -= 1) {
        const event = options.events[index];
        const details = isPlainRecord(event.details) ? event.details : {};
        if (
            String(event.event_type || '').trim() !== 'REVIEW_CYCLE_RESTARTED'
            || String(details.task_id || '').trim() !== options.taskId
            || String(details.event_type || '').trim() !== 'REVIEW_CYCLE_RESTARTED'
            || String(details.status || '').trim() !== 'PASSED'
            || String(details.preflight_sha256 || '').trim().toLowerCase() !== preflightSha256
            || taskEventSequence(event) <= 0
        ) {
            continue;
        }
        if (details.authoritative_review_decision !== undefined) {
            const authoritativeDecision = details.authoritative_review_decision;
            const violations = getAuthoritativeReviewRemediationDecisionViolations(
                authoritativeDecision,
                { expectedTaskId: options.taskId }
            );
            if (violations.length > 0 || !isPlainRecord(authoritativeDecision)) {
                return emptyPersistedRemediationReusePolicy({
                    blockedReason:
                        `review reuse blocked because the persisted authoritative remediation decision `
                        + `failed validation: ${violations.join(' ')}`,
                    failClosed: true
                });
            }
            if (authoritativeDecision.status !== 'READY') {
                return emptyPersistedRemediationReusePolicy({
                    blockedReason:
                        `review reuse blocked because the persisted authoritative remediation decision is `
                        + `${String(authoritativeDecision.status || 'unknown')}`,
                    failClosed: true
                });
            }
            let authoritativeClassification: unknown;
            try {
                authoritativeClassification = readRestartReviewClassification({
                    reviewsRoot: path.resolve(path.dirname(options.timelinePath), '..', 'reviews'),
                    taskId: options.taskId, details
                });
            } catch (error) {
                return emptyPersistedRemediationReusePolicy({
                    blockedReason: 'review reuse blocked because the persisted classification evidence is invalid: '
                        + (error instanceof Error ? error.message : String(error)),
                    failClosed: true
                });
            }
            let authenticatedAuthority: ReviewRemediationReviewContractValidationAuthority | null = null;
            if (authoritativeClassification !== undefined) {
                if (!isPlainRecord(authoritativeClassification) || !preflightPayload) {
                    return emptyPersistedRemediationReusePolicy({
                        blockedReason:
                            'review reuse blocked because the persisted authoritative remediation classification is invalid',
                        failClosed: true
                    });
                }
            }
            const recordedLaneDecision = Array.isArray(authoritativeDecision.lane_decisions)
                ? authoritativeDecision.lane_decisions.find((entry) => (
                    isPlainRecord(entry)
                    && String(entry.review_type || '').trim().toLowerCase() === options.reviewType
                ))
                : undefined;
            if (!isPlainRecord(recordedLaneDecision)) {
                return emptyPersistedRemediationReusePolicy({
                    blockedReason:
                        `review reuse blocked because the persisted authoritative remediation decision `
                        + `does not contain required lane '${options.reviewType}'`,
                    failClosed: true
                });
            }
            const laneDecision = resolvePersistedReviewRemediationLaneDecision(
                authoritativeClassification as ReviewRemediationDecisionClassification | undefined,
                recordedLaneDecision as unknown as ReviewRemediationLaneDecision);
            // A lane an evidence-only restart carried forward repeats in the mode of the restart that invalidated it.
            const carriedOrigin = laneDecision.reason_code === EVIDENCE_ONLY_CARRIED_LANE_REASON_CODE
                ? resolveEvidenceOnlyCarriedLaneOrigin({
                    events: options.events, restartIndex: index, taskId: options.taskId, reviewType: options.reviewType,
                    preflightSha256, reviewsRoot: path.resolve(path.dirname(options.timelinePath), '..', 'reviews')
                })
                : null;
            if (
                laneDecision.reuse_eligible !== true
                && hasAuthenticatedFreshPassAfterBoundary({
                    evidence: options.authenticatedFreshPassReviewEvidence || null,
                    boundarySequence: taskEventSequence(event),
                    authoritativeDecision: (carriedOrigin?.decision ?? authoritativeDecision) as unknown as
                        AuthoritativeReviewRemediationDecision,
                    laneMode: carriedOrigin?.lane.mode ?? laneDecision.mode
                })
            ) {
                return emptyPersistedRemediationReusePolicy();
            }
            if (authoritativeClassification !== undefined) {
                const typedDecision = authoritativeDecision as unknown as AuthoritativeReviewRemediationDecision;
                const typedClassification = authoritativeClassification as unknown as ReviewRemediationDecisionClassification;
                const recordedAuthorityLane = typedDecision.lane_decisions.find((entry) => (
                    entry.review_type === typedDecision.current_review_type
                ));
                const authorityLane = recordedAuthorityLane
                    ? resolvePersistedReviewRemediationLaneDecision(typedClassification, recordedAuthorityLane) : null;
                const keptPassedOrigin = Boolean(authorityLane && isKeptPassedRemediationOrigin(typedClassification, authorityLane));
                if (!authorityLane || (authorityLane.mode === 'REUSE' && !keptPassedOrigin)) {
                    return emptyPersistedRemediationReusePolicy({
                        blockedReason:
                            'review reuse blocked because the persisted remediation authority has no executable FULL/DELTA origin lane',
                        failClosed: true
                    });
                }
                try {
                    authenticatedAuthority = keptPassedOrigin ? buildKeptPassedOriginAuthority({
                        taskId: options.taskId,
                        reviewType: authorityLane.review_type,
                        preflightSha256,
                        fullReviewScope,
                        authoritativeDecision: typedDecision,
                        authoritativeClassification: typedClassification
                    }) : buildAuthenticatedRemediationReviewExecution({
                        taskId: options.taskId,
                        reviewType: authorityLane.review_type,
                        preflightSha256,
                        fullReviewScope,
                        authoritativeDecision: typedDecision,
                        authoritativeClassification: typedClassification,
                        persistedDecisionSha256: typedDecision.decision_sha256
                    }).validationAuthority;
                } catch (error: unknown) {
                    return emptyPersistedRemediationReusePolicy({
                            blockedReason:
                                'review reuse blocked because the persisted remediation authority failed authentication: '
                            + (error instanceof Error ? error.message : String(error)),
                        failClosed: true
                    });
                }
            }
            if (laneDecision.reuse_eligible !== true) {
                let execution = {
                    contract: null as ReviewRemediationReviewContract | null,
                    validationAuthority: null as ReviewRemediationReviewContractValidationAuthority | null
                };
                if (authoritativeClassification !== undefined && laneDecision.mode !== 'REUSE') {
                    try {
                        const executionDecision = carriedOrigin?.decision ?? authoritativeDecision;
                        execution = buildAuthenticatedRemediationReviewExecution({
                            taskId: options.taskId,
                            reviewType: options.reviewType,
                            preflightSha256,
                            fullReviewScope,
                            authoritativeDecision: executionDecision as unknown as AuthoritativeReviewRemediationDecision,
                            authoritativeClassification: carriedOrigin?.classification
                                ?? authoritativeClassification as unknown as ReviewRemediationDecisionClassification,
                            persistedDecisionSha256: String(executionDecision.decision_sha256 || '')
                        });
                    } catch (error: unknown) {
                        return emptyPersistedRemediationReusePolicy({
                            blockedReason:
                                'review reuse blocked because the persisted lane execution failed authentication: '
                                + (error instanceof Error ? error.message : String(error)),
                            failClosed: true
                        });
                    }
                }
                return emptyPersistedRemediationReusePolicy({
                    blockedReason: String(laneDecision.reason || '').trim()
                        || `review reuse blocked by authoritative remediation lane '${options.reviewType}'`,
                    reviewExecutionContract: execution.contract,
                    reviewExecutionValidationAuthority: execution.validationAuthority
                });
            }
            if (authoritativeClassification !== undefined && laneDecision.mode === 'REUSE') {
                return emptyPersistedRemediationReusePolicy({
                    preservedScopeMismatchReason: String(laneDecision.reason || '').trim(),
                    remediationFixBaseTreeStateSha256s: resolveFixPreservedTreeStateSha256s(authenticatedAuthority
                        ? { ...authenticatedAuthority, reviewType: options.reviewType } : null),
                    persistedRemediationReuseRequired: true
                });
            }
            let execution = {
                contract: null as ReviewRemediationReviewContract | null,
                validationAuthority: null as ReviewRemediationReviewContractValidationAuthority | null
            };
            if (authoritativeClassification !== undefined) {
                try {
                    execution = buildAuthenticatedRemediationReviewExecution({
                        taskId: options.taskId,
                        reviewType: options.reviewType,
                        preflightSha256,
                        fullReviewScope,
                        authoritativeDecision: authoritativeDecision as unknown as AuthoritativeReviewRemediationDecision,
                        authoritativeClassification:
                            authoritativeClassification as unknown as ReviewRemediationDecisionClassification,
                        persistedDecisionSha256: String(authoritativeDecision.decision_sha256 || '')
                    });
                } catch (error: unknown) {
                    return emptyPersistedRemediationReusePolicy({
                        blockedReason:
                            'review reuse blocked because the persisted lane execution failed authentication: '
                            + (error instanceof Error ? error.message : String(error)),
                        failClosed: true
                    });
                }
            }
            // A restart recorded before lanes were carried forward can still name such a lane as preserved.
            const releasedUnpassedLane = authoritativeClassification !== undefined
                && collectUnpassedRestartInvalidatedReviewTypes({
                    reviewsRoot: path.resolve(path.dirname(options.timelinePath), '..', 'reviews'),
                    taskId: options.taskId,
                    requiredReviewTypes: [options.reviewType]
                }).length > 0;
            return emptyPersistedRemediationReusePolicy({
                blockedReason: releasedUnpassedLane
                    ? `review reuse blocked because an earlier restart invalidated '${options.reviewType}' and it has not passed since`
                    : '',
                preservedScopeMismatchReason: String(laneDecision.reason || '').trim(),
                acceptsPreservedCurrentPassContract: !releasedUnpassedLane
                    && authoritativeClassification !== undefined
                    && laneDecision.mode === 'FULL'
                    && laneDecision.reuse_eligible === true
                    && laneDecision.invalidated === false
                    && laneDecision.satisfied === false
                    && laneDecision.reason_code === 'authoritative_reuse_pending',
                reviewExecutionContract: execution.contract,
                reviewExecutionValidationAuthority: execution.validationAuthority
            });
        }
        const category = String(details.remediation_category || '').trim() || 'unknown';
        const invalidatedReviewTypes = new Set(
            Array.isArray(details.invalidated_review_types)
                ? details.invalidated_review_types
                    .map((entry) => String(entry || '').trim().toLowerCase())
                    .filter(Boolean)
                : []
        );
        if (invalidatedReviewTypes.has(options.reviewType)) {
            if (hasAuthenticatedFreshPassAfterBoundary({
                evidence: options.authenticatedFreshPassReviewEvidence || null,
                boundarySequence: taskEventSequence(event),
            })) {
                    return emptyPersistedRemediationReusePolicy();
                }
            return emptyPersistedRemediationReusePolicy({
                blockedReason:
                    `review reuse blocked by persisted remediation classification '${category}' ` +
                    `for invalidated review type '${options.reviewType}'`,
            });
        }
        return emptyPersistedRemediationReusePolicy({
            blockedReason: '',
            preservedScopeMismatchReason:
                `persisted remediation classification '${category}' preserved review type '${options.reviewType}'`
        });
    }
    return emptyPersistedRemediationReusePolicy();
}

export function shouldAcceptCurrentPassReviewEvidence(
    evidence: { accepted: boolean; reusedExistingReview: boolean } | null,
    reviewReuseBlockedReason: string
): boolean {
    return evidence?.accepted === true
        && (!reviewReuseBlockedReason || evidence.reusedExistingReview === false);
}

function reviewContextMatchesExecutionContract(
    reviewContextPath: string,
    contract: ReviewRemediationReviewContract | null | undefined
): boolean {
    if (!contract) {
        return true;
    }
    try {
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewExecution = isPlainRecord(reviewContext.review_execution)
            ? reviewContext.review_execution
            : null;
        return String(reviewExecution?.contract_sha256 || '').trim().toLowerCase()
            === contract.contract_sha256;
    } catch {
        return false;
    }
}

export async function runBuildReviewContextCommand(
    options: BuildReviewContextCommandOptions
): Promise<BuildReviewContextCommandResult> {
    const {
        repoRoot,
        reviewType,
        depth,
        preflightPath,
        preflightPayload,
        taskModePath,
        taskId,
        taskModeEvidence,
        runtimeReviewerIdentity,
        timelinePath,
        timelineSummary,
        tokenEconomyConfigPath,
        outputPath,
        scopedDiffMetadataPath,
        focusedRequiredTestPath,
        reviewReuseBlockedReason,
        reviewExecutionContract,
        reviewExecutionValidationAuthority,
        persistedRemediationReuseRequired
    } = resolveBuildReviewContextCommandInputs(options);
    if (taskModeEvidence?.profile_policy_snapshot)
        assertFreshReviewPolicyInputs(joinOrchestratorPath(repoRoot, ''), taskModeEvidence.profile_policy_snapshot);
    if ((reviewExecutionContract === null) !== (reviewExecutionValidationAuthority === null)) {
        throw new Error('Review execution contract and validation authority must be supplied together.');
    }
    const explicitReviewExecutionViolations = reviewExecutionContract && reviewExecutionValidationAuthority
        ? getReviewRemediationReviewContractViolations(
            reviewExecutionContract,
            reviewExecutionValidationAuthority
        )
        : [];
    if (explicitReviewExecutionViolations.length > 0) {
        throw new Error(
            `Explicit remediation review execution authority is invalid: `
            + explicitReviewExecutionViolations.join(' ')
        );
    }
    const reuseAuthority = options.reviewReuseAuthority;
    if (reuseAuthority) {
        const violations = getReviewRemediationReviewContractViolations(reuseAuthority.contract, reuseAuthority.validationAuthority);
        const canonicalScope = (values: readonly unknown[]): string => JSON.stringify(values.map(value => String(value).replace(/\\/gu, '/')).sort());
        if (violations.length > 0 || reuseAuthority.validationAuthority.taskId !== taskId
            || reuseAuthority.validationAuthority.reviewType !== reviewType
            || reuseAuthority.validationAuthority.preflightSha256 !== fileSha256(preflightPath)
            || canonicalScope(reuseAuthority.validationAuthority.fullReviewScope)
                !== canonicalScope(Array.isArray(preflightPayload.changed_files) ? preflightPayload.changed_files : [])) {
            throw new Error('Explicit review reuse authority is invalid: ' + violations.join(' '));
        }
    }
    const explicitLaneDecision = (reuseAuthority?.validationAuthority || reviewExecutionValidationAuthority)?.authoritativeDecision?.lane_decisions
        .find((entry) => entry.review_type === reviewType) || null;
    let persistedRemediationReusePolicy = emptyPersistedRemediationReusePolicy();
    let currentPassReviewEvidence = null as ReturnType<typeof tryAcceptCurrentPassReviewEvidence> | null;
    if (taskId) {
        assertReviewLifecycleGuardFromEntries(
            String(timelinePath),
            timelineSummary?.events || [],
            timelineSummary?.hasInvalidLines === true,
            'build-review-context',
            'review_phase'
        );
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: timelineSummary?.events || [],
            taskModePath,
            runtimeReviewerIdentity
        });
        currentPassReviewEvidence = tryAcceptCurrentPassReviewEvidence({
            repoRoot,
            taskId,
            reviewType,
            preflightPath,
            preflightPayload,
            reviewContextPath: outputPath,
            timelineEventsSummary: timelineSummary
        });
        if (timelineSummary) {
            const authenticatedFreshPassReviewEvidence = currentPassReviewEvidence.accepted
                && currentPassReviewEvidence.reusedExistingReview === false
                && currentPassReviewEvidence.reviewRecordedSequence !== null
                ? {
                    reviewRecordedSequence: currentPassReviewEvidence.reviewRecordedSequence,
                    remediationMode: currentPassReviewEvidence.remediationMode,
                    authoritativeDecisionSha256:
                        currentPassReviewEvidence.remediationAuthoritativeDecisionSha256,
                    classificationSha256: currentPassReviewEvidence.remediationClassificationSha256
                }
                : null;
            persistedRemediationReusePolicy = resolvePersistedRemediationReusePolicy({
                events: timelineSummary.events as unknown as Record<string, unknown>[],
                taskId,
                reviewType,
                preflightPath,
                timelinePath: String(timelinePath),
                preflightPayload,
                authenticatedFreshPassReviewEvidence
            });
        }
    }
    const effectiveReviewExecutionContract = reviewExecutionContract
        || persistedRemediationReusePolicy.reviewExecutionContract;
    const effectiveReviewExecutionValidationAuthority = reviewExecutionValidationAuthority
        || persistedRemediationReusePolicy.reviewExecutionValidationAuthority;
    if (persistedRemediationReusePolicy.failClosed) {
        throw new Error(persistedRemediationReusePolicy.blockedReason);
    }
    const effectiveReviewReuseBlockedReason = reviewReuseBlockedReason
        || (explicitLaneDecision?.reuse_eligible === false
            ? explicitLaneDecision.reason
            : '')
        || persistedRemediationReusePolicy.blockedReason;
    const effectiveRemediationPreservedScopeMismatchReason =
        (explicitLaneDecision?.reuse_eligible === true
            ? explicitLaneDecision.reason
            : '')
        || persistedRemediationReusePolicy.preservedScopeMismatchReason;
    const effectivePersistedRemediationReuseRequired = persistedRemediationReuseRequired
        || persistedRemediationReusePolicy.persistedRemediationReuseRequired;
    let previousReviewContextReuseSha256: string | null = null;
    let previousReviewContextText: string | null = null;
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).isFile()) {
        try {
            previousReviewContextText = fs.readFileSync(outputPath, 'utf8');
            previousReviewContextReuseSha256 = computeReviewContextReuseHash(
                JSON.parse(previousReviewContextText) as Record<string, unknown>
            );
        } catch {
            previousReviewContextText = null;
            previousReviewContextReuseSha256 = null;
        }
    }
    const currentPassReviewEvidenceAccepted = shouldAcceptCurrentPassReviewEvidence(
        currentPassReviewEvidence,
        effectiveReviewReuseBlockedReason
    ) && reviewContextMatchesExecutionContract(
        currentPassReviewEvidence?.reviewContextPath || outputPath,
        reviewExecutionContract
            || (persistedRemediationReusePolicy.acceptsPreservedCurrentPassContract
                ? undefined
                : effectiveReviewExecutionContract)
    );
    if (currentPassReviewEvidenceAccepted && currentPassReviewEvidence) {
        await emitCurrentPassReviewContextReuseAccepted({
            repoRoot,
            taskId,
            reviewType,
            depth,
            preflightPath,
            reviewContextPath: currentPassReviewEvidence.reviewContextPath,
            ruleContextArtifactPath: currentPassReviewEvidence.ruleContextArtifactPath,
            currentPassReviewEvidence,
            telemetryLockTimeoutMs: options.telemetryLockTimeoutMs,
            telemetryLockRetryMs: options.telemetryLockRetryMs
        });
        const persistedQualityCommandResult = buildAcceptedCurrentPassReviewContextCommandResult({
            reviewType,
            reviewContextPath: currentPassReviewEvidence.reviewContextPath,
            ruleContextArtifactPath: currentPassReviewEvidence.ruleContextArtifactPath,
            tokenEconomyActive: currentPassReviewEvidence.tokenEconomyActive === true,
            reusedExistingReview: currentPassReviewEvidence.reusedExistingReview,
            receiptPath: currentPassReviewEvidence.receiptPath,
            reviewerExecutionMode: currentPassReviewEvidence.reviewerExecutionMode,
            reviewerIdentity: currentPassReviewEvidence.reviewerIdentity,
            reason: currentPassReviewEvidence.reason
        });
        return persistedQualityCommandResult;
    }
    const result = buildReviewContext({
        reviewType,
        depth,
        preflightPath,
        preflightPayload,
        taskModePath: taskModePath || null,
        taskModeEvidence,
        runtimeReviewerIdentity,
        tokenEconomyConfigPath,
        tokenEconomyConfigData: options.tokenEconomyConfigData || null,
        scopedDiffMetadataPath,
        outputPath,
        repoRoot,
        focusedRequiredTestPath,
        ruleContextSectionsCache: options.ruleContextSectionsCache || null,
        ruleFileContentCache: options.ruleFileContentCache || null,
        reviewExecutionContract: effectiveReviewExecutionContract,
        reviewExecutionValidationAuthority: effectiveReviewExecutionValidationAuthority
    });
    let reviewReuseResult: ReviewReuseResult = {
        reused: false,
        receiptPath: null,
        reviewerExecutionMode: null,
        reviewerIdentity: null,
        reason: 'reuse check not run'
    };

    if (taskId) {
        await emitGeneratedReviewContextPreparationTelemetry({
            repoRoot,
            taskId,
            reviewType,
            depth,
            preflightPath,
            outputPath: result.output_path,
            ruleContextArtifactPath: result.rule_context.artifact_path,
            selectedSkill: result.rule_context.selected_skill,
            telemetryLockTimeoutMs: options.telemetryLockTimeoutMs,
            telemetryLockRetryMs: options.telemetryLockRetryMs
        });

        const preservationAuthority = reuseAuthority?.validationAuthority || effectiveReviewExecutionValidationAuthority;
        try {
            reviewReuseResult = effectiveReviewReuseBlockedReason
                ? {
                    reused: false,
                    receiptPath: null,
                    reviewerExecutionMode: null,
                    reviewerIdentity: null,
                    reason: effectiveReviewReuseBlockedReason
                }
                : await tryReuseReviewEvidence({
                    repoRoot,
                    taskId,
                    reviewType,
                    preflightPath,
                    preflightPayload,
                    reviewContextPath: outputPath,
                    previousReviewContextReuseSha256,
                    previousReviewContextText,
                    timelineEventsSummary: timelineSummary,
                    remediationPreservedScopeMismatchReason:
                        effectiveRemediationPreservedScopeMismatchReason || null,
                    remediationFixBaseTreeStateSha256s: preservationAuthority
                        ? resolveFixPreservedTreeStateSha256s(preservationAuthority)
                        : persistedRemediationReusePolicy.remediationFixBaseTreeStateSha256s ?? []
                });
        } catch (error: unknown) {
            reviewReuseResult = {
                reused: false,
                receiptPath: null,
                reviewerExecutionMode: null,
                reviewerIdentity: null,
                reason: `review reuse check failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    if (effectivePersistedRemediationReuseRequired && !reviewReuseResult.reused) {
        throw new Error(
            `Persisted authoritative remediation decision requires accepted current-cycle reused evidence `
            + `for '${reviewType}', but that evidence is missing, stale, or forged. `
            + `Reuse validation: ${reviewReuseResult.reason}`
        );
    }

    const persistedQualityCommandResult = buildGeneratedReviewContextCommandResult({
        reviewType,
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        tokenEconomyActive: result.token_economy_active,
        reviewReuseResult,
        currentPassReviewEvidenceAccepted,
        currentPassReviewEvidenceReason:
            effectiveReviewReuseBlockedReason
            || currentPassReviewEvidence?.reason
            || 'current PASS reuse check not run'
    });
    return persistedQualityCommandResult;
}
