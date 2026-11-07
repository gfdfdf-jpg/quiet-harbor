export type WalkLevel = 'sample' | 'full' | 'sweep';

/** The scenarios a normal test run walks. Larger levels run only when GARDA_SYNTHETIC_WALK_LEVEL asks for them. */
export const SAMPLE_WALK_SCENARIOS: readonly string[] = Object.freeze(['clean-pass', 'test-failed-fixed-in-source', 'stack-unknown-quartz-a7-generic-gate-tour', 'stack-polyglot-maven-ts-a3-generic']);

export interface WalkPlan {
    level: WalkLevel;
    jobs: number;
    only: string[] | null;
    /** Partial sweep: only variants with one of these comma-separated disturbance kinds, after their baselines. */
    disturbance: string | null;
    scenarioIds: string[];
    runSweep: boolean;
    /** Node test timeout: a normal run must stay well inside a shard budget; explicit levels may take hours. */
    timeoutMs: number;
}

/** One selection can share checkpoint controls across several whole disturbance kinds. */
export function matchesDisturbanceSelection(selection: string | null, kinds: readonly string[]): boolean {
    return !selection || kinds.some(kind => selection.split(',').includes(kind));
}

/**
 * Derives the run from the environment. A discovery run of the whole repository sets none of these variables,
 * so it walks the sample only; `full` and `sweep` (or an explicit selection) need an explicit request.
 */
export function walkRunPlan(env: NodeJS.ProcessEnv, scenarioIds: readonly string[]): WalkPlan {
    const requested = env.GARDA_SYNTHETIC_WALK_LEVEL || 'sample';
    const level = (requested === 'short' ? 'sample' : requested) as WalkLevel;
    if (!['sample', 'full', 'sweep'].includes(level)) throw new Error('Invalid GARDA_SYNTHETIC_WALK_LEVEL: ' + level);
    const jobs = Number(env.GARDA_SYNTHETIC_WALK_JOBS || 1);
    if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 24) throw new Error('GARDA_SYNTHETIC_WALK_JOBS must be 1..24');
    const only = env.GARDA_SYNTHETIC_WALK_ONLY ? env.GARDA_SYNTHETIC_WALK_ONLY.split(',').map(id => id.trim()).filter(Boolean) : null;
    const unknown = (only ?? []).filter(id => !id.startsWith('sweep-') && !scenarioIds.includes(id));
    if (unknown.length) throw new Error('Unknown scenario selection: ' + unknown.join(', '));
    const disturbance = env.GARDA_SYNTHETIC_WALK_DISTURBANCE?.trim() || null;
    if (disturbance && !/^[a-z][a-z-]*(?:,[a-z][a-z-]*)*$/u.test(disturbance)) throw new Error('Invalid GARDA_SYNTHETIC_WALK_DISTURBANCE: ' + disturbance);
    // A disturbance selection walks only the sweep baselines and its variants, not the scenario families.
    const selected = scenarioIds.filter(id => only ? only.includes(id)
        : !disturbance && (level !== 'sample' || SAMPLE_WALK_SCENARIOS.includes(id)));
    return { level, jobs, only, disturbance, scenarioIds: selected,
        runSweep: level === 'sweep' || !!disturbance || !!only?.some(id => id.startsWith('sweep-')),
        timeoutMs: level === 'sample' && !only && !disturbance ? 1_800_000 : Infinity };
}
