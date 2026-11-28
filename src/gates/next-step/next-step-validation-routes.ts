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
import { attachNextStepCommandExecution, type NextStepClassifyChangeArguments } from './next-step-command-execution';
import type {
    NextStepQualityChecklistReadiness, NextStepValidationRejectionFacts
} from './next-step-quality-checklist-readiness';
import type { FocusedCommandHint } from '../test-first/expected-red-evidence';
import type { QualityValidationPhases } from '../quality-checklist/quality-checklist-validation-phases';
import type { ProjectValidationAuthorityIssue } from '../../core/project-validation-errors';

type ValidationRoute = NextStepDecisionRoutePayload;

/** The navigator's preflight refresh for the current task scope (classify-change), built only when a route needs it. */
export type ValidationPreflightRefresh = () => { command: string; arguments: NextStepClassifyChangeArguments | null };

/** The retry gate of a typed validation inspection race (listed in NEXT_STEP_RETRY_GATES). */
export const VALIDATION_INSPECTION_RETRY_GATE = 'validation-inspection';

export function buildFocusedValidationRecoveryCommand(options: {
    cliPrefix: string; taskId: string; preflightPath: string; hint: FocusedCommandHint; expectedFailure?: boolean;
}): string {
    return `${options.cliPrefix} gate run-intermediate-command --task-id ${quoteCommandValue(options.taskId)}`
        + ` --command-source targeted-test --command ${quoteCommandValue(options.hint.command)}`
        + ` --preflight-path ${quoteCommandValue(options.preflightPath)}`
        + options.hint.cases.map(claim => ` --selected-case ${quoteCommandValue(JSON.stringify(claim))}`).join('')
        + options.hint.reports.map(report => ` --report-file ${quoteCommandValue(JSON.stringify(report))}`).join('')
        + (options.expectedFailure ? ' --expect-failure' : '') + ' --repo-root "."';
}

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
    if (readiness?.validationRejection) {
        const recovery = readiness.validationRecovery;
        const command = recovery?.kind === 'native' ? buildFocusedValidationRecoveryCommand({ ...options,
            preflightPath: recovery.preflightPath, hint: recovery.hint }) : recovery?.kind === 'recipe'
            ? `${options.cliPrefix} gate run-intermediate-command --task-id ${quoteCommandValue(options.taskId)}`
                + ` --recipe-id ${quoteCommandValue(recovery.recipeId)} --repo-root "."` : null;
        if (command && recovery) return { status: 'BLOCKED', nextGate: 'project-validation-evidence',
            title: 'Resolve rejected declared validation evidence.', reason: readiness.validationRejection
                + ' The old execution is outside current evidence authority and still does not count. Record a genuine fresh owning run.',
            // The run repeats a check Garda already bound (the agent's own retained focused run or an admitted
            // recipe); the gate still owns every admission, scope and evidence check of the fresh run.
            commands: [attachNextStepCommandExecution(buildCommand('Record fresh current validation', command), 'mechanical', {
                operation_id: 'run-intermediate-command',
                arguments: recovery.kind === 'native' ? {
                    task_id: options.taskId, recipe_id: null, command: recovery.hint.command, command_source: 'targeted-test',
                    preflight_path: recovery.preflightPath,
                    selected_cases: recovery.hint.cases.map(claim => JSON.stringify(claim)),
                    report_files: recovery.hint.reports.map(report => JSON.stringify(report))
                } : {
                    task_id: options.taskId, recipe_id: recovery.recipeId, command: null, command_source: null,
                    preflight_path: null, selected_cases: [], report_files: []
                }
            })] };
        return resolveRejectedValidationRoute({ ...options, rejection: readiness.validationRejection,
            facts: readiness.validationRejectionFacts, answersPath: readiness.answersTemplatePath, nativeCommand });
    }
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

const READMITTED_CAUSE = 'The current project validation contract has an audited admission newer than the one this preflight froze.';
const APPROVAL_CAUSE = 'The approved project validation contract or its audited authority changed.';

function reapprovalStep(cliPrefix: string): string {
    return `confirm or re-approve the project validation contract (${cliPrefix} workflow set --project-validation-contract `
        + '"<contract path>" with their confirmation)';
}

function resolveWorkflowAuditRepairRoute(reason: string): ValidationRoute {
    return { status: 'BLOCKED', nextGate: 'project-validation-evidence',
        title: 'Ask the operator to repair the workflow-config audit.',
        reason: `${reason} The operator must repair the audit, then rerun the Navigator.`, commands: [], decision: 'operator' };
}

/**
 * Garda's typed authority rejection behind a prepared coherent RED recovery. Its checkpoint binds the preflight path and
 * the authorized scope, not the preflight bytes, so the same-path refresh that binds an audited readmission keeps it.
 * RED recorded under the earlier admission does not carry across a changed authority, so the refresh is the agent's
 * step while this cycle has not started implementation (RED can still precede it); afterwards the operator decides.
 */
export function resolveCoherentRecoveryAuthorityRoute(options: {
    reason: string; authorityIssue: ProjectValidationAuthorityIssue; implementationStarted: boolean; cliPrefix: string;
    refreshPreflight?: ValidationPreflightRefresh;
}): ValidationRoute {
    const operator = (decision: string): ValidationRoute => ({ status: 'BLOCKED', nextGate: 'project-validation-evidence',
        title: 'Ask the operator to resolve project validation authority.',
        reason: `${options.reason} ${decision}`, commands: [], decision: 'operator' });
    if (options.authorityIssue === 'audit-repair') return resolveWorkflowAuditRepairRoute(options.reason);
    if (options.authorityIssue !== 'readmitted') return operator(`${APPROVAL_CAUSE} The operator must `
        + `${reapprovalStep(options.cliPrefix)}; then rerun the Navigator.`);
    if (options.implementationStarted) return operator(`${READMITTED_CAUSE} RED recorded under the earlier admission does `
        + 'not carry across a changed authority, and this coherent cycle has already started implementation, so no '
        + 'refreshed RED can precede it. The operator decides how the task continues; reopening the task starts a fresh cycle.');
    const invocation = options.refreshPreflight?.();
    const reason = `${options.reason} ${READMITTED_CAUSE} The prepared coherent recovery keeps its checkpoint across a `
        + 'same-path refresh within its authorized scope, and implementation has not started, so RED can still be '
        + 'recorded under that admission. Refresh the preflight so it binds the admission, then rerun the Navigator.';
    const title = 'Refresh preflight for the admitted validation contract.';
    if (!invocation) return { status: 'BLOCKED', nextGate: 'classify-change', title, reason, commands: [] };
    const command = buildCommand('Refresh preflight', invocation.command);
    return { status: 'BLOCKED', nextGate: 'classify-change', title, reason,
        commands: [invocation.arguments ? attachNextStepCommandExecution(command, 'mechanical',
            { operation_id: 'classify-change', arguments: invocation.arguments }) : command] };
}

/**
 * A prepared review recovery whose current validation is not ready. Its checkpoint binds the exact preflight bytes, so
 * the refresh that binds any admission makes it stale: Garda's typed authority rejection is the marked operator
 * decision, never a loop back through the same checkpoint. The reason text is never read to decide it; anything else
 * keeps the recovery step.
 */
export function resolveReviewRecoveryValidationRoute(options: {
    reason: string; authorityIssue?: ProjectValidationAuthorityIssue; cliPrefix: string;
}): ValidationRoute {
    if (options.authorityIssue === 'audit-repair') return resolveWorkflowAuditRepairRoute(options.reason);
    if (options.authorityIssue) return { status: 'BLOCKED', nextGate: 'project-validation-evidence',
        title: 'Ask the operator to resolve the validation authority of the prepared review recovery.',
        reason: `${options.reason} ${options.authorityIssue === 'readmitted' ? READMITTED_CAUSE : APPROVAL_CAUSE} `
            + 'The prepared review recovery checkpoint binds this exact preflight, so the refresh that binds an admission '
            + 'makes it stale and it cannot resume. The operator decides how the task continues'
            + (options.authorityIssue === 'readmitted' ? '' : ` (${reapprovalStep(options.cliPrefix)} first)`)
            + '; reopening the task starts a fresh review cycle.',
        commands: [], decision: 'operator' };
    return { status: 'BLOCKED', nextGate: 'project-validation-evidence', title: 'Obtain current recovery validation.',
        reason: options.reason, commands: [] };
}

/**
 * A rejected declared validation without a bound fresh run. Every class names its way on: the agent's own fresh run
 * (an admitted recipe, or the focused native check it declares), its own checklist correction, or an operator decision
 * marked as such. The gates still own every admission, scope and evidence check of whatever runs next.
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
        const command = buildCommand('Refresh preflight', invocation.command);
        return { status: 'BLOCKED', nextGate: 'classify-change', title, reason: `${rejection} ${why}`,
            commands: [invocation.arguments ? attachNextStepCommandExecution(command, 'mechanical',
                { operation_id: 'classify-change', arguments: invocation.arguments }) : command] };
    };
    if (facts?.source === 'review-lanes') return operator('The operator decides the task scope, review lanes or validation '
        + 'contract named above; an agent must not change them to pass this gate.');
    const authorityIssue = facts?.source === 'authority' ? facts.issue
        : facts?.source === 'phases' ? facts.authorityIssue : undefined;
    if (authorityIssue === 'audit-repair') return resolveWorkflowAuditRepairRoute(rejection);
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
        // An agent step, not a mechanical one: a retained failure needs the agent's fix before the rerun can pass.
        commands: [...new Set(facts.rejectedRecipeIds)].map(recipeId => attachNextStepCommandExecution(
            buildCommand(`Record a fresh run of recipe ${recipeId}`, `${options.cliPrefix} gate run-intermediate-command `
                + `--task-id ${quoteCommandValue(options.taskId)} --recipe-id ${quoteCommandValue(recipeId)} --repo-root "."`), 'agent')) };
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
    decision?: NextStepDecisionRoutePayload['decision'];
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
                commands: route.commands,
                // The producing route alone knows it is an operator decision: dropping the marker makes a dead end.
                ...(route.decision ? { decision: route.decision } : {})
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
