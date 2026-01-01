import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWalkMetrics, counterBudgets, verdictResult, type CounterBaseline } from './engine/walk-metrics';
import { recordedWorkInput, RECORDED_COUNTERS, type RecordedWorkPolicy } from './engine/walk-recorded-work';
import type { WalkResult } from './engine/navigator-walk';
import { inspectWalkTimelineInput } from './engine/navigator-walk';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { inspectRecordedSkillInputs, recordedTaskWorkInput, validateRecordedWorkPolicy } from './engine/walk-recorded-work';
import { assertRecordedBudgetMigration, calibrationCounterBaseline } from './engine/walk-counter-history';
import { walkHash } from './engine/walk-run-store';

const { installRecordedWorkObserver, installLoadedFileObserver } = require(path.resolve('tests/node/synthetic/engine/walk-recorded-work-observer.cjs'));

const policy: RecordedWorkPolicy = { version: 1, loadedCode: true, retireStates: ['old-nine-lane-state'] };
const route = 'BLOCKED/unit';
const baseline: CounterBaseline = { schema: 1, provenance: 'Source-operation costs, no measured product output', recordedWork: policy,
    routes: { [route]: Object.fromEntries([...RECORDED_COUNTERS].map(key => [key, { expected: 0, tolerance: 0, constantWithEvents: true }])) } };

function fixture(lanes: number, cycles: number): WalkResult {
    const events: WalkResult['events'] = [], work: Record<string, number> = {};
    for (let cycle = 0; cycle < cycles; cycle++) {
        events.push({ type: cycle ? 'REVIEW_CYCLE_RESTARTED' : 'TASK_MODE_ENTERED', details: {} },
            { type: 'PREFLIGHT_CLASSIFIED', details: { required_reviews: Object.fromEntries(Array.from({ length: lanes }, (_, lane) => ['lane-' + lane, true])) } });
        for (let lane = 0; lane < lanes; lane++) events.push({ type: 'REVIEW_PHASE_STARTED', details: { review_type: 'lane-' + lane } },
            { type: 'REVIEW_RECORDED', details: { review_type: 'lane-' + lane,
                receipt_snapshot_path: 'garda-agent-orchestrator/runtime/reviews/receipt-' + cycle + '-' + lane + '.json' } });
    }
    const input = recordedWorkInput(events, work);
    for (const file of input.artifacts) { work['file_hash:' + file] = 1; work['payload_read:' + file] = 1; }
    work['derive:getReviewContextContractViolations'] = input.reviews.length;
    work['derive:authoritative_coverage_scope'] = input.lanes.length;
    input.reviews.forEach(id => { work['stand_unit:derive:getReviewContextContractViolations:' + id] = 1; });
    input.lanes.forEach(id => { work['stand_unit:derive:authoritative_coverage_scope:' + id] = 1; });
    // Independent one-pass input vector: N receipt files in the same two
    // ancestor directories, one canonical admission and kind check per file.
    // Do not call the budget implementation to manufacture passing observations.
    const n = lanes * cycles;
    const counts = { existsSync: 3 * n, fstatSync: 2 * n, lstatSync: 10 * n + (n ? 8 : 0), statSync: 2 * n,
        'realpathSync.native': (process.platform === 'win32' ? 11 : 8) * n,
        realpathSync: (n ? 4 : 0) + (process.platform === 'win32' ? n : 4 * n) };
    const io = Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, { count, total_ms: 0, max_ms: 0 }]));
    return { scenarioId: 'recorded-' + lanes + '-lanes-' + cycles + '-cycles', events, steps: [{ index: 0, taskEvents: events.length,
        route, navigatorMs: 1, recordedWorkInput: input, measurement: { work, io, phases_ms: {} } }] } as unknown as WalkResult;
}

test('five and nine lanes, unlimited repeated reviews and restarted cycles use the identical rule', () => {
    for (const lanes of [5, 9]) for (const cycles of [1, 3, 12]) {
        const result = fixture(lanes, cycles);
        assert.deepEqual(analyzeWalkMetrics([result], baseline, true).anomalies, [], result.scenarioId);
        assert.equal(result.steps[0].recordedWorkInput!.reviews.length, lanes * cycles);
        assert.deepEqual(analyzeWalkMetrics([verdictResult(result)], baseline, true), analyzeWalkMetrics([result], baseline, true));
    }
});

test('linear recorded history passes, while growth for unchanged inputs fails below the aggregate ceiling', () => {
    const samples = [1, 2, 3].map(cycles => fixture(9, cycles));
    const linear = { ...samples[2], steps: samples.map((sample, index) => ({ ...sample.steps[0], index })) };
    assert.deepEqual(analyzeWalkMetrics([linear], baseline, true).anomalies, []);
    const generous = structuredClone(baseline);
    for (const budget of Object.values(generous.routes[route])) budget.expected = 10000;
    const base = fixture(1, 1);
    const repeated = { ...base, steps: [0, 1, 2].map(index => {
        const step = structuredClone(base.steps[0]);
        step.index = index; step.taskEvents += 10 * index;
        step.measurement!.io!.existsSync.count += index;
        return step;
    }) };
    const anomalies = analyzeWalkMetrics([repeated], generous, true).anomalies;
    assert.ok(anomalies.some(row => row.kind === 'counter-growth' && row.metric === 'file_probes:existsSync:same-inputs/100events'));
    assert.ok(!anomalies.some(row => row.kind === 'counter-budget'));
});

test('each relative counter rejects one extra operation at its derived limit', () => {
    for (const key of RECORDED_COUNTERS) {
        const result = fixture(9, 3), measurement = result.steps[0].measurement!;
        if (key === 'file_hash:file' || key === 'payload_reads') {
            const file = result.steps[0].recordedWorkInput!.artifacts[0];
            measurement.work[(key === 'payload_reads' ? 'payload_read:' : 'file_hash:') + file]++;
        } else measurement.io![key.slice('file_probes:'.length)].count++;
        assert.ok(analyzeWalkMetrics([result], baseline, true).anomalies.some(row => row.kind === 'counter-budget' && row.metric === key), key);
    }
});

test('unused constant allowance cannot hide a repeated artifact or closed-review derivation', () => {
    const generous = structuredClone(baseline);
    for (const budget of Object.values(generous.routes[route])) budget.expected = 10000;
    for (const prefix of ['file_hash:', 'payload_read:']) {
        const result = fixture(1, 1), file = result.steps[0].recordedWorkInput!.artifacts[0];
        result.steps[0].measurement!.work[prefix + file] = 2;
        assert.ok(analyzeWalkMetrics([result], generous, true).anomalies.some(row => row.metric.startsWith(prefix.slice(0, -1) + ':repeated:')));
    }
    for (const key of ['derive:getReviewContextContractViolations', 'derive:resolvePersistedRemediationReviewExecutionAuthority', 'derive:authoritative_coverage_scope']) {
        const result = fixture(1, 1); result.steps[0].measurement!.work[key] = 2;
        assert.ok(analyzeWalkMetrics([result], generous, true).anomalies.some(row => row.metric === key), key);
    }
});

test('loaded-code files require their own decision and repeated hashes never create units', () => {
    const result = fixture(0, 1), step = result.steps[0], work = step.measurement!.work;
    work['code.capture'] = 1;
    work['visit:loaded_code_initial_file'] = 1;
    const file = 'garda-agent-orchestrator/dist/src/core/loaded.js';
    work['file_hash:' + file] = 1;
    step.recordedWorkInput = recordedWorkInput(result.events, work);
    const pending = structuredClone(baseline); pending.recordedWork!.loadedCode = false;
    assert.ok(analyzeWalkMetrics([result], pending, true).anomalies.some(row => row.metric === 'file_hash:file'));
    assert.deepEqual(analyzeWalkMetrics([result], baseline, true).anomalies, []);
    work['file_hash:' + file] = 2;
    step.recordedWorkInput = recordedWorkInput(result.events, work);
    assert.equal(step.recordedWorkInput.loadedFiles.length, 1);
    assert.ok(analyzeWalkMetrics([result], baseline, true).anomalies.some(row => row.metric.startsWith('file_hash:repeated:')));
});

test('different loaded-code domains share physical bytes and retain every identity witness', () => {
    const work: Record<string, number> = {}, file = 'garda-agent-orchestrator/dist/src/core/loaded.js';
    const content = Object.freeze({ sha256: 'a'.repeat(64) });
    let read = false;
    const acquire = (input: string) => {
        assert.equal(input, file);
        if (!read) { work['file_hash:' + file] = 1; work['payload_read:' + file] = 1; }
        const capturedNow = !read; read = true; return { content, capturedNow };
    };
    const files = { readInvocationFileContent: (input: string) => acquire(input).content, readInvocationFileContentWithObservation: acquire };
    const measurement = { countNextStepWork: (key: string, amount = 1) => { work[key] = (work[key] ?? 0) + amount; } };
    const failure = new Error('native capture failure');
    const code = { captureLoadedCodeClosure: (domain: string, _roots: string[]) => {
        if (domain === 'throws') throw failure;
        measurement.countNextStepWork('code.capture'); measurement.countNextStepWork('visit:loaded_code_initial_file');
        return process.platform === 'win32' ? files.readInvocationFileContentWithObservation(file).content : files.readInvocationFileContent(file);
    } };
    installLoadedFileObserver(code, files, measurement);
    for (const domain of ['owner-a', 'owner-b']) assert.equal(code.captureLoadedCodeClosure(domain, ['/fixed/root.js']), content);
    assert.equal(work['file_hash:' + file], 1);
    const input = recordedWorkInput([], work);
    assert.equal(input.loadedFiles.length, 1);
    assert.equal(input.loadedDomainFiles!.length, 2);
    const counts = { fstatSync: 2, lstatSync: process.platform === 'win32' ? 19 : 22, statSync: 1,
        'realpathSync.native': 4, realpathSync: process.platform === 'win32' ? 6 : 9 };
    const result = { scenarioId: 'two-code-domains', events: [], steps: [{ index: 0, taskEvents: 0, route, navigatorMs: 1,
        recordedWorkInput: input, measurement: { work, phases_ms: {}, io: Object.fromEntries(Object.entries(counts)
            .map(([key, count]) => [key, { count, total_ms: 0, max_ms: 0 }])) } }] } as unknown as WalkResult;
    assert.deepEqual(analyzeWalkMetrics([result], baseline, true).anomalies, []);
    code.captureLoadedCodeClosure('owner-a', ['/fixed/root.js']);
    const repeated = { ...result, steps: [{ ...result.steps[0], recordedWorkInput: recordedWorkInput([], work) }] };
    assert.ok(analyzeWalkMetrics([repeated], baseline, true).anomalies.some(row => row.metric.startsWith('stand_loaded_file:')));
    assert.throws(() => code.captureLoadedCodeClosure('throws', ['/fixed/root.js']), error => error === failure);
    const keys = Object.keys(work).length; files.readInvocationFileContent(file);
    assert.equal(Object.keys(work).length, keys, 'Capture failure leaves no attribution scope behind');
});

test('an actual module loaded during measurement earns its loader read once across domains', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-loader-')), file = path.join(root, 'module.json');
    fs.writeFileSync(file, '{}');
    try {
        const work: Record<string, number> = {};
        const content = Object.freeze({ sha256: 'b'.repeat(64) });
        const files = { readInvocationFileContent: (_file: string) => content, readInvocationFileContentWithObservation: (_file: string) => ({ content, capturedNow: true }) };
        const measurement = { countNextStepWork: (key: string, amount = 1) => { work[key] = (work[key] ?? 0) + amount; },
            withNextStepMeasurement: (action: () => void, _receive: () => void) => action() };
        const code = { captureLoadedCodeClosure: (_domain: string, _roots: string[]) => {
            require(file);
            measurement.countNextStepWork('code.capture'); measurement.countNextStepWork('visit:loaded_code_initial_file');
            return files.readInvocationFileContent(file);
        } };
        installLoadedFileObserver(code, files, measurement);
        measurement.withNextStepMeasurement(() => {
            code.captureLoadedCodeClosure('a', ['/root.js']); code.captureLoadedCodeClosure('b', ['/root.js']);
        }, () => {});
        const input = recordedWorkInput([], work);
        assert.equal(input.loadedDomainFiles!.length, 2);
        assert.equal(input.loadedLoaderFiles!.length, 1);
        assert.equal(input.loadedFiles.length, 1);
    } finally { delete require.cache[file]; fs.rmSync(root, { recursive: true, force: true }); }
});

test('retirement removes only relative overrides; fixed budgets and subprocess ceilings stay exact', () => {
    const next = structuredClone(baseline);
    next.routes[route]['subprocess:git'] = { expected: 20, tolerance: 0, constantWithEvents: true };
    next.routes[route]['file_probes:readdirSync'] = { expected: 9, tolerance: 0, constantWithEvents: false };
    next.states = { 'old-nine-lane-state': { provenance: 'retired fixed shape', routes: { [route]: {
        'file_hash:file': { expected: 9000, tolerance: 0, constantWithEvents: true },
        'file_probes:readdirSync': { expected: 10, tolerance: 0, constantWithEvents: false }
    } } } };
    const budgets = counterBudgets(next, route, 'old-nine-lane-state')!;
    assert.equal(budgets['file_hash:file'].expected, 0);
    assert.deepEqual(budgets['subprocess:git'], next.routes[route]['subprocess:git']);
    assert.equal(budgets['file_probes:readdirSync'].expected, 10);
    const result = fixture(9, 3);
    result.steps[0].measurement!.work['process:spawnSync:git:same-query'] = 3;
    assert.ok(analyzeWalkMetrics([result], next, true).anomalies.some(row => row.metric.endsWith('same-query:repeated')));
});

test('an ACL query repeated for the same phase and subject fails despite route slack', () => {
    const next = structuredClone(baseline);
    next.routes[route]['subprocess:icacls.exe'] = { expected: 20, tolerance: 0, constantWithEvents: true };
    const result = fixture(9, 3), work = result.steps[0].measurement!.work;
    work['acl_probe:initial:/tmp/subject'] = 1; work['acl_probe:final:/tmp/subject'] = 1;
    work['process:spawnSync:icacls.exe:same-subject'] = 3;
    assert.ok(analyzeWalkMetrics([result], next, true).anomalies.some(row => row.metric === 'subprocess:icacls.exe/subjects'));
});

test('the same closed review derived twice fails even with eight other recorded units idle', () => {
    for (const [metric, owner] of [
        ['derive:getReviewContextContractViolations', 'review-context-contract-violations'],
        ['derive:resolvePersistedRemediationReviewExecutionAuthority', 'persisted-remediation-review-execution-authority'],
        ['derive:authoritative_coverage_scope', 'authoritative-review-coverage-contract']
    ]) {
        const result = fixture(9, 1), work = result.steps[0].measurement!.work;
        work[metric] = 0;
        for (const key of Object.keys(work)) if (key.startsWith('stand_unit:' + metric + ':')) delete work[key];
        const memo = { memoizeInvocationRead: (_key: { token: symbol }, _id: string, build: () => unknown) => ({ value: build() }) };
        const measurement = { countNextStepWork: (key: string, count = 1) => { work[key] = (work[key] ?? 0) + count; } };
        installRecordedWorkObserver(memo, measurement);
        const key = { token: Symbol(owner) }, returned = { retained: true };
        for (let repeat = 0; repeat < 2; repeat++) assert.equal(memo.memoizeInvocationRead(key, 'same closed review', () => {
            measurement.countNextStepWork(metric); return returned;
        }).value, returned);
        const analysis = analyzeWalkMetrics([result], baseline, true);
        assert.ok(analysis.anomalies.some(row => row.metric.startsWith('stand_unit:' + metric + ':')), metric);
        assert.deepEqual(analyzeWalkMetrics([verdictResult(result)], baseline, true), analysis);
        const failure = new Error('native failure');
        assert.throws(() => memo.memoizeInvocationRead(key, 'throw', () => { throw failure; }), error => error === failure);
    }
});

test('a relative policy cannot smuggle in fitted coefficients or subprocess allowances', () => {
    assert.doesNotThrow(() => validateRecordedWorkPolicy(policy));
    for (const invalid of [{ ...policy, version: 2 }, { ...policy, loadedCode: 1 }, { ...policy, retireStates: ['a', 'a'] },
        { ...policy, perReview: 1000 }, { ...policy, subprocess: 1 }]) assert.throws(() => validateRecordedWorkPolicy(invalid), /Invalid recorded-work/u);
});

test('missing derivation identities cannot be certified from a small aggregate total', () => {
    const result = fixture(9, 3);
    for (const key of Object.keys(result.steps[0].measurement!.work)) if (key.startsWith('stand_unit:')) delete result.steps[0].measurement!.work[key];
    assert.ok(analyzeWalkMetrics([result], baseline, true).anomalies.some(row => row.metric.startsWith('stand_unit_unattributed:')));
});

test('two spellings of one artifact cannot mint allowance or hide a second read', () => {
    const result = fixture(9, 3), file = result.steps[0].recordedWorkInput!.artifacts[0];
    result.steps[0].measurement!.work['payload_read:' + file.replace('/reviews/', '/reviews/./')] = 1;
    assert.ok(analyzeWalkMetrics([result], baseline, true).anomalies.some(row => row.metric.startsWith('payload_read:repeated:')));
    if (process.platform === 'win32') {
        const older = fixture(9, 3), captured = older.steps[0].recordedWorkInput!;
        captured.artifacts = captured.artifacts.map(value => value.toUpperCase());
        older.steps[0].measurement!.work['payload_read:' + file] = 2;
        assert.ok(analyzeWalkMetrics([older], baseline, true).anomalies.some(row => row.metric.startsWith('payload_read:repeated:')),
            'An older captured manifest retains its evidence when canonical spelling changes');
    }
});

test('skill references and declared source directories come from independent input facts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-recorded-input-'));
    try {
        const skills = path.join(root, 'skills'), selected = path.join(skills, 'review');
        fs.mkdirSync(selected, { recursive: true });
        fs.writeFileSync(path.join(selected, 'skill.json'), JSON.stringify({ references: ['one.md', 'also.txt', '../escape.md'] }));
        const events = [{ type: 'TASK_MODE_ENTERED', details: {} }, { type: 'SKILL_SELECTED', details: { skill_id: 'review' } }];
        const witnesses = inspectRecordedSkillInputs(root, events, skills);
        assert.equal(witnesses.length, 1);
        assert.equal(witnesses[0].inputs.length, 3);
        assert.match(witnesses[0].sha256, /^[a-f0-9]{64}$/u);
        const input = recordedWorkInput(events, {}, witnesses, ['module/src/subject.ts', '../outside.ts']);
        assert.ok(input.artifacts.some(file => file.endsWith('/references/one.md')));
        assert.ok(input.artifacts.some(file => file.endsWith('/references/also.txt')));
        assert.deepEqual(input.sourceFiles, ['module/src/subject.ts']);
        assert.ok(input.directories.includes('module/src'));
        assert.ok(input.directories.includes('module'));
        assert.deepEqual(recordedWorkInput([], {}, [], ['module/src/subject.ts']).sourceFiles, []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('two children with the same lane have separate scope units and share physical inputs once', () => {
    const task = fixture(1, 1), input = task.steps[0].recordedWorkInput!;
    const combined = recordedTaskWorkInput([{ taskId: 'parent-1', input }, { taskId: 'parent-2', input }], {});
    assert.equal(combined.lanes.length, 2);
    assert.equal(combined.reviews.length, 2);
    assert.equal(combined.laneScopes!.length, 2);
    assert.equal(combined.artifacts.length, 1);
    const changed = structuredClone(task.events);
    changed.push({ type: 'PREFLIGHT_CLASSIFIED', details: { required_reviews: { 'lane-0': true }, scope_sha256: 'a'.repeat(64) } });
    const scopes = recordedWorkInput(changed, {});
    assert.equal(scopes.lanes.length, 1);
    assert.equal(scopes.laneScopes!.length, 2);
    changed.push(structuredClone(changed.at(-1)!));
    assert.equal(recordedWorkInput(changed, {}).laneScopes!.length, 2, 'Unchanged repeated preflight creates no extra scope unit');
});

test('independent consumed timelines retain separate task units without duplicate-pass credit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-recorded-'));
    try {
        const directory = path.join(root, 'garda-agent-orchestrator/runtime/task-events');
        fs.mkdirSync(directory, { recursive: true });
        const events = [{ event_type: 'TASK_MODE_ENTERED', details: {} },
            { event_type: 'PREFLIGHT_CLASSIFIED', details: { required_reviews: { code: true } } }];
        const work: Record<string, number> = {};
        for (const task of ['PARENT-1', 'PARENT-2']) {
            const file = path.join(directory, task + '.jsonl');
            fs.writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n');
            work['timeline_capture:' + file] = 2;
        }
        const inspected = inspectWalkTimelineInput(root, work);
        assert.equal(inspected.error, undefined);
        assert.equal(inspected.events, 4);
        assert.equal(inspected.tasks!.length, 2);
        const input = recordedTaskWorkInput(inspected.tasks!.map(task => ({ taskId: task.file, input: recordedWorkInput(task.events, {}) })), {});
        assert.equal(input.lanes.length, 2);
        assert.equal(input.cycles.length, 2);
        const broken = path.join(directory, 'PARENT-2.jsonl');
        fs.writeFileSync(broken, 'malformed-json\n');
        const refused = inspectWalkTimelineInput(root, work);
        assert.equal(refused.error, undefined, 'New fact decoding must not change the existing event/byte input allowance');
        assert.equal(refused.events, 3);
        assert.ok(refused.tasks!.find(task => task.file.endsWith('PARENT-2.jsonl'))!.error);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('historical calibration follows a checksummed accepted decision and preserves all unrelated ceilings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-recorded-history-'));
    try {
        const previous = structuredClone(baseline); delete previous.recordedWork;
        previous.routes[route]['subprocess:git'] = { expected: 2, tolerance: 0, constantWithEvents: true };
        previous.states = { 'old-nine-lane-state': { provenance: 'unit fixture', routes: { [route]: {
            'file_hash:file': { expected: 99, tolerance: 0, constantWithEvents: true }
        } } } };
        const next = structuredClone(previous); next.recordedWork = policy;
        delete next.states!['old-nine-lane-state'].routes[route]['file_hash:file'];
        assert.doesNotThrow(() => assertRecordedBudgetMigration(previous, next));
        const changed = structuredClone(next); changed.routes[route]['subprocess:git'].expected++;
        assert.throws(() => assertRecordedBudgetMigration(previous, changed), /constants/u);
        assert.throws(() => calibrationCounterBaseline(root, next, 'win32'), /explicit accepted/u);
        const record = { kind: 'counters', previous_sha256: 'fixture-only', previous, accepted: next };
        const name = walkHash(record) + '.json', file = path.join(root, name);
        fs.writeFileSync(file, JSON.stringify(record));
        const accepted = { ...next, baseline_update: { evidence: name, previous_sha256: record.previous_sha256 } };
        assert.deepEqual(calibrationCounterBaseline(root, accepted, 'win32'), previous);
        fs.writeFileSync(file, JSON.stringify({ ...record, previous: changed }));
        assert.throws(() => calibrationCounterBaseline(root, accepted, 'win32'), /history differs/u);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
