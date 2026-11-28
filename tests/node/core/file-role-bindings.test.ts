import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTaskTestFileRoles, createTaskTestScopeMatcher, declaredFileRole, isTestScopePath, mergeFileRoleBindings, normalizeFileRoleBindings } from '../../../src/core/file-role-bindings';

test('captured task test roles reach review consumers without the global configuration limit', () => {
    const base = normalizeFileRoleBindings({ 'product/source.unfamiliar': 'source' });
    const targets = Array.from({ length: 5000 }, (_, index) => `qa/${index}.case`);
    const roles = bindTaskTestFileRoles(base, targets);
    assert.equal(Object.keys(roles).length, 5001);
    assert.ok(targets.every(target => isTestScopePath(target, [], roles)));
    assert.deepEqual(Object.keys(base), ['product/source.unfamiliar']);
    assert.throws(() => bindTaskTestFileRoles(base, ['product/source.unfamiliar']), /Conflicting/u);
    assert.throws(() => bindTaskTestFileRoles(base, ['../escape.case']), /relative|traversal|path/iu);
});

test('task-local tests and support roles need no global extension or directory rule', () => {
    const matches = createTaskTestScopeMatcher(['(^|/)tests/'], {}, ['qa/purchase.assert'], ['tests/helper.case', 'tests/data.bin']);
    assert.equal(matches('qa/purchase.assert'), true);
    assert.equal(matches('tests/helper.case'), false);
    assert.equal(matches('tests/data.bin'), false);
    assert.equal(matches('tests/ordinary.case'), true);
    assert.equal(matches('qa/not-declared.assert'), false);
});

test('explicit source and test roles take precedence over name guesses using exact literal paths', () => {
    const roles = normalizeFileRoleBindings({ 'docs/view.mdx': 'source', 'tests/rules.yaml': 'source',
        'quality/purchase.case': 'test', 'quality/购买': 'test', 'quality/a+b.case': 'test' });
    assert.equal(isTestScopePath('tests/rules.yaml', ['(^|/)tests/'], roles), false);
    assert.equal(isTestScopePath('quality/purchase.case', [], roles), true);
    assert.equal(declaredFileRole('quality/购买', roles), 'test');
    assert.equal(declaredFileRole('quality/ab.case', roles), undefined);
    assert.equal(declaredFileRole('docs/view.mdx.backup', roles), undefined);
    assert.equal(declaredFileRole('QUALITY/PURCHASE.CASE', roles), process.platform === 'win32' ? 'test' : undefined);
    assert.equal(isTestScopePath('tests/conventional.ts', ['(^|/)tests/'], roles), true);
});

test('rejects malformed, escaping, conflicting and oversized role declarations without dropping entries', () => {
    for (const value of [null, [], { '../source.md': 'source' }, { './source.md': 'source' },
        { '/source.md': 'source' }, { 'C:/source.md': 'source' }, { 'source.md': 'docs' },
        { 'source.md': '' }, { 'source\n.md': 'source' }]) {
        assert.throws(() => normalizeFileRoleBindings(value));
    }
    assert.throws(() => normalizeFileRoleBindings(Object.fromEntries(
        Array.from({ length: 1025 }, (_, index) => [`source-${index}`, 'source']))));
    assert.throws(() => mergeFileRoleBindings({ 'same.path': 'source' }, { 'same.path': 'test' }), /Conflicting/u);
    assert.deepEqual(mergeFileRoleBindings({ 'same.path': 'source' }, { 'same.path': 'source' }), { 'same.path': 'source' });
    const special = normalizeFileRoleBindings(JSON.parse('{"__proto__":"source"}'));
    assert.equal(declaredFileRole('__proto__', special), 'source');
    assert.equal(declaredFileRole('constructor', special), undefined);
});
