import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { assertCanonicalTaskId } from '../../core/task-ids';
import { normalizePath } from '../shared/helpers';
import {
    buildReviewRemediationDeltaBase,
    getReviewRemediationDeltaBaseViolations,
    REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES,
    type ReviewRemediationDeltaBase
} from './review-remediation-delta-contract';

/**
 * The content a reviewer saw, captured when its review context is built. A review result recorded after the
 * workspace changed still needs the reviewed content as its baseline, so a later fix is measured against what
 * was reviewed. The snapshot carries no authority of its own: it is accepted only when every file's lines
 * reproduce exactly the content hash the review context's tree state recorded for that file.
 */

const MAX_SNAPSHOT_FILE_BYTES = 4 * REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES;

function sha256(value: Buffer | string): string {
    return createHash('sha256').update(value).digest('hex');
}

function normalizedChangedFiles(files: readonly unknown[]): string[] {
    return [...new Set(files.map((file) => normalizePath(String(file || ''))).filter(Boolean))].sort();
}

export function getReviewedTreeDeltaBasePath(repoRoot: string, taskId: string, reviewType: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'tmp', 'reviews', assertCanonicalTaskId(taskId),
        String(reviewType || '').trim().toLowerCase(), 'reviewed-tree-delta-base.json'));
}

/**
 * True when every snapshot entry has exactly the content and mode of the reviewed worktree. A staged review
 * tree, a link, an unreadable file or a file the tree state does not list makes the snapshot unusable.
 */
export function deltaBaseMatchesReviewedTree(
    deltaBase: ReviewRemediationDeltaBase,
    reviewContext: Record<string, unknown>,
    reviewTreeStateSha256: string
): boolean {
    const treeState = isPlainRecord(reviewContext.tree_state) ? reviewContext.tree_state : null;
    if (!treeState || treeState.use_staged !== false
        || String(treeState.tree_state_sha256 || '').trim().toLowerCase() !== reviewTreeStateSha256
        || deltaBase.review_tree_state_sha256 !== reviewTreeStateSha256 || !Array.isArray(treeState.entries)) {
        return false;
    }
    const reviewed = new Map<string, Record<string, unknown>>();
    for (const entry of treeState.entries) {
        if (!isPlainRecord(entry) || !isPlainRecord(entry.worktree)) return false;
        reviewed.set(normalizePath(String(entry.path || '')), entry.worktree);
    }
    return deltaBase.entries.every((entry) => {
        const worktree = reviewed.get(entry.path);
        if (!worktree) return false;
        if (entry.status === 'missing') return worktree.status === 'missing';
        return (entry.status === 'text' || entry.status === 'binary')
            && worktree.status === 'file'
            && entry.content_sha256 !== null
            && worktree.sha256 === entry.content_sha256
            && worktree.mode === entry.mode;
    });
}

/** Text lines that are not redacted must reproduce their line hashes and the file's content hash. */
function entryLinesReproduceContent(entry: ReviewRemediationDeltaBase['entries'][number]): boolean {
    if (entry.status !== 'text' || entry.line_hashes === null) return true;
    if (entry.redaction_applied || !Array.isArray(entry.redacted_lines)
        || entry.redacted_lines.length !== entry.line_hashes.length) {
        return false;
    }
    const text = entry.redacted_lines.join('');
    return entry.redacted_lines.every((line, index) => sha256(Buffer.from(line, 'utf8')) === entry.line_hashes![index])
        && sha256(Buffer.from(text, 'utf8')) === entry.content_sha256
        && sha256(text) === entry.redacted_lines_sha256;
}

/**
 * Captures the reviewed content beside the lane's launch artifacts. Best effort: without a usable snapshot a
 * result recorded after a change has no baseline, and the next fix repeats that review in FULL.
 */
export function writeReviewedTreeDeltaBase(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    changedFiles: readonly unknown[];
    reviewContext: Record<string, unknown>;
}): void {
    let snapshotPath = '';
    try {
        snapshotPath = getReviewedTreeDeltaBasePath(options.repoRoot, options.taskId, options.reviewType);
        const treeState = isPlainRecord(options.reviewContext.tree_state) ? options.reviewContext.tree_state : null;
        const treeStateSha256 = String(treeState?.tree_state_sha256 || '').trim().toLowerCase();
        const deltaBase = buildReviewRemediationDeltaBase({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewTreeStateSha256: treeStateSha256,
            changedFiles: normalizedChangedFiles(options.changedFiles)
        });
        if (!/^[0-9a-f]{64}$/u.test(treeStateSha256)
            || !deltaBaseMatchesReviewedTree(deltaBase, options.reviewContext, treeStateSha256)) {
            fs.rmSync(snapshotPath, { force: true });
            return;
        }
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        fs.writeFileSync(snapshotPath, `${JSON.stringify(deltaBase)}\n`, 'utf8');
    } catch {
        try {
            if (snapshotPath) fs.rmSync(snapshotPath, { force: true });
        } catch {
            // A leftover snapshot is never trusted on its own: reading it re-verifies every file hash.
        }
    }
}

/** The reviewed content for this context, or null when it is missing or does not reproduce the reviewed tree. */
export function readReviewedTreeDeltaBase(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    changedFiles: readonly unknown[];
    reviewContext: Record<string, unknown>;
    reviewTreeStateSha256: string;
}): ReviewRemediationDeltaBase | null {
    try {
        const snapshotPath = getReviewedTreeDeltaBasePath(options.repoRoot, options.taskId, options.reviewType);
        const stat = fs.lstatSync(snapshotPath);
        if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) return null;
        const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as ReviewRemediationDeltaBase;
        if (!isPlainRecord(parsed) || !Array.isArray(parsed.entries) || !Array.isArray(parsed.changed_files)) return null;
        const reviewType = String(options.reviewType || '').trim().toLowerCase();
        if (getReviewRemediationDeltaBaseViolations(parsed, {
            taskId: options.taskId, reviewType, reviewTreeStateSha256: options.reviewTreeStateSha256
        }).length > 0) {
            return null;
        }
        if (JSON.stringify(parsed.changed_files) !== JSON.stringify(normalizedChangedFiles(options.changedFiles))
            || !parsed.entries.every(entryLinesReproduceContent)
            || !deltaBaseMatchesReviewedTree(parsed, options.reviewContext, options.reviewTreeStateSha256)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}
