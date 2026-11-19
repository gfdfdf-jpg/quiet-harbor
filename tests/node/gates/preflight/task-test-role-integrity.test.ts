import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange } from '../../../../src/gates/preflight/classify-change';
import { resolveReviewReuseClassificationConfig } from '../../../../src/gates/review-reuse/review-reuse';
import { isTestScopePath } from '../../../../src/core/file-role-bindings';
import { makeConfig, defaultCapabilities } from './classify-change-test-support';

for (const source of ['src/engine.qz', 'src/api/performance/engine.ts', 'product/engine.qz']) {
    test(`declaring ${source} as a test preserves its product classification and review lanes`, () => {
        const config = makeConfig({ file_roles: source.startsWith('product/') ? { [source]: 'source' as const } : {},
            refactor_trigger_regexes: ['engine'], api_trigger_regexes: ['engine'],
            performance_trigger_regexes: ['engine'] });
        const options = { normalizedFiles: [source, 'tests/engine.qt'], taskIntent: 'Require security review for engine authorization boundary',
            classificationConfig: config, reviewCapabilities: defaultCapabilities, changedLinesTotal: 20 };
        const original = classifyChange(options);
        const declared = classifyChange({ ...options, declaredTestPaths: [source, 'tests/engine.qt'] });
        assert.equal(original.required_reviews.code, true);
        assert.notEqual(declared.scope_category, 'test-only');
        for (const lane of ['code', 'api', 'performance', 'refactor', 'security']) {
            assert.equal(declared.required_reviews[lane], original.required_reviews[lane], lane);
            assert.equal(declared.required_reviews[lane], true, lane);
        }
        const reused = resolveReviewReuseClassificationConfig({ declared_test_paths: [source, 'qa/engine.qt'] }, '/repo', config);
        assert.equal(isTestScopePath(source, reused.test_trigger_regexes, reused.file_roles), false);
        assert.equal(isTestScopePath('qa/engine.qt', reused.test_trigger_regexes, reused.file_roles), true);
    });
}

test('task tests with an unknown stack outside product scope remain admissible without a global regex', () => {
    const result = classifyChange({ normalizedFiles: ['qa/engine.qt'], declaredTestPaths: ['qa/engine.qt'],
        classificationConfig: makeConfig(), reviewCapabilities: defaultCapabilities });
    assert.equal(result.scope_category, 'test-only');
    assert.equal(result.required_reviews.test, true);
});
