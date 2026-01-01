import type { WalkResult, WalkScenario } from './navigator-walk';
import { buildSweepScenarios, type SweepInjection } from './walk-sweep';
import { walkHash } from './walk-run-store';

export interface StandShard { index: number; total: number }
export interface WalkWork { baseline: string; variants?: Array<{ id: string; injection: SweepInjection }> }
export function parseStandShard(value?: string): StandShard | undefined {
    if (value === undefined) return undefined;
    const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
    const index = Number(match?.[1]), total = Number(match?.[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total || total > 256)
        throw new Error('shard must be i/n, 1 <= i <= n <= 256');
    return { index, total };
}
export function workIds(item: WalkWork): string[] {
    return item.variants ? ['checkpoint-control-' + item.baseline + '-s' + item.variants[0].injection.step,
        ...item.variants.map(value => value.id).sort()] : [item.baseline];
}
/** Stable navigator-step estimates, not durations from a loaded machine. Families keep their shared prefix/control. */
export function estimatedWalkSteps(id: string): number {
    if (/a9-|parent|aggregate|field-/u.test(id)) return 160;
    if (/gate-tour|review-edit|reset/u.test(id)) return 120;
    if (/deep-stack-|lost-evidence|a8-/u.test(id)) return 90;
    if (/a4-|document-only/u.test(id)) return 12;
    return 60;
}
export function workCost(item: WalkWork): number {
    return estimatedWalkSteps(item.baseline) * (item.variants ? item.variants.length + 1 : 1);
}
/** Longest-processing-time packing, with lexical ID and lowest shard index as explicit tie breakers. */
export function partitionWalkWork(items: readonly WalkWork[], total: number): WalkWork[][] {
    parseStandShard('1/' + total);
    const seen = new Set<string>();
    for (const item of items) for (const id of workIds(item)) {
        if (seen.has(id)) throw new Error('Duplicate planned scenario: ' + id);
        seen.add(id);
    }
    const key = (item: WalkWork) => workIds(item)[0];
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const bins: WalkWork[][] = Array.from({ length: total }, () => []), costs = bins.map(() => 0);
    for (const item of [...items].sort((a, b) => workCost(b) - workCost(a) || compare(key(a), key(b)))) {
        const index = costs.indexOf(Math.min(...costs));
        bins[index].push(item); costs[index] += workCost(item);
    }
    return bins.map(bin => bin.sort((a, b) => compare(key(a), key(b))));
}
export const SWEEP_BASELINES = ['clean-pass', 'document-only', 'security-refactor-pass',
    'stack-unknown-quartz-a1-generic', 'stack-spring-maven-a1-generic', 'stack-polyglot-maven-ts-a1-generic'];
export function sweepWork(baselines: Array<{ scenario: WalkScenario; result: WalkResult }>, seed: number): WalkWork[] {
    const sweep = buildSweepScenarios(baselines, seed).filter(scenario => !scenario.injection!.baseline.startsWith('stack-')
        || scenario.injection!.disturbances.every(disturbance => ['delete-artifact', 'corrupt-artifact', 'stale-artifact',
            'repeat-last', 'wrong-gate', 'change-criteria', 'change-policy', 'reset-task'].includes(disturbance.kind)));
    const families = new Map<string, WalkWork>();
    for (const entry of sweep) {
        const injection = entry.injection!, key = injection.baseline + ':' + injection.step;
        const item = families.get(key) ?? { baseline: injection.baseline, variants: [] };
        item.variants!.push({ id: entry.id, injection }); families.set(key, item);
    }
    return [...families.values()];
}
export function shardPlan(items: readonly WalkWork[], shard: StandShard) {
    const scenarioIds = items.flatMap(workIds).sort();
    return { scenarioIds, scenarioSetHash: walkHash(scenarioIds),
        assigned: partitionWalkWork(items, shard.total)[shard.index - 1].flatMap(workIds).sort() };
}
