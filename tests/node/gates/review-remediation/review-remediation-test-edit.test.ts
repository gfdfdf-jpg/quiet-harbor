import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isAssertionOrCommentOnlyTestEdit } from '../../../../src/gates/review-remediation/review-remediation-test-edit';
import type { ReviewRemediationReadableDiffLine } from '../../../../src/gates/review-remediation/review-remediation-readable-diff';

function evidence(before: string, after: string): ReviewRemediationReadableDiffLine[] {
    const lines = (text: string) => text.split('\n');
    return [...lines(before).map((text, i) => ({ operation: 'deletion' as const, baseline_line: i + 1, current_line: null,
        segment_index: 1, segment_count: 1, text, source_line_sha256: createHash('sha256').update(text).digest('hex') })),
    ...lines(after).map((text, i) => ({ operation: 'addition' as const, baseline_line: null, current_line: i + 1,
        segment_index: 1, segment_count: 1, text, source_line_sha256: createHash('sha256').update(text).digest('hex') }))];
}

test('proves existing-test assertion and comment edits from complete source, including comment delimiters in strings', () => {
    for (const [file, before, after] of [
        ['tests/a.test.ts', 'test("a", () => {\nassert.equal(value, 1);\n});', 'test("a", () => {\nassert.equal(value, "// not a comment");\nassert.ok(value);\n});'],
        ['tests/A.java', 'class A {\nvoid test() { assertEquals(1, x); }\n}', 'class A {\n// fixed\nvoid test() { assertEquals(1, x); }\n}\n/* explanatory\ncomment */'],
        ['tests/test_a.py', 'def test_a():\n    assert x == 1', 'def test_a():\n    # fixed\n    assert x == 2\n    assert y == "# literal"']
    ]) assert.equal(isAssertionOrCommentOnlyTestEdit(file, evidence(before, after)), true, file);
});

test('rejects setup, case membership, control flow, assertion callbacks and code hidden by comment markers', () => {
    const before = 'test("a", () => {\nassert.equal(value, 1);\n});';
    for (const after of [
        before.replace('value, 1', 'value, 2') + '\nconst fixture = 2;',
        before.replace('test("a"', 'test("b"'),
        before.replace('assert.equal(value, 1);', 'if (value) assert.equal(value, 1);'),
        before.replace('assert.equal(value, 1);', 'assert.throws(() => { setup(); });'),
        before + '\nconst text = "//"; setup();',
        '/*\n' + before + '\n*/',
        before.replace('assert.equal(value, 1);', 'assert.equal(value = 2, 2);')
    ]) assert.equal(isAssertionOrCommentOnlyTestEdit('tests/a.test.ts', evidence(before, after)), false, after);
    assert.equal(isAssertionOrCommentOnlyTestEdit('tests/test_a.py', evidence('def test_a():\n    x = 1', 'def test_a():\nx = 1')), false);
});

test('missing, redacted, incomplete and malformed segmented source cannot prove preservation', () => {
    assert.equal(isAssertionOrCommentOnlyTestEdit('tests/a.test.ts'), false);
    const lines = evidence('assert.equal(x, 1);', 'assert.equal(x, 2);');
    lines[0].text = 'assert.equal(x, "<redacted>");';
    assert.equal(isAssertionOrCommentOnlyTestEdit('tests/a.test.ts', lines), false);
    const incomplete = evidence('const fixture = 1;\nassert.ok(x);', 'assert.ok(x);').slice(1);
    assert.equal(isAssertionOrCommentOnlyTestEdit('tests/a.test.ts', incomplete), false);
    const segmented = evidence('assert.ok(x);', 'assert.ok(y);');
    segmented[0].segment_count = 2;
    assert.equal(isAssertionOrCommentOnlyTestEdit('tests/a.test.ts', segmented), false);
});
