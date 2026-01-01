import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeReferenceShards, sealReferenceShard } from '../synthetic/engine/reference-shards';
import { atomicWalkJson, walkHash, walkResultIndex, WalkRunStore } from '../synthetic/engine/walk-run-store';
import { shardPlan } from '../synthetic/engine/walk-sharding';
import { WALK_SCENARIOS } from '../synthetic/engine/walk-scenarios';
import { standCheckPlan } from '../synthetic/engine/stand-check-plan';
import type { WalkResult } from '../synthetic/engine/navigator-walk';

function probe(total: number): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-merge-memory-'));
    const ids = WALK_SCENARIOS.slice(0, total).map(item => item.id);
    assert.equal(ids.length, total);
    const source = { memoryProbe: true }, identity = { source, level: 'full', seed: '1785881697',
        provider: 'Codex', reviewStacks: '3', only: ids.join(','), ci: true };
    const checkIds = [...standCheckPlan('full', fs.readFileSync('tests/node/policy/stack-universal-gates-contract.test.ts', 'utf8'))
        .filter(item => item.phase !== 'timing').map(item => item.id), 'contract'];
    let rawBytes = 0;
    try {
        for (let index = 1; index <= total; index++) {
            const directory = path.join(root, 'inputs', String(index)), shard = { index, total };
            const plan = shardPlan(ids.map(baseline => ({ baseline })), shard);
            const manifest = { shard, runInputsHash: walkHash(source) };
            const store = new WalkRunStore(path.join(directory, 'walk'), walkHash(manifest));
            const result: WalkResult = { scenarioId: plan.assigned[0], outcome: 'done', detail: '', reviews: [], reviewsByLane: {}, events: [],
                steps: [{ index: 0, gate: 'compile-gate', status: 'BLOCKED', navigatorMs: 1, taskEvents: 0,
                    command: '', commandMs: 0, exitCode: 0, output: 'x'.repeat(2 * 1024 * 1024), reason: '', workspaceSha256: '',
                    measurement: { work: Object.fromEntries(Array.from({ length: 8192 }, (_, file) =>
                        ['payload_read:C:/fixture/garda-agent-orchestrator/runtime/reviews/' + plan.assigned[0] + '/r' + file + '.json', 1])),
                        io: {}, phases_ms: {} } }] };
            store.save({ result, findings: [] });
            rawBytes += fs.statSync(path.join(store.root, 'scenarios', walkHash(result.scenarioId) + '.json')).size;
            atomicWalkJson(path.join(directory, 'walk/run-manifest.json'), manifest);
            atomicWalkJson(path.join(directory, 'walk/run-inputs.json'), source);
            atomicWalkJson(path.join(directory, 'walk/shard-plan.json'), plan);
            atomicWalkJson(path.join(directory, 'walk/results.json'), walkResultIndex(store, plan.assigned, [], []));
            sealReferenceShard(directory, identity, shard, { level: 'full', final: false, partial: true, ci: true,
                timingRequested: false, baselineProblems: [], traceProblems: [], policyFindings: [],
                checks: (index === 1 ? checkIds : ['walk']).map(id => ({ id, status: 'PASS', log: id + '.log' })) });
        }
        const summary = mergeReferenceShards(path.join(root, 'inputs'), path.join(root, 'merged'), source);
        assert.equal(summary.totals.scenarios, total);
        // These deliberately incomplete native records must never acquire acceptance.
        assert.equal(summary.verdict, 'FAIL');
        console.log(JSON.stringify({ shards: total, rawMiB: rawBytes / (1024 * 1024), countersPerInput: 8192, heapLimitMiB: 128,
            maxRssMiB: process.resourceUsage().maxRSS / 1024 }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.env.GARDA_MERGE_MEMORY_PROBE) probe(Number(process.env.GARDA_MERGE_MEMORY_PROBE));
else for (const total of [64, 128]) test(`merge ${total} sealed inputs under a 128 MiB heap without accepting incomplete traces`, () => {
    const child = spawnSync(process.execPath, ['--max-old-space-size=128', __filename], {
        encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_TEST_CONTEXT: '', GARDA_MERGE_MEMORY_PROBE: String(total) }
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    console.log(child.stdout.trim());
});
