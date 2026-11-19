import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MergeWalkRecords } from '../synthetic/engine/walk-merge-records';
import { WalkRunStore } from '../synthetic/engine/walk-run-store';
import { judgeWalk } from '../synthetic/engine/walk-verdict';
import { analyzeWalkMetrics, verdictResult, type CounterBaseline } from '../synthetic/engine/walk-metrics';
import type { WalkResult } from '../synthetic/engine/navigator-walk';

test('bounded merge preserves the complete verdict including paired counters, growth, spikes and negative controls', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-merge-projection-'));
    try {
        const records: WalkResult[] = ['clean-pass', 'document-only', 'security-refactor-pass'].map((scenarioId, scenario) => ({
            scenarioId, outcome: 'done', detail: 'retained detail', reviews: [{ lane: 'code', mode: 'FULL' }],
            reviewsByLane: { code: 1 }, events: [{ type: 'POLICY_APPLIED', details: { policy_sha256: 'a'.repeat(64) } }],
            steps: [0, 1, 2, 3].map(index => ({ index, gate: 'compile-gate', status: 'BLOCKED',
                route: 'BLOCKED/compile-gate', counterState: scenario > 0 ? 'unit-unmeasured' : undefined,
                routes: ['source:route'], navigatorMs: scenario === 1 ? 2000 : index === 3 ? 9000 : 10,
                coreMs: index + 1, outsideCoreMs: scenario, command: 'node cli gate compile-gate', commandMs: 0,
                exitCode: 0, taskEvents: index * 50, workspaceSha256: '', output: 'diagnostic bytes'.repeat(1000), reason: 'reason',
                timelineInput: { files: ['T.jsonl'], events: index * 50, bytes: 100, envelopeBytes: 10 },
                measurement: { phases_ms: { total: index + 1, ...scenario ? { scope: index * 3 } : {} }, io: { statSync: { count: index + 1, total_ms: 2, max_ms: 2, throws: 0 } },
                    work: { 'payload_read:C:/tmp/garda-walk-unit/artifact.json': index + 1, timeline_parse: 1,
                        ...scenario ? { timeline_verify: 1 } : {},
                        'subprocess_timeout:icacls.exe': index === 0 ? 1 : 0,
                        'process:sync:icacls.exe:hash': 3, 'acl_probe:initial:C:/tmp/reviews': 1,
                        'acl_probe:initial:C:/tmp/reviews/a.json': 1, 'acl_probe:final:C:/tmp/reviews': 1,
                        'acl_probe:final:C:/tmp/reviews/a.json': 1, 'acl_batch_probe:initial:C:/tmp/reviews': 1,
                        'acl_batch_hit:initial': 2 } },
                effectResult: { gate: 'compile-gate', status: 'BLOCKED', route: 'BLOCKED/compile-gate', routes: [], reason: 'effect' } }))
        }));
        records[1].nativeBudget = { ...records[1], steps: records[1].steps.slice(1) };
        const store = new WalkRunStore(root, 'unit'), payloads = new MergeWalkRecords();
        for (const result of records) store.save({ result, findings: [] });
        const views = records.map(result => {
            const sealed = store.readSealed(result.scenarioId)!;
            return payloads.view(store, result.scenarioId, sealed.digest, sealed.record.result);
        });
        const ordinary = judgeWalk(records.map(verdictResult), [], 'full', true);
        const bounded = judgeWalk(views, [], 'full', true, true);
        assert.deepEqual(bounded, ordinary);
        assert.ok(bounded.findings.length, 'bad counters must remain red');
        assert.throws(() => judgeWalk([views[0], { ...records[1],
            nativeBudget: { ...records[1], scenarioId: records[0].scenarioId } }], [], 'full', true, true),
        /Duplicate metric scenario identity/u, 'a forged paired identity cannot split one growth cohort across inputs');
        // A later change cannot be hidden by the replayable view or the single-record cache.
        store.save({ result: { ...records[0], detail: 'tampered' }, findings: [] });
        void views[1].steps;
        assert.throws(() => views[0].steps, /Tampered scenario during merge/u);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a paired timeout never grants slack for another native ACL acquisition', () => {
    const route = 'BLOCKED/compile-gate';
    const baseline: CounterBaseline = { schema: 1, provenance: 'independent subject ceiling control', routes: {
        [route]: { 'subprocess:icacls.exe': { expected: 20, tolerance: 0, constantWithEvents: true } }
    } };
    const trace = (processes: number): WalkResult => ({ scenarioId: 'acl-retry-control', outcome: 'done', detail: '',
        events: [], reviews: [], reviewsByLane: {}, steps: [{ index: 0, gate: 'compile-gate', status: 'BLOCKED', route,
            command: '', navigatorMs: 1, commandMs: 0, exitCode: 0, taskEvents: 0, output: '', reason: '', workspaceSha256: '',
            measurement: { phases_ms: {}, work: { 'process:spawnSync:icacls.exe:control': processes,
                'subprocess_timeout:icacls.exe': 1, 'acl_batch_probe:initial:/tmp/reviews': 1, 'acl_batch_hit:initial': 2,
                'acl_probe:initial:/tmp/reviews': 1, 'acl_probe:initial:/tmp/reviews/a.json': 1,
                'acl_probe:final:/tmp/reviews': 1, 'acl_probe:final:/tmp/reviews/a.json': 1 } } }] });
    for (const bounded of [false, true]) {
        assert.deepEqual(analyzeWalkMetrics([trace(4)], baseline, false, bounded).anomalies.filter(row => row.severity === 'failure'), []);
        const excess = analyzeWalkMetrics([trace(5)], baseline, false, bounded).anomalies
            .filter(row => row.metric === 'subprocess:icacls.exe/subjects');
        assert.equal(excess.length, 1, 'route slack cannot absorb an extra subject acquisition');
        assert.equal(excess[0].observed, 5);
        assert.equal(excess[0].limit, 4);
    }
});
