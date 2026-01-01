import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as subprocess from '../../../../src/core/process/subprocess';
import { runGit } from '../../../../src/core/git-helpers';
import {
    captureDirtyWorkspaceBaseline, deriveProtectedDirtyWorkspaceScope, deriveTaskOwnedDirtyWorkspaceScope
} from '../../../../src/gates/workspace/dirty-worktree-protection';
import { scopeGitFixture, writeScopeFile } from '../../scope-integrity-fixtures';

const queries = {
    tracked: (args: string[]) => args.includes('ls-files') && !args.includes('-s'),
    changed: (args: string[]) => args.includes('--cached') && args.includes('--name-only'),
    deleted: (args: string[]) => args.includes('--diff-filter=D'),
    index: (args: string[]) => args.includes('ls-files') && args.includes('-s'),
    head: (args: string[]) => args.includes('ls-tree'),
    blob: (args: string[]) => args.includes('cat-file'),
    rename: (args: string[]) => args.includes('--diff-filter=R')
};

// P3 / 508307a1: every authority query must reject failures, including partial stdout.
for (const query of Object.keys(queries) as Array<keyof typeof queries>) {
    for (const failure of ['exit', 'timeout', 'signal', 'buffer'] as const) {
        test(`P3 ${query} authority fails closed on ${failure}`, t => {
            const root = scopeGitFixture(t);
            writeScopeFile(root, 'src/app.ts', 'export const app = 2;\n');
            runGit(root, ['add', 'src/app.ts']);
            runGit(root, ['rm', 'src/deleted.ts']);
            const baseline = query === 'rename' ? captureDirtyWorkspaceBaseline(root, ['src/app.ts']) : null;
            const original = subprocess.spawnSyncWithTimeout;
            let injected = 0;
            t.mock.method(subprocess, 'spawnSyncWithTimeout', (...invocation: Parameters<typeof original>) => {
                const [command, args, options] = invocation;
                const result = original(command, args, options);
                if (command === 'git' && queries[query](args)) {
                    injected++;
                    // A successful-looking prefix must not be accepted on any process failure.
                    if (failure === 'exit') result.status = 128;
                    if (failure === 'timeout') { result.timedOut = true; result.status = null; }
                    if (failure === 'signal') { result.signal = 'SIGTERM'; result.status = null; }
                    if (failure === 'buffer') result.error = Object.assign(new Error('P3 buffer exhausted'), { code: 'ENOBUFS' });
                    result.stderr = 'P3 injected authority failure';
                }
                return result;
            });
            const attempt = query === 'rename'
                ? () => deriveTaskOwnedDirtyWorkspaceScope(root, baseline, ['src/app.ts'], { useStaged: true })
                : () => captureDirtyWorkspaceBaseline(root, ['src/app.ts']);
            assert.throws(attempt, /Git .*authority.*failed/iu);
            assert.ok(injected > 0, `the ${query} query must actually be reached`);
        });
    }
}

test('P3 unavailable Git authority provides the failing query as an executable diagnostic route', t => {
    const root = scopeGitFixture(t);
    const original = subprocess.spawnSyncWithTimeout;
    let injected = false;
    t.mock.method(subprocess, 'spawnSyncWithTimeout', (...invocation: Parameters<typeof original>) => {
        const [command, args, options] = invocation;
        const result = original(command, args, options);
        if (command === 'git' && queries.tracked(args)) {
            injected = true;
            result.status = 128;
            result.stderr = 'P3 tracked query unavailable';
        }
        return result;
    });
    assert.throws(() => captureDirtyWorkspaceBaseline(root, ['src/app.ts']), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /tracked.*authority/iu);
        assert.match(error.message, /git(?:\.exe)?\s+(?:-C\s+.+\s+)?ls-files\b/iu);
        return true;
    });
    assert.ok(injected);
});

// P3 / eabe39c0: contained directory pathspecs enumerate files without granting ownership.
for (const missingDirectory of [false, true]) {
    test(`P3 literal directory pathspec compatibility with ${missingDirectory ? 'missing' : 'existing'} directories`, t => {
        const root = scopeGitFixture(t);
        writeScopeFile(root, 'src/app.ts', 'dirty\n');
        writeScopeFile(root, 'src/local.ts', 'local\n');
        writeScopeFile(root, 'src/ignored.ts', 'ignored\n');
        fs.mkdirSync(path.join(root, 'empty'));
        if (missingDirectory) fs.rmSync(path.join(root, 'src/[literal]'), { recursive: true });
        const exact = captureDirtyWorkspaceBaseline(root, ['src/app.ts']);
        const directories = captureDirtyWorkspaceBaseline(root, ['src', 'src/[literal]', 'empty', 'missing']);
        assert.deepEqual(directories.changed_files, exact.changed_files);
        assert.deepEqual(directories.entry_authorized_files, []);
        assert.deepEqual(deriveProtectedDirtyWorkspaceScope(root, directories, ['src'])?.protected_files,
            directories.changed_files, 'directory selection never claims all child files');
        assert.ok(!directories.changed_files.includes('src/ignored.ts'));
        assert.deepEqual(captureDirtyWorkspaceBaseline(root, ['src/ignored.ts']).entry_authorized_files, ['src/ignored.ts']);
    });
}

for (const [label, output] of [
    ['foreign sibling', 'src-sibling/app.ts\0'], ['traversal', '../outside.ts\0'],
    ['duplicate', 'src/app.ts\0src/app.ts\0'], ['unterminated', 'src/app.ts'],
    ['empty record', 'src/app.ts\0\0']
] as const) {
    test(`P3 directory authority rejects ${label} output`, t => {
        const root = scopeGitFixture(t);
        const original = subprocess.spawnSyncWithTimeout;
        let injected = false;
        t.mock.method(subprocess, 'spawnSyncWithTimeout', (...invocation: Parameters<typeof original>) => {
            const [command, args, options] = invocation;
            const result = original(command, args, options);
            if (command === 'git' && queries.tracked(args)) { result.stdout = output; injected = true; }
            return result;
        });
        assert.throws(() => captureDirtyWorkspaceBaseline(root, ['src']), /Git .*authority.*failed/iu);
        assert.ok(injected);
    });
}

test('P3 directory authority rejects a directory replaced during the Git query', t => {
    const root = scopeGitFixture(t);
    const original = subprocess.spawnSyncWithTimeout;
    let replaced = false;
    t.mock.method(subprocess, 'spawnSyncWithTimeout', (...invocation: Parameters<typeof original>) => {
        const [command, args, options] = invocation;
        const result = original(command, args, options);
        if (command === 'git' && queries.tracked(args) && !replaced) {
            fs.renameSync(path.join(root, 'src'), path.join(root, 'previous-src'));
            fs.mkdirSync(path.join(root, 'src'));
            replaced = true;
        }
        return result;
    });
    assert.throws(() => captureDirtyWorkspaceBaseline(root, ['src']), /Git .*authority.*failed/iu);
    assert.ok(replaced);
});
