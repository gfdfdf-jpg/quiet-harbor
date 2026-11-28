import { resolveRestartTaskIntent } from '../../../../gates/review-context/review-context-task-criteria-binding';
import { prepareOperatorTaskIntentUpdate, recordOperatorTaskIntentUpdate } from '../../../../gates/review-context/review-context-task-intent';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    type CompileGateCommandOptions
} from '../compile/compile-flow';
import { buildNextStepRecoveryCommand } from '../compile/compile-flow-shared-evidence';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveDefaultReviewsPath } from '../../../gate-cli/gates-artifacts';
import { parseBooleanOption } from '../../../gate-cli/gates-parser';
import { resolveTaskModeEntryScope } from '../task-mode/task-mode-entry-scope';
import { confirmCoherentScopeExpansion, readCoherentScopePredecessor } from '../task-mode/task-mode-coherent-scope-approval';
import { taskIntentSha256 } from '../../../../gates/review-context/review-context-task-intent';
import { MISSING_PENDING_SCOPE_STARTUP, readPendingCoherentScopeStartup, readPendingCoherentScope, coherentScopeRequestSha256,
    recordCoherentScopeIntent, bindCoherentScopeStage, normalizedCoherentRequest } from './recovery-flow-pending-coherent-scope';
import { readProtectedCoherentScope } from '../../../../core/auth/protected-coherent-scope';
import type { TaskEvent } from '../../../../gate-runtime/timeline/task-events-io-types';
import { getRulePackEvidence } from '../../../../gates/rule-pack/rule-pack';
import { isPlainRecord } from '../../../../core/records';
import { acquireFilesystemLockAsync, assertValidTaskId, readTaskEventAppendState, releaseFilesystemLock } from '../../../../gate-runtime/task-events';
import { collectLostRecordedReviewEvidenceTypes } from '../../../../gates/review-remediation/review-evidence-only-restart-scope';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';
import {
    runEnterTaskModeCommand,
    runBindRulePackToPreflightCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from '../task-mode/task-mode-flow';
import { getPostPreflightRulePackRebindDecision } from '../../../../gates/rule-pack/rule-pack';
import {
    getEffectiveDepthFromPreflight,
    getTaskEntryRuleFilesForDepth,
    normalizeRuleFileList,
    resolveReplayScope
} from './recovery-flow-replay-scope';
import { buildCoherentCycleRestartedOutput } from './recovery-flow-rendering';
import type { RestartCoherentCycleCommandOptions } from './recovery-flow-types';
import {
    buildOptionalSkillRebindDetails,
    readRestartOptionalSkillActivationSnapshot,
    readRestartOptionalSkillDeclineSnapshot,
    rebindRestartOptionalSkillActivationsForCurrentCycle,
    rebindRestartOptionalSkillDeclinesForCurrentCycle
} from './recovery-flow-optional-skills';
import {
    appendRestartCompletedEvidence,
    collectRequiredRestartReviewTypes,
    ensureRestartStepPassed,
    resolveRecoveryPreflightPath,
    resolveRestartAllowedDirtyWorkflowConfigFiles,
    toNonNegativeRestartCount
} from './recovery-flow-restart-evidence';
import { runRecoveryFlowTaskModePipeline } from './recovery-flow-preflight-pipeline';
import { readInterruptedCoherentCycleReadiness, readInterruptedCompileRecovery } from './recovery-flow-interrupted-coherent-cycle';
import { resolveReviewRestartApproval } from './recovery-flow-review-restart-approval';
import { readUnrequiredCoherentRestart } from './recovery-flow-restart-requirement';
import { readRestartPreflightIntentViolation } from './recovery-flow-restart-intent-binding';

export async function runRestartCoherentCycleCommand(
    options: RestartCoherentCycleCommandOptions
): Promise<{ outputLines: string[]; exitCode: number }> {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(String(options.taskId ?? '').trim());
    const lockPath = path.join(resolveOrchestratorRoot(repoRoot), 'runtime', 'task-events', `.${taskId}.coherent-scope-restart.lock`);
    const { handle } = await acquireFilesystemLockAsync(lockPath, {});
    try {
        if (options.resumePendingScope === undefined) return await runCoherentCycleRestart(options);
        if (Object.keys(options).some(key => !['repoRoot', 'taskId', 'resumePendingScope'].includes(key)
            && options[key as keyof RestartCoherentCycleCommandOptions] !== undefined))
            throw new Error('Resume the protected pending scope without additional recovery arguments.');
        const state = readProtectedCoherentScope(repoRoot, taskId);
        if (!state || state.revoked_by_reset || state.ended_by || state.admission.request_sha256 !== options.resumePendingScope
            || !isPlainRecord(state.admission.request))
            throw new Error('The requested protected coherent scope is missing, changed or already ended. Run next-step.');
        return await runCoherentCycleRestart({ ...state.admission.request, taskId, repoRoot });
    } catch (error) {
        return { exitCode: EXIT_GATE_FAILURE, outputLines: [
            'COHERENT_CYCLE_RESTART_REFUSED', `TaskId: ${taskId}`,
            error instanceof Error ? error.message : String(error),
            `Recovery: ${buildNextStepRecoveryCommand(repoRoot, taskId)}`
        ] };
    } finally {
        releaseFilesystemLock(handle);
    }
}

async function runCoherentCycleRestart(
    options: RestartCoherentCycleCommandOptions
): Promise<{ outputLines: string[]; exitCode: number }> {
    const startedAt = Date.now();
    const {
        repoRoot,
        resolvedTaskId,
        timelinePath,
        previousTaskMode,
        resolvedTaskModePath,
        resolvedPreflightPath
    } = runRecoveryFlowTaskModePipeline(options);
    const scopeBinding = { repoRoot, taskId: resolvedTaskId, taskModePath: resolvedTaskModePath,
        plannedFiles: previousTaskMode.planned_changed_files };
    const pendingScope = readPendingCoherentScope({ ...scopeBinding, options });
    // Until classification is bound, a retry uses only the authenticated replay scope and can recreate its output.
    const previousPreflight = pendingScope ? null : getPreflightContext(resolvedPreflightPath, resolvedTaskId);
    if (pendingScope?.preflightPath) getPreflightContext(resolvedPreflightPath, resolvedTaskId);
    const expansion = options.plannedChangedFiles?.length
        ? resolveTaskModeEntryScope(repoRoot, options.plannedChangedFiles).plannedChangedFiles : null;
    const predecessor = expansion && !pendingScope ? readCoherentScopePredecessor({ repoRoot, taskId: resolvedTaskId,
        taskMode: previousTaskMode, taskModePath: resolvedTaskModePath, preflightPath: resolvedPreflightPath }) : null;
    // Refuse before any state change: a write after REVIEW_GATE_PASSED reopens reviews only with the user's approval.
    const readReviewRestartApproval = () => resolveReviewRestartApproval({
            repoRoot,
            taskId: resolvedTaskId,
            preflightPath: resolvedPreflightPath,
            taskMode: previousTaskMode as unknown as Record<string, unknown>,
            approved: options.reviewRestartApproved,
            approvedAtUtc: options.reviewRestartApprovedAtUtc
        });
    let reviewRestartApproval: ReturnType<typeof resolveReviewRestartApproval> | null = null;
    try {
        if (!pendingScope) reviewRestartApproval = readReviewRestartApproval();
    } catch (error: unknown) {
        return {
            outputLines: [
                'COHERENT_CYCLE_RESTART_REFUSED',
                `TaskId: ${resolvedTaskId}`,
                error instanceof Error ? error.message : String(error)
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
    // Refuse before any state change when the navigator does not route here: an agent that runs this gate
    // by mistake must not roll the task back and pay for a new review cycle.
    const staleIntentViolation = previousPreflight && readRestartPreflightIntentViolation({
        repoRoot, taskId: resolvedTaskId, preflight: previousPreflight.preflight as unknown as Record<string, unknown>
    });
    if (staleIntentViolation) {
        return {
            outputLines: ['COHERENT_CYCLE_RESTART_REFUSED', `TaskId: ${resolvedTaskId}`, staleIntentViolation],
            exitCode: EXIT_GATE_FAILURE
        };
    }
    const previousTaskIntent = previousPreflight ? resolveRestartTaskIntent({
        repoRoot, taskId: resolvedTaskId, preflight: previousPreflight.preflight, taskMode: previousTaskMode
    }) : '';
    const taskSummary = pendingScope?.pending.task_summary ?? String(options.taskIntent || previousTaskIntent || '').trim();
    if (!taskSummary) throw new Error('Task intent could not be resolved for coherent-cycle restart.');
    const operatorIntentUpdate = pendingScope ? pendingScope.pending.intent_update : options.taskIntent ? prepareOperatorTaskIntentUpdate({
        repoRoot, taskId: resolvedTaskId, previousIntent: previousTaskIntent, taskIntent: taskSummary,
        operatorConfirmed: options.operatorConfirmed, operatorConfirmedAtUtc: options.operatorConfirmedAtUtc
    }) : null;
    const unrequiredRestart = operatorIntentUpdate || pendingScope ? null : readUnrequiredCoherentRestart(repoRoot, resolvedTaskId);
    if (unrequiredRestart) {
        return {
            outputLines: [
                'COHERENT_CYCLE_RESTART_REFUSED',
                `TaskId: ${resolvedTaskId}`,
                unrequiredRestart
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
    // Read before any state change: a review whose recorded result was lost repeats in the new cycle instead of
    // coming back through historical reuse of its snapshot (review-context-flow-historical-reuse.ts).
    const lostReviewEvidenceTypes = pendingScope ? [] : collectLostRecordedReviewEvidenceTypes({
        repoRoot, taskId: resolvedTaskId,
        reviewsRoot: path.dirname(resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`))
    });
    const reviewRestartApprovalDetails: Record<string, unknown> = reviewRestartApproval?.required
        ? {
            review_restart_approved: true,
            review_restart_approved_at_utc: reviewRestartApproval.approvedAtUtc,
            review_restart_after_event: reviewRestartApproval.blockingEvent,
            review_restart_changed_files: reviewRestartApproval.changedFilesAfterReviewGate
        }
        : {};
    const replayScope = previousPreflight ? resolveReplayScope(options, previousPreflight, previousTaskMode)
        : pendingScope?.pending.replay_scope;
    if (!replayScope) throw new Error('Coherent restart requires its original preflight or an authenticated replay scope.');
    const scopeApproval = pendingScope?.approval ?? (expansion && predecessor ? {
        approved_at_utc: String(options.operatorConfirmedAtUtc ?? '').trim(),
        added_files: expansion.filter(file => !previousTaskMode.planned_changed_files.includes(file)).sort(),
        task_intent_sha256: taskIntentSha256(resolvedTaskId, taskSummary),
        ...predecessor
    } : null);
    if (scopeApproval && !pendingScope) {
        if (!scopeApproval.added_files.length) throw new Error('Approved scope expansion must add a planned file.');
        confirmCoherentScopeExpansion(options.operatorConfirmed, scopeApproval.approved_at_utc);
        replayScope.plannedChangedFiles = resolveTaskModeEntryScope(repoRoot,
            [...replayScope.plannedChangedFiles, ...scopeApproval.added_files]).plannedChangedFiles;
        const admitted = replayScope.plannedChangedFiles.filter(file => !previousTaskMode.planned_changed_files.includes(file)).sort();
        if (!isDeepStrictEqual(admitted, scopeApproval.added_files))
            throw new Error(`Ask the operator to approve the exact added files and list them with --planned-changed-file: ${admitted.join(', ')}.`);
    }
    const restartDetails = pendingScope?.pending.restart_details ?? {
        ...reviewRestartApprovalDetails,
        ...(lostReviewEvidenceTypes.length ? { lost_review_evidence_types: lostReviewEvidenceTypes } : {})
    };
    const allowedDirtyWorkflowConfigFiles = previousPreflight && previousTaskMode.orchestrator_work === true
        && previousTaskMode.workflow_config_work === true
        ? resolveRestartAllowedDirtyWorkflowConfigFiles(repoRoot, previousPreflight, replayScope.plannedChangedFiles)
        : [];

    const compileEvidencePath = resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`);
    const preservesScope = previousPreflight && (options.changedFiles === undefined || (
        previousPreflight.detection_source === 'explicit_changed_files'
        && isDeepStrictEqual(replayScope.changedFiles, previousPreflight.authorized_files)
    )) && (options.useStaged !== true || replayScope.detectionSource === previousPreflight.detection_source)
        && (options.includeUntracked == null || parseBooleanOption(options.includeUntracked, previousPreflight.include_untracked)
            === previousPreflight.include_untracked);
    const recoveredCompile = preservesScope && !scopeApproval && !operatorIntentUpdate && taskSummary === previousTaskIntent
        && previousTaskMode.orchestrator_work !== true && previousTaskMode.workflow_config_work !== true
        && (!options.preflightOutputPath || path.resolve(repoRoot, options.preflightOutputPath) === path.resolve(resolvedPreflightPath))
        && !parseBooleanOption(options.allowPlanDrift, false)
        ? readInterruptedCompileRecovery({
            repoRoot,
            taskId: resolvedTaskId,
            timelinePath,
            taskMode: previousTaskMode,
            taskModePath: resolvedTaskModePath,
            preflightPath: resolvedPreflightPath,
            compileEvidencePath,
            outputFiltersPath: options.outputFiltersPath
        }) : null;
    const interruptedShellSmoke = !recoveredCompile && !scopeApproval && !operatorIntentUpdate
        ? readInterruptedCoherentCycleReadiness({ repoRoot, taskId: resolvedTaskId, taskModePath: resolvedTaskModePath,
            preflightPath: resolvedPreflightPath, compileEvidencePath })
        : null;
    try {
        if (previousPreflight && (recoveredCompile || interruptedShellSmoke?.ready)) {
            const detectionSource = recoveredCompile ? previousPreflight.detection_source : replayScope.detectionSource;
            const refreshedRequiredReviews = previousPreflight.preflight.required_reviews as Record<string, boolean>;
            const nextStepSummary = 'continue from current compile evidence after finalizing the interrupted coherent-cycle restart.';
            const restartArtifactPath = appendRestartCompletedEvidence({
                repoRoot,
                taskId: resolvedTaskId,
                eventType: 'COHERENT_CYCLE_RESTARTED',
                artifactSuffix: '-coherent-cycle-restart.json',
                message: 'Interrupted coherent task cycle finalized from current verified compile evidence.',
                taskModePath: resolvedTaskModePath,
                preflightPath: resolvedPreflightPath,
                compileEvidencePath,
                detectionSource,
                plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
                detectedChangedFilesCount: toNonNegativeRestartCount(
                    previousPreflight.changed_files_count,
                    previousPreflight.changed_files.length
                ),
                elapsedMs: Date.now() - startedAt,
                restartReason: recoveredCompile
                    ? 'coherent_cycle_restart_resumed_after_interrupted_compile'
                    : 'coherent_cycle_restart_resumed_after_interrupted_shell_smoke',
                recoveredCompile: recoveredCompile ?? undefined,
                nextStepSummary,
                extraDetails: {
                    resumed_interrupted_restart: true,
                    ...(recoveredCompile ? {
                        failed_compile_sequence: recoveredCompile.failedCompileSequence,
                        ...reviewRestartApprovalDetails,
                        ...(lostReviewEvidenceTypes.length ? { lost_review_evidence_types: lostReviewEvidenceTypes } : {})
                    } : { failed_shell_smoke_sequence: interruptedShellSmoke?.failedShellSmokeSequence }),
                    passed_shell_smoke_sequence: recoveredCompile?.passedShellSmokeSequence ?? interruptedShellSmoke?.passedShellSmokeSequence,
                    compile_sequence: recoveredCompile?.compileSequence ?? interruptedShellSmoke?.compileSequence
                }
            });
            return {
                outputLines: buildCoherentCycleRestartedOutput({
                    taskId: resolvedTaskId,
                    navigatorCommand: buildNextStepRecoveryCommand(repoRoot, resolvedTaskId),
                    taskModePath: resolvedTaskModePath,
                    preflightPath: resolvedPreflightPath,
                    restartArtifactPath,
                    detectionSource,
                    plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
                    changedFilesCount: previousPreflight.changed_files_count,
                    preflightMode: previousPreflight.preflight.mode,
                    preflightScopeCategory: previousPreflight.preflight.scope_category,
                    preflightChangedFilesCount: previousPreflight.changed_files_count,
                    preflightRequiredReviewTypes: collectRequiredRestartReviewTypes(refreshedRequiredReviews)
                }),
                exitCode: 0
            };
        }

        const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
        const optionalSkillActivationSnapshot = readRestartOptionalSkillActivationSnapshot(
            orchestratorRoot,
            resolvedTaskId
        );
        const optionalSkillDeclineSnapshot = readRestartOptionalSkillDeclineSnapshot(
            orchestratorRoot,
            resolvedTaskId
        );

        const scopedRequest = scopeApproval ? normalizedCoherentRequest(repoRoot, options) : null;
        const scopeRequestSha256 = scopeApproval ? coherentScopeRequestSha256(repoRoot, options) : null;
        const entry = pendingScope ? null : runEnterTaskModeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            artifactPath: resolvedTaskModePath,
            entryMode: previousTaskMode.entry_mode || 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: previousTaskMode.requested_depth || 2,
            effectiveDepth: previousTaskMode.effective_depth || previousTaskMode.requested_depth || 2,
            taskSummary,
            startBanner: previousTaskMode.start_banner,
            plannedChangedFiles: replayScope.plannedChangedFiles,
            upgradeExistingTaskMode: scopeApproval !== null,
            coherentScopeApproval: scopeApproval,
            pendingCoherentScope: scopedRequest && scopeRequestSha256 ? {
                request_sha256: scopeRequestSha256, request: scopedRequest, task_summary: taskSummary, replay_scope: replayScope,
                intent_update: operatorIntentUpdate, restart_details: restartDetails
            } : null,
            assertReviewRestartApproval: () => {
                if (!isDeepStrictEqual(reviewRestartApproval, readReviewRestartApproval()))
                    throw new Error('Review restart approval no longer matches the current lifecycle boundary or workspace.');
            },
            orchestratorWork: previousTaskMode.orchestrator_work === true,
            workflowConfigWork: previousTaskMode.workflow_config_work === true,
            operatorConfirmed: options.operatorConfirmed,
            operatorConfirmedAtUtc: options.operatorConfirmedAtUtc,
            allowedDirtyWorkflowConfigFiles,
            workflowConfigFileHashesOverride: previousTaskMode.workflow_config_file_hashes,
            workflowConfigCompatibilityBaselineFilesOverride: previousTaskMode.workflow_config_compatibility_baseline_files,
            provider: previousTaskMode.provider || undefined,
            routedTo: previousTaskMode.routed_to || undefined,
            planPath: previousTaskMode.plan?.plan_path || undefined,
            emitMetrics: options.emitMetrics
        });
        if (entry) ensureRestartStepPassed('enter-task-mode', entry);

        // Persist before classification so failed/interrupted compilation cannot revive old PASS criteria.
        if (operatorIntentUpdate) {
            if (scopeApproval) recordCoherentScopeIntent(repoRoot, operatorIntentUpdate);
            else recordOperatorTaskIntentUpdate(repoRoot, operatorIntentUpdate);
        }

        const sealedStartup = !!pendingScope?.authority.classification;
        const entryRulesRetained = entry?.startupReused || !!pendingScope?.currentEvents.some(event =>
            event.event_type === 'RULE_PACK_LOADED' && event.outcome === 'PASS' && event.actor === 'gate'
            && isPlainRecord(event.details) && event.details.stage === 'TASK_ENTRY');
        if (!entryRulesRetained || (pendingScope && getRulePackEvidence(repoRoot, resolvedTaskId, 'TASK_ENTRY',
            { taskModePath: resolvedTaskModePath }).evidence_status !== 'PASS')) {
            ensureRestartStepPassed('load-rule-pack (TASK_ENTRY)', runLoadRulePackCommand({
                repoRoot,
                taskId: resolvedTaskId,
                taskModePath: resolvedTaskModePath,
                stage: 'TASK_ENTRY',
                loadedRuleFiles: getTaskEntryRuleFilesForDepth(
                    previousTaskMode.effective_depth || previousTaskMode.requested_depth || 2
                ),
                emitMetrics: options.emitMetrics
            }));

        }
        const startup = pendingScope ? readPendingCoherentScopeStartup({ ...scopeBinding, timelinePath }) : null;
        if (sealedStartup && !startup?.smoke) throw new Error(MISSING_PENDING_SCOPE_STARTUP);
        if (!startup?.handshake) ensureRestartStepPassed('handshake-diagnostics', runHandshakeDiagnosticsCommand({
            repoRoot, taskId: resolvedTaskId, provider: previousTaskMode.provider || undefined, emitMetrics: options.emitMetrics
        }));
        if (!startup?.smoke) ensureRestartStepPassed('shell-smoke-preflight', runShellSmokePreflightCommand({
            repoRoot, taskId: resolvedTaskId, provider: previousTaskMode.provider || undefined, emitMetrics: options.emitMetrics
        }));

        const refreshedPreflightPath = resolveRecoveryPreflightPath(
            repoRoot,
            resolvedTaskId,
            options.preflightOutputPath || resolvedPreflightPath,
            'PreflightOutputPath'
        );
        const stageBinding = { ...scopeBinding, plannedFiles: replayScope.plannedChangedFiles };
        const bindClassification = scopeRequestSha256
            ? (event: Readonly<TaskEvent>) => bindCoherentScopeStage({ ...stageBinding, requestSha256: scopeRequestSha256, event })
            : undefined;
        const alreadyClassified = pendingScope?.preflightPath
            && path.resolve(pendingScope.preflightPath) === path.resolve(refreshedPreflightPath);
        if (!alreadyClassified) runClassifyChangeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            outputPath: refreshedPreflightPath,
            taskIntent: taskSummary,
            changedFiles: replayScope.changedFiles,
            useStaged: replayScope.useStaged,
            includeUntracked: replayScope.includeUntracked,
            validateCoherentScopeClassification: bindClassification,
            emitMetrics: options.emitMetrics
        });
        const refreshedPreflight = getPreflightContext(refreshedPreflightPath, resolvedTaskId);
        const refreshedRequiredReviews = refreshedPreflight.preflight.required_reviews as Record<string, boolean>;
        const effectiveDepth = getEffectiveDepthFromPreflight(previousTaskMode, refreshedPreflight);

        const postRulesOptions = {
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            emitMetrics: options.emitMetrics
        };
        const rebind = entryRulesRetained && getPostPreflightRulePackRebindDecision(repoRoot, resolvedTaskId,
            refreshedPreflightPath, { taskModePath: resolvedTaskModePath }).can_bind;
        ensureRestartStepPassed('POST_PREFLIGHT rule evidence', rebind
            ? runBindRulePackToPreflightCommand(postRulesOptions)
            : runLoadRulePackCommand({ ...postRulesOptions, stage: 'POST_PREFLIGHT',
                loadedRuleFiles: normalizeRuleFileList(refreshedRequiredReviews, effectiveDepth) }));

        const optionalSkillActivationRebind = await rebindRestartOptionalSkillActivationsForCurrentCycle({
            orchestratorRoot,
            taskId: resolvedTaskId,
            snapshot: optionalSkillActivationSnapshot
        });
        const optionalSkillDeclineRebind = await rebindRestartOptionalSkillDeclinesForCurrentCycle({
            orchestratorRoot,
            taskId: resolvedTaskId,
            snapshot: optionalSkillDeclineSnapshot
        });
        const compileResult = await runCompileGateCommand({
            allowPlanDrift: options.allowPlanDrift,
            allowPlanDriftReason: options.allowPlanDriftReason,
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath: options.commandsPath,
            outputFiltersPath: options.outputFiltersPath,
            failTailLines: options.failTailLines,
            emitMetrics: options.emitMetrics
        } as CompileGateCommandOptions);
        ensureRestartStepPassed('compile-gate', compileResult);
        const nextStepSummary = 'materialize review artifacts for the new compile cycle, then rerun required-reviews-check, doc-impact-gate, and completion-gate.';
        const restartArtifactPath = appendRestartCompletedEvidence({
            repoRoot,
            taskId: resolvedTaskId,
            eventType: 'COHERENT_CYCLE_RESTARTED',
            artifactSuffix: '-coherent-cycle-restart.json',
            message: 'Coherent task cycle restarted after compile gate pass.',
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            compileEvidencePath,
            detectionSource: replayScope.detectionSource,
            plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
            detectedChangedFilesCount: toNonNegativeRestartCount(
                refreshedPreflight.changed_files_count,
                refreshedPreflight.changed_files.length
            ),
            elapsedMs: Date.now() - startedAt,
            restartReason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
            nextStepSummary,
            scopePublication: scopeApproval ? {
                expectedPreviousState: readTaskEventAppendState(timelinePath, resolvedTaskId),
                validateBeforeCanonicalAppend: () => {
                    const current = readPendingCoherentScope({ ...stageBinding, options });
                    if (!current || current.preflightPath !== path.resolve(refreshedPreflightPath))
                        throw new Error('Coherent restart requires its current protected classification.');
                }
            } : undefined,
            extraDetails: {
                ...(scopeApproval ? { coherent_scope_approval: scopeApproval } : {}),
                ...(operatorIntentUpdate ? { task_intent_update: operatorIntentUpdate } : {}),
                ...buildOptionalSkillRebindDetails(optionalSkillActivationRebind, optionalSkillDeclineRebind),
                ...restartDetails
            }
        });

        return {
            outputLines: buildCoherentCycleRestartedOutput({
                taskId: resolvedTaskId,
                navigatorCommand: buildNextStepRecoveryCommand(repoRoot, resolvedTaskId),
                taskModePath: resolvedTaskModePath,
                preflightPath: refreshedPreflightPath,
                restartArtifactPath,
                detectionSource: replayScope.detectionSource,
                plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
                changedFilesCount: refreshedPreflight.changed_files_count,
                preflightMode: refreshedPreflight.preflight.mode,
                preflightScopeCategory: refreshedPreflight.preflight.scope_category,
                preflightChangedFilesCount: refreshedPreflight.changed_files_count,
                preflightRequiredReviewTypes: collectRequiredRestartReviewTypes(refreshedRequiredReviews)
            }),
            exitCode: 0
        };
    } catch (error: unknown) {
        return {
            outputLines: [
                'COHERENT_CYCLE_RESTART_FAILED',
                `TaskId: ${resolvedTaskId}`,
                error instanceof Error ? error.message : String(error),
                `Recovery: ${buildNextStepRecoveryCommand(repoRoot, resolvedTaskId)}`
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
}
