import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell,
    type CanonicalActiveTaskQueueRow
} from '../../core/task-md-table';
import { parseTaskQueueEntriesFromContent, type TaskQueueEntry } from '../../core/task-queue-read';
import { writeTaskQueueFile } from '../../core/task-queue/task-queue-repository';
import { appendTaskEvent, assertValidTaskId } from '../../gate-runtime/task-events';
import { withTaskQueueStatusSyncLock } from '../../cli/commands/gate-flows/task/task-queue-sync';
import { readSplitRequiredLatchEvidence } from '../next-step/next-step-split-required-latch';
import {
    extractExplicitLinkedChildTaskIds,
    formatDecomposedTaskProvenanceNote
} from '../next-step/next-step-task-queue';
import { fileSha256, joinOrchestratorPath, normalizePath, stringSha256 } from '../shared/helpers';
import { isStrictDecompositionWipSuspensionRequired } from '../next-step/next-step-strict-decomposition-wip';
import { findRecordedSplitDecisionViolation, getStrictDecompositionDecisionEvidence } from './strict-decomposition-decision';
import { describeUnreadableTaskQueue, readContainedTaskQueueText } from './strict-decomposition-plan';
import {
    normalizeStrictDecompositionWorkPackageContract,
    readStrictDecompositionWorkPackageContractFile,
    validateStrictDecompositionWorkPackageFindingSources,
    type StrictDecompositionWorkPackage,
    type StrictDecompositionWorkPackageContract
} from './strict-decomposition-work-package-contract';

export const DECOMPOSITION_CHILDREN_MATERIALIZED_EVENT = 'DECOMPOSITION_CHILDREN_MATERIALIZED';
export const DECOMPOSITION_CHILDREN_ARTIFACT_SUFFIX = '-decomposition-children.json';

export type DecompositionChildrenSource = 'strict-decomposition-decision' | 'split-required-latch';

export interface MaterializeDecompositionChildrenOptions {
    repoRoot: string;
    taskId: unknown;
    workPackageContractPath?: unknown;
    cliPrefix: string;
}

export interface MaterializeDecompositionChildrenResult {
    status: 'MATERIALIZED' | 'ALREADY_MATERIALIZED' | 'BLOCKED';
    outputLines: string[];
    childTaskIds: string[];
    artifactPath: string | null;
}

interface ResolvedSplitSource {
    source: DecompositionChildrenSource;
    sourceArtifactSha256: string | null;
    contract: StrictDecompositionWorkPackageContract;
    wipSuspensionRequired: boolean;
}

const MAX_TITLE_LENGTH = 180;
const MAX_NOTES_FRAGMENT_LENGTH = 600;
const REQUIRED_REVIEWS_SENTENCE_PATTERN = /(^|[.!?]\s+|;\s*|\r?\n[ \t]*)(required\s+reviews\b|reviews(?=\s*:))/giu;
const LATCH_KINDS_WITH_CONTRACT = new Set(['scope_budget', 'review_cycle']);

function sanitizeCell(value: string, maxLength: number): string {
    const text = value.replace(/[|\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}

function asSentence(value: string): string {
    const text = sanitizeCell(value, MAX_NOTES_FRAGMENT_LENGTH);
    return /[.!?]$/u.test(text) ? text : `${text}.`;
}

function readExpectedTaskSummary(repoRoot: string, taskId: string): string {
    const taskModePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-task-mode.json`));
    try {
        const taskMode: unknown = JSON.parse(fs.readFileSync(taskModePath, 'utf8'));
        const summary = taskMode && typeof taskMode === 'object' ? (taskMode as Record<string, unknown>).task_summary : null;
        if (typeof summary === 'string' && summary.trim()) return summary.trim();
    } catch {
        // The recorded split still binds its own summary when task-mode evidence is unavailable.
    }
    return '';
}

function unionReviewTypes(rawContract: unknown): string[] {
    const packages = rawContract && typeof rawContract === 'object'
        ? (rawContract as Record<string, unknown>).work_packages
        : null;
    if (!Array.isArray(packages)) return [];
    const types = packages.flatMap((entry) => (
        entry && typeof entry === 'object' && Array.isArray((entry as Record<string, unknown>).required_review_types)
            ? ((entry as Record<string, unknown>).required_review_types as unknown[]).map((type) => String(type).trim().toLowerCase())
            : []
    ));
    return [...new Set(types)];
}

function resolveSplitSource(
    repoRoot: string,
    taskId: string,
    parent: TaskQueueEntry,
    contractPath: unknown
): ResolvedSplitSource | string {
    const decision = getStrictDecompositionDecisionEvidence(repoRoot, taskId, '', readExpectedTaskSummary(repoRoot, taskId));
    const hasContractPath = String(contractPath || '').trim().length > 0;
    if (decision.evidence_status === 'PASS' && decision.decision === 'split-required') {
        if (hasContractPath) {
            return 'The authenticated split-required decision already binds its work-package contract; omit --work-package-contract-path.';
        }
        const recordedViolation = findRecordedSplitDecisionViolation(repoRoot, taskId, decision);
        if (recordedViolation) return recordedViolation;
        const changedDecision = `The ${taskId} split decision changed or became unreadable during materialization. Please rerun next-step.`;
        let contract: StrictDecompositionWorkPackageContract;
        try {
            const bytes = fs.readFileSync(decision.evidence_path!);
            if (createHash('sha256').update(bytes).digest('hex') !== decision.evidence_hash) return changedDecision;
            contract = JSON.parse(bytes.toString('utf8')).work_package_contract;
        } catch {
            return changedDecision;
        }
        return { source: 'strict-decomposition-decision', sourceArtifactSha256: decision.evidence_hash, contract,
            wipSuspensionRequired: isStrictDecompositionWipSuspensionRequired({ repoRoot, taskId, evidence: decision }) };
    }
    const reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    if (readTaskQueueStatusToken(parent.status) !== 'SPLIT_REQUIRED') {
        return `No authenticated split decision exists for ${taskId} (strict decomposition evidence: ${decision.evidence_status}; `
            + `TASK.md status: ${parent.status || 'unknown'}). Record split-required with record-strict-decomposition-decision first.`;
    }
    const latch = readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId });
    if (!latch.valid || !LATCH_KINDS_WITH_CONTRACT.has(String(latch.guard_kind))) {
        return `The SPLIT_REQUIRED latch of ${taskId} cannot source child rows: ${latch.valid ? `guard kind ${latch.guard_kind} has its own repair materialization` : latch.reason}.`;
    }
    if (!hasContractPath) {
        return `The SPLIT_REQUIRED latch of ${taskId} names no children; pass --work-package-contract-path with the root-cause work-package contract.`;
    }
    const rawContract = readStrictDecompositionWorkPackageContractFile(repoRoot, contractPath);
    const contract = normalizeStrictDecompositionWorkPackageContract(
        taskId,
        rawContract,
        unionReviewTypes(rawContract) as StrictDecompositionWorkPackage['required_review_types'],
        String(parent.profile || 'strict').trim().toLowerCase()
    );
    const sourceViolations = validateStrictDecompositionWorkPackageFindingSources(repoRoot, taskId, contract);
    if (sourceViolations.length > 0) {
        return `WorkPackageContract finding sources are invalid: ${sourceViolations.join(' ')}`;
    }
    // A latch captures its WIP when the latch is recorded; its rows add no suspension of their own.
    return { source: 'split-required-latch', sourceArtifactSha256: latch.artifact_sha256, contract, wipSuspensionRequired: false };
}

function buildChildNotes(parentTaskId: string, pkg: StrictDecompositionWorkPackage, index: number, total: number, contractSha: string): string {
    return [
        `Parent: ${parentTaskId} (work package ${index + 1} of ${total}; contract sha256 ${contractSha.slice(0, 12)}).`,
        `Root cause area: ${pkg.root_cause_area}.`,
        `Obligations: ${pkg.scope_obligations.map(asSentence).join(' ')}`,
        `Verify: ${pkg.validation_contract.map(asSentence).join(' ')}`,
        ...(pkg.required_review_types.length > 0 ? [`Required reviews: ${pkg.required_review_types.join(', ')}.`] : [])
    ].join(' ');
}

/** Generated notes must carry exactly the package's review declaration and no child-list marker of their own. */
function findChildNotesViolation(childTaskId: string, notes: string, pkg: StrictDecompositionWorkPackage, knownTaskIds: string[]): string | null {
    const declarations = [...notes.matchAll(REQUIRED_REVIEWS_SENTENCE_PATTERN)].length;
    if (declarations !== (pkg.required_review_types.length > 0 ? 1 : 0)) {
        return `work package ${childTaskId} text would add another review declaration to its TASK.md notes`;
    }
    if (extractExplicitLinkedChildTaskIds(notes, knownTaskIds, childTaskId).length > 0) {
        return `work package ${childTaskId} text would read as a child-task list in its TASK.md notes`;
    }
    return null;
}

function buildChildRows(params: {
    parentRow: CanonicalActiveTaskQueueRow;
    contract: StrictDecompositionWorkPackageContract;
    contractSha: string;
    knownTaskIds: string[];
    today: string;
}): { rows: string[]; violations: string[] } {
    const packages = params.contract.work_packages;
    const violations: string[] = [];
    const titles = new Set<string>();
    const rows = packages.map((pkg, index) => {
        const title = sanitizeCell(pkg.objective, MAX_TITLE_LENGTH);
        if (titles.has(title.toLowerCase())) violations.push(`work package ${pkg.task_id} repeats the title of another package`);
        titles.add(title.toLowerCase());
        const notes = buildChildNotes(params.parentRow.taskId, pkg, index, packages.length, params.contractSha);
        const violation = findChildNotesViolation(pkg.task_id, notes, pkg, params.knownTaskIds);
        if (violation) violations.push(violation);
        const cells = [pkg.task_id, 'TODO', params.parentRow.priority, params.parentRow.area, title,
            params.parentRow.owner, params.today, pkg.profile, notes];
        return `| ${cells.join(' | ')} |`;
    });
    return { rows, violations };
}

function findInsertionLineIndex(parentRow: CanonicalActiveTaskQueueRow, rows: readonly CanonicalActiveTaskQueueRow[]): number {
    const prefix = `${parentRow.taskId.toLowerCase()}-`;
    return rows.reduce((lineIndex, row) => (
        row.taskId.toLowerCase().startsWith(prefix) ? Math.max(lineIndex, row.lineIndex) : lineIndex
    ), parentRow.lineIndex);
}

function assessExistingRows(
    taskEntries: Map<string, TaskQueueEntry>,
    parentTaskId: string,
    childTaskIds: string[]
): 'none' | 'complete' | string {
    const parentNotes = taskEntries.get(parentTaskId)?.notes || '';
    const linked = extractExplicitLinkedChildTaskIds(parentNotes, taskEntries.keys(), parentTaskId);
    const existing = childTaskIds.filter((childTaskId) => taskEntries.has(childTaskId));
    if (existing.length === childTaskIds.length && childTaskIds.every((childTaskId) => linked.includes(childTaskId))) {
        return 'complete';
    }
    if (existing.length === 0 && linked.length === 0 && !/\bdecomposition\s+source\s*:/iu.test(parentNotes)) {
        return 'none';
    }
    return `TASK.md already holds part of this decomposition (existing child rows: ${existing.join(', ') || 'none'}; `
        + `linked children: ${linked.join(', ') || 'none'}). Complete or remove the partial rows and links by hand, then rerun this command.`;
}

function blocked(cliPrefix: string, taskId: string, reason: string): MaterializeDecompositionChildrenResult {
    return {
        status: 'BLOCKED',
        outputLines: [
            'DECOMPOSITION_CHILDREN_BLOCKED',
            `TaskId: ${taskId}`,
            `Reason: ${reason}`,
            `NextStep: ${cliPrefix} next-step "${taskId}" --repo-root "."`
        ],
        childTaskIds: [],
        artifactPath: null
    };
}

interface MaterializationContext {
    repoRoot: string;
    taskId: string;
    taskPath: string;
    artifactPath: string;
    cliPrefix: string;
    workPackageContractPath: unknown;
}

function buildQueueChange(original: string, parentTaskId: string, contract: StrictDecompositionWorkPackageContract,
    contractSha: string, childTaskIds: string[]): string | { next: string } {
    const parsed = parseCanonicalActiveTaskQueue(original);
    if (!parsed.found) return parsed.unavailableReason || 'Canonical Active Queue table not found.';
    const parentRow = parsed.rows.find((row) => row.taskId === parentTaskId);
    if (!parentRow) return `TASK.md has no ${parentTaskId} row.`;
    const collisions = childTaskIds.filter((childTaskId) => parsed.rows.some((row) => row.taskId === childTaskId));
    if (collisions.length > 0) return `TASK.md already has rows ${collisions.join(', ')}.`;
    const knownTaskIds = [...parsed.rows.map((row) => row.taskId), ...childTaskIds];
    const today = new Date().toISOString().slice(0, 10);
    const childRows = buildChildRows({ parentRow, contract, contractSha, knownTaskIds, today });
    if (childRows.violations.length > 0) return `The work-package contract cannot become TASK.md rows: ${childRows.violations.join('; ')}.`;
    const provenance = formatDecomposedTaskProvenanceNote({ source: 'orchestrator', childTaskIds, recordedOn: today });
    const parentNotes = parentRow.notes.trim() ? `${parentRow.notes.trim()} ${provenance}` : provenance;
    const linked = extractExplicitLinkedChildTaskIds(parentNotes, knownTaskIds, parentTaskId);
    if (linked.length !== childTaskIds.length || childTaskIds.some((childTaskId) => !linked.includes(childTaskId))) {
        return `The parent notes would not link exactly ${childTaskIds.join(', ')} (parsed: ${linked.join(', ') || 'none'}).`;
    }
    const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${parentNotes} `);
    if (!updatedParentLine) return 'Failed to replace the TASK.md parent notes cell.';
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/u);
    lines[parentRow.lineIndex] = updatedParentLine;
    lines.splice(findInsertionLineIndex(parentRow, parsed.rows) + 1, 0, ...childRows.rows);
    return { next: formatActiveTaskQueueTable(lines.join(newline)) };
}

/** Writes the evidence of a materialization whose rows are already in TASK.md; the caller still holds the queue lock. */
function recordMaterialization(context: MaterializationContext, resolved: ResolvedSplitSource, contractSha: string,
    childTaskIds: string[], original: string, next: string): void {
    const artifact = {
        schema_version: 1,
        event_source: 'materialize-decomposition-children',
        task_id: context.taskId,
        recorded_at_utc: new Date().toISOString(),
        source: resolved.source,
        source_artifact_sha256: resolved.sourceArtifactSha256,
        work_package_contract_sha256: contractSha,
        child_task_ids: childTaskIds,
        task_queue_sha256_before: stringSha256(original),
        task_queue_sha256_after: stringSha256(next)
    };
    fs.mkdirSync(path.dirname(context.artifactPath), { recursive: true });
    fs.writeFileSync(context.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    appendTaskEvent(joinOrchestratorPath(context.repoRoot, ''), context.taskId, DECOMPOSITION_CHILDREN_MATERIALIZED_EVENT, 'INFO',
        'Decomposition child rows materialized.', {
            artifact_path: normalizePath(context.artifactPath),
            artifact_sha256: fileSha256(context.artifactPath),
            source: resolved.source,
            child_task_ids: childTaskIds,
            work_package_contract_sha256: contractSha
        });
}

/** Undo only this command's own change: the queue still holds exactly what it wrote, because the lock was never released. */
function rollbackOwnQueueChange(context: MaterializationContext, original: string, next: string): void {
    const current = readContainedTaskQueueText(context.repoRoot);
    if (current.status === 'read' && current.text === next) writeTaskQueueFile(context.taskPath, original);
    try { fs.rmSync(context.artifactPath, { force: true }); } catch { /* Without its event the artifact never authenticates. */ }
}

function alreadyMaterialized(context: MaterializationContext, childTaskIds: string[]): MaterializeDecompositionChildrenResult {
    return {
        status: 'ALREADY_MATERIALIZED',
        outputLines: ['DECOMPOSITION_CHILDREN_ALREADY_MATERIALIZED', `TaskId: ${context.taskId}`, `Children: ${childTaskIds.join(', ')}`,
            `NextStep: ${context.cliPrefix} next-step "${context.taskId}" --repo-root "."`],
        childTaskIds,
        artifactPath: fs.existsSync(context.artifactPath) ? normalizePath(context.artifactPath) : null
    };
}

/** Eligibility, the queue write and its evidence share one queue-lock hold, so no other writer can interleave. */
function materializeUnderLock(context: MaterializationContext): MaterializeDecompositionChildrenResult {
    const queue = readContainedTaskQueueText(context.repoRoot);
    if (queue.status !== 'read') return blocked(context.cliPrefix, context.taskId, describeUnreadableTaskQueue());
    const original = queue.text;
    const taskEntries = parseTaskQueueEntriesFromContent(original);
    const parent = taskEntries.get(context.taskId);
    if (!parent) return blocked(context.cliPrefix, context.taskId, `TASK.md has no ${context.taskId} row.`);
    const token = readTaskQueueStatusToken(parent.status);
    if (token === 'DONE' || token === 'BLOCKED') {
        return blocked(context.cliPrefix, context.taskId, `${context.taskId} is ${token}; a terminal row cannot gain decomposition children.`);
    }
    const resolved = resolveSplitSource(context.repoRoot, context.taskId, parent, context.workPackageContractPath);
    if (typeof resolved === 'string') return blocked(context.cliPrefix, context.taskId, resolved);
    const childTaskIds = resolved.contract.work_packages.map((pkg) => pkg.task_id);
    const existing = assessExistingRows(taskEntries, context.taskId, childTaskIds);
    if (existing === 'complete') return alreadyMaterialized(context, childTaskIds);
    if (existing !== 'none') return blocked(context.cliPrefix, context.taskId, existing);
    if (resolved.wipSuspensionRequired) {
        return blocked(context.cliPrefix, context.taskId, `The ${context.taskId} implementation WIP is not suspended yet, and child links would let `
            + 'navigation skip its suspension. Run next-step, which captures and suspends it, then rerun this command.');
    }
    const contractSha = stringSha256(JSON.stringify(resolved.contract)) || '';
    const change = buildQueueChange(original, context.taskId, resolved.contract, contractSha, childTaskIds);
    if (typeof change === 'string') return blocked(context.cliPrefix, context.taskId, change);
    writeTaskQueueFile(context.taskPath, change.next);
    try {
        recordMaterialization(context, resolved, contractSha, childTaskIds, original, change.next);
    } catch (error) {
        rollbackOwnQueueChange(context, original, change.next);
        throw error;
    }
    return {
        status: 'MATERIALIZED',
        outputLines: [
            'DECOMPOSITION_CHILDREN_MATERIALIZED',
            `TaskId: ${context.taskId}`,
            `Source: ${resolved.source}`,
            `Children: ${childTaskIds.join(', ')}`,
            `TaskPath: ${normalizePath(context.taskPath)}`,
            `ArtifactPath: ${normalizePath(context.artifactPath)}`,
            `NextStep: ${context.cliPrefix} next-step "${context.taskId}" --repo-root "."`
        ],
        childTaskIds,
        artifactPath: normalizePath(context.artifactPath)
    };
}

/** Creates the child rows and the parent provenance note of an authenticated split, so next-step can mark the parent DECOMPOSED. */
export function materializeDecompositionChildren(options: MaterializeDecompositionChildrenOptions): MaterializeDecompositionChildrenResult {
    const repoRoot = path.resolve(options.repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const context: MaterializationContext = {
        repoRoot, taskId, cliPrefix: options.cliPrefix, workPackageContractPath: options.workPackageContractPath,
        taskPath: path.join(repoRoot, TASK_QUEUE_FILENAME),
        artifactPath: joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}${DECOMPOSITION_CHILDREN_ARTIFACT_SUFFIX}`))
    };
    return withTaskQueueStatusSyncLock<MaterializeDecompositionChildrenResult>(context.taskPath,
        (message) => blocked(options.cliPrefix, taskId, `TASK.md lock could not be acquired: ${message}`),
        () => materializeUnderLock(context));
}
