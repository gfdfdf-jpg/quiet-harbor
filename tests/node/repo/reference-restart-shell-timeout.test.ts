import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { referenceProbeEnvironment } from './fixtures/reference-probe-environment';

for (const mode of ['transient', 'exhausted']) {
    test(`review-cycle shell launch ${mode} retains attempts and recovers with real CLI evidence`, { timeout: 690_000 }, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-shell-'));
        const hook = path.resolve('tests/node/repo/fixtures/matrix-shell-timeout.cjs');
        // Keep the full native recovery assertions without instrumenting a whole
        // nested cell; shell-smoke unit/gate tests retain their c8 coverage.
        const env = referenceProbeEnvironment({ NODE_TEST_CONTEXT: '', GARDA_MATRIX_SHELL_MODE: mode,
            GARDA_MATRIX_SHELL_LOG: path.join(root, 'injection.json'),
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(hook)}` });
        const child = spawnSync(process.execPath, ['tests/node/synthetic/review-matrix.cjs', 'run', '--only',
            'review-matrix-polyglot-python-go--source-line-limit-240--test_after_code', '--report', path.join(root, 'report')], {
            encoding: 'utf8', windowsHide: true, timeout: 660_000, maxBuffer: 2 * 1024 * 1024,
            env
        });
        fs.writeFileSync(path.join(root, 'process.log'), child.stdout + child.stderr);
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, `${root}\n${child.stdout}${child.stderr}`);
        const evidence = JSON.parse(fs.readFileSync(path.join(root, 'injection.json'), 'utf8'));
        assert.equal(evidence.injected, mode === 'exhausted' ? 3 : 1);
        assert.equal(evidence.launches, mode === 'exhausted' ? 3 : 2);
        if (mode === 'exhausted') {
            assert.equal(evidence.recovery.status, 0);
            assert.equal(evidence.recoveredArtifact.outcome, 'PASS');
            assert.equal(evidence.resumedRestart.exitCode, 0);
        }
        const partial = JSON.parse(fs.readFileSync(path.join(root, 'report/review-matrix-partial.json'), 'utf8'));
        assert.equal(partial.complete, true);
        assert.deepEqual(partial.problems, []);
        assert.equal(partial.results.length, 1);
        assert.equal(partial.results[0].outcome, 'done');
        assert.deepEqual(partial.results[0].findings, []);
        for (const lane of ['code:DELTA', 'test:DELTA']) assert.ok(partial.results[0].launches.includes(lane));
        console.log(`Restart shell ${mode} evidence: ${root}`);
    });
}
