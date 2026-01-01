import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { StandFinding } from '../../../scripts/node-foundation/synthetic/model';
import { compareWalk, createWalkTemplate, walkTaskFamily, WALK_PROVIDER, type WalkResult, type WalkScenario } from './engine/navigator-walk';
import { buildWalkReport, renderWalkReport } from './engine/walk-report';
import { anomalyFindings } from './engine/walk-metrics';
import { buildSweepScenarios, replaySweepScenarios, sweepApplicability, type SweepInjection } from './engine/walk-sweep';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { matchesDisturbanceSelection, walkRunPlan } from './engine/walk-plan';
import { atomicWalkJson, assertWalkResumeIdentity, WalkRunStore, walkHash, walkProgress, type FinishedWalk } from './engine/walk-run-store';
import { getProviderEntryById, getProviderEnvironmentDetectionMarkers, normalizeProviderId } from '../../../src/core/provider/provider-registry';

// Walks name their provider explicitly. The operator's own agent shell (for example CLAUDECODE inside Claude Code)
// must not change runtime identity resolution, or the verdict would depend on where the stand was started.
for (const marker of getProviderEnvironmentDetectionMarkers()) delete process.env[marker];
delete process.env.GARDA_EXECUTION_PROVIDER;
const provider = getProviderEntryById(normalizeProviderId(WALK_PROVIDER) || WALK_PROVIDER);
const marker = provider?.environmentDetection?.markers[0];
assert.ok(marker, `Synthetic walk provider '${WALK_PROVIDER}' needs a registered detection marker`);
process.env[marker] = '1';

const REPORT_ROOT = path.resolve(process.env.GARDA_SYNTHETIC_WALK_REPORT || process.env.GARDA_SYNTHETIC_WALK_RESUME || fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-report-')));
// A discovery run sets none of the walk variables and therefore walks the sample only.
const PLAN = walkRunPlan(process.env, WALK_SCENARIOS.map(entry => entry.id));
const LEVEL = PLAN.level;
interface WorkItem { baseline: string; variants?: Array<{ id: string; injection: SweepInjection }> }

function runInputs(): { manifest: unknown; files: string[] } {
    // Hash all tracked inputs (including fixtures/templates) and untracked source inputs. Deleted files
    // are represented too: HEAD alone cannot identify a dirty worktree or a changed template.
    const git = (...args: string[]) => execFileSync('git', ['-c', 'safe.directory=' + path.resolve('.'), ...args],
        { encoding: 'utf8', windowsHide: true });
    const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
        'src', 'template', 'scripts', 'tests', 'bin', 'package.json', 'package-lock.json', 'tsconfig*.json', 'eslint*')
        .split('\0').filter(Boolean))].sort();
    const digests = Object.fromEntries(files.map(file => [file, fs.existsSync(file)
        ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null]));
    return { files, manifest: { sourceCommit: git('rev-parse', 'HEAD').trim(), node: process.version,
        platform: process.platform, files: digests } };
}

function retainRunInputs(inputs: ReturnType<typeof runInputs>): void {
    for (const file of inputs.files) {
        if (!fs.existsSync(file)) continue;
        const output = path.join(REPORT_ROOT, 'run-inputs', file);
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(file, output);
    }
    atomicWalkJson(path.join(REPORT_ROOT, 'run-inputs.json'), inputs.manifest);
}

let store: WalkRunStore;
let resumeStore: WalkRunStore | undefined;
const observed = new Map<string, FinishedWalk>();
const planned = new Set<string>();
const sessionStarted = performance.now();
let reused = 0, fresh = 0;

function snapshot(): void {
    const records = [...observed.values()];
    atomicWalkJson(path.join(REPORT_ROOT, 'progress.json'), { ...walkProgress(records, planned.size,
        performance.now() - sessionStarted, fresh), status: 'running', reused, updatedAt: new Date().toISOString() });
    atomicWalkJson(path.join(REPORT_ROOT, 'partial-findings.json'), { partial: true,
        completed: records.length, total: planned.size, coverageComplete: false, crossScenarioBudgetsComplete: false,
        scenarios: records.map(value => ({ id: value.result.scenarioId, outcome: value.result.outcome, findings: value.findings })),
        findings: records.flatMap(value => value.findings) });
}

function observe(value: FinishedWalk, reuse = false): void {
    if (observed.has(value.result.scenarioId)) return;
    observed.set(value.result.scenarioId, value);
    if (reuse) reused++; else fresh++;
    snapshot();
    const progress = walkProgress([...observed.values()], planned.size, performance.now() - sessionStarted, fresh);
    console.log('Walk ' + progress.finished + '/' + progress.total + ' ' + value.result.scenarioId + ' ' + value.result.outcome
        + ' elapsed=' + Math.round(value.result.elapsedMs ?? 0) + 'ms ' + JSON.stringify(progress.counts)
        + ' ETA=' + (progress.etaMs === null ? 'unknown' : Math.ceil(progress.etaMs / 1000) + 's') + (reuse ? ' reused' : ''));
}

function itemIds(item: WorkItem): string[] {
    return item.variants ? ['checkpoint-control-' + item.baseline + '-s' + item.variants[0].injection.step,
        ...item.variants.map(value => value.id)] : [item.baseline];
}

function writeReport(results: readonly WalkResult[], findings: StandFinding[]): ReturnType<typeof buildWalkReport> {
    const report = buildWalkReport(results, findings);
    fs.mkdirSync(REPORT_ROOT, { recursive: true });
    fs.writeFileSync(path.join(REPORT_ROOT, 'navigator-walk.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(REPORT_ROOT, 'navigator-walk.md'), renderWalkReport(report));
    return report;
}

function scenarioFor(item: WorkItem): WalkScenario {
    const scenario = WALK_SCENARIOS.find(entry => entry.id === item.baseline);
    if (!scenario) throw new Error('Unknown scenario: ' + item.baseline);
    return scenario;
}

// All parallelism is between processes; clock, cwd and instrumentation are process scoped.
async function execute(items: WorkItem[], jobs: number, stage: string): Promise<{ results: WalkResult[]; findings: StandFinding[] }> {
    if (!items.length) return { results: [], findings: [] };
    const requested = items;
    for (const item of requested) for (const id of itemIds(item)) planned.add(id);
    items = requested.filter(item => {
        const ids = itemIds(item);
        const values = item.variants ? resumeStore?.readFamily(ids) : [resumeStore?.read(item.baseline)];
        if (values?.length && values.every(value => value)) {
            for (const value of values as FinishedWalk[]) { store.save(value); observe(value, true); }
            if (item.variants) store.finishFamily(ids);
            return false;
        }
        store.invalidate(ids);
        return true;
    });
    snapshot();
    const collect = () => {
        const values = requested.flatMap(item => itemIds(item).flatMap(id => {
            const value = observed.get(id) ?? store.read(id);
            if (value) observe(value);
            return value ? [value] : [];
        }));
        return { results: values.map(value => value.result), findings: values.flatMap(value => value.findings) };
    };
    if (!items.length) return collect();
    fs.mkdirSync(REPORT_ROOT, { recursive: true });
    if (jobs > 1) {
        const partitions = Array.from({ length: Math.min(jobs, items.length) }, (_unused, index) => ({
            directory: path.join(REPORT_ROOT, stage + '-job-' + index), items: items.filter((_item, offset) => offset % Math.min(jobs, items.length) === index)
        }));
        const timer = setInterval(collect, 250);
        let codes: Array<number | null>;
        try { codes = await Promise.all(partitions.map(async partition => {
            fs.mkdirSync(partition.directory, { recursive: true });
            const manifest = path.join(partition.directory, 'work.json');
            fs.writeFileSync(manifest, JSON.stringify(partition.items));
            const log = fs.openSync(path.join(partition.directory, 'worker.log'), 'w');
            const { NODE_TEST_CONTEXT: _context, GARDA_SYNTHETIC_WALK_RESUME: _resume, ...env } = process.env;
            return await new Promise<number | null>((resolve, reject) => {
                const child = spawn(process.execPath, ['--test', __filename], { stdio: ['ignore', log, log], windowsHide: true,
                    env: { ...env, GARDA_SYNTHETIC_WALK_STORE: store.root, GARDA_SYNTHETIC_WALK_RUN_HASH: store.runHash, GARDA_SYNTHETIC_WALK_JOBS: '1', GARDA_SYNTHETIC_WALK_WORK: manifest, GARDA_SYNTHETIC_WALK_REPORT: partition.directory } });
                child.once('error', error => { fs.closeSync(log); reject(error); });
                child.once('close', code => { fs.closeSync(log); resolve(code); });
            });
        })); } finally { clearInterval(timer); collect(); }
        const { results, findings } = collect();
        partitions.forEach((partition, index) => {
            if (codes[index] !== 0) findings.push({ layer: 'walk', kind: 'contract', id: 'walk:worker:' + stage + ':' + index,
                summary: 'Worker exit ' + codes[index] + '; inspect ' + path.join(partition.directory, 'worker.log'),
                detail: { route: '(worker)', step: -1, replay: 'GARDA_SYNTHETIC_WALK_WORK=' + path.join(partition.directory, 'work.json') } });
        });
        return { results, findings };
    }
    await executeWorker(items);
    return collect();
}

async function executeWorker(items: WorkItem[]): Promise<void> {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        for (const item of items) {
            const scenario = scenarioFor(item);
            const variants = item.variants?.map(value => ({ ...scenario, id: value.id, injection: value.injection, expectedReviews: {}, expectedModes: [] }));
            const accepted = new Set<string>();
            const accept = (result: WalkResult) => {
                const expected = variants?.find(entry => entry.id === result.scenarioId) ?? { ...scenario, id: result.scenarioId };
                const value = { result, findings: compareWalk(expected, result) };
                store.save(value);
                accepted.add(result.scenarioId);
                if (!process.env.GARDA_SYNTHETIC_WALK_WORK) observe(value);
            };
            const started = performance.now();
            try {
                await walkTaskFamily(template, scenario, variants, accept);
                if (variants) store.finishFamily(itemIds(item));
            } catch (error) {
                for (const id of itemIds(item).filter(id => !accepted.has(id))) accept({ scenarioId: id,
                    outcome: 'exception', detail: String(error), elapsedMs: performance.now() - started,
                    steps: [], reviewsByLane: {}, reviews: [], events: [] });
            }
        }
    } finally { fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('synthetic navigator coverage, disturbance and measurement stand', { timeout: PLAN.timeoutMs, concurrency: false }, async () => {
    const jobs = PLAN.jobs;
    fs.mkdirSync(REPORT_ROOT, { recursive: true });
    if (process.env.GARDA_SYNTHETIC_WALK_WORK) {
        const work = JSON.parse(fs.readFileSync(process.env.GARDA_SYNTHETIC_WALK_WORK, 'utf8')) as WorkItem[];
        store = new WalkRunStore(process.env.GARDA_SYNTHETIC_WALK_STORE!, process.env.GARDA_SYNTHETIC_WALK_RUN_HASH!);
        // Workers publish only immutable scenario records; the parent owns aggregates and progress.
        await executeWorker(work);
        return;
    }
    const started = performance.now();
    const inputs = runInputs();
    const seed = Number(process.env.GARDA_SYNTHETIC_SEED ?? 0x6a726461);
    assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'Seed must be an unsigned 32-bit integer');
    const replay = process.env.GARDA_SYNTHETIC_WALK_REPLAY_MANIFEST;
    const identity = { version: 1, seed, level: LEVEL, provider: WALK_PROVIDER, scenarioManifest: PLAN.scenarioIds,
        only: PLAN.only, disturbance: PLAN.disturbance, runSweep: PLAN.runSweep,
        quiet: process.env.GARDA_SYNTHETIC_WALK_QUIET === '1',
        diagnostics: !!process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS, cpu: process.env.GARDA_SYNTHETIC_WALK_DIAGNOSTICS_CPU === '1',
        replay: replay ? walkHash(JSON.parse(fs.readFileSync(replay, 'utf8'))) : null, runInputsHash: walkHash(inputs.manifest) };
    const resume = process.env.GARDA_SYNTHETIC_WALK_RESUME;
    if (resume) {
        const root = path.resolve(resume);
        try {
            assertWalkResumeIdentity(JSON.parse(fs.readFileSync(path.join(root, 'run-manifest.json'), 'utf8')), identity);
            assertWalkResumeIdentity(walkHash(JSON.parse(fs.readFileSync(path.join(root, 'run-inputs.json'), 'utf8'))), identity.runInputsHash);
        } catch (error) { throw new Error('Synthetic walk resume refused: ' + String(error)); }
        resumeStore = new WalkRunStore(root, walkHash(identity));
    }
    if ((!resume || path.resolve(resume) !== REPORT_ROOT) && fs.existsSync(path.join(REPORT_ROOT, 'run-manifest.json'))) {
        throw new Error('Report directory already contains a run; use GARDA_SYNTHETIC_WALK_RESUME or a new report directory.');
    }
    store = new WalkRunStore(REPORT_ROOT, walkHash(identity));
    retainRunInputs(inputs);
    atomicWalkJson(path.join(REPORT_ROOT, 'run-manifest.json'), identity);
    let sweepPlanned = 0, sweepCompleted = 0;
    const only = PLAN.only ?? undefined;
    const scenarios = WALK_SCENARIOS.filter(entry => PLAN.scenarioIds.includes(entry.id));
    const initial = await execute(scenarios.map(entry => ({ baseline: entry.id })), jobs, 'full');
    const results = initial.results, findings = initial.findings;
    writeReport(results, findings);
    if (PLAN.runSweep) {
        const baselineIds = ['clean-pass', 'document-only', 'security-refactor-pass'];
        const missing = baselineIds.filter(id => !results.some(result => result.scenarioId === id));
        const extra = await execute(missing.map(baseline => ({ baseline })), jobs, 'baselines');
        results.push(...extra.results); findings.push(...extra.findings);
        const baselines = baselineIds.map(id => ({ scenario: WALK_SCENARIOS.find(entry => entry.id === id)!, result: results.find(result => result.scenarioId === id)! }));
        for (const baseline of baselines) assert.equal(baseline.result.outcome, 'done', 'Sweep baseline must reach DONE: ' + baseline.scenario.id);
        const retained = process.env.GARDA_SYNTHETIC_WALK_REPLAY_MANIFEST;
        if (retained) assert.ok(only?.length && only.every(id => id.startsWith('sweep-')),
            'A retained manifest requires an explicit selection of sweep IDs');
        const sweep = retained ? replaySweepScenarios(baselines,
            JSON.parse(fs.readFileSync(path.resolve(retained), 'utf8')) as Array<SweepInjection & { id: string }>, only!, seed)
            : buildSweepScenarios(baselines, seed);
        fs.writeFileSync(path.join(REPORT_ROOT, 'sweep-applicability.json'), JSON.stringify(baselines.map(entry => ({ baseline: entry.scenario.id, steps: sweepApplicability(entry.result) })), null, 2));
        const sweepManifest = sweep.map(entry => ({ id: entry.id, ...entry.injection }));
        if (resume && fs.existsSync(path.join(resume, 'sweep-manifest.json'))) {
            assertWalkResumeIdentity(JSON.parse(fs.readFileSync(path.join(resume, 'sweep-manifest.json'), 'utf8')), sweepManifest);
        }
        atomicWalkJson(path.join(REPORT_ROOT, 'sweep-manifest.json'), sweepManifest);
        const requestedKinds = PLAN.disturbance?.split(',') ?? [];
        const selected = sweep.filter(entry => (!only || only.includes(entry.id))
            && matchesDisturbanceSelection(PLAN.disturbance, entry.injection!.disturbances.map(disturbance => disturbance.kind)));
        sweepPlanned = selected.length;
        assert.deepEqual(only?.filter(id => id.startsWith('sweep-') && !selected.some(entry => entry.id === id)) ?? [], [], 'Unknown sweep replay; use the seed and ID from its manifest');
        for (const kind of requestedKinds) assert.ok(selected.some(entry => entry.injection!.disturbances.some(disturbance => disturbance.kind === kind)),
            'No sweep variant has disturbance ' + kind);
        const families = new Map<string, WorkItem>();
        for (const entry of selected) {
            const injection = entry.injection!, key = injection.baseline + ':' + injection.step;
            const item = families.get(key) ?? { baseline: injection.baseline, variants: [] };
            item.variants!.push({ id: entry.id, injection }); families.set(key, item);
        }
        const disturbed = await execute([...families.values()], jobs, 'sweep');
        results.push(...disturbed.results); findings.push(...disturbed.findings);
        sweepCompleted = disturbed.results.filter(result => !result.checkpointControl).length;
        assert.equal(sweepCompleted, selected.length, 'Every sweep variant must report its outcome');
    }
    const report = writeReport(results, findings);
    const allFindings = [...findings, ...anomalyFindings(report.anomalies)];
    if (LEVEL !== 'sample' && !only && !PLAN.disturbance) {
        allFindings.push(...report.coverage.unaccounted.map(id => ({ layer: 'walk' as const, kind: 'contract' as const,
            id: 'walk:uncovered:' + id, summary: 'Source route neither reached nor explained: ' + id,
            detail: { route: id, step: null, replay: 'GARDA_SYNTHETIC_WALK_LEVEL=' + LEVEL } })));
        assert.deepEqual(report.coverage.invalidExemptions, [], 'Invalid coverage exemptions');
    }
    writeReport(results, allFindings);
    fs.writeFileSync(path.join(REPORT_ROOT, 'run.json'), JSON.stringify({ level: LEVEL, jobs, elapsedMs: performance.now() - started,
        quiet: process.env.GARDA_SYNTHETIC_WALK_QUIET === '1',
        scenarios: results.length, steps: report.executedSteps, findings: allFindings.length, warnings: report.anomalies.filter(entry => entry.severity === 'warning').length,
        partialSelection: !!only || !!PLAN.disturbance, disturbance: PLAN.disturbance, sweepPlanned, sweepCompleted }, null, 2));
    atomicWalkJson(path.join(REPORT_ROOT, 'results.json'), { results, findings: allFindings });
    atomicWalkJson(path.join(REPORT_ROOT, 'progress.json'), { ...walkProgress([...observed.values()], planned.size, performance.now() - sessionStarted, fresh), status: observed.size === planned.size ? 'complete' : 'incomplete', reused });
    console.log('Navigator walk report: ' + REPORT_ROOT);
    const known = JSON.parse(fs.readFileSync(path.resolve('tests/node/synthetic/known-walk-findings.json'), 'utf8')) as Array<{ id: string }>;
    const unexplained = allFindings.filter(entry => !known.some(item => item.id === entry.id));
    assert.equal(unexplained.length, 0, unexplained.length + ' findings; full evidence: ' + REPORT_ROOT + '\n'
        + unexplained.slice(0, 20).map(entry => entry.id + ': ' + entry.summary).join('\n'));
});
