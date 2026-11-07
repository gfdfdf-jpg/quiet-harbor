import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { splitCommandLine } from '../../../../src/core/command-line';
import { resolveTaskQueueTransactionLockPath } from '../../../../src/core/task-queue/task-queue-repository';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { readReviewCycleGuardEvaluation } from '../../../../src/gates/next-step/next-step-review-cycle-guard-evaluation';
import { buildReviewCycleContinuationCommand } from '../../../../src/gates/next-step/next-step-review-cycle-guard-operator-block';
import { runGit } from '../../cli/commands/gate-test-helpers';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../../../src/gate-runtime/task-events';
import { runRecordNoOpCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-record-commands';
import { runEnterTaskModeCommand } from '../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { runCompileGateCommand } from '../../../../src/cli/commands/gate-flows/compile/compile-flow';
import { runRequiredReviewsCheckCommand } from '../../../../src/cli/commands/gate-flows/review/review-flow';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { COVERAGE_WALK_SCENARIOS } from './walk-coverage-scenarios';
import { EVIDENCE_EDGE_WALK_SCENARIOS } from './walk-evidence-edge-scenarios';
import { lostCompileEvidence } from './walk-reuse-coverage-scenarios';
import type { WalkScenario } from './navigator-walk';

const REVIEWS = 'garda-agent-orchestrator/runtime/reviews';
const EDITS = [{ path: 'src/app.ts', append: '// review recovery\n' }, { path: 'tests/app.test.ts', append: '// review recovery\n' }];

function splitFault(kind: 'status-write' | 'legacy-wip' | 'unaccepted-children'): WalkScenario {
    const original = COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-strict-split')!;
    return { ...original, id: 'coverage-split-' + kind, counterState: undefined,
        disturbanceReason: kind === 'status-write' ? 'Obstruct TASK.md publication after a native split decision and valid child declarations.'
            : kind === 'legacy-wip' ? 'Hand-edit the parent to DECOMPOSED with unsuspended WIP and an unrelated untracked file.'
                : 'Hand-edit child rows to DONE without native SOURCE; parent acceptance must still refuse.',
        expectedBlockedGate: kind === 'status-write' ? 'strict-decomposition-split-routing' : kind === 'legacy-wip' ? 'strict-decomposition-wip-capture' : null,
        expectedGuidance: kind === 'status-write' ? /Status sync outcome:.*write_failed.*explicit operator recovery/isu
            : kind === 'legacy-wip' ? /unrelated untracked files.*repair the reported scope/isu
                : /Parent acceptance requires clean Git source without hidden index flags/u,
        prepare: async (root, steps, run) => {
            await original.prepare?.(root, steps, run);
            const last = steps.at(-1);
            if (last?.gate !== 'load-rule-pack' || last.exitCode !== 0 || !steps.some(step => step.gate === 'implementation')) return;
            const queuePath = path.join(root, 'TASK.md');
            let queue = fs.readFileSync(queuePath, 'utf8');
            if (kind !== 'status-write') queue = queue.replace(/🟨 IN_PROGRESS|IN_PROGRESS/u, 'DECOMPOSED');
            if (kind !== 'legacy-wip') {
                queue = queue.replace('Synthetic navigator walk.', 'Decomposition source: orchestrator; child tasks: `T-WALK-1`, `T-WALK-2`.');
                queue += [1, 2].map(id => `| T-WALK-${id} | ${kind === 'status-write' ? 'TODO' : 'DONE'} | P1 | status-part-${id} | Implement independent status behavior part ${id} | synthetic | 2026-11-01 | strict | Child of T-WALK. Required reviews: code, security, performance, test. |\n`).join('');
            }
            fs.writeFileSync(queuePath, queue);
            if (kind === 'status-write') {
                const lock = resolveTaskQueueTransactionLockPath(queuePath);
                fs.mkdirSync(path.dirname(lock), { recursive: true });
                fs.writeFileSync(lock, 'Stand fault: invalid TASK.md lock requires operator recovery.');
            } else if (kind === 'legacy-wip') fs.writeFileSync(path.join(root, 'unrelated.txt'), 'Preserve unrelated work.\n');
        }
    };
}

function failedReviewRecompile(scoped: boolean): WalkScenario {
    const lane = scoped ? 'security' : 'code', lanes = scoped ? ['code', 'security', 'test'] : ['code', 'test'];
    return { id: 'coverage-failed-review-recompile' + (scoped ? '-lost-scoped' : ''), edits: EDITS,
        failures: { [lane]: 1 }, requiredLanes: lanes,
        disturbanceReason: 'Lose the compile report after a failed ' + lane + ' review; compile as next-step names and approve one more review cycle'
            + (scoped ? ', then lose its native scoped metadata.' : '.'),
        expectedReviews: Object.fromEntries(lanes.map(type => [type, type === lane ? 2 : 1])),
        expectedModes: lanes.flatMap(type => type === lane ? [type + ':FULL', type + ':FULL'] : [type + ':FULL']),
        prepare: lostCompileEvidence([{ after: last => last?.gate === 'record-review-result' && !!last.command?.includes('--review-type "' + lane + '"'),
            then: scoped ? root => fs.unlinkSync(path.join(root, REVIEWS, 'T-WALK-security-scoped.json')) : undefined }])
    };
}

function staleUpstreamMetadata(): WalkScenario {
    let injected = false;
    return {
        id: 'coverage-review-gate-stale-upstream-scoped', edits: EDITS, requiredLanes: ['code', 'security', 'test'],
        expectedReviews: { code: 1, security: 1, test: 1 }, expectedModes: ['code:FULL', 'security:FULL', 'test:FULL'],
        disturbanceReason: 'Supply a mismatched expected verdict to native review validation, accept current code context, then lose security scoped metadata.',
        expectedBlockedGate: 'build-scoped-diff',
        expectedGuidance: /latest required-reviews-check failure indicates stale upstream 'security'.*rebuild scoped metadata/isu,
        prepare: async (root, steps, run) => {
            if (!steps.length) injected = false;
            const last = steps.at(-1);
            if (injected || last?.gate !== 'record-review-result' || !last.command?.includes('--review-type "test"')) return;
            injected = true;
            const result = runRequiredReviewsCheckCommand({ repoRoot: root, taskId: 'T-WALK',
                preflightPath: REVIEWS + '/T-WALK-preflight.json', codeReviewVerdict: 'DIFFERENT_EXPECTED_TOKEN',
                reviewAuthorshipAttestationJson: JSON.stringify({ code: true, security: true, test: true }), emitMetrics: false });
            if (result.exitCode === 0 || !result.outputLines.join('\n').includes('DIFFERENT_EXPECTED_TOKEN')) {
                throw new Error('Expected native review gate refusal for the mismatched verdict.');
            }
            const command = steps.find(step => step.gate === 'build-review-context' && step.command?.includes('--review-type "code"'))?.command;
            if (!command) throw new Error('No native code context command to accept after review validation failure.');
            const argv = splitCommandLine(command);
            await run(argv.slice(argv.indexOf('gate') + 1));
            fs.unlinkSync(path.join(root, REVIEWS, 'T-WALK-security-scoped.json'));
        }
    };
}

function downstreamMetadataAfterRepeatedRecord(): WalkScenario {
    let repeated = false;
    let scopedBytes: Buffer | undefined;
    let contextBytes: Buffer | undefined;
    return {
        id: 'coverage-downstream-rebind-lost-scoped', edits: EDITS, requiredLanes: ['code', 'security', 'test'],
        expectedReviews: { code: 1, security: 1, test: 1 }, expectedModes: ['code:FULL', 'security:FULL', 'test:FULL'],
        // A consumed attempt cannot be recorded twice; the accepted context retains its authenticated scope metadata.
        expectedGates: ['build-scoped-diff'],
        disturbanceReason: 'Refuse re-recording a consumed code attempt after downstream reviews, then lose security scoped metadata.',
        prepare: async (root, steps, run) => {
            if (!steps.length) { repeated = false; scopedBytes = undefined; contextBytes = undefined; }
            const last = steps.at(-1);
            if (last?.gate === 'required-reviews-check' && last.exitCode === 0 && scopedBytes && contextBytes) {
                const retained = fs.readFileSync(path.join(root, REVIEWS, 'T-WALK-security-review-context.json'));
                const context = JSON.parse(retained.toString('utf8'));
                const receipt = JSON.parse(fs.readFileSync(path.join(root, REVIEWS, 'T-WALK-security-receipt.json'), 'utf8'));
                if (!retained.equals(contextBytes)
                    || JSON.stringify(context.scoped_diff?.metadata) !== JSON.stringify(JSON.parse(scopedBytes.toString('utf8')))
                    || receipt.review_context_sha256 !== createHash('sha256').update(retained).digest('hex')) {
                    throw new Error('Accepted security context no longer authenticates its retained scoped metadata.');
                }
            }
            if (repeated || last?.gate !== 'record-review-result' || !last.command?.includes('--review-type "test"')) return;
            repeated = true;
            const command = steps.find(step => step.gate === 'record-review-result' && step.command?.includes('--review-type "code"'))?.command;
            if (!command) throw new Error('No accepted native code review command to repeat.');
            const argv = splitCommandLine(command), outputIndex = argv.indexOf('--review-output-path');
            if (outputIndex < 0) throw new Error('Native code record command has no output path.');
            // Read the already authenticated retained bytes directly; never recreate the consumed transport file.
            argv[outputIndex + 1] = path.join(root, REVIEWS, 'T-WALK-code-review-output.md');
            const timeline = path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-WALK.jsonl');
            const timelineBefore = fs.readFileSync(timeline);
            try {
                await run(argv.slice(argv.indexOf('gate') + 1));
                throw new Error('A consumed reviewer attempt was accepted twice.');
            } catch (error) {
                if (!(error instanceof Error) || !error.message.includes('Cannot authenticate the completed reviewer output binding')) throw error;
            }
            if (!fs.readFileSync(timeline).equals(timelineBefore)) throw new Error('Refused re-record changed task history.');
            const scoped = path.join(root, REVIEWS, 'T-WALK-security-scoped.json');
            scopedBytes = fs.readFileSync(scoped);
            contextBytes = fs.readFileSync(path.join(root, REVIEWS, 'T-WALK-security-review-context.json'));
            fs.unlinkSync(scoped);
        }
    };
}

export const FINAL_COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = [
    staleUpstreamMetadata(), downstreamMetadataAfterRepeatedRecord(),
    ...(['scope', 'review'] as const).map((kind): WalkScenario => ({
        id: 'coverage-authorized-invalid-' + kind + '-guard', edits: EDITS, expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Corrupt a guard setting after native operator-approved workflow-config task entry.',
        expectedBlockedGate: 'workflow-config-validation', expectedGuidance: /workflow-config.*guard/su,
        prepare: async (root, steps) => {
            if (!steps.length) {
                handleSet({ targetRoot: root, gardaSelfGuard: 'off', operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(), json: true });
                const file = path.join(root, 'TASK.md'), summary = 'Workflow-config policy changes for guard validation';
                fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Change the status renderer', summary));
                const result = runEnterTaskModeCommand({ repoRoot: root, taskId: 'T-WALK', provider: 'Codex',
                    entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, taskSummary: summary,
                    plannedChangedFiles: ['src/app.ts', 'tests/app.test.ts', 'garda-agent-orchestrator/live/config/workflow-config.json'],
                    orchestratorWork: true, workflowConfigWork: true, operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(), emitMetrics: false });
                if (result.exitCode) throw new Error('Native workflow-config task entry refused: ' + result.outputLines.join('\n'));
            }
            const last = steps.at(-1);
            if (last?.gate !== 'load-rule-pack' || !last.command?.includes('POST_PREFLIGHT')) return;
            const file = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (kind === 'scope') config.scope_budget_guard.action = 'INVALID';
            else config.review_cycle_guard.max_total_non_test_reviews = -1;
            fs.writeFileSync(file, JSON.stringify(config));
        }
    })),
    {
        id: 'coverage-parent-missing-git', edits: [], expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Lose Git metadata before manually declared parent acceptance; DONE rows cannot replace native child SOURCE.',
        expectedBlockedGate: null, expectedGuidance: /native Git workspace and authenticated child SOURCE/u,
        setup: root => {
            const file = path.join(root, 'TASK.md');
            let queue = fs.readFileSync(file, 'utf8').replace(/🟦 TODO/u, 'DECOMPOSED')
                .replace('Synthetic navigator walk.', 'Decomposition source: manual-operator; child tasks: `T-WALK-1`, `T-WALK-2`.');
            queue += [1, 2].map(id => `| T-WALK-${id} | DONE | P1 | part-${id} | Part ${id} | operator | 2026-11-01 | balanced | Child of T-WALK. |\n`).join('');
            fs.writeFileSync(file, queue);
            // Both fixed paths remain within this disposable fixture; retain every Git byte for inspection/cleanup.
            fs.renameSync(path.join(root, '.git'), path.join(root, '.stand-retained-git'));
        }
    },
    {
        id: 'coverage-compile-reverted-scope-drift', edits: EDITS, expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Run native compile during transient source drift, then revert only that unclassified edit.',
        expectedBlockedGate: 'classify-change',
        expectedGuidance: /Compile gate failed because the preflight scope is stale.*Refresh classify-change/isu,
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate !== 'load-rule-pack' || !last.command?.includes('POST_PREFLIGHT')
                || !steps.some(step => step.gate === 'implementation')) return;
            const file = path.join(root, 'src/app.ts'), before = fs.readFileSync(file);
            fs.appendFileSync(file, '\n// transient unclassified source drift\n');
            try {
                const result = await runCompileGateCommand({ repoRoot: root, taskId: 'T-WALK',
                    preflightPath: REVIEWS + '/T-WALK-preflight.json', emitMetrics: false });
                if (result.exitCode === 0 || !result.outputLines.join('\n').includes('Preflight scope drift detected')) {
                    throw new Error('Expected native compile scope-drift refusal.');
                }
            } finally { fs.writeFileSync(file, before); }
        }
    },
    {
        id: 'coverage-task-entry-publication-failure', edits: [], expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Obstruct the real protected continuation destination before a fresh operator-approved entry.',
        expectedBlockedGate: 'task-reset',
        expectedGuidance: /publication failed after TASK_MODE_ENTERED.*preview the explicit operator reset/isu,
        prepare: async (root, steps) => {
            if (steps.length) return;
            handleSet({ targetRoot: root, gardaSelfGuard: 'off', operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString(), json: true });
            fs.mkdirSync(path.join(root, '.git/garda-private/protected-task-entry/T-WALK.json'), { recursive: true });
            let failure: unknown;
            try {
                runEnterTaskModeCommand({ repoRoot: root, taskId: 'T-WALK', provider: 'Codex',
                    entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, taskSummary: 'Change the status renderer',
                    plannedChangedFiles: ['src/app.ts'], orchestratorWork: true, operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(), emitMetrics: false });
            } catch (error) { failure = error; }
            const timeline = fs.readFileSync(path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-WALK.jsonl'), 'utf8');
            if (!failure || !String(failure).includes('T-WALK.json')
                || !timeline.includes('TASK_MODE_ENTRY_FAILED')
                || fs.existsSync(path.join(root, REVIEWS, 'T-WALK-task-mode.json'))) {
                throw new Error('Expected native protected publication failure and invalidated task-mode artifact.');
            }
        }
    },
    splitFault('status-write'), splitFault('legacy-wip'), splitFault('unaccepted-children'),
    failedReviewRecompile(false), failedReviewRecompile(true),
    {
        ...COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-no-op')!,
        id: 'coverage-no-op-event-publication-failure',
        disturbanceReason: 'Hold a real native task-event lock while no-op publication tries to append its binding event.',
        expectedGuidance: /no current integrity-bound NO_OP_RECORDED event.*Record it again/isu,
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate !== 'load-rule-pack' || !last.command?.includes('POST_PREFLIGHT')) return;
            const timeline = path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-WALK.jsonl');
            const before = fs.readFileSync(timeline);
            const lock = acquireFilesystemLock(path.join(path.dirname(timeline), '.T-WALK.lock'), { projectRoot: root });
            try {
                const result = runRecordNoOpCommand({ repoRoot: root, taskId: 'T-WALK', classification: 'AUDIT_ONLY',
                    reason: 'Operator inspected the existing baseline behavior.', preflightPath: REVIEWS + '/T-WALK-preflight.json', emitMetrics: false });
                if (result.exitCode !== EXIT_GATE_FAILURE || !result.outputLines.includes('NO_OP_RECORDING_BLOCKED')
                    || !fs.readFileSync(timeline).equals(before)) throw new Error('No-op must refuse failed native event publication.');
            } finally { releaseFilesystemLock(lock.handle); }
        }
    },
    {
        id: 'coverage-correction-missing-semantics', edits: EDITS, reviewerAttestation: 'controller',
        disturbances: [{ kind: 'missing-report-semantics', lane: 'code' }],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'],
        expectedFailingGates: ['record-review-result']
    },
    {
        ...EVIDENCE_EDGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-operator-no-reset')!,
        id: 'coverage-operator-template-reset', expectedBlockedGate: 'task-reset',
        expectedGuidance: /Reset the stale lifecycle evidence.*approved config baseline/isu,
        disturbanceReason: 'Stage a protected template workflow-config edit after entry; live task reset remains natively approved.',
        prepare: async (root, steps) => {
            if (!steps.length) handleSet({ targetRoot: root, taskResetEnabled: 'true', operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString(), json: true });
            const last = steps.at(-1);
            if (last?.gate !== 'load-rule-pack' || !last.command?.includes('POST_PREFLIGHT')) return;
            const relative = 'garda-agent-orchestrator/template/config/workflow-config.json';
            fs.appendFileSync(path.join(root, relative), '\n');
            if (runGit(root, ['add', '--force', relative]).status !== 0) throw new Error('Cannot stage the disposable template disturbance.');
        }
    },
    {
        ...EVIDENCE_EDGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-review-latch-write-failure')!,
        id: 'coverage-continuation-status-write-failure',
        disturbanceReason: 'Obstruct TASK.md only after native one-shot continuation approval for a real review-cycle latch.',
        expectedGuidance: /continuation.*TASK.md status recovery failed.*explicit operator recovery/isu,
        prepare: async (root, steps, run) => {
            if (!steps.at(-1)?.effectResult || !fs.existsSync(path.join(root, REVIEWS, 'T-WALK-split-required.json'))
                || fs.existsSync(path.join(root, REVIEWS, 'T-WALK-review-cycle-continuation.json'))) return;
            const evaluation = readReviewCycleGuardEvaluation(root, path.join(root, 'garda-agent-orchestrator/runtime/task-events'), 'T-WALK').evaluation;
            const command = buildReviewCycleContinuationCommand('node bin/garda.js', 'T-WALK', evaluation)
                .replace('<ISO-8601 timestamp>', new Date().toISOString());
            const argv = splitCommandLine(command);
            await run(argv.slice(argv.indexOf('gate') + 1));
            const lock = resolveTaskQueueTransactionLockPath(path.join(root, 'TASK.md'));
            fs.mkdirSync(path.dirname(lock), { recursive: true });
            fs.writeFileSync(lock, 'Stand fault: invalid TASK.md lock requires operator recovery.');
        }
    },
    {
        ...COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-no-op')!,
        id: 'coverage-zero-diff-policy-refresh',
        disturbanceReason: 'Pre-existing unrelated parent WIP remains dirty while the child audits already committed source.',
        expectedGuidance: /authenticated staged audit policy.*native no-op.*new preflight hash/isu,
        setup: root => {
            const queue = path.join(root, 'TASK.md');
            fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').replace('Change the status renderer', 'Audit-only: inspect status behavior'));
            fs.appendFileSync(path.join(root, 'tests/app.test.ts'), '// pre-existing unrelated parent WIP\n');
        },
        prepare: async (_root, steps, run) => {
            if (!steps.length) await run(['enter-task-mode', '--task-id', 'T-WALK', '--provider', 'Codex', '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
                '--requested-depth', '2', '--task-summary', 'Audit-only: inspect status behavior', '--planned-changed-file', 'src/app.ts', '--repo-root', '.']);
            const last = steps.at(-1);
            if (last?.gate === 'shell-smoke-preflight') await run(['classify-change', '--task-id', 'T-WALK',
                '--task-intent', 'Audit already implemented child beside preserved parent work', '--changed-file', 'src/app.ts',
                '--output-path', REVIEWS + '/T-WALK-preflight.json', '--repo-root', '.']);
            if (last?.gate === 'load-rule-pack' && last.command?.includes('POST_PREFLIGHT')
                && !steps.some(step => step.preparation?.some(preparation => preparation.command.startsWith('record-no-op ')))) {
                await run(['record-no-op', '--task-id', 'T-WALK', '--classification', 'ALREADY_DONE',
                    '--reason', 'Operator inspected the existing implementation; the requested status behavior is already present.',
                    '--preflight-path', REVIEWS + '/T-WALK-preflight.json', '--repo-root', '.']);
            }
        }
    },
    {
        ...EVIDENCE_EDGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-corrupt-correction-package')!,
        id: 'coverage-correction-lost-launch',
        disturbanceReason: 'Lose the real completed launch artifact after native rejection of malformed reviewer output.',
        expectedBlockedGate: undefined,
        expectedGuidance: undefined,
        expectedModes: ['code:FULL', 'test:FULL', 'test:FULL'],
        expectedReviews: { code: 1, test: 2 },
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate !== 'record-review-result' || !last.exitCode || steps.some(step => step.gate === 'restart-review-cycle')) return;
            if (!last.output.includes("report contains unknown field 'unexpected'")) throw new Error('Expected native report-shape rejection.');
            fs.unlinkSync(path.join(root, 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/test/reviewer-launch.json'));
        }
    }
];
