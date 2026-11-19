import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectFullSuiteValidationEvidence } from '../../../../src/gates/completion/completion-full-suite-evidence';
import { getChangedTestPaths, getFullSuiteTestSelectionViolations } from '../../../../src/gates/full-suite/full-suite-test-selection';

describe('current task test selection', () => {
    it('keeps declared test roles mandatory and honors an explicit source role over filename patterns', t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-declared-test-selection-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const config = path.join(root, 'garda-agent-orchestrator/live/config');
        fs.mkdirSync(config, { recursive: true });
        fs.writeFileSync(path.join(config, 'paths.json'), JSON.stringify({ file_roles: {
            'checks/order.case': 'test', 'checks/old.case': 'test', 'tests/source.test.ts': 'source'
        } }));
        for (const file of ['checks/order.case', 'tests/source.test.ts']) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), '// repository-defined role\n');
        }
        assert.deepEqual(getChangedTestPaths(root, ['checks/order.case', 'tests/source.test.ts']), ['checks/order.case']);
        const violations = getFullSuiteTestSelectionViolations(root, 'node --test checks/old.case', ['checks/order.case']);
        assert.equal(violations.length, 1);
        assert.ok(violations[0].includes('checks/order.case'));
        assert.deepEqual(getFullSuiteTestSelectionViolations(root, 'node --test checks/order.case', ['checks/order.case']), []);
    });
    it('rejects both assignment and separate-argument skip selectors even without changed tests', t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-skip-selection-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        for (const command of ['node --test --test-skip-pattern=widget', 'node --test --test-skip-pattern widget',
            'pytest --deselect=tests/test_widget.py::test_widget', 'mvn verify -DskipTests']) {
            assert.ok(getFullSuiteTestSelectionViolations(root, command, []).some(value => value.includes('skips tests')), command);
        }
        assert.deepEqual(getFullSuiteTestSelectionViolations(root, 'mvn verify -DskipTests=false', []), []);
    });
    it('rejects the OnlineStore previous-task selector instead of accepting its green exit', t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-test-selection-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const files = ['backend/partners-module/src/test/java/com/example/PartnerCustomerCrmServiceTest.java',
            'backend/application/src/test/java/com/example/PartnerCustomerCrmPostgresIntegrationTest.java'];
        for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), '// test'); }
        const rejected = getFullSuiteTestSelectionViolations(root,
            'backend/mvnw.cmd -f backend/pom.xml -pl partners-module -am test "-Dtest=PartnerWebConfigTest" -Dsurefire.failIfNoSpecifiedTests=false', files);
        assert.equal(rejected.length, 1);
        for (const file of files) assert.ok(rejected[0].includes(file));
        assert.deepEqual(getFullSuiteTestSelectionViolations(root,
            'backend/mvnw.cmd -f backend/pom.xml -pl application -am test -Dtest=PartnerCustomerCrmServiceTest,PartnerCustomerCrmPostgresIntegrationTest', files), []);
    });
    it('rejects stale explicit selections for Node and Python without treating broad or opaque runners as verified coverage', t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-test-selection-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        fs.mkdirSync(path.join(root, 'tests'));
        for (const file of ['current.test.ts', 'test_current.py']) fs.writeFileSync(path.join(root, 'tests', file), '// test');
        for (const [command, file] of [['node --test tests/old.test.ts', 'tests/current.test.ts'],
            ['pytest tests/test_old.py', 'tests/test_current.py'],
            ['python -m pytest tests/test_old.py::test_old', 'tests/test_current.py']]) {
            assert.equal(getFullSuiteTestSelectionViolations(root, command, [file]).length, 1, command);
        }
        for (const command of ['node --test tests/current.test.ts', 'node --test', 'npm test', 'tools/suite.cmd'])
            assert.deepEqual(getFullSuiteTestSelectionViolations(root, command, ['tests/current.test.ts']), [], command);
        assert.deepEqual(getFullSuiteTestSelectionViolations(root, 'pytest tests/test_old.py', ['docs/README.md']), []);
        assert.deepEqual(getFullSuiteTestSelectionViolations(root, 'node --test tests/current.test.ts', ['tests/deleted.test.ts']), []);
    });
});


it('completion rejects a retained PASS that selected a different task test', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-test-selection-completion-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tests')); fs.writeFileSync(path.join(root, 'tests/current.test.ts'), '// test');
    const preflight = path.join(root, 'preflight.json');
    fs.writeFileSync(preflight, JSON.stringify({ task_id: 'T-CURRENT', changed_files: ['tests/current.test.ts'] }));
    fs.writeFileSync(path.join(root, 'T-CURRENT-full-suite-validation.json'), JSON.stringify({ status: 'PASSED', enabled: true,
        command: 'node --test tests/old.test.ts', exit_code: 0 }));
    const errors: string[] = [];
    const result = collectFullSuiteValidationEvidence({ enabled: true, required: true, reviewsRoot: root,
        taskId: 'T-CURRENT', repoRoot: root, timelinePath: path.join(root, 'events.jsonl'),
        orderedEvents: [{ event_type: 'FULL_SUITE_VALIDATION_PASSED', outcome: 'PASS', timestamp_utc: new Date().toISOString(), sequence: 0, details: {} }],
        expectedPreflightPath: preflight, expectedPreflightSha256: 'a'.repeat(64), expectedCompileGateTimestamp: null,
        expectedCommand: 'node --test tests/old.test.ts', fullSuiteNotRequiredForDocsOnly: false, errors });
    assert.ok(result.violations.some(message => message.includes('explicitly excludes current changed tests')));
});
