import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { WalkScenario } from './navigator-walk';
import { STACK_MANIFESTS, readStackExecutions, stackExecutionViolations, stackFixture, stackInvocations, type StackTaskPlan } from './walk-stack-fixtures';
import { stackScenario } from './walk-stack-scenarios';

/** Obligations are checked against observed native routes, never treated as reached by declaration. */
export const UNKNOWN_GATE_OBLIGATIONS = {
    discovery: ['enter-task-mode'], compile: ['compile-gate'], selection: ['task-test-selection'],
    execution: ['full-suite-validation'], expectedRed: ['test-first-expected-failure'],
    checklist: ['quality-checklist'], reviews: ['record-review-result'],
    focused: ['run-intermediate-command'], followUp: ['materialize-review-follow-up-tasks'], completion: ['completion-gate']
} as const;

/** Long opaque gate tour. Today's product refusals remain failures; unknown stack is never a declared handoff. */
export function unknownStackGateTour(renamed = false): WalkScenario {
    const original = STACK_MANIFESTS.find(manifest => manifest.id === 'unknown-quartz')!;
    const manifest = structuredClone(original);
    const rename = (value: string) => value.replaceAll('components/', 'realm/').replaceAll('qa/', 'checks/')
        .replaceAll('.qz', '.neb').replaceAll('.case', '.trial');
    // Rename executable, extensions and layout together, retaining no known-stack manifest.
    if (renamed) {
        manifest.technologies[0].executable = 'tools/nebula';
        for (const suite of manifest.suites) { suite.source = rename(suite.source); suite.target = rename(suite.target); }
        manifest.helpers = manifest.helpers.map(rename);
        for (const key of ['firstArgv', 'secondArgv', 'allArgv'] as const)
            manifest.technologies[0][key] = manifest.technologies[0][key].map(rename);
    }
    const base = stackScenario(manifest, 7, 'generic', true);
    const invocations = stackInvocations(manifest, 8);
    const fixture = stackFixture(manifest, 'generic', invocations);
    if (renamed) fixture.files = Object.fromEntries(Object.entries(fixture.files).map(([file, bytes]) => [rename(file), bytes]));
    const broad = fixture.projectTestCommand;
    fixture.configuredCompileCommand = '__COMPILE_GATE_COMMAND_UNCONFIGURED__';
    fixture.projectTestCommand = '__FULL_SUITE_COMMAND_UNCONFIGURED__';
    let broadFailed = false;
    return {
        ...base, fixture, id: 'stack-unknown-quartz-a7-generic-gate-tour' + (renamed ? '-renamed' : ''),
        failures: { test: 1 }, findingDescription: 'The two opaque targets need focused boundary coverage.',
        fix: manifest.suites.map(suite => ({ path: suite.target, append: '# focused foreign-partner assertion\n' })),
        expectedReviews: { code: 1, security: 1, refactor: 1, test: 2 },
        expectedModes: ['code:FULL', 'security:FULL', 'refactor:FULL', 'test:FULL', 'test:DELTA'],
        expectedGates: [...new Set(Object.values(UNKNOWN_GATE_OBLIGATIONS).flat())],
        get testSelectionCommand() { return broadFailed ? invocations.map(run => run.command).join(' && ') : broad; },
        expectedFailingGates: ['full-suite-validation', 'record-review-result'],
        configure: root => { broadFailed = false; base.configure?.(root); },
        prepare: async (root, steps, run) => {
            await base.prepare?.(root, steps, run);
            if (steps.at(-1)?.gate === 'full-suite-validation' && steps.at(-1)?.exitCode) broadFailed = true;
        },
        inspectResult: (root, result) => {
            if (result.outcome !== 'done') return;
            const plan = JSON.parse(fs.readFileSync(path.join(root, '.git/stand-task.json'), 'utf8')) as StackTaskPlan;
            assert.deepEqual(stackExecutionViolations(root, plan), []);
            const executions = readStackExecutions(root);
            assert.equal(executions.filter(record => record.purpose === 'broad' && record.exitCode !== 0).length, 1);
            const red = executions.find(record => record.purpose === 'own' && record.exitCode !== 0);
            const green = executions.find(record => record.purpose === 'own' && record.exitCode === 0);
            assert.ok(red && green && executions.indexOf(red) < executions.indexOf(green));
            assert.equal(red.targets.length, 2);
            for (const check of red.checks) {
                const passed: typeof check | undefined = green.checks.find(item => item.target === check.target);
                assert.ok(passed);
                assert.equal(check.testSha256, passed.testSha256, 'RED/GREEN use identical test bytes');
                assert.notEqual(check.sourceSha256, passed.sourceSha256, 'RED precedes implementation');
            }
            const finding = result.steps.find(step => step.gate === 'record-review-result' && /--review-type\s+"test"/u.test(step.command ?? ''));
            assert.ok(finding && result.steps.some(step => step.index > finding.index && (step.gate === 'run-intermediate-command'
                || step.preparation?.some(action => action.command.startsWith('run-intermediate-command ')))), 'Focused validation after the finding');
            assert.match(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), /Resolve recorded out-of-scope test failures/u);
        }
    };
}

export const UNKNOWN_STACK_CONTRACT_SCENARIOS = [unknownStackGateTour(), unknownStackGateTour(true)];
