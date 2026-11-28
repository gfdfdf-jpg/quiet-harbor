import {
    evaluateProtectedControlPlaneManifest,
    isOrchestratorSourceCheckout,
    isWorkflowConfigControlPlanePath,
    normalizePath,
    toPlainRecord,
    type ProtectedControlPlaneManifestEvidence
} from '../shared/helpers';
import { belongsToProtectedRoots, readProtectedControlPlaneManifestEnvelope } from './protected-control-plane';
import { COMPILE_GENERATED_PROTECTED_ARTIFACT_PATHS } from './compile-generated-protected-artifacts';

export interface ProtectedManifestLifecycleGuardResult {
    status: 'ALLOW' | 'BLOCK';
    manifest_evidence: ProtectedControlPlaneManifestEvidence;
    violations: string[];
}

export interface ProtectedManifestBaselineAllowanceResult {
    status: 'NOT_APPLICABLE' | 'INHERITED_BASELINE_ONLY' | 'SOURCE_CHECKOUT_INHERITED_DRIFT';
    protected_files: string[];
    manifest_changed_files: string[];
}

type WorkflowConfigCompatibilityMatcher = (file: string, sha256: string) => boolean;

// Legacy compatibility can admit newly protected config, but never changes inside a recorded root.
function isCompatibleProtectedManifestConfig(
    manifest: ProtectedControlPlaneManifestEvidence, file: string, sha256: string | null | undefined,
    matches: WorkflowConfigCompatibilityMatcher | undefined
): boolean {
    return !!sha256 && !!manifest.manifest && isWorkflowConfigControlPlanePath(file)
        // The envelope rule (snapshot keys lie inside roots) already implies this; kept as defence in depth.
        && manifest.manifest.protected_snapshot[file] === undefined
        && !belongsToProtectedRoots(file, manifest.manifest.protected_roots)
        && matches?.(file, sha256) === true;
}

/** Drifted files that stay blocking after admitting compatible workflow config bound to the observed bytes. */
export function blockingProtectedManifestChangedFiles(
    manifest: ProtectedControlPlaneManifestEvidence, matches: WorkflowConfigCompatibilityMatcher | undefined
): string[] {
    return manifest.changed_files.filter(file =>
        !isCompatibleProtectedManifestConfig(manifest, file, manifest.observed_changed_file_hashes?.[file], matches));
}

export function resolveProtectedManifestEntry(options: {
    repoRoot: string;
    orchestratorWork: boolean;
    selfGuard: boolean;
    inheritedFiles?: () => string[];
    verifyTree: boolean;
    observedWorkflowConfig?: () => { file: string; sha256: string | null };
    matchesWorkflowConfigCompatibilityBaseline?: (file: string, sha256: string) => boolean;
}): { kind: 'approval' | 'maintenance'; changedFiles: string[]; invalid: boolean; evidence: ProtectedControlPlaneManifestEvidence } | null {
    const manifest = options.verifyTree
        ? evaluateProtectedControlPlaneManifest(options.repoRoot, null, { readOnly: true, strict: true })
        : readProtectedControlPlaneManifestEnvelope(options.repoRoot);
    if (manifest.status === 'INVALID') return { kind: 'maintenance', changedFiles: [], invalid: true, evidence: manifest };
    const isCompatibleConfig = (file: string, sha256: string | null | undefined): boolean =>
        isCompatibleProtectedManifestConfig(manifest, file, sha256, options.matchesWorkflowConfigCompatibilityBaseline);
    if (!options.verifyTree && manifest.manifest && options.observedWorkflowConfig) {
        const { file, sha256 } = options.observedWorkflowConfig();
        if (isWorkflowConfigControlPlanePath(file) && (manifest.manifest.protected_snapshot[file] ?? null) !== sha256
            && !isCompatibleConfig(file, sha256)) {
            return { kind: 'maintenance', changedFiles: [file], invalid: false, evidence: manifest };
        }
    }
    if (manifest.status !== 'DRIFT' || options.orchestratorWork) return null;
    const changedFiles = blockingProtectedManifestChangedFiles(manifest, options.matchesWorkflowConfigCompatibilityBaseline);
    if (changedFiles.length === 0) return null;
    const guard = getProtectedManifestLifecycleGuard({
        repoRoot: options.repoRoot, orchestratorWork: false, phaseLabel: 'task-mode entry',
        manifestEvidence: { ...manifest, changed_files: changedFiles },
        dirtyWorkspaceProtectionStatus: 'PASS', dirtyWorkspaceProtectedFiles: options.inheritedFiles?.() ?? []
    });
    if (guard.status !== 'BLOCK') return null;
    return { kind: options.selfGuard || changedFiles.some(isWorkflowConfigControlPlanePath) ? 'maintenance' : 'approval',
        changedFiles, invalid: false, evidence: manifest };
}

interface ProtectedManifestLifecycleGuardOptions {
    repoRoot: string;
    orchestratorWork: boolean;
    phaseLabel: string;
    preflight?: Record<string, unknown> | null;
    manifestEvidence?: ProtectedControlPlaneManifestEvidence | null;
    dirtyWorkspaceProtectionStatus?: string | null;
    dirtyWorkspaceProtectedFiles?: string[] | null;
    lifecycleOwnedManifestChangedFiles?: string[] | null;
    restartCommandHint?: string;
}

function buildRemediationSuffix(): string {
    return 'Run next-step for the task to get the exact recovery command. Refresh the trusted lifecycle baseline with setup/update/reinit only for trusted baseline drift, or restart task mode with --orchestrator-work if this task intentionally changes orchestrator control-plane files.';
}

function normalizePathList(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((entry) => normalizePath(entry))
            .filter(Boolean)
    )].sort();
}

function getPreflightManifestStatus(preflight: Record<string, unknown> | null | undefined): string {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return String(triggers.protected_control_plane_manifest_status || '').trim().toUpperCase();
}

function getPreflightManifestChangedFiles(preflight: Record<string, unknown> | null | undefined): string[] {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return normalizePathList(triggers.protected_control_plane_manifest_changed_files);
}

function getPreflightDirtyWorkspaceProtectionStatus(preflight: Record<string, unknown> | null | undefined): string {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return String(triggers.dirty_workspace_protection_status || '').trim().toUpperCase();
}

function getPreflightDirtyWorkspaceProtectedFiles(preflight: Record<string, unknown> | null | undefined): string[] {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return normalizePathList(triggers.dirty_workspace_protected_files);
}

export function evaluateProtectedManifestBaselineAllowance(options: {
    orchestratorWork?: boolean;
    manifestStatus: string;
    manifestChangedFiles: string[];
    dirtyWorkspaceProtectionStatus?: string | null;
    dirtyWorkspaceProtectedFiles?: string[] | null;
    sourceCheckoutInheritedDrift?: boolean;
}): ProtectedManifestBaselineAllowanceResult {
    const manifestStatus = String(options.manifestStatus || '').trim().toUpperCase();
    const manifestChangedFiles = normalizePathList(options.manifestChangedFiles);
    const dirtyWorkspaceProtectionStatus = String(options.dirtyWorkspaceProtectionStatus || '').trim().toUpperCase();
    const dirtyWorkspaceProtectedFiles = normalizePathList(options.dirtyWorkspaceProtectedFiles);

    if (options.orchestratorWork || manifestStatus !== 'DRIFT') {
        return {
            status: 'NOT_APPLICABLE',
            protected_files: dirtyWorkspaceProtectedFiles,
            manifest_changed_files: manifestChangedFiles
        };
    }
    if (options.sourceCheckoutInheritedDrift && dirtyWorkspaceProtectedFiles.length === 0) {
        return {
            status: 'SOURCE_CHECKOUT_INHERITED_DRIFT',
            protected_files: dirtyWorkspaceProtectedFiles,
            manifest_changed_files: manifestChangedFiles
        };
    }
    if (dirtyWorkspaceProtectionStatus !== 'PASS') {
        return {
            status: 'NOT_APPLICABLE',
            protected_files: dirtyWorkspaceProtectedFiles,
            manifest_changed_files: manifestChangedFiles
        };
    }
    if (
        dirtyWorkspaceProtectedFiles.length === 0
        || manifestChangedFiles.length === 0
        || !manifestChangedFiles.every((entry) => dirtyWorkspaceProtectedFiles.includes(entry))
    ) {
        return {
            status: 'NOT_APPLICABLE',
            protected_files: dirtyWorkspaceProtectedFiles,
            manifest_changed_files: manifestChangedFiles
        };
    }
    return {
        status: 'INHERITED_BASELINE_ONLY',
        protected_files: dirtyWorkspaceProtectedFiles,
        manifest_changed_files: manifestChangedFiles
    };
}

export function getProtectedManifestLifecycleGuard(
    options: ProtectedManifestLifecycleGuardOptions
): ProtectedManifestLifecycleGuardResult {
    const manifestEvidence = options.manifestEvidence || evaluateProtectedControlPlaneManifest(options.repoRoot, null, true);
    const sourceCheckoutInheritedDrift = manifestEvidence.status === 'DRIFT'
        && manifestEvidence.manifest?.is_source_checkout === true
        && isOrchestratorSourceCheckout(options.repoRoot);
    if (options.orchestratorWork) {
        return {
            status: 'ALLOW',
            manifest_evidence: manifestEvidence,
            violations: []
        };
    }

    const preflightManifestStatus = getPreflightManifestStatus(options.preflight);
    const preflightManifestChangedFiles = getPreflightManifestChangedFiles(options.preflight);
    const dirtyWorkspaceProtectionStatus = String(
        options.dirtyWorkspaceProtectionStatus || getPreflightDirtyWorkspaceProtectionStatus(options.preflight)
    ).trim().toUpperCase();
    const dirtyWorkspaceProtectedFiles = normalizePathList(
        options.dirtyWorkspaceProtectedFiles || getPreflightDirtyWorkspaceProtectedFiles(options.preflight)
    );
    const lifecycleOwnedManifestChangedFiles = new Set(
        normalizePathList(options.lifecycleOwnedManifestChangedFiles).filter((entry) => (
            isOrchestratorSourceCheckout(options.repoRoot)
            && COMPILE_GENERATED_PROTECTED_ARTIFACT_PATHS.includes(entry)
        ))
    );
    const currentManifestChangedFiles = manifestEvidence.changed_files.filter(
        (entry) => !lifecycleOwnedManifestChangedFiles.has(normalizePath(entry))
    );
    const preflightManifestAllowance = evaluateProtectedManifestBaselineAllowance({
        orchestratorWork: options.orchestratorWork,
        manifestStatus: preflightManifestStatus,
        manifestChangedFiles: preflightManifestChangedFiles.length > 0
            ? preflightManifestChangedFiles
            : manifestEvidence.changed_files,
        dirtyWorkspaceProtectionStatus,
        dirtyWorkspaceProtectedFiles,
        sourceCheckoutInheritedDrift
    });
    const currentManifestAllowance = evaluateProtectedManifestBaselineAllowance({
        orchestratorWork: options.orchestratorWork,
        manifestStatus: manifestEvidence.status,
        manifestChangedFiles: currentManifestChangedFiles,
        dirtyWorkspaceProtectionStatus,
        dirtyWorkspaceProtectedFiles,
        sourceCheckoutInheritedDrift: sourceCheckoutInheritedDrift && (
            lifecycleOwnedManifestChangedFiles.size === 0
                ? (
                    preflightManifestStatus !== 'DRIFT'
                    || currentManifestChangedFiles.every((entry) => preflightManifestChangedFiles.includes(entry))
                )
                : currentManifestChangedFiles.every((entry) => preflightManifestChangedFiles.includes(entry))
        )
    });
    const preflightManifestAllowed = preflightManifestAllowance.status === 'INHERITED_BASELINE_ONLY'
        || preflightManifestAllowance.status === 'SOURCE_CHECKOUT_INHERITED_DRIFT';
    const currentManifestAllowed = currentManifestAllowance.status === 'INHERITED_BASELINE_ONLY'
        || currentManifestAllowance.status === 'SOURCE_CHECKOUT_INHERITED_DRIFT'
        || (
            lifecycleOwnedManifestChangedFiles.size > 0
            && manifestEvidence.changed_files.length > 0
            && currentManifestChangedFiles.length === 0
        );
    if (preflightManifestStatus === 'INVALID') {
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest was already invalid before task start: ${normalizePath(manifestEvidence.manifest_path)}. ${buildRemediationSuffix()}`
            ]
        };
    }
    if (preflightManifestStatus === 'DRIFT' && !preflightManifestAllowed) {
        const driftFiles = preflightManifestChangedFiles.length > 0
            ? preflightManifestChangedFiles
            : manifestEvidence.changed_files;
        const remediation = options.restartCommandHint
            ? `Restart task mode with: ${options.restartCommandHint}`
            : buildRemediationSuffix();
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest was already drifted before task start: ${driftFiles.join(', ') || 'unknown protected files'}. ${remediation}`
            ]
        };
    }

    if (manifestEvidence.status === 'INVALID') {
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest is invalid before ${options.phaseLabel}: ${normalizePath(manifestEvidence.manifest_path)}. ${buildRemediationSuffix()}`
            ]
        };
    }
    if (manifestEvidence.status === 'DRIFT' && !currentManifestAllowed) {
        const driftFiles = currentManifestChangedFiles.join(', ') || 'unknown protected files';
        const remediation = options.restartCommandHint
            ? `Restart task mode with: ${options.restartCommandHint}`
            : buildRemediationSuffix();
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest drift detected before ${options.phaseLabel}: ${driftFiles}. ${remediation}`
            ]
        };
    }

    return {
        status: 'ALLOW',
        manifest_evidence: manifestEvidence,
        violations: []
    };
}
