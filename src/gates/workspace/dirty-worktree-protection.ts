import { captureWorkspacePlannedFiles, extendWorkspacePlannedFiles } from '../../core/workspace-planned-files';
import { parseStageIndexAuthority } from '../../core/staged-index-fingerprints';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { cloneFrozenJson, cloneJson } from '../../core/immutable-json';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readInvocationPathObservation } from '../../core/invocation-file-observation';
import { createInvocationReadMemoKey, isInvocationReadObservationActive, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { taskModeInvocationRepoKey } from '../task-mode/task-mode-invocation-observation';

import {
    buildGitChangeClassificationEvidence,
    collectGitChangeClassificationSnapshot,
    normalizeGitChangeClassificationEvidence,
    type GitChangeClassificationEvidence
} from '../../core/git-change-classification';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { resolveCanonicalTaskPlanLockPath } from '../../core/task-plan-read';
import { inspectFilesystemLock, type LockHandle } from '../../gate-runtime/task-events-locking';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    stringSha256,
    toPlainRecord
} from '../shared/helpers';

export interface DirtyWorkspaceBaseline {
    detection_source: string;
    include_untracked: boolean;
    changed_files: string[];
    changed_files_sha256: string | null;
    scope_sha256: string | null;
    file_hashes: Record<string, string | null>;
    entry_authorized_files?: string[];
    staged_files?: string[];
    staged_trust?: StagedBaselineTrustEvidence | null;
    git_change_classification?: GitChangeClassificationEvidence | null;
}

export interface StagedBaselineTrustEvidence {
    schema_version: 1;
    salt: string;
    files: Record<string, StagedBaselineTrustFileEvidence>;
}

export interface StagedBaselineTrustFileEvidence {
    schema_version: 1;
    status: 'present' | 'deleted';
    mode: string;
    object_id_sha256: string | null;
    content_sha256: string | null;
    line_fingerprint_sha256: string | null;
}

export interface TaskOwnedDirtyWorkspaceScope {
    owned_files: string[];
    owned_files_sha256: string | null;
    owned_preexisting_files: string[];
    owned_new_files: string[];
    explicitly_selected_preexisting_files: string[];
    delta_changed_preexisting_files: string[];
    untouched_preexisting_files: string[];
    explicitly_authorized_preexisting_files: string[];
    baseline_file_hashes: Record<string, string | null>;
    current_file_hashes: Record<string, string | null>;
    staged_baseline_trust_status: 'NOT_APPLICABLE' | 'PASS' | 'FAIL';
    staged_baseline_trust_violations: string[];
}

export interface DeriveTaskOwnedDirtyWorkspaceScopeOptions {
    isExplicitTaskScope?: boolean;
    plannedChangedFiles?: string[];
    useStaged?: boolean;
}

export interface ProtectedDirtyWorkspaceScope {
    protected_files: string[];
    protected_files_sha256: string | null;
    protected_file_hashes: Record<string, string | null>;
}

export interface ProtectedDirtyWorkspaceDriftResult {
    status: 'NOT_APPLICABLE' | 'PASS' | 'DRIFT_DETECTED';
    assessment: 'NOT_APPLICABLE' | 'INFO_IGNORED_PROTECTED_LOCAL_BASELINE' | 'PROTECTED_LOCAL_BASELINE_DRIFT';
    protected_files: string[];
    protected_files_sha256: string | null;
    baseline_file_hashes: Record<string, string | null>;
    current_file_hashes: Record<string, string | null>;
    changed_files: string[];
    violations: string[];
}

function normalizeRelativePaths(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((value) => normalizePath(value))
            .filter(Boolean)
    )].sort();
}

function normalizeFileHashRecord(value: unknown, allowedPaths: string[]): Record<string, string | null> {
    const source = toPlainRecord(value) || {};
    const result: Record<string, string | null> = {};
    for (const relativePath of allowedPaths) {
        if (!Object.prototype.hasOwnProperty.call(source, relativePath)) {
            result[relativePath] = null;
            continue;
        }
        const hashValue = source[relativePath];
        if (hashValue == null || String(hashValue).trim() === '') {
            result[relativePath] = null;
            continue;
        }
        result[relativePath] = String(hashValue).trim().toLowerCase();
    }
    return result;
}

function resolveWorkspacePath(repoRoot: string, relativePath: string): string | null {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);
    const relativeFromRoot = path.relative(resolvedRoot, resolvedPath);
    if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
        return null;
    }
    return resolvedPath;
}

export function normalizeWorkspaceRelativePath(repoRoot: string, value: unknown): string | null {
    const rawPath = String(value || '').trim();
    if (!rawPath || rawPath.includes('\0')) {
        return null;
    }
    const portablePath = rawPath.replace(/\\/g, '/');
    if (
        path.isAbsolute(rawPath)
        || path.win32.isAbsolute(rawPath)
        || path.posix.isAbsolute(portablePath)
        || /^[a-z]:/i.test(portablePath)
        || portablePath.split('/').some((segment) => segment === '..')
    ) {
        return null;
    }
    const normalizedPath = normalizePath(portablePath);
    if (!normalizedPath || normalizedPath === '.') {
        return null;
    }
    const resolvedPath = resolveWorkspacePath(repoRoot, normalizedPath);
    if (!resolvedPath || !isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })) {
        return null;
    }
    return normalizedPath;
}

export function normalizeWorkspaceRelativePaths(repoRoot: string, values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((value) => normalizeWorkspaceRelativePath(repoRoot, value))
            .filter((value): value is string => !!value)
    )].sort();
}

function gitAuthority<T>(repoRoot: string, query: string, args: string[], parse: (output: string) => T): T {
    const quote = (value: string) => /^[a-zA-Z0-9_./=-]+$/u.test(value) ? value : "'" + value.replace(/'/gu, process.platform === 'win32' ? "''" : "'\"'\"'") + "'";
    const command = ['git', '-C', quote(repoRoot), ...args.map(quote)].join(' ');
    try {
        const result = spawnSyncWithTimeout('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024
        });
        if (result.status !== 0 || result.timedOut || result.error || result.signal || typeof result.stdout !== 'string') {
            throw new Error([result.error?.message, result.stderr, `exit=${result.status}`, result.signal,
                result.timedOut ? 'timeout' : ''].filter(Boolean).join(' '));
        }
        return parse(result.stdout);
    } catch (cause) {
        throw new Error(`Git ${query} authority query failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
            `Diagnose with: ${command}\nAfter repairing Git authority, retry the original gate.`, { cause });
    }
}

function authorityRecords(output: string): string[] {
    if (!output) return [];
    if (!output.endsWith('\0')) throw new Error('Unterminated authority record.');
    const records = output.slice(0, -1).split('\0');
    if (records.some(record => !record)) throw new Error('Empty authority record.');
    return records;
}

function authorityPath(repoRoot: string, value: string): string {
    if (normalizeWorkspaceRelativePath(repoRoot, value) !== value) throw new Error('Invalid or escaping authority path.');
    return value;
}

function exactAuthorityPaths(repoRoot: string, records: string[], wanted: ReadonlySet<string>): string[] {
    const seen = new Set<string>();
    for (const record of records) {
        const file = authorityPath(repoRoot, record);
        if (!wanted.has(file) || seen.has(file)) throw new Error('Foreign or duplicate authority path.');
        seen.add(file);
    }
    return [...seen];
}

function pathIdentity(file: string): string {
    try {
        const stat = fs.lstatSync(file, { bigint: true });
        return [stat.dev, stat.ino, stat.birthtimeNs, stat.mode].join(':');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw error;
    }
}

function getGitTrackedPaths(repoRoot: string, relativePaths: string[], stageZeroPaths: ReadonlyMap<string, string>): Set<string> {
    const normalizedPaths = normalizeWorkspaceRelativePaths(repoRoot, relativePaths);
    if (!normalizedPaths.length) return new Set();
    const identities = new Map(normalizedPaths.map(file => [file, pathIdentity(path.join(repoRoot, file))]));
    const directoryPaths = new Set(normalizedPaths.filter(file => {
        if (identities.get(file) === 'missing') return [...stageZeroPaths.keys()].some(entry => entry.startsWith(file + '/'));
        const stat = fs.lstatSync(path.join(repoRoot, file));
        return stat.isDirectory() && !stat.isSymbolicLink();
    }));
    return gitAuthority(repoRoot, 'tracked', ['ls-files', '-z', '--', ...normalizedPaths.map(file => `:(literal)${file}`)], output => {
        const seen = new Set<string>();
        for (const raw of authorityRecords(output)) {
            const file = authorityPath(repoRoot, raw);
            if (seen.has(file) || !normalizedPaths.some(selected => file === selected || (
                directoryPaths.has(selected) && file.startsWith(selected + '/') && stageZeroPaths.has(file)
            ))) throw new Error('Foreign, unmerged or duplicate tracked authority path.');
            seen.add(file);
        }
        for (const selected of normalizedPaths) {
            if (pathIdentity(path.join(repoRoot, selected)) !== identities.get(selected))
                throw new Error('Directory identity changed during authority query.');
        }
        return seen;
    });
}

function getStagedRenameSourcePaths(repoRoot: string, currentScopeChangedFiles: string[]): string[] {
    const wanted = new Set(normalizeWorkspaceRelativePaths(repoRoot, currentScopeChangedFiles));
    if (!wanted.size) return [];
    return gitAuthority(repoRoot, 'rename', ['diff', '--cached', '--name-status', '-z', '--find-renames', '--diff-filter=R'], output => {
        const records = authorityRecords(output), seen = new Set<string>(), sources: string[] = [];
        if (records.length % 3) throw new Error('Incomplete rename authority.');
        for (let i = 0; i < records.length; i += 3) {
            if (!/^R(?:100|[0-9]{1,2})$/u.test(records[i])) throw new Error('Invalid rename status.');
            const source = authorityPath(repoRoot, records[i + 1]), target = authorityPath(repoRoot, records[i + 2]);
            if (seen.has(source) || seen.has(target)) throw new Error('Duplicate rename authority.');
            seen.add(source); seen.add(target);
            if (wanted.has(target)) sources.push(source);
        }
        return sources.sort();
    });
}

function getStagedChangedFiles(repoRoot: string, relativePaths: string[]): string[] {
    const wanted = new Set(normalizeWorkspaceRelativePaths(repoRoot, relativePaths));
    if (!wanted.size) return [];
    return gitAuthority(repoRoot, 'changed', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACDMRTUXB', '--',
        ...[...wanted].map(file => `:(literal)${file}`)], output => exactAuthorityPaths(repoRoot, authorityRecords(output), wanted));
}

interface StagedIndexEntry {
    path: string;
    status: 'present' | 'deleted';
    mode: string;
    objectId: string;
}

function getStagedDeletedFiles(repoRoot: string, relativePaths: string[]): string[] {
    const wanted = new Set(normalizeWorkspaceRelativePaths(repoRoot, relativePaths));
    if (!wanted.size) return [];
    return gitAuthority(repoRoot, 'deleted', ['diff', '--cached', '--name-status', '-z', '--diff-filter=D', '--',
        ...[...wanted].map(file => `:(literal)${file}`)], output => {
        const records = authorityRecords(output), paths: string[] = [];
        if (records.length % 2) throw new Error('Incomplete deleted authority.');
        for (let i = 0; i < records.length; i += 2) {
            if (records[i] !== 'D') throw new Error('Invalid deleted authority status.');
            paths.push(records[i + 1]);
        }
        return exactAuthorityPaths(repoRoot, paths, wanted);
    });
}

function getHeadTreeEntry(repoRoot: string, relativePath: string): StagedIndexEntry | null {
    return gitAuthority(repoRoot, 'HEAD tree', ['ls-tree', '-z', 'HEAD', '--', `:(literal)${relativePath}`], output => {
        const records = authorityRecords(output);
        if (!records.length) return null;
        const match = records.length === 1 && /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/su.exec(records[0]);
        if (!match || authorityPath(repoRoot, match[3]) !== relativePath) throw new Error('Invalid HEAD tree authority entry.');
        return { path: relativePath, status: 'deleted', mode: match[1], objectId: match[2] };
    });
}

function getStagedIndexEntries(repoRoot: string, relativePaths: string[]): Map<string, StagedIndexEntry> {
    const normalizedPaths = normalizeWorkspaceRelativePaths(repoRoot, relativePaths), wanted = new Set(normalizedPaths);
    const changed = new Set(getStagedChangedFiles(repoRoot, normalizedPaths));
    const deleted = getStagedDeletedFiles(repoRoot, normalizedPaths);
    const entries = new Map<string, StagedIndexEntry>();
    if (!normalizedPaths.length || !changed.size) return entries;
    gitAuthority(repoRoot, 'index', ['ls-files', '-s', '-z', '--', ...normalizedPaths.map(file => `:(literal)${file}`)], output => {
        const seen = new Set<string>();
        for (const entry of parseStageIndexAuthority(output)) {
            const file = authorityPath(repoRoot, entry.path);
            if (entry.stage !== '0' || seen.has(file) || !wanted.has(file)) throw new Error('Unmerged, foreign or duplicate index authority.');
            seen.add(file);
            if (changed.has(file)) entries.set(file, { path: file, status: 'present', mode: entry.mode, objectId: entry.objectId });
        }
    });
    for (const file of deleted) {
        if (entries.has(file)) throw new Error('Git index authority query failed: deleted entry also present.');
        const entry = getHeadTreeEntry(repoRoot, file);
        if (!entry) throw new Error('Git HEAD tree authority query failed: missing deleted entry.');
        entries.set(file, entry);
    }
    if ([...changed].some(file => !entries.has(file))) throw new Error('Git index authority query failed: missing changed entry.');
    return entries;
}

function readStagedBlobText(repoRoot: string, objectId: string): string {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(objectId)) throw new Error('Git blob authority query failed: invalid object ID.');
    return gitAuthority(repoRoot, 'blob', ['cat-file', '-p', objectId], output => output);
}

function buildStagedTrustFileEvidence(
    repoRoot: string,
    salt: string,
    entry: StagedIndexEntry
): StagedBaselineTrustFileEvidence {
    const blobText = readStagedBlobText(repoRoot, entry.objectId);
    const normalizedLines = blobText == null ? null : blobText.replace(/\r\n/g, '\n');
    return {
        schema_version: 1,
        status: entry.status,
        mode: entry.mode,
        object_id_sha256: stringSha256(`${salt}:object:${entry.status}:${entry.mode}:${entry.objectId}`),
        content_sha256: blobText == null ? null : stringSha256(`${salt}:content:${entry.status}:${blobText}`),
        line_fingerprint_sha256: normalizedLines == null
            ? null
            : stringSha256(`${salt}:lines:${entry.status}:${normalizedLines.split('\n').length}:${normalizedLines}`)
    };
}

function buildStagedBaselineTrustEvidence(
    repoRoot: string,
    stagedFiles: string[]
): StagedBaselineTrustEvidence | null {
    const stagedEntries = getStagedIndexEntries(repoRoot, stagedFiles);
    if (stagedEntries.size === 0) {
        return null;
    }
    const salt = randomBytes(16).toString('hex');
    const files: Record<string, StagedBaselineTrustFileEvidence> = {};
    for (const entry of [...stagedEntries.values()].sort((left, right) => left.path.localeCompare(right.path))) {
        files[entry.path] = buildStagedTrustFileEvidence(repoRoot, salt, entry);
    }
    return {
        schema_version: 1,
        salt,
        files
    };
}

function normalizeStagedTrustEvidence(
    value: unknown,
    allowedPaths: string[]
): StagedBaselineTrustEvidence | null {
    const evidence = toPlainRecord(value);
    if (!evidence || evidence.schema_version !== 1) {
        return null;
    }
    const salt = String(evidence.salt || '').trim();
    const rawFiles = toPlainRecord(evidence.files);
    if (!salt || !rawFiles) {
        return null;
    }
    const allowedPathSet = new Set(allowedPaths);
    const files: Record<string, StagedBaselineTrustFileEvidence> = {};
    for (const [filePath, rawEntry] of Object.entries(rawFiles)) {
        if (!allowedPathSet.has(filePath)) {
            continue;
        }
        const entry = toPlainRecord(rawEntry);
        if (!entry || entry.schema_version !== 1) {
            continue;
        }
        files[filePath] = {
            schema_version: 1,
            status: entry.status === 'deleted' ? 'deleted' : 'present',
            mode: String(entry.mode || '').trim(),
            object_id_sha256: String(entry.object_id_sha256 || '').trim().toLowerCase() || null,
            content_sha256: String(entry.content_sha256 || '').trim().toLowerCase() || null,
            line_fingerprint_sha256: String(entry.line_fingerprint_sha256 || '').trim().toLowerCase() || null
        };
    }
    return {
        schema_version: 1,
        salt,
        files
    };
}

function verifyStagedBaselineTrust(
    repoRoot: string,
    baseline: DirtyWorkspaceBaseline,
    relevantBaselineFiles: string[]
): { status: 'NOT_APPLICABLE' | 'PASS' | 'FAIL'; violations: string[] } {
    const relevantFileSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, relevantBaselineFiles));
    const baselineStagedFiles = normalizeWorkspaceRelativePaths(repoRoot, [
        ...(baseline.staged_files || []),
        ...Object.keys(baseline.staged_trust?.files || {})
    ]);
    const baselineStagedRelevantFiles = baselineStagedFiles.filter((relativePath) => relevantFileSet.has(relativePath));
    if (baselineStagedRelevantFiles.length === 0) {
        return { status: 'NOT_APPLICABLE', violations: [] };
    }
    const evidence = baseline.staged_trust || null;
    if (!evidence) {
        return {
            status: 'FAIL',
            violations: [
                `Missing staged dirty-baseline trust evidence for staged baseline files: ${baselineStagedRelevantFiles.join(', ')}.`
            ]
        };
    }
    const stagedEntries = getStagedIndexEntries(repoRoot, baselineStagedRelevantFiles);
    const violations: string[] = [];
    for (const relativePath of baselineStagedRelevantFiles) {
        const entry = stagedEntries.get(relativePath);
        if (!entry) {
            violations.push(`Missing current staged index entry for staged baseline file '${relativePath}'.`);
            continue;
        }
        const expected = evidence.files[relativePath];
        if (!expected) {
            violations.push(`Missing staged trust fingerprint for '${relativePath}'.`);
            continue;
        }
        const actual = buildStagedTrustFileEvidence(repoRoot, evidence.salt, entry);
        if (expected.status !== actual.status) {
            violations.push(`Staged trust status mismatch for '${relativePath}'.`);
        }
        if (expected.mode !== actual.mode) {
            violations.push(`Staged trust mode mismatch for '${relativePath}'.`);
        }
        if (!expected.object_id_sha256 || expected.object_id_sha256 !== actual.object_id_sha256) {
            violations.push(`Staged trust object fingerprint mismatch for '${relativePath}'.`);
        }
        if (!expected.content_sha256 || expected.content_sha256 !== actual.content_sha256) {
            violations.push(`Staged trust content fingerprint mismatch for '${relativePath}'.`);
        }
        if (!expected.line_fingerprint_sha256 || expected.line_fingerprint_sha256 !== actual.line_fingerprint_sha256) {
            violations.push(`Staged trust line fingerprint mismatch for '${relativePath}'.`);
        }
    }
    return {
        status: violations.length > 0 ? 'FAIL' : 'PASS',
        violations
    };
}

function collectExplicitlyAuthorizedDirtyPaths(
    repoRoot: string,
    changedFiles: string[],
    plannedChangedFiles: string[],
    stageZeroPaths: ReadonlyMap<string, string>
): string[] {
    const changedFileSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, changedFiles));
    const normalizedPlannedFiles = normalizeWorkspaceRelativePaths(repoRoot, plannedChangedFiles);
    const trackedFileSet = getGitTrackedPaths(repoRoot, normalizedPlannedFiles, stageZeroPaths);
    const result: string[] = [];
    for (const relativePath of normalizedPlannedFiles) {
        if (changedFileSet.has(relativePath) || trackedFileSet.has(relativePath)) {
            continue;
        }
        const absolutePath = resolveWorkspacePath(repoRoot, relativePath);
        if (!absolutePath) {
            continue;
        }
        try {
            const stat = fs.lstatSync(absolutePath);
            if (stat.isFile() || stat.isSymbolicLink()) {
                result.push(relativePath);
            }
        } catch {
            // A missing planned path is not a pre-task dirty baseline entry.
        }
    }
    return [...new Set(result)].sort();
}

function buildFileHashMap(repoRoot: string, relativePaths: string[]): Record<string, string | null> {
    const normalizedPaths = normalizeWorkspaceRelativePaths(repoRoot, relativePaths);
    const fileHashes: Record<string, string | null> = {};
    for (const relativePath of normalizedPaths) {
        const absolutePath = resolveWorkspacePath(repoRoot, relativePath);
        fileHashes[relativePath] = absolutePath ? fileSha256(absolutePath) : null;
    }
    return fileHashes;
}

function resolveOwnedEntryLockMetadataPath(repoRoot: string, lock: LockHandle, expectedLockPath: string): string {
    const metadataPath = path.join(expectedLockPath, 'owner.json');
    const relativePath = normalizeWorkspaceRelativePath(repoRoot, path.relative(repoRoot, metadataPath));
    const inspection = inspectFilesystemLock(expectedLockPath);
    if (path.resolve(lock.lockPath) !== path.resolve(expectedLockPath) || !relativePath
        || !lock.lockId || inspection.metadata.lock_id !== lock.lockId
        || inspection.metadata.pid !== process.pid || inspection.ownerHostMatchesCurrent !== true
        || !fs.lstatSync(expectedLockPath).isDirectory() || fs.lstatSync(expectedLockPath).isSymbolicLink()
        || !fs.lstatSync(metadataPath).isFile() || fs.lstatSync(metadataPath).isSymbolicLink()) {
        throw new Error('Cannot capture the task-entry baseline without its current implementation ownership lock or task-plan lock.');
    }
    return relativePath;
}

export function captureDirtyWorkspaceBaseline(
    repoRoot: string,
    plannedChangedFiles: string[] = [],
    ownershipLock?: LockHandle,
    taskPlanLock?: { taskId: string; handle: LockHandle },
    approvedPlanSourceFiles: readonly string[] = []
): DirtyWorkspaceBaseline {
    const ownedLocks = [
        ...(ownershipLock ? [{ handle: ownershipLock, path: joinOrchestratorPath(repoRoot, 'runtime/task-queue-locks/active-implementation.lock') }] : []),
        ...(taskPlanLock ? [{ handle: taskPlanLock.handle, path: resolveCanonicalTaskPlanLockPath(repoRoot, taskPlanLock.taskId) }] : [])
    ];
    const ownedLockMetadataPaths = ownedLocks.map(lock => resolveOwnedEntryLockMetadataPath(repoRoot, lock.handle, lock.path));
    const plannedFiles = extendWorkspacePlannedFiles(captureWorkspacePlannedFiles(repoRoot), approvedPlanSourceFiles);
    const gitSnapshot = collectGitChangeClassificationSnapshot(repoRoot, { timeoutMs: DEFAULT_GIT_TIMEOUT_MS, plannedFiles });
    const gitChangeClassification = buildGitChangeClassificationEvidence(gitSnapshot.classification);
    const snapshotChangedFiles = normalizeWorkspaceRelativePaths(
        repoRoot,
        gitChangeClassification.effective_changed_files
    );
    // Preserve the raw Git evidence; only the untracked metadata of this entry's
    // acquired locks is temporary. Tracked metadata and neighbouring WIP remain protected.
    const temporaryLockMetadataPaths = new Set(ownedLockMetadataPaths.filter(relativePath =>
        gitChangeClassification.untracked_files.includes(relativePath)
        && !gitChangeClassification.staged_files.includes(relativePath)));
    const changedFiles = [...new Set([
        ...snapshotChangedFiles,
        ...collectExplicitlyAuthorizedDirtyPaths(repoRoot, snapshotChangedFiles,
            [...plannedChangedFiles, ...approvedPlanSourceFiles], gitSnapshot.stagedBlobFingerprints)
    ])].filter(relativePath => !temporaryLockMetadataPaths.has(relativePath)).sort();
    for (const lock of ownedLocks) resolveOwnedEntryLockMetadataPath(repoRoot, lock.handle, lock.path);
    const changedFileSet = new Set(changedFiles);
    const entryAuthorizedFiles = normalizeWorkspaceRelativePaths(repoRoot, plannedChangedFiles)
        .filter((relativePath) => changedFileSet.has(relativePath));
    const stagedFiles = normalizeWorkspaceRelativePaths(repoRoot, gitChangeClassification.staged_files)
        .filter((relativePath) => changedFileSet.has(relativePath));
    const classificationScopeSha256 = stringSha256(JSON.stringify(gitChangeClassification));
    return {
        detection_source: 'git_auto',
        include_untracked: true,
        changed_files: changedFiles,
        changed_files_sha256: stringSha256(changedFiles.join('\n')),
        scope_sha256: temporaryLockMetadataPaths.size === 0 && changedFiles.length === snapshotChangedFiles.length
            ? classificationScopeSha256
            : stringSha256(`${classificationScopeSha256 || ''}|${changedFiles.join('\n')}`),
        file_hashes: buildFileHashMap(repoRoot, changedFiles),
        entry_authorized_files: entryAuthorizedFiles,
        staged_files: stagedFiles,
        staged_trust: buildStagedBaselineTrustEvidence(repoRoot, stagedFiles),
        git_change_classification: gitChangeClassification
    };
}

const DIRTY_BASELINE_NORMALIZATIONS = createInvocationReadMemoKey<Map<string, DirtyWorkspaceBaseline>>(
    'task-mode-dirty-baseline-normalizations'
);
const DIRTY_BASELINE_PATHS = createInvocationReadMemoKey<string | null>('task-mode-dirty-baseline-path-verdicts');

/** Keep producer normalization live; only this read-side capture uses the invocation registry. */
function captureDirtyBaselinePaths(repoRoot: string | undefined, value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    if (!repoRoot) return [...new Set(value.map(entry => {
        countNextStepWork('visit:dirty_baseline_path');
        return normalizePath(entry);
    }).filter(Boolean))].sort();
    const repoKey = taskModeInvocationRepoKey(repoRoot);
    const observedPaths = value.map((entry): string | null => {
        countNextStepWork('visit:dirty_baseline_path');
        const rawPath = String(entry || '').trim();
        if (!rawPath || rawPath.includes('\0')) return null;
        const portablePath = rawPath.replace(/\\/g, '/');
        if (path.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath) || path.posix.isAbsolute(portablePath)
            || /^[a-z]:/i.test(portablePath) || portablePath.split('/').some(segment => segment === '..')) return null;
        const normalizedPath = normalizePath(portablePath);
        if (!normalizedPath || normalizedPath === '.') return null;
        const resolvedPath = resolveWorkspacePath(repoRoot, normalizedPath);
        if (!resolvedPath) return null;
        return memoizeInvocationRead(DIRTY_BASELINE_PATHS, JSON.stringify([repoKey, normalizedPath]), () => {
            readInvocationPathObservation(resolvedPath);
            // Use the original native containment predicate, including missing-ancestor behavior.
            return isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true }) ? normalizedPath : null;
        }).value;
    });
    return [...new Set(observedPaths.filter((entry): entry is string => entry !== null))].sort();
}

/** Capture fields and native path verdicts before exposing an immutable reduction input. */
function captureDirtyBaselineNormalization(
    baseline: Record<string, unknown>, repoRoot: string | undefined
): DirtyWorkspaceBaseline {
    const changedFiles = captureDirtyBaselinePaths(repoRoot, baseline.changed_files);
    return cloneFrozenJson({
        detection_source: String(baseline.detection_source || 'git_auto').trim() || 'git_auto',
        include_untracked: baseline.include_untracked == null ? true : !!baseline.include_untracked,
        changed_files: changedFiles,
        changed_files_sha256: String(
            baseline.changed_files_sha256 || stringSha256(changedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        scope_sha256: String(baseline.scope_sha256 || '').trim().toLowerCase() || null,
        file_hashes: normalizeFileHashRecord(baseline.file_hashes, changedFiles),
        entry_authorized_files: captureDirtyBaselinePaths(repoRoot, baseline.entry_authorized_files),
        staged_files: captureDirtyBaselinePaths(repoRoot, baseline.staged_files),
        staged_trust: normalizeStagedTrustEvidence(baseline.staged_trust, changedFiles),
        git_change_classification: normalizeGitChangeClassificationEvidence(baseline.git_change_classification)
    });
}

/** Pure reduction: filesystem containment and input fields are already immutable. */
function deriveDirtyWorkspaceBaseline(captured: DirtyWorkspaceBaseline): DirtyWorkspaceBaseline {
    countNextStepWork('derive:dirty_workspace_baseline');
    const changedFiles = new Set<string>();
    for (const file of captured.changed_files) {
        countNextStepWork('visit:dirty_baseline_reduction_path');
        changedFiles.add(file);
    }
    const retained = (files: string[]) => cloneFrozenJson(files.filter(file => {
        countNextStepWork('visit:dirty_baseline_reduction_path');
        return changedFiles.has(file);
    }));
    return Object.freeze({
        ...captured,
        entry_authorized_files: retained(captured.entry_authorized_files || []),
        staged_files: retained(captured.staged_files || [])
    });
}

/** Own-data keys avoid user getters/toJSON. Exotic inputs keep their original uncached behavior. */
function dirtyBaselineDataKey(value: unknown): string | null {
    const digest = createHash('sha256');
    const ancestors = new Set<object>();
    let remaining = 10_000;
    const append = (entry: unknown, depth: number): boolean => {
        if (depth > 64 || --remaining < 0) return false;
        if (entry === null) { digest.update('null;'); return true; }
        switch (typeof entry) {
            case 'undefined': digest.update('undefined;'); return true;
            case 'boolean': digest.update(entry ? 'true;' : 'false;'); return true;
            case 'number': digest.update('number:' + (Object.is(entry, -0) ? '-0' : String(entry)) + ';'); return true;
            case 'bigint': digest.update('bigint:' + entry.toString() + ';'); return true;
            case 'string':
                if (entry.length > 1024 * 1024) return false;
                digest.update('string:' + JSON.stringify(entry) + ';'); return true;
            case 'object': break;
            default: return false;
        }
        if (types.isProxy(entry) || ancestors.has(entry)) return false;
        const prototype = Object.getPrototypeOf(entry);
        if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
        if (Object.getOwnPropertySymbols(entry).length > 0) return false;
        const descriptors = Object.getOwnPropertyDescriptors(entry);
        if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) return false;
        countNextStepWork('visit:dirty_baseline_memo_key_object');
        ancestors.add(entry);
        digest.update(Array.isArray(entry) ? 'array{' : 'record{');
        for (const [key, descriptor] of Object.entries(descriptors)) {
            countNextStepWork('visit:dirty_baseline_memo_key_field');
            digest.update(JSON.stringify(key) + ':enumerable=' + String(descriptor.enumerable) + ':');
            if (!append(descriptor.value, depth + 1)) return false;
        }
        digest.update('}');
        ancestors.delete(entry);
        return true;
    };
    return append(value, 0) ? digest.digest('hex') : null;
}

export function normalizeDirtyWorkspaceBaseline(value: unknown, repoRoot?: string): DirtyWorkspaceBaseline | null {
    if (!isInvocationReadObservationActive()) return normalizeDirtyWorkspaceBaselineNative(value, repoRoot);
    const baseline = toPlainRecord(value);
    if (!baseline) return null;
    const dataKey = dirtyBaselineDataKey(baseline);
    if (!dataKey) return normalizeDirtyWorkspaceBaselineNative(value, repoRoot);
    // A rootless normalization intentionally accepts paths that a repo-bound projection rejects.
    const modeKey = repoRoot ? 'root:' + taskModeInvocationRepoKey(repoRoot) : 'rootless';
    const registry = memoizeInvocationRead(DIRTY_BASELINE_NORMALIZATIONS, '', () => new Map<string, DirtyWorkspaceBaseline>()).value;
    const memoKey = JSON.stringify([modeKey, dataKey]);
    let retained = registry.get(memoKey);
    if (!retained) {
        retained = deriveDirtyWorkspaceBaseline(captureDirtyBaselineNormalization(baseline, repoRoot));
        registry.set(memoKey, retained);
        // Fresh public copies of an unchanged normalized value share its private projection.
        const normalizedKey = dirtyBaselineDataKey(retained);
        if (normalizedKey) registry.set(JSON.stringify([modeKey, normalizedKey]), retained);
    }
    return cloneJson(retained);
}

function normalizeDirtyWorkspaceBaselineNative(value: unknown, repoRoot?: string): DirtyWorkspaceBaseline | null {
    const baseline = toPlainRecord(value);
    if (!baseline) {
        return null;
    }
    const changedFiles = repoRoot
        ? normalizeWorkspaceRelativePaths(repoRoot, baseline.changed_files)
        : normalizeRelativePaths(baseline.changed_files);
    return {
        detection_source: String(baseline.detection_source || 'git_auto').trim() || 'git_auto',
        include_untracked: baseline.include_untracked == null ? true : !!baseline.include_untracked,
        changed_files: changedFiles,
        changed_files_sha256: String(
            baseline.changed_files_sha256 || stringSha256(changedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        scope_sha256: String(baseline.scope_sha256 || '').trim().toLowerCase() || null,
        file_hashes: normalizeFileHashRecord(baseline.file_hashes, changedFiles),
        entry_authorized_files: (repoRoot
            ? normalizeWorkspaceRelativePaths(repoRoot, baseline.entry_authorized_files)
            : normalizeRelativePaths(baseline.entry_authorized_files))
            .filter((relativePath) => changedFiles.includes(relativePath)),
        staged_files: (repoRoot
            ? normalizeWorkspaceRelativePaths(repoRoot, baseline.staged_files)
            : normalizeRelativePaths(baseline.staged_files))
            .filter((relativePath) => changedFiles.includes(relativePath)),
        staged_trust: normalizeStagedTrustEvidence(baseline.staged_trust, changedFiles),
        git_change_classification: normalizeGitChangeClassificationEvidence(
            baseline.git_change_classification
        )
    };
}

export function buildStagedBaselineTrustInputFingerprint(
    baseline: DirtyWorkspaceBaseline | null,
    repoRoot?: string
): string | null {
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(baseline, repoRoot);
    if (!normalizedBaseline) {
        return null;
    }
    const stagedFiles = [...new Set([
        ...(normalizedBaseline.staged_files || []),
        ...Object.keys(normalizedBaseline.staged_trust?.files || {})
    ])].sort();
    if (stagedFiles.length === 0 && !normalizedBaseline.staged_trust) {
        return null;
    }
    const trustFiles = normalizedBaseline.staged_trust?.files || {};
    return stringSha256(JSON.stringify({
        schema_version: 1,
        staged_files: stagedFiles,
        staged_trust: normalizedBaseline.staged_trust
            ? {
                schema_version: normalizedBaseline.staged_trust.schema_version,
                salt: normalizedBaseline.staged_trust.salt,
                files: Object.fromEntries(
                    Object.entries(trustFiles)
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([relativePath, evidence]) => [relativePath, {
                            schema_version: evidence.schema_version,
                            status: evidence.status,
                            mode: evidence.mode,
                            object_id_sha256: evidence.object_id_sha256,
                            content_sha256: evidence.content_sha256,
                            line_fingerprint_sha256: evidence.line_fingerprint_sha256
                        }])
                )
            }
            : null
    })) || null;
}

export function deriveTaskOwnedDirtyWorkspaceScope(
    repoRoot: string,
    baseline: DirtyWorkspaceBaseline | null,
    currentScopeChangedFiles: string[],
    options: DeriveTaskOwnedDirtyWorkspaceScopeOptions = {}
): TaskOwnedDirtyWorkspaceScope | null {
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(baseline, repoRoot);
    if (!normalizedBaseline) {
        return null;
    }

    const currentFiles = normalizeWorkspaceRelativePaths(repoRoot, currentScopeChangedFiles);
    const baselineFileSet = new Set(normalizedBaseline.changed_files);
    const currentFileSet = new Set(currentFiles);
    const stagedRenameSourceSet = new Set(
        options.useStaged === true
            ? getStagedRenameSourcePaths(repoRoot, currentFiles)
            : []
    );
    const explicitlyAuthorizedPreexistingFiles = normalizeWorkspaceRelativePaths(repoRoot, [
        ...(normalizedBaseline.entry_authorized_files || []),
        ...(options.plannedChangedFiles || [])
    ]).filter((relativePath) => baselineFileSet.has(relativePath));
    const explicitlyAuthorizedPreexistingSet = new Set(explicitlyAuthorizedPreexistingFiles);
    const candidateFiles = [...new Set([
        ...normalizedBaseline.changed_files,
        ...currentFiles,
        ...explicitlyAuthorizedPreexistingFiles
    ])].sort();
    const currentFileHashes = buildFileHashMap(repoRoot, candidateFiles);
    const relevantStagedBaselineFiles = normalizedBaseline.changed_files.filter((relativePath) => (
        currentFileSet.has(relativePath)
            || explicitlyAuthorizedPreexistingSet.has(relativePath)
            || stagedRenameSourceSet.has(relativePath)
    ));
    const stagedTrust = options.useStaged === true
        ? verifyStagedBaselineTrust(repoRoot, normalizedBaseline, relevantStagedBaselineFiles)
        : { status: 'NOT_APPLICABLE' as const, violations: [] };
    if (stagedTrust.status === 'FAIL') {
        return {
            owned_files: [],
            owned_files_sha256: stringSha256(''),
            owned_preexisting_files: [],
            owned_new_files: [],
            explicitly_selected_preexisting_files: [],
            delta_changed_preexisting_files: [],
            untouched_preexisting_files: normalizedBaseline.changed_files,
            explicitly_authorized_preexisting_files: explicitlyAuthorizedPreexistingFiles,
            baseline_file_hashes: normalizeFileHashRecord(normalizedBaseline.file_hashes, normalizedBaseline.changed_files),
            current_file_hashes: currentFileHashes,
            staged_baseline_trust_status: 'FAIL',
            staged_baseline_trust_violations: stagedTrust.violations
        };
    }
    const deltaChangedPreexistingFiles = normalizedBaseline.changed_files.filter((relativePath) => {
        if (
            !currentFileSet.has(relativePath)
            && !explicitlyAuthorizedPreexistingSet.has(relativePath)
            && !stagedRenameSourceSet.has(relativePath)
        ) {
            return false;
        }
        return normalizedBaseline.file_hashes[relativePath] !== currentFileHashes[relativePath];
    });
    const explicitlySelectedPreexistingFiles = normalizedBaseline.changed_files.filter((relativePath) => {
        if (!currentFileSet.has(relativePath)) {
            return false;
        }
        return options.isExplicitTaskScope === true || explicitlyAuthorizedPreexistingSet.has(relativePath);
    });
    const ownedPreexistingFiles = [...new Set([
        ...deltaChangedPreexistingFiles,
        ...explicitlySelectedPreexistingFiles
    ])].sort();
    const ownedPreexistingSet = new Set(ownedPreexistingFiles);
    const ownedNewFiles = currentFiles.filter((relativePath) => !baselineFileSet.has(relativePath));
    const ownedFiles = [...new Set([
        ...ownedPreexistingFiles,
        ...ownedNewFiles
    ])].sort();

    return {
        owned_files: ownedFiles,
        owned_files_sha256: stringSha256(ownedFiles.join('\n')),
        owned_preexisting_files: ownedPreexistingFiles,
        owned_new_files: ownedNewFiles,
        explicitly_selected_preexisting_files: explicitlySelectedPreexistingFiles,
        delta_changed_preexisting_files: deltaChangedPreexistingFiles,
        untouched_preexisting_files: normalizedBaseline.changed_files
            .filter((relativePath) => !ownedPreexistingSet.has(relativePath)),
        explicitly_authorized_preexisting_files: explicitlyAuthorizedPreexistingFiles,
        baseline_file_hashes: normalizeFileHashRecord(normalizedBaseline.file_hashes, normalizedBaseline.changed_files),
        current_file_hashes: currentFileHashes,
        staged_baseline_trust_status: stagedTrust.status,
        staged_baseline_trust_violations: stagedTrust.violations
    };
}

export function deriveProtectedDirtyWorkspaceScope(
    repoRoot: string,
    baseline: DirtyWorkspaceBaseline | null,
    taskScopeChangedFiles: string[]
): ProtectedDirtyWorkspaceScope | null {
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(baseline, repoRoot);
    if (!normalizedBaseline) {
        return null;
    }
    const scopeFiles = new Set(normalizeWorkspaceRelativePaths(repoRoot, taskScopeChangedFiles));
    const protectedFiles = normalizedBaseline.changed_files.filter((relativePath) => !scopeFiles.has(relativePath)).sort();
    return {
        protected_files: protectedFiles,
        protected_files_sha256: stringSha256(protectedFiles.join('\n')),
        protected_file_hashes: normalizeFileHashRecord(normalizedBaseline.file_hashes, protectedFiles)
    };
}

export function normalizeProtectedDirtyWorkspaceScope(
    value: unknown,
    repoRoot?: string
): ProtectedDirtyWorkspaceScope | null {
    const scope = toPlainRecord(value);
    if (!scope) {
        return null;
    }
    const protectedFiles = repoRoot
        ? normalizeWorkspaceRelativePaths(repoRoot, scope.protected_files)
        : normalizeRelativePaths(scope.protected_files);
    return {
        protected_files: protectedFiles,
        protected_files_sha256: String(
            scope.protected_files_sha256 || stringSha256(protectedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        protected_file_hashes: normalizeFileHashRecord(scope.protected_file_hashes, protectedFiles)
    };
}

function getPreflightTriggers(preflight: unknown): Record<string, unknown> | null {
    const preflightObject = toPlainRecord(preflight);
    return preflightObject ? toPlainRecord(preflightObject.triggers) : null;
}

export function getTaskOwnedDirtyWorkspaceFilesFromPreflight(repoRoot: string, preflight: unknown): string[] {
    const triggers = getPreflightTriggers(preflight);
    return triggers ? normalizeWorkspaceRelativePaths(repoRoot, triggers.dirty_workspace_task_owned_files) : [];
}

export function getUntouchedDirtyWorkspaceBaselineFilesFromPreflight(repoRoot: string, preflight: unknown): string[] {
    const triggers = getPreflightTriggers(preflight);
    return triggers ? normalizeWorkspaceRelativePaths(repoRoot, triggers.dirty_workspace_untouched_baseline_files) : [];
}

export interface TaskOwnedPreflightScope {
    changed_files: string[];
    task_owned_files: string[];
    excluded_untouched_baseline_files: string[];
}

export function getTaskOwnedPreflightScopeFromPreflight(repoRoot: string, preflight: unknown): TaskOwnedPreflightScope {
    const preflightObject = toPlainRecord(preflight);
    const changedFiles = preflightObject
        ? normalizeWorkspaceRelativePaths(repoRoot, preflightObject.changed_files)
        : [];
    const taskOwnedFiles = getTaskOwnedDirtyWorkspaceFilesFromPreflight(repoRoot, preflight);
    const excludedUntouchedBaselineFiles = getUntouchedDirtyWorkspaceBaselineFilesFromPreflight(repoRoot, preflight);
    if (taskOwnedFiles.length === 0 && excludedUntouchedBaselineFiles.length === 0) {
        return {
            changed_files: changedFiles,
            task_owned_files: [],
            excluded_untouched_baseline_files: []
        };
    }

    const excludedSet = new Set(excludedUntouchedBaselineFiles);
    return {
        changed_files: [...new Set([
            ...changedFiles.filter((relativePath) => !excludedSet.has(relativePath)),
            ...taskOwnedFiles
        ])].sort(),
        task_owned_files: taskOwnedFiles,
        excluded_untouched_baseline_files: excludedUntouchedBaselineFiles
    };
}

export function getProtectedDirtyWorkspaceScopeFromPreflight(preflight: unknown): ProtectedDirtyWorkspaceScope | null {
    const triggers = getPreflightTriggers(preflight);
    if (!triggers) {
        return null;
    }
    return normalizeProtectedDirtyWorkspaceScope({
        protected_files: triggers.dirty_workspace_protected_files,
        protected_files_sha256: triggers.dirty_workspace_protected_files_sha256,
        protected_file_hashes: triggers.dirty_workspace_protected_file_hashes
    });
}

export function detectProtectedDirtyWorkspaceDrift(
    repoRoot: string,
    scope: ProtectedDirtyWorkspaceScope | null
): ProtectedDirtyWorkspaceDriftResult {
    const protectedFiles = scope
        ? normalizeWorkspaceRelativePaths(repoRoot, scope.protected_files)
        : [];
    if (protectedFiles.length === 0) {
        return {
            status: 'NOT_APPLICABLE',
            assessment: 'NOT_APPLICABLE',
            protected_files: [],
            protected_files_sha256: null,
            baseline_file_hashes: {},
            current_file_hashes: {},
            changed_files: [],
            violations: []
        };
    }

    const protectedFileHashes = normalizeFileHashRecord(scope?.protected_file_hashes, protectedFiles);
    const currentFileHashes = buildFileHashMap(repoRoot, protectedFiles);
    const changedFiles = protectedFiles.filter((relativePath) => {
        return protectedFileHashes[relativePath] !== currentFileHashes[relativePath];
    });
    const violations = changedFiles.length > 0
        ? [
            `Protected pre-existing workspace edits changed outside task scope: ${changedFiles.join(', ')}. ` +
            'These files were already dirty at task-mode entry, were not included in the explicit task scope, ' +
            'and no longer match the task-mode baseline. Clean/stash the local baseline drift or restart task mode ' +
            'with the intended files in scope before continuing.'
        ]
        : [];

    return {
        status: changedFiles.length > 0 ? 'DRIFT_DETECTED' : 'PASS',
        assessment: changedFiles.length > 0
            ? 'PROTECTED_LOCAL_BASELINE_DRIFT'
            : 'INFO_IGNORED_PROTECTED_LOCAL_BASELINE',
        protected_files: protectedFiles,
        protected_files_sha256: stringSha256(protectedFiles.join('\n')),
        baseline_file_hashes: protectedFileHashes,
        current_file_hashes: currentFileHashes,
        changed_files: changedFiles,
        violations
    };
}
