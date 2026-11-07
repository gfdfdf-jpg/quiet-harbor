import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { runHumanCommitCommand } from '../../../../src/cli/commands/gates';
import { parentRecordDigest, readParentRecord } from '../../../../src/gates/parent-audit/parent-audit-auth';
import type { ParentReviewInput, ParentAuditOutput } from '../../../../src/gates/parent-audit/parent-audit-types';
import { runGit } from '../../cli/commands/gate-test-helpers';
import type { WalkScenario } from './navigator-walk';
import { stackCommand, stackFixture, type StackManifest, type StackMode, type StackTaskPlan } from './walk-stack-fixtures';

const TASK = 'T-WALK', BUNDLE = 'garda-agent-orchestrator';
const LANES = ['code', 'security', 'performance', 'test'];

/** Native split, child gates, SOURCE commits and parent audit. Commits are only in the disposable fixture. */
export function stackDecomposition(manifest: StackManifest, _mode: StackMode, base: WalkScenario, plan: StackTaskPlan): WalkScenario {
    let current = TASK, split = false, linked = false;
    const committed = new Set<string>(), implemented = new Set<string>();
    const childIds = [TASK + '-1', TASK + '-2'];
    const childSuites = () => [manifest.suites[childIds.indexOf(current)]];
    const childFixtures = manifest.suites.map(suite => {
        const technology = manifest.technologies.find(tech => tech.id === suite.technology)!;
        const argv = suite === manifest.suites[0] ? technology.firstArgv : technology.secondArgv;
        return stackFixture(manifest, _mode, [{ technology: technology.id, argv, targets: [suite.target], command: stackCommand(technology, argv) }]);
    });
    return {
        ...base, profile: 'strict', inspectTask: () => current,
        get fixture() { return current === TASK ? base.fixture : childFixtures[childIds.indexOf(current)]; },
        get edits() { return current === TASK ? base.edits : base.edits.filter(edit =>
            [childSuites()[0].source, childSuites()[0].target].includes(edit.path)); },
        expectedGates: ['child-task', 'parent-audit'],
        expectedReviews: Object.fromEntries(LANES.map(lane => [lane, 2])),
        expectedModes: childIds.flatMap(() => LANES.map(lane => lane + ':FULL')),
        expectedTaskReviews: Object.fromEntries(childIds.map(id => [id, LANES.map(lane => lane + ':FULL')])),
        get selectionTargets() { return current === TASK ? base.selectionTargets : childSuites().map(suite => suite.target); },
        get testSelectionCommand() {
            if (current === TASK) return base.testSelectionCommand;
            const suite = childSuites()[0], technology = manifest.technologies.find(tech => tech.id === suite.technology)!;
            // A single-technology child still selects only its own component; never rerun its sibling's tests.
            const argv = manifest.suites.filter(item => item.technology === suite.technology).length === 1
                || suite === manifest.suites[0] ? technology.firstArgv : technology.secondArgv;
            if (!argv) throw new Error('Missing second component invocation in fixture ' + manifest.id);
            return stackCommand(technology, argv);
        },
        configure: root => {
            base.configure?.(root);
            current = TASK; split = false; linked = false; committed.clear(); implemented.clear();
            const file = path.join(root, BUNDLE, 'live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8')); config.parent_audit = { enabled: true };
            fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
        },
        prepare: async (root, steps, run) => {
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
                            finding_obligation_ids: [], required_review_types: LANES })) }));
                    await run(['record-strict-decomposition-decision', '--task-id', TASK, '--task-profile', 'strict',
                        '--decision', 'split-required', '--task-summary', base.taskTitle!,
                        '--reason', 'The two component contracts have independent sources and executable targets.',
                        '--scope-risk', 'Each child owns one component and preserves the other component.',
                        ...LANES.flatMap(lane => ['--expected-review-type', lane]), '--atomicity-constraint', 'none',
                        '--work-package-contract-path', contract, '--repo-root', '.']);
                    split = true;
                }
                if (!linked && last?.effectResult?.gate === 'strict-decomposition-split-routing') {
                    const file = path.join(root, 'TASK.md');
                    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(base.taskNotes!,
                        `Decomposition source: orchestrator; child tasks: \`${childIds[0]}\`, \`${childIds[1]}\`.`)
                        + childIds.map((id, index) => `| ${id} | TODO | P1 | ${manifest.suites[index].id} | Implement independent ${manifest.suites[index].id} behavior | synthetic | 2026-11-06 | strict | Child of ${TASK}. Required reviews: ${LANES.join(', ')}. |\n`).join(''));
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
                const suite = childSuites()[0], technology = manifest.technologies.find(tech => tech.id === suite.technology)!;
                const argv = manifest.suites.filter(item => item.technology === suite.technology).length === 1
                    || suite === manifest.suites[0] ? technology.firstArgv : technology.secondArgv!;
                fs.writeFileSync(path.join(root, '.git/stand-task.json'), JSON.stringify({ ...plan, repoRoot: root,
                    invocations: [{ technology: technology.id, argv, targets: [suite.target], command: stackCommand(technology, argv) }] }));
                if (last?.exitCode === 0 && last.gate === 'load-rule-pack' && last.command?.includes('POST_PREFLIGHT')) {
                    await run(['record-strict-decomposition-decision', '--task-id', current, '--task-profile', 'strict',
                        '--decision', 'atomic', '--task-summary', 'Implement independent ' + suite.id + ' behavior',
                        '--reason', 'One source and its regression target are an atomic component obligation.',
                        '--scope-risk', 'Preserve the completed sibling component.',
                        ...LANES.flatMap(lane => ['--expected-review-type', lane]),
                        '--atomicity-constraint', 'One component source and test.', '--repo-root', '.']);
                }
                if (last?.gate === 'completion-gate' && last.exitCode === 0 && !committed.has(current)) {
                    assert.equal(runGit(root, ['add', suite.source, suite.target]).status, 0);
                    assert.equal(await runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                        '--task-id', current, '-m', 'test: accept stack child ' + current], { cwd: root }), 0);
                    committed.add(current); current = current === childIds[0] ? childIds[1] : TASK;
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
            for (const id of childIds) assert.match(queue, new RegExp('\\| ' + id + ' \\|[^\\n]*DONE', 'u'));
            const audit = readParentRecord(root, TASK, 'result'); assert.ok(audit, 'Native aggregate acceptance exists');
        }
    };
}
