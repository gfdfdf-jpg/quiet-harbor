import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
const bootstrap = require.resolve('../../../src/bin/garda/derivation-source-receipts');
for (const owner of ['review', 'terminal']) {
    test('fixed lazy edges cover every function-local require in the ' + owner + ' closure', () => {
        const child = spawnSync(process.execPath, ['-r', bootstrap, require.resolve('./loaded-code-lazy-edges-driver'), owner],
            { encoding: 'utf8', timeout: 60_000, windowsHide: true });
        assert.equal(child.status, 0, child.stdout + child.stderr);
        assert.ok(JSON.parse(child.stdout).checked >= 6);
    });
}
test('cold code identity retains byte, new-module and existing-child-edge distinctions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-lazy-code-'));
    try {
        const policy = path.join(root, 'policy.js'), dependency = path.join(root, 'dependency.js');
        fs.writeFileSync(policy, "exports.load = () => require('./dependency');\n");
        fs.writeFileSync(dependency, "exports.value = 'A';\n");
        const hash = (inside: boolean, load: boolean, pin: boolean) => {
            const script = [
                'const {captureLoadedCodeClosure}=require(' + JSON.stringify(require.resolve('../../../src/core/loaded-code-identity')) + ');',
                'const policy=' + JSON.stringify(policy) + ',dependency=' + JSON.stringify(dependency) + ';',
                'const roots=[policy];const loaded=require(policy);',
                inside ? 'require(dependency);roots.push(dependency);' : '',
                load ? 'loaded.load();' : '', pin ? 'loaded.load();' : '',
                'const code=captureLoadedCodeClosure("garda.lazy-fixture.v1",roots);code.assertCurrent();process.stdout.write(code.sha256);'
            ].join('\n');
            const child = spawnSync(process.execPath, ['-r', bootstrap, '-e', script],
                { encoding: 'utf8', timeout: 30_000, windowsHide: true });
            assert.equal(child.status, 0, child.stdout + child.stderr); return child.stdout;
        };
        const unloaded = hash(true, false, false), loaded = hash(true, true, false);
        assert.notEqual(unloaded, loaded, 'An edge to an already reachable module remains part of identity');
        assert.equal(hash(true, false, true), loaded, 'Preparation makes cold evaluation order stable');
        assert.equal(hash(true, true, true), loaded, 'Preparation remains idempotent');
        assert.notEqual(hash(false, false, false), hash(false, true, false), 'A newly reachable module still changes identity');
        fs.writeFileSync(dependency, "exports.value = 'B';\n");
        assert.notEqual(hash(true, false, true), loaded, 'Even one changed source byte still changes identity');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
