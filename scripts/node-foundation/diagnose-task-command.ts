/** Opt-in developer command recorder. Never imported by production code. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface TaskCommandOptions {
    repoRoot: string; outputDir: string; taskId: string; command: string[];
    timeoutMs?: number; cpuProfile?: boolean; echo?: boolean;
}
function inside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function realProspective(file: string): string {
    try { return fs.realpathSync.native(path.resolve(file)); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const absolute = path.resolve(file), parent = path.dirname(absolute);
        if (parent === absolute) throw error;
        return path.join(realProspective(parent), path.basename(absolute));
    }
}
function task(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)) throw new Error('Invalid task ID.');
}
function json(file: string, value: unknown): void {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
function writeAll(fd: number, bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('Output write made no progress');
        offset += written;
    }
}
function fileSha(file: string): string {
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024), fd = fs.openSync(file, 'r');
    try { let length: number; while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length)); }
    finally { fs.closeSync(fd); }
    return hash.digest('hex');
}
function observedExecutable(command: string, cwd: string): string | null {
    const hasPath = path.isAbsolute(command) || /[\\/]/u.test(command);
    const envPath = Object.entries(process.env).find(([key]) => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH')?.[1] ?? '';
    const roots = hasPath ? [''] : [...(process.platform === 'win32' ? [cwd] : []), ...envPath.split(path.delimiter).map(value => value || cwd)];
    const suffixes = process.platform === 'win32' && !path.extname(command) ? ['.exe', '.com'] : [''];
    for (const root of roots) for (const suffix of suffixes) {
        try {
            const file = hasPath ? path.resolve(cwd, command + suffix) : path.resolve(cwd, root, command + suffix);
            if (fs.statSync(file).isFile()) return fs.realpathSync.native(file);
        } catch { /* The native spawn below retains authoritative executable resolution/errors. */ }
    }
    return null;
}

export async function runTaskCommand(options: TaskCommandOptions) {
    task(options.taskId);
    if (!options.command.length || options.command.some(value => typeof value !== 'string' || value.includes('\0'))
        || !options.command[0]) throw new Error('One executable and literal argv are required.');
    const timeout = options.timeoutMs ?? 3_600_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000) throw new Error('Invalid timeout.');
    const repoRoot = fs.realpathSync.native(options.repoRoot), output = realProspective(options.outputDir);
    if (!fs.statSync(repoRoot).isDirectory() || inside(output, repoRoot)) throw new Error('Output must be outside the measured repository.');
    fs.mkdirSync(output, { recursive: true });
    if (inside(fs.realpathSync.native(output), repoRoot)) throw new Error('Output resolves inside repository.');
    const runDir = fs.mkdtempSync(path.join(output, 'command-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-'));
    if (inside(fs.realpathSync.native(runDir), repoRoot)) throw new Error('Run directory resolves inside repository.');
    const requested = [...options.command];
    const executable = requested[0], observedPath = observedExecutable(executable, repoRoot);
    const isNode = observedPath === fs.realpathSync.native(process.execPath);
    const profile = isNode && options.cpuProfile !== false ? path.join(runDir, randomUUID() + '.cpuprofile') : null;
    if (profile && requested.slice(1).some(value => /^--cpu-prof(?:$|[-=])/u.test(value)))
        throw new Error('CPU profiling is owned by this recorder; remove manual --cpu-prof options.');
    const args = [...(profile ? ['--cpu-prof', '--cpu-prof-dir=' + runDir, '--cpu-prof-name=' + path.basename(profile)] : []), ...requested.slice(1)];
    const stdoutFile = path.join(runDir, 'stdout.txt'), stderrFile = path.join(runDir, 'stderr.txt');
    const out = fs.openSync(stdoutFile, 'wx');
    let err: number;
    try { err = fs.openSync(stderrFile, 'wx'); } catch (error) { fs.closeSync(out); throw error; }
    const environment = { ...process.env, GARDA_NEXT_STEP_TIMING: '1' };
    const start = { schema_version: 1, kind: 'command', record_id: randomUUID(), task_id: options.taskId,
        started_utc: new Date().toISOString(), cwd: repoRoot, requested_command: requested, command: [executable, ...args],
        node_version: process.version, node_platform: process.platform, node_arch: process.arch,
        observed_executable_path: observedPath, stdin_mode: 'inherit',
        profile_unavailable_reason: options.cpuProfile === false ? 'disabled' : !isNode ? 'not_the_verified_recorder_node_binary' : null,
        cpu_profile: !!profile, cpu_profile_file: profile, stdout_file: stdoutFile, stderr_file: stderrFile,
        recorder_sha256: sha(fs.readFileSync(__filename)),
        environment_sha256: sha(JSON.stringify(Object.entries(environment).filter(([key]) => /^(NODE_.*|V8_.*|UV_.*|PATH|GARDA_.*)$/iu.test(key)).sort())),
        note: 'Exact command child wall, separate from navigator statistics. CPU profile covers this Node process, not its subprocesses. A started record without result.json is incomplete.' };
    let child: ReturnType<typeof spawn>;
    let processError: string | null = null, spawnErrorCode: string | null = null, spawned = false;
    let timedOut = false, terminationError: string | null = null, cancelledBySignal: string | null = null;
    let recordingError: string | null = null;
    let started: number;
    try {
        json(path.join(runDir, 'started.json'), start);
        started = performance.now();
        child = spawn(executable, args, { cwd: repoRoot, shell: false, windowsHide: true,
            detached: process.platform !== 'win32', env: environment, stdio: ['inherit', 'pipe', 'pipe'] });
    } catch (error) { fs.closeSync(out); fs.closeSync(err); throw error; }
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        let settled = false, terminating = false, terminationDeadline: NodeJS.Timeout | undefined;
        let pendingEcho = 0, closed: { code: number | null; signal: NodeJS.Signals | null } | null = null;
        const busyOutputs = new Set<Writable>();
        const finish = (code: number | null, signal: NodeJS.Signals | null, force = false) => {
            closed = { code, signal };
            if (pendingEcho && !force) return;
            if (settled) return;
            settled = true; clearTimeout(timer); clearTimeout(terminationDeadline);
            process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
            setImmediate(() => {
                process.stdout.removeListener('error', recordingFailed); process.stderr.removeListener('error', recordingFailed);
            });
            resolve({ code, signal });
        };
        const stop = (signal: 'SIGINT' | 'SIGTERM' | 'timeout' | 'recording-error') => {
            if (settled || terminating) return;
            terminating = true;
            if (signal === 'timeout') timedOut = true;
            else if (signal !== 'recording-error') cancelledBySignal = signal;
            try {
                if (closed) { /* All child stdio has closed; only echo may remain. */ }
                else if (process.platform === 'win32' && child.pid) {
                    const killed = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
                        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
                    if (killed.error || killed.status !== 0) { terminationError = killed.error?.message ?? String(killed.stderr); child.kill('SIGKILL'); }
                } else if (child.pid) process.kill(-child.pid, 'SIGKILL');
            } catch (error) {
                terminationError = String(error);
                try { child.kill('SIGKILL'); } catch (fallbackError) { terminationError += '; ' + String(fallbackError); }
            }
            for (const outputStream of busyOutputs) outputStream.destroy();
            child.stdout?.resume(); child.stderr?.resume();
            terminationDeadline = setTimeout(() => {
                terminationError = (terminationError ? terminationError + '; ' : '') + 'child close not observed after termination';
                child.stdout?.destroy(); child.stderr?.destroy();
                finish(child.exitCode, child.signalCode, true);
            }, 5000);
        };
        const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
        process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
        const timer = setTimeout(() => stop('timeout'), timeout);
        const recordingFailed = (error: unknown) => {
            recordingError ??= String(error);
            stop('recording-error');
        };
        const recordOutput = (fd: number, inputStream: Readable, outputStream: Writable, bytes: Buffer) => {
            if (recordingError) return;
            try {
                writeAll(fd, bytes);
                if (options.echo !== false && !terminating) {
                    inputStream.pause(); pendingEcho++; busyOutputs.add(outputStream);
                    try {
                        outputStream.write(bytes, error => {
                            pendingEcho--; busyOutputs.delete(outputStream);
                            if (error) recordingFailed(error);
                            if (!terminating) inputStream.resume();
                            if (closed) finish(closed.code, closed.signal);
                        });
                    } catch (error) { pendingEcho--; busyOutputs.delete(outputStream); throw error; }
                }
            } catch (error) { recordingFailed(error); }
        };
        if (options.echo !== false) {
            process.stdout.on('error', recordingFailed); process.stderr.on('error', recordingFailed);
        }
        child.on('spawn', () => { spawned = true; });
        child.stdout!.on('data', (bytes: Buffer) => recordOutput(out, child.stdout!, process.stdout, bytes));
        child.stderr!.on('data', (bytes: Buffer) => recordOutput(err, child.stderr!, process.stderr, bytes));
        child.stdout!.on('error', recordingFailed); child.stderr!.on('error', recordingFailed);
        child.on('error', error => { processError = error.message; spawnErrorCode = (error as NodeJS.ErrnoException).code ?? null; });
        child.on('close', (code, signal) => finish(code, signal));
    });
    const wall = performance.now() - started;
    fs.closeSync(out); fs.closeSync(err);
    let profileIssue: string | null = null;
    if (profile) {
        try {
            if (fs.statSync(profile).size > 64 * 1024 * 1024) throw new Error('Profile exceeds parse limit; raw retained');
            const value = JSON.parse(fs.readFileSync(profile, 'utf8')) as { nodes?: unknown[] };
            if (!Array.isArray(value.nodes) || !value.nodes.length) throw new Error('Empty CPU profile');
        } catch (error) { profileIssue = String(error); }
    }
    const record = { ...start, completed_utc: new Date().toISOString(), wall_ms: wall,
        native_exit_code: spawned ? result.code : null, raw_close_code: result.code, spawn_error_code: spawnErrorCode,
        signal: result.signal, timed_out: timedOut, cancelled_by_signal: cancelledBySignal, process_error: processError,
        termination_error: terminationError, recording_error: recordingError, profile_issue: profileIssue,
        stdout_sha256: fileSha(stdoutFile), stderr_sha256: fileSha(stderrFile) };
    json(path.join(runDir, 'result.json'), record);
    return { runDir, record, exitCode: cancelledBySignal ? (cancelledBySignal === 'SIGINT' ? 130 : 143)
        : result.code && result.code > 0 ? result.code
        : timedOut || processError || recordingError || result.signal || profileIssue || result.code === null ? 2 : 0 };
}

/** Additive installation: existing next-step recorder and historical logs are never overwritten. */
export function installTaskCommandRecorder(sessionPath: string): string {
    const session = fs.realpathSync.native(sessionPath);
    const config = JSON.parse(fs.readFileSync(path.join(session, 'session.json'), 'utf8')) as { schema_version: number; repo_root: string };
    if (config.schema_version !== 1 || typeof config.repo_root !== 'string') throw new Error('Unsupported diagnostic session.');
    const repoRoot = fs.realpathSync.native(config.repo_root);
    if (inside(session, repoRoot) || !fs.statSync(path.join(session, 'recorder.cjs')).isFile()) throw new Error('Invalid external session.');
    for (const file of ['commands.cjs', 'run.cjs']) if (fs.existsSync(path.join(session, file))) throw new Error('Recorder already installed: ' + file);
    fs.copyFileSync(__filename, path.join(session, 'commands.cjs'), fs.constants.COPYFILE_EXCL);
    const wrapper = `const path=require('node:path');\nconst [task,...args]=process.argv.slice(2);\n` +
        `(async()=>{\nif(args.length===1&&args[0]==='next-step'){\n` +
        `const result=require('node:child_process').spawnSync(process.execPath,[path.join(__dirname,'next-step.cjs'),task,'--cpu-profile'],{stdio:'inherit',windowsHide:true});\n` +
        `if(result.error)console.error(result.error.message);process.exitCode=result.status??2;\n` +
        `}else{\nif(args[0]!=='--'||args.length<2)throw new Error('Usage: node run.cjs TASK next-step | TASK -- EXECUTABLE ARGS');\n` +
        `const result=await require('./commands.cjs').runTaskCommand({repoRoot:${JSON.stringify(repoRoot)},outputDir:path.join(__dirname,'commands'),taskId:task,command:args.slice(1)});\n` +
        `console.error('Developer command diagnostics: '+result.runDir);process.exitCode=result.exitCode;\n}\n` +
        `})().catch(error=>{console.error(error.message);process.exitCode=2;});\n`;
    fs.writeFileSync(path.join(session, 'run.cjs'), wrapper, { flag: 'wx' });
    return path.join(session, 'run.cjs');
}
if (require.main === module) {
    try {
        if (process.argv.length !== 4 || process.argv[2] !== 'install-session') throw new Error('Usage: install-session SESSION');
        console.log(installTaskCommandRecorder(process.argv[3]));
    } catch (error) { console.error(String(error)); process.exitCode = 2; }
}
