import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reviewRemediationDeltaInternals, classifyReviewRemediationDelta, type ReviewRemediationFileDelta } from '../../../../src/gates/review-remediation/review-remediation-delta';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../../src/policy/review-trigger-policy';
import { collectRestartRequiredReviewTypes } from '../../../../src/cli/commands/gate-flows/compile/compile-flow-classify';
import { compileReviewDependencyGraph } from '../../../../src/core/review-dependency-graph';
import { resolveRuntimeReviewRemediationModeGuards } from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import { createTempRepo } from '../../cli/commands/gate-test-helpers';
import { buildLeafTestDeltaClassification } from '../next-step/next-step-benchmark-remediation-fixture';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { buildDefaultReviewRemediationModePolicy, evaluateReviewRemediationMode } from '../../../../src/policy/review-remediation-mode-policy';
import { collectReviewRemediationScopeReviewTypes, getReviewRemediationDeltaHistoryViolations, getReviewRemediationScopeReviewTypesViolations,
    resolveRemediationRepositoryRoot } from '../../../../src/gates/review-remediation/review-remediation-scope-review-types';
import { buildReviewRemediationReviewContract, getRemediationContractClassificationBindingViolations, resolveFixPreservedTreeStateSha256s } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { fileSha256 } from '../../../../src/gate-runtime/hash';
import { bindAuthoritativeRemediationDecisionToPreflight, resolvePersistedRemediationReusePolicy } from '../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { writeReviewClassificationSnapshot } from '../../../../src/gates/review-remediation/review-remediation-classification-evidence';
import { buildDefaultReviewRemediationRerunPolicy } from '../../../../src/policy/review-remediation-rerun-policy';

for (const boundary of ['linked', 'unlinked', 'missing-classification', 'unauthenticated', 'reached-lane', 'older-unusable'] as const) test(
    'kept review crosses consecutive decisions only with preserved authenticated tree links: ' + boundary, () => {
    const repoRoot = createTempRepo();
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.copyFileSync(path.resolve('template/config/paths.json'), path.join(bundleRoot, 'live/config/paths.json'));
        const preflightPath = path.join(reviewsRoot, 'T-CHAIN-preflight.json');
        fs.writeFileSync(preflightPath, '{}\n');
        const preflightSha256 = fileSha256(preflightPath)!;
        const policy = buildDefaultReviewRemediationModePolicy();
        policy.delta_eligible_review_types = [];
        const profilePolicySnapshot = { review_remediation_mode_policy: policy,
            review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy() };
        const build = (reviewType: string, tree: string, changedFile: string) => {
            const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-CHAIN', reviewType, changedFile,
                preflightPath, preflightSha256, profilePolicySnapshot, modePolicy: policy, baselineTreeStateSha256: tree });
            const inputs = { consecutiveDeltaReviews: 0, protectedBoundarySignals: [],
                scopeReviewTypes: changedFile.includes('/cache/') ? ['code', 'performance', 'test'] : ['code', 'test'],
                taskCriteriaChanged: false, policyChanged: false, uncertainCrossFileImpact: false };
            delta.mode_policy_assessment = evaluateReviewRemediationMode({ policy, reviewType, category: delta.category,
                changedFilesCount: delta.changed_files.length, changedLinesTotal: delta.changed_lines_total, ...inputs });
            delta.full_review_reasons = delta.mode_policy_assessment.full_review_reasons;
            const { classification_sha256: _, ...body } = delta;
            delta.classification_sha256 = sha256RedactedJsonPayload(body);
            const classification = { source: 'delta' as const, delta, profilePolicySnapshot,
                baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot) };
            const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
                taskId: delta.task_id, currentReviewType: reviewType, classification, modePolicyValidationInputs: inputs,
                requiredReviews: { code: true, performance: true, test: true }, reviewExecutionPolicyMode: 'strict_sequential'
            }), preflightSha256);
            return { classification, decision };
        };
        if (boundary === 'older-unusable') {
            appendTaskEvent(bundleRoot, 'T-CHAIN', 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Older unusable restart.', {});
        }
        const previous = build('test', 'a'.repeat(64), boundary === 'reached-lane' ? 'src/cache/CacheStore.ts' : 'src/app.ts');
        const reference = writeReviewClassificationSnapshot({ reviewsRoot, taskId: 'T-CHAIN', classification: previous.classification });
        appendTaskEvent(bundleRoot, 'T-CHAIN', 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Authenticated previous fix.', {
            task_id: 'T-CHAIN', event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', preflight_sha256: preflightSha256,
            review_tree_state_sha256: (boundary === 'unlinked' ? 'c' : 'b').repeat(64),
            authoritative_review_decision: previous.decision, authoritative_review_classification_reference: reference
        });
        if (boundary === 'missing-classification') fs.rmSync(reference.artifact_path);
        if (boundary === 'unauthenticated') {
            const timelinePath = path.join(bundleRoot, 'runtime/task-events/T-CHAIN.jsonl');
            fs.writeFileSync(timelinePath, fs.readFileSync(timelinePath, 'utf8').replace('Authenticated previous fix.', 'Tampered previous fix.'));
        }
        const current = build('code', 'b'.repeat(64), 'src/app.ts');
        const authority = { taskId: 'T-CHAIN', reviewType: 'performance', preflightSha256, mode: 'FULL' as const,
            fullReviewScope: current.classification.delta.scope.full_review_scope,
            persistedDecisionSha256: current.decision.decision_sha256, authoritativeDecisionSha256: current.decision.decision_sha256,
            authoritativeClassificationSha256: current.classification.delta.classification_sha256,
            authoritativeDecision: current.decision, authoritativeClassification: current.classification };
        assert.deepEqual(resolveFixPreservedTreeStateSha256s(authority), (boundary === 'linked' || boundary === 'older-unusable')
            ? ['b'.repeat(64), 'a'.repeat(64)] : ['b'.repeat(64)]);
        if (boundary === 'linked') {
            const lane = current.decision.lane_decisions.find((entry) => entry.review_type === 'performance')!;
            lane.mode = 'REUSE';
            lane.satisfied = true;
            lane.satisfaction_source = 'REUSED';
            lane.reason_code = 'authoritative_reuse_accepted';
            const { reason_sha256: _, ...laneBody } = lane;
            lane.reason_sha256 = sha256RedactedJsonPayload(laneBody);
            current.decision.reused_review_types = ['performance'];
            current.decision.satisfied_review_types = ['performance'];
            const { decision_sha256: __, ...decisionBody } = current.decision;
            current.decision.decision_sha256 = sha256RedactedJsonPayload(decisionBody);
            const currentReference = writeReviewClassificationSnapshot({ reviewsRoot, taskId: 'T-CHAIN', classification: current.classification });
            appendTaskEvent(bundleRoot, 'T-CHAIN', 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Kept review was accepted.', {
                task_id: 'T-CHAIN', event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', preflight_sha256: preflightSha256,
                review_tree_state_sha256: 'c'.repeat(64), authoritative_review_decision: current.decision,
                authoritative_review_classification_reference: currentReference
            });
            const timelinePath = path.join(bundleRoot, 'runtime/task-events/T-CHAIN.jsonl');
            const events = fs.readFileSync(timelinePath, 'utf8').trim().split(/\r?\n/u)
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            const persisted = resolvePersistedRemediationReusePolicy({ events, taskId: 'T-CHAIN', reviewType: 'performance',
                preflightPath, timelinePath, preflightPayload: { changed_files: current.classification.delta.scope.full_review_scope } });
            assert.equal(persisted.failClosed, undefined, persisted.blockedReason);
            assert.equal(persisted.persistedRemediationReuseRequired, true);
            assert.deepEqual(persisted.remediationFixBaseTreeStateSha256s, ['b'.repeat(64), 'a'.repeat(64)],
                'accepted REUSE keeps the authenticated proof when a refreshed full-suite binding rebuilds its context');
        }

    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const signal of ['path:app', 'paths:app', 'trigger:runtime-code-changed', 'task:unavailable-intent']) test('custom scope uses the preflight signal evaluator: ' + signal, () => {
    const repoRoot = createTempRepo();
    try {
        const configRoot = path.join(repoRoot, 'garda-agent-orchestrator/live/config');
        const skillId = signal === 'paths:app' ? 'custom-review' : 'code-review';
        if (skillId === 'custom-review') fs.writeFileSync(path.join(configRoot, 'skills-headlines.json'), JSON.stringify({
            version: 2, installed_pack_ids: [], baseline_skill_ids: [], installed_optional_skill_ids: [], custom_skill_ids: [skillId],
            optional_packs: [], skills: [{ id: skillId, directory: skillId, name: 'Custom review', summary: 'Review custom boundaries.',
                pack: null, source: 'custom_live', implemented: true, review_binding: 'review_bound', aliases: [],
                task_signals: [], changed_path_signals: [], tags: [] }]
        }));
        fs.writeFileSync(path.join(configRoot, 'review-catalog.json'), JSON.stringify({ version: 1, custom_review_types: [{
            id: 'custom-quality', display_label: 'Custom quality', enabled_by_default: false, skill_id: skillId,
            trigger: { mode: 'signals', signal_ids: [signal] }, coverage_category_ids: ['maintainability'],
            reviewer_role: { role_id: 'quality-reviewer', focus_tags: ['maintainability'] }
        }] }));
        fs.copyFileSync(path.resolve('template/config/paths.json'), path.join(configRoot, 'paths.json'));
        const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-CUSTOM-preflight.json');
        fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
        fs.writeFileSync(preflightPath, '{}\n');
        const policy = buildDefaultReviewRemediationModePolicy();
        const profilePolicySnapshot = { review_remediation_mode_policy: policy };
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-CUSTOM', reviewType: 'test', changedFile: 'src/app.ts',
            preflightPath, preflightSha256: sha256RedactedJsonPayload({}), profilePolicySnapshot, modePolicy: policy });
        const collect = (reached: boolean) => collectReviewRemediationScopeReviewTypes({ repoRoot, fileDeltas: delta.file_deltas,
            triggers: { runtime_code_changed: reached }, securityWord: false });
        assert.ok(collect(true).includes('custom-quality'));
        if (signal.startsWith('trigger:')) assert.equal(collect(false).includes('custom-quality'), false);
        delta.mode_policy_assessment!.scope_review_types = ['code', 'custom-quality', 'test'];
        delta.mode_policy_assessment!.full_review_types = [];
        assert.deepEqual(getReviewRemediationScopeReviewTypesViolations({ repoRoot, delta, profilePolicySnapshot }), []);
        delta.mode_policy_assessment!.scope_review_types = ['code', 'test'];
        assert.match(getReviewRemediationScopeReviewTypesViolations({ repoRoot, delta, profilePolicySnapshot }).join(' '), /recomputed fix paths/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const layout of ['nested', 'root', 'named-root'] as const) test('review contract resolves the real repository with ' + layout + ' bundle layout', () => {
    const repoRoot = createTempRepo();
    try {
        const policy = buildDefaultReviewRemediationModePolicy();
        policy.delta_eligible_review_types = [];
        const profilePolicySnapshot = { review_remediation_mode_policy: policy };
        const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-ROOT-preflight.json');
        fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
        fs.writeFileSync(preflightPath, '{}\n');
        const preflightSha256 = sha256RedactedJsonPayload({});
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-ROOT', reviewType: 'code', changedFile: 'src/app.ts',
            preflightPath, preflightSha256, profilePolicySnapshot, modePolicy: policy });
        const nested = layout === 'nested';
        const targetRoot = nested ? repoRoot : path.join(repoRoot, 'flat', ...(layout === 'named-root' ? ['garda-agent-orchestrator'] : []));
        const bundleRoot = nested ? path.join(targetRoot, 'garda-agent-orchestrator') : targetRoot;
        fs.mkdirSync(path.join(bundleRoot, 'live/config'), { recursive: true });
        if (!nested) fs.mkdirSync(path.join(bundleRoot, '.git'), { recursive: true });
        fs.copyFileSync(path.resolve('template/config/paths.json'), path.join(bundleRoot, 'live/config/paths.json'));
        if (!nested) {
            const baselinePath = path.join(bundleRoot, 'runtime/reviews', path.basename(delta.baseline.artifact_path));
            fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
            fs.copyFileSync(delta.baseline.artifact_path, baselinePath);
            delta.baseline.artifact_path = baselinePath.replace(/\\/gu, '/');
        }
        assert.equal(resolveRemediationRepositoryRoot(delta.baseline.artifact_path), targetRoot);
        const inputs = { consecutiveDeltaReviews: 0, protectedBoundarySignals: [], scopeReviewTypes: ['code', 'test'],
            taskCriteriaChanged: false, policyChanged: false, uncertainCrossFileImpact: false };
        delta.mode_policy_assessment = evaluateReviewRemediationMode({ policy, reviewType: 'code', category: delta.category,
            changedFilesCount: delta.changed_files.length, changedLinesTotal: delta.changed_lines_total, ...inputs });
        delta.full_review_reasons = delta.mode_policy_assessment.full_review_reasons;
        const { classification_sha256: _, ...body } = delta;
        delta.classification_sha256 = sha256RedactedJsonPayload(body);
        const classification = { source: 'delta' as const, delta, profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot) };
        const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
            taskId: delta.task_id, currentReviewType: 'code', classification, modePolicyValidationInputs: inputs,
            requiredReviews: { code: true, test: true }, reviewExecutionPolicyMode: 'strict_sequential'
        }), preflightSha256);
        assert.equal(buildReviewRemediationReviewContract({ taskId: delta.task_id, reviewType: 'code', preflightSha256,
            fullReviewScope: delta.scope.full_review_scope, authoritativeDecision: decision, classification }).mode, 'FULL');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('scope authentication accepts preflight-safe documentation inside test folders', () => {
    const repoRoot = createTempRepo();
    try {
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.copyFileSync(path.resolve('template/config/paths.json'), path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json'));
        const preflightPath = path.join(reviewsRoot, 'T-DOC-SCOPE-preflight.json');
        fs.writeFileSync(preflightPath, '{}\n');
        const policy = buildDefaultReviewRemediationModePolicy();
        const profilePolicySnapshot = { review_remediation_mode_policy: policy };
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-DOC-SCOPE', reviewType: 'test',
            changedFile: 'tests/README.md', preflightPath, preflightSha256: sha256RedactedJsonPayload({}),
            profilePolicySnapshot, modePolicy: policy });
        delta.documents_only = true;
        delta.mode_policy_assessment!.scope_review_types = [];
        delta.mode_policy_assessment!.full_review_types = [];
        assert.deepEqual(getReviewRemediationScopeReviewTypesViolations({ repoRoot, delta, profilePolicySnapshot }), []);
        delta.file_deltas[0].current_status = 'symbolic_link';
        assert.match(getReviewRemediationScopeReviewTypesViolations({ repoRoot, delta, profilePolicySnapshot }).join(' '), /documents-only marker/u);
        delta.file_deltas[0].current_status = 'text';
        delta.file_deltas[0].current_mode = (delta.file_deltas[0].baseline_mode ?? 0) + 1;
        assert.match(getReviewRemediationScopeReviewTypesViolations({ repoRoot, delta, profilePolicySnapshot }).join(' '), /documents-only marker/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
    }
});

for (const file of ['orders/invoice.py', 'src/auth/session.ts']) test('scope authentication rejects rehashed lane pruning for ' + file, () => {
    const repoRoot = createTempRepo();
    try {
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.copyFileSync(path.resolve('template/config/paths.json'), path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json'));
        const preflightPath = path.join(reviewsRoot, 'T-SCOPE-preflight.json');
        fs.writeFileSync(preflightPath, '{}\n');
        const policy = buildDefaultReviewRemediationModePolicy();
        const profilePolicySnapshot = { review_remediation_mode_policy: policy };
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-SCOPE', reviewType: 'test', changedFile: file,
            preflightPath, preflightSha256: sha256RedactedJsonPayload({}), profilePolicySnapshot, modePolicy: policy });
        const assessment = delta.mode_policy_assessment!;
        assessment.scope_review_types = file.includes('/auth/') ? ['code', 'security', 'test'] : ['code', 'test'];
        assessment.full_review_types = file.includes('/auth/') ? ['security'] : [];
        const check = () => getReviewRemediationScopeReviewTypesViolations({ repoRoot, delta, profilePolicySnapshot });
        assert.deepEqual(check(), []);
        assessment.scope_review_types = ['test'];
        const { assessment_sha256: _, ...assessmentBody } = assessment;
        assessment.assessment_sha256 = sha256RedactedJsonPayload(assessmentBody);
        const { classification_sha256: __, ...deltaBody } = delta;
        delta.classification_sha256 = sha256RedactedJsonPayload(deltaBody);
        assert.match(check().join(' '), /recomputed fix paths/u);
        assert.ok(getReviewRemediationDeltaHistoryViolations({ repoRoot, delta, reviewType: 'code', profilePolicySnapshot }).length,
            'an absent prior lane receipt cannot authorize a non-origin DELTA');
        delta.documents_only = true;
        assessment.scope_review_types = [];
        assessment.full_review_types = [];
        assert.match(check().join(' '), /documents-only marker/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
    }
});

for (const scopeMembershipChanged of [false, true]) test(
    (scopeMembershipChanged ? 'expanded' : 'unclassified') + ' scopes require every lane FULL despite rehashed preservation', () => {
    const repoRoot = createTempRepo();
    try {
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, 'T-UNKNOWN-preflight.json');
        fs.writeFileSync(preflightPath, '{}\n');
        const preflightSha256 = sha256RedactedJsonPayload({});
        const policy = buildDefaultReviewRemediationModePolicy();
        const profilePolicySnapshot = { review_remediation_mode_policy: policy };
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-UNKNOWN', reviewType: 'test',
            changedFile: 'tests/app.test.ts', preflightPath, preflightSha256, profilePolicySnapshot, modePolicy: policy });
        const inputs = { consecutiveDeltaReviews: 0, protectedBoundarySignals: [], scopeReviewTypes: scopeMembershipChanged ? ['test'] : null,
            taskCriteriaChanged: false, policyChanged: false, uncertainCrossFileImpact: false };
        delta.scope.membership_unchanged = !scopeMembershipChanged;
        delta.mode_policy_assessment = evaluateReviewRemediationMode({ policy, reviewType: 'test', category: delta.category,
            changedFilesCount: delta.changed_files.length, changedLinesTotal: delta.changed_lines_total, scopeMembershipChanged, ...inputs });
        delta.full_review_required = true;
        delta.full_review_reasons = delta.mode_policy_assessment.full_review_reasons;
        const { classification_sha256: _, ...deltaBody } = delta;
        delta.classification_sha256 = sha256RedactedJsonPayload(deltaBody);
        const classification = { source: 'delta' as const, delta, profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot) };
        const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
            taskId: delta.task_id, currentReviewType: 'test', classification, modePolicyValidationInputs: inputs,
            requiredReviews: { code: true, security: true, test: true }, reviewExecutionPolicyMode: 'strict_sequential'
        }), preflightSha256);
        assert.equal(decision.status, 'READY', decision.blocked_reasons.join(' '));
        assert.ok(decision.lane_decisions.every((lane) => lane.invalidated && lane.mode === 'FULL' && !lane.reuse_eligible));
        const build = () => buildReviewRemediationReviewContract({ taskId: delta.task_id, reviewType: 'code', preflightSha256,
            fullReviewScope: delta.scope.full_review_scope, authoritativeDecision: decision, classification });
        assert.equal(build().mode, 'FULL');
        const lane = decision.lane_decisions.find((entry) => entry.review_type === 'security')!;
        lane.invalidated = false;
        lane.reuse_eligible = true;
        const { reason_sha256: __, ...laneBody } = lane;
        lane.reason_sha256 = sha256RedactedJsonPayload(laneBody);
        decision.invalidated_review_types = ['code', 'test'];
        decision.preserved_review_types = ['security'];
        const { decision_sha256: ___, ...decisionBody } = decision;
        decision.decision_sha256 = sha256RedactedJsonPayload(decisionBody);
        assert.throws(build, /every lane to be invalidated in FULL/u);
        fs.rmSync(delta.baseline.artifact_path);
        assert.throws(build, /authenticated remediation baseline is unavailable/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
    }
});

test('file categories keep source-root test helpers and declared tests out of code scope despite runtime flag', () => {
    const structuralPatterns = reviewRemediationDeltaInternals.compilePatterns(
        DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes, 'structural');
    for (const file of ['src/setupTests.ts', 'src/__mocks__/api.ts', 'src/special.ts']) {
        const category = reviewRemediationDeltaInternals.categorizeFile({ filePath: file, operation: 'modified',
            changedLines: 1, lineDeltaUnavailableReason: null, baselineStatus: 'text', currentStatus: 'text',
            testPathRegexes: DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes, fileRoles: { 'src/special.ts': 'test' },
            structuralPatterns, structuralThreshold: 50 });
        const lanes = collectReviewRemediationScopeReviewTypes({ triggers: { runtime_code_changed: true },
            securityWord: false, fileDeltas: [{ ...category, path: file } as ReviewRemediationFileDelta] });
        assert.equal(lanes.includes('code'), false, file);
    }
    assert.deepEqual(collectReviewRemediationScopeReviewTypes({ triggers: { runtime_code_changed: true },
        securityWord: false, fileDeltas: [] }), ['code', 'test']);
});

test('new large documents cannot spend the source delta snapshot budget', () => {
    const repoRoot = createTempRepo();
    try {
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, 'T-BUDGET-preflight.json');
        fs.writeFileSync(preflightPath, '{}\n');
        const policy = buildDefaultReviewRemediationModePolicy();
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-BUDGET', reviewType: 'code',
            changedFile: 'src/app.ts', preflightPath, preflightSha256: sha256RedactedJsonPayload({}),
            profilePolicySnapshot: { review_remediation_mode_policy: policy }, modePolicy: policy });
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        for (const file of ['docs/a.md', 'docs/b.md', 'docs/c.md']) fs.writeFileSync(path.join(repoRoot, file), 'text\n'.repeat(8000));
        const current = classifyReviewRemediationDelta({ repoRoot, taskId: 'T-BUDGET', reviewType: 'code',
            baselineArtifactPath: delta.baseline.artifact_path, baselineArtifactSha256: delta.baseline.artifact_sha256,
            currentChangedFiles: ['docs/a.md', 'docs/b.md', 'docs/c.md', 'src/app.ts'], modePolicy: policy,
            isOrdinaryDocument: (file) => file.startsWith('docs/') });
        assert.equal(current.full_review_required, false, current.full_review_reasons.join(' '));
        assert.deepEqual(current.changed_files, ['src/app.ts']);
        assert.ok(current.file_deltas[0].changed_lines! > 0);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('preflight retains authenticated restart owners across later classifications until a new task entry', () => {
    const repoRoot = createTempRepo();
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime/reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const preflightPath = path.join(reviewsRoot, 'T-OWNER-preflight.json');
        fs.writeFileSync(preflightPath, '{}\n');
        const preflightSha256 = sha256RedactedJsonPayload({});
        const policy = buildDefaultReviewRemediationModePolicy();
        const profilePolicySnapshot = { review_remediation_mode_policy: policy,
            review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy() };
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-OWNER', reviewType: 'code',
            changedFile: 'src/auth/session.ts', preflightPath, preflightSha256, profilePolicySnapshot, modePolicy: policy });
        const inputs = { consecutiveDeltaReviews: 0, protectedBoundarySignals: ['auth_or_permission'] as const,
            scopeReviewTypes: ['code', 'security', 'test'], taskCriteriaChanged: false, policyChanged: false, uncertainCrossFileImpact: false };
        delta.mode_policy_assessment = evaluateReviewRemediationMode({ policy, reviewType: 'code', category: delta.category,
            changedFilesCount: delta.changed_files.length, changedLinesTotal: delta.changed_lines_total, ...inputs });
        delta.full_review_reasons = delta.mode_policy_assessment.full_review_reasons;
        const { classification_sha256: _, ...body } = delta;
        delta.classification_sha256 = sha256RedactedJsonPayload(body);
        const classification = { source: 'delta' as const, delta, profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot) };
        const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
            taskId: delta.task_id, currentReviewType: 'code', classification, modePolicyValidationInputs: inputs,
            requiredReviews: { code: true, security: true, test: true }, reviewExecutionPolicyMode: 'strict_sequential'
        }), preflightSha256);
        const lanes = ['code', 'security', 'performance', 'test'];
        const declared = resolveAuthoritativeReviewRemediationDecision({ taskId: delta.task_id, currentReviewType: 'code',
            classification, modePolicyValidationInputs: inputs, requiredReviews: Object.fromEntries(lanes.map((id) => [id, true])),
            reviewExecutionPolicyMode: 'strict_sequential', reviewDependencyGraph: compileReviewDependencyGraph({
                catalogLaneIds: lanes, activeLaneIds: lanes, requiredReviewIds: lanes, mode: 'strict_sequential',
                declaration: { preparation_order: lanes, dependencies: { performance: ['security'] } }
            }) });
        assert.equal(declared.status, 'READY', declared.blocked_reasons.join(' '));
        assert.ok(declared.invalidated_review_types.includes('performance'), 'scope-reopened security invalidates its declared dependent');
        const reference = writeReviewClassificationSnapshot({ reviewsRoot, taskId: delta.task_id, classification });
        appendTaskEvent(bundleRoot, delta.task_id, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Owner admitted.', {
            task_id: delta.task_id, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', preflight_sha256: preflightSha256,
            authoritative_review_decision: decision, authoritative_review_classification_reference: reference });
        assert.deepEqual(collectRestartRequiredReviewTypes(bundleRoot, delta.task_id), ['security']);
        appendTaskEvent(bundleRoot, delta.task_id, 'PREFLIGHT_CLASSIFIED', 'PASS', 'Later plain classification.', {});
        assert.deepEqual(collectRestartRequiredReviewTypes(bundleRoot, delta.task_id), ['security']);
        const bytes = fs.readFileSync(reference.artifact_path);
        fs.writeFileSync(reference.artifact_path, 'unreadable');
        assert.deepEqual(collectRestartRequiredReviewTypes(bundleRoot, delta.task_id), []);
        fs.writeFileSync(reference.artifact_path, bytes);
        appendTaskEvent(bundleRoot, delta.task_id, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Unreadable restart source.', {
            authoritative_review_classification: { source: 'unsupported' }
        });
        assert.deepEqual(collectRestartRequiredReviewTypes(bundleRoot, delta.task_id), ['security']);
        appendTaskEvent(bundleRoot, delta.task_id, 'TASK_MODE_ENTERED', 'PASS', 'New task entry.', {});
        assert.deepEqual(collectRestartRequiredReviewTypes(bundleRoot, delta.task_id), []);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

for (const name of ['another-project', 'garda-agent-orchestrator']) test(
    'policy-source classification and recorded contract agree for ' + name, () => {
    const repoRoot = createTempRepo();
    try {
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name }));
        const taskId = 'T-POLICY-SOURCE';
        const changedFile = 'src/policy/review-service.ts';
        const policy = buildDefaultReviewRemediationModePolicy();
        const profilePolicySnapshot = { review_remediation_mode_policy: policy,
            review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy() };
        const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/' + taskId + '-preflight.json');
        fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
        fs.writeFileSync(preflightPath, '{}\n');
        const preflightSha256 = sha256RedactedJsonPayload({});
        const baselineDelta = buildLeafTestDeltaClassification({ repoRoot, taskId, reviewType: 'code', changedFile,
            preflightPath, preflightSha256, profilePolicySnapshot });
        const modeGuards = (files: readonly string[], fileDeltas: readonly ReviewRemediationFileDelta[]) =>
            resolveRuntimeReviewRemediationModeGuards({ repoRoot, remediationDeltaFiles: files,
                remediationFileDeltas: fileDeltas, remediationDeltaTriggers: { triggers: { runtime_code_changed: true } } });
        const delta = classifyReviewRemediationDelta({ repoRoot, taskId, reviewType: 'code', modePolicy: policy,
            baselineArtifactPath: baselineDelta.baseline.artifact_path,
            baselineArtifactSha256: baselineDelta.baseline.artifact_sha256, currentChangedFiles: [changedFile],
            resolveModeGuards: (files, _lines, fileDeltas) => modeGuards(files, fileDeltas) });
        const inputs = { ...modeGuards(delta.changed_files, delta.file_deltas), consecutiveDeltaReviews: 0 };
        const classification = { source: 'delta' as const, delta, profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot) };
        const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
            taskId, currentReviewType: 'code', classification, modePolicyValidationInputs: inputs,
            requiredReviews: { code: true, test: true, security: true }, reviewExecutionPolicyMode: 'parallel_all'
        }), preflightSha256);
        const isGarda = name === 'garda-agent-orchestrator';
        assert.equal(inputs.policyChanged, isGarda);
        assert.equal(decision.status, 'READY', decision.blocked_reasons.join(' '));
        assert.equal(decision.lane_decisions.find((lane) => lane.review_type === 'security')?.invalidated, isGarda);
        assert.equal(delta.mode_policy_assessment?.mode, isGarda ? 'FULL' : 'DELTA');
        assert.equal(decision.lane_decisions.find((lane) => lane.review_type === 'code')?.mode, isGarda ? 'FULL' : 'DELTA');
        // The reached test lane has no earlier review, so its contract uses FULL without requiring DELTA history.
        const contract = buildReviewRemediationReviewContract({ taskId, reviewType: 'test', preflightSha256,
            fullReviewScope: delta.scope.full_review_scope, authoritativeDecision: decision, classification });
        assert.equal(contract.mode, 'FULL');
        assert.deepEqual(getRemediationContractClassificationBindingViolations(contract, decision, classification), []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
    }
});
