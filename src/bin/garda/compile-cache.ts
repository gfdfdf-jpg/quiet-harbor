import * as moduleRuntime from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep this launcher free of local imports: enable caching before loading them.
// Keep the inline path equal to resolveNodeCompileCacheRoot (covered by tests).
try {
    if (typeof moduleRuntime.enableCompileCache === 'function') {
        moduleRuntime.enableCompileCache(path.join(os.homedir(), '.cache', 'garda', 'node-compile'));
    }
} catch { /* Node can run normally without a disk compile cache. */ }
