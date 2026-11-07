import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { lstatFileIdentitySync } from '../../core/file-stat';
import { countNextStepWork } from '../../core/next-step-measurement';
import { getWindowsSystemDirectory } from '../../core/windows-native-environment';

export interface WindowsAclObjectIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mode: bigint;
    readonly birthtimeNs: bigint;
    readonly realPath: string;
}

export function aclObjectIdentity(filePath: string): WindowsAclObjectIdentity {
    const stat = lstatFileIdentitySync(filePath, { bigint: true });
    return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, birthtimeNs: stat.birthtimeNs,
        realPath: fs.realpathSync.native(filePath) });
}

export function sameAclObject(left: WindowsAclObjectIdentity, right: WindowsAclObjectIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
        && left.birthtimeNs === right.birthtimeNs && left.realPath === right.realPath;
}

export type WindowsAclBatchEntry = { identity: WindowsAclObjectIdentity; bytes: Buffer };
const MAX_SIBLINGS = 32;

/** Recognize only complete native records. Keep original ACE bytes, including codepage bytes. */
export function parseAclEntries(bytes: Buffer, files: readonly string[]): Map<string, Buffer> | null {
    const prefixes = files.map(file => ({ file, prefix: Buffer.from(file + ' ', 'ascii') }))
        .sort((a, b) => b.prefix.length - a.prefix.length);
    if (!files.length || files.some(file => !/^[\x20-\x7e]+$/u.test(file))) return null;
    const result = new Map<string, Buffer>();
    let current: { file: string; start: number; indent: Buffer } | null = null, footer = false;
    for (let offset = 0; offset < bytes.length;) {
        const end = bytes.indexOf(0x0a, offset);
        if (end < 0) return null;
        const line = bytes.subarray(offset, end > offset && bytes[end - 1] === 0x0d ? end - 1 : end);
        if (line.length === 0) {
            if (current) { result.set(current.file, Buffer.from(bytes.subarray(current.start, offset))); current = null; }
        } else if (current) {
            if (!line.subarray(0, current.indent.length).equals(current.indent)
                || !line.subarray(current.indent.length).includes(Buffer.from(':('))) return null;
        } else if (result.size === files.length) {
            // icacls localizes the trailer (including its OEM codepage), but emits two decimal counts.
            // Status zero, all exact named records and a zero failure count are required together.
            const counts = line.toString('latin1').match(/\d+/gu);
            if (footer || line.includes(Buffer.from(':(')) || counts?.length !== 2
                || counts[0] !== String(files.length) || counts[1] !== '0') return null;
            footer = true;
        } else {
            const entry = prefixes.find(value => line.subarray(0, value.prefix.length).equals(value.prefix));
            if (!entry || result.has(entry.file) || !line.subarray(entry.prefix.length).includes(Buffer.from(':('))) return null;
            current = { file: entry.file, start: offset, indent: Buffer.alloc(entry.prefix.length, 0x20) };
        }
        offset = end + 1;
    }
    return footer && !current && result.size === files.length ? result : null;
}

/** Normalize only the native success trailer; every per-object ACL byte remains bound. */
export function aclEvidenceBytes(filePath: string, bytes: Buffer): Buffer {
    return parseAclEntries(bytes, [filePath])?.get(filePath) ?? bytes;
}

function siblings(parent: string): string[] | null {
    // ASCII paths avoid interpreting lossy native-codepage output as a different pathname.
    if (!/^[\x20-\x7e]+$/u.test(parent) || parent === path.parse(parent).root) return null;
    const directory = fs.opendirSync(parent);
    const result: string[] = [];
    try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (result.length === MAX_SIBLINGS || !/^[\x20-\x7e]+$/u.test(entry.name)
                || !entry.isFile() || entry.isSymbolicLink()) return null;
            result.push(path.join(parent, entry.name));
        }
    } finally { directory.closeSync(); }
    return result.length >= 1 ? result.sort() : null;
}

/** One synchronous acquisition for an explicitly requested directory/file pair. Never retain siblings. */
export function captureAclPairEvidence(parent: string, requestedFile: string): ReadonlyMap<string, WindowsAclBatchEntry> | null {
    let stage = 'enumeration';
    const declined = () => { countNextStepWork('acl_batch_fallback:' + stage); return null; };
    try {
        const children = siblings(parent);
        if (!children || !children.includes(requestedFile)) return declined();
        const files = [parent, ...children];
        stage = 'identity';
        const identities = new Map(files.map(file => [file, aclObjectIdentity(file)]));
        // Directory enumeration and object inspection must agree about links and special files.
        if ((identities.get(parent)!.mode & 0o170000n) !== 0o040000n
            || children.some(file => (identities.get(file)!.mode & 0o170000n) !== 0o100000n)) return declined();
        stage = 'native-read';
        countNextStepWork('acl_batch_probe:initial:' + parent);
        const result = childProcess.spawnSync(path.join(getWindowsSystemDirectory(), 'icacls.exe'), [parent, '/T'],
            { maxBuffer: 256 * 1024, timeout: 1_000, windowsHide: true });
        if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return declined();
        stage = 'output';
        const entries = parseAclEntries(result.stdout, files), afterFiles = siblings(parent);
        if (!entries) return declined();
        stage = 'current-directory';
        if (!afterFiles || children.length !== afterFiles.length || children.some((file, index) => file !== afterFiles[index])) return declined();
        stage = 'current-identity';
        const batch = new Map<string, WindowsAclBatchEntry>();
        for (const file of files) {
            const identity = identities.get(file)!;
            if (!sameAclObject(identity, aclObjectIdentity(file))) return declined();
            if (file === parent || file === requestedFile) batch.set(file, { identity, bytes: entries.get(file)! });
        }
        return batch;
    } catch { return declined(); } // Unsupported/partial acquisition retains the individual native reader.
}
