import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runClassifyChangeCommand } from '../../../src/cli/commands/gates';
import { readValidationEventSnapshot } from '../../../src/gates/project-validation/attempt-evidence';
import { validationDigest } from '../../../src/core/project-validation-identity';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode,
    runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue } from '../cli/commands/gates/preflight/gates-preflight-fixtures';

interface IdentityOptions {
    repoRoot: string; worktreeIdentity: string; taskId: string;
    taskModeSha256: string; epochSha256: string; preflight: unknown;
}
interface ExecutionIdentity {
    schema_version: number; preflight_semantic_sha256: string; identity_sha256: string;
}
interface IdentityModule {
    getIntermediatePreflightSemanticSha256(preflight: unknown): string;
    createIntermediateExecutionPreflightIdentity(options: IdentityOptions): ExecutionIdentity;
    isIntermediateExecutionPreflightIdentity(value: unknown): boolean;
}

function fixture(t: TestContext) {
    const repoRoot = createTempRepo();
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const taskId = 'T-IDENTITY-UNIT', source = 'custom/identity.case';
    seedTaskQueue(repoRoot, taskId); seedInitAnswers(repoRoot); initializeGitRepo(repoRoot);
    assert.equal(runEnterTaskMode({ repoRoot, taskId, provider: 'Codex',
        taskSummary: 'Native execution identity publication' }).exitCode, 0);
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId); runShellSmokeForTask(repoRoot, taskId);
    fs.mkdirSync(path.join(repoRoot, 'custom'));
    fs.writeFileSync(path.join(repoRoot, source), 'require("node:assert/strict").equal(1, 1);\n');
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/identity-preflight.json');
    const classified = runClassifyChangeCommand({ repoRoot, taskId,
        taskIntent: 'Native execution identity publication', changedFiles: [source], outputPath: preflightPath });
    assert.ok(fs.existsSync(preflightPath), classified.outputText);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    const observation = readValidationEventSnapshot(repoRoot, taskId) as unknown as {
        execution_preflight_identity?: ExecutionIdentity;
    };
    assert.ok(observation.execution_preflight_identity,
        'Native classification must publish an authenticated execution identity before it can authorize equivalent refreshes.');
    // Reach the existing publication boundary first so an absent new module cannot masquerade as assertion RED.
    const api = require('../../../src/core/intermediate-execution-preflight-identity') as IdentityModule;
    return { repoRoot, taskId, preflight, api, identity: observation.execution_preflight_identity };
}

test('native execution identity excludes only the valid forecast timestamp and canonicalizes object keys', t => {
    const { preflight, api, identity } = fixture(t);
    const changed = structuredClone(preflight);
    changed.budget_forecast.timestamp_utc = new Date(Date.parse(preflight.budget_forecast.timestamp_utc) + 1000).toISOString();
    assert.notEqual(validationDigest(changed), validationDigest(preflight));
    assert.equal(api.getIntermediatePreflightSemanticSha256(changed), identity.preflight_semantic_sha256);
    assert.equal(api.getIntermediatePreflightSemanticSha256(Object.fromEntries(Object.entries(changed).reverse())),
        identity.preflight_semantic_sha256);
    for (const [key, value] of [['timestamp_utc', 'foreign timestamp'], ['future_policy', { allowed: true }]] as const) {
        const meaningful = { ...changed, [key]: value };
        assert.notEqual(api.getIntermediatePreflightSemanticSha256(meaningful), identity.preflight_semantic_sha256, key);
    }
    const withoutTimestamp = structuredClone(changed);
    delete withoutTimestamp.budget_forecast.timestamp_utc;
    assert.notEqual(api.getIntermediatePreflightSemanticSha256(withoutTimestamp), identity.preflight_semantic_sha256);
    assert.throws(() => api.getIntermediatePreflightSemanticSha256({ ...changed,
        budget_forecast: { ...changed.budget_forecast, timestamp_utc: 'not-a-UTC-timestamp' } }), /timestamp|forecast|UTC/iu);
});

test('execution identity binds repository, worktree, task, run and meaningful epoch and rejects altered envelopes', t => {
    const { repoRoot, taskId, preflight, api } = fixture(t);
    const options: IdentityOptions = { repoRoot, taskId, preflight,
        worktreeIdentity: 'a'.repeat(64), taskModeSha256: 'b'.repeat(64), epochSha256: 'c'.repeat(64) };
    const identity = api.createIntermediateExecutionPreflightIdentity(options);
    assert.equal(api.isIntermediateExecutionPreflightIdentity(identity), true);
    for (const alteration of [{ repoRoot: path.join(repoRoot, 'foreign') }, { taskId: 'T-FOREIGN' },
        { worktreeIdentity: 'd'.repeat(64) }, { taskModeSha256: 'd'.repeat(64) }, { epochSha256: 'd'.repeat(64) }]) {
        assert.notEqual(api.createIntermediateExecutionPreflightIdentity({ ...options, ...alteration }).identity_sha256,
            identity.identity_sha256, JSON.stringify(alteration));
    }
    for (const alteration of [{ schema_version: 2 }, { identity_sha256: '0'.repeat(64) },
        { preflight_semantic_sha256: 'e'.repeat(64) }, { unexpected_authority: true }]) {
        assert.equal(api.isIntermediateExecutionPreflightIdentity({ ...identity, ...alteration }), false,
            JSON.stringify(alteration));
    }
    assert.equal(api.isIntermediateExecutionPreflightIdentity(null), false);
    assert.throws(() => api.createIntermediateExecutionPreflightIdentity({ ...options, worktreeIdentity: 'forged' }));
});

test('semantic identity retains unknown fields and array order and refuses non-JSON input', t => {
    const { preflight, api } = fixture(t);
    const first = { ...preflight, future_contract: { steps: ['before', 'after'], flag: true } };
    const same = { ...preflight, future_contract: { flag: true, steps: ['before', 'after'] } };
    const changed = { ...preflight, future_contract: { steps: ['after', 'before'], flag: true } };
    assert.equal(api.getIntermediatePreflightSemanticSha256(first), api.getIntermediatePreflightSemanticSha256(same));
    assert.notEqual(api.getIntermediatePreflightSemanticSha256(first), api.getIntermediatePreflightSemanticSha256(changed));
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
        assert.throws(() => api.getIntermediatePreflightSemanticSha256({ ...preflight, future_contract: value }));
    }
    const cyclic: Record<string, unknown> = { ...preflight };
    cyclic.cycle = cyclic;
    assert.throws(() => api.getIntermediatePreflightSemanticSha256(cyclic));
    assert.throws(() => api.getIntermediatePreflightSemanticSha256(Object.assign(Object.create({ hidden: true }), preflight)));
});
