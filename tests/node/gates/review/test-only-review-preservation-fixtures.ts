import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mock, type TestContext } from 'node:test';
import type { FileRoleBindings } from '../../../../src/core/file-role-bindings';

import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { buildDefaultReviewRemediationRerunPolicy } from '../../../../src/policy/review-remediation-rerun-policy';
import { computeTaskProfilePolicySnapshotHash } from '../../../../src/policy/task-profile-policy-snapshot';
import { buildDefaultReviewRemediationModePolicy, resolveReviewRemediationModePolicyFromSnapshot } from '../../../../src/policy/review-remediation-mode-policy';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { buildReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import { buildReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import { resolveLockedReviewFindingPolicyFromPreflight } from '../../../../src/gates/review/review-finding-disposition';
import type { ReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';
import { buildReviewRemediationBaselineArtifact } from '../../../../src/gates/review-remediation/review-remediation-baseline';
import { buildReviewRemediationDeltaBase } from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import * as deltaContract from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import { classifyReviewRemediationDelta } from '../../../../src/gates/review-remediation/review-remediation-delta';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { writeReviewClassificationSnapshot } from '../../../../src/gates/review-remediation/review-remediation-classification-evidence';
import { readTestOnlyReviewPreservation } from '../../../../src/gates/review-remediation/test-only-review-preservation';
import {
    createTempRepo, getReviewsRoot, getOrchestratorRoot, runEnterTaskMode, seedInitAnswers,
    seedTaskQueue, writeBalancedProfilesConfig, writePreflight
} from '../../cli/commands/gate-test-helpers';

export const TASK_ID = 'T-455-1-authority';
export const SOURCE = 'src/app.ts';
export const TEST = 'tests/app.test.ts';
export const HELPER = 'tests/helpers/shared.ts';
const LEGACY_SOURCE = 'Authorization: Bearer\nsynthetic-fixture-value\n';
export const REQUIRED_REVIEWS = { code: true, security: true, api: true, test: true };
export function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}
export function writeJson(file: string, value: unknown): string {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return hash(bytes);
}
export function appendFixtureEvent(root: string, eventType: string, details: unknown): void {
    const result = appendTaskEvent(getOrchestratorRoot(root), TASK_ID, eventType, 'PASS', 'Native producer fixture.', details,
        { passThru: true, emitOnce: false });
    assert.ok(result?.canonical_committed, `Fixture event was not persisted: ${eventType}`);
}

// The pre-upgrade capture padded this multiline Authorization replacement with a second LF.
function captureLegacyFixtureSnapshot({ repoRoot, taskId, reviewType, reviewTreeStateSha256, changedFiles }:
    Parameters<typeof buildReviewRemediationDeltaBase>[0]): ReturnType<typeof buildReviewRemediationDeltaBase> {
    const files = [...changedFiles].sort();
    const entries = files.map(file => {
        const absolutePath = path.join(repoRoot, file);
        const content = fs.readFileSync(absolutePath, 'utf8');
        const lines = content.match(/[^\n]*\n/gu) ?? [];
        assert.equal(lines.join(''), content);
        const redactedLines = file === SOURCE ? ['Authorization: Bearer <redacted>\n', '\n'] : lines;
        if (file === SOURCE) assert.equal(content, LEGACY_SOURCE);
        return { path: file, status: 'text' as const, mode: fs.statSync(absolutePath).mode,
            content_sha256: hash(content), link_sha256: null, line_hashes: lines.map(hash), redacted_lines: redactedLines,
            redacted_lines_sha256: hash(redactedLines.join('')), redaction_applied: file === SOURCE,
            line_count: lines.length, line_analysis: 'available' as const };
    });
    const payload = { schema_version: 2 as const, task_id: taskId, review_type: reviewType,
        review_tree_state_sha256: reviewTreeStateSha256, changed_files: files, changed_files_sha256: hash(files.join('\n')),
        entries, entries_sha256: sha256RedactedJsonPayload(entries) };
    return { ...payload, snapshot_sha256: sha256RedactedJsonPayload(payload) };
}

export function createPreservationFixture(t: TestContext, options: {
    helper?: boolean; preserveHelper?: boolean; sourceRole?: boolean; addedCase?: boolean; changedLinesThreshold?: number; refactorRequired?: boolean;
    legacyLineEvidence?: boolean;
} = {}) {
    const root = createTempRepo(t);
    seedInitAnswers(root);
    writeBalancedProfilesConfig(root);
    seedTaskQueue(root, TASK_ID, 'TODO', 'balanced');
    const reviewsRoot = getReviewsRoot(root);
    for (const [file, text] of [[SOURCE, options.legacyLineEvidence ? LEGACY_SOURCE : 'export const value = 1;\n'],
        [TEST, 'assert.equal(value, 1);\n'], [HELPER, 'export const fixture = 1;\n']]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    }
    const entered = runEnterTaskMode({ repoRoot: root, taskId: TASK_ID,
        taskSummary: 'Authenticate private test remediation', requestedDepth: '2', provider: 'Codex' });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    const mode = JSON.parse(fs.readFileSync(path.join(reviewsRoot, `${TASK_ID}-task-mode.json`), 'utf8'));
    const snapshot = mode.profile_policy_snapshot;
    // Retain the authority tests' explicit pre-existing policy, including its
    // conservative shared-helper rule. Future defaults are tested by native entry.
    delete snapshot.review_remediation_rerun_policy.private_test_review_preservation;
    {
        if (options.preserveHelper) {
            const policy = buildDefaultReviewRemediationRerunPolicy();
            delete policy.private_test_review_preservation;
            policy.rules.shared_test_helper_or_harness = { strategy: 'current_review_only' };
            snapshot.review_remediation_rerun_policy = policy;
        }
        if (options.changedLinesThreshold !== undefined) {
            snapshot.review_trigger_policy.test_refactor_changed_lines_threshold = options.changedLinesThreshold;
        }
        if (options.legacyLineEvidence) {
            snapshot.review_remediation_mode_policy = buildDefaultReviewRemediationModePolicy();
            snapshot.review_remediation_mode_policy_diagnostics = ['legacy snapshot fixture mode policy'];
        }
        snapshot.snapshot_hash = computeTaskProfilePolicySnapshotHash(snapshot);
        const modePath = path.join(reviewsRoot, `${TASK_ID}-task-mode.json`);
        writeJson(modePath, mode);
        // Unit producer fixture for a pre-existing authored frozen policy, not a live setting change.
        appendFixtureEvent(root, 'TASK_MODE_ENTERED', { artifact_path: modePath.replace(/\\/gu, '/'),
            profile_policy_snapshot_required: true, profile_policy_snapshot_hash: snapshot.snapshot_hash });
    }
    const scope = [SOURCE, TEST, HELPER];
    const fileRoles: FileRoleBindings = options.sourceRole ? { [HELPER]: 'source' } : {};
    const requiredReviews = options.refactorRequired ? { ...REQUIRED_REVIEWS, refactor: true } : REQUIRED_REVIEWS;
    const preflightPath = writePreflight(root, TASK_ID, { changed_files: scope,
        required_reviews: requiredReviews, profile_policy_snapshot: snapshot });
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    const preflightSha256 = hash(fs.readFileSync(preflightPath, 'utf8'));
    const tree = hash('immutable failed test-review tree');
    const coverage = buildReviewCoverageContract({ reviewType: 'test', changedFiles: scope,
        validationObligations: [{ id: 'original-case', recipe_id: 'unit-fixture', target_id: 'original-case',
            selector: 'original assertion', source_identity: { path: TEST, sha256: hash('original test'), size: 24, identity: 'fixture-test' },
            snapshot_sha256: preflightSha256, execution: 'PENDING', attempt_id: null,
            result_status: null, result_sha256: null }] });
    const reviewArtifactPath = path.join(reviewsRoot, `${TASK_ID}-test.md`);
    const receiptPath = path.join(reviewsRoot, `${TASK_ID}-test-receipt.json`);
    const validationPath = path.join(reviewsRoot, `${TASK_ID}-test-findings-validation.json`);
    const dispositionPath = path.join(reviewsRoot, `${TASK_ID}-test-findings-disposition.json`);
    const contextHash = hash('immutable failed-test-review context');
    const report: ReviewFindingsReport = { schema_version: 2, task_id: TASK_ID, review_type: 'test',
        review_context_sha256: contextHash, tree_state_sha256: tree,
        validation_notes: [], coverage_ledger: { coverage_contract_sha256: coverage.contract_sha256, entries: [] },
        findings: { critical: [], high: [{ id: 'F-001', title: 'Missing fixture assertion',
            description: 'The existing test lacks an assertion for the private helper.',
            evidence: [{ location: `${TEST}:1`, observation: 'Only the old value is asserted.' }],
            coverage_obligation_ids: [] }], medium: [], low: [] }, residual_risks: [], reviewer_notes: [] };
    const reviewHash = writeJson(reviewArtifactPath, report);
    const validationArtifact = buildReviewFindingsValidationArtifact({ taskId: TASK_ID, reviewType: 'test',
        validation: { detected: true, valid: true, report, violations: [], coverage_validation: null },
        reviewOutputSha256: reviewHash, reviewArtifactPath, reviewArtifactSha256: reviewHash,
        reviewContextPath: path.join(reviewsRoot, `${TASK_ID}-test-context.json`), reviewContextSha256: contextHash,
        preflightPath, preflightSha256, scopeSha256: hash(scope.join('\n')), reviewScopeSha256: hash(scope.join('\n')),
        reviewTreeStateSha256: tree, coverageContract: coverage });
    const validationHash = writeJson(validationPath, validationArtifact);
    const disposition = buildReviewFindingsDispositionArtifact({ taskId: TASK_ID, reviewType: 'test',
        validationArtifact, validationArtifactPath: validationPath, validationArtifactSha256: validationHash,
        policyResolution: resolveLockedReviewFindingPolicyFromPreflight(preflight) });
    const dispositionHash = writeJson(dispositionPath, disposition);
    const receipt = { task_id: TASK_ID, review_type: 'test', review_artifact_sha256: reviewHash,
        review_context_sha256: contextHash, review_tree_state_sha256: tree,
        review_findings_report_sha256: sha256RedactedJsonPayload(report as unknown as Record<string, unknown>) };
    const receiptHash = writeJson(receiptPath, receipt);
    const captureDeltaBase = options.legacyLineEvidence ? captureLegacyFixtureSnapshot : buildReviewRemediationDeltaBase;
    const baseline = buildReviewRemediationBaselineArtifact({ taskId: TASK_ID, reviewType: 'test',
        reviewArtifactPath, reviewArtifactSha256: reviewHash, receiptPath, receiptSha256: receiptHash, receipt,
        validationArtifactPath: validationPath, validationArtifactSha256: validationHash, validationArtifact,
        dispositionArtifactPath: dispositionPath, dispositionArtifactSha256: dispositionHash, dispositionArtifact: disposition,
        profilePolicySnapshot: snapshot, originCoverageContract: coverage,
        deltaBase: captureDeltaBase({ repoRoot: root, taskId: TASK_ID, reviewType: 'test',
            reviewTreeStateSha256: tree, changedFiles: scope }) });
    for (const binding of [baseline.bindings.receipt, baseline.bindings.review_artifact,
        baseline.bindings.findings_validation, baseline.bindings.findings_disposition]) {
        fs.copyFileSync(binding.artifact_path, binding.snapshot_path);
    }
    const baselinePath = path.join(reviewsRoot, `${TASK_ID}-test-remediation-baseline.json`);
    const baselineHash = writeJson(baselinePath, baseline);
    const changedPath = path.join(root, options.helper ? HELPER : TEST);
    fs.appendFileSync(changedPath, options.helper ? 'export const corrected = true;\n' : 'assert.equal(value + 1, 2);\n');
    if (options.addedCase) fs.appendFileSync(path.join(root, TEST), 'assert.equal(value - 1, 0);\n');
    const modePolicy = resolveReviewRemediationModePolicyFromSnapshot(snapshot);
    const classify = () => classifyReviewRemediationDelta({ repoRoot: root, taskId: TASK_ID, reviewType: 'test',
        baselineArtifactPath: baselinePath, baselineArtifactSha256: baselineHash, currentChangedFiles: scope,
        fileRoles, structuralTestChangedLinesThreshold: snapshot.review_trigger_policy.test_refactor_changed_lines_threshold,
        modePolicy: modePolicy.policy, modePolicyLegacyFallback: modePolicy.legacy_fallback });
    // Record with the pre-upgrade capture and version gate, then restore both before preservation runs.
    const preUpgradeCapture = options.legacyLineEvidence
        ? mock.method(deltaContract, 'buildReviewRemediationDeltaBase', captureLegacyFixtureSnapshot) : undefined;
    const preUpgradeGate = options.legacyLineEvidence
        ? mock.method(deltaContract, 'hasAlignedLineEvidence', () => true) : undefined;
    let delta: ReturnType<typeof classify>;
    try {
        delta = classify();
    } finally {
        preUpgradeGate?.mock.restore();
        preUpgradeCapture?.mock.restore();
    }
    const classification = { source: 'delta' as const, delta, profilePolicySnapshot: snapshot,
        baselineProfilePolicySnapshotSha256: snapshot.snapshot_hash };
    const decision = resolveAuthoritativeReviewRemediationDecision({ taskId: TASK_ID, currentReviewType: 'test',
        classification, requiredReviews, reviewExecutionPolicyMode: 'strict_sequential',
        modePolicyValidationInputs: { consecutiveDeltaReviews: 0, protectedBoundarySignals: [],
            taskCriteriaChanged: false, policyChanged: false, uncertainCrossFileImpact: false } });
    assert.equal(decision.status, 'READY', decision.blocked_reasons.join('\n'));
    const boundDecision = { ...decision, preflight_sha256: preflightSha256 };
    // Native decision hashes include the preflight binding only when it is part of the persisted record.
    boundDecision.decision_sha256 = sha256RedactedJsonPayload(Object.fromEntries(
        Object.entries(boundDecision).filter(([key]) => key !== 'decision_sha256')));
    appendFixtureEvent(root, 'PREFLIGHT_CLASSIFIED', {
        output_path: preflightPath.replace(/\\/gu, '/'),
        intermediate_execution_preflight: { schema_version: 1, preflight_sha256: preflightSha256 } });
    const classificationReference = writeReviewClassificationSnapshot({ reviewsRoot, taskId: TASK_ID, classification });
    const restartDetails = { task_id: TASK_ID, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED',
        preflight_sha256: preflightSha256, authoritative_review_decision: boundDecision,
        authoritative_review_classification_reference: classificationReference };
    appendFixtureEvent(root, 'REVIEW_CYCLE_RESTARTED', restartDetails);
    const args = { repoRoot: root, reviewsRoot, taskId: TASK_ID, reviewType: 'code', preflightPath };
    return { root, reviewsRoot, preflightPath, baselinePath, baseline, classificationReference, restartDetails, args,
        read: () => withInvocationReadObservation(() => readTestOnlyReviewPreservation(args)) };
}
