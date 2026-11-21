'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireBuildRootLock, releaseBuildRootLock } = require('./build-root-lock.cjs');

const LOCKS_ENV = 'GARDA_PACKAGE_ROOT_LOCKS';
const TOKEN_FILE = 'package-token';

function canonicalRepositoryRoot(repoRoot) {
    const resolved = path.resolve(repoRoot);
    let canonical = resolved;
    try {
        canonical = fs.realpathSync.native(resolved);
    } catch {
        // Nonexistent roots retain a stable spelling-based identity.
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function resolvePackageRootLockBase(repoRoot) {
    // LOCALAPPDATA identifies the Windows local profile independently of TMP/TEMP;
    // /tmp is the system temporary directory on Linux and macOS.
    const parent = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Temp')
        : '/tmp';
    const canonicalRoot = canonicalRepositoryRoot(repoRoot);
    const digest = crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
    // Resolve the parent too: on macOS /tmp is normally a symlink to /private/tmp.
    const base = path.join(fs.realpathSync.native(parent), `garda-package-root-${digest}`);
    const canonicalBase = canonicalRepositoryRoot(base);
    const relative = path.relative(canonicalRoot, canonicalBase);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error(`Package root lock would be inside the repository: ${base}`);
    }
    return base;
}

function getPackageRootLockPath(repoRoot) {
    return `${resolvePackageRootLockBase(repoRoot)}.lock`;
}

function inheritedTokens() {
    try {
        const parsed = JSON.parse(process.env[LOCKS_ENV] || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function hasInheritedLock(lockPath) {
    const token = inheritedTokens()[lockPath];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) return false;
    try {
        return fs.readFileSync(path.join(lockPath, TOKEN_FILE), 'utf8') === token;
    } catch {
        return false;
    }
}

function acquirePackageLock(lockPath) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    acquireBuildRootLock(lockPath);
    try {
        const token = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(path.join(lockPath, TOKEN_FILE), token, { mode: 0o600 });
        return token;
    } catch (error) {
        releaseBuildRootLock(lockPath);
        throw error;
    }
}

// A child can reenter only while its inherited token matches the current acquisition.
function withPackageRootLock(repoRoot, operation) {
    const lockPath = getPackageRootLockPath(repoRoot);
    if (hasInheritedLock(lockPath)) return operation();
    const token = acquirePackageLock(lockPath);
    const previous = process.env[LOCKS_ENV];
    process.env[LOCKS_ENV] = JSON.stringify({ ...inheritedTokens(), [lockPath]: token });
    try {
        return operation();
    } finally {
        if (previous === undefined) delete process.env[LOCKS_ENV];
        else process.env[LOCKS_ENV] = previous;
        releaseBuildRootLock(lockPath);
    }
}

module.exports = {
    getPackageRootLockPath,
    resolvePackageRootLockBase,
    withPackageRootLock
};
