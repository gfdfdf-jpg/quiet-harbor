import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWalkReviewFix, walkRemediationEdits } from './engine/walk-remediation-script';

test('each failed lane and attempt selects its declared repair in a mixed sequence', () => {
    const production = [{ path: 'src/app.ts', append: '// production repair\n' }];
    const tests = [{ path: 'tests/app.test.ts', append: '// test repair\n' }];
    const script = { fix: production, remediationSequence: [
        { reviewType: 'api', attempt: 1, edits: production },
        { reviewType: 'test', attempt: 1, edits: tests },
        { reviewType: 'test', attempt: 2, edits: production }
    ] };
    assert.deepEqual(resolveWalkReviewFix(script, 'api', 1), production);
    assert.deepEqual(resolveWalkReviewFix(script, 'test', 1), tests);
    assert.deepEqual(resolveWalkReviewFix(script, 'test', 2), production);
    assert.deepEqual(walkRemediationEdits(script).map(edit => edit.path), ['src/app.ts', 'tests/app.test.ts', 'src/app.ts']);
    assert.throws(() => resolveWalkReviewFix(script, 'test', 3), /Missing scripted remediation/u,
        'An unmodeled repair must not silently repeat the fallback production fix.');
});

test('legacy repeated repairs retain their existing semantics', () => {
    const fix = [{ path: 'src/app.ts', append: '// fixed\n' }];
    assert.equal(resolveWalkReviewFix({ fix }, 'test', 7), fix);
    assert.equal(resolveWalkReviewFix({}, 'test', 1), undefined);
    assert.deepEqual(walkRemediationEdits({ fix }), fix);
    assert.deepEqual(walkRemediationEdits({}), []);
});

test('ambiguous or invalid remediation script entries fail before selecting an edit', () => {
    const repair = { reviewType: 'test', attempt: 1, edits: [] };
    assert.throws(() => resolveWalkReviewFix({ remediationSequence: [repair, repair] }, 'test', 1), /Duplicate/u);
    for (const invalid of [{ ...repair, attempt: 0 }, { ...repair, attempt: 1.5 }, { ...repair, reviewType: '' }])
        assert.throws(() => resolveWalkReviewFix({ remediationSequence: [invalid] }, 'test', 1), /Invalid/u);
});
