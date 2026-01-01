import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { performance } from 'node:perf_hooks';
import '../isolate-compile-cache';
import { resolveNodeCompileCacheRoot } from '../../../src/bin/garda/node-compile-cache-path';
import { pruneNodeCompileCache } from '../../../src/lifecycle/runtime-policy/node-compile-cache-maintenance';

const nativeFs = require('node:fs') as typeof fs;
const clock = require('node:perf_hooks').performance as typeof performance;

function cacheFixture() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-cache-'));
    const cacheRoot = path.join(temporaryRoot, 'cache');
    fs.mkdirSync(cacheRoot);
    const now = new Date('2026-11-02T12:00:00Z');
    return {
        temporaryRoot, cacheRoot, now, options: { cacheRoot, now },
        cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
    };
}

function seedFile(directory: string, name = 'entry', content = 'data'): string {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    fs.writeFileSync(file, content);
    return file;
}

function trashNames(root: string): string[] {
    return fs.readdirSync(root).filter(name => name.startsWith('.garda-trash-'));
}

describe('pruneNodeCompileCache', () => {
    it('loads the standalone launcher without local companions and matches the shared path', () => {
        const fixture = cacheFixture();
        try {
            const launcher = path.join(fixture.temporaryRoot, 'compile-cache.js');
            fs.copyFileSync(require.resolve('../../../src/bin/garda/compile-cache'), launcher);
            const result = childProcess.spawnSync(process.execPath, ['-e', [
                "require('node:module').enableCompileCache = root => process.stdout.write(root);",
                'require(process.argv[1]);'
            ].join('\n'), launcher], { encoding: 'utf8', windowsHide: true });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, resolveNodeCompileCacheRoot());
        } finally { fixture.cleanup(); }
    });

    it('atomically renames every build including the active build without reading its contents', (t) => {
        const fixture = cacheFixture();
        try {
            for (const name of ['v24-active', 'v24-other', 'v22-old']) seedFile(path.join(fixture.cacheRoot, name));
            const rootFile = seedFile(fixture.cacheRoot, 'unrelated');
            const originalRename = nativeFs.renameSync;
            const originalOpen = nativeFs.opendirSync;
            const renamed: string[] = [];
            t.mock.method(nativeFs, 'opendirSync', (...args: Parameters<typeof fs.opendirSync>) => {
                assert.equal(String(args[0]), fixture.cacheRoot, 'reset must never scan build entries');
                return Reflect.apply(originalOpen, nativeFs, args);
            });
            t.mock.method(nativeFs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
                assert.equal(path.dirname(String(source)), fixture.cacheRoot);
                assert.equal(path.dirname(String(destination)), fixture.cacheRoot);
                assert.ok(path.basename(String(destination)).startsWith('.garda-trash-'));
                renamed.push(path.basename(String(source)));
                return originalRename(source, destination);
            });
            const result = pruneNodeCompileCache({ ...fixture.options, budgetMs: 0 });
            assert.deepEqual(renamed.sort(), ['v22-old', 'v24-active', 'v24-other']);
            assert.equal(result.renamed_directory_count, 3);
            assert.equal(trashNames(fixture.cacheRoot).length, 3);
            assert.equal(result.removed_entry_count, 0);
            assert.deepEqual(result.errors, []);
            assert.ok(fs.existsSync(rootFile));
        } finally { fixture.cleanup(); }
    });

    it('claims once per UTC ISO week across time zones and removes older week markers', () => {
        const fixture = cacheFixture();
        try {
            const first = pruneNodeCompileCache({ ...fixture.options, now: new Date('2026-12-31T23:00:00Z') });
            assert.equal(first.skipped_reason, null);
            assert.ok(fs.existsSync(path.join(fixture.cacheRoot, '.garda-prune-2026-W53')));
            const build = path.join(fixture.cacheRoot, 'new-build');
            seedFile(build);
            const sameWeek = pruneNodeCompileCache({ ...fixture.options, now: new Date('2027-01-04T00:30:00+02:00') });
            assert.equal(sameWeek.skipped_reason, 'already_ran_this_week');
            assert.ok(fs.existsSync(build));
            const nextWeek = pruneNodeCompileCache({ ...fixture.options, now: new Date('2027-01-04T00:00:00Z') });
            assert.equal(nextWeek.renamed_directory_count, 1);
            assert.deepEqual(nextWeek.errors, []);
            assert.deepEqual(fs.readdirSync(fixture.cacheRoot), ['.garda-prune-2027-W01']);
        } finally { fixture.cleanup(); }
    });

    it('counts busy build renames, keeps the weekly claim, and retries next week', (t) => {
        const fixture = cacheFixture();
        try {
            const codes = ['EPERM', 'EBUSY', 'EACCES'];
            for (const code of codes) seedFile(path.join(fixture.cacheRoot, code));
            const originalRename = nativeFs.renameSync;
            let busy = true;
            const rename = t.mock.method(nativeFs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
                const code = path.basename(String(source));
                if (busy && codes.includes(code)) throw Object.assign(new Error(`${code} rename blocked`), { code });
                return originalRename(source, destination);
            });
            const first = pruneNodeCompileCache(fixture.options);
            assert.equal(first.error_count, 3);
            assert.equal(first.errors.length, 3);
            assert.deepEqual(first.warning_errors, []);
            assert.equal(first.renamed_directory_count, 0);
            assert.ok(fs.existsSync(path.join(fixture.cacheRoot, '.garda-prune-2026-W45')));
            assert.equal(pruneNodeCompileCache(fixture.options).skipped_reason, 'already_ran_this_week');
            assert.equal(rename.mock.callCount(), 3);
            busy = false;
            const nextWeek = pruneNodeCompileCache({ ...fixture.options, now: new Date('2026-11-09T12:00:00Z') });
            assert.equal(nextWeek.renamed_directory_count, 3);
            assert.equal(nextWeek.error_count, 0);
            assert.ok(codes.every(code => !fs.existsSync(path.join(fixture.cacheRoot, code))));
        } finally { fixture.cleanup(); }
    });

    it('keeps unexpected rename errors reportable even after the error details fill up', (t) => {
        const fixture = cacheFixture();
        try {
            for (let index = 0; index < 12; index++) seedFile(path.join(fixture.cacheRoot, `busy-${index}`));
            seedFile(path.join(fixture.cacheRoot, 'unexpected'));
            t.mock.method(nativeFs, 'renameSync', (source: fs.PathLike) => {
                const code = path.basename(String(source)) === 'unexpected' ? 'EIO' : 'EBUSY';
                throw Object.assign(new Error(`${code} rename blocked`), { code });
            });
            const result = pruneNodeCompileCache(fixture.options);
            assert.equal(result.error_count, 13);
            assert.equal(result.errors.length, 10);
            assert.deepEqual(result.warning_errors, ['EIO rename blocked']);
        } finally { fixture.cleanup(); }
    });

    it('claims a UTC ISO week only once under concurrent processes', { timeout: 20_000 }, async () => {
        const fixture = cacheFixture();
        try {
            seedFile(path.join(fixture.cacheRoot, 'build'));
            const gate = path.join(fixture.temporaryRoot, 'start');
            const children = [0, 1, 2].map(() => {
                const child = childProcess.spawn(process.execPath, ['-e', [
                    "const fs = require('node:fs');",
                    "process.stdout.write('ready\\n');",
                    'while (!fs.existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
                    'const options = JSON.parse(process.argv[3]); options.now = new Date(options.now);',
                    'process.stdout.write(JSON.stringify(require(process.argv[1]).pruneNodeCompileCache(options)));'
                ].join('\n'), require.resolve('../../../src/lifecycle/runtime-policy/node-compile-cache-maintenance'), gate,
                JSON.stringify({ ...fixture.options, budgetMs: 0 })], { windowsHide: true });
                let output = '';
                let errors = '';
                const ready = new Promise<void>(resolve => child.stdout.on('data', chunk => {
                    output += String(chunk);
                    if (output.includes('\n')) resolve();
                }));
                child.stderr.on('data', chunk => { errors += String(chunk); });
                const done = new Promise<string>((resolve, reject) => {
                    child.on('error', reject);
                    child.on('close', code => code === 0 ? resolve(output.slice(output.indexOf('\n') + 1)) : reject(new Error(errors)));
                });
                return { ready, done };
            });
            await Promise.all(children.map(child => child.ready));
            fs.writeFileSync(gate, '');
            const results = (await Promise.all(children.map(child => child.done))).map(value => JSON.parse(value));
            assert.equal(results.filter(result => result.skipped_reason === null).length, 1);
            assert.equal(results.filter(result => result.skipped_reason === 'already_ran_this_week').length, 2);
            assert.equal(results.reduce((sum, result) => sum + result.renamed_directory_count, 0), 1);
            for (const result of results) assert.deepEqual(result.errors, []);
            assert.ok(fs.existsSync(path.join(fixture.cacheRoot, '.garda-prune-2026-W45')));
        } finally { fixture.cleanup(); }
    });

    it('treats a non-file marker as a claim using lstat without opening it', (t) => {
        const fixture = cacheFixture();
        try {
            const marker = path.join(fixture.cacheRoot, '.garda-prune-2026-W45');
            fs.mkdirSync(marker);
            const build = path.join(fixture.cacheRoot, 'build');
            seedFile(build);
            const originalOpen = nativeFs.openSync;
            t.mock.method(nativeFs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
                assert.notEqual(String(args[0]), marker);
                return Reflect.apply(originalOpen, nativeFs, args);
            });
            const result = pruneNodeCompileCache(fixture.options);
            assert.equal(result.skipped_reason, 'already_ran_this_week');
            assert.ok(fs.existsSync(build));
            assert.deepEqual(result.errors, []);
        } finally { fixture.cleanup(); }
    });

    it('bypasses the weekly throttle on update, including repeated updates', () => {
        const fixture = cacheFixture();
        try {
            pruneNodeCompileCache(fixture.options);
            for (let index = 0; index < 2; index++) {
                const build = path.join(fixture.cacheRoot, 'build');
                seedFile(build);
                const result = pruneNodeCompileCache({ ...fixture.options, ignoreThrottle: true });
                assert.equal(result.skipped_reason, null);
                assert.equal(result.renamed_directory_count, 1);
                assert.equal(result.removed_entry_count, 2);
                assert.equal(result.removed_directory_count, 1);
                assert.equal(result.removed_logical_bytes, 4);
                assert.deepEqual(result.errors, []);
                assert.equal(fs.existsSync(build), false);
            }
        } finally { fixture.cleanup(); }
    });

    it('removes 5000 flat trash files over tiny-budget calls while skipping undeletable entries once per pass', (t) => {
        const fixture = cacheFixture();
        try {
            const trash = path.join(fixture.cacheRoot, '.garda-trash-flat');
            for (let index = 0; index < 5000; index++) seedFile(trash, String(index).padStart(4, '0'), 'x');
            const firstEntries = fs.opendirSync(trash);
            const blocked = new Set([firstEntries.readSync()!.name, firstEntries.readSync()!.name]);
            firstEntries.closeSync();
            let elapsed = 0;
            let blockedAttempts = new Map<string, number>();
            const originalUnlink = nativeFs.unlinkSync;
            t.mock.method(clock, 'now', () => elapsed);
            t.mock.method(nativeFs, 'unlinkSync', (candidate: fs.PathLike) => {
                elapsed += 0.02;
                if (path.dirname(String(candidate)) === trash && blocked.has(path.basename(String(candidate)))) {
                    const name = path.basename(String(candidate));
                    blockedAttempts.set(name, (blockedAttempts.get(name) ?? 0) + 1);
                    throw Object.assign(new Error('locked entry'), { code: 'EACCES' });
                }
                return originalUnlink(candidate);
            });
            let removed = 0;
            let logicalBytes = 0;
            let calls = 0;
            while (fs.readdirSync(trash).length > blocked.size && calls < 100) {
                blockedAttempts = new Map();
                const result = pruneNodeCompileCache({ ...fixture.options, trashOnly: true, budgetMs: 5 });
                assert.ok(result.removed_entry_count > 0, 'undeletable entries must not block later files');
                for (const attempts of blockedAttempts.values()) assert.equal(attempts, 1);
                removed += result.removed_entry_count;
                logicalBytes += result.removed_logical_bytes;
                calls++;
            }
            assert.ok(calls > 1 && calls < 100);
            assert.equal(removed, 4998);
            assert.equal(logicalBytes, 4998);
            assert.deepEqual(fs.readdirSync(trash).sort(), [...blocked].sort());
            blocked.clear();
            const finished = pruneNodeCompileCache({ ...fixture.options, trashOnly: true, budgetMs: 5 });
            assert.equal(finished.removed_entry_count, 3);
            assert.equal(finished.removed_directory_count, 1);
            assert.equal(fs.existsSync(trash), false);
        } finally { fixture.cleanup(); }
    });

    it('retries leftover nested trash even when the weekly reset is throttled', () => {
        const fixture = cacheFixture();
        try {
            seedFile(path.join(fixture.cacheRoot, 'build', 'nested'));
            const first = pruneNodeCompileCache({ ...fixture.options, budgetMs: 0 });
            assert.equal(first.renamed_directory_count, 1);
            assert.equal(trashNames(fixture.cacheRoot).length, 1);
            const second = pruneNodeCompileCache(fixture.options);
            assert.equal(second.skipped_reason, 'already_ran_this_week');
            assert.equal(second.removed_entry_count, 3);
            assert.equal(second.removed_directory_count, 2);
            assert.equal(second.removed_logical_bytes, 4);
            assert.deepEqual(trashNames(fixture.cacheRoot), []);
        } finally { fixture.cleanup(); }
    });

    it('bounds consecutive removal failures and caps error details', (t) => {
        const fixture = cacheFixture();
        try {
            const trash = path.join(fixture.cacheRoot, '.garda-trash-errors');
            for (let index = 0; index < 200; index++) seedFile(trash, String(index));
            t.mock.method(nativeFs, 'unlinkSync', () => { throw Object.assign(new Error('x'.repeat(10000)), { code: 'EACCES' }); });
            const result = pruneNodeCompileCache({ ...fixture.options, trashOnly: true });
            assert.equal(result.error_count, 128);
            assert.equal(result.errors.length, 10);
            assert.ok(result.errors.every(error => error.length === 512));
            assert.equal(result.removed_entry_count, 0);
            assert.equal(fs.readdirSync(trash).length, 200);
        } finally { fixture.cleanup(); }
    });

    it('keeps trash removal advisory when the weekly marker cannot be created', (t) => {
        const fixture = cacheFixture();
        try {
            seedFile(path.join(fixture.cacheRoot, '.garda-trash-old'));
            const originalOpen = nativeFs.openSync;
            t.mock.method(nativeFs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
                if (String(args[0]).includes('.garda-prune-')) throw Object.assign(new Error('marker denied'), { code: 'EACCES' });
                return Reflect.apply(originalOpen, nativeFs, args);
            });
            const result = pruneNodeCompileCache(fixture.options);
            assert.equal(result.error_count, 1);
            assert.deepEqual(result.warning_errors, ['marker denied']);
            assert.equal(result.removed_entry_count, 2);
            assert.deepEqual(trashNames(fixture.cacheRoot), []);
        } finally { fixture.cleanup(); }
    });

    it('skips dry runs and missing roots and reports invalid roots without throwing', () => {
        const fixture = cacheFixture();
        try {
            const build = path.join(fixture.cacheRoot, 'build');
            seedFile(build);
            assert.equal(pruneNodeCompileCache({ ...fixture.options, dryRun: true }).skipped_reason, 'dry_run');
            assert.deepEqual(fs.readdirSync(fixture.cacheRoot), ['build']);
            assert.equal(pruneNodeCompileCache({ cacheRoot: path.join(fixture.temporaryRoot, 'missing') }).skipped_reason, 'cache_root_missing');
            const file = seedFile(fixture.temporaryRoot);
            assert.equal(pruneNodeCompileCache({ cacheRoot: file }).error_count, 1);
        } finally { fixture.cleanup(); }
    });

    it('refuses symlink roots and build/trash links to outside directories', () => {
        const fixture = cacheFixture();
        try {
            const outside = path.join(fixture.temporaryRoot, 'outside');
            const file = seedFile(outside);
            const rootLink = path.join(fixture.temporaryRoot, 'root-link');
            fs.symlinkSync(outside, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
            fs.symlinkSync(outside, path.join(fixture.cacheRoot, 'build-link'), process.platform === 'win32' ? 'junction' : 'dir');
            fs.symlinkSync(outside, path.join(fixture.cacheRoot, '.garda-trash-link'), process.platform === 'win32' ? 'junction' : 'dir');
            assert.equal(pruneNodeCompileCache({ cacheRoot: rootLink }).skipped_reason, 'cache_root_is_symlink');
            const result = pruneNodeCompileCache(fixture.options);
            assert.equal(result.renamed_directory_count, 0);
            assert.equal(result.removed_entry_count, 0);
            assert.ok(fs.existsSync(file));
        } finally { fixture.cleanup(); }
    });
});
