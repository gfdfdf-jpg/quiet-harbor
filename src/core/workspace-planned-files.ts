import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { validationRelativePath } from './validation-relative-path';
import { createInvocationReadMemoKey, memoizeInvocationRead, registerInvocationDependency } from './invocation-read-observation';

/** Exact visibility hints, never directory grants or task ownership. No filesystem reads. */
export interface WorkspacePlannedFiles {
    readonly digest: string;
    readonly native_epoch: number;
    readonly entry_sha256: string;
    readonly paths: readonly string[];
}
const empty: WorkspacePlannedFiles = Object.freeze({ digest: '', native_epoch: 0, entry_sha256: '', paths: Object.freeze([]) });
const published = new Map<string, WorkspacePlannedFiles>();
const nativeEpochs = new Map<string, number>();
let nextNativeEpoch = 0;
const observations = createInvocationReadMemoKey<{ current: WorkspacePlannedFiles; readerTaskId?: string }>('workspace-planned-files');
const key = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
function state(root: string): { current: WorkspacePlannedFiles; readerTaskId?: string } {
    return memoizeInvocationRead(observations, key(root), () => ({ current: published.get(key(root)) ?? empty })).value;
}

/** Called only after native publication, or by the existing authenticated entry reader. */
function retainWorkspacePlannedFiles(root: string, taskId: string, files: readonly string[], planDigest: string, entrySha256: string, native: boolean): void {
    const paths = validatedPlannedPaths(files);
    if (!taskId || entrySha256 && !/^[a-f0-9]{64}$/u.test(entrySha256))
        throw new Error('Invalid native planned-source entry identity.');
    const digest = workspacePlannedFilesDigest(taskId, paths, planDigest);
    const previous = published.get(key(root));
    if (native) nativeEpochs.set(key(root), ++nextNativeEpoch);
    const nativeEpoch = nativeEpochs.get(key(root)) ?? 0;
    const observation = previous?.digest === digest && previous.native_epoch === nativeEpoch && previous.entry_sha256 === entrySha256 ? previous
        : Object.freeze({ digest, native_epoch: nativeEpoch, entry_sha256: entrySha256, paths: Object.freeze(paths) });
    published.delete(key(root)); published.set(key(root), observation);
    // Bound process retention; invocation generations retain their own immutable facts.
    if (published.size > 64) {
        const oldest = published.keys().next().value!;
        published.delete(oldest); nativeEpochs.delete(oldest);
    }
    state(root).current = observation;
}

export function publishWorkspacePlannedFiles(root: string, taskId: string, files: readonly string[], planDigest = '', entrySha256 = ''): void {
    retainWorkspacePlannedFiles(root, taskId, files, planDigest, entrySha256, true);
}

/** The active task's first entry read anchors visibility; reading a parent cannot replace it. */
export function observeWorkspacePlannedFiles(root: string, taskId: string, files: readonly string[], planDigest = '', entrySha256 = ''): void {
    const owner = state(root);
    if (owner.readerTaskId && owner.readerTaskId !== taskId) return;
    owner.readerTaskId = taskId;
    retainWorkspacePlannedFiles(root, taskId, files, planDigest, entrySha256, false);
}

export function clearWorkspacePlannedFiles(root: string, taskId?: string | null): void {
    const owner = state(root);
    if (owner.readerTaskId && owner.readerTaskId !== taskId) return;
    published.delete(key(root));
    nativeEpochs.delete(key(root));
    owner.current = empty;
}

export function captureWorkspacePlannedFiles(root: string): WorkspacePlannedFiles {
    const owner = state(root);
    const captured = owner.current;
    registerInvocationDependency(owner, () => assertWorkspacePlannedFilesCurrent(root, captured));
    return captured;
}

export function assertWorkspacePlannedFilesCurrent(root: string, captured: WorkspacePlannedFiles): void {
    if (state(root).current.digest !== captured.digest || state(root).current.entry_sha256 !== captured.entry_sha256
        || (nativeEpochs.get(key(root)) ?? 0) !== captured.native_epoch)
        throw new Error('Workspace planned-source scope changed during the retained generation; retry the invocation.');
}

export function workspacePlannedFilesDigest(taskId: string, files: readonly string[], planDigest = ''): string {
    return createHash('sha256').update(JSON.stringify([taskId, planDigest, validatedPlannedPaths(files)])).digest('hex');
}

function validatedPlannedPaths(files: readonly string[]): string[] {
    const paths = [...new Set(files)].sort();
    if (paths.length > 100_000 || paths.some(file => {
        try { return validationRelativePath(file) !== file; } catch { return true; }
    })) throw new Error('Invalid native planned-source visibility.');
    return paths;
}

/** Entry-only observation of an approved plan before publication; never an ownership grant. */
export function extendWorkspacePlannedFiles(captured: WorkspacePlannedFiles, files: readonly string[]): WorkspacePlannedFiles {
    if (!files.length) return captured;
    const paths = validatedPlannedPaths([...captured.paths, ...files]);
    return Object.freeze({ native_epoch: captured.native_epoch, entry_sha256: captured.entry_sha256, paths: Object.freeze(paths),
        digest: workspacePlannedFilesDigest('entry-capture', paths) });
}
