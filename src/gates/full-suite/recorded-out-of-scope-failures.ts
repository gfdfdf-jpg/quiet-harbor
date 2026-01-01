import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createInvocationReadMemoKey, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile, readTaskTimelineJsonlEntries, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { stringSha256 } from '../../gate-runtime/hash';

export interface RecordedOutOfScopeFailure {
    task_id: string;
    task_mode_entry_sha256: string;
    failure_event_sha256: string;
    command: string;
    failing_tests: string[];
    attribution?: 'attributed' | 'not attributed';
    artifact_path: string;
    artifact_sha256: string;
    // Retain the original artifact even after narrow validation replaces its mutable path.
    artifact: Record<string, unknown>;
}

const RECORDED = createInvocationReadMemoKey<RecordedOutOfScopeFailure[]>('recorded-out-of-scope-failures');

export function readRecordedOutOfScopeFailures(repoRoot: string, taskId: string): RecordedOutOfScopeFailure[] {
    if (!taskId) return [];
    return memoizeInvocationRead(RECORDED, JSON.stringify([path.resolve(repoRoot), taskId]), () => {
        const eventsRoot = joinOrchestratorPath(repoRoot, 'runtime/task-events');
        const timeline = path.join(eventsRoot, `${taskId}.jsonl`);
        return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
            const entries = readTaskTimelineJsonlEntries(timeline);
            const recorded = new Map<string, RecordedOutOfScopeFailure>();
            for (const entry of entries) {
                if (entry.record?.event_type !== 'TASK_TEST_SELECTION_RECORDED' || entry.record.outcome !== 'PASS'
                    || entry.record.actor !== 'task-selection-command') continue;
                const details = entry.record.details;
                const authority = isPlainRecord(details) ? details.task_test_selection_authority : null;
                if (!isPlainRecord(authority) || authority.task_id !== taskId
                    || authority.workspace_root !== path.resolve(repoRoot)) continue;
                const failures = authority.recorded_out_of_scope_failures;
                if (!Array.isArray(failures)) continue;
                if (inspectTaskEventFile(timeline, taskId).status !== 'PASS') throw new Error('Recorded out-of-scope failures have invalid task timeline integrity.');
                for (const value of failures) {
                    if (!isPlainRecord(value) || value.task_id !== taskId || !isPlainRecord(value.artifact)
                        || typeof value.failure_event_sha256 !== 'string' || typeof value.command !== 'string'
                        || !Array.isArray(value.failing_tests)
                        || (!value.failing_tests.length && value.attribution !== 'not attributed')
                        || (value.attribution !== undefined && value.attribution !== (value.failing_tests.length ? 'attributed' : 'not attributed'))
                        || !value.failing_tests.every(ref => typeof ref === 'string')) throw new Error('Invalid recorded out-of-scope failure.');
                    const failure = entries.find(item => stringSha256(item.rawLine.trim()) === value.failure_event_sha256);
                    const source = failure?.record?.details;
                    const optionalRefs = isPlainRecord(source) ? source.out_of_scope_failure_refs ?? value.artifact.out_of_scope_failure_refs : null;
                    const cycle = [...entries.slice(0, failure ? entries.indexOf(failure) : 0)].reverse()
                        .find(item => item.record?.event_type === 'TASK_MODE_ENTERED');
                    if (!cycle || stringSha256(cycle.rawLine.trim()) !== value.task_mode_entry_sha256
                        || failure?.record?.event_type !== 'FULL_SUITE_VALIDATION_FAILED'
                        || failure.record.actor !== 'gate' || failure.record.outcome !== 'FAIL' || !isPlainRecord(source)
                        || value.artifact.status !== 'FAILED' || !isDeepStrictEqual(source.cycle_binding, value.artifact.cycle_binding)
                        || source.command !== value.command || value.artifact.command !== value.command
                        || source.artifact_sha256 !== value.artifact_sha256 || source.artifact_path !== value.artifact_path
                        || !isDeepStrictEqual(Array.isArray(optionalRefs)
                            ? optionalRefs.filter(ref => typeof ref === 'string') : [], value.failing_tests)
                        || stringSha256(JSON.stringify(value.artifact, null, 2) + '\n') !== value.artifact_sha256) {
                        throw new Error('Recorded out-of-scope failure is not bound to its authenticated task cycle and full-suite artifact.');
                    }
                    recorded.set(value.failure_event_sha256, value as unknown as RecordedOutOfScopeFailure);
                }
            }
            return [...recorded.values()];
        });
    }).value;
}

export function recordedOutOfScopeNotice(repoRoot: string, taskId: string): string {
    const records = readRecordedOutOfScopeFailures(repoRoot, taskId);
    return records.length ? `Task completed with recorded out-of-scope failures: ${[...new Set(records.flatMap(record =>
        record.failing_tests.length ? record.failing_tests : [`not attributed (command: ${record.command}; artifact: ${record.artifact_path})`]))].join(', ')}. See the recorded failure follow-up task and its authenticated full-suite evidence.` : '';
}

