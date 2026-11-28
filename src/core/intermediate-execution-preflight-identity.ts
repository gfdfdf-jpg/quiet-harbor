import { createHash } from 'node:crypto';
import * as path from 'node:path';

const EXECUTION_EPOCH_EVENTS = new Set(['TASK_MODE_ENTERED', 'REWORK_STARTED', 'TASK_RESET', 'TASK_DISCARDED',
    'PREFLIGHT_FAILED', 'REVIEW_GATE_FAILED', 'REVIEW_CYCLE_RESTART_FAILED']);

export function isIntermediateExecutionEpochBoundary(eventType: unknown, details?: Record<string, unknown> | null): boolean {
    return typeof eventType === 'string' && (EXECUTION_EPOCH_EVENTS.has(eventType)
        || eventType === 'REVIEW_RECORDED' && /FAILED|fail_for_fix_now/iu.test(String(details?.verdict ?? '')));
}

export function readIntermediateExecutionClassification(value: unknown): {
    preflight_sha256: string; semantic_sha256: string;
} | null {
    if (value == null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native execution classification binding.');
    const raw = value as Record<string, unknown>;
    if (raw.schema_version !== 1 || Object.keys(raw).sort().join(',') !== 'preflight_sha256,schema_version,semantic_sha256'
        || typeof raw.preflight_sha256 !== 'string' || !SHA256.test(raw.preflight_sha256)
        || typeof raw.semantic_sha256 !== 'string' || !SHA256.test(raw.semantic_sha256))
        throw new Error('Invalid native execution classification version or digest.');
    return { preflight_sha256: raw.preflight_sha256, semantic_sha256: raw.semantic_sha256 };
}

export interface IntermediateExecutionPreflightIdentity {
    schema_version: 1;
    repo_root: string;
    worktree_identity: string;
    task_id: string;
    task_mode_sha256: string;
    epoch_sha256: string;
    preflight_semantic_sha256: string;
    identity_sha256: string;
}

export interface IntermediatePreflightLineageEntry {
    sequence: number;
    preflight_sha256: string | null;
    semantic_sha256: string | null;
}

export interface IntermediateExecutionPreflightObservation {
    identity: IntermediateExecutionPreflightIdentity;
    preflight_sha256: string;
    preflight_sequence: number;
}

export interface IntermediateExecutionPreflightCapture {
    schema_version: 1;
    before: IntermediateExecutionPreflightObservation;
    after: IntermediateExecutionPreflightObservation | null;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAXIMUM_PREFLIGHT_BYTES = 8 * 1024 * 1024;
const MAXIMUM_JSON_DEPTH = 128;
const IDENTITY_KEYS = ['schema_version', 'repo_root', 'worktree_identity', 'task_id', 'task_mode_sha256',
    'epoch_sha256', 'preflight_semantic_sha256', 'identity_sha256'].sort();

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function canonicalArray(value: unknown[], keys: readonly string[], ancestors: Set<object>): string {
    if (Object.keys(value).length !== value.length || Object.getOwnPropertyNames(value).length !== value.length + 1
        || !Object.keys(value).every((key, index) => key === String(index)))
        throw new Error('Execution preflight arrays must be dense JSON arrays.');
    const descriptors = Array.from({ length: value.length }, (_item, index) => Object.getOwnPropertyDescriptor(value, String(index))!);
    if (descriptors.some(descriptor => !('value' in descriptor)))
        throw new Error('Execution preflight must not contain property accessors.');
    return '[' + descriptors.map((descriptor, index) => canonicalJson(descriptor.value,
        [...keys, String(index)], ancestors)).join(',') + ']';
}

function canonicalObject(value: Record<string, unknown>, keys: readonly string[], ancestors: Set<object>): string {
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length)
        throw new Error('Execution preflight contains non-JSON properties.');
    return '{' + Object.keys(value).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) throw new Error('Execution preflight must not contain property accessors.');
        return JSON.stringify(key) + ':' + canonicalJson(descriptor.value, [...keys, key], ancestors);
    }).join(',') + '}';
}

function canonicalJson(value: unknown, keys: readonly string[], ancestors: Set<object>): string {
    if (keys.length > MAXIMUM_JSON_DEPTH) throw new Error('Execution preflight JSON depth exceeds its bound.');
    if (keys.length === 2 && keys[0] === 'budget_forecast' && keys[1] === 'timestamp_utc') {
        if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value) || new Date(value).toISOString() !== value)
            throw new Error('Execution preflight requires a valid UTC forecast timestamp.');
        return 'null';
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (!Array.isArray(value) && !isJsonObject(value)) throw new Error('Execution preflight must contain only JSON values.');
    if (ancestors.has(value)) throw new Error('Execution preflight JSON is cyclic.');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Execution preflight contains non-JSON properties.');
    ancestors.add(value);
    try {
        return Array.isArray(value) ? canonicalArray(value, keys, ancestors) : canonicalObject(value, keys, ancestors);
    } finally { ancestors.delete(value); }
}

function digest(value: unknown): string {
    const canonical = canonicalJson(value, [], new Set());
    if (Buffer.byteLength(canonical, 'utf8') > MAXIMUM_PREFLIGHT_BYTES)
        throw new Error('Execution preflight JSON exceeds its byte bound.');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function getIntermediatePreflightSemanticSha256(preflight: unknown): string {
    if (!isJsonObject(preflight)) throw new Error('Execution preflight must be a JSON object.');
    return digest(preflight);
}

export function createIntermediateExecutionPreflightIdentity(options: {
    repoRoot: string; worktreeIdentity: string; taskId: string;
    taskModeSha256: string; epochSha256: string; preflight: unknown;
}): IntermediateExecutionPreflightIdentity {
    if (!path.isAbsolute(options.repoRoot) || options.repoRoot.includes('\0')
        || !options.taskId || options.taskId.includes('\0')
        || ![options.worktreeIdentity, options.taskModeSha256, options.epochSha256]
            .every(value => typeof value === 'string' && SHA256.test(value)))
        throw new Error('Execution identity requires authenticated repository, worktree, task, run and epoch inputs.');
    const binding = { schema_version: 1 as const, repo_root: options.repoRoot,
        worktree_identity: options.worktreeIdentity, task_id: options.taskId,
        task_mode_sha256: options.taskModeSha256, epoch_sha256: options.epochSha256,
        preflight_semantic_sha256: getIntermediatePreflightSemanticSha256(options.preflight) };
    return { ...binding, identity_sha256: digest(binding) };
}

export function isIntermediateExecutionPreflightIdentity(value: unknown): value is IntermediateExecutionPreflightIdentity {
    if (!isJsonObject(value) || value.schema_version !== 1
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(IDENTITY_KEYS)
        || typeof value.repo_root !== 'string' || !path.isAbsolute(value.repo_root) || value.repo_root.includes('\0')
        || typeof value.task_id !== 'string' || !value.task_id || value.task_id.includes('\0')
        || !['worktree_identity', 'task_mode_sha256', 'epoch_sha256', 'preflight_semantic_sha256', 'identity_sha256']
            .every(key => typeof value[key] === 'string' && SHA256.test(value[key] as string))) return false;
    try {
        const { identity_sha256: expected, ...binding } = value;
        return digest(binding) === expected;
    } catch { return false; }
}

export function isIntermediateExecutionPreflightObservation(value: unknown): value is IntermediateExecutionPreflightObservation {
    return isJsonObject(value) && Object.keys(value).sort().join(',') === 'identity,preflight_sequence,preflight_sha256'
        && isIntermediateExecutionPreflightIdentity(value.identity)
        && typeof value.preflight_sha256 === 'string' && SHA256.test(value.preflight_sha256)
        && Number.isSafeInteger(value.preflight_sequence) && Number(value.preflight_sequence) > 0;
}

export function hasEquivalentIntermediatePreflightLineage(options: {
    identity: unknown; currentIdentity: unknown; preflightSha256: string;
    originSequence: number; currentPreflightSequence: number; entries: readonly IntermediatePreflightLineageEntry[];
}): boolean {
    if (!isIntermediateExecutionPreflightIdentity(options.identity)
        || !isIntermediateExecutionPreflightIdentity(options.currentIdentity)
        || options.identity.identity_sha256 !== options.currentIdentity.identity_sha256
        || !SHA256.test(options.preflightSha256) || !Number.isSafeInteger(options.originSequence)) return false;
    const origin = options.entries.filter(entry => entry.sequence <= options.originSequence).at(-1);
    if (!origin || origin.preflight_sha256 !== options.preflightSha256) return false;
    const lineage = options.entries.filter(entry => entry.sequence >= origin.sequence
        && entry.sequence <= options.currentPreflightSequence);
    const currentIdentity = options.currentIdentity;
    return lineage.length > 0 && lineage.at(-1)!.sequence === options.currentPreflightSequence
        && lineage.every(entry => typeof entry.preflight_sha256 === 'string' && SHA256.test(entry.preflight_sha256)
            && entry.semantic_sha256 === currentIdentity.preflight_semantic_sha256);
}
