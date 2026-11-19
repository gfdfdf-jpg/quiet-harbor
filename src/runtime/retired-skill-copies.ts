import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bindContainedDestination, type ContainedDestination } from '../core/contained-filesystem';
import { lstatFileIdentitySync } from '../core/file-stat';
import { RETIRED_BASELINE_SKILL_DIRECTORIES } from './skill-manifest';
import { SHIPPED_RETIRED_SKILL_DIGESTS } from './retired-skill-digests';

/**
 * State of a live copy of a retired baseline skill.
 * - `absent`: no entry at `live/skills/<id>`.
 * - `shipped`: an ordinary directory whose complete file set is byte-for-byte a copy
 *   that a Garda release (or committed source state) shipped.
 * - `modified`: anything else that is not a link: edited, extra or missing files,
 *   extra directories, unusual entry types or a tree larger than any shipped copy.
 * - `link`: the copy, its parents or an entry inside it is a symlink, junction or
 *   hard-linked file; it is never followed.
 */
export type RetiredSkillCopyState = 'absent' | 'shipped' | 'modified' | 'link';

export interface RetiredSkillCopyClassification {
    skillId: string;
    skillRoot: string;
    state: RetiredSkillCopyState;
    reason: string;
    /** Containment binding taken during classification; only set for `shipped`. */
    binding?: ContainedDestination;
}

// Every shipped copy has at most four files and well under 128 KiB.
const MAX_ENTRIES = 64;
const MAX_TOTAL_BYTES = 1024 * 1024;

/** sha256 over the sorted [relativePath, sha256(bytes)] pairs, as used by the embedded digests. */
export function computeSkillTreeDigest(files: ReadonlyArray<{ path: string; sha256: string }>): string {
    const sorted = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return createHash('sha256').update(JSON.stringify(sorted.map((file) => [file.path, file.sha256]))).digest('hex');
}

export function getShippedRetiredSkillDigests(skillId: string): readonly string[] {
    return Object.hasOwn(SHIPPED_RETIRED_SKILL_DIGESTS, skillId) ? SHIPPED_RETIRED_SKILL_DIGESTS[skillId] : [];
}

function lstatOrNull(entryPath: string): fs.Stats | null {
    try {
        return lstatFileIdentitySync(entryPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function result(skillId: string, skillRoot: string, state: RetiredSkillCopyState, reason: string): RetiredSkillCopyClassification {
    return { skillId, skillRoot, state, reason };
}

export function classifyRetiredSkillCopy(bundleRoot: string, skillId: string): RetiredSkillCopyClassification {
    const liveSkillsRoot = path.join(path.resolve(bundleRoot), 'live', 'skills');
    const skillRoot = path.join(liveSkillsRoot, skillId);
    if (!RETIRED_BASELINE_SKILL_DIRECTORIES.includes(skillId)) {
        throw new Error(`Not a retired baseline skill id: ${skillId}`);
    }
    for (const parent of [path.join(path.resolve(bundleRoot), 'live'), liveSkillsRoot]) {
        const parentStat = lstatOrNull(parent);
        if (!parentStat) return result(skillId, skillRoot, 'absent', 'not present');
        if (parentStat.isSymbolicLink()) return result(skillId, skillRoot, 'link', `parent ${path.basename(parent)} is a link`);
        if (!parentStat.isDirectory()) return result(skillId, skillRoot, 'modified', `parent ${path.basename(parent)} is not a directory`);
    }
    const rootStat = lstatOrNull(skillRoot);
    if (!rootStat) return result(skillId, skillRoot, 'absent', 'not present');
    if (rootStat.isSymbolicLink()) return result(skillId, skillRoot, 'link', 'the skill directory is a link');
    if (!rootStat.isDirectory()) return result(skillId, skillRoot, 'modified', 'not a directory');
    let binding: ContainedDestination;
    try {
        binding = bindContainedDestination(bundleRoot, skillRoot);
    } catch (error) {
        return result(skillId, skillRoot, 'link', `path is not contained: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (fs.realpathSync.native(skillRoot) !== path.join(fs.realpathSync.native(liveSkillsRoot), skillId)) {
        return result(skillId, skillRoot, 'link', 'the skill directory does not resolve inside live/skills');
    }
    return classifySkillTreeContent(skillId, skillRoot, binding);
}

/**
 * Classifies a copy that a lifecycle has already moved out of `live/skills` (for example into a
 * staging directory) with the same complete-file-set, exact-bytes and no-link recognition.
 */
export function classifyMovedRetiredSkillCopy(
    containmentRoot: string,
    skillId: string,
    movedRoot: string
): RetiredSkillCopyClassification {
    if (!RETIRED_BASELINE_SKILL_DIRECTORIES.includes(skillId)) {
        throw new Error(`Not a retired baseline skill id: ${skillId}`);
    }
    const rootStat = lstatOrNull(movedRoot);
    if (!rootStat) return result(skillId, movedRoot, 'absent', 'not present');
    if (rootStat.isSymbolicLink()) return result(skillId, movedRoot, 'link', 'the moved directory is a link');
    if (!rootStat.isDirectory()) return result(skillId, movedRoot, 'modified', 'not a directory');
    let binding: ContainedDestination;
    try {
        binding = bindContainedDestination(containmentRoot, movedRoot);
    } catch (error) {
        return result(skillId, movedRoot, 'link', `path is not contained: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (fs.realpathSync.native(movedRoot) !== path.join(fs.realpathSync.native(path.dirname(movedRoot)), path.basename(movedRoot))) {
        return result(skillId, movedRoot, 'link', 'the moved directory does not resolve where it was moved');
    }
    return classifySkillTreeContent(skillId, movedRoot, binding);
}

function classifySkillTreeContent(
    skillId: string,
    skillRoot: string,
    binding: ContainedDestination
): RetiredSkillCopyClassification {
    const files: Array<{ path: string; sha256: string }> = [];
    const directories = new Set<string>();
    let entries = 0;
    let totalBytes = 0;
    const stack: Array<{ absolute: string; relative: string }> = [{ absolute: skillRoot, relative: '' }];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const name of fs.readdirSync(current.absolute)) {
            entries += 1;
            if (entries > MAX_ENTRIES) return result(skillId, skillRoot, 'modified', 'more entries than any shipped copy');
            const absolute = path.join(current.absolute, name);
            const relative = current.relative ? `${current.relative}/${name}` : name;
            const stat = lstatFileIdentitySync(absolute);
            if (stat.isSymbolicLink()) return result(skillId, skillRoot, 'link', `contains a link: ${relative}`);
            if (stat.isDirectory()) {
                directories.add(relative);
                stack.push({ absolute, relative });
                continue;
            }
            if (!stat.isFile()) return result(skillId, skillRoot, 'modified', `contains an unsupported entry: ${relative}`);
            if (stat.nlink !== 1) return result(skillId, skillRoot, 'link', `contains a hard-linked file: ${relative}`);
            totalBytes += stat.size;
            if (totalBytes > MAX_TOTAL_BYTES) return result(skillId, skillRoot, 'modified', 'larger than any shipped copy');
            files.push({ path: relative, sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') });
        }
    }
    const impliedDirectories = new Set<string>();
    for (const file of files) {
        const parts = file.path.split('/');
        for (let index = 1; index < parts.length; index += 1) impliedDirectories.add(parts.slice(0, index).join('/'));
    }
    for (const directory of directories) {
        if (!impliedDirectories.has(directory)) {
            return result(skillId, skillRoot, 'modified', `contains a directory no shipped copy has: ${directory}`);
        }
    }
    if (!getShippedRetiredSkillDigests(skillId).includes(computeSkillTreeDigest(files))) {
        return result(skillId, skillRoot, 'modified', 'content differs from every shipped copy');
    }
    return { skillId, skillRoot, state: 'shipped', reason: 'unmodified copy shipped by an earlier release', binding };
}

export function classifyRetiredSkillCopies(bundleRoot: string): RetiredSkillCopyClassification[] {
    return RETIRED_BASELINE_SKILL_DIRECTORIES.map((skillId) => classifyRetiredSkillCopy(bundleRoot, skillId));
}
