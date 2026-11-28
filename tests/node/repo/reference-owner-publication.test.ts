import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { referenceProbeEnvironment } from './fixtures/reference-probe-environment';

test('matrix waits for the actual owner to publish its child before checking byte preservation', { timeout: 600_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-owner-publication-'));
    const hook = path.resolve('tests/node/repo/fixtures/matrix-owner-publication.cjs');
    // Native cell/handshake coverage is exercised by focused gate tests; do not
    // instrument the entire nested runtime during this process-ordering proof.
    const env = referenceProbeEnvironment({ NODE_TEST_CONTEXT: '', GARDA_MATRIX_OWNER_LOG: path.join(root, 'handshake.jsonl'),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(hook)}` });
    let passed = false;
    try {
        const child = spawnSync(process.execPath, ['tests/node/synthetic/review-matrix.cjs', 'run', '--only',
            'review-matrix-python--audit-recovery-no-fresh-review--strict_sequential', '--report', path.join(root, 'report')], {
            encoding: 'utf8', windowsHide: true, timeout: 570_000, maxBuffer: 2 * 1024 * 1024,
            env
        });
        fs.writeFileSync(path.join(root, 'process.log'), child.stdout + child.stderr);
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, `${root}\n${child.stdout}${child.stderr}`);
        const partial = JSON.parse(fs.readFileSync(path.join(root, 'report/review-matrix-partial.json'), 'utf8'));
        assert.equal(partial.results.length, 1);
        assert.equal(partial.results[0].outcome, 'done');
        assert.deepEqual(partial.results[0].findings, []);
        const handshake = fs.readFileSync(path.join(root, 'handshake.jsonl'), 'utf8');
        assert.match(handshake, /"publication":/u);
        assert.match(handshake, /"observation":/u);
        assert.match(handshake, /observer released publication/u);
        passed = true;
    } finally {
        if (passed) fs.rmSync(root, { recursive: true, force: true });
    }
});
