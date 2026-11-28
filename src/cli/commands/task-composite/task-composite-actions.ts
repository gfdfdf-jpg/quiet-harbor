import * as path from 'node:path';
import { format } from 'node:util';
import { executeNextStepEffects } from '../../../gates/next-step';
import {
    type NextStepCommandOperation, type NextStepReviewerBookkeepingOperation
} from '../../../gates/next-step/next-step-command-execution';
import { captureDirtyWorkspaceBaseline } from '../../../gates/workspace/dirty-worktree-protection';
import {
    formatClassifyChangeConsoleOutput,
    runBindRulePackToPreflightCommand,
    runBuildReviewContextCommand,
    runCompileGateCommand,
    runFullSuiteValidationCommand,
    runHandshakeDiagnosticsCommand,
    runIntermediateCommandCommand,
    runRequiredReviewsCheckCommand,
    runQualityChecklistCommand,
    runShellSmokePreflightCommand
} from '../gates';
import { runEnterTaskModeGate } from '../gate-task-handlers';
import { runClassifyChangeWithRulePackRebind } from '../gate-flows/compile/classify-change-rule-pack-rebind';
import { runMaterializeReviewFollowUpTasksCommand } from '../gate-flows/review/review-follow-up-task-flow';
import { reviewerLaunchPathsEqual } from '../gate-review-handlers/launch/reviewer-launch-lane-transaction';
import { findInvalidDefaultPreflight } from '../gate-reset-preflight';

export { COMPOSITE_MECHANICAL_EFFECT_KINDS, selectTaskCompositeAction } from '../../../gates/next-step/next-step-composite-action';
export type { TaskCompositeMode, TaskCompositeEntryInputs, TaskCompositeStopKind, TaskCompositeAction } from '../../../gates/next-step/next-step-composite-action';
import type {
    TaskCompositeCloseoutInputs, TaskCompositeEntryInputs, TaskCompositeReviewerInputs
} from '../../../gates/next-step/next-step-composite-action';

const OBSERVATION_REFUSAL_GATE = 'git-observation';

/** Files already changed before entry; explicit planned scope is the only accepted isolation for them. */
export function readUnscopedDirtyWorkspaceFiles(repoRoot: string, entryInputs: TaskCompositeEntryInputs): string[] {
    if (entryInputs.plannedChangedFiles.length > 0) return [];
    return [...captureDirtyWorkspaceBaseline(repoRoot).changed_files];
}

export interface TaskCompositeOperationOutcome {
    passed: boolean;
    outputLines: string[];
}

function splitOutputText(text: string): string[] {
    return text.split(/\r?\n/u).filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

export interface TaskCompositeOperationContext {
    repoRoot: string;
    entryInputs: TaskCompositeEntryInputs | null;
    reviewerInputs?: TaskCompositeReviewerInputs | null;
    closeoutInputs?: TaskCompositeCloseoutInputs | null;
}

function boundPathsMatch(repoRoot: string, actual: string | null, expected: string | null): boolean {
    if (actual === null || expected === null) return actual === expected;
    return reviewerLaunchPathsEqual(path.resolve(repoRoot, actual), path.resolve(repoRoot, expected));
}

async function runReviewerBookkeeping(
    operation: NextStepReviewerBookkeepingOperation,
    repoRoot: string,
    inputs: TaskCompositeReviewerInputs | null | undefined
): Promise<TaskCompositeOperationOutcome> {
    const args = operation.arguments;
    const gate = operation.operation_id;
    const recoverySha256 = args.recover_publication_sha256;
    const automaticRecovery = recoverySha256 && !inputs;
    if (automaticRecovery) {
        if ((gate !== 'record-reviewer-delegation-started' && gate !== 'complete-reviewer-launch')
            || !args.reviewer_identity || !args.attestation_source || !args.launch_input_mode || !args.launch_input_sha256
            || !(args.controller_invocation_id || args.provider_invocation_id)
            || (gate === 'complete-reviewer-launch' && !args.review_output_path)) {
            throw new Error('Reviewer publication recovery requires the persisted launch inputs. Run next-step again.');
        }
        inputs = {
            phase: gate === 'complete-reviewer-launch' ? 'returned' : 'started',
            reviewType: args.review_type,
            reviewerIdentity: args.reviewer_identity,
            providerInvocationId: args.controller_invocation_id ? null : args.provider_invocation_id,
            controllerInvocationId: args.controller_invocation_id,
            attestationSource: args.attestation_source,
            launchInputMode: args.launch_input_mode,
            launchInputSha256: args.launch_input_sha256,
            launchInputArtifactPath: args.launch_input_artifact_path,
            reviewOutputPath: args.review_output_path,
            forkContext: false
        };
    }
    const gateArgv = [
        `--task-id=${args.task_id}`, `--review-type=${args.review_type}`, `--repo-root=${repoRoot}`,
        '--reviewer-execution-mode=delegated_subagent',
        ...(args.task_mode_path ? [`--task-mode-path=${args.task_mode_path}`] : []),
        ...(gate === 'record-review-result' ? [] : [`--reviewer-launch-artifact-path=${args.launch_artifact_path}`])
    ];
    if (gate !== 'prepare-reviewer-launch') {
        if (!inputs) throw new Error('Explicit reviewer bookkeeping inputs are required.');
        if (!boundPathsMatch(repoRoot, inputs.launchInputArtifactPath, args.launch_input_artifact_path)
            || (inputs.phase === 'returned' && !boundPathsMatch(repoRoot, inputs.reviewOutputPath, args.review_output_path))) {
            throw new Error('Reviewer input or output path does not match the current navigator action.');
        }
        gateArgv.push(`--reviewer-identity=${inputs.reviewerIdentity}`);
        if (gate === 'record-reviewer-delegation-started' || gate === 'complete-reviewer-launch') {
            gateArgv.push(
                ...(inputs.providerInvocationId ? [`--provider-invocation-id=${inputs.providerInvocationId}`] : []),
                ...(inputs.controllerInvocationId ? [`--controller-invocation-id=${inputs.controllerInvocationId}`] : []),
                `--attestation-source=${inputs.attestationSource}`,
                `--launch-input-mode=${inputs.launchInputMode}`, `--launch-input-sha256=${inputs.launchInputSha256}`,
                ...(inputs.launchInputArtifactPath ? [`--launch-input-artifact-path=${inputs.launchInputArtifactPath}`] : []),
                `--fork-context=${inputs.forkContext}`,
                ...(recoverySha256 ? [`--recover-publication-sha256=${recoverySha256}`] : []),
                // The stated recovery command always records the invocation; agent-supplied inputs send the same argv.
                ...(recoverySha256 && gate === 'complete-reviewer-launch' ? ['--record-invocation'] : []),
                ...(gate === 'record-reviewer-delegation-started' && inputs.reviewerProvider
                    ? [`--reviewer-provider=${inputs.reviewerProvider}`] : []),
                ...(gate === 'record-reviewer-delegation-started' && inputs.reviewerModel
                    ? [`--reviewer-model=${inputs.reviewerModel}`] : [])
            );
        } else if (gate === 'record-review-result') {
            gateArgv.push(`--preflight-path=${args.preflight_path}`, `--review-output-path=${args.review_output_path}`);
        }
    }
    return captureHandlerOutput(async () => {
        if (gate !== 'record-review-result') {
            const preflightError = findInvalidDefaultPreflight(repoRoot, args.task_id);
            if (preflightError) throw preflightError;
        }
        const handlers = await import('../gate-review-handlers');
        switch (gate) {
            case 'prepare-reviewer-launch':
                await handlers.handlePrepareReviewerLaunch(gateArgv);
                break;
            case 'record-reviewer-delegation-started':
                await handlers.handleRecordReviewerDelegationStarted(gateArgv);
                break;
            case 'complete-reviewer-launch': {
                const outputPath = inputs?.reviewOutputPath;
                if (!outputPath) throw new Error('Reviewer completion requires the returned output path.');
                await handlers.handleCompleteReviewerLaunch(gateArgv, outputPath);
                break;
            }
            case 'record-review-invocation':
                await handlers.handleRecordReviewInvocation(gateArgv);
                break;
            case 'record-review-result':
                await handlers.handleRecordReviewResult(gateArgv);
                break;
        }
    });
}

/**
 * Gate handlers invoked by the single-command CLI print directly (console.log or stdout). Preserve those messages in
 * composite JSON too. With `ownExitCode` the handler's exit status is read from a clean slate and the caller's status
 * is restored afterwards, so an earlier status can neither fail nor pass this step.
 */
async function captureHandlerOutput(
    run: () => Promise<void>,
    options: { captureStdout?: boolean; ownExitCode?: boolean } = {}
): Promise<TaskCompositeOperationOutcome> {
    const outputLines: string[] = [];
    let pending = '';
    const originalLog = console.log;
    const originalWrite = process.stdout.write;
    const previousExitCode = process.exitCode;
    console.log = (...values: unknown[]) => outputLines.push(...splitOutputText(format(...values)));
    if (options.captureStdout) {
        process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
            pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
            const callback = rest.find((value): value is () => void => typeof value === 'function');
            callback?.();
            return true;
        }) as typeof process.stdout.write;
    }
    if (options.ownExitCode) process.exitCode = undefined;
    try {
        await run();
        if (pending) outputLines.push(...splitOutputText(pending));
        return { passed: !process.exitCode, outputLines };
    } finally {
        console.log = originalLog;
        process.stdout.write = originalWrite;
        if (options.ownExitCode) process.exitCode = previousExitCode;
    }
}

async function runCloseoutHandler(
    gate: 'completion-gate' | 'task-audit-summary',
    gateArgv: string[]
): Promise<TaskCompositeOperationOutcome> {
    return captureHandlerOutput(async () => {
        const handlers = await import('../gate-task-handlers');
        if (gate === 'completion-gate') await handlers.handleCompletionGate(gateArgv);
        else await handlers.handleTaskAuditSummary(gateArgv);
    }, { captureStdout: true, ownExitCode: true });
}

async function runReviewRouting(
    operation: Extract<NextStepCommandOperation, { operation_id: 'record-review-routing' }>,
    repoRoot: string
): Promise<TaskCompositeOperationOutcome> {
    const args = operation.arguments;
    const gateArgv = [
        `--task-id=${args.task_id}`, `--review-type=${args.review_type}`, `--repo-root=${repoRoot}`,
        '--reviewer-execution-mode=delegated_subagent',
        ...(args.task_mode_path ? [`--task-mode-path=${args.task_mode_path}`] : [])
    ];
    return captureHandlerOutput(async () => {
        // Like the gate command: inspect the canonical preflight before the handler can record any evidence.
        const preflightError = findInvalidDefaultPreflight(repoRoot, args.task_id);
        if (preflightError) throw preflightError;
        await (await import('../gate-review-handlers')).handleRecordReviewRouting(gateArgv);
    });
}

/** Runs the existing gate entry point with the descriptor's typed arguments, never with rendered command text. */
export async function executeTaskCompositeOperation(
    operation: NextStepCommandOperation,
    context: TaskCompositeOperationContext
): Promise<TaskCompositeOperationOutcome> {
    const repoRoot = path.resolve(context.repoRoot);
    switch (operation.operation_id) {
        case 'prepare-reviewer-launch':
        case 'record-reviewer-delegation-started':
        case 'complete-reviewer-launch':
        case 'record-review-invocation':
        case 'record-review-result':
            return runReviewerBookkeeping(operation, repoRoot, context.reviewerInputs);
        case 'enter-task-mode': {
            const inputs = context.entryInputs;
            if (!inputs) throw new Error('Task-mode entry requires explicit agent inputs.');
            const result = await runEnterTaskModeGate({
                repoRoot,
                taskId: operation.arguments.task_id,
                entryMode: operation.arguments.entry_mode,
                requestedDepth: inputs.requestedDepth ?? operation.arguments.requested_depth,
                taskSummary: inputs.taskSummary ?? operation.arguments.task_summary,
                provider: inputs.provider,
                ...(inputs.routedTo ? { routedTo: inputs.routedTo } : {}),
                ...(inputs.plannedChangedFiles.length ? { plannedChangedFiles: [...inputs.plannedChangedFiles] } : {}),
                ...(inputs.orchestratorWork ? { orchestratorWork: true } : {}),
                ...(inputs.workflowConfigWork ? { workflowConfigWork: true } : {}),
                ...(inputs.operatorConfirmed ? { operatorConfirmed: inputs.operatorConfirmed } : {}),
                ...(inputs.operatorConfirmedAtUtc ? { operatorConfirmedAtUtc: inputs.operatorConfirmedAtUtc } : {})
            });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'handshake-diagnostics': {
            const result = runHandshakeDiagnosticsCommand({ repoRoot, taskId: operation.arguments.task_id,
                taskModePath: operation.arguments.task_mode_path });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'shell-smoke-preflight': {
            const result = runShellSmokePreflightCommand({ repoRoot, taskId: operation.arguments.task_id,
                taskModePath: operation.arguments.task_mode_path });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'classify-change': {
            const args = operation.arguments;
            const result = runClassifyChangeWithRulePackRebind({
                repoRoot,
                taskId: args.task_id,
                taskIntent: args.task_intent,
                ...(args.changed_files.length ? { changedFiles: [...args.changed_files] } : {}),
                ...(args.detection_source ? { detectionSource: args.detection_source } : {}),
                ...(args.use_staged ? { useStaged: true } : {}),
                ...(args.task_mode_path ? { taskModePath: args.task_mode_path } : {}),
                ...(args.rule_pack_path ? { rulePackPath: args.rule_pack_path } : {}),
                outputPath: args.output_path
            });
            // A failed inline rebinding fails the step; the navigator then routes the rule-pack binding again.
            return { passed: result.rulePackRebind?.passed !== false, outputLines: [
                ...splitOutputText(formatClassifyChangeConsoleOutput(result.outputText, result.preflightPath)),
                ...(result.rulePackRebind?.outputLines ?? [])
            ] };
        }
        case 'bind-rule-pack-to-preflight': {
            const args = operation.arguments;
            const result = runBindRulePackToPreflightCommand({
                repoRoot,
                taskId: args.task_id,
                preflightPath: args.preflight_path,
                ...(args.task_mode_path ? { taskModePath: args.task_mode_path } : {}),
                ...(args.artifact_path ? { artifactPath: args.artifact_path } : {})
            });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'quality-checklist': {
            const args = operation.arguments;
            const result = runQualityChecklistCommand({
                repoRoot, taskId: args.task_id, preflightPath: args.preflight_path, answersPath: args.answers_path
            });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'compile-gate': {
            const args = operation.arguments;
            const result = await runCompileGateCommand({
                repoRoot,
                taskId: args.task_id,
                preflightPath: args.preflight_path,
                ...(args.rule_pack_path ? { rulePackPath: args.rule_pack_path } : {}),
                ...(args.task_mode_path ? { taskModePath: args.task_mode_path } : {})
            });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'task-test-validation': {
            const args = operation.arguments;
            const result = await runFullSuiteValidationCommand({ repoRoot, taskId: args.task_id, preflightPath: args.preflight_path });
            return { passed: result.exitCode === 0, outputLines: splitOutputText(result.outputText) };
        }
        case 'build-scoped-diff': {
            const args = operation.arguments;
            // The gate command's own handler resolves and checks every path inside the repo before it writes.
            return captureHandlerOutput(async () => (await import('../gate-build-handlers')).handleBuildScopedDiff([
                `--review-type=${args.review_type}`, `--preflight-path=${args.preflight_path}`,
                `--output-path=${args.output_path}`, `--metadata-path=${args.metadata_path}`, `--repo-root=${repoRoot}`,
                `--expected-preflight-sha256=${args.preflight_sha256}`
            ]), { ownExitCode: true });
        }
        case 'build-review-context': {
            const args = operation.arguments;
            // Like the gate command, a refused context throws; the runner reports it as the failed step.
            const result = await runBuildReviewContextCommand({
                repoRoot,
                reviewType: args.review_type,
                depth: String(args.depth),
                preflightPath: args.preflight_path,
                ...(args.task_mode_path ? { taskModePath: args.task_mode_path } : {})
            });
            return { passed: true, outputLines: result.outputLines };
        }
        case 'record-review-routing':
            return runReviewRouting(operation, repoRoot);
        case 'run-intermediate-command': {
            const args = operation.arguments;
            const result = await runIntermediateCommandCommand(args.recipe_id !== null
                ? { repoRoot, taskId: args.task_id, recipeId: args.recipe_id }
                : {
                    repoRoot,
                    taskId: args.task_id,
                    command: args.command,
                    commandSource: args.command_source,
                    ...(args.preflight_path ? { preflightPath: args.preflight_path } : {}),
                    ...(args.selected_cases.length ? { selectedCases: [...args.selected_cases] } : {}),
                    ...(args.report_files.length ? { reportFiles: [...args.report_files] } : {})
                });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'required-reviews-check': {
            const args = operation.arguments;
            // The agent's explicit statement wins; otherwise the attestation Garda derived from its own evidence.
            const attestation = context.closeoutInputs?.reviewAuthorshipAttestationJson ?? args.review_authorship_attestation_json;
            const result = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId: args.task_id,
                preflightPath: args.preflight_path,
                ...(args.task_mode_path ? { taskModePath: args.task_mode_path } : {}),
                ...(args.rule_pack_path ? { rulePackPath: args.rule_pack_path } : {}),
                ...(attestation ? { reviewAuthorshipAttestationJson: attestation } : {})
            });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'materialize-review-follow-up-tasks': {
            const args = operation.arguments;
            const result = runMaterializeReviewFollowUpTasksCommand({
                repoRoot,
                taskId: args.task_id,
                ...(args.review_type !== null ? { reviewType: args.review_type } : {}),
                ...(args.review_types.length ? { reviewTypes: args.review_types.join(',') } : {}),
                ...(args.disposition_artifact_path !== null ? { dispositionArtifactPath: args.disposition_artifact_path } : {}),
                ...(args.receipt_path !== null ? { receiptPath: args.receipt_path } : {}),
                ...(args.artifact_path !== null ? { artifactPath: args.artifact_path } : {}),
                ...(args.reviews_root !== null ? { reviewsRoot: args.reviews_root } : {})
            });
            return { passed: result.exitCode === 0, outputLines: result.outputLines };
        }
        case 'completion-gate': {
            const args = operation.arguments;
            return runCloseoutHandler('completion-gate', [
                `--task-id=${args.task_id}`, `--preflight-path=${args.preflight_path}`, `--repo-root=${repoRoot}`,
                ...(args.rule_pack_path ? [`--rule-pack-path=${args.rule_pack_path}`] : []),
                ...(args.task_mode_path ? [`--task-mode-path=${args.task_mode_path}`] : [])
            ]);
        }
        case 'task-audit-summary':
            return runCloseoutHandler('task-audit-summary', [`--task-id=${operation.arguments.task_id}`, `--repo-root=${repoRoot}`]);
        case 'execute-next-step-effects': {
            const result = executeNextStepEffects(
                { taskId: operation.arguments.task_id, repoRoot },
                operation.arguments.plan_sha256
            );
            // A refused observation executes nothing; it names the retry instead.
            return result.next_gate === OBSERVATION_REFUSAL_GATE
                ? { passed: false, outputLines: [result.title, result.reason] }
                : { passed: true, outputLines: [`EffectsExecuted: ${operation.arguments.effect_kinds.join(', ')}`] };
        }
        default: {
            const unsupported: never = operation;
            throw new Error(`Unsupported composite operation: ${String((unsupported as { operation_id?: unknown }).operation_id)}.`);
        }
    }
}
