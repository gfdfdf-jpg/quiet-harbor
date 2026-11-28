import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { withFilesystemLockAsync } from '../../../../src/gate-runtime/timeline/task-events-locking';
import { resolveReviewScratchRoot } from '../../../../src/gates/review/review-scratch-paths';
import { runTaskComposite } from '../../../../src/cli/commands/task-composite/task-composite-runner';
import {
    attachNextStepCommandExecution, type NextStepReviewerBookkeepingOperation
} from '../../../../src/gates/next-step/next-step-command-execution';
import type { TaskCompositeReviewerInputs } from '../../../../src/gates/next-step/next-step-composite-action';
import { resolveNextStep, type NextStepResult } from '../../../../src/gates/next-step/next-step';
import { handleTaskComposite } from '../../../../src/cli/commands/task-composite/task-composite-command';
import {
    cli, createCompositeFixture, countEvents, PROVIDER_ARGS, runPrintedCommand, TASK_ID, writeTaskEdit
} from './task-composite-test-fixture';
import { buildNoFindingsJsonReviewReport } from './gates/review-result/gates-command-review-result-fixtures';
import type { TaskCompositeRunResult } from '../../../../src/cli/commands/task-composite/task-composite-runner';

const taskId = 'T-409-3';
const inputSha256 = 'a'.repeat(64);
const started: TaskCompositeReviewerInputs = {
    phase: 'started', reviewType: 'code', reviewerIdentity: 'agent:fixture',
    providerInvocationId: 'provider-launch-fixture', controllerInvocationId: null, attestationSource: 'test_provider_controller',
    launchInputMode: 'launch_artifact_path', launchInputSha256: inputSha256,
    launchInputArtifactPath: 'launch-input.json', reviewOutputPath: null, forkContext: false
};
const returned: TaskCompositeReviewerInputs = { ...started, phase: 'returned', reviewOutputPath: 'review.md' };

function reviewRoute(operationId: NextStepReviewerBookkeepingOperation['operation_id'], reviewType = 'code'): NextStepResult {
    const operation: NextStepReviewerBookkeepingOperation = { operation_id: operationId, arguments: {
        task_id: taskId, preflight_path: 'preflight.json', task_mode_path: null, review_type: reviewType,
        launch_artifact_path: 'launch.json', reviewer_identity: started.reviewerIdentity,
        provider_invocation_id: started.providerInvocationId, controller_invocation_id: null,
        launch_input_mode: started.launchInputMode, launch_input_sha256: inputSha256,
        launch_input_artifact_path: started.launchInputArtifactPath, review_output_path: returned.reviewOutputPath
    } };
    const boundary = operationId === 'prepare-reviewer-launch' ? 'mechanical' : 'agent';
    return { task_id: taskId, status: 'BLOCKED', next_gate: operationId,
        navigator_command: `garda next-step "${taskId}" --repo-root "."`,
        commands: [attachNextStepCommandExecution({ label: operationId, command: 'display only' }, boundary, operation)]
    } as NextStepResult;
}

async function advance(repoRoot: string, args: string[] = []): Promise<TaskCompositeRunResult> {
    const result = await cli(repoRoot, ['task', TASK_ID, 'advance', '--as-json', ...args]);
    const parsed = JSON.parse(result.text) as TaskCompositeRunResult;
    assert.equal(result.exitCode, parsed.outcome === 'FAILED' ? EXIT_GATE_FAILURE : 0, result.text);
    return parsed;
}

function handoffValue(result: TaskCompositeRunResult, key: string): string {
    const prefix = `${key}: `;
    const value = result.completed.flatMap(step => step.output_lines).find(line => line.startsWith(prefix))?.slice(prefix.length);
    assert.ok(value, `Missing ${key} in preparation output`);
    return value;
}

async function interruptCompletion(repoRoot: string, launchPath: string, args: string[]): Promise<string> {
    const lockPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `.${TASK_ID}.lock`);
    const transition = await withFilesystemLockAsync(lockPath, {
        timeoutMs: 5_000, retryMs: 10, staleMs: 60_000, ownerLabel: 'composite-completion-test'
    }, async () => {
        const child = spawn(process.execPath, ['--input-type=commonjs', '-e',
            'require(process.argv[1]).runCliMainWithHandling(JSON.parse(process.argv[2]), process.argv[3])',
            require.resolve('../../../../src/cli/main'), JSON.stringify(['task', TASK_ID, 'advance', ...args]),
            path.resolve(__dirname, '../../../../..')
        ], { cwd: repoRoot, stdio: 'ignore' });
        const exited = once(child, 'exit');
        try {
            const deadline = Date.now() + 25_000;
            while (Date.now() < deadline && child.exitCode === null) {
                try {
                    const text = fs.readFileSync(launchPath, 'utf8');
                    if ((JSON.parse(text) as { attestation_state: string }).attestation_state === 'launched') return text;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
                await delay(20);
            }
            throw new Error('Expected a persisted completion while timeline append is locked.');
        } finally {
            child.kill();
            await exited;
        }
    });
    return transition.result;
}

interface InterruptedReturn {
    repoRoot: string; launchPath: string; outputPath: string; resultArgs: string[];
    report: unknown; reportBytes: string; persisted: string; cacheDirectory: string;
}

/** Prepares the code review, starts it and interrupts its return after the completion artifact is persisted. */
async function persistInterruptedReturn(fixture: Awaited<ReturnType<typeof createCompositeFixture>>): Promise<InterruptedReturn> {
    const repoRoot = fixture.clone();
    const bundle = path.join(repoRoot, 'garda-agent-orchestrator');
    const apiSkill = path.join(bundle, 'live', 'skills', 'api-contract-review', 'SKILL.md');
    fs.mkdirSync(path.dirname(apiSkill), { recursive: true });
    fs.copyFileSync(path.join(bundle, 'template', 'skill-packs', 'quality-architecture', 'skills',
        'api-contract-review', 'SKILL.md'), apiSkill);
    const enabled = await cli(repoRoot, ['review-capabilities', 'enable', 'api']);
    assert.equal(enabled.exitCode, 0, enabled.text);
    const taskQueue = path.join(repoRoot, 'TASK.md');
    const queue = fs.readFileSync(taskQueue, 'utf8');
    fs.writeFileSync(taskQueue, queue.replace('Composite fixture.', 'Required reviews: code, api, test.'), 'utf8');
    const quality = await cli(repoRoot, ['workflow', 'set', '--optional-checks', 'off',
        '--review-execution-policy', 'strict_sequential',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
    assert.equal(quality.exitCode, 0, quality.text);
    const entry = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS]);
    assert.equal(entry.exitCode, 0, entry.text);
    await runPrintedCommand(repoRoot, 'load-rule-pack');
    writeTaskEdit(repoRoot);
    await advance(repoRoot);
    await runPrintedCommand(repoRoot, 'load-rule-pack');

    const prepared = await advance(repoRoot);
    assert.deepEqual(prepared.completed.slice(-2).map(({ gate }) => gate),
        ['record-review-routing', 'prepare-reviewer-launch'], 'routing derives the planned identity mechanically');
    assert.equal(prepared.next?.next_gate, 'record-reviewer-delegation-started');
    assert.equal(countEvents(repoRoot, 'REVIEWER_DELEGATION_STARTED'), 0);
    const inputPath = handoffValue(prepared, 'ReviewerLaunchInputArtifactPath');
    const outputPath = handoffValue(prepared, 'ReviewOutputPath');
    const launchPath = handoffValue(prepared, 'ReviewerLaunchArtifactPath');
    const launchHash = handoffValue(prepared, 'ReviewerLaunchInputArtifactSha256').toUpperCase();
    const alternateSpelling = (value: string) => process.platform === 'win32'
        ? value.replace(/^[a-z]:/iu, (drive) => drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase())
        : value;
    const shared = [
        '--review-type', 'code', '--reviewer-identity', 'agent:composite-fixture',
        '--provider-invocation-id', 'composite-fixture-launch', '--attestation-source', 'test_provider_controller',
        '--launch-input-mode', 'launch_artifact_path', '--launch-input-artifact-path', alternateSpelling(inputPath),
        '--launch-input-sha256', launchHash, '--fork-context', 'false'
    ];
    const wrongInput = [...shared];
    wrongInput[wrongInput.indexOf('--launch-input-artifact-path') + 1] = path.join(path.dirname(inputPath), 'different.json');
    const rejectedStart = await advance(repoRoot, ['--reviewer-phase', 'started', ...wrongInput]);
    assert.match(rejectedStart.failed?.error || '', /input or output path does not match/u);
    assert.equal(countEvents(repoRoot, 'REVIEWER_DELEGATION_STARTED'), 0);
    const start = await cli(repoRoot, ['task', TASK_ID, 'advance', '--reviewer-phase', 'started', ...shared]);
    assert.equal(start.exitCode, 0, start.text);
    assert.match(start.text, /1\. record-reviewer-delegation-started: PASS/u);
    assert.match(start.text, /RecordReviewerLaunchFailedCommand: .*gate record-reviewer-launch-failed/u);
    assert.equal(countEvents(repoRoot, 'REVIEWER_DELEGATION_STARTED'), 1);
    const substituted = await advance(repoRoot, [
        '--reviewer-phase', 'returned', '--review-output-path', path.join(path.dirname(outputPath), 'different.md'), ...shared
    ]);
    assert.match(substituted.failed?.error || '', /output path does not match/u);
    const resultArgs = ['--reviewer-phase', 'returned', '--review-output-path', alternateSpelling(outputPath), ...shared];
    const missing = await advance(repoRoot, resultArgs);
    assert.match(missing.failed?.error || '', /requires the report returned/u);

    const contextPath = handoffValue(prepared, 'ReviewContextPath');
    const report = buildNoFindingsJsonReviewReport(contextPath, TASK_ID);
    const reportBytes = JSON.stringify(report);
    const startedArtifact = fs.readFileSync(launchPath, 'utf8');
    const { delegation_started_at_utc: delegationStartedAt } = JSON.parse(startedArtifact) as {
        delegation_started_at_utc: string;
    };
    const cacheDirectory = path.join(resolveReviewScratchRoot(repoRoot), '..', '.reviewer-output-cache', TASK_ID);
    fs.writeFileSync(outputPath, reportBytes, 'utf8');
    const staleMtimeSeconds = (Date.parse(delegationStartedAt) - 0.25) / 1000;
    fs.utimesSync(outputPath, staleMtimeSeconds, staleMtimeSeconds);
    assert.ok(fs.statSync(outputPath).mtimeMs < Date.parse(delegationStartedAt));
    const stale = await advance(repoRoot, resultArgs);
    assert.match(stale.failed?.error || '', /requires the report returned/u);
    assert.equal(countEvents(repoRoot, 'REVIEWER_LAUNCH_COMPLETED'), 0);
    assert.equal(fs.readFileSync(launchPath, 'utf8'), startedArtifact);
    assert.equal(fs.existsSync(cacheDirectory), false);

    fs.writeFileSync(outputPath, reportBytes, 'utf8');
    const contextBytes = fs.readFileSync(contextPath);
    fs.appendFileSync(contextPath, '\n');
    const staleContext = await advance(repoRoot, resultArgs);
    assert.equal(staleContext.completed.length, 0);
    assert.equal(countEvents(repoRoot, 'REVIEWER_LAUNCH_COMPLETED'), 0);
    assert.equal(fs.readFileSync(launchPath, 'utf8'), startedArtifact);
    assert.equal(fs.existsSync(cacheDirectory), false);
    fs.writeFileSync(contextPath, contextBytes);
    // Garda distrusts a delegated review whose launch completes less than 10 s after delegation start
    // (MIN_DELEGATED_WORK_WINDOW_MS in review-timing-trust.ts). A fast host reaches this point sooner,
    // so wait out a real reviewer work window instead of depending on host speed.
    await delay(Math.max(0, Date.parse(delegationStartedAt) + 10_500 - Date.now()));
    const persisted = await interruptCompletion(repoRoot, launchPath, resultArgs);
    return { repoRoot, launchPath, outputPath, resultArgs, report, reportBytes, persisted, cacheDirectory };
}

describe('composite reviewer boundaries', () => {
    it('does not complete a reviewer merely because launch metadata has been prepared', async () => {
        const result = await runTaskComposite({
            taskId, repoRoot: '.', mode: 'advance', entryInputs: null, reviewerInputs: returned,
            resolve: () => reviewRoute('record-reviewer-delegation-started'),
            execute: async () => assert.fail('Prepared metadata is not evidence of a launch.')
        });
        assert.equal(result.counters.subgates_attempted, 0);
    });

    it('stops after prepare and after start even when the next resolution offers more work', async () => {
        for (const phase of ['prepare-reviewer-launch', 'record-reviewer-delegation-started'] as const) {
            const routes = [reviewRoute(phase), reviewRoute('complete-reviewer-launch')];
            const result = await runTaskComposite({
                taskId, repoRoot: '.', mode: 'advance', entryInputs: null,
                reviewerInputs: phase === 'record-reviewer-delegation-started' ? started : null,
                resolve: () => routes.shift()!,
                execute: async () => ({ passed: true, outputLines: [] })
            });
            assert.deepEqual(result.completed.map(({ gate }) => gate), [phase]);
            assert.equal(result.counters.navigator_resolutions, 2);
        }
    });

    it('stops before running unbound review output or a substituted launch input', async () => {
        const substituted = await runTaskComposite({
            taskId, repoRoot: '.', mode: 'advance', entryInputs: null,
            reviewerInputs: { ...started, launchInputSha256: 'b'.repeat(64) },
            resolve: () => reviewRoute('record-reviewer-delegation-started'),
            execute: async () => assert.fail('A substituted input digest must stop before dispatch.')
        });
        assert.equal(substituted.counters.subgates_attempted, 0);
        const staleRoute = reviewRoute('record-reviewer-delegation-started');
        staleRoute.commands[0].command = 'stale navigation';
        const stale = await runTaskComposite({
            taskId, repoRoot: '.', mode: 'advance', entryInputs: null, reviewerInputs: started,
            resolve: () => staleRoute,
            execute: async () => assert.fail('Stale routes must lose their execution binding.')
        });
        assert.equal(stale.counters.subgates_attempted, 0);
    });

    it('requires a real invocation id before reading or changing task state', async () => {
        await assert.rejects(handleTaskComposite(taskId, 'advance', [
            '--reviewer-phase', 'started', '--review-type', 'code', '--reviewer-identity', 'agent:fixture',
            '--attestation-source', 'test_provider_controller', '--fork-context', 'false',
            '--launch-input-mode', 'copy_paste_prompt', '--launch-input-sha256', inputSha256
        ]), /exactly one provider or controller invocation id/u);
    });

    it('re-resolves completion, invocation and result in order and stops before another lane', async () => {
        const routes = [
            reviewRoute('complete-reviewer-launch'), reviewRoute('record-review-invocation'),
            reviewRoute('record-review-result'), reviewRoute('prepare-reviewer-launch', 'test')
        ];
        const result = await runTaskComposite({
            taskId, repoRoot: '.', mode: 'advance', entryInputs: null, reviewerInputs: returned,
            resolve: () => routes.shift()!,
            execute: async () => ({ passed: true, outputLines: [] })
        });
        assert.deepEqual(result.completed.map(({ gate }) => gate), [
            'complete-reviewer-launch', 'record-review-invocation', 'record-review-result'
        ]);
        assert.equal(result.next?.next_gate, 'prepare-reviewer-launch');
    });

    it('records one native receipt after recovering the composite return without rewriting the attempt', async () => {
        const fixture = await createCompositeFixture();
        try {
            const { repoRoot, launchPath, outputPath, resultArgs, report, reportBytes, persisted, cacheDirectory } = await persistInterruptedReturn(fixture);
            assert.equal(countEvents(repoRoot, 'REVIEWER_LAUNCH_COMPLETED'), 0);
            const { review_output_sha256: outputDigest } = JSON.parse(persisted) as { review_output_sha256: string };
            assert.match(outputDigest, /^[a-f0-9]{64}$/u);
            fs.unlinkSync(path.join(cacheDirectory, outputDigest));

            fs.unlinkSync(outputPath);
            const fallback = await advance(repoRoot);
            assert.equal(fallback.completed.length, 0);
            assert.match(fallback.next?.commands[0]?.command || '', /gate complete-reviewer-launch .*--recover-publication-sha256/u);
            assert.equal(fallback.next?.stated_action, undefined);
            const missingRecovery = await advance(repoRoot, resultArgs);
            assert.equal(missingRecovery.failed?.gate, 'complete-reviewer-launch');
            assert.match(missingRecovery.failed?.error || '', /recovery requires the report bound to the persisted completion/u);
            assert.equal(countEvents(repoRoot, 'REVIEWER_LAUNCH_COMPLETED'), 0);
            assert.equal(fs.readFileSync(launchPath, 'utf8'), persisted);

            fs.writeFileSync(outputPath, `${reportBytes}\n`, 'utf8');
            const changedRecovery = await advance(repoRoot, resultArgs);
            assert.equal(changedRecovery.failed?.gate, 'complete-reviewer-launch');
            assert.match(changedRecovery.failed?.error || '', /recovery requires the report bound to the persisted completion/u);
            assert.equal(countEvents(repoRoot, 'REVIEWER_LAUNCH_COMPLETED'), 0);
            assert.equal(fs.readFileSync(launchPath, 'utf8'), persisted);

            fs.writeFileSync(outputPath, reportBytes, 'utf8');
            const recorded = await advance(repoRoot, resultArgs);
            // The stated recovery command records the invocation inside the completion, so agent-supplied inputs
            // send the same argv and no separate invocation step remains.
            assert.deepEqual(recorded.completed.map(({ gate }) => gate), [
                'complete-reviewer-launch', 'record-review-result'
            ]);
            assert.equal(countEvents(repoRoot, 'REVIEWER_INVOCATION_ATTESTED'), 1);
            assert.equal(fs.readFileSync(launchPath, 'utf8'), persisted);
            const acceptedOutputPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews',
                `${TASK_ID}-code-review-output.md`);
            assert.deepEqual(JSON.parse(fs.readFileSync(acceptedOutputPath, 'utf8')), report);
            assert.equal((await advance(repoRoot, resultArgs)).completed.length, 0);
            assert.equal(countEvents(repoRoot, 'REVIEWER_DELEGATION_STARTED'), 1);
            assert.equal(countEvents(repoRoot, 'REVIEWER_LAUNCH_COMPLETED'), 1);
            assert.equal(countEvents(repoRoot, 'REVIEW_RECORDED'), 1);
            const next = resolveNextStep({ taskId: TASK_ID, repoRoot });
            assert.deepEqual(next.review.launchable_review_types, ['api']);
            assert.deepEqual(next.review.blocked_review_lanes.find(lane => lane.review_type === 'test')?.blocked_by, ['api']);
            assert.equal(next.review.next_review_type, 'api');
        } finally {
            fixture.dispose();
        }
    });

    it('recovers the persisted return without inputs and attests the invocation in the same step', async () => {
        const fixture = await createCompositeFixture();
        try {
            const { repoRoot, launchPath, persisted } = await persistInterruptedReturn(fixture);
            assert.equal(countEvents(repoRoot, 'REVIEWER_LAUNCH_COMPLETED'), 0);
            assert.equal(countEvents(repoRoot, 'REVIEWER_INVOCATION_ATTESTED'), 0);
            const recovered = await advance(repoRoot);
            assert.equal(recovered.completed[0]?.gate, 'complete-reviewer-launch');
            assert.equal(recovered.completed.some(({ gate }) => gate === 'record-review-invocation'), false);
            assert.equal(countEvents(repoRoot, 'REVIEWER_LAUNCH_COMPLETED'), 1);
            assert.equal(countEvents(repoRoot, 'REVIEWER_INVOCATION_ATTESTED'), 1);
            assert.equal(fs.readFileSync(launchPath, 'utf8'), persisted);
        } finally {
            fixture.dispose();
        }
    });
});
