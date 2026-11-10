import { counterBudgets, type CounterBaseline } from './walk-metrics';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWalkJson, walkHash } from './walk-run-store';
import { timingDistribution } from './step-timing';
import { validatePermanentReviewCases } from './walk-stack-review-scenarios';
import type { PlatformBaselines } from './walk-platform-baselines';

export const BASELINE_FILES = {
    counters: 'walk-counter-baseline.json', timing: 'step-timing-baseline.json', expectations: 'stand-expectations.json', 'timing-manifest': 'step-timing-manifest.json',
    'review-cases': 'stack-review-cases.json', 'counter-platforms': 'walk-counter-platforms.json'
} as const;
export type BaselineKind = keyof typeof BASELINE_FILES;
export const EXPECTATION_SOURCES = ['engine/walk-scenarios.ts', 'engine/walk-stack-scenarios.ts', 'engine/walk-stack-parent.ts', 'engine/walk-unknown-stack-contract.ts',
    'engine/walk-field-cases.ts', 'engine/walk-remediation-script.ts', 'engine/common-review-matrix.ts', 'engine/review-matrix-native.ts', 'review-matrix.cjs', 'engine/walk-preserved-delta-counter-state.ts', 'preserved-delta-counter-calibration-evidence.json', 'engine/walk-field-case-ids.ts', 'engine/stand-check-plan.ts', 'engine/stand-check-observation.ts',
    'engine/stand-properties.ts', 'stand-properties.json', '../../../docs/stand/concept-rules.md', '../../../docs/stand/review-transition-matrix.md',
    'engine/walk-clock.ts', 'engine/walk-native-owner.ts', 'engine/walk-plan.ts', 'engine/walk-progress.ts', '../../fixtures/stacks/review-rotation.json',
    'engine/walk-run-store.ts', 'engine/walk-restored-parent-controls.ts', 'engine/walk-economy.ts', 'known-findings.json', 'known-walk-findings.json', 'known-uncovered-routes.json', 'api-counter-calibration-evidence.json', 'native-counter-input-shapes.json', 'native-counter-calibration-evidence.json', 'single-repair-counter-calibration-evidence.json', 'engine/walk-metrics.ts', 'engine/navigator-walk.ts',
    '../../fixtures/stacks/tasks.json', '../../fixtures/stacks/catalog.json'];
export function fileDigest(file: string): string { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
export function expectationManifest(root: string): Record<string, string> {
    const sources = [...new Set([...EXPECTATION_SOURCES, ...fs.readdirSync(path.join(root, 'engine'))
        .filter(file => /^walk-.*scenarios\.ts$/u.test(file)).map(file => 'engine/' + file)])].sort();
    return Object.fromEntries(sources.map(file => [file, fileDigest(path.join(root, file))]));
}
interface BaselinePolicy { schema_version: 1; reason: string; files: Record<string, string> }
export function inspectBaselinePolicy(root: string): string[] {
    try {
        const policy = JSON.parse(fs.readFileSync(path.join(root, 'baseline-policy.json'), 'utf8')) as BaselinePolicy;
        const problems = Object.values(BASELINE_FILES).filter(file => policy.files[file] !== fileDigest(path.join(root, file)))
            .map(file => 'Unrecorded baseline edit: ' + file);
        const expected = JSON.parse(fs.readFileSync(path.join(root, BASELINE_FILES.expectations), 'utf8')) as { sources: Record<string, string> };
        if (walkHash(expected.sources) !== walkHash(expectationManifest(root))) problems.push('Expectations changed without an explicit baseline decision');
        return problems;
    } catch (error) { return ['Baseline policy invalid: ' + String(error)]; }
}
export interface BaselineDecision {
    kind: BaselineKind; candidate: string; reason: string; release: string; sourceCommit: string; expectedSha256: string;
    formatOnly?: boolean;
}
/** Deliberate replacement only. Neither runner nor a red report calls this. */
export function acceptStandBaseline(root: string, decision: BaselineDecision): string {
    if (!Object.hasOwn(BASELINE_FILES, decision.kind) || !decision.reason?.trim() || !decision.release?.trim()
        || !/^[a-f0-9]{40}$/u.test(decision.sourceCommit)) throw new Error('Baseline requires kind, written reason, exact release and full source commit');
    const target = path.join(root, BASELINE_FILES[decision.kind]), previous = fs.readFileSync(target);
    if (fileDigest(target) !== decision.expectedSha256) throw new Error('Baseline changed since review: expected-sha256 differs');
    const bytes = decision.kind === 'expectations' && decision.candidate === 'current'
        ? Buffer.from(JSON.stringify({ schema_version: 1, sources: expectationManifest(root) })) : fs.readFileSync(path.resolve(decision.candidate));
    const candidate = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (decision.kind === 'counter-platforms') {
        const platforms = (candidate as unknown as PlatformBaselines).platforms;
        if (candidate.schema !== 1 || !platforms || Object.hasOwn(platforms, 'win32')) throw new Error('Windows budgets stay in the original counter baseline');
        const previousPlatforms = (JSON.parse(previous.toString('utf8')) as PlatformBaselines).platforms;
        for (const [platform, entry] of Object.entries(platforms)) {
            if (!entry.evidence?.trim() || !['MEASURED', 'NEEDS_CALIBRATION'].includes(entry.status)
                || entry.status === 'MEASURED' && !Object.keys(entry.baseline?.routes ?? {}).length
                || entry.status === 'NEEDS_CALIBRATION' && entry.baseline !== null) throw new Error('Platform budgets require explicit measurement evidence or null NEEDS_CALIBRATION');
            for (const routes of [entry.baseline?.routes ?? {}, ...Object.values(entry.baseline?.states ?? {}).map(state => state.routes)])
                for (const budgets of Object.values(routes)) for (const budget of Object.values(budgets))
                    if (![budget.expected, budget.tolerance, budget.growthTolerance ?? 0].every(value => Number.isFinite(value) && value >= 0)
                        || typeof budget.constantWithEvents !== 'boolean') throw new Error('Platform counter budgets require finite nonnegative limits and a history rule');
            const before = previousPlatforms[platform]?.baseline;
            if (before) for (const state of [undefined, ...Object.keys(before.states ?? {})]) {
                const routes = new Set([...Object.keys(before.routes), ...Object.values(before.states ?? {}).flatMap(value => Object.keys(value.routes))]);
                for (const route of routes) for (const [counter, budget] of Object.entries(counterBudgets(before, route, state) ?? {})) {
                    const next = entry.baseline && counterBudgets(entry.baseline, route, state)?.[counter];
                    if (counter.startsWith('subprocess:') && (!next || next.expected + next.tolerance > budget.expected + budget.tolerance))
                        throw new Error('Platform subprocess ceilings cannot be raised or removed');
                }
            }
        }
        for (const platform of Object.keys(previousPlatforms)) if (!platforms[platform]) throw new Error('Cannot remove a platform baseline');
    }
    if (decision.kind === 'review-cases') validatePermanentReviewCases(candidate);
    if (decision.formatOnly && walkHash(candidate) !== walkHash(JSON.parse(previous.toString('utf8')))) {
        throw new Error('Format-only decision cannot change baseline values');
    }
    if (decision.kind === 'timing' && !decision.formatOnly) {
        if (process.env.GITHUB_ACTIONS === 'true' || candidate.ci === true) throw new Error('CI timing cannot supply a baseline');
        const routes = candidate.routes as Array<{ key: string; samples_ms: number[]; verdict: string; issues: string[];
            median_ms: number; p95_ms: number; raw_manifest: string; raw_inputs_manifest_sha256: string }>;
        const quiet = candidate.quiet as { quiet?: boolean; duration_ms?: number; host_cpu_percent?: number } | undefined;
        if (candidate.release !== decision.release || candidate.source_commit !== decision.sourceCommit
            || candidate.acceptable_for_baseline !== true || !routes?.length
            || !quiet?.quiet || (quiet.duration_ms ?? 0) < 30_000 || (quiet.host_cpu_percent ?? 100) >= 10
            || routes.some(route => route.samples_ms?.length !== 100 || route.issues?.length || route.verdict === 'FAIL')) {
            throw new Error('Timing candidate lacks a complete quiet, identity-checked 100-sample release measurement');
        }
        const rawManifests: Record<string, unknown> = {};
        for (const route of routes) {
            const stats = timingDistribution(route.samples_ms);
            if (stats.median_ms !== route.median_ms || stats.p95_ms !== route.p95_ms) throw new Error('Timing candidate statistics disagree with raw samples: ' + route.key);
            const candidateRoot = path.dirname(path.resolve(decision.candidate)), rawPath = path.resolve(candidateRoot, route.raw_manifest);
            const relative = path.relative(candidateRoot, rawPath);
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Timing raw manifest escapes candidate directory');
            const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as { raw: unknown; samples_ms: number[] };
            if (walkHash(raw.raw) !== route.raw_inputs_manifest_sha256 || walkHash(raw.samples_ms) !== walkHash(route.samples_ms)) {
                throw new Error('Timing raw manifest digest/samples mismatch: ' + route.key);
            }
            rawManifests[route.key] = raw;
        }
        // An accepted release remains reproducible after its temporary run directory is removed.
        candidate.raw_manifests = rawManifests;
    }
    if (decision.kind === 'timing-manifest') {
        const manifest = candidate as { checkpoints?: unknown[]; limits?: Record<string, number>; normalization_version?: number };
        if (!manifest.checkpoints?.length || !manifest.normalization_version || !manifest.limits
            || Object.values(manifest.limits).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing manifest');
    }
    if (decision.kind === 'expectations' && walkHash(candidate.sources) !== walkHash(expectationManifest(root))) {
        throw new Error('Expectation candidate must contain exact current expectation source hashes');
    }
    if (decision.kind === 'counters') {
        const old = JSON.parse(previous.toString('utf8')) as { routes: Record<string, Record<string, { expected: number; tolerance: number }>> };
        const next = candidate as unknown as typeof old;
        if (candidate.schema !== 1 || !next.routes) throw new Error('Invalid counter baseline');
        const states = (candidate.states ?? {}) as Record<string, { routes: typeof next.routes }>;
        for (const routes of [next.routes, ...Object.values(states).map(state => state.routes)]) {
            if (!routes || typeof routes !== 'object') throw new Error('Invalid counter routes');
            for (const budgets of Object.values(routes)) for (const budget of Object.values(budgets)) {
                const value = budget as typeof budget & { constantWithEvents?: boolean; growthTolerance?: number };
                if (![value.expected, value.tolerance, value.growthTolerance ?? 0].every(number => Number.isFinite(number) && number >= 0)
                    || typeof value.constantWithEvents !== 'boolean') throw new Error('Counter budgets require finite nonnegative limits and a history rule');
            }
        }
        const ceilings = (before: typeof old.routes, after: typeof old.routes) => {
        for (const [route, budgets] of Object.entries(before)) for (const [counter, limit] of Object.entries(budgets)) {
            const replacement = after[route]?.[counter];
            if (counter.startsWith('subprocess:') && (!replacement || replacement.expected + replacement.tolerance > limit.expected + limit.tolerance)) {
                throw new Error('Subprocess ceilings cannot be raised or removed: ' + route + '/' + counter);
            }
        }
        };
        ceilings(old.routes, next.routes);
        const previousStates = (old as CounterBaseline).states ?? {};
        const nextStates = (next as CounterBaseline).states ?? {};
        for (const state of new Set([...Object.keys(previousStates), ...Object.keys(nextStates)])) {
            // A new measured input shape may inherit an existing native route family.
            // Its Git/ACL ceilings remain those already accepted for that family.
            const beforeState = previousStates[state] ? state : nextStates[state]?.inherits;
            if (beforeState && !previousStates[beforeState]) throw new Error('Counter parent must be previously accepted: ' + beforeState);
            const routeIds = new Set([...Object.keys(old.routes), ...Object.values(previousStates).flatMap(value => Object.keys(value.routes)),
                ...Object.values(nextStates).flatMap(value => Object.keys(value.routes))]);
            for (const route of routeIds) ceilings({ [route]: counterBudgets(old as CounterBaseline, route, beforeState) ?? {} },
                { [route]: counterBudgets(next as CounterBaseline, route, state) ?? {} });
        }
    }
    const record = { schema_version: 1, ...decision, candidate: path.resolve(decision.candidate), at: new Date().toISOString(),
        previous_sha256: fileDigest(target), candidate_sha256: createHash('sha256').update(bytes).digest('hex'),
        previous: JSON.parse(previous.toString('utf8')) as unknown, accepted: candidate };
    const evidence = path.join(root, 'baseline-decisions', walkHash(record) + '.json');
    atomicWalkJson(evidence, record); // Evidence is durable before any replacement. An interrupted update fails the seal.
    atomicWalkJson(target, { ...candidate, baseline_update: { reason: decision.reason, previous_sha256: record.previous_sha256,
        evidence: path.relative(root, evidence).replace(/\\/gu, '/'), release: decision.release, source_commit: decision.sourceCommit } });
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'baseline-policy.json'), 'utf8')) as BaselinePolicy;
    policy.files[path.basename(target)] = fileDigest(target);
    policy.reason = decision.reason;
    atomicWalkJson(path.join(root, 'baseline-policy.json'), policy);
    return evidence;
}
