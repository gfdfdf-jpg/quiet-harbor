import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import type { WalkResult, WalkStep } from './navigator-walk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRouteInventory, routeCoverage, type RouteCoverage, type UncoveredRoute } from './walk-routes';
import { analyzeWalkMetrics, type CounterBaseline, type RouteMetrics, type WalkAnomaly } from './walk-metrics';
import { renderReviewEconomy, summarizeReviewEconomy, type EconomySummary } from './walk-economy';

const EVENT_BUCKET_SIZE = 50;

interface GrowthBucket {
    scenario: string;
    route: string;
    taskEvents: string;
    calls: number;
    wallMedianMs: number | null;
    coreMedianMs: number;
    outsideCoreMedianMs: number | null;
    phases: Array<{ phase: string; averageMs: number }>;
}

export interface WalkReport {
    scenarios: Array<{ id: string; counterState?: string; outcome: string; steps: number; taskEvents: number; reviews: string[]; terminalRoute: string; detail: string; replay: string }>;
    measurement: string;
    journals: Array<{ path: string; scenario: string; taskEvents: number }>;
    growth: GrowthBucket[];
    findings: StandFinding[];
    coverage: RouteCoverage;
    metrics: RouteMetrics[];
    anomalies: WalkAnomaly[];
    /** Counter budgets are calibrated undisturbed, so a disturbed variant's counters are reported, never judged. */
    disturbed: { results: number; steps: number; metrics: RouteMetrics[]; overBudget: DisturbedCounterSummary[] };
    /** Reviews of disturbed DONE variants against the rule-derived bound; these are judged. */
    economy: EconomySummary;
    projectSize: Array<{ scenario: string; trackedFiles: number; routes: RouteMetrics[] }>;
    sweep: Array<{ scenario: string; seed: number; baseline: string; step: number; disturbances: string[]; applied: string[] }>;
    executedSteps: number;
    checkpointControls: Array<{ id: string; baseline: string; step: number; outcome: string }>;
    effectResults: Array<{ scenario: string; step: number; gate: string | null; status: string; route: string; routes: string[]; reason: string }>;
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length ? Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : 0;
}

function growthFor(result: WalkResult): GrowthBucket[] {
    const buckets = new Map<string, WalkStep[]>();
    for (const step of result.steps) {
        if (step.reusedPrefix) continue;
        const route = (step.gate ?? '(done)') + (step.diagnostic?.review_lane ? '/' + step.diagnostic.review_lane : '');
        const key = Math.floor(step.taskEvents / EVENT_BUCKET_SIZE) + '|' + route;
        buckets.set(key, [...buckets.get(key) ?? [], step]);
    }
    return [...buckets.entries()].map(([key, steps]) => {
        const [bucket, route] = key.split('|');
        const phases = new Map<string, number>();
        for (const step of steps) {
            const timing = step.diagnostic?.timing as { phases_ms?: Record<string, number> } | null;
            for (const [phase, ms] of Object.entries(timing?.phases_ms ?? step.measurement?.phases_ms ?? {})) {
                if (phase !== 'total') phases.set(phase, (phases.get(phase) ?? 0) + ms);
            }
        }
        const diagnostics = steps.flatMap((step) => step.diagnostic ? [step.diagnostic] : []);
        return {
            scenario: result.scenarioId, route,
            taskEvents: Number(bucket) * EVENT_BUCKET_SIZE + '-' + ((Number(bucket) + 1) * EVENT_BUCKET_SIZE - 1),
            calls: steps.length,
            wallMedianMs: diagnostics.length ? median(diagnostics.map((entry) => entry.wall_ms)) : null,
            coreMedianMs: median(steps.map((step) => step.diagnostic?.core_ms ?? step.navigatorMs)),
            outsideCoreMedianMs: diagnostics.length ? median(diagnostics.map((entry) => entry.outside_core_ms!)) : null,
            phases: [...phases.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
                .map(([phase, ms]) => ({ phase, averageMs: Math.round(ms / steps.length) }))
        };
    });
}

export interface DisturbedCounterSummary { kind: WalkAnomaly['kind']; route: string; metric: string; records: number; maxObserved: number; limit: number; example: string }

/** Budgets and growth were calibrated on undisturbed runs; a disturbed variant's extra work is information, not a failure. */
export function summarizeDisturbedAnomalies(anomalies: readonly WalkAnomaly[]): DisturbedCounterSummary[] {
    const groups = new Map<string, DisturbedCounterSummary>();
    for (const entry of anomalies) {
        const key = [entry.kind, entry.route, entry.metric].join('|');
        const group = groups.get(key) ?? { kind: entry.kind, route: entry.route, metric: entry.metric, records: 0, maxObserved: entry.observed, limit: entry.limit, example: entry.replay };
        group.records += 1;
        if (entry.observed >= group.maxObserved) { group.maxObserved = entry.observed; group.example = entry.replay; }
        groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.records - a.records || a.route.localeCompare(b.route) || a.metric.localeCompare(b.metric));
}

export function buildWalkReport(results: readonly WalkResult[], findings: StandFinding[]): WalkReport {
    const root = path.resolve('.');
    const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/node/synthetic/walk-counter-baseline.json'), 'utf8')) as CounterBaseline;
    const quiet = process.env.GARDA_SYNTHETIC_WALK_QUIET === '1';
    const disturbedResults = results.filter(result => result.sweep || result.disturbances?.length);
    const metrics = analyzeWalkMetrics(results.filter(result => !result.sweep && !result.disturbances?.length), baseline, quiet);
    const disturbedMetrics = analyzeWalkMetrics(disturbedResults, baseline, quiet);
    const actualSteps = results.flatMap(result => result.steps.filter(step => !step.reusedPrefix));
    const observations = results.flatMap(result => result.steps.filter(step => !step.reusedPrefix).flatMap(step => {
        const stepId = result.scenarioId + ':' + step.index;
        return [{ ...step, stepId }, ...(step.effectResult ? [{ ...step.effectResult, stepId }] : [])];
    }));
    return {
        scenarios: results.map((result) => {
            const target = result.checkpointControl ? results.find(candidate => candidate.sweep?.baseline === result.checkpointControl!.baseline
                && candidate.sweep.step === result.checkpointControl!.step) : result;
            const replay = target ? (target.sweep ? 'GARDA_SYNTHETIC_SEED=' + target.sweep.seed + ' ' : '')
                + 'GARDA_SYNTHETIC_WALK_ONLY=' + target.scenarioId : 'GARDA_SYNTHETIC_WALK_LEVEL=sweep';
            return {
            id: result.scenarioId, counterState: result.counterState, outcome: result.outcome, steps: result.steps.length, taskEvents: result.events.length,
            reviews: result.reviews.map((review) => review.lane + ':' + review.mode),
            terminalRoute: result.steps.at(-1)?.effectResult?.route ?? result.steps.at(-1)?.route ?? '(setup)', detail: result.detail, replay
        }; }),
        measurement: results.some((result) => result.steps.some((step) => step.diagnostic))
            ? 'real process, runDiagnostics journal; phases are inclusive and must not be summed'
            : 'in-process only; startup and shutdown are not measured',
        journals: results.flatMap((result) => result.steps.flatMap((step) => step.diagnostic
            ? [{ path: step.diagnostic.stdout_file.replace(/\.stdout\.txt$/u, '.json'),
                scenario: result.scenarioId, taskEvents: step.taskEvents }] : [])),
        growth: results.flatMap(growthFor), findings,
        coverage: routeCoverage(readRouteInventory(root), observations,
            JSON.parse(fs.readFileSync(path.join(root, 'tests/node/synthetic/known-uncovered-routes.json'), 'utf8')) as UncoveredRoute[]),
        metrics: metrics.routes, anomalies: metrics.anomalies,
        disturbed: { results: disturbedResults.length,
            steps: disturbedResults.reduce((sum, result) => sum + result.steps.filter(step => !step.reusedPrefix).length, 0),
            metrics: disturbedMetrics.routes,
            overBudget: summarizeDisturbedAnomalies(disturbedMetrics.anomalies.map(entry => ({ ...entry, severity: 'report' as const }))) },
        economy: summarizeReviewEconomy(results),
        executedSteps: actualSteps.length,
        projectSize: results.flatMap(result => result.trackedFiles === undefined ? [] : [{ scenario: result.scenarioId,
            trackedFiles: result.trackedFiles, routes: analyzeWalkMetrics([result], baseline, false).routes }]),
        sweep: results.flatMap(result => result.sweep ? [{ scenario: result.scenarioId, ...result.sweep }] : []),
        checkpointControls: results.flatMap(result => result.checkpointControl ? [{ id: result.scenarioId, ...result.checkpointControl, outcome: result.outcome }] : []),
        effectResults: results.flatMap(result => result.steps.filter(step => !step.reusedPrefix && step.effectResult)
            .map(step => ({ scenario: result.scenarioId, step: step.index, ...step.effectResult! })))
    };
}

export function renderWalkReport(report: WalkReport): string {
    return [
        '# Synthetic navigator walk', '', report.measurement, '',
        'Coverage: ' + report.coverage.gates.filter(entry => entry.steps).length + '/' + report.coverage.gates.length + ' gates; '
            + report.coverage.blocked.filter(entry => entry.steps).length + '/' + report.coverage.blocked.length + ' BLOCKED route points. '
            + report.coverage.unaccounted.length + ' unexplained gaps. ' + report.executedSteps + ' executed steps; '
            + report.effectResults.length + ' effect-command returns recorded.', '',
        '| Scenario | Counter state | Outcome | Steps | Task events | Reviews |',
        '|---|---|---|---:|---:|---|',
        ...report.scenarios.map((entry) => '| ' + [entry.id, entry.counterState ?? 'ordinary', entry.outcome, entry.steps, entry.taskEvents, entry.reviews.join(' ')].join(' | ') + ' |'),
        '', '## Growth by task events and route', '',
        'Raw process timings, output, state hashes and runtime identity remain in the recorder journals linked by navigator-walk.json. These buckets add the event counts the recorder does not know. Compare the same scenario and route; different routes and states are not interchangeable.', '',
        '| Scenario | Route/lane | Task events | Calls | Wall/core/outside core median, ms | Inclusive phases, average ms |',
        '|---|---|---|---:|---|---|',
        ...report.growth.map((entry) => '| ' + [entry.scenario, entry.route, entry.taskEvents, entry.calls,
            [entry.wallMedianMs ?? 'unmeasured', entry.coreMedianMs, entry.outsideCoreMedianMs ?? 'unmeasured'].join(' / '),
            entry.phases.map((phase) => phase.phase + ' ' + phase.averageMs).join(', ')].join(' | ') + ' |'),
        '', '## Coverage gaps', '', ...report.coverage.notReached.map(id => '- ' + id + ': '
            + (report.coverage.exemptions.find(entry => entry.id === id)?.reason ?? 'UNACCOUNTED — full/sweep fails')), '',
        '## Route measurements', '',
        '| Route | Calls | Events min/max | Wall median/p95/max | Core median/p95/max | Outside median/p95/max | Wall growth/100 events |',
        '|---|---:|---|---|---|---|---:|',
        ...report.metrics.map(entry => '| ' + [entry.route, entry.calls, entry.events.min + '/' + entry.events.max,
            ...[entry.wall_ms, entry.core_ms, entry.outside_core_ms].map(value => [value.median, value.p95, value.max].map(n => n.toFixed(2)).join('/')),
            entry.wall_ms.growthPer100Events.toFixed(2)].join(' | ') + ' |'),
        '', 'Per-route counters, inclusive phases, project-size results, seed, injection steps and replays are in navigator-walk.json.', '',
        ...renderReviewEconomy(report.economy),
        '## Disturbed runs (counters reported, not judged)', '',
        report.disturbed.results + ' disturbed variants, ' + report.disturbed.steps + ' steps. Budgets and growth are calibrated on undisturbed runs only.', '',
        ...report.disturbed.overBudget.slice(0, 200).map(entry => '- ' + entry.kind + ' ' + entry.route + ' ' + entry.metric + ': ' + entry.records + ' records, max ' + entry.maxObserved + ' vs ' + entry.limit + '; ' + entry.example),
        '', '## Anomalies (undisturbed runs)', '', ...report.anomalies.map(entry => '- ' + entry.severity + ': ' + entry.route + ' ' + entry.kind + ' ' + entry.metric
            + '=' + entry.observed + ' > ' + entry.limit + '; step ' + entry.step + '; ' + entry.replay),
        '', '## Findings', '',
        ...(report.findings.length ? report.findings.map((finding) => '- ' + finding.kind + ' ' + finding.id + ': ' + finding.summary) : ['None.']), ''
    ].join('\n');
}
