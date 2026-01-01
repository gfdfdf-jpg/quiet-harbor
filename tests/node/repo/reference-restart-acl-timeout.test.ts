import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

test('review-cycle restart recovers from a native ACL timeout and produces both required DELTA reviews', { skip: process.platform !== 'win32', timeout: 600_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-acl-'));
    const hook = path.resolve('tests/node/repo/fixtures/matrix-acl-timeout.cjs');
    const child = spawnSync(process.execPath, ['tests/node/synthetic/review-matrix.cjs', 'run', '--only',
        'review-matrix-polyglot-python-go--source-line-limit-240--test_after_code', '--report', path.join(root, 'report')], {
        encoding: 'utf8', windowsHide: true, timeout: 570_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NODE_TEST_CONTEXT: '', GARDA_MATRIX_ACL_INJECTION_LOG: path.join(root, 'injection.json'),
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(hook)}` }
    });
    fs.writeFileSync(path.join(root, 'process.log'), child.stdout + child.stderr);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, `${root}\n${child.stdout}${child.stderr}`);
    assert.ok(fs.existsSync(path.join(root, 'injection.json')), 'a real restart must reach the injected native probe');
    const partial = JSON.parse(fs.readFileSync(path.join(root, 'report/review-matrix-partial.json'), 'utf8'));
    assert.equal(partial.results.length, 1);
    assert.equal(partial.results[0].outcome, 'done');
    assert.deepEqual(partial.results[0].findings, []);
    for (const lane of ['code:DELTA', 'test:DELTA']) assert.ok(partial.results[0].launches.includes(lane));
    console.log('Restart ACL evidence: ' + root);
});
