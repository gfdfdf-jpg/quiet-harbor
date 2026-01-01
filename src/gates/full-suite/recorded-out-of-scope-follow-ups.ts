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
import { readRecordedOutOfScopeFailures, type RecordedOutOfScopeFailure } from './recorded-out-of-scope-failures';

const EVENT = 'OUT_OF_SCOPE_FOLLOW_UP_MATERIALIZED';
const marker = (taskId: string, failure: RecordedOutOfScopeFailure) =>
    `out_of_scope_parent=${taskId} out_of_scope_failure=${failure.failure_event_sha256}`;
const GROUPED_TYPE = 'out_of_scope_follow_up=grouped';

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
        const lines = content.split(/\r?\n/u);
        const bindings: Array<{ failure_event_sha256: string; task_id: string }> = [];
        const claims = records.map(record => ({ record, rows: queue.rows.filter(row => row.notes.includes(marker(taskId, record))) }));
        if (claims.some(({ rows }) => rows.length > 1 || (rows.length === 1 && !isGroupedFollowUp(taskId, rows[0])))) {
            return { outputLines: [`Invalid or ambiguous recorded out-of-scope follow-up binding; retain the marker only on a distinct grouped child task. ${followUpRoute(taskId)}`], exitCode: 1 };
        }
        const missing = claims.filter(({ rows }) => !rows.length).map(({ record }) => record);
        for (const { record, rows } of claims) {
            if (rows.length) bindings.push({ failure_event_sha256: record.failure_event_sha256, task_id: rows[0].taskId });
        }
        if (missing.length) {
            // A normal task ID keeps this evidence separate from reviewer -F provenance.
            const child = allocateNextParentDerivedTaskId({ parentTaskId: taskId, kind: 'child', existingTaskIds: queue.rows.map(row => row.taskId) });
            const notes = `Child of \`${taskId}\`. ${GROUPED_TYPE}; `
                + missing.map(record => `${marker(taskId, record)}; Failing tests: ${record.failing_tests.join(', ').replace(/[\r\n|]/gu, ' ')}`).join('; ');
            const evidence = normalizePath(path.relative(repoRoot, joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`)));
            const row = `| ${child} | TODO | P1 | tests | Resolve recorded out-of-scope test failures | unassigned | ${new Date().toISOString().slice(0, 10)} | ${parent.profile} | ${notes}; Evidence: ${evidence} (authenticated selection records retain commands, failing tests and full-suite artifacts). |`;
            lines.splice(queue.rows.at(-1)!.lineIndex + 1, 0, row);
            writeTaskQueueFile(taskPath, formatActiveTaskQueueTable(lines.join('\n')));
            bindings.push(...missing.map(record => ({ failure_event_sha256: record.failure_event_sha256, task_id: child })));
        }
        appendMandatoryTaskEvent(joinOrchestratorPath(repoRoot, ''), taskId, EVENT, 'PASS',
            'Recorded out-of-scope failures have follow-up tasks independent of review policy.', { bindings }, { actor: 'gate' });
        const violations = recordedOutOfScopeFollowUpViolations(repoRoot, taskId, true);
        return { outputLines: violations.length ? violations : [`RECORDED_OUT_OF_SCOPE_FOLLOW_UP_MATERIALIZED ${[...new Set(bindings.map(binding => binding.task_id))].join(', ')}`],
            exitCode: violations.length ? 1 : 0 };
    });
}
