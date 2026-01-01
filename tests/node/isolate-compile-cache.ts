import { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Each test file runs in its own Node process. Children inherit this home too.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const protectedRoots = [...new Set([os.homedir(), os.userInfo().homedir])]
    .map(home => path.resolve(home, '.cache', 'garda', 'node-compile'));
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-test-home-'));

export function assertDisposableCachePath(candidate: string): void {
    for (const root of protectedRoots) {
        const relative = path.relative(root, path.resolve(candidate));
        assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
            `test attempted to access the real compile cache: ${candidate}`);
    }
}

export function assertIsolatedTestHome(env: NodeJS.ProcessEnv = process.env): void {
    assert.equal(env.HOME, testHome);
    assert.equal(env.USERPROFILE, testHome);
    assertDisposableCachePath(path.join(testHome, '.cache', 'garda', 'node-compile'));
}

assertDisposableCachePath(testHome);
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

// Maintenance catches filesystem errors, so remember denied access and fail the
// suite in its after hook even if the update itself reports success.
const nativeFs = require('node:fs') as Record<string, (...args: never[]) => unknown>;
const operations = ['lstatSync', 'opendirSync', 'openSync', 'renameSync', 'unlinkSync', 'rmdirSync', 'rmSync', 'mkdirSync', 'writeFileSync'];
const originals = new Map<string, (...args: never[]) => unknown>();
let forbiddenAccess: string | null = null;
for (const operation of operations) {
    const original = nativeFs[operation];
    originals.set(operation, original);
    nativeFs[operation] = new Proxy(original, {
        apply(target, thisArg, args: unknown[]) {
            for (const candidate of args.slice(0, operation === 'renameSync' ? 2 : 1)) {
                if (typeof candidate !== 'string') continue;
                try {
                    assertDisposableCachePath(candidate);
                } catch (error) {
                    forbiddenAccess = `${operation}: ${candidate}`;
                    throw error;
                }
            }
            return Reflect.apply(target, thisArg, args);
        }
    });
}

beforeEach(() => assertIsolatedTestHome());
after(() => {
    for (const [operation, original] of originals) nativeFs[operation] = original;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(testHome, { recursive: true, force: true });
    assert.equal(forbiddenAccess, null, `test attempted to access the real compile cache: ${forbiddenAccess}`);
});
