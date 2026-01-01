import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CounterBaseline } from './walk-metrics';

export interface PlatformBaselines {
    schema: 1;
    platforms: Record<string, { status: 'MEASURED' | 'NEEDS_CALIBRATION'; evidence: string; baseline: CounterBaseline | null }>;
}
/** The historical file is Windows evidence. No other platform can inherit it implicitly. */
export function platformCounterBaseline(root: string, platform: string = process.platform): CounterBaseline {
    if (platform === 'win32') return JSON.parse(fs.readFileSync(path.join(root, 'tests/node/synthetic/walk-counter-baseline.json'), 'utf8')) as CounterBaseline;
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'tests/node/synthetic/walk-counter-platforms.json'), 'utf8')) as PlatformBaselines;
    const entry = policy.platforms[platform];
    if (entry?.baseline) return entry.baseline;
    return { schema: 1, provenance: 'NEEDS_CALIBRATION: ' + platform + '; ' + (entry?.evidence ?? 'No platform measurement'), routes: {} };
}
