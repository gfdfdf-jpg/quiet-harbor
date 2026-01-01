import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createDiagnosticSession } from '../../../scripts/node-foundation/diagnose-next-step';
import { installTaskCommandRecorder, runTaskCommand } from '../../../scripts/node-foundation/diagnose-task-command';
import { getRepoRoot } from '../../../scripts/node-foundation/build';

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-command-diagnostics-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repoRoot = path.join(root, 'repo with spaces'), outputDir = path.join(root, 'logs');
    fs.mkdirSync(repoRoot); fs.writeFileSync(path.join(repoRoot, 'sentinel.txt'), 'untouched');
    return { root, repoRoot, outputDir, taskId: 'T-COMMAND', echo: false, timeoutMs: 5000 };
}

test('records failed native commands with exact JSON argv, raw stdout/stderr and a real CPU profile', async t => {
    const f = fixture(t), value = '{"code":true,"path":"space & literal"}';
    const script = 'process.stdout.write(process.argv[1]);process.stderr.write("native gate rejected input\\n");process.exitCode=7;';
    const result = await runTaskCommand({ ...f, command: [process.execPath, '-e', script, value] });
    assert.equal(result.exitCode, 7); assert.equal(result.record.native_exit_code, 7);
    assert.equal(fs.readFileSync(result.record.stdout_file, 'utf8'), value);
    assert.equal(fs.readFileSync(result.record.stderr_file, 'utf8'), 'native gate rejected input\n');
    assert.equal(result.record.profile_issue, null); assert.equal(result.record.cpu_profile, true);
    assert.ok(JSON.parse(fs.readFileSync(result.record.cpu_profile_file!, 'utf8')).nodes.length);
    assert.deepEqual(result.record.requested_command, [process.execPath, '-e', script, value]);
    assert.ok(result.record.wall_ms > 0);
    assert.equal(fs.readFileSync(path.join(f.repoRoot, 'sentinel.txt'), 'utf8'), 'untouched');
    assert.deepEqual(fs.readdirSync(f.repoRoot), ['sentinel.txt']);
});

test('successful commands without profiling and missing executables retain their actual outcomes', async t => {
    const f = fixture(t);
    const good = await runTaskCommand({ ...f, cpuProfile: false, command: ['node', '-e', 'console.log("ok")'] });
    assert.equal(good.exitCode, 0); assert.equal(good.record.cpu_profile, false);
    const missing = await runTaskCommand({ ...f, command: [path.join(f.root, 'missing.exe')] });
    assert.equal(missing.exitCode, 2); assert.equal(missing.record.native_exit_code, null);
    assert.ok(missing.record.process_error); assert.equal(missing.record.cpu_profile, false);
    assert.ok(fs.existsSync(path.join(missing.runDir, 'started.json')));
    assert.ok(fs.existsSync(path.join(missing.runDir, 'result.json')));
});

test('timeout retains partial gate output and never labels the command successful', async t => {
    const f = fixture(t);
    const result = await runTaskCommand({ ...f, timeoutMs: 500, command: ['node', '-e',
        'process.stdout.write("started\\n");setInterval(()=>{},1000);'] });
    assert.equal(result.record.timed_out, true); assert.notEqual(result.exitCode, 0);
    assert.match(fs.readFileSync(result.record.stdout_file, 'utf8'), /started/u);
    assert.ok(result.record.wall_ms < 10000);
});

test('command logs cannot be redirected into the target project through an output junction', async t => {
    const f = fixture(t), alias = path.join(f.root, 'linked-output');
    fs.symlinkSync(f.repoRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(runTaskCommand({ ...f, outputDir: path.join(alias, 'new'), command: ['node', '-e', 'throw new Error("must not run")'] }), /outside/u);
    assert.deepEqual(fs.readdirSync(f.repoRoot), ['sentinel.txt']);
});

test('additive unified session wrapper keeps prior logs and routes navigator and gate records separately', t => {
    const f = fixture(t), launcher = path.join(f.repoRoot, 'garda-agent-orchestrator/bin/garda.js');
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, 'console.log(JSON.stringify({task_id:process.argv[3],status:"READY",next_gate:"quality-checklist"}));'
        + 'console.error(\'GARDA_NEXT_STEP_TIMING {"phases_ms":{"total":1},"work":{}}\');');
    const session = createDiagnosticSession(f), originalRecorder = fs.readFileSync(path.join(session, 'recorder.cjs'));
    fs.writeFileSync(path.join(session, 'old.log'), 'prior evidence');
    const wrapper = installTaskCommandRecorder(session);
    const nav = spawnSync(process.execPath, [wrapper, f.taskId, 'next-step'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(nav.status, 0, nav.stderr);
    const gate = spawnSync(process.execPath, [wrapper, f.taskId, '--', 'node', '-e', 'console.error("failed gate");process.exitCode=9'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(gate.status, 9, gate.stderr); assert.match(gate.stderr, /failed gate/u);
    assert.equal(fs.readdirSync(path.join(session, 'runs')).length, 1);
    assert.equal(fs.readdirSync(path.join(session, 'commands')).length, 1);
    assert.deepEqual(fs.readFileSync(path.join(session, 'recorder.cjs')), originalRecorder);
    assert.equal(fs.readFileSync(path.join(session, 'old.log'), 'utf8'), 'prior evidence');
    assert.throws(() => installTaskCommandRecorder(session), /already installed/u);
    const navDir = fs.readdirSync(path.join(session, 'runs'))[0];
    assert.equal(JSON.parse(fs.readFileSync(path.join(session, 'runs', navDir, 'call-0001.json'), 'utf8')).cpu_profile, true);
});

test('full task diagnostic runner cannot enter the production compilation or package allowlist', () => {
    const root = getRepoRoot();
    const files = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { files: string[] }).files;
    const include = (JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.build.json'), 'utf8')) as { include: string[] }).include;
    for (const file of ['scripts/node-foundation/diagnose-task-command.ts', '.scripts-build/scripts/node-foundation/diagnose-task-command.js',
        'tests/node/core/developer-task-command-diagnostics.test.ts']) {
        for (const entry of files) assert.ok(!path.posix.matchesGlob(file, entry) && !file.startsWith(entry.replace(/\/$/u, '') + '/'));
        for (const entry of include) assert.ok(!path.posix.matchesGlob(file, entry));
    }
});

test('unified command wrapper inherits piped stdin instead of silently discarding it', t => {
    const f = fixture(t), session = createDiagnosticSession(f), wrapper = installTaskCommandRecorder(session);
    const result = spawnSync(process.execPath, [wrapper, f.taskId, '--', process.execPath, '-'], {
        encoding: 'utf8', input: 'process.stdout.write("executed stdin")', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'executed stdin');
    const dir = fs.readdirSync(path.join(session, 'commands'))[0];
    const record = JSON.parse(fs.readFileSync(path.join(session, 'commands', dir, 'result.json'), 'utf8'));
    assert.equal(record.stdin_mode, 'inherit');
    assert.equal(fs.readFileSync(record.stdout_file, 'utf8'), 'executed stdin');
});

test('PATH-selected Node remains the requested interpreter rather than the recorder interpreter', t => {
    const f = fixture(t), session = createDiagnosticSession(f), wrapper = installTaskCommandRecorder(session);
    const alternate = path.join(f.root, 'alternate'), binary = path.join(alternate, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.mkdirSync(alternate); fs.copyFileSync(process.execPath, binary); fs.chmodSync(binary, 0o755);
    const env = { ...process.env };
    const key = Object.keys(env).find(name => process.platform === 'win32' ? name.toLowerCase() === 'path' : name === 'PATH') ?? 'PATH';
    env[key] = alternate + path.delimiter + (env[key] ?? '');
    const result = spawnSync(process.execPath, [wrapper, f.taskId, '--', 'node', '-e', 'process.stdout.write(process.execPath)'], {
        cwd: f.repoRoot, env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.realpathSync.native(result.stdout), fs.realpathSync.native(binary));
    const dir = fs.readdirSync(path.join(session, 'commands'))[0];
    const record = JSON.parse(fs.readFileSync(path.join(session, 'commands', dir, 'result.json'), 'utf8'));
    assert.equal(record.requested_command[0], 'node'); assert.equal(record.command[0], 'node');
    assert.equal(record.cpu_profile, false);
    assert.equal(record.profile_unavailable_reason, 'not_the_verified_recorder_node_binary');
});

test('relative PATH is interpreted from the command cwd rather than the recorder cwd', t => {
    const f = fixture(t), session = createDiagnosticSession(f), wrapper = installTaskCommandRecorder(session);
    const parentCwd = path.join(f.root, 'caller'), childBin = path.join(f.repoRoot, 'bin');
    fs.mkdirSync(parentCwd); fs.mkdirSync(childBin);
    fs.symlinkSync(path.dirname(process.execPath), path.join(parentCwd, 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
    const binary = path.join(childBin, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.copyFileSync(process.execPath, binary); fs.chmodSync(binary, 0o755);
    const env = { ...process.env };
    const key = Object.keys(env).find(name => process.platform === 'win32' ? name.toLowerCase() === 'path' : name === 'PATH') ?? 'PATH';
    env[key] = 'bin';
    const result = spawnSync(process.execPath, [wrapper, f.taskId, '--', 'node', '-e', 'process.stdout.write(process.execPath)'], {
        cwd: parentCwd, env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.realpathSync.native(result.stdout), fs.realpathSync.native(binary));
    const dir = fs.readdirSync(path.join(session, 'commands'))[0];
    const record = JSON.parse(fs.readFileSync(path.join(session, 'commands', dir, 'result.json'), 'utf8'));
    assert.equal(record.observed_executable_path, fs.realpathSync.native(binary));
    assert.equal(record.cpu_profile, false);
});

test('short writes are retried until every raw output byte is retained', async t => {
    const f = fixture(t), nativeFs = require('node:fs') as typeof fs, original = nativeFs.writeSync;
    nativeFs.writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => {
        if (Buffer.isBuffer(buffer) && typeof offset === 'number' && typeof length === 'number')
            return original(fd, buffer, offset, Math.min(length, 3));
        return original(fd, buffer);
    }) as typeof fs.writeSync;
    try {
        const result = await runTaskCommand({ ...f, cpuProfile: false, command: [process.execPath, '-e', 'process.stdout.write("many bytes after a short write")'] });
        assert.equal(result.exitCode, 0);
        assert.equal(fs.readFileSync(result.record.stdout_file, 'utf8'), 'many bytes after a short write');
    } finally { nativeFs.writeSync = original; }
});

test('slow output consumers do not turn normal backpressure into command failure', { timeout: 15000 }, async t => {
    const f = fixture(t), session = createDiagnosticSession(f), wrapper = installTaskCommandRecorder(session);
    const size = 4 * 1024 * 1024;
    const child = spawn(process.execPath, [wrapper, f.taskId, '--', process.execPath, '-e', `process.stdout.write(Buffer.alloc(${size},120))`], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let bytes = 0, error = '';
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
    child.stdout.pause();
    const closed = new Promise<number | null>(resolve => child.on('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 250));
    child.stdout.resume();
    assert.equal(await closed, 0, error); assert.equal(bytes, size);
    const dir = fs.readdirSync(path.join(session, 'commands'))[0];
    const record = JSON.parse(fs.readFileSync(path.join(session, 'commands', dir, 'result.json'), 'utf8'));
    assert.equal(record.recording_error, null); assert.equal(fs.statSync(record.stdout_file).size, size);
});

test('closed output pipe becomes a recorded failure and stops the running command', { timeout: 15000 }, async t => {
    const f = fixture(t), session = createDiagnosticSession(f), wrapper = installTaskCommandRecorder(session);
    const heartbeat = path.join(f.root, 'pipe-heartbeat');
    const script = 'setInterval(()=>{require("node:fs").appendFileSync(process.argv[1],"x");process.stdout.write(Buffer.alloc(65536,120))},25)';
    const child = spawn(process.execPath, [wrapper, f.taskId, '--', process.execPath, '-e', script, heartbeat], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    child.stderr.resume();
    const closed = new Promise<number | null>(resolve => child.on('close', resolve));
    child.stdout.once('data', () => child.stdout.destroy());
    assert.notEqual(await closed, 0);
    const dir = fs.readdirSync(path.join(session, 'commands'))[0];
    const record = JSON.parse(fs.readFileSync(path.join(session, 'commands', dir, 'result.json'), 'utf8'));
    assert.ok(record.recording_error); assert.equal(record.termination_error, null);
    const before = fs.readFileSync(heartbeat);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(fs.readFileSync(heartbeat), before);
});

test('recording failure stops command and descendant instead of leaving them running', async t => {
    const f = fixture(t), heartbeat = path.join(f.root, 'child-heartbeat'), descendantHeartbeat = path.join(f.root, 'descendant-heartbeat');
    const descendant = 'setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),25)';
    const script = 'const fs=require("node:fs");require("node:child_process").spawn(process.execPath,["-e",process.argv[1],process.argv[3]],{stdio:"inherit"});'
        + 'let sent=false;setInterval(()=>{fs.appendFileSync(process.argv[2],"x");if(!sent&&fs.existsSync(process.argv[3])){sent=true;process.stdout.write("INJECT_WRITE_FAILURE")}},25);';
    const nativeFs = require('node:fs') as typeof fs, original = nativeFs.writeSync;
    nativeFs.writeSync = ((fd: number, buffer: Buffer, offset?: number, length?: number) => {
        if (Buffer.isBuffer(buffer) && buffer.toString() === 'INJECT_WRITE_FAILURE') throw new Error('ENOSPC injected log failure');
        return typeof offset === 'number' && typeof length === 'number' ? original(fd, buffer, offset, length) : original(fd, buffer);
    }) as typeof fs.writeSync;
    let result: Awaited<ReturnType<typeof runTaskCommand>>;
    try {
        result = await runTaskCommand({ ...f, cpuProfile: false, command: [process.execPath, '-e', script, descendant, heartbeat, descendantHeartbeat] });
    } finally { nativeFs.writeSync = original; }
    assert.notEqual(result.exitCode, 0);
    assert.match(result.record.recording_error!, /ENOSPC/u);
    assert.equal(result.record.termination_error, null);
    const before = [fs.readFileSync(heartbeat), fs.readFileSync(descendantHeartbeat)];
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual([fs.readFileSync(heartbeat), fs.readFileSync(descendantHeartbeat)], before);
});

test('POSIX cancellation records failure and stops child and descendant execution', { skip: process.platform === 'win32' }, async t => {
    const f = fixture(t), session = createDiagnosticSession(f), wrapper = installTaskCommandRecorder(session);
    const heartbeat = path.join(f.root, 'child-heartbeat'), descendantHeartbeat = path.join(f.root, 'descendant-heartbeat');
    const descendant = 'setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),25)';
    const script = 'require("node:child_process").spawn(process.execPath,["-e",process.argv[1],process.argv[3]],{stdio:"inherit"});'
        + 'setInterval(()=>require("node:fs").appendFileSync(process.argv[2],"x"),25);';
    const child = spawn(process.execPath, [wrapper, f.taskId, '--', process.execPath, '-e', script, descendant, heartbeat, descendantHeartbeat], { stdio: 'ignore' });
    const closed = new Promise<number | null>(resolve => child.on('close', resolve));
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(descendantHeartbeat) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(fs.existsSync(heartbeat) && fs.existsSync(descendantHeartbeat));
    child.kill('SIGTERM');
    assert.equal(await closed, 143);
    const before = [fs.readFileSync(heartbeat), fs.readFileSync(descendantHeartbeat)];
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual([fs.readFileSync(heartbeat), fs.readFileSync(descendantHeartbeat)], before);
    const dir = fs.readdirSync(path.join(session, 'commands'))[0];
    const record = JSON.parse(fs.readFileSync(path.join(session, 'commands', dir, 'result.json'), 'utf8'));
    assert.equal(record.cancelled_by_signal, 'SIGTERM');
    assert.equal(record.signal, 'SIGKILL'); assert.equal(record.termination_error, null);
});

test('POSIX timeout stops the process group after its leader has exited', { skip: process.platform === 'win32' }, async t => {
    const f = fixture(t), heartbeat = path.join(f.root, 'orphan-heartbeat');
    const descendant = 'setInterval(()=>require("node:fs").appendFileSync(process.argv[1],"x"),25)';
    const script = 'require("node:child_process").spawn(process.execPath,["-e",process.argv[1],process.argv[2]],{stdio:"inherit"});process.exit(0)';
    const result = await runTaskCommand({ ...f, cpuProfile: false, timeoutMs: 1000,
        command: [process.execPath, '-e', script, descendant, heartbeat] });
    assert.equal(result.record.timed_out, true); assert.notEqual(result.exitCode, 0);
    assert.equal(result.record.termination_error, null);
    const before = fs.readFileSync(heartbeat);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(fs.readFileSync(heartbeat), before);
});
