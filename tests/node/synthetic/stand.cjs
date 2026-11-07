'use strict';
// The public entry stays source-only; the existing build driver owns compilation and its lock.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const action = args.shift() || 'short';
const values = {};
const flags = new Set(['step-timing', 'machine-busy']);
const options = new Set(['report', 'resume', 'jobs', 'seed', 'only', 'timing-routes', 'kind', 'candidate', 'reason', 'release', 'source-commit', 'expected-sha256']);
try {
    if (!['short', 'sample', 'full', 'sweep', 'timing', 'baseline'].includes(action)) throw new Error('Expected short (sample), full, sweep, timing or baseline');
    while (args.length) {
        const key = args.shift().replace(/^--/u, '');
        if (flags.has(key)) values[key] = true;
        else if (options.has(key) && args.length && !args[0].startsWith('--')) values[key] = args.shift();
        else throw new Error('Unknown or incomplete option: --' + key);
    }
    const root = path.resolve(__dirname, '../../..');
    const env = { ...process.env, GARDA_REFERENCE_STAND: JSON.stringify({ ...values, action }) };
    for (const key of Object.keys(env)) if (/^GIT_CONFIG(?:_|$)/iu.test(key)) delete env[key];
    if (process.platform === 'win32') env.PATH = path.join(env.SystemRoot || 'C:\\Windows', 'System32') + path.delimiter + env.PATH;
    const result = spawnSync(process.execPath, ['scripts/node-foundation/build-scripts.cjs', 'test.js',
        '--garda-shard-timeout-ms', '86400000', 'tests/node/synthetic/reference-stand-run.test.ts'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} catch (error) { console.error(String(error)); process.exitCode = 1; }
