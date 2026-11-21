import * as os from 'node:os';
import * as path from 'node:path';

export function resolveNodeCompileCacheRoot(): string {
    return path.join(os.homedir(), '.cache', 'garda', 'node-compile');
}
