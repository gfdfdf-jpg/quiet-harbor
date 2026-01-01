import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runCompileGateCommand } from '../../../../src/cli/commands/gate-flows/compile/compile-flow';
import { splitCommandLine } from '../../../../src/core/command-line';
import { NativeWalkOwner, waitForOwner } from './walk-native-owner';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { FULL_SUITE_CHILD_WALK_SCENARIOS } from './walk-full-suite-child-scenarios';
import { NODE_WALK_FIXTURE, type WalkFixtureDescriptor } from './walk-fixture';
import { legacySourceRoute } from './walk-legacy-task-contract';
import type { WalkScenario } from './navigator-walk';

const REVIEWS = 'garda-agent-orchestrator/runtime/reviews';
const SOURCE = 'src/status.cjs', TEST = 'tests/owned-status.test.cjs';
const CASE = 'selected status behavior';
const COMMAND = `node --test --test-reporter=tap ${TEST}`;
const FLAG = '.git/walk-owned-test-failure';
const EDITS = [{ path: SOURCE, append: '// Task-owned status change.\n' },
    { path: TEST, append: '// Task-owned regression.\n' }];
const route = (file: string, signature: string) => legacySourceRoute('src/gates/next-step/' + file, signature);
const suiteRoute = (signature: string) => route('next-step-full-suite-routing.ts', signature);

/** These are actual selected task tests, distinct from the configured project-wide command. */
function selectedFixture(timeout = false): WalkFixtureDescriptor {
    const command = timeout ? `node ${TEST}` : COMMAND;
    return { ...NODE_WALK_FIXTURE, id: timeout ? 'owned-status-timeout' : 'owned-status-failure',
        primarySource: SOURCE, primaryTest: TEST, taskTitle: 'Verify selected status behavior',
        taskTestCommand: command, taskTestInvocations: [{ command, targets: [TEST] }],
        caseCommand: command, cases: [{ source: TEST, case_id: CASE, selector: CASE }],
        selectionReason: `${TEST} verifies the behavior in ${SOURCE} and its task recovery contract.`,
        trustBoundaryMatrix: [{ boundary_id: 'TB-OWNED-STATUS', boundary: 'Status source to selected task regression',
            authority_source: SOURCE, mutable_inputs: [SOURCE], integrity_evidence: ['source sha256'],
            canonical_reconstruction: 'Execute the selected status regression against the current source.',
            toctou_replay: 'Reject an altered status implementation.', negative_paths: [{ kind: 'replaced', scenario: CASE,
                expected_behavior: 'The current status remains ready.', evidence_files: [TEST + '#' + CASE] }] }],
        files: { ...NODE_WALK_FIXTURE.files, [SOURCE]: 'exports.status = () => "ready";\n',
            [TEST]: 'const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");\n'
                + `const { status } = require("../${SOURCE}");\n`
                + `test("${CASE}", async () => { assert.equal(status(), "ready");\n`
                + `if (fs.existsSync("${FLAG}")) { fs.rmSync("${FLAG}"); `
                + (timeout ? 'fs.writeFileSync(".git/walk-owned-test-ready", String(process.pid)); await new Promise(resolve => setTimeout(resolve, 60000));' : 'assert.fail("Planned failure of the selected task regression");')
                + ' } });\n' } };
}

function ownTestFailure(kind: 'before-test' | 'closeout' | 'manual-retry' | 'targeted-retry' | 'timeout-retry'): WalkScenario {
    const retry = kind.endsWith('retry'), timeout = kind === 'timeout-retry';
    let injected = false, guidance = false;
    let owner: NativeWalkOwner | undefined;
    const expectedRoute = kind === 'before-test' ? suiteRoute('Fix task test failures before launching test review.')
        : kind === 'closeout' ? suiteRoute('Fix the selected task tests before completion.')
        : timeout ? suiteRoute('duration history now recommends a longer timeout')
        : kind === 'manual-retry' ? suiteRoute('task-scoped focused validation evidence marks the failure as transient')
        : suiteRoute('task-scoped targeted diagnostic evidence passed afterward');
    return { id: 'coverage-task-owned-' + kind, fixture: selectedFixture(timeout), edits: EDITS,
        selectionTargets: [TEST], testSelectionCommand: timeout ? `node ${TEST}` : COMMAND,
        fullSuitePlacement: kind === 'closeout' ? 'before_completion' : kind === 'before-test' ? 'before_test_review' : 'after_compile_before_reviews',
        expectedReviews: kind === 'before-test' ? { code: 1 } : { code: 1, test: 1 },
        expectedModes: kind === 'before-test' ? ['code:FULL'] : ['code:FULL', 'test:FULL'],
        expectedFailingGates: ['full-suite-validation'], expectedRoutes: [expectedRoute],
        ...(!retry ? { expectedBlockedGate: 'implementation', expectedGuidance: /Fix.*task test|selected task tests failed/isu } : {}),
        disturbanceReason: 'Fail the actual selected task test, preserving its mandatory failure until the navigator observes recovery.',
        ...(timeout ? { configure: (root: string) => {
            const file = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            Object.assign(config.full_suite_validation, { timeout_ms: 10000, timeout_retry_count: 1 });
            fs.writeFileSync(file, JSON.stringify(config));
        } } : {}),
        execute: async (root, step) => {
            if (step.gate === 'full-suite-validation' && !injected) {
                injected = true;
                if (timeout) {
                    const argv = splitCommandLine(step.command!);
                    // Eligible duration history comes from this real successful invocation, not a written sample.
                    const prior = new NativeWalkOwner(root, argv.slice(argv.indexOf('gate') + 1));
                    await prior.finish();
                    fs.writeFileSync(path.join(root, FLAG), 'Interrupt the next actual selected-test invocation.\n');
                    owner = new NativeWalkOwner(root, argv.slice(argv.indexOf('gate') + 1));
                    await waitForOwner('selected task test readiness and native owner marker', () => {
                        owner!.assertRunning();
                        const marker = path.join(root, REVIEWS, 'T-WALK-full-suite-run-marker.json');
                        const ready = path.join(root, '.git/walk-owned-test-ready');
                        if (!fs.existsSync(marker) || !fs.existsSync(ready)) return false;
                        const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
                        return value.gate_pid === owner!.child.pid && value.child_pid === Number(fs.readFileSync(ready, 'utf8'));
                    });
                    // Native recovery publishes the cancelled first attempt with retries remaining. No timeout
                    // policy, artifact or event is authored by the fixture. Both marker owners are terminated.
                    await owner.killTree();
                    // The previous terminal report is lost while the new owner is interrupted; native cleanup
                    // must publish its own FAILED evidence rather than preserve the older successful artifact.
                    fs.unlinkSync(path.join(root, REVIEWS, 'T-WALK-full-suite-validation.json'));
                    step.exitCode = 3;
                    step.output = 'Interrupted the real task-test owner and its marked child before terminal publication.\n' + owner.output;
                    return true;
                }
                fs.writeFileSync(path.join(root, FLAG), 'One real selected-test failure.\n');
            }
            return false;
        },
        prepare: async (root, steps, run) => {
            if (!steps.length) { injected = false; guidance = false; }
            const last = steps.at(-1);
            if (!retry || timeout || guidance || last?.gate !== 'full-suite-validation' || !last.exitCode) return;
            const preflight = REVIEWS + '/T-WALK-preflight.json';
            await run(['run-intermediate-command', '--task-id', 'T-WALK', '--command-source', 'targeted-test',
                '--command', COMMAND, '--preflight-path', preflight, '--repo-root', '.']);
            if (kind === 'manual-retry') {
                const hash = (file: string) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
                const file = path.join(root, 'garda-agent-orchestrator/runtime/manual-validation/T-WALK/full-suite-retry-evidence.json');
                fs.mkdirSync(path.dirname(file), { recursive: true });
                // Supplemental retry guidance is allowed input, never authenticated passing task-test evidence.
                fs.writeFileSync(file, JSON.stringify({ task_id: 'T-WALK', reason_kind: 'focused_pass_after_failure',
                    preflight_sha256: hash(preflight), full_suite_failure_artifact_sha256: hash(REVIEWS + '/T-WALK-full-suite-validation.json'),
                    focused_validation: { command: COMMAND, exit_code: 0, status: 'PASSED' } }));
            }
            guidance = true;
        },
        cleanup: async () => { await owner?.killTree(); },
        inspectResult: (root, result) => {
            assert.ok(injected, 'The task-owned native test command must actually fail.');
            const executions = result.steps.filter(step => step.gate === 'full-suite-validation');
            assert.ok(executions.some(step => step.exitCode !== null && step.exitCode !== 0));
            if (retry) assert.ok(executions.some(step => step.exitCode === 0 && step.output.includes('FULL_SUITE_VALIDATION_PASSED')),
                'Recovery guidance or marker cleanup cannot replace the mandatory selected-test rerun.');
            assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json'), 'utf8'))
                .full_suite_validation.enabled, true, 'Task recovery never disables validation.');
        }
    };
}

function gitRefusal(): WalkScenario {
    let injected = false;
    return { id: 'coverage-native-git-observation-refusal', edits: EDITS, fixture: selectedFixture(),
        selectionTargets: [TEST], testSelectionCommand: COMMAND, expectedReviews: {}, expectedModes: [],
        expectedBlockedGate: 'git-observation', expectedGuidance: /git[\s\S]*failed:[\s\S]*index[\s\S]*Workspace authority and planned effects were not accepted/iu,
        expectedRoutes: [route('next-step.ts', 'Retry the Git observation before continuing.')],
        disturbanceReason: 'Corrupt only the disposable native Git index after genuine task entry; retain the original bytes.',
        prepare: async (root, steps) => {
            if (!steps.length) injected = false;
            if (injected || steps.at(-1)?.gate !== 'classify-change' || steps.at(-1)?.exitCode !== 0) return;
            const index = path.join(root, '.git/index');
            fs.copyFileSync(index, path.join(root, '.git/stand-retained-index'));
            fs.writeFileSync(index, 'Invalid disposable Git index.'); injected = true;
        },
        inspectResult: root => {
            assert.ok(fs.existsSync(path.join(root, '.git/stand-retained-index')));
            assert.equal(fs.readFileSync(path.join(root, '.git/index'), 'utf8'), 'Invalid disposable Git index.',
                'The native Git refusal must preserve the rejected index bytes.');
        }
    };
}

function invalidCompileApplicability(): WalkScenario {
    let injected = false, attempted = false;
    return { id: 'coverage-native-compile-applicability-refusal', edits: EDITS,
        fixture: { ...selectedFixture(), id: 'owned-status-task-local-compile', configuredCompileCommand: '' },
        selectionTargets: [TEST], testSelectionCommand: COMMAND, expectedReviews: {}, expectedModes: [],
        expectedBlockedGate: 'compile-gate', expectedGuidance: /Not-applicable cannot close a failed required compile/u,
        expectedRoutes: [route('next-step-pre-review-routing.ts', 'Fix and rerun the required task compile.')],
        expectedFailingGates: ['compile-gate'],
        disturbanceReason: 'A real required compile failure cannot be erased by a later native not-applicable declaration.',
        execute: async (root, step) => {
            if (!injected && step.gate === 'compile-gate') {
                fs.writeFileSync(path.join(root, '.git/walk-fail-compile'), 'Fail the required compile.'); injected = true;
            }
            return false;
        },
        prepare: async (root, steps) => {
            if (!steps.length) { injected = false; attempted = false; }
            const last = steps.at(-1);
            if (attempted || last?.gate !== 'compile-gate' || !last.exitCode) return;
            const result = await runCompileGateCommand({ repoRoot: root, taskId: 'T-WALK',
                preflightPath: REVIEWS + '/T-WALK-preflight.json', emitMetrics: false,
                compileNotApplicableReason: 'This task would like to declare that it has no separate compilation phase.' });
            assert.notEqual(result.exitCode, 0);
            assert.match(result.outputLines.join('\n'), /Not-applicable cannot close a failed required compile/u);
            attempted = true;
        }
    };
}

function lateRecordedFailure(): WalkScenario {
    let injected = false, narrowed = false;
    return { id: 'coverage-native-recorded-failure-after-reviews', edits: EDITS, fixture: selectedFixture(),
        selectionTargets: [TEST], testSelectionCommand: 'node scripts/full-suite-check.cjs', fullSuitePlacement: 'before_completion',
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'],
        expectedFailingGates: ['full-suite-validation'], expectedGates: ['materialize-review-follow-up-tasks'],
        expectedRoutes: [route('next-step-post-review-routes.ts', 'Materialize recorded out-of-scope failures.')],
        disturbanceReason: 'Record a genuine broad failure only after reviews, then narrow while retaining its required follow-up.',
        execute: async (root, step) => {
            if (!injected && step.gate === 'full-suite-validation') {
                fs.writeFileSync(path.join(root, '.git/walk-fail-full-suite'), 'Fail the selected broad attempt.'); injected = true;
            }
            return false;
        },
        prepare: async (root, steps) => {
            if (!steps.length) { injected = false; narrowed = false; }
            const last = steps.at(-1);
            if (!injected || narrowed || last?.gate !== 'full-suite-validation' || !last.exitCode) return;
            handleSet({ targetRoot: root, taskId: 'T-WALK', fullSuiteCommand: COMMAND, focusedRequiredTestPath: [TEST],
                taskTestSelectionReason: `T-WALK: ${TEST} verifies the selected status behavior in ${SOURCE}; retain the earlier broad failure separately.`, json: true });
            narrowed = true;
        }
    };
}

function reuseWithoutScopedMetadata(): WalkScenario {
    let metadataLost = false;
    return { id: 'coverage-native-reuse-missing-scoped-metadata', edits: EDITS, fixture: selectedFixture(),
        selectionTargets: [TEST], testSelectionCommand: COMMAND, fullSuitePlacement: 'before_completion',
        requiredLanes: ['code', 'security', 'test'],
        expectedReviews: { code: 1, security: 1, test: 1 }, expectedModes: ['code:FULL', 'security:FULL', 'test:FULL'],
        expectedGates: ['build-scoped-diff'],
        expectedRoutes: [route('next-step-review-cycle-routing.ts', "Prepare '${options.reviewType}' scoped diff metadata.")],
        disturbanceReason: 'A test-only edit refreshes preflight while production stays unchanged; lose scoped cache and require native rebuilding without fresh upstream reviewers.',
        prepare: async (root, steps, run) => {
            if (!steps.length) metadataLost = false;
            const last = steps.at(-1);
            if (metadataLost || last?.gate !== 'record-review-result' || last.exitCode !== 0
                || !last.command?.includes('--review-type "security"')) return;
            fs.appendFileSync(path.join(root, TEST), '// Preserve unchanged production domain after security PASS.\n');
            const command = [...steps].reverse().find(step => step.gate === 'classify-change' && step.exitCode === 0)?.command;
            assert.ok(command);
            const argv = splitCommandLine(command);
            await run(argv.slice(argv.indexOf('gate') + 1));
            fs.unlinkSync(path.join(root, REVIEWS, 'T-WALK-security-scoped.json'));
            metadataLost = true;
        },
        inspectResult: (_root, result) => { if (result.outcome === 'done') assert.ok(metadataLost); }
    };
}

function singleRepairHandoff(): WalkScenario {
    return { ...FULL_SUITE_CHILD_WALK_SCENARIOS[0], id: 'coverage-native-single-repair-child-handoff',
        expectedReviews: {}, expectedModes: [], expectedGates: [], expectedBlockedGate: 'child-task',
        expectedRoutes: [route('next-step-decision-route-groups.ts', 'Continue the linked task test repair task.')],
        expectedGuidance: /one independent child[\s\S]*WIP remains suspended/iu };
}

export const NATIVE_RECOVERY_WALK_SCENARIOS: readonly WalkScenario[] = [gitRefusal(), invalidCompileApplicability(),
    ownTestFailure('before-test'), ownTestFailure('closeout'), ownTestFailure('manual-retry'),
    ownTestFailure('targeted-retry'), ownTestFailure('timeout-retry'), lateRecordedFailure(), reuseWithoutScopedMetadata(), singleRepairHandoff()];
