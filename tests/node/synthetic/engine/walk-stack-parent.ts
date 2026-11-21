import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { isTestScopePath } from '../../../../src/core/file-role-bindings';
import { inspectValidationCommand } from '../../../../src/core/validation-command-contract';
import { resolveTaskProfileReviewTriggerPolicy } from '../../../../src/policy/task-profile-policy-snapshot';
import { runHumanCommitCommand } from '../../../../src/cli/commands/gates';
import { parentArtifactPath, parentRecordDigest, readParentRecord } from '../../../../src/gates/parent-audit/parent-audit-auth';
import type { ParentReviewInput, ParentAuditOutput } from '../../../../src/gates/parent-audit/parent-audit-types';
import { inspectParentCompletion } from '../../../../src/gates/parent-audit/parent-audit-state';
import { parentChildSourceIdentity } from '../../../../src/gates/parent-audit/parent-audit-graph';
import { readNativeChildSourceAcceptance } from '../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs';
import { runGit } from '../../cli/commands/gate-test-helpers';
import type { WalkScenario } from './navigator-walk';
import { stackCommand, stackFixture, stackExecutionViolations, type StackExecution, type StackManifest, type StackMode, type StackTaskPlan } from './walk-stack-fixtures';

const TASK = 'T-WALK', BUNDLE = 'garda-agent-orchestrator';
const LANES = ['code', 'security', 'performance', 'test'];

/** Move the complete companion evidence at a task boundary; never discard individual attempts. */
export function archiveStackTaskEvidence(root: string, taskId: string): void {
    const directory = path.join(root, '.git/stand-task-archives', taskId);
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.mkdirSync(directory); // An accepted task archive must never be overwritten.
    fs.renameSync(path.join(root, '.git/stand-task.json'), path.join(directory, 'plan.json'));
    const journal = path.join(root, '.git/stand-invocations.jsonl'), archive = path.join(directory, 'invocations.jsonl');
    if (fs.existsSync(journal)) fs.renameSync(journal, archive);
    else fs.writeFileSync(archive, '');
}

export function inspectStackTaskArchive(root: string, taskId: string, expectedPlan: StackTaskPlan): StackExecution[] {
    const directory = path.join(root, '.git/stand-task-archives', taskId);
    const plan = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8')) as StackTaskPlan;
    assert.deepEqual(plan, { ...expectedPlan, repoRoot: root }, 'Archived child plan: ' + taskId);
    const records = fs.readFileSync(path.join(directory, 'invocations.jsonl'), 'utf8').trim().split('\n')
        .filter(Boolean).map(line => JSON.parse(line) as StackExecution);
    assert.deepEqual(stackExecutionViolations(root, plan, records), [], 'Archived child execution oracle: ' + taskId);
    return records;
}

/** Native split, child gates, SOURCE commits and parent audit. Commits are only in the disposable fixture. */
export function stackDecomposition(manifest: StackManifest, _mode: StackMode, base: WalkScenario, plan: StackTaskPlan): WalkScenario {
    let current = TASK, active = TASK, split = false, linked = false;
    const committed = new Set<string>(), implemented = new Set<string>(), rolesDeclared = new Set<string>();
    const childIds = [TASK + '-1', TASK + '-2'];
    const childSuites = () => [manifest.suites[childIds.indexOf(current)]];
    const childPlans = childIds.map((_id, index) => {
        const suite = manifest.suites[index];
        const technology = manifest.technologies.find(tech => tech.id === suite.technology)!;
        const argv = manifest.suites.filter(item => item.technology === suite.technology).length === 1
            || index === 0 ? technology.firstArgv : technology.secondArgv;
        assert.ok(argv, 'Missing component invocation in fixture ' + manifest.id);
        return { ...plan, invocations: [{ technology: technology.id, argv, targets: [suite.target], command: stackCommand(technology, argv) }] };
    });
    const childFixtures = childPlans.map(childPlan => stackFixture(manifest, _mode, childPlan.invocations));
    // Rust's *_contract.rs targets activate the established API policy (S12).
    const childLanes = manifest.id === 'rust' ? ['code', 'security', 'api', 'performance', 'test'] : LANES;
    const activate = (root: string) => {
        if (active === current) return;
        archiveStackTaskEvidence(root, active);
        active = current;
        const activePlan = current === TASK ? plan : childPlans[childIds.indexOf(current)];
        fs.writeFileSync(path.join(root, '.git/stand-task.json'), JSON.stringify({ ...activePlan, repoRoot: root }));
    };
    return {
        ...base, profile: 'strict', inspectTask: () => current,
        get counterState() { return !split ? 'stack-decomposition-planning'
            : manifest.id === 'rust' ? 'stack-five-lane-native-child-tree' : 'stack-four-lane-native-child-tree'; },
        get fixture() { return current === TASK ? base.fixture : childFixtures[childIds.indexOf(current)]; },
        get edits() { return current === TASK ? base.edits : base.edits.filter(edit =>
            [childSuites()[0].source, childSuites()[0].target].includes(edit.path)); },
        expectedGates: ['child-task', 'parent-audit'],
        expectedReviews: Object.fromEntries(childLanes.map(lane => [lane, 2])),
        expectedModes: childIds.flatMap(() => childLanes.map(lane => lane + ':FULL')),
        expectedTaskReviews: Object.fromEntries(childIds.map(id => [id, childLanes.map(lane => lane + ':FULL')])),
        get selectionTargets() { return current === TASK ? base.selectionTargets : childSuites().map(suite => suite.target); },
        get testSelectionCommand() {
            if (current === TASK) return base.testSelectionCommand;
            return childPlans[childIds.indexOf(current)].invocations[0].command;
        },
        configure: root => {
            base.configure?.(root);
            current = TASK; active = TASK; split = false; linked = false; committed.clear(); implemented.clear(); rolesDeclared.clear();
            const file = path.join(root, BUNDLE, 'live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8')); config.parent_audit = { enabled: true };
            fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
        },
        prepare: async (root, steps, run) => {
            activate(root);
            if (!steps.length) handleSet({ targetRoot: root, localCommitEnabled: 'true', json: true,
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            const last = steps.at(-1);
            if (current === TASK) {
                if (!split && last?.gate === 'load-rule-pack' && last.exitCode === 0 && steps.some(step => step.gate === 'implementation')) {
                    const contract = BUNDLE + '/runtime/tmp/stack-work-packages.json';
                    fs.writeFileSync(path.join(root, contract), JSON.stringify({ schema_version: 1, finding_obligations: [],
                        work_packages: childIds.map((id, index) => ({ task_id: id, profile: 'strict',
                            root_cause_area: 'partner-contract-' + index, objective: 'Implement independent ' + manifest.suites[index].id + ' behavior',
                            scope_obligations: [manifest.suites[index].source], validation_contract: [manifest.suites[index].target],
                            finding_obligation_ids: [], required_review_types: childLanes })) }));
                    await run(['record-strict-decomposition-decision', '--task-id', TASK, '--task-profile', 'strict',
                        '--decision', 'split-required', '--task-summary', base.taskTitle!,
                        '--reason', 'The two component contracts have independent sources and executable targets.',
                        '--scope-risk', 'Each child owns one component and preserves the other component.',
                        ...childLanes.flatMap(lane => ['--expected-review-type', lane]), '--atomicity-constraint', 'none',
                        '--work-package-contract-path', contract, '--repo-root', '.']);
                    split = true;
                }
                if (!linked && last?.effectResult?.gate === 'strict-decomposition-split-routing') {
                    const file = path.join(root, 'TASK.md');
                    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(base.taskNotes!,
                        `Decomposition source: orchestrator; child tasks: \`${childIds[0]}\`, \`${childIds[1]}\`.`)
                        + childIds.map((id, index) => `| ${id} | TODO | P1 | ${manifest.suites[index].id} | Implement independent ${manifest.suites[index].id} behavior | synthetic | 2026-11-06 | strict | Child of ${TASK}. Required reviews: ${childLanes.join(', ')}. |\n`).join(''));
                    linked = true;
                }
                if (last?.gate === 'parent-audit' && last.exitCode === 0 && last.command?.includes('--phase prepare')) {
                    const input = readParentRecord<ParentReviewInput>(root, TASK, 'review-input');
                    assert.ok(input, 'Native parent audit input');
                    await run(['parent-audit', '--task-id', TASK, '--phase', 'started', '--reviewer-identity', 'agent:stack-aggregate',
                        '--input-sha256', parentRecordDigest(input), '--controller-tool', 'collaboration.spawn_agent', '--repo-root', '.']);
                    const output: ParentAuditOutput = { schema_version: 1, task_id: TASK, attempt_id: input.attempt_id,
                        input_sha256: parentRecordDigest(input), requirements: input.obligations.map(obligation => ({ id: obligation.id,
                            result: 'satisfied', evidence: manifest.suites.flatMap(suite => [suite.source + ':1', suite.target + ':1']), finding_ids: [] })), findings: [] };
                    fs.writeFileSync(input.output_path, JSON.stringify(output, null, 2) + '\n');
                }
            } else {
                const suite = childSuites()[0];
                if (implemented.has(current) && !rolesDeclared.has(current) && last?.exitCode === 0
                    && (last.gate === 'bind-rule-pack-to-preflight'
                        || last.gate === 'load-rule-pack' && last.command?.includes('POST_PREFLIGHT'))) {
                    const preflight = JSON.parse(fs.readFileSync(path.join(root, BUNDLE, 'runtime/reviews', current + '-preflight.json'), 'utf8'));
                    const policy = resolveTaskProfileReviewTriggerPolicy(preflight.profile_policy_snapshot);
                    if (!isTestScopePath(suite.target, policy.test_path_regexes, policy.file_roles)) {
                        const index = childIds.indexOf(current), command = childPlans[index].invocations[0].command;
                        const descriptor = inspectValidationCommand(command, 'test').descriptor;
                        assert.ok(descriptor, 'Native child command descriptor');
                        const relation = `${current}: ${base.taskTitle}; ${suite.target} verifies independent ${suite.id} behavior in ${suite.source}.`;
                        // These project facts are already known to the agent. Declare them
                        // after the changed scope is authenticated, before the first compile.
                        handleSet({ targetRoot: root, taskId: current, fullSuiteCommand: command,
                            focusedRequiredTestPath: [suite.target], taskTestSelectionReason: relation,
                            taskTestPlan: JSON.stringify({ targets: [{ path: suite.target, invocation: 0,
                                entrypoint: descriptor.invocations[0].executable,
                                reason: relation }],
                                ...(childFixtures[index].taskTestSupport ? { support: childFixtures[index].taskTestSupport } : {}) }), json: true });
                    }
                    rolesDeclared.add(current);
                }
                if (last?.exitCode === 0 && last.gate === 'load-rule-pack' && last.command?.includes('POST_PREFLIGHT')) {
                    await run(['record-strict-decomposition-decision', '--task-id', current, '--task-profile', 'strict',
                        '--decision', 'atomic', '--task-summary', 'Implement independent ' + suite.id + ' behavior',
                        '--reason', 'One source and its regression target are an atomic component obligation.',
                        '--scope-risk', 'Preserve the completed sibling component.',
                        ...childLanes.flatMap(lane => ['--expected-review-type', lane]),
                        '--atomicity-constraint', 'One component source and test.', '--repo-root', '.']);
                }
                if (last?.gate === 'completion-gate' && last.exitCode === 0 && !committed.has(current)) {
                    assert.equal(runGit(root, ['add', suite.source, suite.target]).status, 0);
                    assert.equal(await runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                        '--task-id', current, '-m', 'test: accept stack child ' + current], { cwd: root }), 0);
                    committed.add(current); current = current === childIds[0] ? childIds[1] : TASK;
                    activate(root);
                }
            }
        },
        act: async (root, gate) => {
            if (gate === 'child-task' && current === TASK) { current = childIds[0]; return true; }
            if (current !== TASK && ['implementation', 'materialize-planned-scope'].includes(String(gate)) && !implemented.has(current)) {
                const suite = childSuites()[0];
                for (const edit of base.edits.filter(edit => [suite.source, suite.target].includes(edit.path)))
                    fs.appendFileSync(path.join(root, edit.path), edit.append);
                implemented.add(current); return true;
            }
            return false;
        },
        inspectResult: (root, result) => {
            if (result.outcome !== 'done') return;
            assert.deepEqual([...committed].sort(), childIds);
            const queue = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
            for (const [index, id] of childIds.entries()) {
                assert.match(queue, new RegExp('\\| ' + id + ' \\|[^\\n]*DONE', 'u'));
                const records = inspectStackTaskArchive(root, id, childPlans[index]);
                assert.equal(records.filter(record => record.purpose === 'compile').length, 1,
                    'Declare known child roles before compile; no avoidable compile repeat for ' + id);
            }
            const sources = childIds.map(id => readNativeChildSourceAcceptance(root, id));
            assert.notEqual(sources[0].commitSha, sources[1].commitSha, 'Each child has its own accepted SOURCE');
            const input = readParentRecord<ParentReviewInput>(root, TASK, 'review-input');
            assert.ok(input, 'Native aggregate input exists');
            assert.deepEqual(input.child_sources, parentChildSourceIdentity(sources), 'Aggregate input binds both child SOURCE proofs');
            for (const suite of manifest.suites) for (const file of [suite.source, suite.target])
                assert.ok(input.changed_files.includes(file), 'Aggregate diff includes ' + file);
            const audit = inspectParentCompletion(root, TASK);
            assert.ok(audit?.ready && audit.result, 'Native aggregate acceptance is qualified');
            assert.deepEqual(audit.violations, []);
            assert.deepEqual(audit.childSources, sources);
            assert.equal(audit.result.input_sha256, parentRecordDigest(input));
            assert.equal(audit.result.source_commit, sources[1].commitSha);
            assert.deepEqual(audit.result.findings, []);
            const reportRoot = process.env.GARDA_SYNTHETIC_WALK_REPORT;
            if (reportRoot) {
                // The walk removes its disposable repository; retain the inspected bytes with its report.
                const retained = path.join(reportRoot, 'stack-parent-evidence', base.id);
                fs.cpSync(path.join(root, '.git/stand-task-archives'), retained, { recursive: true });
                for (const source of sources) fs.copyFileSync(path.join(root, source.artifactPath),
                    path.join(retained, source.taskId, 'source-acceptance.json'));
                for (const kind of ['review-input', 'result']) fs.copyFileSync(parentArtifactPath(root, TASK, kind),
                    path.join(retained, 'parent-' + kind + '.json'));
            }
        }
    };
}
