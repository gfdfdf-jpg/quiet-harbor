import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { bindContainedDestination, assertContainedDestination } from '../core/contained-filesystem';
import { statFileIdentitySync } from '../core/file-stat';
import { parseJsonText } from '../core/json';
import { isPlainRecord } from '../core/records';
import { isPathRealpathInsideRoot, normalizePath } from '../core/orchestrator-paths';

export const SKILL_REFERENCE_LIMITS = Object.freeze({
    max_files: 32,
    max_file_bytes: 128 * 1024,
    max_total_bytes: 512 * 1024,
    max_metadata_bytes: 64 * 1024
});

function inputVersion(stat: fs.BigIntStats): string {
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}

export function readBoundedSkillInput(filePath: string, owningRoot: string, maximumBytes: number, label: string) {
    let binding;
    try {
        binding = bindContainedDestination(owningRoot, filePath);
    } catch (error) {
        throw new Error(`${label} must retain an ordinary identity inside its owning root: ${String(error)}`);
    }
    if (binding.missingAt) throw new Error(`${label} required input is missing: ${normalizePath(filePath)}.`);
    if (!isPathRealpathInsideRoot(filePath, owningRoot)) {
        throw new Error(`${label} must resolve inside its owning skill/reference root: ${normalizePath(filePath)}.`);
    }
    const before = statFileIdentitySync(filePath, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} requires a regular file: ${normalizePath(filePath)}.`);
    if (before.size > BigInt(maximumBytes)) throw new Error(`${label} exceeds its byte bound (${maximumBytes}).`);
    // A replacement FIFO must not block before the ordinary-file identity checks can run.
    const descriptor = fs.openSync(filePath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
        assertContainedDestination(binding);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (inputVersion(opened) !== inputVersion(before)) throw new Error(`${label} identity changed before reading.`);
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
            if (count === 0) break;
            bytesRead += count;
        }
        assertContainedDestination(binding);
        if (BigInt(bytesRead) !== before.size
            || inputVersion(fs.fstatSync(descriptor, { bigint: true })) !== inputVersion(before)
            || inputVersion(statFileIdentitySync(filePath, { bigint: true })) !== inputVersion(before)) {
            throw new Error(`${label} identity or contents changed during bounded reading.`);
        }
        const bytes = buffer.subarray(0, bytesRead);
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally {
        fs.closeSync(descriptor);
    }
}

export function normalizeRequiredSkillReferenceNames(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error('Review skill references must be a declared string array.');
    if (value.length > SKILL_REFERENCE_LIMITS.max_files) {
        throw new Error(`Review skill reference count exceeds its bound (${SKILL_REFERENCE_LIMITS.max_files}).`);
    }
    const names: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || !entry || entry.trim() !== entry
            || /[\u0000-\u001f\u007f:]/.test(entry) || path.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
            throw new Error('Review skill reference path must be a nonempty relative path without control characters.');
        }
        const name = entry.replace(/\\/g, '/');
        if (name.split('/').some((component) => !component || component === '.' || component === '..')) {
            throw new Error('Review skill reference path cannot contain traversal or empty components.');
        }
        if (names.includes(name)) throw new Error(`Review skill reference path is duplicated: ${name}.`);
        names.push(name);
    }
    return names.sort();
}

function readOptionalSkillInput(filePath: string, owningRoot: string, maximumBytes: number, label: string) {
    try {
        fs.lstatSync(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    return readBoundedSkillInput(filePath, owningRoot, maximumBytes, label);
}

function readSkillMetadata(skillRoot: string) {
    const metadataPath = path.join(skillRoot, 'skill.json');
    const input = readOptionalSkillInput(metadataPath, skillRoot,
        SKILL_REFERENCE_LIMITS.max_metadata_bytes, 'Review skill metadata');
    if (!input) return undefined;
    const parsed = parseJsonText(input.bytes.toString('utf8'), normalizePath(metadataPath));
    if (!isPlainRecord(parsed)) throw new Error('Review skill metadata must be a JSON object.');
    return { input, parsed };
}

export function resolveRequiredSkillReferences(skillRoot: string) {
    const current = readSkillMetadata(skillRoot);
    if (!current) return undefined;
    const metadataPath = path.join(skillRoot, 'skill.json');
    const { input: metadata, parsed } = current;
    if (parsed.references == null) return undefined;
    const names = normalizeRequiredSkillReferenceNames(parsed.references);
    if (names.length === 0) return undefined;
    const referenceRoot = path.join(skillRoot, 'references');
    if (!isPathRealpathInsideRoot(referenceRoot, skillRoot)) {
        throw new Error(`Review skill reference root must stay inside the owning skill: ${normalizePath(referenceRoot)}.`);
    }
    let totalBytes = 0;
    const references = names.map((name) => {
        const referencePath = path.join(referenceRoot, name);
        const availableBytes = Math.min(SKILL_REFERENCE_LIMITS.max_file_bytes,
            SKILL_REFERENCE_LIMITS.max_total_bytes - totalBytes);
        const label = availableBytes < SKILL_REFERENCE_LIMITS.max_file_bytes
            ? 'Review skill reference total bytes' : 'Review skill reference';
        const input = readBoundedSkillInput(referencePath, referenceRoot,
            availableBytes, label);
        totalBytes += input.bytes.length;
        return { reference_path: normalizePath(referencePath), reference_sha256: input.sha256, reference_bytes: input.bytes.length };
    });
    return {
        schema_version: 1 as const,
        metadata_path: normalizePath(metadataPath),
        metadata_sha256: metadata.sha256,
        reference_root_path: normalizePath(referenceRoot),
        limits: { ...SKILL_REFERENCE_LIMITS },
        required_references: references
    };
}

export interface SkillContentInput {
    path: string;
    text: string;
    sha256: string;
    bytes: number;
}

/** True when a directory entry exists at the path, including a dangling or escaping link. */
function hasPathEntry(entryPath: string): boolean {
    try {
        fs.lstatSync(entryPath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

export function readSkillContentInputs(skillRoot: string) {
    if (!fs.lstatSync(skillRoot).isDirectory()) throw new Error('Skill content requires an ordinary skill directory.');
    const metadata = readSkillMetadata(skillRoot);
    const primary = readOptionalSkillInput(path.join(skillRoot, 'SKILL.md'), skillRoot,
        SKILL_REFERENCE_LIMITS.max_file_bytes, 'Skill instructions');
    if (!primary && !metadata) throw new Error('Skill content entrypoint is missing.');
    const names = metadata?.parsed.references == null ? [] : normalizeRequiredSkillReferenceNames(metadata.parsed.references);
    if (names.length + Number(Boolean(primary)) + Number(Boolean(metadata)) > SKILL_REFERENCE_LIMITS.max_files) {
        throw new Error('Skill content file count exceeds its bound.');
    }
    const referenceRoot = path.join(skillRoot, 'references');
    if (names.length && !hasPathEntry(referenceRoot)) {
        throw new Error('Skill content reference root is missing: skill.json declares references but references/ does not exist.');
    }
    if (names.length && !isPathRealpathInsideRoot(referenceRoot, skillRoot)) {
        throw new Error('Skill content reference root must stay inside the owning skill.');
    }
    const files: SkillContentInput[] = [];
    let totalBytes = 0;
    const append = (name: string, input: { bytes: Buffer; sha256: string }) => {
        totalBytes += input.bytes.length;
        if (totalBytes > SKILL_REFERENCE_LIMITS.max_total_bytes) throw new Error('Skill content exceeds its total byte bound.');
        files.push({ path: name, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes),
            sha256: input.sha256, bytes: input.bytes.length });
    };
    if (primary) append('SKILL.md', primary);
    if (metadata) append('skill.json', metadata.input);
    for (const name of names) {
        const available = Math.min(SKILL_REFERENCE_LIMITS.max_file_bytes, SKILL_REFERENCE_LIMITS.max_total_bytes - totalBytes);
        append('references/' + name, readBoundedSkillInput(path.join(referenceRoot, name), referenceRoot,
            available, 'Skill content reference/total bytes'));
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const contentSha256 = createHash('sha256').update(JSON.stringify(files.map(({ path: filePath, sha256, bytes }) =>
        ({ path: filePath, sha256, bytes })))).digest('hex');
    return { files, content_sha256: contentSha256 };
}

