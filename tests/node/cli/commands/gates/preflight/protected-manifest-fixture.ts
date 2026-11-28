import * as fs from 'node:fs';
import {
    buildProtectedControlPlaneManifest,
    computeProtectedSnapshotDigest,
    resolveProtectedControlPlaneManifestPath
} from '../../../../../../src/gates/shared/helpers';

export function writeDriftedProtectedManifest(
    repoRoot: string,
    changedFiles = ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'],
    extraRoots: string[] = []
): void {
    const manifest = buildProtectedControlPlaneManifest(repoRoot, { readOnly: true, strict: true });
    for (const file of changedFiles) {
        manifest.protected_snapshot[file] = '0'.repeat(64);
    }
    manifest.protected_roots.push(...extraRoots);
    manifest.protected_snapshot_sha256 = computeProtectedSnapshotDigest(manifest.protected_snapshot);
    fs.writeFileSync(resolveProtectedControlPlaneManifestPath(repoRoot), JSON.stringify(manifest, null, 2), 'utf8');
}
