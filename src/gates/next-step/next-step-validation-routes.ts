import type { ScopeBudgetGuardEvaluation } from '../../core/scope-budget-guard';
import type {
    ReviewCycleContinuationAssessment
} from '../review-cycle/review-cycle-continuation';
import type {
    NextStepReviewCycleBlock,
    ReviewCycleGuardEvaluation
} from './next-step-review-cycle-guard';
import type {
    SplitRequiredLatchResult
} from './next-step-split-required-latch';
import {
    buildCommand,
    buildGatePathCommandParts,
    quoteCommandValue,
    formatNextStepInlineList,
    formatNextStepInlineValue,
    buildNavigatorCommand
} from './next-step-command-formatters';
import type {
    NextStepDecisionRoutePayload
} from './next-step-decision-route-groups';
import {
    getActiveTaskLifecycleGateIds,
    resolveFirstActiveTaskLifecycleGate
} from '../../runtime/task-lifecycle-phase-runtime';
import type {
    NextStepQualityChecklistReadiness, NextStepValidationRejectionFacts
} from './next-step-quality-checklist-readiness';
import type { ProjectValidationAuthorityIssue } from '../../core/project-validation-errors';
import type { NextStepPreReviewRoute } from './next-step-pre-review-routing';
import type { QualityValidationPhases } from '../quality-checklist/quality-checklist-validation-phases';

type ValidationRoute = NextStepDecisionRoutePayload;

/** The navigator's preflight refresh for the current task scope (classify-change), built only when a route needs it. */
export type ValidationPreflightRefresh = () => { command: string };

/** The retry gate of a typed validation inspection race (listed in NEXT_STEP_RETRY_GATES). */
export const VALIDATION_INSPECTION_RETRY_GATE = 'validation-inspection';

function buildNativeTaskCommandTemplate(cliPrefix: string, taskId: string, preflightPath: string, selectedCaseParts = ''): string {
    return `${cliPrefix} gate run-intermediate-command --task-id ${quoteCommandValue(taskId)}`
        + ' --command-source targeted-test --command "<task-test-command>"'
        + ` ${buildGatePathCommandParts({ preflight_path: preflightPath }).join(' ')}`
        + `${selectedCaseParts} --repo-root "."`;
}

/**
 * Complete checklist answers whose selected trust-boundary cases have no current focused run yet. The checklist
 * freezes the validation phases it reads, so recording it now would freeze PENDING execution, the focused run would
 * then make that record stale and the checklist would run twice. Run the focused cases first; the next navigator
 * call offers the checklist once, with their observed execution. Nothing is skipped: the gates still own every
 * admission, scope and evidence check of the run and of the checklist that follows it.
 */
export function resolveFocusedRunBeforeChecklistRoute(options: {
    phases: QualityValidationPhases | null | undefined; cliPrefix: string; taskId: string; preflightPath: string;
}): ValidationRoute | null {
    const phases = options.phases;
    if (!phases || phases.execution_kind !== 'task-command' || phases.structural !== 'BOUND' || phases.execution !== 'PENDING'
        || phases.obligations.length === 0) return null;
    const cases = [...new Set(phases.obligations.map(obligation => `${obligation.source_identity.path}#${obligation.target_id}`))];
    // Each obligation is bound to its case by --selected-case, so a runner that names a class but no source file still
    // proves the selected case rather than an unrelated passing run.
    const claims = new Map(phases.obligations.map(obligation => {
        const claim = JSON.stringify({ source: obligation.source_identity.path, case_id: obligation.target_id,
            selector: obligation.selector });
        return [claim, ` --selected-case ${quoteCommandValue(claim)}`];
    }));
    const template = buildNativeTaskCommandTemplate(options.cliPrefix, options.taskId, options.preflightPath, [...claims.values()].join(''));
    return {
        status: 'BLOCKED', nextGate: 'run-intermediate-command',
        title: 'Run the selected focused cases before recording the quality checklist.',
        reason: `The completed quality-checklist answers select ${formatNextStepInlineList(cases)}, and no focused run bound to `
            + 'the current preflight covers them yet. Run the actual focused project check for these cases through gate '
            + 'run-intermediate-command with --command-source targeted-test, then rerun next-step: it offers the quality '
            + 'checklist once, recorded with their observed execution. No runner or command is inferred from the source language. '
            + 'Keep each --selected-case source and case_id; its selector must name the case exactly as the actual --command '
            + '(for example a full runner ID such as Class#method). '
            + `Declare the actual command and record it using: ${template}`,
        // The agent declares the project command; a template with an unresolved command is never queued for execution.
        commands: []
    };
}

export function resolveDeclaredValidationDecisionRoute(options: {
    readiness: NextStepQualityChecklistReadiness | null; cliPrefix: string; taskId: string; preflightPath: string;
    refreshPreflight?: ValidationPreflightRefresh;
}): ValidationRoute | null {
    const readiness = options.readiness;
    const nativeCommand = buildNativeTaskCommandTemplate(options.cliPrefix, options.taskId, options.preflightPath);
    if (readiness?.validationRejection) return resolveRejectedValidationRoute({ ...options,
        rejection: readiness.validationRejection, facts: readiness.validationRejectionFacts,
        answersPath: readiness.answersTemplatePath, nativeCommand });
    const phases = readiness?.ready && readiness.evidenceStatus === 'current' ? readiness.validationPhases : null;
    if (!phases || phases.execution === 'OBSERVED') return null;
    const pending = phases.executions.find(execution => execution.execution === 'PENDING' && execution.attempt_id)
        ?? phases.executions.find(execution => execution.execution === 'PENDING');
    if (!pending) return resolveRejectedValidationRoute({ ...options, rejection: 'No current pending execution can be selected.',
        facts: { source: 'phases', executionKind: phases.execution_kind === 'task-command' ? 'task-command' : 'declared',
            structural: phases.structural, rejectedRecipeIds: phases.execution_kind === 'task-command' ? []
                : phases.executions.filter(execution => execution.execution === 'REJECTED').map(execution => execution.recipe_id) },
        answersPath: readiness?.answersTemplatePath ?? null, nativeCommand });
    if (phases.execution_kind === 'task-command') return {
        status: 'BLOCKED', nextGate: 'run-intermediate-command', title: 'Execute the current project check.',
        reason: 'Structural source/case references are bound. Run the explicit project check through gate run-intermediate-command '
            + 'with --command-source targeted-test and the actual focused --command; retain its current output. '
            + 'No runner or command is inferred from the source language. Independent per-case resolution remains required. '
            + `Declare the actual command and record it using: ${nativeCommand}`,
        // This is the initial agent declaration step. A template containing an unresolved
        // project command is guidance, never a command queued for automatic execution.
        commands: []
    };
    if (pending.attempt_id) return { status: 'BLOCKED', nextGate: 'await-project-validation',
        title: 'Collect the existing declared validation attempt.',
        reason: `Await and collect the existing attempt ${formatNextStepInlineValue(pending.attempt_id)} for recipe ${formatNextStepInlineValue(pending.recipe_id)} through its executing owner, then evaluate its retained result. Do not launch a duplicate execution.`,
        commands: [] };
    return { status: 'BLOCKED', nextGate: 'run-intermediate-command', title: 'Execute the admitted declared recipe.',
        reason: `Structural evidence is bound; recipe ${formatNextStepInlineValue(pending.recipe_id)} still requires a genuine current execution. Independent semantic obligations remain pending.`,
        commands: [buildCommand('Execute declared recipe', `${options.cliPrefix} gate run-intermediate-command --task-id ${quoteCommandValue(options.taskId)} --recipe-id ${quoteCommandValue(pending.recipe_id)} --repo-root "."`)] };
}

export function resolveValidationAuthorityOperatorRoute(
    reason: string, issue: ProjectValidationAuthorityIssue, cliPrefix: string
): ValidationRoute {
    const decision = issue === 'audit-repair'
        ? 'The operator must repair the audit, then rerun the Navigator.'
        : issue === 'readmitted'
            ? 'The operator must decide how to continue test-first recovery. RED under the earlier admission cannot carry forward. '
                + 'An agent refresh requires an entirely recognized test scope before implementation. '
                + 'Reopening the task starts a fresh cycle.'
            : 'The operator must confirm or re-approve the project validation contract '
                + `(${cliPrefix} workflow set --project-validation-contract "<contract path>" with their confirmation), `
                + 'then rerun the Navigator.';
    const authorityReason = issue === 'readmitted' ? 'The active preflight holds an earlier audited validation admission.' : reason;
    return { status: 'BLOCKED', nextGate: 'project-validation-evidence', decision: 'operator', commands: [],
        title: issue === 'audit-repair' ? 'Ask the operator to repair the workflow-config audit.'
            : 'Ask the operator to resolve project validation authority.',
        reason: authorityReason + ' ' + decision };
}

export function resolveTestFirstAuthorityRoute(reason: string, command: string): NextStepPreReviewRoute {
    return { status: 'BLOCKED', nextGate: 'classify-change',
        title: 'Refresh preflight for the admitted validation contract.',
        reason: reason + ' Refresh the same preflight to bind the audited admission, then rerun the Navigator to record current RED.',
        commands: [buildCommand('Refresh preflight', command)] };
}

/**
 * A rejected declared validation. Every class names its way on: the agent's own fresh run (an admitted recipe, or the
 * focused native check it declares), its own checklist correction, or an operator decision marked as such. The gates
 * still own every admission, scope and evidence check of whatever runs next.
 */
function resolveRejectedValidationRoute(options: {
    cliPrefix: string; taskId: string; rejection: string; facts: NextStepValidationRejectionFacts | undefined;
    answersPath: string | null; nativeCommand: string; refreshPreflight?: ValidationPreflightRefresh;
}): ValidationRoute {
    // Routing reads the typed facts only: the rejection text also carries user-supplied case ids and paths.
    const { rejection, facts } = options;
    const operator = (decision: string): ValidationRoute => ({ status: 'BLOCKED', nextGate: 'project-validation-evidence',
        title: 'Ask the operator to resolve rejected declared validation evidence.', reason: `${rejection} ${decision}`,
        commands: [], decision: 'operator' });
    const refresh = (title: string, why: string): ValidationRoute | null => {
        const invocation = options.refreshPreflight?.();
        if (!invocation) return null;
        return { status: 'BLOCKED', nextGate: 'classify-change', title, reason: `${rejection} ${why}`,
            commands: [buildCommand('Refresh preflight', invocation.command)] };
    };
    if (facts?.source === 'review-lanes') return operator('The operator decides the task scope, review lanes or validation '
        + 'contract named above; an agent must not change them to pass this gate.');
    const authorityIssue = facts?.source === 'authority' ? facts.issue
        : facts?.source === 'phases' ? facts.authorityIssue : undefined;
    if (authorityIssue === 'audit-repair') return resolveValidationAuthorityOperatorRoute(rejection, authorityIssue, options.cliPrefix);
    // The audited admission is already recorded: refreshing the preflight only binds it; nothing is approved here.
    const readmitted = authorityIssue === 'readmitted' ? refresh('Refresh preflight for the admitted validation contract.',
        'The current project validation contract has an audited admission newer than the one this preflight froze. '
        + 'Refresh the preflight so it binds that admission, then rerun the Navigator.') : null;
    if (readmitted) return readmitted;
    if (authorityIssue) return operator(
        'The operator must confirm or re-approve the project validation contract '
        + `(${options.cliPrefix} workflow set --project-validation-contract "<contract path>" with their confirmation); `
        + 'then refresh preflight with classify-change and rerun the Navigator.');
    if (facts?.source === 'inspection' && facts.retry === 'classify-change') {
        const route = refresh('Refresh preflight before inspecting declared validation.',
            'The declared recipes froze a different preflight file than the one this run read. Refresh the preflight at '
            + 'the navigator path so both name one classification, then rerun the Navigator.');
        if (route) return route;
    }
    if (facts?.source === 'inspection' && facts.stop === 'preflight-identity') return operator('The preflight file is '
        + 'stable and equal to the classification the declared recipes froze, but this run identified its preflight '
        + 'differently, so nothing is changing and a retry would repeat the mismatch. Ask the operator to check the preflight '
        + 'identity or refresh the classification, then rerun the Navigator.');
    if (facts?.source === 'inspection' && facts.stop === 'unchanged') return operator('The same validation inspection race '
        + 'repeated on unchanged preflight, timeline and recipe content, so it is not a concurrent change and a retry cannot clear '
        + 'it. Ask the operator to repair the reported evidence, then rerun the Navigator.');
    if (facts?.source === 'inspection' && facts.stop === 'exhausted') return operator(`Validation inputs kept changing `
        + `across ${facts.attempts ?? 0} fresh inspections in a row. Ask the operator to stop whatever keeps changing the `
        + 'preflight, the task timeline or the declared recipe inputs, then rerun the Navigator.');
    if (facts?.source === 'inspection' && facts.retry === 'next-step' && facts.retryToken) {
        // Bounded: the stated retry carries the attempt and the inputs' content witness, which the next answer compares.
        return { status: 'BLOCKED', nextGate: VALIDATION_INSPECTION_RETRY_GATE,
            title: 'Retry next-step with a fresh validation inspection.',
            reason: `${rejection} Validation inputs changed while this run inspected them; nothing was accepted. `
                + 'Wait for running checks or edits to finish, then retry next-step with a fresh inspection.',
            commands: [buildCommand('Retry next-step', `${buildNavigatorCommand(options.cliPrefix, options.taskId)}`
                + ` --inspection-retry ${quoteCommandValue(facts.retryToken)}`)] };
    }
    if (facts?.source === 'phases' && facts.executionKind === 'task-command' && facts.structural === 'BOUND')
        return { status: 'BLOCKED', nextGate: 'run-intermediate-command', title: 'Record current execution for the selected cases.',
            reason: `${rejection} Declare the actual command and record it using: ${options.nativeCommand}`,
            commands: [] };
    if (facts?.source === 'phases' && facts.structural !== 'BOUND') return { status: 'BLOCKED', nextGate: 'quality-checklist',
        title: 'Correct the trust-boundary matrix in the checklist answers.',
        reason: `${rejection} Correct the trust-boundary matrix so each selected case cites a declared validation target `
            + `(answer in ${options.answersPath ? formatNextStepInlineValue(options.answersPath) : 'the checklist answers file'}), `
            + 'resubmit it through quality-checklist and rerun the Navigator. '
            + 'If the case the task needs has no declared target, ask the operator to change the validation contract.',
        commands: [] };
    if (facts?.source === 'phases' && facts.rejectedRecipeIds.length > 0) return { status: 'BLOCKED',
        nextGate: 'project-validation-evidence', title: 'Record a fresh run of the rejected declared recipe.',
        reason: `${rejection} The rejected execution does not count. Fix the failure it reports if there is one, `
            + 'then record a genuine fresh run of the admitted recipe.',
        commands: [...new Set(facts.rejectedRecipeIds)].map(recipeId => buildCommand(`Record a fresh run of recipe ${recipeId}`,
            `${options.cliPrefix} gate run-intermediate-command --task-id ${quoteCommandValue(options.taskId)} `
                + `--recipe-id ${quoteCommandValue(recipeId)} --repo-root "."`)) };
    if (facts?.source === 'phases') return operator('The declared validation phases are bound but name no pending or rejected '
        + 'recipe execution Garda can select, so no agent run can be stated safely. '
        + 'Ask the operator to repair the reported evidence or validation contract, then rerun the Navigator.');
    return operator('Garda could not inspect this declared validation evidence, so no agent run can be stated safely. '
        + 'Ask the operator to repair the reported evidence or validation contract, then rerun the Navigator.');
}

interface BaselineOnlyRoute {
    nextGate: string;
    title: string;
    reason: string;
    commands?: NextStepDecisionRoutePayload['commands'];
}

interface TestFirstExpectedFailureRoute {
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepDecisionRoutePayload['commands'];
}

export interface NextStepGuardDecision {
    route: NextStepDecisionRoutePayload | null;
    warnings: string[];
}

export function resolveScopeBudgetGuardDecisionRoute(options: {
    evaluation: ScopeBudgetGuardEvaluation | null;
    guardReason: string | null;
    materializeLatch: () => SplitRequiredLatchResult;
    formatArtifactPath: (artifactPath: string) => string;
    presentArtifacts: NextStepDecisionRoutePayload['presentArtifacts'];
}): NextStepGuardDecision {
    const evaluation = options.evaluation;
    if (!evaluation) {
        return { route: null, warnings: [] };
    }
    const warnings = evaluation.should_warn
        ? [
            `${evaluation.summary_line}. Continuation allowed until a blocking scope-budget threshold is exceeded.`
        ]
        : [];
    if (!evaluation.should_block) {
        return { route: null, warnings };
    }

    const guardReason = options.guardReason || evaluation.summary_line;
    const latchResult = options.materializeLatch();
    if (
        latchResult.status_sync.outcome !== 'updated'
        && latchResult.status_sync.outcome !== 'already_synced'
    ) {
        return {
            warnings,
            route: {
                status: 'BLOCKED',
                nextGate: 'split-required-latch',
                title: 'Split-required latch could not update TASK.md.',
                reason:
                    `${guardReason}. The split-required latch artifact was materialized at ${formatNextStepInlineValue(options.formatArtifactPath(latchResult.artifact_path))}, ` +
                    `but TASK.md status sync failed with outcome ${formatNextStepInlineValue(latchResult.status_sync.outcome)}. ` +
                    `${latchResult.status_sync.error_message ? `${latchResult.status_sync.error_message} ` : ''}` +
                    'Do not continue parent compile, review, task test validation, completion, or final closeout gates until the latch is repaired.',
                commands: [],
                finalReport: null
            }
        };
    }

    return {
        warnings,
        route: {
            status: 'SPLIT_REQUIRED',
            nextGate: 'split-required-latch',
            title: 'Split-required latch is active.',
            reason:
                `${guardReason}. The gate moved this parent task to SPLIT_REQUIRED and materialized latch evidence at ` +
                `${formatNextStepInlineValue(options.formatArtifactPath(latchResult.artifact_path))}. ` +
                'Create and link child tasks before continuing; do not shrink or reshape the diff merely to bypass the guard. ' +
                'Ordinary classify, compile, review, task test validation, completion, and final closeout gates are suppressed for the parent while the latch is active.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: options.presentArtifacts,
            finalReport: null
        }
    };
}

export function resolveReviewCycleGuardDecisionRoute(options: {
    evaluation: ReviewCycleGuardEvaluation | null;
    getPendingRequiredReviewTypes: () => string[];
    assessContinuation: (
        pendingRequiredReviewTypes: string[]
    ) => ReviewCycleContinuationAssessment;
    buildOperatorBlock: () => NextStepReviewCycleBlock;
    materializeLatch: () => SplitRequiredLatchResult;
    materializeAutoSplitPrompt: (
        latchResult: SplitRequiredLatchResult
    ) => NextStepReviewCycleBlock['auto_split_prompt'];
    buildContinuationCommand: () => string;
    buildSplitDecisionCommand: () => string;
    formatArtifactPath: (artifactPath: string) => string;
    presentArtifacts: NextStepDecisionRoutePayload['presentArtifacts'];
    defaultMissingArtifacts: NextStepDecisionRoutePayload['missingArtifacts'];
    /** Side-effect-free preview of the operator reset that is the executable way out of damaged review history. */
    taskResetPreviewCommand?: string;
}): NextStepGuardDecision {
    const evaluation = options.evaluation;
    if (!evaluation) {
        return { route: null, warnings: [] };
    }

    if (!evaluation.should_block) {
        const warnings = evaluation.active
            && evaluation.action === 'WARN_ONLY'
            && evaluation.violations.length > 0
            ? [
                `${evaluation.summary_line}. ` +
                `Counts: total_non_test_reviews=${evaluation.total_non_test_review_count}, ` +
                `failed_non_test_reviews=${evaluation.failed_non_test_review_count}, ` +
                `excluded_review_types=${formatNextStepInlineList(evaluation.excluded_review_types)}.`
            ]
            : [];
        return { route: null, warnings };
    }

    if (evaluation.violations.some(violation => violation.metric === 'timeline_integrity')) {
        const reviewCycleBlock = options.buildOperatorBlock();
        return {
            warnings: [],
            route: {
                status: 'BLOCKED',
                nextGate: 'review-cycle-attempt-guard',
                title: 'Ask the operator to repair authenticated review history.',
                reason: evaluation.summary_line,
                commands: options.taskResetPreviewCommand
                    ? [buildCommand('Preview task reset after preserving evidence', options.taskResetPreviewCommand)] : [],
                reviewCycleBlock: { ...reviewCycleBlock, reason: evaluation.summary_line, auto_split_enabled: false,
                    operator_decision_required: true, wait_for_operator: true,
                    choices: ['restore_authenticated_history', 'task_reset'],
                    operator_choice_guidance: [evaluation.summary_line] },
                missingArtifacts: options.defaultMissingArtifacts,
                presentArtifacts: options.presentArtifacts,
                finalReport: null
            }
        };
    }

    const continuationEvidence = options.assessContinuation(
        options.getPendingRequiredReviewTypes()
    );
    if (continuationEvidence.status === 'ACTIVE') {
        return {
            route: null,
            warnings: [
                `Review cycle one-shot continuation active: ${continuationEvidence.reason}. ` +
                `Artifact: ${formatNextStepInlineValue(options.formatArtifactPath(continuationEvidence.artifact_path))}. ` +
                'This approval is task-scoped runtime evidence only and does not mutate workflow-config.json; raise_limits remains a permanent repo-local workflow-config change through workflow set.'
            ]
        };
    }

    const warnings = continuationEvidence.status === 'MISSING'
        ? []
        : [
            `Review cycle one-shot continuation ${continuationEvidence.status.toLowerCase()}: ${continuationEvidence.reason}. ` +
            `Artifact: ${formatNextStepInlineValue(options.formatArtifactPath(continuationEvidence.artifact_path))}.`
        ];
    const reviewCycleBlock = options.buildOperatorBlock();
    const continuationAlreadyRecorded = continuationEvidence.status !== 'MISSING';
    if (continuationAlreadyRecorded) {
        reviewCycleBlock.choices = reviewCycleBlock.choices.filter(
            (choice) => choice !== 'allow_one_more_cycle'
        );
        reviewCycleBlock.operator_choice_guidance = reviewCycleBlock.operator_choice_guidance
            .filter((guidance) => !guidance.startsWith('allow_one_more_cycle:'));
        reviewCycleBlock.operator_choice_guidance.push(
            'continuation_already_recorded: A one-shot continuation was already recorded for this task attempt; do not offer or accept another one. Continue by splitting/decomposing the task or choosing an explicit terminal/operator decision.'
        );
    }

    const autoSplitEnabled = reviewCycleBlock.auto_split_enabled;
    const continuationDecisionGuidance = continuationAlreadyRecorded
        ? 'A one-shot continuation was already recorded for this task attempt; do not offer or accept another one. Continue by splitting/decomposing the task or choosing an explicit terminal/operator decision.'
        : 'The configured workflow guard blocks additional compile, review, or task test continuation until operator decision. allow_one_more_cycle records task-scoped one-shot runtime evidence only; raise_limits is a permanent repo-local workflow-config change through workflow set.';
    let splitRequiredLatch: SplitRequiredLatchResult | null = null;
    if (autoSplitEnabled) {
        splitRequiredLatch = options.materializeLatch();
        // Complete the inspected effect plan even if status publication failed. The native callback
        // records the second effect as a no-op in that case; it must not publish a split prompt.
        const autoSplitPrompt = options.materializeAutoSplitPrompt(splitRequiredLatch);
        if (
            splitRequiredLatch.status_sync.outcome !== 'updated'
            && splitRequiredLatch.status_sync.outcome !== 'already_synced'
        ) {
            return {
                warnings,
                route: {
                    status: 'BLOCKED',
                    nextGate: 'split-required-latch',
                    title: 'Split-required latch could not update TASK.md.',
                    reason:
                        `${reviewCycleBlock.reason}. The split-required latch artifact was materialized at ` +
                        `${formatNextStepInlineValue(options.formatArtifactPath(splitRequiredLatch.artifact_path))}, ` +
                        `but TASK.md status sync failed with outcome ${formatNextStepInlineValue(splitRequiredLatch.status_sync.outcome)}. ` +
                        `${splitRequiredLatch.status_sync.error_message ? `${splitRequiredLatch.status_sync.error_message} ` : ''}` +
                        'Do not continue parent compile, review, task test validation, completion, or final closeout gates until the latch is repaired.',
                    commands: [],
                    reviewCycleBlock,
                    finalReport: null
                }
            };
        }
        reviewCycleBlock.auto_split_prompt = autoSplitPrompt;
    }

    return {
        warnings,
        route: {
            status: autoSplitEnabled ? 'SPLIT_REQUIRED' : 'BLOCKED',
            nextGate: autoSplitEnabled ? 'split-required-latch' : 'review-cycle-attempt-guard',
            title: autoSplitEnabled ? 'Split-required latch is active.' : 'Review cycle limit exceeded.',
            reason:
                `${reviewCycleBlock.reason}. ` +
                `Counts: total_non_test_reviews=${evaluation.total_non_test_review_count}, ` +
                `failed_non_test_reviews=${evaluation.failed_non_test_review_count}, ` +
                `excluded_review_types=${formatNextStepInlineList(evaluation.excluded_review_types)}. ` +
                (autoSplitEnabled
                    ? `The gate moved this parent task to SPLIT_REQUIRED and materialized latch evidence at ${formatNextStepInlineValue(options.formatArtifactPath(splitRequiredLatch?.artifact_path || ''))}. Follow the auto-split prompt artifact and create linked child tasks before continuing child work.`
                    : continuationDecisionGuidance),
            commands: autoSplitEnabled
                ? []
                : [
                    ...(continuationAlreadyRecorded
                        ? []
                        : [
                            buildCommand(
                                'Record one-shot review-cycle continuation',
                                options.buildContinuationCommand()
                            )
                        ]),
                    buildCommand(
                        'Record review-cycle split decision',
                        options.buildSplitDecisionCommand()
                    )
                ],
            reviewCycleBlock,
            missingArtifacts: autoSplitEnabled ? [] : options.defaultMissingArtifacts,
            presentArtifacts: options.presentArtifacts,
            finalReport: null
        }
    };
}

export function resolveValidationDecisionRoute(options: {
    lifecycleGateIds?: readonly string[];
    resolveDeclaredValidationRoute?: () => ValidationRoute | null;
    /** The focused run the checklist about to be recorded needs first; see resolveFocusedRunBeforeChecklistRoute. */
    resolveChecklistFocusedRunRoute?: () => ValidationRoute | null;
    resolveQualityChecklistRoute: () => ValidationRoute | null;
    resolveBaselineOnlyPreImplementationRoute: () => BaselineOnlyRoute | null;
    resolveTestFirstExpectedFailureRoute?: () => TestFirstExpectedFailureRoute | null;
    resolveCompileGateRoute: () => ValidationRoute | null;
    resolveAuditedNoOpState: () => {
        required: boolean;
        passed: boolean;
        evidenceStatus: string;
        command: string;
    };
    resolveFullSuiteValidationRoute: () => ValidationRoute | null;
}): NextStepDecisionRoutePayload | null {
    const gateIds = options.lifecycleGateIds ?? getActiveTaskLifecycleGateIds('validation', {
        changes_exist: true,
        optional_quality_checks_enabled: true,
        full_suite_after_compile_before_reviews: true
    });
    let baselineChecked = false;
    let testFirstChecked = false;
    let noOpChecked = false;
    const resolveBaselineRoute = (): ValidationRoute | null => {
        baselineChecked = true;
        const route = options.resolveBaselineOnlyPreImplementationRoute();
        return route
            ? {
                status: 'BLOCKED',
                nextGate: route.nextGate,
                title: route.title,
                reason: route.reason,
                commands: route.commands ?? []
            }
            : null;
    };
    const resolveTestFirstRoute = (): ValidationRoute | null => {
        testFirstChecked = true;
        const route = options.resolveTestFirstExpectedFailureRoute?.() ?? null;
        return route
            ? {
                status: 'BLOCKED',
                nextGate: route.nextGate,
                title: route.title,
                reason: route.reason,
                commands: route.commands
            }
            : null;
    };
    const resolveNoOpRoute = (): ValidationRoute | null => {
        noOpChecked = true;
        const state = options.resolveAuditedNoOpState();
        if (!state.required || state.passed) {
            return null;
        }
        return {
            status: 'BLOCKED',
            nextGate: 'record-no-op',
            title: 'Record audited zero-diff no-op evidence.',
            reason:
                'The current preflight is BASELINE_ONLY with no reviewable diff and requires audited no-op evidence before review or completion gates can pass. ' +
                `Record no-op evidence or implement changes and refresh preflight; current no-op evidence status: ${state.evidenceStatus}.`,
            commands: [buildCommand('Record audited no-op evidence', state.command)]
        };
    };
    const declaredRoute = options.resolveDeclaredValidationRoute?.();
    if (declaredRoute) return resolveBaselineRoute() ?? resolveTestFirstRoute() ?? declaredRoute;
    const route = resolveFirstActiveTaskLifecycleGate(gateIds, {
        // Like a declared validation run, the checklist's focused run waits for the planned diff and the expected RED.
        'optional-quality-checklist': () => {
            const focusedRun = options.resolveChecklistFocusedRunRoute?.() ?? null;
            return focusedRun
                ? resolveBaselineRoute() ?? resolveTestFirstRoute() ?? focusedRun
                : options.resolveQualityChecklistRoute();
        },
        'compile-gate': () => (
            resolveBaselineRoute()
            ?? resolveTestFirstRoute()
            ?? options.resolveCompileGateRoute()
        ),
        'full-suite-validation': () => resolveNoOpRoute() ?? options.resolveFullSuiteValidationRoute()
    });
    if (route) {
        return route;
    }
    return (!baselineChecked ? resolveBaselineRoute() : null)
        ?? (!testFirstChecked ? resolveTestFirstRoute() : null)
        ?? (!noOpChecked ? resolveNoOpRoute() : null);
}
