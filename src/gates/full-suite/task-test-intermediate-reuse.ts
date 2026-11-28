import * as path from 'node:path';
import { readValidationFile, validationDigest } from '../../core/project-validation-identity';
import { MAX_RETAINED_VALIDATION_OUTPUT_BYTES } from '../../core/validation-report-evidence';
import { intermediateInvocationIdentity, intermediateSourcePathKey } from '../../core/intermediate-selected-cases';
import type { TaskValidationPlan, TaskValidationProcess } from '../../core/task-validation-plan';
import { isPlainRecord } from '../../core/records';
import { normalizePath } from '../../core/orchestrator-paths';
import { readImmutableValidationEventSnapshot } from '../project-validation/attempt-evidence';
import { readTaskOwnedIntermediateExecutionEvidence } from '../review/focused-intermediate-evidence';
import { TASK_TEST_ADAPTERS } from './task-test-execution-proof';

const TEST_COMMAND_SOURCES = new Set(['targeted-test', 'node-test']);
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Audit record: the validation artifact names the exact intermediate execution it accepted. */
export interface ReusedIntermediateTaskTestExecution {
    schema_version: 1;
    command_source: string;
    command: string;
    execution_id: string;
    event_task_sequence: number;
    artifact_path: string;
    artifact_sha256: string;
    output_artifact_path: string;
    output_artifact_sha256: string;
    duration_ms: number | null;
}

export interface ReusableIntermediateTaskTestRun {
    process: Omit<TaskValidationProcess, 'scope_before' | 'scope_after'>;
    outputLines: string[];
    reuse: ReusedIntermediateTaskTestExecution;
}

type TimelineEvent = Record<string, unknown> & { event_type: string; details?: Record<string, unknown> };

function sequenceOf(event: Record<string, unknown> | undefined): number {
    const integrity = isPlainRecord(event?.integrity) ? event.integrity : {};
    return typeof integrity.task_sequence === 'number' && Number.isSafeInteger(integrity.task_sequence)
        ? integrity.task_sequence : NaN;
}

/**
 * A passing intermediate run of exactly the selected task test command is the same execution that
 * task-test-validation would perform when it started after the selection and the latest compile
 * pass, ran for the current preflight and source content, observed every selected target and input
 * at its selected bytes, and is the latest attempt of that command. Every other case returns null so
 * the caller executes the command normally.
 */
export function readReusableIntermediateTaskTestRun(options: {
    repoRoot: string;
    taskId: string;
    reviewsRoot: string;
    eventsRoot: string;
    command: string;
    plan: TaskValidationPlan | undefined;
    preflightPath: string;
    preflightSha256: string | null;
    compileGateTimestamp: string | null;
}): ReusableIntermediateTaskTestRun | null {
    const { repoRoot, taskId, plan, command } = options;
    try {
        const binding = plan?.binding;
        if (!plan || !binding || plan.descriptor.invocations.length !== 1 || !options.preflightSha256
            || path.resolve(binding.workspace_root) !== path.resolve(repoRoot)
            || TASK_TEST_ADAPTERS.some(adapter => adapter.supports(command))) return null;
        const selectedAt = Date.parse(binding.selected_at);
        const snapshot = readImmutableValidationEventSnapshot(repoRoot, taskId);
        if (path.resolve(snapshot.preflight_path) !== path.resolve(options.preflightPath)
            || snapshot.preflight_sha256 !== options.preflightSha256
            || snapshot.scope_content_sha256 !== binding.scope_content_sha256
            || !Number.isFinite(selectedAt)) return null;
        const events = snapshot.events as unknown as TimelineEvent[];
        const selection = [...events].reverse().find(event => event.event_type === 'TASK_TEST_SELECTION_RECORDED'
            && event.actor === 'task-selection-command' && event.outcome === 'PASS'
            && isPlainRecord(event.details?.task_test_selection_authority)
            && event.details.task_test_selection_authority.task_id === taskId
            && event.details.task_test_selection_authority.decision_utc === binding.selected_at
            && event.details.task_test_selection_authority.command === command);
        const compile = [...events].reverse().find(event => event.event_type === 'COMPILE_GATE_PASSED');
        if (!selection || !compile || !options.compileGateTimestamp
            || compile.timestamp_utc !== options.compileGateTimestamp) return null;
        const after = Math.max(sequenceOf(selection), sequenceOf(compile), snapshot.preflight_sequence);
        if (!Number.isSafeInteger(after)) return null;
        const evidence = readTaskOwnedIntermediateExecutionEvidence({ repoRoot, taskId,
            reviewsRoot: options.reviewsRoot, eventsRoot: options.eventsRoot,
            expectedPreflightPath: snapshot.preflight_path, expectedPreflightSha256: snapshot.preflight_sha256,
            expectedScopeContentSha256: snapshot.scope_content_sha256, minimumTaskSequenceExclusive: after });
        const identity = intermediateInvocationIdentity(command);
        const sameCommand = events.filter(event => ['INTERMEDIATE_COMMAND_STARTED', 'INTERMEDIATE_COMMAND_RUN',
            'TEST_FIRST_EXPECTED_FAILURE_RECORDED'].includes(event.event_type)
            && intermediateInvocationIdentity(event.details?.command) === identity);
        const latest = sameCommand.reduce<TimelineEvent | undefined>((found, event) =>
            !found || sequenceOf(event) > sequenceOf(found) ? event : found, undefined);
        const entry = evidence.entries.find(item => item.event_task_sequence === sequenceOf(latest));
        if (!identity || !entry || latest?.event_type !== 'INTERMEDIATE_COMMAND_RUN' || entry.command !== command
            || !TEST_COMMAND_SOURCES.has(entry.command_source) || !entry.execution_id || !entry.selected_case_binding
            || entry.report_evidence || entry.output_encoding) return null;
        const starts = sameCommand.filter(event => event.event_type === 'INTERMEDIATE_COMMAND_STARTED'
            && event.details?.execution_id === entry.execution_id);
        const start = starts[0];
        const before = entry.selected_case_binding.before;
        if (starts.length !== 1 || start.actor !== 'gate' || latest.actor !== 'gate'
            || sequenceOf(start) <= after || sequenceOf(start) >= entry.event_task_sequence
            || start.details?.command !== command || start.details?.artifact_path !== latest.details?.artifact_path
            || start.details?.preflight_sha256 !== snapshot.preflight_sha256
            || validationDigest(start.details?.selected_case_selection) !== validationDigest(before)
            || (before.unobserved_operands ?? []).length > 0) return null;
        const startedAt = String(start.timestamp_utc ?? ''), completedAt = String(latest.timestamp_utc ?? '');
        if (!(Date.parse(startedAt) >= selectedAt) || !(Date.parse(completedAt) >= Date.parse(startedAt))) return null;
        // Every selected target and command input was observed by this execution at its selected bytes.
        const observed = new Map(before.sources.map(source => [intermediateSourcePathKey(source.path), source.sha256]));
        if (![...plan.targets, ...plan.inputs].every(input => observed.get(intermediateSourcePathKey(input.path)) === input.sha256))
            return null;
        const artifact = readValidationFile(repoRoot, normalizePath(path.relative(repoRoot, entry.artifact_path)), MAX_ARTIFACT_BYTES);
        if (artifact.identity.sha256 !== entry.artifact_sha256) return null;
        const record: unknown = JSON.parse(artifact.bytes.toString('utf8'));
        const invocation = plan.descriptor.invocations[0];
        if (!isPlainRecord(record) || !isPlainRecord(record.command_descriptor)
            || validationDigest(record.command_descriptor.invocations) !== validationDigest(plan.descriptor.invocations)
            || !Array.isArray(record.invocations) || record.invocations.length !== 1 || !isPlainRecord(record.invocations[0])
            || record.invocations[0].exitCode !== 0 || record.invocations[0].timedOut !== false
            || record.invocations[0].cancelled !== false || record.invocations[0].executionError !== undefined
            || record.invocations[0].outputTruncated !== false) return null;
        const output = readValidationFile(repoRoot, normalizePath(path.relative(repoRoot, entry.output_artifact_path)),
            MAX_RETAINED_VALIDATION_OUTPUT_BYTES);
        if (output.identity.sha256 !== entry.output_artifact_sha256) return null;
        const outputLines = output.bytes.toString('utf8').replace(/\r?\n$/u, '').split(/\r?\n/u);
        const durationMs = typeof record.duration_ms === 'number' && Number.isSafeInteger(record.duration_ms)
            ? record.duration_ms : null;
        return {
            process: { execution_id: entry.execution_id, invocation: 0, executable: invocation.executable,
                argv: [...invocation.argv], cwd: binding.workspace_root, started_at: startedAt, completed_at: completedAt,
                exit_code: 0, timed_out: false, cancelled: false, output_sha256: entry.output_artifact_sha256 },
            outputLines,
            reuse: { schema_version: 1, command_source: entry.command_source, command, execution_id: entry.execution_id,
                event_task_sequence: entry.event_task_sequence, artifact_path: entry.artifact_path,
                artifact_sha256: entry.artifact_sha256, output_artifact_path: entry.output_artifact_path,
                output_artifact_sha256: entry.output_artifact_sha256, duration_ms: durationMs }
        };
    } catch {
        return null;
    }
}
