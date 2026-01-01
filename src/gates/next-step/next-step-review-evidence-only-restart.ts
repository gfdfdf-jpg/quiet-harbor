import * as path from 'node:path';

import type { CompiledReviewDependencyGraph } from '../../core/review-dependency-graph';
import {
    collectUnpassedRestartInvalidatedReviewTypes,
    describeReviewEvidenceOnlyRestartRepeats,
    resolveReviewEvidenceOnlyRestartScope
} from '../review-remediation/review-evidence-only-restart-scope';
import { fileSha256 } from '../shared/helpers';
import { safeReadJson } from '../task-audit/task-audit-summary-collectors';
import type { WorkspaceSnapshotRequest } from '../workspace/workspace-snapshot-cache';
import { readCompileReadiness } from './next-step-compile-readiness';
import {
    getTaskModeDirtyWorkspaceBaselineChangedFiles,
    getTaskModeDirtyWorkspaceBaselineFileHashes,
    getTaskModePlannedChangedFiles
} from './next-step-lifecycle-command-builders';
import { readPreflightWorkspaceReadiness } from './next-step-preflight-workspace-readiness';

export const REVIEW_EVIDENCE_ONLY_FLAG = '--review-evidence-only';

export interface ReviewEvidenceOnlyRestartReadinessOptions {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewType: string;
    preflight: Record<string, unknown>;
    preflightPath: string;
    taskMode: Record<string, unknown> | null;
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest;
}

export interface ReviewEvidenceOnlyRestartReadiness {
    ready: boolean;
    reason: string;
}

/**
 * The one acceptance rule of restart-review-cycle --review-evidence-only, also read before offering it.
 * It keeps the current preflight and compile, so both must still be current by the rules next-step routes on:
 * neutral closeout evidence and authorized Git-ignored files are current, a changed task file is not.
 */
export function readReviewEvidenceOnlyRestartReadiness(
    options: ReviewEvidenceOnlyRestartReadinessOptions
): ReviewEvidenceOnlyRestartReadiness {
    const compileEvidence = safeReadJson(path.join(options.reviewsRoot, `${options.taskId}-compile-gate.json`));
    if (!compileEvidence) {
        return { ready: false, reason: 'current compile-gate evidence is missing or unreadable.' };
    }
    if (String(compileEvidence.status || '').trim() !== 'PASSED'
        || String(compileEvidence.task_id || '').trim() !== options.taskId
        || String(compileEvidence.preflight_hash_sha256 || '').trim().toLowerCase() !== fileSha256(options.preflightPath)) {
        return { ready: false, reason: 'compile evidence is not PASSED and bound to the current task and preflight.' };
    }
    const compileReadiness = readCompileReadiness(
        options.repoRoot, options.reviewsRoot, options.eventsRoot, options.taskId, options.preflightPath,
        options.workspaceSnapshotRequest
    );
    if (!compileReadiness.ready) {
        return { ready: false, reason: compileReadiness.reason };
    }
    const readWorkspaceReadiness = (failedReviewType: string | null) => readPreflightWorkspaceReadiness(
        options.repoRoot, options.preflight, {
            failedReviewType,
            failedReviewVerdict: null,
            docImpactPath: path.join(options.reviewsRoot, `${options.taskId}-doc-impact.json`),
            plannedChangedFiles: getTaskModePlannedChangedFiles(options.taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(options.repoRoot, options.taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(options.repoRoot, options.taskMode),
            workspaceSnapshotRequest: options.workspaceSnapshotRequest
        }
    );
    // next-step reads a failed lane with its failed type and every other lane without one.
    const failedLaneReadiness = readWorkspaceReadiness(options.reviewType);
    if (failedLaneReadiness.ready) {
        return { ready: true, reason: failedLaneReadiness.reason };
    }
    const laneReadiness = readWorkspaceReadiness(null);
    return { ready: laneReadiness.ready, reason: laneReadiness.ready ? laneReadiness.reason : failedLaneReadiness.reason };
}

interface EvidenceOnlyRestartRoute {
    reason: string;
    commands: Array<{ label: string; command: string }>;
}

/**
 * Finishes a route that offers an evidence-only restart: it says exactly what repeats, or replaces the
 * command with the ordinary restart when the evidence-only one would be refused. A refused command stays
 * refused until the state changes, so offering it would loop.
 */
export function finalizeReviewEvidenceOnlyRestartRoute<Route extends EvidenceOnlyRestartRoute>(
    route: Route | null,
    optionsForRestart: () => ReviewEvidenceOnlyRestartReadinessOptions & {
        requiredReviewTypes: readonly string[];
        dependencyGraph?: CompiledReviewDependencyGraph | null;
        ordinaryRestart: { label: string; command: string };
    }
): Route | null {
    if (!route?.commands[0]?.command.includes(REVIEW_EVIDENCE_ONLY_FLAG)) {
        return route;
    }
    const options = optionsForRestart();
    const readiness = readReviewEvidenceOnlyRestartReadiness(options);
    if (!readiness.ready) {
        return {
            ...route,
            reason: `${route.reason} ${describeOrdinaryRestartFallback(readiness.reason)}`,
            commands: [options.ordinaryRestart]
        };
    }
    const scope = resolveReviewEvidenceOnlyRestartScope({
        reviewType: options.reviewType,
        requiredReviewTypes: options.requiredReviewTypes,
        carriedReviewTypes: collectUnpassedRestartInvalidatedReviewTypes({
            reviewsRoot: options.reviewsRoot,
            taskId: options.taskId,
            requiredReviewTypes: options.requiredReviewTypes
        }),
        dependencyGraph: options.dependencyGraph
    });
    return {
        ...route,
        reason: `${route.reason} The evidence-only restart repeats `
            + `${describeReviewEvidenceOnlyRestartRepeats(options.reviewType, scope)}, preserving passed receipts for other `
            + 'reviews through reuse when reuse validation accepts them; current preflight and compile evidence are retained.'
    };
}

export function describeOrdinaryRestartFallback(evidenceOnlyRefusal: string): string {
    return `An evidence-only restart cannot be used here: ${evidenceOnlyRefusal.trim().replace(/\.$/u, '')}. `
        + 'This ordinary restart refreshes preflight and compile and rebuilds the review contexts; '
        + 'every required review repeats in FULL unless an authenticated fix delta narrows it.';
}
