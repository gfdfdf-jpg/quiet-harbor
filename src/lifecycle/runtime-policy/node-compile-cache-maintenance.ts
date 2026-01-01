import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
    assertBoundContainedRemovalBoundary,
    assertContainedDestination,
    bindContainedDestination,
    removeBoundContainedPath,
    type ContainedDestination
} from '../../core/contained-filesystem';
import { resolveNodeCompileCacheRoot } from '../../bin/garda/node-compile-cache-path';

export const NODE_COMPILE_CACHE_BUDGET_MS = 2000;
export const NODE_COMPILE_CACHE_UPDATE_BUDGET_MS = 30_000;
const MARKER_PREFIX = '.garda-prune-';
const MARKER_PATTERN = /^\.garda-prune-\d{4}-W\d{2}$/;
const TRASH_PREFIX = '.garda-trash-';
const CONSECUTIVE_FAILURE_LIMIT = 128;
const ERROR_DETAIL_LIMIT = 10;
const ERROR_MESSAGE_LIMIT = 512;

export interface CompileCachePruneOptions {
    cacheRoot?: string;
    now?: Date;
    ignoreThrottle?: boolean;
    trashOnly?: boolean;
    dryRun?: boolean;
    budgetMs?: number;
}

export interface CompileCachePruneResult {
    renamed_directory_count: number;
    removed_entry_count: number;
    removed_directory_count: number;
    removed_logical_bytes: number;
    skipped_reason: string | null;
    errors: string[];
    error_count: number;
    warning_errors: string[];
}

function emptyResult(): CompileCachePruneResult {
    return {
        renamed_directory_count: 0, removed_entry_count: 0, removed_directory_count: 0,
        removed_logical_bytes: 0, skipped_reason: null, errors: [], error_count: 0, warning_errors: []
    };
}

function recordError(result: CompileCachePruneResult, error: unknown, advisory = false): void {
    result.error_count += 1;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MESSAGE_LIMIT);
    if (result.errors.length < ERROR_DETAIL_LIMIT) {
        result.errors.push(message);
    }
    if (!advisory && result.warning_errors.length < ERROR_DETAIL_LIMIT) result.warning_errors.push(message);
}

function utcIsoWeek(now: Date): string {
    const thursday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
    const year = thursday.getUTCFullYear();
    const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
}

// Inspect only the marker's identity, never its contents. Any existing entry
// (including a directory, FIFO or link) counts as a claim.
function claimWeek(root: ContainedDestination, week: string): boolean {
    const marker = path.join(root.root, `${MARKER_PREFIX}${week}`);
    assertContainedDestination(root);
    if (fs.lstatSync(marker, { throwIfNoEntry: false })) return false;
    try {
        const descriptor = fs.openSync(marker, 'wx', 0o600);
        fs.closeSync(descriptor);
        return true;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
    }
}

function resetBuilds(root: ContainedDestination, week: string, result: CompileCachePruneResult): void {
    assertContainedDestination(root);
    const directory = fs.opendirSync(root.path);
    try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (entry.name.startsWith(TRASH_PREFIX)) continue;
            try {
                assertContainedDestination(root);
                const candidate = path.join(root.path, entry.name);
                const stat = fs.lstatSync(candidate);
                if (MARKER_PATTERN.test(entry.name)) {
                    if (entry.name < `${MARKER_PREFIX}${week}` && stat.isFile()) {
                        removeBoundContainedPath(bindContainedDestination(root.root, candidate));
                    }
                    continue;
                }
                if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
                const binding = bindContainedDestination(root.root, candidate);
                assertBoundContainedRemovalBoundary(binding);
                const trash = bindContainedDestination(root.root, path.join(root.path, `${TRASH_PREFIX}${randomUUID()}`));
                assertContainedDestination(binding);
                assertContainedDestination(trash);
                try {
                    fs.renameSync(binding.path, trash.path);
                } catch (error: unknown) {
                    const code = (error as NodeJS.ErrnoException | null)?.code;
                    recordError(result, error, code === 'EPERM' || code === 'EBUSY' || code === 'EACCES');
                    continue;
                }
                result.renamed_directory_count++;
            } catch (error: unknown) {
                recordError(result, error);
            }
        }
    } finally {
        directory.closeSync();
    }
}

interface RemovalPass {
    deadline: number;
    consecutiveFailures: number;
    result: CompileCachePruneResult;
}

function canRemove(pass: RemovalPass): boolean {
    return pass.consecutiveFailures < CONSECUTIVE_FAILURE_LIMIT && performance.now() < pass.deadline;
}

function removalFailed(pass: RemovalPass, error: unknown): void {
    pass.consecutiveFailures++;
    recordError(pass.result, error);
}

// Keep one handle open per directory for this pass: failed entries are visited
// once, while successful removals disappear before the next call reopens it.
function sweepTrashDirectory(binding: ContainedDestination, pass: RemovalPass, depth = 0): boolean {
    if (!canRemove(pass)) return false;
    if (depth > 128) throw new Error('Compile cache trash depth limit exceeded.');
    assertBoundContainedRemovalBoundary(binding);
    const directory = fs.opendirSync(binding.path, { bufferSize: 32 });
    let complete = false;
    let allRemoved = true;
    try {
        while (canRemove(pass)) {
            assertContainedDestination(binding);
            const entry = directory.readSync();
            if (!entry) {
                complete = true;
                break;
            }
            try {
                const child = bindContainedDestination(binding.root, path.join(binding.path, entry.name));
                assertBoundContainedRemovalBoundary(child);
                const stat = fs.lstatSync(child.path);
                if (stat.isDirectory()) {
                    if (!sweepTrashDirectory(child, pass, depth + 1)) allRemoved = false;
                } else {
                    removeBoundContainedPath(child);
                    pass.result.removed_entry_count++;
                    pass.result.removed_logical_bytes += stat.size;
                    pass.consecutiveFailures = 0;
                }
            } catch (error: unknown) {
                allRemoved = false;
                removalFailed(pass, error);
            }
        }
    } finally {
        directory.closeSync();
    }
    if (!complete || !allRemoved || !canRemove(pass)) return false;
    assertBoundContainedRemovalBoundary(binding);
    removeBoundContainedPath(binding);
    pass.result.removed_entry_count++;
    pass.result.removed_directory_count++;
    pass.consecutiveFailures = 0;
    return true;
}

function sweepTrash(root: ContainedDestination, budgetMs: number, result: CompileCachePruneResult): void {
    const pass: RemovalPass = { deadline: performance.now() + budgetMs, consecutiveFailures: 0, result };
    assertContainedDestination(root);
    const directory = fs.opendirSync(root.path);
    try {
        while (canRemove(pass)) {
            const entry = directory.readSync();
            if (!entry) break;
            if (!entry.name.startsWith(TRASH_PREFIX)) continue;
            try {
                assertContainedDestination(root);
                const candidate = path.join(root.path, entry.name);
                const stat = fs.lstatSync(candidate);
                if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
                sweepTrashDirectory(bindContainedDestination(root.root, candidate), pass);
            } catch (error: unknown) {
                removalFailed(pass, error);
            }
        }
    } finally {
        directory.closeSync();
    }
}

/** Advisory only: callers report errors without changing their own outcome. */
export function pruneNodeCompileCache(options: CompileCachePruneOptions = {}): CompileCachePruneResult {
    const result = emptyResult();
    try {
        if (options.dryRun) {
            result.skipped_reason = 'dry_run';
            return result;
        }
        const requestedRoot = path.resolve(options.cacheRoot ?? resolveNodeCompileCacheRoot());
        const rootStat = fs.lstatSync(requestedRoot, { throwIfNoEntry: false });
        if (!rootStat) {
            result.skipped_reason = 'cache_root_missing';
            return result;
        }
        if (rootStat.isSymbolicLink()) {
            result.skipped_reason = 'cache_root_is_symlink';
            return result;
        }
        const original = bindContainedDestination(requestedRoot, requestedRoot);
        const rootPath = fs.realpathSync.native(requestedRoot);
        assertContainedDestination(original);
        const root = bindContainedDestination(rootPath, rootPath);
        if (!options.trashOnly) {
            try {
                const week = utcIsoWeek(options.now ?? new Date());
                if (options.ignoreThrottle || claimWeek(root, week)) resetBuilds(root, week, result);
                else result.skipped_reason = 'already_ran_this_week';
            } catch (error: unknown) {
                recordError(result, error);
            }
        }
        sweepTrash(root, options.budgetMs ?? NODE_COMPILE_CACHE_BUDGET_MS, result);
    } catch (error: unknown) {
        recordError(result, error);
    }
    return result;
}
