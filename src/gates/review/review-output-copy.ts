import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomically } from '../../core/filesystem';
import { resolvePathInsideRepo } from '../shared/helpers';
import { resolveReviewScratchRoot } from './review-scratch-paths';

function comparable(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function hasNoLinks(file: string): boolean {
    let existing = file;
    while (true) {
        try {
            if (fs.lstatSync(existing).isSymbolicLink()) return false;
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        }
        const parent = path.dirname(existing);
        if (parent === existing) return false;
        existing = parent;
    }
    return comparable(fs.realpathSync(existing)) === comparable(existing);
}

function paths(repoRoot: string, taskId: string, reviewType: string, outputPath: string, sha256: string) {
    if (!/^[a-f0-9]{64}$/u.test(sha256) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)
        || taskId.length > 128) return null;
    const directory = path.resolve(resolveReviewScratchRoot(repoRoot), taskId, reviewType);
    const output = resolvePathInsideRepo(outputPath, repoRoot, { allowMissing: true, enforceInside: true });
    if (!output || comparable(path.dirname(output)) !== comparable(directory)
        || !/^review-output(?:-[a-f0-9]{16})?\.md$/u.test(path.basename(output))) return null;
    // Do not write through a symlink or junction, including one that stays in the repo.
    if (!fs.existsSync(directory) || !hasNoLinks(output)) return null;
    const cacheRoot = path.join(resolveReviewScratchRoot(repoRoot), '..', '.reviewer-output-cache');
    const cache = resolvePathInsideRepo(path.join(cacheRoot, taskId, sha256),
        repoRoot, { allowMissing: true, enforceInside: true });
    const legacy = resolvePathInsideRepo(path.join(cacheRoot, sha256), repoRoot, { allowMissing: true, enforceInside: true });
    return cache && legacy && hasNoLinks(cache) && hasNoLinks(legacy) ? { output, cache, legacy } : null;
}

function bytesMatching(file: string, sha256: string): Buffer | null {
    try {
        const bytes = fs.readFileSync(file);
        return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null;
    } catch { return null; }
}

/** Read-only routing hint; the result gate authenticates the launch again before restoring. */
export function hasReviewerOutputCopy(options: {
    repoRoot: string; taskId: string; reviewType: string; outputPath: string; sha256: string;
}): boolean {
    const entry = paths(options.repoRoot, options.taskId, options.reviewType, options.outputPath, options.sha256);
    return !!entry && !!(bytesMatching(entry.cache, options.sha256) || bytesMatching(entry.legacy, options.sha256));
}

/** Capture exact bytes at launch completion; the completed launch binds their digest. */
export function preserveReviewerOutput(options: {
    repoRoot: string; taskId: string; reviewType: string; outputPath: string;
}): { sha256: string; sourceMtimeUtc: string; sourceMtimeMs: number } | null {
    const output = resolvePathInsideRepo(options.outputPath, options.repoRoot, { allowMissing: true, enforceInside: true });
    if (!output || !fs.existsSync(output) || !fs.statSync(output).isFile()) return null;
    const before = fs.statSync(output);
    const bytes = fs.readFileSync(output);
    const after = fs.statSync(output);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || before.ino !== after.ino || before.dev !== after.dev) throw new Error('Reviewer output changed while it was being preserved.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entry = paths(options.repoRoot, options.taskId, options.reviewType, output, sha256);
    if (!entry || comparable(fs.realpathSync(output)) !== comparable(output)) return null;
    if (!bytesMatching(entry.cache, sha256)) writeFileAtomically(entry.cache, bytes);
    return { sha256, sourceMtimeUtc: after.mtime.toISOString(), sourceMtimeMs: after.mtimeMs };
}

/** Only the canonical path may be restored; callers must first authenticate the completed launch. */
export function restoreReviewerOutput(options: {
    repoRoot: string; taskId: string; reviewType: string; outputPath: string; sha256: string;
}): 'intact' | 'restored' | 'lost' {
    const entry = paths(options.repoRoot, options.taskId, options.reviewType, options.outputPath, options.sha256);
    if (!entry) return 'lost';
    if (bytesMatching(entry.output, options.sha256)) return 'intact';
    const bytes = bytesMatching(entry.cache, options.sha256) || bytesMatching(entry.legacy, options.sha256);
    if (!bytes) return 'lost';
    writeFileAtomically(entry.output, bytes);
    return 'restored';
}
