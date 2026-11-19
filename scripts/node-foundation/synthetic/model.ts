/**
 * Abstract vocabulary of the synthetic review stand. Scenarios speak about file
 * roles and review outcomes, never about one project's paths, so the same
 * scenario can run against every stack adapter.
 */

/** Built-in review lanes in strict sequential order. */
export const REVIEW_LANES = Object.freeze([
    'code', 'db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency', 'test'
] as const);

export type ReviewLane = typeof REVIEW_LANES[number];

export const FILE_ROLES = Object.freeze([
    'PROD',
    'UNIT_TEST',
    'TEST_HELPER',
    'TEST_FIXTURE',
    'CONFIG',
    'DEP_MANIFEST',
    'API',
    'DB_MIGRATION',
    'AUTH',
    'INFRA',
    'DOCS',
    'GENERATED'
] as const);

export type FileRole = typeof FILE_ROLES[number];

/** Deterministic 32-bit generator (mulberry32); the whole stand derives from one seed. */
export function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

export function pick<T>(random: () => number, values: readonly T[]): T {
    return values[Math.floor(random() * values.length)];
}

/** Every finding the stand reports carries a stable id so known findings can be tracked. */
export interface StandFinding {
    id: string;
    layer: 'path' | 'policy-mode' | 'policy-rerun' | 'corpus' | 'engine' | 'walk';
    kind: 'safety' | 'economy' | 'contract';
    summary: string;
    detail: Record<string, unknown>;
}

export interface LayerResult {
    layer: StandFinding['layer'];
    cases: number;
    findings: StandFinding[];
}
