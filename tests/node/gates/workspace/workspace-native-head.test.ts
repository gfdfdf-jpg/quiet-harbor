import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readHeadSha } from '../../../../src/gates/workspace/workspace-snapshot-cache';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';

function git(root: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function fixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-native-head-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, 'init', '-q');
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'initial');
    return root;
}

type HeadOutcome = { value: string | null } | { error: string };

// HEAD authority fails closed: a Git failure is thrown, never turned into an empty HEAD.
function headOutcome(read: () => string | null): HeadOutcome {
    try { return { value: read() }; }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

function observedHeadOutcome(root: string, expectedCalls: number): HeadOutcome {
    const native = require('node:child_process') as typeof import('node:child_process');
    const original = native.spawnSync;
    let calls = 0;
    native.spawnSync = ((...args: Parameters<typeof original>) => {
        calls++;
        assert.equal(args[0], 'git');
        assert.deepEqual(args[1], ['-C', root, 'rev-parse', 'HEAD']);
        return original(...args);
    }) as typeof original;
    try {
        const outcome = headOutcome(() => withInvocationReadObservation(() => readHeadSha(root)));
        assert.equal(calls, expectedCalls);
        return outcome;
    } finally { native.spawnSync = original; }
}

function observedHead(root: string, expectedCalls: number): string | null {
    const outcome = observedHeadOutcome(root, expectedCalls);
    if ('error' in outcome) assert.fail(outcome.error);
    return outcome.value;
}

test('native HEAD recognizes a linked worktree gitdir file and common branch refs', t => {
    const root = fixture(t), linked = path.join(root, 'linked');
    git(root, 'worktree', 'add', '-qb', 'linked', linked);
    assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
    assert.equal(observedHead(linked, 0), git(linked, 'rev-parse', 'HEAD'));
});

test('native HEAD recognizes a branch present only in packed-refs', t => {
    const root = fixture(t), ref = git(root, 'symbolic-ref', 'HEAD');
    git(root, 'pack-refs', '--all', '--prune');
    assert.equal(fs.existsSync(path.join(root, '.git', ref)), false);
    assert.equal(observedHead(root, 0), git(root, 'rev-parse', 'HEAD'));
});

test('native HEAD recognizes a detached HEAD', t => {
    const root = fixture(t), expected = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-ref', '--no-deref', 'HEAD', expected);
    assert.equal(observedHead(root, 0), expected);
});

for (const backend of ['config', 'directory'] as const) {
    test(`native HEAD falls back to the unchanged Git command for reftable ${backend}`, t => {
        const root = fixture(t);
        if (backend === 'config') fs.appendFileSync(path.join(root, '.git/config'), '\n[extensions]\nrefStorage = reftable\n');
        else fs.mkdirSync(path.join(root, '.git/reftable'));
        // Even when loose files look valid, only Git may interpret this backend.
        const expected = headOutcome(() => readHeadSha(root));
        assert.deepEqual(observedHeadOutcome(root, 1), expected);
    });
}

test('native HEAD delegates an unborn symbolic branch to Git and returns the same failure', t => {
    const root = fixture(t);
    git(root, 'symbolic-ref', 'HEAD', 'refs/heads/unborn');
    const expected = headOutcome(() => readHeadSha(root));
    assert.ok('error' in expected && /git rev-parse HEAD failed/u.test(expected.error));
    assert.deepEqual(observedHeadOutcome(root, 1), expected);
});

test('native HEAD delegates symbolic ref chains to Git', t => {
    const root = fixture(t), branch = git(root, 'symbolic-ref', 'HEAD');
    git(root, 'symbolic-ref', 'refs/heads/alias', branch);
    git(root, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
    assert.equal(observedHead(root, 1), git(root, 'rev-parse', 'HEAD'));
});

test('native HEAD never accepts malformed config just because loose refs look valid', t => {
    const root = fixture(t);
    fs.appendFileSync(path.join(root, '.git/config'), '\n[core]\neditor = "unterminated\n');
    assert.deepEqual(observedHeadOutcome(root, 1), headOutcome(() => readHeadSha(root)));
});

test('native HEAD retains the Git discovery environment through invocation exit', t => {
    const root = fixture(t), original = process.env.GIT_DIR;
    try {
        assert.throws(() => withInvocationReadObservation(() => {
            assert.ok(readHeadSha(root));
            process.env.GIT_DIR = path.join(root, 'foreign');
        }), /Git discovery environment changed/u);
    } finally {
        if (original === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = original;
    }
});

for (const change of ['HEAD', 'config', 'reftable'] as const) {
    test(`native HEAD rejects ${change} changes before invocation exit`, t => {
        const root = fixture(t);
        assert.throws(() => withInvocationReadObservation(() => {
            assert.ok(readHeadSha(root));
            const file = path.join(root, '.git', change);
            if (change === 'reftable') fs.mkdirSync(file);
            else fs.appendFileSync(file, '\n# changed\n');
        }), /observation changed|identity changed/iu);
    });
}

test('native HEAD delegates config includes and malformed packed refs instead of guessing', t => {
    const root = fixture(t), expected = git(root, 'rev-parse', 'HEAD');
    const config = path.join(root, '.git/config'), original = fs.readFileSync(config);
    fs.appendFileSync(config, '\n[include]\npath = absent.config\n');
    assert.equal(observedHead(root, 1), expected);
    fs.writeFileSync(config, original);
    git(root, 'pack-refs', '--all', '--prune');
    fs.appendFileSync(path.join(root, '.git/packed-refs'), 'invalid ref record\n');
    assert.deepEqual(observedHeadOutcome(root, 1), headOutcome(() => readHeadSha(root)));
});
