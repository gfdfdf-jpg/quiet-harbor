import './engine/walk-route-observer';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { mergeReferenceShards, sealReferenceShard, type ShardIdentity } from './engine/reference-shards';
import { parseStandShard, partitionWalkWork, shardPlan, sweepWork, workCost, workIds } from './engine/walk-sharding';
import { walkHash, atomicWalkJson, atomicWalkText, readWalkResultIndex, walkResultIndex, WalkRunStore } from './engine/walk-run-store';
import { judgeWalk } from './engine/walk-verdict';
import { platformCounterBaseline } from './engine/walk-platform-baselines';
import { buildStandSummary, type SummaryInput } from './engine/stand-summary';
import { propertyTrace, readStandProperties } from './engine/stand-properties';
import type { WalkResult } from './engine/navigator-walk';
import type { StandFinding } from '../../../scripts/node-foundation/synthetic/model';
import { walkRunPlan } from './engine/walk-plan';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { configureTimingSession, finishTimingSession, type TimingReport } from './engine/step-timing-session';

const MAX_STRING_LENGTH = bufferConstants.MAX_STRING_LENGTH;
const ids = ['clean-pass', 'document-only', 'security-refactor-pass'];
const source = { unit: 'immutable-source', platform: process.platform };
const identity: ShardIdentity = { source, seed: '1785881697', level: 'full', provider: 'Codex', reviewStacks: '3', only: ids.join(','), ci: true };
const checks: SummaryInput['checks'] = ['stand-unit', 'shard-unit', 'stand-meta', 'field-unit', 'validation-plan-unit', 'stack-review-unit',
    'contract', 'contract-selection', 'contract-tour', 'contract-rename', 'fixture-contract', 'economy', 'policy-reuse', 'walk']
    .map(id => ({ id, log: id + '.log', status: 'PASS', executed_tests: ['unit witness'], oracles_executed: ['route-coverage', 'work-budgets'] }));
for (const check of checks) {
    const declared = readStandProperties(path.resolve('.')).checks.filter(item => item.run === check.id);
    check.executed_tests = declared.flatMap(item => item.cases ?? item.tests ?? []);
    check.oracles_executed = declared.filter(item => item.symbol).map(item => item.id);
}
const input: SummaryInput = { level: 'full', final: true, partial: true, ci: true, timingRequested: false,
    checks, baselineProblems: [], traceProblems: [], policyFindings: [] };
function result(id: string, gate: string): WalkResult {
    return { scenarioId: id, outcome: 'done', detail: '', steps: [{ index: 0, gate, status: 'BLOCKED', route: 'BLOCKED/' + gate,
        navigatorMs: 10, taskEvents: 0, command: '', commandMs: 0, exitCode: 0, output: '', reason: '', workspaceSha256: 'unit',
        routes: [], measurement: { work: {}, io: {}, phases_ms: {} } }],
    events: [], reviews: [], reviewsByLane: {} };
}
const results = ids.map((id, index) => result(id, ['compile-gate', 'completion-gate', 'required-reviews-check'][index]));
const finding: StandFinding = { layer: 'walk', kind: 'contract', id: 'walk:reviews:clean-pass:unit-witness', summary: 'Known finding stays red', detail: {} };
function fixture(root: string, findings: StandFinding[] = [], records: WalkResult[] = results) {
    for (let index = 1; index <= 2; index++) {
        const directory = path.join(root, 'inputs', 'shard-' + index), shard = { index, total: 2 };
        const plan = shardPlan(ids.map(baseline => ({ baseline })), shard);
        const selected = records.filter(item => plan.assigned.includes(item.scenarioId));
        const inputs = { source }, manifest = { shard, runInputsHash: walkHash(inputs) };
        const store = new WalkRunStore(path.join(directory, 'walk'), walkHash(manifest));
        for (const item of selected) store.save({ result: item, findings: item.scenarioId === ids[0] ? findings : [] });
        atomicWalkJson(path.join(directory, 'walk/run-manifest.json'), manifest);
        atomicWalkJson(path.join(directory, 'walk/run-inputs.json'), inputs);
        atomicWalkJson(path.join(directory, 'walk/shard-plan.json'), plan);
        atomicWalkJson(path.join(directory, 'walk/results.json'), walkResultIndex(store, selected.map(item => item.scenarioId), [],
            selected.some(item => item.scenarioId === ids[0]) ? findings : []));
        const shardChecks = (index === 1 ? checks : checks.filter(check => check.id === 'walk')).map(check => check.id === 'walk'
            ? { ...check, oracles_executed: check.oracles_executed?.filter(id => id !== 'adapter-parity') } : check);
        sealReferenceShard(directory, identity, shard, { ...input, checks: shardChecks });
    }
}
function temporary(run: (root: string) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-shards-unit-'));
    const saved = { ...process.env };
    try { run(root); } finally { process.env = saved; fs.rmSync(root, { recursive: true, force: true }); }
}
test('packing is deterministic from IDs, discovery independent, cost balanced, and keeps checkpoint controls with variants', () => {
    for (const value of ['0/2', '3/2', '1/0', '1/257', '1.5/2', '1/2junk']) assert.throws(() => parseStandShard(value));
    const items = ['parent', 'document-only', 'clean-pass', 'review-edit', 'extra', 'a4-generic', 'long-gate-tour'].map(baseline => ({ baseline }));
    const forward = partitionWalkWork(items, 3), backward = partitionWalkWork([...items].reverse(), 3);
    assert.deepEqual(forward, backward);
    const costs = forward.map(bin => bin.reduce((sum, item) => sum + workCost(item), 0));
    assert.ok(Math.max(...costs) - Math.min(...costs) <= Math.max(...items.map(workCost)));
    assert.deepEqual(forward.flat().flatMap(workIds).sort(), items.flatMap(workIds).sort());
    const family = { baseline: 'clean-pass', variants: [{ id: 'sweep-unit', injection: { seed: 1, baseline: 'clean-pass', step: 2, gate: null, disturbances: [] } }] };
    const packed = partitionWalkWork([...items, family], 3);
    assert.equal(packed.flat().filter(item => item.variants).length, 1);
    assert.deepEqual(workIds(packed.flat().find(item => item.variants)!), ['checkpoint-control-clean-pass-s2', 'sweep-unit']);
});
test('all review stacks enables every deep scenario on full and sweep while rotation defaults stay unchanged', () => {
    const allIds = WALK_SCENARIOS.map(item => item.id), deep = allIds.filter(id => id.startsWith('deep-stack-'));
    for (const level of ['full', 'sweep']) {
        const plan = walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: level, GARDA_SYNTHETIC_REVIEW_STACKS: 'all' }, allIds);
        assert.deepEqual(plan.scenarioIds.filter(id => id.startsWith('deep-stack-')), deep);
        assert.ok(plan.reviewRotation.families.every(family => family.stacks.length === 19));
    }
    assert.equal(walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'full' }, allIds).scenarioIds.filter(id => id.startsWith('deep-stack-')).length, 0);
    // seeded: the default seeded rotation (unknown-quartz, three known stacks and permanent pairs) also runs at full,
    // exactly as sweep selects it; every other full scenario is unchanged.
    const seeded = walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'full', GARDA_SYNTHETIC_REVIEW_STACKS: 'seeded' }, allIds);
    const sweepDeep = walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'sweep' }, allIds).scenarioIds.filter(id => id.startsWith('deep-stack-'));
    assert.deepEqual(seeded.scenarioIds.filter(id => id.startsWith('deep-stack-')), sweepDeep);
    assert.ok(seeded.reviewRotation.families.every(family => family.stacks.includes('unknown-quartz') && family.stacks.length >= 4));
    assert.deepEqual(seeded.scenarioIds.filter(id => !id.startsWith('deep-stack-')),
        walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'full' }, allIds).scenarioIds);
    assert.ok(walkRunPlan({ GARDA_SYNTHETIC_WALK_LEVEL: 'sweep' }, allIds).scenarioIds.filter(id => id.startsWith('deep-stack-')).length < deep.length);
});
for (const findings of [[], [finding]]) test('single and merged verdicts, findings, coverage, counters, economy and property trace (findings=' + findings.length + ')', () => temporary(root => {
    fixture(root, findings);
    const walk = judgeWalk(results, findings, 'full', true), properties = readStandProperties(path.resolve('.'));
    const singleInput = { ...input, walk, checks: checks.map(check => check.id === 'walk' && walk.findings.length ? { ...check, status: 'FAIL' as const } : check) };
    const single = buildStandSummary({ ...singleInput, traceability: propertyTrace(properties, { ...singleInput, only: ids }) });
    const merged = mergeReferenceShards(path.join(root, 'inputs'), path.join(root, 'merged'), source);
    assert.deepEqual(merged.pillars, single.pillars);
    assert.deepEqual(merged.traceability, single.traceability);
    assert.deepEqual(merged.totals, single.totals);
    assert.equal(merged.verdict, single.verdict);
    if (process.platform === 'win32' && !findings.length) assert.equal(single.verdict, 'PASS');
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'merged/walk/navigator-walk.json'), 'utf8')) as ReturnType<typeof judgeWalk>;
    assert.deepEqual(raw.findings, JSON.parse(JSON.stringify(walk.findings)));
    assert.deepEqual(raw.metrics, walk.metrics);
    for (const gate of ['compile-gate', 'completion-gate', 'required-reviews-check'])
        assert.ok(raw.coverage.gates.find(item => item.id === 'gate:' + gate)!.steps > 0);
    assert.equal(merged.speed.step_timing, 'INCONCLUSIVE');
    assert.equal(buildStandSummary({ ...input, shard: { index: 1, total: 2 } }).verdict, 'PARTIAL');
    assert.equal(buildStandSummary({ ...input, shard: { index: 1, total: 2 } }).state, 'partial');
}));
test('a result set beyond the single-string limit is written, indexed, verified and merged record by record', () => temporary(root => {
    // Each record fits in one string; the set does not. JSON escapes a control character in six characters, so one shared
    // 31M-character string serializes to about 186M characters per record while the set stays small in memory.
    const noise = '\u0001'.repeat(31_000_000);
    const large = results.map(item => ({ ...item, steps: item.steps.map(step => ({ ...step, output: noise, measurement: { phases_ms: {}, work: {
        'payload_read:/tmp/garda-walk-unit/TASK.md': 1, 'visit:derivation_descriptor_value': 9 } } })) }));
    const parts = large.map(item => JSON.stringify(item));
    assert.ok(parts.every(part => part.length < MAX_STRING_LENGTH));
    assert.ok(parts.reduce((sum, part) => sum + part.length, 0) + parts.length + 1 > MAX_STRING_LENGTH, 'The old results.json text cannot exist');
    // Streaming serialization is byte-identical to JSON.stringify, for the hash and for the file.
    const expected = (suffix: string) => {
        const hash = createHash('sha256');
        parts.forEach((part, index) => hash.update((index ? ',' : '[') + part));
        return hash.update(']' + suffix).digest('hex');
    };
    assert.equal(walkHash(large), expected(''));
    const file = path.join(root, 'large.json');
    atomicWalkJson(file, large);
    const written = createHash('sha256'), descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(1 << 24);
    try { for (let count; (count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) written.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(descriptor); }
    assert.equal(written.digest('hex'), expected('\n'));
    fs.rmSync(file);
    parts.length = 0;
    fixture(root, [], large);
    const shardIndexes = [1, 2].map(index => readWalkResultIndex(path.join(root, 'inputs', 'shard-' + index, 'walk/results.json')));
    // The shard index is a few hundred bytes; the records it names are the only copy of the results.
    for (const index of [1, 2]) assert.ok(fs.statSync(path.join(root, 'inputs', 'shard-' + index, 'walk/results.json')).size < 4096);
    const summary = mergeReferenceShards(path.join(root, 'inputs'), path.join(root, 'merged'), source);
    assert.equal(summary.totals.scenarios, ids.length);
    const merged = readWalkResultIndex(path.join(root, 'merged/walk/results.json'));
    assert.deepEqual(merged.records.map(entry => entry.id).sort(), [...ids].sort());
    assert.deepEqual(Object.fromEntries(merged.records.map(entry => [entry.id, entry.digest])),
        Object.fromEntries(shardIndexes.flatMap(index => index.records).map(entry => [entry.id, entry.digest])));
    const report = JSON.parse(fs.readFileSync(path.join(root, 'merged/walk/navigator-walk.json'), 'utf8')) as ReturnType<typeof judgeWalk>;
    const single = judgeWalk(large, [], 'full', true);
    assert.deepEqual(report.metrics, single.metrics);
    assert.deepEqual(report.findings, JSON.parse(JSON.stringify(single.findings)));
    // A record altered after sealing is still refused, even when the envelope is resealed around it.
    const directory = path.join(root, 'inputs/shard-1/walk/scenarios'), victim = path.join(directory, fs.readdirSync(directory)[0]);
    const record = JSON.parse(fs.readFileSync(victim, 'utf8')) as { result: WalkResult };
    record.result.steps[0].output = noise.slice(1);
    atomicWalkJson(victim, record);
    sealReferenceShard(path.join(root, 'inputs/shard-1'), identity, { index: 1, total: 2 }, { ...input, checks });
    assert.throws(() => mergeReferenceShards(path.join(root, 'inputs'), path.join(root, 'tampered'), source), /tampered scenario/u);
}));
test('sweep merge independently reconstructs variants and requires the family completion checksum', () => temporary(root => {
    const baselines = results.map(item => ({ result: item, scenario: WALK_SCENARIOS.find(scenario => scenario.id === item.scenarioId)! }));
    const family = sweepWork(baselines, Number(identity.seed))[0];
    assert.ok(family?.variants?.length);
    const common = { ...identity, only: family.variants.map(variant => variant.id).join(',') };
    const items = [...ids.map(baseline => ({ baseline })), family];
    const records = [...results, ...workIds(family).map(id => ({ ...result(id, 'compile-gate'), checkpointControl: id.startsWith('checkpoint-control-')
        ? { baseline: family.baseline, step: family.variants![0].injection.step } : undefined }))];
    for (let index = 1; index <= 2; index++) {
        const shard = { index, total: 2 }, directory = path.join(root, 'inputs', String(index)), plan = shardPlan(items, shard);
        const inputs = { source }, manifest = { shard, runInputsHash: walkHash(inputs) };
        const store = new WalkRunStore(path.join(directory, 'walk'), walkHash(manifest));
        const selected = records.filter(item => plan.assigned.includes(item.scenarioId));
        for (const item of selected) store.save({ result: item, findings: [] });
        if (plan.assigned.includes(workIds(family)[0])) store.finishFamily(workIds(family));
        atomicWalkJson(path.join(directory, 'walk/run-manifest.json'), manifest);
        atomicWalkJson(path.join(directory, 'walk/run-inputs.json'), inputs);
        atomicWalkJson(path.join(directory, 'walk/shard-plan.json'), plan);
        atomicWalkJson(path.join(directory, 'walk/results.json'), walkResultIndex(store, selected.map(item => item.scenarioId), [], []));
        sealReferenceShard(directory, common, shard, { ...input, checks: index === 1 ? checks : checks.filter(check => check.id === 'walk') });
    }
    const summary = mergeReferenceShards(path.join(root, 'inputs'), path.join(root, 'merged'), source);
    assert.equal(summary.totals.scenarios, records.length);
    const owner = partitionWalkWork(items, 2).findIndex(bin => bin.some(item => item.variants)) + 1;
    const directory = path.join(root, 'inputs', String(owner)), families = path.join(directory, 'walk/families');
    fs.writeFileSync(path.join(families, fs.readdirSync(families)[0]), '{}');
    // Reseal the envelope so the immutable family marker, rather than just the outer file checksum, rejects it.
    sealReferenceShard(directory, common, { index: owner, total: 2 }, { ...input, checks: owner === 1 ? checks : checks.filter(check => check.id === 'walk') });
    assert.throws(() => mergeReferenceShards(path.join(root, 'inputs'), path.join(root, 'tampered'), source), /checkpoint family/u);
}));
test('merge refuses missing, duplicate, mixed identity, omitted planned scenarios and altered raw or sealed evidence', () => {
    const cases: Array<(root: string) => void> = [
        root => fs.renameSync(path.join(root, 'inputs/shard-2/shard-result.json'), path.join(root, 'missing.json')),
        root => fs.cpSync(path.join(root, 'inputs/shard-1'), path.join(root, 'inputs/duplicate'), { recursive: true }),
        root => {
            const file = path.join(root, 'inputs/shard-2/shard-result.json');
            const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
            artifact.identity.seed = '1'; const { digest: _digest, ...body } = artifact; artifact.digest = walkHash(body); atomicWalkJson(file, artifact);
        },
        root => {
            const file = path.join(root, 'inputs/shard-2/shard-result.json');
            const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
            artifact.summaryInput.policyFindings = [finding];
            const { digest: _digest, ...body } = artifact; artifact.digest = walkHash(body); atomicWalkJson(file, artifact);
        },
        root => {
            const file = path.join(root, 'inputs/shard-2/shard-result.json');
            const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
            artifact.assigned = []; const { digest: _digest, ...body } = artifact; artifact.digest = walkHash(body); atomicWalkJson(file, artifact);
        },
        root => fs.appendFileSync(path.join(root, 'inputs/shard-2/walk/results.json'), ' '),
        root => {
            const directory = path.join(root, 'inputs/shard-2/walk/scenarios');
            fs.appendFileSync(path.join(directory, fs.readdirSync(directory)[0]), ' ');
        }
    ];
    for (const mutate of cases) temporary(root => {
        fixture(root); mutate(root);
        assert.throws(() => mergeReferenceShards(path.join(root, 'inputs'), path.join(root, 'merged'), source));
        assert.ok(!fs.existsSync(path.join(root, 'merged/summary.json')));
    });
});
test('unmeasured platforms never inherit Windows budgets; CI timing cannot fail or pass timing acceptance', () => {
    temporary(root => {
        const directory = path.join(root, 'tests/node/synthetic');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'walk-counter-baseline.json'), JSON.stringify({ schema: 1, routes: { sentinel: {} } }));
        fs.writeFileSync(path.join(directory, 'walk-counter-platforms.json'), JSON.stringify({ schema: 1, platforms: {
            linux: { status: 'NEEDS_CALIBRATION', evidence: 'Deliberately unmeasured unit fixture.', baseline: null }
        } }));
        const linux = platformCounterBaseline(root, 'linux');
        assert.deepEqual(linux.routes, {}); assert.match(linux.provenance, /NEEDS_CALIBRATION/u);
        assert.deepEqual(Object.keys(platformCounterBaseline(root, 'win32').routes), ['sentinel']);
    });
    const walk = judgeWalk(results, [], 'full', true);
    const summary = buildStandSummary({ ...input, walk });
    assert.equal(summary.speed.step_timing, 'INCONCLUSIVE');
    const failedTiming = { verdict: 'FAIL' } as NonNullable<SummaryInput['timing']>;
    assert.equal(buildStandSummary({ ...input, walk, timing: failedTiming }).speed.step_timing, 'INCONCLUSIVE');
});
test('CI timing reports retain an explicit non-baseline marker even when called directly', () => temporary(root => {
    process.env.GITHUB_ACTIONS = 'true';
    const data = path.resolve('tests/node/synthetic');
    const config: Parameters<typeof configureTimingSession>[0] = {
        output: root, selected: [], source: { sourceCommit: 'a'.repeat(40), release: 'unit', packageHash: 'unit', harnessHash: 'unit' },
        environment: {} as Parameters<typeof configureTimingSession>[0]['environment'],
        quiet: { quiet: true, duration_ms: 30000, host_cpu_percent: 0, heavy_processes: [], reasons: [] },
        manifest: JSON.parse(fs.readFileSync(path.join(data, 'step-timing-manifest.json'), 'utf8')),
        baseline: JSON.parse(fs.readFileSync(path.join(data, 'step-timing-baseline.json'), 'utf8')),
        workReportPath: path.join(root, 'work.json')
    };
    atomicWalkJson(config.workReportPath, { anomalies: [] });
    configureTimingSession(config); finishTimingSession();
    const report = JSON.parse(fs.readFileSync(path.join(root, 'step-timing.json'), 'utf8')) as TimingReport;
    assert.equal(report.ci, true); assert.equal(report.verdict, 'INCONCLUSIVE'); assert.equal(report.acceptable_for_baseline, false);
}));

const nativeFs: typeof fs = require('node:fs');
const atomicWriters = [
    { name: 'JSON', bytes: JSON.stringify({ status: 'new' }) + '\n', write: (file: string) => atomicWalkJson(file, { status: 'new' }) },
    { name: 'text', bytes: 'new report\n', write: (file: string) => atomicWalkText(file, 'new report\n') }
];
for (const writer of atomicWriters) {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) test(`atomic stand artifacts retry transient ${code} for ${writer.name}`, t => temporary(root => {
        const file = path.join(root, 'progress.txt'); fs.writeFileSync(file, 'previous complete report');
        const rename = fs.renameSync, pauses: number[] = []; let attempts = 0;
        t.mock.method(Atomics, 'wait', (_array: Int32Array | BigInt64Array, _index: number, _expected: number | bigint, delay?: number) => { pauses.push(delay ?? 0); return 'timed-out' as const; });
        t.mock.method(nativeFs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
            assert.equal(fs.readFileSync(file, 'utf8'), 'previous complete report');
            assert.equal(fs.readFileSync(from, 'utf8'), writer.bytes, 'each attempt keeps the complete streamed temporary file');
            attempts++;
            if (attempts < 3) throw Object.assign(new Error('Transient sharing conflict'), { code });
            return rename(from, to);
        });
        writer.write(file);
        assert.equal(fs.readFileSync(file, 'utf8'), writer.bytes);
        assert.equal(attempts, 3); assert.deepEqual(pauses, [10, 25]);
        assert.deepEqual(fs.readdirSync(root), ['progress.txt']);
    }));
    for (const code of ['EPERM', 'ENOSPC']) test(`atomic stand artifacts retain failure and old bytes on ${code} for ${writer.name}`, t => temporary(root => {
        const file = path.join(root, 'progress.txt'); fs.writeFileSync(file, 'previous complete report');
        const failure = Object.assign(new Error('Persistent replacement refusal'), { code });
        let attempts = 0; const pauses: number[] = [];
        t.mock.method(Atomics, 'wait', (_array: Int32Array | BigInt64Array, _index: number, _expected: number | bigint, delay?: number) => { pauses.push(delay ?? 0); return 'timed-out' as const; });
        t.mock.method(nativeFs, 'renameSync', () => { attempts++; throw failure; });
        assert.throws(() => writer.write(file), error => error === failure);
        assert.equal(fs.readFileSync(file, 'utf8'), 'previous complete report');
        assert.equal(attempts, code === 'EPERM' ? 5 : 1);
        assert.deepEqual(pauses, code === 'EPERM' ? [10, 25, 50, 100] : []);
        assert.deepEqual(fs.readdirSync(root), ['progress.txt']);
    }));
}
