import * as fs from 'node:fs';
import * as path from 'node:path';

import { readTaskPlan, resolveCanonicalTaskPlanPath } from '../../core/task-plan-read';
import { validateTaskPlan } from '../../schemas/task-plan';
import { expandValueList } from '../../cli/gate-cli/gates-parser';
import { getProtectedControlPlaneRoots, normalizePath, resolvePathInsideRepo, testPathPrefix } from '../shared/helpers';
import { getWorkflowConfigControlPlanePaths } from '../workflow-config/workflow-config-work-paths';

/** Protected orchestrator files of a planned scope, and the workflow-config files among them. */
export interface ProtectedScopeSelection {
    protectedFiles: string[];
    workflowConfigFiles: string[];
}

/**
 * Repo-relative planned paths. Both the --planned-changed-file flags and a task plan's scope_files go through
 * this one normalization, so `..` segments, absolute paths and backslashes resolve against the repo root the
 * same way for both. A path that leaves the repo root is refused; `label` names its source in that error.
 */
export function normalizePlannedChangedFiles(repoRoot: string, rawValues: unknown, label = 'PlannedChangedFile'): string[] {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const unique = new Set<string>();
    for (const rawValue of expandValueList(rawValues || [], { splitDelimiters: true })) {
        const rawPath = String(rawValue || '').trim();
        if (!rawPath) {
            continue;
        }
        const resolvedPath = resolvePathInsideRepo(rawPath, normalizedRepoRoot, { allowMissing: true });
        if (!resolvedPath) {
            continue;
        }
        const relativePath = normalizePath(path.relative(normalizedRepoRoot, resolvedPath));
        if (!relativePath || relativePath === '.' || relativePath.startsWith('../')) {
            throw new Error(`${label} must stay inside repo root. Got '${rawPath}'.`);
        }
        unique.add(relativePath);
    }
    return [...unique].sort();
}

/** Select protected control-plane files from repo-relative planned paths. */
export function selectProtectedControlPlaneScope(repoRoot: string, files: readonly string[]): ProtectedScopeSelection {
    const protectedRoots = getProtectedControlPlaneRoots(repoRoot);
    const workflowConfigPaths = new Set(getWorkflowConfigControlPlanePaths(repoRoot));
    return {
        protectedFiles: files.filter((entry) => testPathPrefix(entry, protectedRoots)),
        workflowConfigFiles: files.filter((entry) => workflowConfigPaths.has(normalizePath(entry)))
    };
}

const GLOB_METACHARACTER = /[*?[{]/u;

/**
 * True when a scope entry that may name more than one file can reach protected control-plane roots: a directory
 * that contains a protected root, or a glob whose literal prefix (the text before its first glob character) is
 * the start of a protected root. A glob without a literal prefix can match anything and counts as protected.
 * Entries inside a protected root are already covered by the prefix check.
 */
function reachesProtectedRoot(entry: string, protectedRoots: readonly string[]): boolean {
    const globStart = entry.search(GLOB_METACHARACTER);
    if (globStart >= 0) {
        const literalPrefix = entry.slice(0, globStart).toLowerCase();
        return literalPrefix === ''
            || testPathPrefix(literalPrefix, [...protectedRoots])
            || protectedRoots.some((root) => root.toLowerCase().startsWith(literalPrefix));
    }
    const directoryPrefix = `${entry.toLowerCase().replace(/\/+$/u, '')}/`;
    return protectedRoots.some((root) => root.toLowerCase().startsWith(directoryPrefix));
}

/**
 * Protected files named by a task plan's scope_files. Task-mode entry checks them together with the
 * planned-file flags, so a plan that touches the protected control plane stops at entry, not before classify.
 * Entries are normalized exactly like the flags. An entry that names a directory containing a protected root,
 * or a glob that can match one, also counts as protected: the plan cannot show which files it means.
 */
export function selectTaskPlanScopeProtection(
    repoRoot: string,
    scopeFiles: readonly string[] | null | undefined
): ProtectedScopeSelection {
    let files: string[];
    try {
        files = normalizePlannedChangedFiles(repoRoot, [...(scopeFiles ?? [])], 'Task plan scope_files entry');
    } catch (error) {
        throw new Error(`Task plan scope_files must name paths inside the repo root: ${(error as Error).message}`);
    }
    const selection = selectProtectedControlPlaneScope(repoRoot, files);
    const protectedRoots = getProtectedControlPlaneRoots(repoRoot);
    const reaching = files.filter((entry) => !selection.protectedFiles.includes(entry) && reachesProtectedRoot(entry, protectedRoots));
    return reaching.length === 0
        ? selection
        : { ...selection, protectedFiles: [...selection.protectedFiles, ...reaching].sort() };
}

/**
 * Protected scope of the canonical approved plan that a fresh task-mode entry would attach, or null when
 * there is none. A missing plan costs one existence check; an invalid one is left to the entry gate to report.
 */
export function readFreshEntryPlanScopeProtection(repoRoot: string, taskId: string): ProtectedScopeSelection | null {
    if (!fs.existsSync(resolveCanonicalTaskPlanPath(repoRoot, taskId))) return null;
    const prepared = readTaskPlan(repoRoot, taskId);
    if (prepared.state !== 'ready' || !prepared.content) return null;
    const selection = selectTaskPlanScopeProtection(repoRoot, validateTaskPlan(JSON.parse(prepared.content)).scope_files);
    return selection.protectedFiles.length > 0 || selection.workflowConfigFiles.length > 0 ? selection : null;
}
