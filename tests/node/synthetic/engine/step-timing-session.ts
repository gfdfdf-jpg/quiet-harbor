import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWalkJson, assertWalkResumeIdentity, walkHash } from './walk-run-store';
import { compareTiming, measureCheckpoint, timingCheckpointMatches, TIMING_PROTOCOL, type TimingEnvironment, type TimingManifest, type TimingRow } from './step-timing';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { removeWalkDirectory, restoreWalkCheckpoint } from './walk-checkpoint';
import type { NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { workCounters } from './walk-metrics';
import { fileDigest } from './stand-baselines';
import type { QuietEvidence } from './step-timing';
import { readRouteInventory } from './walk-routes';

interface SessionConfig { output: string; manifest: TimingManifest; environment: TimingEnvironment; quiet: QuietEvidence; source: unknown; selected: string[]; baseline: TimingBaseline; workReportPath: string }
export interface TimingBaseline {
    schema_version: 1; release: string; source_commit: string | null; package_sha256: string | null; harness_sha256: string | null;
    checkpoint_manifest_sha256: string | null; environment: TimingEnvironment | null; protocol: typeof TIMING_PROTOCOL; routes: TimingRow[];
}
export interface TimingReport {
    schema_version: 1; release: string; source_commit: string; package_sha256: string; harness_sha256: string;
    checkpoint_manifest_sha256: string; environment: TimingEnvironment; protocol: typeof TIMING_PROTOCOL;
    baseline_identity: unknown; source: unknown; routes: TimingRow[]; missing_routes: string[]; complete: boolean;
    verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'UNBASELINED'; acceptable_for_baseline: boolean; progress: { done: number; total: number; eta_ms: number | null };
    quiet: QuietEvidence;
    unmapped_source_routes: string[];
    work_budgets: 'PASS' | 'FAIL' | 'INCOMPLETE';
    ci?: boolean;
}
let config: SessionConfig | undefined;
let report: TimingReport | undefined;
let started = 0;
export function configureTimingSession(value: SessionConfig): void {
    if (!value.quiet.quiet || value.quiet.duration_ms < 30_000 || value.quiet.host_cpu_percent >= 10) throw new Error('Step timing requires a completed quiet-machine preflight');
    config = value; started = performance.now();
    const source = value.source as { sourceCommit: string; packageHash: string; harnessHash: string; release: string };
    // Keep release raw manifests once, outside sampling. Re-embedding them in the growing report would make
    // the parent's progress polling compete with the resolver as accepted baselines accumulate routes.
    const baselineFile = path.join(value.output, 'baseline.json');
    const baselineIdentity = { release: value.baseline.release, source_commit: value.baseline.source_commit,
        package_sha256: value.baseline.package_sha256, artifact: 'baseline.json', sha256: '' };
    report = { schema_version: 1, release: source.release, source_commit: source.sourceCommit, package_sha256: source.packageHash,
        harness_sha256: source.harnessHash, checkpoint_manifest_sha256: walkHash(value.manifest), environment: value.environment,
        protocol: TIMING_PROTOCOL, baseline_identity: baselineIdentity, source: value.source, routes: [], missing_routes: value.selected,
        complete: false, verdict: 'INCONCLUSIVE', acceptable_for_baseline: false, quiet: value.quiet, work_budgets: 'INCOMPLETE', ci: process.env.GITHUB_ACTIONS === 'true',
        unmapped_source_routes: readRouteInventory(path.resolve('.')).points.map(point => point.id).filter(id => !value.manifest.source_routes.includes(id)),
        progress: { done: 0, total: value.selected.length, eta_ms: null } };
    const identity = { source: value.source, environment: value.environment, manifest: value.manifest, protocol: TIMING_PROTOCOL, selected: value.selected,
        baseline: value.baseline };
    const manifestFile = path.join(value.output, 'timing-identity.json');
    if (fs.existsSync(manifestFile)) {
        assertWalkResumeIdentity(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), identity);
        // Every atomically completed attempt survives, including FAIL/INCONCLUSIVE. A killed series has no record.
        report.routes = value.selected.flatMap(key => {
            try {
                const record = JSON.parse(fs.readFileSync(path.join(value.output, 'series', walkHash(key) + '.json'), 'utf8')) as { row: TimingRow; digest: string; raw_sha256: string };
                const row = record.row;
                return row.key === key && Array.isArray(row.samples_ms) && row.samples_ms.length <= 100
                    && row.samples_ms.every(sample => Number.isFinite(sample) && sample >= 0)
                    && ['PASS', 'FAIL', 'INCONCLUSIVE', 'UNBASELINED'].includes(row.verdict)
                    && record.digest === walkHash(row) && record.raw_sha256 === fileDigest(path.join(value.output, row.raw_manifest)) ? [row] : [];
            } catch { return []; }
        });
    }
    atomicWalkJson(baselineFile, value.baseline);
    baselineIdentity.sha256 = fileDigest(baselineFile);
    atomicWalkJson(manifestFile, identity);
    persist(false);
}
function persist(final: boolean): void {
    if (!config || !report) return;
    report.missing_routes = [...config.manifest.checkpoints.filter(checkpoint => !report!.routes.some(row => row.key === checkpoint.key)).map(checkpoint => checkpoint.key),
        ...report.unmapped_source_routes.map(id => 'UNBASELINED source route: ' + id)];
    const wholeManifest = config.manifest.checkpoints.every(checkpoint => config!.selected.includes(checkpoint.key));
    report.complete = final && wholeManifest && report.missing_routes.length === 0;
    if (final) {
        try {
            const work = JSON.parse(fs.readFileSync(config.workReportPath, 'utf8')) as { anomalies: Array<{ severity: string; kind: string }> };
            report.work_budgets = work.anomalies.some(anomaly => anomaly.severity === 'failure' && !anomaly.kind.startsWith('time-')) ? 'FAIL' : 'PASS';
        } catch { report.work_budgets = 'INCOMPLETE'; }
    }
    report.verdict = report.routes.some(row => row.verdict === 'FAIL') || report.work_budgets === 'FAIL' ? 'FAIL'
        : report.unmapped_source_routes.length ? 'UNBASELINED'
        : report.routes.some(row => row.verdict === 'INCONCLUSIVE') || !report.complete || report.work_budgets === 'INCOMPLETE' ? 'INCONCLUSIVE'
        : report.routes.some(row => row.verdict === 'UNBASELINED') ? 'UNBASELINED' : 'PASS';
    report.acceptable_for_baseline = report.complete && report.work_budgets === 'PASS' && report.routes.length > 0 && report.routes.every(row => row.samples_ms.length === 100
        && !row.issues.length && row.verdict !== 'FAIL');
    if (report.ci) { report.verdict = 'INCONCLUSIVE'; report.acceptable_for_baseline = false; }
    report.progress = { done: report.routes.length, total: config.selected.length,
        eta_ms: report.routes.length ? (performance.now() - started) / report.routes.length * report.missing_routes.length : null };
    atomicWalkJson(path.join(config.output, 'step-timing.json'), report);
}
export function sampleTimingCheckpoint<T extends { next_gate: string | null; status: string; commands: unknown; reason: string }>(
    root: string, scenario: string, expected: T, resolve: () => T, counters: NextStepMeasurement | null, taskId: string,
    counterPass: () => { result: T; measurement: NextStepMeasurement | null }, prior: Parameters<typeof timingCheckpointMatches>[3]): void {
    if (!config || !report) return;
    const matches = config.manifest.checkpoints.filter(checkpoint => timingCheckpointMatches(checkpoint, scenario, expected, prior) && config!.selected.includes(checkpoint.key)
        && !report!.routes.some(row => row.key === checkpoint.key));
    for (const checkpoint of matches) {
        let snapshot: string | undefined;
        let currentCounters = counters;
        if (checkpoint.history_events_added) {
            snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-timing-checkpoint-'));
            fs.cpSync(root, snapshot, { recursive: true, preserveTimestamps: true });
        }
        try {
        for (let index = 0; index < checkpoint.history_events_added; index++) appendTaskEvent(path.join(root, 'garda-agent-orchestrator'), taskId,
            'SYNTHETIC_TIMING_HISTORY', 'INFO', 'Declared history-only timing checkpoint.', { index }, { actor: 'gate' });
        if (checkpoint.history_events_added) currentCounters = counterPass().measurement;
        const row = measureCheckpoint({ checkpoint, manifest: config.manifest, root, resolve, expected, counters: currentCounters,
            identity: result => ({ next_gate: result.next_gate, status: result.status, commands: result.commands }), environment: config.environment, output: config.output });
        if (checkpoint.history_events_added && counters && currentCounters) {
            const before = workCounters({ measurement: counters } as Parameters<typeof workCounters>[0]);
            const after = workCounters({ measurement: currentCounters } as Parameters<typeof workCounters>[0]);
            const delta = Object.fromEntries(Object.keys(after).map(key => [key, after[key] - (before[key] ?? 0)]));
            const violations = Object.entries(delta).filter(([key, growth]) =>
                /^(?:subprocess:|file_probes:|file_hash:file$|payload_reads$|timeline_(?:capture|payload_read|parse|verify))/u.test(key) ? growth > 0
                : /^(?:json_parse_verified_timeline_event|visit:verified_timeline_(?:index|selected)_event|visit:timeline_cloned_event)/u.test(key)
                    && growth > checkpoint.history_events_added).map(([key, growth]) => key + ' grew by ' + growth);
            row.history_work_delta = { added_events: checkpoint.history_events_added, counters: delta, violations };
            if (violations.length) { row.verdict = 'FAIL'; row.issues.push(...violations); }
        }
        const baseline = config.baseline.routes.find(entry => entry.key === row.key);
        if (!row.issues.length && baseline) {
            const compatible = walkHash(config.environment) === walkHash(config.baseline.environment)
                && walkHash(TIMING_PROTOCOL) === walkHash(config.baseline.protocol) && report.harness_sha256 === config.baseline.harness_sha256
                && walkHash(config.manifest) === config.baseline.checkpoint_manifest_sha256
                && row.semantic_inputs_sha256 === baseline.semantic_inputs_sha256
                && walkHash(row.limits) === walkHash(baseline.limits);
            if (!compatible) { row.verdict = 'INCONCLUSIVE'; row.issues.push('Baseline environment/protocol/checkpoint/semantic identity mismatch'); }
            else if (row.median_ms !== undefined && row.p95_ms !== undefined && baseline.median_ms !== undefined && baseline.p95_ms !== undefined) {
                row.comparison = compareTiming({ median_ms: row.median_ms, p95_ms: row.p95_ms },
                    { median_ms: baseline.median_ms, p95_ms: baseline.p95_ms }, row.limits);
                row.verdict = row.comparison.verdict;
            }
        }
        atomicWalkJson(path.join(config.output, 'series', walkHash(row.key) + '.json'), { row, digest: walkHash(row), raw_sha256: fileDigest(path.join(config.output, row.raw_manifest)) });
        report.routes.push(row); persist(false);
        console.log('Timing ' + report.routes.length + '/' + config.selected.length + ' ' + row.key + ' ' + row.verdict);
        } finally {
            if (snapshot) { restoreWalkCheckpoint(snapshot, root); removeWalkDirectory(snapshot); }
        }
    }
}
export function finishTimingSession(): void { persist(true); }
