import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { readInvocationPathObservation, observedInvocationValue, readInvocationTextFile } from '../../../../src/core/invocation-file-observation';
import { readNativeRealpath } from '../../../../src/core/paths';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { currentProcessOwnsReviewTransactionLock, resolveReviewTransactionLockPath, resolveCanonicalReviewsDirectoryPath, readCurrentReviewArtifactIndexEntry } from '../../../../src/gate-runtime/review/reviews-index';
import { withReviewArtifactReadBarrier, writeReviewArtifactText } from '../../../../src/gate-runtime/review/review-artifacts';

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repeated-reads-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reviews = path.join(root, 'runtime', 'reviews');
    fs.mkdirSync(reviews, { recursive: true });
    const lock = resolveReviewTransactionLockPath(reviews), owner = path.join(lock, 'owner.json');
    const writeOwner = (lockId = 'first') => {
        fs.mkdirSync(lock, { recursive: true });
        fs.writeFileSync(owner, JSON.stringify({ lock_id: lockId, pid: process.pid, hostname: os.hostname(), created_at_utc: '2026-01-01T00:00:00Z' }));
    };
    return { root, reviews, lock, owner, writeOwner };
}

function measure(action: () => void): NextStepMeasurement {
    let result: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(action), value => { result = value; });
    return result!;
}

test('repeated owner checks read once and retain a final freshness inspection', t => {
    const { reviews, owner, writeOwner } = fixture(t);
    writeOwner();
    for (let invocation = 0; invocation < 2; invocation++) {
        const result = measure(() => {
            for (let repeat = 0; repeat < 18; repeat++) assert.equal(currentProcessOwnsReviewTransactionLock(reviews), true);
        });
        assert.equal(result.work['payload_read:' + owner], 2, 'one initial inspection and one final inspection');
    }
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(currentProcessOwnsReviewTransactionLock(reviews), true);
        writeOwner('replacement');
        assert.equal(currentProcessOwnsReviewTransactionLock(reviews), true);
    }), /Review transaction ownership changed/u);
    assert.equal(currentProcessOwnsReviewTransactionLock(reviews), true);
});

test('absent lock ownership cannot be rebaselined inside an invocation', t => {
    const { reviews, owner, writeOwner } = fixture(t);
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(currentProcessOwnsReviewTransactionLock(reviews), false);
        writeOwner();
        assert.equal(currentProcessOwnsReviewTransactionLock(reviews), false);
    }), /Review transaction ownership changed/u);
    assert.equal(currentProcessOwnsReviewTransactionLock(reviews), true);
    fs.unlinkSync(owner);
    assert.equal(currentProcessOwnsReviewTransactionLock(reviews), false, 'action readers outside the observation stay fresh');
});

test('non-link path captures reuse their lstat metadata for the target', t => {
    const { root } = fixture(t), file = path.join(root, 'TASK.md');
    fs.writeFileSync(file, 'task bytes');
    const expected = fs.statSync(file), nativeFs = require('node:fs') as { statSync: typeof fs.statSync };
    const original = nativeFs.statSync;
    let targetStats = 0;
    nativeFs.statSync = function (this: unknown, ...args: unknown[]) {
        if (args[0] === file) targetStats++;
        return Reflect.apply(original, this, args);
    } as typeof fs.statSync;
    try {
        measure(() => {
            for (let repeat = 0; repeat < 18; repeat++) {
                const observed = readInvocationPathObservation(file)!;
                const target = observedInvocationValue(observed.targetStat);
                assert.equal(target.ino, expected.ino);
                assert.equal(target.size, expected.size);
                assert.equal(target.mtimeMs, expected.mtimeMs);
            }
        });
    } finally { nativeFs.statSync = original; }
    assert.equal(targetStats, 0, 'ordinary paths need no separate followed-target stat');
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(readInvocationTextFile(file), 'task bytes');
        const replacement = file + '.replacement';
        fs.writeFileSync(replacement, 'task bytes');
        fs.renameSync(replacement, file);
    }), /Invocation file observation changed/u);
});

test('canonical review root and native file paths reuse observed resolutions', t => {
    const { root, reviews } = fixture(t), file = path.join(root, 'TASK.md');
    fs.writeFileSync(file, 'task bytes');
    const expected = fs.realpathSync.native(reviews);
    const nativeFs = require('node:fs') as typeof fs, original = nativeFs.realpathSync.native;
    let resolutions = 0;
    nativeFs.realpathSync.native = function (this: unknown, ...args: unknown[]) {
        if (args[0] === reviews) resolutions++;
        return Reflect.apply(original, this, args);
    } as typeof fs.realpathSync.native;
    let result: NextStepMeasurement;
    try {
        result = measure(() => {
            for (let repeat = 0; repeat < 18; repeat++) {
                assert.equal(resolveCanonicalReviewsDirectoryPath(reviews), expected);
                readInvocationPathObservation(file);
                assert.equal(readNativeRealpath(file), fs.realpathSync.native(file));
            }
        });
    } finally { nativeFs.realpathSync.native = original; }
    if (fs.lstatSync(reviews).dev !== 0) assert.equal(resolutions, 2, 'capture and final validation only');
    if (process.platform === 'win32') assert.equal(result.work['native_realpath_observation:' + file] || 0, 0,
        'the regular-file path observation already captured native realpath');
});


test('exact membership probes are shared while returned entries remain independent', t => {
    const { reviews } = fixture(t), fileName = 'T-READ-code.md', file = path.join(reviews, fileName);
    fs.writeFileSync(file, 'review bytes');
    const result = measure(() => {
        for (let repeat = 0; repeat < 18; repeat++) {
            const entry = readCurrentReviewArtifactIndexEntry(reviews, 'T-READ', fileName);
            assert.ok(entry && !('nativeFallback' in entry));
            assert.equal(entry.fileName, fileName);
            entry.fileName = 'caller mutation';
        }
    });
    assert.equal(result.work.review_index_current_entry, 1);
    assert.equal(result.work.review_index_current_directory_probe, 1);
    assert.throws(() => withInvocationReadObservation(() => {
        assert.ok(readCurrentReviewArtifactIndexEntry(reviews, 'T-READ', fileName));
        const replacement = file + '.replacement';
        fs.writeFileSync(replacement, 'review bytes');
        fs.renameSync(replacement, file);
    }), /Invocation file observation changed/u);
    assert.ok(readCurrentReviewArtifactIndexEntry(reviews, 'T-READ', fileName));
});

test('descriptor binding rejects a same-byte replacement immediately before open', t => {
    const { root } = fixture(t), file = path.join(root, 'TASK.md'), replacement = file + '.replacement';
    fs.writeFileSync(file, 'task bytes');
    fs.writeFileSync(replacement, 'task bytes');
    const nativeFs = require('node:fs') as typeof fs, original = nativeFs.openSync;
    let replaced = false;
    nativeFs.openSync = function (this: unknown, ...args: unknown[]) {
        if (args[0] === file && !replaced) {
            replaced = true;
            fs.renameSync(replacement, file);
        }
        return Reflect.apply(original, this, args);
    } as typeof fs.openSync;
    try {
        assert.throws(() => withInvocationReadObservation(() => readInvocationTextFile(file)),
            /Invocation descriptor does not match observed file/u);
    } finally { nativeFs.openSync = original; }
    assert.equal(replaced, true);
});


test('settling a foreign lock before generation acquisition preserves non-ownership', t => {
    const { reviews, owner, lock } = fixture(t);
    fs.mkdirSync(lock);
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, hostname: 'foreign-host.invalid', created_at_utc: '2026-01-01T00:00:00Z' }));
    withInvocationReadObservation(() => {
        assert.equal(currentProcessOwnsReviewTransactionLock(reviews), false);
        fs.unlinkSync(owner);
        fs.rmdirSync(lock);
        assert.equal(currentProcessOwnsReviewTransactionLock(reviews), false);
    });
});

test('an owned lock heartbeat can advance without changing its generation', t => {
    const { reviews, owner, writeOwner } = fixture(t);
    writeOwner();
    const metadata = JSON.parse(fs.readFileSync(owner, 'utf8')) as Record<string, unknown>;
    withInvocationReadObservation(() => {
        assert.equal(currentProcessOwnsReviewTransactionLock(reviews), true);
        fs.writeFileSync(owner, JSON.stringify({ ...metadata, heartbeat_at_utc: '2026-01-01T00:01:00Z' }));
        assert.equal(currentProcessOwnsReviewTransactionLock(reviews), true);
    });
});


test('nested and sequential barriers share one invocation generation and final check', t => {
    const { reviews, owner } = fixture(t);
    const run = (count: number) => measure(() => {
        for (let index = 0; index < count; index++) {
            withReviewArtifactReadBarrier(reviews, () => withReviewArtifactReadBarrier(reviews, () => undefined));
        }
    });
    const single = run(1), repeated = run(6);
    assert.ok((single.work['payload_read:' + owner] || 0) > 0, 'the generation locks must retain live owner checks');
    assert.equal(repeated.work['payload_read:' + owner], single.work['payload_read:' + owner]);
    assert.throws(() => withInvocationReadObservation(() => {
        withReviewArtifactReadBarrier(reviews, () => undefined);
        fs.writeFileSync(path.join(reviews, 'reviews-index.json'), '{"version":0}');
        withReviewArtifactReadBarrier(reviews, () => undefined);
    }), /Review artifact read snapshot was invalidated/u);
});

test('a stale shared generation cannot authorize an intervening publication', t => {
    const { reviews } = fixture(t), target = path.join(reviews, 'T-READ-code.md');
    let refused = false;
    assert.throws(() => withInvocationReadObservation(() => withReviewArtifactReadBarrier(reviews, () => {
        withReviewArtifactReadBarrier(reviews, () => undefined);
        fs.writeFileSync(path.join(reviews, 'reviews-index.json'), '{"version":0}');
        try { writeReviewArtifactText(target, 'must not publish'); }
        catch (error: unknown) {
            assert.match(String(error), /Review artifact read snapshot was invalidated/u);
            refused = true;
        }
    })), /Review artifact read snapshot was invalidated/u);
    assert.equal(refused, true);
    assert.equal(fs.existsSync(target), false);
});

test('independent concurrent barriers still reject a changed generation', async t => {
    const { reviews } = fixture(t);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = withReviewArtifactReadBarrier(reviews, async () => { await hold; });
    const second = withReviewArtifactReadBarrier(reviews, async () => { await hold; });
    fs.writeFileSync(path.join(reviews, 'reviews-index.json'), '{"version":0}');
    release();
    await Promise.all([
        assert.rejects(first, /Review artifact read snapshot was invalidated/u),
        assert.rejects(second, /Review artifact read snapshot was invalidated/u)
    ]);
});

test('a detached participant checks freshness after its invocation closes', async t => {
    const { reviews } = fixture(t);
    let release!: () => void, detached!: Promise<void>;
    const hold = new Promise<void>(resolve => { release = resolve; });
    withInvocationReadObservation(() => {
        detached = withReviewArtifactReadBarrier(reviews, async () => { await hold; });
    });
    fs.writeFileSync(path.join(reviews, 'reviews-index.json'), '{"version":0}');
    release();
    await assert.rejects(detached, /Review artifact read snapshot was invalidated/u);
});


test('released invocation generations still guard writes against intervening changes', t => {
    const { reviews } = fixture(t), target = path.join(reviews, 'T-READ-code.md');
    let refused = false;
    assert.throws(() => withInvocationReadObservation(() => {
        withReviewArtifactReadBarrier(reviews, () => {
            fs.writeFileSync(path.join(reviews, 'reviews-index.json'), '{"version":0}');
        });
        try { writeReviewArtifactText(target, 'must not publish'); }
        catch (error: unknown) {
            assert.match(String(error), /Review artifact read snapshot was invalidated/u);
            refused = true;
        }
    }), /Review artifact read snapshot was invalidated/u);
    assert.equal(refused, true);
    assert.equal(fs.existsSync(target), false);
});


test('write authority resolves a retargeted review root live', t => {
    const { root, reviews } = fixture(t);
    const alias = path.join(root, 'review-alias'), replacement = path.join(root, 'other-reviews');
    fs.mkdirSync(replacement);
    try { fs.symlinkSync(reviews, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error: unknown) { t.skip('Directory aliases unavailable: ' + String(error)); return; }
    let refused = false;
    assert.throws(() => withInvocationReadObservation(() => {
        withReviewArtifactReadBarrier(alias, () => undefined);
        if (process.platform === 'win32') fs.rmdirSync(alias);
        else fs.unlinkSync(alias);
        fs.symlinkSync(replacement, alias, process.platform === 'win32' ? 'junction' : 'dir');
        try { writeReviewArtifactText(path.join(alias, 'T-READ-code.md'), 'must not publish'); }
        catch (error: unknown) {
            assert.match(String(error), /Review artifact read snapshot was invalidated/u);
            refused = true;
        }
    }), /changed|invalidated/iu);
    assert.equal(refused, true);
    assert.equal(fs.existsSync(path.join(replacement, 'T-READ-code.md')), false);
});
