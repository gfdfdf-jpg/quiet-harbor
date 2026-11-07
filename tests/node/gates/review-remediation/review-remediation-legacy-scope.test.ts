import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { fileSha256 } from '../../../../src/gates/shared/helpers';
import { runBuildReviewContextCommand } from '../../../../src/cli/commands/gate-build-handlers';
import { bindAuthoritativeRemediationDecisionToPreflight, resolvePersistedRemediationReusePolicy }
    from '../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { resolveAuthoritativeReviewRemediationDecision }
    from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { getRemediationContractClassificationBindingViolations }
    from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { findReviewContextRecoveryCandidates } from '../../../../src/gates/review/review-artifact-recovery';
import { resolvePersistedRemediationReviewExecutionAuthority }
    from '../../../../src/gates/review-remediation/review-remediation-execution-authority';
import { buildDefaultReviewRemediationModePolicy, evaluateReviewRemediationMode, getReviewRemediationModeAssessmentViolations }
    from '../../../../src/policy/review-remediation-mode-policy';
import { bindFixtureEffectiveReviewSnapshot, createTempRepo, getReviewsRoot, initializeGitRepo, loadPostPreflightRulePack, prepareCurrentReviewPhase,
    seedInitAnswers, seedTaskQueue, writeCompilePassEvidence, writePreflight }
    from '../../cli/commands/gate-test-helpers';
import { buildLeafTestDeltaClassification } from '../next-step/next-step-benchmark-remediation-fixture';
import { getWorkspaceSnapshot, resolveNextStep } from '../next-step/next-step-test-support';

test('new classifications require both lane fields, including when reading persisted assessments', () => {
    const policy = buildDefaultReviewRemediationModePolicy();
    const assessment = evaluateReviewRemediationMode({ policy, reviewType: 'code', category: 'ambiguous',
        changedFilesCount: 1, changedLinesTotal: 1, consecutiveDeltaReviews: 0, scopeReviewTypes: null });
    assert.equal(assessment.mode, 'FULL');
    assert.equal(assessment.scope_review_types, null);
    assert.deepEqual(getReviewRemediationModeAssessmentViolations({ assessment, policy, legacyFallback: false }), []);
    for (const field of ['scope_review_types', 'full_review_types'] as const) {
        const incomplete = { ...assessment };
        delete incomplete[field];
        const { assessment_sha256: _, ...body } = incomplete;
        incomplete.assessment_sha256 = sha256RedactedJsonPayload(body);
        for (const allowLegacyScope of [false, true]) {
            assert.match(getReviewRemediationModeAssessmentViolations({ assessment: incomplete, policy,
                legacyFallback: false, allowLegacyScope }).join(' '), /lane assessment is missing/u, field);
        }
    }
});

for (const legacyMode of ['FULL', 'DELTA'] as const) test(
    'legacy ' + legacyMode + ' restart without either lane field builds fresh FULL contexts and advances', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-LEGACY-SCOPE';
    try {
        const workflowPath = path.join(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
        const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
        workflow.optional_quality_checks.enabled = false;
        workflow.review_execution_policy.mode = 'parallel_all';
        fs.writeFileSync(workflowPath, JSON.stringify(workflow));
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'], required_reviews: { code: true, test: true, security: true },
            review_execution_policy: { mode: 'parallel_all' }
        });
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Qwen');
        for (const reviewType of ['security', 'test']) {
            bindFixtureEffectiveReviewSnapshot(repoRoot, taskId, reviewType, preflightPath, '');
        }
        initializeGitRepo(repoRoot);
        const policy = buildDefaultReviewRemediationModePolicy();
        const profilePolicySnapshot = { review_remediation_mode_policy: policy };
        const delta = buildLeafTestDeltaClassification({ repoRoot, taskId, reviewType: 'code', changedFile: 'src/app.ts',
            preflightPath, preflightSha256: fileSha256(preflightPath)!, profilePolicySnapshot, modePolicy: policy });
        const workspace = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        preflight.metrics = { changed_lines_total: workspace.changed_lines_total,
            changed_files_sha256: workspace.changed_files_sha256, scope_content_sha256: workspace.scope_content_sha256,
            scope_sha256: workspace.scope_sha256 };
        fs.writeFileSync(preflightPath, JSON.stringify(preflight));
        const preflightSha256 = fileSha256(preflightPath)!;
        const classification = { source: 'delta' as const, delta, profilePolicySnapshot,
            baselineProfilePolicySnapshotSha256: sha256RedactedJsonPayload(profilePolicySnapshot) };
        const inputs = { consecutiveDeltaReviews: 0, protectedBoundarySignals: [], scopeReviewTypes: [],
            taskCriteriaChanged: false, policyChanged: false, uncertainCrossFileImpact: false };
        if (legacyMode === 'FULL') {
            delta.mode_policy_assessment = evaluateReviewRemediationMode({ policy, reviewType: 'code',
                category: delta.category, changedFilesCount: delta.changed_files.length,
                changedLinesTotal: delta.changed_lines_total, consecutiveDeltaReviews: 0,
                protectedBoundarySignals: ['security'], scopeReviewTypes: ['security'] });
            // v1.4.3 treats every protected signal as a reason to make the entire assessment FULL.
            delta.mode_policy_assessment.mode = 'FULL';
            delta.mode_policy_assessment.delta_eligible_review_types = [];
            delta.mode_policy_assessment.full_review_reasons = ["protected boundary signal 'security' requires FULL mode"];
            delta.full_review_required = true;
            delta.full_review_reasons = delta.mode_policy_assessment.full_review_reasons;
            const { assessment_sha256: _, ...assessmentBody } = delta.mode_policy_assessment;
            delta.mode_policy_assessment.assessment_sha256 = sha256RedactedJsonPayload(assessmentBody);
            const { classification_sha256: __, ...deltaBody } = delta;
            delta.classification_sha256 = sha256RedactedJsonPayload(deltaBody);
        }
        // Create a valid decision, then encode the assessment and hashes as the previous version did.
        const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
            taskId, currentReviewType: 'code', classification, requiredReviews: { code: true, test: true, security: true },
            modePolicyValidationInputs: legacyMode === 'FULL'
                ? { ...inputs, protectedBoundarySignals: ['security'], scopeReviewTypes: ['security'] } : inputs,
            reviewExecutionPolicyMode: 'parallel_all'
        }), preflightSha256);
        assert.equal(decision.status, 'READY', decision.blocked_reasons.join(' '));
        assert.equal(decision.lane_decisions.find((lane) => lane.review_type === 'code')?.mode, legacyMode);
        for (const field of ['scope_review_types', 'full_review_types'] as const) {
            const incomplete = structuredClone(classification);
            delete incomplete.delta.mode_policy_assessment![field];
            const { assessment_sha256: _, ...assessmentBody } = incomplete.delta.mode_policy_assessment!;
            incomplete.delta.mode_policy_assessment!.assessment_sha256 = sha256RedactedJsonPayload(assessmentBody);
            const { classification_sha256: __, ...deltaBody } = incomplete.delta;
            incomplete.delta.classification_sha256 = sha256RedactedJsonPayload(deltaBody);
            const refused = resolveAuthoritativeReviewRemediationDecision({ taskId, currentReviewType: 'code',
                classification: incomplete, requiredReviews: { code: true, test: true, security: true },
                modePolicyValidationInputs: inputs, reviewExecutionPolicyMode: 'parallel_all' });
            assert.equal(refused.status, 'BLOCKED', field);
            assert.match(refused.blocked_reasons.join(' '), /lane assessment is missing/u, field);
        }
        delete delta.mode_policy_assessment!.scope_review_types;
        delete delta.mode_policy_assessment!.full_review_types;
        const { assessment_sha256: _, ...assessmentBody } = delta.mode_policy_assessment!;
        delta.mode_policy_assessment!.assessment_sha256 = sha256RedactedJsonPayload(assessmentBody);
        const { classification_sha256: __, ...deltaBody } = delta;
        delta.classification_sha256 = sha256RedactedJsonPayload(deltaBody);
        decision.classification_sha256 = delta.classification_sha256;
        const { decision_sha256: ___, ...decisionBody } = decision;
        decision.decision_sha256 = sha256RedactedJsonPayload(decisionBody);
        assert.match(getReviewRemediationModeAssessmentViolations({ assessment: delta.mode_policy_assessment,
            policy, legacyFallback: false }).join(' '), /scope lane assessment is missing/u);
        assert.deepEqual(getReviewRemediationModeAssessmentViolations({ assessment: delta.mode_policy_assessment,
            policy, legacyFallback: false, allowLegacyScope: true, reviewType: 'code', category: delta.category,
            changedFilesCount: delta.changed_files.length, changedLinesTotal: delta.changed_lines_total }), []);
        assert.equal(resolveAuthoritativeReviewRemediationDecision({ taskId, currentReviewType: 'code', classification,
            requiredReviews: { code: true, test: true, security: true }, modePolicyValidationInputs: inputs,
            reviewExecutionPolicyMode: 'parallel_all' }).status, 'BLOCKED', 'new incomplete classifications remain refused');
        appendTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO',
            'Current preflight classified.', { output_path: preflightPath.replace(/\\/gu, '/'),
                effective_review_snapshot: preflight.effective_review_snapshot });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Legacy review cycle restarted.', {
            task_id: taskId, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', preflight_sha256: preflightSha256,
            // Older events can list only the originally invalidated lane, while the legacy fallback now repeats all lanes.
            ...(legacyMode === 'DELTA' ? { invalidated_review_types: ['code'] } : {}),
            authoritative_review_decision: decision, authoritative_review_classification: classification
        }, { actor: 'orchestrator' });
        const timelinePath = path.join(bundleRoot, 'runtime/task-events', taskId + '.jsonl');
        const contextStates = ['code', 'security', 'test'].map((reviewType) => ({ reviewType,
            contextPath: path.join(getReviewsRoot(repoRoot), taskId + '-' + reviewType + '-review-context.json') }));
        const recoveryOptions = { repoRoot, eventsRoot: path.dirname(timelinePath), taskId, states: contextStates };
        assert.deepEqual(findReviewContextRecoveryCandidates(recoveryOptions), [],
            'no context pinned before the legacy restart is accepted as a fresh attempt');
        const timelineBefore = fs.readFileSync(timelinePath, 'utf8');
        const events = timelineBefore.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
        const before = resolveNextStep({ repoRoot, taskId });
        assert.equal(before.next_gate, 'build-review-context', before.reason);
        for (const reviewType of ['code', 'security', 'test']) {
            const persisted = resolvePersistedRemediationReusePolicy({ events, taskId, reviewType, preflightPath, timelinePath });
            assert.equal(persisted.failClosed, undefined, persisted.blockedReason);
            assert.equal(persisted.reviewExecutionContract?.mode, 'FULL');
            assert.equal(persisted.persistedRemediationReuseRequired, undefined);
            const result = await runBuildReviewContextCommand({ repoRoot, reviewType, depth: '2', preflightPath });
            assert.equal(result.reusedReviewEvidence, false);
            const context = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), taskId + '-' + reviewType + '-review-context.json'), 'utf8'));
            assert.equal(context.review_execution.mode, 'FULL');
            assert.equal(context.review_execution.source, 'remediation_full');
            const authority = resolvePersistedRemediationReviewExecutionAuthority({ reviewsRoot: getReviewsRoot(repoRoot),
                taskId, reviewType, preflightSha256, fullReviewScope: ['src/app.ts'], reviewExecution: context.review_execution });
            assert.ok(authority, 'fresh FULL context retains its authenticated restart authority');
            assert.equal(resolvePersistedRemediationReviewExecutionAuthority({ reviewsRoot: getReviewsRoot(repoRoot),
                taskId, reviewType, preflightSha256, fullReviewScope: ['src/app.ts'],
                reviewExecution: { ...context.review_execution, mode: 'DELTA' } }), null,
                'a recorded DELTA execution cannot satisfy the legacy restart');
            assert.match(getRemediationContractClassificationBindingViolations({ ...context.review_execution, mode: 'DELTA' },
                decision, classification).join(' '), /unclassified remediation review scopes require FULL/u);
        }
        const freshPins = findReviewContextRecoveryCandidates(recoveryOptions);
        assert.equal(freshPins.length, contextStates.length, 'each FULL context is pinned by its new preparation event');
        for (const state of contextStates) {
            assert.equal(freshPins.find((pin) => pin.state.reviewType === state.reviewType)?.sha256, fileSha256(state.contextPath));
        }
        const after = resolveNextStep({ repoRoot, taskId });
        assert.ok(['record-review-routing', 'prepare-reviewer-launch'].includes(String(after.next_gate)), after.reason);
        assert.ok(fs.readFileSync(timelinePath, 'utf8').startsWith(timelineBefore), 'stored restart events remain unchanged');
        if (legacyMode === 'DELTA') {
            // Code began FULL under R1, but completes after an evidence-only R2 restarts test.
            const preservedClassification = { source: 'runtime_fix' as const, classification: {
                category: 'review_evidence_only', reason: 'Only test reviewer evidence changed.',
                blocked_before_reuse: false, invalidated_review_types: ['test']
            } };
            const preservedDecision = bindAuthoritativeRemediationDecisionToPreflight(
                resolveAuthoritativeReviewRemediationDecision({ taskId, currentReviewType: 'test',
                    classification: preservedClassification, requiredReviews: { code: true, security: true, test: true },
                    reviewExecutionPolicyMode: 'parallel_all' }), preflightSha256);
            assert.equal(preservedDecision.status, 'READY', preservedDecision.blocked_reasons.join(' '));
            appendTaskEvent(bundleRoot, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Evidence-only R2.', {
                task_id: taskId, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', preflight_sha256: preflightSha256,
                authoritative_review_decision: preservedDecision, authoritative_review_classification: preservedClassification
            }, { actor: 'orchestrator' });
            const reviewsRoot = getReviewsRoot(repoRoot);
            const reviewContextPath = path.join(reviewsRoot, taskId + '-code-review-context.json');
            const receiptPath = path.join(reviewsRoot, taskId + '-code-receipt.json');
            const reviewArtifactPath = path.join(reviewsRoot, taskId + '-code.md');
            const context = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
            const authorityOptions = { reviewsRoot, taskId, reviewType: 'code', preflightSha256, preflightPath,
                fullReviewScope: ['src/app.ts'], reviewExecution: context.review_execution,
                reviewContextPath, receiptPath, acceptPreservedPendingReuse: true };
            assert.equal(resolvePersistedRemediationReviewExecutionAuthority(authorityOptions), null,
                'R2 requires a fresh authenticated review result');
            fs.writeFileSync(reviewArtifactPath, 'REVIEW PASSED\n');
            appendTaskEvent(bundleRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'R1 FULL review completes after R2.', {
                task_id: taskId, review_type: 'code', preflight_sha256: preflightSha256,
                review_context_path: reviewContextPath, review_context_sha256: fileSha256(reviewContextPath),
                receipt_path: receiptPath, receipt_sha256: fileSha256(receiptPath),
                review_artifact_path: reviewArtifactPath, review_artifact_sha256: fileSha256(reviewArtifactPath)
            });
            assert.equal(resolvePersistedRemediationReviewExecutionAuthority(authorityOptions)?.authoritativeDecisionSha256,
                decision.decision_sha256, 'the FULL review retains its legacy R1 authority after R2');
            assert.equal(resolvePersistedRemediationReviewExecutionAuthority({ ...authorityOptions,
                reviewExecution: { ...context.review_execution, mode: 'DELTA' } }), null,
            'the recorded legacy DELTA mode still cannot satisfy a FULL review');
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3 });
    }
});
