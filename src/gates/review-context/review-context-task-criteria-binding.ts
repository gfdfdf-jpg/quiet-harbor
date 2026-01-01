import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloneFrozenJson } from '../../core/immutable-json';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { createInvocationReadMemoKey, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { parseTaskMdTableRow } from '../../core/task-md-table';
import { stringSha256 } from '../../gate-runtime/hash';
import { readReviewTaskCard } from './review-context-task-card';
import { listTaskOperatorDecisionLines } from './review-context-task-decisions';
import { taskCriteriaNotes } from './review-context-workflow-notes';
import { readReviewValidationBytes } from './review-validation-invocation';
import { getTaskModeEvidence } from '../task-mode/task-mode';
import { isPathRealpathInsideRoot, normalizePath } from '../shared/helpers';
import { normalizeTaskCriteriaText, taskIntentSha256, readOperatorTaskIntent, type OperatorTaskIntent } from './review-context-task-intent';
export { normalizeTaskCriteriaText, taskIntentSha256 } from './review-context-task-intent';
import { assessTrustBoundaryAnalysisApplicability } from '../../core/trust-boundary-analysis';

/**
 * The task criteria a review was judged against: the task's own TASK.md row text (title and notes, every
 * row with the task id), the attached plan, the whole task-card section the
 * row links (the reviewer is given that section, whatever form its criteria take) and this task's own
 * operator-decision entries in TASK.md. Status, owner, dates, other tasks' rows and decisions are workflow
 * bookkeeping, not criteria. Authenticated follow-up and repair-handoff notes written by Garda are also
 * bookkeeping. Text keeps its case, indentation, line structure and internal whitespace; only line endings
 * and trailing horizontal whitespace are normalized.
 */
export interface TaskCriteriaBinding {
    schema: typeof TASK_CRITERIA_BINDING_SCHEMA;
    task_id: string;
    task_rows: Array<{ title: string; notes: string }>;
    task_intent: string;
    /** Audits wording independently of the criteria digest; old review evidence is never rewritten. */
    task_intent_sha256: string;
    /** Only an authenticated operator-confirmed change makes intent a task criterion. */
    operator_task_intent: OperatorTaskIntent | null;
    /** Scope-derived obligations remain criteria independently of agent descriptions and lane policy. */
    scope_review_requirements: { security: boolean; api: boolean; performance: boolean; refactor: boolean; trust_boundary_analysis: boolean };
    task_plan: { path: string; declared_sha256: string; content_sha256: string | null } | null;
    /** The linked task-card section: its path and the sha256 of its whitespace-normalized text. */
    task_card: { path: string; section_sha256: string } | null;
    /** This task's operator-decision lines, whitespace-normalized, in TASK.md order. */
    task_operator_decisions: Array<{ text: string; in_section: boolean }>;
    sha256: string;
}

// Older bindings did not distinguish operator criteria from agent descriptions.
export const TASK_CRITERIA_BINDING_SCHEMA = 'garda.task-criteria-binding.v5';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function digestTaskCriteria(binding: Omit<TaskCriteriaBinding, 'sha256'>): string {
    return stringSha256(JSON.stringify([
        binding.schema, binding.task_id, binding.task_rows.map((row) => [row.title, row.notes]),
        binding.operator_task_intent, binding.scope_review_requirements, binding.task_plan,
        binding.task_card ? [binding.task_card.path, binding.task_card.section_sha256] : null,
        binding.task_operator_decisions.map((entry) => [entry.text, entry.in_section])
    ]))!;
}

/** Lane policy and explanatory intent cannot invalidate another lane's accepted review.
 * Operator intent is bound separately; its classification obligations must not enter this scope-only projection.
 */
function scopeReviewRequirements(preflight?: Record<string, unknown> | null): TaskCriteriaBinding['scope_review_requirements'] {
    const triggers = isRecord(preflight?.triggers) ? preflight.triggers : {};
    const scope = isRecord(preflight?.scope_review_requirements) ? preflight.scope_review_requirements : triggers;
    const security = scope.security === true || triggers.protected_control_plane_changed === true;
    return {
        security,
        api: scope.api === true,
        performance: scope.performance === true,
        refactor: scope.refactor === true,
        trust_boundary_analysis: assessTrustBoundaryAnalysisApplicability({ ...preflight,
            triggers: { ...triggers, security, security_intent: false } }).required
    };
}

function readTaskPlanBinding(repoRoot: string, taskId: string): TaskCriteriaBinding['task_plan'] {
    const plan = taskId ? getTaskModeEvidence(repoRoot, taskId).plan : null;
    if (!plan) return null;
    const planPath = path.resolve(repoRoot, plan.plan_path);
    if (!isPathRealpathInsideRoot(planPath, repoRoot, { allowMissing: true })) throw new Error('Task plan escapes the repository root.');
    let contentSha256: string | null = null;
    try { contentSha256 = stringSha256(normalizeTaskCriteriaText(readReviewValidationBytes(planPath).toString('utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    return { path: normalizePath(path.relative(repoRoot, planPath)), declared_sha256: plan.plan_sha256, content_sha256: contentSha256 };
}

/** The original classified text is needed when classifying the restart again. */
function readPreflightTaskIntent(preflight: Record<string, unknown> | null | undefined): string {
    const snapshot = isRecord(preflight?.effective_review_snapshot) ? preflight.effective_review_snapshot : null;
    const inputs = isRecord(snapshot?.inputs) ? snapshot.inputs : null;
    return String(inputs?.task_intent ?? preflight?.task_intent ?? preflight?.taskIntent ?? '');
}

/** The latest classified wording, also used by restart commands and reviewer handoffs. */
export function resolvePreflightTaskIntent(preflight: Record<string, unknown> | null | undefined): string {
    return normalizeTaskCriteriaText(readPreflightTaskIntent(preflight));
}

/**
 * Preserve the intent of the existing preflight on restart. The task title and summary are fallbacks for
 * cases without a readable classified intent; neither may replace an intent already used by the reviews.
 */
export function resolveRestartTaskIntent(options: {
    repoRoot: string;
    taskId: string;
    preflight?: Record<string, unknown> | null;
    taskMode?: { task_summary?: unknown } | null;
}): string {
    const classifiedIntent = readPreflightTaskIntent(options.preflight);
    if (classifiedIntent.trim()) return classifiedIntent;
    let title = '';
    try {
        title = String(readTaskQueueEntries(options.repoRoot).get(options.taskId)?.title || '').trim();
    } catch {
        title = '';
    }
    return title || String(options.taskMode?.task_summary || '').trim();
}

/** `resolveRestartTaskIntent` for a preflight known by path; an unreadable preflight is skipped. */
export function resolveRestartTaskIntentFromPreflightPath(repoRoot: string, taskId: string, preflightPath: string | null | undefined,
    taskMode?: { task_summary?: unknown } | null): string {
    let preflight: Record<string, unknown> | null = null;
    try {
        const parsed: unknown = preflightPath ? JSON.parse(fs.readFileSync(path.resolve(repoRoot, preflightPath), 'utf8')) : null;
        preflight = isRecord(parsed) ? parsed : null;
    } catch {
        preflight = null;
    }
    return resolveRestartTaskIntent({ repoRoot, taskId, preflight, taskMode });
}

function readTaskQueueText(repoRoot: string): string | null {
    try {
        return readReviewValidationBytes(path.join(repoRoot, TASK_QUEUE_FILENAME)).toString('utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw error;
    }
}

function readTaskCriteriaRows(repoRoot: string, text: string, taskId: string): TaskCriteriaBinding['task_rows'] {
    return text.split(/\r\n?|\n/u)
        .map((line) => parseTaskMdTableRow(line))
        .filter((cells) => cells.length >= 9 && cells[0].trimmed === taskId)
        .map((cells) => ({ title: normalizeTaskCriteriaText(cells[4].trimmed),
            notes: normalizeTaskCriteriaText(taskCriteriaNotes(repoRoot, taskId, cells[8].trimmed)) }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

type TaskCriteriaSources = Pick<TaskCriteriaBinding, 'task_rows' | 'task_card' | 'task_operator_decisions'>;
const TASK_CRITERIA_SOURCES = createInvocationReadMemoKey<TaskCriteriaSources>('task-criteria-sources-v3');

/** TASK.md rows and decisions and the linked task-card section, read once per observed invocation. */
function readTaskCriteriaSources(repoRoot: string, taskId: string): TaskCriteriaSources {
    const sources = memoizeInvocationRead(TASK_CRITERIA_SOURCES, JSON.stringify([path.resolve(repoRoot), taskId]), () => {
        const queueText = taskId ? readTaskQueueText(repoRoot) : null;
        const card = readReviewTaskCard(repoRoot, taskId || null);
        return cloneFrozenJson({
            task_rows: queueText === null ? [] : readTaskCriteriaRows(repoRoot, queueText, taskId),
            task_card: card ? { path: card.path, section_sha256: stringSha256(normalizeTaskCriteriaText(card.section))! } : null,
            task_operator_decisions: queueText === null ? [] : listTaskOperatorDecisionLines(queueText.replace(/\r\n?/gu, '\n'), taskId)
                .map((entry) => ({ text: normalizeTaskCriteriaText(entry.line), in_section: entry.in_section }))
        });
    }).value;
    return {
        task_rows: sources.task_rows.map((row) => ({ title: row.title, notes: row.notes })),
        task_card: sources.task_card ? { path: sources.task_card.path, section_sha256: sources.task_card.section_sha256 } : null,
        task_operator_decisions: sources.task_operator_decisions.map((entry) => ({ text: entry.text, in_section: entry.in_section }))
    };
}

/** Reads the current task criteria. An ambiguous or unsafe task-card link throws, as the review-context reader does. */
export function computeTaskCriteriaBinding(options: {
    repoRoot: string;
    taskId: string;
    preflight: Record<string, unknown> | null | undefined;
}): TaskCriteriaBinding {
    const taskId = String(options.taskId || '').trim();
    const sources = readTaskCriteriaSources(options.repoRoot, taskId);
    const taskIntent = resolvePreflightTaskIntent(options.preflight);
    const taskPlan = readTaskPlanBinding(options.repoRoot, taskId);
    const unsigned: Omit<TaskCriteriaBinding, 'sha256'> = {
        schema: TASK_CRITERIA_BINDING_SCHEMA,
        task_id: taskId,
        task_rows: sources.task_rows,
        task_intent: taskIntent,
        task_intent_sha256: taskIntentSha256(taskId, taskIntent),
        operator_task_intent: readOperatorTaskIntent(options.repoRoot, taskId),
        scope_review_requirements: scopeReviewRequirements(options.preflight),
        task_plan: taskPlan,
        task_card: sources.task_card,
        task_operator_decisions: sources.task_operator_decisions
    };
    return { ...unsigned, sha256: digestTaskCriteria(unsigned) };
}

/** A recorded binding whose digest matches its own fields, or null for a missing, older-schema or altered one. */
export function readTaskCriteriaBinding(value: unknown): TaskCriteriaBinding | null {
    if (!isRecord(value) || value.schema !== TASK_CRITERIA_BINDING_SCHEMA || typeof value.task_id !== 'string'
        || typeof value.task_intent !== 'string' || value.task_intent_sha256 !== taskIntentSha256(value.task_id, value.task_intent)
        || (value.operator_task_intent !== null && (!isRecord(value.operator_task_intent)
            || typeof value.operator_task_intent.task_intent !== 'string'
            || value.operator_task_intent.task_intent_sha256 !== taskIntentSha256(value.task_id, value.operator_task_intent.task_intent)
            || !/^[a-f0-9]{64}$/u.test(String(value.operator_task_intent.event_sha256 || ''))))
        || !isRecord(value.scope_review_requirements)
        || !['security', 'api', 'performance', 'refactor', 'trust_boundary_analysis']
            .every(key => typeof (value.scope_review_requirements as Record<string, unknown>)[key] === 'boolean')
        || !Array.isArray(value.task_rows)
        || !Array.isArray(value.task_operator_decisions) || typeof value.sha256 !== 'string') return null;
    const rows = value.task_rows.map((row) => isRecord(row) && typeof row.title === 'string' && typeof row.notes === 'string'
        ? { title: row.title, notes: row.notes } : null);
    const decisions = value.task_operator_decisions.map((entry) => isRecord(entry) && typeof entry.text === 'string'
        && typeof entry.in_section === 'boolean' ? { text: entry.text, in_section: entry.in_section } : null);
    const card = value.task_card === null ? null
        : isRecord(value.task_card) && typeof value.task_card.path === 'string' && typeof value.task_card.section_sha256 === 'string'
            ? { path: value.task_card.path, section_sha256: value.task_card.section_sha256 } : undefined;
    const plan = value.task_plan === null ? null
        : isRecord(value.task_plan) && typeof value.task_plan.path === 'string' && typeof value.task_plan.declared_sha256 === 'string'
            && (value.task_plan.content_sha256 === null || typeof value.task_plan.content_sha256 === 'string')
            ? { path: value.task_plan.path, declared_sha256: value.task_plan.declared_sha256, content_sha256: value.task_plan.content_sha256 } : undefined;
    if (rows.some((row) => !row) || decisions.some((entry) => !entry) || card === undefined || plan === undefined) return null;
    const unsigned: Omit<TaskCriteriaBinding, 'sha256'> = {
        schema: TASK_CRITERIA_BINDING_SCHEMA, task_id: value.task_id, task_intent: value.task_intent,
        task_intent_sha256: value.task_intent_sha256 as string, operator_task_intent: value.operator_task_intent as OperatorTaskIntent | null,
        scope_review_requirements: value.scope_review_requirements as TaskCriteriaBinding['scope_review_requirements'], task_plan: plan,
        task_rows: rows as TaskCriteriaBinding['task_rows'], task_card: card,
        task_operator_decisions: decisions as TaskCriteriaBinding['task_operator_decisions']
    };
    return digestTaskCriteria(unsigned) === value.sha256.toLowerCase() ? { ...unsigned, sha256: value.sha256.toLowerCase() } : null;
}

/**
 * The one notion of "task criteria changed" (operator rule: every review repeats in FULL). Fails closed: a
 * missing, unreadable or altered binding on either side counts as a change.
 */
export function hasTaskCriteriaChanged(recorded: unknown, current: unknown): boolean {
    const before = readTaskCriteriaBinding(recorded);
    const after = readTaskCriteriaBinding(current);
    return !before || !after || before.task_id !== after.task_id || before.sha256 !== after.sha256;
}

/** Contexts written since task-card criteria joined the review context must carry the criteria binding. */
export function reviewContextRequiresTaskCriteriaBinding(reviewContext: Record<string, unknown>): boolean {
    return reviewContext.task_criteria_binding !== undefined
        || (isRecord(reviewContext.task_criteria) && 'task_card' in reviewContext.task_criteria);
}

export function getReviewContextTaskCriteriaViolation(options: {
    reviewContext: Record<string, unknown>;
    repoRoot: string;
    taskId: string;
    preflight: Record<string, unknown> | null | undefined;
}): string | null {
    if (!reviewContextRequiresTaskCriteriaBinding(options.reviewContext)) return null;
    let current: TaskCriteriaBinding;
    try {
        current = computeTaskCriteriaBinding(options);
    } catch (error) {
        return `Task criteria for '${options.taskId}' cannot be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!hasTaskCriteriaChanged(options.reviewContext.task_criteria_binding, current)) return null;
    return `Task criteria changed since this review context was built (the task's TASK.md row, attached plan, ` +
        `linked task-card section, operator decisions, operator-confirmed intent or scope-derived requirements): recorded task_criteria_binding.sha256=` +
        `${readTaskCriteriaBinding(options.reviewContext.task_criteria_binding)?.sha256 || 'missing or invalid'}; ` +
        `current=${current.sha256}. Every review repeats in FULL against the current criteria.`;
}
