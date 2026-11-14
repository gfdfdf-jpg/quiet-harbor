// The implementation is shared with the uncompiled npm lifecycle script.
const packageRootLock = require('../package-root-lock.cjs') as {
    resolvePackageRootLockBase: (repoRoot: string) => string;
    getPackageRootLockPath: (repoRoot: string) => string;
    withPackageRootLock: <T>(repoRoot: string, operation: () => T) => T;
};

export const resolvePackageRootLockBase = packageRootLock.resolvePackageRootLockBase;
export const getPackageRootLockPath = packageRootLock.getPackageRootLockPath;
export const withPackageRootLock = packageRootLock.withPackageRootLock;
