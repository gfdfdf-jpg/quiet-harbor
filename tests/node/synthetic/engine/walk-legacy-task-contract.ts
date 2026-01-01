import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { handleGate } from '../../../../src/cli/commands/gate-command';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { splitCommandLine } from '../../../../src/core/command-line';
import type { WalkScenario, WalkStep } from './navigator-walk';
import { NODE_WALK_FIXTURE, type WalkFixtureDescriptor } from './walk-fixture';
import { captureWalkOutput } from './walk-output';
import { extractRoutes } from './walk-routes';
import { loadTaskFullSuiteConfig } from '../../../../src/gates/full-suite/task-full-suite-config';
import { readRecordedOutOfScopeFailures } from '../../../../src/gates/full-suite/recorded-out-of-scope-failures';

export const LEGACY_TASK_TARGET = 'tests/app.test.ts';
export const LEGACY_TASK_COMMAND = 'node --test ' + LEGACY_TASK_TARGET;
export const LEGACY_BROAD_COMMAND = 'node scripts/full-suite-check.cjs';

/** Even an opaque script must declare the task targets its entrypoint verifies. */
export function legacyTaskFixture(command = LEGACY_BROAD_COMMAND, targets = [LEGACY_TASK_TARGET]): WalkFixtureDescriptor {
    return { ...NODE_WALK_FIXTURE, taskTestCommand: command, taskTestInvocations: [{ command, targets }] };
}

/** Repair children bind checklist execution and semantic review to the same regression as their task selection. */
export function legacyRepairFixture(source: string, target: string, caseId: string): WalkFixtureDescriptor {
    const command = `node --test --test-reporter=tap --test-name-pattern="${caseId}" ${target}`;
    return { ...legacyTaskFixture(command, [target]), primarySource: source, primaryTest: target,
        caseCommand: command, cases: [{ source: target, case_id: caseId, selector: caseId }],
        selectionReason: `${target} verifies the task repair in ${source}`,
        caseReasoning: 'The retained Node output confirms this task repair regression passed.',
        trustBoundaryMatrix: [{ boundary_id: 'TB-REPAIR-001', boundary: 'Repaired command/source to its regression',
            authority_source: source, mutable_inputs: [source], integrity_evidence: ['source sha256'],
            canonical_reconstruction: 'Read the repaired task source and rerun its declared regression.',
            toctou_replay: 'Reject a stale or ineffective repair.', negative_paths: [{ kind: 'replaced', scenario: caseId,
                expected_behavior: 'Reject the unrepaired task behavior.', evidence_files: [target + '#' + caseId] }] }] };
}

/** A failed broad attempt is retained by the native selector when the agent narrows to its own tests. */
export function narrowLegacyFailure(scenario: WalkScenario): WalkScenario {
    let narrowed = false;
    return { ...scenario, counterState: scenario.counterState ?? 'stack-retained-broad-failure', selectionTargets: [LEGACY_TASK_TARGET],
        get testSelectionCommand() { return narrowed ? LEGACY_TASK_COMMAND : LEGACY_BROAD_COMMAND; },
        prepare: async (root, steps, run) => {
            if (!steps.length) narrowed = false;
            await scenario.prepare?.(root, steps, run);
            const last = steps.at(-1);
            if (narrowed || last?.gate !== 'full-suite-validation' || !last.exitCode) return;
            handleSet({ targetRoot: root, taskId: last.taskId || 'T-WALK', fullSuiteCommand: LEGACY_TASK_COMMAND,
                focusedRequiredTestPath: [LEGACY_TASK_TARGET],
                taskTestSelectionReason: `${last.taskId || 'T-WALK'}: tests/app.test.ts verifies the changed src/app.ts renderer.`, json: true });
            // Rerun the printed gate on the new task selection before rebuilding any review context.
            const argv = splitCommandLine(last.command!);
            await run(argv.slice(argv.indexOf('gate') + 1));
            narrowed = true;
        },
        inspectResult: (root, result) => {
            scenario.inspectResult?.(root, result);
            if (result.outcome !== 'done') return;
            assert.ok(narrowed, 'The intentional broad failure must select task-only tests.');
            const task = loadTaskFullSuiteConfig(root, 'T-WALK');
            assert.equal(task.config.command, LEGACY_TASK_COMMAND);
            assert.deepEqual(task.selection.targets, [LEGACY_TASK_TARGET]);
            assert.ok(readRecordedOutOfScopeFailures(root, 'T-WALK').length, 'The failed broad attempt must remain recorded.');
            const config = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json'), 'utf8'));
            assert.equal(config.full_suite_validation.command, LEGACY_BROAD_COMMAND);
        } };
}

/** Execute the scenario's actual RED command, including its case binding, through the real gate. */
export async function executeLegacyRed(step: WalkStep, cases: WalkFixtureDescriptor['cases']): Promise<boolean> {
    if (step.gate !== 'test-first-expected-failure' || !step.command) return false;
    const argv = splitCommandLine(step.command);
    const gate = argv.indexOf('gate');
    if (gate < 0) throw new Error('RED route has no executable gate command.');
    for (let i = argv.length - 2; i >= 0; i--) if (argv[i] === '--selected-case') argv.splice(i, 2);
    argv.push(...cases.flatMap(selected => ['--selected-case', JSON.stringify(selected)]));
    const output: string[] = [], previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await captureWalkOutput(output, () => handleGate(argv.slice(gate + 1)));
        step.exitCode = Number(process.exitCode ?? 0);
        step.output = output.join('\n');
        step.command = argv.map(arg => JSON.stringify(arg)).join(' ');
    } finally { process.exitCode = previousExitCode; }
    return true;
}

/** A literal target needs no symbolic entrypoint claim or the extra semantic lane that claim entails. */
export async function executeLegacyLiteralSelection(root: string, step: WalkStep): Promise<boolean> {
    if (step.gate !== 'task-test-selection' || !step.command) return false;
    const argv = splitCommandLine(step.command);
    const plan = argv.indexOf('--task-test-plan');
    if (plan >= 0) argv.splice(plan, 2);
    const value = (flag: string) => { const index = argv.indexOf(flag); return index < 0 ? '' : argv[index + 1] ?? ''; };
    const targets = argv.flatMap((arg, index) => arg === '--focused-required-test-path' ? [argv[index + 1]] : []);
    const output: string[] = [];
    await captureWalkOutput(output, async () => {
        handleSet({ targetRoot: root, taskId: value('--task-id'), fullSuiteCommand: value('--task-test-command') || value('--full-suite-command'),
            focusedRequiredTestPath: targets, taskTestSelectionReason: value('--reason'), json: true });
    });
    step.command = argv.map(arg => JSON.stringify(arg)).join(' ');
    step.exitCode = 0; step.output = output.join('\n');
    return true;
}

/** Resolve a unique semantic source route each run, so integration may move code without weakening the oracle. */
export function legacySourceRoute(file: string, signature: string, source = fs.readFileSync(path.resolve(file), 'utf8')): string {
    const matches = extractRoutes(source, file).points.filter(point => point.expression.includes(signature));
    if (matches.length !== 1) throw new Error(`Expected one route for ${file} containing ${signature}; found ${matches.length}.`);
    return matches[0].id;
}
