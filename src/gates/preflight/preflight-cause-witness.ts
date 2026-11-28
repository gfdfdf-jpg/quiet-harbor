import {
    computeProtectedSnapshotDigest,
    getProtectedControlPlaneRoots,
    readProtectedControlPlaneManifestEnvelope,
    scanProtectedPathHashes
} from '../protected-control-plane/protected-control-plane';
import { stringSha256 } from '../shared/hashing-metrics';

/** PREFLIGHT_FAILED detail: the content witness of the protected inputs at the moment the classification failed. */
export const PREFLIGHT_CAUSE_WITNESS_FIELD = 'protected_cause_witness_sha256';

/** The classification failed on changed protected control-plane files (OP-056, control-plane variant). */
export function hasProtectedOrchestratorWorkRecoverySignal(message: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('protected')
        && normalized.includes('control-plane')
        && normalized.includes('enter-task-mode')
        && normalized.includes('--orchestrator-work');
}

/** The classification failed on changed workflow-config files (OP-056). */
export function hasWorkflowConfigWorkRecoverySignal(message: string): boolean {
    const normalized = String(message || '').toLowerCase();
    if (!normalized.includes('--workflow-config-work')) {
        return false;
    }
    return (
        normalized.includes('workflow config files changed before')
        && normalized.includes('task-mode')
    ) || (
        normalized.includes('protected orchestrator control-plane files')
        && normalized.includes('--orchestrator-work')
    );
}

/** A failure whose cause next-step re-checks live against the current protected files. */
export function hasProtectedPreflightRecoverySignal(message: string): boolean {
    return hasProtectedOrchestratorWorkRecoverySignal(message) || hasWorkflowConfigWorkRecoverySignal(message);
}

/**
 * T-403 content witness of what the live re-evaluation of a protected classification failure reads: every file under the
 * protected control-plane roots (the workflow-config files included), hashed from their bytes without the metadata cache,
 * and the trusted manifest they are compared with. Equal witnesses mean none of those inputs changed. Modification times
 * play no part, so a restore that keeps the old times (Explorer copy, robocopy, `cp -p`) is still seen as a change.
 * Null when any input cannot be read: callers treat an unknown witness as "unchanged" (fail closed).
 */
export function computePreflightCauseWitness(repoRoot: string): string | null {
    try {
        const snapshot = scanProtectedPathHashes(repoRoot, getProtectedControlPlaneRoots(repoRoot), { strict: true });
        const manifest = readProtectedControlPlaneManifestEnvelope(repoRoot);
        if (manifest.status === 'INVALID') {
            return null;
        }
        return stringSha256(JSON.stringify({
            schema_version: 1,
            protected_snapshot_sha256: computeProtectedSnapshotDigest(snapshot),
            manifest_snapshot_sha256: manifest.manifest?.protected_snapshot_sha256 ?? null
        }));
    } catch {
        return null;
    }
}
