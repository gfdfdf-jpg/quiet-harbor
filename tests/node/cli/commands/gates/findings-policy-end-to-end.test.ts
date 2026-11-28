import { resolveNextStep } from '../../../gates/next-step/next-step-test-support';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit, writeBalancedProfilesConfig, writeBudgetOutputFilters } from '../gate-test-helpers';
import { describe, it } from 'node:test';

import { runDocImpactGateCommand, runRequiredReviewsCheckCommand } from '../../../../../src/cli/commands/gates';
import { readTaskQueueStatus, syncTaskQueueStatusDetailed } from '../../../../../src/cli/commands/gate-flows/task/task-queue-sync';
import { runTaskAuditSummaryCommand } from '../../../../../src/cli/commands/gate-flows/task/task-summary-flow';
import { resolveTaskQueueTransactionLockPath } from '../../../../../src/core/task-queue/task-queue-repository';
import { formatActiveTaskQueueTable } from '../../../../../src/core/task-md-table';
import { buildReviewContext } from '../../../../../src/gates/review-context/build-review-context';
import { buildTaskAuditSummary } from '../../../../../src/gates/task-audit/task-audit-summary';
import { resolveTaskHistoryLedgerPath } from '../../../../../src/gate-runtime/task-history-ledger';
import { materializeReviewFindingsFollowUpTasks } from '../../../../../src/gates/review/review-findings-follow-up-tasks';
import { classifyReviewRemediationDelta } from '../../../../../src/gates/review-remediation/review-remediation-delta';
import {
    resolveReviewRemediationRerunLanes,
    resolveReviewRemediationRerunPolicyFromSnapshot
} from '../../../../../src/policy/review-remediation-rerun-policy';
import { syncDecomposedParentsToDone } from '../../../../../src/gates/next-step/next-step-task-queue-status-sync';
import {
    buildNoFindingsJsonReviewReport,
    buildFailedJsonReviewReport,
    createTempRepo,
    appendTaskEvent,
    getOrchestratorRoot,
    getReviewsRoot,
    attestReviewerInvocationForTest,
    prepareCurrentReviewPhase,
    runCliWithCapturedOutput,
    runEnterTaskMode,
    seedInitAnswers,
    writeCompilePassEvidence,
    writePreflight,
    writeReceiptBackedReviewArtifact
} from './review-result/gates-command-review-result-fixtures';
import {
    launchArtifactInputArgsForTest,
    prepareReviewerLaunchForTest,
    recordReviewerDelegationStartedForTest,
    seedPromptBoundReviewFixture
} from './review-launch/gates-command-review-launch-fixtures';

async function launchAuthenticatedReviewer(
    fixture: Awaited<ReturnType<typeof seedPromptBoundReviewFixture>>, finishReviewWork?: () => void
): Promise<void> {
    const providerInvocationId = `e2e-${fixture.reviewerIdentity.replace(/[^a-z0-9]+/giu, '-')}`;
    await prepareReviewerLaunchForTest({
        repoRoot: path.resolve(fixture.reviewsRoot, '..', '..', '..'),
        taskId: path.basename(fixture.preflightPath, '-preflight.json'),
        reviewerIdentity: fixture.reviewerIdentity,
        reviewType: fixture.reviewType,
        launchArtifactPath: fixture.launchArtifactPath
    });
    const repoRoot = path.resolve(fixture.reviewsRoot, '..', '..', '..');
    const taskId = path.basename(fixture.preflightPath, '-preflight.json');
    await recordReviewerDelegationStartedForTest({
        repoRoot,
        taskId,
        reviewerIdentity: fixture.reviewerIdentity,
        reviewType: fixture.reviewType,
        launchArtifactPath: fixture.launchArtifactPath,
        providerInvocationId,
        attestationSource: 'multi_agent_v1.spawn_agent'
    });
    finishReviewWork?.();
    const completed = await runCliWithCapturedOutput([
        'gate', 'complete-reviewer-launch',
        '--task-id', taskId,
        '--review-type', fixture.reviewType,
        '--repo-root', repoRoot,
        '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', fixture.reviewerIdentity,
        '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
        '--provider-invocation-id', providerInvocationId,
        '--attestation-source', 'multi_agent_v1.spawn_agent',
        ...launchArtifactInputArgsForTest(fixture.launchArtifactPath),
        '--fork-context', 'false',
        '--record-invocation'
    ], { cwd: repoRoot });
    assert.equal(completed.exitCode, 0, completed.errors.join('\n'));
}

function reviewOutputPath(repoRoot: string, taskId: string, reviewType = 'code'): string {
    const outputPath = path.join(
        repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, reviewType, 'review-output.json'
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    return outputPath;
}

describe('findings policy end-to-end lifecycle', () => {
    for (const [scenario, title] of [
        ['clean', 'completes authenticated empty-findings ingestion through final audit'],
        ['deferred', 'publishes grouped deferred findings only after completion and lists the child in the final report'],
        ['ledger-failure', 'keeps committed DONE and report on a ledger write failure and preserves them through native human-commit'],
        ['alternate-completion', 'refuses a grouped completion with alternate compile evidence without writing lifecycle state']
    ]) it(title, async (context) => {
        const deferred = scenario !== 'clean';
        const repoRoot = createTempRepo();
        const taskId = 'T-979-44-clean-e2e';
        try {
            if (deferred) fs.appendFileSync(path.join(repoRoot, '.gitignore'), '\nTASK.md\ngarda-agent-orchestrator/runtime/\n');
            const multiLane = scenario === 'deferred';
            if (multiLane) {
                const profilesPath = writeBalancedProfilesConfig(repoRoot);
                const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
                    built_in_profiles: { balanced: { review_policy: Record<string, boolean | string> } };
                };
                profiles.built_in_profiles.balanced.review_policy.refactor = true;
                fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2) + '\n');
                const skillPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'skills', 'refactor-review', 'SKILL.md');
                fs.mkdirSync(path.dirname(skillPath), { recursive: true });
                fs.writeFileSync(skillPath, '# Refactor review\n\nFixture review skill entrypoint.\n');
                fs.appendFileSync(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/live/skills/refactor-review/\n');
            }
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId, requireRefactorReview: multiLane });
            if (multiLane) {
                const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as { required_reviews: Record<string, boolean> };
                assert.equal(preflight.required_reviews.refactor, true, JSON.stringify(preflight.required_reviews));
            }
            const orchestratorRoot = getOrchestratorRoot(repoRoot);
            appendTaskEvent(orchestratorRoot, taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'E2E fixture implementation started.', {});
            writeCompilePassEvidence(repoRoot, taskId, fixture.preflightPath);
            appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'E2E fixture review started.', {
                review_type: 'code'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'E2E fixture selected review skill.', {
                skill_id: 'code-review'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'E2E fixture loaded review skill.', {
                reference_path: '/live/skills/code-review/SKILL.md'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'E2E fixture routed reviewer.', {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: fixture.reviewerIdentity,
                reviewer_fallback_reason: null,
                delegation_used: true
            });
            if (deferred) {
                context.mock.timers.enable({ apis: ['Date'], now: Date.now() - 12_000 });
                try {
                    await launchAuthenticatedReviewer(fixture, () => context.mock.timers.tick(12_000));
                } finally {
                    context.mock.timers.reset();
                }
            } else attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            const outputPath = reviewOutputPath(repoRoot, taskId);
            const report = deferred ? buildFailedJsonReviewReport(fixture.reviewContextPath, taskId)
                : buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId);
            if (deferred) {
                const findings = report.findings as Record<string, unknown[]>;
                findings.low = findings.high;
                findings.high = [];
            }
            fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
            const recorded = await runCliWithCapturedOutput([
                'gate', 'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', outputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });
            assert.equal(recorded.exitCode, 0, recorded.errors.join('\n'));

            if (multiLane) {
                const reviewType = 'refactor';
                const reviewerIdentity = 'agent:' + taskId + '-refactor';
                const reviewContextPath = path.join(fixture.reviewsRoot, taskId + '-refactor-review-context.json');
                appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'E2E fixture started refactor review.', {
                    review_type: reviewType
                });
                appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'E2E fixture selected refactor review skill.', {
                    skill_id: 'refactor-review'
                });
                appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'E2E fixture loaded refactor review skill.', {
                    reference_path: '/live/skills/refactor-review/SKILL.md'
                });
                buildReviewContext({ repoRoot, reviewType, depth: 2, preflightPath: fixture.preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    outputPath: reviewContextPath, scopedDiffMetadataPath: path.join(fixture.reviewsRoot, taskId + '-refactor-scoped.json') });
                const routing = await runCliWithCapturedOutput(['gate', 'record-review-routing', '--task-id', taskId,
                    '--review-type', reviewType, '--repo-root', repoRoot,
                    '--reviewer-execution-mode', 'delegated_subagent', '--reviewer-identity', reviewerIdentity], { cwd: repoRoot });
                assert.equal(routing.exitCode, 0, routing.errors.join('\n'));
                const refactorOutput = reviewOutputPath(repoRoot, taskId, reviewType);
                context.mock.timers.enable({ apis: ['Date'], now: Date.now() - 12_000 });
                try {
                    await launchAuthenticatedReviewer({
                        ...fixture, reviewType, reviewerIdentity, reviewContextPath,
                        launchArtifactPath: path.join(path.dirname(refactorOutput), 'reviewer-launch.json')
                    }, () => context.mock.timers.tick(12_000));
                } finally {
                    context.mock.timers.reset();
                }
                const refactorReport = buildFailedJsonReviewReport(reviewContextPath, taskId, reviewType);
                const findings = refactorReport.findings as Record<string, unknown[]>;
                findings.low = findings.high;
                findings.high = [];
                fs.writeFileSync(refactorOutput, JSON.stringify(refactorReport, null, 2) + '\n');
                const recordedRefactor = await runCliWithCapturedOutput(['gate', 'record-review-result',
                    '--task-id', taskId, '--review-type', reviewType, '--preflight-path', fixture.preflightPath,
                    '--review-output-path', refactorOutput, '--repo-root', repoRoot, '--reviewer-execution-mode',
                    'delegated_subagent', '--reviewer-identity', reviewerIdentity], { cwd: repoRoot });
                assert.equal(recordedRefactor.exitCode, 0, [...recordedRefactor.errors, ...recordedRefactor.logs].join('\n'));
            }

            const reviewGate = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath: fixture.preflightPath,
                codeReviewVerdict: 'REVIEW PASSED',
                ...(multiLane ? { refactorReviewVerdict: 'REFACTOR REVIEW PASSED' } : {}),
                reviewAuthorshipAttestationJson: multiLane ? '{"code":true,"refactor":true}' : '{"code":true}',
                outputFiltersPath: writeBudgetOutputFilters(repoRoot),
                emitMetrics: false
            });
            assert.equal(reviewGate.exitCode, 0, reviewGate.outputLines.join('\n'));
            const docImpact = runDocImpactGateCommand({
                repoRoot,
                taskId,
                preflightPath: fixture.preflightPath,
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                rationale: 'Findings-only end-to-end regression adds no documentation behavior.',
                emitMetrics: false
            });
            assert.equal(docImpact.exitCode, 0, docImpact.outputLines.join('\n'));
            if (deferred) {
                const premature = materializeReviewFindingsFollowUpTasks({ repoRoot, taskId, reviewType: 'code' });
                assert.equal(premature.status, 'BLOCKED', premature.output_lines.join('\n'));
                assert.ok(!fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(taskId + '-F1'));
            }
            const timelinePath = path.join(orchestratorRoot, 'runtime', 'task-events', taskId + '.jsonl');
            const timelineBeforeCompletion = fs.readFileSync(timelinePath);
            const completionArgs = [
                'gate', 'completion-gate',
                '--task-id', taskId,
                '--preflight-path', fixture.preflightPath,
                ...(scenario === 'alternate-completion' ? ['--compile-evidence-path', fixture.preflightPath] : []),
                '--repo-root', repoRoot
            ];
            if (multiLane) {
                const crash = spawnSync(process.execPath, ['-e', [
                    'const [auditModule, cliModule, timelinePath, ...args] = process.argv.slice(1);',
                    'const fs = require("node:fs");',
                    'const audit = require(auditModule);',
                    'const originalAudit = audit.buildTaskAuditSummary;',
                    'audit.buildTaskAuditSummary = function(options) {',
                    '    const timeline = fs.readFileSync(timelinePath, "utf8");',
                    '    const pass = JSON.stringify({ event_type: "COMPLETION_GATE_PASSED" }).slice(1, -1);',
                    '    if (timeline.includes(pass)) process.exit(44);',
                    '    return originalAudit(options);',
                    '};',
                    'void require(cliModule).runCliMainWithHandling(args);'
                ].join('\n'), require.resolve('../../../../../src/gates/task-audit/task-audit-summary'),
                    require.resolve('../../../../../src/cli/main'), timelinePath, ...completionArgs],
                { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
                assert.equal(crash.status, 44, crash.error?.message || crash.stderr);
                const pendingTimeline = fs.readFileSync(timelinePath, 'utf8');
                assert.match(pendingTimeline, /"event_type":"COMPLETION_GATE_PASSED"/u);
                assert.doesNotMatch(pendingTimeline, /"event_type":"REVIEW_FOLLOW_UP_PUBLICATION_AUTHORIZED"/u);
                const refusedPublication = await runCliWithCapturedOutput(['gate', 'materialize-review-follow-up-tasks',
                    '--task-id', taskId, '--review-types', 'code,refactor', '--repo-root', repoRoot], { cwd: repoRoot });
                assert.notEqual(refusedPublication.exitCode, 0);
                assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), new RegExp(taskId + '-F1', 'u'));
                assert.equal(resolveNextStep({ repoRoot, taskId }).next_gate, 'completion-gate');
            }
            const completion = await runCliWithCapturedOutput(completionArgs, { cwd: repoRoot });
            if (scenario === 'alternate-completion') {
                assert.notEqual(completion.exitCode, 0);
                assert.match([...completion.logs, ...completion.errors].join(' '), /Grouped completion requires canonical task evidence paths/u);
                assert.deepEqual(fs.readFileSync(timelinePath), timelineBeforeCompletion);
                assert.ok(!fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(taskId + '-F1'));
                assert.notEqual(resolveNextStep({ repoRoot, taskId }).next_gate, 'materialize-review-follow-up-tasks');
                return;
            }
            assert.equal(completion.exitCode, 0, [...completion.errors, ...completion.logs].join('\n'));

            if (scenario === 'ledger-failure') {
                assert.equal(resolveNextStep({ repoRoot, taskId }).next_gate, 'materialize-review-follow-up-tasks');
                const published = await runCliWithCapturedOutput(['gate', 'materialize-review-follow-up-tasks',
                    '--task-id', taskId, '--review-types', 'code', '--repo-root', repoRoot], { cwd: repoRoot });
                assert.equal(published.exitCode, 0, [...published.errors, ...published.logs].join('\n'));
                const closeout = require('../../../../../src/gates/task-audit/task-audit-summary-closeout-sync') as typeof import('../../../../../src/gates/task-audit/task-audit-summary-closeout-sync');
                const failedLedger = context.mock.method(closeout, 'synchronizeFinalCloseoutLedger', () => {
                    throw new Error('Injected first terminal ledger write failure.');
                });
                const args = ['gate', 'task-audit-summary', '--task-id', taskId, '--repo-root', repoRoot];
                const failed = await runCliWithCapturedOutput(args, { cwd: repoRoot });
                failedLedger.mock.restore();
                assert.notEqual(failed.exitCode, 0);
                assert.match([...failed.errors, ...failed.logs].join('\n'), /Grouped report and DONE are committed/u);
                assert.match([...failed.errors, ...failed.logs].join('\n'), /Injected first terminal ledger write failure/u);
                assert.equal(readTaskQueueStatus(repoRoot, taskId), 'DONE');
                const terminalTimeline = fs.readFileSync(timelinePath);
                assert.match(terminalTimeline.toString('utf8'), /"new_status":"DONE","grouped_closeout":/u);
                const artifacts = ['-final-closeout.json', '-final-closeout.md', '-final-user-report.md']
                    .map(suffix => path.join(fixture.reviewsRoot, taskId + suffix));
                const committedReport = artifacts.map(file => fs.readFileSync(file));
                assert.ok(!fs.existsSync(resolveTaskHistoryLedgerPath(orchestratorRoot, taskId)));
                const ledgerRecovery = resolveNextStep({ repoRoot, taskId });
                assert.equal(ledgerRecovery.next_gate, 'task-audit-summary', ledgerRecovery.reason);
                assert.match(ledgerRecovery.commands[0]?.command || '', /gate task-audit-summary/u);
                const retried = await runCliWithCapturedOutput(args, { cwd: repoRoot });
                assert.equal(retried.exitCode, 0, [...retried.errors, ...retried.logs].join('\n'));
                assert.deepEqual(fs.readFileSync(timelinePath), terminalTimeline);
                assert.deepEqual(artifacts.map(file => fs.readFileSync(file)), committedReport);
                const ledgerPath = resolveTaskHistoryLedgerPath(orchestratorRoot, taskId);
                assert.equal(resolveNextStep({ repoRoot, taskId }).status, 'DONE');
                const committedLedger = fs.readFileSync(ledgerPath);
                const staleLedger = JSON.parse(committedLedger.toString('utf8')) as { lifecycle: { queue_status: string } };
                staleLedger.lifecycle.queue_status = 'IN_REVIEW';
                fs.writeFileSync(ledgerPath, JSON.stringify(staleLedger, null, 2) + '\n');
                const staleLedgerRecovery = resolveNextStep({ repoRoot, taskId });
                assert.equal(staleLedgerRecovery.next_gate, 'task-audit-summary', staleLedgerRecovery.reason);
                fs.writeFileSync(ledgerPath, committedLedger);
                runGit(repoRoot, ['add', '--', 'src/app.ts']);
                const headBefore = runGit(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
                const humanCommit = await runCliWithCapturedOutput(['gate', 'human-commit', '--task-id', taskId,
                    '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString(),
                    '--message', 'test: grouped report preservation'], { cwd: repoRoot });
                assert.equal(humanCommit.exitCode, 0, [...humanCommit.errors, ...humanCommit.logs].join('\n'));
                assert.notEqual(runGit(repoRoot, ['rev-parse', 'HEAD']).stdout.trim(), headBefore);
                assert.deepEqual(artifacts.map(file => fs.readFileSync(file)), committedReport);
                assert.match(fs.readFileSync(timelinePath, 'utf8'), /"event_type":"TASK_SOURCE_COMMIT_ACCEPTED"/u);
                assert.equal(resolveNextStep({ repoRoot, taskId }).status, 'DONE');
                return;
            }

            if (deferred) {
                const route = resolveNextStep({ repoRoot, taskId });
                assert.equal(route.next_gate, 'materialize-review-follow-up-tasks', route.reason);
                assert.match(route.commands[0].command, /--review-types "code,refactor"/u);
                assert.ok(!fs.existsSync(path.join(fixture.reviewsRoot, taskId + '-final-user-report.md')));
                const queuePath = path.join(repoRoot, 'TASK.md');
                const queueBefore = fs.readFileSync(queuePath);
                const protectedPath = path.join(repoRoot, 'AGENTS.md');
                const originalProtected = fs.existsSync(protectedPath) ? fs.readFileSync(protectedPath) : null;
                const driftProtected = () => fs.appendFileSync(protectedPath, '\nchanged after completion\n');
                const restoreProtected = () => originalProtected === null
                    ? fs.unlinkSync(protectedPath) : fs.writeFileSync(protectedPath, originalProtected);
                const receiptPath = path.join(fixture.reviewsRoot, taskId + '-code-receipt.json');
                const alternateReceipt = path.join(fixture.reviewsRoot, taskId + '-alternate-receipt.json');
                fs.writeFileSync(alternateReceipt, fs.readFileSync(receiptPath, 'utf8') + '\n');
                const commonArgs = ['gate', route.next_gate, '--task-id', taskId, '--repo-root', repoRoot];
                const preflightBytes = fs.readFileSync(fixture.preflightPath);
                const changedMode = JSON.parse(preflightBytes.toString('utf8')) as {
                    profile_policy_snapshot: { review_follow_up_policy: { materialization_mode: string } };
                };
                changedMode.profile_policy_snapshot.review_follow_up_policy.materialization_mode = 'per_finding';
                fs.writeFileSync(fixture.preflightPath, JSON.stringify(changedMode, null, 2) + '\n');
                try {
                    const modeDrift = await runCliWithCapturedOutput([...commonArgs, '--review-type', 'code'], { cwd: repoRoot });
                    assert.notEqual(modeDrift.exitCode, 0);
                    assert.match([...modeDrift.errors, ...modeDrift.logs].join('\n'), /follow-up mode differs from the authenticated grouped completion/u);
                    assert.deepEqual(fs.readFileSync(queuePath), queueBefore);
                } finally {
                    fs.writeFileSync(fixture.preflightPath, preflightBytes);
                }
                const alternate = await runCliWithCapturedOutput([...commonArgs, '--review-type', 'code',
                    '--receipt-path', alternateReceipt], { cwd: repoRoot });
                assert.notEqual(alternate.exitCode, 0);
                assert.match([...alternate.errors, ...alternate.logs].join('\n'), /canonical recorded receipt/u);
                assert.deepEqual(fs.readFileSync(queuePath), queueBefore);
                const omitted = await runCliWithCapturedOutput([...commonArgs, '--review-types', 'code'], { cwd: repoRoot });
                assert.notEqual(omitted.exitCode, 0);
                assert.match([...omitted.errors, ...omitted.logs].join('\n'), /requires every deferred review lane/u);
                assert.deepEqual(fs.readFileSync(queuePath), queueBefore);
                const materializationArgs = [...commonArgs, '--review-types', 'code,refactor'];
                driftProtected();
                const stale = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                restoreProtected();
                assert.notEqual(stale.exitCode, 0);
                assert.match([...stale.errors, ...stale.logs].join('\n'), /unchanged canonical completion evidence/u);
                assert.deepEqual(fs.readFileSync(queuePath), queueBefore);

                const queue = require('../../../../../src/cli/commands/gate-flows/task/task-queue-sync') as typeof import('../../../../../src/cli/commands/gate-flows/task/task-queue-sync');
                const withLock = queue.withTaskQueueStatusSyncLock;
                const receiptBytes = fs.readFileSync(receiptPath);
                const replacedReceipt = context.mock.method(queue, 'withTaskQueueStatusSyncLock', (...args: Parameters<typeof withLock>) => {
                    fs.appendFileSync(receiptPath, '\n');
                    return withLock(...args);
                });
                try {
                    const replaced = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                    assert.notEqual(replaced.exitCode, 0);
                    assert.deepEqual(fs.readFileSync(queuePath), queueBefore);
                } finally {
                    replacedReceipt.mock.restore();
                    fs.writeFileSync(receiptPath, receiptBytes);
                }

                const dispositionPath = path.join(fixture.reviewsRoot, taskId + '-code-findings-disposition.json');
                const dispositionBytes = fs.readFileSync(dispositionPath);
                const disposition = JSON.parse(dispositionBytes.toString('utf8')) as { source_validation: { artifact_path: string } };
                const validationPath = path.resolve(repoRoot, disposition.source_validation.artifact_path);
                assert.equal(syncTaskQueueStatusDetailed(repoRoot, taskId, 'BLOCKED').outcome, 'updated');
                const blockedQueue = fs.readFileSync(queuePath);
                const blockedParent = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                assert.notEqual(blockedParent.exitCode, 0);
                assert.match([...blockedParent.errors, ...blockedParent.logs].join('\n'), /requires a unique canonical parent in IN_REVIEW/u);
                assert.deepEqual(fs.readFileSync(queuePath), blockedQueue);
                assert.equal(syncTaskQueueStatusDetailed(repoRoot, taskId, 'IN_REVIEW').outcome, 'updated');
                assert.deepEqual(fs.readFileSync(queuePath), queueBefore);

                const { RecoverableFileTransaction } = require('../../../../../src/core/recoverable-file-transaction') as
                    typeof import('../../../../../src/core/recoverable-file-transaction');
                const writeTransactionFile = RecoverableFileTransaction.prototype.write;
                const sourceRace = context.mock.method(RecoverableFileTransaction.prototype, 'write', function(
                    this: InstanceType<typeof RecoverableFileTransaction>, ...args: Parameters<typeof writeTransactionFile>
                ) {
                    writeTransactionFile.call(this, ...args);
                    if (args[0].endsWith('-code-findings-follow-ups.json')) fs.appendFileSync(dispositionPath, '\n');
                });
                try {
                    const changed = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                    assert.notEqual(changed.exitCode, 0);
                    assert.match([...changed.errors, ...changed.logs].join('\n'), /disposition changed before publication/u);
                    assert.deepEqual(fs.readFileSync(queuePath), queueBefore);
                    assert.ok(!fs.existsSync(path.join(fixture.reviewsRoot, taskId + '-code-findings-follow-ups.json')));
                } finally {
                    sourceRace.mock.restore();
                    fs.writeFileSync(dispositionPath, dispositionBytes);
                }

                const crashAfterWrite = (suffix: string, exitCode: number) => spawnSync(process.execPath, ['-e', [
                    'const [journalModule, gateModule, repoRoot, taskId, suffix, exitCode] = process.argv.slice(1);',
                    'const { RecoverableFileTransaction } = require(journalModule);',
                    'const { materializeReviewFindingsFollowUpTaskBatch } = require(gateModule);',
                    'const originalWrite = RecoverableFileTransaction.prototype.write;',
                    'RecoverableFileTransaction.prototype.write = function(file, bytes) {',
                    '    originalWrite.call(this, file, bytes);',
                    '    if (file.endsWith(suffix)) process.exit(Number(exitCode));',
                    '};',
                    'materializeReviewFindingsFollowUpTaskBatch({ repoRoot, taskId, reviewTypes: ["code", "refactor"] });'
                ].join('\n'), require.resolve('../../../../../src/core/recoverable-file-transaction'),
                    require.resolve('../../../../../src/gates/review/review-findings-follow-up-tasks'), repoRoot, taskId, suffix, String(exitCode)],
                { cwd: repoRoot, encoding: 'utf8', timeout: 25_000 });
                const journalPath = path.join(fixture.reviewsRoot, taskId + '-grouped-publication-journal.json');
                const afterLane = crashAfterWrite('-findings-follow-ups.json', 42);
                assert.equal(afterLane.status, 42, afterLane.error?.message || afterLane.stderr);
                assert.deepEqual(fs.readFileSync(queuePath), queueBefore);
                assert.ok(fs.existsSync(journalPath));

                const afterQueue = crashAfterWrite('TASK.md', 43);
                assert.equal(afterQueue.status, 43, afterQueue.error?.message || afterQueue.stderr);
                assert.ok(fs.existsSync(journalPath));
                assert.match(fs.readFileSync(queuePath, 'utf8'), /review_follow_up_group_fingerprint=/u);
                const unrelatedTaskId = 'T-979-99';
                const previousQueueText = fs.readFileSync(queuePath, 'utf8');
                const unrelatedRow = '| ' + unrelatedTaskId + ' | TODO | P2 | test | Unrelated work | unassigned | 2026-03-28 | balanced | fixture |';
                fs.writeFileSync(queuePath, formatActiveTaskQueueTable(previousQueueText.trimEnd() + '\n' + unrelatedRow));

                const events = require('../../../../../src/gate-runtime/timeline/task-events-io') as typeof import('../../../../../src/gate-runtime/timeline/task-events-io');
                const originalAppend = events.appendMandatoryTaskEvent;
                const queueLockPath = resolveTaskQueueTransactionLockPath(queuePath);
                const eventLockPath = path.join(path.dirname(timelinePath), '.' + taskId + '.lock');
                const appendFailure = context.mock.method(events, 'appendMandatoryTaskEvent',
                    (...args: Parameters<typeof originalAppend>) => {
                        if (args[2] === 'REVIEW_FOLLOW_UP_CHILD_PUBLISHED') {
                            assert.ok(!fs.existsSync(queueLockPath), 'F1 must not hold the queue when requesting the event lock');
                            throw new Error('Interrupted publication lineage.');
                        }
                        return originalAppend(...args);
                    });
                const interrupted = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                appendFailure.mock.restore();
                assert.notEqual(interrupted.exitCode, 0);
                assert.match([...interrupted.errors, ...interrupted.logs].join('\n'), /Interrupted publication lineage/u);
                assert.ok(!fs.existsSync(journalPath));
                assert.equal(resolveNextStep({ repoRoot, taskId }).next_gate, 'materialize-review-follow-up-tasks');
                const queueAfter = fs.readFileSync(queuePath);
                assert.equal(readTaskQueueStatus(repoRoot, unrelatedTaskId), 'TODO');
                const lanePaths = ['code', 'refactor'].map(type => path.join(fixture.reviewsRoot, taskId + '-' + type + '-findings-follow-ups.json'));
                const laneBytes = lanePaths.map(file => fs.readFileSync(file));
                const beforeTampering = fs.readFileSync(timelinePath);
                for (const change of ['remediation', 'timestamp']) {
                    const altered = JSON.parse(laneBytes[0].toString('utf8')) as {
                        created_at_utc: string; items: Array<{ remediation: string }>;
                    };
                    if (change === 'timestamp') {
                        altered.created_at_utc = new Date(Date.parse(altered.created_at_utc) + 1_000).toISOString();
                    } else altered.items[0].remediation = 'Different remediation after the accepted review.';
                    fs.writeFileSync(lanePaths[0], JSON.stringify(altered, null, 2) + '\n');
                    try {
                        const tampered = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                        assert.notEqual(tampered.exitCode, 0, change);
                        assert.match([...tampered.errors, ...tampered.logs].join('\n'), /differs from the canonical first publication/u);
                        assert.deepEqual(fs.readFileSync(timelinePath), beforeTampering);
                        assert.deepEqual(fs.readFileSync(queuePath), queueAfter);
                    } finally {
                        fs.writeFileSync(lanePaths[0], laneBytes[0]);
                    }
                }
                const guardedInputs = [
                    ['receipt', receiptPath], ['disposition', dispositionPath], ['validation', validationPath]
                ] as const;
                for (const [kind, sourcePath] of guardedInputs) {
                    const sourceBytes = fs.readFileSync(sourcePath);
                    const race = context.mock.method(events, 'appendMandatoryTaskEvent',
                        (...args: Parameters<typeof originalAppend>) => {
                            if (args[2] === 'REVIEW_FOLLOW_UP_CHILD_PUBLISHED') fs.appendFileSync(sourcePath, '\n');
                            return originalAppend(...args);
                        });
                    try {
                        const changed = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                        assert.notEqual(changed.exitCode, 0);
                        assert.match([...changed.errors, ...changed.logs].join('\n'), new RegExp(kind + ' changed before publication', 'u'));
                        assert.deepEqual(fs.readFileSync(timelinePath), beforeTampering);
                        assert.deepEqual(fs.readFileSync(queuePath), queueAfter);
                        assert.deepEqual(lanePaths.map(file => fs.readFileSync(file)), laneBytes);
                    } finally {
                        race.mock.restore();
                        fs.writeFileSync(sourcePath, sourceBytes);
                    }
                }
                const parentStatusRace = context.mock.method(events, 'appendMandatoryTaskEvent',
                    (...args: Parameters<typeof originalAppend>) => {
                        if (args[2] === 'REVIEW_FOLLOW_UP_CHILD_PUBLISHED') {
                            assert.equal(syncTaskQueueStatusDetailed(repoRoot, taskId, 'BLOCKED').outcome, 'updated');
                        }
                        return originalAppend(...args);
                    });
                try {
                    const changed = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                    assert.notEqual(changed.exitCode, 0);
                    assert.match([...changed.errors, ...changed.logs].join('\n'), /requires a unique canonical parent in IN_REVIEW/u);
                    assert.equal(readTaskQueueStatus(repoRoot, taskId), 'BLOCKED');
                    assert.deepEqual(fs.readFileSync(timelinePath), beforeTampering);
                    assert.deepEqual(lanePaths.map(file => fs.readFileSync(file)), laneBytes);
                } finally {
                    parentStatusRace.mock.restore();
                    assert.equal(syncTaskQueueStatusDetailed(repoRoot, taskId, 'IN_REVIEW').outcome, 'updated');
                }
                assert.deepEqual(fs.readFileSync(queuePath), queueAfter);
                const stagedChildId = taskId + '-F1';
                const stagedChild = queueAfter.toString('utf8').split('\n').find(line => line.startsWith(`| ${stagedChildId} `));
                assert.ok(stagedChild);
                const competingQueues = [
                    stagedChild, stagedChild.replace(stagedChildId, taskId + '-f1'),
                    stagedChild.replace(stagedChildId, taskId + '-F2'), `| ${taskId}-F2 | TODO |`
                ].map(row => formatActiveTaskQueueTable(queueAfter.toString('utf8').trimEnd() + '\n' + row));
                for (const competingQueue of competingQueues) {
                    const competingChild = context.mock.method(events, 'appendMandatoryTaskEvent',
                        (...args: Parameters<typeof originalAppend>) => {
                            if (args[2] === 'REVIEW_FOLLOW_UP_CHILD_PUBLISHED') {
                                assert.ok(!fs.existsSync(queueLockPath));
                                withLock(queuePath, message => assert.fail(message), () => fs.writeFileSync(queuePath, competingQueue));
                            }
                            return originalAppend(...args);
                        });
                    try {
                        const rejected = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                        assert.notEqual(rejected.exitCode, 0);
                        assert.match([...rejected.errors, ...rejected.logs].join('\n'), /queue bindings changed before recording publication/u);
                        assert.equal(fs.readFileSync(queuePath, 'utf8'), competingQueue);
                        assert.deepEqual(fs.readFileSync(timelinePath), beforeTampering);
                        assert.deepEqual(lanePaths.map(file => fs.readFileSync(file)), laneBytes);
                    } finally {
                        competingChild.mock.restore();
                        fs.writeFileSync(queuePath, queueAfter);
                    }
                }
                const publicationLockOrder = context.mock.method(events, 'appendMandatoryTaskEvent',
                    (...args: Parameters<typeof originalAppend>) => {
                        if (args[2] !== 'REVIEW_FOLLOW_UP_CHILD_PUBLISHED') return originalAppend(...args);
                        assert.ok(!fs.existsSync(queueLockPath));
                        const guard = args[6]?.withCanonicalAppend;
                        assert.ok(guard);
                        args[6] = { ...args[6], withCanonicalAppend: append => guard(() => {
                            assert.ok(fs.existsSync(eventLockPath));
                            assert.ok(fs.existsSync(queueLockPath));
                            append();
                        }) };
                        return originalAppend(...args);
                    });
                const materialized = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                publicationLockOrder.mock.restore();
                assert.equal(materialized.exitCode, 0, [...materialized.errors, ...materialized.logs].join('\n'));
                const retry = await runCliWithCapturedOutput(materializationArgs, { cwd: repoRoot });
                assert.equal(retry.exitCode, 0, [...retry.errors, ...retry.logs].join('\n'));
                assert.deepEqual(fs.readFileSync(queuePath), queueAfter);
                assert.deepEqual(lanePaths.map(file => fs.readFileSync(file)), laneBytes);
                assert.equal(fs.readFileSync(timelinePath, 'utf8').match(/"event_type":"REVIEW_FOLLOW_UP_CHILD_PUBLISHED"/gu)?.length, 1);
                assert.equal(resolveNextStep({ repoRoot, taskId }).next_gate, 'task-audit-summary');
                for (const competingQueue of competingQueues) {
                    fs.writeFileSync(queuePath, competingQueue);
                    try {
                        const blockedAudit = buildTaskAuditSummary({ taskId, repoRoot, reviewsRoot: fixture.reviewsRoot });
                        assert.notEqual(blockedAudit.status, 'PASS');
                    } finally {
                        fs.writeFileSync(queuePath, queueAfter);
                    }
                }
                const closeout = require('../../../../../src/gates/task-audit/task-audit-summary-closeout-sync') as typeof import('../../../../../src/gates/task-audit/task-audit-summary-closeout-sync');
                const closeoutArgs = ['gate', 'task-audit-summary', '--task-id', taskId, '--repo-root', repoRoot];
                let changedQueue = false;
                const queueRace = context.mock.method(queue, 'withTaskQueueStatusSyncLock',
                    (...[taskPath, onLockFailure, operation]: Parameters<typeof withLock>) => withLock(taskPath, onLockFailure, () => {
                        if (!changedQueue) {
                            changedQueue = true;
                            assert.equal(syncTaskQueueStatusDetailed(repoRoot, taskId, 'BLOCKED').outcome, 'updated');
                        }
                        return operation();
                    }));
                const raced = await runCliWithCapturedOutput(closeoutArgs, { cwd: repoRoot });
                queueRace.mock.restore();
                assert.notEqual(raced.exitCode, 0);
                assert.match([...raced.errors, ...raced.logs].join('\n'), /could not advance the current queue status: BLOCKED/u);
                assert.equal(readTaskQueueStatus(repoRoot, taskId), 'BLOCKED');
                assert.equal(syncTaskQueueStatusDetailed(repoRoot, taskId, 'IN_REVIEW').outcome, 'updated');
                const canonicalWriter = closeout.synchronizeFinalCloseoutArtifacts;
                const tamperReport = context.mock.method(closeout, 'synchronizeFinalCloseoutArtifacts',
                    (...args: Parameters<typeof canonicalWriter>) => {
                        const written = canonicalWriter(...args);
                        fs.appendFileSync(written.final_closeout.artifact_paths.final_user_report!, '\nModified before DONE.\n');
                        return written;
                    });
                const changedReport = await runCliWithCapturedOutput(closeoutArgs, { cwd: repoRoot });
                tamperReport.mock.restore();
                assert.notEqual(changedReport.exitCode, 0);
                assert.match([...changedReport.errors, ...changedReport.logs].join('\n'), /differ from the canonical rendered report/u);
                assert.equal(readTaskQueueStatus(repoRoot, taskId), 'IN_REVIEW');
                assert.doesNotMatch(fs.readFileSync(timelinePath, 'utf8'), /"new_status":"DONE"/u);
                const failure = context.mock.method(closeout, 'synchronizeFinalCloseoutArtifacts', () => {
                    const other = syncTaskQueueStatusDetailed(repoRoot, unrelatedTaskId, 'BLOCKED');
                    assert.equal(other.outcome, 'updated');
                    throw new Error('Injected final report publication failure.');
                });
                driftProtected();
                const staleAudit = await runCliWithCapturedOutput(closeoutArgs, { cwd: repoRoot });
                restoreProtected();
                assert.notEqual(staleAudit.exitCode, 0);
                assert.match([...staleAudit.errors, ...staleAudit.logs].join('\n'), /completion evidence changed before final audit/u);
                assert.deepEqual(fs.readFileSync(queuePath), queueAfter);
                const failed = await runCliWithCapturedOutput(closeoutArgs, { cwd: repoRoot });
                failure.mock.restore();
                assert.notEqual(failed.exitCode, 0);
                assert.match([...failed.errors, ...failed.logs].join(' '), /Injected final report publication failure/u);
                assert.equal(resolveNextStep({ repoRoot, taskId }).next_gate, 'task-audit-summary');
                assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(taskId + '-F1'));
                assert.equal(readTaskQueueStatus(repoRoot, unrelatedTaskId), 'BLOCKED');
                const interruptedDone = syncTaskQueueStatusDetailed(repoRoot, taskId, 'DONE');
                assert.equal(interruptedDone.outcome, 'updated');
                const resumedFailure = context.mock.method(closeout, 'synchronizeFinalCloseoutArtifacts', () => {
                    throw new Error('Injected report failure while resuming queue-only DONE.');
                });
                const failedResume = await runCliWithCapturedOutput(closeoutArgs, { cwd: repoRoot });
                resumedFailure.mock.restore();
                assert.notEqual(failedResume.exitCode, 0);
                assert.match([...failedResume.errors, ...failedResume.logs].join(' '), /resuming queue-only DONE/u);
                assert.equal(readTaskQueueStatus(repoRoot, taskId), 'IN_REVIEW');
                assert.equal(readTaskQueueStatus(repoRoot, unrelatedTaskId), 'BLOCKED');
                assert.doesNotMatch(fs.readFileSync(timelinePath, 'utf8'), /"new_status":"DONE"/u);

                const afterStatus = spawnSync(process.execPath, ['-e', [
                    'const [eventModule, cliModule, queueLockPath, eventLockPath, ...args] = process.argv.slice(1);',
                    'const fs = require("node:fs");',
                    'const events = require(eventModule);',
                    'const append = events.appendMandatoryTaskEvent;',
                    'events.appendMandatoryTaskEvent = function(...eventArgs) {',
                    '    if (eventArgs[2] !== "STATUS_CHANGED" || !eventArgs[5]?.grouped_closeout) return append(...eventArgs);',
                    '    if (fs.existsSync(queueLockPath)) process.exit(46);',
                    '    const guard = eventArgs[6]?.withCanonicalAppend;',
                    '    if (!guard) process.exit(47);',
                    '    eventArgs[6].withCanonicalAppend = write => guard(() => {',
                    '        if (!fs.existsSync(eventLockPath) || !fs.existsSync(queueLockPath)) process.exit(48);',
                    '        write();',
                    '    });',
                    '    append(...eventArgs);',
                    '    process.exit(45);',
                    '};',
                    'void require(cliModule).runCliMainWithHandling(args);'
                ].join('\n'), require.resolve('../../../../../src/gate-runtime/timeline/task-events-io'),
                    require.resolve('../../../../../src/cli/main'), queueLockPath, eventLockPath, ...closeoutArgs],
                { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
                assert.equal(afterStatus.status, 45, afterStatus.error?.message || afterStatus.stderr);
                assert.equal(readTaskQueueStatus(repoRoot, taskId), 'DONE');
                const terminalTimeline = fs.readFileSync(timelinePath);
                assert.match(terminalTimeline.toString('utf8'), /"new_status":"DONE","grouped_closeout":/u);
                const reportPath = path.join(fixture.reviewsRoot, taskId + '-final-user-report.md');
                const committedReport = fs.readFileSync(reportPath);
                assert.match(committedReport.toString('utf8'), /passed with follow-up/u);
                assert.ok(!fs.existsSync(resolveTaskHistoryLedgerPath(orchestratorRoot, taskId)));
                const ledgerRecoveryRoute = resolveNextStep({ repoRoot, taskId });
                assert.equal(ledgerRecoveryRoute.next_gate, 'task-audit-summary', ledgerRecoveryRoute.reason);
                assert.match(ledgerRecoveryRoute.commands[0]?.command || '', /gate task-audit-summary/u);
                const writeReport = context.mock.method(closeout, 'synchronizeFinalCloseoutArtifacts', () => {
                    throw new Error('An interrupted terminal audit must reuse its already committed report.');
                });
                const published = await runCliWithCapturedOutput(closeoutArgs, { cwd: repoRoot });
                assert.equal(writeReport.mock.callCount(), 0);
                writeReport.mock.restore();
                assert.equal(published.exitCode, 0, [...published.logs, ...published.errors].join('\n'));
                assert.deepEqual(fs.readFileSync(reportPath), committedReport);
                assert.deepEqual(fs.readFileSync(timelinePath), terminalTimeline);
                const ledger = JSON.parse(fs.readFileSync(resolveTaskHistoryLedgerPath(orchestratorRoot, taskId), 'utf8')) as {
                    lifecycle: { queue_status: string };
                    artifact_refs: { task_events: { sha256: string } };
                };
                assert.equal(ledger.lifecycle.queue_status, 'DONE');
                assert.equal(ledger.artifact_refs.task_events.sha256, createHash('sha256').update(terminalTimeline).digest('hex'));
            }
            const finalAudit = runTaskAuditSummaryCommand({ taskId, repoRoot, reviewsRoot: fixture.reviewsRoot });
            assert.match(finalAudit.rendered, /Review findings audit: status=CLEAR/u);
            assert.match(finalAudit.rendered, /\[\+\] completion-gate/u);
            const audit = buildTaskAuditSummary({ taskId, repoRoot, reviewsRoot: fixture.reviewsRoot });
            assert.equal(audit.review_findings_audit?.status, 'CLEAR');
            if (deferred) {
                assert.equal(audit.review_findings_audit?.finding_count, 2);
                const reportBody = fs.readFileSync(path.join(fixture.reviewsRoot, taskId + '-final-user-report.md'), 'utf8');
                assert.match(reportBody, /passed with follow-up/u);
                assert.equal(reportBody.split('\n').filter(line => line.trim() === taskId + '-F1').length, 1);
                const taskRows = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').split('\n');
                assert.equal(taskRows.filter(line => new RegExp('^\\| ' + taskId + '-F[0-9]+ ').test(line)).length, 1);
                for (const laneType of ['code', 'refactor']) {
                    const artifact = JSON.parse(fs.readFileSync(path.join(fixture.reviewsRoot,
                        taskId + '-' + laneType + '-findings-follow-ups.json'), 'utf8'));
                    assert.equal(artifact.items.filter((item: { task_id: string }) => item.task_id === taskId + '-F1').length, 1);
                }
                assert.equal(resolveNextStep({ repoRoot, taskId }).status, 'DONE');

                const closeoutPaths = audit.final_closeout.artifact_paths;
                const canonicalFiles = [closeoutPaths.json, closeoutPaths.markdown, closeoutPaths.final_user_report!,
                    resolveTaskHistoryLedgerPath(orchestratorRoot, taskId), path.join(repoRoot, 'TASK.md'),
                    path.join(orchestratorRoot, 'runtime', 'task-events', taskId + '.jsonl')];
                const canonicalBytes = canonicalFiles.map(file => fs.readFileSync(file));
                const alternateEventsRoot = path.join(repoRoot, 'alternate-events');
                fs.mkdirSync(alternateEventsRoot);
                const alternateAudit = await runCliWithCapturedOutput(['gate', 'task-audit-summary', '--task-id', taskId,
                    '--repo-root', repoRoot, '--events-root', alternateEventsRoot, '--as-json'], { cwd: repoRoot });
                assert.notEqual(alternateAudit.exitCode, 0);
                assert.doesNotThrow(() => JSON.parse(alternateAudit.logs.join('\n')));
                assert.deepEqual(canonicalFiles.map(file => fs.readFileSync(file)), canonicalBytes);
            } else {
                assert.equal(audit.review_findings_audit?.finding_count, 0);
            }
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('passes required reviews and completion with a recorded grouped follow-up lane recovery event', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-45-recovery-e2e';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            const orchestratorRoot = getOrchestratorRoot(repoRoot);
            appendTaskEvent(orchestratorRoot, taskId, 'IMPLEMENTATION_STARTED', 'INFO', 'E2E fixture implementation started.', {});
            writeCompilePassEvidence(repoRoot, taskId, fixture.preflightPath);
            appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'E2E fixture review started.', {
                review_type: 'code'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'E2E fixture selected review skill.', {
                skill_id: 'code-review'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'E2E fixture loaded review skill.', {
                reference_path: '/live/skills/code-review/SKILL.md'
            });
            appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'E2E fixture routed reviewer.', {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: fixture.reviewerIdentity,
                reviewer_fallback_reason: null,
                delegation_used: true
            });
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: fixture.reviewContextPath,
                reviewerIdentity: fixture.reviewerIdentity
            });
            const outputPath = reviewOutputPath(repoRoot, taskId);
            fs.writeFileSync(
                outputPath,
                `${JSON.stringify(buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId), null, 2)}\n`,
                'utf8'
            );
            const recorded = await runCliWithCapturedOutput([
                'gate', 'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', outputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });
            assert.equal(recorded.exitCode, 0, recorded.errors.join('\n'));
            // The operator-confirmed grouped follow-up recovery event must not disturb closeout gates.
            appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_FOLLOW_UP_LANES_RECOVERED', 'PASS',
                'Operator-confirmed never-materialized review lanes were bound to the current grouped follow-up task.', {
                    task_id: taskId, child_task_id: `${taskId}-F1`, recovered_review_types: ['api'],
                    batch_review_types: ['api', 'code'], operator_confirmed_at_utc: new Date().toISOString()
                });

            const reviewGate = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath: fixture.preflightPath,
                codeReviewVerdict: 'REVIEW PASSED',
                reviewAuthorshipAttestationJson: '{"code":true}',
                outputFiltersPath: writeBudgetOutputFilters(repoRoot),
                emitMetrics: false
            });
            assert.equal(reviewGate.exitCode, 0, reviewGate.outputLines.join('\n'));
            const docImpact = runDocImpactGateCommand({
                repoRoot,
                taskId,
                preflightPath: fixture.preflightPath,
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                rationale: 'Findings-only end-to-end regression adds no documentation behavior.',
                emitMetrics: false
            });
            assert.equal(docImpact.exitCode, 0, docImpact.outputLines.join('\n'));
            const completion = await runCliWithCapturedOutput([
                'gate', 'completion-gate',
                '--task-id', taskId,
                '--preflight-path', fixture.preflightPath,
                '--repo-root', repoRoot
            ], { cwd: repoRoot });
            assert.equal(completion.exitCode, 0, [...completion.errors, ...completion.logs].join('\n'));

        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('audits evidence-only F-000 without materializing follow-up work', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-44-evidence-only-e2e';
        const focusedTarget = 'tests/node/example.test.ts';
        try {
            fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, focusedTarget), 'export {};\n', 'utf8');
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            await launchAuthenticatedReviewer(fixture);
            const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
                coverage_contract: { obligations: Array<{ id: string }> };
                task_scope: { changed_files: string[] };
                full_suite_validation: unknown;
            };
            const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as {
                effective_review_snapshot: {
                    review_dependency_graph: { full_suite_barrier: { enabled: boolean } };
                };
            };
            assert.equal(preflight.effective_review_snapshot.review_dependency_graph.full_suite_barrier.enabled, false);
            assert.equal(reviewContext.full_suite_validation, null);
            const report = buildNoFindingsJsonReviewReport(fixture.reviewContextPath, taskId);
            const coverageLedger = report.coverage_ledger as {
                entries: Array<{ finding_ids: string[] }>;
            };
            coverageLedger.entries[0].finding_ids = ['F-000'];
            const marker =
                `[garda:evidence-only:missing-focused-validation] test=${focusedTarget}; `
                + 'action=run-and-record-focused-test';
            (report.validation_notes as Array<Record<string, unknown>>).push({
                id: 'N-002',
                topic: 'focused-self-validation',
                note: 'The reviewer attempted the smallest relevant focused test after prior execution evidence was unavailable.',
                command: `node --test ${focusedTarget}`,
                command_outcome: 'unavailable',
                diagnostics: 'The isolated reviewer environment did not provide the runtime needed to execute the focused test.',
                evidence: [{
                    location: `${reviewContext.task_scope.changed_files[0]}:1`,
                    observation: `The changed implementation is covered by ${focusedTarget}, which motivated the focused attempt.`
                }]
            });
            (report.findings as { high: Array<Record<string, unknown>> }).high = [{
                id: 'F-000',
                title: marker,
                description: marker,
                evidence: [{
                    location: `${reviewContext.task_scope.changed_files[0]}:1`,
                    observation: 'The unavailable focused check remains audit evidence only.'
                }],
                coverage_obligation_ids: [reviewContext.coverage_contract.obligations[0].id]
            }];

            const outputPath = reviewOutputPath(repoRoot, taskId);
            fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
            const recorded = await runCliWithCapturedOutput([
                'gate', 'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', outputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });
            assert.equal(recorded.exitCode, 0, recorded.errors.join('\n'));

            const receipt = JSON.parse(
                fs.readFileSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
            );
            assert.deepEqual(receipt.review_coverage.finding_ids, ['F-000']);
            assert.equal(receipt.review_findings_disposition.verdict, 'pass_no_findings');
            assert.equal(receipt.review_findings_disposition.total_count, 0);
            assert.equal(receipt.review_findings_disposition.blocking_count, 0);

            const disposition = JSON.parse(
                fs.readFileSync(
                    path.join(fixture.reviewsRoot, `${taskId}-code-findings-disposition.json`),
                    'utf8'
                )
            ) as { items: unknown[] };
            assert.deepEqual(disposition.items, []);
            const materialized = materializeReviewFindingsFollowUpTasks({
                repoRoot,
                taskId,
                reviewType: 'code'
            });
            assert.equal(materialized.status, 'NOT_REQUIRED', materialized.violations.join('\n'));
            assert.deepEqual(materialized.created_task_ids, []);

            const audit = buildTaskAuditSummary({ taskId, repoRoot, reviewsRoot: fixture.reviewsRoot });
            assert.equal(audit.review_findings_audit?.status, 'CLEAR');
            assert.equal(audit.review_findings_audit?.finding_count, 1);
            assert.equal(audit.review_findings_audit?.remaining_blocker_count, 0);
            const evidenceOnlyFinding = audit.review_findings_audit?.lanes
                .flatMap((lane) => lane.findings)
                .find((finding) => finding.id === 'F-000');
            assert.equal(evidenceOnlyFinding?.action, null);
            assert.equal(evidenceOnlyFinding?.materialization_status, null);
            assert.equal(evidenceOnlyFinding?.follow_up_task_id, null);
            assert.equal(evidenceOnlyFinding?.blocking, false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('binds mixed dispositions to selective recovery and rejects tampered follow-up evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-44-mixed-e2e';
        try {
            const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
            await launchAuthenticatedReviewer(fixture);
            const report = buildFailedJsonReviewReport(fixture.reviewContextPath, taskId);
            const context = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as {
                coverage_contract: { obligations: Array<{ id: string }> };
                task_scope: { changed_files: string[] };
            };
            const ledger = report.coverage_ledger as { entries: Array<{ finding_ids: string[] }> };
            ledger.entries[0].finding_ids.push('F-002');
            (report.findings as { low: Array<Record<string, unknown>> }).low = [{
                id: 'F-002',
                title: 'Deferred hardening follow-up',
                description: 'A bounded non-blocking hardening item must be grouped after fix-now remediation.',
                evidence: [{
                    location: `${context.task_scope.changed_files[0]}:1`,
                    observation: 'The low-severity item remains bound to the authenticated review scope.'
                }],
                coverage_obligation_ids: [context.coverage_contract.obligations[0].id]
            }];
            const outputPath = reviewOutputPath(repoRoot, taskId);
            fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
            const recorded = await runCliWithCapturedOutput([
                'gate', 'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', fixture.preflightPath,
                '--review-output-path', outputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ], { cwd: repoRoot });
            assert.equal(recorded.exitCode, 0, recorded.errors.join('\n'));

            const dispositionPath = path.join(fixture.reviewsRoot, `${taskId}-code-findings-disposition.json`);
            const disposition = JSON.parse(fs.readFileSync(dispositionPath, 'utf8'));
            assert.equal(disposition.disposition_result.findings.high.action, 'fix_now');
            assert.equal(disposition.disposition_result.findings.low.action, 'create_follow_up');
            const blocked = materializeReviewFindingsFollowUpTasks({ repoRoot, taskId, reviewType: 'code' });
            assert.equal(blocked.status, 'BLOCKED');
            assert.match(blocked.output_lines.join('\n'), /fix_now/iu);

            const baselinePath = path.join(fixture.reviewsRoot, `${taskId}-code-remediation-baseline.json`);
            const baselineSha256 = createHash('sha256').update(fs.readFileSync(baselinePath)).digest('hex');
            fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const remediated = true;\n', 'utf8');
            const delta = classifyReviewRemediationDelta({
                repoRoot,
                taskId,
                reviewType: 'code',
                baselineArtifactPath: baselinePath,
                baselineArtifactSha256: baselineSha256,
                currentChangedFiles: ['src/app.ts'],
                structuralTestChangedLinesThreshold: 20
            });
            assert.equal(delta.category, 'production');
            const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
            const policy = resolveReviewRemediationRerunPolicyFromSnapshot(preflight.profile_policy_snapshot).policy;
            const rerun = resolveReviewRemediationRerunLanes({
                policy,
                category: delta.category,
                currentReviewType: 'code',
                requiredReviews: preflight.required_reviews,
                reviewExecutionPolicyMode: 'strict_sequential'
            });
            assert.deepEqual(rerun.ordered_rerun_lanes, ['code']);

            disposition.items[0].action = 'ignore';
            fs.writeFileSync(dispositionPath, `${JSON.stringify(disposition, null, 2)}\n`, 'utf8');
            const tampered = materializeReviewFindingsFollowUpTasks({ repoRoot, taskId, reviewType: 'code' });
            assert.equal(tampered.status, 'BLOCKED');
            assert.ok(
                tampered.violations.some((violation) => /hash|match|binding/iu.test(violation)),
                tampered.output_lines.join('\n')
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps a decomposed parent open until a materialized residual-risk follow-up completes', async () => {
        const repoRoot = createTempRepo();
        const parentTaskId = 'T-979-e2e-parent';
        const childTaskId = 'T-979-e2e-child';
        const unrelatedParentTaskId = 'T-979-e2e-unrelated-parent';
        const unrelatedTaskId = 'T-979-e2e-unrelated';
        try {
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
                '## Active Queue',
                '',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '|---|---|---|---|---|---|---|---|---|',
                `| ${parentTaskId} | DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-07-23 | default | Execute child tasks \`${childTaskId}\` through normal gates. |`,
                `| ${childTaskId} | IN_PROGRESS | P1 | workflow | Child | gpt-5.5 | 2026-07-23 | default | Child of \`${parentTaskId}\`. |`,
                `| ${unrelatedParentTaskId} | DECOMPOSED | P1 | workflow | Unrelated parent | gpt-5.5 | 2026-07-23 | default | Review follow-up tasks materialized: \`${unrelatedTaskId}\`. |`,
                `| ${unrelatedTaskId} | DONE | P1 | workflow | Unrelated task | gpt-5.5 | 2026-07-23 | default | Complete. |`,
                ''
            ].join('\n'), 'utf8');
            seedInitAnswers(repoRoot, 'Codex');
            runEnterTaskMode({ repoRoot, taskId: childTaskId, taskSummary: 'Materialize one grouped review follow-up.' });
            const unrelatedClosure = syncDecomposedParentsToDone(
                repoRoot,
                unrelatedParentTaskId,
                [unrelatedParentTaskId]
            );
            assert.equal(unrelatedClosure.outcome, 'write_failed');
            assert.match(unrelatedClosure.error_message || '', /no longer has explicit child task links/iu);
            const preflightPath = writePreflight(repoRoot, childTaskId, {
                scope_category: 'code',
                required_reviews: { code: true }
            });
            writeReceiptBackedReviewArtifact(
                repoRoot,
                childTaskId,
                'code',
                'REVIEW FAILED',
                undefined,
                { findingSeverity: null, residualRisk: true }
            );
            const materialized = materializeReviewFindingsFollowUpTasks({
                repoRoot,
                taskId: childTaskId,
                reviewType: 'code'
            });
            assert.equal(materialized.status, 'MATERIALIZED', materialized.violations.join('\n'));
            const followUpTaskId = materialized.created_task_ids[0];
            assert.ok(followUpTaskId);
            const followUpArtifact = JSON.parse(fs.readFileSync(materialized.artifact_path, 'utf8')) as {
                items: Array<{ source_item_kind: string }>;
            };
            assert.deepEqual(
                [...new Set(followUpArtifact.items.map((item) => item.source_item_kind))],
                ['residual_risk']
            );
            assert.equal(syncTaskQueueStatusDetailed(repoRoot, childTaskId, 'DONE').outcome, 'updated');

            const premature = syncDecomposedParentsToDone(repoRoot, parentTaskId, [parentTaskId]);
            assert.equal(premature.outcome, 'write_failed');
            assert.match(premature.error_message || '', new RegExp(`${followUpTaskId} \\((?:🟦 )?TODO\\)`, 'u'));

            const followUpPreflightPath = writePreflight(repoRoot, followUpTaskId, {
                scope_category: 'code',
                required_reviews: {
                    code: true,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                }
            });
            prepareCurrentReviewPhase(repoRoot, followUpTaskId, followUpPreflightPath);
            appendTaskEvent(
                getOrchestratorRoot(repoRoot),
                followUpTaskId,
                'IMPLEMENTATION_STARTED',
                'INFO',
                'E2E residual-risk follow-up implementation started.',
                {}
            );
            writeCompilePassEvidence(repoRoot, followUpTaskId, followUpPreflightPath);
            writeReceiptBackedReviewArtifact(repoRoot, followUpTaskId, 'code', 'REVIEW PASSED');
            const followUpReviewGate = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId: followUpTaskId,
                preflightPath: followUpPreflightPath,
                codeReviewVerdict: 'REVIEW PASSED',
                reviewAuthorshipAttestationJson: '{"code":true}',
                outputFiltersPath: writeBudgetOutputFilters(repoRoot),
                emitMetrics: false
            });
            assert.equal(followUpReviewGate.exitCode, 0, followUpReviewGate.outputLines.join('\n'));
            const followUpDocImpact = runDocImpactGateCommand({
                repoRoot,
                taskId: followUpTaskId,
                preflightPath: followUpPreflightPath,
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                rationale: 'Residual-risk follow-up closure fixture changes no documentation.',
                emitMetrics: false
            });
            assert.equal(followUpDocImpact.exitCode, 0, followUpDocImpact.outputLines.join('\n'));
            const followUpCompletion = await runCliWithCapturedOutput([
                'gate', 'completion-gate',
                '--task-id', followUpTaskId,
                '--preflight-path', followUpPreflightPath,
                '--repo-root', repoRoot
            ], { cwd: repoRoot });
            assert.equal(
                followUpCompletion.exitCode,
                0,
                [...followUpCompletion.errors, ...followUpCompletion.logs].join('\n')
            );
            assert.match(
                fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'),
                new RegExp(`\\|\\s*${parentTaskId}\\s*\\|\\s*(?:🟩\\s*)?DONE\\s*\\|`, 'u')
            );

            const audit = buildTaskAuditSummary({
                taskId: childTaskId,
                repoRoot,
                reviewsRoot: getReviewsRoot(repoRoot)
            });
            assert.equal(audit.review_findings_audit?.status, 'CLEAR');
            assert.equal(audit.review_findings_audit?.remaining_blocker_count, 0);
            assert.equal(fs.existsSync(preflightPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
