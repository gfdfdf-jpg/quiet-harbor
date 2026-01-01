import { runGitBinary } from './git-helpers';
import { normalizePath } from './orchestrator-paths';

const STAGED_INDEX_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const STAGED_INDEX_TIMEOUT_MS = 30_000;

export type StagedBlobFingerprints = ReadonlyMap<string, string>;

export function readStagedBlobFingerprints(
    repoRoot: string,
    relativePaths: readonly string[]
): Map<string, string> {
    const wantedPaths = new Set(
        relativePaths.map((relativePath) => normalizePath(relativePath)).filter(Boolean)
    );
    const fingerprints = new Map<string, string>();
    if (wantedPaths.size === 0) {
        return fingerprints;
    }

    const output = runGitBinary(repoRoot, ['ls-files', '--stage', '-z'], {
        maxBuffer: STAGED_INDEX_MAX_BUFFER_BYTES,
        timeoutMs: STAGED_INDEX_TIMEOUT_MS
    });
    for (const entry of parseStageIndexAuthority(output.toString('utf8'))) {
        if (!wantedPaths.has(entry.path)) continue;
        if (entry.stage !== '0' || fingerprints.has(entry.path)) {
            throw new Error('Staged index authority contains an unmerged or duplicate requested entry.');
        }
        fingerprints.set(entry.path, `staged:${entry.mode}:${entry.objectId}`);
    }
    return fingerprints;
}

/** Strict framing and exact path identity shared by native index consumers. */
export function parseStageIndexAuthority(output: string): Array<{ path: string; mode: string; objectId: string; stage: string }> {
    if (output === '') return [];
    if (!output.endsWith('\0')) throw new Error('Staged index authority has an unterminated record.');
    const seen = new Set<string>();
    return output.slice(0, -1).split('\0').map(record => {
        const match = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/su.exec(record);
        if (!match || !match[4] || match[4].startsWith('/') || (process.platform === 'win32' && match[4].includes('\\'))
            || match[4].split('/').some(part => !part || part === '.' || part === '..'))
            throw new Error('Staged index authority has a malformed record.');
        const [, mode, objectId, stage, file] = match;
        const key = stage + ':' + file;
        if (seen.has(key)) throw new Error('Staged index authority has a duplicate entry.');
        seen.add(key);
        return { path: file, mode, objectId, stage };
    });
}
