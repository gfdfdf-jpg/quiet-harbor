import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    MAXIMUM_TOOL_BYTES, parseFileIdentity, readObservedValidationFile, readValidationTool
} from '../../../src/core/project-validation-identity';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';

const RETAINED_INPUT_BYTES = 128 * 1024 * 1024;

function fixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'garda-tool-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function streamedSha256(file: string): string {
    const digest = createHash('sha256'), descriptor = fs.openSync(file, 'r'), chunk = Buffer.alloc(1024 * 1024);
    try {
        for (let count = fs.readSync(descriptor, chunk); count > 0; count = fs.readSync(descriptor, chunk)) digest.update(chunk.subarray(0, count));
    } finally { fs.closeSync(descriptor); }
    return digest.digest('hex');
}

test('admits an audited executable above the retained input bound with a streamed identity', t => {
    // Node 26 release binaries are about 143 MiB on Linux and 141 MiB on macOS.
    const root = fixture(t), tool = path.join(root, 'node');
    fs.writeFileSync(tool, 'tool-head');
    fs.truncateSync(tool, RETAINED_INPUT_BYTES + 4096);
    const expected = { path: tool, sha256: streamedSha256(tool), size: RETAINED_INPUT_BYTES + 4096 };
    const direct = readValidationTool(tool);
    assert.deepEqual({ path: direct.path, sha256: direct.sha256, size: direct.size }, expected);
    const observed = withInvocationReadObservation(() => readValidationTool(tool));
    assert.deepEqual(observed, direct);
    assert.deepEqual(parseFileIdentity(direct, tool, MAXIMUM_TOOL_BYTES), direct);
    // Ordinary validation inputs keep the retained bound.
    assert.throws(() => readObservedValidationFile(root, 'node'), /byte bound/u);
    assert.throws(() => withInvocationReadObservation(() => readObservedValidationFile(root, 'node')), /byte bound/u);
    assert.throws(() => parseFileIdentity(direct, tool), /Invalid approved file identity/u);
});

test('refuses an audited executable above the tool bound, hard-linked or relative', t => {
    const root = fixture(t), oversized = path.join(root, 'oversized');
    fs.writeFileSync(oversized, '');
    fs.truncateSync(oversized, MAXIMUM_TOOL_BYTES + 1);
    assert.throws(() => readValidationTool(oversized), /byte bound/u);
    assert.throws(() => withInvocationReadObservation(() => readValidationTool(oversized)), /byte bound/u);
    assert.throws(() => parseFileIdentity({ path: oversized, sha256: 'a'.repeat(64), size: MAXIMUM_TOOL_BYTES + 1, identity: '1:2:3' },
        oversized, MAXIMUM_TOOL_BYTES), /Invalid approved file identity/u);

    const tool = path.join(root, 'tool'), link = path.join(root, 'tool-link');
    fs.writeFileSync(tool, 'tool');
    fs.linkSync(tool, link);
    assert.throws(() => readValidationTool(tool), /hard-linked|byte bound/u);
    assert.throws(() => withInvocationReadObservation(() => readValidationTool(link)), /hard-linked|byte bound/u);
    assert.throws(() => readValidationTool('tool'), /absolute path/u);
});

test('streamed and retained identities agree for the same small executable', t => {
    const root = fixture(t), tool = path.join(root, 'tool');
    fs.writeFileSync(tool, 'small tool bytes');
    const streamed = readValidationTool(tool), retained = readObservedValidationFile(root, 'tool').identity;
    assert.equal(streamed.sha256, retained.sha256);
    assert.equal(streamed.size, retained.size);
    assert.equal(streamed.identity, retained.identity);
    assert.equal(streamed.sha256, createHash('sha256').update('small tool bytes').digest('hex'));
});
