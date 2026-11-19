import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDeclaredReviewCoverageContract, resolveAuthoritativeReviewValidationObligations } from '../../../../../../src/gates/review-context/review-context-coverage';
import { createPreservationFixture } from '../../../../gates/review/test-only-review-preservation-fixtures';
import * as recovery from '../review-cycle/gates-review-cycle-fixtures';
import { buildDefaultReviewRemediationRerunPolicy } from '../../../../../../src/policy/review-remediation-rerun-policy';
import { buildDefaultReviewRemediationModePolicy } from '../../../../../../src/policy/review-remediation-mode-policy';
import { normalizeOptionalQualityChecksConfig, isOptionalQualityCheckRuleActiveForScope } from '../../../../../../src/core/workflow-config';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID, assessTrustBoundaryAnalysisApplicability } from '../../../../../../src/core/trust-boundary-analysis';
import { runQualityChecklistCommand } from '../../../../../../src/cli/commands/gates';
import { validationDigest, readValidationFile } from '../../../../../../src/core/project-validation-identity';
import type { QualityValidationObligation } from '../../../../../../src/gates/quality-checklist/quality-checklist-validation-phases';
import { handleRecordReviewResult } from '../../../../../../src/cli/commands/gate-review-handlers';
import { computeTaskProfilePolicySnapshotHash } from '../../../../../../src/policy/task-profile-policy-snapshot';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { readTestOnlyReviewPreservation, readPreservedReviewCoverage } from '../../../../../../src/gates/review-remediation/test-only-review-preservation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../../../src/core/next-step-measurement';
import { withInvocationReadObservation } from '../../../../../../src/core/invocation-read-observation';
import { runIntermediateCommandCommand } from '../../../../../../src/cli/commands/gate-flows/command-run/command-run-flow';
import { getNativeCaseResolutionViolations } from '../../../../../../src/gates/review/native-case-semantics';
import { completeAuthenticatedHistoryFixture } from '../../../../gates/next-step/next-step-authenticated-history-fixture';

const SOURCE = 'src/app.ts';
const HELPER = 'tests/helpers/preservation.cjs';
const CASE_SOURCE = recovery.TRUST_BOUNDARY_FIXTURE_EVIDENCE_PATH;
const ADDED_CASE = 'rejects a replaced private helper value';

function readJson(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function saveJson(file: string, value: unknown): void { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

async function recordNativeReview(repoRoot: string, taskId: string, preflightPath: string,
    lane: string, passed: boolean) {
    const verdict = lane === 'code' ? `REVIEW ${passed ? 'PASSED' : 'FAILED'}`
        : `${lane.toUpperCase()} REVIEW ${passed ? 'PASSED' : 'FAILED'}`;
    const evidenceFile = lane === 'test' ? CASE_SOURCE : buildDeclaredReviewCoverageContract({
        repoRoot, preflight: readJson(preflightPath), preflightPath, reviewType: lane }).changedFiles[0];
    assert.ok(evidenceFile, 'modeled reviewer notes must name a file in the actual lane evidence domain');
    recovery.writeReceiptBackedReviewArtifact(repoRoot, taskId, lane, verdict, undefined,
        { authenticatedNavigatorLaunch: true, skipReceipt: true, findingSeverity: passed ? null : 'high',
            findingEvidenceFile: evidenceFile, caseResolutions: currentCaseResolutions(repoRoot, taskId) });
    const reviewsRoot = recovery.getReviewsRoot(repoRoot);
    const context = readJson(path.join(reviewsRoot, `${taskId}-${lane}-review-context.json`));
    const output = path.join(repoRoot, 'garda-agent-orchestrator/runtime/tmp/reviews', taskId, lane, 'review-output.md');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(reviewsRoot, `${taskId}-${lane}.md`), output);
    const prior = process.exitCode;
    try {
        process.exitCode = 0;
        await handleRecordReviewResult(['--task-id', taskId, '--review-type', lane,
            '--preflight-path', preflightPath, '--review-output-path', output, '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', context.reviewer_routing.reviewer_session_id]);
        assert.equal(process.exitCode ?? 0, 0, 'the native review-result producer must accept the fixture report');
    } finally { process.exitCode = prior; }
    assert.ok(fs.existsSync(path.join(reviewsRoot, `${taskId}-${lane}-receipt.json`)));
}

function currentCaseResolutions(repoRoot: string, taskId: string) {
    const quality = readJson(path.join(recovery.getReviewsRoot(repoRoot), `${taskId}-quality-checklist.json`));
    const bindings = quality.validation_phases.obligations as QualityValidationObligation[];
    return Object.fromEntries(bindings.map(binding => {
        assert.equal(binding.execution, 'OBSERVED');
        assert.ok(binding.case_execution);
        const execution = binding.case_execution;
        const relative = path.relative(repoRoot, path.resolve(repoRoot, execution.output_path)).replace(/\\/gu, '/');
        const output = readValidationFile(repoRoot, relative).bytes.toString('utf8');
        const quote = output.split(/\r?\n/u).find(line => line.includes(binding.selector) && /^ok \d+ -/u.test(line.trim()));
        assert.ok(quote, `Actual output must mark the selected assertion as passed: ${binding.selector}`);
        return [`VALIDATION-${binding.id.toUpperCase()}`, { binding_sha256: validationDigest(binding),
            execution_sha256: execution.record_sha256, output_sha256: execution.output_sha256,
            outcome: 'PASSED', evidence_quote: quote,
            reasoning: 'The retained native execution marks this exact replacement-rejection assertion as passed.' }];
    }));
}

async function createNativeRecovery(t: TestContext, testOnly = false, normalDefaults = false,
    nonprivate?: 'production' | 'source-role') {
    const repoRoot = recovery.createTempRepo(t), taskId = `T-CLAIM-COMPOSITION-${testOnly ? 'TEST' : 'MIXED'}`;
    recovery.seedRemediationRepoBase(repoRoot);
    recovery.writeReviewCapabilitiesConfig(repoRoot);
    const profilesPath = recovery.writeProfilesConfig(repoRoot), profiles = readJson(profilesPath);
    profiles.built_in_profiles.balanced.review_policy = Object.fromEntries(
        ['code', 'security', 'test', 'refactor', 'api', 'performance', 'db', 'infra', 'dependency']
            .map(lane => [lane, ['code', 'security', 'test'].includes(lane)]));
    const rerun = buildDefaultReviewRemediationRerunPolicy();
    Reflect.deleteProperty(rerun, 'private_test_review_preservation');
    for (const category of ['structural_test', 'shared_test_helper_or_harness', 'ambiguous'] as const)
        rerun.rules[category] = { strategy: 'current_review_only' };
    profiles.built_in_profiles.balanced.review_remediation_mode_policy = buildDefaultReviewRemediationModePolicy();
    saveJson(profilesPath, profiles);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(repoRoot, HELPER)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, SOURCE), 'export const value = 1;\n');
    fs.writeFileSync(path.join(repoRoot, HELPER), 'module.exports = { value: 0 };\n');
    // The selected assertion is part of the original reviewable task delta.
    fs.writeFileSync(path.join(repoRoot, CASE_SOURCE), "throw new Error('initial baseline');\n");
    const compile = recovery.writeSimpleCompileCommandsFile(repoRoot, 'claim-composition');
    // The shared fixture forces security for every path. Here security remains mandatory
    // through TASK.md, while its accepted production domain excludes private test repairs.
    const scopePath = path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json');
    const scope = readJson(scopePath);
    scope.triggers.security = ['^src/'];
    saveJson(scopePath, scope);
    const workflowPath = recovery.writeWorkflowConfig(repoRoot, 'strict_sequential');
    const initialWorkflow = readJson(workflowPath);
    const qualityRules = normalizeOptionalQualityChecksConfig(initialWorkflow.optional_quality_checks);
    const boundaryRule = qualityRules.rules.find(rule => rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID)!;
    // Exercise selected-case semantics in both the mixed and empty production domains
    // without pretending every private test repair changes the security domain.
    boundaryRule.included_changed_file_regexes = ['.*'];
    initialWorkflow.optional_quality_checks = qualityRules;
    saveJson(workflowPath, initialWorkflow);
    if (nonprivate === 'source-role') {
        const pathsConfig = path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json');
        saveJson(pathsConfig, { ...(fs.existsSync(pathsConfig) ? readJson(pathsConfig) : {}), file_roles: { [HELPER]: 'source' } });
    }
    recovery.initializeGitRepo(repoRoot);
    if (!testOnly) fs.writeFileSync(path.join(repoRoot, SOURCE), 'export const value = 2;\n');
    fs.writeFileSync(path.join(repoRoot, HELPER), 'module.exports = { value: 1 };\n');
    recovery.writeCurrentReviewCycleValidationSource(repoRoot);
    const files = [...(testOnly ? [] : [SOURCE]), HELPER, CASE_SOURCE];
    recovery.seedTaskQueue(repoRoot, taskId);
    const taskPath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace('| fixture |',
        '| fixture. Required reviews: code, security, test. |'));
    recovery.seedInitAnswers(repoRoot, 'Codex');
    const entered = recovery.runEnterTaskMode({ repoRoot, taskId, provider: 'Codex',
        taskSummary: 'Compose authenticated review claims', plannedChangedFiles: files });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    const modePath = path.join(recovery.getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    const mode = readJson(modePath), frozen = mode.profile_policy_snapshot;
    // Model a pre-existing authored frozen policy, as the foundation authority fixture does.
    // Entry currently creates the default rerun policy; live profiles cannot configure it.
    if (!normalDefaults) {
        frozen.review_remediation_rerun_policy = rerun;
        frozen.snapshot_hash = computeTaskProfilePolicySnapshotHash(frozen);
        saveJson(modePath, mode);
        const recorded = appendTaskEvent(recovery.getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS',
            'Fixture constructor for an already frozen authored preservation policy.', {
                artifact_path: modePath.replace(/\\/gu, '/'), profile_policy_snapshot_required: true,
                profile_policy_snapshot_hash: frozen.snapshot_hash }, { passThru: true, emitOnce: false });
        assert.ok(recorded?.canonical_committed);
        assert.equal(frozen.review_remediation_rerun_policy.rules.ambiguous.strategy, 'current_review_only');
    } else {
        assert.equal(frozen.review_remediation_rerun_policy.private_test_review_preservation, true);
        assert.equal(recovery.readTaskTimelineEvents(repoRoot, taskId)
            .filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 1,
        'normal defaults must come from the real entry producer without a modeled policy replacement');
    }
    if (nonprivate === 'source-role') assert.equal(frozen.review_trigger_policy.file_roles[HELPER], 'source');
    recovery.loadTaskEntryRulePack(repoRoot, taskId);
    recovery.runHandshakeForTask(repoRoot, taskId);
    recovery.runShellSmokeForTask(repoRoot, taskId);
    const preflightPath = recovery.runExplicitPreflight(repoRoot, taskId, 'Compose authenticated review claims', files);
    await recovery.prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
    recovery.loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    recovery.writeCompilePassEvidence(repoRoot, taskId, preflightPath);
    for (const lane of ['code', 'security']) await recordNativeReview(repoRoot, taskId, preflightPath, lane, true);
    const reviewsRoot = recovery.getReviewsRoot(repoRoot);
    const originalCode = fs.readFileSync(path.join(reviewsRoot, `${taskId}-code.md`));
    const originalCodeReceipt = readJson(path.join(reviewsRoot, `${taskId}-code-receipt.json`));
    const quality = readJson(path.join(reviewsRoot, `${taskId}-quality-checklist.json`));
    const matrix = quality.answers.find((answer: { rule_id: string }) => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID).trust_boundary_matrix;
    await recordNativeReview(repoRoot, taskId, preflightPath, 'test', false);
    fs.writeFileSync(path.join(repoRoot, HELPER), 'module.exports = { value: 2 };\n');
    const helperPath = path.relative(path.dirname(CASE_SOURCE), HELPER).replace(/\\/gu, '/');
    fs.appendFileSync(path.join(repoRoot, CASE_SOURCE),
        `test('${ADDED_CASE}', () => assert.throws(() => assert.equal(require('${helperPath}').value, 1)));\n`);
    if (nonprivate === 'production') fs.appendFileSync(path.join(repoRoot, SOURCE), 'export const changedProductionContract = true;\n');
    const restarted = await recovery.runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, ...compile,
        reviewType: 'test', taskIntent: 'Compose authenticated review claims', changedFiles: files,
        impactAnalysis: recovery.buildDefaultRemediationImpactAnalysis(
            [...(nonprivate === 'production' ? [SOURCE] : []), HELPER, CASE_SOURCE], preflightPath), emitMetrics: false });
    assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
    const restart = recovery.readTaskTimelineEvents(repoRoot, taskId)
        .filter(event => event.event_type === 'REVIEW_CYCLE_RESTARTED').at(-1);
    const decision = (restart?.details as Record<string, unknown> | undefined)?.authoritative_review_decision as
        { status: string; invalidated_review_types: string[] } | undefined;
    assert.equal(decision?.status, 'READY', 'the real native restart must reconstruct the preservation decision');
    const fixture = { repoRoot, taskId, reviewsRoot, preflightPath, originalCode, originalCodeReceipt, lanes: ['code', 'security', 'test'] };
    if (nonprivate) {
        assert.ok(decision.invalidated_review_types.includes('code'), 'production/source-role changes must invalidate CODE');
        assert.equal(readTestOnlyReviewPreservation({ ...fixture, reviewType: 'code' }), null);
        const nextCode = await recovery.runBuildReviewContextCommand({ ...fixture, reviewType: 'code', depth: 2 });
        assert.equal(nextCode.reusedReviewEvidence, false, 'affected production requires fresh code review');
        assert.equal(nextCode.acceptedReviewEvidenceKind, null);
        return fixture;
    }
    assert.deepEqual(decision.invalidated_review_types, ['test'],
        'the already frozen policy must preserve upstream lanes: ' + JSON.stringify(decision));
    let measurement: NextStepMeasurement | undefined;
    const candidate = withNextStepMeasurement(() => readTestOnlyReviewPreservation({
        repoRoot, taskId, reviewsRoot, preflightPath, reviewType: 'code' }), value => { measurement = value; });
    assert.ok(candidate, 'before current matrix update: ' + JSON.stringify(Object.fromEntries(
        Object.entries(measurement?.work ?? {}).filter(([key]) => key.startsWith('preservation_rejected:')))));
    matrix[0].negative_paths.push({ kind: 'replaced', scenario: ADDED_CASE,
        expected_behavior: 'Reject the original private helper value after its correction.',
        evidence_files: [`${CASE_SOURCE}#${ADDED_CASE}`] });
    const preflight = readJson(preflightPath);
    const workflow = readJson(path.join(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json'));
    const active = normalizeOptionalQualityChecksConfig(workflow.optional_quality_checks).rules.filter(rule =>
        rule.enabled !== false && (isOptionalQualityCheckRuleActiveForScope(rule, preflight.scope_category, preflight.changed_files)
            || rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID && assessTrustBoundaryAnalysisApplicability(preflight).required));
    if (testOnly) {
        // No production boundary forces automatic validation in this domain. Observe
        // the actual added case explicitly before asking for independent TEST semantics.
        const nestedContext = process.env.NODE_TEST_CONTEXT;
        try {
            delete process.env.NODE_TEST_CONTEXT;
            const observed = await runIntermediateCommandCommand({ repoRoot, taskId, preflightPath,
                commandSource: 'targeted-test',
                command: `node --experimental-strip-types --test --test-reporter=tap ${CASE_SOURCE}` });
            assert.equal(observed.exitCode, 0, observed.outputLines.join('\n'));
        } finally {
            if (nestedContext === undefined) delete process.env.NODE_TEST_CONTEXT;
            else process.env.NODE_TEST_CONTEXT = nestedContext;
        }
    }
    const checked = runQualityChecklistCommand({ repoRoot, taskId, preflightPath, emitMetrics: false,
        answersJson: JSON.stringify(active.map(rule => ({ rule_id: rule.id, status: 'PASS',
            answer: 'Verified the native recovery boundary with current replacement-rejection assertions and their retained execution.',
            evidence_files: [CASE_SOURCE], actions_taken: [], actions_required: [],
            ...(rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? { trust_boundary_matrix: matrix } : {}) }))) });
    assert.equal(checked.exitCode, 0, checked.outputLines.join('\n'));
    return fixture;
}

test('a failed-test baseline alone cannot supply accepted code claims or current test semantics', t => {
    const fixture = createPreservationFixture(t);
    const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
    const original = fixture.baseline.origin_coverage_contract!.obligations.flatMap(obligation =>
        obligation.kind === 'validation' && obligation.validation_binding ? [obligation.validation_binding] : []);
    assert.ok(original.length > 0, 'the native remediation baseline must contain original validation claims');
    const actual = resolveAuthoritativeReviewValidationObligations({ ...fixture.args, preflight });
    assert.equal(actual, undefined, 'the failed-test candidate cannot replace the original accepted CODE coverage witness');
    assert.equal(resolveAuthoritativeReviewValidationObligations({ ...fixture.args, preflight, reviewType: 'test' }),
        undefined, 'historical claims alone must not supply current test execution or semantic acceptance');
});

async function assertNativeComposition(t: TestContext, testOnly: boolean, normalDefaults = false) {
        const fixture = await createNativeRecovery(t, testOnly, normalDefaults);
        const authority = { ...fixture, reviewType: 'code' };
        assert.ok(readTestOnlyReviewPreservation(authority), 'native restart must authenticate the test-only preservation domain');
        let claimMeasurement: NextStepMeasurement | undefined;
        const claimed = withNextStepMeasurement(() => readPreservedReviewCoverage(authority), value => { claimMeasurement = value; });
        assert.ok(claimed, 'the original native CODE proof must authenticate coverage: ' + JSON.stringify(Object.fromEntries(
            Object.entries(claimMeasurement?.work ?? {}).filter(([key]) => key.startsWith('preservation_rejected:')))));
        withInvocationReadObservation(() => {
            const first = readPreservedReviewCoverage(authority)!;
            const originalTarget = first.obligations[0].target;
            first.obligations[0].target = 'caller-mutated';
            let repeated!: NextStepMeasurement;
            const second = withNextStepMeasurement(() => readPreservedReviewCoverage({
                repoRoot: fixture.repoRoot, taskId: fixture.taskId, reviewsRoot: fixture.reviewsRoot,
                preflightPath: fixture.preflightPath, reviewType: 'code'
            }), value => { repeated = value; });
            assert.ok(second);
            assert.equal(second.obligations[0].target, originalTarget, 'public callers cannot mutate private original claims');
            assert.equal(repeated.work['derive:accepted-review-claims'] || 0, 0,
                'irrelevant caller fields cannot cause another original-claim reconstruction');
            assert.equal(repeated.work['visit:derivation_json_cloned_object'] || 0, 0,
                'only the requested public coverage projection is copied');
        });
        withInvocationReadObservation(() => {
            let reads = 0;
            readPreservedReviewCoverage({ repoRoot: fixture.repoRoot, taskId: fixture.taskId,
                reviewsRoot: fixture.reviewsRoot, preflightPath: fixture.preflightPath,
                get reviewType() { return ++reads === 1 ? 'code' : 'security'; } });
            const ordinary = readPreservedReviewCoverage(authority);
            assert.ok(ordinary);
            assert.equal(ordinary.review_type, 'code', 'opaque caller fields cannot seed another lane under a canonical memo key');
        });
        const result = await recovery.runBuildReviewContextCommand({ ...fixture, reviewType: 'code', depth: 2 });
        assert.equal(result.reusedReviewEvidence, true, result.outputLines.join('\n'));
        assert.deepEqual(fs.readFileSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-code.md`)), fixture.originalCode);
        const receipt = readJson(path.join(fixture.reviewsRoot, `${fixture.taskId}-code-receipt.json`));
        assert.equal(receipt.reused_from_review_context_sha256, fixture.originalCodeReceipt.review_context_sha256);
        const security = await recovery.runBuildReviewContextCommand({ ...fixture, reviewType: 'security', depth: 2 });
        assert.equal(security.reusedReviewEvidence, true, security.outputLines.join('\n'));
        const historical = readPreservedReviewCoverage(authority)!.obligations.flatMap(item => item.validation_binding ? [item.validation_binding] : []);
        const entries = JSON.parse(fixture.originalCode.toString('utf8')).coverage_ledger.entries;
        const inspect = () => getNativeCaseResolutionViolations({ repoRoot: fixture.repoRoot, reviewType: 'code',
            obligations: historical, entries, requirePassed: true });
        assert.deepEqual(inspect(), [], 'CODE must inspect authenticated original source, record, output and semantics');
        assert.equal(readPreservedReviewCoverage({ ...authority, reviewType: 'test' }), null,
            'TEST cannot use the historical source route, including an empty production domain');
        if (historical.length > 0) {
            assert.ok(getNativeCaseResolutionViolations({ repoRoot: fixture.repoRoot, reviewType: 'test',
                obligations: historical, entries, requirePassed: true }).length > 0,
            'nonempty historical CODE bindings cannot supply current TEST semantics');
        }
        const originalRecord = recovery.readTaskTimelineEvents(fixture.repoRoot, fixture.taskId).find(event =>
            event.event_type === 'REVIEW_RECORDED' && (event.details as Record<string, unknown>)?.accepted_review_claims_path);
        const claimsPath = String((originalRecord!.details as Record<string, unknown>).accepted_review_claims_path);
        const claimsBytes = fs.readFileSync(claimsPath);
        if (testOnly) assert.deepEqual(JSON.parse(claimsBytes.toString('utf8')).non_test_changed_files, [],
            'empty-domain reuse requires the original native publisher to attest the empty file set');
        try {
            fs.appendFileSync(claimsPath, '\n');
            assert.equal(readPreservedReviewCoverage(authority), null, 'tampered original claims must fail closed');
            if (historical.length > 0) assert.ok(inspect().length > 0, 'tampered source proof cannot close old CODE semantics');
        } finally { fs.writeFileSync(claimsPath, claimsBytes); }
        if (historical.length > 0) {
            const outputPath = path.resolve(fixture.repoRoot, historical[0].case_execution!.output_path);
            const outputBytes = fs.readFileSync(outputPath);
            try {
                fs.appendFileSync(outputPath, '\n');
                assert.ok(inspect().length > 0, 'changed retained output must fail despite a valid old receipt');
            } finally { fs.writeFileSync(outputPath, outputBytes); }
        }
        // SOURCE belongs to the mixed task; it is outside the explicitly isolated test-only task.
        if (!testOnly) {
            const sourcePath = path.join(fixture.repoRoot, SOURCE), sourceBytes = fs.readFileSync(sourcePath);
            try {
                fs.appendFileSync(sourcePath, 'export const productionDrift = true;\n');
                assert.equal(readPreservedReviewCoverage(authority), null, 'production drift in the task domain must revoke preservation');
            } finally { fs.writeFileSync(sourcePath, sourceBytes); }
        }
        const current = readJson(path.join(fixture.reviewsRoot, `${fixture.taskId}-quality-checklist.json`));
        assert.equal(current.validation_phases.obligations.length, 2, 'both current cases require fresh independent semantics');
        const freshTest = await recovery.runBuildReviewContextCommand({ ...fixture, reviewType: 'test', depth: 2 });
        assert.ok(fs.existsSync(freshTest.outputPath), 'the native producer must publish the fresh test handoff');
        assert.equal(freshTest.acceptedReviewEvidenceKind, null, 'a generated context cannot accept test semantics');
        assert.equal(freshTest.reusedReviewEvidence, false, 'failed original test review must never be preserved');
        await recordNativeReview(fixture.repoRoot, fixture.taskId, fixture.preflightPath, 'test', true);
        // Ordinary case-ledger activation requires a declared recipe or a production
        // trust boundary. The empty production domain still owes fresh full TEST
        // review of both files; optional observed cases do not invent another lane floor.
        const testContext = readJson(freshTest.outputPath);
        const testReport = readJson(path.join(fixture.reviewsRoot, `${fixture.taskId}-test.md`));
        const testBindings = testContext.coverage_contract.obligations.flatMap(
            (item: { validation_binding?: QualityValidationObligation }) => item.validation_binding ? [item.validation_binding] : []);
        if (testOnly) {
            assert.equal(testBindings.length, 0);
            const testFiles = testContext.coverage_contract.obligations
                .filter((item: { kind: string }) => item.kind === 'file').map((item: { target: string }) => item.target);
            assert.deepEqual(testFiles.sort(), [HELPER, CASE_SOURCE].sort());
        } else {
            assert.equal(testBindings.length, 2);
            const inspectTest = () => getNativeCaseResolutionViolations({ repoRoot: fixture.repoRoot, reviewType: 'test',
                obligations: testBindings, entries: testReport.coverage_ledger.entries, requirePassed: true });
            assert.deepEqual(inspectTest(), []);
            const testOutputPath = path.resolve(fixture.repoRoot, testBindings[0].case_execution!.output_path);
            const testOutput = fs.readFileSync(testOutputPath);
            try {
                fs.appendFileSync(testOutputPath, '\n');
                assert.ok(inspectTest().length > 0, 'changed current TEST output must fail despite a valid receipt');
            } finally { fs.writeFileSync(testOutputPath, testOutput); }
        }
        await completeAuthenticatedHistoryFixture(fixture);
        assert.ok(readPreservedReviewCoverage(authority), 'native completed inspection must retain the same historical claims');
        assert.deepEqual(fs.readFileSync(path.join(fixture.reviewsRoot, `${fixture.taskId}-code.md`)), fixture.originalCode);
}

test('native private fixture and added-case recovery preserves accepted code and requires fresh test review',
    { timeout: 180_000 }, async t => { await assertNativeComposition(t, false); });
test('native initially test-only recovery preserves empty production scope and closes with fresh test semantics',
    { timeout: 180_000 }, async t => { await assertNativeComposition(t, true); });
test('native future defaults preserve accepted production reviews after private helper and added-case fixes',
    { timeout: 180_000 }, async t => { await assertNativeComposition(t, false, true); });
test('native future defaults preserve the empty production domain after private helper and added-case fixes',
    { timeout: 180_000 }, async t => { await assertNativeComposition(t, true, true); });
test('native future defaults require fresh code review when remediation changes production alongside private tests',
    { timeout: 180_000 }, async t => { await createNativeRecovery(t, false, true, 'production'); });
test('native future defaults respect a frozen source-role override on a helper-shaped path',
    { timeout: 180_000 }, async t => { await createNativeRecovery(t, false, true, 'source-role'); });
