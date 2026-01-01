import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const { requiredFieldProducerTree, assertFieldProducerTreeAvailable } = require(path.resolve('scripts/ci/reference-stand-source-fixtures.cjs')) as {
    requiredFieldProducerTree: (source: string) => string;
    assertFieldProducerTreeAvailable: (root: string) => string;
};
const pin = (tree: string) => `export const FIELD_LEGACY_GARDA_TREE = '${tree}';\n`;
const pinFile = 'tests/node/synthetic/engine/walk-field-cases.ts';

test('reserve fixture pin refuses missing, ambiguous and non-literal producer identities', () => {
    const tree = 'a'.repeat(40);
    assert.equal(requiredFieldProducerTree(pin(tree)), tree);
    assert.throws(() => requiredFieldProducerTree(''), /exactly one/u);
    assert.throws(() => requiredFieldProducerTree(pin(tree) + pin(tree)), /exactly one/u);
    assert.throws(() => requiredFieldProducerTree(pin('main')), /literal/u);
    assert.throws(() => requiredFieldProducerTree(pin('a'.repeat(39))), /literal/u);
});

test('a parentless reserve snapshot must carry the exact pinned tree, without exporting repository history', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-ci-field-tree-'));
    const source = path.join(parent, 'source'); fs.mkdirSync(source);
    const git = (cwd: string, args: string[], input?: string) => execFileSync('git', args, {
        cwd, encoding: 'utf8', windowsHide: true, input, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const commit = (tree: string, predecessor?: string) => git(source,
        ['-c', 'user.name=Garda fixture', '-c', 'user.email=tests@example.invalid', 'commit-tree', tree,
            ...(predecessor ? ['-p', predecessor] : [])], 'Isolated native source-fixture control\n');
    try {
        git(source, ['init', '--quiet']);
        fs.writeFileSync(path.join(source, 'producer.txt'), 'Required historical producer\n');
        git(source, ['add', '.']); const historical = git(source, ['write-tree']);
        fs.writeFileSync(path.join(source, 'producer.txt'), 'Wrong historical producer\n');
        git(source, ['add', '.']); const wrong = git(source, ['write-tree']);
        fs.mkdirSync(path.dirname(path.join(source, pinFile)), { recursive: true });
        fs.writeFileSync(path.join(source, pinFile), pin(historical));
        git(source, ['add', '.']); const candidate = git(source, ['write-tree']);
        git(source, ['update-ref', 'refs/heads/bad', commit(candidate, commit(wrong))]);
        git(source, ['update-ref', 'refs/heads/good', commit(candidate, commit(historical))]);
        for (const branch of ['bad', 'good']) {
            const checkout = path.join(parent, branch);
            git(parent, ['clone', '--quiet', '--no-local', '--single-branch', '--branch', branch, source, checkout]);
            assert.equal(git(checkout, ['rev-list', '--all', '--count']), '2');
            const before = git(checkout, ['status', '--porcelain']);
            if (branch === 'bad') assert.throws(() => assertFieldProducerTreeAvailable(checkout), new RegExp(historical + ' is unavailable', 'u'));
            else assert.equal(assertFieldProducerTreeAvailable(checkout), historical);
            assert.equal(git(checkout, ['status', '--porcelain']), before, 'The preflight only reads the snapshot.');
        }
        const wrongType = git(source, ['rev-parse', 'refs/heads/good']);
        fs.writeFileSync(path.join(source, pinFile), pin(wrongType));
        assert.throws(() => assertFieldProducerTreeAvailable(source), /must be a tree, found commit/u);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
