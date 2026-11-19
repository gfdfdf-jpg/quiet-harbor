import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import { copyContainedFile, ensureContainedDirectory } from '../../../src/core/contained-filesystem';

function fixture(t: TestContext): string {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-contained-directory-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function countLstat<T>(operation: () => T): { result: T; calls: number } {
    const nativeFs = require('node:fs') as Record<string, (...args: unknown[]) => unknown>;
    const original = nativeFs.lstatSync;
    let calls = 0;
    nativeFs.lstatSync = function (this: unknown, ...args: unknown[]): unknown {
        calls += 1;
        return Reflect.apply(original, this, args);
    };
    try {
        return { result: operation(), calls };
    } finally {
        nativeFs.lstatSync = original;
    }
}

function canCreateLinks(root: string): boolean {
    try {
        const target = path.join(root, 'link-probe-target');
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(root, 'link-probe'), 'junction');
        return true;
    } catch {
        return false;
    }
}

function inspectionsOfExistingChain(t: TestContext, depth: number): number {
    const root = fixture(t);
    const directory = path.join(root, ...Array.from({ length: depth }, (_, index) => `level-${index}`));
    fs.mkdirSync(directory, { recursive: true });
    const { calls } = countLstat(() => ensureContainedDirectory(root, directory));
    assert.ok(fs.statSync(directory).isDirectory());
    return calls;
}

test('an existing directory chain is inspected once per component instead of once per component and prefix', t => {
    const shallow = inspectionsOfExistingChain(t, 6);
    const deep = inspectionsOfExistingChain(t, 24);
    // Quadrupling the depth quadruples a linear count and multiplies a per-prefix count about tenfold.
    // The count per inspection differs by host (Windows without a volume id re-reads each identity); growth does not.
    assert.ok(deep < 6 * shallow, `expected linear growth, observed ${shallow} inspections at depth 6 and ${deep} at depth 24`);
});

test('missing components are created and the whole chain is re-checked before each creation', t => {
    const root = fixture(t);
    const created: string[] = [];
    ensureContainedDirectory(root, path.join(root, 'a', 'b', 'c'), (binding) => created.push(path.relative(root, binding.path)));
    assert.deepEqual(created, ['a', path.join('a', 'b'), path.join('a', 'b', 'c')]);
    assert.ok(fs.statSync(path.join(root, 'a', 'b', 'c')).isDirectory());
});

test('an ancestor replaced by a link while directories are being created is refused before the next creation', t => {
    const root = fixture(t);
    if (!canCreateLinks(root)) {
        t.skip('links cannot be created on this host');
        return;
    }
    fs.rmSync(path.join(root, 'link-probe'), { force: true });
    const outside = path.join(root, 'outside');
    // The link target already holds a/b/c's twin, so only the identity re-check can stop the next creation.
    fs.mkdirSync(path.join(outside, 'c'), { recursive: true });
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const nativeFs = require('node:fs') as Record<string, (...args: unknown[]) => unknown>;
    const originalMkdir = nativeFs.mkdirSync;
    let swapped = false;
    nativeFs.mkdirSync = function (this: unknown, ...args: unknown[]): unknown {
        const result = Reflect.apply(originalMkdir, this, args);
        if (!swapped) {
            swapped = true;
            // The first creation (a/b/c) has happened; move the bound ancestor away and put a link in its place.
            fs.renameSync(path.join(root, 'a', 'b'), path.join(root, 'a', 'b-moved'));
            fs.symlinkSync(outside, path.join(root, 'a', 'b'), 'junction');
        }
        return result;
    };
    try {
        assert.throws(
            () => ensureContainedDirectory(root, path.join(root, 'a', 'b', 'c', 'd')),
            /symlink or junction/u
        );
    } finally {
        nativeFs.mkdirSync = originalMkdir;
    }
    assert.equal(swapped, true);
    assert.deepEqual(fs.readdirSync(path.join(outside, 'c')), [], 'nothing may be created through the replaced ancestor');
});

test('a copied file keeps its bytes and source time after the directory and temporary-file checks', t => {
    const root = fixture(t);
    const source = path.join(root, 'source.txt');
    fs.writeFileSync(source, 'payload');
    const archiveTime = new Date('1985-10-26T08:15:00.000Z');
    fs.utimesSync(source, archiveTime, archiveTime);
    const destination = path.join(root, 'deep', 'er', 'copy.txt');
    copyContainedFile(root, source, destination);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'payload');
    assert.equal(fs.statSync(destination).mtimeMs, archiveTime.getTime());
    assert.deepEqual(fs.readdirSync(path.dirname(destination)), ['copy.txt']);
});
