import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// Test the preload's ordering without another complete review cell or a 30 s sleep.
function harness() {
    const source = fs.readFileSync('tests/node/repo/fixtures/matrix-owner-publication.cjs', 'utf8');
    const root = path.resolve('owner-hook-fixture');
    const marker = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-WALK-full-suite-run-marker.json');
    const control = path.join(root, '.git/matrix-marker-observed');
    const pending = marker + '.pending';
    const files = new Map<string, string>([
        [marker, JSON.stringify({ gate_pid: 1, child_pid: null })],
        [pending, JSON.stringify({ gate_pid: 1, child_pid: 99 })],
        [path.join(root, '.git/matrix-tests-ready'), 'ready']
    ]);
    function load(role: 'parent' | 'owner' | 'contender', rejectRename = false) {
        const io = {
            readFileSync: (file: string, encoding?: string) => {
                const value = files.get(file);
                assert.notEqual(value, undefined, 'read existing fixture file: ' + file);
                return encoding ? value! : Buffer.from(value!);
            },
            writeFileSync: (file: string, bytes: string) => { files.set(file, String(bytes)); },
            appendFileSync: (file: string, bytes: string) => { files.set(file, (files.get(file) || '') + bytes); },
            existsSync: (file: string) => files.has(file),
            renameSync: (from: string, to: string) => {
                if (rejectRename) throw Object.assign(new Error('publication refused'), { code: 'EPERM' });
                files.set(to, files.get(from)!);
                files.delete(from);
            }
        };
        let clock = 0;
        vm.runInNewContext(source, {
            require: (name: string) => {
                if (name === 'node:fs') return io;
                if (name === 'node:path') return path;
                assert.equal(name, './matrix-current-build.cjs');
                return {};
            },
            process: { pid: role === 'owner' ? 1 : 2, cwd: () => root,
                argv: [process.execPath, role === 'parent' ? 'review-matrix.cjs' : role === 'owner' ? 'walk-native-owner.js' : 'main.js',
                    ...role === 'contender' ? ['gate', 'full-suite-validation'] : []],
                env: { GARDA_MATRIX_OWNER_LOG: path.join(root, '.git/handshake.jsonl') } },
            performance: { now: () => { clock += 15_000; return clock; } },
            Atomics: { wait: () => undefined }, Int32Array, SharedArrayBuffer
        });
        return io;
    }
    return { files, marker, control, pending, load };
}

test('publication hook returns the old observation before requiring the owner to complete publication', () => {
    const h = harness(), observer = h.load('parent'), owner = h.load('owner');
    // Publication is scheduled after this read returns. Waiting inside readFileSync
    // prevents releasing the observer's surrounding operation/event-loop turn.
    const before = observer.readFileSync(h.marker, 'utf8');
    assert.equal(JSON.parse(String(before)).child_pid, null);
    assert.ok(h.files.has(h.control));
    owner.renameSync(h.pending, h.marker);
    assert.ok(h.files.has(h.control + '.published'));
    h.load('contender');
    const after = observer.readFileSync(h.marker, 'utf8');
    assert.equal(JSON.parse(String(after)).child_pid, 99);
    assert.notEqual(before, after, 'the stale before snapshot must still fail byte preservation');
});

test('publication hook refuses the contender if the actual owner failed to publish', () => {
    const h = harness();
    h.files.set(h.control, 'observed');
    const owner = h.load('owner', true);
    assert.throws(() => owner.renameSync(h.pending, h.marker), /publication refused/u);
    assert.equal(h.files.has(h.control + '.published'), false);
    assert.throws(() => h.load('contender'), /handshake timed out/u);
    assert.equal(JSON.parse(h.files.get(h.marker)!).child_pid, null);
});
