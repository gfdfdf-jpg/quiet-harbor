import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readKnownFindings } from '../../../scripts/node-foundation/synthetic/stand';
import type { StandFinding } from '../../../scripts/node-foundation/synthetic/model';
import {
    generateScenario,
    minimizeScenario,
    runScenario,
    type EngineScenario
} from './engine/remediation-engine';

/**
 * Long random run of the remediation decision engine (see README.md beside this file).
 * GARDA_SYNTHETIC_SCENARIOS sets the scenario count, GARDA_SYNTHETIC_SEED the first seed.
 * Unexplained findings are minimized and written to the report as corpus candidates.
 */
test('random remediation scenarios match the review contract', { timeout: 3_600_000 }, () => {
    const count = Number(process.env.GARDA_SYNTHETIC_SCENARIOS || 200);
    const firstSeed = Number(process.env.GARDA_SYNTHETIC_SEED || Date.now() % 1_000_000_000);
    assert.ok(Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(firstSeed) && firstSeed >= 0);
    const knownIds = readKnownFindings().map((entry) => entry.id);
    const explained: StandFinding[] = [];
    const unexplained: Array<{ finding: StandFinding; minimized: EngineScenario }> = [];
    const seenUnexplained = new Set<string>();
    const started = performance.now();
    for (let offset = 0; offset < count; offset += 1) {
        const scenario = generateScenario(firstSeed + offset);
        for (const finding of runScenario(scenario).findings) {
            if (knownIds.includes(finding.id)) {
                explained.push(finding);
            } else if (!seenUnexplained.has(finding.id)) {
                seenUnexplained.add(finding.id);
                unexplained.push({ finding, minimized: minimizeScenario(scenario, finding.id) });
            }
        }
    }
    const report = {
        schema_version: 1,
        first_seed: firstSeed,
        scenarios: count,
        wall_time_ms: Math.round(performance.now() - started),
        explained_by_known_findings: explained.length,
        unexplained: unexplained.map((entry) => ({ id: entry.finding.id, kind: entry.finding.kind,
            summary: entry.finding.summary, minimized: entry.minimized, detail: entry.finding.detail }))
    };
    const reportPath = process.env.GARDA_SYNTHETIC_STAND_REPORT
        || path.join(os.tmpdir(), 'garda-synthetic-stand', `random-${firstSeed}.json`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`SYNTHETIC_RANDOM_REPORT ${reportPath} scenarios=${count} first_seed=${firstSeed} `
        + `explained=${explained.length} unexplained=${unexplained.length} wall_time_ms=${report.wall_time_ms}`);
    assert.deepEqual(report.unexplained.map((entry) => `${entry.kind} ${entry.id}: ${entry.summary}`), []);
});
