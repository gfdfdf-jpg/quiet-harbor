import type { StrictDecompositionTaskPlan } from './strict-decomposition-plan';

/** One explicit disposition for one planned sub-card task. */
export interface StrictDecompositionPlanDisposition {
    task_id: string;
    disposition: string;
}

/** A justified estimate over a soft cap, recorded with the decision instead of an operator stop. */
export interface StrictDecompositionPlanCapRevision {
    file_cap: number;
    justification: string;
}

export interface StrictDecompositionRecheckBaseline {
    preflight_changed_files_count: number | null;
    failed_non_test_review_count: number;
    /** Repo-relative inputs the baseline was read from; next-step re-decides when it navigates other inputs. */
    preflight_path?: string | null;
    events_root?: string | null;
    /** Changed workspace files (Git) when no preflight counts them yet; dirty work needs an estimate too. */
    workspace_changed_files_count?: number | null;
}

export interface StrictDecompositionPlanConformanceInput {
    decision: string;
    taskId: string;
    plan: StrictDecompositionTaskPlan | null;
    estimatedChangedFiles: number | null;
    planDispositions: StrictDecompositionPlanDisposition[];
    planCapRevision: string | null;
    recheckBaseline: StrictDecompositionRecheckBaseline | null;
}

const MIN_PLAN_DISPOSITION_LENGTH = 20;
const MAX_PLAN_DISPOSITION_LENGTH = 2000;
const MIN_CAP_REVISION_LENGTH = 40;
const MAX_CAP_REVISION_LENGTH = 2000;
const DISPOSITION_PATTERN = /^\s*(T-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\s*:\s*([\s\S]+?)\s*$/u;

/** A non-split decision must explicitly own a sub-card plan unless this row is itself one planned sub-card. */
export function requiresStrictDecompositionPlanDisposition(plan: StrictDecompositionTaskPlan | null): boolean {
    return Boolean(plan && plan.sub_card_plan && !plan.task_is_planned_sub_card);
}

/** `--plan-disposition "<task id>: <how this row honours it>"`, once per planned sub-card task. */
export function normalizeStrictDecompositionPlanDispositions(value: unknown): StrictDecompositionPlanDisposition[] {
    if (value === null || value === undefined) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw.map((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const record = entry as Record<string, unknown>;
            return normalizeDispositionParts(String(record.task_id ?? ''), String(record.disposition ?? ''));
        }
        const match = DISPOSITION_PATTERN.exec(String(entry ?? ''));
        if (!match) throw new Error('PlanDisposition must have the form "<task id>: <how this row honours that sub-card>".');
        return normalizeDispositionParts(match[1], match[2]);
    }).filter((entry) => entry.task_id || entry.disposition);
}

function normalizeDispositionParts(taskId: string, disposition: string): StrictDecompositionPlanDisposition {
    const text = disposition.trim();
    if (!/^T-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(taskId.trim())) {
        throw new Error(`PlanDisposition task id '${taskId}' is not a task id.`);
    }
    if (text.length < MIN_PLAN_DISPOSITION_LENGTH || text.length > MAX_PLAN_DISPOSITION_LENGTH) {
        throw new Error(`PlanDisposition for ${taskId} must contain ${MIN_PLAN_DISPOSITION_LENGTH}-${MAX_PLAN_DISPOSITION_LENGTH} characters.`);
    }
    return { task_id: taskId.trim(), disposition: text };
}

export function normalizeStrictDecompositionPlanCapRevision(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const stored = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).justification : value;
    const text = String(stored ?? '').trim();
    if (!text) return null;
    if (text.length < MIN_CAP_REVISION_LENGTH || text.length > MAX_CAP_REVISION_LENGTH) {
        throw new Error(`PlanCapRevision must justify the estimate over the cap in ${MIN_CAP_REVISION_LENGTH}-${MAX_CAP_REVISION_LENGTH} characters.`);
    }
    return text;
}

function assessDispositions(input: StrictDecompositionPlanConformanceInput, violations: string[]): void {
    const plan = input.plan;
    if (!requiresStrictDecompositionPlanDisposition(plan)) return;
    // Without named children the row itself owns the sub-card plan and states how in one disposition.
    const expected = plan!.planned_child_task_ids.length > 0 ? plan!.planned_child_task_ids : [input.taskId];
    if (input.planDispositions.length === 0) {
        violations.push(`The task card or TASK.md notes plan sub-cards (${plan!.evidence.join('; ') || 'sub-card plan'}); `
            + `a ${input.decision} decision must pass one --plan-disposition per planned task: ${expected.map((id) => `"${id}: <how this row honours it>"`).join(' ')}.`);
        return;
    }
    const counts = new Map<string, number>();
    for (const entry of input.planDispositions) counts.set(entry.task_id.toLowerCase(), (counts.get(entry.task_id.toLowerCase()) ?? 0) + 1);
    const missing = expected.filter((id) => !counts.has(id.toLowerCase()));
    const repeated = expected.filter((id) => (counts.get(id.toLowerCase()) ?? 0) > 1);
    const unplanned = [...new Set(input.planDispositions.map((entry) => entry.task_id)
        .filter((id) => !expected.some((planned) => planned.toLowerCase() === id.toLowerCase())))];
    if (missing.length > 0) violations.push(`--plan-disposition is missing for ${missing.join(', ')}.`);
    if (repeated.length > 0) violations.push(`--plan-disposition repeats ${repeated.join(', ')}; give one disposition per planned task.`);
    if (unplanned.length > 0) violations.push(`--plan-disposition names tasks the plan does not list: ${unplanned.join(', ')}.`);
}

function assessEstimate(input: StrictDecompositionPlanConformanceInput, violations: string[]): void {
    const plan = input.plan;
    const current = input.recheckBaseline?.preflight_changed_files_count ?? null;
    const dirty = input.recheckBaseline?.workspace_changed_files_count ?? null;
    const hasPlan = Boolean(plan && (plan.sub_card_plan || plan.file_cap !== null));
    if (input.estimatedChangedFiles === null) {
        const scope = hasPlan ? 'for a planned task'
            : (current ?? 0) > 0 ? `while the preflight already changes ${current} files`
                : (dirty ?? 0) > 0 ? `while the workspace already changes ${dirty} files` : null;
        if (scope) {
            const capNote = plan?.file_cap != null
                ? ` The task card or TASK.md notes cap this work at ${plan.file_cap} files${plan.file_cap_hard ? ' (hard cap)' : ''}.` : '';
            violations.push(`A ${input.decision} decision ${scope} must pass --estimated-changed-files.${capNote}`);
        }
        return;
    }
    const cap = plan?.file_cap ?? null;
    const hardCap = resolveHardFileCap(plan);
    if (hardCap !== null && input.estimatedChangedFiles > hardCap) {
        // A revision lifts only a soft cap: the hard cap of the card still applies.
        violations.push(`--estimated-changed-files ${input.estimatedChangedFiles} exceeds the hard cap of ${hardCap} files that the card sets; split the work.`);
    } else if (cap !== null && input.estimatedChangedFiles > cap) {
        if (!input.planCapRevision) {
            violations.push(`--estimated-changed-files ${input.estimatedChangedFiles} exceeds the planned cap of ${cap} files; `
                + 'split the work, or for indivisible work pass --plan-cap-revision with the justification.');
        }
    } else if (input.planCapRevision) {
        violations.push('--plan-cap-revision is only for an estimate over the planned file cap.');
    }
    if (current !== null && input.estimatedChangedFiles < current) {
        violations.push(`--estimated-changed-files ${input.estimatedChangedFiles} is below the ${current} files the current preflight already changes.`);
    }
}

/** Reasons a non-split decision does not address the planned sub-cards, the file cap or the current scope. */
export function assessStrictDecompositionPlanConformance(input: StrictDecompositionPlanConformanceInput): string[] {
    if (input.decision === 'split-required') return [];
    const violations: string[] = [];
    assessDispositions(input, violations);
    assessEstimate(input, violations);
    return violations;
}

/** The smallest hard cap; an artifact from before `hard_file_cap` derives it from the hard flag of its minimum cap. */
function resolveHardFileCap(plan: StrictDecompositionTaskPlan | null): number | null {
    if (!plan) return null;
    if (plan.hard_file_cap !== undefined) return plan.hard_file_cap;
    return plan.file_cap_hard ? plan.file_cap : null;
}

/** The cap the recheck enforces: a recorded revision lifts the soft cap, never the hard cap of the card. */
export function resolveEffectiveStrictDecompositionFileCap(plan: StrictDecompositionTaskPlan | null, revision: string | null): number | null {
    return revision ? resolveHardFileCap(plan) : plan?.file_cap ?? null;
}

function normalizeOptionalRelativePath(value: unknown, label: string): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`RecheckBaseline ${label} is malformed.`);
    return value;
}

export function normalizeStrictDecompositionRecheckBaseline(value: unknown): StrictDecompositionRecheckBaseline | null {
    if (value === null || value === undefined) return null;
    const record = typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const changed = record?.preflight_changed_files_count;
    const failed = record?.failed_non_test_review_count;
    if (!record || (changed !== null && !(typeof changed === 'number' && Number.isSafeInteger(changed) && changed >= 0))
        || !(typeof failed === 'number' && Number.isSafeInteger(failed) && failed >= 0)) {
        throw new Error('RecheckBaseline is malformed.');
    }
    const dirty = record.workspace_changed_files_count;
    if (dirty !== undefined && dirty !== null && !(typeof dirty === 'number' && Number.isSafeInteger(dirty) && dirty >= 0)) {
        throw new Error('RecheckBaseline is malformed.');
    }
    const preflightPath = normalizeOptionalRelativePath(record.preflight_path, 'preflight_path');
    const eventsRoot = normalizeOptionalRelativePath(record.events_root, 'events_root');
    return {
        preflight_changed_files_count: changed as number | null,
        failed_non_test_review_count: failed,
        ...(preflightPath !== null ? { preflight_path: preflightPath } : {}),
        ...(eventsRoot !== null ? { events_root: eventsRoot } : {}),
        ...(dirty !== undefined ? { workspace_changed_files_count: dirty as number | null } : {})
    };
}
