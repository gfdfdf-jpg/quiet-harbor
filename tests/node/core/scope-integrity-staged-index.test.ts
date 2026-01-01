import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as git from '../../../src/core/git-helpers';
import { readStagedBlobFingerprints } from '../../../src/core/staged-index-fingerprints';
import { scopeGitFixture } from '../scope-integrity-fixtures';

// P3 / 508307a1: an unavailable or corrupt index is never empty authority.
test('P3 Git failure outside a worktree rejects a nonempty staged-fingerprint request', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-p3-no-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.throws(() => readStagedBlobFingerprints(root, ['src/app.ts']), /git .*ls-files.*failed/iu);
    assert.deepEqual([...readStagedBlobFingerprints(root, [])], [], 'no requested authority needs no Git query');
});

const oid = 'a'.repeat(40);
for (const [label, output] of [
    ['truncated NUL record', `100644 ${oid} 0\tsrc/app.ts`],
    ['bad object ID', '100644 invalid 0\tsrc/app.ts\0'],
    ['missing path separator', `100644 ${oid} 0 src/app.ts\0`],
    ['unmerged requested entry', `100644 ${oid} 2\tsrc/app.ts\0`],
    ['duplicate requested entry', `100644 ${oid} 0\tsrc/app.ts\0`.repeat(2)],
    ['empty interior record', `100644 ${oid} 0\tsrc/app.ts\0\0`]
] as const) {
    test(`P3 staged authority rejects ${label}`, t => {
        const query = t.mock.method(git, 'runGitBinary', () => Buffer.from(output));
        assert.throws(() => readStagedBlobFingerprints(os.tmpdir(), ['src/app.ts']), /authority|index|record|entry/iu);
        assert.equal(query.mock.callCount(), 1);
    });
}

test('P3 staged authority retains exact space and sensitive-looking path identities', t => {
    const root = scopeGitFixture(t);
    const file = 'src/auth/token space.ts';
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'export const auth = 1;\n');
    git.runGit(root, ['add', '--', file]);
    const before = readStagedBlobFingerprints(root, [file]);
    fs.writeFileSync(path.join(root, file), 'export const auth = 2;\n');
    assert.match(before.get(file) || '', /^staged:100644:[a-f0-9]{40,64}$/u);
    assert.deepEqual(readStagedBlobFingerprints(root, [file]), before);
});
