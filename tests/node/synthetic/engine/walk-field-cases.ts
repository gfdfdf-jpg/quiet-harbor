import assert from 'node:assert/strict';
import { recordedFailureRecheckScenario } from './walk-test-selection-scenarios';
import { preservedDeltaFieldScenario } from './walk-preserved-delta-field-scenarios';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRuntime, command, type Runtime } from '../../migration/p4-fixtures';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { captureWalkOutput } from './walk-output';
import type { WalkScenario } from './navigator-walk';
import { STACK_MANIFESTS, readStackExecutions, stackInvocations } from './walk-stack-fixtures';
import { stackScenario } from './walk-stack-scenarios';
import { readRecordedOutOfScopeFailures } from '../../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { atomicWalkJson } from './walk-run-store';
import { FIELD_CASE_IDS, R144_FIELD_CASE_IDS } from './walk-field-case-ids';
import { onlineStoreCloseoutScenario } from './walk-onlinestore-closeout-scenarios';
import { r144FieldCase } from './walk-field-r144-scenarios';
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
    if ((R144_FIELD_CASE_IDS as readonly string[]).includes(id)) return r144FieldCase(id as typeof R144_FIELD_CASE_IDS[number]);
    if (id === 'field-onlinestore-t022-1-closeout') return onlineStoreCloseoutScenario();
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

export const FIELD_CASE_SCENARIOS: readonly WalkScenario[] = FIELD_CASE_IDS.map(id => fieldCase(id));
