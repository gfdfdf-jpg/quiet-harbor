import { getAllShimmedGateNames } from '../../compat/shim-registry';
import { taskValidationGateName } from '../../core/task-validation-names';
import { EXIT_GATE_FAILURE } from '../exit-codes';
import { findInvalidDefaultPreflight, InvalidPreflightError, MissingPreflightError } from './gate-reset-preflight';
import { buildGateCommandBase } from './gate-flows/task-mode/task-mode-command-format';

import {
    buildGateCommandOverviewText,
    buildGateHelpText,
    buildTaskIdSyntaxRemediationMessage,
    hasStandaloneGateHelpFlag
} from './gate-command-help';

const IMPLICIT_REVIEW_PREFLIGHT_GATES = new Set([
    'record-review-routing', 'prepare-reviewer-launch', 'record-review-invocation',
    'record-reviewer-delegation-started', 'record-reviewer-launch-failed', 'complete-reviewer-launch'
]);

function lastOptionValue(argv: string[], name: string): string {
    let value = '';
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === name) value = argv[++index] || '';
        else if (argv[index].startsWith(`${name}=`)) value = argv[index].slice(name.length + 1);
    }
    return value;
}

export async function handleGate(commandArgv: string[]): Promise<void> {
    if (commandArgv[0] === 'help') {
        const requestedGateName = String(commandArgv[1] || '').trim();
        console.log(requestedGateName ? buildGateHelpText(requestedGateName) : buildGateCommandOverviewText());
        return;
    }

    if (commandArgv.length === 0 || commandArgv[0] === '-h' || commandArgv[0] === '--help') {
        console.log(buildGateCommandOverviewText());
        console.log('');
        console.log('Available gates:');
        for (const name of getAllShimmedGateNames().sort()) {
            console.log(`  ${name === 'full-suite-validation' ? 'task-test-validation (alias: full-suite-validation)' : name}`);
        }
        return;
    }

    const gateName = taskValidationGateName(commandArgv[0]);
    const gateArgv = commandArgv.slice(1);
    if (hasStandaloneGateHelpFlag(gateArgv)) {
        console.log(buildGateHelpText(gateName));
        return;
    }
    const taskIdRemediationMessage = gateName === 'task-reset'
        ? null
        : buildTaskIdSyntaxRemediationMessage(gateName, gateArgv);
    if (taskIdRemediationMessage) {
        throw new Error(taskIdRemediationMessage);
    }

    try {
        // These review launch gates resolve the canonical preflight internally.
        // Inspect it before the handler can materialize or record any evidence.
        if (IMPLICIT_REVIEW_PREFLIGHT_GATES.has(gateName)) {
            const invalid = findInvalidDefaultPreflight(
                lastOptionValue(gateArgv, '--repo-root') || '.', lastOptionValue(gateArgv, '--task-id')
            );
            if (invalid) throw invalid;
        }
        await dispatchGate(gateName, gateArgv);
    } catch (error: unknown) {
        if (!(error instanceof MissingPreflightError) && !(error instanceof InvalidPreflightError)) throw error;
        const preflightError = error;
        const marker = `${gateName.toUpperCase().replace(/-/gu, '_')}_REFUSED`;
        const command = buildGateCommandBase(preflightError.repoRoot, preflightError.taskId || '<task-id>', 'next-step').join(' ');
        process.stdout.write([
            marker,
            ...(preflightError.taskId ? [`TaskId: ${preflightError.taskId}`] : []),
            `PreflightPath: ${preflightError.preflightPath.replace(/\\/gu, '/')}`,
            preflightError instanceof InvalidPreflightError
                ? `Reason: This preflight is ${preflightError.reason}. Nothing was changed.`
                : preflightError.removedByReset
                ? `Reason: Task '${preflightError.taskId}' was reset and this preflight no longer exists (missing). Nothing was changed.`
                : 'Reason: This preflight is missing or not found. Nothing was changed.',
            `Recovery: Run next-step and follow the gate it names: ${command}`
        ].join('\n') + '\n');
        process.exitCode = EXIT_GATE_FAILURE;
    }
}

async function dispatchGate(gateName: string, gateArgv: string[]): Promise<void> {
    switch (gateName) {
        case 'parent-audit':
            return (await import('./gate-parent-audit-handlers')).handleParentAudit(gateArgv);
        case 'validate-manifest':
            return (await import('./gate-validate-handlers')).handleValidateManifest(gateArgv);
        case 'validate-config':
            return (await import('./gate-validate-handlers')).handleValidateConfig(gateArgv);
        case 'classify-change':
            return (await import('./gate-build-handlers')).handleClassifyChange(gateArgv);
        case 'enter-task-mode':
            return (await import('./gate-task-handlers')).handleEnterTaskMode(gateArgv);
        case 'recover-task-mode-protected-manifest':
            return (await import('./gate-task-handlers')).handleRecoverTaskModeProtectedManifest(gateArgv);
        case 'restart-coherent-cycle':
            return (await import('./gate-task-handlers')).handleRestartCoherentCycle(gateArgv);
        case 'restart-review-cycle':
            return (await import('./gate-task-handlers')).handleRestartReviewCycle(gateArgv);
        case 'load-rule-pack':
            return (await import('./gate-task-handlers')).handleLoadRulePack(gateArgv);
        case 'bind-rule-pack-to-preflight':
            return (await import('./gate-task-handlers')).handleBindRulePackToPreflight(gateArgv);
        case 'record-no-op':
            return (await import('./gate-task-handlers')).handleRecordNoOp(gateArgv);
        case 'record-review-cycle-continuation':
            return (await import('./gate-task-handlers')).handleRecordReviewCycleContinuation(gateArgv);
        case 'record-review-cycle-split-decision':
            return (await import('./gate-task-handlers')).handleRecordReviewCycleSplitDecision(gateArgv);
        case 'record-strict-decomposition-decision':
            return (await import('./gate-task-handlers')).handleRecordStrictDecompositionDecision(gateArgv);
        case 'list-split-required-wip':
            return (await import('./gate-task-handlers')).handleListSplitRequiredWip(gateArgv);
        case 'restore-split-required-wip':
            return (await import('./gate-task-handlers')).handleRestoreSplitRequiredWip(gateArgv);
        case 'retire-split-required-wip':
            return (await import('./gate-task-handlers')).handleRetireSplitRequiredWip(gateArgv);
        case 'handshake-diagnostics':
            return (await import('./gate-task-handlers')).handleHandshakeDiagnostics(gateArgv);
        case 'shell-smoke-preflight':
            return (await import('./gate-task-handlers')).handleShellSmokePreflight(gateArgv);
        case 'command-timeout-diagnostics':
            return (await import('./gate-task-handlers')).handleCommandTimeoutDiagnostics(gateArgv);
        case 'quality-checklist':
            return (await import('./gate-task-handlers')).handleQualityChecklist(gateArgv);
        case 'run-intermediate-command':
            return (await import('./gate-task-handlers')).handleRunIntermediateCommand(gateArgv);
        case 'project-memory-impact':
            return (await import('./gate-task-handlers')).handleProjectMemoryImpact(gateArgv);
        case 'compile-gate':
            return (await import('./gate-build-handlers')).handleCompileGate(gateArgv);
        case 'build-scoped-diff':
            return (await import('./gate-build-handlers')).handleBuildScopedDiff(gateArgv);
        case 'build-review-context':
            return (await import('./gate-build-handlers')).handleBuildReviewContext(gateArgv);
        case 'activate-optional-skill':
            return (await import('./gate-build-handlers')).handleActivateOptionalSkill(gateArgv);
        case 'decline-optional-skill':
            return (await import('./gate-build-handlers')).handleDeclineOptionalSkill(gateArgv);
        case 'task-events-summary':
            return (await import('./gate-task-handlers')).handleTaskEventsSummary(gateArgv);
        case 'task-audit-summary':
            return (await import('./gate-task-handlers')).handleTaskAuditSummary(gateArgv);
        case 'next-step':
            return (await import('./gate-next-step-handler')).handleNextStep(gateArgv);
        case 'log-task-event':
            return (await import('./gate-task-handlers')).handleLogTaskEvent(gateArgv);
        case 'required-reviews-check':
            return (await import('./gate-review-handlers')).handleRequiredReviewsCheck(gateArgv);
        case 'doc-impact-gate':
            return (await import('./gate-review-handlers')).handleDocImpactGate(gateArgv);
        case 'full-suite-validation':
            return (await import('./gate-task-handlers')).handleFullSuiteValidation(gateArgv);
        case 'full-suite-run-marker-recovery':
            return (await import('./gate-task-handlers')).handleFullSuiteRunMarkerRecovery(gateArgv);
        case 'materialize-full-suite-repair-task':
            return (await import('./gate-task-handlers')).handleMaterializeFullSuiteRepairTask(gateArgv);
        case 'restore-full-suite-repair-wip':
            return (await import('./gate-task-handlers')).handleRestoreFullSuiteRepairWip(gateArgv);
        case 'record-review-result':
            return (await import('./gate-review-handlers')).handleRecordReviewResult(gateArgv);
        case 'record-review-output-correction-transport':
            return (await import('./gate-review-handlers')).handleRecordReviewOutputCorrectionTransport(gateArgv);
        case 'record-review-output-correction-response':
            return (await import('./gate-review-handlers')).handleRecordReviewOutputCorrectionResponse(gateArgv);
        case 'record-review-output-correction-invocation':
            return (await import('./gate-review-handlers')).handleRecordReviewOutputCorrectionInvocation(gateArgv);
        case 'completion-gate':
            return (await import('./gate-task-handlers')).handleCompletionGate(gateArgv);
        case 'record-review-routing':
            return (await import('./gate-review-handlers')).handleRecordReviewRouting(gateArgv);
        case 'prepare-reviewer-launch':
            return (await import('./gate-review-handlers')).handlePrepareReviewerLaunch(gateArgv);
        case 'record-reviewer-delegation-started':
            return (await import('./gate-review-handlers')).handleRecordReviewerDelegationStarted(gateArgv);
        case 'record-reviewer-launch-failed':
            return (await import('./gate-review-handlers')).handleRecordReviewerLaunchFailed(gateArgv);
        case 'complete-reviewer-launch':
            return (await import('./gate-review-handlers')).handleCompleteReviewerLaunch(gateArgv);
        case 'record-review-invocation':
            return (await import('./gate-review-handlers')).handleRecordReviewInvocation(gateArgv);
        case 'record-review-receipt':
            return (await import('./gate-review-handlers')).handleRecordReviewReceipt(gateArgv);
        case 'materialize-review-follow-up-tasks':
            return (await import('./gate-review-handlers')).handleMaterializeReviewFollowUpTasks(gateArgv);
        case 'human-commit':
            return (await import('./gate-task-handlers')).handleHumanCommit(gateArgv);
        case 'validate-isolation':
            return (await import('./gate-isolation-handlers')).handleValidateIsolation(gateArgv);
        case 'prepare-isolation':
            return (await import('./gate-isolation-handlers')).handlePrepareIsolation(gateArgv);
        case 'task-reset':
            return (await import('./gate-task-handlers')).handleTaskReset(gateArgv);
        default:
            throw new Error(`Unknown gate: ${gateName}`);
    }
}
