import {
    type FullSuiteValidationPlacement
} from '../../core/workflow-config';
import {
    type GateOutcome
} from '../task-audit/task-audit-summary-collectors';
import {
    buildCommand,
    quoteCommandValue
} from './next-step-command-formatters';
import {
    redactSecretText
} from '../../core/redaction';
import type {
    NextStepCommand,
    NextStepStatus
} from './';

export interface NextStepFullSuiteValidationRoute {
    status: NextStepStatus;
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface InterruptedFullSuiteValidationRunRouteInput {
    markerPath: string;
    startedAtUtc: string;
    command: string;
    timeoutMs: number;
    gatePid: number;
    gateProcessAlive: boolean | null;
    childPid: number | null;
    childProcessAlive: boolean | null;
    childCommand: string | null;
    descendantProcessCandidates?: Array<{
        pid: number;
        parentPid: number | null;
        commandLine: string;
    }>;
    processScanWarning?: string | null;
    processCheckWarning?: string | null;
    markerState?: 'CURRENT' | 'STALE';
    markerStateReason?: string;
}

export interface NextStepFullSuiteValidationRoutingOptions {
    enabled: boolean;
    placement: FullSuiteValidationPlacement;
    notRequiredForCurrentScope: boolean;
    gateStatus: GateOutcome['status'] | null;
    gatePassed: boolean;
    timeoutBlockerExhausted: boolean;
    timeoutRepairTaskProposal: string | null;
    repeatedTimeoutBlockerAnalysis?: string | null;
    timeoutRepairTaskCommand?: string | null;
    taskRepairCommand?: string;
    timeoutRepairTaskMaterialized?: boolean;
    timedOutRetryAvailable: boolean;
    transientRetryEvidenceAvailable: boolean;
    transientRetryEvidenceReason: string | null;
    targetedDiagnosticRetryAvailable?: boolean;
    targetedDiagnosticRetryReason?: string | null;
    configPath: string;
    commandText: string;
    testSelectionViolations?: readonly string[];
    executionIntegrityViolations?: readonly string[];
    testSelectionCommand: string;
    testSelectionRequiresConfirmation: boolean;
    testSelectionReferenceCommand?: string;
    /** Offer a fresh selection for a project-wide command or after a failed opaque selection. */
    testSelectionReselectCommand?: string;
    outOfScopeFailure?: { refs: readonly string[]; repairCommand: string; narrowCommand?: string; widenScopeCommand: string; restoredRepairValidationCommand?: string; followUpCommand?: string; referenceCommand?: string; failedCommand?: string } | null;
    timeoutForecastLine: string | null;
    command: string;
    runMarkerRecoveryCommand: string;
    runMarkerCleanupCommand: string;
    navigatorCommand: string;
    nextReviewType: string | null;
    interruptedRun?: InterruptedFullSuiteValidationRunRouteInput | null;
    unresolvedRunMarkerPath?: string | null;
}

export const TASK_TEST_SELECTION_GUIDANCE =
    'Choose the tests that verify this task\'s changes and acceptance criteria; the selection applies to this task only. '
    + 'Supply a command that runs only this task\'s tests and relevant regressions. Every changed test and every target carried from a failed selection must run. '
    + 'For opaque entrypoints declare target and helper/data mappings with --task-test-plan (JSON or @file). Several literal commands may be joined by &&; each needs bound targets. '
    + 'Use the configured project command only as a reference to narrow from. ';

export function resolveNextStepFullSuiteValidationRoute(
    options: NextStepFullSuiteValidationRoutingOptions
): NextStepFullSuiteValidationRoute | null {
    const requiresEvidenceNow = shouldRunFullSuiteAfterCompileBeforeReviews(options.enabled, options.placement,
        options.notRequiredForCurrentScope) || shouldRunFullSuiteBeforeTestReview(options.enabled, options.placement,
        options.notRequiredForCurrentScope) && options.nextReviewType === 'test';
    // An unsatisfied test run cannot preempt an independent lane or hide its own repair handoff.
    const pendingTimeoutRepair = options.timeoutBlockerExhausted && !isTimeoutBlockerResolvedByRepairTask(options);
    if (requiresEvidenceNow && options.executionIntegrityViolations?.length && !pendingTimeoutRepair)
        return { status: 'BLOCKED', nextGate: 'full-suite-validation',
            title: options.placement === 'after_compile_before_reviews'
                ? 'Run task test validation after compile before reviews with current task execution evidence.'
                : 'Run task test validation before test review with current task execution evidence.',
            reason: options.executionIntegrityViolations.join(' '),
            commands: [buildCommand('Run selected own task tests with fresh process evidence', options.command)] };
    if (shouldRunFullSuiteAfterCompileBeforeReviews(
        options.enabled,
        options.placement,
        options.notRequiredForCurrentScope
    )) {
        return resolveTestSelectionRoute(options) ?? resolveOutOfScopeFullSuiteRoute(options.outOfScopeFailure)
            ?? withTaskTestReselection(resolveAfterCompileBeforeReviewsRoute(options), options);
    }

    if (
        shouldRunFullSuiteBeforeTestReview(
            options.enabled,
            options.placement,
            options.notRequiredForCurrentScope
        )
        && options.nextReviewType === 'test'
    ) {
        return resolveTestSelectionRoute(options) ?? resolveOutOfScopeFullSuiteRoute(options.outOfScopeFailure)
            ?? withTaskTestReselection(resolveBeforeTestReviewRoute(options), options);
    }

    return null;
}

/** A task that selected the project-wide command can always switch to its own tests before running it. */
function withTaskTestReselection(
    route: NextStepFullSuiteValidationRoute | null, options: NextStepFullSuiteValidationRoutingOptions
): NextStepFullSuiteValidationRoute | null {
    if (!route || route.nextGate !== 'full-suite-validation' || !options.testSelectionReselectCommand) return route;
    return {
        ...route,
        reason: route.reason + ' The current task selection is the configured project-wide command. If this task has its own '
            + 'tests, first select only them with the second command (replace its command placeholder), then run task test '
            + 'validation; keep the project command only when it is exactly this task\'s own test command.',
        commands: [...route.commands, buildCommand('Select only this task\'s tests', options.testSelectionReselectCommand)]
    };
}

export function resolveOutOfScopeFullSuiteRoute(
    failure: NextStepFullSuiteValidationRoutingOptions['outOfScopeFailure']
): (NextStepFullSuiteValidationRoute & { status: 'BLOCKED'; nextGate: 'task-test-selection' | 'materialize-full-suite-repair-task' | 'full-suite-validation' | 'materialize-review-follow-up-tasks' }) | null {
    if (!failure) return null;
    if (failure.followUpCommand && !failure.narrowCommand) {
        return { status: 'BLOCKED', nextGate: 'materialize-review-follow-up-tasks',
            title: 'Materialize the recorded broad failure follow-up.',
            reason: 'The task selection retains its required tests. Preserve the failed command and authenticated artifact in a distinct grouped child follow-up; test attribution is optional.',
            commands: [buildCommand('Materialize recorded failure follow-up', failure.followUpCommand)] };
    }
    if (failure.restoredRepairValidationCommand) {
        return {
            status: 'BLOCKED', nextGate: 'full-suite-validation',
            title: 'Revalidate the restored parent after the linked repair completed.',
            reason: `The authenticated repair handoff completed and parent WIP was restored. Original failing tests: ${failure.refs.join(', ')}. `
                + 'Run the original test command on the restored parent before continuing. '
                + 'AUDIT_AND_BLOCK still blocks DONE until passing validation resolves the original failure; completed repair tasks alone are not passing evidence.',
            commands: [buildCommand('Validate the original command after parent WIP restore', failure.restoredRepairValidationCommand)]
        };
    }
    return {
        status: 'BLOCKED', nextGate: failure.narrowCommand ? 'task-test-selection' : 'materialize-full-suite-repair-task',
        title: 'Narrow test selection to this task’s tests and regressions.',
        reason: `Failed command: ${redactSecretText(failure.failedCommand || 'see the task test artifact')}. Attributed tests (optional): ${failure.refs.join(', ') || 'not attributed'}. `
            + (failure.referenceCommand ? `Configured project command (reference to narrow from): ${redactSecretText(failure.referenceCommand)}. ` : '')
            + 'Narrow your selection to your task’s tests and relevant regressions. The entire failed run is recorded in the grouped follow-up task with its command and authenticated task test artifact; no per-test attribution or rerun of the broad command is required. Carried regression targets and current changed tests must remain selected. '
            + TASK_TEST_SELECTION_GUIDANCE
            + 'After the narrowed selection is accepted, materialize the recorded failure follow-up. '
            + 'For an alternative repair handoff: Declare one meaningful linked repair task in TASK.md for the task-owned failure, with independent Repair scope paths; '
            + 'declare more only when the repairs are independent. Garda-instructed repair rows are approved work: create them without asking the operator. '
            + 'Then run the printed materialization command to preserve parent WIP and execute the repair task(s). '
            + 'Alternatively, obtain explicit operator approval to widen this task\'s scope and update its acceptance criteria/plan, '
            + 'then run the scope-upgrade command with the approved repair paths. Refresh preflight, compile, select tests and validate again. '
            + `Operator-approved scope-upgrade command: ${failure.widenScopeCommand}`,
        commands: [...(failure.narrowCommand ? [buildCommand('Narrow this task’s test selection and record outside failures', failure.narrowCommand)] : []),
            ...(failure.followUpCommand ? [buildCommand('Materialize recorded failure follow-up after selection', failure.followUpCommand)] : []),
            buildCommand('Materialize the linked out-of-scope task test repair', failure.repairCommand),
            buildCommand('Widen scope after explicit operator approval', failure.widenScopeCommand)]
    };
}

export function resolveTestSelectionRoute(options: Pick<NextStepFullSuiteValidationRoutingOptions,
    'testSelectionViolations' | 'testSelectionCommand' | 'testSelectionRequiresConfirmation' | 'testSelectionReferenceCommand'>):
    (NextStepFullSuiteValidationRoute & { status: 'BLOCKED'; nextGate: 'task-test-selection' }) | null {
    if (!options.testSelectionViolations?.length) return null;
    return { status: 'BLOCKED', nextGate: 'task-test-selection',
        title: 'Select tests for the implemented task before running validation.',
        reason: options.testSelectionViolations.join(' ') + ' Select your own task\'s tests with this command; '
            + 'do not manually change the project-wide test command. The selection is bound to this task and its current evidence. '
            + 'Changed test files and carried regression targets are prefilled. Replace the command placeholder with your task-only test command and supply the reason. '
            + (options.testSelectionReferenceCommand ? `Configured project command (reference to narrow from): ${redactSecretText(options.testSelectionReferenceCommand)}. ` : '')
            + (options.testSelectionRequiresConfirmation
                ? 'Obtain genuine operator confirmation and use its fresh timestamp before running the command. ' : '')
            + TASK_TEST_SELECTION_GUIDANCE,
        commands: [buildCommand('Select current task tests', options.testSelectionCommand)] };
}

export function buildTaskTestSelectionCommand(
    cliPrefix: string, taskId: string, changedTests: readonly string[], requireConfirmation: boolean
): string {
    const parts = [
        `${cliPrefix} workflow set`,
        `--task-test-command ${quoteCommandValue('<command that runs only this task\'s tests and required regressions>')}`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--reason ${quoteCommandValue(`${taskId} verifies <task behavior and regression relationships>`)}`,
        ...changedTests.map(file => `--focused-required-test-path ${quoteCommandValue(file)}`)
    ];
    if (requireConfirmation) parts.push('--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp of operator approval>"');
    parts.push('--target-root "."');
    return parts.join(' ');
}

export function resolveTaskTestFailureRoute(command: string, repairCommand: string, selectionCommand?: string): NextStepFullSuiteValidationRoute & { status: 'BLOCKED'; nextGate: 'implementation' } {
    return { status: 'BLOCKED', nextGate: 'implementation',
        title: 'Fix the selected task tests before completion.',
        reason: 'The selected task tests failed. Fix this task, refresh preflight and compile when implementation changes, then rerun its selected command. Required changed tests and carried regression targets cannot be dropped. A bounded repair handoff may use one meaningful linked child with declared Repair scope paths.',
        commands: [buildCommand('Validate selected tests after fixing this task', command),
            ...(selectionCommand ? [buildCommand('Reselect task tests retaining all required targets', selectionCommand)] : []),
            buildCommand('Materialize a declared task repair child', repairCommand)] };
}

export function shouldRunFullSuiteAfterCompileBeforeReviews(
    enabled: boolean,
    placement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForCurrentScope: boolean
): boolean {
    return enabled
        && placement === 'after_compile_before_reviews'
        && !fullSuiteNotRequiredForCurrentScope;
}

export function shouldRunFullSuiteBeforeTestReview(
    enabled: boolean,
    placement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForCurrentScope: boolean
): boolean {
    return enabled
        && placement === 'before_test_review'
        && !fullSuiteNotRequiredForCurrentScope;
}

function resolveAfterCompileBeforeReviewsRoute(
    options: NextStepFullSuiteValidationRoutingOptions
): NextStepFullSuiteValidationRoute | null {
    const timeoutBlockerResolvedByRepairTask = isTimeoutBlockerResolvedByRepairTask(options);
    if (options.timeoutBlockerExhausted && !timeoutBlockerResolvedByRepairTask) {
        return buildTimeoutBlockerRepairRoute(
            options,
            'Materialize a linked task test timeout repair task handoff before reviewer launch.',
            'Do not launch independent reviewers until the timeout blocker is resolved or an audited repair handoff is materialized.'
        );
    }

    // A repair handoff resolves who repairs the timeout; it is not passing suite evidence.
    if (options.gateStatus === 'FAIL') {
        if (options.timedOutRetryAvailable) {
            return buildRetryRoute(
                options,
                'Retry task test validation with updated timeout forecast.',
                'Rerun the selected task test command before launching independent reviewers.'
            );
        }
        if (options.transientRetryEvidenceAvailable) {
            return buildManualTransientRetryRoute(
                options,
                'Retry task test validation after focused transient evidence.',
                'Rerun the selected task test command before launching independent reviewers.'
            );
        }
        if (options.targetedDiagnosticRetryAvailable) {
            return buildTargetedDiagnosticRetryRoute(
                options,
                'Retry task test validation after targeted diagnostics.',
                'Rerun the selected task test command before launching independent reviewers.'
            );
        }
        return {
            status: 'BLOCKED',
            nextGate: 'implementation',
            title: 'Fix task test failures before reviewer launch.',
            reason:
                `Task test validation is configured for placement '${options.placement}' and already failed for the current compiled scope. ` +
                `Do not launch independent reviewers until the selected task test command passes; ` +
                `fix the failures in the selected task tests, rerun compile-gate if implementation changed, then execute the printed task-test-validation command. `
                + 'A bounded repair handoff may use one meaningful linked child with declared Repair scope paths.',
            commands: [
                buildCommand(
                    'Rerun task test validation after fixing implementation',
                    options.command
                ),
                ...(options.testSelectionReselectCommand ? [buildCommand('Reselect task tests retaining all required targets', options.testSelectionReselectCommand)] : []),
                ...(options.taskRepairCommand ? [buildCommand('Materialize a declared task repair child', options.taskRepairCommand)] : [])
            ]
        };
    }

    if (!options.gatePassed) {
        const interruptedRoute = buildInterruptedRunRecoveryRoute(
            options,
            'Recover interrupted task test validation run.',
            'Recover the interrupted task test run before launching independent reviewers.'
        );
        if (interruptedRoute) {
            return interruptedRoute;
        }
        return {
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: 'Run task test validation after compile before reviews.',
            reason:
                `Effective workflow config enables task test validation at ${options.configPath} with placement '${options.placement}'. ` +
                `Run it after compile-gate and before launching independent reviewers so suite failures fail fast on the same compiled scope. ` +
                `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. ` +
                `Selected task test command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
            commands: [
                buildCommand(
                    'Run task test validation',
                    options.command
                )
            ]
        };
    }

    return null;
}

function resolveBeforeTestReviewRoute(
    options: NextStepFullSuiteValidationRoutingOptions
): NextStepFullSuiteValidationRoute | null {
    const timeoutBlockerResolvedByRepairTask = isTimeoutBlockerResolvedByRepairTask(options);
    if (options.timeoutBlockerExhausted && !timeoutBlockerResolvedByRepairTask) {
        return buildTimeoutBlockerRepairRoute(
            options,
            'Materialize a linked task test timeout repair task handoff before launching test review.',
            'Do not launch the mandatory test reviewer until the timeout blocker is resolved or an audited repair handoff is materialized.'
        );
    }

    if (options.gateStatus === 'FAIL') {
        if (options.timedOutRetryAvailable) {
            return buildRetryRoute(
                options,
                'Retry task test validation with updated timeout forecast.',
                'Rerun it before launching the mandatory test reviewer.'
            );
        }
        if (options.transientRetryEvidenceAvailable) {
            return buildManualTransientRetryRoute(
                options,
                'Retry task test validation after focused transient evidence.',
                'Rerun it before launching the mandatory test reviewer.'
            );
        }
        if (options.targetedDiagnosticRetryAvailable) {
            return buildTargetedDiagnosticRetryRoute(
                options,
                'Retry task test validation after targeted diagnostics.',
                'Rerun it before launching the mandatory test reviewer.'
            );
        }
        return {
            status: 'BLOCKED',
            nextGate: 'implementation',
            title: 'Fix task test failures before launching test review.',
            reason:
                `Task test validation is enabled and already failed for the current compiled scope. ` +
                `Do not launch the mandatory test reviewer until the selected task test command passes; ` +
                `fix the failures in the selected task tests, rerun compile-gate if implementation changed, then execute the printed task-test-validation command. `
                + 'A bounded repair handoff may use one meaningful linked child with declared Repair scope paths.',
            commands: [
                buildCommand(
                    'Rerun task test validation after fixing implementation',
                    options.command
                ),
                ...(options.testSelectionReselectCommand ? [buildCommand('Reselect task tests retaining all required targets', options.testSelectionReselectCommand)] : []),
                ...(options.taskRepairCommand ? [buildCommand('Materialize a declared task repair child', options.taskRepairCommand)] : [])
            ]
        };
    }

    if (!options.gatePassed) {
        const interruptedRoute = buildInterruptedRunRecoveryRoute(
            options,
            'Recover interrupted task test validation run.',
            'Recover the interrupted task test run before launching the mandatory test reviewer.'
        );
        if (interruptedRoute) {
            return interruptedRoute;
        }
        return {
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: 'Run task test validation before test review.',
            reason:
                `Effective workflow config enables task test validation at ${options.configPath} with placement '${options.placement}'. ` +
                `Run it before launching the mandatory test reviewer so suite failures fail fast on the same compiled scope. ` +
                `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. ` +
                `Selected task test command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
            commands: [
                buildCommand(
                    'Run task test validation',
                    options.command
                )
            ]
        };
    }

    return null;
}

function buildInterruptedRunRecoveryRoute(
    options: NextStepFullSuiteValidationRoutingOptions,
    title: string,
    retryInstruction: string
): NextStepFullSuiteValidationRoute | null {
    const interruptedRun = options.interruptedRun;
    if (!interruptedRun) {
        if (options.unresolvedRunMarkerPath) {
            return {
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Inspect unresolved task test run marker state.',
                reason:
                    `A task test run marker exists at ${options.unresolvedRunMarkerPath}, but it is stale, invalid, malformed, or not bound to the current preflight/compile cycle. ` +
                    `Do not start a fresh task test run until the marker is inspected because a new run would overwrite the diagnostic marker. ` +
                    `Run the recovery command to preserve evidence and report the exact marker state before any cleanup. ${retryInstruction} ` +
                    `Retry command after recovery: ${redactDiagnosticText(options.commandText)}. ${options.timeoutForecastLine || ''}`.trim(),
                commands: [
                    buildCommand(
                        'Inspect unresolved task test run marker state',
                        options.runMarkerRecoveryCommand
                    )
                ]
            };
        }
        return null;
    }
    const markerStateDetail = interruptedRun.markerState === 'STALE'
        ? ` The marker is stale for the current cycle: ${redactDiagnosticText(interruptedRun.markerStateReason || 'cycle binding mismatch')}.`
        : '';
    if (interruptedRun.gateProcessAlive !== false) {
        const gateStateUnknown = interruptedRun.gateProcessAlive === null;
        return {
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: gateStateUnknown
                ? 'Inspect unverifiable task test validation process state.'
                : 'Wait for active task test validation run.',
            reason:
                `A task test validation run marker started at ${interruptedRun.startedAtUtc} and its owner process is ${gateStateUnknown ? 'not safely verifiable' : 'still active'} for the current compiled scope. ` +
                `The run marker is ${interruptedRun.markerPath}; gate pid ${interruptedRun.gatePid} is ${gateStateUnknown ? 'unverifiable' : 'still alive'}.${markerStateDetail} ` +
                `Do not start a second task test run or clear this marker. ${gateStateUnknown ? 'Run recovery to preserve the exact process-check blocker.' : 'Wait for the active run to write terminal evidence, or inspect only task-owned processes if the run appears stuck.'} ` +
                `Interrupted command: ${redactDiagnosticText(interruptedRun.command)}. Timeout configured for this run: ${interruptedRun.timeoutMs} ms. ${options.timeoutForecastLine || ''}`.trim(),
            commands: [
                buildCommand(
                    gateStateUnknown
                        ? 'Inspect unverifiable task test run marker state'
                        : 'Rerun navigator after the active task test run completes',
                    gateStateUnknown ? options.runMarkerRecoveryCommand : options.navigatorCommand
                )
            ]
        };
    }

    const childState = interruptedRun.childPid == null
        ? 'no child PID was recorded'
        : interruptedRun.childProcessAlive
            ? `child pid ${interruptedRun.childPid} is still alive`
            : `child pid ${interruptedRun.childPid} is no longer alive`;
    const childCommand = interruptedRun.childCommand
        ? ` Child command: ${redactDiagnosticText(interruptedRun.childCommand)}.`
        : '';
    const descendantCandidates = interruptedRun.descendantProcessCandidates || [];
    const hasLiveChildTree =
        interruptedRun.childPid == null
        || interruptedRun.childProcessAlive === true
        || (interruptedRun.childPid != null && interruptedRun.childProcessAlive === null)
        || descendantCandidates.length > 0
        || !!interruptedRun.processScanWarning
        || !!interruptedRun.processCheckWarning;
    const descendantState = descendantCandidates.length > 0
        ? ` Live descendant candidates from the recorded child process: ${formatProcessCandidates(descendantCandidates)}.`
        : interruptedRun.processScanWarning || interruptedRun.processCheckWarning
            ? ` No descendant process candidates were listed because process verification failed: ${redactDiagnosticText(interruptedRun.processScanWarning || interruptedRun.processCheckWarning || '')}.`
            : ' No live descendant process candidates were discovered from the recorded child pid; do not kill generic node.exe or IDE/Codex Node processes without separate task-owned command-line or working-directory evidence.';
    const actionCommand = hasLiveChildTree
        ? options.runMarkerRecoveryCommand
        : options.runMarkerCleanupCommand;
    const actionLabel = hasLiveChildTree
        ? 'Inspect interrupted task test run marker'
        : 'Clear dead task test run marker after preserving recovery evidence';

    return {
        status: 'BLOCKED',
        nextGate: 'full-suite-validation',
        title,
        reason:
            `A previous task test validation run started at ${interruptedRun.startedAtUtc}, but no terminal task test artifact was materialized for the current compiled scope. ` +
            `The run marker is ${interruptedRun.markerPath}; gate pid ${interruptedRun.gatePid} is no longer alive; ${childState}.${markerStateDetail}${childCommand}${descendantState} ` +
            `Inspect and terminate only task-owned processes confirmed by the marker, descendant scan, command line, or working-directory evidence, then rerun task-test-validation. ${retryInstruction} ` +
            `Interrupted command: ${redactDiagnosticText(interruptedRun.command)}. Retry command: ${redactDiagnosticText(options.commandText)}. Timeout configured for the interrupted run: ${interruptedRun.timeoutMs} ms. ${options.timeoutForecastLine || ''}`.trim(),
        commands: [
            buildCommand(
                actionLabel,
                actionCommand
            )
        ]
    };
}

function formatProcessCandidates(candidates: Array<{
    pid: number;
    parentPid: number | null;
    commandLine: string;
}>): string {
    return candidates.slice(0, 5).map((candidate) => {
        const parent = candidate.parentPid == null ? 'unknown' : String(candidate.parentPid);
        const redactedCommandLine = redactDiagnosticText(candidate.commandLine);
        const commandLine = redactedCommandLine.length > 160
            ? `${redactedCommandLine.slice(0, 157)}...`
            : redactedCommandLine;
        return `pid=${candidate.pid}, ppid=${parent}, command=${commandLine || '<unavailable>'}`;
    }).join('; ');
}

function redactDiagnosticText(text: string): string {
    return redactSecretText(text);
}

function isTimeoutBlockerResolvedByRepairTask(
    options: NextStepFullSuiteValidationRoutingOptions
): boolean {
    return options.timeoutBlockerExhausted && options.timeoutRepairTaskMaterialized === true;
}

function buildRetryRoute(
    options: NextStepFullSuiteValidationRoutingOptions,
    title: string,
    retryInstruction: string
): NextStepFullSuiteValidationRoute {
    return {
        status: 'BLOCKED',
        nextGate: 'full-suite-validation',
        title,
        reason:
            `Task test validation timed out for the current compiled scope, and duration history now recommends a longer timeout. ` +
            `${retryInstruction} ` +
            `Selected task test command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
        commands: [
            buildCommand(
                'Retry task test validation',
                options.command
            )
        ]
    };
}

function buildTimeoutBlockerRepairRoute(
    options: NextStepFullSuiteValidationRoutingOptions,
    title: string,
    blockerInstruction: string
): NextStepFullSuiteValidationRoute {
    const proposal = options.timeoutRepairTaskProposal
        ? ` Diagnostic repair suggestion: ${options.timeoutRepairTaskProposal}.`
        : ' No structured repair-task proposal was found in the task test artifact; inspect the artifact before continuing.';
    const repairCommand = options.timeoutRepairTaskCommand || options.navigatorCommand;
    const repeatedBlocker = options.repeatedTimeoutBlockerAnalysis
        ? ` Repeated-blocker analysis: ${options.repeatedTimeoutBlockerAnalysis}. `
            + 'The same blocker fingerprint must not create another automatic nested repair child; '
            + 'continue only with a true independently scoped multi-child decomposition or an explicit recovery decision.'
        : '';
    return {
        status: 'BLOCKED',
        nextGate: 'full-suite-timeout-repair-task',
        title: options.repeatedTimeoutBlockerAnalysis
            ? 'Analyze repeated task test blocker before any nested repair routing.'
            : title,
        reason:
            `Task test validation timed out for the current compiled scope after exhausting the configured retry policy. ` +
            `${blockerInstruction}${proposal}${repeatedBlocker} ` +
            `Before materialization, declare one meaningful linked repair task with independent Repair scope paths; ` +
            `declare more only when the repairs are independent. Create these Garda-instructed rows without asking the operator, then run the printed command. ` +
            `The suggested_task_id alone does not declare or link a repair row. After the repair handoff is materialized ` +
            `or the timeout/runtime issue is fixed, rerun the navigator before any review launch. ` +
            `Selected task test command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
        commands: [
            buildCommand(
                options.timeoutRepairTaskCommand
                    ? 'Validate and materialize linked timeout repair handoff'
                    : 'Rerun navigator after audited timeout repair handoff is materialized',
                repairCommand
            )
        ]
    };
}

function buildManualTransientRetryRoute(
    options: NextStepFullSuiteValidationRoutingOptions,
    title: string,
    retryInstruction: string
): NextStepFullSuiteValidationRoute {
    const evidenceReason = options.transientRetryEvidenceReason
        ? ` ${options.transientRetryEvidenceReason}`
        : '';
    return {
        status: 'BLOCKED',
        nextGate: 'full-suite-validation',
        title,
        reason:
            `Task test validation failed for the current compiled scope, but task-scoped focused validation evidence marks the failure as transient or already cleared.${evidenceReason} ` +
            `${retryInstruction} Focused validation is recovery guidance only and does not replace mandatory task test evidence. ` +
            `Selected task test command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
        commands: [
            buildCommand(
                'Retry task test validation',
                options.command
            )
        ]
    };
}

function buildTargetedDiagnosticRetryRoute(
    options: NextStepFullSuiteValidationRoutingOptions,
    title: string,
    retryInstruction: string
): NextStepFullSuiteValidationRoute {
    const evidenceReason = options.targetedDiagnosticRetryReason
        ? ` ${options.targetedDiagnosticRetryReason}`
        : '';
    return {
        status: 'BLOCKED',
        nextGate: 'full-suite-validation',
        title,
        reason:
            `Task test validation failed for the current compiled scope, and task-scoped targeted diagnostic evidence passed afterward.${evidenceReason} ` +
            `${retryInstruction} Targeted diagnostics are recovery guidance only and do not replace mandatory task test evidence; ` +
            `use full-suite-retry-evidence.json only when the focused evidence is intentionally promoted as supported retry evidence. ` +
            `Selected task test command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
        commands: [
            buildCommand(
                'Retry task test validation',
                options.command
            )
        ]
    };
}
