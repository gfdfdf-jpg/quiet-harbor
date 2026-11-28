import assert from 'node:assert/strict';
import { recordedFailureRecheckScenario } from './walk-test-selection-scenarios';
import { preservedDeltaFieldScenario } from './walk-preserved-delta-field-scenarios';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRuntime, command, type Runtime } from '../../migration/p4-fixtures';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { captureWalkOutput } from './walk-output';
import { runOperatorApprovedCommand } from './walk-operator-approval';
import type { WalkScenario } from './navigator-walk';
import { STACK_MANIFESTS, readStackExecutions, stackInvocations } from './walk-stack-fixtures';
import { stackScenario } from './walk-stack-scenarios';
import { readRecordedOutOfScopeFailures } from '../../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { atomicWalkJson } from './walk-run-store';
import { FIELD_CASE_IDS, R144_FIELD_CASE_IDS } from './walk-field-case-ids';
import { onlineStoreCloseoutScenario } from './walk-onlinestore-closeout-scenarios';
import { OP056_FIELD_CASE_IDS, T437_DOC_IMPACT_FLAG_MISMATCH_FIELD_CASE_ID, T437_STALE_BASELINE_FIELD_CASE_ID, T437_UNCHANGED_RECLASSIFICATION_FIELD_CASE_ID,
    closeoutEvidenceMistakeScenario, staleQualityBaselineSelectionScenario, workflowConfigDriftResolvedScenario } from './walk-dead-end-field-scenarios';
import { r144FieldCase } from './walk-field-r144-scenarios';
import { decompositionFieldScenario, T212_FIELD_CASE_IDS } from './walk-decomposition-field-scenarios';
import { fillQualityAnswers, NODE_WALK_FIXTURE } from './walk-fixture';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { readTaskTimelineJsonlEntries } from '../../../../src/gate-runtime/task-events';
import { renamedParentFieldScenario } from './walk-parent-coverage-scenarios';
import { activeUpdateFieldScenario, closedTaskUpdateFieldScenario, draftUpdateFieldScenario,
    reviewCycleMarkBlockedFieldScenario, workflowNoChangeScenario } from './walk-update-workflow-field-scenarios';
export { FIELD_CASE_IDS, R144_FIELD_CASE_IDS } from './walk-field-case-ids';

/** Pin the producer before the Maven attribution fix; never forge legacy references. */
export const FIELD_LEGACY_GARDA_COMMIT = '02d86b380e215837c8b79619cc86fbbf01bf2247';
/** Tree of FIELD_LEGACY_GARDA_COMMIT: CI receives only this tree, never the history. */
export const FIELD_LEGACY_GARDA_TREE = '96806fc4ba44ed12a61152a2edf1cf55c7c0aa10';

export const FIELD_TWO_MODULE_COUNTER_STATE = 'stack-fixture-spring-maven-two-modules';

/** The fixture is a Spring reactor with an external parent and unrelated JaCoCo excludes. */
export function fieldSpringScenario(id: string, modules: 1 | 2 = 2): WalkScenario {
    const manifest = structuredClone(STACK_MANIFESTS.find(item => item.id === 'spring-maven')!);
    const rename = (text: string) => text.replaceAll('application', 'a').replaceAll('partners-module', 'b')
        .replaceAll('OrderServiceTest', 'A').replaceAll('PartnerServiceTest', 'B');
    for (const suite of manifest.suites) { suite.source = rename(suite.source); suite.target = rename(suite.target); }
    for (const technology of manifest.technologies) for (const key of ['compileArgv', 'firstArgv', 'allArgv', 'secondArgv', 'broadArgv'] as const)
        technology[key] = technology[key].map(rename);
    if (id === 'field-cmd-call-argv') manifest.technologies[0].allArgv.splice(-1, 0, '-Dstand.literal=left^&right');
    const base = stackScenario(manifest, 6, 'generic', false, stackInvocations(manifest, modules === 1 ? 6 : 3));
    base.id = id;
    base.fixture!.files = Object.fromEntries(Object.entries(base.fixture!.files).map(([file, bytes]) => [rename(file), rename(bytes)]));
    // Registered field cases select both tests; the one-module form is the independent calibration control.
    if (modules === 2) base.counterState = FIELD_TWO_MODULE_COUNTER_STATE;
    base.reselectAfterFailure = true;
    return base;
}

export function fieldCase(id: typeof FIELD_CASE_IDS[number], modules: 1 | 2 = 2): WalkScenario {
    if (id === 'field-r144-renamed-parent-audit') return renamedParentFieldScenario();
    if (id === 'field-r144-update-active-task') return activeUpdateFieldScenario();
    if (id === 'field-r144-update-draft-status') return draftUpdateFieldScenario();
    if (id === 'field-r144-workflow-set-no-change') return workflowNoChangeScenario();
    if (id === 'field-r144-review-cycle-mark-blocked') return reviewCycleMarkBlockedFieldScenario();
    if (id === 'field-r144-update-operator-closed-task') return closedTaskUpdateFieldScenario();
    if (id === 'field-onlinestore-op050-case-source') return onlineStoreCaseSourceScenario();
    if (id === 'field-onlinestore-op051-literal-brackets') return onlineStoreLiteralBracketsScenario();
    if (id === 'field-t409-planned-superset-restart') return plannedSupersetRestartScenario();
    if (id === 'field-guard-intent-change-restart') return postReviewGuardScenario(id, 'intent');
    if (id === 'field-guard-restore-deferred-edit') return postReviewGuardScenario(id, 'restore');
    if (id === T437_STALE_BASELINE_FIELD_CASE_ID) return staleQualityBaselineSelectionScenario();
    if (id === T437_DOC_IMPACT_FLAG_MISMATCH_FIELD_CASE_ID || id === T437_UNCHANGED_RECLASSIFICATION_FIELD_CASE_ID) return closeoutEvidenceMistakeScenario(id);
    if ((OP056_FIELD_CASE_IDS as readonly string[]).includes(id)) return workflowConfigDriftResolvedScenario(id as typeof OP056_FIELD_CASE_IDS[number]);
    if ((T212_FIELD_CASE_IDS as readonly string[]).includes(id)) return decompositionFieldScenario(id as typeof T212_FIELD_CASE_IDS[number]);
    if ((R144_FIELD_CASE_IDS as readonly string[]).includes(id)) return r144FieldCase(id as typeof R144_FIELD_CASE_IDS[number]);
    if (id === 'field-onlinestore-t022-1-closeout') return onlineStoreCloseoutScenario();
    if (id === 'field-onlinestore-op055-deferred-other-lane') return continuedRemediationScenario(id);
    if (id === 'field-onlinestore-t006-7-1-audit-only') return recordedFailureRecheckScenario();
    if (id === 'field-onlinestore-passed-delta-after-test-repair') return preservedDeltaFieldScenario();
    const base = fieldSpringScenario(id, modules);
    const legacyProducer = id === 'field-onlinestore-op035-follow-up-attribution';
    if (id === 'field-onlinestore-op035-follow-up-attribution') {
        // OP-035: old native Maven parsing authenticates exception/time tokens as refs.
        // Fake only the toolchain output, before its own output digest is recorded.
        const runner = base.fixture!.files['.stand/runner.cjs'];
        const broad = "else if (broad) output = 'worker 7f3a: repository audit\\n3 checks broke in an unrelated resource boundary';";
        assert.ok(runner.includes(broad), 'Pinned broad-output fixture changed');
        base.fixture!.files['.stand/runner.cjs'] = runner.replace(broad,
            "else if (broad) output = '14:19:54.151 [main] WARN java.lang.RuntimeException: unrelated failure\\n"
            + "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.5.2:test';");
    }
    let old: Runtime | undefined, oldRoot: string | undefined, legacySelected = false, legacyFailed = false, checkedRefusal = false, offered = false;
    let retained: Buffer | undefined;
    const timeline = (root: string) => path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-WALK.jsonl');
    return { ...base,
        // Spreading a scenario must preserve its stateful broad -> own selection getter.
        get testSelectionCommand() {
            return legacyProducer && legacyFailed ? base.fixture!.taskTestCommand : base.testSelectionCommand;
        },
        inspectNavigation: (result, steps) => {
            if (id !== 'field-project-command-reselection' || result.next_gate !== 'full-suite-validation'
                || steps.some(step => step.gate === 'full-suite-validation')) return;
            assert.match(result.reason, /Selected task test command/iu);
            assert.ok(result.commands.some(item => /workflow.*set/u.test(item.command)
                && /--(?:task-test-command|full-suite-command)/u.test(item.command)),
            'A recorded project command must offer own-test reselection before execution');
            offered = true;
        },
        execute: async (root, step) => {
            if (id === 'field-misleading-in-scope-refusal' && step.gate === 'task-test-selection' && !checkedRefusal) {
                checkedRefusal = true;
                const output: string[] = [];
                let refused = '';
                try {
                    await captureWalkOutput(output, async () => handleSet({ targetRoot: root, taskId: 'T-WALK',
                        fullSuiteCommand: base.fixture!.taskTestCommand.replace('-Dtest=A,B', '-Dtest=A'),
                        focusedRequiredTestPath: base.selectionTargets!,
                        taskTestSelectionReason: 'T-WALK selection verifies the changed task modules with ' + base.selectionTargets!.join(', '), json: true }));
                } catch (error) { refused = String(error); }
                assert.match(refused, /b\/src\/test\/java\/example\/B\.java|exact argv association|explicit mapping/iu, output.join('\n'));
                assert.doesNotMatch(refused, /unresolved in-scope failing test cannot be dropped/iu);
            }
            if (!legacyProducer || step.gate !== 'task-test-selection' || legacyFailed) return false;
            if (!old) {
                oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-field-old-'));
                old = buildRuntime(oldRoot, FIELD_LEGACY_GARDA_TREE);
            }
            const selectedArgv = ['workflow', 'set', '--task-id', 'T-WALK', '--full-suite-command', base.fixture!.projectTestCommand,
                    ...base.selectionTargets!.flatMap(target => ['--focused-required-test-path', target]),
                    '--reason', 'T-WALK selection verifies the changed task modules with ' + base.selectionTargets!.join(', '), '--target-root', root, '--json'];
            const selected = command(process.execPath, [old.readerCli, ...selectedArgv], root);
            assert.equal(selected.code, 0, selected.output); legacySelected = true;
            step.command = [process.execPath, old.readerCli, ...selectedArgv].map(arg => JSON.stringify(arg)).join(' ');
            step.exitCode = selected.code; step.output = selected.output;
            // Finish the real historical producer phase before handing the repository to the new reader.
            // A new-version navigator must never be asked to approve or run the legacy broad selection.
            const argv = ['gate', 'full-suite-validation', '--task-id', 'T-WALK', '--preflight-path',
                'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json', '--repo-root', root];
            const result = command(process.execPath, [old.readerCli, ...argv], root);
            (step.preparation ??= []).push({ command: [process.execPath, old.readerCli, ...argv].map(arg => JSON.stringify(arg)).join(' '),
                output: 'Historical producer exit=' + result.code + '\n' + result.output });
            assert.notEqual(result.code, 0, result.output);
            assert.equal(readStackExecutions(root).filter(item => item.purpose === 'broad').length, 1,
                'The older Garda must actually execute the broad failure');
            retained = fs.readFileSync(timeline(root)); legacyFailed = true;
            const output = process.env.GARDA_SYNTHETIC_WALK_REPORT;
            if (output) {
                const directory = path.join(output, 'field-legacy-evidence', id);
                fs.mkdirSync(directory, { recursive: true });
                fs.writeFileSync(path.join(directory, 'before-update.jsonl'), retained);
                fs.cpSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews'), path.join(directory, 'reviews'), { recursive: true });
                fs.copyFileSync(path.join(old.root, 'p4-provenance.json'), path.join(directory, 'producer.json'));
                atomicWalkJson(path.join(directory, 'broad-command.json'), { argv, ...result });
            }
            return true;
        },
        inspectResult: (root, result) => {
            base.inspectResult?.(root, result);
            if (result.outcome !== 'done') return;
            if (legacyProducer) {
                assert.ok(legacySelected && legacyFailed && retained);
                assert.ok(fs.readFileSync(timeline(root)).subarray(0, retained.length).equals(retained), 'Old events stay byte-identical');
            }
            if (id === 'field-project-command-reselection') assert.ok(offered);
            if (id === 'field-misleading-in-scope-refusal') assert.ok(checkedRefusal);
            const failures = readRecordedOutOfScopeFailures(root, 'T-WALK');
            assert.equal(failures.length, 1);
            if (id === 'field-onlinestore-op035-follow-up-attribution') {
                assert.equal(failures[0].attribution, 'attributed', 'Retain the raw historical attribution unchanged');
                assert.ok(failures[0].failing_tests.some(ref => /RuntimeException|14[.:]|maven\.plugins/u.test(ref)),
                    'The actual old producer must reproduce the noisy reference list');
                const task = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
                const child = task.split(/\r?\n/u).find(line => line.includes('out_of_scope_follow_up=grouped'))!;
                assert.ok(child); assert.match(child, /Tests: not attributed/u);
                assert.doesNotMatch(child, /Failing tests:|RuntimeException|14:19|org\.apache\.maven\.plugins/u);
            } else assert.equal(failures[0].attribution, 'not attributed');
            const own = readStackExecutions(root).filter(item => item.purpose === 'own');
            assert.ok(own.length); assert.ok(own.every(item => item.argv.includes('a,b') && item.argv.includes('-Dtest=A,B')),
                'CALL/.cmd and native execution must preserve comma-list argv exactly');
            assert.ok(own.every(item => item.targets.length === 2));
            if (id === 'field-cmd-call-argv') assert.ok(own.every(item => item.argv.includes('-Dstand.literal=left^&right')),
                'CALL must not add an expansion pass or double the quoted caret');
        },
        cleanup: async () => { if (oldRoot) fs.rmSync(oldRoot, { recursive: true, force: true }); }
    };
}

function continuedRemediationScenario(id: string): WalkScenario {
    const reviewType = 'test';
    const taskId = 'T-WALK';
    let secondEditChecked = false;
    let postLaunchEditChecked = false;
    const assertUnapprovedEditRefused = (root: string, edit: string) => {
        const file = path.join(root, 'tests/app.test.ts');
        const approvedBytes = fs.readFileSync(file);
        try {
            fs.appendFileSync(file, edit);
            const route = resolveNextStep({ repoRoot: root, taskId });
            assert.equal(route.status, 'BLOCKED', route.reason);
            assert.ok(!route.commands.some(action => /gate restart-review-cycle /u.test(action.command)
                && /--review-type "test"/u.test(action.command) && !/--review-restart-approved|--operator-confirmed/u.test(action.command)),
            route.reason);
        } finally { fs.writeFileSync(file, approvedBytes); }
    };
    return {
        id,
        edits: [{ path: 'src/app.ts', append: '// Product change.\n' }, { path: 'tests/app.test.ts', append: '// Task regression.\n' }],
        failures: { code: 1, test: 1 }, findingSeverityByLane: { code: 'low', test: 'high' },
        fix: [{ path: 'tests/app.test.ts', append: '// Repaired fix-now finding.\n' }],
        expectedReviews: { code: 1, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'test:DELTA'],
        expectedGates: ['restart-review-cycle', 'materialize-review-follow-up-tasks'],
        configure: () => { secondEditChecked = false; postLaunchEditChecked = false; },
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.exitCode !== 0 || !['restart-review-cycle', 'prepare-reviewer-launch'].includes(String(last.gate))) return;
            const timeline = path.join(root, 'garda-agent-orchestrator/runtime/task-events', `${taskId}.jsonl`);
            const events = readTaskTimelineJsonlEntries(timeline).map(entry => entry.record);
            const types = events.map(event => event?.event_type);
            const restart = types.lastIndexOf('REVIEW_CYCLE_RESTARTED');
            if (restart < 0) return;
            if (!secondEditChecked && last.gate === 'restart-review-cycle') {
                const refreshed = types.lastIndexOf('PREFLIGHT_CLASSIFIED', restart - 1);
                const replay = events.slice(refreshed + 1, restart);
                assert.ok(replay.some(event => event?.event_type === 'REVIEW_RECORDED'
                    && (event.details as Record<string, unknown>)?.review_type === 'code'), 'Native reuse re-recorded the other lane.');
                assert.ok(replay.some(event => event?.event_type === 'REVIEW_PHASE_STARTED'
                    && (event.details as Record<string, unknown>)?.review_type === reviewType), 'The failed lane opened its native phase.');
                assertUnapprovedEditRefused(root, '// OP-055 second edit after re-review preparation.\n');
                secondEditChecked = true;
            }
            if (!postLaunchEditChecked && secondEditChecked && last.gate === 'prepare-reviewer-launch'
                && events.slice(restart + 1).some(event => event?.event_type === 'REVIEWER_LAUNCH_PREPARED'
                    && (event.details as Record<string, unknown>)?.review_type === reviewType)) {
                assertUnapprovedEditRefused(root, '// OP-055 edit after native reviewer launch preparation.\n');
                postLaunchEditChecked = true;
            }
        },
        inspectResult: (_root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            const restart = result.events.findIndex(event => event.type === 'REVIEW_CYCLE_RESTARTED'
                && event.details.restart_reason === 'failed_review_remediation_cycle');
            assert.ok(restart > 0, 'The native failed-lane restart completed.');
            const classification = result.events.slice(0, restart).map(event => event.type).lastIndexOf('PREFLIGHT_CLASSIFIED');
            assert.ok(classification >= 0 && result.events.slice(classification + 1, restart).some(event =>
                event.type === 'REVIEW_PHASE_STARTED' && event.details.review_type === 'test'),
            'The failed test lane opened its re-review phase under the restarted preflight.');
            assert.ok(result.steps.some(step => step.gate === 'materialize-review-follow-up-tasks' && step.exitCode === 0));
            assert.ok(secondEditChecked && postLaunchEditChecked, 'Both edits exercised the authority boundary in this native walk.');
        }
    };
}

function onlineStoreLiteralBracketsScenario(): WalkScenario {
    const id = 'field-onlinestore-op051-literal-brackets';
    const route = 'src/app/api/auth/[...nextauth]/route.ts';
    const fixture = { ...NODE_WALK_FIXTURE, id, files: { ...NODE_WALK_FIXTURE.files, [route]: 'export const GET = () => "session";\n' } };
    return {
        id, fixture,
        disturbanceReason: 'OP-051, OnlineStore: a changed route path with literal brackets must stay a literal path when the task selects its ordinary test.',
        edits: [{ path: route, append: 'export const POST = () => "session";\n' }, { path: 'tests/app.test.ts', append: '// Verify the changed route.\n' }],
        // An auth/api route path also requires the security and api lanes.
        expectedReviews: { code: 1, security: 1, api: 1, test: 1 }, expectedModes: ['code:FULL', 'security:FULL', 'api:FULL', 'test:FULL'], enforceReviewExpectations: true,
        expectedGates: ['task-test-selection', 'build-review-context'],
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            const preflight = JSON.parse(fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json'), 'utf8')) as { changed_files: string[] };
            assert.ok(preflight.changed_files.includes(route), 'The literal bracketed route stays a changed source file: ' + preflight.changed_files.join(', '));
            assert.ok(!result.steps.some(step => step.gate === 'task-test-selection' && step.exitCode), 'Selecting the ordinary test for the bracketed route is admitted');
        }
    };
}

/**
 * T-409 (cfd696ac, 65fc1a85): the approved plan names more files than the task changes. A failed code review is fixed and
 * the review cycle restarts. Only files that actually changed count as remediation scope: untouched planned files never widen
 * it, the FULL scope is the current preflight, and the repair is judged as DELTA with the other lane's FULL review kept.
 */
function plannedSupersetRestartScenario(): WalkScenario {
    const id = 'field-t409-planned-superset-restart';
    const actual = ['src/app.ts', 'src/feature-b.ts', 'tests/app.test.ts', 'tests/feature-b.test.ts'];
    const untouchedPlanned = ['src/planned-only.ts', 'docs/planned-only.md'];
    const fixture = { ...NODE_WALK_FIXTURE, id, files: { ...NODE_WALK_FIXTURE.files,
        'src/feature-b.ts': 'export const featureB = 1;\n', 'tests/feature-b.test.ts': 'import test from "node:test";\n\ntest("feature b", () => undefined);\n',
        'src/planned-only.ts': 'export const plannedOnly = 0;\n', 'docs/planned-only.md': '# Planned only\n' } };
    return {
        id, fixture,
        disturbanceReason: 'T-409: planned files that the task never changes must not count as remediation scope after a failed-review restart.',
        setup: root => {
            const file = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-WALK-task-plan.json');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, serializeTaskPlan(validateTaskPlan({ schema_version: 1, task_id: 'T-WALK', status: 'approved', goal: 'Change the status renderer and feature B',
                scope_files: [...actual, ...untouchedPlanned], risk_level: 'low', steps: [{ id: 'one', title: 'Implement and verify both features' }],
                acceptance_criteria: ['Both features stay covered'], verification_expectations: ['Focused tests'], out_of_scope: ['Other behavior'] })));
        },
        edits: actual.map(file => ({ path: file, append: '// planned-superset family\n' })),
        failures: { code: 1 }, fix: [{ path: 'src/app.ts', append: '// fixed\n' }],
        expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'code:DELTA', 'test:FULL'], enforceReviewExpectations: true,
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            const reviews = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
            const preflight = JSON.parse(fs.readFileSync(path.join(reviews, 'T-WALK-preflight.json'), 'utf8')) as { changed_files: string[] };
            assert.deepEqual([...preflight.changed_files].sort(), [...actual].sort(), 'The FULL scope is the current preflight: actual files only');
            const remediation = JSON.parse(fs.readFileSync(path.join(reviews, 'T-WALK-review-remediation-cycle.json'), 'utf8')) as {
                remediation_scope: { status: string; current_changed_files: string[]; expanded_non_test_files: string[] };
                remediation_fix_classification: { scope_category: string } };
            assert.notEqual(remediation.remediation_scope.status, 'BLOCKED');
            assert.deepEqual([...remediation.remediation_scope.current_changed_files].sort(), [...actual].sort(), 'Remediation scope names actual changed paths');
            for (const planned of untouchedPlanned) {
                assert.ok(!remediation.remediation_scope.current_changed_files.includes(planned), 'Untouched planned file excluded: ' + planned);
            }
            assert.deepEqual(remediation.remediation_scope.expanded_non_test_files, []);
            assert.notEqual(remediation.remediation_fix_classification.scope_category, 'expanded_non_test_blocked');
        }
    };
}

/**
 * Post-review mutation guard (b327dfbe, d0e95287, 20d13c2b, 701962eb). After an accepted deferred code finding the agent edits source.
 * The guard states two routes. `intent`: the operator confirms a changed task intent; the offered intent-change command runs with
 * ONE fresh confirmation, records one operator intent event and repeats every required review in FULL. `restore`: the agent
 * restores the frozen state; the deferred-only edit gains no remediation authority (no restart, no repeated review).
 */
function postReviewGuardScenario(id: string, route: 'intent' | 'restore'): WalkScenario {
    const intentText = 'Changed task intent: the status renderer and the deferred follow-up change';
    const edit = '// deferred-only edit after review\n';
    let mutated = false, handled = false, original = '';
    return {
        id,
        edits: [{ path: 'src/app.ts', append: '// Product change.\n' }, { path: 'tests/app.test.ts', append: '// Task regression.\n' }],
        failures: { code: 1 }, findingSeverity: 'low',
        expectedReviews: route === 'intent' ? { code: 2, test: 1 } : { code: 1, test: 1 },
        expectedModes: route === 'intent' ? ['code:FULL', 'code:FULL', 'test:FULL'] : ['code:FULL', 'test:FULL'],
        enforceReviewExpectations: true,
        disturbanceReason: 'An edit after accepted deferred review findings; the guard states an operator intent change or a restore: ' + route + '.',
        configure: () => { mutated = false; handled = false; original = ''; },
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (mutated || last?.gate !== 'record-review-result' || last.exitCode !== 0) return;
            const file = path.join(root, 'src/app.ts');
            original = fs.readFileSync(file, 'utf8');
            fs.appendFileSync(file, edit);
            mutated = true;
        },
        execute: async (root, step) => {
            if (step.gate !== 'post-review-source-mutation-guard' || handled) return false;
            handled = true;
            if (route === 'restore') {
                fs.writeFileSync(path.join(root, 'src/app.ts'), original);
                step.exitCode = 0; step.output = 'The agent restored the frozen source; no remediation was requested.';
                return true;
            }
            assert.ok((step.command ?? '').includes('--operator-confirmed'), 'The offered intent-change command carries the fresh operator confirmation: ' + step.command);
            await runOperatorApprovedCommand(step, [['<operator-stated task intent>', intentText], [/<ISO-8601[^>]*>/u, new Date().toISOString()]]);
            assert.equal(step.exitCode, 0, step.output);
            return true;
        },
        inspectResult: (_root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            const updates = result.events.filter(event => event.type === 'TASK_INTENT_UPDATED');
            if (route === 'intent') {
                assert.equal(updates.length, 1, 'One operator intent event');
                assert.equal(updates[0].details.task_intent, intentText);
                assert.equal(updates[0].details.operator_confirmed, true);
            } else {
                assert.equal(updates.length, 0, 'A restore records no operator intent');
                assert.ok(!result.steps.some(step => ['restart-review-cycle', 'restart-coherent-cycle'].includes(String(step.gate))),
                    'A deferred-only edit that is restored gains no remediation authority');
                assert.ok(result.steps.some(step => step.gate === 'materialize-review-follow-up-tasks' && step.exitCode === 0));
            }
        }
    };
}

function onlineStoreCaseSourceScenario(): WalkScenario {
    const id = 'field-onlinestore-op050-case-source';
    const source = 'backend/application/src/test/java/example/CatalogPermissionIntegrationTest.java';
    const wrongTest = 'backend/application/src/test/java/example/ProductPublicationPostgresIntegrationTest.java';
    const method = 'everyRouteDeniesLegacyRolesWithoutStoredGrants';
    const selector = 'CatalogPermissionIntegrationTest#' + method;
    const xml = '<testcase classname="example.CatalogPermissionIntegrationTest" name="' + method + '"/>';
    const wrapper = process.platform === 'win32' ? 'backend/mvnw.cmd' : 'backend/mvnw';
    const caseCommand = wrapper + ' -f backend/pom.xml -pl application -am test -Dtest=' + selector
        + ' -Dsurefire.failIfNoSpecifiedTests=false';
    const runtime = 'garda-agent-orchestrator/runtime';
    const preflight = runtime + '/reviews/T-WALK-preflight.json';
    const answersPath = runtime + '/tmp/T-WALK-quality-checklist-answers.json';
    const artifactPath = runtime + '/reviews/T-WALK-quality-checklist.json';
    const edits = [{ path: 'src/auth/session.ts', append: 'export const session = "s";\n' },
        { path: 'tests/app.test.ts', append: '// Verify the changed session.\n' }];
    const fixture = { ...NODE_WALK_FIXTURE, id, caseCommand,
        cases: [{ source, case_id: method, selector }],
        passedCaseQuote: (_root: string, _source: string, _selector: string, output: string) => output.includes(xml) ? xml : undefined,
        caseReasoning: 'The retained output names the selected class and method.',
        trustBoundaryMatrix: [{
            boundary_id: 'TB-050', boundary: 'Stored grant to route authority',
            authority_source: 'Stored catalog grants', mutable_inputs: ['request roles'],
            integrity_evidence: ['grant identity'], canonical_reconstruction: 'Load the grant from storage.',
            toctou_replay: 'Retry using legacy roles.', negative_paths: [{ kind: 'other', scenario: method,
                expected_behavior: 'Reject legacy roles without stored grants.', evidence_files: [wrongTest + '#' + method] }]
        }],
        executableFiles: process.platform === 'win32' ? [] : [wrapper],
        files: { ...NODE_WALK_FIXTURE.files,
            [source]: 'package example;\nclass CatalogPermissionIntegrationTest { @org.junit.jupiter.api.Test void ' + method + '() {} }\n',
            [wrongTest]: 'package example;\nclass ProductPublicationPostgresIntegrationTest {}\n',
            'backend/pom.xml': '<project><modules><module>application</module></modules></project>\n',
            'backend/application/pom.xml': '<project/>\n',
            [wrapper]: process.platform === 'win32' ? '@echo off\nnode backend/runner.cjs %*\n'
                : '#!/bin/sh\nexec node backend/runner.cjs "$@"\n',
            'backend/runner.cjs': [
                'if (!process.argv.includes(' + JSON.stringify('-Dtest=' + selector) + ')) process.exit(2);',
                'console.log(' + JSON.stringify(xml) + ');'
            ].join('\n')
        }
    };
    let stage = 0;
    function correctReference(root: string) {
        const file = path.join(root, answersPath);
        const template = JSON.parse(fs.readFileSync(file, 'utf8'));
        const answer = template.answers.find((entry: { trust_boundary_matrix?: unknown }) => entry.trust_boundary_matrix);
        const negative = answer.trust_boundary_matrix[0].negative_paths[0];
        assert.deepEqual(negative.evidence_files, [wrongTest + '#' + method]);
        negative.evidence_files = [source + '#' + method];
        answer.answer = 'Verified the stored-grant refusal in the corrected source.';
        fs.writeFileSync(file, JSON.stringify(template, null, 2) + '\n');
    }
    return {
        id, fixture,
        disturbanceReason: 'OP-050, OnlineStore T-007-3-F1. The checklist cites the wrong class for a reactor test and is corrected after the gate refuses it.',
        edits,
        requiredLanes: ['security'],
        expectedReviews: { code: 1, security: 1, test: 1 }, expectedModes: ['code:FULL', 'security:FULL', 'test:FULL'],
        enforceReviewExpectations: true,
        expectedGates: ['quality-checklist', 'run-intermediate-command', 'build-review-context'],
        expectedFailingGates: ['quality-checklist'],
        configure: () => { stage = 0; },
        act: async (root, gate, steps, run) => {
            if (gate !== 'quality-checklist') return false;
            if (stage === 0) {
                const file = path.join(root, answersPath);
                if (!fs.existsSync(file)) return false;
                fillQualityAnswers(file, edits.map(edit => edit.path), fixture);
                // Submit directly to exercise the gate's refusal and subsequent recovery of the same template.
                await run(['quality-checklist', '--task-id', 'T-WALK', '--preflight-path', preflight,
                    '--answers-path', answersPath, '--repo-root', '.'], 3);
                const artifact = JSON.parse(fs.readFileSync(path.join(root, artifactPath), 'utf8'));
                assert.equal(artifact.status, 'CONFIG_ERROR');
                assert.equal(artifact.validation_phases.structural, 'INVALID');
                const violations = artifact.violations.join('\n');
                assert.ok(violations.includes(wrongTest) && violations.includes(method), violations);
                assert.match(violations, /Cite the file that declares this case/u);
                assert.match(violations, /identifier as written in that file as case_id/u);
                assert.match(violations, /selector may stay the full runner ID/u);
                steps.at(-1)!.exitCode = 3;
                stage = 1;
                return true;
            }
            if (stage !== 2) return false;
            correctReference(root);
            stage = 3;
            return true;
        },
        inspectNavigation: (result, steps) => {
            const previous = steps.at(-1);
            if (stage === 0 && previous?.gate === 'quality-checklist' && previous.exitCode !== null) {
                assert.equal(previous.exitCode, 3, 'The quality-checklist gate must refuse the wrong source.\n' + previous.output);
            }
            if (stage === 1) {
                assert.equal(result.next_gate, 'quality-checklist', result.reason);
                assert.equal(result.quality_checklist?.status, 'CONFIG_ERROR');
                assert.equal(result.commands.length, 0);
                stage = 2;
            } else if (stage === 3) {
                // Shop T-007-4: the selected case runs before the checklist that depends on it, so the checklist is recorded once.
                assert.equal(result.next_gate, 'run-intermediate-command', result.reason);
                assert.equal(result.commands.length, 0);
                assert.ok(result.reason.includes(source + '#' + method), result.reason);
                stage = 4;
            } else if (stage === 4 && previous?.gate === 'run-intermediate-command') {
                assert.ok(previous.preparation?.some(item => item.command.includes('--selected-case')), 'The agent ran the selected case');
                assert.equal(result.next_gate, 'quality-checklist', result.reason);
                assert.match(result.commands[0]?.command ?? '', /--answers-path/u);
                assert.match(result.reason, /updated after CONFIG_ERROR remediation/u);
                stage = 5;
            } else if (stage === 5) {
                assert.equal(previous?.gate, 'quality-checklist');
                assert.equal(previous?.exitCode, 0, previous?.output);
                assert.notEqual(result.next_gate, 'run-intermediate-command', result.reason);
                assert.notEqual(result.next_gate, 'quality-checklist', result.reason);
                stage = 6;
            }
        },
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            assert.equal(stage, 6);
            assert.deepEqual(result.steps.filter(step => step.gate === 'quality-checklist' && step.exitCode !== null)
                .map(step => step.exitCode), [3, 0], 'The corrected checklist is recorded once, after the focused run');
            assert.equal(result.events.filter(event => event.type === 'QUALITY_CHECKLIST_RECORDED').length, 2,
                'One refused and one accepted checklist record');
            const artifact = JSON.parse(fs.readFileSync(path.join(root, artifactPath), 'utf8'));
            assert.equal(artifact.validation_phases.structural, 'BOUND');
            assert.equal(artifact.validation_phases.execution, 'OBSERVED');
            assert.deepEqual(artifact.validation_phases.obligations.map((item: { source_identity: { path: string }; target_id: string }) =>
                [item.source_identity.path, item.target_id]), [[source, method]]);
        }
    };
}

export const FIELD_CASE_SCENARIOS: readonly WalkScenario[] = FIELD_CASE_IDS.map(id => fieldCase(id));
