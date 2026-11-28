import * as path from 'node:path';
import { types } from 'node:util';
import { countNextStepWork } from '../../core/next-step-measurement';
import { createInvocationReadMemoKey, memoizeInvocationRead, withInvocationReadObservation } from '../../core/invocation-read-observation';
import { cloneFrozenJson } from '../../core/immutable-json';
import { mergeFileRoleBindings } from '../../core/file-role-bindings';
import { readProjectValidationFileRoles } from '../../core/project-validation-authority';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { isPlainRecord } from '../../core/records';
import { resolveReviewExecutionPolicyModeFromPreflight } from '../../core/review-execution-policy';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { readInvocationVerifiedTaskEventTimeline, readTaskTimelineNavigationQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { navigationEventSequence, navigationLatestEvent, navigationLatestReview, navigationRawEvents } from '../../gate-runtime/timeline/task-navigation-query';
import { readTaskTimelineRouteQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { routeArtifactBindingIndices } from '../../gate-runtime/timeline/task-route-query';
import { createHash } from 'node:crypto';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import type { QualityValidationObligation } from '../quality-checklist/quality-checklist-validation-phases';
import { readImmutableValidationEventSnapshot, type ValidationEvidenceInspection } from '../project-validation/attempt-evidence';
import { computeReviewReuseCodeScopeFingerprint } from '../review-reuse/review-reuse';
import type { ReviewCoverageContract } from '../review/review-coverage-ledger';
import { getEffectiveReviewSnapshotViolations, type EffectiveReviewSnapshot } from '../../policy/effective-review-snapshot';
import { resolveTaskProfileReviewTriggerPolicy, summarizeTaskProfilePolicySnapshot, validateTaskProfilePolicySnapshot, type TaskProfilePolicySnapshot } from '../../policy/task-profile-policy-snapshot';
import { resolveReviewRemediationRerunLanes, resolveReviewRemediationRerunPolicyFromSnapshot } from '../../policy/review-remediation-rerun-policy';
import { getTaskModeEvidence } from '../task-mode/task-mode';
import { validateReviewRemediationBaselineArtifact } from './review-remediation-baseline';
import { buildReviewRemediationDeltaBase, getReviewRemediationDeltaBaseViolations, type ReviewRemediationDeltaBase } from './review-remediation-delta-contract';
import { readRestartReviewClassification } from './review-remediation-classification-evidence';
import { recheckRecordedReviewRemediationDelta, type ReviewRemediationDeltaClassification } from './review-remediation-delta';
import { getAuthoritativeReviewRemediationDecisionViolations, type AuthoritativeReviewRemediationDecision } from './review-remediation-recovery-routing';
import { getReviewRemediationDeltaClassificationViolations } from './review-remediation-validation-evidence';
import type { TestOnlyReviewPreservation, TestOnlyReviewPreservationOptions } from './test-only-review-preservation-contract';

interface PreservationDomain {
    binding: Omit<TestOnlyReviewPreservation, 'review_type'>;
    decision: AuthoritativeReviewRemediationDecision;
    snapshot: TaskProfilePolicySnapshot;
    category: ReviewRemediationDeltaClassification['category'];
    fileDeltaCategories: readonly ReviewRemediationDeltaClassification['category'][];
}

export interface AcceptedReviewClaims {
    schema_version: 1;
    artifact_type: 'accepted_non_test_review_claims';
    task_id: string;
    review_type: string;
    receipt_sha256: string;
    review_context_sha256: string;
    profile_policy_snapshot_sha256: string;
    code_scope_sha256: string;
    non_test_changed_files: string[];
    origin_coverage_contract: ReviewCoverageContract;
    delta_base: ReviewRemediationDeltaBase;
}

/** Read-only snapshot constructor. Only a native REVIEW_RECORDED commitment grants provenance. */
export function buildAcceptedReviewClaims(options: {
    repoRoot: string; taskId: string; reviewType: string; receipt: Record<string, unknown>;
    receiptSha256: string; profilePolicySnapshotSha256: string;
    coverageContract: ReviewCoverageContract; preflight: Record<string, unknown>;
}) {
    assertValidTaskId(options.taskId);
    if (options.reviewType === 'test' || !/^[a-z][a-z0-9_-]*$/u.test(options.reviewType))
        throw new Error('Accepted historical claims require a canonical non-test lane.');
    const payload: AcceptedReviewClaims = { schema_version: 1, artifact_type: 'accepted_non_test_review_claims',
        task_id: options.taskId, review_type: options.reviewType, receipt_sha256: options.receiptSha256,
        review_context_sha256: String(options.receipt.review_context_sha256),
        profile_policy_snapshot_sha256: options.profilePolicySnapshotSha256,
        code_scope_sha256: String(options.receipt.code_scope_sha256), origin_coverage_contract: options.coverageContract,
        non_test_changed_files: computeReviewReuseCodeScopeFingerprint(options.reviewType, options.preflight, options.repoRoot).non_test_changed_files,
        delta_base: buildReviewRemediationDeltaBase({ repoRoot: options.repoRoot, taskId: options.taskId,
            reviewType: options.reviewType, reviewTreeStateSha256: String(options.receipt.review_tree_state_sha256),
            // Only declared case sources need original bytes; the receipt separately binds
            // the entire non-test domain. Unchanged validation targets can be outside the diff.
            changedFiles: [...new Set(options.coverageContract.obligations.flatMap(item =>
                item.validation_binding ? [item.validation_binding.source_identity.path] : []))] }) };
    const artifactSha256 = sha256RedactedJsonPayload(payload);
    return { payload, artifactSha256, artifactPath: path.join(options.repoRoot, 'garda-agent-orchestrator/runtime/reviews',
        `${options.taskId}-${options.reviewType}-accepted-claims-${artifactSha256}.json`) };
}

const PRESERVATION = createInvocationReadMemoKey<PreservationDomain | null>('test-only-review-preservation');
const PRESERVED_BASELINE = createInvocationReadMemoKey<AcceptedReviewClaims | null>('preserved-review-claims');
const TEST_CATEGORIES = new Set(['leaf_test', 'structural_test', 'shared_test_helper_or_harness']);
const TERMINAL_EVENTS = ['TASK_RESET', 'TASK_DISCARDED', 'TASK_MODE_ENTRY_FAILED', 'COMPLETION_GATE_PASSED'];
type RecordValue = Readonly<Record<string, unknown>>;
function rejected(reason: string): null {
    countNextStepWork(`preservation_rejected:${reason}`);
    return null;
}

function samePath(left: string, right: string): boolean {
    const canonical = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return canonical(left) === canonical(right);
}

type PreservationInspection = TestOnlyReviewPreservationOptions & { inspection?: ValidationEvidenceInspection };

function readCurrentRestart(options: PreservationInspection) {
    const timelinePath = path.join(path.dirname(options.reviewsRoot), 'task-events', `${options.taskId}.jsonl`);
    const verified = readInvocationVerifiedTaskEventTimeline(timelinePath, options.taskId);
    const query = readTaskTimelineNavigationQuery(timelinePath, options.taskId);
    if (!verified?.result.status.startsWith('PASS') || !query?.ordered) return rejected('timeline');
    const entry = navigationLatestEvent(query, 'TASK_MODE_ENTERED');
    const classified = navigationLatestEvent(query, 'PREFLIGHT_CLASSIFIED');
    const restart = navigationLatestEvent(query, 'REVIEW_CYCLE_RESTARTED');
    if (!entry || !classified || !restart || !isPlainRecord(restart.details) || !isPlainRecord(classified.details)) return rejected('anchors');
    const entrySequence = navigationEventSequence(entry);
    if (navigationEventSequence(classified) <= entrySequence || navigationEventSequence(restart) <= navigationEventSequence(classified)) return rejected('anchor_order');
    if (options.inspection === 'retained_completed') readImmutableValidationEventSnapshot(options.repoRoot, options.taskId, 'retained_completed');
    if (TERMINAL_EVENTS.some(type => {
        const terminal = navigationLatestEvent(query, type);
        return terminal !== null && navigationEventSequence(terminal) > entrySequence
            && !(type === 'COMPLETION_GATE_PASSED' && options.inspection === 'retained_completed');
    })) return rejected('terminal');
    const retained = readValidationFile(options.repoRoot, path.relative(options.repoRoot, options.preflightPath).replace(/\\/gu, '/'));
    const preflight: unknown = JSON.parse(retained.bytes.toString('utf8'));
    const details = restart.details;
    if (!isPlainRecord(preflight) || preflight.task_id !== options.taskId || details.task_id !== options.taskId
        || details.event_type !== 'REVIEW_CYCLE_RESTARTED' || details.status !== 'PASSED'
        || details.preflight_sha256 !== retained.identity.sha256
        || !samePath(String(classified.details.output_path || ''), options.preflightPath)) return rejected('preflight');
    const binding = classified.details.intermediate_execution_preflight;
    if (!isPlainRecord(binding) || binding.preflight_sha256 !== retained.identity.sha256) return rejected('classification_preflight');
    return { preflight, details, preflightSha256: retained.identity.sha256, timelineSha256: verified.sha256,
        entrySequence, restartSequence: navigationEventSequence(restart) };
}

function readBoundDecision(options: TestOnlyReviewPreservationOptions, current: NonNullable<ReturnType<typeof readCurrentRestart>>) {
    const rawDecision = current.details.authoritative_review_decision;
    const classification = readRestartReviewClassification({ reviewsRoot: options.reviewsRoot, taskId: options.taskId, details: current.details });
    if (getAuthoritativeReviewRemediationDecisionViolations(rawDecision, { expectedTaskId: options.taskId }).length > 0
        || !isPlainRecord(rawDecision) || !isPlainRecord(classification) || classification.source !== 'delta'
        || !isPlainRecord(classification.delta)) return rejected('decision_schema');
    const decision = rawDecision as unknown as AuthoritativeReviewRemediationDecision;
    const delta = classification.delta as unknown as ReviewRemediationDeltaClassification;
    if (decision.status !== 'READY' || decision.current_review_type !== 'test' || decision.classification_source !== 'delta'
        || rawDecision.preflight_sha256 !== current.preflightSha256 || delta.task_id !== options.taskId || delta.review_type !== 'test'
        || decision.classification_sha256 !== delta.classification_sha256 || decision.category !== delta.category
        || !TEST_CATEGORIES.has(delta.category) && delta.category !== 'ambiguous'
        || getReviewRemediationDeltaClassificationViolations(delta).length > 0) return rejected('delta_binding');
    const mode = getTaskModeEvidence(options.repoRoot, options.taskId);
    const policy = validateTaskProfilePolicySnapshot(mode.profile_policy_snapshot);
    const declaredPolicy = validateTaskProfilePolicySnapshot(current.preflight.profile_policy_snapshot);
    const classifiedPolicy = validateTaskProfilePolicySnapshot(classification.profilePolicySnapshot);
    if (mode.evidence_status !== 'PASS' || policy.status !== 'PASS' || !policy.snapshot || classifiedPolicy.status !== 'PASS'
        || classifiedPolicy.snapshot?.snapshot_hash !== policy.snapshot.snapshot_hash
        || mode.profile_policy_snapshot_hash !== policy.snapshot.snapshot_hash
        || decision.profile_policy_snapshot_sha256 !== policy.snapshot.snapshot_hash
        || classification.baselineProfilePolicySnapshotSha256 !== policy.snapshot.snapshot_hash) return rejected('policy');
    // Native classification publishes a summary; unit/legacy producers can retain the full snapshot.
    // Both forms must reconstruct exactly from the authenticated entry policy.
    const declaredMatches = declaredPolicy.status === 'PASS'
        ? validationDigest(declaredPolicy.snapshot) === validationDigest(policy.snapshot)
        : validationDigest(current.preflight.profile_policy_snapshot) === validationDigest(summarizeTaskProfilePolicySnapshot(policy.snapshot));
    if (!declaredMatches) return rejected('declared_policy');
    return { decision, delta, snapshot: policy.snapshot };
}

function laneIsPreserved(options: TestOnlyReviewPreservationOptions, preflight: RecordValue,
    bound: PreservationDomain): boolean {
    if (getEffectiveReviewSnapshotViolations(preflight.effective_review_snapshot).length > 0 || !isPlainRecord(preflight.required_reviews)) return false;
    const effective = preflight.effective_review_snapshot as unknown as EffectiveReviewSnapshot;
    const rerunPolicy = resolveReviewRemediationRerunPolicyFromSnapshot(bound.snapshot);
    if (rerunPolicy.legacy_fallback || preflight.required_reviews[options.reviewType] !== true || preflight.required_reviews.test !== true) return false;
    const selected = resolveReviewRemediationRerunLanes({ policy: rerunPolicy.policy, category: bound.category,
        fileDeltaCategories: bound.fileDeltaCategories,
        currentReviewType: 'test', requiredReviews: preflight.required_reviews as Record<string, boolean>,
        reviewExecutionPolicyMode: resolveReviewExecutionPolicyModeFromPreflight(preflight),
        reviewDependencyGraph: effective.review_dependency_graph });
    const lane = bound.decision.lane_decisions.find(item => item.review_type === options.reviewType);
    return validationDigest(selected.ordered_rerun_lanes) === validationDigest(bound.decision.invalidated_review_types)
        && !selected.ordered_rerun_lanes.includes(options.reviewType)
        && bound.decision.preserved_review_types.includes(options.reviewType)
        && lane?.reuse_eligible === true && lane.invalidated === false;
}

function derivePreservation(options: TestOnlyReviewPreservationOptions, current: NonNullable<ReturnType<typeof readCurrentRestart>>): PreservationDomain | null {
    countNextStepWork('derive:test-only-review-preservation');
    const bound = readBoundDecision(options, current);
    if (!bound) return null;
    const baselineRelative = path.relative(options.reviewsRoot, bound.delta.baseline.artifact_path);
    if (baselineRelative.startsWith('..') || path.isAbsolute(baselineRelative)
        || !path.basename(baselineRelative).startsWith(`${options.taskId}-test-`)) return rejected('baseline_path');
    const validated = validateReviewRemediationBaselineArtifact({ artifactPath: bound.delta.baseline.artifact_path,
        expectedArtifactSha256: bound.delta.baseline.artifact_sha256, expectedTaskId: options.taskId, expectedReviewType: 'test',
        expectedProfilePolicySnapshotSha256: bound.snapshot.snapshot_hash });
    const baseline = validated.artifact;
    if (!validated.valid || !baseline?.origin_coverage_contract || !Array.isArray(current.preflight.changed_files)) return rejected('baseline');
    const triggers = resolveTaskProfileReviewTriggerPolicy(bound.snapshot);
    const fresh = recheckRecordedReviewRemediationDelta({ repoRoot: options.repoRoot, taskId: options.taskId, reviewType: 'test',
        baselineArtifactPath: bound.delta.baseline.artifact_path, baselineArtifactSha256: bound.delta.baseline.artifact_sha256,
        currentChangedFiles: current.preflight.changed_files as string[], testPathRegexes: triggers.test_path_regexes,
        structuralTestPathRegexes: triggers.test_refactor_structural_path_regexes,
        structuralTestChangedLinesThreshold: triggers.test_refactor_changed_lines_threshold,
        fileRoles: mergeFileRoleBindings(triggers.file_roles ?? {}, readProjectValidationFileRoles(options.repoRoot))
    }, bound.delta.current_snapshot_sha256);
    if (fresh.category !== bound.delta.category
        || validationDigest(fresh.scope) !== validationDigest(bound.delta.scope)
        || validationDigest(fresh.file_deltas) !== validationDigest(bound.delta.file_deltas)
        || fresh.file_deltas.length === 0 || fresh.file_deltas.some(file => !TEST_CATEGORIES.has(file.category))) return rejected('fresh_delta');
    const obligations = baseline.origin_coverage_contract.obligations.flatMap(item => item.kind === 'validation' && item.validation_binding
        ? [structuredClone(item.validation_binding)] : []);
    return { decision: bound.decision, snapshot: bound.snapshot, category: bound.delta.category,
        fileDeltaCategories: fresh.file_deltas.map(file => file.category),
        binding: { task_id: options.taskId, entry_sequence: current.entrySequence,
        restart_sequence: current.restartSequence, preflight_sha256: current.preflightSha256,
        decision_sha256: bound.decision.decision_sha256, baseline_sha256: bound.delta.baseline.artifact_sha256,
        original_validation_obligations: obligations } };
}

/** Reads historical claims; callers must still validate accepted receipts and current test semantics. */
export function readTestOnlyReviewPreservation(options: PreservationInspection): TestOnlyReviewPreservation | null {
    try {
        return withInvocationReadObservation(() => {
            assertValidTaskId(options.taskId);
            const reviewsRoot = path.join(options.repoRoot, 'garda-agent-orchestrator/runtime/reviews');
            if (options.reviewType === 'test' || !samePath(options.reviewsRoot, reviewsRoot)
                || !samePath(options.preflightPath, path.join(reviewsRoot, `${options.taskId}-preflight.json`))) return null;
            const current = readCurrentRestart(options);
            if (!current) return null;
            const domain = memoizeInvocationRead(PRESERVATION, JSON.stringify([path.resolve(options.repoRoot), options.taskId,
                current.preflightSha256, current.timelineSha256, options.inspection ?? 'active']),
                () => cloneFrozenJson(derivePreservation(options, current))).value;
            return domain && laneIsPreserved(options, current.preflight, domain)
                ? { ...structuredClone(domain.binding), review_type: options.reviewType } : rejected('lane');
        });
    } catch {
        return rejected('exception');
    }
}

// Scalar memo identities are safe only for ordinary own data fields. An opaque
// caller keeps the uncached reader semantics and cannot publish into another lane.
function stableClaimFields(options: TestOnlyReviewPreservationOptions): TestOnlyReviewPreservationOptions | null {
    if (types.isProxy(options)) return null;
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const fields = ['repoRoot', 'taskId', 'reviewType', 'reviewsRoot', 'preflightPath'] as const;
    const values: Partial<TestOnlyReviewPreservationOptions> = {};
    for (const key of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return null;
        values[key] = descriptor.value;
    }
    return values as TestOnlyReviewPreservationOptions;
}

/** Historical declarations only. Receipt acceptance remains the responsibility of native reuse validation. */
function readPreservedBaseline(options: TestOnlyReviewPreservationOptions) {
    try {
        return withInvocationReadObservation(() => {
            assertValidTaskId(options.taskId);
            const relative = (file: string) => path.relative(options.repoRoot, file).replace(/\\/gu, '/');
            const timeline = path.join(path.dirname(options.reviewsRoot), 'task-events', `${options.taskId}.jsonl`);
            const timelineSha = readInvocationVerifiedTaskEventTimeline(timeline, options.taskId)?.sha256
                ?? readValidationFile(options.repoRoot, relative(timeline)).identity.sha256;
            const preflightSha = readValidationFile(options.repoRoot, relative(options.preflightPath)).identity.sha256;
            const fields = stableClaimFields(options);
            if (!fields) return derivePreservedBaseline(options);
            // Only this private function retains the frozen graph. Public readers project copies.
            return memoizeInvocationRead(PRESERVED_BASELINE, JSON.stringify([path.resolve(fields.repoRoot),
                fields.taskId, fields.reviewType, path.resolve(fields.reviewsRoot), path.resolve(fields.preflightPath),
                timelineSha, preflightSha]), () => cloneFrozenJson(derivePreservedBaseline(fields))).value;
        });
    } catch { return null; }
}

function derivePreservedBaseline(options: TestOnlyReviewPreservationOptions) {
    countNextStepWork('derive:accepted-review-claims');
    try {
        const timelinePath = path.join(path.dirname(options.reviewsRoot), 'task-events', `${options.taskId}.jsonl`);
        const query = readTaskTimelineNavigationQuery(timelinePath, options.taskId);
        const verified = readInvocationVerifiedTaskEventTimeline(timelinePath, options.taskId);
        const entry = query && navigationLatestEvent(query, 'TASK_MODE_ENTERED');
        const completed = query && navigationLatestEvent(query, 'COMPLETION_GATE_PASSED');
        const preservation = readTestOnlyReviewPreservation({ ...options,
            ...(completed && entry && navigationEventSequence(completed) > navigationEventSequence(entry)
                ? { inspection: 'retained_completed' } : {}) });
        if (!preservation) return rejected('claims_domain');
        const event = query && navigationLatestReview(query, options.reviewType);
        if (!event || navigationEventSequence(event) <= preservation.entry_sequence || !isPlainRecord(event.details)) return rejected('claims_record');
        const details = event.details;
        const receiptHash = String(details.receipt_snapshot_sha256 ?? '');
        if (!/^[a-f0-9]{64}$/u.test(receiptHash)) return rejected('claims_receipt_hash');
        const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-receipt-${receiptHash}.json`);
        if (!samePath(String(details.receipt_snapshot_path ?? ''), receiptPath)) return rejected('claims_receipt_path');
        const read = (file: string) => readValidationFile(options.repoRoot,
            path.relative(options.repoRoot, file).replace(/\\/gu, '/'));
        const receiptFile = read(receiptPath);
        if (receiptFile.identity.sha256 !== receiptHash) return rejected('claims_receipt_bytes');
        const receipt: unknown = JSON.parse(receiptFile.bytes.toString('utf8'));
        const preflight = JSON.parse(read(options.preflightPath).bytes.toString('utf8'));
        const currentScope = computeReviewReuseCodeScopeFingerprint(options.reviewType, preflight, options.repoRoot);
        const emptyCurrentDomain = currentScope.test_only && currentScope.non_test_changed_files.length === 0;
        if (!isPlainRecord(receipt) || receipt.task_id !== options.taskId || receipt.review_type !== options.reviewType
            || receipt.code_scope_sha256 !== currentScope.code_scope_sha256 && !emptyCurrentDomain) return rejected('claims_code_scope');
        const originContext = String(receipt.reused_existing_review === true
            ? receipt.reused_from_review_context_sha256 : receipt.review_context_sha256);
        const originReceipt = String(receipt.reused_existing_review === true ? receipt.reused_from_receipt_sha256 : receiptHash);
        const route = readTaskTimelineRouteQuery(timelinePath, options.taskId);
        if (!route || !/^[a-f0-9]{64}$/u.test(originContext) || !/^[a-f0-9]{64}$/u.test(originReceipt)) return rejected('claims_origin');
        const provenance = isPlainRecord(receipt.reviewer_provenance) ? receipt.reviewer_provenance : {};
        const events = navigationRawEvents(query);
        for (const routing of new Set(['', String(provenance.routing_event_sha256 ?? '')])) {
            for (const index of routeArtifactBindingIndices(route, options.taskId, options.reviewType, originContext, routing, -1)) {
                const original = events[index];
                // Only an original record inside this entry and strictly BEFORE the authenticated
                // restart can supply historical claims. A current reused receipt is just a pointer.
                if (original?.event_type !== 'REVIEW_RECORDED' || navigationEventSequence(original) <= preservation.entry_sequence
                    || navigationEventSequence(original) >= preservation.restart_sequence
                    || !isPlainRecord(original.details) || original.details.receipt_snapshot_sha256 !== originReceipt) continue;
                const origin = original.details;
                const baselineHash = String(origin.accepted_review_claims_sha256 ?? '');
                const baselinePath = path.join(options.reviewsRoot,
                    `${options.taskId}-${options.reviewType}-accepted-claims-${baselineHash}.json`);
                if (!/^[a-f0-9]{64}$/u.test(baselineHash)
                    || !samePath(String(origin.accepted_review_claims_path ?? ''), baselinePath)) return rejected('claims_path');
                const claimFile = read(baselinePath);
                const claims: unknown = JSON.parse(claimFile.bytes.toString('utf8'));
                if (claimFile.identity.sha256 !== baselineHash || !isPlainRecord(claims)
                    || claims.schema_version !== 1 || claims.artifact_type !== 'accepted_non_test_review_claims'
                    || claims.task_id !== options.taskId || claims.review_type !== options.reviewType
                    || claims.receipt_sha256 !== originReceipt || claims.review_context_sha256 !== originContext
                    || claims.profile_policy_snapshot_sha256 !== preflight.profile_policy_snapshot?.snapshot_hash
                    || claims.code_scope_sha256 !== (receipt.reused_existing_review === true
                        ? receipt.reused_from_code_scope_sha256 : receipt.code_scope_sha256)
                    || !Array.isArray(claims.non_test_changed_files)
                    || validationDigest(claims.non_test_changed_files) !== validationDigest(currentScope.non_test_changed_files)
                    || receipt.code_scope_sha256 !== currentScope.code_scope_sha256
                        && !(emptyCurrentDomain && claims.non_test_changed_files.length === 0)
                    || !isPlainRecord(claims.origin_coverage_contract)
                    || claims.origin_coverage_contract.review_type !== options.reviewType
                    || !isPlainRecord(receipt.review_coverage)
                    || claims.origin_coverage_contract.contract_sha256 !== receipt.review_coverage.contract_sha256
                    || getReviewRemediationDeltaBaseViolations(claims.delta_base, { taskId: options.taskId,
                        reviewType: options.reviewType, reviewTreeStateSha256: String(receipt.reused_existing_review === true
                            ? receipt.reused_from_review_tree_state_sha256 : receipt.review_tree_state_sha256) }).length > 0) return rejected('claims_envelope');
                if (read(options.preflightPath).identity.sha256 !== preservation.preflight_sha256
                    || read(receiptPath).identity.sha256 !== receiptHash
                    || read(baselinePath).identity.sha256 !== baselineHash
                    || readInvocationVerifiedTaskEventTimeline(timelinePath, options.taskId)?.sha256 !== verified?.sha256)
                    return rejected('claims_closure');
                return claims as unknown as AcceptedReviewClaims;
            }
        }
        return rejected('claims_original_record');
    } catch { return rejected('claims_exception'); }
}

export function readPreservedReviewCoverage(options: TestOnlyReviewPreservationOptions): ReviewCoverageContract | null {
    return structuredClone(readPreservedBaseline(options)?.origin_coverage_contract ?? null);
}

/** Verify actual original source bytes from the authenticated, bounded native snapshot. */
export function readPreservedNativeCaseSource(options: TestOnlyReviewPreservationOptions,
    binding: QualityValidationObligation): string | null {
    if (options.reviewType !== 'code') return null;
    const baseline = readPreservedBaseline(options);
    if (!baseline?.origin_coverage_contract?.obligations.some(item => item.validation_binding
        && validationDigest(item.validation_binding) === validationDigest(binding))) return null;
    const source = baseline.delta_base?.entries.find(item => item.path === binding.source_identity.path);
    if (!source || source.status !== 'text' || source.redaction_applied || !source.redacted_lines) return null;
    const bytes = Buffer.from(source.redacted_lines.join(''), 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    return digest === source.content_sha256 && digest === binding.source_identity.sha256
        && bytes.length === binding.source_identity.size ? validationDigest(binding.source_identity) : null;
}
