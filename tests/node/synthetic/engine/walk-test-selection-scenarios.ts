import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRecordedOutOfScopeFailures } from '../../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { recordedOutOfScopeFollowUpViolations } from '../../../../src/gates/full-suite/recorded-out-of-scope-follow-ups';
import { splitCommandLine } from '../../../../src/core/command-line';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { runHumanCommitCommand } from '../../../../src/cli/commands/gates';
import { resolveNextStep } from '../../../../src/gates/next-step/next-step';
import { readTaskQueueEntries } from '../../../../src/gates/next-step/next-step-task-queue';
import { readTaskQueueStatusToken } from '../../../../src/core/active-task-state';
import { loadTaskFullSuiteConfig } from '../../../../src/gates/full-suite/task-full-suite-config';
import { taskTestExecutionProofSatisfied } from '../../../../src/gates/full-suite/task-test-execution-proof';
import { runGit } from '../../cli/commands/gate-test-helpers';
import type { WalkScenario } from './navigator-walk';

const CONFIG = 'garda-agent-orchestrator/live/config/workflow-config.json';
const TARGET = 'backend/application/src/test/java/example/StatusTest.java';
const MODULE_COMMAND = `backend/mvnw${process.platform === 'win32' ? '.cmd' : ''} -f backend/pom.xml -pl application -am verify`;

function outOfScopeRepairScenario(): WalkScenario {
    const parent = 'T-WALK', child = parent + '-F1', repairPath = 'src/module-boundary.cjs';
    const lanes = ['code', 'security', 'performance', 'test'];
    const parentPath = 'tests/app.test.ts', parentEdit = '// Task-only regression.\n';
    let currentTask = parent, declared = false, restored = false, implemented = false;
    const committed = new Set<string>();
    return {
        id: 'coverage-full-suite-out-of-scope',
        preferredOutOfScopeRepair: true,
        counterState: 'full-suite-child-tree',
        fullSuitePlacement: 'after_compile_before_reviews',
        edits: [{ path: parentPath, append: parentEdit }],
        expectedGates: ['task-test-selection', 'full-suite-validation', 'materialize-full-suite-repair-task',
            'restore-full-suite-repair-wip', 'parent-audit'],
        expectedFailingGates: ['full-suite-validation'],
        expectedReviews: { code: 1, security: 1, performance: 1, test: 2 },
        expectedModes: [...lanes.map(lane => lane + ':FULL'), 'test:FULL'],
        inspectTask: () => currentTask,
        setup: root => {
            fs.writeFileSync(path.join(root, repairPath), 'module.exports = false;\n');
            fs.writeFileSync(path.join(root, 'scripts/full-suite-check.cjs'),
                'if (!require("../src/module-boundary.cjs")) { console.error("FAIL tests/unrelated.test.cjs:1 ModuleBoundaryTest: pre-existing production module debt"); process.exitCode = 1; }\n');
            runGit(root, ['add', repairPath, 'scripts/full-suite-check.cjs']);
            runGit(root, ['commit', '-qm', 'Seed unrelated module debt in disposable fixture']);
        },
        prepare: async (root, steps, run) => {
            if (!steps.length) {
                currentTask = parent; declared = false; restored = false; implemented = false; committed.clear();
                handleSet({ targetRoot: root, localCommitEnabled: 'true', json: true,
                    operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            }
            const last = steps.at(-1);
            if (currentTask === parent) {
                if (!declared && last?.gate === 'full-suite-validation' && last.exitCode !== 0) {
                    const queue = path.join(root, 'TASK.md');
                    fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').replace('Synthetic navigator walk.',
                        `Repair handoff source: orchestrator; child tasks: \`${child}\`.`)
                        + `| ${child} | TODO | P1 | architecture/module-boundary | Repair unrelated module boundary debt | synthetic | 2026-11-01 | strict | Child of ${parent}. Repair scope paths: \`${repairPath}\`; Required reviews: ${lanes.join(', ')}. |\n`);
                    declared = true;
                } else if (last?.gate === 'materialize-full-suite-repair-task' && last.exitCode === 0) {
                    assert.ok(!fs.readFileSync(path.join(root, parentPath), 'utf8').includes(parentEdit), 'Parent WIP must be suspended');
                    const manifest = JSON.parse(fs.readFileSync(path.join(root,
                        'garda-agent-orchestrator/runtime/reviews/T-WALK-full-suite-repair-task.json'), 'utf8'));
                    assert.deepEqual(manifest.child_task_ids, [child]);
                    const parentRoute = resolveNextStep({ taskId: parent, repoRoot: root });
                    assert.equal(parentRoute.next_gate, 'child-task', parentRoute.reason);
                    assert.ok(parentRoute.commands[0].command.includes(`next-step "${child}"`));
                    currentTask = child;
                } else if (!restored && last?.gate === 'restore-full-suite-repair-wip' && last.exitCode === 0) {
                    const args = splitCommandLine(last.command!).filter(arg => arg !== '--dry-run');
                    await run(args.slice(args.indexOf('gate') + 1));
                    assert.ok(fs.readFileSync(path.join(root, parentPath), 'utf8').includes(parentEdit), 'Parent WIP must be restored');
                    restored = true;
                } else if (restored && last?.gate === 'completion-gate' && last.exitCode === 0 && !committed.has(parent)) {
                    assert.equal(runGit(root, ['add', parentPath]).status, 0);
                    const code = await runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                        '--task-id', parent, '-m', 'test: accept restored test-only parent'], { cwd: root });
                    assert.equal(code, 0, 'Native restored parent SOURCE must be accepted');
                    committed.add(parent);
                }
            } else if (last?.exitCode === 0 && ((last.gate === 'load-rule-pack' && last.command?.includes('POST_PREFLIGHT'))
                || last.gate === 'shell-smoke-preflight')) {
                await run(['record-strict-decomposition-decision', '--task-id', child, '--task-profile', 'strict',
                    '--decision', 'atomic', '--task-summary', 'Repair unrelated module boundary debt',
                    '--reason', 'One bounded production debt repair has one independent executable scope.',
                    '--scope-risk', 'Preserve suspended test-only parent WIP.',
                    ...(last.gate === 'shell-smoke-preflight' ? ['none'] : lanes).flatMap(lane => ['--expected-review-type', lane]),
                    '--atomicity-constraint', 'One exact declared repair file.', '--repo-root', '.']);
            } else if (last?.gate === 'completion-gate' && last.exitCode === 0 && !committed.has(child)) {
                assert.equal(runGit(root, ['add', repairPath]).status, 0);
                const code = await runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                    '--task-id', child, '-m', 'fix: repair module boundary in disposable fixture'], { cwd: root });
                assert.equal(code, 0, 'Native single repair child SOURCE must be accepted');
                assert.equal(readTaskQueueStatusToken(readTaskQueueEntries(root).get(child)?.status ?? null), 'DONE');
                committed.add(child); currentTask = parent;
            }
        },
        act: async (root, gate) => {
            if (currentTask !== child || gate !== 'implementation' || implemented) return false;
            fs.writeFileSync(path.join(root, repairPath), 'module.exports = true;\n');
            implemented = true;
            return true;
        }
    };
}

function narrowingScenario(profile: 'balanced' | 'fast' | 'strict', unattributed = false): WalkScenario {
    let narrowAfterFailure = false;
    return {
        id: 'coverage-full-suite-out-of-scope-narrow' + (profile === 'balanced' ? '' : '-' + profile) + (unattributed ? '-unattributed' : ''),
        profile,
        expectedDoneGuidance: unattributed ? /Task completed with recorded out-of-scope failures: not attributed/u
            : /Task completed with recorded out-of-scope failures: tests\/unrelated.test.cjs/u,
        get testSelectionCommand() { return narrowAfterFailure ? 'node --test tests/app.test.ts' : undefined; },
        counterState: 'full-suite-out-of-scope-narrow',
        fullSuitePlacement: 'after_compile_before_reviews',
        edits: [{ path: profile === 'fast' ? 'src/app.ts' : 'tests/app.test.ts', append: '// task-only regression\n' }],
        expectedGates: ['task-test-selection', 'full-suite-validation', 'materialize-review-follow-up-tasks'],
        expectedFailingGates: ['full-suite-validation'],
        expectedReviews: profile === 'fast' ? { code: 1 } : { test: 1 },
        expectedModes: profile === 'fast' ? ['code:FULL'] : ['test:FULL'],
        setup: root => {
            fs.writeFileSync(path.join(root, 'scripts/full-suite-check.cjs'),
                unattributed
                    ? 'console.error("14:19:54.151 [main] WARN Consumer inbox processing failed\\norg.hibernate.tool.schema.spi.CommandAcceptanceException: Error executing DDL\\n[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.2:test"); process.exitCode = 1;\n'
                    : 'console.error("FAIL tests/unrelated.test.cjs:1 ModuleBoundaryTest: production module debt"); process.exitCode = 1;\n');
            runGit(root, ['add', 'scripts/full-suite-check.cjs']);
            runGit(root, ['commit', '-qm', 'Seed unrelated failure in disposable fixture']);
        },
        prepare: async (root, steps, run) => {
            if (!steps.length) narrowAfterFailure = false;
            const latest = steps.at(-1);
            if (profile === 'strict' && latest?.exitCode === 0 && (latest.gate === 'shell-smoke-preflight'
                || (latest.gate === 'load-rule-pack' && latest.command?.includes('POST_PREFLIGHT')))) {
                await run(['record-strict-decomposition-decision', '--task-id', 'T-WALK', '--task-profile', 'strict',
                    '--decision', 'atomic', '--task-summary', 'Update one status regression',
                    '--reason', 'One bounded test regression has one independently executable scope.',
                    '--scope-risk', 'Retain unrelated suite failures in their separate follow-up.',
                    '--expected-review-type', latest.gate === 'shell-smoke-preflight' ? 'none' : 'test',
                    '--atomicity-constraint', 'One test-only change.', '--repo-root', '.']);
            }
            if (steps.some(step => step.gate === 'full-suite-validation' && step.exitCode !== 0)) {
                // The next printed selector must be executable once its task command is chosen.
                const last = steps.at(-1);
                if (last?.gate === 'full-suite-validation' && last.exitCode !== 0) {
                    narrowAfterFailure = true;
                    if (profile === 'fast') handleSet({ targetRoot: root, taskId: 'T-WALK', fullSuiteCommand: 'node --test tests/app.test.ts', focusedRequiredTestPath: ['tests/app.test.ts'], taskTestSelectionReason: 'T-WALK tests/app.test.ts guards src/app.ts status regression behavior', json: true });
                }
                if (last?.gate === 'materialize-review-follow-up-tasks' && last.exitCode === 0) {
                    const queue = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
                    assert.match(queue, /T-WALK-1.*Resolve recorded out-of-scope test failures/u);
                    const record = readRecordedOutOfScopeFailures(root, 'T-WALK')[0];
                    assert.deepEqual(record.failing_tests, unattributed ? [] : ['tests/unrelated.test.cjs']);
                    if (unattributed) {
                        assert.equal(record.attribution, 'not attributed');
                        assert.match(queue, /Tests: not attributed/u);
                    }
                    assert.deepEqual(recordedOutOfScopeFollowUpViolations(root, 'T-WALK'), []);
                    const preflight = JSON.parse(fs.readFileSync(path.join(root,
                        'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json'), 'utf8'));
                    if (profile === 'fast') {
                        assert.equal(preflight.required_reviews.test, false);
                        assert.deepEqual(preflight.changed_files, ['src/app.ts']);
                        assert.deepEqual(loadTaskFullSuiteConfig(root, 'T-WALK').selection.targets, ['tests/app.test.ts']);
                    }
                    if (profile === 'strict') assert.equal(preflight.profile_policy_snapshot.review_follow_up_policy.materialization_mode, 'per_finding');
                }
                if (last?.gate === 'completion-gate' && last.exitCode === 0) {
                    assert.match(last.output || '', /completed with recorded out-of-scope failures/u);
                }
            }
        }
    };
}


function moduleSelectionScenario(failFirst = false): WalkScenario {
    let failed = false, repaired = false;
    const command = MODULE_COMMAND;
    return {
        id: 'coverage-task-test-selection-module' + (failFirst ? '-failed-fixed' : ''),
        counterState: 'test-selection-module',
        edits: [{ path: TARGET, append: '// Task regression coverage.\n' }],
        testSelectionCommand: command,
        ...(failFirst ? { fullSuitePlacement: 'after_compile_before_reviews', expectedFailingGates: ['full-suite-validation'] } : {}),
        expectedGates: ['task-test-selection', 'full-suite-validation', ...(failFirst ? ['implementation'] : [])],
        expectedReviews: { test: 1 }, expectedModes: ['test:FULL'],
        setup: root => {
            failed = false; repaired = false;
            fs.mkdirSync(path.dirname(path.join(root, TARGET)), { recursive: true });
            fs.writeFileSync(path.join(root, TARGET), 'package example; class StatusTest {}\n');
            fs.writeFileSync(path.join(root, 'backend/pom.xml'), '<project><modules><module>application</module></modules></project>');
            fs.writeFileSync(path.join(root, 'backend/application/pom.xml'), '<project/>');
            fs.appendFileSync(path.join(root, '.gitignore'), '\n**/target/\n');
            // Model the reactor runner while checking the task's real edited target through Node.
            fs.writeFileSync(path.join(root, 'backend/check-module.cjs'),
                failFirst ? `const fs = require('node:fs'); const fixed = fs.readFileSync('${TARGET}', 'utf8').includes('// fixed'); fs.mkdirSync('backend/application/target/surefire-reports', {recursive:true}); fs.writeFileSync('backend/application/target/surefire-reports/TEST-example.StatusTest.xml', '<testsuite><testcase classname="example.StatusTest" name="status" time="' + process.hrtime.bigint() + '">' + (fixed ? '' : '<failure message="wrong status"/>') + '</testcase></testsuite>'); if (!fixed) { console.error('FAIL ${TARGET}:1 StatusTest#status: wrong status'); process.exitCode = 1; }\n`
                    : `require('node:assert/strict').match(require('node:fs').readFileSync('${TARGET}', 'utf8'), /Task regression/); const fs = require('node:fs'); fs.mkdirSync('backend/application/target/surefire-reports', {recursive:true}); fs.writeFileSync('backend/application/target/surefire-reports/TEST-example.StatusTest.xml', '<testsuite><testcase classname=\"example.StatusTest\" name=\"status\" time=\"' + process.hrtime.bigint() + '\"/></testsuite>'); console.log('MODULE_TEST_PASS');\n`);
            fs.writeFileSync(path.join(root, 'backend/mvnw.cmd'), '@echo off\r\nnode backend/check-module.cjs\r\n');
            fs.writeFileSync(path.join(root, 'backend/mvnw'), '#!/bin/sh\nexec node backend/check-module.cjs\n', { mode: 0o755 });
            runGit(root, ['add', 'backend', '.gitignore']);
            runGit(root, ['commit', '-qm', 'Seed module test in disposable fixture']);
        },
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate !== 'full-suite-validation') return;
            if (failFirst) {
                const artifact = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-WALK-full-suite-validation.json'), 'utf8'));
                assert.equal(taskTestExecutionProofSatisfied(command, [TARGET], artifact.task_test_execution_proof), last.exitCode === 0);
                if (last.exitCode !== 0) { failed = true; return; }
                assert.ok(failed && repaired, 'A failed method must visit remediation before its passing rerun');
            }
            if (last.exitCode !== 0) return;
            const configured = JSON.parse(fs.readFileSync(path.join(root, CONFIG), 'utf8')).full_suite_validation.command;
            assert.equal(configured, 'node scripts/full-suite-check.cjs');
            assert.equal(loadTaskFullSuiteConfig(root, 'T-WALK').config.command, command);
            assert.equal(loadTaskFullSuiteConfig(root, 'T-NEXT').selection.status, 'missing');
            assert.equal(loadTaskFullSuiteConfig(root, 'T-NEXT').config.command, configured);
            const mode = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-WALK-task-mode.json'), 'utf8'));
            assert.deepEqual(mode.planned_changed_files, []);
        },
        execute: async (root, step) => {
            if (!failFirst || !failed || repaired || step.gate !== 'implementation') return false;
            assert.match(step.reason || '', /already failed.*fix the failures/su);
            fs.appendFileSync(path.join(root, TARGET), '// fixed\n');
            repaired = true;
            step.exitCode = 0;
            step.output = 'Fixed the selected StatusTest#status failure; refresh preflight and rerun.';
            return true;
        }
    };
}

export const TEST_SELECTION_WALK_SCENARIOS: readonly WalkScenario[] = [
    moduleSelectionScenario(),
    moduleSelectionScenario(true),
    narrowingScenario('balanced'),
    narrowingScenario('fast'),
    narrowingScenario('strict'),
    narrowingScenario('balanced', true),
    outOfScopeRepairScenario()
];
