import * as fs from 'node:fs';
import * as path from 'node:path';

const REMOVAL_RETRY_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES']);

/**
 * Remove a disposable walk directory. rmSync's own retries repeat only the final rmdir, so a child that is still
 * finishing a write can leave a new entry behind (ENOTEMPTY on Linux, EBUSY/EPERM on Windows). Each further
 * attempt enumerates the tree again; after the last one the original error is thrown, never ignored.
 */
export function removeWalkDirectory(directory: string, attempts = 8): void {
    for (let attempt = 1; ; attempt += 1) {
        try {
            fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (attempt >= attempts || !REMOVAL_RETRY_CODES.has(code)) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * attempt);
        }
    }
}

/** Restore content in place. Unchanged native directory/file identities are part of authenticated evidence. */
export function restoreWalkCheckpoint(snapshot: string, target: string): void {
    const root = fs.realpathSync.native(target);
    const inside = (file: string) => {
        const relative = path.relative(root, file);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe checkpoint child: ' + file);
    };
    const restore = (from: string, to: string) => {
        const names = new Set(fs.readdirSync(from));
        for (const name of fs.readdirSync(to)) if (!names.has(name)) {
            const file = path.join(to, name); inside(file);
            fs.rmSync(file, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
        for (const name of names) {
            const source = path.join(from, name), destination = path.join(to, name); inside(destination);
            const stat = fs.lstatSync(source);
            if (stat.isSymbolicLink()) throw new Error('Checkpoint contains a symbolic link');
            let current: fs.Stats | null = null;
            try { current = fs.lstatSync(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            if (current && (current.isSymbolicLink() || current.isDirectory() !== stat.isDirectory())) {
                fs.rmSync(destination, { recursive: true, force: true }); current = null;
            }
            if (stat.isDirectory()) {
                if (!current) fs.mkdirSync(destination);
                restore(source, destination);
            } else if (stat.isFile()) {
                const bytes = fs.readFileSync(source);
                const sameBytes = !!current && current.size === bytes.length && fs.readFileSync(destination).equals(bytes);
                if (!sameBytes) {
                    fs.writeFileSync(destination, bytes);
                    fs.chmodSync(destination, stat.mode);
                }
                // A variant may rewrite identical bytes (a digest-named snapshot) or only move a timestamp; that later
                // mtime must not reach the next variant. The copy keeps an untouched file's mtime well within 1 ms.
                if (!sameBytes || Math.abs((current?.mtimeMs ?? 0) - stat.mtimeMs) >= 1) fs.utimesSync(destination, stat.atime, stat.mtime);
            } else throw new Error('Checkpoint contains a non-regular input');
        }
    };
    restore(snapshot, root);
}
