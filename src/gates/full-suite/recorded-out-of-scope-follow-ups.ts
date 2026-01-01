import * as fs from 'node:fs';
import * as path from 'node:path';
import { allocateNextParentDerivedTaskId } from '../../core/task-id-allocation';
import { assertCanonicalTaskId, isCanonicalTaskId } from '../../core/task-ids';
import { formatActiveTaskQueueTable, parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import { withTaskQueueTransaction, writeTaskQueueFile } from '../../core/task-queue/task-queue-repository';
import { joinOrchestratorPath, normalizePath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { readInvocationFileContent } from '../../core/invocation-file-observation';
import { appendMandatoryTaskEvent, readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { readRecordedOutOfScopeFailures, recordedFailureAttributionText, type RecordedOutOfScopeFailure } from './recorded-out-of-scope-failures';

const EVENT = 'OUT_OF_SCOPE_FOLLOW_UP_MATERIALIZED';
const marker = (taskId: string, failure: RecordedOutOfScopeFailure) =>
    `out_of_scope_parent=${taskId} out_of_scope_failure=${failure.failure_event_sha256}`;
const GROUPED_TYPE = 'out_of_scope_follow_up=grouped';

const tableText = (text: string) => text.replace(/[\r\n|]/gu, ' ');
function failureDescription(taskId: string, record: RecordedOutOfScopeFailure, legacy = false): string {
    const attribution = legacy
        ? (record.failing_tests.length ? `Failing tests: ${record.failing_tests.join(', ')}` : 'Tests: not attributed')
        : recordedFailureAttributionText(record.failing_tests);
    return tableText(`${marker(taskId, record)}; Failed command: ${record.command}; Artifact: ${record.artifact_path} (sha256 ${record.artifact_sha256}); ${attribution}`);
}

function isGroupedFollowUp(taskId: string, row: { taskId: string; notes: string | null }): boolean {
    return isCanonicalTaskId(row.taskId) && row.taskId !== taskId
        && row.taskId.startsWith(`${taskId}-`) && /^[1-9][0-9]*$/u.test(row.taskId.slice(taskId.length + 1))
        && !!row.notes?.includes(`Child of \`${taskId}\`.`)
        && /(?:^|[\s;])out_of_scope_follow_up=grouped(?:[\s;.]|$)/u.test(row.notes);
}

const followUpRoute = (taskId: string) =>
    `Run gate materialize-review-follow-up-tasks --task-id "${taskId}" --review-type recorded-out-of-scope --repo-root ".".`;

/** These obligations are authenticated test-run evidence, independent of review lanes and their policy. */
export function recordedOutOfScopeFollowUpViolations(repoRoot: string, taskId: string, afterWrite = false): string[] {
    const records = readRecordedOutOfScopeFailures(repoRoot, taskId);
    if (!records.length) return [];
    const entries = readTaskTimelineJsonlEntries(joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`));
    const taskPath = path.join(repoRoot, 'TASK.md');
    // Retain canonical diagnostics: a map would silently collapse duplicate task IDs.
    // next-step already observed TASK.md, so this reuses its bytes without native probes.
    const observed = afterWrite ? null : readInvocationFileContent(taskPath);
    const queue = parseCanonicalActiveTaskQueue(observed?.copyBytes().toString('utf8') ?? fs.readFileSync(taskPath, 'utf8'));
    return records.flatMap(record => {
        const bound = entries.some(entry => {
            const details = entry.record?.details;
            if (entry.record?.event_type !== EVENT || entry.record.actor !== 'gate' || entry.record.outcome !== 'PASS'
                || !isPlainRecord(details) || !Array.isArray(details.bindings)) return false;
            const rows = queue.rows.filter(row => row.notes?.includes(marker(taskId, record)));
            return rows.length === 1 && isGroupedFollowUp(taskId, rows[0])
                && details.bindings.some(binding => isPlainRecord(binding)
                    && binding.failure_event_sha256 === record.failure_event_sha256 && binding.task_id === rows[0].taskId);
        });
        return bound && queue.found && !queue.diagnostics?.length ? []
            : [`Recorded out-of-scope failure ${record.failure_event_sha256} requires its authenticated distinct grouped child follow-up row. ${followUpRoute(taskId)}`];
    });
}

export function materializeRecordedOutOfScopeFollowUps(repoRoot: string, taskId: string): { outputLines: string[]; exitCode: number } {
    assertCanonicalTaskId(taskId);
    const records = readRecordedOutOfScopeFailures(repoRoot, taskId);
    if (!records.length) return { outputLines: ['RECORDED_OUT_OF_SCOPE_FOLLOW_UP_NOT_REQUIRED'], exitCode: 0 };
    const taskPath = path.join(repoRoot, 'TASK.md');
    return withTaskQueueTransaction(taskPath, message => ({ outputLines: [message], exitCode: 1 }), () => {
        const content = fs.readFileSync(taskPath, 'utf8');
        const queue = parseCanonicalActiveTaskQueue(content);
        const parent = queue.rows.find(row => row.taskId === taskId);
        if (!queue.found || queue.diagnostics?.length || !parent) {
            return { outputLines: [`Canonical follow-up parent queue is missing or ambiguous; repair TASK.md. ${followUpRoute(taskId)}`], exitCode: 1 };
        }
        const lines = content.split('\n');
        const bindings: Array<{ failure_event_sha256: string; task_id: string }> = [];
        const claims = records.map(record => ({ record, rows: queue.rows.filter(row => row.notes.includes(marker(taskId, record))) }));
        if (claims.some(({ rows }) => rows.length > 1 || (rows.length === 1 && !isGroupedFollowUp(taskId, rows[0])))) {
            return { outputLines: [`Invalid or ambiguous recorded out-of-scope follow-up binding; retain the marker only on a distinct grouped child task. ${followUpRoute(taskId)}`], exitCode: 1 };
        }
        const refreshed = new Set<string>();
        const warnings: string[] = [];
        const missing = claims.filter(({ rows }) => !rows.length).map(({ record }) => record);
        for (const { record, rows } of claims) {
            if (!rows.length) continue;
            const row = rows[0];
            bindings.push({ failure_event_sha256: record.failure_event_sha256, task_id: row.taskId });
            const legacy = failureDescription(taskId, record, true);
            const current = failureDescription(taskId, record);
            if (legacy === current || row.notes.includes(current)) continue;
            const line = lines[row.lineIndex];
            const at = line.indexOf(legacy);
            const suffix = at < 0 ? '' : line.slice(at + legacy.length);
            // Replace only an exact owned segment at its original generated boundary.
            // Edited/ambiguous text remains operator-owned; do not rebuild the row.
            if (at >= 0 && line.indexOf(legacy, at + 1) < 0
                && /^(?:; Evidence: |; out_of_scope_parent=)/u.test(suffix)) {
                lines[row.lineIndex] = line.slice(0, at) + current + suffix;
                refreshed.add(row.taskId);
            } else if (row.notes.includes('Failing tests:')) {
                warnings.push(`WARNING: ${row.taskId}: legacy failure description was edited or is unrecognized; kept unchanged. Original references are diagnostic, not confirmed failing tests; inspect the authenticated artifact.`);
            }
        }
        if (missing.length) {
            // A normal task ID keeps this evidence separate from reviewer -F provenance.
            const child = allocateNextParentDerivedTaskId({ parentTaskId: taskId, kind: 'child', existingTaskIds: queue.rows.map(row => row.taskId) });
            const notes = `Child of \`${taskId}\`. ${GROUPED_TYPE}; `
                + missing.map(record => failureDescription(taskId, record)).join('; ');
            const evidence = normalizePath(path.relative(repoRoot, joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`)));
            const row = `| ${child} | TODO | P1 | tests | Resolve recorded out-of-scope test failures | unassigned | ${new Date().toISOString().slice(0, 10)} | ${parent.profile} | ${notes}; Evidence: ${evidence} (authenticated selection records retain commands, failing tests and full-suite artifacts). |`;
            lines.splice(queue.rows.at(-1)!.lineIndex + 1, 0, row);
            bindings.push(...missing.map(record => ({ failure_event_sha256: record.failure_event_sha256, task_id: child })));
        }
        if (missing.length || refreshed.size) {
            writeTaskQueueFile(taskPath, missing.length ? formatActiveTaskQueueTable(lines.join('\n'))
                : lines.join('\n'));
        }
        appendMandatoryTaskEvent(joinOrchestratorPath(repoRoot, ''), taskId, EVENT, 'PASS',
            'Recorded out-of-scope failures have follow-up tasks independent of review policy.', { bindings, presentation_refreshed_task_ids: [...refreshed] }, { actor: 'gate' });
        const violations = recordedOutOfScopeFollowUpViolations(repoRoot, taskId, true);
        return { outputLines: violations.length ? violations : [`RECORDED_OUT_OF_SCOPE_FOLLOW_UP_MATERIALIZED ${[...new Set(bindings.map(binding => binding.task_id))].join(', ')}`, ...warnings],
            exitCode: violations.length ? 1 : 0 };
    });
}
