import * as path from 'node:path';
import { isPlainRecord } from '../../core/records';
import { readVerifiedCaptureFile } from '../full-suite/full-suite-repair-capture';
import { parseRepairWipManifest } from '../full-suite/full-suite-repair-manifest';
import { readParentAuditProofRecord } from '../task-audit/task-audit-summary-decomposed-parent-proofs';
import { parentEventHash } from './parent-audit-contract';
import type { ParentCompletionContract } from './parent-audit-types';

/** Qualify the retained archive of a natively restored timeout-repair parent. Its live
 * preflight/full-suite artifacts may now describe the resumed cycle; the archive stays immutable. */
export function assertFullSuiteRepairParentWipPreserved(root: string,
    contract: Pick<ParentCompletionContract, 'task_id' | 'child_task_ids' | 'decomposition_sha256'>,
    events: readonly Record<string, unknown>[]): boolean {
    const splitIndex = events.findIndex(event => parentEventHash(event) === contract.decomposition_sha256);
    const split = events[splitIndex], splitDetails = isPlainRecord(split?.details) ? split.details : null;
    if (split?.event_type !== 'SPLIT_REQUIRED_LATCHED' || splitDetails?.guard_kind !== 'full_suite_repair') return false;
    const sameChildren = (value: unknown): boolean => Array.isArray(value)
        && value.length === contract.child_task_ids.length && new Set(value).size === value.length
        && contract.child_task_ids.every(id => value.includes(id));
    const materializedIndex = events.findIndex((event, index) => index > splitIndex
        && event.event_type === 'FULL_SUITE_REPAIR_TASK_MATERIALIZED' && isPlainRecord(event.details)
        && event.details.split_required_artifact_path === splitDetails.artifact_path);
    const details = events[materializedIndex]?.details;
    if (!isPlainRecord(details) || typeof details.artifact_path !== 'string' || typeof details.artifact_sha256 !== 'string') {
        throw new Error('Full-suite repair parent has no authenticated materialization archive.');
    }
    const artifactPath = path.resolve(root, details.artifact_path);
    const artifact = readParentAuditProofRecord(root, artifactPath, details.artifact_sha256);
    if (artifact.task_id !== contract.task_id || artifact.status !== 'MATERIALIZED'
        || !sameChildren(artifact.child_task_ids) || !sameChildren(details.child_task_ids)
        || artifact.split_required_artifact_path !== splitDetails.artifact_path
        || artifact.split_required_artifact_sha256 !== splitDetails.artifact_sha256
        || typeof artifact.wip_manifest_path !== 'string' || typeof artifact.wip_manifest_sha256 !== 'string'
        || artifact.wip_manifest_path !== details.wip_manifest_path) {
        throw new Error('Full-suite repair parent materialization bindings changed.');
    }
    const manifestPath = path.resolve(root, artifact.wip_manifest_path);
    const parsed = parseRepairWipManifest(root, manifestPath,
        readParentAuditProofRecord(root, manifestPath, artifact.wip_manifest_sha256));
    const manifest = parsed.manifest;
    if (!manifest || parsed.violations.length || manifest.task_id !== contract.task_id || !sameChildren(manifest.child_task_ids)
        || manifest.preflight_sha256 !== artifact.preflight_sha256
        || manifest.full_suite_artifact_sha256 !== artifact.full_suite_artifact_sha256
        || JSON.stringify(manifest.child_scopes) !== JSON.stringify(artifact.child_scopes)) {
        throw new Error('Full-suite repair parent WIP manifest is invalid: ' + parsed.violations.join(' | '));
    }
    const restored = events.some((event, index) => {
        const restore = isPlainRecord(event.details) ? event.details : null;
        const resumed = isPlainRecord(restore?.parent_status_sync) ? restore.parent_status_sync : null;
        return index > materializedIndex && event.event_type === 'FULL_SUITE_REPAIR_WIP_RESTORED' && event.outcome === 'PASS'
            && restore !== null && restore.manifest_path === artifact.wip_manifest_path && sameChildren(restore.child_task_ids)
            && resumed?.task_id === contract.task_id && resumed.next_status === 'IN_PROGRESS'
            && ['updated', 'already_synced'].includes(String(resumed.outcome));
    });
    if (!restored) throw new Error('Full-suite repair parent WIP has no authenticated successful restore.');
    for (const [kind, patch] of Object.entries(manifest.patches)) {
        const snapshot = readVerifiedCaptureFile({ repoRoot: root, filePath: path.resolve(root, patch.path),
            label: 'parent WIP ' + kind + ' patch', expectedSha256: patch.sha256, expectedBytes: patch.bytes });
        if (patch.empty !== (snapshot.content.length === 0)) throw new Error('Full-suite repair parent patch empty flag changed.');
    }
    for (const file of manifest.untracked_files) readVerifiedCaptureFile({ repoRoot: root,
        filePath: path.resolve(root, file.artifact_path), label: 'parent WIP untracked archive',
        expectedSha256: file.sha256, expectedBytes: file.bytes });
    // Recheck both authenticated owners after reading their referenced archives.
    readParentAuditProofRecord(root, manifestPath, artifact.wip_manifest_sha256);
    readParentAuditProofRecord(root, artifactPath, details.artifact_sha256);
    return true;
}
