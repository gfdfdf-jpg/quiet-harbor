import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareWalk, createWalkTemplate, walkTaskFamily, type WalkResult } from './navigator-walk';
import { WALK_SCENARIOS } from './walk-scenarios';
import { atomicWalkJson } from './walk-run-store';
import type { WalkWork } from './walk-sharding';
import type { StandFinding } from '../../../../scripts/node-foundation/synthetic/model';
import { nativeWalkPathFindings } from './walk-native';

export interface NativeFamily { results: WalkResult[]; findings: Record<string, StandFinding[]> }

async function main(): Promise<void> {
    if (!process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS) throw new Error('Native replay needs an outside journal directory');
    const item = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as WalkWork;
    const scenario = WALK_SCENARIOS.find(entry => entry.id === item.baseline);
    if (!scenario) throw new Error('Unknown native replay: ' + item.baseline);
    const template = await createWalkTemplate(path.resolve('.'), scenario.fixture);
    const family: NativeFamily = { results: [], findings: {} };
    const variants = item.variants?.map(value => ({ ...scenario, id: value.id, injection: value.injection,
        expectedReviews: {}, expectedModes: [] }));
    try {
        await walkTaskFamily(template, scenario, variants, result => {
            const expected = variants?.find(entry => entry.id === result.scenarioId) ?? scenario;
            // The separate coverage replay proves source points; native still checks gates, outcomes and reviews.
            family.findings[result.scenarioId] = [...compareWalk({ ...expected, id: result.scenarioId, expectedRoutes: undefined }, result),
                ...nativeWalkPathFindings(result)];
            family.results.push(result);
        });
        atomicWalkJson(process.argv[3], family);
    } finally { fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
