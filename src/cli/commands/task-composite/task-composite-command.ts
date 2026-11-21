import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../exit-codes';
import {
    formatCommandsHeading, formatNextStepFinalReportLines, formatNextStepWarningLines
} from '../../../gates/next-step/next-step-command-formatters';
import { parseOptions } from '../cli-helpers';
import type { ParsedOptionsRecord } from '../shared-command-utils';
import type { TaskCompositeEntryInputs, TaskCompositeMode } from './task-composite-actions';
import type { TaskCompositeReviewerInputs } from '../../../gates/next-step/next-step-composite-action';
import { runTaskComposite, type TaskCompositeRunResult } from './task-composite-runner';

const COMMON_OPTION_DEFINITIONS = {
    '--repo-root': { key: 'repoRoot', type: 'string' },
    '--target-root': { key: 'repoRoot', type: 'string' },
    '--as-json': { key: 'asJson', type: 'boolean' },
    '--json': { key: 'asJson', type: 'boolean' }
} as const;

const START_OPTION_DEFINITIONS = {
    ...COMMON_OPTION_DEFINITIONS,
    '--provider': { key: 'provider', type: 'string' },
    '--routed-to': { key: 'routedTo', type: 'string' },
    '--requested-depth': { key: 'requestedDepth', type: 'string' },
    '--task-summary': { key: 'taskSummary', type: 'string' },
    '--planned-changed-file': { key: 'plannedChangedFiles', type: 'string[]' },
    '--orchestrator-work': { key: 'orchestratorWork', type: 'boolean' },
    '--workflow-config-work': { key: 'workflowConfigWork', type: 'boolean' },
    '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
    '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' }
} as const;

const ADVANCE_OPTION_DEFINITIONS = {
    ...COMMON_OPTION_DEFINITIONS,
    '--reviewer-phase': { key: 'reviewerPhase', type: 'string' },
    '--review-type': { key: 'reviewType', type: 'string' },
    '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
    '--provider-invocation-id': { key: 'providerInvocationId', type: 'string' },
    '--controller-invocation-id': { key: 'controllerInvocationId', type: 'string' },
    '--attestation-source': { key: 'attestationSource', type: 'string' },
    '--launch-input-mode': { key: 'launchInputMode', type: 'string' },
    '--launch-input-sha256': { key: 'launchInputSha256', type: 'string' },
    '--launch-input-artifact-path': { key: 'launchInputArtifactPath', type: 'string' },
    '--review-output-path': { key: 'reviewOutputPath', type: 'string' },
    '--fork-context': { key: 'forkContext', type: 'boolean' }
} as const;

const FINISH_OPTION_DEFINITIONS = {
    ...COMMON_OPTION_DEFINITIONS,
    '--review-authorship-attestation-json': { key: 'reviewAuthorshipAttestationJson', type: 'string' }
} as const;

const OUTPUT_TAIL_LINES = 40;

function optionalText(value: unknown): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function readEntryInputs(parsed: ParsedOptionsRecord): TaskCompositeEntryInputs {
    const provider = optionalText(parsed.provider);
    if (!provider) {
        throw new Error('task <task-id> start requires --provider "<runtime-provider>"; Garda never derives it for task-mode entry.');
    }
    return {
        provider,
        routedTo: optionalText(parsed.routedTo),
        requestedDepth: optionalText(parsed.requestedDepth),
        taskSummary: optionalText(parsed.taskSummary),
        plannedChangedFiles: Array.isArray(parsed.plannedChangedFiles)
            ? parsed.plannedChangedFiles.map((entry) => String(entry).trim()).filter(Boolean) : [],
        orchestratorWork: parsed.orchestratorWork === true,
        workflowConfigWork: parsed.workflowConfigWork === true,
        operatorConfirmed: optionalText(parsed.operatorConfirmed),
        operatorConfirmedAtUtc: optionalText(parsed.operatorConfirmedAtUtc)
    };
}

function readReviewerInputs(parsed: ParsedOptionsRecord): TaskCompositeReviewerInputs | null {
    const phase = optionalText(parsed.reviewerPhase);
    if (!phase && Object.values(ADVANCE_OPTION_DEFINITIONS).every(({ key }) =>
        key === 'repoRoot' || key === 'asJson' || parsed[key] === undefined)) return null;
    if (phase !== 'started' && phase !== 'returned') {
        throw new Error('Reviewer bookkeeping requires --reviewer-phase started or returned.');
    }
    const reviewType = optionalText(parsed.reviewType);
    const reviewerIdentity = optionalText(parsed.reviewerIdentity);
    const providerInvocationId = optionalText(parsed.providerInvocationId);
    const controllerInvocationId = optionalText(parsed.controllerInvocationId);
    const attestationSource = optionalText(parsed.attestationSource);
    const launchInputMode = optionalText(parsed.launchInputMode);
    const launchInputSha256 = optionalText(parsed.launchInputSha256)?.toLowerCase();
    const launchInputArtifactPath = optionalText(parsed.launchInputArtifactPath);
    const reviewOutputPath = optionalText(parsed.reviewOutputPath);
    if (!reviewType || !reviewerIdentity || !attestationSource || !launchInputSha256 || parsed.forkContext !== false) {
        throw new Error('Reviewer bookkeeping requires the review type, reviewer identity, attestation source, launch input hash and --fork-context false.');
    }
    if (Boolean(providerInvocationId) === Boolean(controllerInvocationId)) {
        throw new Error('Reviewer bookkeeping requires exactly one provider or controller invocation id.');
    }
    if ((launchInputMode !== 'copy_paste_prompt' && launchInputMode !== 'launch_artifact_path')
        || Boolean(launchInputArtifactPath) !== (launchInputMode === 'launch_artifact_path')) {
        throw new Error('Pass the launch input artifact path only in launch_artifact_path mode.');
    }
    if (Boolean(reviewOutputPath) !== (phase === 'returned')) {
        throw new Error('Pass --review-output-path only after the reviewer has returned its report.');
    }
    return { phase, reviewType, reviewerIdentity, providerInvocationId, controllerInvocationId, attestationSource,
        launchInputMode, launchInputSha256, launchInputArtifactPath, reviewOutputPath, forkContext: parsed.forkContext };
}

function formatStepLines(result: TaskCompositeRunResult): string[] {
    const lines = result.completed.flatMap((step, index) => [
        `  ${index + 1}. ${step.gate}: ${step.outcome}`,
        ...(['prepare-reviewer-launch', 'record-review-result'].includes(step.gate) ? step.output_lines : []),
        ...(step.gate === 'record-reviewer-delegation-started'
            ? step.output_lines.filter(line => line.startsWith('RecordReviewerLaunchFailedCommand: '))
            : [])
    ]);
    return lines.length ? ['Completed:', ...lines] : ['Completed: none'];
}

function formatCounters(result: TaskCompositeRunResult): string {
    const counters = result.counters;
    return `Counters: agent_invocations=${counters.agent_invocations}; navigator_resolutions=${counters.navigator_resolutions}; `
        + `subgates_attempted=${counters.subgates_attempted}; subgates_succeeded=${counters.subgates_succeeded}; `
        + `effects_executed=${counters.effects_executed}`;
}

export function formatTaskCompositeText(result: TaskCompositeRunResult): string {
    const lines = ['GARDA_TASK_COMPOSITE', `Task: ${result.task_id}`, `Mode: ${result.mode}`, `Outcome: ${result.outcome}`];
    lines.push(...formatStepLines(result));
    if (result.failed) {
        lines.push(`FailedGate: ${result.failed.gate}`);
        if (result.failed.error) lines.push(`Error: ${result.failed.error}`);
        const tail = result.failed.output_lines.slice(-OUTPUT_TAIL_LINES);
        if (tail.length) lines.push('FailureOutput:', ...tail.map((line) => `  ${line}`));
        if (result.navigator_command) lines.push(`Recovery: rerun the navigator: ${result.navigator_command}`);
    }
    if (result.stop && result.next) {
        lines.push(`StopKind: ${result.stop.kind}`, `StopReason: ${result.stop.reason}`);
        lines.push(`NextGate: ${result.next.next_gate ?? 'none'}`, `Next: ${result.next.title}`, `Reason: ${result.next.reason}`);
        // Same labels as the default next-step answer: warnings and operator decisions are never dropped.
        lines.push(...formatNextStepWarningLines(result.next), ...result.next.operator_decision, ...result.next.hints);
        lines.push('Instruction: rerun the Navigator below for the full instruction and artifact lines before continuing.');
        if (result.next.commands.length) {
            lines.push(formatCommandsHeading(result.next), ...result.next.commands.map((command) => `  ${command.label}: ${command.command}`));
        }
    }
    if (result.final_report) {
        // The canonical report, verbatim, then the native commit guidance. finish itself never commits.
        lines.push(...formatNextStepFinalReportLines(result.final_report));
        lines.push(`CommitCommandSuggestion: ${result.final_report.commit_command_suggestion}`);
        lines.push(`CommitQuestion: ${result.final_report.commit_question}`);
        lines.push('Commit: task finish never commits or publishes; commit only after explicit approval.');
    }
    if (result.navigator_command && !result.failed) lines.push(`Navigator: ${result.navigator_command}`);
    lines.push(formatCounters(result));
    return `${lines.join('\n')}\n`;
}

/** Exit status: a boundary stop is a normal outcome; a failed gate or a stalled navigator state is not. */
export function resolveTaskCompositeExitCode(result: TaskCompositeRunResult): number {
    if (result.outcome === 'FAILED') return EXIT_GATE_FAILURE;
    return result.stop?.kind === 'repeated-state' || result.stop?.kind === 'step-limit' ? EXIT_GATE_FAILURE : 0;
}

export async function handleTaskComposite(taskId: string, mode: TaskCompositeMode, actionArgv: string[]): Promise<void> {
    const { options } = parseOptions(actionArgv, mode === 'start' ? START_OPTION_DEFINITIONS
        : mode === 'advance' ? ADVANCE_OPTION_DEFINITIONS : FINISH_OPTION_DEFINITIONS);
    const parsed = options as ParsedOptionsRecord;
    const result = await runTaskComposite({
        taskId,
        repoRoot: path.resolve(String(parsed.repoRoot || '.')),
        mode,
        entryInputs: mode === 'start' ? readEntryInputs(parsed) : null,
        reviewerInputs: mode === 'advance' ? readReviewerInputs(parsed) : null,
        closeoutInputs: mode === 'finish'
            ? { reviewAuthorshipAttestationJson: optionalText(parsed.reviewAuthorshipAttestationJson) } : null
    });
    process.stdout.write(parsed.asJson === true ? `${JSON.stringify(result, null, 2)}\n` : formatTaskCompositeText(result));
    const exitCode = resolveTaskCompositeExitCode(result);
    if (exitCode !== 0) process.exitCode = exitCode;
}
