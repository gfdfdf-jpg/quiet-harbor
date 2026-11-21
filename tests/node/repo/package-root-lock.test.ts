import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getPackageRootLockPath,
    withPackageRootLock
} from '../../../scripts/node-foundation/release-validation/package-root-lock';

const HOLDER_SCRIPT = [
    'const { withPackageRootLock } = require(process.argv[1]);',
    'withPackageRootLock(process.argv[2], () => {',
    "  process.stdout.write('held\\n');",
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[3]));',
    '});',
    "process.stdout.write('released\\n');"
].join('\n');

function makeRoot(): string {
    return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gao-package-root-lock-')));
}

test('one repository root shares one temp-dir lock whatever its spelling, other roots do not', () => {
    const root = makeRoot();
    const other = makeRoot();
    try {
        fs.mkdirSync(path.join(root, 'child'));
        const respelled = path.join(root, 'child', '..');
        assert.equal(getPackageRootLockPath(respelled), getPackageRootLockPath(root));
        assert.notEqual(getPackageRootLockPath(other), getPackageRootLockPath(root));
        const expectedParent = process.platform === 'win32'
            ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Temp')
            : '/tmp';
        assert.equal(path.dirname(getPackageRootLockPath(root)), fs.realpathSync.native(expectedParent));
        assert.ok(path.relative(root, getPackageRootLockPath(root)).startsWith('..'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(other, { recursive: true, force: true });
    }
});

test('lock identity is independent of TEMP, TMP and TMPDIR', () => {
    const root = makeRoot();
    try {
        const modulePath = require.resolve('../../../scripts/node-foundation/release-validation/package-root-lock');
        const script = 'process.stdout.write(require(process.argv[1]).getPackageRootLockPath(process.argv[2]))';
        const result = spawnSync(process.execPath, ['-e', script, modulePath, root], {
            encoding: 'utf8', env: { ...process.env, TEMP: path.join(root, 'a'), TMP: path.join(root, 'b'), TMPDIR: path.join(root, 'c') }
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, getPackageRootLockPath(root));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('children can reenter the active lock and stale inherited tokens cannot reenter a later lock', () => {
    const root = makeRoot();
    const modulePath = require.resolve('../../../scripts/node-foundation/release-validation/package-root-lock');
    const script = 'require(process.argv[1]).withPackageRootLock(process.argv[2], () => process.stdout.write("entered"))';
    try {
        let stale = '';
        withPackageRootLock(root, () => {
            stale = process.env.GARDA_PACKAGE_ROOT_LOCKS || '';
            const child = spawnSync(process.execPath, ['-e', script, modulePath, root], { encoding: 'utf8', timeout: 5000 });
            assert.equal(child.status, 0, child.stderr);
            assert.equal(child.stdout, 'entered');
        });
        withPackageRootLock(root, () => {
            const child = spawnSync(process.execPath, ['-e', script, modulePath, root], {
                encoding: 'utf8', timeout: 700, env: { ...process.env, GARDA_PACKAGE_ROOT_LOCKS: stale }
            });
            assert.equal((child.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT');
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

const CONTROLLED_HOLDER = [
    'const fs = require("node:fs");',
    'require(process.argv[1]).withPackageRootLock(process.argv[2], () => {',
    ' process.stdout.write("held\\n");',
    ' const deadline = Date.now() + 60000;',
    ' while (!fs.existsSync(process.argv[3]) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);',
    ' if (!fs.existsSync(process.argv[3])) process.exitCode = 1;',
    '});'
].join('\n');

function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let output = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes(expected)) resolve();
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`process exited ${code} before ${expected}: ${output}`)));
    });
}

function waitForClose(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
}

async function assertWriterWaits(
    root: string, command: string, args: string[], inspect: () => void = () => {}, shell = false, readyPath?: string
): Promise<void> {
    const release = path.join(os.tmpdir(), `gao-lock-release-${process.pid}-${Date.now()}-${Math.random()}`);
    const holder = spawn(process.execPath, [
        '-e', CONTROLLED_HOLDER, require.resolve('../../../scripts/node-foundation/release-validation/package-root-lock'), root, release
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const holderClosed = waitForClose(holder);
    let writer: ChildProcess | undefined;
    try {
        await waitForOutput(holder, 'held\n');
        writer = spawn(command, args, {
            cwd: root, env: { ...process.env, npm_config_cache: path.join(root, 'cache') },
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell
        });
        let exited = false;
        let stderr = '';
        writer.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        const writerClosed = waitForClose(writer).then((code) => { exited = true; return code; });
        if (readyPath) {
            const deadline = Date.now() + 30_000;
            while (!fs.existsSync(readyPath)) {
                if (exited || Date.now() >= deadline) throw new Error(`writer did not reach postpack: ${stderr}`);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.equal(exited, false, `writer must wait for the unrelated holder: ${stderr}`);
        inspect();
        fs.writeFileSync(release, 'release');
        assert.equal(await holderClosed, 0);
        assert.equal(await writerClosed, 0, stderr);
    } finally {
        fs.writeFileSync(release, 'release');
        holder.kill();
        writer?.kill();
        fs.rmSync(release, { force: true });
    }
}

test('compatibility file creation and removal each wait for an unrelated holder', { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const canonical = path.join(root, 'template', 'entrypoints', 'canonical-rule-index.md');
    const legacy = path.join(root, 'template', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '# canonical\n');
    const { getRepoRoot } = await import('../../../scripts/node-foundation/build');
    const hook = path.join(getRepoRoot(), 'scripts', 'package-legacy-entrypoint-compat.cjs');
    try {
        await assertWriterWaits(root, process.execPath, [hook, 'create'], () => assert.equal(fs.existsSync(legacy), false));
        assert.equal(fs.readFileSync(legacy, 'utf8'), '# CLAUDE.md\n');
        await assertWriterWaits(root, process.execPath, [hook, 'remove'], () => assert.equal(fs.existsSync(legacy), true));
        assert.equal(fs.existsSync(legacy), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function makeNpmFixture(hook: string): { root: string; legacy: string } {
    const root = makeRoot();
    const canonical = path.join(root, 'template', 'entrypoints', 'canonical-rule-index.md');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '# canonical\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'garda-package-lock-fixture', version: '1.0.0', files: ['template'],
        scripts: {
            prepack: `node "${hook}" create`,
            postpack: `node "${hook}" remove`
        }
    }));
    return { root, legacy: path.join(root, 'template', 'CLAUDE.md') };
}

function npmFixtureInvocation(): { command: string; prefix: string[]; shell: boolean } {
    const candidates = [
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    const cli = candidates.find((candidate) => candidate && fs.existsSync(candidate));
    return cli
        ? { command: process.execPath, prefix: [cli], shell: false }
        : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], shell: process.platform === 'win32' };
}

test('an unrelated npm pack postpack waits before removing the compatibility file', { timeout: 60_000 }, async () => {
    const { getRepoRoot } = await import('../../../scripts/node-foundation/build');
    const hook = path.join(getRepoRoot(), 'scripts', 'package-legacy-entrypoint-compat.cjs');
    const { root, legacy } = makeNpmFixture(hook);
    const invocation = npmFixtureInvocation();
    fs.writeFileSync(legacy, '# CLAUDE.md\n');
    const postpackStarted = path.join(root, 'postpack-started');
    fs.writeFileSync(path.join(root, 'mark-postpack.cjs'), 'require("node:fs").writeFileSync("postpack-started", "yes");\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'garda-package-lock-fixture', version: '1.0.0', files: ['template'],
        scripts: { postpack: `node mark-postpack.cjs && node "${hook}" remove` }
    }));
    try {
        await assertWriterWaits(root, invocation.command, [...invocation.prefix, 'pack', '--json', '--silent'],
            () => assert.equal(fs.existsSync(legacy), true), invocation.shell, postpackStarted);
        assert.equal(fs.existsSync(legacy), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('npm prepack and postpack reenter a parent package root lock', { timeout: 60_000 }, async () => {
    const { getRepoRoot } = await import('../../../scripts/node-foundation/build');
    const hook = path.join(getRepoRoot(), 'scripts', 'package-legacy-entrypoint-compat.cjs');
    const { root, legacy } = makeNpmFixture(hook);
    const invocation = npmFixtureInvocation();
    try {
        withPackageRootLock(root, () => {
            const result = spawnSync(invocation.command, [...invocation.prefix, 'pack', '--json', '--silent'], {
                cwd: root, env: { ...process.env, npm_config_cache: path.join(root, 'cache') },
                encoding: 'utf8', timeout: 45_000, windowsHide: true, shell: invocation.shell
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(fs.existsSync(legacy), false);
            assert.equal(fs.existsSync(getPackageRootLockPath(root)), true);
        });
        assert.equal(fs.existsSync(getPackageRootLockPath(root)), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the lock is held for the whole operation and released after success and failure', () => {
    const root = makeRoot();
    const lockPath = getPackageRootLockPath(root);
    try {
        assert.equal(fs.existsSync(lockPath), false);
        assert.equal(withPackageRootLock(root, () => {
            assert.equal(fs.existsSync(lockPath), true);
            return 'done';
        }), 'done');
        assert.equal(fs.existsSync(lockPath), false);
        assert.throws(() => withPackageRootLock(root, () => {
            assert.equal(fs.existsSync(lockPath), true);
            throw new Error('operation failed');
        }), /operation failed/u);
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a second process waits until the first process releases the lock', async () => {
    const root = makeRoot();
    const holdMs = 1500;
    const holder = spawn(process.execPath, [
        '-e', HOLDER_SCRIPT, require.resolve('../../../scripts/node-foundation/release-validation/package-root-lock'), root, String(holdMs)
    ], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    try {
        let output = '';
        const closed = new Promise<number | null>((resolve) => holder.once('close', resolve));
        await new Promise<void>((resolve, reject) => {
            holder.stdout.on('data', (chunk: Buffer) => {
                output += chunk.toString('utf8');
                if (output.includes('held\n')) resolve();
            });
            holder.once('error', reject);
            holder.once('exit', () => reject(new Error(`holder exited before taking the lock: ${output}`)));
        });
        const waitStarted = Date.now();
        // Blocks this process until the holder leaves: an unserialized acquisition would return immediately.
        const waitedMs = withPackageRootLock(root, () => Date.now() - waitStarted);
        assert.ok(waitedMs >= 500, `the lock must stay exclusive across processes, waited ${waitedMs} ms`);
        assert.equal(await closed, 0);
        assert.ok(output.includes('released\n'));
        assert.equal(fs.existsSync(getPackageRootLockPath(root)), false);
    } finally {
        holder.kill();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
