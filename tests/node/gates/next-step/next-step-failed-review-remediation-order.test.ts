import '../../../../src/bin/garda/derivation-source-receipts';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { resolveNextStep } from './next-step-test-support';
import { readReviewArtifactState } from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import { createAuthenticatedNextStepHistoryFixture, type AuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';
import * as fixture from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import { runIntermediateCommandCommand } from '../../../../src/cli/commands/gate-flows/command-run/command-run-flow';
import { buildReviewRemediationBaselineArtifact } from '../../../../src/gates/review-remediation/review-remediation-baseline';
import { hasOpenFixNowRemediationOnCurrentPreflight } from '../../../../src/gates/review-remediation/review-remediation-origin';
import { buildReviewRemediationDeltaBase } from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import { resolveDefaultQualityChecklistArtifactPath, QUALITY_CHECKLIST_ID } from '../../../../src/gates/quality-checklist';
import { inspectQualityValidationPhases } from '../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { validationDigest } from '../../../../src/core/project-validation-identity';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import type { ReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import type { ReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';

// OP-045: a fresh FULL review recorded an authenticated fix_now failure. Recording it changed the canonical
// validation obligations, so the navigator refreshed the quality checklist, rebuilt the review context and then
// asked for a new reviewer of the same unchanged code instead of routing to the fix.

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Bind the latest recorded review of a lane to a retained remediation baseline, as record-review-result does. */
function retainRecordedBaseline(state: AuthenticatedHistoryFixture, lane: string, passed: boolean): void {
    const prefix = path.join(fixture.getReviewsRoot(state.repoRoot), `${state.taskId}-${lane}`);
    const receiptPath = prefix + '-receipt.json', artifactPath = prefix + '.md';
    const validationPath = prefix + '-findings-validation.json', dispositionPath = prefix + '-findings-disposition.json';
    const receipt = readJson(receiptPath), context = readJson(prefix + '-review-context.json');
    const baseline = buildReviewRemediationBaselineArtifact({ taskId: state.taskId, reviewType: lane, withoutFixNowItems: passed,
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
    const recorded = [...fixture.readTaskTimelineEvents(state.repoRoot, state.taskId)].reverse().find(event =>
        event.event_type === 'REVIEW_RECORDED' && (event.details as Record<string, unknown> | undefined)?.review_type === lane);
    const details = recorded?.details as Record<string, unknown> | undefined;
    assert.equal(details?.receipt_sha256, fixture.fileSha256(receiptPath));
    fixture.appendTaskEvent(fixture.getOrchestratorRoot(state.repoRoot), state.taskId, 'REVIEW_RECORDED', 'PASS',
        'Bind the retained review baseline to its original receipt.', {
            ...details, remediation_baseline_path: mutable,
            remediation_baseline_snapshot_path: retained, remediation_baseline_snapshot_sha256: fixture.fileSha256(retained)
        });
}

async function rerunSelectedCase(state: AuthenticatedHistoryFixture): Promise<void> {
    const testContext = process.env.NODE_TEST_CONTEXT;
    try {
        delete process.env.NODE_TEST_CONTEXT;
        const execution = await runIntermediateCommandCommand({ repoRoot: state.repoRoot, taskId: state.taskId,
            preflightPath: state.preflightPath, commandSource: 'targeted-test',
            command: `node --experimental-strip-types --test --test-reporter=tap ${fixture.TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH}` });
        assert.equal(execution.exitCode, 0, execution.outputLines.join('\n'));
    } finally {
        if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = testContext;
    }
}

function inspectCurrentChecklistPhases(state: AuthenticatedHistoryFixture) {
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(state.repoRoot, state.taskId);
    const artifact = readJson(artifactPath);
    const preflightSha256 = fixture.fileSha256(state.preflightPath)!;
    const validation = inspectQualityValidationPhases({ repoRoot: state.repoRoot, taskId: state.taskId,
        preflight: readJson(state.preflightPath), preflightSha256, matrixRequired: true,
        matrix: artifact.answers[0].trust_boundary_matrix });
    return { artifactPath, artifact, preflightSha256, validation };
}

function readChecklistPhaseExecution(state: AuthenticatedHistoryFixture): string | null {
    return inspectCurrentChecklistPhases(state).validation?.phases.execution ?? null;
}

/** Current canonical validation phases versus the recorded checklist phases. */
function readChecklistPhases(state: AuthenticatedHistoryFixture) {
    const { artifactPath, artifact, preflightSha256, validation } = inspectCurrentChecklistPhases(state);
    assert.equal(validation?.phases.execution, 'OBSERVED');
    return { artifactPath, artifact, preflightSha256, current: validation!.phases };
}

/** What the quality-checklist gate records: the current canonical phases as PENDING_VALIDATION evidence. */
function rerecordChecklistPhases(state: AuthenticatedHistoryFixture): void {
    const { artifactPath, artifact, preflightSha256, current } = readChecklistPhases(state);
    artifact.status = 'PENDING_VALIDATION';
    artifact.validation_phases = current;
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    fixture.appendTaskEvent(fixture.getOrchestratorRoot(state.repoRoot), state.taskId, 'QUALITY_CHECKLIST_RECORDED', 'PASS',
        'Re-recorded validation phases after the failed review.', {
            artifact_path: fixture.normalizePath(artifactPath), artifact_hash: fixture.fileSha256(artifactPath),
            status: 'PASS', outcome: 'PASS', checklist_id: QUALITY_CHECKLIST_ID,
            preflight_path: fixture.normalizePath(path.resolve(state.preflightPath)), preflight_sha256: preflightSha256
        }, { actor: 'gate' });
}

/**
 * A passed review keeps its reviewed native case execution through a later rerun. A failed FULL review of the
 * same lane then supersedes it, so the canonical validation obligation falls back to the latest execution and
 * the recorded checklist phases are stale, exactly as in the field.
 */
async function createFailedReviewWithStaleChecklist(): Promise<AuthenticatedHistoryFixture> {
    const state = await createAuthenticatedNextStepHistoryFixture(1, 1);
    retainRecordedBaseline(state, 'code', true);
    await rerunSelectedCase(state);
    assert.equal(resolveNextStep(state).next_gate, 'required-reviews-check');
    fixture.writeReceiptBackedReviewArtifact(state.repoRoot, state.taskId, 'code', 'REVIEW FAILED', undefined,
        { authenticatedNavigatorLaunch: true, findingSeverity: 'medium',
            caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(state.repoRoot, state.taskId) });
    retainRecordedBaseline(state, 'code', false);
    const phases = readChecklistPhases(state);
    assert.notEqual(validationDigest(phases.current), validationDigest(phases.artifact.validation_phases),
        'The recorded failure must change the canonical validation obligations.');
    return state;
}

function readCodeReviewState(state: AuthenticatedHistoryFixture) {
    return readReviewArtifactState(fixture.getReviewsRoot(state.repoRoot), state.taskId, 'code', state.preflightPath,
        fixture.fileSha256(state.preflightPath), readJson(state.preflightPath), state.repoRoot);
}

function assertFixFirst(result: ReturnType<typeof resolveNextStep>): void {
    assert.equal(result.next_gate, 'implementation', result.reason);
    assert.match(result.title, /Fix failed 'code' review findings/u);
    assert.match(result.reason, /CODE REVIEW FAILED/u);
    assert.match(result.reason, /quality-checklist and review-context refreshes wait until the fix/u);
    assert.equal(result.review.failed_review_type, 'code');
    assert.equal(result.review.next_review_type, 'code');
    assert.deepEqual(result.review.launchable_review_types, []);
    assert.ok(result.commands.every(entry => !/quality-checklist|build-review-context|record-review-routing/u.test(entry.command)));
}

function changeReviewedCode(state: AuthenticatedHistoryFixture): void {
    // A runnable test: lines that run the changed tests during restart must still pass.
    fs.writeFileSync(path.join(state.repoRoot, state.files[1]),
        "const assert = require('node:assert/strict');\nassert.equal(404, 404);\n");
}

test('a fix_now failure that makes the checklist phases stale routes to remediation before the checklist', { timeout: 900_000 }, async () => {
    const state = await createFailedReviewWithStaleChecklist();
    const reviewState = readCodeReviewState(state);
    assert.equal(reviewState.failed, true);
    assert.equal(reviewState.reviewFindingsDisposition?.counts_by_action.fix_now, 1);

    assertFixFirst(resolveNextStep(state));

    // The refresh is postponed, not skipped: the fix opens the ordinary failed-review remediation cycle.
    changeReviewedCode(state);
    const fixed = resolveNextStep(state);
    assert.equal(fixed.next_gate, 'restart-review-cycle', fixed.reason);
    assert.match(fixed.title, /Restart failed 'code' review remediation cycle/u);
});

test('an authenticated failed test review names its lane and offers no reviewer launch during remediation', { timeout: 900_000 }, async () => {
    const state = await createAuthenticatedNextStepHistoryFixture(1, 3);
    fixture.writeReceiptBackedReviewArtifact(state.repoRoot, state.taskId, 'test', 'TEST REVIEW FAILED', undefined,
        { authenticatedNavigatorLaunch: true, findingSeverity: 'medium', findingEvidenceFile: state.files[1],
            caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(state.repoRoot, state.taskId) });
    retainRecordedBaseline(state, 'test', false);

    const result = resolveNextStep(state);
    assert.equal(result.next_gate, 'implementation', result.reason);
    assert.match(result.reason, /TEST REVIEW FAILED/u);
    assert.equal(result.review.failed_review_type, 'test');
    assert.equal(result.review.next_review_type, 'test');
    assert.deepEqual(result.review.launchable_review_types, []);
    assert.ok(result.commands.every(entry => !/reviewer-launch/u.test(entry.command)));
});

test('a fix_now failure whose checklist and context were refreshed on unchanged code still routes to remediation', { timeout: 900_000 }, async () => {
    const state = await createFailedReviewWithStaleChecklist();
    // The field sequence: quality-checklist re-recorded, then the review context rebuilt on the unchanged code.
    rerecordChecklistPhases(state);
    fixture.prepareScopedDiffFixture(state.repoRoot, state.preflightPath, 'code');
    await fixture.runBuildReviewContextCommand({ repoRoot: state.repoRoot, reviewType: 'code', depth: 2,
        preflightPath: state.preflightPath,
        outputPath: path.join(fixture.getReviewsRoot(state.repoRoot), `${state.taskId}-code-review-context.json`) });
    const reviewState = readCodeReviewState(state);
    assert.equal(reviewState.failed, false, 'The rebuilt context no longer matches the failed receipt.');
    assert.equal(reviewState.receiptReviewTreeStateSha256, reviewState.contextReviewTreeStateSha256);

    const unchanged = resolveNextStep(state);
    assertFixFirst(unchanged);
    assert.notEqual(unchanged.next_gate, 'record-review-routing');

    changeReviewedCode(state);
    const fixed = resolveNextStep(state);
    assert.equal(fixed.next_gate, 'restart-review-cycle', fixed.reason);
    assert.match(fixed.title, /Restart failed 'code' review remediation cycle/u);
    const { commandsPath, outputFiltersPath } = fixture.writeSimpleCompileCommandsFile(state.repoRoot, 'fix');
    const restarted = await fixture.runRestartReviewCycleCommand({ repoRoot: state.repoRoot, taskId: state.taskId,
        preflightPath: state.preflightPath, commandsPath, outputFiltersPath, changedFiles: state.files, reviewType: 'code',
        emitMetrics: false });
    assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
    // The postponed refresh runs for the fixed code: the restart refreshes preflight and the checklist, then the
    // failed lane gets a new context on the fixed tree before the re-review.
    const refreshedPreflightSha256 = fixture.fileSha256(state.preflightPath);
    const checklist = readJson(resolveDefaultQualityChecklistArtifactPath(state.repoRoot, state.taskId));
    const refreshed = resolveNextStep(state);
    assert.notEqual(refreshed.next_gate, 'implementation', refreshed.reason);
    if (refreshed.next_gate !== 'quality-checklist') {
        assert.equal(checklist.preflight_sha256, refreshedPreflightSha256, refreshed.reason);
        const context = readJson(path.join(fixture.getReviewsRoot(state.repoRoot), `${state.taskId}-code-review-context.json`));
        assert.equal(context.preflight_sha256, refreshedPreflightSha256, refreshed.reason);
        assert.notEqual(context.tree_state.tree_state_sha256, reviewState.receiptReviewTreeStateSha256, refreshed.reason);
    }
});

test('a fix_now receipt without its attested review record keeps its own recovery instead of the unchanged-scope route', { timeout: 900_000 }, async () => {
    const state = await createAuthenticatedNextStepHistoryFixture(1, 1);
    fixture.writeReceiptBackedReviewArtifact(state.repoRoot, state.taskId, 'code', 'REVIEW FAILED', undefined,
        { authenticatedNavigatorLaunch: true, findingSeverity: 'medium',
            caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(state.repoRoot, state.taskId) });
    retainRecordedBaseline(state, 'code', false);
    // Drop the reviewer invocation attestation from the receipt: the receipt no longer is the attested record.
    const receiptPath = path.join(fixture.getReviewsRoot(state.repoRoot), `${state.taskId}-code-receipt.json`);
    const receipt = readJson(receiptPath);
    receipt.reviewer_provenance = null;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    const reviewState = readCodeReviewState(state);
    assert.equal(reviewState.reviewFindingsDisposition?.counts_by_action.fix_now, 1);
    assert.equal(reviewState.receiptReviewTreeStateSha256, reviewState.contextReviewTreeStateSha256);

    const result = resolveNextStep(state);
    assert.notEqual(result.next_gate, 'implementation', result.reason);
    assert.doesNotMatch(result.reason, /refreshes wait until the fix/u);
});

test('a rebuilt-context fix_now failure authorizes the fix beside accepted deferred findings of another lane', { timeout: 900_000 }, async () => {
    const state = await createAuthenticatedNextStepHistoryFixture(1, 3);
    const deferredLane = state.lanes.find(lane => lane !== 'code')!;
    fixture.writeReceiptBackedReviewArtifact(state.repoRoot, state.taskId, deferredLane,
        `${deferredLane.toUpperCase()} REVIEW PASSED`, undefined, { authenticatedNavigatorLaunch: true, findingSeverity: 'low',
            caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(state.repoRoot, state.taskId) });
    retainRecordedBaseline(state, deferredLane, true);
    const deferredState = readReviewArtifactState(fixture.getReviewsRoot(state.repoRoot), state.taskId, deferredLane,
        state.preflightPath, fixture.fileSha256(state.preflightPath), readJson(state.preflightPath), state.repoRoot);
    assert.equal(deferredState.reviewFindingsDisposition?.counts_by_action.create_follow_up, 1);
    assert.equal(deferredState.reviewFindingsDisposition?.blocking_count, 0);

    fixture.writeReceiptBackedReviewArtifact(state.repoRoot, state.taskId, 'code', 'REVIEW FAILED', undefined,
        { authenticatedNavigatorLaunch: true, findingSeverity: 'medium',
            caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(state.repoRoot, state.taskId) });
    retainRecordedBaseline(state, 'code', false);
    // Re-record the checklist as in the field when this fixture's checklist binds observed validation phases.
    if (readChecklistPhaseExecution(state) === 'OBSERVED') rerecordChecklistPhases(state);
    fixture.prepareScopedDiffFixture(state.repoRoot, state.preflightPath, 'code');
    await fixture.runBuildReviewContextCommand({ repoRoot: state.repoRoot, reviewType: 'code', depth: 2,
        preflightPath: state.preflightPath,
        outputPath: path.join(fixture.getReviewsRoot(state.repoRoot), `${state.taskId}-code-review-context.json`) });
    assert.equal(readCodeReviewState(state).failed, false, 'The rebuilt context no longer matches the failed receipt.');
    assertFixFirst(resolveNextStep(state));

    changeReviewedCode(state);
    const fixed = resolveNextStep(state);
    assert.doesNotMatch(fixed.reason, /Post-review source mutation is not authorized|frozen as non-remediation dispositions/u);
    assert.equal(fixed.next_gate, 'restart-review-cycle', fixed.reason);
    assert.match(fixed.title, /Restart failed 'code' review remediation cycle/u);
});

// OnlineStore T-014-1-2: an API review passed with a deferred finding, the code review failed with a fix_now
// finding, and restart-review-cycle refreshed the preflight for the fix. The fix then continued before the code
// lane was reviewed again. The failed review is bound to the earlier preflight, so the navigator found no current
// failure and the post-review guard stopped with `commands: []`. The open remediation must keep its restart route.
test('a fix that continues after the remediation restart keeps the failed-lane restart route', { timeout: 900_000 }, async () => {
    const state = await createAuthenticatedNextStepHistoryFixture(1, 3);
    const deferredLane = state.lanes.find(lane => lane !== 'code')!;
    fixture.writeReceiptBackedReviewArtifact(state.repoRoot, state.taskId, deferredLane,
        `${deferredLane.toUpperCase()} REVIEW PASSED`, undefined, { authenticatedNavigatorLaunch: true, findingSeverity: 'low',
            caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(state.repoRoot, state.taskId) });
    retainRecordedBaseline(state, deferredLane, true);
    fixture.writeReceiptBackedReviewArtifact(state.repoRoot, state.taskId, 'code', 'REVIEW FAILED', undefined,
        { authenticatedNavigatorLaunch: true, findingSeverity: 'medium',
            caseResolutions: fixture.buildCurrentReviewCycleCaseResolutions(state.repoRoot, state.taskId) });
    retainRecordedBaseline(state, 'code', false);
    const failedPreflightSha256 = fixture.fileSha256(state.preflightPath);

    changeReviewedCode(state);
    const fixed = resolveNextStep(state);
    assert.equal(fixed.next_gate, 'restart-review-cycle', fixed.reason);
    const { commandsPath, outputFiltersPath } = fixture.writeSimpleCompileCommandsFile(state.repoRoot, 'fix');
    const restarted = await fixture.runRestartReviewCycleCommand({ repoRoot: state.repoRoot, taskId: state.taskId,
        preflightPath: state.preflightPath, commandsPath, outputFiltersPath, changedFiles: state.files, reviewType: 'code',
        emitMetrics: false });
    assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
    const restartedPreflightSha256 = fixture.fileSha256(state.preflightPath)!;
    assert.notEqual(restartedPreflightSha256, failedPreflightSha256, 'The restart refreshes the preflight.');

    fixture.appendTaskEvent(fixture.getOrchestratorRoot(state.repoRoot), state.taskId, 'REVIEW_PHASE_STARTED', 'INFO',
        'The failed code lane opens its re-review phase.', {
            review_type: 'code', preflight_path: state.preflightPath, preflight_sha256: restartedPreflightSha256
        }, { actor: 'gate' });
    // The fix goes on after its own re-review phase opens, before a new reviewer is prepared.
    fs.writeFileSync(path.join(state.repoRoot, state.files[1]),
        "const assert = require('node:assert/strict');\nassert.equal(405, 405);\n");
    const receiptSha256 = fixture.fileSha256(path.join(fixture.getReviewsRoot(state.repoRoot), `${state.taskId}-code-receipt.json`))!;
    const openRemediation = { repoRoot: state.repoRoot, taskId: state.taskId, reviewType: 'code',
        preflightSha256: restartedPreflightSha256, currentReceiptSha256: receiptSha256 };
    assert.equal(hasOpenFixNowRemediationOnCurrentPreflight(openRemediation), true);
    assert.equal(hasOpenFixNowRemediationOnCurrentPreflight({ ...openRemediation, currentReceiptSha256: '0'.repeat(64) }), false,
        'Another receipt in place is not the recorded failure.');
    assert.equal(hasOpenFixNowRemediationOnCurrentPreflight({ ...openRemediation, preflightSha256: failedPreflightSha256! }), false,
        'The failure is open only on the preflight its remediation restart refreshed.');
    assert.equal(hasOpenFixNowRemediationOnCurrentPreflight({ ...openRemediation, reviewType: deferredLane }), false,
        'A passed lane with a deferred finding never authorizes a fix.');

    const continued = resolveNextStep(state);
    assert.equal(continued.status, 'BLOCKED');
    assert.notEqual(continued.next_gate, 'post-review-source-mutation-guard', continued.reason);
    assert.equal(continued.next_gate, 'restart-review-cycle', continued.reason);
    assert.match(continued.title, /Restart failed 'code' review remediation cycle/u);
    assert.equal(continued.commands.length, 1);
    assert.match(continued.commands[0].command, /gate restart-review-cycle /u);
    assert.match(continued.commands[0].command, /--review-type "code"/u);
    for (const changedFile of state.files) {
        assert.ok(continued.commands[0].command.includes(`--changed-file "${changedFile}"`), continued.commands[0].command);
    }

    // A reviewer launch of the cycle the restart opened ends the open remediation: a change then follows the review rules.
    fixture.appendTaskEvent(fixture.getOrchestratorRoot(state.repoRoot), state.taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO',
        'Reviewer launch prepared.', { review_type: 'code' }, { actor: 'gate' });
    assert.equal(hasOpenFixNowRemediationOnCurrentPreflight(openRemediation), false);
    fs.appendFileSync(path.join(state.repoRoot, state.files[1]), '// Edit after preparation closed the prior authority.\n');
    const expired = resolveNextStep(state);
    assert.doesNotMatch(expired.title, /Restart failed 'code' review remediation cycle/u);
    assert.ok(expired.commands.every(item => !/gate restart-review-cycle .*--review-type "code"/u.test(item.command)
        || /--review-restart-approved|--operator-confirmed/u.test(item.command)), expired.reason);
});
