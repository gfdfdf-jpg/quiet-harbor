import { countNextStepWork } from '../../core/next-step-measurement';
import { readInvocationTextFile } from '../../core/invocation-file-observation';
import { fileSha256, isOrchestratorSourceCheckout } from '../shared/helpers';
import { isSourceCheckoutGeneratedRuntimeArtifactPath, splitGeneratedRuntimeControlPlaneArtifacts } from '../shared/generated-runtime-artifacts';
import { normalizeDirtyWorkspaceBaseline } from '../workspace/dirty-worktree-protection';
import { filterUntrackedBuildOutputPaths } from '../../core/build-output-paths';
import { plannedFilesNeedOrchestratorWork } from './next-step-protected-entry-hint';
import * as childProcess from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitNulRecords } from '../../core/git-path-output';
import { resolveWorkspaceSnapshotRequest, type WorkspaceSnapshotRequest } from '../workspace/workspace-snapshot-cache';
import { isPlainRecord } from '../../core/records';
import { findUnapprovedActiveImplementationOwners } from '../workspace/active-implementation-ownership';
import { readFreshEntryPlanScopeFiles, type ProtectedScopeSelection } from '../task-mode/task-mode-plan-protection';
import type { QualityValidationPhases } from '../quality-checklist/quality-checklist-validation-phases';
import {
    selectRulePackFiles
} from '../review-context/review-context-token-economy';
import {
    isPathRealpathInsideRoot,
    normalizePath
} from '../shared/helpers';
import {
    normalizeWorkspaceRelativePath,
    normalizeWorkspaceRelativePaths
} from '../workspace/dirty-worktree-protection';
import {
    assessQualityChecklistAnswersTemplateFile,
    buildQualityChecklistArtifact,
    resolveDefaultQualityChecklistAnswersTemplatePath
} from '../quality-checklist';
import type {
    TaskQueueEntry
} from './next-step-task-queue';
import {
    buildBundleRelativePath,
    buildGatePathCommandParts,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    buildTaskModePathCommandParts,
    resolveTaskModePathCommandValue
} from './next-step-review-command-builders';
import type {
    NextStepBuildReviewContextArguments,
    NextStepClassifyChangeArguments,
    NextStepEnterTaskModeArguments,
    NextStepPreflightGateArguments,
    NextStepRequiredReviewsCheckArguments,
    NextStepQualityChecklistArguments,
    NextStepRulePackBindArguments
} from './next-step-command-execution';
import {
    getPreflightChangedFiles
} from './next-step-doc-closeout-readiness';
import {
    resolveTaskProfileSelection
} from '../../policy/task-profile-selection';
import {
    resolveBundleRootForTarget
} from '../../core/constants';
import {
    expandDependencyManifestLockfileScope
} from '../scope/dependency-manifest-lockfile-scope';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';
import {
    getWorkflowConfigChangedFiles
} from '../workflow-config/workflow-config-work';
import {
    selectTaskEntryRulePackFileNames
} from '../rule-pack/rule-pack-selection';
import {
    resolveSplitCheckpointTaskScope
} from '../split-required/split-checkpoint-scope';

export interface AuthenticatedSplitCheckpointCommandScope {
    detectionSource: string;
    changedFiles: string[];
    violation: string | null;
}

function resolveDefaultDepthFromTaskQueue(repoRoot: string, taskEntry: TaskQueueEntry | null): string {
    try {
        const resolvedProfile = resolveTaskProfileSelection(
            resolveBundleRootForTarget(repoRoot),
            taskEntry?.profile || null
        );
        const depth = resolvedProfile.effective_policy.depth;
        if (Number.isInteger(depth) && depth >= 1 && depth <= 3) {
            return String(depth);
        }
    } catch {
        // Fall back to legacy queue-name mapping when profile config is unavailable.
    }
    const profile = String(taskEntry?.profile || '').trim().toLowerCase();
    if (profile === 'fast' || profile === 'docs-only') return '1';
    return '2';
}

function resolveDefaultDepthFromTaskMode(taskMode: Record<string, unknown> | null): string {
    // Restart commands must preserve the task-mode artifact snapshot. Fresh task
    // entry resolves profile defaults; restart should not drift if profiles.json changes later.
    return getNumberField(taskMode, 'requested_depth', '<1|2|3>');
}

function shouldPreserveEffectiveDepthForRestart(
    taskMode: Record<string, unknown> | null,
    requestedDepth: string,
    effectiveDepth: string
): boolean {
    if (!effectiveDepth) {
        return false;
    }
    const effectiveDepthSource = getStringField(taskMode, 'effective_depth_source', '');
    if (effectiveDepthSource === 'explicit') {
        return true;
    }
    return !effectiveDepthSource && requestedDepth !== effectiveDepth;
}

export function getStringField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const rawValue = source?.[field];
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    return value || fallback;
}

function getNumberField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const value = source?.[field];
    return Number.isInteger(value) ? String(value) : fallback;
}

function buildProtectedOperatorConfirmationCommandParts(): string[] {
    return [
        '--operator-confirmed yes',
        '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
    ];
}

function readGitPaths(repoRoot: string, args: string[]): string[] | null {
    try {
        const output = childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10000
        });
        return splitNulRecords(String(output || '')).map((entry) => (countNextStepWork('visit:next-step-lifecycle-command-builders:event:135'), normalizePath(entry))).filter(Boolean);
    } catch {
        return null;
    }
}

interface CommandWorkspaceReadSnapshot {
    active: boolean;
    repositories: Map<string, { changedFiles: string[]; reliable: boolean }>;
    request?: WorkspaceSnapshotRequest;
}

const commandWorkspaceReadSnapshots = new AsyncLocalStorage<CommandWorkspaceReadSnapshot>();

export function withNextStepCommandWorkspaceReadSnapshot<T>(callback: () => T, request?: WorkspaceSnapshotRequest): T {
    const snapshot: CommandWorkspaceReadSnapshot = { active: true, repositories: new Map(), request };
    return commandWorkspaceReadSnapshots.run(snapshot, () => {
        try {
            return callback();
        } finally {
            snapshot.active = false;
            snapshot.repositories.clear();
        }
    });
}

function readCurrentWorkspaceChangedFiles(repoRoot: string): { changedFiles: string[]; reliable: boolean } {
    const snapshot = commandWorkspaceReadSnapshots.getStore();
    const resolvedRoot = path.resolve(repoRoot);
    const key = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
    const cached = snapshot?.active ? snapshot.repositories.get(key) : null;
    if (cached) return { changedFiles: [...cached.changedFiles], reliable: cached.reliable };
    let result: { changedFiles: string[]; reliable: boolean };
    try {
        result = snapshot?.active && snapshot.request
            ? { changedFiles: resolveWorkspaceSnapshotRequest(repoRoot, snapshot.request).read('git_auto', true, []).changed_files,
                reliable: true }
            : captureCurrentWorkspaceChangedFiles(repoRoot);
    } catch { result = { changedFiles: [], reliable: false }; }
    if (snapshot?.active) snapshot.repositories.set(key, result);
    return { changedFiles: [...result.changedFiles], reliable: result.reliable };
}

function captureCurrentWorkspaceChangedFiles(repoRoot: string): { changedFiles: string[]; reliable: boolean } {
    const trackedChangedFiles = readGitPaths(repoRoot, ['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', 'HEAD', '--']);
    const untrackedChangedFiles = readGitPaths(repoRoot, ['ls-files', '-z', '--others', '--exclude-standard']);
    if (trackedChangedFiles === null || untrackedChangedFiles === null) {
        return { changedFiles: [], reliable: false };
    }
    return {
        changedFiles: [...new Set([
            ...trackedChangedFiles,
            ...filterUntrackedBuildOutputPaths(repoRoot, untrackedChangedFiles)
        ])].sort(),
        reliable: true
    };
}

export function readCurrentStagedChangedFiles(repoRoot: string): string[] | null {
    return readGitPaths(repoRoot, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACDMRTUXB', '--']);
}

function isSafeRepoRelativePath(relativePath: string): boolean {
    const normalizedPath = normalizePath(relativePath).replace(/\/+$/, '');
    if (!normalizedPath || normalizedPath === '.' || path.isAbsolute(normalizedPath)) {
        return false;
    }
    return !normalizedPath.split('/').includes('..');
}

function isPlainDirectoryPlaceholder(repoRoot: string, relativePath: string): boolean {
    if (!isSafeRepoRelativePath(relativePath)) {
        return false;
    }
    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
        return false;
    }
    const fileStatus = fs.lstatSync(absolutePath);
    return fileStatus.isDirectory() && !fileStatus.isSymbolicLink();
}

function isPhysicallyContainedCommandPath(repoRoot: string, relativePath: string): boolean {
    if (!isSafeRepoRelativePath(relativePath)) {
        return false;
    }
    return isPathRealpathInsideRoot(
        path.resolve(repoRoot, relativePath),
        repoRoot,
        { allowMissing: true }
    );
}

function expandDirectoryPlaceholdersForCommand(repoRoot: string, scopeFiles: string[]): string[] {
    const normalizedScopeFiles = [...new Set(scopeFiles.map((entry) => normalizePath(entry)).filter(Boolean))]
        .filter((entry) => isPhysicallyContainedCommandPath(repoRoot, entry))
        .sort();
    if (normalizedScopeFiles.length === 0) {
        return [];
    }
    const currentWorkspace = readCurrentWorkspaceChangedFiles(repoRoot);
    if (!currentWorkspace.reliable) {
        return normalizedScopeFiles;
    }
    const currentChangedFiles = currentWorkspace.changedFiles;
    if (currentChangedFiles.length === 0) {
        return normalizedScopeFiles.filter((entry) => {
            return !isPlainDirectoryPlaceholder(repoRoot, entry);
        });
    }
    const atomicScopeFiles = expandDependencyManifestLockfileScope(normalizedScopeFiles, currentChangedFiles);

    const expanded = new Set<string>();
    for (const scopeFile of atomicScopeFiles) {
        if (
            currentChangedFiles.includes(scopeFile)
            && isPhysicallyContainedCommandPath(repoRoot, scopeFile)
        ) {
            expanded.add(scopeFile);
        }
        const prefix = `${scopeFile.replace(/\/+$/, '')}/`;
        const matchingCurrentFiles = currentChangedFiles.filter((changedFile) => (
            changedFile.startsWith(prefix)
            && isPhysicallyContainedCommandPath(repoRoot, changedFile)
        ));
        if (matchingCurrentFiles.length > 0) {
            for (const matchingFile of matchingCurrentFiles) {
                expanded.add(matchingFile);
            }
            continue;
        }

        if (isPlainDirectoryPlaceholder(repoRoot, scopeFile)) {
            continue;
        }
        if (isPhysicallyContainedCommandPath(repoRoot, scopeFile)) {
            expanded.add(scopeFile);
        }
    }
    return [...expanded].sort();
}

/** Git Bash, MSYS2 and Cygwin on Windows expand POSIX `$NAME`, not PowerShell `$env:NAME`. */
export function usesPowerShellEnvironmentSyntax(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
    return platform === 'win32' && !env.MSYSTEM && !/cygwin/iu.test(env.TERM || '');
}

export function quoteProviderForCommand(provider: string | null): string {
    if (provider) {
        return quoteCommandValue(provider);
    }
    return usesPowerShellEnvironmentSyntax()
        ? '"$env:GARDA_EXECUTION_PROVIDER"'
        : '"$GARDA_EXECUTION_PROVIDER"';
}

/** Fresh-entry values of the ordinary enter-task-mode command; the runtime provider is never derived here. */
export function buildFreshEnterTaskModeArguments(
    repoRoot: string,
    taskId: string,
    taskEntry: TaskQueueEntry | null
): NextStepEnterTaskModeArguments {
    return {
        task_id: taskId,
        entry_mode: 'EXPLICIT_TASK_EXECUTION',
        requested_depth: resolveDefaultDepthFromTaskQueue(repoRoot, taskEntry),
        task_summary: taskEntry?.title || taskId
    };
}

export function buildEnterTaskModeCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    provider: string | null,
    taskMode: Record<string, unknown> | null = null,
    unapprovedActiveTaskOwners?: readonly string[],
    scopeUpgradeFiles?: readonly string[],
    freshEntryProtectedPlan?: ProtectedScopeSelection | null
): string {
    const requestedDepth = taskMode
        ? resolveDefaultDepthFromTaskMode(taskMode)
        : resolveDefaultDepthFromTaskQueue(repoRoot, taskEntry);
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(getStringField(taskMode, 'entry_mode', 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(requestedDepth)}`,
        `--task-summary ${quoteCommandValue(getStringField(taskMode, 'task_summary', taskEntry?.title || taskId))}`
    ];
    parts.push(`--provider ${taskMode
        ? quoteCommandValue(getStringField(taskMode, 'provider', provider || '<provider>'))
        : quoteProviderForCommand(provider)}`);
    if (taskMode) {
        const plan = isPlainRecord(taskMode.plan) ? taskMode.plan : null;
        const planPath = getStringField(plan, 'plan_path', '');
        if (planPath) parts.push(`--plan-path ${quoteCommandValue(planPath)}`);
        for (const [field, flag] of [['start_banner', '--start-banner'], ['routed_to', '--routed-to']]) {
            const value = getStringField(taskMode, field, '');
            if (value) parts.push(`${flag} ${quoteCommandValue(value)}`);
        }
        const effectiveDepth = getNumberField(taskMode, 'effective_depth', '');
        if (shouldPreserveEffectiveDepthForRestart(taskMode, requestedDepth, effectiveDepth)) {
            parts.push(`--effective-depth ${quoteCommandValue(effectiveDepth)}`);
        }
    }
    const owners = unapprovedActiveTaskOwners ?? findUnapprovedActiveImplementationOwners(repoRoot, taskId);
    if (owners.length > 0 || scopeUpgradeFiles) {
        for (const owner of owners) parts.push(`--allow-active-task ${quoteCommandValue(owner)}`);
        // A fresh entry whose authenticated follow-up scope or attached plan names the files declares exactly those,
        // never a placeholder.
        const plannedFiles = [...new Set([...(Array.isArray(taskMode?.planned_changed_files)
            ? taskMode.planned_changed_files.map(String) : []), ...scopeUpgradeFiles ?? [],
        ...(!taskMode ? [...freshEntryProtectedPlan?.plannedFiles ?? [], ...readFreshEntryPlanScopeFiles(repoRoot, taskId)] : [])])];
        for (const file of plannedFiles.length > 0 ? plannedFiles : ['<task-owned-file>']) {
            parts.push(`--planned-changed-file ${quoteCommandValue(file)}`);
        }
        if (taskMode) {
            parts.push('--upgrade-existing-task-mode');
            // Entry refuses protected planned files without the flag; the operator confirmation stays required.
            if (taskMode.orchestrator_work === true || plannedFilesNeedOrchestratorWork(repoRoot, plannedFiles)) parts.push('--orchestrator-work');
            if (taskMode.workflow_config_work === true) parts.push('--workflow-config-work');
        }
        parts.push(...buildProtectedOperatorConfirmationCommandParts());
    }
    if (!taskMode && freshEntryProtectedPlan?.protectedFiles.length) {
        // The attached plan or the authenticated follow-up scope already names protected scope: declare it at entry.
        // The confirmation stays a placeholder that only the operator's answer fills.
        for (const file of freshEntryProtectedPlan.plannedFiles ?? []) {
            const flag = `--planned-changed-file ${quoteCommandValue(file)}`;
            if (!parts.includes(flag)) parts.push(flag);
        }
        parts.push('--orchestrator-work');
        if (freshEntryProtectedPlan.workflowConfigFiles.length > 0) {
            // Entry requires --workflow-config-work to name its workflow-config files as planned files.
            for (const file of freshEntryProtectedPlan.workflowConfigFiles) {
                const flag = `--planned-changed-file ${quoteCommandValue(file)}`;
                if (!parts.includes(flag)) parts.push(flag);
            }
            parts.push('--workflow-config-work');
        }
        if (!parts.some((part) => part.startsWith('--operator-confirmed '))) {
            parts.push(...buildProtectedOperatorConfirmationCommandParts());
        }
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

/**
 * Task-mode re-entry that adopts an operator-approved review-policy change. Re-entry cannot drop a protected
 * task's authorization, so the command keeps its orchestrator and workflow-config flags and planned scope.
 */
export function buildReviewPolicyAdoptionCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    provider: string | null,
    taskMode: Record<string, unknown> | null,
    policyDigest: string
): string {
    // The unfinished-task route returns before this one, so the base command carries no active-task grant.
    const parts = [buildEnterTaskModeCommand(repoRoot, cliPrefix, taskId, taskEntry, provider, taskMode, [])
        .replace(/ --repo-root "\."$/u, '')];
    const protectedWork = taskMode?.orchestrator_work === true || taskMode?.workflow_config_work === true;
    if (protectedWork && Array.isArray(taskMode?.planned_changed_files)) {
        for (const file of taskMode.planned_changed_files.map(String)) parts.push(`--planned-changed-file ${quoteCommandValue(file)}`);
    }
    if (taskMode?.orchestrator_work === true) parts.push('--orchestrator-work');
    if (taskMode?.workflow_config_work === true) parts.push('--workflow-config-work');
    parts.push(`--adopt-changed-review-policy ${quoteCommandValue(policyDigest)}`, ...buildProtectedOperatorConfirmationCommandParts(),
        '--repo-root "."');
    return parts.join(' ');
}

export function buildOrchestratorWorkRestartCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskMode: Record<string, unknown> | null,
    additionalPlannedChangedFiles: string[] = [],
    includeWorkflowConfigWork = false
): string {
    const requestedDepth = resolveDefaultDepthFromTaskMode(taskMode);
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(getStringField(taskMode, 'entry_mode', 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(requestedDepth)}`,
        `--task-summary ${quoteCommandValue(getStringField(taskMode, 'task_summary', '<TASK.md summary>'))}`,
        `--provider ${quoteCommandValue(getStringField(taskMode, 'provider', '<provider>'))}`
    ];
    const startBanner = getStringField(taskMode, 'start_banner', '');
    if (startBanner) {
        parts.push(`--start-banner ${quoteCommandValue(startBanner)}`);
    }
    const routedTo = getStringField(taskMode, 'routed_to', '');
    if (routedTo) {
        parts.push(`--routed-to ${quoteCommandValue(routedTo)}`);
    }
    const effectiveDepth = getNumberField(taskMode, 'effective_depth', '');
    if (shouldPreserveEffectiveDepthForRestart(taskMode, requestedDepth, effectiveDepth)) {
        parts.push(`--effective-depth ${quoteCommandValue(effectiveDepth)}`);
    }
    parts.push('--orchestrator-work');
    if (includeWorkflowConfigWork) {
        parts.push('--workflow-config-work');
    }
    parts.push('--upgrade-existing-task-mode');
    parts.push(...buildProtectedOperatorConfirmationCommandParts());
    const plannedChangedFiles = Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const baseline = normalizeDirtyWorkspaceBaseline(taskMode?.dirty_workspace_baseline, repoRoot);
    const planned = new Set(plannedChangedFiles);
    const baselineFiles = new Set(baseline?.changed_files || []);
    const current = baseline ? readCurrentWorkspaceChangedFiles(repoRoot) : null;
    const taskChangedFiles = current?.reliable ? current.changedFiles.filter(file => {
        if (planned.has(file) || !baselineFiles.has(file)) return true;
        const expected = baseline?.file_hashes[file];
        return !expected || fileSha256(path.resolve(repoRoot, file)) !== expected;
    }) : [];
    // Legacy entries without a readable Git workspace still need their existing fallback scope.
    const fallbackScope = !current?.reliable && plannedChangedFiles.length === 0 && additionalPlannedChangedFiles.length === 0
        ? getTaskModeDirtyWorkspaceBaselineCommandChangedFiles(repoRoot, taskMode)
        : [];
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const restartScopeFiles = splitGeneratedRuntimeControlPlaneArtifacts([
        ...plannedChangedFiles, ...additionalPlannedChangedFiles, ...taskChangedFiles, ...fallbackScope
    ], { isSourceCheckout }).reviewableFiles.filter(file => !isSourceCheckoutGeneratedRuntimeArtifactPath(file, isSourceCheckout));
    const mergedPlannedChangedFiles = expandDirectoryPlaceholdersForCommand(repoRoot, restartScopeFiles);
    const workflowConfigFileSet = includeWorkflowConfigWork
        ? new Set<string>()
        : new Set(getWorkflowConfigChangedFiles(mergedPlannedChangedFiles));
    for (const plannedChangedFile of mergedPlannedChangedFiles) {
        if (workflowConfigFileSet.has(plannedChangedFile)) {
            continue;
        }
        parts.push(`--planned-changed-file ${quoteCommandValue(plannedChangedFile)}`);
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function getTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    return Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

export function getTaskModeDirtyWorkspaceBaselineChangedFiles(
    repoRoot: string,
    taskMode: Record<string, unknown> | null
): string[] {
    if (taskMode?.orchestrator_work !== true) {
        return [];
    }
    const dirtyWorkspaceBaseline = taskMode.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return [];
    }
    const changedFiles = (dirtyWorkspaceBaseline as Record<string, unknown>).changed_files;
    return normalizeWorkspaceRelativePaths(repoRoot, changedFiles);
}

export function getTaskModeDirtyWorkspaceBaselineCommandChangedFiles(
    repoRoot: string,
    taskMode: Record<string, unknown> | null
): string[] {
    if (taskMode?.orchestrator_work !== true) {
        return [];
    }
    const dirtyWorkspaceBaseline = taskMode.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return [];
    }
    const changedFiles = (dirtyWorkspaceBaseline as Record<string, unknown>).changed_files;
    return Array.isArray(changedFiles)
        ? [...new Set(changedFiles
            .map((entry) => normalizeDirtyBaselineCommandPath(repoRoot, entry))
            .filter((entry): entry is string => !!entry))]
            .sort()
        : [];
}

function normalizeDirtyBaselineCommandPath(repoRoot: string, value: unknown): string | null {
    const rawPath = String(value || '').trim();
    const normalizedRawPath = normalizePath(rawPath);
    if (!normalizedRawPath) {
        return null;
    }
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, rawPath);
    const relativeFromRoot = path.relative(resolvedRoot, resolvedPath);
    if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
        return null;
    }
    const normalizedRelativePath = normalizePath(relativeFromRoot);
    if (!normalizedRelativePath) {
        return null;
    }
    try {
        if (
            fs.existsSync(resolvedPath)
            && !isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: false })
        ) {
            return null;
        }
        return normalizedRelativePath;
    } catch {
        return null;
    }
}

export function getTaskModeDirtyWorkspaceBaselineFileHashes(
    repoRoot: string,
    taskMode: Record<string, unknown> | null
): Record<string, string> {
    if (taskMode?.orchestrator_work !== true) {
        return {};
    }
    const dirtyWorkspaceBaseline = taskMode.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return {};
    }
    const fileHashes = (dirtyWorkspaceBaseline as Record<string, unknown>).file_hashes;
    if (!fileHashes || typeof fileHashes !== 'object' || Array.isArray(fileHashes)) {
        return {};
    }
    const normalized: Record<string, string> = {};
    for (const [filePath, hash] of Object.entries(fileHashes as Record<string, unknown>)) {
        countNextStepWork('visit:next-step-lifecycle-command-builders:event:493');
        const normalizedPath = normalizeWorkspaceRelativePath(repoRoot, filePath);
        const normalizedHash = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
        if (normalizedPath && normalizedHash) {
            normalized[normalizedPath] = normalizedHash;
        }
    }
    return normalized;
}

function getTaskModeClassifyChangedFiles(repoRoot: string, taskMode: Record<string, unknown> | null): string[] {
    const plannedChangedFiles = getTaskModePlannedChangedFiles(taskMode);
    const dirtyBaselineCommandFiles = getTaskModeDirtyWorkspaceBaselineCommandChangedFiles(repoRoot, taskMode);
    if (taskMode?.workflow_config_work === true) {
        return [...new Set([
            ...plannedChangedFiles,
            ...dirtyBaselineCommandFiles
        ])].sort();
    }
    if (plannedChangedFiles.length > 0) {
        return [...new Set(plannedChangedFiles)].sort();
    }
    return [...new Set(dirtyBaselineCommandFiles)].sort();
}

export function getPreflightRefreshChangedFiles(
    repoRoot: string,
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): string[] {
    const plannedChangedFiles = taskMode?.workflow_config_work === true
        ? [...new Set([
            ...getTaskModePlannedChangedFiles(taskMode),
            ...getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode)
        ])].sort()
        : getTaskModePlannedChangedFiles(taskMode).length > 0
            ? getTaskModePlannedChangedFiles(taskMode)
            : getTaskModeDirtyWorkspaceBaselineChangedFiles(repoRoot, taskMode);
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    const explicitPreflightChangedFiles = detectionSource === 'explicit_changed_files'
        ? getPreflightChangedFiles(preflight)
        : [];
    if (plannedChangedFiles.length > 0 || explicitPreflightChangedFiles.length > 0) {
        return [...new Set([
            ...plannedChangedFiles,
            ...explicitPreflightChangedFiles
        ])].sort();
    }
    if (detectionSource === 'explicit_changed_files') {
        return getPreflightChangedFiles(preflight);
    }
    return [];
}

export function resolveAuthenticatedSplitCheckpointCommandScope(
    repoRoot: string,
    taskId: string,
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>
): AuthenticatedSplitCheckpointCommandScope | null {
    const resolution = resolveSplitCheckpointTaskScope(repoRoot, taskId, taskQueueEntries);
    if (resolution.scope) {
        return {
            detectionSource: resolution.scope.detection_source,
            changedFiles: [...resolution.scope.changed_files],
            violation: null
        };
    }
    if (resolution.violation) {
        return {
            detectionSource: '',
            changedFiles: [],
            violation: resolution.violation
        };
    }
    return null;
}

export interface ClassifyChangeCommandParams {
    repoRoot: string;
    cliPrefix: string;
    taskId: string;
    taskMode: Record<string, unknown> | null;
    taskModePath: string | null;
    preflightCommandPath: string;
    rulePackCommandPath?: string | null;
    includePlannedScope: boolean;
    changedFiles?: string[];
    detectionSource?: string | null;
    taskIntent?: string | null;
}

const MISSING_TASK_INTENT_PLACEHOLDER = '<task summary>';

/** The rendered command and the same values as typed arguments; a placeholder intent yields no arguments. */
export function buildClassifyChangeInvocation(params: ClassifyChangeCommandParams): {
    command: string;
    arguments: NextStepClassifyChangeArguments | null;
} {
    const taskIntent = String(params.taskIntent || '').trim()
        || getStringField(params.taskMode, 'task_summary', MISSING_TASK_INTENT_PLACEHOLDER);
    const changedFiles = params.changedFiles || (params.includePlannedScope
        ? getTaskModeClassifyChangedFiles(params.repoRoot, params.taskMode)
        : []);
    const expandedChangedFiles = expandDirectoryPlaceholdersForCommand(params.repoRoot, changedFiles);
    const detectionSource = String(params.detectionSource || '').trim();
    const useStaged = expandedChangedFiles.length === 0 && (readCurrentStagedChangedFiles(params.repoRoot)?.length || 0) > 0;
    const taskModePath = resolvePreflightTaskModePathCommandValue(params.repoRoot, params.taskId, params.taskModePath,
        params.preflightCommandPath);
    const parts = [
        `${params.cliPrefix} gate classify-change`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--task-intent ${quoteCommandValue(taskIntent)}`
    ];
    if (detectionSource) {
        parts.push(`--detection-source ${quoteCommandValue(detectionSource)}`);
    }
    for (const changedFile of expandedChangedFiles) {
        parts.push(`--changed-file ${quoteCommandValue(changedFile)}`);
    }
    if (useStaged) {
        parts.push('--use-staged');
    }
    parts.push(...buildGatePathCommandParts({
        task_mode_path: taskModePath,
        rule_pack_path: params.rulePackCommandPath,
        output_path: params.preflightCommandPath
    }));
    parts.push('--repo-root "."');
    return {
        command: parts.join(' '),
        arguments: taskIntent === MISSING_TASK_INTENT_PLACEHOLDER ? null : {
            task_id: params.taskId,
            task_intent: taskIntent,
            changed_files: expandedChangedFiles,
            detection_source: detectionSource || null,
            use_staged: useStaged,
            task_mode_path: taskModePath,
            ...(params.rulePackCommandPath ? { rule_pack_path: params.rulePackCommandPath } : {}),
            output_path: params.preflightCommandPath
        }
    };
}

export function buildClassifyChangeCommand(params: ClassifyChangeCommandParams): string {
    return buildClassifyChangeInvocation(params).command;
}

export function getEffectiveDepthForPostPreflightRules(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): number {
    const riskAwareDepth = isPlainRecord(preflight?.risk_aware_depth) ? preflight.risk_aware_depth : null;
    const preflightDepth = typeof riskAwareDepth?.effective_depth === 'number'
        ? riskAwareDepth.effective_depth
        : Number(riskAwareDepth?.effective_depth);
    if (Number.isInteger(preflightDepth) && preflightDepth >= 1) {
        return preflightDepth;
    }
    const taskModeDepth = typeof taskMode?.effective_depth === 'number'
        ? taskMode.effective_depth
        : Number(taskMode?.effective_depth);
    if (Number.isInteger(taskModeDepth) && taskModeDepth >= 1) {
        return taskModeDepth;
    }
    return 2;
}

export function getPostPreflightRuleFileNames(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const requiredReviews = isPlainRecord(preflight?.required_reviews) ? preflight.required_reviews : {};
    const effectiveDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
    const fileNames = new Set<string>(selectTaskEntryRulePackFileNames({ effectiveDepth }));
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        countNextStepWork('visit:next-step-lifecycle-command-builders:event:636');
        if (required !== true) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }
    return [...fileNames].sort();
}

/**
 * The task-mode flag of a rule-pack command. Outside the default reviews root the rule-pack gates would look for the
 * task-mode artifact beside the preflight, so the path the navigator read is named even when it is the default one.
 */
function buildRulePackTaskModePathParts(repoRoot: string, taskId: string, taskModePath: string | null,
    rulePackCommandPath: string | null): string[] {
    return rulePackCommandPath && taskModePath
        ? buildGatePathCommandParts({ task_mode_path: toRepoDisplayPath(repoRoot, taskModePath) })
        : buildTaskModePathCommandParts(repoRoot, taskId, taskModePath);
}

export function buildPostPreflightRulePackCommandForFiles(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    ruleFileNames: string[],
    taskModePath: string | null,
    preflightCommandPath = buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`),
    rulePackCommandPath: string | null = null
): string {
    // The reload targets the preflight and rule pack the navigator evaluated, so following it never reloads others.
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "POST_PREFLIGHT"',
        ...buildGatePathCommandParts({ preflight_path: preflightCommandPath, artifact_path: rulePackCommandPath }),
        ...buildRulePackTaskModePathParts(repoRoot, taskId, taskModePath, rulePackCommandPath),
        ...ruleFileNames.map((fileName) => (
            `--loaded-rule-file "${buildBundleRelativePath(repoRoot, `live/docs/agent-rules/${fileName}`)}"`
        )),
        '--repo-root "."'
    ].join(' ');
}

/** Typed arguments of a gate bound to the current preflight, from the same values its command renders. */
function buildPreflightGateArguments(
    repoRoot: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    rulePackCommandPath?: string | null
): NextStepPreflightGateArguments {
    return {
        task_id: taskId,
        preflight_path: preflightCommandPath,
        task_mode_path: resolvePreflightTaskModePathCommandValue(repoRoot, taskId, taskModePath, preflightCommandPath),
        ...(rulePackCommandPath ? { rule_pack_path: rulePackCommandPath } : {})
    };
}

function resolvePreflightTaskModePathCommandValue(
    repoRoot: string, taskId: string, taskModePath: string | null, preflightCommandPath: string
): string | null {
    const defaultReviews = path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'runtime/reviews'));
    const preflightDirectory = path.dirname(path.resolve(repoRoot, preflightCommandPath));
    return taskModePath && path.relative(defaultReviews, preflightDirectory)
        ? toRepoDisplayPath(repoRoot, taskModePath)
        : resolveTaskModePathCommandValue(repoRoot, taskId, taskModePath);
}

function buildPreflightGateCommand(
    cliPrefix: string, gate: string, { task_id, ...paths }: NextStepPreflightGateArguments, extra: string[] = []
): string {
    return [`${cliPrefix} gate ${gate}`, `--task-id "${task_id}"`, ...buildGatePathCommandParts(paths),
        ...extra, '--repo-root "."'].join(' ');
}

export function buildPostPreflightRulePackBindInvocation(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskModePath: string | null,
    preflightCommandPath = buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`),
    rulePackCommandPath: string | null = null
): { command: string; arguments: NextStepRulePackBindArguments } {
    return {
        command: [
            `${cliPrefix} gate bind-rule-pack-to-preflight`,
            `--task-id "${taskId}"`,
            ...buildGatePathCommandParts({ preflight_path: preflightCommandPath, artifact_path: rulePackCommandPath }),
            ...buildRulePackTaskModePathParts(repoRoot, taskId, taskModePath, rulePackCommandPath),
            '--repo-root "."'
        ].join(' '),
        arguments: { ...buildPreflightGateArguments(repoRoot, taskId, preflightCommandPath, taskModePath),
            ...(rulePackCommandPath ? { artifact_path: rulePackCommandPath } : {}),
            ...(rulePackCommandPath && taskModePath ? { task_mode_path: toRepoDisplayPath(repoRoot, taskModePath) } : {}) }
    };
}

export function buildCompileGateInvocation(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    rulePackCommandPath?: string | null
): { command: string; arguments: NextStepPreflightGateArguments } {
    const args = buildPreflightGateArguments(repoRoot, taskId, preflightCommandPath, taskModePath, rulePackCommandPath);
    return {
        command: buildPreflightGateCommand(cliPrefix, 'compile-gate', args),
        arguments: args
    };
}

export function buildCompileGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    rulePackCommandPath?: string | null
): string {
    return buildCompileGateInvocation(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath, rulePackCommandPath).command;
}

/**
 * The command and its typed arguments; both are empty until the answers file is complete and valid. With them come
 * the validation phases a PENDING_VALIDATION checklist would record from those answers, so routing can see a pending
 * focused run; any other recorded status carries no candidate phases.
 */
export function buildQualityChecklistInvocation(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    answersTemplatePath?: string | null
): { command: string; arguments: NextStepQualityChecklistArguments | null; candidateValidationPhases?: QualityValidationPhases | null } {
    const absoluteAnswersPath = answersTemplatePath
        ? path.resolve(repoRoot, answersTemplatePath)
        : resolveDefaultQualityChecklistAnswersTemplatePath(repoRoot, taskId);
    let candidateValidationPhases: QualityValidationPhases | null = null;
    try {
        const assessment = assessQualityChecklistAnswersTemplateFile({
            repoRoot,
            taskId,
            preflightPath: preflightCommandPath,
            answersPath: absoluteAnswersPath
        });
        const candidate = assessment.status === 'current' && assessment.template !== null
            ? buildQualityChecklistArtifact({
                repoRoot,
                taskId,
                preflightPath: preflightCommandPath,
                answers: assessment.template
            })
            : null;
        if (!candidate || candidate.status === 'CONFIG_ERROR') {
            return { command: '', arguments: null };
        }
        // Only answers that would record PENDING_VALIDATION wait on a focused run: ACTION_REQUIRED answers record the
        // finding that explains why a case cannot run yet (a disabled case, a setup fix), so they are never preempted.
        candidateValidationPhases = candidate.status === 'PENDING_VALIDATION' ? candidate.validation_phases ?? null : null;
    } catch {
        return { command: '', arguments: null };
    }
    const answersPath = toRepoDisplayPath(repoRoot, absoluteAnswersPath);
    return {
        command: [
            `${cliPrefix} gate quality-checklist`,
            `--task-id "${taskId}"`,
            `--preflight-path "${preflightCommandPath}"`,
            ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
            `--answers-path "${answersPath}"`,
            '--repo-root "."'
        ].join(' '),
        // The quality-checklist gate takes no task-mode path; a nondefault one leaves the command agent-run.
        arguments: resolveTaskModePathCommandValue(repoRoot, taskId, taskModePath)
            ? null
            : { task_id: taskId, preflight_path: preflightCommandPath, answers_path: answersPath },
        candidateValidationPhases
    };
}

/** Typed arguments of a plain review-context build; a focused-test binding keeps the command agent-run. */
export function buildReviewContextArguments(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    reviewDepth: number,
    preflightCommandPath: string,
    taskModePath: string | null
): NextStepBuildReviewContextArguments {
    return {
        ...buildPreflightGateArguments(repoRoot, taskId, preflightCommandPath, taskModePath),
        review_type: reviewType,
        depth: reviewDepth
    };
}

export function buildReviewContextCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewDepth: number,
    preflightCommandPath: string,
    taskModePath: string | null,
    focusedRequiredTestPath?: string | null
): string {
    const focusedRequiredTest = normalizeWorkspaceRelativePath(repoRoot, String(focusedRequiredTestPath || '').trim());
    return [
        `${cliPrefix} gate build-review-context`,
        `--review-type "${reviewType}"`,
        `--depth "${reviewDepth}"`,
        ...buildGatePathCommandParts({ preflight_path: preflightCommandPath,
            task_mode_path: resolvePreflightTaskModePathCommandValue(repoRoot, taskId, taskModePath, preflightCommandPath) }),
        ...(focusedRequiredTest
            ? [`--focused-required-test-path ${quoteCommandValue(focusedRequiredTest)}`]
            : []),
        '--repo-root "."'
    ].join(' ');
}

export function buildRequiredReviewsCheckCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    reviewAuthorshipAttestationDefaults?: Record<string, boolean>
): string {
    return buildRequiredReviewsCheckInvocation(
        repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath, reviewAuthorshipAttestationDefaults
    ).command;
}

/**
 * The required-reviews command and its typed step. With no required review there is nothing to attest. When Garda's
 * own persisted delegated-review evidence proves every required lane, the step carries exactly the attestation the
 * navigator prints and is mechanical. Otherwise the attestation is the agent's statement: the step is an agent
 * boundary that carries the per-lane template the agent answers (`task <id> finish --review-authorship-attestation-json`).
 * The gate validates every supplied attestation unchanged in all cases.
 */
export function buildRequiredReviewsCheckInvocation(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    reviewAuthorshipAttestationDefaults?: Record<string, boolean>,
    rulePackCommandPath?: string | null
): { command: string; boundary: 'mechanical' | 'agent'; arguments: NextStepRequiredReviewsCheckArguments } {
    const args = buildPreflightGateArguments(repoRoot, taskId, preflightCommandPath, taskModePath, rulePackCommandPath);
    const attestationPlaceholder = buildReviewAuthorshipAttestationDefault(
        repoRoot,
        preflightCommandPath,
        reviewAuthorshipAttestationDefaults
    );
    const proven = attestationPlaceholder !== null
        && Object.values(JSON.parse(attestationPlaceholder) as Record<string, boolean>).every((value) => value === true);
    return {
        command: buildPreflightGateCommand(cliPrefix, 'required-reviews-check', args, attestationPlaceholder
            ? [`--review-authorship-attestation-json ${quoteCommandValue(attestationPlaceholder)}`] : []),
        boundary: attestationPlaceholder === null || proven ? 'mechanical' : 'agent',
        arguments: {
            ...args,
            review_authorship_attestation_json: proven ? attestationPlaceholder : null,
            review_authorship_attestation_template: attestationPlaceholder !== null && !proven ? attestationPlaceholder : null
        }
    };
}

function buildReviewAuthorshipAttestationDefault(
    repoRoot: string,
    preflightCommandPath: string,
    reviewAuthorshipAttestationDefaults?: Record<string, boolean>
): string | null {
    try {
        const preflightPath = path.resolve(repoRoot, preflightCommandPath);
        const preflight = JSON.parse(readInvocationTextFile(preflightPath)) as Record<string, unknown>;
        const requiredReviews = isPlainRecord(preflight.required_reviews)
            ? preflight.required_reviews
            : {};
        const requiredReviewTypes = REVIEW_CONTRACTS
            .map(([reviewType]) => reviewType)
            .filter((reviewType) => requiredReviews[reviewType] === true);
        if (requiredReviewTypes.length === 0) {
            return null;
        }
        return JSON.stringify(Object.fromEntries(requiredReviewTypes.map((reviewType) => [
            reviewType,
            reviewAuthorshipAttestationDefaults?.[reviewType] === true
        ])));
    } catch {
        return null;
    }
}

export function buildCompletionGateArguments(
    repoRoot: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    rulePackCommandPath?: string | null
): NextStepPreflightGateArguments {
    return buildPreflightGateArguments(repoRoot, taskId, preflightCommandPath, taskModePath, rulePackCommandPath);
}

export function buildCompletionGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    rulePackCommandPath?: string | null
): string {
    return buildPreflightGateCommand(cliPrefix, 'completion-gate',
        buildCompletionGateArguments(repoRoot, taskId, preflightCommandPath, taskModePath, rulePackCommandPath));
}
