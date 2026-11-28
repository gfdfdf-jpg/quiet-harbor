import * as fs from 'node:fs';
import * as path from 'node:path';
import { toRepoPath, uniqueSorted } from './project-memory-impact-common';

const MAX_POINTERS = 8;
const MAX_MEMORY_FILE_BYTES = 512 * 1024;
const MAX_EXCERPT_CHARS = 80;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Names a changed module can appear under in prose: its path, its file stem and the stem's trailing word runs. */
function modulePhrases(changedFile: string): RegExp[] {
    const repoPath = toRepoPath(changedFile);
    const stem = path.posix.basename(repoPath).replace(/(?:\.(?:test|spec))?\.[^.]+$/u, '');
    const words = stem.split(/[-_.]+/u).filter((word) => word.length > 1);
    const patterns = [new RegExp(escapeRegExp(repoPath), 'iu')];
    if (words.length >= 2) {
        patterns.push(new RegExp(`\\b${escapeRegExp(stem)}\\b`, 'iu'));
        for (let start = 0; start <= words.length - 2; start += 1) {
            patterns.push(new RegExp(`\\b${words.slice(start).map(escapeRegExp).join('[-_ ]+')}\\b`, 'iu'));
        }
    }
    return patterns;
}

/**
 * Lines of the candidate memory files that name a changed module: where an outdated statement is most likely.
 * A pointer for review only; it never decides whether a memory file must change.
 */
export function findProjectMemoryReviewPointers(
    repoRoot: string,
    affectedMemoryFiles: readonly string[],
    changedFiles: readonly string[]
): { pointers: string[]; omitted: number } {
    const sources = uniqueSorted(changedFiles.map(toRepoPath))
        .filter((file) => file && !file.startsWith('tests/') && !file.includes('/fixtures/')
            && !affectedMemoryFiles.includes(file));
    const phrases = sources.flatMap(modulePhrases);
    const pointers: string[] = [];
    let omitted = 0;
    if (phrases.length === 0) return { pointers, omitted };
    for (const memoryFile of affectedMemoryFiles) {
        const absolute = path.resolve(repoRoot, memoryFile);
        const relative = path.relative(path.resolve(repoRoot), absolute);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        let text: string;
        try {
            const stat = fs.lstatSync(absolute);
            if (!stat.isFile() || stat.size > MAX_MEMORY_FILE_BYTES) continue;
            text = fs.readFileSync(absolute, 'utf8');
        } catch {
            continue;
        }
        text.split(/\r?\n/u).forEach((line, index) => {
            if (!phrases.some((phrase) => phrase.test(line))) return;
            if (pointers.length >= MAX_POINTERS) {
                omitted += 1;
                return;
            }
            const excerpt = line.trim().replace(/\s+/gu, ' ');
            pointers.push(`${toRepoPath(memoryFile)}:${index + 1} (${excerpt.length > MAX_EXCERPT_CHARS
                ? `${excerpt.slice(0, MAX_EXCERPT_CHARS - 3)}...` : excerpt})`);
        });
    }
    return { pointers, omitted };
}

/** The review guidance that matches the suggested project-memory-impact command. */
export function buildProjectMemoryReviewHint(options: {
    repoRoot: string;
    affectedMemoryFiles: readonly string[];
    updatedMemoryFiles: readonly string[];
    changedFiles: readonly string[];
}): string {
    if (options.affectedMemoryFiles.length === 0) return '';
    const parts: string[] = [];
    if (options.updatedMemoryFiles.length === 0) {
        parts.push('No candidate memory file is edited. The command records a review without edits: --confirm-updated '
            + 'confirms the review evidence, with every candidate listed as --skipped-memory-file and the rationale '
            + 'that it is still accurate. If a candidate holds an outdated statement, edit that file first and list '
            + 'it with --updated-memory-file instead.');
    }
    const { pointers, omitted } = findProjectMemoryReviewPointers(options.repoRoot, options.affectedMemoryFiles,
        options.changedFiles);
    parts.push(pointers.length > 0
        ? `Candidate lines that name a changed module (check them for outdated statements): ${pointers.join('; ')}`
            + `${omitted > 0 ? `; and ${omitted} more` : ''}.`
        : 'No candidate line names a changed module; read the candidate files before confirming.');
    return parts.join(' ');
}
