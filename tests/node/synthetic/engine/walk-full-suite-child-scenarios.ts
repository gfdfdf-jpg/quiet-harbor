import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitCommandLine } from '../../../../src/core/command-line';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { runHumanCommitCommand } from '../../../../src/cli/commands/gates';
import { runGit } from '../../cli/commands/gate-test-helpers';
import { COVERAGE_WALK_SCENARIOS, configureSuiteTimeout } from './walk-coverage-scenarios';
import type { WalkScenario } from './navigator-walk';
import { legacyRepairFixture } from './walk-legacy-task-contract';
import { NODE_WALK_FIXTURE } from './walk-fixture';
import { assertRestoredParentPhaseGuards } from './walk-restored-parent-controls';

const TASK = 'T-WALK', BUNDLE = 'garda-agent-orchestrator';
const LANES = ['code', 'security', 'performance', 'test'];
const CHILD_FILES = ['scripts/full-suite-check.cjs', 'tests/timeout-repair.test.cjs'];
const TITLES = ['Repair the full suite timeout command', 'Verify the full suite timeout repair'];

function repairScenario(escapeChildScope = false, failParentValidation = false): WalkScenario {
    // A timeout repair needs one linked child; fault variants retain two independent scopes.
    const childFiles = CHILD_FILES.slice(0, escapeChildScope || failParentValidation ? 2 : 1);
    const timeout = COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-full-suite-timeout')!;
    const childFixture = legacyRepairFixture(CHILD_FILES[0], CHILD_FILES[1], 'timeout repair terminates');
    let currentTask = TASK, materialized = false, restored = false;
    const implemented = new Set<string>(), committed = new Set<string>();
    return {
        ...timeout, id: 'coverage-full-suite-' + (escapeChildScope ? 'child-scope-escape' : 'wip-restoration'), counterState: 'task-local-full-suite-child-tree',
        expectedBlockedGate: undefined, expectedGuidance: undefined,
        expectedGates: ['child-task', 'restore-full-suite-repair-wip', 'parent-audit'],
        expectedReviews: { code: childFiles.length + 1, security: childFiles.length, performance: childFiles.length, test: childFiles.length + 1 },
        expectedModes: [...childFiles.flatMap(() => LANES.map(lane => lane + ':FULL')), 'code:FULL', 'test:FULL'],
        ...(escapeChildScope ? {
            disturbanceReason: 'Edit a parent source file after native repair-child entry, outside the immutable repair scope.',
            expectedBlockedGate: 'full-suite-repair-child-scope', expectedGuidance: /immutable|isolated|suspended parent WIP/iu,
            expectedGates: [], expectedReviews: {}, expectedModes: []
        } : {}),
        ...(failParentValidation ? {
            id: 'coverage-parent-unresolved-original-validation',
            disturbanceReason: 'Fail the original full-suite command on combined parent SOURCE after both repair children and restored parent passed their own gates.',
            expectedBlockedGate: null, expectedGuidance: /failed original validations require a correction before completion/u,
            expectedFailingGates: ['full-suite-validation', 'parent-audit']
        } : {}),
        // The parent selects the seeded broad command, which must actually time out. The timeout family's own configure
        // only lowers the limit for its own blocking test; inheriting it here left a passing command and no repair tree.
        configure: configureSuiteTimeout,
        inspectTask: () => currentTask,

        get fixture() { return currentTask === TASK ? NODE_WALK_FIXTURE : childFixture; },
        get taskTitle() { return currentTask === TASK ? 'Change the status renderer' : 'tests/timeout-repair.test.cjs verifies the terminating command in scripts/full-suite-check.cjs'; },
        get selectionTargets() { return currentTask === TASK ? ['tests/app.test.ts'] : ['tests/timeout-repair.test.cjs']; },
        get testSelectionCommand() { return currentTask === TASK ? 'node scripts/full-suite-check.cjs' : childFixture.taskTestCommand; },
        setup: root => {
            fs.writeFileSync(path.join(root, 'tests/timeout-repair.test.cjs'),
                'const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");\n'
                + 'test("timeout repair terminates", () => assert.doesNotMatch(fs.readFileSync("scripts/full-suite-check.cjs", "utf8"), /setTimeout/));\n');
            runGit(root, ['add', 'tests/timeout-repair.test.cjs']);
            runGit(root, ['commit', '-qm', 'Seed the repair child regression target']);
        },
        prepare: async (root, steps, run) => {
            if (!steps.length) {
                currentTask = TASK; materialized = false; restored = false; implemented.clear(); committed.clear();
                handleSet({ targetRoot: root, localCommitEnabled: 'true', json: true,
                    operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            }
            const last = steps.at(-1);
            if (escapeChildScope && currentTask !== TASK && last?.taskId === currentTask
                && last.gate === 'enter-task-mode' && last.exitCode === 0) {
                fs.appendFileSync(path.join(root, 'src/app.ts'), '// outside immutable repair-child scope\n');
            }
            if (currentTask === TASK) {
                if (restored && last?.gate === 'completion-gate' && last.exitCode === 0 && !committed.has(TASK)) {
                    const staged = runGit(root, ['add', ...timeout.edits.map(edit => edit.path)]);
                    if (staged.status !== 0) throw new Error('Cannot stage the restored parent SOURCE.');
                    const code = await runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                        '--task-id', TASK, '-m', 'test: accept restored parent SOURCE'], { cwd: root });
                    if (code !== 0) throw new Error('Native restored parent SOURCE was refused: ' + code);
                    committed.add(TASK);
                    if (failParentValidation) fs.writeFileSync(path.join(root, '.git/walk-fail-parent-validation'), 'Combined-source validation failure.\n');
                } else if (!materialized && last?.gate === 'full-suite-validation' && last.exitCode !== 0) {
                    const queue = path.join(root, 'TASK.md');
                    fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').replace('Synthetic navigator walk.',
                        'Repair handoff source: orchestrator; child tasks: ' + childFiles.map((_file, index) => '`T-WALK-F' + (index + 1) + '`').join(', ') + '.')
                        + childFiles.map((file, index) =>
                            `| ${TASK}-F${index + 1} | TODO | P1 | workflow/timeout-${index + 1} | ${TITLES[index]} | synthetic | 2026-11-01 | strict | Child of ${TASK}. Repair scope paths: \`${file}\`; Required reviews: ${LANES.join(', ')}. |\n`).join(''));
                    await run(['materialize-full-suite-repair-task', '--task-id', TASK,
                        '--preflight-path', BUNDLE + '/runtime/reviews/' + TASK + '-preflight.json',
                        '--full-suite-artifact-path', BUNDLE + '/runtime/reviews/' + TASK + '-full-suite-validation.json', '--repo-root', '.']);
                    if (fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8').includes('// coverage family')) {
                        throw new Error('Native timeout materialization did not suspend parent WIP.');
                    }
                    materialized = true; // Observe the native parent handoff before following the child.
                } else if (!restored && last?.gate === 'restore-full-suite-repair-wip' && last.exitCode === 0) {
                    const args = splitCommandLine(last.command!).filter(arg => arg !== '--dry-run');
                    await run(args.slice(args.indexOf('gate') + 1));
                    for (const edit of timeout.edits) {
                        if (!fs.readFileSync(path.join(root, edit.path), 'utf8').includes(edit.append)) {
                            throw new Error('Native restore lost the suspended parent edit: ' + edit.path);
                        }
                    }
                    if (failParentValidation) assertRestoredParentPhaseGuards(root, TASK);
                    restored = true;
                }
            } else {
                const childIndex = currentTask.endsWith('F1') ? 0 : 1;
                if (last?.exitCode === 0 && ((last.gate === 'load-rule-pack' && last.command?.includes('POST_PREFLIGHT'))
                    || last.gate === 'shell-smoke-preflight')) {
                    await run(['record-strict-decomposition-decision', '--task-id', currentTask, '--task-profile', 'strict',
                        '--decision', 'atomic', '--task-summary', TITLES[childIndex],
                        '--reason', 'A single bounded timeout repair obligation can be implemented and reviewed independently.',
                        '--scope-risk', 'Preserve the parent WIP and the sibling repair scope.',
                        ...(last.gate === 'shell-smoke-preflight' ? ['none'] : LANES).flatMap(lane => ['--expected-review-type', lane]),
                        '--atomicity-constraint', 'One exact declared repair file.', '--repo-root', '.']);
                } else if (last?.gate === 'completion-gate' && last.exitCode === 0 && !committed.has(currentTask)) {
                    runGit(root, ['add', CHILD_FILES[childIndex]]);
                    const code = await runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                        '--task-id', currentTask, '-m', 'test: accept native timeout repair ' + currentTask], { cwd: root });
                    if (code !== 0) throw new Error('Native timeout child SOURCE was refused: ' + currentTask);
                    committed.add(currentTask); currentTask = childIndex + 1 < childFiles.length ? TASK + '-F2' : TASK;
                }
            }
        },
        act: async (root, gate) => {
            if (gate === 'child-task' && currentTask === TASK && materialized && !restored) {
                currentTask = TASK + '-F1';
                return true;
            }
            if (gate !== 'implementation' || currentTask === TASK || implemented.has(currentTask)) return false;
            const childIndex = currentTask.endsWith('F1') ? 0 : 1;
            fs.writeFileSync(path.join(root, CHILD_FILES[childIndex]), childIndex === 0
                ? (failParentValidation ? 'if (require("node:fs").existsSync(".git/walk-fail-parent-validation")) process.exit(1);\n' : '')
                    + 'console.log("Full suite timeout repaired.");\n'
                : 'const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");\n'
                    + 'test("timeout repair terminates", () => { const source = fs.readFileSync("scripts/full-suite-check.cjs", "utf8"); assert.doesNotMatch(source, /setTimeout/); assert.match(source, /Full suite timeout repaired/); });\n');
            implemented.add(currentTask); return true;
        }
    };
}

export const FULL_SUITE_CHILD_WALK_SCENARIOS: readonly WalkScenario[] = [repairScenario(), repairScenario(true), repairScenario(false, true)];
