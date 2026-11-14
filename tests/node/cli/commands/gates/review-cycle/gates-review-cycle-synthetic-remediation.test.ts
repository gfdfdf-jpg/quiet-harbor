import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readKnownFindings } from '../../../../../../scripts/node-foundation/synthetic/stand';
import {
    compareScenario,
    generateScenario,
    runScenario,
    type EngineScenario
} from '../../../../synthetic/engine/remediation-engine';

// Sample of the synthetic remediation engine (tests/node/synthetic/README.md); the long random run is separate.
const DATA_ROOT = path.resolve('tests/node/synthetic');
const SAMPLE_SEEDS = [11, 23, 37, 41, 53, 67, 79, 83];

function readJson<T>(relativePath: string): T {
    return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, relativePath), 'utf8')) as T;
}

test('engine corpus scenarios of fixed remediation defects stay green', { timeout: 300_000 }, () => {
    const files = fs.readdirSync(path.join(DATA_ROOT, 'corpus-engine')).filter((name) => name.endsWith('.json')).sort();
    const entries = files.flatMap((name) => readJson<Array<{ note: string; scenario: EngineScenario }>>(path.join('corpus-engine', name)));
    assert.ok(entries.length > 0);
    for (const entry of entries) {
        const result = runScenario(entry.scenario);
        assert.deepEqual(result.findings.map((finding) => `${finding.id}: ${finding.summary}`), [],
            `${entry.scenario.id}: ${JSON.stringify(result.observed)}`);
    }
});

test('known engine findings still reproduce, so their entries are not stale', { timeout: 300_000 }, () => {
    const knownIds = readKnownFindings(DATA_ROOT).map((entry) => entry.id);
    const reproductions = readJson<Array<{ finding_id: string; scenario: EngineScenario }>>('known-engine-scenarios.json');
    const engineKnownIds = knownIds.filter((id) => id.startsWith('engine:'));
    assert.deepEqual([...new Set(reproductions.map((entry) => entry.finding_id))].sort(), [...engineKnownIds].sort(),
        'every known engine finding needs a reproduction and every reproduction a known finding');
    for (const entry of reproductions) {
        const ids = runScenario(entry.scenario).findings.map((finding) => finding.id);
        assert.ok(ids.includes(entry.finding_id), `${entry.scenario.id} no longer reproduces ${entry.finding_id}: ${ids.join(', ')}`);
    }
});

test('the engine reports wrong decisions of lanes other than the failed one', () => {
    const scenario: EngineScenario = {
        id: 'wrong-lane-decisions', stack: 'python', failedLane: 'infra', requiredLanes: ['code', 'infra', 'test'],
        scope: [{ role: 'TEST_FIXTURE', path: 'tests/fixtures/invoice.json', lines: 10 }],
        fix: [{ role: 'TEST_FIXTURE', path: 'tests/fixtures/invoice.json', operation: 'modified', changedLines: 10 }]
    };
    const expected = {
        category: 'shared_test_helper_or_harness', failedLaneMode: 'DELTA' as const,
        invalidatedLanes: scenario.requiredLanes, ruleCoversFailedLane: false
    };
    const rerunLane = (lane: string, mode: string) => ({ lane, mode, invalidated: true, reuseEligible: false, satisfied: false });
    const observed = {
        category: expected.category, failedLaneMode: 'DELTA', failedLaneReason: '', fullReviewReasons: [],
        invalidatedLanes: ['code', 'infra', 'test'],
        laneDecisions: [rerunLane('code', 'FULL'), rerunLane('infra', 'DELTA'), rerunLane('test', 'FULL')]
    };
    assert.deepEqual(compareScenario(scenario, expected, observed), []);
    const idsWith = (lane: ReturnType<typeof rerunLane>) => compareScenario(scenario, expected,
        { ...observed, laneDecisions: [lane, ...observed.laneDecisions.slice(1)] }).map((finding) => finding.id);
    assert.deepEqual(idsWith({ lane: 'code', mode: 'REUSE', invalidated: true, reuseEligible: false, satisfied: true }),
        ['engine:lane-state:pending->satisfied:lane-code', 'engine:lane-mode:FULL->REUSE:lane-code']);
    assert.deepEqual(idsWith({ lane: 'code', mode: 'FULL', invalidated: false, reuseEligible: true, satisfied: false }),
        ['engine:lane-state:rerun->reuse-pending:lane-code']);
    assert.deepEqual(idsWith(rerunLane('code', 'DELTA')), ['engine:lane-mode:FULL->DELTA:lane-code']);
    assert.deepEqual(compareScenario(scenario, expected, { ...observed, laneDecisions: observed.laneDecisions.slice(1) })
        .map((finding) => finding.id), ['engine:lane-state:decided->missing:lane-code']);
});

test('generated scenarios reach deletions, five-file fixes and every failed lane class', () => {
    const scenarios = Array.from({ length: 2000 }, (_, seed) => generateScenario(seed));
    const operations = new Set(scenarios.flatMap((scenario) => scenario.fix.map((edit) => edit.operation)));
    assert.deepEqual([...operations].sort(), ['added', 'deleted', 'modified']);
    assert.ok(scenarios.some((scenario) => scenario.fix.length === 5));
    assert.ok(scenarios.some((scenario) => scenario.leftScope !== undefined));
    assert.ok(scenarios.some((scenario) => scenario.fix.some((edit) => edit.role === 'GENERATED')));
    const failedLanes = new Set(scenarios.map((scenario) => scenario.failedLane));
    for (const lane of ['code', 'db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency', 'test']) {
        assert.ok(failedLanes.has(lane as EngineScenario['failedLane']), lane);
    }
});

test('sampled engine scenarios report only known findings', { timeout: 300_000 }, () => {
    const knownIds = readKnownFindings(DATA_ROOT).map((entry) => entry.id);
    const unexplained = SAMPLE_SEEDS.flatMap((seed) => runScenario(generateScenario(seed)).findings
        .filter((finding) => !knownIds.includes(finding.id))
        .map((finding) => `seed ${seed}: ${finding.kind} ${finding.id}: ${finding.summary}`));
    assert.deepEqual(unexplained, []);
});
