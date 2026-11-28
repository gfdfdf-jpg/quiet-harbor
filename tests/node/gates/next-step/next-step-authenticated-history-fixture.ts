import '../../../../src/bin/garda/derivation-source-receipts';
import { admitNativeReviewCadence } from '../../../../src/gates/review-attempts/review-cadence-admission';
import { captureClosedReviewGate, prepareClosedReviewCurrentIndex } from '../../../../src/gates/review-attempts/review-closed-cycle-capture';
import { publishClosedReviewHistory } from '../../../../src/gates/review-attempts/review-closed-cycle-storage';
import { readTaskTimelineClosedReviewQuery } from '../../../../src/gate-runtime/timeline/task-events-integrity';
import { getReviewExecutionPreparationOrder } from '../../../../src/core/review-execution-policy';
import { classifyHistoryRemediation } from './next-step-authenticated-remediation-fixture';
import { buildDefaultReviewRemediationModePolicy } from '../../../../src/policy/review-remediation-mode-policy';
import { runProjectMemoryImpactCommand } from '../../../../src/cli/commands/gate-flows/completion/project-memory-flow';
import { runDocImpactGateCommand } from '../../../../src/cli/commands/gate-flows/review/review-flow';
import { handleCompletionGate } from '../../../../src/cli/commands/gate-task-handlers';
import { retainHistoryCorrectionAttempt } from './next-step-authenticated-correction-fixture';
import { appendRestartCompletedEvidence } from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-restart-evidence';
import { DEFAULT_REVIEW_CYCLE_GUARD_CONFIG } from '../../../../src/core/review-cycle-guard';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fixture from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import { buildReviewRemediationBaselineArtifact, validateReviewRemediationBaselineArtifact } from '../../../../src/gates/review-remediation/review-remediation-baseline';
import { buildReviewRemediationDeltaBase } from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import { bindAuthoritativeRemediationDecisionToPreflight, buildAuthenticatedRemediationReviewExecution } from '../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import type { ReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import type { ReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { buildDeclaredReviewCoverageContract } from '../../../../src/gates/review-context/review-context-coverage';
import { retainedNativeCaseOutput } from '../../../../src/gates/review/native-case-semantics';
import { validationDigest } from '../../../../src/core/project-validation-identity';
import { readPreservedReviewCoverage, buildAcceptedReviewClaims } from '../../../../src/gates/review-remediation/test-only-review-preservation';
import { readRestartReviewClassification } from '../../../../src/gates/review-remediation/review-remediation-classification-evidence';
import type { AuthoritativeReviewRemediationDecision, ReviewRemediationDecisionClassification } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';

export interface AuthenticatedHistoryFixture {
    repoRoot: string; taskId: string; preflightPath: string; files: string[]; lanes: string[];
    timelineBytes: number; historicalArtifacts: string[]; artifactCycles: Record<string, number>; correctionProofs: string[]; correctionPackages: Record<string, string>; baselinePath: string; contextPath: string;
    testBaselinePath?: string; testExecution?: ReturnType<typeof buildAuthenticatedRemediationReviewExecution>;
}
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const verdict = (lane: string, passed: boolean) => (lane === 'code' ? 'REVIEW' : lane.toUpperCase() + ' REVIEW') + (passed ? ' PASSED' : ' FAILED');

/** The returned delegated reviewer's own output, at the path its authenticated launch declared. */
function writeReturnedReviewerOutput(state: AuthenticatedHistoryFixture, lane: string): string {
    const report = path.join(fixture.getReviewsRoot(state.repoRoot), `${state.taskId}-${lane}.md`);
    const output = path.join(fixture.getOrchestratorRoot(state.repoRoot), 'runtime/tmp/reviews', state.taskId, lane, 'review-output.md');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(report, output);
    return output;
}

function retainBaseline(state: AuthenticatedHistoryFixture, lane: string): string {
    const root = fixture.getReviewsRoot(state.repoRoot), prefix = path.join(root, `${state.taskId}-${lane}`);
    const receiptPath = prefix + '-receipt.json', artifactPath = prefix + '.md';
    const validationPath = prefix + '-findings-validation.json', dispositionPath = prefix + '-findings-disposition.json';
    const receipt = readJson(receiptPath), context = readJson(prefix + '-review-context.json');
    if (receipt.review_findings_disposition?.summary?.fix_now_count === 0
        || readJson(dispositionPath).summary.fix_now_count === 0) {
        const claims = buildAcceptedReviewClaims({ repoRoot: state.repoRoot, taskId: state.taskId, reviewType: lane,
            receipt, receiptSha256: fixture.fileSha256(receiptPath)!, coverageContract: context.coverage_contract,
            profilePolicySnapshotSha256: readJson(state.preflightPath).profile_policy_snapshot.snapshot_hash,
            preflight: readJson(state.preflightPath) });
        fs.writeFileSync(claims.artifactPath, JSON.stringify(claims.payload, null, 2) + '\n');
        fixture.appendTaskEvent(fixture.getOrchestratorRoot(state.repoRoot), state.taskId, 'REVIEW_RECORDED', 'PASS',
            'Retain native accepted-claim fixture publication bindings.', admitNativeReviewCadence(state.repoRoot, state.taskId, { ...receipt,
                review_artifact_path: artifactPath, review_context_path: prefix + '-review-context.json',
                review_artifact_snapshot_path: prefix + '-artifact-' + receipt.review_artifact_sha256 + '.md',
                review_artifact_snapshot_sha256: receipt.review_artifact_sha256,
                receipt_snapshot_path: prefix + '-receipt-' + fixture.fileSha256(receiptPath) + '.json',
                receipt_snapshot_sha256: fixture.fileSha256(receiptPath),
                accepted_review_claims_path: claims.artifactPath, accepted_review_claims_sha256: claims.artifactSha256 }));
        state.historicalArtifacts.push(claims.artifactPath);
        return claims.artifactPath;
    }
    const baseline = buildReviewRemediationBaselineArtifact({ taskId: state.taskId, reviewType: lane,
        reviewArtifactPath: artifactPath, reviewArtifactSha256: fixture.fileSha256(artifactPath)!,
        receiptPath, receiptSha256: fixture.fileSha256(receiptPath)!, receipt,
        validationArtifactPath: validationPath, validationArtifactSha256: fixture.fileSha256(validationPath)!,
        validationArtifact: readJson(validationPath) as ReviewFindingsValidationArtifact,
        dispositionArtifactPath: dispositionPath, dispositionArtifactSha256: fixture.fileSha256(dispositionPath)!,
        dispositionArtifact: readJson(dispositionPath) as ReviewFindingsDispositionArtifact,
        profilePolicySnapshot: readJson(state.preflightPath).profile_policy_snapshot,
        originCoverageContract: context.coverage_contract as ReviewCoverageContract,
        deltaBase: buildReviewRemediationDeltaBase({ repoRoot: state.repoRoot, taskId: state.taskId,
            reviewType: lane, reviewTreeStateSha256: receipt.review_tree_state_sha256, changedFiles: state.files })
    });
    const mutable = prefix + '-remediation-baseline.json';
    fs.writeFileSync(mutable, JSON.stringify(baseline, null, 2) + '\n');
    const retained = prefix + '-remediation-baseline-' + fixture.fileSha256(mutable) + '.json';
    fs.copyFileSync(mutable, retained);
    fs.copyFileSync(prefix + '-review-context.json', prefix + '-review-context-' + fixture.fileSha256(prefix + '-review-context.json') + '.json');
    assert.equal(validateReviewRemediationBaselineArtifact({ artifactPath: retained, expectedTaskId: state.taskId,
        expectedReviewType: lane, expectedArtifactSha256: fixture.fileSha256(retained) }).valid, true);
    const recorded = [...fixture.readTaskTimelineEvents(state.repoRoot, state.taskId)].reverse().find(event =>
        event.event_type === 'REVIEW_RECORDED' && (event.details as Record<string, unknown> | undefined)?.review_type === lane);
    const recordedDetails = recorded?.details as Record<string, unknown> | undefined;
    assert.equal(recordedDetails?.receipt_sha256, fixture.fileSha256(receiptPath));
    fixture.appendTaskEvent(fixture.getOrchestratorRoot(state.repoRoot), state.taskId, 'REVIEW_RECORDED', 'PASS',
        'Bind the retained failed-review baseline to its original receipt.', admitNativeReviewCadence(state.repoRoot, state.taskId, {
            ...recordedDetails, review_artifact_path: artifactPath, review_context_path: prefix + '-review-context.json',
            receipt_snapshot_path: baseline.bindings.receipt.snapshot_path,
            receipt_snapshot_sha256: baseline.bindings.receipt.snapshot_sha256,
            review_artifact_snapshot_path: baseline.bindings.review_artifact.snapshot_path,
            review_artifact_snapshot_sha256: baseline.bindings.review_artifact.snapshot_sha256,
            remediation_baseline_path: mutable,
            remediation_baseline_snapshot_path: retained, remediation_baseline_snapshot_sha256: fixture.fileSha256(retained)
        }));
    state.historicalArtifacts.push(baseline.bindings.receipt.snapshot_path, baseline.bindings.review_artifact.snapshot_path,
        baseline.bindings.findings_validation.snapshot_path, baseline.bindings.findings_disposition.snapshot_path, retained);
    return retained;
}

function appendRestart(state: AuthenticatedHistoryFixture, cycle: number, expectDelta: boolean): void {
    const classified = state.lanes.length === 3 ? classifyHistoryRemediation(state, state.testBaselinePath!, expectDelta) : null;
    const classification = classified?.classification || { source: 'runtime_fix' as const, classification: { category: 'production',
        reason: `Retained full-review remediation cycle ${cycle}.`, blocked_before_reuse: false,
        invalidated_review_types: state.lanes } };
    const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
        taskId: state.taskId, currentReviewType: classified ? 'test' : state.lanes[0], classification,
        modePolicyValidationInputs: classified?.inputs,
        requiredReviews: Object.fromEntries(state.lanes.map(lane => [lane, true])), reviewExecutionPolicyMode: 'strict_sequential'
    }), fixture.fileSha256(state.preflightPath)!);
    assert.equal(decision.status, 'READY', JSON.stringify(decision));
    if (expectDelta && classified) {
        state.testExecution = buildAuthenticatedRemediationReviewExecution({ taskId: state.taskId, reviewType: 'test',
            preflightSha256: fixture.fileSha256(state.preflightPath)!, fullReviewScope: state.files,
            authoritativeDecision: decision, authoritativeClassification: classification });
        assert.equal(state.testExecution.contract.mode, 'DELTA');
        assert.equal(path.resolve(state.testExecution.contract.base!.baseline_artifact_path), path.resolve(state.testBaselinePath!));
        assert.deepEqual(state.testExecution.contract.delta!.required_delta_targets, [state.files[1]]);
    }
    const root = fixture.getReviewsRoot(state.repoRoot);
    appendRestartCompletedEvidence({ repoRoot: state.repoRoot, taskId: state.taskId, eventType: 'REVIEW_CYCLE_RESTARTED',
        artifactSuffix: '-review-cycle-restart.json', message: 'Historical review cycle closed by authenticated restart.',
        taskModePath: path.join(root, state.taskId + '-task-mode.json'), preflightPath: state.preflightPath,
        compileEvidencePath: path.join(root, state.taskId + '-compile-gate.json'), detectionSource: 'explicit',
        plannedChangedFilesCount: state.files.length, detectedChangedFilesCount: state.files.length, elapsedMs: 1,
        restartReason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
        nextStepSummary: 'Continue with current review evidence.', extraDetails: {
            invalidated_review_types: decision.invalidated_review_types,
            authoritative_review_decision: decision, authoritative_review_classification: classification } });
}

/** Native validation plus real content-addressed receipts consumed by audit history. */
export async function createAuthenticatedNextStepHistoryFixture(cycles = 16, laneCount = 3, onActive?: (state: AuthenticatedHistoryFixture) => void, onCycle?: (completed: number) => void): Promise<AuthenticatedHistoryFixture> {
    assert.ok(Number.isInteger(cycles) && cycles > 0);
    assert.ok([1, 3, 5].includes(laneCount));
    const repoRoot = fixture.createTempRepo(), taskId = 'T-BENCH-NATIVE';
    const selectedLanes = ['code', 'refactor', 'test', 'performance', 'security'].slice(0, laneCount);
    const lanes = getReviewExecutionPreparationOrder('strict_sequential').filter(lane => selectedLanes.includes(lane));
    const files = ['src/evidence.ts', fixture.TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH,
        ...Array.from({ length: 62 }, (_, index) => `tests/benchmark-${index}.test.ts`)];
    fixture.seedRemediationRepoBase(repoRoot);
    fixture.writeCurrentReviewCycleValidationSource(repoRoot);
    fixture.writeReviewCapabilitiesConfig(repoRoot);
    const profilesPath = fixture.writeProfilesConfig(repoRoot), profiles = readJson(profilesPath);
    profiles.built_in_profiles.balanced.review_policy = Object.fromEntries(
        ['code', 'security', 'test', 'refactor', 'performance', 'api', 'db', 'infra', 'dependency']
            .map(lane => [lane, lanes.includes(lane)]));
    profiles.built_in_profiles.balanced.review_remediation_mode_policy = buildDefaultReviewRemediationModePolicy();
    fs.writeFileSync(profilesPath, JSON.stringify(profiles));
    const pathsPath = path.join(fixture.getOrchestratorRoot(repoRoot), 'live/config/paths.json');
    const paths = readJson(pathsPath); paths.triggers.security = ['(^|/)security/'];
    fs.writeFileSync(pathsPath, JSON.stringify(paths));
    const workflowPath = fixture.writeWorkflowConfig(repoRoot, 'strict_sequential');
    const workflow = readJson(workflowPath);
    // Materialize the unchanged shipped rule baseline before native template and repair production.
    workflow.optional_quality_checks = buildDefaultWorkflowConfig().optional_quality_checks;
    // Fixed finite policy for every history size: the guard still evaluates all
    // evidence; the workload must reach ordinary routes even with 16 x 5 attempts.
    workflow.review_cycle_guard = { ...DEFAULT_REVIEW_CYCLE_GUARD_CONFIG, max_total_non_test_reviews: 128,
        max_failed_non_test_reviews: 128 };
    fs.writeFileSync(workflowPath, JSON.stringify(workflow));
    const compile = fixture.writeSimpleCompileCommandsFile(repoRoot, 'authenticated-history');
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, file), file === 'src/evidence.ts' ? 'export const value = 1;\n' : 'assert.equal(actual, 0);\n');
    }
    fixture.initializeGitRepo(repoRoot);
    for (const file of files) fs.writeFileSync(path.join(repoRoot, file), file === 'src/evidence.ts' ? 'export const value = 2;\n' : 'assert.equal(actual, expected);\n');
    fixture.seedTaskQueue(repoRoot, taskId, 'TODO', 'balanced'); fixture.seedInitAnswers(repoRoot, 'Codex');
    const entered = fixture.runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Measure authenticated review history', plannedChangedFiles: files });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    fixture.loadTaskEntryRulePack(repoRoot, taskId); fixture.runHandshakeForTask(repoRoot, taskId); fixture.runShellSmokeForTask(repoRoot, taskId);
    const preflightPath = fixture.runExplicitPreflight(repoRoot, taskId, 'Measure authenticated review history', files);
    await fixture.prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
    fixture.loadPostPreflightRulePack(repoRoot, taskId, preflightPath); fixture.writeCompilePassEvidence(repoRoot, taskId, preflightPath);
    const root = fixture.getReviewsRoot(repoRoot);
    const state: AuthenticatedHistoryFixture = { repoRoot, taskId, preflightPath, files, lanes, timelineBytes: 0,
        historicalArtifacts: [], artifactCycles: {}, correctionProofs: [], correctionPackages: {}, baselinePath: '', contextPath: path.join(root, `${taskId}-code-review-context.json`) };
    for (let cycle = 0; cycle < cycles; cycle += 1) {
        fixture.writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', verdict('code', true), undefined,
            { authenticatedNavigatorLaunch: true, nativeCadenceAdmission: true, nativeReviewPhaseTelemetry: true, skipReceipt: true,
                caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(repoRoot, taskId) });
        await retainHistoryCorrectionAttempt(state, cycle);
        for (const lane of lanes) {
            const acceptedUpstream = laneCount === 3 && cycle === cycles - 1 && lane !== 'test';
            fixture.writeReceiptBackedReviewArtifact(repoRoot, taskId, lane, verdict(lane, acceptedUpstream), undefined,
                { authenticatedNavigatorLaunch: true, nativeCadenceAdmission: true, nativeReviewPhaseTelemetry: true, findingSeverity: acceptedUpstream ? null : 'high', findingEvidenceFile: lane === 'test' ? files[1] : undefined, caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(repoRoot, taskId) });
            state.baselinePath = retainBaseline(state, lane);
            if (lane === 'test') state.testBaselinePath = state.baselinePath;
        }
        // Direct fixture writes must finish the same index-owner boundary as native writers.
        // Retaining a baseline may rewrite an existing snapshot with identical bytes but a
        // new file identity; a previously built index must not retain its old metadata.
        prepareClosedReviewCurrentIndex(repoRoot);
        const expectDelta = state.lanes.length === 3 && cycle === cycles - 1;
        if (state.lanes.length === 3) {
            for (const file of files.slice(1, expectDelta ? 2 : 7)) {
                if (file === fixture.TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH)
                    fs.appendFileSync(path.join(repoRoot, file), '// authenticated private-case remediation\n');
                else fs.writeFileSync(path.join(repoRoot, file), 'assert.equal(actual, ' + (100 + cycle) + ');\n');
            }
        }
        if (expectDelta) {
            const restarted = await fixture.runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath: state.preflightPath,
                ...compile, reviewType: 'test', taskIntent: 'Measure authenticated review history', changedFiles: files,
                impactAnalysis: fixture.buildDefaultRemediationImpactAnalysis([files[1]], state.preflightPath), emitMetrics: false });
            assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
            const details = readJson(path.join(root, `${taskId}-review-cycle-restart.json`));
            const classification = readRestartReviewClassification({ reviewsRoot: root, taskId, details }) as ReviewRemediationDecisionClassification;
            state.testExecution = buildAuthenticatedRemediationReviewExecution({ taskId, reviewType: 'test',
                preflightSha256: fixture.fileSha256(state.preflightPath)!, fullReviewScope: files,
                authoritativeDecision: details.authoritative_review_decision as AuthoritativeReviewRemediationDecision,
                authoritativeClassification: classification });
            assert.equal(state.testExecution.contract.mode, 'DELTA');
            assert.deepEqual(state.testExecution.contract.delta!.required_delta_targets, [files[1]]);
        } else {
        fixture.runHandshakeForTask(repoRoot, taskId); fixture.runShellSmokeForTask(repoRoot, taskId);
        state.preflightPath = fixture.runExplicitPreflight(repoRoot, taskId, 'Measure authenticated review history', files);
        await fixture.prepareCurrentReviewCycleValidation(repoRoot, taskId, state.preflightPath);
        fixture.loadPostPreflightRulePack(repoRoot, taskId, state.preflightPath);
        fixture.appendTaskEvent(fixture.getOrchestratorRoot(repoRoot), taskId, 'IMPLEMENTATION_STARTED', 'INFO',
            'Fixture remediation implementation entered after refreshed preflight.', { preflight_path: state.preflightPath,
                preflight_sha256: fixture.fileSha256(state.preflightPath) });
        fixture.writeCompilePassEvidence(repoRoot, taskId, state.preflightPath);
        appendRestart(state, cycle, expectDelta);
        }
        for (const file of fs.readdirSync(fixture.getReviewsRoot(repoRoot))) {
            if (/-[a-f0-9]{64}\.(?:json|md)$/u.test(file)) {
                const absolute = path.resolve(fixture.getReviewsRoot(repoRoot), file);
                state.artifactCycles[absolute] ??= cycle;
            }
        }
        onCycle?.(cycle + 1);
    }
    if (laneCount === 3) assert.ok(readPreservedReviewCoverage({ repoRoot, taskId, reviewsRoot: root,
        preflightPath: state.preflightPath, reviewType: 'code' }), 'Q1 must execute real historical CODE coverage derivation');
    for (const lane of lanes) {
        if (laneCount === 3 && lane !== 'test') {
            const reused = await fixture.runBuildReviewContextCommand({ ...state, reviewType: lane, depth: 2 });
            assert.equal(reused.reusedReviewEvidence, true, reused.outputLines.join('\n'));
            continue;
        }
        fixture.writeReceiptBackedReviewArtifact(repoRoot, taskId, lane, verdict(lane, true), undefined,
        { authenticatedNavigatorLaunch: true, nativeCadenceAdmission: true, nativeReviewPhaseTelemetry: true,
            reviewExecutionContract: lane === 'test' ? state.testExecution?.contract : undefined,
            reviewExecutionValidationAuthority: lane === 'test' ? state.testExecution?.validationAuthority : undefined,
            // The active route is measured after the delegated reviewer returned and before its result is
            // recorded. A real reviewer has then written its output to the launch's review_output_path; without
            // those bytes 1.4.4 correctly treats the completed launch as abandoned (lost output).
            beforeReceipt: lane === (laneCount === 3 ? 'test' : lanes[0]) ? () => {
                const output = writeReturnedReviewerOutput(state, lane);
                try { onActive?.(state); } finally { fs.rmSync(output, { force: true }); }
            } : undefined,
            caseResolutions: Object.fromEntries((buildDeclaredReviewCoverageContract({ repoRoot, reviewType: lane,
                preflight: readJson(state.preflightPath), preflightPath: state.preflightPath }).validationObligations ?? [])
                .filter(binding => binding.case_execution).map(binding => {
                    const execution = binding.case_execution!;
                    const text = retainedNativeCaseOutput(repoRoot, execution).text;
                    const quote = text.split(/\r?\n/u).find(line => /^ok \d+ -/u.test(line.trim()) && line.includes(binding.selector));
                    assert.ok(quote, 'Modeled reviewer must cite the actual retained case output.');
                    return [`VALIDATION-${binding.id.toUpperCase()}`, { binding_sha256: validationDigest(binding),
                        execution_sha256: execution.record_sha256, output_sha256: execution.output_sha256,
                        outcome: 'PASSED' as const, evidence_quote: quote,
                        reasoning: 'This exact independently selected assertion passed in its authenticated retained execution.' }];
                })) });
    }
    const timeline = path.join(fixture.getOrchestratorRoot(repoRoot), 'runtime/task-events', taskId + '.jsonl');
    // The seed helper emits fully bound native review evidence directly. Run the same
    // authenticating producer after those completed writes; never fabricate a derived record.
    prepareClosedReviewCurrentIndex(repoRoot);
    const query = readTaskTimelineClosedReviewQuery(timeline, taskId);
    assert.equal(query?.query.sourceEventType, 'REVIEW_RECORDED');
    publishClosedReviewHistory(captureClosedReviewGate({ repoRoot, taskId, kind: 'record',
        sourceEventSha256: query!.query.source.sha256 }));
    prepareClosedReviewCurrentIndex(repoRoot);
    state.timelineBytes = fs.statSync(timeline).size;
    return state;
}

export async function completeAuthenticatedHistoryFixture(state: Pick<AuthenticatedHistoryFixture, 'repoRoot' | 'taskId' | 'preflightPath' | 'lanes'>): Promise<void> {
    const review = fixture.runRequiredReviewsCheckCommand({ ...state,
        codeReviewVerdict: 'REVIEW PASSED', securityReviewVerdict: 'SECURITY REVIEW PASSED',
        testReviewVerdict: 'TEST REVIEW PASSED', refactorReviewVerdict: 'REFACTOR REVIEW PASSED',
        performanceReviewVerdict: 'PERFORMANCE REVIEW PASSED',
        reviewAuthorshipAttestationJson: JSON.stringify(Object.fromEntries(state.lanes.map(lane => [lane, true]))),
        emitMetrics: false });
    assert.equal(review.exitCode, 0, review.outputLines.join('\n'));
    const doc = runDocImpactGateCommand({ ...state, decision: 'NO_DOC_UPDATES', behaviorChanged: false,
        changelogUpdated: false, sensitiveScopeReviewed: true,
        rationale: 'Temporary fixture changes only a local test value and assertions; it has no deployed interface or documentation contract.', emitMetrics: false });
    assert.equal(doc.exitCode, 0, doc.outputLines.join('\n'));
    const memory = runProjectMemoryImpactCommand(state);
    assert.equal(memory.exitCode, 0, memory.outputLines.join('\n'));
    const previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await handleCompletionGate(['--repo-root', state.repoRoot, '--task-id', state.taskId, '--preflight-path', state.preflightPath]);
        assert.equal(process.exitCode, 0, 'The real completion handler must accept and materialize the fixture.');
    } finally { process.exitCode = previousExitCode; }
    assert.ok(fs.existsSync(path.join(fixture.getReviewsRoot(state.repoRoot), state.taskId + '-final-closeout.json')));
}
