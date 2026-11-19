import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { bindContainedDestination } from '../../core/contained-filesystem';
import { readTransactionBytes } from '../../core/file-transaction-journal';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import {
    getUpdateReceiptWorkspaceIdentity, publishAuthenticatedUpdateTaskReceipt
} from '../../core/auth/update-task-receipt';
import {
    UPDATE_TASK_RECEIPT_DOMAIN, readUpdateTaskVerificationContext, updateReceiptDigest, withUpdateTaskVerificationContext,
    type UpdateTaskEntryIdentity, type UpdateTaskReceiptBody
} from '../../core/update-task-receipt';
import {
    getProtectedControlPlaneRoots, scanProtectedPathHashes
} from '../../gates/protected-control-plane/protected-control-plane';
import {
    findOtherActiveImplementationOwners, readImplementationTaskMode, withImplementationOwnershipLock
} from '../../gates/workspace/active-implementation-ownership';
import { BUNDLE_SYNC_ITEMS } from '../common';
import type { AcquiredUpdateSource } from '../check-update/check-update-types';
import { readVerifiedRegistryPayload } from '../check-update/check-update-source';
import { consumeVerifiedUpdatePipeline, type UpdatePipelineStageResult } from './update-execution';

interface UpdateReceiptState {
    root: string;
    bundle: string;
    workspaceIdentity: string;
    transactionId: string;
    entries: UpdateTaskEntryIdentity[];
    roots: string[];
    before: Record<string, string>;
    payload: Record<string, string>;
    sourceRoot: string;
    verifiedProtected: Record<string, string> | null;
    provenance: UpdateTaskReceiptBody['source_provenance'];
    verified: boolean;
}

type UpdateReceiptCapture = Readonly<object>;
const captures = new WeakMap<UpdateReceiptCapture, UpdateReceiptState>();

function activeEntries(root: string): UpdateTaskEntryIdentity[] {
    const entries = readTaskQueueEntries(root);
    return findOtherActiveImplementationOwners(root, '', entries).map(taskId => {
        const mode = readImplementationTaskMode(root, taskId);
        if (mode.evidence_status !== 'PASS' || !mode.evidence_hash || !mode.evidence_path) {
            throw new Error(`Cannot bind verified update to invalid active entry ${taskId}.`);
        }
        const evidencePath = path.resolve(mode.evidence_path);
        const relative = path.relative(root, evidencePath).replace(/\\/gu, '/');
        const bytes = readTransactionBytes(root, evidencePath);
        if (!bytes || updateReceiptDigest(bytes) !== mode.evidence_hash) throw new Error('Active entry changed while capturing update.');
        return { task_id: taskId, task_mode_sha256: mode.evidence_hash, task_mode_path: relative,
            status: readTaskQueueStatusToken(entries.get(taskId)!.status)! };
    });
}

function snapshot(root: string, roots: string[]): Record<string, string> {
    const hashes = scanProtectedPathHashes(root, roots, { readOnly: true, noCache: true });
    for (const file of Object.keys(hashes)) bindContainedDestination(root, path.join(root, file));
    return hashes;
}

function packagePayload(root: string): Record<string, string> {
    return snapshot(root, [...BUNDLE_SYNC_ITEMS]);
}

/** Only an acquired allowlisted registry package can supply package provenance. */
export function captureVerifiedTaskUpdate(input: {
    root: string; bundle: string; source: AcquiredUpdateSource;
}): UpdateReceiptCapture | null {
    const { root, bundle, source } = input;
    const { packageName, exactPackageSpec, resolvedPackageVersion, resolvedPackageIntegrity } = source;
    const acquiredPayload = readVerifiedRegistryPayload(source);
    if (!acquiredPayload || source.sourceType !== 'npm' || source.trustPolicy !== 'enforced' || source.trustOverrideUsed
        || packageName !== 'garda-agent-orchestrator'
        || source.releaseProvenanceStatus !== 'NPM_REGISTRY_INTEGRITY_RECORDED'
        || !exactPackageSpec || !resolvedPackageVersion || !resolvedPackageIntegrity) return null;
    return withImplementationOwnershipLock(root, () => {
        const entries = activeEntries(root);
        if (entries.length === 0) return null;
        const payload = packagePayload(source.sourceRoot);
        if (!isDeepStrictEqual(payload, acquiredPayload)) throw new Error('Acquired package payload changed before task update capture.');
        const roots = getProtectedControlPlaneRoots(root);
        const state: UpdateReceiptState = {
            root: path.resolve(root), bundle: path.resolve(bundle), workspaceIdentity: getUpdateReceiptWorkspaceIdentity(root),
            transactionId: randomUUID(), entries, roots, before: snapshot(root, roots), payload,
            sourceRoot: source.sourceRoot, verified: false, verifiedProtected: null,
            provenance: {
                source_type: 'npm', package_name: packageName, exact_package_spec: exactPackageSpec,
                resolved_package_version: resolvedPackageVersion,
                resolved_package_integrity: resolvedPackageIntegrity,
                package_payload_sha256: updateReceiptDigest(JSON.stringify(payload))
            }
        };
        const capture = Object.freeze({});
        captures.set(capture, state);
        return capture;
    });
}

export function withTaskUpdateVerification<T>(capture: UpdateReceiptCapture | null, operation: () => T): T {
    const state = capture ? captures.get(capture) : null;
    if (capture && !state) throw new Error('Unrecognized verified update capture.');
    return withUpdateTaskVerificationContext(capture && state ? Object.freeze({
        transaction: capture, root: state.root, bundle: state.bundle, protectedRoots: Object.freeze([...state.roots])
    }) : null, operation);
}

/** A completed native pipeline attests verification in process; reports and caller flags cannot attest it. */
export function attestVerifiedTaskUpdate(root: string, bundle: string, stage: UpdatePipelineStageResult): void {
    const context = readUpdateTaskVerificationContext();
    if (!context) return;
    const capture = captures.get(context.transaction);
    if (!capture || path.resolve(root) !== capture.root || path.resolve(bundle) !== capture.bundle
        || stage.verifyStatus !== 'PASS' || stage.manifestStatus !== 'PASS' || stage.invariantStatus !== 'PASS'
        || stage.installStatus !== 'PASS' || stage.materializationStatus !== 'PASS') {
        throw new Error('Native update pipeline cannot attest a fully verified task update.');
    }
    const verified = consumeVerifiedUpdatePipeline(stage, context.transaction, capture.root, capture.bundle);
    if (!verified) throw new Error('Only a genuine native pipeline can attest a verified task update.');
    capture.verifiedProtected = verified;
    capture.verified = true;
}

export function publishVerifiedTaskUpdate(handle: UpdateReceiptCapture | null): void {
    if (!handle) return;
    const capture = captures.get(handle);
    if (!capture) throw new Error('Unrecognized verified update capture.');
    if (!capture.verified) {
        // A separate-process lifecycle needs an authenticated handoff before it can publish authority.
        captures.delete(handle);
        return;
    }
    withImplementationOwnershipLock(capture.root, () => {
        if (getUpdateReceiptWorkspaceIdentity(capture.root) !== capture.workspaceIdentity)
            throw new Error('Task update workspace identity changed before publication.');
        const currentEntries = activeEntries(capture.root);
        if (!isDeepStrictEqual(currentEntries, capture.entries))
            throw new Error('Task update active owners changed before publication: '
                + JSON.stringify({ before: capture.entries, after: currentEntries }).slice(0, 2048));
        if (!isDeepStrictEqual(getProtectedControlPlaneRoots(capture.root), capture.roots))
            throw new Error('Task update protected roots changed before publication.');
        const currentPayload = packagePayload(capture.sourceRoot);
        if (!isDeepStrictEqual(currentPayload, capture.payload)) {
            const changed = [...new Set([...Object.keys(currentPayload), ...Object.keys(capture.payload)])]
                .filter(file => currentPayload[file] !== capture.payload[file]);
            throw new Error(`Task update acquired package changed before publication: ${changed.slice(0, 5).join(', ')}`);
        }
        for (const [file, expected] of Object.entries(capture.payload)) {
            const destination = path.join(capture.bundle, file);
            const bytes = readTransactionBytes(capture.root, destination);
            if (!bytes || updateReceiptDigest(bytes) !== expected) {
                throw new Error(`Installed update payload differs from the acquired package: ${file}`);
            }
        }
        const after = snapshot(capture.root, capture.roots);
        if (!isDeepStrictEqual(after, capture.verifiedProtected)) {
            throw new Error('Protected task update state changed after native verification.');
        }
        publishAuthenticatedUpdateTaskReceipt(capture.root, {
            schema_version: 1, domain: UPDATE_TASK_RECEIPT_DOMAIN, workspace_identity: capture.workspaceIdentity,
            transaction_id: capture.transactionId, completed_at_utc: new Date().toISOString(),
            active_entries: capture.entries, protected_roots: capture.roots,
            protected_before: capture.before, protected_after: after,
            source_provenance: capture.provenance
        });
        captures.delete(handle);
    });
}
