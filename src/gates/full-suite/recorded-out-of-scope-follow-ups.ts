import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildTaskValidationPlan, parseTaskValidationDeclaration, taskValidationLiteralAssociation,
    type TaskValidationDeclaration, type TaskValidationPlan } from '../../core/task-validation-plan';
import { readValidationFile } from '../../core/project-validation-identity';
import { inspectValidationCommand } from '../../core/validation-command-contract';
import { allocateNextParentDerivedTaskId } from '../../core/task-id-allocation';
import { assertCanonicalTaskId, isCanonicalTaskId } from '../../core/task-ids';
import { formatActiveTaskQueueTable, parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import { withTaskQueueTransaction, writeTaskQueueFile } from '../../core/task-queue/task-queue-repository';
import { joinOrchestratorPath, normalizePath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { readInvocationFileContent } from '../../core/invocation-file-observation';
import { appendMandatoryTaskEvent, inspectTaskEventFile, isAuthenticatedTaskHistoryStatus, readTaskTimelineJsonlEntries,
    signedTaskHistoryEntries, withTaskTimelineReadSnapshot } from '../../gate-runtime/task-events';
import { readRecordedOutOfScopeFailures, recordedFailureAttributionText, recordedFailureTestNames, type RecordedOutOfScopeFailure } from './recorded-out-of-scope-failures';

const EVENT = 'OUT_OF_SCOPE_FOLLOW_UP_MATERIALIZED';
const marker = (taskId: string, failure: RecordedOutOfScopeFailure) =>
    `out_of_scope_parent=${taskId} out_of_scope_failure=${failure.failure_event_sha256}`;
const GROUPED_TYPE = 'out_of_scope_follow_up=grouped';

const tableText = (text: string) => text.replace(/[\r\n|]/gu, ' ');
function failureDescription(taskId: string, record: RecordedOutOfScopeFailure, legacy = false): string {
    const attribution = legacy
        ? (record.failing_tests.length ? `Failing tests: ${record.failing_tests.join(', ')}` : 'Tests: not attributed')
        : recordedFailureAttributionText(record.failing_tests);
    const tests = recordedFailureTestNames(record.artifact, record.failing_tests);
    return tableText(`${marker(taskId, record)}; Failed command: ${record.command}; Artifact: ${record.artifact_path} (sha256 ${record.artifact_sha256}); ${attribution}`
        + (tests.length ? `; Failing tests: ${tests.join(', ')}` : ''));
}

function isGroupedFollowUp(taskId: string, row: { taskId: string; notes: string | null }): boolean {
    return isCanonicalTaskId(row.taskId) && row.taskId !== taskId
        && row.taskId.startsWith(`${taskId}-`) && /^[1-9][0-9]*$/u.test(row.taskId.slice(taskId.length + 1))
        && !!row.notes?.includes(`Child of \`${taskId}\`.`)
        && /(?:^|[\s;])out_of_scope_follow_up=grouped(?:[\s;.]|$)/u.test(row.notes);
}

export interface RecordedFailureRecheck {
    command: string;
    targets: string[];
    declaration?: TaskValidationDeclaration;
}

export function matchesRecordedFailureRecheck(plan: TaskValidationPlan | undefined, recheck: RecordedFailureRecheck): boolean {
    const declaration = recheck.declaration;
    if (!declaration) return true;
    return !!plan && (declaration.targets ?? []).every(claim => plan.targets.some(target =>
        target.path === claim.path && target.invocation === claim.invocation && target.reason === claim.reason
        && target.association === (claim.entrypoint ? 'symbolic' : 'literal') && target.selector === (claim.entrypoint ?? claim.selector)))
        && (declaration.support ?? []).every(claim => plan.support.some(item => item.path === claim.path
            && item.role === claim.role && isDeepStrictEqual([...item.targets].sort(), [...claim.targets].sort())));
}

function recoverRecheckPlan(repoRoot: string, records: RecordedOutOfScopeFailure[]): RecordedFailureRecheck | null {
    const command = records[0].command;
    const descriptor = inspectValidationCommand(command, 'test', { allowConjunction: true }).descriptor;
    if (!descriptor) return null;
    const targets = new Set<string>();
    const targetClaims = new Map<string, NonNullable<TaskValidationDeclaration['targets']>[number]>();
    const support = new Map<string, NonNullable<TaskValidationDeclaration['support']>[number]>();
    for (const record of records) {
        const plan = record.artifact.task_test_validation_plan;
        if (!isPlainRecord(plan) || plan.schema_version !== 1 || !isDeepStrictEqual(plan.descriptor, descriptor)
            || !Array.isArray(plan.targets) || !Array.isArray(plan.support)) return null;
        for (const target of plan.targets) {
            if (!isPlainRecord(target) || typeof target.path !== 'string' || typeof target.selector !== 'string'
                || typeof target.invocation !== 'number' || !['literal', 'symbolic'].includes(String(target.association))) return null;
            const claim = { path: target.path, invocation: target.invocation,
                ...(typeof target.reason === 'string' ? { reason: target.reason } : {}),
                ...(target.association === 'symbolic' ? { entrypoint: target.selector } : { selector: target.selector }) };
            const key = JSON.stringify([target.path, target.invocation]);
            if (targetClaims.has(key) && !isDeepStrictEqual(targetClaims.get(key), claim)) return null;
            targets.add(target.path);
            targetClaims.set(key, claim);
        }
        for (const item of plan.support) {
            if (!isPlainRecord(item) || typeof item.path !== 'string' || !Array.isArray(item.targets)) return null;
            const claim = { path: item.path, role: item.role as NonNullable<TaskValidationDeclaration['support']>[number]['role'],
                targets: [...item.targets].sort() };
            if (support.has(item.path) && !isDeepStrictEqual(support.get(item.path), claim)) return null;
            support.set(item.path, claim);
        }
    }
    try {
        const declarations = [...targetClaims.values()];
        const fullDeclaration = { targets: declarations, ...(support.size ? { support: [...support.values()] } : {}) };
        const sources = [...targets, ...support.keys()].map(file => readValidationFile(repoRoot, file).identity);
        const rebuilt = buildTaskValidationPlan(command, sources, fullDeclaration);
        if (rebuilt.targets.length !== targetClaims.size || [...support.keys()].some(file => targets.has(file))) return null;
        const explicitPaths = new Set([...targets].filter(file => {
            const retained = declarations.filter(claim => claim.path === file);
            const inferred = descriptor.invocations.flatMap((invocation, index) => {
                const selector = taskValidationLiteralAssociation([invocation.executable, ...invocation.argv], file);
                return selector ? [{ path: file, invocation: index, selector }] : [];
            });
            return !isDeepStrictEqual(retained.sort((a, b) => a.invocation! - b.invocation!), inferred);
        }));
        const explicitTargets = declarations.filter(claim => explicitPaths.has(claim.path));
        const declaration = explicitTargets.length || support.size
            ? { ...(explicitTargets.length ? { targets: explicitTargets } : {}), ...('support' in fullDeclaration ? { support: fullDeclaration.support } : {}) } : undefined;
        return { command, targets: [...targets], ...(declaration ? { declaration } : {}) };
    } catch {
        return null;
    }
}

/** Recover the exact test command and associations from the parent's authenticated handoff. */
export function readRecordedFailureRecheck(repoRoot: string, taskId: string): RecordedFailureRecheck | null {
    const parent = taskId.replace(/-[1-9][0-9]*$/u, '');
    if (parent === taskId || !isCanonicalTaskId(parent)) return null;
    const taskPath = path.join(repoRoot, 'TASK.md');
    const observed = readInvocationFileContent(taskPath);
    const queue = parseCanonicalActiveTaskQueue(observed?.copyBytes().toString('utf8') ?? fs.readFileSync(taskPath, 'utf8'));
    const row = queue.rows.find(item => item.taskId === taskId);
    if (!queue.found || queue.diagnostics?.length || !row || !isGroupedFollowUp(parent, row)) return null;
    const eventsRoot = joinOrchestratorPath(repoRoot, 'runtime/task-events');
    const timeline = path.join(eventsRoot, parent + '.jsonl');
    return withTaskTimelineReadSnapshot(eventsRoot, parent, () => {
        if (!isAuthenticatedTaskHistoryStatus(inspectTaskEventFile(timeline, parent).status)) return null;
        const hashes = new Set(signedTaskHistoryEntries(readTaskTimelineJsonlEntries(timeline)).flatMap(({ record }) => {
            if (record?.event_type !== EVENT || record.actor !== 'gate' || record.outcome !== 'PASS'
                || !isPlainRecord(record.details) || !Array.isArray(record.details.bindings)) return [];
            return record.details.bindings.flatMap(binding => isPlainRecord(binding) && binding.task_id === taskId
                && typeof binding.failure_event_sha256 === 'string' ? [binding.failure_event_sha256] : []);
        }));
        if (!hashes.size) return null;
        const records = readRecordedOutOfScopeFailures(repoRoot, parent).filter(record =>
            hashes.has(record.failure_event_sha256) && row.notes.includes(marker(parent, record))
            && queue.rows.filter(item => item.notes.includes(marker(parent, record))).length === 1);
        if (!records.length || records.length !== hashes.size || new Set(records.map(record => record.command)).size !== 1) return null;
        return recoverRecheckPlan(repoRoot, records);
    });
}

/** Read the binding only after authenticating the preflight that published it. */
export function readPreflightRecordedFailureRecheck(preflight: Record<string, unknown>): RecordedFailureRecheck | null {
    const binding = preflight.recorded_failure_recheck;
    if (!isPlainRecord(binding) || typeof binding.command !== 'string' || !binding.command
        || !Array.isArray(binding.targets) || !binding.targets.length
        || !binding.targets.every(target => typeof target === 'string' && target)) return null;
    try {
        const declaration = binding.declaration === undefined ? undefined : parseTaskValidationDeclaration(binding.declaration);
        return { command: binding.command, targets: binding.targets as string[], ...(declaration ? { declaration } : {}) };
    } catch {
        return null;
    }
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
