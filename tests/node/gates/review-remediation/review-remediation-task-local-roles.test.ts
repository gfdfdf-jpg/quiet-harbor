import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256 } from '../../../../src/gate-runtime/hash';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { declaredFileRole } from '../../../../src/core/file-role-bindings';
import { getClassificationConfig } from '../../../../src/gates/preflight/classify-change';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../../src/policy/review-trigger-policy';
import { buildDefaultReviewRemediationModePolicy } from '../../../../src/policy/review-remediation-mode-policy';
import { getReviewRemediationScopeReviewTypesViolations } from '../../../../src/gates/review-remediation/review-remediation-scope-review-types';
import { resolveRemediationTaskRoleConfig, reviewRemediationDeltaInternals } from '../../../../src/gates/review-remediation/review-remediation-delta';
import { resolveRuntimeDecisionInputs } from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import { buildLeafTestDeltaClassification } from '../next-step/next-step-benchmark-remediation-fixture';
import { createTempRepo } from '../../cli/commands/gate-test-helpers';

test('independent scope verification recognizes only authenticated task-local test declarations', () => {
    const repoRoot = createTempRepo();
    try {
        const taskId = 'T-ROLES';
        const file = 'qa/orders/purchase.case';
        const configRoot = path.join(repoRoot, 'garda-agent-orchestrator/live/config');
        fs.copyFileSync(path.resolve('template/config/paths.json'), path.join(configRoot, 'paths.json'));
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, taskId + '-preflight.json');
        const preflightText = JSON.stringify({ task_id: taskId, declared_test_paths: [file] }, null, 2) + '\n';
        fs.writeFileSync(preflightPath, preflightText);
        const preflightSha256 = fileSha256(preflightPath)!;
        const policy = buildDefaultReviewRemediationModePolicy();
        const profilePolicySnapshot = { review_remediation_mode_policy: policy };
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId, reviewType: 'test', changedFile: file,
            preflightPath, preflightSha256, profilePolicySnapshot, modePolicy: policy });
        delta.category = 'leaf_test';
        delta.file_deltas[0].category = 'leaf_test';
        delta.mode_policy_assessment!.scope_review_types = ['test'];
        delta.mode_policy_assessment!.full_review_types = [];
        Object.assign(delta, { task_role_preflight_text: preflightText });
        const options = { repoRoot, delta, profilePolicySnapshot, authenticatedPreflightSha256: preflightSha256 };
        assert.deepEqual(getReviewRemediationScopeReviewTypesViolations(options), []);
        Object.assign(delta, { task_role_preflight_text: preflightText.replace(file, 'qa/other.case') });
        assert.notDeepEqual(getReviewRemediationScopeReviewTypesViolations(options), []);
        Object.assign(delta, { task_role_preflight_text: preflightText });
        delta.file_deltas[0].category = 'production';
        assert.match(getReviewRemediationScopeReviewTypesViolations(options).join(' '), /categories do not match/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
    }
});

test('task roles cannot override production sources or authenticate foreign preflights', () => {
    const repoRoot = createTempRepo();
    try {
        const taskId = 'T-ROLE-SOURCE';
        const config = getClassificationConfig(repoRoot);
        const explicitSource = 'src/payments.test.ts';
        const runtimeSource = 'src/orders/purchase.case';
        const testFile = 'qa/orders/purchase.case';
        const testFixture = 'tests/fixtures/project/package.json';
        const protectedFiles = ['package.json', 'Dockerfile', '.env', 'config/routes.yaml', 'AGENTS.md',
            'vendor/acme/tests/parser.test.ts', 'build/tests/a.js'];
        const preflight = { task_id: taskId, declared_test_paths: [explicitSource, runtimeSource, testFile, testFixture, ...protectedFiles] };
        const preflightPath = path.join(repoRoot, 'preflight.json');
        const preflightText = JSON.stringify(preflight, null, 2) + '\n';
        fs.writeFileSync(preflightPath, preflightText);
        const hash = fileSha256(preflightPath)!;
        const options = { repoRoot, taskId, preflightText, authenticatedPreflightHashes: [hash],
            config: { ...config, file_roles: { [explicitSource]: 'source' as const } } };
        const roles = resolveRemediationTaskRoleConfig(options).file_roles;
        assert.equal(declaredFileRole(explicitSource, roles), 'source');
        assert.notEqual(declaredFileRole(runtimeSource, roles), 'test');
        assert.equal(declaredFileRole(testFile, roles), 'test');
        assert.equal(declaredFileRole(testFixture, roles), 'test');
        for (const filePath of protectedFiles) assert.notEqual(declaredFileRole(filePath, roles), 'test', filePath);
        for (const filePath of [explicitSource, runtimeSource]) {
            const result = reviewRemediationDeltaInternals.categorizeFile({ filePath, operation: 'modified', changedLines: 2,
                lineDeltaUnavailableReason: null, baselineStatus: 'text', currentStatus: 'text',
                testPathRegexes: config.test_trigger_regexes, fileRoles: roles, structuralPatterns: [], structuralThreshold: 50 });
            assert.equal(result.category, 'production', filePath);
        }
        assert.throws(() => resolveRemediationTaskRoleConfig({ ...options, authenticatedPreflightHashes: ['0'.repeat(64)] }), /not authenticated/u);
        assert.throws(() => resolveRemediationTaskRoleConfig({ ...options, taskId: 'T-OTHER' }), /this task/u);
        assert.throws(() => resolveRemediationTaskRoleConfig({ ...options, preflightText: preflightText + ' ' }), /not authenticated/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
    }
});

for (const file of ['qa/orders/purchase.case', 'docs/qa/purchase.md']) test(
    'recovery authenticates a task-local test even with an unfamiliar or documentation-shaped name: ' + file, () => {
    const repoRoot = createTempRepo();
    try {
        const taskId = 'T-ROLE-PRODUCER';
        const bundle = path.join(repoRoot, 'garda-agent-orchestrator');
        fs.copyFileSync(path.resolve('template/config/paths.json'), path.join(bundle, 'live/config/paths.json'));
        const reviewsRoot = path.join(bundle, 'runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, taskId + '-preflight.json');
        const preflight = { task_id: taskId, declared_test_paths: [file] };
        fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n');
        const preflightSha256 = fileSha256(preflightPath)!;
        const profilePolicySnapshot = { review_remediation_mode_policy: buildDefaultReviewRemediationModePolicy(),
            review_trigger_policy: DEFAULT_REVIEW_TRIGGER_POLICY };
        const baseline = buildLeafTestDeltaClassification({ repoRoot, taskId, reviewType: 'test', changedFile: file,
            preflightPath, preflightSha256, profilePolicySnapshot });
        const baselineHash = baseline.baseline.artifact_sha256;
        const snapshot = path.join(reviewsRoot, `${taskId}-test-remediation-baseline-${baselineHash}.json`);
        fs.copyFileSync(baseline.baseline.artifact_path, snapshot);
        appendTaskEvent(bundle, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Classified.', {
            output_path: preflightPath, output_sha256: preflightSha256
        });
        appendTaskEvent(bundle, taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Compiled.', {
            task_id: taskId, preflight_path: preflightPath, preflight_hash_sha256: preflightSha256
        });
        appendTaskEvent(bundle, taskId, 'REVIEW_RECORDED', 'PASS', 'Recorded baseline.', {
            task_id: taskId, review_type: 'test', review_execution_mode: 'FULL',
            remediation_baseline_snapshot_path: snapshot, remediation_baseline_snapshot_sha256: baselineHash
        });
        const options = { repoRoot, taskId, remediationReviewType: 'test', requiredReviewTypes: ['code', 'test'],
            remediationFixClassification: { category: 'production', reason: '', blocked_before_reuse: false,
                invalidated_review_types: ['code', 'test'] },
            profilePolicySnapshot, currentChangedFiles: [file], reviewTriggerPolicy: DEFAULT_REVIEW_TRIGGER_POLICY,
            allowAuthenticatedDelta: true, preflightPayload: preflight, preflightPath };
        const result = resolveRuntimeDecisionInputs(options);
        assert.equal(result.classification.source, 'delta');
        if (result.classification.source !== 'delta') return;
        assert.equal(result.classification.delta.category, 'leaf_test');
        assert.deepEqual(result.classification.delta.mode_policy_assessment?.scope_review_types, ['test']);
        assert.ok(result.classification.delta.task_role_preflight_text);

        fs.writeFileSync(preflightPath, JSON.stringify({ ...preflight, declared_test_paths: ['src/forged.ts'] }) + '\n');
        const stale = resolveRuntimeDecisionInputs(options);
        assert.equal(stale.classification.source, 'delta');
        if (stale.classification.source === 'delta') {
            assert.equal(stale.classification.delta.category, 'production');
            assert.equal(stale.classification.delta.task_role_preflight_text, undefined);
        }
        fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n');
        appendTaskEvent(bundle, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'An uncompiled preflight.', {
            output_path: preflightPath, output_sha256: preflightSha256
        });
        const uncompiled = resolveRuntimeDecisionInputs(options);
        assert.equal(uncompiled.classification.source, 'delta');
        if (uncompiled.classification.source === 'delta') {
            assert.equal(uncompiled.classification.delta.category, 'production');
            assert.equal(uncompiled.classification.delta.task_role_preflight_text, undefined);
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
    }
});
