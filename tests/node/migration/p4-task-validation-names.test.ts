import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadFullSuiteValidationConfig } from '../../../src/core/full-suite-validation-config';
import { buildDefaultWorkflowConfig, mergeWorkflowConfigWithTemplate } from '../../../src/core/workflow-config';
import { validateWorkflowConfig } from '../../../src/schemas/config-artifacts-workflow';
import { getGateHelpEntry } from '../../../src/cli/commands/gate-command-help';
import { buildTaskTestSelectionCommand } from '../../../src/gates/next-step/next-step-full-suite-routing';
import { buildTaskValidationPlan } from '../../../src/core/task-validation-plan';
import { taskTestProcessEvidenceViolations } from '../../../src/gates/full-suite/task-test-execution-proof';
import { detectStaleValidationEvidenceFailureReason } from '../../../src/gates/next-step/next-step-review-artifact-failure-detection';

test('T-457: new and legacy config names normalize identically without rewriting input', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-p4-names-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const legacy = buildDefaultWorkflowConfig();
    const { full_suite_validation: section, ...rest } = legacy;
    const renamed = { ...rest, task_test_validation: section };
    assert.deepEqual(validateWorkflowConfig(renamed), validateWorkflowConfig(legacy));
    assert.throws(() => validateWorkflowConfig({ ...legacy, Task_test_validation: section }), /task_test_validation/u);
    assert.deepEqual(mergeWorkflowConfigWithTemplate(legacy, renamed), mergeWorkflowConfigWithTemplate(legacy, legacy));
    fs.writeFileSync(configPath, JSON.stringify(renamed));
    const before = fs.readFileSync(configPath);
    assert.deepEqual(loadFullSuiteValidationConfig(root), section);
    assert.deepEqual(fs.readFileSync(configPath), before);
    assert.throws(() => validateWorkflowConfig({ ...renamed, full_suite_validation: { ...section, enabled: !section.enabled } }), /Conflicting/u);
    fs.writeFileSync(configPath, JSON.stringify({ ...renamed, full_suite_validation: { ...section, command: 'conflict' } }));
    assert.throws(() => loadFullSuiteValidationConfig(root), /Conflicting/u);
});

test('T-457: both gate names explain task tests and navigator offers the task command option', () => {
    const current = getGateHelpEntry('task-test-validation');
    assert.deepEqual(getGateHelpEntry('full-suite-validation'), current);
    assert.match(current.summary, /selected task tests/u);
    assert.doesNotMatch(current.summary, /repository-wide test suite/u);
    assert.match(current.usage[0], /gate task-test-validation/u);
    const command = buildTaskTestSelectionCommand('garda', 'T-457', ['checks/own.case'], false);
    assert.match(command, /--task-test-command/u);
    assert.match(command, /checks\/own.case/u);
    assert.doesNotMatch(command, /--full-suite-command/u);
});

test('T-441: a bare old PASS cannot substitute for a bound selection and execution', () => {
    const barePass = { exit_code: 0, timed_out: false };
    assert.ok(taskTestProcessEvidenceViolations(undefined, barePass).length);
    const plan = buildTaskValidationPlan('runner checks/own.case', [{ path: 'checks/own.case', sha256: 'a'.repeat(64) }]);
    assert.ok(taskTestProcessEvidenceViolations(plan, barePass).length);
    assert.ok(taskTestProcessEvidenceViolations(undefined, barePass, plan).length);
});

test('T-457: stale-evidence recovery reads current and legacy validation names', () => {
    for (const name of ['full-suite validation', 'task test validation', 'task-test-validation', 'TaskTestValidation']) {
        const report = `TEST REVIEW FAILED\nEvidence-only failure: ${name} is stale.\n## Findings by Severity\nNone.\n`;
        assert.ok(detectStaleValidationEvidenceFailureReason(report), name);
        assert.equal(detectStaleValidationEvidenceFailureReason(report.replace('None.', 'High: unsafe authorization bypass.')), null,
            'naming aliases must not turn a real finding into evidence-only recovery');
    }
});
