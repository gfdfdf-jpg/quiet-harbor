import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeTaskEntryJson } from '../../../src/core/task-entry-json';
import { serializeRedactedJson } from '../../../src/core/redaction';
import { buildTaskModeArtifact } from '../../../src/gates/task-mode/task-mode-artifact';

function entry() {
    return buildTaskModeArtifact({ taskId: 'T-P3-JSON', taskSummary: 'API_TOKEN=fixture-value-secret',
        entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, effectiveDepth: 2,
        dirtyWorkspaceBaseline: { detection_source: 'git_auto', include_untracked: true,
            changed_files: ['src/auth/token.ts'], changed_files_sha256: 'a'.repeat(64), scope_sha256: 'b'.repeat(64),
            file_hashes: { 'src/auth/token.ts': 'c'.repeat(64) }, staged_files: ['src/auth/token.ts'],
            staged_trust: { schema_version: 1, salt: 'd'.repeat(32), files: { 'src/auth/token.ts': {
                schema_version: 1, status: 'present', mode: '100644', object_id_sha256: 'e'.repeat(64),
                content_sha256: 'f'.repeat(64), line_fingerprint_sha256: 'a'.repeat(64)
            } } } }, workflowConfigFileHashes: { 'garda-agent-orchestrator/live/config/workflow-config.json': null } });
}

test('P3 native JSON capability freezes identity facts while still redacting ordinary values', () => {
    const artifact = entry(), prepared = prepareNativeTaskEntryJson(artifact);
    artifact.dirty_workspace_baseline!.file_hashes['src/auth/token.ts'] = 'source mutation';
    assert.throws(() => { prepared.dirty_workspace_baseline!.file_hashes['src/auth/token.ts'] = 'API_TOKEN=mutation-secret'; }, TypeError);
    const output = serializeRedactedJson(prepared, 0), parsed = JSON.parse(output);
    assert.equal(parsed.dirty_workspace_baseline.file_hashes['src/auth/token.ts'], 'c'.repeat(64));
    assert.equal(parsed.workflow_config_file_hashes['garda-agent-orchestrator/live/config/workflow-config.json'], null);
    assert.doesNotMatch(output, /fixture-value-secret|mutation-secret|source mutation/u);
    assert.equal(output.split('\n').length, 2);
    assert.equal(JSON.parse(serializeRedactedJson(structuredClone(prepared))).dirty_workspace_baseline
        .file_hashes['src/auth/token.ts'], '<redacted>', 'a copied shape carries no native capability');
});

for (const kind of ['digest', 'membership', 'missing', 'witness', 'salt', 'config', 'status'] as const) {
    test(`P3 native JSON capability rejects invalid ${kind}`, () => {
        const artifact = entry(), baseline = artifact.dirty_workspace_baseline!;
        if (kind === 'digest') baseline.file_hashes['src/auth/token.ts'] = 'secret';
        if (kind === 'membership') baseline.file_hashes['foreign.ts'] = 'a'.repeat(64);
        if (kind === 'missing') delete baseline.file_hashes['src/auth/token.ts'];
        if (kind === 'witness') Object.assign(baseline.staged_trust!.files['src/auth/token.ts'], { extra: 'secret' });
        if (kind === 'salt') baseline.staged_trust!.salt = 'arbitrary secret';
        if (kind === 'config') artifact.workflow_config_file_hashes!['garda-agent-orchestrator/live/config/workflow-config.json'] = 'secret';
        if (kind === 'status') Object.assign(artifact, { status: 'FAILED' });
        assert.throws(() => prepareNativeTaskEntryJson(artifact), /native|Native/u);
    });
}
