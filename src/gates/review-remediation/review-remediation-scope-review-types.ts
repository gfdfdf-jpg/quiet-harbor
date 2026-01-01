import * as path from 'node:path';
import * as fs from 'node:fs';
import { readReviewCatalogConfigFile } from '../../core/review-catalog';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { collectKnownReviewSkillIds, matchConfiguredReviewSignal } from '../../policy/effective-review-snapshot';
import { readSkillsHeadlinesIfPresent } from '../../runtime/skill-headlines-store';
import { readReviewArtifactJsonFile } from '../../gate-runtime/review-artifacts';
import { normalizeReviewReceiptReviewerProvenance } from '../../gate-runtime/review-context';
import { validateReviewFindingsValidationArtifactForReceipt } from '../review/review-findings-validation-artifact';
import { validateReviewFindingsDispositionEvidence } from '../review/review-findings-disposition-evidence';
import { resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence, reviewFindingsValidationArtifactHasBlockingFindings } from '../review/review-finding-disposition';
import { evaluateHiddenReviewTimingTrust, stripReviewTimingProvenanceTimestamps, type ReviewTimingTrustEventLike } from '../review/review-timing-trust';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { validateHistoricalReviewRecordedReceiptSnapshot } from '../review-reuse/review-reuse-telemetry';
import { resolveReviewRemediationModePolicyFromSnapshot, resolveReviewRemediationScopeReviewTypes } from '../../policy/review-remediation-mode-policy';
import { isPlainRecord } from '../../core/records';
import { PROTECTED_BOUNDARY_SIGNAL_OWNERS, collectReviewRemediationProtectedBoundarySignals } from '../../policy/review-remediation-mode-policy';
import { resolveTaskProfileReviewTriggerPolicy } from '../../policy/task-profile-policy-snapshot';
import { classifyChange, getClassificationConfig } from '../preflight/classify-change';
import { isSafeOrdinaryDocumentationPath } from '../preflight/classify-change-doc-safety';
import { isOrchestratorSourceCheckout } from '../shared/helpers';
import { resolveRemediationTaskRoleConfig, reviewRemediationDeltaInternals, type ReviewRemediationDeltaClassification, type ReviewRemediationFileDelta } from './review-remediation-delta';
import { collectReviewRemediationChangedLineEvidence } from './review-remediation-readable-diff';

const TRIGGERED_REVIEW_TYPES = ['db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency', 'test'];

export function resolveRemediationRepositoryRoot(baselineArtifactPath: string): string {
    const bundleRoot = path.resolve(path.dirname(baselineArtifactPath), '../..');
    if (fs.existsSync(path.join(bundleRoot, '.git'))) return bundleRoot;
    const parent = path.dirname(bundleRoot);
    return path.resolve(joinOrchestratorPath(parent, 'runtime/reviews')) === path.resolve(bundleRoot, 'runtime/reviews')
        ? parent : bundleRoot;
}

export function mentionsReviewSecurityWord(lines: readonly string[], tokens: readonly string[]): boolean {
    const words = new Set(tokens.map((token) => token.toLowerCase()));
    return lines.some((line) => line.replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2').toLowerCase()
        .split(/[^a-z0-9]+/u).some((word) => words.has(word)));
}

export function collectReviewRemediationScopeReviewTypes(options: {
    repoRoot?: string;
    triggers: Record<string, unknown>;
    fileDeltas: readonly ReviewRemediationFileDelta[];
    securityWord: boolean;
    productionChanged?: boolean;
    scopeCategory?: string;
}): string[] {
    const { triggers, fileDeltas } = options;
    const lanes = TRIGGERED_REVIEW_TYPES.filter((lane) => triggers[lane] === true);
    if (options.repoRoot && fileDeltas.length) {
        const catalog = readReviewCatalogConfigFile(joinOrchestratorPath(options.repoRoot, 'live/config/review-catalog.json'), {
            knownSkillIds: collectKnownReviewSkillIds(readSkillsHeadlinesIfPresent(joinOrchestratorPath(options.repoRoot, ''))?.payload.skills)
        });
        for (const definition of catalog.review_types.filter((entry) => !entry.built_in)) {
            const signals = definition.trigger.signal_ids;
            const evaluable = definition.trigger.mode === 'signals' && signals.length > 0
                && signals.every((signal) => /^(?:trigger|path|paths|package)[.:]/u.test(signal)
                    || (options.scopeCategory !== undefined && /^scope[.:]/u.test(signal)));
            if (!evaluable || signals.some((signal) => matchConfiguredReviewSignal(signal, {
                scopeCategory: options.scopeCategory ?? '', taskIntent: '', changedFiles: fileDeltas.map((entry) => entry.path),
                taskTriggers: Object.fromEntries(Object.entries(triggers).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
            }))) lanes.push(definition.id);
        }
    }
    const productionChanged = fileDeltas.some((entry) => entry.category === 'production'
        && entry.reason !== 'path is a dependency manifest' && entry.reason !== 'path is infrastructure configuration'
        && entry.reason !== 'path is owned configuration');
    if (fileDeltas.length ? productionChanged : options.productionChanged || triggers.runtime_code_changed === true) lanes.push('code', 'test');
    if (fileDeltas.some((entry) => entry.category === 'structural_test' || entry.category === 'shared_test_helper_or_harness')) {
        lanes.push('refactor', 'test');
    }
    if (fileDeltas.length && fileDeltas.every((entry) => entry.operation === 'added' && entry.category === 'leaf_test')) {
        return [...new Set([...lanes.filter((lane) => lane === 'test'), 'test'])].sort();
    }
    if (options.securityWord) lanes.push('security');
    return [...new Set(lanes)].sort();
}

export function getReviewRemediationScopeReviewTypesViolations(options: {
    repoRoot: string;
    delta: ReviewRemediationDeltaClassification;
    profilePolicySnapshot: unknown;
    authenticatedPreflightSha256?: string;
}): string[] {
    const { delta } = options;
    const recorded = resolveReviewRemediationScopeReviewTypes(delta.mode_policy_assessment);
    if (recorded === null) return [];
    try {
        const snapshot = isPlainRecord(options.profilePolicySnapshot) ? options.profilePolicySnapshot : {};
        const reviewTriggerPolicy = snapshot.review_trigger_policy === undefined ? undefined
            : resolveTaskProfileReviewTriggerPolicy(snapshot as unknown as Parameters<typeof resolveTaskProfileReviewTriggerPolicy>[0]);
        const rawConfig = getClassificationConfig(options.repoRoot);
        for (const patterns of [rawConfig.db_trigger_regexes, rawConfig.security_trigger_regexes, rawConfig.api_trigger_regexes,
            rawConfig.dependency_trigger_regexes, rawConfig.infra_trigger_regexes]) {
            patterns.forEach((pattern) => new RegExp(pattern, 'i'));
        }
        const baseConfig = getClassificationConfig(options.repoRoot, reviewTriggerPolicy ? { reviewTriggerPolicy } : {});
        const config = delta.task_role_preflight_text === undefined ? baseConfig : resolveRemediationTaskRoleConfig({
            repoRoot: options.repoRoot, taskId: delta.task_id, preflightText: delta.task_role_preflight_text,
            authenticatedPreflightHashes: options.authenticatedPreflightSha256 ? [options.authenticatedPreflightSha256] : [],
            config: baseConfig
        });
        if (delta.documents_only && (!delta.changed_files.length || delta.changed_files.some((file) =>
            !isSafeOrdinaryDocumentationPath(file, config) || !delta.file_deltas.some((entry) => entry.path === file
                && ['text', 'missing'].includes(entry.baseline_status) && ['text', 'missing'].includes(entry.current_status)
                && !(entry.operation === 'modified' && entry.baseline_mode !== entry.current_mode))))) {
            return ['remediation documents-only marker does not match safe ordinary documentation paths.'];
        }
        const files = delta.documents_only ? [] : delta.changed_files;
        const classification = files.length ? classifyChange({
            repoRoot: options.repoRoot, normalizedFiles: [...files], classificationConfig: config,
            isSourceCheckout: isOrchestratorSourceCheckout(options.repoRoot)
        }) : null;
        const triggers = classification?.triggers as unknown as Record<string, unknown> ?? {};
        const changedLineEvidence = delta.documents_only ? { lines: [], redactedChangedLine: false }
            : collectReviewRemediationChangedLineEvidence(delta.readable_diff);
        const securityWord = !delta.documents_only && mentionsReviewSecurityWord(
            changedLineEvidence.lines,
            rawConfig.security_trigger_name_tokens ?? []
        );
        const signals = collectReviewRemediationProtectedBoundarySignals({ changedFiles: files, preflight: { triggers } });
        if (changedLineEvidence.redactedChangedLine) signals.push('secret');
        const structuralPatterns = reviewRemediationDeltaInternals.compilePatterns(
            config.test_refactor_structural_trigger_regexes, 'structural test paths');
        const fileDeltas = delta.documents_only ? [] : delta.file_deltas.map((entry) => ({
            ...entry,
            ...reviewRemediationDeltaInternals.categorizeFile({
                filePath: entry.path, operation: entry.operation, changedLines: entry.changed_lines,
                lineDeltaUnavailableReason: null, baselineStatus: entry.baseline_status, currentStatus: entry.current_status,
                testPathRegexes: config.test_trigger_regexes, fileRoles: config.file_roles, structuralPatterns,
                structuralThreshold: config.test_refactor_changed_lines_threshold
            })
        }));
        if (delta.task_role_preflight_text !== undefined && !delta.documents_only
            && (delta.file_deltas.some((entry, index) => entry.category !== fileDeltas[index].category)
                || delta.category !== reviewRemediationDeltaInternals.aggregateFileCategories(fileDeltas))) {
            return ['remediation task-role categories do not match independently classified fix paths.'];
        }
        const newTestsOnly = fileDeltas.length && fileDeltas.every((entry) =>
            entry.operation === 'added' && entry.category === 'leaf_test');
        const owners = [...new Set(newTestsOnly ? [] : signals.flatMap((signal) => PROTECTED_BOUNDARY_SIGNAL_OWNERS[signal] ?? []))].sort();
        const expected = [...new Set([...owners, ...collectReviewRemediationScopeReviewTypes({
            repoRoot: options.repoRoot, triggers, fileDeltas, securityWord, scopeCategory: classification?.scope_category
        })])].sort();
        return JSON.stringify(expected) === JSON.stringify(recorded)
            && JSON.stringify(owners) === JSON.stringify(delta.mode_policy_assessment?.full_review_types ?? []) ? []
            : ['remediation scope lanes do not match recomputed fix paths and changed-line security signals'
                + ` (expected scopes: ${expected.join(', ') || 'none'}; recorded scopes: ${recorded.join(', ') || 'none'};`
                + ` expected owners: ${owners.join(', ') || 'none'}; recorded owners: ${(delta.mode_policy_assessment?.full_review_types ?? []).join(', ') || 'none'}).`];
    } catch (error) {
        return ['remediation scope lanes cannot be recomputed: ' + (error instanceof Error ? error.message : String(error))];
    }
}

interface RemediationLaneEvidenceOptions {
    repoRoot: string; taskId: string; reviewType: string; details: Record<string, unknown>;
    timingEvents: readonly ReviewTimingTrustEventLike[]; trustedReceipts: ReadonlySet<string>;
}

function hasMatchingRemediationInvocation(options: RemediationLaneEvidenceOptions,
    provenance: ReturnType<typeof normalizeReviewReceiptReviewerProvenance>): boolean {
    if (provenance?.attestation_type !== 'reviewer_invocation_attestation') return false;
    return options.timingEvents.some((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
        && isPlainRecord(event.integrity) && isPlainRecord(event.details)
        && event.integrity.event_sha256 === provenance.event_sha256
        && event.integrity.task_sequence === provenance.task_sequence
        && event.integrity.prev_event_sha256 === provenance.prev_event_sha256
        && event.details.task_id === provenance.task_id && event.details.review_type === provenance.review_type
        && event.details.reviewer_identity === provenance.reviewer_identity
        && event.details.review_context_sha256 === provenance.review_context_sha256
        && event.details.review_tree_state_sha256 === provenance.review_tree_state_sha256
        && event.details.reviewer_launch_artifact_sha256 === provenance.reviewer_launch_artifact_sha256);
}

// Call only for integrity-verified native REVIEW_RECORDED events. Closed archive bytes cannot rewrite their chain facts.
export function readRemediationLaneEventTiming(options: RemediationLaneEvidenceOptions): {
    authenticated: boolean; reused: boolean; attemptSha256: string | null;
} {
    const details = options.details;
    const provenance = normalizeReviewReceiptReviewerProvenance(details.reviewer_provenance);
    const reused = details.reused_existing_review === true;
    const stringValue = (name: string): string | null => typeof details[name] === 'string' ? details[name] as string : null;
    const timingTrusted = reused
        ? options.trustedReceipts.has(options.reviewType + ':' + String(details.reused_from_receipt_sha256 || ''))
        : evaluateHiddenReviewTimingTrust({
            reviewType: options.reviewType, reusedExistingReview: false,
            reviewerProvenance: stripReviewTimingProvenanceTimestamps(provenance),
            reviewResultRecordedAtUtc: stringValue('review_result_recorded_at_utc'), recordedAtUtc: stringValue('recorded_at_utc'),
            reviewOutputSourceMtimeUtc: stringValue('review_output_source_mtime_utc'), timelineEvents: options.timingEvents
        }).trusted;
    return { reused, attemptSha256: provenance?.event_sha256 ?? null,
        authenticated: timingTrusted && hasMatchingRemediationInvocation(options, provenance)
            && /^[a-f0-9]{64}$/u.test(String(details.receipt_sha256 || ''))
            && ['FULL', 'DELTA'].includes(String(details.review_execution_mode))
            && details.task_id === options.taskId && details.review_type === options.reviewType
            && provenance?.attestation_type === 'reviewer_invocation_attestation'
            && provenance.task_id === options.taskId && provenance.review_type === options.reviewType
            && provenance.review_tree_state_sha256 === details[reused ? 'reused_from_review_tree_state_sha256' : 'review_tree_state_sha256'] };
}

export function readAuthenticatedRemediationLaneReceipt(options: RemediationLaneEvidenceOptions): {
    authenticated: boolean; passed: boolean; reused: boolean; attemptSha256: string | null;
} {
    try {
        const snapshot = validateHistoricalReviewRecordedReceiptSnapshot(options.details, options.repoRoot, {
            taskId: options.taskId, reviewType: options.reviewType
        });
        if (!snapshot.valid || !snapshot.resolvedPath) return { authenticated: false, passed: false, reused: false, attemptSha256: null };
        const receipt = readReviewArtifactJsonFile(snapshot.resolvedPath) as Record<string, unknown>;
        const reused = receipt.reused_existing_review === true;
        const stringValue = (name: string): string | null => typeof receipt[name] === 'string' ? receipt[name] as string : null;
        const validation = validateReviewFindingsValidationArtifactForReceipt({
            receipt, reviewArtifactPath: String(options.details.review_artifact_path || ''),
            expectedTaskId: options.taskId, expectedReviewType: options.reviewType,
            expectedReviewArtifactSha256: stringValue('review_artifact_sha256'),
            expectedReviewContextSha256: stringValue(reused ? 'reused_from_review_context_sha256' : 'review_context_sha256'),
            expectedReviewTreeStateSha256: stringValue(reused ? 'reused_from_review_tree_state_sha256' : 'review_tree_state_sha256'),
            preferSnapshot: true, requireAccepted: true
        });
        const provenance = normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
        const timingTrusted = reused
            ? options.trustedReceipts.has(options.reviewType + ':' + String(receipt.reused_from_receipt_sha256 || ''))
            : evaluateHiddenReviewTimingTrust({
                reviewType: options.reviewType, reusedExistingReview: false,
                reviewerProvenance: stripReviewTimingProvenanceTimestamps(provenance),
                reviewResultRecordedAtUtc: stringValue('review_result_recorded_at_utc'), recordedAtUtc: stringValue('recorded_at_utc'),
                reviewOutputSourceMtimeUtc: stringValue('review_output_source_mtime_utc'), timelineEvents: options.timingEvents
            }).trusted;
        const policyResolution = resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(receipt);
        const disposition = validation.artifact && validation.reference && validation.artifact_sha256
            ? validateReviewFindingsDispositionEvidence({
                repoRoot: options.repoRoot, receipt, receiptPath: snapshot.resolvedPath,
                reviewArtifactPath: String(options.details.review_artifact_path || ''),
                expectedTaskId: options.taskId, expectedReviewType: options.reviewType,
                validationArtifact: validation.artifact, validationArtifactPath: validation.reference.artifact_path,
                validationArtifactSha256: validation.artifact_sha256, policyResolution,
                expectedReceiptPath: reused ? stringValue('reused_from_receipt_path') || snapshot.resolvedPath
                    : String(options.details.receipt_path || snapshot.resolvedPath),
                expectedReceiptSha256: reused ? stringValue('reused_from_receipt_sha256') || snapshot.actualSha256!
                    : snapshot.actualSha256!, preferSnapshot: true, allowPendingGroupedFollowUp: true
            }) : null;
        const authenticated = validation.valid && timingTrusted && provenance?.attestation_type === 'reviewer_invocation_attestation'
            && snapshot.actualSha256 === options.details.receipt_sha256
            && receipt.review_execution_mode === options.details.review_execution_mode
            && reused === (options.details.reused_existing_review === true)
            && receipt.review_context_sha256 === options.details.review_context_sha256
            && receipt.review_artifact_sha256 === options.details.review_artifact_sha256
            && provenance.task_id === options.taskId && provenance.review_type === options.reviewType
            && provenance.reviewer_identity === receipt.reviewer_identity && receipt.reviewer_execution_mode === 'delegated_subagent'
            && provenance.review_context_sha256 === receipt[reused ? 'reused_from_review_context_sha256' : 'review_context_sha256']
            && provenance.review_tree_state_sha256 === receipt[reused ? 'reused_from_review_tree_state_sha256' : 'review_tree_state_sha256']
            && hasMatchingRemediationInvocation(options, provenance)
            && receipt.task_id === options.taskId
            && receipt.review_type === options.reviewType && receipt.review_tree_state_sha256 === options.details.review_tree_state_sha256;
        const passed = authenticated && disposition?.valid === true
            && !reviewFindingsValidationArtifactHasBlockingFindings(validation.artifact, policyResolution);
        return { authenticated, passed, reused, attemptSha256: provenance?.event_sha256 ?? null };
    } catch {
        return { authenticated: false, passed: false, reused: false, attemptSha256: null };
    }
}

export function collectRemediationLaneHistory(options: {
    repoRoot: string;
    taskId: string;
    untilClassificationSha256?: string;
}) {
    const timelinePath = joinOrchestratorPath(options.repoRoot, 'runtime/task-events/' + options.taskId + '.jsonl');
    const seen = new Set<string>();
    const seenAttempts = new Set<string>();
    const lanes = new Map<string, RemediationLaneRecord>();
    const recordsByReceipt = new Map<string, RemediationLaneRecord>();
    const timingEvents: ReviewTimingTrustEventLike[] = [];
    const trustedReceipts = new Set<string>();
    let boundaryReached = false;
    let classifiedPreflight: { path: string; hash: string } | null = null;
    let authenticatedPreflightSha256: string | null = null;
    const pathKey = (value: unknown): string => {
        const resolved = path.resolve(options.repoRoot, String(value || ''));
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const integrity = inspectTaskEventFile(timelinePath, options.taskId, {
        onIntegrityEvent: (event) => {
            if (['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED', 'PREFLIGHT_STARTED', 'PREFLIGHT_FAILED'].includes(String(event.event_type))) {
                classifiedPreflight = null;
                authenticatedPreflightSha256 = null;
            } else if (event.event_type === 'PREFLIGHT_CLASSIFIED') {
                classifiedPreflight = event.actor === 'gate' && ['INFO', 'PASS'].includes(String(event.outcome))
                    && isPlainRecord(event.details) && typeof event.details.output_path === 'string' && event.details.output_path
                    ? { path: pathKey(event.details.output_path), hash: String(event.details.output_sha256 || '').toLowerCase() } : null;
                authenticatedPreflightSha256 = null;
            } else if (event.event_type === 'COMPILE_GATE_PASSED') {
                authenticatedPreflightSha256 = null;
                if (event.actor === 'gate' && event.outcome === 'PASS' && isPlainRecord(event.details) && classifiedPreflight) {
                    const hash = String(event.details.preflight_hash_sha256 || '').toLowerCase();
                    authenticatedPreflightSha256 = event.details.task_id === options.taskId
                        && typeof event.details.preflight_path === 'string' && pathKey(event.details.preflight_path) === classifiedPreflight.path
                        && /^[a-f0-9]{64}$/u.test(hash) && (!classifiedPreflight.hash || classifiedPreflight.hash === hash) ? hash : null;
                }
            } else if (['COMPILE_GATE_FAILED', 'COMPILE_GATE_REFUSED'].includes(String(event.event_type))) {
                authenticatedPreflightSha256 = null;
            }
            if (!boundaryReached && event.event_type === 'REVIEWER_INVOCATION_ATTESTED') timingEvents.push(event);
            if (event.event_type === 'REVIEW_CYCLE_RESTARTED' && isPlainRecord(event.details)
                && isPlainRecord(event.details.authoritative_review_decision)
                && event.details.authoritative_review_decision.classification_sha256 === options.untilClassificationSha256) boundaryReached = true;
            if (boundaryReached || event.event_type !== 'REVIEW_RECORDED' || event.outcome !== 'PASS' || !isPlainRecord(event.details)) return;
            const details = event.details;
            const lane = String(details.review_type || '');
            const previous = lanes.get(lane);
            const key = lane + ':' + String(details.receipt_sha256 || details.remediation_baseline_snapshot_sha256 || '');
            const receipt = readRemediationLaneEventTiming({ repoRoot: options.repoRoot,
                taskId: options.taskId, reviewType: lane, details, timingEvents, trustedReceipts });
            const attemptKey = lane + ':' + String(receipt.attemptSha256 || '');
            const repeated = seen.has(key) || (receipt.attemptSha256 !== null && seenAttempts.has(attemptKey));
            seen.add(key);
            if (receipt.attemptSha256) seenAttempts.add(attemptKey);
            if (receipt.authenticated) trustedReceipts.add(key);
            // A kept (REUSE) review carries no baseline of its own: it stands for the review it reused, so it keeps
            // that review's baseline and reviewed tree and can still anchor a later fix in its scope.
            const reusedFrom = details.reused_existing_review === true
                ? recordsByReceipt.get(lane + ':' + String(details.reused_from_receipt_sha256 || '')) : undefined;
            const inheritsBaseline = !details.remediation_baseline_snapshot_sha256
                && Boolean(reusedFrom?.details.remediation_baseline_snapshot_sha256);
            const tree = String(details.review_tree_state_sha256 || '');
            const record: RemediationLaneRecord = {
                depth: repeated || receipt.reused ? previous?.depth ?? 0
                    : details.review_execution_mode === 'DELTA' ? Math.min(Number.MAX_SAFE_INTEGER, (previous?.depth ?? 0) + 1)
                    : details.review_execution_mode === 'FULL' ? 0 : Number.MAX_SAFE_INTEGER,
                tree,
                reviewedTree: reusedFrom?.reviewedTree ?? tree,
                sequence: Number(isPlainRecord(event.integrity) ? event.integrity.task_sequence : 0) || 0,
                details: inheritsBaseline ? { ...details,
                    remediation_baseline_snapshot_path: reusedFrom!.details.remediation_baseline_snapshot_path,
                    remediation_baseline_snapshot_sha256: reusedFrom!.details.remediation_baseline_snapshot_sha256 } : details
            };
            lanes.set(lane, record);
            if (details.receipt_sha256) recordsByReceipt.set(lane + ':' + String(details.receipt_sha256), record);
        }
    });
    return { integrity, lanes, timingEvents, trustedReceipts, authenticatedPreflightSha256 };
}

/** The latest recorded review of a lane in the task timeline. */
export interface RemediationLaneRecord {
    depth: number;
    /** The tree the record was made on. */
    tree: string;
    /** The tree the reviewer reviewed: for a kept (REUSE) review, the tree of the review it reused. */
    reviewedTree: string;
    sequence: number;
    details: Record<string, unknown>;
}

/** A recorded review covers a baseline tree when it was recorded on it or reviewed it. */
export function laneRecordCoversTree(record: Pick<RemediationLaneRecord, 'tree' | 'reviewedTree'>, tree: string): boolean {
    return Boolean(tree) && (record.tree === tree || record.reviewedTree === tree);
}

export function getReviewRemediationDeltaHistoryViolations(options: {
    repoRoot: string;
    delta: ReviewRemediationDeltaClassification;
    reviewType: string;
    profilePolicySnapshot: unknown;
    timelineBoundaryClassificationSha256?: string;
    requirePassedOrigin?: boolean;
}): string[] {
    if (!options.delta.mode_policy_assessment) return [];
    const { integrity, lanes, timingEvents, trustedReceipts } = collectRemediationLaneHistory({
        repoRoot: options.repoRoot, taskId: options.delta.task_id,
        untilClassificationSha256: options.timelineBoundaryClassificationSha256 ?? options.delta.classification_sha256
    });
    const originLane = lanes.get(options.delta.review_type);
    const originReached = originLane?.details.remediation_baseline_snapshot_sha256 === options.delta.baseline.artifact_sha256
        && laneRecordCoversTree(originLane, options.delta.baseline.review_tree_state_sha256);
    const lane = lanes.get(options.reviewType);
    const receipt = lane ? readAuthenticatedRemediationLaneReceipt({ ...options, taskId: options.delta.task_id,
        details: lane.details, timingEvents, trustedReceipts }) : null;
    const policy = resolveReviewRemediationModePolicyFromSnapshot(options.profilePolicySnapshot).policy;
    const origin = options.reviewType === options.delta.review_type;
    return integrity.status === 'PASS' && originReached && receipt?.authenticated && (!options.requirePassedOrigin || receipt.passed) && lane
        && (origin ? lane.depth === options.delta.mode_policy_assessment.delta_chain_depth : receipt.passed)
        && laneRecordCoversTree(lane, options.delta.baseline.review_tree_state_sha256) && lane.depth < policy.max_consecutive_delta_reviews ? []
        : ['DELTA lane has no authenticated prior review on the failed review tree within its per-lane DELTA bound.'];
}
