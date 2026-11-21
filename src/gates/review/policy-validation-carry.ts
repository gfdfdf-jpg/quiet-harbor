import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { readImmutableValidationEventSnapshot } from '../project-validation/attempt-evidence';
import { computeTaskCriteriaBinding } from '../review-context/review-context-task-criteria-binding';
import { buildReviewTreeState } from './review-tree-state';
import type { TaskAuditEvent } from '../task-audit/task-audit-summary-lifecycle';

type Snapshot = ReturnType<typeof readImmutableValidationEventSnapshot>;

export interface PolicyValidationCarry {
    source_mode_sequence: number;
    source_preflight_sequence: number;
    source_preflight_path: string;
    source_preflight_sha256: string;
    scope_sha256: string;
    scope_content_sha256: string;
    state_sha256: string;
}

function stateBinding(repoRoot: string, taskId: string, current: Snapshot): string {
    const preflight = JSON.parse(readValidationFile(repoRoot,
        path.relative(repoRoot, current.preflight_path).replace(/\\/gu, '/')).bytes.toString('utf8')) as Record<string, unknown>;
    const tree = buildReviewTreeState({ repoRoot, detectionSource: preflight.detection_source,
        includeUntracked: true, changedFiles: current.changed_files });
    // Entries bind both index and worktree bytes/status without making review-lane policy part of code identity.
    return validationDigest({ use_staged: tree.use_staged, files: [...current.changed_files].sort(),
        entries: tree.entries, criteria: computeTaskCriteriaBinding({ repoRoot, taskId, preflight }).sha256 });
}

/** Read the carry recorded by task-mode gates in an operator-approved policy epoch.
 * The adoption gate checked the operator's proposal digest; recovery may capture only fresh facts in that epoch.
 * Timeline integrity authenticates this record; this reader does not replay operator approval.
 * Ordinary re-entry never creates a carry window.
 */
export function readPolicyValidationCarry(repoRoot: string, taskId: string, current: Snapshot): PolicyValidationCarry | null {
    const modes = current.events.filter(event => event.event_type === 'TASK_MODE_ENTERED');
    let adoptionIndex = -1;
    for (let index = modes.length - 1; index >= 0; index--) {
        if (isPlainRecord(modes[index].details?.review_policy_adoption)) { adoptionIndex = index; break; }
    }
    if (adoptionIndex < 1) return null;
    const adopted = modes[adoptionIndex], adoption = adopted.details!.review_policy_adoption;
    if (!isPlainRecord(adoption) || !/^[a-f0-9]{64}$/u.test(String(adoption.approved_digest))
        || adoption.previous_snapshot_hash !== modes[adoptionIndex - 1].details?.profile_policy_snapshot_hash
        || adoption.previous_snapshot_hash === adopted.details?.profile_policy_snapshot_hash
        || !/^[a-f0-9]{64}$/u.test(String(adopted.details?.profile_policy_snapshot_hash))
        || modes.slice(adoptionIndex).some(mode => mode.details?.profile_policy_snapshot_hash !== adopted.details?.profile_policy_snapshot_hash))
        return null;
    const recovery = modes.slice(adoptionIndex + 1).filter(mode => isPlainRecord(mode.details?.review_policy_validation_carry)).at(-1);
    const anchor = recovery ?? adopted;
    const value = recovery?.details?.review_policy_validation_carry ?? adoption.validation_carry;
    if (!isPlainRecord(value) || !Number.isSafeInteger(value.source_mode_sequence)
        || !Number.isSafeInteger(value.source_preflight_sequence) || typeof value.source_preflight_path !== 'string'
        || ['source_preflight_sha256', 'scope_sha256', 'scope_content_sha256', 'state_sha256']
            .some(key => !/^[a-f0-9]{64}$/u.test(String(value[key])))) return null;
    const carry = value as unknown as PolicyValidationCarry;
    const mode = modes.find(event => event.integrity?.task_sequence === carry.source_mode_sequence);
    if (!mode) return null;
    const windowModes = modes.slice(modes.indexOf(mode));
    for (let index = 1; index < windowModes.length; index++) {
        const previous = windowModes[index - 1], next = windowModes[index];
        if (previous.details?.profile_policy_snapshot_hash === next.details?.profile_policy_snapshot_hash) continue;
        const recorded = next.details?.review_policy_adoption;
        if (!isPlainRecord(recorded) || recorded.previous_snapshot_hash !== previous.details?.profile_policy_snapshot_hash
            || !/^[a-f0-9]{64}$/u.test(String(recorded.approved_digest))
            || !isPlainRecord(recorded.validation_carry)
            || validationDigest(recorded.validation_carry) !== validationDigest(carry)) return null;
    }
    const classified = current.events.find(event => event.event_type === 'PREFLIGHT_CLASSIFIED'
        && event.integrity?.task_sequence === carry.source_preflight_sequence);
    if (!classified || carry.source_mode_sequence >= carry.source_preflight_sequence
        || carry.source_preflight_sequence >= Number(anchor.integrity?.task_sequence)
        || recovery && carry.source_mode_sequence < Number(adopted.integrity?.task_sequence)
        || path.resolve(repoRoot, String(classified.details?.output_path ?? '')) !== path.resolve(repoRoot, carry.source_preflight_path)
        || classified.details?.output_sha256 !== carry.source_preflight_sha256
        || classified.details?.scope_sha256 !== carry.scope_sha256
        || classified.details?.scope_content_sha256 !== carry.scope_content_sha256
        || current.scope_content_sha256 !== carry.scope_content_sha256
        || stateBinding(repoRoot, taskId, current) !== carry.state_sha256) return null;
    return carry;
}

/** Each carried execution keeps its own classification, including reruns after an earlier adoption. */
export function readCarriedExecutionPreflight(current: Snapshot, carry: PolicyValidationCarry,
    event: TaskAuditEvent, repoRoot: string): PolicyValidationCarry | null {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
    const details = isPlainRecord(event.details) ? event.details : {};
    const sequence = Number(integrity.task_sequence);
    const preceding = current.events.filter(item => Number(item.integrity?.task_sequence) < sequence);
    const classified = preceding.filter(item => item.event_type === 'PREFLIGHT_CLASSIFIED').at(-1);
    const mode = preceding.filter(item => item.event_type === 'TASK_MODE_ENTERED').at(-1);
    const data = classified?.details;
    const profile = data?.profile_policy_snapshot;
    if (!classified || !mode || !isPlainRecord(profile)
        || Number(classified.integrity?.task_sequence) < carry.source_preflight_sequence
        || Number(mode.integrity?.task_sequence) < carry.source_mode_sequence
        || Number(mode.integrity?.task_sequence) >= Number(classified.integrity?.task_sequence)
        || profile.snapshot_hash !== mode.details?.profile_policy_snapshot_hash
        || data?.scope_content_sha256 !== carry.scope_content_sha256
        || typeof data.output_path !== 'string' || !/^[a-f0-9]{64}$/u.test(String(data.output_sha256))
        || details.preflight_sha256 !== data.output_sha256
        || path.resolve(repoRoot, String(details.preflight_path ?? '')) !== path.resolve(repoRoot, data.output_path)) return null;
    return { ...carry, source_preflight_sequence: Number(classified.integrity?.task_sequence),
        source_preflight_path: path.relative(repoRoot, path.resolve(repoRoot, data.output_path)).replace(/\\/gu, '/'),
        source_preflight_sha256: String(data.output_sha256) };
}

/** Capture before task-mode/preflight artifacts are replaced; the caller publishes this only after approved adoption. */
export function capturePolicyValidationCarry(repoRoot: string, taskId: string, recovery = false): PolicyValidationCarry | null {
    try {
        const current = readImmutableValidationEventSnapshot(repoRoot, taskId);
        const inherited = readPolicyValidationCarry(repoRoot, taskId, current);
        if (inherited) return recovery ? null : inherited;
        const mode = current.events.filter(event => event.event_type === 'TASK_MODE_ENTERED').at(-1);
        const classified = current.events.find(event => event.integrity?.task_sequence === current.preflight_sequence);
        const scope = classified?.details?.scope_sha256;
        if (recovery) {
            // Legacy adoptions grant no authority for their older runs. Only the fresh classification in
            // the adopted epoch can seed a recovery carry; ordinary re-entry without adoption cannot.
            const modes = current.events.filter(event => event.event_type === 'TASK_MODE_ENTERED');
            const adoptionIndex = modes.map(event => isPlainRecord(event.details?.review_policy_adoption)).lastIndexOf(true);
            const adopted = modes[adoptionIndex], adoption = adopted?.details?.review_policy_adoption;
            if (adoptionIndex < 1 || !isPlainRecord(adoption)
                || !/^[a-f0-9]{64}$/u.test(String(adoption.approved_digest))
                || adoption.previous_snapshot_hash !== modes[adoptionIndex - 1].details?.profile_policy_snapshot_hash
                || adoption.previous_snapshot_hash === adopted.details?.profile_policy_snapshot_hash
                || modes.slice(adoptionIndex).some(event => event.details?.profile_policy_snapshot_hash !== mode?.details?.profile_policy_snapshot_hash)) return null;
        }
        const preflight = JSON.parse(readValidationFile(repoRoot,
            path.relative(repoRoot, current.preflight_path).replace(/\\/gu, '/')).bytes.toString('utf8')) as Record<string, unknown>;
        if (mode?.integrity?.task_sequence == null || typeof scope !== 'string' || !/^[a-f0-9]{64}$/u.test(scope)
            || classified?.details?.output_sha256 !== current.preflight_sha256
            || classified.details.task_criteria_sha256 !== computeTaskCriteriaBinding({ repoRoot, taskId, preflight }).sha256) return null;
        return { source_mode_sequence: mode.integrity.task_sequence, source_preflight_sequence: current.preflight_sequence,
            source_preflight_path: path.relative(repoRoot, current.preflight_path).replace(/\\/gu, '/'), source_preflight_sha256: current.preflight_sha256,
            scope_sha256: scope, scope_content_sha256: current.scope_content_sha256,
            state_sha256: stateBinding(repoRoot, taskId, current) };
    } catch {
        // Missing/stale evidence grants no carry authority and keeps normal task-mode entry behavior.
        return null;
    }
}

