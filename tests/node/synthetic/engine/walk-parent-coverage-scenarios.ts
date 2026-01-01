import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { runHumanCommitCommand } from '../../../../src/cli/commands/gates';
import { parentRecordDigest, readParentRecord } from '../../../../src/gates/parent-audit/parent-audit-auth';
import { readParentQueue } from '../../../../src/gates/parent-audit/parent-audit-contract';
import type { ParentAuditOutput, ParentAuditResult, ParentReviewInput } from '../../../../src/gates/parent-audit/parent-audit-types';
import { runGit } from '../../cli/commands/gate-test-helpers';
import { COVERAGE_WALK_SCENARIOS } from './walk-coverage-scenarios';
import type { WalkScenario } from './navigator-walk';
import { resolveTaskQueueTransactionLockPath } from '../../../../src/core/task-queue/task-queue-repository';

const TASK = 'T-WALK';
const BUNDLE = 'garda-agent-orchestrator';
const LANES = ['code', 'security', 'performance', 'test'];

/** Every child runs its real gates and publishes native SOURCE with the human-commit gate.
 * Operator consent and local commits here belong only to the disposable fixture. */
function parentScenario(findings: boolean, loseChild = false): WalkScenario {
    const strict = COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-strict-split')!;
    let currentTask = TASK;
    let linked = false;
    const implemented = new Set<string>(), committed = new Set<string>();
    return {
        ...strict, id: 'coverage-parent-' + (loseChild ? 'lost-completed-child' : findings ? 'aggregate-follow-up' : 'acceptance'),
        counterState: 'native-child-tree', expectedBlockedGate: undefined, expectedGuidance: undefined,
        expectedGates: ['child-task', 'parent-audit', ...(findings ? ['next-step'] : [])],
        expectedReviews: Object.fromEntries(LANES.map(lane => [lane, findings ? 3 : 2])),
        expectedModes: Array.from({ length: findings ? 3 : 2 }, () => LANES.map(lane => lane + ':FULL')).flat(),
        ...(loseChild ? {
            disturbanceReason: 'Remove a completed child queue row after native aggregate acceptance; retain its SOURCE and timeline evidence.',
            expectedBlockedGate: 'decomposed-parent-obligations', expectedGuidance: /resolve these original parent obligations/iu
        } : {}),
        inspectTask: () => currentTask,
        configure: root => {
            const file = path.join(root, BUNDLE, 'live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            config.parent_audit = { enabled: true };
            fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
        },
        prepare: async (root, steps, run) => {
            if (!steps.length) {
                currentTask = TASK; linked = false; implemented.clear(); committed.clear();
                handleSet({ targetRoot: root, localCommitEnabled: 'true', json: true,
                    operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
            }
            const last = steps.at(-1);
            if (currentTask === TASK) {
                if (loseChild && last?.effectResult?.reason === 'All required child SOURCE and aggregate correction obligations are accepted.') {
                    const file = path.join(root, 'TASK.md');
                    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter(line => !line.startsWith('| T-WALK-2 |')).join('\n'));
                }
                if (!linked) await strict.prepare?.(root, steps, run);
                if (!linked && last?.effectResult?.gate === 'strict-decomposition-split-routing') {
                    const file = path.join(root, 'TASK.md');
                    const queue = fs.readFileSync(file, 'utf8').replace('Synthetic navigator walk.',
                        'Decomposition source: orchestrator; child tasks: `T-WALK-1`, `T-WALK-2`.');
                    fs.writeFileSync(file, queue + [1, 2].map(id =>
                        `| ${TASK}-${id} | TODO | P1 | status-part-${id} | Implement independent status behavior part ${id} | synthetic | 2026-11-01 | strict | Child of ${TASK}. Required reviews: ${LANES.join(', ')}. |\n`).join(''));
                    linked = true;
                }
                if (last?.gate === 'parent-audit' && last.exitCode === 0 && last.command?.includes('--phase prepare')) {
                    const input = readParentRecord<ParentReviewInput>(root, TASK, 'review-input');
                    if (!input) throw new Error('Native parent review input was not published.');
                    await run(['parent-audit', '--task-id', TASK, '--phase', 'started', '--reviewer-identity', 'agent:walk-aggregate',
                        '--input-sha256', parentRecordDigest(input), '--controller-tool', 'collaboration.spawn_agent', '--repo-root', '.']);
                    const ids = input.obligations.map(obligation => obligation.id);
                    const output: ParentAuditOutput = {
                        schema_version: 1, task_id: TASK, attempt_id: input.attempt_id, input_sha256: parentRecordDigest(input),
                        requirements: ids.map(id => ({ id, result: findings ? 'finding' : 'satisfied',
                            evidence: ['src/app.ts:1', 'tests/app.test.ts:1'], finding_ids: findings ? ['F-001'] : [] })),
                        findings: findings ? [{ id: 'F-001', severity: 'high', title: 'Combined status behavior needs correction',
                            description: 'The combined status behavior needs a focused regression correction.',
                            remediation: 'Correct the status behavior and verify it through the ordinary review lanes.',
                            requirement_ids: ids, evidence: ['src/app.ts:1', 'tests/app.test.ts:1'] }] : []
                    };
                    fs.writeFileSync(input.output_path, JSON.stringify(output, null, 2) + '\n');
                }
            } else if (last?.exitCode === 0 && ((last.gate === 'load-rule-pack' && last.command?.includes('POST_PREFLIGHT'))
                || (last.gate === 'shell-smoke-preflight' && currentTask === TASK + '-F1'))) {
                const title = readParentQueue(root).entries.get(currentTask)?.title;
                if (!title) throw new Error('Native child task title is missing: ' + currentTask);
                await run(['record-strict-decomposition-decision', '--task-id', currentTask, '--task-profile', 'strict',
                    '--decision', 'atomic', '--task-summary', title,
                    '--reason', 'One focused status behavior binds source and test in this child.',
                    '--scope-risk', 'A small source and test contract with all strict reviews retained.',
                    ...(last.gate === 'shell-smoke-preflight' ? ['none'] : LANES).flatMap(lane => ['--expected-review-type', lane]),
                    '--atomicity-constraint', 'Source and corresponding test are one behavior change.', '--repo-root', '.']);
            } else if (last?.gate === 'completion-gate' && last.exitCode === 0 && !committed.has(currentTask)) {
                runGit(root, ['add', 'src/app.ts', 'tests/app.test.ts']);
                const result = await runHumanCommitCommand(['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                    '--task-id', currentTask, '-m', 'test: accept native isolated child ' + currentTask], { cwd: root });
                if (result !== 0) throw new Error('Native child SOURCE commit refused: ' + currentTask + ' code ' + result);
                committed.add(currentTask);
                currentTask = currentTask === TASK + '-1' ? TASK + '-2' : TASK;
            }
        },
        act: async (root, gate) => {
            if (gate === 'child-task' && currentTask === TASK) { currentTask = TASK + '-1'; return true; }
            if (gate === 'next-step' && currentTask === TASK) {
                const result = readParentRecord<ParentAuditResult>(root, TASK, 'result');
                if (!result?.follow_up_task_id) throw new Error('Native aggregate result has no grouped follow-up.');
                currentTask = result.follow_up_task_id; return true;
            }
            if (['implementation', 'materialize-planned-scope'].includes(String(gate)) && currentTask !== TASK && !implemented.has(currentTask)) {
                fs.appendFileSync(path.join(root, 'src/app.ts'), '// accepted child ' + currentTask + '\n');
                fs.appendFileSync(path.join(root, 'tests/app.test.ts'), '// covers child ' + currentTask + '\n');
                implemented.add(currentTask); return true;
            }
            return false;
        }
    };
}

function parentPublicationFailure(): WalkScenario {
    const original = parentScenario(false);
    return { ...original, id: 'coverage-parent-status-write-failure',
        disturbanceReason: 'Obstruct native task-queue publication after both child SOURCE records are complete.',
        expectedTerminalStatus: 'BLOCKED', expectedBlockedGate: 'task-status-sync',
        expectedGuidance: /status publication failed.*Repair TASK.md.*rerun next-step/isu,
        prepare: async (root, steps, run) => {
            await original.prepare?.(root, steps, run);
            const queue = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
            if (![1, 2].every(id => new RegExp('\\| T-WALK-' + id + ' \\|[^\\n]*DONE', 'u').test(queue))) return;
            const lock = resolveTaskQueueTransactionLockPath(path.join(root, 'TASK.md'));
            fs.mkdirSync(path.dirname(lock), { recursive: true });
            fs.writeFileSync(lock, 'Stand fault: operator must repair this obstructed task-queue lock.');
        }
    };
}

export const PARENT_COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = [
    parentScenario(false), parentScenario(true), parentScenario(false, true), parentPublicationFailure()
];
