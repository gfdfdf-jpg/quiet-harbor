import type {
    NextStepCommand,
    NextStepStatus
} from './';
import { buildCommand, formatNextStepInlineValue } from './next-step-command-formatters';

export interface NextStepPreReviewRoute {
    status: NextStepStatus;
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface NextStepReadinessState {
    ready: boolean;
    reason: string;
}

export interface NextStepWorkspaceReadinessState extends NextStepReadinessState {
    awaitingMaterializedPlannedScope?: boolean;
}

export interface NextStepProtectedControlPlaneRoutingOptions {
    touched: boolean;
    taskModeHasOrchestratorWork: boolean;
    selfGuardDeny: boolean;
    selfGuardGuidance: string;
    maintenanceInspectionCommand: string;
    orchestratorWorkRestartCommand: string;
}

export interface NextStepPostPreflightRulePackRoutingOptions extends NextStepReadinessState {
    stage: string | null;
    canBind: boolean;
    rebindReason?: string;
    loadCommand: string;
    bindCommand: string;
}

export interface NextStepCompileGateRoutingOptions extends NextStepReadinessState {
    compileGatePassed: boolean;
    compileCommandUnconfigured?: boolean;
    retryStoredCompileCommand?: boolean;
    recoveryGate?: 'classify-change' | 'enter-task-mode';
    restartTaskModeCommand: string;
    refreshPreflightCommand: string;
    compileCommand: string;
    /** Files the last compile rejected as outside the frozen task plan. */
    planDriftExtraFiles?: readonly string[];
}

export interface NextStepQualityChecklistRoutingOptions extends NextStepReadinessState {
    enabled: boolean;
    required: boolean;
    status: string | null;
    actionRequiredSummary?: string | null;
    answersTemplatePath?: string | null;
    command: string;
}

export interface NextStepOptionalSkillActivationRoutingOptions {
    skillId: string;
    command: string;
}

export interface NextStepPreGuardRoutingOptions {
    preflightCycleReadiness: NextStepReadinessState;
    preflightCycleRefreshCommand: string;
    protectedControlPlane: NextStepProtectedControlPlaneRoutingOptions;
    postReviewSourceMutationGuard?: {
        blocked: boolean;
        reason: string;
    } | null;
    workspaceReadiness: NextStepWorkspaceReadinessState;
    workspaceRefreshCommand: string;
    workspaceRefreshRecovery?: { nextGate: string; reason: string; command: string; title?: string; label?: string } | null;
    /** The workspace changed after REVIEW_GATE_PASSED without an authenticated remediation transition. */
    writeAfterReviewGate?: {
        changedFiles: readonly string[];
        detail: string;
        approvedRestartCommand: string;
        /** restart-review-cycle when a passed review baseline measures the change, else the coherent restart. */
        approvedRestartGate?: 'restart-review-cycle' | 'restart-coherent-cycle';
        originReviewType?: string;
    } | null;
    failedReviewRemediation?: {
        reviewType: string;
        verdictToken: string;
        restartReviewCycleCommand: string;
        closedCycleRestart?: {
            boundary: string;
            command: string;
        } | null;
        expandedNonTestFiles?: string[];
    } | null;
    coherentCycleReadiness: NextStepReadinessState & { command?: string | null };
    interruptedReviewRestartCommand?: string;
    navigatorCommand: string;
    postPreflightRulePack: NextStepPostPreflightRulePackRoutingOptions;
    optionalSkillActivation?: NextStepOptionalSkillActivationRoutingOptions | null;
}

export function resolveNextStepPreGuardRoute(
    options: NextStepPreGuardRoutingOptions
): NextStepPreReviewRoute | null {
    if (options.postReviewSourceMutationGuard?.blocked) {
        return {
            status: 'BLOCKED',
            nextGate: 'post-review-source-mutation-guard',
            title: 'Stop unauthorized post-review source mutation.',
            reason: options.postReviewSourceMutationGuard.reason,
            commands: []
        };
    }

    if (!options.preflightCycleReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current task cycle.',
            reason: options.preflightCycleReadiness.reason,
            commands: [
                buildCommand('Refresh preflight', options.preflightCycleRefreshCommand)
            ]
        };
    }

    if (options.protectedControlPlane.touched && !options.protectedControlPlane.taskModeHasOrchestratorWork) {
        if (options.protectedControlPlane.selfGuardDeny) {
            return {
                status: 'BLOCKED',
                nextGate: 'operator-maintenance',
                title: 'Garda self-guard blocks agent-owned protected control-plane work.',
                reason:
                    'The current preflight touches protected Garda control-plane files. ' +
                    options.protectedControlPlane.selfGuardGuidance,
                commands: [
                    buildCommand('Inspect Garda installation', options.protectedControlPlane.maintenanceInspectionCommand)
                ]
            };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode as orchestrator work.',
            reason: 'The current preflight touches protected orchestrator control-plane files, but task-mode evidence does not declare --orchestrator-work. Fresh operator approval is required before the agent can rerun protected task-mode entry.',
            commands: [
                buildCommand('Restart task mode with orchestrator work', options.protectedControlPlane.orchestratorWorkRestartCommand)
            ]
        };
    }

    if (!options.workspaceReadiness.ready && options.failedReviewRemediation) {
        const remediation = options.failedReviewRemediation;
        if (remediation.closedCycleRestart) {
            return {
                status: 'BLOCKED',
                nextGate: 'restart-coherent-cycle',
                title: 'Restart the closed coherent task cycle.',
                reason:
                    `${options.workspaceReadiness.reason} ` +
                    `The stale scope follows a recorded failed '${remediation.reviewType}' review verdict ` +
                    `'${remediation.verdictToken}', but the current cycle already crossed ` +
                    `${remediation.closedCycleRestart.boundary}. restart-review-cycle cannot reopen that closed boundary; ` +
                    'restart the coherent cycle from task entry before rebuilding compile and review evidence. '
                    + 'That new review cycle runs only after the user approves it: tell the user, and fill in the approval '
                    + 'time only after the user says yes.',
                commands: [
                    buildCommand('Restart coherent cycle', remediation.closedCycleRestart.command)
                ]
            };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'restart-review-cycle',
            title: `Restart failed '${remediation.reviewType}' review remediation cycle.`,
            reason:
                `${options.workspaceReadiness.reason} ` +
                `The stale scope follows a recorded failed '${remediation.reviewType}' review verdict '${remediation.verdictToken}'. ` +
                ((remediation.expandedNonTestFiles || []).length > 0
                    ? `The fix expands non-test scope: ${remediation.expandedNonTestFiles?.join(', ')}. ` +
                        'restart-review-cycle binds the expanded scope and requires every review in FULL. '
                    : '') +
                'Use restart-review-cycle as the cheapest valid recovery path: it preserves the current task-mode authorization, ' +
                'runs any missing startup diagnostics before refreshing preflight, reloads POST_PREFLIGHT rules, reruns compile, ' +
                'and rebuilds the affected review context before downstream reviewers. This avoids a standalone classify-change ' +
                'that would refresh preflight after REVIEW_PHASE_STARTED and only later be rejected by coherent-cycle ordering. ' +
                'The current cycle has not crossed a closed review boundary, so this command is directly executable.',
            commands: [
                buildCommand('Restart failed-review remediation cycle: replace all eight <analysis> fields with task-specific details '
                    + '(at least 120 characters total; name an affected file)', remediation.restartReviewCycleCommand)
            ]
        };
    }

    if (!options.workspaceReadiness.ready && options.writeAfterReviewGate) {
        // Operator decision: a write after the reviews passed does not start a new review cycle by itself.
        // The task is almost finished; the agent reverts and keeps closing, or asks the user to approve a restart.
        const write = options.writeAfterReviewGate;
        const measured = write.approvedRestartGate === 'restart-review-cycle';
        return {
            status: 'BLOCKED',
            nextGate: measured ? 'restart-review-cycle' : 'restart-coherent-cycle',
            title: 'Revert the change made after the reviews passed, then continue closing.',
            reason:
                'Files changed after the required reviews passed (REVIEW_GATE_PASSED)'
                + (write.changedFiles.length ? `; files in the current diff: ${write.changedFiles.join(', ')}` : '')
                + `. ${write.detail} The task is almost finished: revert that change and rerun next-step to continue closing. `
                + (measured
                    ? 'Keeping it starts a new review cycle, measured against the authenticated '
                        + `'${write.originReviewType}' review baseline like a change before the review gate: a review the change `
                        + 'does not reach keeps its result, a small fix inside a review\'s scope repeats it in DELTA, a large fix in '
                        + 'FULL, documents repeat nothing, and a change that cannot be authenticated or classified repeats every '
                        + 'review in FULL. '
                    : 'Keeping it starts a new review cycle in which every required review runs again, which is very expensive. ')
                + 'If the change is truly necessary, tell the user and ask for approval; run the command below only after the user '
                + 'approves, with the time of that approval. Do not fill in the approval yourself.',
            commands: [buildCommand(measured
                ? 'Only after the user approves a new review cycle: replace all eight <analysis> fields with task-specific details '
                    + '(at least 120 characters total; name an affected file)'
                : 'Only after the user approves a new review cycle', write.approvedRestartCommand)]
        };
    }

    if (options.interruptedReviewRestartCommand) {
        return {
            status: 'BLOCKED',
            nextGate: 'restart-review-cycle',
            title: 'Resume the unfinished review remediation cycle.',
            reason: options.coherentCycleReadiness.reason,
            commands: [buildCommand('Retry review remediation restart', options.interruptedReviewRestartCommand)]
        };
    }

    if (!options.workspaceReadiness.ready && options.workspaceRefreshRecovery) {
        return {
            status: 'BLOCKED',
            nextGate: options.workspaceRefreshRecovery.nextGate,
            title: options.workspaceRefreshRecovery.title || 'Prepare the diagnostic sequence before refreshing workspace scope.',
            reason: `${options.workspaceRefreshRecovery.reason} ${options.workspaceReadiness.reason}`,
            commands: [buildCommand(options.workspaceRefreshRecovery.label || 'Refresh current task cycle', options.workspaceRefreshRecovery.command)]
        };
    }

    if (!options.workspaceReadiness.ready && !options.coherentCycleReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'restart-coherent-cycle',
            title: 'Restore the coherent cycle before refreshing workspace scope.',
            reason: `${options.coherentCycleReadiness.reason} ${options.workspaceReadiness.reason}`,
            commands: options.coherentCycleReadiness.command
                ? [buildCommand('Restart coherent cycle', options.coherentCycleReadiness.command)]
                : []
        };
    }

    if (!options.workspaceReadiness.ready) {
        if (options.workspaceReadiness.awaitingMaterializedPlannedScope) {
            return {
                status: 'BLOCKED',
                nextGate: 'materialize-planned-scope',
                title: 'Materialize planned task changes before refreshing preflight.',
                reason: options.workspaceReadiness.reason,
                commands: []
            };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current workspace.',
            reason: options.workspaceReadiness.reason,
            commands: [
                buildCommand('Refresh preflight', options.workspaceRefreshCommand)
            ]
        };
    }

    if (options.optionalSkillActivation) {
        return {
            status: 'BLOCKED',
            nextGate: 'activate-optional-skill',
            title: 'Activate the selected optional skill.',
            reason:
                `Current preflight selected optional skill ${formatNextStepInlineValue(options.optionalSkillActivation.skillId)}, ` +
                'but the current task cycle has no matching activation evidence yet. ' +
                'Record activation before restart-coherent-cycle, compile, review, implementation, or closeout so selected-skill diagnostics and final audit describe the same current-cycle state.',
            commands: [
                buildCommand(
                    `Activate optional skill ${options.optionalSkillActivation.skillId}`,
                    options.optionalSkillActivation.command
                )
            ]
        };
    }

    if (!options.coherentCycleReadiness.ready) {
        return {
            status: 'BLOCKED',
            nextGate: 'restart-coherent-cycle',
            title: 'Restart the latest coherent task cycle.',
            reason: options.coherentCycleReadiness.reason,
            commands: [
                buildCommand(
                    'Restart coherent cycle',
                    options.coherentCycleReadiness.command || options.navigatorCommand
                )
            ]
        };
    }

    if (options.postPreflightRulePack.stage !== 'POST_PREFLIGHT' || !options.postPreflightRulePack.ready) {
        const canBindPostPreflightRules =
            options.postPreflightRulePack.stage === 'POST_PREFLIGHT'
            && options.postPreflightRulePack.canBind;
        return {
            status: 'BLOCKED',
            nextGate: canBindPostPreflightRules ? 'bind-rule-pack-to-preflight' : 'load-rule-pack',
            title: canBindPostPreflightRules
                ? 'Bind existing POST_PREFLIGHT rule-pack evidence to the current preflight.'
                : 'Read and record POST_PREFLIGHT rule files.',
            reason: canBindPostPreflightRules
                ? `${options.postPreflightRulePack.rebindReason || 'Rule files are already loaded.'} Rebind the machine-readable evidence to the latest preflight before compile.`
                : options.postPreflightRulePack.ready
                ? 'Preflight exists; downstream rule files and risk-specific packs must be recorded for the current scope.'
                : options.postPreflightRulePack.reason,
            commands: [
                buildCommand(
                    canBindPostPreflightRules
                        ? 'Bind POST_PREFLIGHT rules to current preflight'
                        : 'Load POST_PREFLIGHT rules',
                    canBindPostPreflightRules
                        ? options.postPreflightRulePack.bindCommand
                        : options.postPreflightRulePack.loadCommand
                )
            ]
        };
    }

    return null;
}

export function resolveNextStepQualityChecklistRoute(
    options: NextStepQualityChecklistRoutingOptions
): NextStepPreReviewRoute | null {
    if (!options.required) {
        return null;
    }

    if (!options.enabled && options.status !== 'CONFIG_ERROR') {
        return null;
    }

    if (options.ready && ['PASS', 'WARN', 'SKIPPED_DISABLED'].includes(options.status || '')) {
        return null;
    }

    if (options.ready && options.status === 'ACTION_REQUIRED') {
        const actionSummary = options.actionRequiredSummary
            ? ` Action required: ${options.actionRequiredSummary}`
            : '';
        return {
            status: 'BLOCKED',
            nextGate: 'implementation',
            title: 'Resolve quality checklist action items.',
            reason:
                `${options.reason}${actionSummary} Address the required quality checklist follow-up in implementation, ` +
                'then refresh preflight if the workspace changed before rerunning compile, review, task test validation, or completion gates.',
            commands: []
        };
    }

    const answersTemplatePath = options.answersTemplatePath || '';
    const answersNeedCompletion = !options.command && !!answersTemplatePath;
    const label = options.ready && options.status === 'CONFIG_ERROR'
        ? 'Rerun quality checklist after repairing configuration or answers'
        : 'Run quality checklist';
    return {
        status: 'BLOCKED',
        nextGate: 'quality-checklist',
        title: answersNeedCompletion
            ? 'Complete quality checklist answers.'
            : options.ready && options.status === 'CONFIG_ERROR'
            ? 'Repair quality checklist evidence.'
            : 'Run optional quality checklist.',
        reason: answersNeedCompletion
            ? `${options.reason} Complete every active answer in ${formatNextStepInlineValue(answersTemplatePath)} ` +
                'and rerun next-step; the executable quality-checklist command is emitted only after the answers are valid.'
            : options.reason,
        commands: options.command ? [buildCommand(label, options.command)] : []
    };
}

export function resolveNextStepCompileGateRoute(
    options: NextStepCompileGateRoutingOptions
): NextStepPreReviewRoute | null {
    if (options.compileGatePassed && options.ready) {
        return null;
    }

    if (options.recoveryGate === 'classify-change') {
        return {
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight after compile scope drift.',
            reason: options.reason,
            commands: [
                buildCommand('Refresh preflight', options.refreshPreflightCommand)
            ]
        };
    }

    if (options.recoveryGate === 'enter-task-mode') {
        return {
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart protected task mode before compile.',
            reason: options.reason,
            commands: [
                buildCommand('Restart task mode with orchestrator work', options.restartTaskModeCommand)
            ]
        };
    }

    if (options.planDriftExtraFiles?.length) {
        return {
            status: 'BLOCKED',
            nextGate: 'compile-gate',
            title: 'Resolve plan drift before compile.',
            reason: `The last compile rejected ${options.planDriftExtraFiles.length} file(s) outside the approved task plan: `
                + `${options.planDriftExtraFiles.join(', ')}. If they are required for this task, rerun compile with `
                + '--allow-plan-drift and a concrete --allow-plan-drift-reason (at least 12 characters, why these files belong here). '
                + 'Otherwise revert them; replacing the frozen plan needs the operator.',
            commands: [
                buildCommand('Run compile gate accepting the plan drift',
                    `${options.compileCommand} --allow-plan-drift --allow-plan-drift-reason "<why these files belong to this task>"`)
            ]
        };
    }

    if (/Not-applicable cannot close a failed required compile/u.test(options.reason)) {
        return {
            status: 'BLOCKED', nextGate: 'compile-gate', title: 'Fix and rerun the required task compile.',
            reason: options.reason,
            commands: [buildCommand('Rerun the required task compile',
                `${options.compileCommand} --compile-command "<task-compile-command>"`)]
        };
    }

    if (options.compileCommandUnconfigured && options.retryStoredCompileCommand) {
        return {
            status: 'BLOCKED', nextGate: 'compile-gate', title: 'Fix the failure and rerun the stored task compile.',
            reason: options.reason,
            commands: [buildCommand('Rerun the stored task compile command', options.compileCommand)]
        };
    }

    if (options.compileCommandUnconfigured || /Compile gate command is unconfigured/u.test(options.reason)) {
        return {
            status: 'BLOCKED', nextGate: 'compile-gate', title: 'Declare task-local compile applicability.',
            reason: options.reason,
            commands: [
                buildCommand('Run this task compile command', `${options.compileCommand} --compile-command "<task-compile-command>"`),
                buildCommand('Record no separate compile phase', `${options.compileCommand} --compile-not-applicable-reason "<why this stack has no separate compile phase>"`)
            ]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'compile-gate',
        title: 'Run compile gate.',
        reason: options.reason,
        commands: [
            buildCommand('Run compile gate', options.compileCommand)
        ]
    };
}
