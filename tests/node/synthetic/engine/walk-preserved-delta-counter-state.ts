import { isPlainRecord } from '../../../../src/core/records';
import type { WalkResult } from './navigator-walk';

export const PRESERVED_DELTA_COUNTER_STATE = 'native-v4-preserved-delta-origin-chain';
export const TWO_SOURCE_API_INITIAL_STATE = 'native-v4-two-source-api-initial';
export const TWO_SOURCE_API_REMEDIATION_STATE = 'native-v4-two-source-api-remediation';
const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** A second production file is a distinct bounded input even before any DELTA is preserved. */
export function hasTwoSourceApiCounterInputs(events: WalkResult['events'], taskId = 'T-WALK'): boolean {
    let entryIndex = -1;
    for (let index = events.length - 1; index >= 0; index--) if (events[index].type === 'TASK_MODE_ENTERED') { entryIndex = index; break; }
    if (entryIndex < 0 || events[entryIndex].details.profile_policy_snapshot_required !== true
        || !digest(events[entryIndex].details.profile_policy_snapshot_hash)) return false;
    const current = events.slice(entryIndex + 1);
    if (current.some(event => ['TASK_RESET', 'TASK_DISCARDED'].includes(event.type))) return false;
    const preflight = [...current].reverse().find(event => event.type === 'PREFLIGHT_CLASSIFIED');
    const required = preflight?.details.required_reviews;
    if (!preflight || preflight.details.changed_files_count !== 3 || !digest(preflight.details.output_sha256)
        || typeof preflight.details.output_path !== 'string' || preflight.details.output_path.replace(/\\/gu, '/').split('/').at(-1) !== taskId + '-preflight.json'
        || !isPlainRecord(required) || Object.entries(required).filter(([, value]) => value === true).map(([lane]) => lane).sort().join('+') !== 'api+code+test') return false;
    return current.some(event => {
        const value = event.details, validation = value.review_findings_validation, disposition = value.review_findings_disposition;
        const domains = isPlainRecord(value.domain_scope_fingerprints) && value.domain_scope_fingerprints.domains;
        return event.type === 'REVIEW_RECORDED' && value.task_id === taskId && value.review_type === 'code'
            && ['FULL', 'DELTA'].includes(String(value.review_execution_mode)) && value.preflight_sha256 === preflight.details.output_sha256
            && digest(value.receipt_sha256) && digest(value.review_artifact_sha256) && digest(value.review_execution_contract_sha256)
            && isPlainRecord(validation) && validation.status === 'accepted' && validation.accepted === true
            && isPlainRecord(disposition) && disposition.blocking_count === 0
            && isPlainRecord(domains) && isPlainRecord(domains.implementation) && domains.implementation.changed_files_count === 2
            && isPlainRecord(domains.test) && domains.test.changed_files_count === 1;
    });
}

/** Select by native proof inputs, never by measured cost, elapsed time or a scenario name. */
export function hasPreservedDeltaCounterInputs(events: WalkResult['events'], taskId = 'T-WALK'): boolean {
    const lastIndex = (predicate: (event: WalkResult['events'][number], index: number) => boolean): number => {
        for (let index = events.length - 1; index >= 0; index--) if (predicate(events[index], index)) return index;
        return -1;
    };
    const latestIndex = lastIndex(event => event.type === 'REVIEW_CYCLE_RESTARTED');
    if (latestIndex < 0) return false;
    const latest = events[latestIndex].details, decision = latest.authoritative_review_decision;
    if (latest.task_id !== taskId || latest.status !== 'PASSED' || latest.planned_changed_files_count !== 3 || !isPlainRecord(decision)
        || decision.task_id !== latest.task_id
        || decision.status !== 'READY' || decision.current_review_type !== 'test' || decision.category !== 'leaf_test'
        || !digest(decision.decision_sha256) || !digest(decision.classification_sha256)
        || !digest(decision.preflight_sha256) || decision.preflight_sha256 !== latest.preflight_sha256
        || !Array.isArray(decision.lane_decisions)) return false;
    const entryIndex = lastIndex(event => event.type === 'TASK_MODE_ENTERED');
    const entry = events[entryIndex];
    if (!entry || entry.details.profile_policy_snapshot_required !== true
        || !digest(entry.details.profile_policy_snapshot_hash)
        || entry.details.profile_policy_snapshot_hash !== decision.profile_policy_snapshot_sha256 || entryIndex >= latestIndex
        || events.slice(entryIndex + 1).some(event => /^(?:TASK_RESET|TASK_DISCARDED|TASK_MODE_RESET)(?:_|$)/u.test(event.type))) return false;
    const preflight = [...events].reverse().find(event => event.type === 'PREFLIGHT_CLASSIFIED');
    const required = preflight?.details.required_reviews;
    if (!preflight || preflight.details.output_sha256 !== latest.preflight_sha256 || preflight.details.changed_files_count !== 3
        || !isPlainRecord(required) || Object.entries(required).filter(([, value]) => value === true).map(([lane]) => lane).sort().join('+') !== 'api+code+test') return false;
    for (const lane of ['code', 'api']) {
        const preserved = decision.lane_decisions.find(value => isPlainRecord(value) && value.review_type === lane);
        if (!isPlainRecord(preserved) || preserved.invalidated !== false || preserved.reuse_eligible !== true) return false;
    }
    const originIndex = lastIndex((event, index) => index > entryIndex && index < latestIndex && event.type === 'REVIEW_CYCLE_RESTARTED'
        && isPlainRecord(event.details.authoritative_review_decision) && event.details.authoritative_review_decision.category === 'production');
    if (originIndex < 0) return false;
    const origin = events[originIndex].details.authoritative_review_decision;
    if (!isPlainRecord(origin) || origin.status !== 'READY' || origin.task_id !== latest.task_id
        || events[originIndex].details.task_id !== latest.task_id
        || origin.profile_policy_snapshot_sha256 !== decision.profile_policy_snapshot_sha256 || !digest(origin.decision_sha256)
        || !digest(origin.classification_sha256) || !Array.isArray(origin.lane_decisions)) return false;
    const originLanes = origin.lane_decisions;
    return ['code', 'api'].every(lane => {
        const invalidated = originLanes.find(value => isPlainRecord(value) && value.review_type === lane);
        if (!isPlainRecord(invalidated) || invalidated.mode !== 'DELTA' || invalidated.invalidated !== true) return false;
        return events.slice(originIndex + 1, latestIndex).some(event => {
            const value = event.details, validation = value.review_findings_validation, disposition = value.review_findings_disposition;
            const domains = isPlainRecord(value.domain_scope_fingerprints) && value.domain_scope_fingerprints.domains;
            return event.type === 'REVIEW_RECORDED' && value.task_id === taskId && value.review_type === lane && value.review_execution_mode === 'DELTA'
                && value.preflight_sha256 === events[originIndex].details.preflight_sha256
                && digest(value.receipt_sha256) && digest(value.review_execution_contract_sha256) && digest(value.review_artifact_sha256)
                && isPlainRecord(validation) && validation.accepted === true && validation.status === 'accepted'
                && isPlainRecord(disposition) && disposition.blocking_count === 0
                && isPlainRecord(domains) && isPlainRecord(domains.implementation) && domains.implementation.changed_files_count === 2
                && isPlainRecord(domains.test) && domains.test.changed_files_count === 1;
        });
    });
}
