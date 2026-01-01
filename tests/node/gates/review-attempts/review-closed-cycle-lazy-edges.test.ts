import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const bootstrap = require.resolve('../../../../src/bin/garda/derivation-source-receipts');
const driver = require.resolve('./review-closed-cycle-lazy-driver');
function child(scenario: string, root: string, noReceipts = false) {
    const output = spawnSync(process.execPath, ['-r', bootstrap, driver, scenario, root], {
        encoding: 'utf8', timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: noReceipts ? '--no-warnings' : '' }
    });
    assert.equal(output.status, 0, scenario + ': ' + output.stdout + output.stderr);
    const line = output.stdout.split(/\r?\n/u).find(value => value.startsWith('GARDA_LAZY_RESULT '));
    assert.ok(line, output.stdout + output.stderr);
    return JSON.parse(line.slice('GARDA_LAZY_RESULT '.length));
}
test('cold native summary remains valid across boundary read ordering and checklist publication', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-lazy-native-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    child('seed', root);
    await t.test('guard first then bound matrix keeps final graph validation intact', () => {
        assert.deepEqual(child('order', root), { result: true, accepted: 1, bindings: 13 });
    });
    const recorded = child('checklist', root);
    assert.ok(recorded.status, 'Native checklist must record its actual result');
    await t.test('cold navigation accepts preflight summary after native checklist with source evidence', () => {
        const read = child('read', root);
        t.diagnostic(JSON.stringify({ route: read.result.next_gate, status: read.result.status, accepted: read.accepted, bindings: read.bindings }));
        assert.deepEqual({ accepted: read.accepted, bindings: read.bindings }, { accepted: 1, bindings: 13 });
        assert.equal(read.result.status, 'BLOCKED', 'Pending checklist validation must not be bypassed');
        assert.equal(read.result.next_gate, 'run-intermediate-command', 'Current native checklist still requires execution evidence');
    });
    await t.test('consumer with unavailable receipts makes no binding comparison', () => {
        assert.deepEqual(child('unavailable', root, true), { result: null, accepted: 0, bindings: 0 });
    });
});
test('native preflight with unavailable receipts does not publish optional summary', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-lazy-no-receipts-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(child('seed', root, true), { published: false });
});
