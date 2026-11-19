// Structural view of the task-mode artifact fields this module reads; core must not import gate contracts.
interface NativeStagedTrustWitness {
    schema_version: number; status: string; mode: string;
    object_id_sha256: string | null; content_sha256: string | null; line_fingerprint_sha256: string | null;
}
interface NativeStagedTrust { schema_version: number; salt: string; files: Record<string, NativeStagedTrustWitness> }
interface NativeTaskEntryBaseline {
    changed_files: string[];
    file_hashes: Record<string, string | null>;
    staged_files?: string[] | null;
    staged_trust?: NativeStagedTrust | null;
}
interface NativeTaskEntryArtifact {
    event_source: unknown; status: unknown; outcome: unknown;
    dirty_workspace_baseline: NativeTaskEntryBaseline | null;
    workflow_config_file_hashes: Record<string, string | null> | null;
}
import { validationRelativePath } from './validation-relative-path';

interface NativeIdentityMaps {
    fileHashes: Record<string, string | null> | null;
    stagedTrust: NativeStagedTrust | null | undefined;
    configHashes: Record<string, string | null> | null;
}

// Only the native producer can opt a payload into identity-map serialization.
// The private snapshot cannot be changed by mutating the returned payload.
const nativeEntries = new WeakMap<object, NativeIdentityMaps>();
const hash = (value: unknown) => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const exactPath = (value: string) => {
    if (validationRelativePath(value) !== value) throw new Error('Native task-entry identity map requires exact contained paths.');
};

export function prepareNativeTaskEntryJson<T extends NativeTaskEntryArtifact>(artifact: T): T {
    const payload = structuredClone(artifact);
    if (payload.event_source !== 'enter-task-mode' || payload.status !== 'PASSED' || payload.outcome !== 'PASS')
        throw new Error('Native task-entry identity maps require a successful entry.');
    const baseline = payload.dirty_workspace_baseline;
    if (baseline) {
        const paths = new Set(baseline.changed_files);
        if (paths.size !== baseline.changed_files.length || paths.size > 100_000) throw new Error('Invalid native baseline paths.');
        for (const file of paths) exactPath(file);
        if (Object.keys(baseline.file_hashes).length !== paths.size) throw new Error('Incomplete native baseline digest map.');
        for (const [file, value] of Object.entries(baseline.file_hashes)) {
            if (!paths.has(file) || !hash(value)) throw new Error('Invalid native baseline digest.');
        }
        const trust = baseline.staged_trust;
        if (trust) {
            if (trust.schema_version !== 1 || !/^[a-f0-9]{32}$/u.test(trust.salt)
                || Object.keys(trust).some(key => !['schema_version', 'salt', 'files'].includes(key)))
                throw new Error('Invalid native staged trust header.');
            const staged = new Set(baseline.staged_files ?? []);
            for (const [file, witness] of Object.entries(trust.files)) {
                if (!paths.has(file) || !staged.has(file) || witness.schema_version !== 1
                    || !['present', 'deleted'].includes(witness.status) || !/^[0-7]{6}$/u.test(witness.mode)
                    || Object.keys(witness).length !== 6
                    || Object.keys(witness).some(key => !['schema_version', 'status', 'mode', 'object_id_sha256',
                        'content_sha256', 'line_fingerprint_sha256'].includes(key))
                    || !hash(witness.object_id_sha256) || !hash(witness.content_sha256) || !hash(witness.line_fingerprint_sha256))
                    throw new Error('Invalid native staged trust witness.');
            }
            if (Object.keys(trust.files).length !== staged.size) throw new Error('Incomplete native staged trust.');
        }
    }
    for (const [file, value] of Object.entries(payload.workflow_config_file_hashes ?? {})) {
        exactPath(file);
        if (!hash(value)) throw new Error('Invalid native workflow config digest.');
    }
    nativeEntries.set(payload, structuredClone({ fileHashes: baseline?.file_hashes ?? null,
        stagedTrust: baseline?.staged_trust ?? null, configHashes: payload.workflow_config_file_hashes }));
    const freeze = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    };
    freeze(payload);
    return payload;
}

/** Restore only validated identity facts after the ordinary value redaction. */
export function restoreNativeTaskEntryIdentityMaps(original: unknown, redacted: unknown): unknown {
    const maps = original && typeof original === 'object' ? nativeEntries.get(original) : undefined;
    if (!maps || !redacted || typeof redacted !== 'object') return redacted;
    const result = redacted as NativeTaskEntryArtifact;
    if (result.dirty_workspace_baseline && maps.fileHashes) {
        result.dirty_workspace_baseline.file_hashes = structuredClone(maps.fileHashes);
        result.dirty_workspace_baseline.staged_trust = structuredClone(maps.stagedTrust);
    }
    result.workflow_config_file_hashes = structuredClone(maps.configHashes);
    return result;
}
