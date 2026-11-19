import { countNextStepWork, describeProcessInputs } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { cloneFrozenJson, cloneJson } from '../../core/immutable-json';
import { readInvocationFileContent } from '../../core/invocation-file-observation';
import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { readInvocationVerifiedTaskEventTimeline, type InvocationVerifiedTaskEventTimeline } from '../../gate-runtime/timeline/task-events-integrity';
import * as path from 'node:path';

import { parseJsonText, readJsonFile } from '../../core/json';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import type {
    ReviewRemediationReviewContract,
    ReviewRemediationReviewContractValidationAuthority
} from './review-remediation-review-contract';
import { buildReviewRemediationReviewContract, getReviewRemediationReviewContractViolations,
    resolveFixPreservedTreeStateSha256s, reviewEvidenceRequiresFindingsValidation } from './review-remediation-review-contract';
import { getPreservedReviewPassViolation } from './review-remediation-preserved-verdict';
import { EVIDENCE_ONLY_CARRIED_LANE_REASON_CODE, getAuthoritativeReviewRemediationDecisionViolations, resolvePersistedReviewRemediationLaneDecision,
    type ReviewRemediationLaneDecision, type ReviewRemediationDecisionClassification } from './review-remediation-recovery-routing';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import { pathsEqual } from '../review-reuse/review-reuse-telemetry-normalization';
import { fileSha256 } from '../shared/helpers';
import { readRestartReviewClassification } from './review-remediation-classification-evidence';

interface PersistedRemediationReviewExecutionAuthorityOptions {
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    preflightPath?: string;
    fullReviewScope: readonly string[];
    reviewExecution: ReviewRemediationReviewContract;
    reviewContextPath?: string;
    receiptPath?: string;
    /**
     * Set only by the current PASS reuse step, which is what records the replacement telemetry:
     * a preserved lane still needs fresh authenticated REVIEW_RECORDED evidence after the newest
     * restart. Only the subsequent reuse-accepted telemetry may be absent at this step.
     */
    acceptPreservedPendingReuse?: boolean;
    /** Materialization-only: validate an unchanged FULL origin before writing new-cycle reuse telemetry. */
    acceptPreservedOriginReuse?: boolean;
}

function normalizeSha256(value: unknown): string {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : '';
}

function taskEventSequence(event: Readonly<Record<string, unknown>>): number {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
    const sequence = Number(integrity?.task_sequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : 0;
}

function readJsonRecord(filePath: string): Readonly<Record<string, unknown>> | null {
    try {
        const content = readInvocationFileContent(filePath);
        let value: unknown;
        if (!content) value = readJsonFile(filePath);
        else {
            // Preserve the original unbounded UTF-8 reader for the rare oversized input.
            const bytes = content.size <= 128 * 1024 * 1024 ? content.copyBytes() : fs.readFileSync(filePath);
            if (content.size > 128 * 1024 * 1024
                && createHash('sha256').update(bytes).digest('hex') !== content.sha256) {
                throw new Error('Remediation authority JSON changed after its invocation observation: ' + filePath);
            }
            value = parseJsonText(bytes.toString('utf8'), filePath);
        }
        return isPlainRecord(value) ? value : null;
    } catch {
        return null;
    }
}

function hasAuthenticatedFreshCurrentPassReplacement(options: {
    events: readonly { readonly event: Readonly<Record<string, unknown>> }[];
    restartIndex: number;
    restartSequence: number;
    authorityOptions: PersistedRemediationReviewExecutionAuthorityOptions;
    acceptRecordedOnly?: boolean;
    preservedOriginVerified?: boolean;
}): boolean {
    const authorityOptions = options.authorityOptions;
    const reviewContextPath = authorityOptions.reviewContextPath || '';
    const receiptPath = authorityOptions.receiptPath || '';
    const preflightPath = authorityOptions.preflightPath || '';
    if (!reviewContextPath || !receiptPath || !preflightPath || !/-receipt\.json$/u.test(receiptPath)) {
        return false;
    }
    const reviewArtifactPath = receiptPath.replace(/-receipt\.json$/u, '.md');
    const findingsValidationArtifactPath = reviewArtifactPath.replace(/\.md$/u, '-findings-validation.json');
    const findingsDispositionArtifactPath = reviewArtifactPath.replace(/\.md$/u, '-findings-disposition.json');
    const receipt = readJsonRecord(receiptPath);
    const reviewContext = readJsonRecord(reviewContextPath);
    if (!receipt || !reviewContext) {
        return false;
    }
    const findingsValidationRequired = reviewEvidenceRequiresFindingsValidation(receipt, reviewContext);
    const currentHashes = {
        reviewContext: fileSha256(reviewContextPath),
        receipt: fileSha256(receiptPath),
        reviewArtifact: fileSha256(reviewArtifactPath),
        findingsValidation: findingsValidationRequired
            ? fileSha256(findingsValidationArtifactPath)
            : null,
        findingsDisposition: findingsValidationRequired
            ? fileSha256(findingsDispositionArtifactPath)
            : null
    };
    if (
        !normalizeSha256(currentHashes.reviewContext)
        || !normalizeSha256(currentHashes.receipt)
        || !normalizeSha256(currentHashes.reviewArtifact)
        || (findingsValidationRequired && (
            !normalizeSha256(currentHashes.findingsValidation)
            || !normalizeSha256(currentHashes.findingsDisposition)
        ))
    ) {
        return false;
    }
    const normalizedPreflightSha256 = normalizeSha256(authorityOptions.preflightSha256);
    const normalizedDecisionSha256 = normalizeSha256(
        authorityOptions.reviewExecution.authoritative_decision_sha256
    );
    const normalizedClassificationSha256 = normalizeSha256(
        authorityOptions.reviewExecution.classification_sha256
    );
    function matchesRecordedEvidence(reviewRecordedEvent: Readonly<Record<string, unknown>> | undefined): boolean {
        const reviewRecordedDetails = isPlainRecord(reviewRecordedEvent?.details)
            ? reviewRecordedEvent.details
            : null;
        return reviewRecordedEvent?.event_type === 'REVIEW_RECORDED'
            && reviewRecordedEvent.actor === 'gate'
            && reviewRecordedEvent.outcome === 'PASS'
            && reviewRecordedDetails?.review_type === authorityOptions.reviewType
            && normalizeSha256(reviewRecordedDetails.preflight_sha256) === normalizedPreflightSha256
            && pathsEqual(String(reviewRecordedDetails.review_context_path || ''), reviewContextPath)
            && normalizeSha256(reviewRecordedDetails.review_context_sha256) === currentHashes.reviewContext
            && pathsEqual(String(reviewRecordedDetails.receipt_path || ''), receiptPath)
            && normalizeSha256(reviewRecordedDetails.receipt_sha256) === currentHashes.receipt
            && pathsEqual(String(reviewRecordedDetails.review_artifact_path || ''), reviewArtifactPath)
            && normalizeSha256(
                reviewRecordedDetails.review_artifact_sha256
                || reviewRecordedDetails.review_artifact_snapshot_sha256
            ) === currentHashes.reviewArtifact;
    }
    const reviewRecordedEventsBySequence = new Map<number, Readonly<Record<string, unknown>>>();
    for (let eventIndex = options.restartIndex + 1; eventIndex < options.events.length; eventIndex += 1) {
        countNextStepWork('visit:remediation_query_event');
        const event = options.events[eventIndex].event;
        const details = isPlainRecord(event.details) ? event.details : null;
        const acceptedSequence = taskEventSequence(event);
        if (event.event_type === 'REVIEW_RECORDED' && acceptedSequence > options.restartSequence) {
            reviewRecordedEventsBySequence.set(acceptedSequence, event);
            if (options.acceptRecordedOnly === true && matchesRecordedEvidence(event)) return true;
            continue;
        }
        const reviewRecordedSequence = Number(details?.review_recorded_sequence);
        const reviewRecordedEventSha256 = normalizeSha256(details?.review_recorded_event_sha256);
        const recordedFindingsValidationPath = String(details?.findings_validation_artifact_path || '');
        const recordedFindingsValidationSha256 = normalizeSha256(
            details?.findings_validation_artifact_sha256
        );
        const recordedFindingsDispositionPath = String(details?.findings_disposition_artifact_path || '');
        const recordedFindingsDispositionSha256 = normalizeSha256(
            details?.findings_disposition_artifact_sha256
        );
        const findingsArtifactsMatch = findingsValidationRequired
            ? pathsEqual(recordedFindingsValidationPath, findingsValidationArtifactPath)
                && recordedFindingsValidationSha256
                    === normalizeSha256(currentHashes.findingsValidation)
                && pathsEqual(recordedFindingsDispositionPath, findingsDispositionArtifactPath)
                && recordedFindingsDispositionSha256
                    === normalizeSha256(currentHashes.findingsDisposition)
            : !recordedFindingsValidationPath
                && !recordedFindingsValidationSha256
                && !recordedFindingsDispositionPath
                && !recordedFindingsDispositionSha256;
        const preservedCarryForward = options.preservedOriginVerified === true
            && details?.preserved_current_pass_origin === true
            && reviewRecordedSequence <= options.restartSequence;
        if (
            event.event_type !== 'REVIEW_CONTEXT_REUSE_ACCEPTED'
            || event.actor !== 'gate'
            || event.outcome !== 'PASS'
            || !details
            || acceptedSequence <= options.restartSequence
            || !Number.isInteger(reviewRecordedSequence)
            || (reviewRecordedSequence <= options.restartSequence && !preservedCarryForward)
            || reviewRecordedSequence >= acceptedSequence
            || !reviewRecordedEventSha256
            || details.current_pass_review_evidence !== true
            || details.findings_validation_required !== findingsValidationRequired
            || details.review_reuse_evidence !== 'FRESH'
            || details.reused_existing_review !== false
            || details.remediation_authority_eligible !== true
            || details.review_type !== authorityOptions.reviewType
            || details.remediation_mode !== authorityOptions.reviewExecution.mode
            || normalizeSha256(details.remediation_authoritative_decision_sha256) !== normalizedDecisionSha256
            || normalizeSha256(details.remediation_classification_sha256) !== normalizedClassificationSha256
            || !pathsEqual(String(details.preflight_path || ''), preflightPath)
            || normalizeSha256(details.preflight_sha256) !== normalizedPreflightSha256
            || !pathsEqual(String(details.review_context_path || details.output_path || ''), reviewContextPath)
            || normalizeSha256(details.review_context_sha256) !== currentHashes.reviewContext
            || !pathsEqual(String(details.receipt_path || ''), receiptPath)
            || normalizeSha256(details.receipt_sha256) !== currentHashes.receipt
            || !pathsEqual(String(details.review_artifact_path || ''), reviewArtifactPath)
            || normalizeSha256(details.review_artifact_sha256) !== currentHashes.reviewArtifact
            || !findingsArtifactsMatch
        ) {
            continue;
        }
        const reviewRecordedEvent = reviewRecordedEventsBySequence.get(reviewRecordedSequence)
            || (preservedCarryForward
                ? options.events.find(entry => taskEventSequence(entry.event) === reviewRecordedSequence)?.event : undefined);
        const reviewRecordedIntegrity = isPlainRecord(reviewRecordedEvent?.integrity) ? reviewRecordedEvent.integrity : null;
        if (normalizeSha256(reviewRecordedIntegrity?.event_sha256) === reviewRecordedEventSha256
            && matchesRecordedEvidence(reviewRecordedEvent)) {
            return true;
        }
    }
    return false;
}

function buildAuthority(
    options: PersistedRemediationReviewExecutionAuthorityOptions,
    decision: Record<string, unknown>,
    classification: ReviewRemediationDecisionClassification,
    acceptedCurrentPassReplacement = false
): ReviewRemediationReviewContractValidationAuthority {
    const decisionSha256 = normalizeSha256(decision.decision_sha256);
    return {
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.preflightSha256.trim().toLowerCase(),
        mode: options.reviewExecution.mode,
        fullReviewScope: options.fullReviewScope,
        persistedDecisionSha256: decisionSha256,
        authoritativeDecisionSha256: decisionSha256,
        authoritativeClassificationSha256: normalizeSha256(decision.classification_sha256),
        authoritativeDecision: decision as unknown as ReviewRemediationReviewContractValidationAuthority['authoritativeDecision'],
        authoritativeClassification: classification,
        acceptedCurrentPassReplacement
    };
}

/** Keep the accepted DELTA contract as historical work; a separate current decision proves that this fix preserves it. */
export function resolvePreservedDeltaReviewExecutionAuthority(
    options: PersistedRemediationReviewExecutionAuthorityOptions & {
        preservingAuthority: ReviewRemediationReviewContractValidationAuthority;
    }
): ReviewRemediationReviewContractValidationAuthority | null {
    if (!isInvocationReadObservationActive()) return derivePreservedDeltaReviewExecutionAuthority(options);
    const timelinePath = path.join(path.dirname(options.reviewsRoot), 'task-events', options.taskId + '.jsonl');
    const verified = readInvocationVerifiedTaskEventTimeline(timelinePath, options.taskId);
    // Share the invocation's authenticated, mutation-observed snapshot, as the persisted authority reader does.
    // Outside that boundary the full native inspection above remains mandatory.
    return derivePreservedDeltaReviewExecutionAuthority(options, verified ?? undefined);
}

type ExecutionTimeline = {
    result: Pick<InvocationVerifiedTaskEventTimeline['result'], 'status'>;
    events: readonly { readonly event: Readonly<Record<string, unknown>> }[];
};

function derivePreservedDeltaReviewExecutionAuthority(
    options: PersistedRemediationReviewExecutionAuthorityOptions & {
        preservingAuthority: ReviewRemediationReviewContractValidationAuthority;
    },
    verified?: ExecutionTimeline
): ReviewRemediationReviewContractValidationAuthority | null {
    const refuse = (reason: string): null => { countNextStepWork('reuse:preserved_delta_rejected:' + reason); return null; };
    try {
        const execution = options.reviewExecution;
        const preserving = options.preservingAuthority;
        const decision = preserving.authoritativeDecision;
        const classification = preserving.authoritativeClassification;
        const lane = decision?.lane_decisions.find(entry => entry.review_type === options.reviewType);
        if (execution.mode !== 'DELTA' || execution.source !== 'remediation_delta'
            || execution.task_id !== options.taskId || execution.review_type !== options.reviewType
            || execution.preflight_sha256 === options.preflightSha256
            || preserving.taskId !== options.taskId || preserving.preflightSha256 !== options.preflightSha256
            || !decision || !classification || classification.source !== 'delta'
            || !lane || lane.invalidated || !lane.reuse_eligible) return null;
        countNextStepWork('reuse:preserved_delta_attempt');
        // Validate the actual failed lane, including its baseline, policy, fix scope and the whole READY decision.
        const owner = String(decision.current_review_type);
        const ownerScope = classification.delta.scope.full_review_scope;
        const ownerExecution = buildReviewRemediationReviewContract({ taskId: options.taskId, reviewType: owner,
            preflightSha256: options.preflightSha256, fullReviewScope: ownerScope, authoritativeDecision: decision, classification });
        const ownerAuthority = { ...preserving, reviewType: owner, mode: ownerExecution.mode, fullReviewScope: ownerScope };
        if (getReviewRemediationReviewContractViolations(ownerExecution, ownerAuthority).length) return refuse('preserving_authority');
        const delivered: Array<{ event: Readonly<Record<string, unknown>> }> = [];
        const inspection = verified?.result ?? inspectTaskEventFile(path.join(path.dirname(options.reviewsRoot),
            'task-events', options.taskId + '.jsonl'), options.taskId, {
            onIntegrityEvent: event => delivered.push({ event })
        });
        const events = verified?.events ?? delivered;
        if (!inspection.status.startsWith('PASS') || !options.receiptPath || !options.reviewContextPath) return refuse('timeline');
        const receipt = readJsonRecord(options.receiptPath);
        const receiptHash = fileSha256(options.receiptPath);
        if (!receipt || receipt.task_id !== options.taskId || receipt.review_type !== options.reviewType
            || receipt.review_execution_mode !== 'DELTA'
            || receipt.review_execution_contract_sha256 !== execution.contract_sha256
            || !receiptHash || !events.some(({ event }) => {
                const details = isPlainRecord(event.details) ? event.details : null;
                return event.event_type === 'REVIEW_RECORDED' && event.actor === 'gate' && event.outcome === 'PASS'
                    && details?.review_type === options.reviewType && details.receipt_sha256 === receiptHash
                    && pathsEqual(String(details.receipt_path || ''), options.receiptPath!);
            })) return refuse('unsigned_receipt');
        const artifactPath = options.receiptPath.replace(/-receipt\.json$/u, '.md');
        if (artifactPath === options.receiptPath || fileSha256(artifactPath) !== receipt.review_artifact_sha256) return refuse('artifact');
        const reviewContext = readJsonRecord(options.reviewContextPath);
        if (!reviewContext || getPreservedReviewPassViolation({ taskId: options.taskId, reviewType: options.reviewType,
            receipt, reviewContext, reviewArtifactPath: artifactPath })) return refuse('verdict');
        const originTree = String(receipt.reused_existing_review === true
            ? receipt.reused_from_review_tree_state_sha256 : receipt.review_tree_state_sha256);
        if (!resolveFixPreservedTreeStateSha256s({ ...preserving, reviewType: options.reviewType }).includes(originTree)) return refuse('preserved_tree');
        const origin = derivePersistedRemediationReviewExecutionAuthority({ ...options,
            preflightSha256: execution.preflight_sha256, fullReviewScope: execution.full_review_scope }, { result: inspection, events });
        if (!origin || getReviewRemediationReviewContractViolations(execution, origin).length) return refuse('origin_authority');
        return { ...origin, preserved_current_scope: {
            current_preflight_sha256: options.preflightSha256,
            preserving_decision_sha256: decision.decision_sha256,
            preserving_classification_sha256: decision.classification_sha256
        } };
    } catch { return refuse('exception'); }
}

const RESTART_CHAIN_BOUNDARY_EVENT_TYPES = new Set([
    'TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'COMPILE_GATE_FAILED'
]);

export interface AuthenticatedRestartLane {
    index: number;
    decision: Record<string, unknown>;
    classification: ReviewRemediationDecisionClassification;
    lane: ReviewRemediationLaneDecision;
}

/** A restart of the current preflight with a valid READY decision, its readable classification and one lane. */
function readAuthenticatedRestartLane(options: {
    event: Readonly<Record<string, unknown>>;
    index: number;
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    reviewsRoot: string;
}): AuthenticatedRestartLane | null {
    const event = options.event;
    const details = isPlainRecord(event.details) ? event.details : null;
    const preflightSha256 = normalizeSha256(options.preflightSha256);
    if (event.event_type !== 'REVIEW_CYCLE_RESTARTED' || event.outcome !== 'PASS' || !details
        || details.task_id !== options.taskId || details.event_type !== 'REVIEW_CYCLE_RESTARTED' || details.status !== 'PASSED'
        || !preflightSha256 || normalizeSha256(details.preflight_sha256) !== preflightSha256) return null;
    const decision = isPlainRecord(details.authoritative_review_decision) ? details.authoritative_review_decision : null;
    if (!decision || decision.status !== 'READY' || normalizeSha256(decision.preflight_sha256) !== preflightSha256
        || getAuthoritativeReviewRemediationDecisionViolations(decision, { expectedTaskId: options.taskId }).length > 0) return null;
    let classification: unknown;
    try {
        classification = readRestartReviewClassification({ reviewsRoot: options.reviewsRoot, taskId: options.taskId, details });
    } catch { return null; }
    if (!isPlainRecord(classification)) return null;
    const classificationSha256 = classification.source === 'runtime_fix' && isPlainRecord(classification.classification)
        ? sha256RedactedJsonPayload(classification.classification)
        : classification.source === 'delta' && isPlainRecord(classification.delta)
            ? normalizeSha256(classification.delta.classification_sha256) : '';
    if (!classificationSha256 || normalizeSha256(decision.classification_sha256) !== classificationSha256) return null;
    const recordedLane = Array.isArray(decision.lane_decisions)
        ? decision.lane_decisions.find((value) => isPlainRecord(value) && value.review_type === options.reviewType) : null;
    if (!isPlainRecord(recordedLane)) return null;
    const typedClassification = classification as unknown as ReviewRemediationDecisionClassification;
    return {
        index: options.index,
        decision,
        classification: typedClassification,
        lane: resolvePersistedReviewRemediationLaneDecision(typedClassification,
            recordedLane as unknown as ReviewRemediationLaneDecision)
    };
}

function isEvidenceOnlyClassification(classification: ReviewRemediationDecisionClassification): boolean {
    return classification.source === 'runtime_fix' && isPlainRecord(classification.classification)
        && classification.classification.category === 'review_evidence_only';
}

function isEvidenceOnlyCarriedLane(entry: AuthenticatedRestartLane): boolean {
    return isEvidenceOnlyClassification(entry.classification) && entry.lane.invalidated && !entry.lane.satisfied
        && entry.lane.reason_code === EVIDENCE_ONLY_CARRIED_LANE_REASON_CODE;
}

/**
 * The restart that invalidated a lane an evidence-only restart carried forward. An evidence-only restart changes
 * neither the tree nor the preflight, so the carried lane repeats in the mode and under the authority of that
 * restart. A compile, a classification, a task entry or an unreadable restart in between ends the chain (FULL).
 */
export function resolveEvidenceOnlyCarriedLaneOrigin(options: {
    events: readonly Readonly<Record<string, unknown>>[];
    restartIndex: number;
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    reviewsRoot: string;
}): AuthenticatedRestartLane | null {
    const carrying = readAuthenticatedRestartLane({ ...options, event: options.events[options.restartIndex], index: options.restartIndex });
    if (!carrying || !isEvidenceOnlyCarriedLane(carrying)) return null;
    for (let index = options.restartIndex - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:remediation_query_event');
        const event = options.events[index];
        if (RESTART_CHAIN_BOUNDARY_EVENT_TYPES.has(String(event.event_type))) return null;
        if (event.event_type !== 'REVIEW_CYCLE_RESTARTED') continue;
        const prior = readAuthenticatedRestartLane({ ...options, event, index });
        if (!prior) return null;
        if (isEvidenceOnlyCarriedLane(prior)) continue;
        return prior.lane.invalidated && !prior.lane.satisfied && (prior.lane.mode === 'FULL' || prior.lane.mode === 'DELTA')
            ? prior : null;
    }
    return null;
}

function resolvePreservedFullOrigin(
    options: PersistedRemediationReviewExecutionAuthorityOptions,
    events: readonly { readonly event: Readonly<Record<string, unknown>> }[]
): ReviewRemediationReviewContractValidationAuthority | null {
    if (options.acceptPreservedOriginReuse !== true || !['FULL', 'DELTA'].includes(options.reviewExecution.mode)) return null;
    let compilePath = '';
    let compileSha256 = '';
    let dependencyEdgesSha256 = '';
    let policySha256 = '';
    let latestRecordedSequence: number | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:remediation_query_event');
        const event = events[index].event;
        const details = isPlainRecord(event.details) ? event.details : null;
        if (RESTART_CHAIN_BOUNDARY_EVENT_TYPES.has(String(event.event_type))) return null;
        if (details?.review_type === options.reviewType) {
            if (event.event_type === 'REVIEW_RECORDED' && latestRecordedSequence === null) {
                if (event.actor !== 'gate' || event.outcome !== 'PASS') return null;
                latestRecordedSequence = taskEventSequence(event);
            }
            if (latestRecordedSequence === null && ['REVIEWER_DELEGATION_STARTED', 'REVIEWER_LAUNCH_FAILED'].includes(String(event.event_type))) return null;
        }
        if (event.event_type !== 'REVIEW_CYCLE_RESTARTED') continue;
        const restart = readAuthenticatedRestartLane({
            event, index, taskId: options.taskId, reviewType: options.reviewType,
            preflightSha256: options.preflightSha256, reviewsRoot: options.reviewsRoot
        });
        if (!restart || !details) return null;
        const { decision, classification, lane } = restart;
        const evidenceOnly = isEvidenceOnlyClassification(classification);
        // An evidence-only restart measures no fix and records the runtime fallback policy rather than the task's
        // remediation policy: only its review graph has to match the restarts around it.
        const currentDependencyEdgesSha256 = sha256RedactedJsonPayload({ dependency_edges: decision.dependency_edges });
        if (!dependencyEdgesSha256) dependencyEdgesSha256 = currentDependencyEdgesSha256;
        else if (dependencyEdgesSha256 !== currentDependencyEdgesSha256) return null;
        if (!evidenceOnly) {
            const currentPolicySha256 = sha256RedactedJsonPayload({
                profile_policy_snapshot_sha256: decision.profile_policy_snapshot_sha256,
                policy_id: decision.policy_id,
                policy_legacy_fallback: decision.policy_legacy_fallback
            });
            if (!policySha256) policySha256 = currentPolicySha256;
            else if (policySha256 !== currentPolicySha256) return null;
        }
        const currentCompilePath = String(details.compile_evidence_path || '');
        const currentCompileSha256 = normalizeSha256(details.compile_evidence_sha256);
        if (!currentCompilePath || !currentCompileSha256) return null;
        if (!compilePath) {
            compilePath = currentCompilePath;
            compileSha256 = currentCompileSha256;
            if (fileSha256(compilePath) !== compileSha256) return null;
        } else if (!pathsEqual(compilePath, currentCompilePath) || compileSha256 !== currentCompileSha256) return null;
        if (normalizeSha256(decision.decision_sha256) === normalizeSha256(options.reviewExecution.authoritative_decision_sha256)
            && normalizeSha256(decision.classification_sha256) === normalizeSha256(options.reviewExecution.classification_sha256)) {
            if (lane.mode !== options.reviewExecution.mode) return null;
            if (latestRecordedSequence === null || latestRecordedSequence <= taskEventSequence(event)) return null;
            if (!hasAuthenticatedFreshCurrentPassReplacement({
                events, restartIndex: index, restartSequence: latestRecordedSequence - 1,
                authorityOptions: options, acceptRecordedOnly: true
            })) return null;
            return buildAuthority(options, decision, classification);
        }
        // Only evidence-only restarts are crossed: one that left the lane pending, or one that carried it forward.
        if (!evidenceOnly || classification.source !== 'runtime_fix' || classification.classification.blocked_before_reuse === true
            || !Array.isArray(classification.classification.invalidated_review_types)) return null;
        if (isEvidenceOnlyCarriedLane(restart)) continue;
        if (lane.mode !== 'FULL' || lane.reuse_eligible !== true || lane.invalidated !== false || lane.satisfied !== false
            || lane.reason_code !== 'authoritative_reuse_pending') return null;
        const invalidated = new Set(classification.classification.invalidated_review_types);
        const edges = decision.dependency_edges as Array<{ review_type: string; depends_on: string[] }>;
        for (let pass = 0; pass < edges.length; pass += 1) {
            for (const edge of edges) {
                if (edge.depends_on.some(upstream => invalidated.has(upstream))) invalidated.add(edge.review_type);
            }
        }
        if (invalidated.has(options.reviewType)) return null;
    }
    return null;
}

const AUTHORITY_OBSERVATIONS = createInvocationReadMemoKey<ReviewRemediationReviewContractValidationAuthority | null>(
    'persisted-remediation-review-execution-authority'
);

export function resolvePersistedRemediationReviewExecutionAuthority(
    options: PersistedRemediationReviewExecutionAuthorityOptions
): ReviewRemediationReviewContractValidationAuthority | null {
    if (!isInvocationReadObservationActive()) {
        return derivePersistedRemediationReviewExecutionAuthority(options);
    }
    const key = describeProcessInputs(options);
    if (key.opaque) return derivePersistedRemediationReviewExecutionAuthority(options);
    if (options.reviewExecution.source === 'initial_full') {
        return memoizeInvocationRead(AUTHORITY_OBSERVATIONS, 'initial:' + key.text,
            () => derivePersistedRemediationReviewExecutionAuthority(options)).value;
    }
    const timelinePath = path.join(path.dirname(options.reviewsRoot), 'task-events', `${options.taskId}.jsonl`);
    const verified = readInvocationVerifiedTaskEventTimeline(timelinePath, options.taskId);
    if (!verified) return derivePersistedRemediationReviewExecutionAuthority(options);
    // Authenticated appends replace the snapshot digest, so they never reuse an old authority result.
    const memoKey = JSON.stringify([path.resolve(timelinePath), verified.sha256, key.text]);
    const retained = memoizeInvocationRead(AUTHORITY_OBSERVATIONS, memoKey, () => cloneFrozenJson(
        derivePersistedRemediationReviewExecutionAuthority(options, verified)
    )).value;
    return cloneJson(retained);
}

function derivePersistedRemediationReviewExecutionAuthority(
    options: PersistedRemediationReviewExecutionAuthorityOptions,
    verified?: ExecutionTimeline
): ReviewRemediationReviewContractValidationAuthority | null {
    countNextStepWork('derive:resolvePersistedRemediationReviewExecutionAuthority');
    if (options.reviewExecution.source === 'initial_full') {
        return null;
    }
    const timelinePath = path.join(
        path.dirname(options.reviewsRoot),
        'task-events',
        `${options.taskId}.jsonl`
    );
    const deliveredEvents: Array<{ event: Readonly<Record<string, unknown>> }> = [];
    const inspection = verified?.result ?? inspectTaskEventFile(timelinePath, options.taskId, {
        onIntegrityEvent: (event) => { countNextStepWork('visit:remediation_observer_event'); return deliveredEvents.push({ event }); }
    });
    const events = verified?.events ?? deliveredEvents;
    if (!inspection.status.startsWith('PASS')) {
        return null;
    }
    const normalizedPreflightSha256 = options.preflightSha256.trim().toLowerCase();
    if (options.reviewExecution.mode === 'DELTA'
        && options.reviewExecution.preflight_sha256 !== normalizedPreflightSha256) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index].event;
            const details = isPlainRecord(event.details) ? event.details : null;
            if (event.event_type !== 'REVIEW_CYCLE_RESTARTED' || details?.task_id !== options.taskId
                || normalizeSha256(details.preflight_sha256) !== normalizedPreflightSha256) continue;
            const restart = readAuthenticatedRestartLane({ event: events[index].event, index,
                taskId: options.taskId, reviewType: options.reviewType, preflightSha256: normalizedPreflightSha256,
                reviewsRoot: options.reviewsRoot });
            if (!restart) return null;
            const preservingAuthority = buildAuthority(options, restart.decision, restart.classification);
            const preserved = derivePreservedDeltaReviewExecutionAuthority({ ...options, preservingAuthority }, { result: inspection, events });
            return preserved;
        }
        return null;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        countNextStepWork('visit:remediation_query_event');
        const event = events[index].event;
        const details = isPlainRecord(event.details) ? event.details : null;
        if (
            event.event_type !== 'REVIEW_CYCLE_RESTARTED'
            || !details
            || details.task_id !== options.taskId
            || details.event_type !== 'REVIEW_CYCLE_RESTARTED'
            || details.status !== 'PASSED'
            || String(details.preflight_sha256 || '').trim().toLowerCase() !== normalizedPreflightSha256
            || !isPlainRecord(details.authoritative_review_decision)
        ) {
            continue;
        }
        const decision = details.authoritative_review_decision;
        let classification: unknown;
        try {
            classification = readRestartReviewClassification({ reviewsRoot: options.reviewsRoot, taskId: options.taskId, details });
        } catch { return null; }
        if (!isPlainRecord(classification)) continue;
        const recordedLane = Array.isArray(decision.lane_decisions)
            ? decision.lane_decisions.find((value) => (
                isPlainRecord(value) && value.review_type === options.reviewType
            ))
            : null;
        const lane = isPlainRecord(recordedLane) ? resolvePersistedReviewRemediationLaneDecision(
            classification as unknown as ReviewRemediationDecisionClassification,
            recordedLane as unknown as ReviewRemediationLaneDecision) : null;
        if (lane?.reason_code === EVIDENCE_ONLY_CARRIED_LANE_REASON_CODE
            && normalizeSha256(options.reviewExecution.authoritative_decision_sha256) !== normalizeSha256(decision.decision_sha256)) {
            const origin = resolveEvidenceOnlyCarriedLaneOrigin({
                events: events.map((entry) => entry.event), restartIndex: index, taskId: options.taskId,
                reviewType: options.reviewType, preflightSha256: normalizedPreflightSha256, reviewsRoot: options.reviewsRoot
            });
            return origin && origin.lane.mode === options.reviewExecution.mode
                && normalizeSha256(origin.decision.decision_sha256)
                    === normalizeSha256(options.reviewExecution.authoritative_decision_sha256)
                && normalizeSha256(origin.decision.classification_sha256)
                    === normalizeSha256(options.reviewExecution.classification_sha256)
                ? buildAuthority(options, origin.decision, origin.classification, hasAuthenticatedFreshCurrentPassReplacement({
                    events, restartIndex: index, restartSequence: taskEventSequence(event), authorityOptions: options
                }))
                : null;
        }
        const sameDecision = normalizeSha256(options.reviewExecution.authoritative_decision_sha256)
                === normalizeSha256(decision.decision_sha256)
            && normalizeSha256(options.reviewExecution.classification_sha256)
                === normalizeSha256(decision.classification_sha256);
        // An evidence-only restart leaves a passed lane pending in FULL whatever mode its kept review ran in.
        const evidenceOnlyPending = !sameDecision && lane?.mode === 'FULL' && lane.invalidated === false
            && lane.reason_code === 'authoritative_reuse_pending' && isPlainRecord(classification)
            && isEvidenceOnlyClassification(classification as unknown as ReviewRemediationDecisionClassification);
        if (!lane || (lane.mode !== options.reviewExecution.mode && !evidenceOnlyPending)
            || decision.preflight_sha256 !== normalizedPreflightSha256) {
            return null;
        }
        if (sameDecision) {
            return buildAuthority(
                options,
                decision,
                classification as unknown as ReviewRemediationDecisionClassification,
                hasAuthenticatedFreshCurrentPassReplacement({
                    events,
                    restartIndex: index,
                    restartSequence: taskEventSequence(event),
                    authorityOptions: options
                })
            );
        }

        const preservedPending = lane.mode === 'FULL'
            && lane.reuse_eligible === true
            && lane.invalidated === false
            && lane.satisfied === false
            && lane.reason_code === 'authoritative_reuse_pending';
        const preservedOrigin = preservedPending
            ? resolvePreservedFullOrigin({ ...options, acceptPreservedOriginReuse: true }, events) : null;
        const acceptedAfterRestart = preservedPending && hasAuthenticatedFreshCurrentPassReplacement({
            events,
            restartIndex: index,
            restartSequence: taskEventSequence(event),
            authorityOptions: options,
            acceptRecordedOnly: options.acceptPreservedPendingReuse,
            preservedOriginVerified: Boolean(preservedOrigin)
        });
        if (!acceptedAfterRestart) {
            return options.acceptPreservedOriginReuse === true ? preservedOrigin : null;
        }

        for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
            countNextStepWork('visit:remediation_query_event');
            const priorEvent = events[priorIndex].event;
            const priorDetails = isPlainRecord(priorEvent.details) ? priorEvent.details : null;
            const priorDecision = isPlainRecord(priorDetails?.authoritative_review_decision)
                ? priorDetails.authoritative_review_decision
                : null;
            const recordedPriorLane = priorDecision && Array.isArray(priorDecision.lane_decisions)
                ? priorDecision.lane_decisions.find((value) => (
                    isPlainRecord(value) && value.review_type === options.reviewType
                ))
                : null;
            if (priorEvent.event_type !== 'REVIEW_CYCLE_RESTARTED' || priorDetails?.task_id !== options.taskId
                || priorDetails.event_type !== 'REVIEW_CYCLE_RESTARTED' || priorDetails.status !== 'PASSED') continue;
            // An unreadable classification keeps the recorded lane; only the matching restart must be readable.
            let priorClassification: unknown;
            try {
                priorClassification = readRestartReviewClassification({
                    reviewsRoot: options.reviewsRoot, taskId: options.taskId, details: priorDetails
                });
            } catch { priorClassification = undefined; }
            const priorLane = isPlainRecord(recordedPriorLane) ? resolvePersistedReviewRemediationLaneDecision(
                isPlainRecord(priorClassification)
                    ? priorClassification as unknown as ReviewRemediationDecisionClassification : undefined,
                recordedPriorLane as unknown as ReviewRemediationLaneDecision) : null;
            if (
                priorEvent.event_type === 'REVIEW_CYCLE_RESTARTED'
                && priorDetails?.task_id === options.taskId
                && priorDetails.event_type === 'REVIEW_CYCLE_RESTARTED'
                && priorDetails.status === 'PASSED'
                && normalizeSha256(priorDetails.preflight_sha256) === normalizedPreflightSha256
                && priorDecision
                && isPlainRecord(priorLane)
                && priorLane.mode === options.reviewExecution.mode
                && normalizeSha256(priorDecision.decision_sha256)
                    === normalizeSha256(options.reviewExecution.authoritative_decision_sha256)
                && normalizeSha256(priorDecision.classification_sha256)
                    === normalizeSha256(options.reviewExecution.classification_sha256)
            ) {
                if (!isPlainRecord(priorClassification)) return null;
                return buildAuthority(
                    options,
                    priorDecision,
                    priorClassification as unknown as ReviewRemediationDecisionClassification
                );
            }
            // An evidence-only restart in between carried the lane forward or left it pending; it changed nothing else.
            if (isPlainRecord(priorLane) && isPlainRecord(priorClassification)
                && isEvidenceOnlyClassification(priorClassification as unknown as ReviewRemediationDecisionClassification)
                && (priorLane.reason_code === EVIDENCE_ONLY_CARRIED_LANE_REASON_CODE
                    || (priorLane.invalidated === false && priorLane.reason_code === 'authoritative_reuse_pending'))) continue;
            if (!isPlainRecord(priorLane) || priorLane.invalidated === true
                || priorLane.mode !== options.reviewExecution.mode) return null;
        }
        return null;
    }
    return null;
}
