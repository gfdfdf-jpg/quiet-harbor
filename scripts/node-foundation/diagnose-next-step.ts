/** Developer-only external recorder. Never imported by the shipped runtime. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const MARKER = 'GARDA_NEXT_STEP_TIMING ';
const MAX_DIAGNOSTIC_BYTES = 64 * 1024 * 1024;
export interface DiagnosticOptions {
    repoRoot: string; taskId: string; outputDir: string; launcher?: string;
    label?: string; repeat?: number; timeoutMs?: number; cpuProfile?: boolean;
}
export interface DiagnosticRecord {
    schema_version: 1; record_id: string; index: number; task_id: string; label: string; started_utc: string;
    command: string[]; cwd: string; node_version: string; node_executable: string; node_platform: string; node_arch: string; node_options_present: boolean;
    cpu_profile: boolean; wall_ms: number; core_ms: number | null; outside_core_ms: number | null;
    native_exit_code: number | null; signal: string | null; process_error: string | null; timed_out: boolean;
    next_gate: string | null; status: string | null; review_lane: string | null;
    timing: Record<string, unknown> | null; issues: string[];
    runtime_descriptor_before: Record<string, string>; runtime_descriptor_after: Record<string, string>;
    runtime_descriptor_sha256: string; runtime_selection: 'not_observed'; navigator_state_sha256: string | null;
    environment_sha256: string; runner_sha256: string;
    stdout_file: string; stderr_file: string; cpu_profile_file: string | null;
}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function contained(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
/** Resolve existing ancestors too, so a junction cannot redirect the output into the project. */
function prospectiveRealPath(value: string): string {
    const absolute = path.resolve(value);
    try { return fs.realpathSync.native(absolute); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(absolute);
        if (parent === absolute) throw error;
        return path.join(prospectiveRealPath(parent), path.basename(absolute));
    }
}
function boundedInteger(value: number, maximum: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}.`);
    return value;
}
function runtimeDescriptor(launcher: string): Record<string, string> {
    const root = path.dirname(path.dirname(launcher));
    const files = [launcher, path.join(root, 'package.json'),
        ...['dist', '.node-build'].flatMap(build => [path.join(root, build, 'publish-runtime-manifest.json'),
            path.join(root, build, 'node-foundation-manifest.json'), path.join(root, build, 'src/gates/next-step/index.js'),
            path.join(root, build, 'src/core/next-step-measurement.js')])];
    const support = path.join(path.dirname(launcher), 'garda');
    if (fs.existsSync(support)) {
        for (const item of fs.readdirSync(support, { withFileTypes: true }))
            if (item.isFile() && item.name.endsWith('.js')) files.push(path.join(support, item.name));
    }
    return Object.fromEntries(files.map(file => {
        try { return [file, digest(fs.readFileSync(file))]; }
        catch (error) { return [file, 'unavailable:' + (error as NodeJS.ErrnoException).code]; }
    }));
}
function readDiagnosticText(file: string): string {
    if (fs.statSync(file).size > MAX_DIAGNOSTIC_BYTES) throw new Error('Diagnostic output exceeds parse limit; raw file retained.');
    return fs.readFileSync(file, 'utf8');
}
export function parseTiming(text: string): { timing: Record<string, unknown> | null; issue?: string } {
    const lines = text.split(/\r?\n/u).filter(line => line.startsWith(MARKER));
    if (lines.length !== 1) return { timing: null, issue: lines.length ? 'multiple_timing_records' : 'missing_timing_record' };
    try {
        const value: unknown = JSON.parse(lines[0].slice(MARKER.length));
        if (!record(value) || !record(value.phases_ms) || !record(value.work)
            || typeof value.phases_ms.total !== 'number' || !Number.isFinite(value.phases_ms.total)
            || value.phases_ms.total < 0
            || [...Object.values(value.phases_ms), ...Object.values(value.work)].some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error('invalid timing');
        return { timing: value };
    } catch { return { timing: null, issue: 'malformed_timing_record' }; }
}
function writeJson(file: string, value: unknown): void { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }

export function runDiagnostics(options: DiagnosticOptions): { runDir: string; records: DiagnosticRecord[]; exitCode: number } {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(options.taskId)) throw new Error('Invalid task ID.');
    const repeat = boundedInteger(options.repeat ?? 1, 100, 'repeat');
    const timeout = boundedInteger(options.timeoutMs ?? 120_000, 3_600_000, 'timeout-ms');
    const repoRoot = fs.realpathSync.native(path.resolve(options.repoRoot));
    if (!fs.statSync(repoRoot).isDirectory()) throw new Error('Repository root is not a directory.');
    const outputDir = prospectiveRealPath(options.outputDir);
    if (contained(outputDir, repoRoot)) throw new Error('Output must be outside the measured repository.');
    const launcher = fs.realpathSync.native(path.resolve(options.launcher ?? path.join(repoRoot, 'garda-agent-orchestrator/bin/garda.js')));
    if (!fs.statSync(launcher).isFile()) throw new Error('Launcher is not a file.');
    fs.mkdirSync(outputDir, { recursive: true });
    if (contained(fs.realpathSync.native(outputDir), repoRoot)) throw new Error('Output resolves inside measured repository.');
    const runDir = fs.mkdtempSync(path.join(outputDir, 'next-step-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-'));
    if (contained(fs.realpathSync.native(runDir), repoRoot)) throw new Error('Run directory resolves inside measured repository.');
    const records: DiagnosticRecord[] = [];
    writeJson(path.join(runDir, 'run.json'), { schema_version: 1, task_id: options.taskId, repo_root: repoRoot,
        label: options.label ?? '', repeat, cpu_profile: !!options.cpuProfile, launcher,
        note: 'wall measures one child process only; outside_core includes startup, shutdown and other uninstrumented time; phases can overlap; runtime descriptor is not full bundle authentication' });
    let exitCode = 0;
    for (let index = 1; index <= repeat; index++) {
        const stem = 'call-' + String(index).padStart(4, '0');
        const stdoutFile = path.join(runDir, stem + '.stdout.txt'), stderrFile = path.join(runDir, stem + '.stderr.txt');
        const profile = options.cpuProfile ? stem + '-' + randomUUID() + '.cpuprofile' : null;
        const args = [...(profile ? ['--cpu-prof', '--cpu-prof-dir=' + runDir, '--cpu-prof-name=' + profile] : []),
            launcher, 'next-step', options.taskId, '--repo-root', repoRoot, '--as-json'];
        const runtimeBefore = runtimeDescriptor(launcher);
        const out = fs.openSync(stdoutFile, 'wx');
        let err: number;
        try { err = fs.openSync(stderrFile, 'wx'); }
        catch (error) { fs.closeSync(out); throw error; }
        const startedUtc = new Date().toISOString(), started = performance.now();
        let child: ReturnType<typeof spawnSync>;
        let wall: number;
        const childEnvironment = { ...process.env, GARDA_NEXT_STEP_TIMING: '1' };
        try {
            child = spawnSync(process.execPath, args, { cwd: repoRoot, shell: false, windowsHide: true,
                env: childEnvironment, stdio: ['ignore', out, err], timeout, killSignal: 'SIGKILL' });
            wall = performance.now() - started;
        } finally { fs.closeSync(out); fs.closeSync(err); }
        const runtimeAfter = runtimeDescriptor(launcher), issues: string[] = [];
        if (JSON.stringify(runtimeBefore) !== JSON.stringify(runtimeAfter)) issues.push('runtime_descriptor_changed');
        let timing: Record<string, unknown> | null = null, nextGate: string | null = null;
        let status: string | null = null, reviewLane: string | null = null, stateSha256: string | null = null;
        try {
            const parsed = parseTiming(readDiagnosticText(stderrFile)); timing = parsed.timing;
            if (parsed.issue) issues.push(parsed.issue);
        } catch { issues.push('stderr_unparseable_raw_retained'); }
        try {
            const result: unknown = JSON.parse(readDiagnosticText(stdoutFile));
            if (!record(result) || result.task_id !== options.taskId || typeof result.status !== 'string'
                || !(result.next_gate === null || typeof result.next_gate === 'string')) throw new Error('Invalid result');
            nextGate = result.next_gate; status = result.status;
            const stable = { ...result }; delete stable.generated_utc;
            stateSha256 = digest(JSON.stringify(stable));
            if (record(result.review) && typeof result.review.next_review_type === 'string') reviewLane = result.review.next_review_type;
        } catch { issues.push('navigator_output_unparseable_or_task_mismatch'); }
        const core = timing ? (timing.phases_ms as Record<string, number>).total : null;
        if (core !== null && core > wall) issues.push('core_exceeds_process_wall');
        if (profile) {
            try {
                const captured: unknown = JSON.parse(readDiagnosticText(path.join(runDir, profile)));
                if (!record(captured) || !Array.isArray(captured.nodes) || !captured.nodes.length) throw new Error('Empty profile');
            } catch { issues.push('cpu_profile_missing_or_incomplete'); }
        }
        if (child.error) issues.push('child_process_error');
        const sample: DiagnosticRecord = { schema_version: 1, record_id: randomUUID(), index, task_id: options.taskId,
            label: options.label ?? '', started_utc: startedUtc, command: [process.execPath, ...args], cwd: repoRoot,
            node_version: process.version, node_executable: fs.realpathSync.native(process.execPath), node_platform: process.platform,
            node_arch: process.arch, node_options_present: !!process.env.NODE_OPTIONS,
            cpu_profile: !!profile, wall_ms: wall, core_ms: core, outside_core_ms: core === null ? null : wall - core,
            native_exit_code: child.status, signal: child.signal, process_error: child.error?.message ?? null,
            timed_out: (child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
            next_gate: nextGate, status, review_lane: reviewLane, timing, issues,
            runtime_descriptor_before: runtimeBefore, runtime_descriptor_after: runtimeAfter,
            runtime_descriptor_sha256: digest(JSON.stringify(runtimeBefore)), runtime_selection: 'not_observed', navigator_state_sha256: stateSha256,
            environment_sha256: digest(JSON.stringify(Object.entries(childEnvironment).filter(([key]) =>
                /^(NODE_.*|V8_.*|UV_.*|PATH|GARDA_.*)$/iu.test(key)).sort(([a],[b]) => a.localeCompare(b)))),
            runner_sha256: digest(fs.readFileSync(__filename)), stdout_file: stdoutFile, stderr_file: stderrFile,
            cpu_profile_file: profile ? path.join(runDir, profile) : null };
        records.push(sample); writeJson(path.join(runDir, stem + '.json'), sample);
        if (child.status !== 0 || issues.length) { exitCode = child.status && child.status > 0 ? child.status : 2; break; }
    }
    writeJson(path.join(runDir, 'summary.json'), summarizeDiagnostics(records));
    return { runDir, records, exitCode };
}

function statistics(values: number[]) {
    const sorted = [...values].sort((a,b) => a-b), n = sorted.length;
    return { count: n, mean_ms: sorted.reduce((sum, value) => sum + value, 0) / n,
        median_ms: (sorted[Math.floor((n-1)/2)] + sorted[Math.ceil((n-1)/2)]) / 2,
        p95_ms: sorted[Math.ceil(n * 0.95) - 1], min_ms: sorted[0], max_ms: sorted[n-1] };
}
function sampleIssues(sample: DiagnosticRecord): string[] {
    const issues = [...sample.issues];
    if (sample.native_exit_code !== 0) issues.push('native_command_failed');
    if (sample.signal || sample.process_error || sample.timed_out) issues.push('incomplete_process');
    if (sample.core_ms === null) issues.push('missing_core');
    if (!Number.isFinite(sample.wall_ms) || sample.wall_ms < 0
        || sample.core_ms !== null && (!Number.isFinite(sample.core_ms) || sample.core_ms < 0)) issues.push('invalid_durations');
    if (sample.core_ms !== null && sample.core_ms > sample.wall_ms) issues.push('core_exceeds_process_wall');
    if (!sample.navigator_state_sha256 || !sample.status || !(sample.next_gate === null || typeof sample.next_gate === 'string'))
        issues.push('missing_navigator_state');
    return [...new Set(issues)];
}
export function summarizeDiagnostics(samples: DiagnosticRecord[]) {
    const seen = new Set<string>();
    const suppliedCount = samples.length;
    samples = samples.filter(sample => { if (seen.has(sample.record_id)) return false; seen.add(sample.record_id); return true; });
    const groups = new Map<string, DiagnosticRecord[]>();
    const rejected = samples.filter(sample => sampleIssues(sample).length > 0);
    for (const sample of samples) {
        if (rejected.includes(sample)) continue;
        const key = JSON.stringify([sample.cwd, sample.task_id, sample.label, sample.next_gate, sample.status,
            sample.review_lane, sample.runtime_descriptor_sha256, sample.node_version, sample.node_executable, sample.node_platform, sample.node_arch, sample.cpu_profile,
            sample.environment_sha256, sample.runner_sha256, sample.navigator_state_sha256]);
        const group = groups.get(key) ?? []; group.push(sample); groups.set(key, group);
    }
    return { schema_version: 1, recorded_count: samples.length, duplicate_count: suppliedCount - samples.length, rejected_count: rejected.length,
        rejected: rejected.map(sample => ({ file: sample.stdout_file, native_exit_code: sample.native_exit_code, issues: sampleIssues(sample) })),
        groups: [...groups.values()].map(group => ({ task_id: group[0].task_id, label: group[0].label,
            next_gate: group[0].next_gate, status: group[0].status, review_lane: group[0].review_lane,
            runtime_descriptor_sha256: group[0].runtime_descriptor_sha256, cpu_profile: group[0].cpu_profile,
            repo_root: group[0].cwd, node_version: group[0].node_version, node_executable: group[0].node_executable,
            node_platform: group[0].node_platform, node_arch: group[0].node_arch, navigator_state_sha256: group[0].navigator_state_sha256,
            first_wall_ms: group[0].wall_ms, wall: statistics(group.map(sample => sample.wall_ms)),
            core: statistics(group.map(sample => sample.core_ms!)) })) };
}

export function createDiagnosticSession(options: Omit<DiagnosticOptions, 'taskId'>): string {
    const repoRoot = fs.realpathSync.native(path.resolve(options.repoRoot)), output = prospectiveRealPath(options.outputDir);
    if (!fs.statSync(repoRoot).isDirectory()) throw new Error('Repository root is not a directory.');
    if (contained(output, repoRoot)) throw new Error('Session output must be outside the measured repository.');
    fs.mkdirSync(output, { recursive: true });
    const session = fs.mkdtempSync(path.join(fs.realpathSync.native(output), 'garda-debug-session-'));
    if (contained(fs.realpathSync.native(session), repoRoot)) throw new Error('Session resolves inside measured repository.');
    // Standalone compiled recorder uses only Node builtins. The live agent need not rebuild our worktree.
    fs.copyFileSync(__filename, path.join(session, 'recorder.cjs'), fs.constants.COPYFILE_EXCL);
    const base = ['--repo-root', repoRoot, '--output-dir', path.join(session, 'runs'),
        ...(options.launcher ? ['--launcher', path.resolve(options.launcher)] : []),
        ...(options.label ? ['--label', options.label] : []),
        ...(options.timeoutMs ? ['--timeout-ms', String(options.timeoutMs)] : [])];
    fs.writeFileSync(path.join(session, 'next-step.cjs'), `const { diagnosticMain } = require('./recorder.cjs');\ntry {\n` +
        ` const [task, ...extra] = process.argv.slice(2);\n` +
        ` if (!task || extra.some(value => value !== '--cpu-profile') || extra.length > 1) throw new Error('Usage: node next-step.cjs TASK [--cpu-profile]');\n` +
        ` process.exitCode = diagnosticMain([...${JSON.stringify(base)}, '--task-id', task, ...extra]);\n` +
        `} catch (error) { console.error(error.message); process.exitCode = 2; }\n`, { flag: 'wx' });
    writeJson(path.join(session, 'session.json'), { schema_version: 1, repo_root: repoRoot,
        created_utc: new Date().toISOString(), recorder_sha256: digest(fs.readFileSync(__filename)),
        runs: 'runs', note: 'Opt-in developer session; no project file or default launcher was modified.' });
    return session;
}

export function readDiagnosticRecords(input: string): DiagnosticRecord[] {
    const root = fs.realpathSync.native(input), samples: DiagnosticRecord[] = [];
    const runs = fs.existsSync(path.join(root, 'session.json')) ? path.join(root, 'runs') : root;
    if (!fs.existsSync(runs)) return [];
    const directories = fs.existsSync(path.join(runs, 'run.json')) ? [runs] : fs.readdirSync(runs, { withFileTypes: true })
        .filter(item => item.isDirectory() && item.name.startsWith('next-step-')).map(item => path.join(runs, item.name));
    for (const directory of directories) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!item.isFile() || !/^call-\d+\.json$/u.test(item.name)) continue;
            if (samples.length >= 10_000) throw new Error('Summary exceeds 10000 samples.');
            const value: unknown = JSON.parse(readDiagnosticText(path.join(directory, item.name)));
            if (!record(value) || value.schema_version !== 1 || typeof value.record_id !== 'string'
                || !['started_utc', 'label', 'node_version', 'node_executable', 'node_platform', 'node_arch', 'environment_sha256', 'runner_sha256', 'stdout_file'].every(key => typeof value[key] === 'string')
                || !Array.isArray(value.issues) || value.issues.some(issue => typeof issue !== 'string')
                || typeof value.wall_ms !== 'number' || !Number.isFinite(value.wall_ms) || value.wall_ms < 0
                || !(value.core_ms === null || typeof value.core_ms === 'number' && Number.isFinite(value.core_ms) && value.core_ms >= 0)
                || typeof value.cpu_profile !== 'boolean' || typeof value.task_id !== 'string'
                || typeof value.cwd !== 'string' || typeof value.runtime_descriptor_sha256 !== 'string'
                || typeof value.timed_out !== 'boolean' || !['signal', 'process_error', 'status', 'next_gate', 'review_lane'].every(key => value[key] === null || typeof value[key] === 'string')
                || !(value.native_exit_code === null || typeof value.native_exit_code === 'number' && Number.isSafeInteger(value.native_exit_code) && value.native_exit_code >= 0)
                || !(value.navigator_state_sha256 === null || typeof value.navigator_state_sha256 === 'string'))
                throw new Error('Invalid diagnostic record: ' + path.join(directory, item.name));
            const sample = value as unknown as DiagnosticRecord;
            sample.issues = sampleIssues(sample);
            samples.push(sample);
        }
    }
    return samples.sort((a,b) => a.started_utc.localeCompare(b.started_utc) || a.index - b.index);
}

export function diagnosticMain(args: string[]): number {
    if (args[0] === 'summarize') {
        if (args.length < 3 || args.length % 2 !== 1) throw new Error('Usage: summarize --input SESSION_OR_RUN [--input OTHER]');
        const samples: DiagnosticRecord[] = [];
        for (let i = 1; i < args.length; i += 2) {
            if (args[i] !== '--input') throw new Error('Only --input is accepted by summarize.');
            samples.push(...readDiagnosticRecords(args[i+1]));
        }
        console.log(JSON.stringify(summarizeDiagnostics(samples), null, 2)); return 0;
    }
    const sessionMode = args[0] === 'init-session';
    if (sessionMode) args = args.slice(1);
    const values = new Map<string, string>(); let cpuProfile = false;
    if (args.includes('--help')) {
        console.log('Developer-only: [init-session] --repo-root PATH [--task-id ID] --output-dir OUTSIDE_REPO [--launcher FILE] [--label TEXT] [--repeat 1..100] [--timeout-ms N] [--cpu-profile]\nRead retained logs: summarize --input SESSION_OR_RUN [--input OTHER]');
        return 0;
    }
    for (let i = 0; i < args.length; i++) {
        const name = args[i];
        if (name === '--cpu-profile' && !cpuProfile) { cpuProfile = true; continue; }
        if (!['--repo-root', '--task-id', '--output-dir', '--launcher', '--label', '--repeat', '--timeout-ms'].includes(name)
            || values.has(name) || args[i+1] === undefined || args[i+1].startsWith('--')) throw new Error('Unknown, duplicate or incomplete option: ' + name);
        values.set(name, args[++i]);
    }
    for (const name of ['--repo-root', ...(sessionMode ? [] : ['--task-id']), '--output-dir']) if (!values.get(name)) throw new Error('Required option: ' + name);
    if (sessionMode) {
        if (cpuProfile || values.has('--repeat') || values.has('--task-id')) throw new Error('Session task/profile/repeat must be selected at invocation time.');
        console.log(createDiagnosticSession({ repoRoot: values.get('--repo-root')!, outputDir: values.get('--output-dir')!,
            launcher: values.get('--launcher'), label: values.get('--label'),
            timeoutMs: values.has('--timeout-ms') ? boundedInteger(Number(values.get('--timeout-ms')), 3_600_000, 'timeout-ms') : undefined }));
        return 0;
    }
    const result = runDiagnostics({ repoRoot: values.get('--repo-root')!, taskId: values.get('--task-id')!,
        outputDir: values.get('--output-dir')!, launcher: values.get('--launcher'), label: values.get('--label'),
        repeat: values.has('--repeat') ? Number(values.get('--repeat')) : undefined,
        timeoutMs: values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : undefined, cpuProfile });
    const last = result.records.at(-1);
    if (last) process.stdout.write(readDiagnosticText(last.stdout_file));
    console.error('Developer next-step diagnostics: ' + result.runDir);
    return result.exitCode;
}
if (require.main === module) {
    try { process.exitCode = diagnosticMain(process.argv.slice(2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
