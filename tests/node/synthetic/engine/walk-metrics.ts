import type { WalkResult, WalkStep } from './navigator-walk';
import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import { splitCommandLine } from '../../../../src/core/command-line';
import { observeStandOracle } from './stand-check-observation';
import { rootChainProbes, type RootChainProbe } from './walk-root-chain';
import { createHash } from 'node:crypto';
import { RECORDED_COUNTERS, recordedAllowance, repeatedRecordedWork, stepRecordedWork, type RecordedWorkPolicy } from './walk-recorded-work';

export interface CounterBudget { expected: number; tolerance: number; constantWithEvents: boolean; growthTolerance?: number }
export interface CounterBaseline {
    schema: 1;
    provenance: string;
    routes: Record<string, Record<string, CounterBudget>>;
    recordedWork?: RecordedWorkPolicy;
    /** Independently measured fixture states; only named route/counter overrides apply. */
    states?: Record<string, { provenance: string; inherits?: string; routes: Record<string, Record<string, CounterBudget>> }>;
}

export function counterBudgets(baseline: CounterBaseline, route: string, state?: string): Record<string, CounterBudget> | undefined {
    const layers = [], seen = new Set<string>();
    for (let id = state; id; id = baseline.states?.[id]?.inherits) {
        if (seen.has(id)) throw new Error('Counter state inheritance cycle: ' + id);
        seen.add(id);
        const layer = baseline.states?.[id];
        if (!layer) {
            if (id === state) break; // An unmeasured family still reports missing ordinary routes.
            throw new Error('Unknown counter parent: ' + id);
        }
        if (layer.routes[route]) layers.unshift(baseline.recordedWork?.retireStates.includes(id)
            ? Object.fromEntries(Object.entries(layer.routes[route]).filter(([key]) => !RECORDED_COUNTERS.has(key))) : layer.routes[route]);
    }
    return baseline.routes[route] || layers.length ? Object.assign({}, baseline.routes[route], ...layers) : undefined;
}
export interface Distribution { median: number; p95: number; max: number; growthPer100Events: number }
export interface RouteMetrics {
    route: string; calls: number; events: { min: number; max: number };
    wall_ms: Distribution; core_ms: Distribution; outside_core_ms: Distribution;
    phases: Record<string, Distribution>;
    counters: Record<string, Distribution>;
    /** Calls of one decision whose counted inputs differ: their counts differ by available evidence, not by event history. */
    evidenceCohorts: EvidenceCohort[];
    growthByScenario: Array<{ scenario: string; sourceRoutes: string[]; action: string; calls: number; events: { min: number; max: number }; wall_ms: number; core_ms: number; outside_core_ms: number; counters: Record<string, number>; phases: Record<string, number> }>;
}
export interface EvidenceCohort {
    scenario: string; action: string; counter: string;
    /** Fitted growth per 100 events of the inputs every call counted; information for review. */
    sharedInputSlope: number;
    cohorts: Array<{ events: { min: number; max: number }; calls: number; values: number[]; identities: number }>;
    added: string[]; removed: string[];
}
export interface WalkAnomaly {
    kind: 'time-spike' | 'time-growth' | 'time-subprocess-timeout' | 'counter-budget' | 'counter-growth' | 'missing-baseline';
    severity: 'warning' | 'failure' | 'report'; route: string; scenario: string; step: number;
    metric: string; observed: number; limit: number; replay: string; cpuProfile?: string;
    sourceRoutes?: string[]; action?: string;
    /** File-probe budgets: the measured root chain behind `observed` (raw = observed + adjustment). */
    rootChain?: RootChainProbe;
}
export const TIME_POLICY = Object.freeze({ medianMultiple: 8, minimumSpikeMs: 250, growthMsPer100Events: 500 });
const counterSnapshots = new WeakMap<object, Record<string, number>>();
const identitySnapshots = new WeakMap<object, Record<string, Record<string, number>>>();
const decisions = new WeakMap<object, { sourceRoutes: string[]; action: string }>();
const recordedSignatures = new WeakMap<WalkStep, string>();

function recordedSignature(result: WalkResult, step: WalkStep): string {
    const retained = recordedSignatures.get(step); if (retained) return retained;
    const files = Object.keys(step.measurement?.work ?? {}).filter(key => /^(?:file_hash:|payload_read:|acl_probe:)/u.test(key))
        .map(normalizeCounterIdentity).sort();
    const acquisition = Object.entries(step.measurement?.work ?? {}).filter(([key]) => /^(?:acl_batch_|subprocess_timeout:)/u.test(key))
        .sort(([left], [right]) => left.localeCompare(right));
    const policyFacts = [...new Set((result.events ?? []).slice(0, step.taskEvents).filter(event => /POLICY|CRITERIA/u.test(event.type))
        .flatMap(event => Object.entries(event.details).filter(([key, value]) => /hash|sha256/u.test(key)
            && typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)).map(([key, value]) => key + ':' + String(value))))].sort();
    const value = createHash('sha256').update(JSON.stringify([stepRecordedWork(result, step), files, policyFacts, acquisition])).digest('hex');
    recordedSignatures.set(step, value); return value;
}

function decision(step: WalkStep): { sourceRoutes: string[]; action: string } {
    const cached = decisions.get(step); if (cached) return cached;
    const argv = step.command ? splitCommandLine(step.command) : [];
    const gate = argv.indexOf('gate'), stage = argv.indexOf('--stage');
    const value = { sourceRoutes: step.routes ?? [], action: (gate >= 0 ? argv[gate + 1] : step.gate === 'next-step-effect' ? 'execute-effect' : 'instruction')
        + (stage >= 0 ? ':' + argv[stage + 1] : '') };
    decisions.set(step, value); return value;
}

/**
 * A counter suffixed with an absolute input path, a Windows drive or a POSIX root, counts one file of that kind. The
 * aggregate is platform independent. Without the POSIX form every Linux fixture root became its own counter, so route
 * counter sets and the per-scenario growth rows grew with the number of scenarios. The exact input remains in
 * counterIdentities and in the raw measurement.
 */
export function fileCounterKey(key: string): string {
    return key.replace(/:(?:[A-Z]:|\/).*$/u, ':file');
}

/**
 * Raw work keys a verdict can read: everything workCounters aggregates, subprocess timeouts, root-chain labels, and
 * every key whose counterIdentities aggregate can share a name with a workCounters counter (and therefore a budget).
 * Other raw keys (product visit/derivation/realpath counters) are diagnostics that no reducer consults.
 */
const VERDICT_WORK_KEY = /^(?:process:|payload_read|file_hash:|file_probes|subprocess|root_chain_|timeline_|json_parse_verified_timeline_event|visit:verified_timeline_|visit:timeline_cloned_event|acl_probe:initial:)/u;
export function isVerdictWorkKey(key: string): boolean {
    return VERDICT_WORK_KEY.test(key) || /^(?:stand_loaded_|stand_unit|derive:|acl_probe:final:|acl_batch_probe:initial:|acl_batch_hit:initial$|loaded_code_|closed-review-summary:|code\.capture$|visit:loaded_code_initial_file$)/u.test(key);
}

/** One initial directory/file acquisition is the unit, whether batched or individually acquired.
 * Final freshness reads remain individual. Raw process counters are retained in the trace. */
export function aclPairProcessAdjustment(work: Record<string, number>): number {
    const prefix = 'acl_probe:initial:';
    const inputs = Object.keys(work).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
    let pairs = 0;
    for (const directory of inputs) {
        if (!/[\\/](?:reviews|task-events)$/u.test(directory)) continue;
        const child = inputs.find(file => file.slice(0, directory.length + 1) === directory + (directory.includes('\\') ? '\\' : '/')
            && !/[\\/]/u.test(file.slice(directory.length + 1)) && file.endsWith('.json' + (directory.endsWith('task-events') ? 'l' : '')));
        if (child && [directory, child].every(file => work[prefix + file] === 1 && work['acl_probe:final:' + file] === 1)) pairs++;
    }
    const batches = Object.entries(work).filter(([key]) => key.startsWith('acl_batch_probe:initial:')).reduce((sum, [, count]) => sum + count, 0);
    // No inferred batching credit: each successful batch must have exactly two observed hits.
    const successful = (work['acl_batch_hit:initial'] ?? 0) / 2;
    if (!Number.isInteger(successful) || successful > batches || successful > pairs) return 0;
    return Math.max(0, pairs - successful);
}

const EVENT_COUNTERS = new Set(['timeline_events', 'json_parse_verified_timeline_event', 'visit:verified_timeline_index_event']);
/** C3: one mandatory pass, zero extra events/bytes. Old sample sizes and their tolerances are not allowances. */
function proportionalLimit(step: WalkStep, key: string): number | undefined {
    if (!EVENT_COUNTERS.has(key) && key !== 'timeline_bytes') return undefined;
    if (step.timelineInput?.error) return 0;
    return key === 'timeline_bytes' ? step.timelineInput?.bytes ?? 0 : step.timelineInput?.events ?? step.taskEvents;
}

/**
 * The same result with each measurement reduced to the work keys a verdict reads. The stored record keeps the complete
 * raw measurement; this copy only bounds what a merge holds in memory for the union of all shards.
 */
export function verdictResult(result: WalkResult): WalkResult {
    return { ...result, ...(result.nativeBudget ? { nativeBudget: verdictResult(result.nativeBudget) } : {}),
        steps: result.steps.map(step => !step.measurement?.work ? step : { ...step, measurement: { ...step.measurement,
        work: Object.fromEntries(Object.entries(step.measurement.work).filter(([key]) => isVerdictWorkKey(key))) } }) };
}

/** No absolute temp paths or command digests in aggregate keys. Raw measurements remain in traces. */
export function workCounters(step: WalkStep): Record<string, number> {
    const measurement = step.measurement;
    if (!measurement) return {};
    const cached = counterSnapshots.get(measurement);
    if (cached) return cached;
    const result: Record<string, number> = {};
    const add = (name: string, amount: number) => { result[name] = (result[name] ?? 0) + amount; };
    for (const [key, count] of Object.entries(measurement.work)) {
        if (key === 'timeline_bytes_normalized') continue;
        if (key === 'timeline_bytes' && measurement.work.timeline_bytes_normalized !== undefined
            && !measurement.work.timeline_bytes_normalization_failed) {
            add(key, measurement.work.timeline_bytes_normalized);
        } else if (key.startsWith('process:')) {
            const parts = key.split(':'); add('subprocess:' + parts[2], count);
        } else if (key.startsWith('payload_read:')) {
            add('payload_reads', count);
        } else if (key.startsWith('file_hash:')) add('file_hash:file', count);
        else if (/^(?:timeline_|json_parse_verified_timeline_event$|visit:verified_timeline_(?:index|selected)_event$|visit:timeline_cloned_event$)/u.test(key)) {
            add(fileCounterKey(key), count);
        }
    }
    // The native snapshot reader counts task-mode JSON in the same byte scalar. Remove one independently
    // measured envelope, never a multiple of its read counter: a repeated envelope read still fails.
    if (result.timeline_bytes !== undefined && !step.timelineInput?.error)
        result.timeline_bytes = Math.max(0, result.timeline_bytes - (step.timelineInput?.envelopeBytes ?? 0));
    // Ancestor walks above the disposable root are stated at the reference chain depth, so budgets compare the
    // navigator's work wherever TMP points. Partial chain probes and every other probe count unchanged.
    const chain = rootChainProbes(measurement.work, measurement.io);
    if (chain.problem) add('root_chain_unverified', 1);
    for (const [key, value] of Object.entries(measurement.io ?? {})) {
        if (/stat|exists|realpath|readlink|readdir/iu.test(key)) add('file_probes:' + key, value.count - (chain.probes[key]?.adjustment ?? 0));
    }
    // A subprocess stopped by its own timeout is load, not work: the caller's bounded retry runs the same
    // command again. It is reported as a timing observation (subprocessTimeouts), never dropped.
    for (const [key, count] of Object.entries(subprocessTimeouts(step))) {
        const name = 'subprocess:' + key;
        if (result[name] !== undefined) result[name] = Math.max(0, result[name] - count);
    }
    if (result['subprocess:icacls.exe'] !== undefined)
        result['subprocess:icacls.exe'] = Math.max(0, result['subprocess:icacls.exe'] - aclPairProcessAdjustment(measurement.work));
    counterSnapshots.set(measurement, result);
    return result;
}

/** Timed-out subprocess attempts by program, as recorded by the measurement (subprocess_timeout:<program>). */
export function subprocessTimeouts(step: WalkStep): Record<string, number> {
    return Object.fromEntries(Object.entries(step.measurement?.work ?? {})
        .filter(([key]) => key.startsWith('subprocess_timeout:')).map(([key, count]) => [key.slice('subprocess_timeout:'.length), count]));
}

/** Fixture roots are scenario scoped; within a scenario they are constant, so only the relative input remains. */
export function normalizeCounterIdentity(raw: string): string {
    return raw.replace(/^((?:file_hash|payload_read|acl_probe:(?:initial|final)|timeline_[a-z_]+|json_parse_verified_timeline_event|visit:[a-z_]+):)(?:[A-Za-z]:)?[^:]*?garda-walk-[A-Za-z0-9]+[\\/]/u, '$1').replace(/\\/gu, '/');
}

/** The raw inputs behind each aggregate counter: which files were hashed, which commands ran. */
export function counterIdentities(step: WalkStep): Record<string, Record<string, number>> {
    const measurement = step.measurement;
    if (!measurement) return {};
    const cached = identitySnapshots.get(measurement);
    if (cached) return cached;
    const result: Record<string, Record<string, number>> = {};
    for (const [key, count] of Object.entries(measurement.work)) {
        if (/^stand_(?:io:|loaded_)/u.test(key)) continue; // Input manifests/diagnosis have separate per-unit checks.
        const aggregate = key.startsWith('process:') ? 'subprocess:' + key.split(':')[2] : key.startsWith('payload_read:') ? 'payload_reads'
            : key.startsWith('file_hash:') ? 'file_hash:file' : fileCounterKey(key);
        // These native scalar counters count a set of timelines, not a single file. Parent acceptance
        // authenticates each child's timeline too. Retain the whole measured input set as one identity;
        // do not invent a per-file attribution of the scalar total. A repeat over that same set still
        // fails on any positive growth. Raw totals and the changed set remain in the report.
        const timelineInputs = key === 'timeline_parse' || key === 'timeline_verify'
            ? Object.keys(measurement.work).filter(input => input.startsWith('timeline_capture:') && input.endsWith('.jsonl'))
                .map(normalizeCounterIdentity).sort() : [];
        // The principal query has identical argv for every protected path. Its authority inputs
        // are the actual ACL subjects, not just the command digest (a parent/child handoff adds paths).
        const aclInputs = aggregate === 'subprocess:powershell.exe'
            ? Object.keys(measurement.work).filter(input => input.startsWith('acl_probe:initial:'))
                .map(normalizeCounterIdentity).sort() : [];
        const identities = result[aggregate] ??= {}, identity = normalizeCounterIdentity(key)
            + (timelineInputs.length ? ':' + JSON.stringify(timelineInputs) : '')
            + (aclInputs.length ? ':acl=' + JSON.stringify(aclInputs) : '');
        identities[identity] = (identities[identity] ?? 0) + count;
    }
    identitySnapshots.set(measurement, result);
    return result;
}

export function fittedGrowth(samples: readonly { events: number; value: number }[], minimumSamples = 3): number {
    if (samples.length < minimumSamples) return 0;
    const meanX = samples.reduce((sum, entry) => sum + entry.events, 0) / samples.length;
    const meanY = samples.reduce((sum, entry) => sum + entry.value, 0) / samples.length;
    const denominator = samples.reduce((sum, entry) => sum + (entry.events - meanX) ** 2, 0);
    return denominator ? 100 * samples.reduce((sum, entry) => sum + (entry.events - meanX) * (entry.value - meanY), 0) / denominator : 0;
}
function distribution(steps: readonly WalkStep[], value: (step: WalkStep) => number): Distribution {
    const sorted = steps.map(value).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return { median: sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2,
        p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0, max: sorted.at(-1) ?? 0,
        growthPer100Events: fittedGrowth(steps.map(step => ({ events: step.taskEvents, value: value(step) }))) };
}
export function analyzeWalkMetrics(results: readonly WalkResult[], baseline: CounterBaseline, quiet: boolean): { routes: RouteMetrics[]; anomalies: WalkAnomaly[] } {
    observeStandOracle('work-budgets');
    const grouped = new Map<string, Array<{ result: WalkResult; step: WalkStep }>>();
    for (const result of results) for (const step of result.steps) {
        if (step.reusedPrefix) continue;
        const key = step.route ?? step.status + '/' + (step.gate ?? '(done)');
        const group = grouped.get(key) ?? []; group.push({ result, step }); grouped.set(key, group);
    }
    const anomalies: WalkAnomaly[] = [], routes: RouteMetrics[] = [];
    for (const [route, entries] of grouped) {
        const steps = entries.map(entry => entry.step);
        const counters = new Set(steps.flatMap(step => Object.keys(workCounters(step))));
        const phases = new Set(steps.flatMap(step => Object.keys(step.measurement?.phases_ms ?? {})));
        const row: RouteMetrics = { route, calls: steps.length,
            events: { min: Math.min(...steps.map(step => step.taskEvents)), max: Math.max(...steps.map(step => step.taskEvents)) },
            wall_ms: distribution(steps, step => step.navigatorMs), core_ms: distribution(steps, step => step.coreMs ?? step.navigatorMs),
            outside_core_ms: distribution(steps, step => step.outsideCoreMs ?? 0),
            phases: Object.fromEntries([...phases].sort().map(key => [key, distribution(steps, step => step.measurement?.phases_ms[key] ?? 0)])),
            counters: Object.fromEntries([...counters].sort().map(key => [key, distribution(steps, step => workCounters(step)[key] ?? 0)])), evidenceCohorts: [], growthByScenario: [] };
        routes.push(row);
        const add = (entry: typeof entries[number], kind: WalkAnomaly['kind'], metric: string, observed: number, limit: number) => {
            anomalies.push({ kind, severity: kind.startsWith('time') && !quiet ? 'warning' : 'failure', route,
                scenario: entry.result.scenarioId, step: entry.step.index, metric, observed, limit,
                ...decision(entry.step),
                replay: (entry.result.sweep ? 'GARDA_SYNTHETIC_SEED=' + entry.result.sweep.seed + ' ' : '')
                    + 'GARDA_SYNTHETIC_WALK_ONLY=' + entry.result.scenarioId,
                cpuProfile: entry.step.cpuProfile ?? entry.step.diagnostic?.cpu_profile_file ?? undefined });
        };
        const decisionGroups = new Map<string, typeof entries>();
        for (const entry of entries) {
            const key = JSON.stringify(decision(entry.step)), group = decisionGroups.get(key) ?? [];
            group.push(entry); decisionGroups.set(key, group);
        }
        for (const group of decisionGroups.values()) {
            const median = distribution(group.map(entry => entry.step), step => step.navigatorMs).median;
            const spikeLimit = Math.max(TIME_POLICY.minimumSpikeMs, median * TIME_POLICY.medianMultiple);
            for (const entry of group) if (entry.step.navigatorMs > spikeLimit) add(entry, 'time-spike', 'wall_ms', entry.step.navigatorMs, spikeLimit);
        }
        // Fit within a scenario and project size. Mixing different tasks creates spurious history slopes.
        const scenarioGroups = new Map<string, typeof entries>();
        for (const entry of entries) {
            const key = entry.result.scenarioId + '|' + (entry.step.taskId ?? '') + '|' + JSON.stringify(decision(entry.step)) + '|' + (entry.step.counterState ?? '');
            const group = scenarioGroups.get(key) ?? []; group.push(entry); scenarioGroups.set(key, group);
        }
        for (const group of scenarioGroups.values()) {
            const current = group.map(entry => entry.step);
            const slope = (value: (step: WalkStep) => number, minimumSamples = 3) => fittedGrowth(current.map(step => ({ events: step.taskEvents, value: value(step) })), minimumSamples);
            row.growthByScenario.push({ scenario: group[0].result.scenarioId, ...decision(group[0].step), calls: group.length,
                events: { min: Math.min(...current.map(step => step.taskEvents)), max: Math.max(...current.map(step => step.taskEvents)) },
                wall_ms: slope(step => step.navigatorMs), core_ms: slope(step => step.coreMs ?? step.navigatorMs),
                outside_core_ms: slope(step => step.outsideCoreMs ?? 0),
                counters: Object.fromEntries([...counters].map(key => [key, slope(step => workCounters(step)[key] ?? 0, 2)])),
                phases: Object.fromEntries([...phases].map(key => [key, slope(step => step.measurement?.phases_ms[key] ?? 0)])) });
            const eventSpan = Math.max(...current.map(step => step.taskEvents)) - Math.min(...current.map(step => step.taskEvents));
            if (group.length < 2 || eventSpan === 0) continue;
            const growth = fittedGrowth(group.map(entry => ({ events: entry.step.taskEvents, value: entry.step.navigatorMs })));
            if (group.length >= 3 && eventSpan >= 50 && growth > TIME_POLICY.growthMsPer100Events) add(group.at(-1)!, 'time-growth', 'wall_ms/100events', growth, TIME_POLICY.growthMsPer100Events);
            for (const [key, budget] of Object.entries(counterBudgets(baseline, route, group[0].step.counterState) ?? {})) {
                const recorded = baseline.recordedWork && RECORDED_COUNTERS.has(key);
                const proportional = recorded || proportionalLimit(group[0].step, key) !== undefined;
                if (!budget.constantWithEvents && !proportional) continue;
                if (proportional) {
                    const residual = fittedGrowth(group.map(entry => ({ events: entry.step.taskEvents,
                        value: recorded ? Math.max(0, (workCounters(entry.step)[key] ?? 0)
                            - recordedAllowance(stepRecordedWork(entry.result, entry.step), key, baseline.recordedWork!) - budget.expected - budget.tolerance)
                            : (workCounters(entry.step)[key] ?? 0) - proportionalLimit(entry.step, key)! })), 2);
                    if (residual > 0) add(group.at(-1)!, 'counter-growth', key + ':excess/100events', residual, 0);
                    if (recorded) {
                        const cohorts = new Map<string, typeof group>();
                        for (const entry of group) {
                            const signature = recordedSignature(entry.result, entry.step), members = cohorts.get(signature) ?? [];
                            members.push(entry); cohorts.set(signature, members);
                        }
                        for (const members of cohorts.values()) {
                            const growth = fittedGrowth(members.map(entry => ({ events: entry.step.taskEvents,
                                value: workCounters(entry.step)[key] ?? 0 })), 2);
                            if (growth > 0) add(members.at(-1)!, 'counter-growth', key + ':same-inputs/100events', growth, 0);
                        }
                    }
                    continue;
                }
                // Growth with event history means the SAME inputs cost more as history grows. Calls that count a
                // different input set are different evidence states (scope files exist, a binding was written);
                // they are fitted separately and their difference is reported with the exact inputs, never hidden.
                const cohorts = new Map<string, { identities: string[]; members: typeof group }>();
                const inputs = (entry: typeof group[number]) => counterIdentities(entry.step)[key] ?? {};
                for (const entry of group) {
                    const identities = Object.keys(inputs(entry)).sort(), signature = JSON.stringify(identities);
                    const cohort = cohorts.get(signature) ?? { identities, members: [] };
                    cohort.members.push(entry); cohorts.set(signature, cohort);
                }
                for (const { members } of cohorts.values()) {
                    const slope = fittedGrowth(members.map(entry => ({ events: entry.step.taskEvents, value: workCounters(entry.step)[key] ?? 0 })), 2);
                    if (slope > (budget.growthTolerance ?? 0)) add(members.at(-1)!, 'counter-growth', key + '/100events', slope, budget.growthTolerance ?? 0);
                }
                if (cohorts.size < 2) continue;
                // Across evidence states the cost of the inputs every call shares is reported, not judged: a
                // substituted input (for example a declined ACL batch replaced by per-file reads) changes it too.
                const shared = Object.keys(inputs(group[0])).filter(identity => group.every(entry => identity in inputs(entry)));
                const sharedInputSlope = fittedGrowth(group.map(entry => ({ events: entry.step.taskEvents,
                    value: shared.reduce((sum, identity) => sum + inputs(entry)[identity], 0) })), 2);
                const ordered = [...cohorts.values()].sort((a, b) => a.members[0].step.taskEvents - b.members[0].step.taskEvents);
                const first = new Set(ordered[0].identities), last = new Set(ordered.at(-1)!.identities);
                row.evidenceCohorts.push({ scenario: group[0].result.scenarioId, action: decision(group[0].step).action, counter: key, sharedInputSlope,
                    cohorts: ordered.map(({ identities, members }) => ({ calls: members.length, identities: identities.length,
                        events: { min: Math.min(...members.map(entry => entry.step.taskEvents)), max: Math.max(...members.map(entry => entry.step.taskEvents)) },
                        values: members.map(entry => workCounters(entry.step)[key] ?? 0) })),
                    added: [...last].filter(identity => !first.has(identity)), removed: [...first].filter(identity => !last.has(identity)) });
            }
        }
        // A cross-task slope can be Simpson's paradox. The headline slope is the largest within-task fit.
        row.wall_ms.growthPer100Events = Math.max(0, ...row.growthByScenario.map(entry => entry.wall_ms));
        row.core_ms.growthPer100Events = Math.max(0, ...row.growthByScenario.map(entry => entry.core_ms));
        row.outside_core_ms.growthPer100Events = Math.max(0, ...row.growthByScenario.map(entry => entry.outside_core_ms));
        for (const key of counters) row.counters[key].growthPer100Events = Math.max(0, ...row.growthByScenario.map(entry => entry.counters[key]));
        for (const key of phases) row.phases[key].growthPer100Events = Math.max(0, ...row.growthByScenario.map(entry => entry.phases[key]));
        const missingStates = new Set<string>();
        for (const entry of entries) {
            for (const [program, count] of Object.entries(subprocessTimeouts(entry.step))) {
                add(entry, 'time-subprocess-timeout', 'subprocess_timeout:' + program, count, 0);
            }
            // Pair normalization must not create slack for an ordinary path's extra native acquisition.
            // A batch replaces two subject reads. Count its two hits, then compare to distinct phase/subject
            // inputs. Preserve failed-batch process cost in the route ceiling below and all raw counters.
            const work = entry.step.measurement?.work ?? {};
            if (baseline.recordedWork && (entry.step.timelineInput?.files.length ?? 0) > 1
                && (entry.step.recordedWorkInput?.taskFiles?.length ?? 0) < entry.step.timelineInput!.files.length)
                add(entry, 'missing-baseline', 'recorded-task-input-manifest', 1, 0);
            if (baseline.recordedWork?.loadedCode && stepRecordedWork(entry.result, entry.step).loadedInputError)
                add(entry, 'missing-baseline', 'loaded-code-input-manifest', 1, 0);
            if (baseline.recordedWork) for (const failure of repeatedRecordedWork(stepRecordedWork(entry.result, entry.step), work))
                add(entry, 'counter-budget', failure.metric, failure.observed, failure.limit);
            const subjects = Object.keys(work).filter(key => /^acl_probe:(?:initial|final):/u.test(key)).length;
            const rawAcl = (workCounters(entry.step)['subprocess:icacls.exe'] ?? 0) + aclPairProcessAdjustment(work);
            const batches = Object.entries(work).filter(([key]) => key.startsWith('acl_batch_probe:initial:'))
                .reduce((sum, [, count]) => sum + count, 0);
            const acquisitions = rawAcl - batches + (work['acl_batch_hit:initial'] ?? 0);
            if (subjects && acquisitions > subjects) add(entry, 'counter-budget', 'subprocess:icacls.exe/subjects', acquisitions, subjects);
            const budgets = counterBudgets(baseline, route, entry.step.counterState);
            if (!budgets) {
                const state = entry.step.counterState ?? '';
                if (!missingStates.has(state)) add(entry, 'missing-baseline', 'route', 1, 0);
                missingStates.add(state);
                continue;
            }
            for (const [key, value] of Object.entries(workCounters(entry.step))) {
                const budget = budgets[key];
                const limit = proportionalLimit(entry.step, key) ?? (budget ? budget.expected + budget.tolerance
                    + (baseline.recordedWork ? recordedAllowance(stepRecordedWork(entry.result, entry.step), key, baseline.recordedWork) : 0) : 0);
                if (!budget) add(entry, 'missing-baseline', key, value, 0);
                else if (value > limit) {
                    add(entry, 'counter-budget', key, value, limit);
                    const chain = key.startsWith('file_probes:') && entry.step.measurement
                        ? rootChainProbes(entry.step.measurement.work, entry.step.measurement.io).probes[key.slice('file_probes:'.length)] : undefined;
                    if (chain) anomalies[anomalies.length - 1].rootChain = chain;
                }
            }
        }
    }
    return { routes: routes.sort((a, b) => a.route.localeCompare(b.route)), anomalies };
}

export function anomalyFindings(anomalies: readonly WalkAnomaly[]): StandFinding[] {
    return anomalies.filter(entry => entry.severity === 'failure').map(entry => ({ layer: 'walk', kind: 'contract',
        id: ['walk', entry.kind, entry.scenario, entry.step, entry.metric].join(':'),
        summary: entry.route + ' ' + entry.metric + '=' + entry.observed + ' exceeds ' + entry.limit,
        detail: { ...entry } }));
}
