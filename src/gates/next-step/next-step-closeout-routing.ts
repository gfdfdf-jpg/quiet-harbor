import {
    getActiveTaskLifecycleGateIds,
    resolveFirstActiveTaskLifecycleGate
} from '../../runtime/task-lifecycle-phase-runtime';
import type { NextStepRouteDecision } from './next-step-progress-invariant';

export interface CloseoutRoutingCommand {
    label: string;
    command: string;
}

export interface CloseoutRoutingRoute {
    status: 'BLOCKED' | 'READY' | 'DONE';
    nextGate: string | null;
    title: string;
    reason: string;
    commands: CloseoutRoutingCommand[];
    finalReport?: unknown | null;
    /** An operator decision the gate name does not imply; carried to `route_decision` by every payload rebuild. */
    decision?: NextStepRouteDecision | null;
}

export interface RequiredReviewsCheckCloseoutOptions {
    requiredReviewsGatePassed: boolean;
    zeroDiffNoReviewCloseout: boolean;
    command: CloseoutRoutingCommand;
}

export interface DocImpactCloseoutOptions {
    docImpactGatePassed: boolean;
    /**
     * Claims of the passed doc-impact record that current closeout evidence contradicts (for example its
     * project-memory flags against the recorded project-memory-impact status). The record stays in the timeline;
     * a rerun with corrected flags supersedes it.
     */
    evidenceConflicts?: readonly string[];
    requiresProjectMemoryBeforeAssessment?: boolean;
    compatibilityHint: string;
    command: CloseoutRoutingCommand;
}

export interface FullSuiteCloseoutOptions {
    enabled: boolean;
    gatePassed: boolean;
    timeoutBlockerResolvedByRepairTask?: boolean;
    notRequiredForDocsOnly: boolean;
    placement: string;
    configPath: string;
    commandText: string;
    interruptedRunRoute?: CloseoutRoutingRoute | null;
    testSelectionRoute?: CloseoutRoutingRoute | null;
    timeoutForecastLine: string | null;
    command: CloseoutRoutingCommand;
}

export interface ProjectMemoryCloseoutOptions {
    required: boolean;
    evidenceCurrent: boolean;
    visibleSummaryLine: string;
    affectedMemoryFiles: readonly string[];
    violations: readonly string[];
    command: CloseoutRoutingCommand;
    reviewHint?: () => string;
}

export interface CompletionCloseoutOptions {
    completionGatePassed: boolean;
    command: CloseoutRoutingCommand;
}

export interface PostReviewCloseoutRoutingOptions {
    requiredReviews: RequiredReviewsCheckCloseoutOptions;
    docImpact: DocImpactCloseoutOptions;
    fullSuite: FullSuiteCloseoutOptions;
    projectMemory: ProjectMemoryCloseoutOptions;
    completion: CompletionCloseoutOptions;
}

export interface PostReviewCloseoutRouteState {
    requiredReviewsGatePassed: boolean;
    zeroDiffNoReviewCloseout: boolean;
    requiredReviewsCommand: string;
    docImpactGatePassed: boolean;
    docImpactEvidenceConflicts?: readonly string[];
    docImpactRequiresProjectMemoryBeforeAssessment?: boolean;
    docImpactCompatibilityHint: string;
    docImpactCommand: string;
    fullSuiteEnabled: boolean;
    fullSuiteGatePassed: boolean;
    fullSuiteTimeoutBlockerResolvedByRepairTask?: boolean;
    fullSuiteNotRequiredForDocsOnly: boolean;
    fullSuitePlacement: string;
    fullSuiteConfigPath: string;
    fullSuiteCommandText: string;
    fullSuiteInterruptedRunRoute?: CloseoutRoutingRoute | null;
    fullSuiteTestSelectionRoute?: CloseoutRoutingRoute | null;
    fullSuiteTimeoutForecastLine: string | null;
    fullSuiteCommand: string;
    projectMemoryRequired: boolean;
    projectMemoryEvidenceCurrent: boolean;
    projectMemoryVisibleSummaryLine: string;
    projectMemoryAffectedMemoryFiles: readonly string[];
    projectMemoryViolations: readonly string[];
    projectMemoryCommand: string;
    /** Review guidance that matches the suggested command; evaluated only on the project-memory route. */
    projectMemoryReviewHint?: () => string;
    completionGatePassed: boolean;
    completionCommand: string;
}

function closeoutCommand(label: string, command: string): CloseoutRoutingCommand {
    return { label, command };
}

function buildProjectMemoryImpactRoute(options: PostReviewCloseoutRoutingOptions): CloseoutRoutingRoute {
    const staleDetails = options.projectMemory.violations.length > 0
        ? ` Violations: ${options.projectMemory.violations.join('; ')}`
        : '';
    const reviewHint = options.projectMemory.reviewHint?.() ?? '';
    const affectedFiles = options.projectMemory.affectedMemoryFiles.length > 0
        ? ` Affected memory files: ${options.projectMemory.affectedMemoryFiles.join(', ')}.`
        : '';
    return {
        status: 'BLOCKED',
        nextGate: 'project-memory-impact',
        title: 'Record project memory impact.',
        reason:
            `Project memory maintenance is enabled before final closeout (${options.projectMemory.visibleSummaryLine}). ` +
            `Record current project-memory impact evidence after upstream validation and before completion.${affectedFiles}${staleDetails}`
            + (reviewHint ? ` ${reviewHint}` : ''),
        commands: [options.projectMemory.command]
    };
}

export function resolvePostReviewCloseoutRouteFromState(
    state: PostReviewCloseoutRouteState
): CloseoutRoutingRoute {
    return resolvePostReviewCloseoutRoute({
        requiredReviews: {
            requiredReviewsGatePassed: state.requiredReviewsGatePassed,
            zeroDiffNoReviewCloseout: state.zeroDiffNoReviewCloseout,
            command: closeoutCommand('Run required reviews check', state.requiredReviewsCommand)
        },
        docImpact: {
            docImpactGatePassed: state.docImpactGatePassed,
            evidenceConflicts: state.docImpactEvidenceConflicts,
            requiresProjectMemoryBeforeAssessment: state.docImpactRequiresProjectMemoryBeforeAssessment,
            compatibilityHint: state.docImpactCompatibilityHint,
            command: closeoutCommand('Run doc impact gate', state.docImpactCommand)
        },
        fullSuite: {
            enabled: state.fullSuiteEnabled,
            gatePassed: state.fullSuiteGatePassed,
            timeoutBlockerResolvedByRepairTask: state.fullSuiteTimeoutBlockerResolvedByRepairTask,
            notRequiredForDocsOnly: state.fullSuiteNotRequiredForDocsOnly,
            placement: state.fullSuitePlacement,
            configPath: state.fullSuiteConfigPath,
            commandText: state.fullSuiteCommandText,
            interruptedRunRoute: state.fullSuiteInterruptedRunRoute,
            testSelectionRoute: state.fullSuiteTestSelectionRoute,
            timeoutForecastLine: state.fullSuiteTimeoutForecastLine,
            command: closeoutCommand(
                state.fullSuiteNotRequiredForDocsOnly ? 'Record task test not required' : 'Run task test validation',
                state.fullSuiteCommand
            )
        },
        projectMemory: {
            required: state.projectMemoryRequired,
            evidenceCurrent: state.projectMemoryEvidenceCurrent,
            visibleSummaryLine: state.projectMemoryVisibleSummaryLine,
            affectedMemoryFiles: state.projectMemoryAffectedMemoryFiles,
            violations: state.projectMemoryViolations,
            command: closeoutCommand('Run project memory impact gate', state.projectMemoryCommand),
            ...(state.projectMemoryReviewHint ? { reviewHint: state.projectMemoryReviewHint } : {})
        },
        completion: {
            completionGatePassed: state.completionGatePassed,
            command: closeoutCommand('Run completion gate', state.completionCommand)
        }
    });
}

export function resolvePostReviewCloseoutRoute(
    options: PostReviewCloseoutRoutingOptions
): CloseoutRoutingRoute {
    const closeoutRoute = resolveFirstActiveTaskLifecycleGate<CloseoutRoutingRoute>(
        getActiveTaskLifecycleGateIds('closeout', {
            review_gate_required: true,
            full_suite_before_completion: options.fullSuite.enabled,
            project_memory_impact_required: options.projectMemory.required
        }),
        {
            'required-reviews-check': () => options.requiredReviews.requiredReviewsGatePassed
                ? null
                : {
                    status: 'BLOCKED',
                    nextGate: 'required-reviews-check',
                    title: options.requiredReviews.zeroDiffNoReviewCloseout
                        ? 'Validate zero-diff no-review closeout.'
                        : 'Run required reviews check.',
                    reason: options.requiredReviews.zeroDiffNoReviewCloseout
                        ? 'Profile-forced reviews were suppressed because the current preflight is BASELINE_ONLY with no reviewable diff; required-reviews-check must validate audited no-op evidence before closeout.'
                        : 'All required review artifacts appear present, but the review gate has not validated them. If the command includes --review-authorship-attestation-json, leave each value false unless you personally observed real delegated subagent review output and receipt for that lane; change a lane to true only for that case. False is correct when reviewer launch, authorship, or receipt provenance is absent, self-authored, fabricated, substituted, or uncertain.',
                    commands: [options.requiredReviews.command]
                },
            'full-suite-validation': () => {
                if (options.fullSuite.interruptedRunRoute) return options.fullSuite.interruptedRunRoute;
                if (!options.fullSuite.notRequiredForDocsOnly && options.fullSuite.testSelectionRoute) {
                    return options.fullSuite.testSelectionRoute;
                }
                if (options.fullSuite.gatePassed) {
                    return null;
                }
                if (options.fullSuite.notRequiredForDocsOnly) {
                    return {
                        status: 'BLOCKED',
                        nextGate: 'full-suite-validation',
                        title: 'Record task test validation as not required.',
                        reason:
                            `Effective workflow config enables task test validation at ${options.fullSuite.configPath}, ` +
                            'but the current scope is docs-only. Record a SKIPPED/NOT_REQUIRED artifact instead of running the selected task test command.',
                        commands: [options.fullSuite.command]
                    };
                }
                return {
                    status: 'BLOCKED',
                    nextGate: 'full-suite-validation',
                    title: options.fullSuite.placement === 'before_completion'
                        ? 'Run task test validation before completion.'
                        : 'Run task test validation.',
                    reason:
                        `Effective workflow config enables task test validation at ${options.fullSuite.configPath} with placement '${options.fullSuite.placement}'. ` +
                        `Selected task test command: ${options.fullSuite.commandText}. ${options.fullSuite.timeoutForecastLine || ''}`.trim(),
                    commands: [options.fullSuite.command]
                };
            },
            'project-memory-impact': () => {
                if (
                    !options.docImpact.docImpactGatePassed
                    && options.docImpact.requiresProjectMemoryBeforeAssessment !== true
                ) {
                    return null;
                }
                return options.projectMemory.evidenceCurrent
                    ? null
                    : buildProjectMemoryImpactRoute(options);
            },
            'doc-impact-gate': () => {
                const conflicts = options.docImpact.evidenceConflicts || [];
                if (options.docImpact.docImpactGatePassed && conflicts.length > 0) {
                    return {
                        status: 'BLOCKED',
                        nextGate: 'doc-impact-gate',
                        title: 'Rerun documentation impact with corrected evidence.',
                        reason:
                            `The recorded doc-impact decision contradicts current closeout evidence: ${conflicts.join(' ')} ` +
                            'Rerun doc-impact-gate with the corrected flags below, then completion-gate. The earlier record stays in the task timeline and the new record supersedes it; ' +
                            'reviewed code and reviews are unchanged, so no review or cycle restart is needed.',
                        commands: [options.docImpact.command]
                    };
                }
                return options.docImpact.docImpactGatePassed ? null : {
                    status: 'BLOCKED',
                    nextGate: 'doc-impact-gate',
                    title: 'Record documentation impact.',
                    reason: `Completion requires an explicit docs decision. ${options.docImpact.compatibilityHint}`,
                    commands: [options.docImpact.command]
                };
            }
        }
    );
    if (closeoutRoute) {
        return closeoutRoute;
    }

    const terminalRoute = resolveFirstActiveTaskLifecycleGate<CloseoutRoutingRoute>(
        getActiveTaskLifecycleGateIds('terminal', {}),
        {
            'completion-gate': () => !options.completion.completionGatePassed
                ? {
                    status: 'BLOCKED',
                    nextGate: 'completion-gate',
                    title: 'Run completion gate.',
                    reason: 'All upstream gates appear ready; completion has not finalized the task.',
                    commands: [options.completion.command]
                }
                : null
        }
    );
    if (terminalRoute) {
        return terminalRoute;
    }

    return {
        status: 'BLOCKED',
        nextGate: 'completion-gate',
        title: 'Rerun completion gate for the current task cycle.',
        reason: 'A previous completion gate pass exists, but it is older than the latest task-mode entry. Continue the restarted task cycle before treating the task as DONE.',
        commands: [options.completion.command]
    };
}

export interface CompletedCloseoutRoutingOptions {
    postDoneDrift: {
        blocked: boolean;
        reason: string;
    };
    finalReportContractReady: boolean;
    finalReportContractBlocker: string;
    finalReport: unknown | null;
    taskAuditCommand: CloseoutRoutingCommand;
}

export interface CompletedCloseoutRouteState {
    postDoneDriftBlocked: boolean;
    postDoneDriftReason: string;
    finalReportContractReady: boolean;
    finalReportContractBlocker: string;
    finalReport: unknown | null;
    taskAuditCommand: string;
}

export function resolveCompletedCloseoutRouteFromState(
    state: CompletedCloseoutRouteState
): CloseoutRoutingRoute {
    return resolveCompletedCloseoutRoute({
        postDoneDrift: {
            blocked: state.postDoneDriftBlocked,
            reason: state.postDoneDriftReason
        },
        finalReportContractReady: state.finalReportContractReady,
        finalReportContractBlocker: state.finalReportContractBlocker,
        finalReport: state.finalReport,
        taskAuditCommand: closeoutCommand('Build final audit summary', state.taskAuditCommand)
    });
}

/**
 * The grouped closeout is pending but its final audit is not PASS. Like the ungrouped final-report blocker, the reported
 * closeout evidence is never rebuilt by an agent: the operator decides its repair, so the route says so (T-403).
 */
export function resolveGroupedFollowUpAuditBlockedRoute(blocker: string | null):
    Omit<CloseoutRoutingRoute, 'commands' | 'finalReport'> & { commands: never[] } {
    return {
        status: 'BLOCKED', nextGate: 'task-audit-summary', title: 'Resolve the final grouped follow-up audit.',
        decision: 'operator',
        reason: `${blocker || 'Final audit is blocked.'} Preserve the accepted completion and grouped child. `
            + 'Ask the operator to decide how the reported closeout evidence is repaired; '
            + 'do not rebuild completion, review or audit evidence yourself.',
        commands: []
    };
}

export function resolveTerminalGroupedFollowUpRoute<T>(publicationPending: boolean, resolvePending: () => T | null): T | null {
    return resolveFirstActiveTaskLifecycleGate(getActiveTaskLifecycleGateIds('terminal', {
        grouped_follow_up_pending: publicationPending
    }), {
        'completion-gate': () => null,
        'materialize-review-follow-up-tasks': resolvePending
    });
}

export function resolveCompletedCloseoutRoute(
    options: CompletedCloseoutRoutingOptions
): CloseoutRoutingRoute {
    if (options.postDoneDrift.blocked) {
        return {
            status: 'BLOCKED',
            nextGate: 'post-done-drift',
            title: 'Resolve tracked post-DONE workspace drift.',
            reason: options.postDoneDrift.reason,
            commands: [],
            finalReport: null
        };
    }

    if (!options.finalReportContractReady) {
        return {
            status: 'BLOCKED',
            nextGate: 'task-audit-summary',
            // Lost review bindings are never rebuilt by an agent: the operator preserves the evidence and decides the reset.
            decision: 'operator',
            title: 'Final report integrity attestation is not ready.',
            reason:
                `${options.finalReportContractBlocker || 'Final report contract is not ready.'} ` +
                'Do not deliver a task-complete final report or reconstruct lost review bindings from unauthenticated artifacts. ' +
                'Ask the operator to preserve the task evidence and source work, reset the task (garda gate task-reset), then enter it again for fresh ordered reviews.',
            commands: [],
            finalReport: null
        };
    }

    if (options.finalReport) {
        return {
            status: 'DONE',
            nextGate: null,
            title: 'Task gate flow is complete.',
            reason: 'Completion gate passed and the canonical final closeout is materialized. Deliver the final report in the required order below; do not auto-commit without explicit user approval.',
            commands: [],
            finalReport: options.finalReport
        };
    }

    return {
        status: 'READY',
        nextGate: 'task-audit-summary',
        title: 'Materialize final closeout before stopping.',
        reason: 'Completion gate passed, but the canonical final closeout artifacts are not materialized yet. Run task-audit-summary to materialize the final report order and commit guidance before stopping.',
        commands: [options.taskAuditCommand],
        finalReport: null
    };
}
