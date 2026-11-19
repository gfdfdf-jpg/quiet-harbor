import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { copyContainedFile } from '../../../src/core/contained-filesystem';

const ARCHIVE_TIME = new Date('1985-10-26T08:15:00.000Z');

function withFixture(action: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-contained-copy-times-'));
    try { action(root); }
    finally {
        mock.restoreAll();
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
}

for (const copyStamp of ['native', 'posix-copy-time'] as const) {
    test(`copyContainedFile keeps the source modification time (${copyStamp})`, () => withFixture((root) => {
        const source = path.join(root, 'archive', 'bin', 'garda.js');
        const destination = path.join(root, 'bundle', 'bin', 'garda.js');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(source, '#!/usr/bin/env node\n');
        fs.writeFileSync(destination, '#!/usr/bin/env node\n');
        fs.utimesSync(source, ARCHIVE_TIME, ARCHIVE_TIME);
        if (copyStamp === 'posix-copy-time') {
            // Linux and macOS copies stamp the copy time, unlike Windows CopyFile.
            const nativeCopy = fs.copyFileSync;
            mock.method(require('node:fs') as typeof fs, 'copyFileSync', (from: fs.PathLike, to: fs.PathLike, mode?: number) => {
                nativeCopy(from, to, mode);
                const now = new Date();
                fs.utimesSync(to, now, now);
            });
        }

        copyContainedFile(root, source, destination);

        assert.equal(fs.readFileSync(destination, 'utf8'), '#!/usr/bin/env node\n');
        assert.equal(fs.statSync(destination).mtimeMs, ARCHIVE_TIME.getTime());
        assert.equal(fs.statSync(source).mtimeMs, ARCHIVE_TIME.getTime());
        assert.deepEqual(fs.readdirSync(path.dirname(destination)), ['garda.js']);
    }));
}
