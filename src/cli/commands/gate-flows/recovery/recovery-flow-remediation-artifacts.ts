import * as path from 'node:path';

import { writeReviewArtifactJson } from '../../../../gate-runtime/review-artifacts';
import { runGit } from '../../../../core/git-helpers';
import { splitNulRecords } from '../../../../core/git-path-output';
import { DEFAULT_GIT_TIMEOUT_MS } from '../../../../core/subprocess';
import { getWorkspaceSnapshot } from '../../../../gates/compile/compile-gate';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { excludeUnchangedDirtyWorkspaceBaselineFiles, normalizeChangedFiles } from './recovery-flow-shared';
import type {
    ResolvedReplayScope,
    ReviewRemediationScopeBoundary
} from './recovery-flow-types';

/**
 * A named file that Git tracks and that is identical to HEAD in the index and the worktree was not changed.
 * classify-change drops such files from an explicit list; the remediation scope does the same, so planned but
 * unmodified files never count as added remediation paths. Untracked, ignored and deleted paths are kept.
 */
function omitUnchangedTrackedFiles(
    repoRoot: string,
    namedFiles: readonly string[],
    workspaceChangedFiles: readonly string[]
): string[] {
    const changedSet = new Set(normalizeChangedFiles(workspaceChangedFiles));
    const candidates = normalizeChangedFiles(namedFiles).filter((file) => !changedSet.has(file));
    if (candidates.length === 0) {
        return normalizeChangedFiles(namedFiles);
    }
    const tracked = new Set(normalizeChangedFiles(splitNulRecords(runGit(
        repoRoot,
        ['ls-files', '-z', '--cached', '--', ...candidates.map((file) => `:(literal)${file}`)],
        { timeoutMs: DEFAULT_GIT_TIMEOUT_MS }
    ))));
    return normalizeChangedFiles(namedFiles).filter((file) => changedSet.has(file) || !tracked.has(file));
}

export function resolveCurrentRemediationChangedFiles(
    repoRoot: string,
    replayScope: ResolvedReplayScope,
    dirtyWorkspaceBaseline?: unknown
): string[] {
    const detectionSource = replayScope.useStaged
        ? (replayScope.includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only')
        : 'git_auto';
    const includeUntracked = replayScope.includeUntracked ?? !replayScope.useStaged;
    const snapshot = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, []);
    const workspaceChangedFiles = snapshot.changed_files as string[];
    const currentTaskChanges = excludeUnchangedDirtyWorkspaceBaselineFiles(
        repoRoot,
        workspaceChangedFiles,
        dirtyWorkspaceBaseline
    );
    return normalizeChangedFiles([
        ...omitUnchangedTrackedFiles(repoRoot, replayScope.changedFiles ?? [], workspaceChangedFiles),
        ...currentTaskChanges
    ]);
}

export function writeReviewRemediationCycleArtifact(
    repoRoot: string,
    taskId: string,
    artifact: Record<string, unknown>
): string {
    const artifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-review-remediation-cycle.json`)
    );
    writeReviewArtifactJson(artifactPath, artifact);
    return artifactPath;
}

export function resolveReviewRemediationClassifyChangedFiles(
    replayScope: ResolvedReplayScope,
    scopeBoundary: ReviewRemediationScopeBoundary,
    extraChangedFiles: readonly string[] = []
): string[] | undefined {
    const normalizedExtraChangedFiles = normalizeChangedFiles(extraChangedFiles);
    if (replayScope.changedFiles === undefined && normalizedExtraChangedFiles.length === 0) {
        return undefined;
    }
    return normalizeChangedFiles([
        ...scopeBoundary.previousChangedFiles,
        ...(replayScope.changedFiles ?? []),
        ...scopeBoundary.expandedNonTestFiles,
        ...scopeBoundary.allowedTestOnlyExpansionFiles,
        ...scopeBoundary.allowedDocumentExpansionFiles ?? [],
        ...normalizedExtraChangedFiles
    ]);
}
