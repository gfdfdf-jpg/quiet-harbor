import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { referenceProbeEnvironment } from './fixtures/reference-probe-environment';

test('native probe children disable V8 coverage even when Node would restore an omitted environment key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-probe-coverage-'));
    const previous = process.env.NODE_V8_COVERAGE;
    try {
        process.env.NODE_V8_COVERAGE = root;
        const run = (env: NodeJS.ProcessEnv) => {
            const child = spawnSync(process.execPath, ['-p', "process.env.NODE_V8_COVERAGE || 'disabled'"],
                { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
            assert.ifError(child.error);
            assert.equal(child.status, 0, child.stderr);
            return child.stdout.trim();
        };
        const omitted = { ...process.env };
        delete omitted.NODE_V8_COVERAGE;
        assert.equal(run(omitted), root, 'negative control: Node restores coverage from its parent');
        const before = fs.readdirSync(root);
        assert.ok(before.some(name => name.startsWith('coverage-')), 'negative control really writes V8 coverage');
        assert.equal(run(referenceProbeEnvironment()), 'disabled');
        assert.deepEqual(fs.readdirSync(root), before, 'the resource child must not publish coverage');
    } finally {
        if (previous === undefined) delete process.env.NODE_V8_COVERAGE;
        else process.env.NODE_V8_COVERAGE = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
