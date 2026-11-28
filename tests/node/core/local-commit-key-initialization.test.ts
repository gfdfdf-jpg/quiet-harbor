import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { authenticateLocalCommitWorkflowAudit } from '../../../src/core/auth/local-commit-availability';

const nativeFs = require('node:fs') as typeof fs;

for (const replace of [false, true]) {
    test(`local commit key initialization with missing Windows path device ${replace ? 'rejects replacement' : 'authenticates a stable file'}`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-key-initialization-'));
        const keyPath = path.join(root, '.git/garda-private/local-commit-key');
        fs.mkdirSync(path.join(root, '.git'));
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const lstat = nativeFs.lstatSync, write = nativeFs.writeFileSync;
        let missingDevices = 0, replaced = false;
        t.mock.method(nativeFs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
            const stat = Reflect.apply(lstat, nativeFs, args);
            if (String(args[0]) !== keyPath || !stat) return stat;
            missingDevices++;
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
                { dev: typeof stat.dev === 'bigint' ? 0n : 0 });
        });
        t.mock.method(nativeFs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
            const result = Reflect.apply(write, nativeFs, args);
            if (replace && typeof args[0] === 'number' && !replaced) {
                replaced = true;
                fs.renameSync(keyPath, keyPath + '.displaced');
                write(keyPath, 'ab'.repeat(32) + '\n', { flag: 'wx', mode: 0o600 });
            }
            return result;
        });
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            const sign = () => authenticateLocalCommitWorkflowAudit(root, { event: 'initialization-regression' }, false, true);
            if (replace) {
                assert.throws(sign, /key changed during initialization/u);
                assert.equal(replaced, true, 'reach the post-write identity check');
                assert.equal(fs.readFileSync(keyPath, 'utf8'), 'ab'.repeat(32) + '\n');
            } else {
                const first = sign();
                assert.match(first.local_commit_authentication!.hmac_sha256, /^[a-f0-9]{64}$/u);
                assert.deepEqual(sign(), first, 'the same file must authenticate the next invocation');
            }
            assert.ok(missingDevices > 0, 'exercise path stat without a volume id');
        } finally {
            t.mock.restoreAll();
            Object.defineProperty(process, 'platform', platform);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}
