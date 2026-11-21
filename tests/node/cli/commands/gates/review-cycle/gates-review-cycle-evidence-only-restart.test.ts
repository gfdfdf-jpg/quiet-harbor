import { runBindRulePackToPreflightCommand, runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import { handleRecordReviewResult, handleRecordReviewOutputCorrectionTransport } from '../../../../../../src/cli/commands/gate-review-handlers';
import { splitCommandLine } from '../../../../../../src/core/command-line';
import { sha256RedactedJsonPayload } from '../../../../../../src/core/redaction';
import {
    bindAuthoritativeRemediationDecisionToPreflight,
    buildAuthenticatedRemediationReviewExecution
} from '../../../../../../src/cli/commands/gate-flows/review-context/review-context-flow';
import { executeNextStepEffects, resolveNextStep } from '../../../../../../src/gates/next-step';
import {
    resolveAuthoritativeReviewRemediationDecision,
    type ReviewRemediationDecisionClassification
} from '../../../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import type { ReviewRemediationAuthoritativeDecisionBinding } from '../../../../../../src/gates/review-remediation/review-remediation-review-contract';
import { buildDefaultReviewRemediationModePolicy } from '../../../../../../src/policy/review-remediation-mode-policy';
import { preserveReviewContextCopy } from '../../../../../../src/gates/review/review-artifact-recovery';
import {
    collectRemediationOriginCandidates,
    resolveRemediationOriginReviewType
} from '../../../../../../src/gates/review-remediation/review-remediation-origin';
import {
    buildReviewOutputCorrectionArtifact,
    getReviewOutputCorrectionArtifactPath,
    persistReviewOutputCorrection,
    type ReviewOutputCorrectionArtifact
} from '../../../../../../src/gates/review/review-output-correction';
import {
    appendTaskEvent,
    assert,
    createTempRepo,
    describe,
    fileSha256,
    fs,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    it,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    path,
    prepareScopedDiffFixture,
    readTaskTimelineEvents,
    runBuildReviewContextCommand,
    runCompletionGate,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runRequiredReviewsCheckCommand,
    runRestartReviewCycleCommand,
    runShellSmokeForTask,
    seedInitAnswers,
    seedRemediationRepoBase,
    seedTaskQueue,
    writeCompilePassEvidence,
    writeReceiptBackedReviewArtifact,
    writeReviewCapabilitiesConfig,
    writeSimpleCompileCommandsFile,
    writeWorkflowConfig
} from './gates-review-cycle-fixtures';

const IMPACT_ANALYSIS = [
    'Reviewer finding: the review report was rejected and its reviewer launch identity was lost.',
    'Intended fix: supersede only the affected reviewer evidence and launch a fresh reviewer.',
    'Affected files and contracts: no source changes; only review evidence is affected.',
    'API/runtime/artifact/test impact: current implementation and validation evidence stay unchanged.',
    'Possible side effects: preserve unrelated passed receipts and repeat what the route names.',
    'Required targeted checks: reuse the preserved reviews and require fresh evidence for the repeated ones.',
    'Scope or review-type changes: no scope changes and no new review types.',
    'Related blocker or follow-up decision: recover this review in the same task.'
].join(' ');

const FIX_IMPACT_ANALYSIS = [
    'Reviewer finding: the shared helper hides a failed assertion.',
    'Intended fix: correct tests/helpers/render.ts.',
    'Affected files and contracts: only this recognized test helper changes, source bytes are identical.',
    'API/runtime/artifact/test impact: stronger test coverage only.',
    'Possible side effects: existing findings receipts need authenticated current-cycle reuse.',
    'Required targeted checks: native restart and strict review order.',
    'Scope or review-type changes: repeat the reviews the helper reaches.',
    'Related blocker or follow-up decision: repair the failed test findings now.'
].join(' ');

const FILES = ['src/total.ts', 'tests/helpers/render.ts'];

function resolveNextStepAfterEffects(taskId: string, repoRoot: string): ReturnType<typeof resolveNextStep> {
    let nextStep = resolveNextStep({ taskId, repoRoot });
    for (let batch = 0; batch < 16 && nextStep.next_gate === 'next-step-effect'; batch += 1) {
        const planSha256 = (nextStep.commands[0]?.command || '').match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';
        assert.match(planSha256, /^[a-f0-9]{64}$/u, nextStep.reason);
        nextStep = executeNextStepEffects({ taskId, repoRoot }, planSha256);
    }
    return nextStep;
}

interface ReadyTask {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    reviewsRoot: string;
    commandsPath: string;
    outputFiltersPath: string;
}

function launchPathFor(task: ReadyTask, lane: string): string {
    return path.join(getOrchestratorRoot(task.repoRoot), 'runtime/tmp/reviews', task.taskId, lane, 'reviewer-launch.json');
}

async function recordReviewerOutput(task: ReadyTask, lane: string): Promise<void> {
    const launch = JSON.parse(fs.readFileSync(launchPathFor(task, lane), 'utf8')) as { review_output_path: string; reviewer_identity: string };
    const outputPath = path.resolve(task.repoRoot, launch.review_output_path);
    fs.copyFileSync(path.join(task.reviewsRoot, `${task.taskId}-${lane}.md`), outputPath);
    await handleRecordReviewResult(['--task-id', task.taskId, '--review-type', lane, '--preflight-path', task.preflightPath,
        '--review-context-path', path.join(task.reviewsRoot, `${task.taskId}-${lane}-review-context.json`),
        '--review-output-path', outputPath, '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', launch.reviewer_identity, '--repo-root', task.repoRoot]);
}

function passedReceiptRetained(result: Awaited<ReturnType<typeof runBuildReviewContextCommand>>): boolean {
    return result.reusedReviewEvidence === true || result.outputLines.includes('CurrentPassReviewEvidence: True');
}

async function buildContext(task: ReadyTask, lane: string): ReturnType<typeof runBuildReviewContextCommand> {
    prepareScopedDiffFixture(task.repoRoot, task.preflightPath, lane);
    return runBuildReviewContextCommand({ repoRoot: task.repoRoot, reviewType: lane, depth: 3, preflightPath: task.preflightPath,
        outputPath: path.join(task.reviewsRoot, `${task.taskId}-${lane}-review-context.json`) });
}

interface RestartCycleAuthority {
    authoritative_review_decision: ReviewRemediationAuthoritativeDecisionBinding;
    authoritative_review_classification: ReviewRemediationDecisionClassification;
}

function readCycleAuthority(task: ReadyTask): RestartCycleAuthority {
    return JSON.parse(fs.readFileSync(path.join(task.reviewsRoot, `${task.taskId}-review-remediation-cycle.json`), 'utf8')) as RestartCycleAuthority;
}

interface ReviewOutcome {
    /** The restart decision the review runs under; the newest one by default. */
    cycle?: RestartCycleAuthority;
    failure?: { finding: string; file: string };
}

/** A delegated review launched under a restart decision, with the routing a real launch records. */
function writeRestartBoundReview(task: ReadyTask, lane: string, outcome: ReviewOutcome = {}): void {
    const cyclePath = path.join(task.reviewsRoot, `${task.taskId}-review-remediation-cycle.json`);
    const verdict = `${lane.toUpperCase()} REVIEW ${outcome.failure ? 'FAILED' : 'PASSED'}`;
    const findings = outcome.failure ? [outcome.failure.finding] : undefined;
    const failureOptions = outcome.failure ? { findingSeverity: 'high' as const, findingEvidenceFile: outcome.failure.file } : {};
    if (!outcome.cycle && !fs.existsSync(cyclePath)) {
        writeReceiptBackedReviewArtifact(task.repoRoot, task.taskId, lane, verdict, findings,
            { authenticatedNavigatorLaunch: true, skipReceipt: true, caseResolutions: {}, ...failureOptions });
        return;
    }
    const cycle = outcome.cycle ?? readCycleAuthority(task);
    const execution = buildAuthenticatedRemediationReviewExecution({ taskId: task.taskId, reviewType: lane,
        preflightSha256: fileSha256(task.preflightPath)!,
        fullReviewScope: (JSON.parse(fs.readFileSync(task.preflightPath, 'utf8')) as { changed_files: string[] }).changed_files,
        authoritativeDecision: cycle.authoritative_review_decision,
        authoritativeClassification: cycle.authoritative_review_classification,
        persistedDecisionSha256: cycle.authoritative_review_decision.decision_sha256 });
    writeReceiptBackedReviewArtifact(task.repoRoot, task.taskId, lane, verdict, findings,
        { authenticatedNavigatorLaunch: true, skipReceipt: true, caseResolutions: {}, ...failureOptions,
            reviewExecutionContract: execution.contract, reviewExecutionValidationAuthority: execution.validationAuthority });
}

async function passFreshReview(task: ReadyTask, lane: string, outcome: ReviewOutcome = {}): Promise<void> {
    writeRestartBoundReview(task, lane, outcome);
    await recordReviewerOutput(task, lane);
}

function contextMode(task: ReadyTask, lane: string): { mode: string; decision: string } {
    const context = JSON.parse(fs.readFileSync(path.join(task.reviewsRoot, `${task.taskId}-${lane}-review-context.json`), 'utf8')) as {
        review_execution?: { mode?: string; authoritative_decision_sha256?: string };
    };
    return { mode: String(context.review_execution?.mode), decision: String(context.review_execution?.authoritative_decision_sha256) };
}

interface SeedTaskOptions {
    dependencies?: Record<string, string[]>;
    /** Classify from Git instead of an explicit file list. */
    gitAuto?: boolean;
    /** Task files besides FILES in the explicit preflight, such as TASK.md or an authorized Git-ignored file. */
    extraFiles?: string[];
    gitIgnored?: string;
    /** A profile with the remediation mode policy, so a restart can choose DELTA; without it every lane runs FULL. */
    modePolicy?: boolean;
    /** Align the queued title and entered task summary when running the exact command next-step offers. */
    matchingTaskTitle?: boolean;
    setupBeforePreflight?: (repoRoot: string, taskId: string) => void;
}

async function seedTask(taskId: string, options: SeedTaskOptions = {}): Promise<ReadyTask> {
    const repoRoot = createTempRepo();
    seedRemediationRepoBase(repoRoot);
    writeReviewCapabilitiesConfig(repoRoot);
    const configRoot = path.join(getOrchestratorRoot(repoRoot), 'live/config');
    const pathsPath = path.join(configRoot, 'paths.json');
    const paths = JSON.parse(fs.readFileSync(pathsPath, 'utf8')) as { triggers: Record<string, string[]> };
    paths.triggers.security = ['^src/security/'];
    fs.writeFileSync(pathsPath, JSON.stringify(paths) + '\n');
    if (options.dependencies || options.modePolicy) {
        const profilesPath = path.join(configRoot, 'profiles.json');
        const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
            built_in_profiles: Record<string, Record<string, unknown>>;
        };
        if (options.dependencies) {
            profiles.built_in_profiles.balanced.review_dependency_graph = {
                preparation_order: ['code', 'db', 'api', 'security', 'refactor', 'test', 'performance', 'dependency'],
                dependencies: options.dependencies
            };
        }
        if (options.modePolicy) {
            profiles.built_in_profiles.balanced.review_remediation_mode_policy = buildDefaultReviewRemediationModePolicy();
        }
        fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2) + '\n');
    }
    const workflowPath = writeWorkflowConfig(repoRoot, 'strict_sequential');
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8')) as Record<string, unknown>;
    workflow.optional_quality_checks = { enabled: false };
    fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2) + '\n');
    const { commandsPath, outputFiltersPath } = writeSimpleCompileCommandsFile(repoRoot, 'evidence-only-restart');
    if (options.gitIgnored) {
        fs.appendFileSync(path.join(repoRoot, '.gitignore'), `${options.gitIgnored}\n`);
    }
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, taskId, 'TODO', 'balanced');
    const queuePath = path.join(repoRoot, 'TASK.md');
    const queue = fs.readFileSync(queuePath, 'utf8').replace('| fixture |', '| Required reviews: code, security, refactor, test. |');
    fs.writeFileSync(queuePath, options.matchingTaskTitle ? queue.replace('Update app flow', 'Update the displayed total') : queue);
    seedInitAnswers(repoRoot, 'Codex');
    runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Update the displayed total' });
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    for (const file of FILES) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, file), '// original task content\n');
    }
    for (const file of options.extraFiles ?? []) {
        fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
        fs.appendFileSync(path.join(repoRoot, file), '\n');
    }
    options.setupBeforePreflight?.(repoRoot, taskId);
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (options.gitAuto) {
        runClassifyChangeCommand({ repoRoot, taskId, taskIntent: 'Update the displayed total', outputPath: preflightPath, emitMetrics: false });
    } else {
        runExplicitPreflight(repoRoot, taskId, 'Update the displayed total', [...FILES, ...(options.extraFiles ?? [])]);
    }
    loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    writeCompilePassEvidence(repoRoot, taskId, preflightPath);
    if (options.gitIgnored) {
        // The compile fixture touches every file Git reports as clean, so classify the ignored file's final bytes.
        runExplicitPreflight(repoRoot, taskId, 'Update the displayed total', [...FILES, ...(options.extraFiles ?? [])]);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compilePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const preflightSha256 = fileSha256(preflightPath);
        fs.writeFileSync(compilePath, JSON.stringify({
            ...JSON.parse(fs.readFileSync(compilePath, 'utf8')) as Record<string, unknown>,
            preflight_hash_sha256: preflightSha256
        }, null, 2));
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Compile gate passed.', {
            preflight_path: preflightPath.replace(/\\/g, '/'), preflight_hash_sha256: preflightSha256
        });
    }
    return { repoRoot, taskId, preflightPath, reviewsRoot: getReviewsRoot(repoRoot), commandsPath, outputFiltersPath };
}

/** Everything but test passed, test failed, and a shared test helper fix reopened security, refactor and test. */
async function restartAfterSharedHelperFix(task: ReadyTask, preserveCodeContext = false): Promise<void> {
    const { repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath } = task;
    for (const lane of ['code', 'security', 'refactor']) {
        await passFreshReview(task, lane);
        if (preserveCodeContext && lane === 'code') {
            // The native routing gate retains these bytes; this fixture writes routing telemetry directly.
            const contextPath = path.join(task.reviewsRoot, `${taskId}-code-review-context.json`);
            preserveReviewContextCopy({ repoRoot, taskId, reviewType: 'code', contextPath }, fs.readFileSync(contextPath, 'utf8'));
        }
    }
    writeReceiptBackedReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW FAILED',
        ['The helper in tests/helpers/render.ts:1 hides a failed assertion.'],
        { authenticatedNavigatorLaunch: true, skipReceipt: true, findingSeverity: 'high', findingEvidenceFile: FILES[1], caseResolutions: {} });
    await recordReviewerOutput(task, 'test');
    fs.appendFileSync(path.join(repoRoot, FILES[1]), '// the helper checks the session token now\n');
    const restarted = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
        changedFiles: FILES, reviewType: 'test', emitMetrics: false, impactAnalysis: FIX_IMPACT_ANALYSIS });
    assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
    const refreshed = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as {
        effective_review_snapshot: { inputs: { task_intent: string } };
    };
    assert.equal(refreshed.effective_review_snapshot.inputs.task_intent, 'Update the displayed total',
        'the restart keeps the classified intent even when the TASK.md title differs');
}

async function rejectReport(task: ReadyTask, lane: string): Promise<{
    contextPath: string; artifactPath: string; rejectedOutput: string;
    launch: { reviewer_identity: string; provider_invocation_id: string };
}> {
    const { repoRoot, taskId, preflightPath, reviewsRoot } = task;
    writeRestartBoundReview(task, lane);
    const contextPath = path.join(reviewsRoot, `${taskId}-${lane}-review-context.json`);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${lane}.md`);
    const launch = JSON.parse(fs.readFileSync(launchPathFor(task, lane), 'utf8')) as {
        review_output_path: string; reviewer_identity: string; launch_completed_at_utc: string; provider_invocation_id: string;
    };
    const outputPath = path.resolve(repoRoot, launch.review_output_path);
    const rejectedOutput = JSON.stringify({ ...JSON.parse(fs.readFileSync(artifactPath, 'utf8')), unexpected: true });
    fs.writeFileSync(outputPath, rejectedOutput);
    const completedAt = new Date(launch.launch_completed_at_utc);
    fs.utimesSync(outputPath, completedAt, completedAt);
    await assert.rejects(() => handleRecordReviewResult(['--task-id', taskId, '--review-type', lane,
        '--preflight-path', preflightPath, '--review-context-path', contextPath, '--review-output-path', outputPath,
        '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', launch.reviewer_identity,
        '--repo-root', repoRoot]), /unknown field 'unexpected'/u);
    return { contextPath, artifactPath, rejectedOutput, launch };
}

/** A rejected report whose correction package waits for transport selection, then a lost reviewer launch. */
async function rejectReportAndLoseIdentity(task: ReadyTask, lane: string, options: { recorded?: boolean } = {}): Promise<void> {
    const { repoRoot, taskId } = task;
    const { contextPath, artifactPath, rejectedOutput, launch } = await rejectReport(task, lane);
    const rejected = JSON.parse(fs.readFileSync(getReviewOutputCorrectionArtifactPath(artifactPath), 'utf8')) as ReviewOutputCorrectionArtifact;
    const pending = buildReviewOutputCorrectionArtifact({
        taskId, reviewType: lane, rejectedOutputPath: rejected.binding.original_output_path,
        rejectedOutputSha256: rejected.binding.original_output_sha256,
        reviewContextPath: contextPath, reviewContextSha256: fileSha256(contextPath)!,
        reviewTreeStateSha256: rejected.binding.review_tree_state_sha256,
        reviewerIdentity: launch.reviewer_identity, reviewerAttemptId: rejected.binding.reviewer_attempt_id,
        reviewerInvocationEventSha256: rejected.binding.reviewer_invocation_event_sha256,
        validationArtifactPath: rejected.binding.validation_artifact_path,
        validationArtifactSha256: rejected.binding.validation_artifact_sha256,
        violations: ["report contains unknown field 'unexpected'"],
        capabilities: { live_reviewer_continuation: true, correction_only_invocation: true },
        providerId: 'Codex', providerInvocationId: launch.provider_invocation_id, sessionAvailability: 'pending'
    });
    const persisted = persistReviewOutputCorrection({ repoRoot, reviewArtifactPath: artifactPath, rawOutput: rejectedOutput, artifact: pending });
    if (options.recorded !== false) {
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_OUTPUT_CORRECTION_REQUIRED', 'INFO',
            'Persisted pre-transport correction recovery fixture.', { task_id: taskId, review_type: lane,
                correction_artifact_path: persisted.artifactPath, correction_package_sha256: fileSha256(persisted.artifactPath) },
            { actor: 'orchestrator' });
    }
    fs.unlinkSync(launchPathFor(task, lane));
}

/** The rule-pack binding covers the bytes of preflight files, so a changed TASK.md in the scope asks for a rebind first. */
function rebindRulePackIfOffered(task: ReadyTask): void {
    if (resolveNextStepAfterEffects(task.taskId, task.repoRoot).next_gate === 'bind-rule-pack-to-preflight') {
        const bound = runBindRulePackToPreflightCommand({ repoRoot: task.repoRoot, taskId: task.taskId, preflightPath: task.preflightPath });
        assert.equal(bound.exitCode ?? 0, 0, bound.outputLines?.join('\n'));
    }
}

async function runOfferedRestart(task: ReadyTask, command: string): Promise<void> {
    const argv = splitCommandLine(command);
    const changedFiles = argv.flatMap((entry, index) => entry === '--changed-file' ? [argv[index + 1]] : []);
    const restarted = await runRestartReviewCycleCommand({
        repoRoot: task.repoRoot, taskId: task.taskId, preflightPath: task.preflightPath,
        commandsPath: task.commandsPath, outputFiltersPath: task.outputFiltersPath, emitMetrics: false,
        taskIntent: argv[argv.indexOf('--task-intent') + 1], reviewType: argv[argv.indexOf('--review-type') + 1],
        reviewEvidenceOnly: argv.includes('--review-evidence-only'),
        impactAnalysis: `${IMPACT_ANALYSIS} Scope kept unchanged: ${changedFiles.join(', ')}.`,
        ...(changedFiles.length > 0 ? { changedFiles } : {})
    });
    assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
}

interface RemediationCycle {
    authoritative_review_decision: { invalidated_review_types: string[]; preserved_review_types: string[];
        lane_decisions: Array<{ review_type: string; reuse_eligible: boolean; invalidated: boolean }> };
    review_reuse: { pending_reason: string | null };
}

function readCycle(task: ReadyTask): RemediationCycle {
    return JSON.parse(fs.readFileSync(path.join(task.reviewsRoot, `${task.taskId}-review-remediation-cycle.json`), 'utf8')) as RemediationCycle;
}

function restartCount(task: ReadyTask): number {
    return readTaskTimelineEvents(task.repoRoot, task.taskId).filter(event => event.event_type === 'REVIEW_CYCLE_RESTARTED').length;
}

function reviewGate(task: ReadyTask): ReturnType<typeof runRequiredReviewsCheckCommand> {
    return runRequiredReviewsCheckCommand({ repoRoot: task.repoRoot, taskId: task.taskId, preflightPath: task.preflightPath,
        codeReviewVerdict: 'REVIEW PASSED', securityReviewVerdict: 'SECURITY REVIEW PASSED',
        refactorReviewVerdict: 'REFACTOR REVIEW PASSED', testReviewVerdict: 'TEST REVIEW PASSED',
        reviewAuthorshipAttestationJson: JSON.stringify({ code: true, security: true, refactor: true, test: true }),
        outputFiltersPath: task.outputFiltersPath, emitMetrics: false });
}

const assertEvidenceOnlyRoute = (route: ReturnType<typeof resolveNextStep>, lane: string): void => {
    assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
    assert.match(route.commands[0].command, new RegExp(`--review-type "${lane}".*--review-evidence-only`, 'u'), route.reason);
};

describe('cli/commands/gates – evidence-only review restart', () => {
    const carriedGraphs: Array<[string, Record<string, string[]> | undefined]> = [
        ['without a declared graph', undefined],
        ['with a declared graph', { security: ['code'], refactor: ['code'], test: ['code'] }]
    ];
    for (const [label, dependencies] of carriedGraphs) {
        it(`keeps refactor and test invalidated after a shared helper fix ${label}`, { concurrency: false }, async () => {
            const task = await seedTask(`T-950-carried-${dependencies ? 'graph' : 'plain'}`, { dependencies });
            try {
                await restartAfterSharedHelperFix(task);
                const reopening = readCycleAuthority(task);
                assert.deepEqual(readCycle(task).authoritative_review_decision.invalidated_review_types, ['security', 'refactor', 'test']);
                assert.equal((await buildContext(task, 'code')).reusedReviewEvidence, true);
                await buildContext(task, 'security');
                await rejectReportAndLoseIdentity(task, 'security');

                const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
                assertEvidenceOnlyRoute(route, 'security');
                assert.match(route.reason, /repeats 'security' and the reviews an earlier restart invalidated that have not passed since \('refactor', 'test', in the mode that restart chose\)/u);
                assert.match(route.reason, /preserving passed receipts for other reviews through reuse/u);

                await runOfferedRestart(task, route.commands[0].command);
                const cycle = readCycle(task);
                const decision = cycle.authoritative_review_decision;
                assert.deepEqual(decision.invalidated_review_types, ['security', 'refactor', 'test']);
                assert.deepEqual(decision.preserved_review_types, ['code']);
                assert.equal(decision.lane_decisions.find(lane => lane.review_type === 'refactor')?.reuse_eligible, false);
                assert.match(cycle.review_reuse.pending_reason || '', /'security' and the reviews an earlier restart invalidated .*'refactor', 'test'/u);

                assert.equal(passedReceiptRetained(await buildContext(task, 'code')), true);
                await buildContext(task, 'security');
                await passFreshReview(task, 'security');
                const refactor = await buildContext(task, 'refactor');
                assert.equal(refactor.reusedReviewEvidence, false, refactor.outputLines.join('\n'));
                assert.equal(refactor.acceptedReviewEvidenceKind ?? null, null, refactor.outputLines.join('\n'));

                const earlyGate = reviewGate(task);
                assert.notEqual(earlyGate.exitCode, 0, 'the old refactor PASS must not satisfy the review gate');
                assert.match(earlyGate.outputLines.join('\n'), /refactor/iu);
                assert.equal(runCompletionGate({ repoRoot: task.repoRoot, preflightPath: task.preflightPath, taskId: task.taskId }).outcome, 'FAIL');

                // A carried review repeats under the restart that reopened it.
                await passFreshReview(task, 'refactor', { cycle: reopening });
                await buildContext(task, 'test');
                await passFreshReview(task, 'test', { cycle: reopening });
                const gate = reviewGate(task);
                assert.equal(gate.exitCode, 0, gate.outputLines.join('\n'));
            } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
        });
    }


    for (const [label, modePolicy] of [['in FULL', false], ['in DELTA', true]] as const) {
        it(`keeps reviews that passed ${label} under an earlier restart and repeats only the lost one`, { concurrency: false }, async () => {
            const task = await seedTask(`T-951-passed-since-${modePolicy ? 'delta' : 'full'}`, { modePolicy });
            try {
                await restartAfterSharedHelperFix(task);
                await buildContext(task, 'code');
                for (const lane of ['security', 'refactor']) {
                    await buildContext(task, lane);
                    assert.equal(contextMode(task, lane).mode, modePolicy ? 'DELTA' : 'FULL');
                    await passFreshReview(task, lane);
                }
                await buildContext(task, 'test');
                await rejectReportAndLoseIdentity(task, 'test');

                const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
                assertEvidenceOnlyRoute(route, 'test');
                assert.match(route.reason, /repeats only 'test', preserving passed receipts/u);
                assert.match(route.commands[0].command, /--task-intent ["']Update the displayed total["']/u);
                await runOfferedRestart(task, route.commands[0].command);

                const cycle = readCycle(task);
                assert.deepEqual(cycle.authoritative_review_decision.invalidated_review_types, ['test']);
                assert.equal(cycle.review_reuse.pending_reason, "failed delegated reviewer evidence repeats only 'test'");
                // The route promised that only 'test' repeats: every review that passed keeps its result.
                for (const lane of ['code', 'security', 'refactor']) {
                    const kept = await buildContext(task, lane);
                    assert.equal(passedReceiptRetained(kept), true, kept.outputLines.join('\n'));
                }
                await buildContext(task, 'test');
                await passFreshReview(task, 'test');
                const gate = reviewGate(task);
                assert.equal(gate.exitCode, 0, gate.outputLines.join('\n'));
            } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
        });
    }

    it('does not let an ordinary restart release a review an earlier restart reopened', { concurrency: false }, async () => {
        const task = await seedTask('T-954-ordinary-carry');
        const { repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath } = task;
        try {
            await restartAfterSharedHelperFix(task);
            await buildContext(task, 'code');
            await buildContext(task, 'security');
            await passFreshReview(task, 'security', {
                failure: { finding: 'The session check in src/total.ts:1 accepts an expired token.', file: FILES[0] }
            });
            const newTest = 'tests/total-session.test.ts';
            fs.writeFileSync(path.join(repoRoot, newTest), '// covers the expired session token\n');
            const restarted = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
                changedFiles: [...FILES, newTest], reviewType: 'security', emitMetrics: false,
                impactAnalysis: `${FIX_IMPACT_ANALYSIS} The security fix adds the leaf test ${newTest}.` });
            assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
            // The new test file alone reaches only security and test, but refactor has not passed since the first restart.
            assert.deepEqual(readCycle(task).authoritative_review_decision.invalidated_review_types, ['security', 'refactor', 'test']);

            await buildContext(task, 'code');
            await buildContext(task, 'security');
            await passFreshReview(task, 'security');
            const refactor = await buildContext(task, 'refactor');
            assert.equal(passedReceiptRetained(refactor), false, refactor.outputLines.join('\n'));
            const earlyGate = reviewGate(task);
            assert.notEqual(earlyGate.exitCode, 0, 'the refactor PASS from before the first restart must not satisfy the gate');
            assert.match(earlyGate.outputLines.join('\n'), /refactor/iu);
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('repeats a carried review in the mode the restart that reopened it chose', { concurrency: false }, async () => {
        const task = await seedTask('T-955-carried-delta', { modePolicy: true });
        try {
            await restartAfterSharedHelperFix(task);
            const reopening = readCycleAuthority(task);
            assert.equal(reopening.authoritative_review_decision.lane_decisions.find((lane) => lane.review_type === 'refactor')?.mode, 'DELTA');
            await buildContext(task, 'code');
            await buildContext(task, 'security');
            await rejectReportAndLoseIdentity(task, 'security');

            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assertEvidenceOnlyRoute(route, 'security');
            await runOfferedRestart(task, route.commands[0].command);
            const decision = readCycle(task).authoritative_review_decision as unknown as {
                invalidated_review_types: string[]; lane_decisions: Array<{ review_type: string; reason_code: string }>;
            };
            assert.deepEqual(decision.invalidated_review_types, ['security', 'refactor', 'test']);
            assert.deepEqual(decision.lane_decisions.filter((lane) => lane.reason_code === 'evidence_only_carried_lane')
                .map((lane) => lane.review_type), ['refactor', 'test']);

            await buildContext(task, 'code');
            await buildContext(task, 'security');
            assert.equal(contextMode(task, 'security').mode, 'FULL');
            await passFreshReview(task, 'security');
            for (const lane of ['refactor', 'test']) {
                await buildContext(task, lane);
                assert.deepEqual(contextMode(task, lane), {
                    mode: 'DELTA', decision: reopening.authoritative_review_decision.decision_sha256
                });
                await passFreshReview(task, lane, { cycle: reopening });
            }
            const gate = reviewGate(task);
            assert.equal(gate.exitCode, 0, gate.outputLines.join('\n'));
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('does not reuse a lane a restart recorded before lanes were carried forward released', { concurrency: false }, async () => {
        const task = await seedTask('T-952-recorded-release');
        try {
            await restartAfterSharedHelperFix(task);
            await buildContext(task, 'code');
            const classification = { source: 'runtime_fix' as const, classification: {
                category: 'review_evidence_only', reason: 'delegated reviewer evidence failed for security',
                blocked_before_reuse: false, invalidated_review_types: ['security']
            } };
            const preflightSha256 = fileSha256(task.preflightPath)!;
            const preflight = JSON.parse(fs.readFileSync(task.preflightPath, 'utf8')) as { required_reviews: Record<string, boolean> };
            const decision = bindAuthoritativeRemediationDecisionToPreflight(resolveAuthoritativeReviewRemediationDecision({
                taskId: task.taskId, currentReviewType: 'security', classification,
                requiredReviews: preflight.required_reviews, reviewExecutionPolicyMode: 'strict_sequential'
            }), preflightSha256);
            const compilePath = path.join(task.reviewsRoot, `${task.taskId}-compile-gate.json`);
            appendTaskEvent(getOrchestratorRoot(task.repoRoot), task.taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Restart of an older version.', {
                task_id: task.taskId, event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', preflight_sha256: preflightSha256,
                compile_evidence_path: compilePath, compile_evidence_sha256: fileSha256(compilePath),
                invalidated_review_types: ['security'], preserved_review_types: decision.preserved_review_types,
                authoritative_review_decision: decision, authoritative_review_classification: classification
            }, { actor: 'orchestrator' });
            fs.writeFileSync(path.join(task.reviewsRoot, `${task.taskId}-review-remediation-cycle.json`), JSON.stringify({
                authoritative_review_decision: decision, authoritative_review_classification: classification
            }));
            await buildContext(task, 'code');
            await buildContext(task, 'security');
            await passFreshReview(task, 'security');
            const refactor = await buildContext(task, 'refactor');
            assert.equal(refactor.reusedReviewEvidence, false, refactor.outputLines.join('\n'));
            assert.match(refactor.outputLines.join('\n'), /earlier restart invalidated 'refactor' and it has not passed since/u);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('measures a restart without --review-type against the failed review, as next-step does', { concurrency: false }, async () => {
        const task = await seedTask('T-956-no-review-type', { modePolicy: true });
        const { repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath } = task;
        try {
            for (const lane of ['code', 'security', 'refactor']) {
                await passFreshReview(task, lane);
            }
            await passFreshReview(task, 'test', {
                failure: { finding: 'The helper in tests/helpers/render.ts:1 hides a failed assertion.', file: FILES[1] }
            });
            assert.equal(resolveRemediationOriginReviewType({ repoRoot, taskId, requiredReviewTypes: ['code', 'security', 'refactor', 'test'] }), 'test');
            fs.appendFileSync(path.join(repoRoot, FILES[1]), '// the helper checks the session token now\n');
            // The published form of the command: no --review-type.
            const restarted = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
                changedFiles: FILES, emitMetrics: false, impactAnalysis: FIX_IMPACT_ANALYSIS });
            assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
            const decision = readCycleAuthority(task).authoritative_review_decision;
            assert.equal(decision.classification_source, 'delta');
            assert.equal(decision.current_review_type, 'test');
            assert.deepEqual(decision.preserved_review_types, ['code'], 'a small helper fix does not repeat the code review');
            assert.ok(decision.lane_decisions.some((lane) => lane.mode === 'DELTA'), JSON.stringify(decision.lane_decisions));
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('anchors a change only on a review whose latest record binds its baseline, newest first', { concurrency: false }, async () => {
        const task = await seedTask('T-957-origin-baseline', { modePolicy: true });
        const { repoRoot, taskId, reviewsRoot } = task;
        try {
            await restartAfterSharedHelperFix(task);
            await buildContext(task, 'code');
            for (const lane of ['security', 'refactor', 'test']) {
                await buildContext(task, lane);
                await passFreshReview(task, lane);
            }
            const required = ['code', 'security', 'refactor', 'test'];
            const bound = new Map(readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_RECORDED')
                .map((event) => {
                    const details = (event.details ?? {}) as { review_type?: string; remediation_baseline_snapshot_path?: string };
                    return [String(details.review_type), Boolean(details.remediation_baseline_snapshot_path)];
                }));
            // The reused code review binds no baseline of its own: it keeps the baseline of the review it reused, the
            // oldest record here. A baseline file another attempt left beside it plays no part in that.
            assert.equal(bound.get('code'), false);
            fs.copyFileSync(path.join(reviewsRoot, `${taskId}-test-remediation-baseline.json`),
                path.join(reviewsRoot, `${taskId}-code-remediation-baseline.json`));
            const candidates = collectRemediationOriginCandidates({ repoRoot, taskId, requiredReviewTypes: required });
            const expected = [...['test', 'refactor', 'security'].filter((lane) => bound.get(lane)), 'code'];
            assert.ok(expected.length > 1, 'the passed reviews bind their baselines');
            assert.deepEqual(candidates.map((candidate) => candidate.reviewType), expected);
            assert.ok(candidates.every((candidate) => !candidate.failed));
            assert.deepEqual(collectRemediationOriginCandidates({ repoRoot, taskId, requiredReviewTypes: [...required].reverse() }), candidates,
                'the choice does not depend on the order of the review list');
            assert.equal(resolveRemediationOriginReviewType({ repoRoot, taskId, requiredReviewTypes: required }), expected[0]);
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    for (const [label, changedFile] of [
        ['TypeScript integration', 'src/integration/setup/stripe.ts'],
        ['Java integration', 'src/main/java/com/acme/integration/support/MessageRouter.java'],
        ['Ruby integration', 'app/integration/helpers/slack.rb'],
        ['source e2e', 'src/e2e/setup/client.ts']
    ] as const) {
        it(`reopens code in DELTA for a production helper in ${label}`, { concurrency: false }, async () => {
            const task = await seedTask(`T-961-${label.replace(/ /gu, '-')}`, {
                modePolicy: true, matchingTaskTitle: true, extraFiles: [changedFile]
            });
            try {
                for (const lane of ['code', 'security', 'refactor']) await passFreshReview(task, lane);
                await passFreshReview(task, 'test', {
                    failure: { finding: `The integration helper in ${changedFile}:1 produces an incorrect value.`, file: changedFile }
                });
                fs.appendFileSync(path.join(task.repoRoot, changedFile), '// correct the production value\n');
                rebindRulePackIfOffered(task);
                const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
                assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
                await runOfferedRestart(task, route.commands[0].command);
                const cycle = readCycleAuthority(task);
                const code = cycle.authoritative_review_decision.lane_decisions.find((lane) => lane.review_type === 'code');
                assert.equal(code?.mode, 'DELTA', JSON.stringify(cycle.authoritative_review_decision.lane_decisions));
                assert.equal(code?.reuse_eligible, false);
                assert.equal(cycle.authoritative_review_decision.lane_decisions.find((lane) => lane.review_type === 'test')?.mode, 'DELTA');
                assert.equal(cycle.authoritative_review_classification.source, 'delta');
                if (cycle.authoritative_review_classification.source === 'delta') {
                    assert.equal(cycle.authoritative_review_classification.delta.file_deltas.find((entry) => entry.path === changedFile)?.category,
                        'production');
                }
                await buildContext(task, 'code');
                assert.equal(contextMode(task, 'code').mode, 'DELTA');
                const context = JSON.parse(fs.readFileSync(path.join(task.reviewsRoot, `${task.taskId}-code-review-context.json`), 'utf8')) as {
                    review_execution: { delta: { required_delta_targets: string[] } };
                };
                assert.ok(context.review_execution.delta.required_delta_targets.includes(changedFile));
            } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
        });
    }

    it('requires FULL when criteria changed and the failed review context was deleted', { concurrency: false }, async () => {
        const task = await seedTask('T-criteria-lost-context', { modePolicy: true, matchingTaskTitle: true });
        try {
            await passFreshReview(task, 'code', {
                failure: { finding: 'The total in src/total.ts:1 rounds incorrectly.', file: FILES[0] }
            });
            const contextPath = path.join(task.reviewsRoot, `${task.taskId}-code-review-context.json`);
            preserveReviewContextCopy({ repoRoot: task.repoRoot, taskId: task.taskId, reviewType: 'code', contextPath },
                fs.readFileSync(contextPath, 'utf8'));
            fs.appendFileSync(path.join(task.repoRoot, FILES[0]), '// correct rounding\n');
            const queue = path.join(task.repoRoot, 'TASK.md');
            fs.writeFileSync(queue, fs.readFileSync(queue, 'utf8').replace(
                'Required reviews: code, security, refactor, test.',
                'Required reviews: code, security, refactor, test. Reject negative totals as well.'));
            fs.unlinkSync(contextPath);
            const restarted = await runRestartReviewCycleCommand({ repoRoot: task.repoRoot, taskId: task.taskId,
                preflightPath: task.preflightPath, commandsPath: task.commandsPath, outputFiltersPath: task.outputFiltersPath,
                changedFiles: FILES, reviewType: 'code', emitMetrics: false, impactAnalysis: FIX_IMPACT_ANALYSIS });
            assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
            const cycle = readCycleAuthority(task);
            assert.equal(cycle.authoritative_review_classification.source, 'delta');
            if (cycle.authoritative_review_classification.source === 'delta') {
                assert.equal(cycle.authoritative_review_classification.delta.mode_policy_assessment?.mode, 'FULL');
            }
            assert.ok(cycle.authoritative_review_decision.lane_decisions.every(lane => lane.invalidated && lane.mode === 'FULL'));
            await buildContext(task, 'code');
            assert.equal(contextMode(task, 'code').mode, 'FULL');
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('uses a signed context copy to retain DELTA when the lost context criteria are unchanged', { concurrency: false }, async () => {
        const task = await seedTask('T-criteria-unchanged-copy', { modePolicy: true, matchingTaskTitle: true });
        try {
            await passFreshReview(task, 'code', {
                failure: { finding: 'The total in src/total.ts:1 rounds incorrectly.', file: FILES[0] }
            });
            const contextPath = path.join(task.reviewsRoot, `${task.taskId}-code-review-context.json`);
            preserveReviewContextCopy({ repoRoot: task.repoRoot, taskId: task.taskId, reviewType: 'code', contextPath },
                fs.readFileSync(contextPath, 'utf8'));
            fs.appendFileSync(path.join(task.repoRoot, FILES[0]), '// correct rounding\n');
            fs.unlinkSync(contextPath);
            const restarted = await runRestartReviewCycleCommand({ repoRoot: task.repoRoot, taskId: task.taskId,
                preflightPath: task.preflightPath, commandsPath: task.commandsPath, outputFiltersPath: task.outputFiltersPath,
                changedFiles: FILES, reviewType: 'code', emitMetrics: false, impactAnalysis: FIX_IMPACT_ANALYSIS });
            assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
            const cycle = readCycleAuthority(task);
            assert.equal(cycle.authoritative_review_classification.source, 'delta');
            if (cycle.authoritative_review_classification.source === 'delta') {
                assert.equal(cycle.authoritative_review_classification.delta.mode_policy_assessment?.mode, 'DELTA');
            }
            await buildContext(task, 'code');
            assert.equal(contextMode(task, 'code').mode, 'DELTA');
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    for (const edit of ['linked card', 'linked card only', 'ordinary document', 'no document'] as const) {
        it(`applies task-criteria FULL rules when the fix edits ${edit}`, { concurrency: false }, async () => {
            const card = 'docs/tasks/card.md';
            const ordinary = 'docs/guide.md';
            const task = await seedTask(`T-962-${edit.replace(/ /gu, '-')}`, {
                modePolicy: true, matchingTaskTitle: true, extraFiles: [card, ordinary],
                setupBeforePreflight: (repoRoot, taskId) => {
                    const queuePath = path.join(repoRoot, 'TASK.md');
                    fs.writeFileSync(queuePath, fs.readFileSync(queuePath, 'utf8')
                        .replace('Required reviews: code, security, refactor, test.',
                            `Required reviews: code, security, refactor, test. [${taskId}](${card}#${taskId.toLowerCase()})`));
                    fs.writeFileSync(path.join(repoRoot, card), `# ${taskId}\n\n## Acceptance criteria\n- Round totals down.\n`);
                    fs.writeFileSync(path.join(repoRoot, ordinary), '# Guide\n');
                }
            });
            try {
                await passFreshReview(task, 'code', {
                    failure: { finding: 'The total in src/total.ts:1 rounds incorrectly.', file: FILES[0] }
                });
                if (edit !== 'linked card only') fs.appendFileSync(path.join(task.repoRoot, FILES[0]), '// correct rounding\n');
                if (edit === 'linked card' || edit === 'linked card only') {
                    fs.writeFileSync(path.join(task.repoRoot, card), `# ${task.taskId}\n\n## Acceptance criteria\n- Round totals up.\n`);
                } else if (edit === 'ordinary document') fs.appendFileSync(path.join(task.repoRoot, ordinary), 'Updated guide.\n');
                rebindRulePackIfOffered(task);
                const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
                assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
                await runOfferedRestart(task, route.commands[0].command);
                const cycle = readCycleAuthority(task);
                assert.equal(cycle.authoritative_review_classification.source, 'delta');
                if (cycle.authoritative_review_classification.source === 'delta') {
                    const delta = cycle.authoritative_review_classification.delta;
                    assert.equal(delta.mode_policy_assessment?.mode, edit.startsWith('linked card') ? 'FULL' : 'DELTA');
                    assert.equal(delta.full_review_reasons.some((reason) => reason.includes('task criteria changed')), edit.startsWith('linked card'));
                }
                if (edit.startsWith('linked card')) {
                    assert.ok(cycle.authoritative_review_decision.lane_decisions.every((lane) => lane.invalidated && lane.mode === 'FULL'),
                        JSON.stringify(cycle.authoritative_review_decision.lane_decisions));
                } else {
                    assert.equal(cycle.authoritative_review_decision.lane_decisions.find((lane) => lane.review_type === 'code')?.mode, 'DELTA');
                }
                await buildContext(task, 'code');
                assert.equal(contextMode(task, 'code').mode, edit.startsWith('linked card') ? 'FULL' : 'DELTA');
            } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
        });
    }

    it('keeps the authenticated DELTA for a carried lane through a second ordinary restart', { concurrency: false }, async () => {
        const task = await seedTask('T-958-carried-two-fixes', { modePolicy: true, matchingTaskTitle: true });
        try {
            for (const lane of ['code', 'security', 'refactor']) await passFreshReview(task, lane);
            const refactorRecord = readTaskTimelineEvents(task.repoRoot, task.taskId).find((event) => event.event_type === 'REVIEW_RECORDED'
                && (event.details as { review_type?: string } | undefined)?.review_type === 'refactor');
            const refactorTree = (refactorRecord?.details as { review_tree_state_sha256?: string } | undefined)?.review_tree_state_sha256;
            assert.match(String(refactorTree), /^[a-f0-9]{64}$/u);
            await passFreshReview(task, 'test', {
                failure: { finding: 'The helper in tests/helpers/render.ts:1 hides a failed assertion.', file: FILES[1] }
            });
            fs.appendFileSync(path.join(task.repoRoot, FILES[0]), '// first production fix\n');
            fs.appendFileSync(path.join(task.repoRoot, FILES[1]), '// first helper fix\n');
            rebindRulePackIfOffered(task);
            let route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
            await runOfferedRestart(task, route.commands[0].command);
            const first = readCycleAuthority(task).authoritative_review_decision;
            assert.equal(first.lane_decisions.find((lane) => lane.review_type === 'refactor')?.mode, 'DELTA',
                JSON.stringify(first.lane_decisions));

            await buildContext(task, 'code');
            await passFreshReview(task, 'code', {
                failure: { finding: 'The total in src/total.ts:1 still rounds down.', file: FILES[0] }
            });
            fs.appendFileSync(path.join(task.repoRoot, FILES[0]), '// second production fix\n');
            rebindRulePackIfOffered(task);
            route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
            await runOfferedRestart(task, route.commands[0].command);
            const secondCycle = readCycleAuthority(task);
            const second = secondCycle.authoritative_review_decision;
            assert.equal(second.lane_decisions.find((lane) => lane.review_type === 'refactor')?.mode, 'DELTA',
                JSON.stringify(second.lane_decisions));
            assert.equal(second.lane_decisions.find((lane) => lane.review_type === 'test')?.mode, 'FULL',
                'the earlier failed lane is not treated as a passed carried review');
            assert.equal(secondCycle.authoritative_review_classification.source, 'delta');
            if (secondCycle.authoritative_review_classification.source === 'delta') {
                const delta = secondCycle.authoritative_review_classification.delta;
                const refactorDelta = delta.lane_deltas?.refactor;
                assert.ok(refactorDelta);
                assert.equal(refactorDelta.baseline.review_tree_state_sha256, refactorTree);
                assert.notEqual(refactorDelta.baseline.review_tree_state_sha256, delta.baseline.review_tree_state_sha256);
                assert.deepEqual(refactorDelta.changed_files, FILES);
                const forged = structuredClone(secondCycle.authoritative_review_classification);
                forged.delta.lane_deltas!.refactor.baseline.review_tree_state_sha256 = '0'.repeat(64);
                const forgedLane = forged.delta.lane_deltas!.refactor;
                const { classification_sha256: _laneHash, ...lanePayload } = forgedLane;
                forgedLane.classification_sha256 = sha256RedactedJsonPayload(lanePayload);
                const { classification_sha256: _parentHash, ...parentPayload } = forged.delta;
                forged.delta.classification_sha256 = sha256RedactedJsonPayload(parentPayload);
                const forgedDecision = structuredClone(second);
                forgedDecision.classification_sha256 = forged.delta.classification_sha256;
                const { decision_sha256: _decisionHash, ...decisionPayload } = forgedDecision;
                forgedDecision.decision_sha256 = sha256RedactedJsonPayload(decisionPayload);
                assert.throws(() => buildAuthenticatedRemediationReviewExecution({ taskId: task.taskId, reviewType: 'refactor',
                    preflightSha256: fileSha256(task.preflightPath)!, fullReviewScope: delta.scope.full_review_scope,
                    authoritativeDecision: forgedDecision, authoritativeClassification: forged,
                    persistedDecisionSha256: forgedDecision.decision_sha256 }));
            }
            await buildContext(task, 'code');
            await passFreshReview(task, 'code');
            await buildContext(task, 'security');
            await buildContext(task, 'refactor');
            assert.equal(contextMode(task, 'refactor').mode, 'DELTA');
            const context = JSON.parse(fs.readFileSync(path.join(task.reviewsRoot, `${task.taskId}-refactor-review-context.json`), 'utf8')) as {
                review_execution: { base: { review_tree_state_sha256: string }; delta: { required_delta_targets: string[] } };
            };
            assert.equal(context.review_execution.base.review_tree_state_sha256, refactorTree);
            assert.deepEqual(context.review_execution.delta.required_delta_targets, FILES);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('requires FULL for a carried lane when the cumulative changes exceed the DELTA bound', { concurrency: false }, async () => {
        const task = await seedTask('T-958-carried-large-cumulative', { modePolicy: true, matchingTaskTitle: true });
        try {
            for (const lane of ['code', 'security', 'refactor']) await passFreshReview(task, lane);
            await passFreshReview(task, 'test', {
                failure: { finding: 'The helper in tests/helpers/render.ts:1 hides a failed assertion.', file: FILES[1] }
            });
            fs.appendFileSync(path.join(task.repoRoot, FILES[0]), '// first production fix\n');
            fs.appendFileSync(path.join(task.repoRoot, FILES[1]), Array.from({ length: 120 }, (_, i) => `// helper change ${i}\n`).join(''));
            rebindRulePackIfOffered(task);
            let route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
            await runOfferedRestart(task, route.commands[0].command);
            assert.equal(readCycleAuthority(task).authoritative_review_decision.lane_decisions.find((lane) => lane.review_type === 'refactor')?.mode,
                'DELTA');
            await buildContext(task, 'code');
            await passFreshReview(task, 'code', {
                failure: { finding: 'The total in src/total.ts:1 still rounds down.', file: FILES[0] }
            });
            fs.appendFileSync(path.join(task.repoRoot, FILES[0]), Array.from({ length: 120 }, (_, i) => `// production change ${i}\n`).join(''));
            rebindRulePackIfOffered(task);
            route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
            await runOfferedRestart(task, route.commands[0].command);
            const decision = readCycleAuthority(task).authoritative_review_decision;
            assert.equal(decision.lane_decisions.find((lane) => lane.review_type === 'code')?.mode, 'DELTA');
            assert.equal(decision.lane_decisions.find((lane) => lane.review_type === 'refactor')?.mode, 'FULL');
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('measures a later small fix against a review an earlier restart kept, in DELTA', { concurrency: false }, async () => {
        const task = await seedTask('T-958-kept-origin', { modePolicy: true });
        const { repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath } = task;
        try {
            await restartAfterSharedHelperFix(task, true);
            // The restart kept the code review: rebuilding its context records it through REUSE.
            assert.equal(passedReceiptRetained(await buildContext(task, 'code')), true);
            const required = ['code', 'security', 'refactor', 'test'];
            assert.ok(collectRemediationOriginCandidates({ repoRoot, taskId, requiredReviewTypes: required })
                .some((candidate) => candidate.reviewType === 'code' && !candidate.failed), 'the kept review can anchor a later fix');
            // Before the reopened reviews are recorded, a small production fix inside the code review's scope.
            fs.appendFileSync(path.join(repoRoot, FILES[0]), '// the total rounds half up\n');
            rebindRulePackIfOffered(task);
            const route = resolveNextStepAfterEffects(taskId, repoRoot);
            assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
            const argv = splitCommandLine(route.commands[0].command);
            const restarted = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
                emitMetrics: false, reviewType: argv[argv.indexOf('--review-type') + 1],
                changedFiles: argv.flatMap((entry, index) => entry === '--changed-file' ? [argv[index + 1]] : []),
                impactAnalysis: `${FIX_IMPACT_ANALYSIS} A one-line production fix in ${FILES[0]} follows.` });
            assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
            const decision = readCycleAuthority(task).authoritative_review_decision;
            assert.equal(decision.classification_source, 'delta', JSON.stringify(decision.lane_decisions));
            assert.equal(decision.lane_decisions.find((lane) => lane.review_type === 'code')?.mode, 'DELTA',
                JSON.stringify(decision.lane_decisions));
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('repeats a passed then failed review in DELTA after a small fix', { concurrency: false }, async () => {
        const task = await seedTask('T-960-passed-then-failed', { modePolicy: true, matchingTaskTitle: true });
        const { repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath } = task;
        try {
            await passFreshReview(task, 'code');
            fs.appendFileSync(path.join(repoRoot, FILES[0]), '// adjust the displayed total\n');
            const reopened = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
                changedFiles: FILES, reviewType: 'code', emitMetrics: false,
                impactAnalysis: `${FIX_IMPACT_ANALYSIS} A small production change in ${FILES[0]} reopens code.` });
            assert.equal(reopened.exitCode, 0, reopened.outputLines.join('\n'));
            await buildContext(task, 'code');
            await passFreshReview(task, 'code', {
                failure: { finding: 'The total in src/total.ts:1 rounds half down.', file: FILES[0] }
            });

            const codeRecords = readTaskTimelineEvents(repoRoot, taskId).filter((event) => event.event_type === 'REVIEW_RECORDED'
                && (event.details as { review_type?: string } | undefined)?.review_type === 'code');
            assert.equal(codeRecords.length, 2);
            const latest = codeRecords[1].details as Record<string, string>;
            for (const [pathKey, shaKey] of [['receipt_path', 'receipt_sha256'], ['review_artifact_path', 'review_artifact_sha256']]) {
                assert.equal(fileSha256(path.resolve(repoRoot, latest[pathKey])), latest[shaKey], `${pathKey} belongs to the failed run`);
            }
            const candidates = collectRemediationOriginCandidates({ repoRoot, taskId, requiredReviewTypes: ['code'] });
            assert.equal(candidates[0]?.reviewType, 'code');
            assert.equal(candidates[0]?.failed, true, 'the latest failed review owns the fix');

            fs.appendFileSync(path.join(repoRoot, FILES[0]), '// round half up\n');
            rebindRulePackIfOffered(task);
            const route = resolveNextStepAfterEffects(taskId, repoRoot);
            assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
            const argv = splitCommandLine(route.commands[0].command);
            const reviewTypeIndex = argv.indexOf('--review-type');
            const taskIntentIndex = argv.indexOf('--task-intent');
            assert.equal(argv[taskIntentIndex + 1], 'Update the displayed total', route.commands[0].command);
            const restarted = await runRestartReviewCycleCommand({ repoRoot, taskId, preflightPath, commandsPath, outputFiltersPath,
                emitMetrics: false,
                ...(reviewTypeIndex >= 0 ? { reviewType: argv[reviewTypeIndex + 1] } : {}),
                ...(taskIntentIndex >= 0 ? { taskIntent: argv[taskIntentIndex + 1] } : {}),
                changedFiles: argv.flatMap((entry, index) => entry === '--changed-file' ? [argv[index + 1]] : []),
                impactAnalysis: `${FIX_IMPACT_ANALYSIS} A one-line production fix in ${FILES[0]} follows.` });
            assert.equal(restarted.exitCode, 0, restarted.outputLines.join('\n'));
            const decision = readCycleAuthority(task).authoritative_review_decision;
            assert.equal(decision.classification_source, 'delta');
            assert.equal(decision.current_review_type, 'code');
            assert.equal(decision.lane_decisions.find((lane) => lane.review_type === 'code')?.mode, 'DELTA',
                JSON.stringify(decision.lane_decisions));
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('names only the affected review without a declared graph', { concurrency: false }, async () => {
        const task = await seedTask('T-953-only-review');
        try {
            await passFreshReview(task, 'code');
            await rejectReportAndLoseIdentity(task, 'security');
            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assertEvidenceOnlyRoute(route, 'security');
            assert.match(route.reason, /repeats only 'security', preserving passed receipts/u);
            assert.doesNotMatch(route.reason, /depend/u);
            await runOfferedRestart(task, route.commands[0].command);
            assert.deepEqual(readCycle(task).authoritative_review_decision.invalidated_review_types, ['security']);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('repeats only the affected review after the original correction session is closed', { concurrency: false }, async () => {
        const task = await seedTask('T-953-closed-correction');
        try {
            await passFreshReview(task, 'code');
            const rejected = await rejectReport(task, 'security');
            const correctionPath = getReviewOutputCorrectionArtifactPath(rejected.artifactPath);
            await handleRecordReviewOutputCorrectionTransport(['--task-id', task.taskId, '--review-type', 'security',
                '--correction-artifact-path', correctionPath, '--session-availability', 'closed',
                '--reviewer-identity', rejected.launch.reviewer_identity,
                '--provider-invocation-id', rejected.launch.provider_invocation_id, '--repo-root', task.repoRoot]);
            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assertEvidenceOnlyRoute(route, 'security');
            await runOfferedRestart(task, route.commands[0].command);
            assert.deepEqual(readCycle(task).authoritative_review_decision.invalidated_review_types, ['security']);
            assert.equal(passedReceiptRetained(await buildContext(task, 'code')), true);
            await buildContext(task, 'security');
            await passFreshReview(task, 'security');
            assert.notEqual(resolveNextStepAfterEffects(task.taskId, task.repoRoot).next_gate, 'restart-review-cycle');
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('names the declared graph dependents the restart repeats', { concurrency: false }, async () => {
        const task = await seedTask('T-954-dependents', { dependencies: { security: ['code'], refactor: ['security'], test: ['refactor'] } });
        try {
            await passFreshReview(task, 'code');
            await rejectReportAndLoseIdentity(task, 'security');
            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assertEvidenceOnlyRoute(route, 'security');
            assert.match(route.reason, /repeats 'security' and the reviews that depend on it in the declared review graph \('refactor', 'test'\)/u);
            await runOfferedRestart(task, route.commands[0].command);
            const cycle = readCycle(task);
            assert.deepEqual(cycle.authoritative_review_decision.invalidated_review_types, ['security', 'refactor', 'test']);
            assert.match(cycle.review_reuse.pending_reason || '', /'security' and the reviews that depend on it in the declared review graph/u);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    const neutralClosures: Array<[string, SeedTaskOptions]> = [
        ['a Git-detected preflight', { gitAuto: true }],
        ['TASK.md in an explicit preflight', { extraFiles: ['TASK.md'] }]
    ];
    for (const [label, options] of neutralClosures) {
        it(`accepts the offered restart after follow-up materialization changed TASK.md with ${label}`, { concurrency: false }, async () => {
            const task = await seedTask(`T-955-closeout-${options.gitAuto ? 'git' : 'explicit'}`, options);
            try {
                rebindRulePackIfOffered(task);
                await passFreshReview(task, 'code');
                rebindRulePackIfOffered(task);
                await rejectReportAndLoseIdentity(task, 'security');
                rebindRulePackIfOffered(task);
                assertEvidenceOnlyRoute(resolveNextStepAfterEffects(task.taskId, task.repoRoot), 'security');
                fs.appendFileSync(path.join(task.repoRoot, 'TASK.md'), '\nFollow-up materialized from the code review.\n');

                rebindRulePackIfOffered(task);
                const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
                assertEvidenceOnlyRoute(route, 'security');
                await runOfferedRestart(task, route.commands[0].command);
                assert.deepEqual(readCycle(task).authoritative_review_decision.invalidated_review_types, ['security']);

                assert.equal(passedReceiptRetained(await buildContext(task, 'code')), true);
                const next = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
                assert.notEqual(next.next_gate, 'restart-review-cycle', next.reason);
            } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
        });
    }

    it('accepts the offered restart with an authorized Git-ignored file in an explicit preflight', { concurrency: false }, async () => {
        const task = await seedTask('T-956-ignored-file', { gitIgnored: 'generated/', extraFiles: ['generated/bundle.ts'] });
        try {
            const ignoredPath = path.join(task.repoRoot, 'generated/bundle.ts');
            const ignoredBytes = fs.readFileSync(ignoredPath);
            await rejectReportAndLoseIdentity(task, 'code');
            // The review fixtures touch every file Git reports as clean; the task itself left this one unchanged.
            fs.writeFileSync(ignoredPath, ignoredBytes);
            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assertEvidenceOnlyRoute(route, 'code');
            await runOfferedRestart(task, route.commands[0].command);
            assert.deepEqual(readCycle(task).authoritative_review_decision.invalidated_review_types, ['code']);
            const next = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.notEqual(next.next_gate, 'restart-review-cycle', next.reason);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('refuses evidence-only recovery after a real change and does not offer it', { concurrency: false }, async () => {
        const task = await seedTask('T-957-real-change');
        try {
            await passFreshReview(task, 'code');
            await rejectReportAndLoseIdentity(task, 'security');
            // Same line count: only the content hash can see this edit.
            fs.writeFileSync(path.join(task.repoRoot, FILES[0]), '// changed task content\n');
            const restartsBefore = restartCount(task);
            const refused = await runRestartReviewCycleCommand({ repoRoot: task.repoRoot, taskId: task.taskId,
                preflightPath: task.preflightPath, commandsPath: task.commandsPath, outputFiltersPath: task.outputFiltersPath,
                reviewEvidenceOnly: true, reviewType: 'security', emitMetrics: false, impactAnalysis: IMPACT_ANALYSIS });
            assert.notEqual(refused.exitCode, 0);
            assert.match(refused.outputLines.join('\n'), /review-evidence-only restart is blocked/u);
            assert.equal(restartCount(task), restartsBefore);
            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.doesNotMatch(route.commands[0]?.command || '', /--review-evidence-only/u, route.reason);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    for (const lostEvidence of ['compile-gate', 'preflight']) {
        it(`leaves lost ${lostEvidence} evidence to its own route instead of repeating reviews here`, { concurrency: false }, async () => {
            const task = await seedTask(`T-959-lost-${lostEvidence}`);
            try {
                await passFreshReview(task, 'code');
                await rejectReportAndLoseIdentity(task, 'security');
                const restartsBefore = restartCount(task);
                fs.unlinkSync(path.join(task.reviewsRoot, `${task.taskId}-${lostEvidence}.json`));
                const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
                assert.notEqual(route.next_gate, 'restart-review-cycle', route.reason);
                assert.equal(restartCount(task), restartsBefore);
            } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
        });
    }

    it('restores lost preflight with its classified intent and keeps a passed review', { concurrency: false }, async () => {
        const task = await seedTask('T-959-lost-preflight-intent');
        try {
            await passFreshReview(task, 'code');
            const preflight = fs.readFileSync(task.preflightPath, 'utf8');
            const receiptPath = path.join(task.reviewsRoot, `${task.taskId}-code-receipt.json`);
            const receipt = fs.readFileSync(receiptPath, 'utf8');
            const restarts = restartCount(task);
            fs.unlinkSync(task.preflightPath);
            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.equal(route.next_gate, 'classify-change', route.reason);
            const argv = splitCommandLine(route.commands[0].command);
            const taskIntent = argv[argv.indexOf('--task-intent') + 1];
            assert.equal(taskIntent, 'Update the displayed total', route.commands[0].command);
            const changedFiles = argv.flatMap((arg, index) => arg === '--changed-file' ? [argv[index + 1]] : []);
            runClassifyChangeCommand({ repoRoot: task.repoRoot, taskId: task.taskId, taskIntent, changedFiles,
                outputPath: task.preflightPath, emitMetrics: false });
            assert.equal(fs.readFileSync(task.preflightPath, 'utf8'), preflight);
            assert.equal(fs.readFileSync(receiptPath, 'utf8'), receipt);
            assert.equal(restartCount(task), restarts);
            assert.equal(passedReceiptRetained(await buildContext(task, 'code')), true);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('leaves a correction package no event recorded through a restart that changes state', { concurrency: false }, async () => {
        const task = await seedTask('T-958-unrecorded-package');
        try {
            await passFreshReview(task, 'code');
            await rejectReportAndLoseIdentity(task, 'security', { recorded: false });

            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.equal(route.next_gate, 'restart-review-cycle', route.reason);
            assert.doesNotMatch(route.commands[0].command, /--review-evidence-only/u);
            assert.match(route.reason, /no authenticated correction event records this correction package/u);
            assert.match(route.reason, /every required review repeats in FULL/u);

            await runOfferedRestart(task, route.commands[0].command);
            assert.equal(restartCount(task), 1);
            const next = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.notEqual(next.next_gate, 'restart-review-cycle', next.reason);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });

    it('restarts only the affected review after a rejected report lost its reviewer identity', { concurrency: false }, async () => {
        const task = await seedTask('T-959-rejected-identity');
        try {
            await passFreshReview(task, 'code');
            await rejectReport(task, 'security');
            fs.unlinkSync(launchPathFor(task, 'security'));

            const route = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assertEvidenceOnlyRoute(route, 'security');
            // A lost launch record cannot bind a correction: the route is a FULL rerun of only this review.
            assert.match(route.title, /fresh full 'security' reviewer/u);
            assert.match(route.reason, /repeats only 'security'/u);
            await runOfferedRestart(task, route.commands[0].command);
            assert.deepEqual(readCycle(task).authoritative_review_decision.invalidated_review_types, ['security']);
            assert.equal(passedReceiptRetained(await buildContext(task, 'code')), true);
            const next = resolveNextStepAfterEffects(task.taskId, task.repoRoot);
            assert.notEqual(next.next_gate, 'restart-review-cycle', next.reason);
            assert.equal(restartCount(task), 1);
        } finally { fs.rmSync(task.repoRoot, { recursive: true, force: true }); }
    });
});
