import { readInvocationTextFile } from '../../core/invocation-file-observation';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bindContainedDestination, writeContainedFile } from '../../core/contained-filesystem';
import { readTransactionBytes } from '../../core/file-transaction-journal';
import { isPlainRecord } from '../../core/records';
import {
    computeProtectedSnapshotDigest,
    resolveProtectedControlPlaneManifestPath,
    type ProtectedControlPlaneManifest,
    type ProtectedControlPlaneManifestEvidence
} from '../../core/protected-control-plane-contracts';
import {
    ALL_AGENT_ENTRYPOINT_FILES,
    DEFAULT_BUNDLE_NAME,
    isBundleRootLike,
    isRecognizedBundleName,
    isRecognizedPackageName,
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions
} from '../../materialization/common';
import { ProtectedTraversalError, scanProtectedPathHashesIncremental, type ProtectedHashScanOptions } from './protected-hash-cache';
import { normalizePath } from '../shared/path-utils';

export {
    computeProtectedSnapshotDigest,
    resolveProtectedControlPlaneManifestPath
} from '../../core/protected-control-plane-contracts';
export type {
    ProtectedControlPlaneManifest,
    ProtectedControlPlaneManifestEvidence
} from '../../core/protected-control-plane-contracts';

/**
 * Detect whether repoRoot is the orchestrator source checkout itself.
 */
export function isOrchestratorSourceCheckout(repoRoot: string): boolean {
    const packageJsonPath = path.join(path.resolve(repoRoot), 'package.json');
    if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) {
        return false;
    }
    try {
        const parsed = JSON.parse(readInvocationTextFile(packageJsonPath)) as Record<string, unknown>;
        return isRecognizedPackageName(parsed.name);
    } catch {
        return false;
    }
}

/**
 * Return protected control-plane roots for this workspace.
 * Ordinary workspaces protect only the deployed bundle.
 * The orchestrator source checkout additionally protects root-level runtime sources.
 */
export function getProtectedControlPlaneRoots(repoRoot: string): string[] {
    const effectiveName = resolveBundleNameForTarget(repoRoot);
    const protectsRootControlPlane = isOrchestratorSourceCheckout(repoRoot) || isBundleRootLike(repoRoot);
    const bundleNames = [...new Set([effectiveName, DEFAULT_BUNDLE_NAME].filter(Boolean))];
    const bundleRoots = bundleNames.flatMap((bundleName) => [
        `${bundleName}/src/bin/`,
        `${bundleName}/src/cli/`,
        `${bundleName}/src/gates/`,
        `${bundleName}/src/gate-runtime/`,
        `${bundleName}/src/lifecycle/`,
        `${bundleName}/src/materialization/`,
        `${bundleName}/bin/`,
        `${bundleName}/dist/`,
        `${bundleName}/live/config/workflow-config.json`,
        `${bundleName}/live/config/task-reset-enablement-receipt.json`,
        `${bundleName}/template/config/workflow-config.json`,
        `${bundleName}/live/docs/agent-rules/`
    ]);
    const roots = [
        ...bundleRoots,
        'live/config/task-reset-enablement-receipt.json',
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        ...ALL_AGENT_ENTRYPOINT_FILES,
        ...getProviderOrchestratorProfileDefinitions().map((profile) => profile.orchestratorRelativePath),
        ...getGitHubSkillBridgeProfileDefinitions().map((profile) => profile.relativePath)
    ];

    if (protectsRootControlPlane) {
        roots.push(
            'src/bin/',
            'src/cli/',
            'src/gates/',
            'src/gate-runtime/',
            'src/lifecycle/',
            'src/materialization/',
            'bin/',
            'dist/',
            'live/config/workflow-config.json',
            'live/config/task-reset-enablement-receipt.json',
            'template/config/workflow-config.json',
            'live/docs/agent-rules/'
        );
    }

    return normalizeProtectedControlPlaneRoots(roots);
}

export function isWorkflowConfigControlPlanePathShape(relativePath: string): boolean {
    const normalized = normalizePath(relativePath).replace(/^\.\//, '');
    if (
        normalized === 'live/config/workflow-config.json'
        || normalized === 'template/config/workflow-config.json'
    ) {
        return true;
    }
    const parts = normalized.split('/');
    return parts.length === 4
        && (
            (
                parts[1] === 'live'
                && parts[2] === 'config'
                && parts[3] === 'workflow-config.json'
            )
            || (
                parts[1] === 'template'
                && parts[2] === 'config'
                && parts[3] === 'workflow-config.json'
            )
        );
}

export function isWorkflowConfigControlPlanePath(relativePath: string): boolean {
    const normalized = normalizePath(relativePath).replace(/^\.\//, '');
    if (
        normalized === 'live/config/workflow-config.json'
        || normalized === 'template/config/workflow-config.json'
    ) {
        return true;
    }
    const parts = normalized.split('/');
    return parts.length === 4
        && isRecognizedBundleName(parts[0])
        && isWorkflowConfigControlPlanePathShape(normalized);
}

/**
 * Scan protected roots recursively and return a map of path -> sha256 hash.
 * Delegates to the incremental implementation that uses a persisted metadata
 * cache (mtime + size) to skip unchanged files while preserving identical
 * drift-detection semantics.
 */
export function scanProtectedPathHashes(
    repoRoot: string,
    protectedRoots: string[],
    readOnlyOrOptions: boolean | ProtectedHashScanOptions = false
): Record<string, string> {
    return scanProtectedPathHashesIncremental(repoRoot, protectedRoots, readOnlyOrOptions);
}

/**
 * Build the current trusted protected control-plane manifest from the workspace.
 */
export function buildProtectedControlPlaneManifest(repoRoot: string, options: ProtectedHashScanOptions = {}): ProtectedControlPlaneManifest {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const protectedRoots = getProtectedControlPlaneRoots(normalizedRepoRoot);
    const manifestPath = resolveProtectedControlPlaneManifestPath(normalizedRepoRoot);
    const protectedSnapshot = scanProtectedPathHashes(normalizedRepoRoot, protectedRoots, options);
    return {
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: new Date().toISOString(),
        workspace_root: normalizePath(normalizedRepoRoot),
        orchestrator_root: normalizePath(path.dirname(path.dirname(manifestPath))),
        protected_roots: protectedRoots,
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: isOrchestratorSourceCheckout(normalizedRepoRoot)
    };
}

/**
 * Persist the trusted protected control-plane manifest after a lifecycle action.
 */
export function writeProtectedControlPlaneManifest(repoRoot: string,
    options: ProtectedHashScanOptions & { expectedSnapshotSha256?: string } = {}): string {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    bindContainedDestination(repoRoot, manifestPath);
    const manifest = buildProtectedControlPlaneManifest(repoRoot, options);
    if (options.expectedSnapshotSha256 && manifest.protected_snapshot_sha256 !== options.expectedSnapshotSha256)
        throw new Error('Protected manifest repair requires the exact inspected snapshot.');
    writeContainedFile(repoRoot, manifestPath, JSON.stringify(manifest, null, 2));
    return manifestPath;
}

/**
 * Compare the current protected snapshot with the last trusted lifecycle manifest.
 */
export function readProtectedControlPlaneManifestEnvelope(repoRoot: string): ProtectedControlPlaneManifestEvidence {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    const result = { manifest_path: normalizePath(manifestPath), changed_files: [], manifest: null };
    try {
        const bytes = readTransactionBytes(repoRoot, manifestPath, 16 * 1024 * 1024);
        if (!bytes) return { ...result, status: 'MISSING' };
        const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!isProtectedManifest(manifest, repoRoot, manifestPath)) return { ...result, status: 'INVALID' };
        return { ...result, status: 'MATCH', manifest };
    } catch {
        return { ...result, status: 'INVALID' };
    }
}

export function belongsToProtectedRoots(file: string, roots: readonly string[]): boolean {
    return roots.some(root => root.endsWith('/') ? file.startsWith(root) : file === root);
}

function isNormalizedProtectedPath(value: unknown, allowDirectory: boolean): value is string {
    if (typeof value !== 'string' || !value || /[\\:\p{Cc}]/u.test(value) || value !== value.trim()) return false;
    const file = allowDirectory ? value.replace(/\/$/u, '') : value;
    return file.split('/').every(part => part && part !== '.' && part !== '..');
}

function isProtectedManifest(value: unknown, repoRoot: string, manifestPath: string): value is ProtectedControlPlaneManifest {
    if (!isPlainRecord(value) || value.schema_version !== 1 || value.event_source !== 'refresh-protected-control-plane-manifest'
        || typeof value.timestamp_utc !== 'string' || !Number.isFinite(Date.parse(value.timestamp_utc))
        || typeof value.workspace_root !== 'string' || !path.isAbsolute(value.workspace_root)
        || typeof value.orchestrator_root !== 'string' || !path.isAbsolute(value.orchestrator_root)
        || path.relative(value.workspace_root, value.orchestrator_root) !== path.relative(repoRoot, path.dirname(path.dirname(manifestPath)))
        || typeof value.is_source_checkout !== 'boolean') return false;
    const roots: unknown = value.protected_roots;
    const snapshot = value.protected_snapshot;
    const sha256 = /^[a-f0-9]{64}$/u;
    const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!Array.isArray(roots) || !roots.length || !roots.every(root => isNormalizedProtectedPath(root, true))
        || new Set(roots.map(pathKey)).size !== roots.length || !isPlainRecord(snapshot)) return false;
    const snapshotEntries = Object.entries(snapshot);
    if (new Set(Object.keys(snapshot).map(pathKey)).size !== snapshotEntries.length || !snapshotEntries.every(([file, hash]) => isNormalizedProtectedPath(file, false)
        && belongsToProtectedRoots(file, roots) && typeof hash === 'string' && sha256.test(hash))) return false;
    return value.protected_snapshot_sha256 === computeProtectedSnapshotDigest(snapshot as Record<string, string>);
}

export function evaluateProtectedControlPlaneManifest(
    repoRoot: string,
    currentSnapshot?: Record<string, string> | null,
    readOnlyOrOptions: boolean | ProtectedHashScanOptions = false
): ProtectedControlPlaneManifestEvidence {
    const envelope = readProtectedControlPlaneManifestEnvelope(repoRoot);
    const manifest = envelope.manifest;
    if (!manifest) return envelope;
    const strict = typeof readOnlyOrOptions === 'object' && !!readOnlyOrOptions.strict;
    let snapshot: Record<string, string>;
    try {
        snapshot = currentSnapshot ?? scanProtectedPathHashes(repoRoot, getProtectedControlPlaneRoots(repoRoot), readOnlyOrOptions);
    } catch (error) {
        const traversal = error instanceof ProtectedTraversalError ? { traversal_error: { path: error.path, code: error.code } } : {};
        return { ...envelope, ...traversal, status: 'INVALID' };
    }
    const observedDigest = computeProtectedSnapshotDigest(snapshot);
    const evidence = strict ? { ...envelope, observed_snapshot_sha256: observedDigest } : envelope;
    if (!strict && observedDigest === manifest.protected_snapshot_sha256) return evidence;
    const allProtectedPaths = new Set([
        ...Object.keys(manifest.protected_snapshot),
        ...Object.keys(snapshot).filter(file => strict || belongsToProtectedRoots(file, manifest.protected_roots))
    ]);
    const changedFiles = [...allProtectedPaths].filter(file => manifest.protected_snapshot[file] !== snapshot[file]).sort();
    return {
        ...evidence, status: changedFiles.length ? 'DRIFT' : 'MATCH', changed_files: changedFiles,
        ...(strict && changedFiles.length ? {
            observed_changed_file_hashes: Object.fromEntries(changedFiles.map(file => [file, snapshot[file] ?? null]))
        } : {})
    };
}

/**
 * Normalize protected control-plane roots.
 * Directory roots should end with `/`; file targets should not.
 */
export function normalizeProtectedControlPlaneRoots(roots: unknown[] | null | undefined): string[] {
    const set = new Set<string>();
    for (const root of (roots || [])) {
        const original = String(root == null ? '' : root).replace(/\\/g, '/');
        const isDirectoryLike = /\/$/.test(original);
        let value = normalizePath(root);
        if (!value) continue;
        value = value.replace(/\/+$/, '');
        if (!value) continue;
        if (isDirectoryLike) value += '/';
        set.add(value);
    }
    return [...set].sort();
}
