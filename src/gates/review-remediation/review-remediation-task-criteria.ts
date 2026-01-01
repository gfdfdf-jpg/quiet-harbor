import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathRealpathInsideRoot, joinOrchestratorPath } from '../../core/orchestrator-paths';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { computeTaskCriteriaBinding, hasTaskCriteriaChanged,
    reviewContextRequiresTaskCriteriaBinding, TASK_CRITERIA_BINDING_SCHEMA } from '../review-context/review-context-task-criteria-binding';
import { getCanonicalReviewContextPath } from '../review-context/review-context-paths';
import { readPreservedReviewContextCopy, sameReviewContextPath } from '../review/review-artifact-recovery';
import type { ReviewRemediationBaselineArtifact } from './review-remediation-baseline';

/**
 * The after-failed-review side of the one "task criteria changed" rule (every review repeats in FULL): the
 * `task_criteria_binding` recorded in the review context the failed review ran against, compared through
 * `hasTaskCriteriaChanged` with the current criteria under the intent the new preflight is classified with.
 * The context is read only when its bytes still match the hash the authenticated baseline binds.
 *
 * Returns null only when authenticated context bytes prove that it predates the binding. A missing or
 * altered context uses a criteria fingerprint signed at routing, or a digest-exact cached copy, only when
 * verified REVIEW_RECORDED telemetry binds both the baseline and that context. Unverifiable criteria count as changed.
 */
export function resolveFailedReviewTaskCriteriaChange(options: {
    repoRoot: string;
    taskId: string;
    baseline: ReviewRemediationBaselineArtifact;
    baselineSha256: string;
    currentTaskIntent: string;
}): boolean | null {
    const binding = options.baseline.bindings?.context;
    const contextPathText = String(binding?.review_context_path || '').trim();
    const contextSha256 = String(binding?.review_context_sha256 || '').trim().toLowerCase();
    if (!contextPathText || !/^[0-9a-f]{64}$/u.test(contextSha256)) return true;
    const contextPath = path.resolve(options.repoRoot, contextPathText);
    const reviewsRoot = joinOrchestratorPath(options.repoRoot, 'runtime/reviews');
    if (!sameReviewContextPath(contextPath, getCanonicalReviewContextPath(reviewsRoot, options.taskId, options.baseline.review_type))
        || !isPathRealpathInsideRoot(contextPath, options.repoRoot, { allowMissing: true })
        || !isPathRealpathInsideRoot(contextPath, reviewsRoot, { allowMissing: true })) return true;
    let bytes: Buffer | null = null;
    if (isPathRealpathInsideRoot(contextPath, options.repoRoot, { allowMissing: false })) {
        try {
            const current = fs.readFileSync(contextPath);
            if (createHash('sha256').update(current).digest('hex') === contextSha256) bytes = current;
        } catch { /* Try the independently authenticated copy below. */ }
    }
    if (!bytes) {
        let eventMatches = false;
        let routedCriteria: string | null = null;
        let boundRoutedCriteria: string | null = null;
        let conflictingCriteria = false;
        const timeline = joinOrchestratorPath(options.repoRoot, `runtime/task-events/${options.taskId}.jsonl`);
        const inspection = inspectTaskEventFile(timeline, options.taskId, { onIntegrityEvent: event => {
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown> : {};
            if (event.event_type === 'REVIEWER_DELEGATION_ROUTED' && event.actor === 'orchestrator' && event.outcome === 'INFO'
                && event.task_id === options.taskId && details.review_type === options.baseline.review_type
                && String(details.review_context_sha256 || '').toLowerCase() === contextSha256
                && details.task_criteria_binding_schema === TASK_CRITERIA_BINDING_SCHEMA
                && /^[0-9a-f]{64}$/u.test(String(details.task_criteria_binding_sha256 || ''))) {
                const digest = String(details.task_criteria_binding_sha256);
                if (routedCriteria !== null && routedCriteria !== digest) conflictingCriteria = true;
                routedCriteria = digest;
            }
            if (event.event_type === 'REVIEW_RECORDED' && event.actor === 'gate' && event.outcome === 'PASS'
                && event.task_id === options.taskId && details.task_id === options.taskId
                && details.review_type === options.baseline.review_type
                && String(details.remediation_baseline_snapshot_sha256 || '').toLowerCase() === options.baselineSha256
                && String(details.review_context_sha256 || '').toLowerCase() === contextSha256
                && sameReviewContextPath(path.resolve(options.repoRoot, String(details.review_context_path || '')), contextPath)) {
                eventMatches = true;
                boundRoutedCriteria = !conflictingCriteria ? routedCriteria : null;
            }
        } });
        if (eventMatches && ['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status)) {
            if (boundRoutedCriteria && !conflictingCriteria) {
                try {
                    const current = computeTaskCriteriaBinding({ repoRoot: options.repoRoot, taskId: options.taskId,
                        preflight: { task_intent: options.currentTaskIntent } });
                    return current.sha256 !== boundRoutedCriteria;
                } catch { return true; }
            }
            bytes = readPreservedReviewContextCopy({ repoRoot: options.repoRoot, taskId: options.taskId,
                reviewType: options.baseline.review_type, contextPath }, contextSha256);
        }
    }
    if (!bytes) return true;
    let reviewContext: unknown;
    try {
        reviewContext = JSON.parse(bytes.toString('utf8'));
    } catch {
        return true;
    }
    if (!reviewContext || typeof reviewContext !== 'object' || Array.isArray(reviewContext)) return true;
    const recorded = (reviewContext as Record<string, unknown>).task_criteria_binding;
    if (recorded === undefined) return reviewContextRequiresTaskCriteriaBinding(reviewContext as Record<string, unknown>) ? true : null;
    try {
        const current = computeTaskCriteriaBinding({
            repoRoot: options.repoRoot, taskId: options.taskId, preflight: { task_intent: options.currentTaskIntent }
        });
        return hasTaskCriteriaChanged(recorded, current);
    } catch {
        return true;
    }
}
