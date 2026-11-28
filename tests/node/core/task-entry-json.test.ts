import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareNativeTaskEntryJson } from '../../../src/core/task-entry-json';
import { redactSensitiveData, serializeRedactedJson } from '../../../src/core/redaction';

const AUTH_PATH = 'src/core/auth/update-task-rebind.ts';
const ORDINARY_PATH = 'src/ordinary.ts';
const CONFIG_PATH = 'garda-agent-orchestrator/live/config/auth-policy.json';
const DIGEST = createHash('sha256').update('native metadata bytes').digest('hex');

function entry() {
    return {
        event_source: 'enter-task-mode', task_id: 'T-ENTRY-JSON', status: 'PASSED', outcome: 'PASS',
        dirty_workspace_baseline: { changed_files: [AUTH_PATH, ORDINARY_PATH],
            file_hashes: { [AUTH_PATH]: DIGEST, [ORDINARY_PATH]: null }, entry_authorized_files: [] },
        workflow_config_file_hashes: { [CONFIG_PATH]: DIGEST },
        auth_token: DIGEST, extra: { file_hashes: { [AUTH_PATH]: DIGEST } }
    };
}

test('native entry publication preserves only its schema-owned path digests and still redacts secrets', () => {
    const actual = JSON.parse(serializeRedactedJson(prepareNativeTaskEntryJson(entry())));
    assert.equal(actual.dirty_workspace_baseline.file_hashes[AUTH_PATH], DIGEST);
    assert.equal(actual.dirty_workspace_baseline.file_hashes[ORDINARY_PATH], null);
    assert.equal(actual.workflow_config_file_hashes[CONFIG_PATH], DIGEST);
    assert.equal(actual.auth_token, '<redacted>', 'a hex-looking credential is still a credential');
    assert.equal(actual.extra.file_hashes[AUTH_PATH], '<redacted>', 'a foreign map is not native metadata');
});

test('ordinary same-shaped entry JSON cannot select native publication by field names or SHA strings', () => {
    const input = entry();
    for (const actual of [redactSensitiveData(input), JSON.parse(serializeRedactedJson(input))]) {
        const value = actual as ReturnType<typeof entry>;
        assert.equal(value.dirty_workspace_baseline.file_hashes[AUTH_PATH], '<redacted>');
        assert.equal(value.workflow_config_file_hashes[CONFIG_PATH], '<redacted>');
        assert.equal(value.auth_token, '<redacted>');
    }
});

test('copied publication markers cannot forge an opaque native entry context', () => {
    const native = prepareNativeTaskEntryJson(entry());
    const forged = Object.assign({}, native, { payload: entry() });
    const actual = JSON.parse(serializeRedactedJson(forged));
    assert.equal(actual.payload.dirty_workspace_baseline.file_hashes[AUTH_PATH], '<redacted>');
    assert.equal(actual.payload.auth_token, '<redacted>');
});

test('native entry publication snapshots its metadata before caller mutation', () => {
    const input = entry(), publication = prepareNativeTaskEntryJson(input);
    // The native payload is a frozen private snapshot; later caller mutation never reaches it.
    input.dirty_workspace_baseline.file_hashes[AUTH_PATH] = 'f'.repeat(64);
    input.workflow_config_file_hashes[CONFIG_PATH] = 'e'.repeat(64);
    input.extra.file_hashes[AUTH_PATH] = 'caller-secret';
    const actual = JSON.parse(serializeRedactedJson(publication));
    assert.equal(actual.dirty_workspace_baseline.file_hashes[AUTH_PATH], DIGEST);
    assert.equal(actual.workflow_config_file_hashes[CONFIG_PATH], DIGEST);
    assert.equal(actual.extra.file_hashes[AUTH_PATH], '<redacted>');
    assert.equal(Object.isFrozen(publication), true);
});

test('native entry publication rejects malformed metadata and foreign baseline membership', () => {
    for (const value of ['caller-secret', 'f'.repeat(63), 'F'.repeat(64), false, {}]) {
        const input = entry();
        Object.assign(input.dirty_workspace_baseline.file_hashes, { [AUTH_PATH]: value });
        assert.throws(() => prepareNativeTaskEntryJson(input), /native baseline digest/iu);
    }
    const foreign = entry();
    Object.assign(foreign.dirty_workspace_baseline.file_hashes, { 'src/foreign.ts': DIGEST });
    assert.throws(() => prepareNativeTaskEntryJson(foreign), /native baseline digest/iu);
    const missing = entry();
    Reflect.deleteProperty(missing.dirty_workspace_baseline.file_hashes, AUTH_PATH);
    assert.throws(() => prepareNativeTaskEntryJson(missing), /native baseline digest/iu);
});

test('native entry publication validates its producer schema and supports empty baseline metadata', () => {
    assert.throws(() => prepareNativeTaskEntryJson({ ...entry(), event_source: 'caller' }), /successful entry/iu);
    assert.throws(() => prepareNativeTaskEntryJson({ ...entry(), status: 'FAILED' }), /successful entry/iu);
    const input = { ...entry(), dirty_workspace_baseline: null, workflow_config_file_hashes: null };
    const actual = JSON.parse(serializeRedactedJson(prepareNativeTaskEntryJson(input)));
    assert.equal(actual.dirty_workspace_baseline, null);
    assert.equal(actual.workflow_config_file_hashes, null);
    assert.equal(actual.auth_token, '<redacted>');
});

test('native staged path labels preserve typed digest witnesses without making arbitrary objects safe', () => {
    const input = entry();
    const witness = { schema_version: 1, status: 'present', mode: '100644',
        object_id_sha256: DIGEST, content_sha256: DIGEST, line_fingerprint_sha256: DIGEST };
    Object.assign(input.dirty_workspace_baseline, { staged_files: [AUTH_PATH], staged_trust: { schema_version: 1,
        salt: 'a'.repeat(32), files: { [AUTH_PATH]: witness } } });
    const actual = JSON.parse(serializeRedactedJson(prepareNativeTaskEntryJson(input)));
    assert.deepEqual(actual.dirty_workspace_baseline.staged_trust.files[AUTH_PATH], witness);
    Object.assign(witness, { auth_token: DIGEST });
    assert.throws(() => prepareNativeTaskEntryJson(input), /native staged trust/iu);
});
