import * as fs from 'node:fs';
import * as os from 'node:os';
import { observeStandOracle } from './stand-check-observation';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomicWalkJson, walkHash } from './walk-run-store';

export const TIMING_PROTOCOL = Object.freeze({ mode: 'resolver-warm', warmups: 5, samples: 100, quantile: 'nearest-rank', jobs: 1 });
export interface TimingLimits { median_relative: number; median_absolute_ms: number; p95_relative: number; p95_absolute_ms: number }
export type TimingVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'UNBASELINED';
export interface TimingCheckpoint {
    key: string; scenario: string; next_gate: string | null; status?: string; history: string; history_events_added: number; budget_reason: string;
    require_prior?: Array<{ gate: string; failed?: boolean; command_contains?: string }>; reason_contains?: string;
}
export function timingCheckpointMatches(checkpoint: TimingCheckpoint, scenario: string, result: { next_gate: string | null; status: string; reason: string },
    prior: readonly { gate: string | null; exitCode: number | null; command: string | null }[]): boolean {
    return checkpoint.scenario === scenario && checkpoint.next_gate === result.next_gate && (!checkpoint.status || checkpoint.status === result.status)
        && (!checkpoint.reason_contains || result.reason.includes(checkpoint.reason_contains))
        && (checkpoint.require_prior ?? []).every(required => prior.some(step => step.gate === required.gate
            && step.exitCode !== null
            && (required.failed === undefined || (required.failed ? step.exitCode !== null && step.exitCode !== 0 : step.exitCode === 0))
            && (!required.command_contains || step.command?.includes(required.command_contains))));
}
export interface TimingManifest {
    schema_version: 1; normalization_version: number; limits: TimingLimits; checkpoints: TimingCheckpoint[];
    advisory_writes: string[]; normalized_runtime_fields: string[]; required_families: string[];
    source_routes: string[];
}
export interface TimingEnvironment {
    machine_id: string; os: string; node: string; arch: string; cpu: string; cpu_count: number; ram_bytes: number;
    power_plan: string; defender: string; disk: string; coverage: string; compile_cache: string;
    node_options: string;
}
export interface QuietEvidence { quiet: boolean; duration_ms: number; host_cpu_percent: number; heavy_processes: string[]; reasons: string[] }
function shellProbe(script: string): string {
    try {
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script],
            { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        return output || 'unavailable';
    } catch { return 'unavailable'; }
}
export function timingEnvironment(): TimingEnvironment {
    return { machine_id: os.hostname(), os: [os.platform(), os.release(), os.version()].join('/'), node: process.version, arch: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unavailable', cpu_count: os.cpus().length, ram_bytes: os.totalmem(),
        power_plan: process.platform === 'win32' ? shellProbe('powercfg /getactivescheme') : 'unavailable',
        defender: process.platform === 'win32' ? shellProbe('Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled | ConvertTo-Json -Compress') : 'not-windows',
        disk: process.platform === 'win32' ? shellProbe('Get-PhysicalDisk | Select-Object FriendlyName,MediaType,BusType | ConvertTo-Json -Compress') : 'unavailable',
        coverage: process.env.NODE_V8_COVERAGE || process.env.NYC_CONFIG || 'off', compile_cache: process.env.NODE_COMPILE_CACHE || 'node-default',
        node_options: process.env.NODE_OPTIONS || '' };
}
export function cpuTotals(): { idle: number; total: number } {
    return os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}
export function cpuPercent(before: ReturnType<typeof cpuTotals>, after: ReturnType<typeof cpuTotals>): number {
    return after.total > before.total ? 100 * (1 - (after.idle - before.idle) / (after.total - before.total)) : 100;
}
interface ProcessSample { Id: number; ProcessName: string; CPU: number }
function processSample(): ProcessSample[] | null {
    if (process.platform !== 'win32') return null;
    try {
        const value = JSON.parse(shellProbe('Get-Process | Where-Object { $_.CPU -ne $null } | Select-Object Id,ProcessName,CPU | ConvertTo-Json -Compress')) as ProcessSample[];
        return Array.isArray(value) ? value : null;
    } catch { return null; }
}
/** A reservation is required; measured idleness alone cannot establish that another executor will stay idle. */
export async function checkQuietMachine(operatorBusy = false): Promise<QuietEvidence> {
    const start = process.hrtime.bigint(), beforeProcesses = processSample(), before = cpuTotals();
    for (let index = 0; index < 30; index++) await new Promise(resolve => setTimeout(resolve, 1000));
    const percent = cpuPercent(before, cpuTotals()), afterProcesses = processSample();
    const reasons = operatorBusy ? ['Operator reports competing work on this machine'] : [];
    if (percent >= 10) reasons.push('Average host CPU is not below 10%');
    const heavy = (afterProcesses ?? []).filter(entry => entry.Id !== process.pid && entry.ProcessName !== 'Idle'
        && entry.CPU - (beforeProcesses?.find(old => old.Id === entry.Id)?.CPU ?? 0) > 3)
        .map(entry => entry.ProcessName + ':' + entry.Id);
    if (heavy.length) reasons.push('Competing heavy processes observed');
    if (!beforeProcesses || !afterProcesses) reasons.push('Heavy-process inventory unavailable');
    if (process.env.GARDA_TIMING_MACHINE_RESERVED !== '1') reasons.push('No operator reservation (GARDA_TIMING_MACHINE_RESERVED=1)');
    return { quiet: !reasons.length, duration_ms: Number(process.hrtime.bigint() - start) / 1e6, host_cpu_percent: percent, heavy_processes: heavy, reasons };
}
export function timingDistribution(values: readonly number[]): { median_ms: number; p95_ms: number } {
    if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing samples');
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return { median_ms: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        p95_ms: sorted[Math.ceil(sorted.length * .95) - 1] };
}
export function compareTiming(candidate: { median_ms: number; p95_ms: number }, baseline: typeof candidate, limits: TimingLimits) {
    observeStandOracle('step-timing');
    const compare = (metric: 'median' | 'p95') => {
        const before = baseline[`${metric}_ms`], delta = candidate[`${metric}_ms`] - before;
        const allowed = Math.max(limits[`${metric}_absolute_ms`], limits[`${metric}_relative`] * before);
        return { baseline_ms: before, candidate_ms: candidate[`${metric}_ms`], delta_ms: delta, delta_percent: before === 0 ? null : delta / before * 100,
            allowed_growth_ms: allowed, verdict: delta > allowed ? 'FAIL' as const : 'PASS' as const };
    };
    const median = compare('median'), p95 = compare('p95');
    return { median, p95, verdict: median.verdict === 'FAIL' || p95.verdict === 'FAIL' ? 'FAIL' as const : 'PASS' as const };
}
export interface InputManifest { raw: Record<string, string>; semantic: Record<string, string> }
/** Target/source bytes are never normalized. Only declared runtime JSON fields and native Git bindings vary. */
export function checkpointInputs(root: string, manifest: TimingManifest): InputManifest {
    const raw: Record<string, string> = {}, semantic: Record<string, string> = {};
    const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const normalize = (value: unknown, key = ''): unknown => {
        if (manifest.normalized_runtime_fields.includes(key)) return '<runtime:' + key + '>';
        if (typeof value === 'string') return value.split(root).join('<fixture-root>').split(root.replace(/\\/gu, '/')).join('<fixture-root>');
        if (Array.isArray(value)) return value.map(entry => normalize(entry));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, normalize(entry, name)]));
        return value;
    };
    const visit = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name), relative = path.relative(root, file).replace(/\\/gu, '/');
            if (entry.isSymbolicLink()) throw new Error('Timing checkpoint contains symlink: ' + relative);
            const stat = fs.lstatSync(file);
            if (entry.isDirectory()) { raw[relative + '/'] = JSON.stringify({ directory: true, ino: stat.ino, mode: stat.mode }); visit(file); continue; }
            const bytes = fs.readFileSync(file);
            raw[relative] = JSON.stringify({ sha256: hash(bytes), ino: stat.ino, size: stat.size, mode: stat.mode, mtime_ms: stat.mtimeMs });
            if (relative.startsWith('.git/')) continue; // Retained raw; Git's native identities belong to the raw binding only.
            // The resolver release is an independent recorded identity, not a semantic fixture input.
            // Live configuration, project targets and runtime evidence are still compared byte-for-byte/field-for-field.
            if (relative.startsWith('garda-agent-orchestrator/') && !relative.startsWith('garda-agent-orchestrator/runtime/')
                && !relative.startsWith('garda-agent-orchestrator/live/')) continue;
            if (relative.startsWith('garda-agent-orchestrator/runtime/') && /\.(json|jsonl)$/u.test(relative)) {
                try { semantic[relative] = hash(relative.endsWith('.jsonl')
                    ? bytes.toString('utf8').trim().split('\n').map(line => JSON.stringify(normalize(JSON.parse(line)))).join('\n')
                    : JSON.stringify(normalize(JSON.parse(bytes.toString('utf8'))))); }
                catch { semantic[relative] = hash(bytes); }
            } else semantic[relative] = hash(bytes);
        }
    };
    visit(root); return { raw, semantic };
}
export function unexpectedMutations(before: InputManifest, after: InputManifest, advisory: string[]): string[] {
    return [...new Set([...Object.keys(before.raw), ...Object.keys(after.raw)])]
        .filter(file => before.raw[file] !== after.raw[file] && !advisory.includes(file));
}
export interface TimingRow {
    key: string; scenario: string; next_gate: string | null; history: string; samples_ms: number[]; median_ms?: number; p95_ms?: number;
    semantic_inputs_sha256: string; raw_inputs_manifest_sha256: string; limits: TimingLimits; budget_reason: string;
    verdict: TimingVerdict; issues: string[]; counters: unknown; comparison?: ReturnType<typeof compareTiming>; raw_manifest: string;
    history_work_delta?: { added_events: number; counters: Record<string, number>; violations: string[] };
}
/** Setup, comparison, hashing and writes are all outside the two hrtime reads surrounding each resolver call. */
export function measureCheckpoint<T>(options: { checkpoint: TimingCheckpoint; manifest: TimingManifest; root: string; resolve: () => T;
    identity: (result: T) => unknown; expected: T; counters: unknown; environment: TimingEnvironment; output: string }): TimingRow {
    const { checkpoint, manifest, root, resolve, identity, expected, environment, output } = options;
    const initial = checkpointInputs(root, manifest), issues: string[] = [], samples: number[] = [], expectedHash = walkHash(identity(expected));
    const beforeProcesses = processSample(), beforeCpu = cpuTotals(), started = performance.now();
    for (let index = -TIMING_PROTOCOL.warmups; index < TIMING_PROTOCOL.samples; index++) {
        const before = checkpointInputs(root, manifest);
        let result: T | undefined, thrown: unknown;
        const begin = process.hrtime.bigint();
        try { result = resolve(); } catch (error) { thrown = error; }
        const end = process.hrtime.bigint();
        if (index >= 0) samples.push(Number(end - begin) / 1e6);
        if (thrown) issues.push('Resolver threw: ' + String(thrown));
        if (!thrown && walkHash(identity(result!)) !== expectedHash) issues.push('Route/status/commands changed');
        const after = checkpointInputs(root, manifest);
        const mutations = unexpectedMutations(before, after, manifest.advisory_writes);
        if (mutations.length) issues.push('Checkpoint mutated: ' + mutations.join(', '));
        if (walkHash(after.semantic) !== walkHash(initial.semantic)) issues.push('Semantic inputs changed');
        if (issues.length) break; // Keep the complete invalid prefix; never discard slow samples and retry.
    }
    const cpu = cpuPercent(beforeCpu, cpuTotals());
    const afterProcesses = processSample();
    const elapsed = (performance.now() - started) / 1000;
    const heavy = (afterProcesses ?? []).filter(entry => entry.Id !== process.pid && entry.ProcessName !== 'Idle'
        && entry.CPU - (beforeProcesses?.find(old => old.Id === entry.Id)?.CPU ?? 0) > Math.max(1, elapsed * .1));
    if (heavy.length) issues.push('Competing heavy processes during route: ' + heavy.map(entry => entry.ProcessName + ':' + entry.Id).join(', '));
    if (!beforeProcesses || !afterProcesses) issues.push('Heavy-process inventory unavailable during route');
    const power = process.platform === 'win32' ? shellProbe('powercfg /getactivescheme') : 'unavailable';
    if (cpu >= 10) issues.push('Host CPU during route >=10%: ' + cpu);
    if (power !== environment.power_plan) issues.push('Power plan changed');
    if (samples.length !== 100) issues.push('Incomplete series');
    const rawFile = path.join(output, 'raw', walkHash(checkpoint.key) + '.json');
    atomicWalkJson(rawFile, { ...initial, normalization_version: manifest.normalization_version, host_cpu_percent: cpu,
        elapsed_ms: performance.now() - started, output_identity: identity(expected), samples_ms: samples });
    return { ...checkpoint, samples_ms: samples, ...(samples.length ? timingDistribution(samples) : {}),
        semantic_inputs_sha256: walkHash(initial.semantic), raw_inputs_manifest_sha256: walkHash(initial.raw),
        limits: manifest.limits, verdict: issues.length ? 'INCONCLUSIVE' : 'UNBASELINED', issues, counters: options.counters,
        raw_manifest: path.relative(output, rawFile).replace(/\\/gu, '/') };
}
