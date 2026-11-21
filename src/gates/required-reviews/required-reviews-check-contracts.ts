// Extracted from required-reviews-check.ts; keep behavior changes in the facade tests.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildReviewVerdictTokenSet } from '../../gate-runtime/review-context';
import { resolveBundleName } from '../../core/constants';
import { loadFullSuiteValidationConfig } from '../../core/full-suite-validation-config';
import { readReviewCapabilitiesConfigFile } from '../../core/review-capabilities';
import { readReviewCatalogConfigFile } from '../../core/review-catalog';
import { loadReviewExecutionPolicyConfig } from '../../core/review-execution-policy';
import {
    resolveLegacyCompatibilityReviewCatalogBinding,
    resolveProfileReviewCatalogPolicy
} from '../../policy/profile-review-catalog-policy';
import {
    buildTaskProfilePolicySnapshot,
    type TaskProfilePolicySnapshot
} from '../../policy/task-profile-policy-snapshot';
import {
    assertEffectiveReviewSnapshotCurrent,
    collectKnownReviewSkillIds,
    getEffectiveReviewSnapshotViolations,
    type EffectiveReviewSnapshot
} from '../../policy/effective-review-snapshot';
import { readSkillsHeadlinesIfPresent } from '../../runtime/skill-headlines-store';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { fileSha256, resolvePathInsideRepo } from '../shared/helpers';
import { readReviewValidationBytes } from '../review-context/review-validation-invocation';

const BUILT_IN_REVIEW_CONTRACTS = [
    ['code', 'REVIEW PASSED'],
    ['db', 'DB REVIEW PASSED'],
    ['security', 'SECURITY REVIEW PASSED'],
    ['refactor', 'REFACTOR REVIEW PASSED'],
    ['api', 'API REVIEW PASSED'],
    ['test', 'TEST REVIEW PASSED'],
    ['performance', 'PERFORMANCE REVIEW PASSED'],
    ['infra', 'INFRA REVIEW PASSED'],
    ['dependency', 'DEPENDENCY REVIEW PASSED']
] as const;

const REVIEW_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;

function buildCustomReviewContracts(
    reviewTypes: readonly EffectiveReviewSnapshot['lanes'][number]['definition'][]
): Array<[string, string]> {
    return reviewTypes
        .filter((definition) => !definition.built_in && REVIEW_ID_PATTERN.test(definition.id))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((definition): [string, string] => [definition.id, definition.verdict_tokens.pass]);
}

export function readConfiguredReviewContracts(bundleRoot: string): Array<[string, string]> {
    const knownReviewSkillIds = collectKnownReviewSkillIds(
        readSkillsHeadlinesIfPresent(bundleRoot)?.payload.skills
    );
    const catalog = readReviewCatalogConfigFile(
        path.join(bundleRoot, 'live', 'config', 'review-catalog.json'),
        { knownSkillIds: knownReviewSkillIds }
    );
    return buildCustomReviewContracts(catalog.review_types);
}

function initializeConfiguredReviewContracts(): Array<[string, string]> {
    const candidates = [
        path.join(process.cwd(), resolveBundleName()),
        process.cwd()
    ];
    for (const bundleRoot of candidates) {
        if (!fs.existsSync(path.join(bundleRoot, 'live', 'config', 'review-catalog.json'))) {
            continue;
        }
        try {
            return readConfiguredReviewContracts(bundleRoot);
        } catch {
            // The authenticated preflight validator reports malformed or stale
            // catalog state. Keep unrelated CLI commands available until then.
            return [];
        }
    }
    return [];
}

// Preserve the array identity because existing review-gate consumers capture this
// export during module initialization. Synchronizing its contents lets those
// consumers enforce catalog-backed lanes without changing built-in contracts.
export const REVIEW_CONTRACTS: Array<[string, string]> = BUILT_IN_REVIEW_CONTRACTS
    .map(([reviewId, passToken]): [string, string] => [reviewId, passToken])
    .concat(initializeConfiguredReviewContracts());

function synchronizeReviewContracts(
    requiredReviews: Readonly<Record<string, boolean>>,
    snapshotLanes: EffectiveReviewSnapshot['lanes'] = []
): Array<[string, string]> {
    const builtInIds = new Set<string>(BUILT_IN_REVIEW_CONTRACTS.map(([reviewId]) => reviewId));
    const configuredPassTokens = new Map(REVIEW_CONTRACTS);
    for (const lane of snapshotLanes) {
        configuredPassTokens.set(lane.id, lane.definition.verdict_tokens.pass);
    }
    const customContracts = Object.keys(requiredReviews)
        .filter((reviewId) => !builtInIds.has(reviewId) && REVIEW_ID_PATTERN.test(reviewId))
        .sort()
        .map((reviewId): [string, string] => [
            reviewId,
            configuredPassTokens.get(reviewId) || `${reviewId.toUpperCase().replace(/-/g, ' ')} REVIEW PASSED`
        ]);
    const effectiveContracts: Array<[string, string]> = [
        ...BUILT_IN_REVIEW_CONTRACTS.map(([reviewId, passToken]): [string, string] => [reviewId, passToken]),
        ...customContracts
    ];
    REVIEW_CONTRACTS.splice(0, REVIEW_CONTRACTS.length, ...effectiveContracts);
    return REVIEW_CONTRACTS;
}

export function resolveExpectedReviewVerdicts(
    requiredReviews: Record<string, boolean>,
    verdicts?: Record<string, string>,
    skipReviews?: string[],
    reviewContracts: readonly (readonly [string, string])[] = synchronizeReviewContracts(requiredReviews)
): Record<string, string> {
    const providedVerdicts = verdicts || {};
    const skipSet = new Set((skipReviews || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
    const resolved: Record<string, string> = {};

    for (const [reviewKey, passToken] of reviewContracts) {
        const explicitVerdict = String(providedVerdicts[reviewKey] || '').trim();
        if (explicitVerdict) {
            resolved[reviewKey] = normalizeExplicitReviewVerdict(reviewKey, explicitVerdict, passToken);
            continue;
        }
        resolved[reviewKey] = requiredReviews[reviewKey] && !skipSet.has(reviewKey)
            ? passToken
            : 'NOT_REQUIRED';
    }

    return resolved;
}

function normalizeExplicitReviewVerdict(
    reviewKey: string,
    explicitVerdict: string,
    passToken: string
): string {
    const failToken = passToken.replace(/\bPASSED\b/g, 'FAILED');
    const tokenSet = buildReviewVerdictTokenSet(reviewKey, passToken, failToken);
    if (tokenSet.passTokens.includes(explicitVerdict)) {
        return passToken;
    }
    if (tokenSet.failTokens.includes(explicitVerdict)) {
        return failToken;
    }
    return explicitVerdict;
}

export function parseSkipReviews(value: unknown): string[] {
    if (!value || !String(value).trim()) return [];
    const parts = String(value).trim().toLowerCase().split(/[,; ]+/).filter(s => s.trim());
    return [...new Set(parts)].sort();
}

export function testExpectedVerdict(errors: string[], label: string, required: boolean, skippedByOverride: boolean, actualVerdict: string, passVerdict: string): void {
    if (required && !skippedByOverride) {
        if (actualVerdict !== passVerdict) {
            errors.push(`${label} is required. Expected '${passVerdict}', got '${actualVerdict}'.`);
        }
        return;
    }
    if (skippedByOverride) {
        const allowed = new Set(['NOT_REQUIRED', 'SKIPPED_BY_OVERRIDE', passVerdict]);
        if (!allowed.has(actualVerdict)) {
            const allowedText = [...allowed].sort().join("', '");
            errors.push(`${label} override is active. Expected one of '${allowedText}', got '${actualVerdict}'.`);
        }
        return;
    }
    if (actualVerdict === 'NOT_REQUIRED' || actualVerdict === passVerdict) return;
    errors.push(`${label} is not required. Expected 'NOT_REQUIRED' or '${passVerdict}', got '${actualVerdict}'.`);
}

export function validatePreflightForReview(
    preflightPath: string,
    explicitTaskId: string,
    explicitTaskModePath = '',
    inspection: 'live' | 'frozen-validation-evidence' = 'live'
) {
    let preflight;
    try {
        preflight = JSON.parse(readReviewValidationBytes(preflightPath).toString('utf8'));
    } catch {
        throw new Error(`Preflight artifact is not valid JSON: ${preflightPath}`);
    }

    const errors: string[] = [];
    let resolvedTaskId: string | null = null;
    if (explicitTaskId && explicitTaskId.trim()) {
        try {
            resolvedTaskId = assertValidTaskId(explicitTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(String(message));
        }
    }

    let preflightTaskId: string | null = preflight.task_id != null ? String(preflight.task_id).trim() : '';
    if (preflightTaskId) {
        try {
            preflightTaskId = assertValidTaskId(preflightTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(`preflight.task_id: ${message}`);
            preflightTaskId = null;
        }
    } else {
        preflightTaskId = null;
    }

    if (resolvedTaskId && preflightTaskId && resolvedTaskId !== preflightTaskId) {
        errors.push(`TaskId '${resolvedTaskId}' does not match preflight.task_id '${preflightTaskId}'.`);
    }
    if (!resolvedTaskId && preflightTaskId) resolvedTaskId = preflightTaskId;
    if (!resolvedTaskId) {
        errors.push('TaskId is required and must be provided either via --task-id or preflight.task_id.');
    }

    const requiredReviews = preflight.required_reviews;
    const requiredFlags: Record<string, boolean> = {};
    const requiredKeys = ['code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency'];
    if (!requiredReviews || typeof requiredReviews !== 'object') {
        errors.push('Preflight field `required_reviews` is required and must be an object.');
    }
    for (const key of requiredKeys) {
        const value = requiredReviews ? requiredReviews[key] : undefined;
        if (typeof value !== 'boolean') {
            errors.push(`Preflight field \`required_reviews.${key}\` is required and must be boolean.`);
            requiredFlags[key] = false;
        } else {
            requiredFlags[key] = value;
        }
    }

    let reviewContracts: Array<[string, string]> = synchronizeReviewContracts(requiredFlags)
        .map(([reviewId, passToken]) => [reviewId, passToken]);
    const effectiveReviewSnapshot = preflight.effective_review_snapshot;
    if (effectiveReviewSnapshot === undefined) {
        errors.push('Preflight field `effective_review_snapshot` is required for downstream review routing.');
    } else {
        const snapshotViolations = getEffectiveReviewSnapshotViolations(effectiveReviewSnapshot);
        errors.push(...snapshotViolations);
        if (snapshotViolations.length === 0) {
            const snapshot = effectiveReviewSnapshot as EffectiveReviewSnapshot;
            const snapshotRequiredReviews = snapshot.required_reviews;
            const preflightReviewIds = Object.keys(requiredReviews || {}).sort();
            const snapshotReviewIds = Object.keys(snapshotRequiredReviews).sort();
            if (JSON.stringify(preflightReviewIds) !== JSON.stringify(snapshotReviewIds)) {
                errors.push(
                    'Preflight field `required_reviews` must contain exactly the review ids from ' +
                    '`effective_review_snapshot.required_reviews`.'
                );
            }
            reviewContracts = synchronizeReviewContracts(snapshotRequiredReviews, snapshot.lanes)
                .map(([reviewId, passToken]) => [reviewId, passToken]);
            for (const [reviewId, required] of Object.entries(snapshotRequiredReviews)) {
                requiredFlags[reviewId] = required;
                if (requiredReviews?.[reviewId] !== required) {
                    errors.push(
                        `Preflight required_reviews.${reviewId} does not match effective_review_snapshot.required_reviews.${reviewId}.`
                    );
                }
            }
            try {
                const bundleRoot = path.dirname(path.dirname(path.dirname(path.resolve(preflightPath))));
                const repoRoot = path.dirname(bundleRoot);
                const knownReviewSkillIds = collectKnownReviewSkillIds(
                    readSkillsHeadlinesIfPresent(bundleRoot)?.payload.skills
                );
                const currentCatalog = readReviewCatalogConfigFile(
                    path.join(bundleRoot, 'live', 'config', 'review-catalog.json'),
                    { knownSkillIds: knownReviewSkillIds }
                );
                const defaultTaskModePath = path.join(
                    path.dirname(path.resolve(preflightPath)),
                    `${resolvedTaskId}-task-mode.json`
                );
                const taskModePath = explicitTaskModePath.trim()
                    ? resolvePathInsideRepo(
                        explicitTaskModePath,
                        path.dirname(bundleRoot),
                        { enforceInside: true }
                    )
                    : defaultTaskModePath;
                if (!taskModePath) {
                    throw new Error('Task-mode artifact path must resolve inside the repository root.');
                }
                const taskMode = JSON.parse(readReviewValidationBytes(taskModePath).toString('utf8'));
                const frozenProfileSnapshot = taskMode.profile_policy_snapshot;
                if (frozenProfileSnapshot == null) {
                    if (taskMode.profile_policy_snapshot_required === true) {
                        throw new Error(
                            'Task-mode artifact requires a frozen profile policy snapshot, but none is present.'
                        );
                    }
                    const currentCapabilities = readReviewCapabilitiesConfigFile(
                        path.join(bundleRoot, 'live', 'config', 'review-capabilities.json')
                    );
                    const compatibilityBinding = resolveLegacyCompatibilityReviewCatalogBinding(
                        currentCapabilities,
                        currentCatalog
                    );
                    const reviewExecutionPolicy = loadReviewExecutionPolicyConfig(repoRoot);
                    const fullSuiteValidation = loadFullSuiteValidationConfig(repoRoot);
                    assertEffectiveReviewSnapshotCurrent(
                        snapshot,
                        currentCatalog,
                        compatibilityBinding.profile_snapshot_sha256,
                        compatibilityBinding.profile_policy,
                        {
                            mode: reviewExecutionPolicy.mode,
                            review_dependency_graph: null,
                            full_suite_validation: fullSuiteValidation
                        }
                    );
                } else {
                    const currentProfilePolicy = resolveProfileReviewCatalogPolicy(
                        frozenProfileSnapshot.source.effective_profile,
                        frozenProfileSnapshot.review_lane_selection.profile_review_policy,
                        frozenProfileSnapshot.review_lane_selection.review_capabilities,
                        currentCatalog
                    );
                    const liveProfileSnapshot = buildLiveTaskProfilePolicySnapshot(bundleRoot, frozenProfileSnapshot);
                    // Reading authenticated facts on the pinned preflight grants no new review launch or adoption.
                    // It must remain possible to finish an already-started reviewer while a lane-only proposal waits.
                    try {
                        assertReviewProfileInputsCurrent(frozenProfileSnapshot, liveProfileSnapshot, currentCatalog);
                    } catch (error) {
                        if (inspection !== 'frozen-validation-evidence') throw error;
                        const proposal = readReviewPolicyAdoption(bundleRoot, frozenProfileSnapshot);
                        if (!proposal.snapshot || proposal.unadoptableChanges.length > 0) throw error;
                    }
                    assertEffectiveReviewSnapshotCurrent(
                        snapshot,
                        currentCatalog,
                        String(frozenProfileSnapshot.snapshot_hash || '').trim().toLowerCase(),
                        currentProfilePolicy,
                        frozenProfileSnapshot.review_execution_policy
                    );
                }
            } catch (error: unknown) {
                errors.push(error instanceof Error ? error.message : String(error));
            }
        }
    }

    return {
        preflight,
        resolved_task_id: resolvedTaskId,
        required_reviews: requiredFlags,
        review_contracts: reviewContracts,
        preflight_path: path.resolve(preflightPath),
        preflight_hash: fileSha256(path.resolve(preflightPath)),
        errors
    };
}

function buildLiveTaskProfilePolicySnapshot(
    bundleRoot: string,
    frozenSnapshot: TaskProfilePolicySnapshot
): TaskProfilePolicySnapshot {
    return rebuildTaskProfilePolicySnapshot(bundleRoot, frozenSnapshot, frozenSnapshot.lock_timestamp_utc);
}

/**
 * The frozen snapshot rebuilt from the current review-policy inputs. The task's own profile, review execution,
 * full-suite and follow-up closure choices stay as frozen, so only the inputs the drift check compares can change.
 */
export function rebuildTaskProfilePolicySnapshot(
    bundleRoot: string,
    frozenSnapshot: TaskProfilePolicySnapshot,
    lockTimestampUtc: string
): TaskProfilePolicySnapshot {
    return buildTaskProfilePolicySnapshot(bundleRoot, frozenSnapshot.source.task_profile, {
        reviewExecutionPolicyMode: frozenSnapshot.review_execution_policy.mode,
        reviewExecutionPolicyConfigured: frozenSnapshot.review_execution_policy.configured,
        fullSuiteValidationEnabled: frozenSnapshot.review_execution_policy.full_suite_validation?.enabled,
        fullSuiteValidationPlacement: frozenSnapshot.review_execution_policy.full_suite_validation?.placement,
        reviewFollowUpTaskClosurePolicy: frozenSnapshot.review_follow_up_task_closure_policy,
        lockTimestampUtc
    });
}

/**
 * Names the review-policy inputs that changed since a task-mode snapshot froze them, or returns null.
 * Review routing refuses on it; operator-approved task-mode re-entry adopts the changed inputs only when it is set.
 */
export function readTaskProfilePolicyDrift(bundleRoot: string, frozenSnapshot: TaskProfilePolicySnapshot): string | null {
    const currentCatalog = readReviewCatalogConfigFile(
        path.join(bundleRoot, 'live', 'config', 'review-catalog.json'),
        { knownSkillIds: collectKnownReviewSkillIds(readSkillsHeadlinesIfPresent(bundleRoot)?.payload.skills) }
    );
    return describeReviewProfileInputDrift(
        frozenSnapshot, buildLiveTaskProfilePolicySnapshot(bundleRoot, frozenSnapshot), currentCatalog
    );
}

/** Frozen validation facts may finish a started reviewer; fresh preparation requires live policy inputs. */
export function assertFreshReviewPolicyInputs(bundleRoot: string, frozenSnapshot: TaskProfilePolicySnapshot): void {
    const drift = readTaskProfilePolicyDrift(bundleRoot, frozenSnapshot);
    if (drift) throw new Error(`Task profile policy inputs changed after preflight (${drift}). `
        + 'Run next-step to show the review-lane changes and the operator-approved adoption command, or revert the change. '
        + 'Generate a fresh preflight after adoption before preparing a new reviewer.');
}

export interface ReviewPolicyAdoption {
    /** The drift the POST_PREFLIGHT refusal reports, or null when the frozen policy is current. */
    drift: string | null;
    /** Review-lane settings the adoption would change, as `lane: before -> after`. */
    laneChanges: string[];
    /** Snapshot fields outside review-lane selection that also changed; any of them makes the drift unadoptable. */
    unadoptableChanges: string[];
    /**
     * Binds an operator's approval to exactly this proposal: the frozen snapshot it replaces and the review-lane
     * selection and config hashes it adopts. Any later change to the proposal changes the digest.
     */
    digest: string | null;
    snapshot: TaskProfilePolicySnapshot | null;
}

// Bookkeeping that differs for every rebuild, and the review-lane selection an operator approves.
const ADOPTABLE_SNAPSHOT_FIELDS = new Set(['lock_timestamp_utc', 'config_hashes', 'config_hash', 'snapshot_hash', 'review_lane_selection']);
// Config files whose effect on the task is compared field by field; any other changed file hash is a change the
// operator would not see (for example workflow-config.json, which later gates trust through this snapshot).
const ADOPTABLE_CONFIG_HASHES = new Set(['profiles', 'review_capabilities']);

function describeChangedEntries(label: string, before: unknown, after: unknown): string[] {
    const left = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
    const right = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
        .filter((key) => canonicalJson(left[key]) !== canonicalJson(right[key]))
        .map((key) => `${label}${key}: ${canonicalJson(left[key] ?? null)} -> ${canonicalJson(right[key] ?? null)}`);
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * What adopting the current review-policy inputs would freeze for a task. Adoption covers review-lane selection
 * only: a rebuilt snapshot that also changes another part of the policy (finding policy, depth, triggers, the
 * effective profile and so on) is reported as unadoptable instead of being adopted unseen.
 */
export function readReviewPolicyAdoption(
    bundleRoot: string,
    frozenSnapshot: TaskProfilePolicySnapshot,
    lockTimestampUtc = frozenSnapshot.lock_timestamp_utc
): ReviewPolicyAdoption {
    const drift = readTaskProfilePolicyDrift(bundleRoot, frozenSnapshot);
    if (!drift) return { drift: null, laneChanges: [], unadoptableChanges: [], digest: null, snapshot: null };
    const snapshot = rebuildTaskProfilePolicySnapshot(bundleRoot, frozenSnapshot, lockTimestampUtc);
    const frozen = frozenSnapshot as unknown as Record<string, unknown>;
    const rebuilt = snapshot as unknown as Record<string, unknown>;
    const unadoptableChanges = [...new Set([...Object.keys(frozen), ...Object.keys(rebuilt)])].sort()
        .filter((key) => !ADOPTABLE_SNAPSHOT_FIELDS.has(key))
        .filter((key) => {
            if (key !== 'source') return canonicalJson(frozen[key]) !== canonicalJson(rebuilt[key]);
            // The workspace's own active profile is informational; the task's effective profile is not.
            const { runtime_active_profile: _a, runtime_profile_source: _b, ...frozenSource } = frozenSnapshot.source;
            const { runtime_active_profile: _c, runtime_profile_source: _d, ...rebuiltSource } = snapshot.source;
            return canonicalJson(frozenSource) !== canonicalJson(rebuiltSource);
        });
    for (const key of [...new Set([...Object.keys(frozenSnapshot.config_hashes), ...Object.keys(snapshot.config_hashes)])].sort()) {
        if (!ADOPTABLE_CONFIG_HASHES.has(key) && frozenSnapshot.config_hashes[key] !== snapshot.config_hashes[key]) {
            unadoptableChanges.push(`config_hashes.${key}`);
        }
    }
    const before = frozenSnapshot.review_lane_selection;
    const after = snapshot.review_lane_selection;
    // Every lane-selection difference is shown, so a lost lane cannot hide behind a stricter-looking one.
    const laneChanges = [
        ...describeChangedEntries('', before.profile_review_policy, after.profile_review_policy),
        ...describeChangedEntries('capability ', before.review_capabilities, after.review_capabilities),
        ...describeChangedEntries('active ', before.effective_review_policy, after.effective_review_policy),
        ...(canonicalJson(before.safety_floors_applied) === canonicalJson(after.safety_floors_applied) ? []
            : [`safety floors: ${canonicalJson(before.safety_floors_applied)} -> ${canonicalJson(after.safety_floors_applied)}`])
    ];
    if (laneChanges.length === 0) unadoptableChanges.push('no visible review-lane change to approve');
    const digest = createHash('sha256').update(canonicalJson({
        frozen_snapshot_hash: frozenSnapshot.snapshot_hash,
        review_lane_selection: after,
        config_hashes: snapshot.config_hashes
    })).digest('hex');
    return { drift, laneChanges, unadoptableChanges, digest, snapshot };
}

function assertReviewProfileInputsCurrent(
    frozenSnapshot: TaskProfilePolicySnapshot,
    liveSnapshot: TaskProfilePolicySnapshot,
    currentCatalog: Parameters<typeof resolveProfileReviewCatalogPolicy>[3]
): void {
    const inputDetails = describeReviewProfileInputDrift(frozenSnapshot, liveSnapshot, currentCatalog);
    if (inputDetails) {
        throw new Error(
            `Task profile policy inputs changed after preflight (${inputDetails}). ` +
            'The task keeps the review policy frozen at task-mode entry: revert the change, or after the operator ' +
            'approves it re-enter task mode with --adopt-changed-review-policy and fresh operator confirmation, ' +
            'then generate a fresh preflight before review routing.'
        );
    }
}

function describeReviewProfileInputDrift(
    frozenSnapshot: TaskProfilePolicySnapshot,
    liveSnapshot: TaskProfilePolicySnapshot,
    currentCatalog: Parameters<typeof resolveProfileReviewCatalogPolicy>[3]
): string | null {
    const profileInputKeys = ['profiles', 'review_capabilities', 'token_economy', 'skill_packs', 'paths'];
    const changedInputs = profileInputKeys.filter(
        (key) => frozenSnapshot.config_hashes[key] !== liveSnapshot.config_hashes[key]
    ).filter((key) => key !== 'profiles');
    const frozenPolicy = resolveProfileReviewCatalogPolicy(
        frozenSnapshot.source.effective_profile,
        frozenSnapshot.review_lane_selection.profile_review_policy,
        frozenSnapshot.review_lane_selection.review_capabilities,
        currentCatalog
    );
    const livePolicy = resolveProfileReviewCatalogPolicy(
        liveSnapshot.source.effective_profile,
        liveSnapshot.review_lane_selection.profile_review_policy,
        liveSnapshot.review_lane_selection.review_capabilities,
        currentCatalog
    );
    if (changedInputs.length === 0 && livePolicy.policy_sha256 === frozenPolicy.policy_sha256) return null;
    return changedInputs.length > 0 ? changedInputs.join(', ') : 'review lane policy';
}
