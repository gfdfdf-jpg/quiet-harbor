import * as fs from 'node:fs';
import * as path from 'node:path';

import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { isPlainRecord } from '../../core/records';
import { isGeneratedRuntimeControlPlaneArtifactPath } from '../shared/generated-runtime-artifacts';
import {
    collectCapturedUntrackedFiles,
    collectTrackedChangeFiles,
    collectVisibleUntrackedFiles,
    readPreflightChangedFileScope
} from '../full-suite/full-suite-repair-capture';
import { safeReadJson } from '../task-audit/task-audit-summary-collectors';
import { collectRetainedCompletedQualityInputs } from './next-step-retained-quality-inputs';
import {
    captureAndSuspendSplitRequiredWip
} from '../split-required/split-required-wip-capture';
import {
    findCurrentCapturedManifest,
    type SplitRequiredWipCaptureResult
} from '../split-required/split-required-wip-contracts';
import {
    getStrictDecompositionDecisionEvidence,
    type StrictDecompositionDecisionEvidenceResult
} from '../task-mode/strict-decomposition-decision';
import {
    joinOrchestratorPath
} from '../shared/helpers';

export type StrictDecompositionWipSuspensionResult = SplitRequiredWipCaptureResult | {
    status: 'NOT_REQUIRED';
    manifest_path: null;
    manifest_sha256: null;
    tracked_files: string[];
    untracked_files: string[];
    violations: string[];
};

function noWipSuspensionRequired(): StrictDecompositionWipSuspensionResult {
    return {
        status: 'NOT_REQUIRED',
        manifest_path: null,
        manifest_sha256: null,
        tracked_files: [],
        untracked_files: [],
        violations: []
    };
}

function isRetainedIgnoredRuntimeEvidence(filePath: string): boolean {
    // Match the private split-capture contract; inventory paths are already normalized.
    const lower = filePath.toLowerCase();
    return lower.startsWith('garda-agent-orchestrator/runtime/reviews/')
        || lower.startsWith('garda-agent-orchestrator/runtime/task-events/')
        || lower.startsWith('garda-agent-orchestrator/runtime/task-ledger/')
        || lower.startsWith('garda-agent-orchestrator/runtime/project-memory/')
        || lower.startsWith('garda-agent-orchestrator/runtime/wip/')
        || lower.startsWith('garda-agent-orchestrator/runtime/metrics');
}

function hasCurrentImplementationWip(repoRoot: string, taskId: string, preflightPath: string): boolean {
    try {
        const preflightExists = fs.existsSync(preflightPath);
        const preflight = safeReadJson(preflightPath);
        if (preflightExists && (!isPlainRecord(preflight) || preflight.task_id !== taskId)) return true;
        const scope = preflightExists ? readPreflightChangedFileScope(repoRoot, preflightPath, taskId) : null;
        if (scope?.violations.length) return true;
        const countsAsWip = (filePath: string): boolean => preflightExists
            || (!isGeneratedRuntimeControlPlaneArtifactPath(filePath) && !isRetainedIgnoredRuntimeEvidence(filePath));
        const trackedFiles = collectTrackedChangeFiles(repoRoot).all
            .filter(filePath => filePath !== TASK_QUEUE_FILENAME && countsAsWip(filePath));
        const untrackedFiles = collectVisibleUntrackedFiles(repoRoot)
            .filter(filePath => filePath !== `${TASK_QUEUE_FILENAME}.garda-status-sync.lock/owner.json` && countsAsWip(filePath));
        if (trackedFiles.length > 0 || untrackedFiles.length > 0) return true;
        const allowed = scope?.allowed ?? new Set<string>();
        const ignoredFiles = collectCapturedUntrackedFiles(repoRoot, taskId, allowed)
            .filter(filePath => !isRetainedIgnoredRuntimeEvidence(filePath));
        if (!ignoredFiles.length) return false;
        const retainedQualityInputs = collectRetainedCompletedQualityInputs(
            repoRoot, taskId, ignoredFiles, allowed
        );
        return ignoredFiles.some(filePath => !retainedQualityInputs.has(filePath));
    } catch {
        // An uncertain inventory must still go through guarded native capture.
        return true;
    }
}

/** How the parent WIP of an authenticated split stands before its children may be linked. */
export type StrictDecompositionWipState =
    /** No split or no preflight and no current parent WIP. */
    | 'none'
    /** Capture needs a preflight for the current parent workspace. */
    | 'refresh-preflight'
    /** No suspended capture of the preflight yet; the guarded capture decides whether anything is there. */
    | 'capture'
    /** A suspended capture exists and Git shows no parent work after it. */
    | 'suspended'
    /** A suspended capture exists, but parent work appeared after it; a guarded recapture keeps the previous one. */
    | 'recapture';

/**
 * The parent preflight the split is bound to: the one the decision recorded its baseline from, else the one this
 * navigation reads, else the default. A preflight kept only at an alternate path is never mistaken for none.
 */
export function resolveStrictDecompositionParentPreflightPath(params: {
    repoRoot: string;
    taskId: string;
    evidence: StrictDecompositionDecisionEvidenceResult;
    preflightPath?: string | null;
}): string {
    const recorded = params.evidence.recheck_baseline?.preflight_path;
    if (recorded) return path.resolve(params.repoRoot, recorded);
    if (params.preflightPath) return path.resolve(params.repoRoot, params.preflightPath);
    return joinOrchestratorPath(params.repoRoot, path.join('runtime', 'reviews', `${params.taskId}-preflight.json`));
}

/** Inspect Git when the preflight is unavailable or when parent WIP may have appeared after a capture. */
export function inspectStrictDecompositionWipState(params: {
    repoRoot: string;
    taskId: string;
    evidence: StrictDecompositionDecisionEvidenceResult;
    preflightPath?: string | null;
}): { state: StrictDecompositionWipState; preflightPath: string } {
    const preflightPath = resolveStrictDecompositionParentPreflightPath(params);
    if (params.evidence.evidence_status !== 'PASS' || params.evidence.decision !== 'split-required') {
        return { state: 'none', preflightPath };
    }
    if (!isPlainRecord(safeReadJson(preflightPath))) {
        const state = hasCurrentImplementationWip(params.repoRoot, params.taskId, preflightPath) ? 'refresh-preflight' : 'none';
        return { state, preflightPath };
    }
    if (!findCurrentCapturedManifest({ repoRoot: params.repoRoot, taskId: params.taskId, preflightPath, guardKind: 'strict_decomposition' })) {
        return { state: 'capture', preflightPath };
    }
    return { state: hasCurrentImplementationWip(params.repoRoot, params.taskId, preflightPath) ? 'recapture' : 'suspended', preflightPath };
}

/**
 * Read-only, always with Git: whether parent implementation WIP is still in the worktree, with or without an earlier
 * capture. Child rows are not linked then, because links let navigation skip the suspension.
 */
export function isStrictDecompositionWipSuspensionRequired(params: {
    repoRoot: string;
    taskId: string;
    evidence: StrictDecompositionDecisionEvidenceResult;
    preflightPath?: string | null;
}): boolean {
    if (params.evidence.evidence_status !== 'PASS' || params.evidence.decision !== 'split-required') return false;
    const preflightPath = resolveStrictDecompositionParentPreflightPath(params);
    return hasCurrentImplementationWip(params.repoRoot, params.taskId, preflightPath);
}

export function suspendStrictDecompositionWipIfRequired(params: {
    repoRoot: string;
    taskId: string;
    evidence?: StrictDecompositionDecisionEvidenceResult;
    /** The preflight the split is bound to; the default one when omitted. */
    preflightPath?: string | null;
    /** Capture parent edits made after a suspended capture as a new capture, keeping the previous one. */
    recapture?: boolean;
}): StrictDecompositionWipSuspensionResult {
    const evidence = params.evidence || getStrictDecompositionDecisionEvidence(
        params.repoRoot,
        params.taskId
    );
    if (evidence.evidence_status !== 'PASS' || evidence.decision !== 'split-required') {
        return noWipSuspensionRequired();
    }

    const preflightPath = resolveStrictDecompositionParentPreflightPath({ ...params, evidence });
    if (!hasCurrentImplementationWip(params.repoRoot, params.taskId, preflightPath)) {
        return noWipSuspensionRequired();
    }

    return captureAndSuspendSplitRequiredWip({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        preflightPath,
        guardKind: 'strict_decomposition',
        guardReason: params.recapture
            ? 'Parent edits made after the suspended strict-decomposition capture are suspended as a new capture; the previous capture is kept.'
            : 'A current strict decomposition decision requires the implemented parent scope to be suspended before child execution.',
        ...(params.recapture ? { reuseExistingCapture: false } : {})
    });
}
