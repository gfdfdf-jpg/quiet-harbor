import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WAIT_MS = 120_000;

/** Poll an observable condition with a real monotonic deadline, independent of the walk's shifted Date. */
export async function waitForOwner(label: string, condition: () => boolean, timeoutMs = WAIT_MS): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!condition()) {
        if (performance.now() >= deadline) throw new Error('Timed out waiting for ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

/** An actual gate owner, using the same gate entrypoint as the ordinary walker in its own process. */
export class NativeWalkOwner {
    readonly child: ChildProcess;
    output = '';
    closed = false;
    code: number | null = null;
    error: Error | undefined;
    private readonly fullSuite: boolean;

    constructor(root: string, argv: string[], inspect = false) {
        this.fullSuite = argv[0] === 'full-suite-validation';
        const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
        // Match the existing fixture clock; no evidence timestamps are rewritten after publication.
        const offset = Date.now() - (performance.timeOrigin + performance.now());
        this.child = spawn(process.execPath, [...inspect ? ['--inspect-brk=127.0.0.1:0'] : [],
            __filename, JSON.stringify(argv), String(offset)], {
            cwd: root, windowsHide: true, detached: process.platform !== 'win32', env,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });
        this.child.stdout!.on('data', data => { this.output += String(data); });
        this.child.stderr!.on('data', data => { this.output += String(data); });
        this.child.once('error', error => { this.error = error; });
        this.child.once('close', code => { this.closed = true; this.code = code; });
    }

    assertRunning(): void {
        if (this.error || this.closed) throw new Error('Native owner exited before its boundary: ' + this.error + '\n' + this.output);
    }

    async finish(acceptedCodes = [0]): Promise<void> {
        try { await waitForOwner('native owner exit', () => this.closed || !!this.error); }
        catch (error) { throw new Error(String(error) + '\n' + this.output); }
        if (this.error || !acceptedCodes.includes(this.code!)) throw new Error('Native owner failed (exit ' + this.code + '): ' + this.error + '\n' + this.output);
    }

    async killTree(): Promise<void> {
        if (this.closed || !this.child.pid) return;
        if (this.fullSuite && this.child.connected) {
            this.child.send('kill-native-tree');
        } else if (process.platform !== 'win32') {
            process.kill(-this.child.pid, 'SIGKILL');
        } else {
            // Use the retained spawn handle, rather than opening an arbitrary PID through taskkill.
            this.child.kill('SIGKILL');
        }
        await waitForOwner('killed native owner exit', () => this.closed, 30_000);
    }
}

/** Only ordinary fixture control files; none of these are Garda evidence or lifecycle events. */
export function writeOwnerBlocker(root: string): void {
    const directory = path.join(root, '.git/walk-owner');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'block.cjs'), [
        'const fs = require("node:fs"), cp = require("node:child_process");',
        'fs.writeFileSync(".git/walk-owner/ready", String(process.pid));',
        'const deadline = performance.now() + 120000;',
        'const timer = setInterval(() => {',
        '  if (performance.now() >= deadline) { clearInterval(timer); process.exit(97); }',
        '  if (!fs.existsSync(".git/walk-owner/release")) return;',
        '  clearInterval(timer);',
        '  if (process.argv.length > 2) {',
        '    const run = cp.spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit", windowsHide: true, timeout: 30000 });',
        '    process.exit(run.status ?? 98);',
        '  }',
        '  console.log("fixture full suite passed");',
        '}, 25);'
    ].join('\n'));
}

if (require.main === module) {
    process.on('message', message => {
        if (message !== 'kill-native-tree') return;
        // The owner can terminate its actual spawned command even on Windows hosts that deny
        // cross-process taskkill/WMI to the supervising test. Read, never synthesize, its native PID.
        const markerPath = path.resolve('garda-agent-orchestrator/runtime/reviews/T-WALK-full-suite-run-marker.json');
        if (fs.existsSync(markerPath)) {
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { gate_pid: number; child_pid: number | null };
            if (marker.gate_pid !== process.pid) throw new Error('Native owner marker belongs to another process.');
            if (marker.child_pid) process.kill(process.platform === 'win32' ? marker.child_pid : -marker.child_pid, 'SIGKILL');
        }
        process.kill(process.pid, 'SIGKILL');
    });
    const offset = Number(process.argv[3]);
    const RealDate = Date;
    class OwnerDate extends RealDate {
        constructor(...values: unknown[]) {
            if (!values.length) super(RealDate.now() + offset);
            else super(...values as [number]);
        }
        static override now(): number { return RealDate.now() + offset; }
    }
    globalThis.Date = OwnerDate as DateConstructor;
    void import('../../../../src/cli/commands/gate-command').then(async ({ handleGate }) => {
        await handleGate(JSON.parse(process.argv[2]) as string[]);
    }).catch(error => { console.error(error); process.exitCode = 1; })
        .finally(() => {
            if (process.connected) process.disconnect();
            process.exit(process.exitCode ?? 0);
        });
}
