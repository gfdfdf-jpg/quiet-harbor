import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isPlainRecord } from './records';
import { TASK_ID_ALLOWED_PATTERN, TASK_ID_MAX_LENGTH } from './task-ids';

export const UPDATE_TASK_RECEIPT_DOMAIN = 'garda.verified-task-update.v1';
export const UPDATE_TASK_RECEIPT_MAX_BYTES = 8 * 1024 * 1024;
export const UPDATE_TASK_RECEIPT_SHA = /^[a-f0-9]{64}$/u;

export interface UpdateTaskVerificationContext {
    readonly transaction: object;
    readonly root: string;
    readonly bundle: string;
    readonly protectedRoots: readonly string[];
}

const taskUpdateVerification = new AsyncLocalStorage<UpdateTaskVerificationContext | null>();

export function withUpdateTaskVerificationContext<T>(context: UpdateTaskVerificationContext | null, operation: () => T): T {
    return taskUpdateVerification.run(context, operation);
}

export function readUpdateTaskVerificationContext(): UpdateTaskVerificationContext | null {
    return taskUpdateVerification.getStore() ?? null;
}

export interface UpdateTaskEntryIdentity {
    task_id: string;
    task_mode_sha256: string;
    task_mode_path: string;
    status: string;
}

export interface UpdateTaskReceiptBody {
    schema_version: 1;
    domain: typeof UPDATE_TASK_RECEIPT_DOMAIN;
    workspace_identity: string;
    transaction_id: string;
    completed_at_utc: string;
    active_entries: UpdateTaskEntryIdentity[];
    protected_roots: string[];
    protected_before: Record<string, string>;
    protected_after: Record<string, string>;
    source_provenance: {
        source_type: 'npm';
        package_name: string;
        exact_package_spec: string;
        resolved_package_version: string;
        resolved_package_integrity: string;
        package_payload_sha256: string;
    };
}

export interface UpdateTaskReceipt extends UpdateTaskReceiptBody {
    hmac_sha256: string;
}

export function updateReceiptDigest(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

export function isUpdateReceiptPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096
        && !/[\\\u0000-\u001f:]/u.test(value) && !value.startsWith('/')
        && value.replace(/\/$/u, '').split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function assertUpdateReceiptEntry(taskId: string, entrySha256: string): void {
    if (taskId.length > TASK_ID_MAX_LENGTH || !TASK_ID_ALLOWED_PATTERN.test(taskId)
        || !UPDATE_TASK_RECEIPT_SHA.test(entrySha256)) {
        throw new Error('Invalid exact update receipt entry identity.');
    }
}

function validSnapshot(value: unknown): value is Record<string, string> {
    return isPlainRecord(value) && Object.keys(value).length <= 50_000
        && Object.entries(value).every(([file, hash]) => isUpdateReceiptPath(file)
            && typeof hash === 'string' && UPDATE_TASK_RECEIPT_SHA.test(hash));
}

export function assertUpdateTaskReceipt(value: unknown): asserts value is UpdateTaskReceipt {
    if (!isPlainRecord(value) || value.schema_version !== 1 || value.domain !== UPDATE_TASK_RECEIPT_DOMAIN
        || !UPDATE_TASK_RECEIPT_SHA.test(String(value.workspace_identity))
        || !UPDATE_TASK_RECEIPT_SHA.test(String(value.hmac_sha256))
        || typeof value.transaction_id !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.transaction_id)
        || typeof value.completed_at_utc !== 'string' || !Number.isFinite(Date.parse(value.completed_at_utc))
        || !validSnapshot(value.protected_before) || !validSnapshot(value.protected_after)
        || !Array.isArray(value.protected_roots) || value.protected_roots.length === 0
        || !value.protected_roots.every(isUpdateReceiptPath)
        || !Array.isArray(value.active_entries) || value.active_entries.length === 0 || value.active_entries.length > 256) {
        throw new Error('Invalid verified update receipt contract.');
    }
    const ids = new Set<string>();
    for (const entry of value.active_entries) {
        if (!isPlainRecord(entry) || typeof entry.task_id !== 'string' || ids.has(entry.task_id)
            || typeof entry.task_mode_sha256 !== 'string' || !isUpdateReceiptPath(entry.task_mode_path)
            || !['IN_PROGRESS', 'IN_REVIEW'].includes(String(entry.status))) {
            throw new Error('Invalid verified update receipt owner.');
        }
        assertUpdateReceiptEntry(entry.task_id, entry.task_mode_sha256);
        ids.add(entry.task_id);
    }
    const source = value.source_provenance;
    if (!isPlainRecord(source) || source.source_type !== 'npm' || source.package_name !== 'garda-agent-orchestrator'
        || typeof source.resolved_package_version !== 'string'
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(source.resolved_package_version)
        || source.exact_package_spec !== `${source.package_name}@${source.resolved_package_version}`
        || typeof source.resolved_package_integrity !== 'string'
        || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u.test(source.resolved_package_integrity)
        || !UPDATE_TASK_RECEIPT_SHA.test(String(source.package_payload_sha256))) {
        throw new Error('Invalid verified update receipt provenance.');
    }
}
