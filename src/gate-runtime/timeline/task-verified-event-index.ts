/** Invocation-private selections over the canonical, fully verified parser records. */
import type { TaskEventIntegrity } from './task-events-io-types';
import { parseTimestamp } from '../../core/event-timestamps';
import { countNextStepWork } from '../../core/next-step-measurement';
import type { TaskTimelineDeepReadonly } from './task-timeline-read-snapshot';
import { isIntermediateExecutionEpochBoundary, readIntermediateExecutionClassification } from '../../core/intermediate-execution-preflight-identity';
import { normalizePath } from '../../core/orchestrator-paths';

/** Structural projection for navigation without an upward gate dependency. */
export interface IndexedTimelineEvent {
    event_type: string;
    outcome?: string;
    timestamp_utc: string;
    sequence: number;
    details: Record<string, unknown> | null;
    integrity?: TaskEventIntegrity | null;
}

type Event = TaskTimelineDeepReadonly<Record<string, unknown>>;
export interface VerifiedTaskEventIndex {
    readonly normalizedEvents: readonly IndexedTimelineEvent[];
    readonly startBytes: readonly number[];
    readonly events: readonly Event[];
    readonly ordered: readonly Event[];
    readonly lastIndexByType: Readonly<Record<string, number>>;
    readonly byType: Readonly<Record<string, readonly Event[]>>;
    readonly byTrimmedType: Readonly<Record<string, readonly Event[]>>;
    readonly taskModeBoundaries: readonly number[];
    readonly reviewCycleBoundaries: readonly number[];
    readonly latestCompileSequence: number | null;
    readonly latestFocusedTaskModeSequence: number | null;
}
const indices = new WeakMap<object, VerifiedTaskEventIndex>();
const positions = new WeakMap<object, number>();
const normalizedTypes = new WeakMap<object, Readonly<Record<string, readonly IndexedTimelineEvent[]>>>();
const empty: readonly Event[] = Object.freeze([]);
const sourceNormalizedTypes = new WeakMap<object, Readonly<Record<string, readonly Event[]>>>();
const selectionViews = new WeakMap<VerifiedTaskEventIndex, Map<string, readonly Event[]>>();
interface SelectionOptions { trimmed?: boolean; normalized?: boolean; ordered?: boolean; fromPosition?: number }
function selectionKey(types: readonly string[], options: SelectionOptions): string {
    return JSON.stringify([!!options.trimmed, !!options.normalized, !!options.ordered, [...new Set(types)].sort(),
        options.fromPosition ?? 0]);
}
/** Native type lists are in position order; a bounded backward scan selects the current suffix. */
function suffixFromPosition(list: readonly Event[], fromPosition: number): readonly Event[] {
    if (fromPosition <= 0 || !list.length) return list;
    let cursor = list.length;
    while (cursor > 0) {
        countNextStepWork('visit:verified_timeline_range_candidate');
        if (positions.get(list[cursor - 1])! < fromPosition) break;
        cursor--;
    }
    return cursor === 0 ? list : Object.freeze(list.slice(cursor));
}
// Native validation consumers share these composed views from the canonical pass.
// No consumer walks/copies the same evidence events again just to merge event types.
const nativeSelections: Array<{ types: readonly string[]; options: SelectionOptions }> = [
    { types: ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED', 'TEST_FIRST_EXPECTED_FAILURE_RECORDED', 'REVIEW_RECORDED'], options: {} },
    { types: ['INTERMEDIATE_COMMAND_RUN', 'INTERMEDIATE_COMMAND_STARTED'], options: { ordered: true } },
    { types: ['INTERMEDIATE_COMMAND_RUN', 'PROJECT_VALIDATION_RESULTS_EVALUATED'], options: { trimmed: true, ordered: true } },
    { types: ['QUALITY_CHECKLIST_RECORDED', 'REVIEW_RECORDED'], options: {} },
    { types: ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE'], options: { trimmed: true, ordered: true } }
];
export function verifiedIndexForEvents(events: readonly object[]): VerifiedTaskEventIndex | null {
    return indices.get(events) ?? null;
}
export function bindVerifiedEventIndex(events: readonly object[], index: VerifiedTaskEventIndex): void {
    indices.set(events, index);
}
export function beginVerifiedEventIndexPass() {
    const currentEvidence = beginCurrentEvidenceIndexPass();
    const recovery = beginRecoveryIndexPass();
    const qualityBindings = beginQualityBindingIndexPass();
    const startBytes: number[] = [];
    const normalizedEvents: IndexedTimelineEvent[] = [];
    const normalizedByType: Record<string, IndexedTimelineEvent[]> = Object.create(null);
    const sourceByNormalizedType: Record<string, Event[]> = Object.create(null);
    const events: Event[] = [], lastIndexByType: Record<string, number> = Object.create(null);
    const byType: Record<string, Event[]> = Object.create(null), byTrimmedType: Record<string, Event[]> = Object.create(null);
    const taskModeBoundaries: number[] = [], reviewCycleBoundaries: number[] = [];
    const composed = nativeSelections.map(definition => ({ ...definition,
        key: selectionKey(definition.types, definition.options), members: new Set(definition.types), events: [] as Event[] }));
    let monotonic = true, previousTime = -Infinity;
    let latestCompileSequence: number | null = null;
    let latestFocusedTaskModeSequence: number | null = null;
    return {
        accept(event: Event, startByte: number): void {
            countNextStepWork('visit:verified_timeline_index_event');
            const position = events.length, type = String(event.event_type || '');
            startBytes.push(startByte);
            positions.set(event, position); events.push(event);
            for (const group of composed) if (group.members.has(group.options.trimmed ? type.trim() : type)) group.events.push(event);
            if (event.event_type === 'COMPILE_GATE_PASSED') {
                const raw = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
                    ? event.integrity as Record<string, unknown> : null;
                const sequence = Number(raw?.task_sequence);
                if (Number.isInteger(sequence) && sequence > 0)
                    latestCompileSequence = Math.max(latestCompileSequence ?? 0, sequence);
            }
            // Validation boundaries use strict equality, unlike telemetry's string coercion.
            if (typeof event.event_type === 'string') lastIndexByType[event.event_type] = position;
            (byType[type] ??= []).push(event); (byTrimmedType[type.trim()] ??= []).push(event);
            const normalizedType = type.trim().toUpperCase();
            currentEvidence.accept(event, position, normalizedType);
            qualityBindings.accept(event, position, startByte, type);
            if (normalizedType) {
                const raw = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
                    ? event.integrity as Record<string, unknown> : null;
                const sequence = typeof raw?.task_sequence === 'number' ? raw.task_sequence : Number(raw?.task_sequence);
                if (type.trim() === 'TASK_MODE_ENTERED' && typeof raw?.task_sequence === 'number'
                    && Number.isInteger(raw.task_sequence) && raw.task_sequence >= 0)
                    latestFocusedTaskModeSequence = Math.max(latestFocusedTaskModeSequence ?? 0, raw.task_sequence);
                const sha = String(raw?.event_sha256 || '').trim().toLowerCase();
                const previous = raw?.prev_event_sha256 == null ? null : String(raw.prev_event_sha256).trim().toLowerCase() || null;
                const integrity = raw && Number.isInteger(sequence) && sequence > 0 && /^[0-9a-f]{64}$/.test(sha)
                    && (previous == null || /^[0-9a-f]{64}$/.test(previous))
                    ? { schema_version: typeof raw.schema_version === 'number' ? raw.schema_version : Number(raw.schema_version) || 1,
                        task_sequence: sequence, prev_event_sha256: previous, event_sha256: sha } : null;
                const normalized: IndexedTimelineEvent = { event_type: normalizedType,
                    outcome: String(event.outcome || '').trim().toUpperCase() || undefined,
                    timestamp_utc: String(event.timestamp_utc || '').trim(), sequence: position,
                    details: event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                        ? event.details as Record<string, unknown> : null, integrity };
                // Source details are already deeply frozen by the canonical parser owner.
                if (integrity) Object.freeze(integrity);
                Object.freeze(normalized);
                normalizedEvents.push(normalized); (normalizedByType[normalizedType] ??= []).push(normalized);
                recovery.accept(normalized);
                (sourceByNormalizedType[normalizedType] ??= []).push(event);
            }
            else recovery.reject();
            if (event.event_type === 'TASK_MODE_ENTERED') taskModeBoundaries.push(position);
            if (event.event_type === 'REVIEW_CYCLE_RESTARTED') reviewCycleBoundaries.push(position);
            const time = parseTimestamp(event.timestamp_utc).getTime();
            if (time < previousTime) monotonic = false;
            previousTime = time;
        },
        finish(verified: boolean): VerifiedTaskEventIndex | null {
            if (!verified) return null;
            // Audit uses a stable timestamp sort. Preserve ties and legacy timestamps.
            const ordered = monotonic ? events : [...events].sort((a, b) => {
                countNextStepWork('visit:audit_ordered_event_comparison');
                return parseTimestamp(a.timestamp_utc).getTime() - parseTimestamp(b.timestamp_utc).getTime();
            });
            for (const list of Object.values(byType)) Object.freeze(list);
            for (const list of Object.values(byTrimmedType)) Object.freeze(list);
            for (const list of Object.values(normalizedByType)) Object.freeze(list);
            normalizedTypes.set(normalizedEvents, Object.freeze(normalizedByType));
            for (const list of Object.values(sourceByNormalizedType)) Object.freeze(list);
            sourceNormalizedTypes.set(normalizedEvents, Object.freeze(sourceByNormalizedType));
            const index = Object.freeze({ normalizedEvents: Object.freeze(normalizedEvents), startBytes: Object.freeze(startBytes), events: Object.freeze(events), ordered: Object.freeze(ordered),
                lastIndexByType: Object.freeze(lastIndexByType), byType: Object.freeze(byType),
                byTrimmedType: Object.freeze(byTrimmedType), taskModeBoundaries: Object.freeze(taskModeBoundaries),
                reviewCycleBoundaries: Object.freeze(reviewCycleBoundaries), latestCompileSequence, latestFocusedTaskModeSequence });
            const views = new Map<string, readonly Event[]>();
            for (const group of composed) {
                if (group.options.ordered && !monotonic) group.events.sort((a, b) =>
                    parseTimestamp(a.timestamp_utc).getTime() - parseTimestamp(b.timestamp_utc).getTime()
                    || positions.get(a)! - positions.get(b)!);
                views.set(group.key, Object.freeze(group.events));
            }
            selectionViews.set(index, views);
            indices.set(events, index); indices.set(ordered, index);
            currentEvidence.finish(index);
            recovery.finish(index);
            qualityBindings.finish(index);
            return index;
        }
    };
}

export interface QualityBindingWitness {
    answersPath: unknown;
    bindingPath: unknown;
    bindingSha256: unknown;
    policySha256: unknown;
}
interface QualityBindingFacts {
    compatible: boolean;
    latest: Map<string, { position: number; startByte: number }>;
    repairs: Map<string, { answersPath: string; position: number; startByte: number }>;
}
interface QualityBindingWindow { minimumPosition: number; afterStartByte: number }
const qualityBindingFacts = new WeakMap<VerifiedTaskEventIndex, QualityBindingFacts>();

/** The existing allowed recovery suffix grammar, shared with the fallback predicate. */
export function qualityBindingRepairPrefix(answersPath: string): string {
    return answersPath.replace(/\.recovery(?:\.(?:[2-9]|[1-9]\d+))?\.json$/u, '');
}

function qualityBindingKey(input: QualityBindingWitness): string {
    return JSON.stringify([normalizePath(input.answersPath), normalizePath(input.bindingPath),
        String(input.bindingSha256 || '').trim().toLowerCase(), String(input.policySha256 || '').trim().toLowerCase()]);
}

function beginQualityBindingIndexPass() {
    const state: QualityBindingFacts = { compatible: true, latest: new Map(), repairs: new Map() };
    return {
        accept(event: Event, position: number, startByte: number, type: string): void {
            if (type !== 'QUALITY_CHECKLIST_ANSWERS_TEMPLATE_BINDING_RECORDED') return;
            try {
                const details = record(event.details);
                const answersPath = normalizePath(details.answers_path);
                state.latest.set(qualityBindingKey({ answersPath: details.answers_path, bindingPath: details.binding_path,
                    bindingSha256: details.binding_sha256, policySha256: details.answers_template_policy_sha256 }),
                { position, startByte });
                state.repairs.set(qualityBindingRepairPrefix(answersPath), { answersPath, position, startByte });
            } catch {
                // Eager optional coercion must not change the legacy short-circuit/error semantics.
                state.compatible = false;
            }
        },
        finish(index: VerifiedTaskEventIndex): void { qualityBindingFacts.set(index, state); }
    };
}

function readQualityBindingFacts(index: VerifiedTaskEventIndex, window: QualityBindingWindow): QualityBindingFacts | null {
    const state = qualityBindingFacts.get(index);
    return state?.compatible && Number.isSafeInteger(window.minimumPosition) && window.minimumPosition >= 0
        && Number.isSafeInteger(window.afterStartByte) && window.afterStartByte >= -1 ? state : null;
}

function isQualityBindingRetained(found: { position: number; startByte: number } | undefined, window: QualityBindingWindow): boolean {
    return !!found && found.position >= window.minimumPosition && found.startByte > window.afterStartByte;
}

/** Only the latest syntactically eligible candidate is selected; the caller still validates its actual current binding. */
export function readVerifiedQualityRepairCandidate(index: VerifiedTaskEventIndex, repairPrefix: string,
    window: QualityBindingWindow): { answersPath: string | null } | null {
    const state = readQualityBindingFacts(index, window);
    if (!state) return null;
    countNextStepWork('verified_quality_repair_lookup');
    const found = state.repairs.get(normalizePath(repairPrefix));
    return { answersPath: isQualityBindingRetained(found, window) ? found!.answersPath : null };
}

/** A witness narrows the existing existential check; it grants no new binding authority. */
export function readVerifiedQualityBindingWitness(index: VerifiedTaskEventIndex, input: QualityBindingWitness,
    window: QualityBindingWindow): boolean | null {
    const state = readQualityBindingFacts(index, window);
    if (!state) return null;
    countNextStepWork('verified_quality_binding_lookup');
    // The old predicate compared the observed file hash strictly, without coercing
    // a missing value or normalizing the query into a different hash identity.
    if (typeof input.bindingSha256 !== 'string'
        || input.bindingSha256 !== input.bindingSha256.trim().toLowerCase()) return false;
    const found = state.latest.get(qualityBindingKey({ ...input, policySha256: String(input.policySha256).trim().toLowerCase() }));
    return isQualityBindingRetained(found, window);
}

interface RecoveryPrefix {
    mode: number; pending: number; restarted: number;
    firstBoundary: number; lastNonImplementation: number;
}
interface RecoveryFacts {
    compatible: boolean;
    endSequence: number;
    prefix: RecoveryPrefix;
    preflight: { sequence: number; prefix: RecoveryPrefix } | null;
    latest: Record<string, number>;
}
const recoveryFacts = new WeakMap<VerifiedTaskEventIndex, RecoveryFacts>();
const recoveryBoundaries = new Set(['IMPLEMENTATION_STARTED', 'REVIEW_PHASE_STARTED', 'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'COMPLETION_GATE_FAILED', 'COMPLETION_GATE_PASSED']);

/** Field reductions fused into the verifier; no history array is replayed by a consumer. */
function beginRecoveryIndexPass() {
    const facts: RecoveryFacts = { compatible: true, endSequence: -1, preflight: null,
        prefix: { mode: -1, pending: -1, restarted: -1, firstBoundary: -1, lastNonImplementation: -1 },
        latest: Object.create(null) };
    return {
        reject(): void { facts.compatible = false; },
        accept(event: IndexedTimelineEvent): void {
            // Native line ordinals and task sequences must agree. Legacy/coerced streams
            // keep the original route readers rather than gaining a new ordering authority.
            if (event.integrity?.task_sequence !== event.sequence + 1) facts.compatible = false;
            facts.endSequence = event.sequence;
            const type = event.event_type, prefix = facts.prefix;
            if (type === 'PREFLIGHT_CLASSIFIED') facts.preflight = { sequence: event.sequence, prefix: { ...prefix } };
            if (type === 'TASK_MODE_ENTERED' || type === 'COMPLETION_GATE_PASSED')
                facts.latest[type] = event.integrity?.task_sequence ?? event.sequence;
            if (type === 'TASK_MODE_ENTERED') prefix.mode = event.sequence;
            if (type === 'COHERENT_CYCLE_RED_PENDING') prefix.pending = event.sequence;
            if (type === 'COHERENT_CYCLE_RESTARTED') prefix.restarted = event.sequence;
            if (recoveryBoundaries.has(type)) {
                if (prefix.firstBoundary < 0) prefix.firstBoundary = event.sequence;
                if (type !== 'IMPLEMENTATION_STARTED') prefix.lastNonImplementation = event.sequence;
            }
        },
        finish(index: VerifiedTaskEventIndex): void { recoveryFacts.set(index, facts); }
    };
}

/** Null means no genuine compatible capture; an absent native event is a known null sequence. */
export function readVerifiedRecoverySequence(index: VerifiedTaskEventIndex, type: string): { sequence: number | null } | null {
    const facts = recoveryFacts.get(index);
    if (!facts?.compatible || (type !== 'TASK_MODE_ENTERED' && type !== 'COMPLETION_GATE_PASSED')) return null;
    countNextStepWork('verified_recovery_sequence_lookup');
    return { sequence: facts.latest[type] ?? null };
}

/** Only the exact current preflight prefix or complete current head has a bounded answer. */
export function readVerifiedOriginalEntryRefresh(index: VerifiedTaskEventIndex, sequence: number,
    allowPendingCoherentRefresh = false): boolean | null {
    const facts = recoveryFacts.get(index);
    if (!facts?.compatible) return null;
    const prefix = sequence === facts.endSequence + 1 ? facts.prefix
        : sequence === facts.preflight?.sequence ? facts.preflight.prefix : null;
    if (!prefix) return null;
    countNextStepWork('verified_original_entry_refresh_lookup');
    if (prefix.mode < 0) return false;
    const pending = allowPendingCoherentRefresh && prefix.pending > prefix.mode && prefix.restarted <= prefix.pending;
    return pending ? prefix.lastNonImplementation <= prefix.mode
        : prefix.firstBoundary > prefix.mode && prefix.lastNonImplementation < 0;
}
/** Select requested types, preserving native order and stable timestamp ties. */
export function selectVerifiedEvents(index: VerifiedTaskEventIndex, types: readonly string[],
    options: SelectionOptions = {}): readonly Event[] {
    const table = options.normalized ? sourceNormalizedTypes.get(index.normalizedEvents) ?? {}
        : options.trimmed ? index.byTrimmedType : index.byType;
    const names = [...new Set(types)].sort();
    const key = selectionKey(names, options);
    const memo = selectionViews.get(index) ?? new Map<string, readonly Event[]>();
    selectionViews.set(index, memo);
    const retained = memo.get(key);
    if (retained) return retained;
    const fromPosition = options.fromPosition ?? 0;
    // A bounded epoch selection over a composition the canonical pass already prepared reuses that shared view:
    // a position-ordered view needs only its bounded suffix, never a second merge of the type lists.
    const shared = fromPosition > 0 ? memo.get(selectionKey(names, { ...options, fromPosition: 0 })) : undefined;
    if (shared && (!options.ordered || index.ordered === index.events)) {
        const view = suffixFromPosition(shared, fromPosition);
        memo.set(key, view);
        return view;
    }
    const lists = names.map(type => suffixFromPosition(table[type] ?? empty, fromPosition)).filter(list => list.length);
    // A single canonical type list is already ordered when the verified history is monotonic.
    // Reuse that immutable view instead of visiting/copying its events for each consumer.
    if (!lists.length || lists.length === 1 && (!options.ordered || index.ordered === index.events)) {
        const view = lists[0] ?? empty;
        // Retain bounded suffixes too, so repeated current-epoch readers do not rescan.
        if (fromPosition > 0) memo.set(key, view);
        return view;
    }
    const selected: Event[] = [];
    for (const list of lists) for (const event of list) {
        countNextStepWork('visit:verified_timeline_selected_event'); selected.push(event);
    }
    selected.sort((a, b) => (options.ordered
        ? parseTimestamp(a.timestamp_utc).getTime() - parseTimestamp(b.timestamp_utc).getTime() : 0)
        || positions.get(a)! - positions.get(b)!);
    const result = Object.freeze(selected); memo.set(key, result);
    return result;
}

export function verifiedEventPosition(event: object): number | undefined { return positions.get(event); }

export function normalizedEventsOfType(events: readonly IndexedTimelineEvent[], type: string): readonly IndexedTimelineEvent[] | null {
    const table = normalizedTypes.get(events);
    return table ? table[type] ?? [] : null;
}

interface CurrentEvidenceFacts {
    compatible: boolean;
    ambiguousStarts: boolean;
    epochPosition: number | null;
    classificationPosition: number | null;
    classificationSemantic: string | null;
    receipts: Map<string, Event[]>;
    invocations: Map<string, Event[]>;
    starts: Map<string, Event[]>;
    lastNonPassReview: Event | null;
}
const facts = new WeakMap<VerifiedTaskEventIndex, CurrentEvidenceFacts>();
const currentEvidenceText = (value: unknown) => String(value || '').trim().toLowerCase();
function record(value: unknown): Readonly<Record<string, unknown>> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function append(map: Map<string, Event[]>, key: string, event: Event, maximum = Infinity): void {
    const rows = map.get(key) ?? [];
    if (rows.length < maximum) rows.push(event);
    map.set(key, rows);
}
function beginCurrentEvidenceIndexPass() {
    const state: CurrentEvidenceFacts = { compatible: true, ambiguousStarts: false, epochPosition: null,
        classificationPosition: null, classificationSemantic: null,
        receipts: new Map(), invocations: new Map(), starts: new Map(), lastNonPassReview: null };
    let closed = false;
    return {
        accept(event: Event, position: number, normalizedType: string): void {
            if (closed) throw new Error('Current evidence index pass is closed.');
            try {
                const details = record(event.details);
                if (event.event_type === 'TASK_MODE_ENTERED') {
                    state.starts.clear(); state.ambiguousStarts = false;
                    state.classificationPosition = null; state.classificationSemantic = null;
                }
                if (isIntermediateExecutionEpochBoundary(event.event_type, details)) state.epochPosition = position;
                if (event.event_type === 'PREFLIGHT_CLASSIFIED') {
                    let binding: ReturnType<typeof readIntermediateExecutionClassification> = null;
                    try { binding = readIntermediateExecutionClassification(details.intermediate_execution_preflight); }
                    catch { /* Invalid historical classifications cannot bridge an equivalent refresh. */ }
                    if (!binding || binding.semantic_sha256 !== state.classificationSemantic)
                        state.classificationPosition = position;
                    state.classificationSemantic = binding?.semantic_sha256 ?? null;
                }
                if (normalizedType === 'REVIEW_RECORDED') {
                    append(state.receipts, currentEvidenceText(details.receipt_sha256 ?? details.receiptSha256), event);
                    if (currentEvidenceText(event.outcome) !== 'pass') state.lastNonPassReview = event;
                }
                if (normalizedType === 'REVIEWER_INVOCATION_ATTESTED')
                    append(state.invocations, currentEvidenceText(record(event.integrity).event_sha256), event);
                if (event.event_type === 'INTERMEDIATE_COMMAND_STARTED' && typeof details.execution_id === 'string') {
                    if (state.starts.has(details.execution_id)) state.ambiguousStarts = true;
                    append(state.starts, details.execution_id, event, 2);
                }
            } catch {
                // Optional indexing must not change legacy acceptance or coercion failures.
                state.compatible = false;
            }
        },
        finish(index: VerifiedTaskEventIndex): void {
            closed = true;
            facts.set(index, state);
        }
    };
}
export function readVerifiedExecutionEpochPosition(index: VerifiedTaskEventIndex): number | null {
    const state = facts.get(index);
    return state?.compatible && !state.ambiguousStarts ? state.epochPosition : null;
}
/** A timestamp-only refresh retains its original span; A/B/A never joins the older A. */
export function readVerifiedExecutionContextPosition(index: VerifiedTaskEventIndex): number | null {
    const epoch = readVerifiedExecutionEpochPosition(index);
    return epoch == null ? null : Math.max(epoch, facts.get(index)?.classificationPosition ?? epoch);
}
export function readVerifiedIntermediateStarts(index: VerifiedTaskEventIndex, executionId: string): readonly Event[] | null {
    const state = facts.get(index);
    if (!state?.compatible || state.ambiguousStarts) return null;
    countNextStepWork('verified_intermediate_start_lookup');
    return Object.freeze(state.starts.get(executionId) ?? empty);
}
export function readVerifiedReviewWitnesses(index: VerifiedTaskEventIndex, type: string, sha256: string): readonly Event[] | null {
    const state = facts.get(index);
    if (!state?.compatible) return null;
    countNextStepWork('verified_review_witness_lookup');
    const rows = (type === 'REVIEW_RECORDED' ? state.receipts : state.invocations).get(sha256);
    // Retain the original non-PASS diagnostic when the named receipt has no candidate.
    return rows ? Object.freeze(rows) : type === 'REVIEW_RECORDED' && state.lastNonPassReview
        ? Object.freeze([state.lastNonPassReview]) : empty;
}
