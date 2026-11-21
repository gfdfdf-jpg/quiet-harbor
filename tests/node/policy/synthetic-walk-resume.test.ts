import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertWalkResumeIdentity, atomicWalkJson, WalkRunStore, walkHash, walkProgress, type FinishedWalk } from '../synthetic/engine/walk-run-store';
import { walkInjectionDue, type SweepInjection } from '../synthetic/engine/walk-sweep';

const finished = (id: string): FinishedWalk => ({ result: { scenarioId: id, outcome: 'done', detail: 'DONE',
    steps: [], events: [], reviews: [], reviewsByLane: {}, elapsedMs: 10 }, findings: [] });

test('scripted checkpoints follow their gate and lane when earlier lifecycle steps change', () => {
    const injection: SweepInjection = { seed: 42, baseline: 'clean-pass', step: -1,
        gate: 'complete-reviewer-launch', checkpoint: { lane: 'code' }, disturbances: [] };
    for (const index of [18, 19, 21, 22]) assert.equal(walkInjectionDue(injection, index, injection.gate, 'code'), true);
    assert.equal(walkInjectionDue(injection, 19, injection.gate, 'test'), false);
    assert.equal(walkInjectionDue(injection, 19, 'record-reviewer-delegation-started', 'code'), false);
    const replay = { ...injection, checkpoint: undefined, step: 19 };
    assert.equal(walkInjectionDue(replay, 19, injection.gate, 'code'), true);
    assert.equal(walkInjectionDue(replay, 20, injection.gate, 'code'), false);
});

test('resume accepts only intact scenario records belonging to the exact run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-resume-contract-'));
    try {
        const store = new WalkRunStore(root, 'original');
        store.save(finished('one'));
        assert.deepEqual(store.read('one'), finished('one'));
        assert.equal(new WalkRunStore(root, 'changed-code').read('one'), undefined);
        assert.equal(store.read('unfinished'), undefined);
        const file = path.join(root, 'scenarios', walkHash('one') + '.json');
        fs.writeFileSync(file + '.tmp', '{');
        assert.deepEqual(store.read('one'), finished('one'), 'temporary writes are never completions');
        const changed = JSON.parse(fs.readFileSync(file, 'utf8'));
        changed.result.detail = 'edited';
        atomicWalkJson(file, changed);
        assert.equal(store.read('one'), undefined, 'valid JSON with a bad digest is unfinished');
        fs.writeFileSync(file, '{');
        assert.equal(store.read('one'), undefined);
        store.save(finished('one'));
        assert.deepEqual(store.read('one'), finished('one'), 'atomic replacement repairs a corrupt record');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('partial or changed checkpoint families must rerun their fresh restored control', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-resume-family-'));
    try {
        const store = new WalkRunStore(root, 'same-run');
        const ids = ['control', 'variant-a', 'variant-b'];
        store.save(finished('control')); store.save(finished('variant-a'));
        assert.equal(store.readFamily(ids), undefined);
        assert.throws(() => store.finishFamily(ids), /missing results/u);
        store.save(finished('variant-b'));
        assert.equal(store.readFamily(ids), undefined, 'all records without a completion marker are still partial');
        store.finishFamily(ids);
        assert.deepEqual(store.readFamily(ids), ids.map(finished));
        store.save({ ...finished('variant-a'), findings: [{ layer: 'walk', kind: 'contract', id: 'changed', summary: 'changed', detail: {} }] });
        assert.equal(store.readFamily(ids), undefined);
        store.invalidate(ids);
        assert.equal(store.read('control'), undefined);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resume refuses every identity change, and progress counts failures and estimates remaining work', () => {
    const identity = { seed: 42, level: 'full', provider: 'Codex', manifest: ['one'], runInputsHash: 'bytes' };
    assert.doesNotThrow(() => assertWalkResumeIdentity({ ...identity }, identity));
    for (const key of Object.keys(identity)) assert.throws(() => assertWalkResumeIdentity(identity, { ...identity, [key]: 'different' }), /resume refused/u);
    const records = ['done', 'blocked', 'loop', 'agent_stuck', 'exception', 'step_limit', 'dead_end'].map((outcome, index) => ({
        ...finished(String(index)), result: { ...finished(String(index)).result, outcome }
    })) as FinishedWalk[];
    const progress = walkProgress(records, 10, 700, 7);
    assert.deepEqual(progress.counts, { done: 1, blocked: 1, loop: 1, agent_stuck: 1, crash: 3 });
    assert.equal(progress.etaMs, 300);
    assert.equal(walkProgress([], 10, 100, 0).etaMs, null);
});
