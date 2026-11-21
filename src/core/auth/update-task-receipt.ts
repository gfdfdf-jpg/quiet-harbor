import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertExistingPathIdentity, bindContainedDestination, ensureContainedDirectory, writeContainedFile } from '../contained-filesystem';
import { readTransactionBytes } from '../file-transaction-journal';
import { withFilesystemLock } from '../../gate-runtime/timeline/task-events-locking';
import {
    assertUpdateReceiptEntry, assertUpdateTaskReceipt, UPDATE_TASK_RECEIPT_MAX_BYTES,
    UPDATE_TASK_RECEIPT_SHA, updateReceiptDigest, type UpdateTaskReceipt, type UpdateTaskReceiptBody
} from '../update-task-receipt';

interface ReceiptContext {
    root: string;
    gitRoot: string;
    storage: string;
    identity: string;
}

function context(repoRoot: string): ReceiptContext {
    const root = fs.realpathSync.native(path.resolve(repoRoot));
    const rootBinding = bindContainedDestination(root, root);
    const gitPath = path.join(root, '.git');
    bindContainedDestination(root, gitPath);
    const stat = fs.lstatSync(gitPath);
    const pointer = stat.isFile() ? readTransactionBytes(root, gitPath, 4096)?.toString().trim().match(/^gitdir:\s*(.+)$/u) : null;
    const git = stat.isDirectory() ? gitPath : pointer ? path.resolve(root, pointer[1]) : '';
    if (!git || !fs.lstatSync(git).isDirectory()) throw new Error('Verified update receipts require native Git metadata.');
    const gitRoot = fs.realpathSync.native(git);
    const gitBinding = bindContainedDestination(gitRoot, git);
    const canonical = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file;
    const identity = updateReceiptDigest(JSON.stringify([canonical(root), canonical(gitRoot),
        ...[rootBinding.existing[0], gitBinding.existing[0]].map(i => [String(i.dev), String(i.ino), String(i.birthtimeNs)])]));
    assertExistingPathIdentity(rootBinding);
    assertExistingPathIdentity(gitBinding);
    return { root, gitRoot, identity, storage: path.join(gitRoot, 'garda-private/update-task-receipts') };
}

function readKey(ctx: ReceiptContext): Buffer | null {
    const bytes = readTransactionBytes(ctx.gitRoot, path.join(ctx.storage, 'key'), 128);
    if (!bytes) return null;
    if (!UPDATE_TASK_RECEIPT_SHA.test(bytes.toString().trim())) throw new Error('Invalid verified update receipt key.');
    return Buffer.from(bytes.toString().trim(), 'hex');
}

function signature(value: unknown, secret: Buffer): Buffer {
    return createHmac('sha256', secret).update(JSON.stringify(value)).digest();
}

function entryPath(ctx: ReceiptContext, taskId: string, entrySha256: string): string {
    assertUpdateReceiptEntry(taskId, entrySha256);
    return path.join(ctx.storage, 'entries', `${taskId}-${entrySha256}.json`);
}

export function getUpdateReceiptWorkspaceIdentity(repoRoot: string): string {
    return context(repoRoot).identity;
}

/** Entry files are inert until the final authenticated transaction seal exists. */
export function publishAuthenticatedUpdateTaskReceipt(repoRoot: string, body: UpdateTaskReceiptBody): void {
    const ctx = context(repoRoot);
    if (body.workspace_identity !== ctx.identity) throw new Error('Update receipt workspace identity changed.');
    ensureContainedDirectory(ctx.gitRoot, ctx.storage);
    fs.chmodSync(ctx.storage, 0o700);
    withFilesystemLock(path.join(ctx.storage, 'publication.lock'), { ownerLabel: 'verified-task-update' }, () => {
        let secret = readKey(ctx);
        if (!secret) {
            secret = randomBytes(32);
            writeContainedFile(ctx.gitRoot, path.join(ctx.storage, 'key'), secret.toString('hex') + '\n');
            fs.chmodSync(path.join(ctx.storage, 'key'), 0o600);
        }
        const receipt: UpdateTaskReceipt = { ...body, hmac_sha256: signature(body, secret).toString('hex') };
        assertUpdateTaskReceipt(receipt);
        const bytes = JSON.stringify(receipt) + '\n';
        if (Buffer.byteLength(bytes) > UPDATE_TASK_RECEIPT_MAX_BYTES) throw new Error('Oversized verified update receipt.');
        ensureContainedDirectory(ctx.gitRoot, path.join(ctx.storage, 'entries'));
        ensureContainedDirectory(ctx.gitRoot, path.join(ctx.storage, 'transactions'));
        const receiptSha = updateReceiptDigest(bytes);
        for (const entry of body.active_entries) {
            writeContainedFile(ctx.gitRoot, entryPath(ctx, entry.task_id, entry.task_mode_sha256), bytes);
        }
        const seal = { domain: 'garda.verified-task-update.commit.v1', workspace_identity: ctx.identity,
            transaction_id: body.transaction_id, receipt_sha256: receiptSha };
        if (context(repoRoot).identity !== ctx.identity) throw new Error('Update receipt Git identity changed during publication.');
        writeContainedFile(ctx.gitRoot, path.join(ctx.storage, 'transactions', `${body.transaction_id}.json`),
            JSON.stringify({ ...seal, hmac_sha256: signature(seal, secret).toString('hex') }) + '\n');
    });
}

/** Exact-entry lookup performs no directory or task-history scans. Invalid evidence fails closed. */
export function readAuthenticatedUpdateTaskReceipt(repoRoot: string, taskId: string, entrySha256: string): UpdateTaskReceipt | null {
    const ctx = context(repoRoot);
    const bytes = readTransactionBytes(ctx.gitRoot, entryPath(ctx, taskId, entrySha256), UPDATE_TASK_RECEIPT_MAX_BYTES);
    if (!bytes) return null;
    const receipt: unknown = JSON.parse(bytes.toString());
    assertUpdateTaskReceipt(receipt);
    const secret = readKey(ctx);
    const { hmac_sha256, ...body } = receipt;
    if (!secret || receipt.workspace_identity !== ctx.identity
        || !receipt.active_entries.some(entry => entry.task_id === taskId && entry.task_mode_sha256 === entrySha256)
        || !timingSafeEqual(signature(body, secret), Buffer.from(hmac_sha256, 'hex'))) {
        throw new Error('Verified update receipt authentication failed.');
    }
    const sealBytes = readTransactionBytes(ctx.gitRoot,
        path.join(ctx.storage, 'transactions', `${receipt.transaction_id}.json`), 4096);
    if (!sealBytes) return null;
    const seal = JSON.parse(sealBytes.toString()) as Record<string, unknown>;
    const { hmac_sha256: sealHmac, ...sealBody } = seal;
    if (seal.domain !== 'garda.verified-task-update.commit.v1' || seal.workspace_identity !== ctx.identity
        || seal.transaction_id !== receipt.transaction_id || seal.receipt_sha256 !== updateReceiptDigest(bytes)
        || !UPDATE_TASK_RECEIPT_SHA.test(String(sealHmac))
        || !timingSafeEqual(signature(sealBody, secret), Buffer.from(String(sealHmac), 'hex'))) {
        throw new Error('Verified update receipt transaction is not committed.');
    }
    return receipt;
}
