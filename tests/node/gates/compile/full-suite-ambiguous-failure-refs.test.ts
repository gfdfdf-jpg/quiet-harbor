import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_FULL_SUITE_VALIDATION_CONFIG } from '../../../../src/core/full-suite-validation-config';
import { buildValidationResult, detectOutOfScopeFailures } from '../../../../src/gates/full-suite/full-suite-validation-results';

const config = { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG, enabled: true, command: 'gradlew :app:test --tests example.OrdersTest' };
const artifact = 'runtime/logs/selected-tests.log';

describe('failure references without a repository path', () => {
    for (const [extension, language] of [['java', 'java'], ['kt', 'kotlin']]) {
        const own = `app/src/test/${language}/example/OrdersTest.${extension}`;
        const basename = `OrdersTest.${extension}`;
        const output = ['> Task :app:test', `${basename} > taskContract FAILED`];

        it(`keeps the selected ${language} failure blocking without declaring its basename outside`, t => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-basename-scope-'));
            t.after(() => fs.rmSync(root, { recursive: true, force: true }));
            // The same basename can belong to the task, another module or the repository root.
            for (const file of [own, `other/src/test/${language}/example/${basename}`, basename]) {
                fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
                fs.writeFileSync(path.join(root, file), '// test source\n');
            }
            for (const repoRoot of [undefined, root]) {
                for (const policy of ['AUDIT_AND_BLOCK', 'AUDIT_AND_WARN'] as const) {
                    const result = buildValidationResult({ ...config, out_of_scope_failure_policy: policy },
                        1, false, output, artifact, [own], undefined, repoRoot);
                    assert.equal(result.status, 'FAILED');
                    assert.equal(result.out_of_scope_failure_detected, false);
                    assert.deepEqual(result.out_of_scope_failure_refs, []);
                    assert.equal(result.out_of_scope_audit_verdict, 'NOT_APPLICABLE');
                    assert.equal(result.output_artifact_path, artifact);
                    assert.deepEqual(result.failure_chunks, [output]);
                    assert.equal(detectOutOfScopeFailures(output, [own], repoRoot), false);
                }
            }
        });

        it(`does not infer an unrelated ${language} failure from an unresolved basename`, () => {
            const result = buildValidationResult({ ...config, out_of_scope_failure_policy: 'AUDIT_AND_WARN' },
                1, false, output, artifact, [`app/src/main/${language}/example/Orders.${extension}`]);
            assert.equal(result.status, 'FAILED');
            assert.equal(result.out_of_scope_failure_detected, false);
            assert.deepEqual(result.out_of_scope_failure_refs, []);
            assert.deepEqual(result.failure_chunks, [output]);
        });
    }

    it('does not downgrade a mixed attributed and unresolved failure to a warning', () => {
        const result = buildValidationResult({ ...config, out_of_scope_failure_policy: 'AUDIT_AND_WARN' },
            1, false, ['FAIL at other/DebtTest.java:10', 'OrdersTest.java > taskContract FAILED'],
            artifact, ['app/src/test/java/example/OrdersTest.java']);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.out_of_scope_failure_detected, true);
        assert.deepEqual(result.out_of_scope_failure_refs, ['other/DebtTest.java']);
    });

    it('does not treat an unresolved basename and a lock timeout as an outside harness failure', () => {
        const result = buildValidationResult(config, 1, true, [
            'FAIL at other/DebtTest.java:10',
            'OrdersTest.java > taskContract FAILED',
            'WARNING: task-event append failed: Timed out acquiring file lock: runtime/task-events/.T-001.lock;',
            'Process timed out after 600000 ms.'
        ], artifact, ['app/src/test/java/example/OrdersTest.java']);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.harness_failure_detected, false);
    });

    it('retains full path attribution and an exact task match at the repository root', () => {
        const own = 'app/src/test/java/example/OrdersTest.java';
        for (const ref of [own, own.replaceAll('/', '\\')]) {
            assert.equal(detectOutOfScopeFailures([`FAIL at ${ref}:10`], [own]), false);
        }
        for (const ref of ['other/src/test/java/example/OrdersTest.java', 'other/DebtTest.java']) {
            const result = buildValidationResult({ ...config, out_of_scope_failure_policy: 'AUDIT_AND_WARN' },
                1, false, [`FAIL at ${ref}:10`], artifact, [own]);
            assert.equal(result.status, 'WARNED');
            assert.equal(result.out_of_scope_failure_detected, true);
            assert.deepEqual(result.out_of_scope_failure_refs, [ref]);
        }
        assert.equal(detectOutOfScopeFailures(['OrdersTest.java > taskContract FAILED'], ['OrdersTest.java']), false);
    });

    it('preserves an unattributed broad failure and its output artifact', () => {
        const output = ['worker 7f3a: repository audit', '3 checks broke in an unrelated resource boundary'];
        const result = buildValidationResult({ ...config, command: 'gradlew test' }, 1, false,
            output, artifact, ['app/src/test/java/example/OrdersTest.java']);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.command, 'gradlew test');
        assert.equal(result.output_artifact_path, artifact);
        assert.deepEqual(result.failure_chunks, [output]);
        assert.equal(result.out_of_scope_failure_detected, false);
        assert.deepEqual(result.out_of_scope_failure_refs, []);
    });
});
