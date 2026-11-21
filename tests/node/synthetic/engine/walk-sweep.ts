import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import type { WalkResult, WalkScenario, WalkStep } from './navigator-walk';
import { GATE_COMMANDS } from '../../../../src/compat/shim-registry';
import { BUILT_IN_REVIEW_TYPE_IDS } from '../../../../src/core/review-catalog';
import { economyFacts, SWEEP_EDITS, type EconomyFacts } from './walk-economy';

export type ArtifactKind = 'preflight' | 'context' | 'report' | 'receipt' | 'launch' | 'checklist';
export interface ArtifactRead { path: string; kind: ArtifactKind }
/** Real gates a confused agent runs instead of the command next-step named. */
export const WRONG_GATES = ['compile-gate', 'build-review-context', 'required-reviews-check', 'completion-gate', 'restart-coherent-cycle'] as const;
export type WrongGate = typeof WRONG_GATES[number];
/**
 * Wrong-gate checkpoints: the first step of each of these baseline gates (before compile, before the full suite,
 * before, during and after reviews, before completion). Every wrong gate runs at each of them, never at every step.
 */
export const WRONG_GATE_CHECKPOINTS: readonly string[] = Object.freeze(['implementation', 'compile-gate', 'full-suite-validation',
    'build-review-context', 'record-review-result', 'required-reviews-check', 'completion-gate']);
/** Evidence an undisturbed task records on its way to DONE, in the order its baseline records it. */
export const WALK_MILESTONES: readonly string[] = Object.freeze(['COMPILE_GATE_PASSED', 'FULL_SUITE_VALIDATION_PASSED',
    'FULL_SUITE_VALIDATION_SKIPPED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED']);

export type SweepDisturbance =
    | { kind: keyof typeof SWEEP_EDITS | 'repeat-last' | 'fail-gate' | 'stale-lock' | 'change-criteria' | 'change-policy' | 'reset-task' }
    | { kind: 'delete-artifact' | 'corrupt-artifact' | 'stale-artifact'; artifact: ArtifactRead }
    | { kind: 'wrong-gate'; gate: WrongGate };
export interface SweepInjection {
    seed: number; baseline: string; step: number; gate: string | null;
    /** Scripted checkpoints follow a gate/lane instead of a lifecycle offset. step records the resolved index. */
    checkpoint?: { lane?: string };
    disturbances: SweepDisturbance[];
    /**
     * What the undisturbed baseline did. A wrong-gate variant must not review more or restart more, must not reach
     * DONE with less, and its next navigation must name one of `returnRoutes`.
     */
    undisturbed?: { reviews: Record<string, number>; milestones: string[]; restarts: Record<string, number>; returnRoutes: string[] };
    /** Baseline facts the review-economy bound is computed from; absent when the baseline had a failed review. */
    economy?: EconomyFacts;
    /** Independent scenario expectation, when criteria or reset actually change which lanes remain required. */
    requiredAtDone?: string[];
}

export function walkInjectionDue(injection: SweepInjection, index: number, gate: string | null, lane: string): boolean {
    return injection.checkpoint ? gate === injection.gate && (!injection.checkpoint.lane || lane === injection.checkpoint.lane)
        : index === injection.step;
}

export function artifactKind(file: string): ArtifactKind | null {
    const name = path.basename(file);
    if (/preflight.*\.json$/u.test(name)) return 'preflight';
    if (/review-context.*\.(?:json|md)$/u.test(name)) return 'context';
    if (/receipt.*\.json$/u.test(name)) return 'receipt';
    if (/launch.*\.json$/u.test(name)) return 'launch';
    if (/quality.*(?:answers|checklist).*\.json$/u.test(name)) return 'checklist';
    if (/(?:review-output|review-report|review-result|report).*\.(?:json|md)$/u.test(name)) return 'report';
    if (/-review\.json$/u.test(name)) return 'report';
    if (/^T-WALK-(?:code|db|security|refactor|api|test|performance|infra|dependency|custom-quality)\.md$/u.test(name)) return 'report';
    if (/^T-WALK-.+-artifact-[a-f0-9]{64}\.md$/u.test(name)) return 'report';
    // Gate evidence such as compile-gate.json and doc-impact-gate.json is a report even without
    // "report" in its filename. Do not silently omit those task-scoped workflow artifacts.
    if (/(?:^|\/)runtime\/(?:reviews|reports)\/T-WALK[^/]*\.(?:json|md|txt|log)$/u.test(file.replace(/\\/gu, '/'))) return 'report';
    return null;
}

/** Observe the real command's existing artifact inputs; outputs created by that command are excluded. */
export async function captureArtifactReads<T>(root: string, action: () => Promise<T>): Promise<{ value: T; reads: ArtifactRead[] }> {
    const native = require('node:fs') as typeof fs;
    const original = native.readFileSync;
    const open = native.openSync, read = native.readSync, close = native.closeSync, rename = native.renameSync;
    const descriptors = new Map<number, string>();
    const reads = new Map<string, ArtifactRead>();
    const existing = new Set<string>();
    const scan = (directory: string) => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) scan(file);
            else if (entry.isFile() && artifactKind(file)) existing.add(path.resolve(file));
        }
    };
    scan(path.join(root, 'garda-agent-orchestrator/runtime'));
    // Track writes as well, so reading an output later in the command does not call it an input.
    const write = native.writeFileSync, written = new Set<string>();
    const observe = (file: string) => {
        const absolute = path.resolve(file), relative = path.relative(root, absolute).replace(/\\/gu, '/');
        const kind = artifactKind(relative);
        if (kind && existing.has(absolute) && !relative.startsWith('../') && relative.includes('/runtime/') && !written.has(absolute)) reads.set(relative, { path: relative, kind });
    };
    const probes = (['existsSync', 'statSync', 'lstatSync'] as const).map(name => ({ name, original: native[name] }));
    for (const probe of probes) Reflect.set(native, probe.name, (file: unknown, ...args: unknown[]) => {
        if (typeof file === 'string') observe(file);
        return Reflect.apply(probe.original, native, [file, ...args]);
    });
    native.openSync = ((file: fs.PathLike, ...args: unknown[]) => {
        const descriptor = Reflect.apply(open, native, [file, ...args]) as number;
        if (typeof file === 'string') descriptors.set(descriptor, file);
        return descriptor;
    }) as typeof open;
    native.readSync = ((descriptor: number, ...args: unknown[]) => {
        const file = descriptors.get(descriptor);
        if (file) observe(file);
        return Reflect.apply(read, native, [descriptor, ...args]);
    }) as typeof read;
    native.closeSync = ((descriptor: number) => {
        descriptors.delete(descriptor);
        return close(descriptor);
    }) as typeof close;
    native.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
        if (typeof to === 'string') written.add(path.resolve(to));
        return rename(from, to);
    }) as typeof rename;
    native.writeFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (typeof file === 'string') written.add(path.resolve(file));
        return Reflect.apply(write, native, [file, ...args]);
    }) as typeof write;
    native.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        const name = typeof file === 'string' ? file : typeof file === 'number' ? descriptors.get(file) : undefined;
        if (name) observe(name);
        return Reflect.apply(original, native, [file, ...args]);
    }) as typeof original;
    try { return { value: await action(), reads: [...reads.values()].sort((a, b) => a.path.localeCompare(b.path)) }; }
    finally {
        native.readFileSync = original; native.writeFileSync = write; native.openSync = open;
        native.readSync = read; native.closeSync = close; native.renameSync = rename;
        for (const probe of probes) Reflect.set(native, probe.name, probe.original);
    }
}

/** Step indexes where the sweep runs wrong gates: the first nonterminal step of each checkpoint gate. */
export function wrongGateCheckpoints(result: Pick<WalkResult, 'steps'>): number[] {
    return WRONG_GATE_CHECKPOINTS.flatMap(gate => {
        const first = result.steps.find(step => step.gate === gate && step.status !== 'DONE');
        return first ? [first.index] : [];
    }).sort((a, b) => a - b);
}

/** Valid arguments for a wrong gate, as a confused agent would copy them from earlier next-step output. */
export function wrongGateArgv(gate: WrongGate, task: { taskId: string; preflightPath: string; taskIntent: string; changedFiles: readonly string[] }): string[] {
    const preflight = ['--preflight-path', task.preflightPath];
    switch (gate) {
    case 'compile-gate':
    case 'completion-gate':
        return [gate, '--task-id', task.taskId, ...preflight, '--repo-root', '.'];
    case 'build-review-context':
        return [gate, '--review-type', 'code', '--depth', '2', ...preflight, '--repo-root', '.'];
    case 'required-reviews-check':
        return [gate, '--task-id', task.taskId, ...preflight, '--review-authorship-attestation-json', JSON.stringify({ code: true, test: true }), '--repo-root', '.'];
    case 'restart-coherent-cycle':
        return [gate, '--task-id', task.taskId, ...preflight, '--task-intent', task.taskIntent,
            ...[...new Set(task.changedFiles)].sort().flatMap(file => ['--changed-file', file]), '--repo-root', '.'];
    }
}

/** Events that roll a task back: a new review cycle, a coherent restart or a task reset. */
export const WALK_RESTART_EVENTS: readonly string[] = Object.freeze(['REVIEW_CYCLE_RESTARTED', 'COHERENT_CYCLE_RESTARTED', 'TASK_RESET']);

export function walkRestarts(events: WalkResult['events']): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of events) if (WALK_RESTART_EVENTS.includes(event.type)) counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
}

/** The lane a wrong gate acts on, so its route matches the baseline's own run of that gate. */
function wrongGateRoute(gate: WrongGate): string {
    return 'BLOCKED/' + gate + (gate === 'build-review-context' ? '/code' : '');
}

/**
 * Where next-step may send the agent right after a wrong gate: the step it named before, or the step the baseline
 * reaches right after its own later run of that gate (the gate legitimately did that step's work early).
 */
export function wrongGateReturnRoutes(result: Pick<WalkResult, 'steps'>, index: number, gate: WrongGate): string[] {
    const named = result.steps[index]?.route;
    const routes = new Set<string>(named ? [named] : []);
    for (const step of result.steps.slice(index)) {
        const following = result.steps[step.index + 1];
        if (step.route === wrongGateRoute(gate) && following?.route) routes.add(following.route);
    }
    return [...routes];
}

/** Ordered milestone types of an undisturbed run, each once. */
export function walkMilestones(events: WalkResult['events']): string[] {
    return [...new Set(events.map(event => event.type).filter(type => WALK_MILESTONES.includes(type)))];
}

/**
 * Milestones a DONE run lacks after its latest implementation or coherent restart, in the baseline's order.
 * Evidence recorded before a restart or before the implementation does not count for the final cycle.
 */
export function missingWalkMilestones(events: WalkResult['events'], expected: readonly string[]): string[] {
    const cycle = Math.max(...events.map((event, index) => ['COHERENT_CYCLE_RESTARTED', 'IMPLEMENTATION_STARTED'].includes(event.type) ? index : -1), -1);
    let cursor = cycle + 1;
    const missing: string[] = [];
    for (const milestone of expected) {
        const found = events.findIndex((event, index) => index >= cursor && event.type === milestone);
        if (found < 0) missing.push(milestone); else cursor = found + 1;
    }
    return missing;
}

/** A programming error, not a gate refusal: an agent's wrong gate must refuse, never crash. */
export function isUncaughtGateError(output: string): boolean {
    return /^(?:TypeError|ReferenceError|RangeError|SyntaxError|AssertionError|EvalError|URIError)\b|\bCannot read propert(?:y|ies) of (?:undefined|null)\b|Maximum call stack size exceeded/mu.test(output);
}

export function applicableDisturbances(step: WalkStep, previous?: WalkStep, wrongGateCheckpoint = false, scopedExtraEdits = false): SweepDisturbance[] {
    if (step.status === 'DONE') return [];
    const disturbances: SweepDisturbance[] = [
        { kind: 'edit-production' }, { kind: 'edit-test' }, { kind: 'edit-document' },
        { kind: 'stale-lock' }, { kind: 'change-criteria' }, { kind: 'reset-task' },
        { kind: 'edit-test-large' }, { kind: 'edit-production-large' }, { kind: 'add-test-file' }, { kind: 'add-production-file' }, { kind: 'change-policy' }
    ];
    // These files exist in the specialized baseline only after its implementation step writes them.
    if (scopedExtraEdits) disturbances.push({ kind: 'edit-shared-test-helper' }, { kind: 'edit-protected' });
    if (previous?.command && previous.exitCode !== null) disturbances.push({ kind: 'repeat-last' });
    // The fixture has executable failure flags for these gates. Other gates have no generic safe failure injection;
    // their real artifact rejection paths are enumerated independently below, never simulated with a fake result.
    if (['compile-gate', 'full-suite-validation'].includes(step.gate ?? '')) disturbances.push({ kind: 'fail-gate' });
    for (const artifact of step.reads ?? []) for (const kind of ['delete-artifact', 'corrupt-artifact', 'stale-artifact'] as const) disturbances.push({ kind, artifact });
    // Running the gate next-step named is not a wrong gate.
    if (wrongGateCheckpoint) for (const gate of WRONG_GATES) if (gate !== step.gate) disturbances.push({ kind: 'wrong-gate', gate });
    return disturbances;
}

export function disturbanceId(disturbance: SweepDisturbance): string {
    return disturbance.kind + ('artifact' in disturbance ? ':' + disturbance.artifact.path : 'gate' in disturbance ? ':' + disturbance.gate : '');
}

/** Stable replay identity, independent of fresh digest-named artifacts. */
function sweepScenarioId(baseline: string, step: number, disturbances: readonly SweepDisturbance[], seed: number): string {
    const digest = createHash('sha256').update(JSON.stringify(disturbances.map(disturbanceId)
        .map(id => id.replace(/[a-f0-9]{16,64}/gu, '<digest>')))).digest('hex').slice(0, 12);
    return 'sweep-' + baseline + '-s' + step + '-d' + digest + '-seed' + seed;
}

/** Restore exact selected variants from a retained manifest even if a fresh baseline observes different inputs. */
export function replaySweepScenarios(baselines: readonly { scenario: WalkScenario; result: WalkResult }[], saved: readonly (SweepInjection & { id: string })[],
    only: readonly string[], seed: number): WalkScenario[] {
    if (!only.length || new Set(only).size !== only.length) throw new Error('Manifest replay requires distinct selected sweep IDs');
    const entries = new Map<string, SweepInjection & { id: string }>();
    for (const entry of saved) {
        if (entries.has(entry.id)) throw new Error('Duplicate sweep manifest ID: ' + entry.id);
        entries.set(entry.id, entry);
    }
    return only.map(id => {
        const entry = entries.get(id), baseline = baselines.find(candidate => candidate.scenario.id === entry?.baseline);
        if (!entry || !baseline || entry.seed !== seed || !Number.isSafeInteger(entry.step) || entry.step < 0
            || !Array.isArray(entry.disturbances) || !entry.disturbances.length
            || sweepScenarioId(entry.baseline, entry.step, entry.disturbances, seed) !== id) {
            throw new Error('Invalid or unknown selected sweep manifest ID: ' + id);
        }
        if (baseline.result.steps[entry.step]?.gate !== entry.gate
            || JSON.stringify(economyFacts(baseline.scenario, baseline.result)) !== JSON.stringify(entry.economy)) {
            throw new Error('Sweep baseline changed since the retained manifest: ' + id);
        }
        const { id: _id, ...injection } = entry;
        return { ...baseline.scenario, id, injection, expectedReviews: {}, expectedModes: [] };
    });
}

/** Task-owned files known to the synthetic operator when a reset re-enters the same task. */
export function resetPlannedFiles(scenario: WalkScenario): string[] {
    const files = scenario.edits.map(edit => edit.path);
    for (const disturbance of scenario.injection?.disturbances ?? []) {
        if (disturbance.kind in SWEEP_EDITS) files.push(SWEEP_EDITS[disturbance.kind as keyof typeof SWEEP_EDITS].path);
    }
    return [...new Set(files)].sort();
}

/** Before task entry there is no state to remove; Garda explicitly reports this idempotent reset. */
export function isCompletedSweepReset(output: string): boolean {
    return /^RESET_COMPLETE$/mu.test(output) || /^ALREADY_RESET$/mu.test(output)
        && /^PreviousStatus: TODO$/mu.test(output) && /^TargetStatus: TODO$/mu.test(output)
        && /^Note: Task already TODO with no remaining artifacts\.$/mu.test(output);
}

export function sweepApplicability(result: WalkResult): Array<{ step: number; gate: string | null; applicable: string[]; omitted: string[] }> {
    const checkpoints = wrongGateCheckpoints(result);
    const implementation = result.steps.find(step => step.gate === 'implementation')?.index ?? Number.MAX_SAFE_INTEGER;
    return result.steps.map(step => {
        const scoped = result.scenarioId === 'security-refactor-pass' && step.index > implementation;
        const applicable = applicableDisturbances(step, result.steps[step.index - 1], checkpoints.includes(step.index), scoped).map(disturbanceId);
        const omitted = (['preflight', 'context', 'report', 'receipt', 'launch', 'checklist'] as const)
            .filter(kind => !step.reads?.some(read => read.kind === kind)).map(kind => kind + ': no existing input of this kind observed in the next action');
        if (!applicable.includes('fail-gate')) omitted.push('fail-gate: no failing external-command fixture for this gate; artifact rejection variants are enumerated separately');
        if (!applicable.includes('repeat-last')) omitted.push('repeat-last: no preceding executed command');
        if (!applicable.some(id => id.startsWith('wrong-gate:')) && step.status !== 'DONE') omitted.push('wrong-gate: not a wrong-gate checkpoint (first step of ' + WRONG_GATE_CHECKPOINTS.join(', ') + ')');
        if (step.status === 'DONE') omitted.push('terminal: no next action');
        return { step: step.index, gate: step.gate, applicable, omitted };
    });
}

export function buildSweepScenarios(baselines: readonly { scenario: WalkScenario; result: WalkResult }[], seed: number): WalkScenario[] {
    let state = seed >>> 0;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
    const scenarios: WalkScenario[] = [];
    for (const { scenario, result } of baselines) for (const step of result.steps) {
        const economy = economyFacts(scenario, result);
        const checkpoints = wrongGateCheckpoints(result);
        const implementation = result.steps.find(entry => entry.gate === 'implementation')?.index ?? Number.MAX_SAFE_INTEGER;
        const scoped = scenario.id === 'security-refactor-pass' && step.index > implementation;
        const applicable = applicableDisturbances(step, result.steps[step.index - 1], checkpoints.includes(step.index), scoped);
        const variants = applicable.map(entry => [entry]);
        // Wrong gates are single variants only. Combinations draw from the other disturbances, so adding
        // wrong gates neither changes existing combinations nor consumes the seeded generator.
        const addedSingles = ['edit-test-large', 'edit-production-large', 'add-test-file', 'edit-shared-test-helper', 'add-production-file', 'edit-protected', 'change-policy'];
        const combinable = applicable.filter(entry => entry.kind !== 'wrong-gate' && !addedSingles.includes(entry.kind));
        if (combinable.length >= 2) {
            const shuffled = [...combinable];
            for (let index = shuffled.length - 1; index > 0; index--) {
                const selected = Math.floor(random() * (index + 1));
                [shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
            }
            const inputs = new Set<string>();
            const compatible = shuffled.filter(entry => {
                if (!('artifact' in entry)) return true;
                if (inputs.has(entry.artifact.path)) return false;
                inputs.add(entry.artifact.path); return true;
            });
            variants.push(compatible.slice(0, 2 + Math.floor(random() * Math.min(3, compatible.length - 1)))
                .sort((a, b) => Number(a.kind === 'reset-task') - Number(b.kind === 'reset-task')));
        }
        variants.forEach(disturbances => scenarios.push({ ...scenario,
            id: sweepScenarioId(scenario.id, step.index, disturbances, seed),
            injection: { seed, baseline: scenario.id, step: step.index, gate: step.gate, disturbances, ...(economy ? { economy } : {}),
                ...(disturbances.length === 1 && disturbances[0].kind === 'wrong-gate'
                    ? { undisturbed: { reviews: { ...result.reviewsByLane }, milestones: walkMilestones(result.events),
                        restarts: walkRestarts(result.events), returnRoutes: wrongGateReturnRoutes(result, step.index, disturbances[0].gate) } } : {}) },
            // Exact review counts belong to the baseline and scenario families: a mutation can legitimately change
            // them. A disturbed variant is judged against the rule-derived bound of walk-economy.ts instead.
            expectedReviews: {}, expectedModes: []
        }));
    }
    if (new Set(scenarios.map(scenario => scenario.id)).size !== scenarios.length) throw new Error('Sweep roles are ambiguous; refusing colliding replay IDs');
    return scenarios;
}

/** Resolve a recreated artifact by its exact role, including a fresh digest where applicable. */
export function resolveSweepArtifact(root: string, artifact: ArtifactRead): string | null {
    const file = path.resolve(root, artifact.path);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Sweep artifact escapes fixture');
    if (fs.existsSync(file)) return file;
    // Launch output nonces and receipt content hashes are intentionally fresh on each prefix replay.
    const shape = (name: string) => name.replace(/[a-f0-9]{16,64}/gu, '<digest>');
    const directory = path.dirname(file);
    const matches = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => shape(name) === shape(path.basename(file))) : [];
    if (matches.length > 1) throw new Error('Sweep input cannot be resolved uniquely: ' + artifact.path);
    return matches.length ? path.join(directory, matches[0]) : null;
}

export function mutateSweepFile(root: string, disturbance: SweepDisturbance): void {
    if ('artifact' in disturbance) {
        const file = resolveSweepArtifact(root, disturbance.artifact);
        if (!file) throw new Error('Sweep input cannot be resolved uniquely: ' + disturbance.artifact.path);
        if (disturbance.kind === 'delete-artifact') fs.unlinkSync(file);
        else if (disturbance.kind === 'corrupt-artifact') fs.writeFileSync(file, '{broken synthetic artifact\n');
        else {
            if (!file.endsWith('.json')) {
                fs.appendFileSync(file, '\n<!-- Stale evidence from 2000-01-01. -->\n');
                fs.utimesSync(file, new Date(0), new Date(0));
                return;
            }
            const artifact = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            // Change content-bound identity as well as time. mtime alone is not Garda's freshness contract.
            artifact.generated_utc = '2000-01-01T00:00:00.000Z';
            const ageBindings = (value: unknown): void => {
                if (!value || typeof value !== 'object') return;
                for (const [key, child] of Object.entries(value)) {
                    if (/^(?:preflight|review_context|scope|scope_content|review_scope|code_scope|routing_event)_sha256$/u.test(key)
                        && typeof child === 'string' && /^[a-f0-9]{64}$/u.test(child)) {
                        (value as Record<string, unknown>)[key] = '0'.repeat(64);
                    } else ageBindings(child);
                }
            };
            ageBindings(artifact);
            fs.writeFileSync(file, JSON.stringify(artifact) + '\n');
            fs.utimesSync(file, new Date(0), new Date(0));
        }
        return;
    }
    if (disturbance.kind in SWEEP_EDITS) {
        const edit = SWEEP_EDITS[disturbance.kind as keyof typeof SWEEP_EDITS];
        const file = path.join(root, edit.path);
        if ((edit.role === 'new-test' || edit.role === 'new-production') && fs.existsSync(file)) throw new Error('Sweep new file already exists: ' + edit.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, edit.append);
        // The edit happens now on the stand's clock, the clock the modeled reviewer's output and the gates use; the
        // file system would otherwise stamp the machine's clock, which lags behind the reviewer's simulated work.
        const now = new Date();
        fs.utimesSync(path.join(root, edit.path), now, now);
    } else if (disturbance.kind === 'change-criteria') {
        const file = path.join(root, 'TASK.md');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Change the status renderer', 'Change the status renderer and reject empty status'));
    } else if (disturbance.kind === 'change-policy') {
        const file = path.join(root, 'garda-agent-orchestrator/live/config/profiles.json');
        const profiles = JSON.parse(fs.readFileSync(file, 'utf8')) as { built_in_profiles: Record<string, { review_policy: Record<string, unknown> }> };
        const taskRow = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8').split(/\r?\n/u).find(line => /^\|\s*T-WALK\s*\|/u.test(line));
        const profile = taskRow?.split('|')[8]?.trim();
        const policy = profile && profiles.built_in_profiles[profile]?.review_policy;
        if (!policy) throw new Error('Cannot change the task\'s active review policy: ' + (profile ?? 'task profile not found'));
        policy.code = policy.code === 'auto' ? true : 'auto';
        fs.writeFileSync(file, JSON.stringify(profiles, null, 2) + '\n');
    } else if (disturbance.kind === 'stale-lock') {
        const lock = path.join(root, 'garda-agent-orchestrator/runtime/task-events/.T-WALK.lock');
        fs.mkdirSync(lock, { recursive: true });
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ lock_id: 'synthetic-stale-lock', pid: 2147483647,
            hostname: os.hostname(), created_at_utc: '2000-01-01T00:00:00.000Z', heartbeat_at_utc: '2000-01-01T00:00:00.000Z', command: 'synthetic abandoned writer' }));
        fs.utimesSync(lock, new Date(0), new Date(0));
    }
}

/** A repeated command may refuse with an instruction the agent can follow through the navigator. */
function hasRecoveryInstruction(reason: string, rejectedGate?: string): boolean {
    const action = /(?:^|[.!?:]\s+)(?:ask|confirm|repair|restore|reset|stage|create(?: or update)?|update|set|reopen|isolate|preserve|enable|explicitly reopen)\s+/iu.test(reason);
    const object = /(?:task|artifact|workspace|scope|provider|file|config|evidence|manifest|lock|criteria|plan)/iu.test(reason);
    const command = [...reason.matchAll(/\b(?:garda|gao)(?:\.js)?["']?\s+(gate\s+([a-z][a-z-]+)|workflow|task|doctor|next-step)\b/giu)]
        .some(match => !match[2] || GATE_COMMANDS.includes(match[2].toLowerCase()) && match[2].toLowerCase() !== rejectedGate)
        || [...reason.matchAll(/\b(?:run|rerun|use|or)\s+(?:gate\s+)?([a-z][a-z-]+)\b/giu)]
            .some(match => GATE_COMMANDS.includes(match[1].toLowerCase()) && match[1].toLowerCase() !== rejectedGate);
    const upstream = /upstream reviews pass for the current cycle:\s*([a-z][a-z0-9_, -]*)\./iu.exec(reason)?.[1]
        .split(',').map(lane => lane.trim().toLowerCase());
    const reviewInstruction = /\bRun and record those reviews first\./iu.test(reason) && upstream?.length
        && upstream.every(lane => BUILT_IN_REVIEW_TYPE_IDS.some(known => known === lane));
    const directGate = [...reason.matchAll(/(?:^|[.!?:]\s+)([a-z][a-z-]+)\s+before\b/giu)]
        .some(match => GATE_COMMANDS.includes(match[1].toLowerCase()) && match[1].toLowerCase() !== rejectedGate);
    const contextRepair = /\bRebuild (?:the )?review context\b/iu.test(reason)
        && GATE_COMMANDS.includes('build-review-context') && rejectedGate !== 'build-review-context';
    const completedScopeIsolation = /\bCommit or isolate the already-completed task diff\b/iu.test(reason);
    const preEntryIsolation = /Workspace already contained modified files before task-mode entry:/u.test(reason)
        && /Clean\/stash unrelated changes, or rerun classify-change with --use-staged or explicit --changed-file scope after entering task mode\./u.test(reason);
    // Same gate, different authenticated transport: the timing guard explicitly requires stdin after
    // delegation. A generic suggestion to repeat the rejected gate still does not qualify.
    const delegatedStdinRecovery = rejectedGate === 'record-review-result'
        && /Review output path-mode timing is impossible/u.test(reason)
        && /Safe recovery: rerun record-review-result by piping the same delegated reviewer output through stdin after\s+delegation evidence exists\./u.test(reason)
        && /--review-output-stdin\b/u.test(reason);
    return !!(action && object || command || reviewInstruction || directGate || contextRepair || completedScopeIsolation
        || preEntryIsolation || delegatedStdinRecovery);
}

/** A terminal handoff requires a person or manual repair of evidence the agent cannot manufacture. */
export function hasHumanRecovery(reason: string, _rejectedGate?: string): boolean {
    const noApproval = /\b(?:no|without)\s+(?:explicit\s+)?(?:user|operator|human)(?:'s)?\s+(?:approval|confirmation|authorization)\b/iu.test(reason)
        || /\b(?:user|operator|human)(?:'s)?\s+(?:approval|confirmation|authorization)\s+is\s+not\s+(?:required|needed)\b/iu.test(reason);
    const approval = /\b(?:requires?|needs?|awaits?|obtain|request|after|with|pending)\s+(?:(?:the|an?|explicit|fresh|required)\s+)*(?:user|operator|human)(?:'s)?\s+(?:approval|confirmation|authorization|decision|intervention|action)\b/iu.test(reason)
        || /\b(?:user|operator|human)(?:'s)?\s+(?:approval|confirmation|authorization|decision|intervention|action)\s+is\s+(?:required|needed|necessary|pending)\b/iu.test(reason)
        || /\buser approval command:/iu.test(reason);
    const person = /\b(?:ask|contact|notify|await|require|requires|request|obtain)\s+(?:the\s+)?(?:user|operator|human)\b/iu.test(reason)
        || !noApproval && approval
        || /\b(?:use|run|perform|preview|request|requires?|needs?)\s+(?:(?:the|an?|explicit)\s+)*operator\s+(?:task-reset|reset|remediation|decision)\b/iu.test(reason)
        || /\bworkflow\s+set\b[\s\S]{0,400}--operator-confirmed\b/iu.test(reason)
        || /\b(?:user|operator|human)\s+(?:must|should|repairs|resets|selects|confirms)\b/iu.test(reason);
    const manualEvidence = /(?:^|[.!?:]\s+)(?:repair|restore)\s+(?:the\s+)?(?:task\s+)?(?:artifact|evidence|workspace|manifest|lock)\b/iu.test(reason)
        && /\b(?:authenticated|immutable|protected|original|trusted)\b/iu.test(reason);
    const completedScopeIsolation = /\bCommit or isolate the already-completed task diff\b/iu.test(reason);
    const preEntryIsolation = /Workspace already contained modified files before task-mode entry:/u.test(reason)
        && /Clean\/stash unrelated changes, or rerun classify-change with --use-staged or explicit --changed-file scope after entering task mode\./u.test(reason);
    return person || manualEvidence || completedScopeIsolation || preEntryIsolation;
}

/**
 * The out-of-order refusal of src/cli/commands/gate-flows/support/out-of-order-gate-guard.ts for exactly this gate:
 * a *_REFUSED header, the named next-step route, "Nothing was changed." and next-step as the way out. The caller
 * must also show that the refused run left the workspace and runtime evidence unchanged.
 */
export function isOutOfOrderRefusal(output: string, rejectedGate: string | undefined): boolean {
    if (!rejectedGate || !/^[a-z][a-z-]*$/u.test(rejectedGate)) return false;
    return /^[A-Z][A-Z_]*_REFUSED$/mu.test(output)
        && new RegExp(`\\b${rejectedGate} is out of order for task '[^']+': next-step routes the current cycle to '[a-z][a-z-]*(?: \\([a-z-]+\\))?'\\.`, 'u').test(output)
        && /\bNothing was changed\. Run next-step and follow the gate it names\b/u.test(output);
}

export function isActionableIntegrityRefusal(output: string, rejectedGate?: string): boolean {
    const closedReviewStage = /Recovery after (?:REVIEW_GATE_PASSED(?:_WITH_OVERRIDE)?|COMPLETION_GATE_PASSED): run next-step to continue closing/u.test(output);
    const closedCycleRestart = rejectedGate === 'restart-review-cycle'
        && /restart-review-cycle cannot continue after the current task-mode cycle already reached '(?:REVIEW_GATE_PASSED(?:_WITH_OVERRIDE)?|COMPLETION_GATE_PASSED)'/u.test(output)
        && /Run restart-coherent-cycle to begin a fresh coherent cycle from task entry before rebuilding review contexts\./u.test(output);
    return (closedReviewStage || closedCycleRestart || /integrity|authentic|stale|immutable|corrupt|missing|mismatch|not found|ENOENT|unreadable|malformed|invalid JSON|requires a readable|must contain valid/iu.test(output))
        && hasRecoveryInstruction(output, rejectedGate);
}
