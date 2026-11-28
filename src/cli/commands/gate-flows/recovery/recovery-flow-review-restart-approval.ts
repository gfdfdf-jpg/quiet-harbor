import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOperatorConfirmationYes, validateFreshOperatorConfirmation } from '../../../../core/operator-confirmation';
import { getReviewLifecycleGuard } from '../../../../gates/review/review-lifecycle-guard';
import { readPreflightWorkspaceReadiness } from '../../../../gates/next-step/next-step-preflight-workspace-readiness';
import {
    getTaskModeDirtyWorkspaceBaselineChangedFiles,
    getTaskModeDirtyWorkspaceBaselineFileHashes,
    getTaskModePlannedChangedFiles
} from '../../../../gates/next-step/next-step-lifecycle-command-builders';

export const REVIEW_RESTART_APPROVED_OPTION = '--review-restart-approved';
export const REVIEW_RESTART_APPROVED_AT_UTC_OPTION = '--review-restart-approved-at-utc';
const REVIEW_RESTART_APPROVAL_MAX_AGE_MS = 10 * 60 * 1000;

export interface ReviewRestartApproval {
    /** The current cycle already passed its review gate and the workspace changed after that pass. */
    readonly required: boolean;
    readonly blockingEvent: string | null;
    readonly changedFilesAfterReviewGate: readonly string[];
    readonly approvedAtUtc: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPreflightRecord(preflightPath: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * A write after REVIEW_GATE_PASSED reopens a cycle that was almost finished. A new review cycle then repeats
 * reviews again, so it runs only with the user's explicit, fresh approval, through either restart gate. Lost or
 * corrupt evidence with an unchanged workspace is ordinary recovery and needs no approval. The approval is never
 * forwarded to task-mode entry: --operator-confirmed protects orchestrator and re-entry consent instead.
 */
export function resolveReviewRestartApproval(options: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    taskMode: Record<string, unknown>;
    approved?: unknown;
    approvedAtUtc?: unknown;
    gate?: 'restart-coherent-cycle' | 'restart-review-cycle';
}): ReviewRestartApproval {
    const gate = options.gate ?? 'restart-coherent-cycle';
    const guard = getReviewLifecycleGuard(options.repoRoot, options.taskId, gate, 'review_gate');
    const blockingEvent = guard.status === 'BLOCK' ? guard.blocking_event : null;
    const preflight = blockingEvent ? readPreflightRecord(options.preflightPath) : null;
    const readiness = preflight
        ? readPreflightWorkspaceReadiness(options.repoRoot, preflight, {
            failedReviewType: null,
            failedReviewVerdict: null,
            // Same acceptance as next-step: docs the doc-impact gate declared are part of closing, not a new write.
            docImpactPath: path.join(path.dirname(options.preflightPath), `${options.taskId}-doc-impact.json`),
            plannedChangedFiles: getTaskModePlannedChangedFiles(options.taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(options.repoRoot, options.taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(options.repoRoot, options.taskMode)
        })
        : null;
    const approvalSupplied = options.approved !== undefined || options.approvedAtUtc !== undefined;
    if (!readiness || readiness.ready) {
        // Evidence recovery without a late write. A supplied approval is not needed and is not recorded.
        return { required: false, blockingEvent, changedFilesAfterReviewGate: [], approvedAtUtc: null };
    }
    const changedFiles = [...(readiness.currentChangedFiles ?? [])].sort();
    const instruction = 'Files changed after the required reviews passed'
        + (changedFiles.length ? ` (${changedFiles.join(', ')})` : '')
        + '. Revert the change and continue closing the task with next-step. If the change is truly necessary, '
        + 'tell the user that it starts a new, expensive review cycle and rerun only after the user approves, with '
        + `${REVIEW_RESTART_APPROVED_OPTION} yes ${REVIEW_RESTART_APPROVED_AT_UTC_OPTION} "<ISO-8601 timestamp of the approval>".`;
    if (!approvalSupplied) {
        throw new Error(`${gate} after ${blockingEvent} requires the user's approval. ${instruction}`);
    }
    const approved = parseOperatorConfirmationYes(options.approved, REVIEW_RESTART_APPROVED_OPTION);
    const approvedAtUtc = String(options.approvedAtUtc ?? '').trim();
    if (!approvedAtUtc) {
        throw new Error(`${gate} after ${blockingEvent} requires ${REVIEW_RESTART_APPROVED_AT_UTC_OPTION}. ${instruction}`);
    }
    if (!Number.isFinite(Date.parse(approvedAtUtc))) {
        throw new Error(`${REVIEW_RESTART_APPROVED_AT_UTC_OPTION} must be a valid ISO-8601 timestamp.`);
    }
    // Enforce the documented review-restart window independently of the broader legacy operator window.
    if (Date.now() - Date.parse(approvedAtUtc) > REVIEW_RESTART_APPROVAL_MAX_AGE_MS) {
        throw new Error(`Review restart approval is stale (older than ten minutes); ask the user for fresh approval. ${instruction}`);
    }
    validateFreshOperatorConfirmation({
        actionLabel: `${gate} review restart`,
        confirmed: approved,
        confirmedAtUtc: approvedAtUtc,
        requireConfirmedAtUtc: true,
        instruction
    });
    return { required: true, blockingEvent, changedFilesAfterReviewGate: changedFiles, approvedAtUtc };
}
