import type { RuleRefreshEntry } from '../../materialization/rule-refresh-files';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import { pathExists } from '../../core/filesystem';
import { readJsonFile } from '../../core/json';
import { runInstall } from '../../materialization/install';
import { runInit } from '../../materialization/init';
import { syncOptionalRuleSupportFiles } from '../../materialization/rule-support-files';
import { writeProtectedControlPlaneManifest } from '../../gates/shared/helpers';
import { getExpectedBundleInvariantPaths, validateBundleInvariants } from '../../validators/workspace-layout';
import {
    buildRefreshAgentInitState,
    doesAgentInitStateMatchAnswers,
    readAgentInitStateSafe,
    writeAgentInitState
} from '../../runtime/agent-init-state';
import { getActiveAgentEntrypointFiles } from '../../materialization/common';
import {
    PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT,
    readProjectMemoryMaintenanceRolloutSummaryFromBundle
} from '../../core/project-memory-rollout';
import { restoreRollbackSnapshot } from '../common';
import { getLiveVersionPayload, type ResolvedUpdateSources } from './update-source';
import { readPreservableCompileGateCommandFromFile } from '../agent-init/contract-migrations';
import { captureWorkflowConfigMigration, recordWorkflowConfigMigration } from '../../core/workflow-config-migration';
import { readUpdateTaskVerificationContext } from '../../core/update-task-receipt';
import { bindContainedDestination } from '../../core/contained-filesystem';
import { scanProtectedPathHashes } from '../../gates/protected-control-plane/protected-control-plane';
import { formatVerifyResult, runVerify } from '../../validators/verify';
import { formatManifestResult, validateManifest } from '../../validators/validate-manifest';
import { traceUpdateProgress } from './update-progress';
import {
    planRetiredSkillCopyRemoval,
    removeShippedRetiredSkillCopies,
    type RetiredSkillCopyOutcome
} from '../retired-skill-removal';

export interface InstallRunnerOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    runInit?: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    initAnswersPath: string;
    lifecycleLockAlreadyHeld?: boolean;
}

export interface MaterializationRunnerOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    assistantLanguage: string;
    assistantBrevity: string;
    sourceOfTruth: string;
    enforceNoAutoCommit: boolean;
    claudeOrchestratorFullAccess: boolean;
    tokenEconomyEnabled: boolean;
    providerMinimalism: boolean;
    activeAgentFilesSeed: string | null;
    preserveLegacyReviewExecutionPolicyOmission?: boolean;
    preservedCompileGateCommand?: string | null;
    lifecycleLockAlreadyHeld?: boolean;
}

export interface VerifyRunnerOptions {
    targetRoot: string;
    sourceOfTruth: string;
    initAnswersPath: string;
}

export interface ManifestRunnerOptions {
    targetRoot: string;
}

export interface ContractMigrationResult {
    appliedCount?: number;
    appliedFiles?: string[];
}

export interface ContractMigrationRunnerOptions {
    rootPath: string;
    preservedCompileGateCommand?: string | null;
}

interface RollbackRecord {
    relativePath: string;
    existed: boolean;
    pathType: string;
}

export interface UpdatePipelineRunners {
    installRunner?: ((options: InstallRunnerOptions) => Record<string, unknown> | void) | null;
    materializationRunner?: ((options: MaterializationRunnerOptions) => Record<string, unknown> | void) | null;
    verifyRunner?: ((options: VerifyRunnerOptions) => unknown) | null;
    manifestRunner?: ((options: ManifestRunnerOptions) => unknown) | null;
    contractMigrationRunner?: ((options: ContractMigrationRunnerOptions) => ContractMigrationResult) | null;
}

export interface UpdatePipelineStageResult {
    installStatus: string;
    materializationStatus: string;
    workflowConfigMergeStatus: string | null;
    optionalQualityChecksNotice?: string | null;
    projectMemoryMaintenanceSummaryLine?: string | null;
    projectMemoryRefreshHandoffPrompt?: string | null;
    projectMemoryDiagnostics?: ProjectMemoryLifecycleDiagnostics | null;
    ruleRefresh?: RuleRefreshEntry[];
    contractMigrationStatus: string;
    contractMigrationCount: number;
    contractMigrationFiles: string[];
    verifyStatus: string;
    manifestStatus: string;
    invariantStatus: string;
    updatedVersion: string;
    /** Per retired baseline skill id: removed, kept or absent (would-remove/would-keep on dry-run). */
    retiredSkillCopies?: RetiredSkillCopyOutcome[];
}

const verifiedUpdatePipelines = new WeakMap<UpdatePipelineStageResult, {
    transaction: object; root: string; bundle: string; protectedState: Record<string, string>;
}>();

/** Only this module's completed native pipeline can create a one-shot proof. */
export function consumeVerifiedUpdatePipeline(stage: UpdatePipelineStageResult, transaction: object,
    root: string, bundle: string): Record<string, string> | null {
    const proof = verifiedUpdatePipelines.get(stage);
    verifiedUpdatePipelines.delete(stage);
    return proof && proof.transaction === transaction && proof.root === root && proof.bundle === bundle
        ? { ...proof.protectedState } : null;
}

export interface ProjectMemoryLifecycleDiagnostics {
    copiedFiles: string[];
    preservedFiles: string[];
    missingTemplateFiles: string[];
    templateUpdateNotices: string[];
    bootstrapReportPath: string | null;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getWorkflowConfigMergeStatus(result: unknown): string | null {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return null;
    }
    const status = (result as Record<string, unknown>).workflowConfigMergeStatus;
    return typeof status === 'string' && status.trim()
        ? status
        : null;
}

function getOptionalQualityChecksNotice(result: unknown): string | null {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return null;
    }
    const notice = (result as Record<string, unknown>).optionalQualityChecksNotice;
    return typeof notice === 'string' && notice.trim()
        ? notice
        : null;
}

function getRuleRefresh(result: unknown): RuleRefreshEntry[] {
    const entries = result && typeof result === 'object' ? (result as Record<string, unknown>).ruleRefresh : null;
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is RuleRefreshEntry => Boolean(entry && typeof entry === 'object'
        && typeof entry.ruleFile === 'string'
        && (entry.backupPath === undefined || typeof entry.backupPath === 'string')
        && (entry.warning === undefined || typeof entry.warning === 'string')));
}

function getStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
        : [];
}

function getProjectMemoryDiagnostics(result: unknown): ProjectMemoryLifecycleDiagnostics | null {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return null;
    }

    const record = result as Record<string, unknown>;
    const report = record.projectMemoryBootstrapReport;
    const reportRecord = report && typeof report === 'object' && !Array.isArray(report)
        ? report as Record<string, unknown>
        : null;
    const seed = reportRecord?.seed && typeof reportRecord.seed === 'object' && !Array.isArray(reportRecord.seed)
        ? reportRecord.seed as Record<string, unknown>
        : null;
    if (!seed) {
        return null;
    }

    const rawNotices = Array.isArray(seed.template_update_notices)
        ? seed.template_update_notices
        : [];
    const templateUpdateNotices = rawNotices
        .map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            const notice = entry as Record<string, unknown>;
            const livePath = typeof notice.livePath === 'string' ? notice.livePath : '';
            const templatePath = typeof notice.templatePath === 'string' ? notice.templatePath : '';
            return livePath && templatePath
                ? `${livePath} preserved; template guidance available at ${templatePath}`
                : null;
        })
        .filter((entry): entry is string => Boolean(entry));

    const bootstrapReportPath = typeof record.projectMemoryBootstrapReportPath === 'string'
        ? record.projectMemoryBootstrapReportPath
        : null;

    return {
        copiedFiles: getStringArray(seed.copied_files),
        preservedFiles: getStringArray(seed.preserved_files),
        missingTemplateFiles: getStringArray(seed.missing_template_files),
        templateUpdateNotices,
        bootstrapReportPath
    };
}

/**
 * Executes the update pipeline stages (install, materialization, contract
 * migrations, verify, manifest validation, invariant check, agent-init-state
 * sync) and returns per-stage status. On failure, attempts rollback if a
 * snapshot exists and re-throws.
 */
export function executeUpdatePipelineStages(options: {
    normalizedTarget: string;
    bundleRoot: string;
    dryRun: boolean;
    skipVerify: boolean;
    skipManifestValidation: boolean;
    lifecycleLockAlreadyHeld: boolean;
    sources: ResolvedUpdateSources;
    runners: UpdatePipelineRunners;
    rollbackSnapshotCreated: boolean;
    rollbackSnapshotPath: string;
    rollbackRecords: RollbackRecord[];
}): UpdatePipelineStageResult & { rollbackStatus: string } {
    const {
        normalizedTarget,
        bundleRoot,
        dryRun,
        skipVerify,
        skipManifestValidation,
        lifecycleLockAlreadyHeld,
        sources,
        runners,
        rollbackSnapshotCreated,
        rollbackSnapshotPath,
        rollbackRecords
    } = options;

    const {
        installRunner = null,
        materializationRunner = null,
        verifyRunner = null,
        manifestRunner = null,
        contractMigrationRunner = null
    } = runners;

    let installStatus = 'NOT_RUN';
    let materializationStatus = 'NOT_RUN';
    let workflowConfigMergeStatus: string | null = null;
    let optionalQualityChecksNotice: string | null = null;
    let projectMemoryMaintenanceSummaryLine: string | null = null;
    let projectMemoryRefreshHandoffPrompt: string | null = null;
    let projectMemoryDiagnostics: ProjectMemoryLifecycleDiagnostics | null = null;
    let ruleRefresh: RuleRefreshEntry[] = [];
    let contractMigrationStatus = 'NOT_RUN';
    let verifyStatus = 'NOT_RUN';
    let manifestStatus = 'NOT_RUN';
    let invariantStatus = 'NOT_RUN';
    let updatedVersion = sources.bundleVersion;
    let contractMigrationCount = 0;
    let contractMigrationFiles: string[] = [];
    let rollbackStatus = 'NOT_NEEDED';
    let retiredSkillCopies: RetiredSkillCopyOutcome[] = [];
    const preservedCompileGateCommand = dryRun
        ? null
        : readPreservableCompileGateCommandFromFile(path.join(
            normalizedTarget,
            resolveBundleName(),
            'live',
            'docs',
            'agent-rules',
            '40-commands.md'
        ));

    const expectedInvariantPaths = getExpectedBundleInvariantPaths(bundleRoot);
    const taskVerification = readUpdateTaskVerificationContext();
    if (taskVerification && (taskVerification.root !== path.resolve(normalizedTarget)
        || taskVerification.bundle !== path.resolve(bundleRoot))) throw new Error('Task update native pipeline workspace mismatch.');
    let verifiedProtectedState: Record<string, string> | null = null;
    const workflowMigration = dryRun ? null : captureWorkflowConfigMigration(
        normalizedTarget, rollbackSnapshotCreated ? rollbackSnapshotPath : normalizedTarget);
    let currentStage = 'INSTALL';

    try {
        currentStage = 'INSTALL';
        traceUpdateProgress('lifecycle:install');
        if (installRunner) {
            installRunner({
                targetRoot: normalizedTarget,
                bundleRoot,
                dryRun,
                assistantLanguage: sources.assistantLanguage,
                assistantBrevity: sources.assistantBrevity,
                sourceOfTruth: sources.sourceOfTruth,
                initAnswersPath: sources.initAnswersResolvedPath,
                lifecycleLockAlreadyHeld
            });
        } else {
            runInstall({
                targetRoot: normalizedTarget,
                bundleRoot,
                runInit: false,
                dryRun,
                assistantLanguage: sources.assistantLanguage,
                assistantBrevity: sources.assistantBrevity,
                sourceOfTruth: sources.sourceOfTruth,
                initAnswersPath: sources.initAnswersResolvedPath,
                lifecycleLockAlreadyHeld
            });
        }
        installStatus = 'PASS';

        if (dryRun) {
            materializationStatus = 'SKIPPED_DRY_RUN';
            contractMigrationStatus = 'SKIPPED_DRY_RUN';
            verifyStatus = 'SKIPPED_DRY_RUN';
            manifestStatus = 'SKIPPED_DRY_RUN';
            retiredSkillCopies = planRetiredSkillCopyRemoval(bundleRoot);
        } else {
            currentStage = 'MATERIALIZATION';
            traceUpdateProgress('lifecycle:materialization');
            if (materializationRunner) {
                const materializationResult = materializationRunner({
                    targetRoot: normalizedTarget,
                    bundleRoot,
                    assistantLanguage: sources.assistantLanguage,
                    assistantBrevity: sources.assistantBrevity,
                    sourceOfTruth: sources.sourceOfTruth,
                    enforceNoAutoCommit: sources.enforceNoAutoCommit,
                    claudeOrchestratorFullAccess: sources.claudeOrchestratorFullAccess,
                    tokenEconomyEnabled: sources.tokenEconomyEnabled,
                    providerMinimalism: sources.providerMinimalism,
                    activeAgentFilesSeed: sources.activeAgentFilesSeed,
                    preserveLegacyReviewExecutionPolicyOmission: true,
                    preservedCompileGateCommand,
                    lifecycleLockAlreadyHeld
                });
                ruleRefresh = getRuleRefresh(materializationResult);
                workflowConfigMergeStatus = getWorkflowConfigMergeStatus(materializationResult);
                optionalQualityChecksNotice = getOptionalQualityChecksNotice(materializationResult);
                projectMemoryDiagnostics = getProjectMemoryDiagnostics(materializationResult);
                const materializationRecord = materializationResult && typeof materializationResult === 'object' && !Array.isArray(materializationResult)
                    ? materializationResult as Record<string, unknown>
                    : {};
                projectMemoryMaintenanceSummaryLine = typeof materializationRecord.projectMemoryMaintenanceSummaryLine === 'string'
                    ? materializationRecord.projectMemoryMaintenanceSummaryLine
                    : null;
                projectMemoryRefreshHandoffPrompt = typeof materializationRecord.projectMemoryRefreshHandoffPrompt === 'string'
                    ? materializationRecord.projectMemoryRefreshHandoffPrompt
                    : null;
            } else {
                const initResult = runInit({
                    targetRoot: normalizedTarget,
                    bundleRoot,
                    dryRun: false,
                    assistantLanguage: sources.assistantLanguage,
                    assistantBrevity: sources.assistantBrevity,
                    sourceOfTruth: sources.sourceOfTruth,
                    enforceNoAutoCommit: sources.enforceNoAutoCommit,
                    claudeOrchestratorFullAccess: sources.claudeOrchestratorFullAccess,
                    tokenEconomyEnabled: sources.tokenEconomyEnabled,
                    providerMinimalism: sources.providerMinimalism,
                    activeAgentFilesSeed: sources.activeAgentFilesSeed,
                    preserveLegacyReviewExecutionPolicyOmission: true,
                    preservedCompileGateCommand,
                    lifecycleLockAlreadyHeld
                });
                ruleRefresh = getRuleRefresh(initResult);
                workflowConfigMergeStatus = getWorkflowConfigMergeStatus(initResult);
                optionalQualityChecksNotice = getOptionalQualityChecksNotice(initResult);
                projectMemoryDiagnostics = getProjectMemoryDiagnostics(initResult);
                projectMemoryMaintenanceSummaryLine = typeof initResult.projectMemoryMaintenanceSummaryLine === 'string'
                    ? initResult.projectMemoryMaintenanceSummaryLine
                    : null;
                projectMemoryRefreshHandoffPrompt = typeof initResult.projectMemoryRefreshHandoffPrompt === 'string'
                    ? initResult.projectMemoryRefreshHandoffPrompt
                    : null;
            }
            syncOptionalRuleSupportFiles({ bundleRoot });
            if (!projectMemoryMaintenanceSummaryLine) {
                projectMemoryMaintenanceSummaryLine = readProjectMemoryMaintenanceRolloutSummaryFromBundle(bundleRoot).summary_line;
            }
            if (!projectMemoryRefreshHandoffPrompt) {
                projectMemoryRefreshHandoffPrompt = PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT;
            }
            materializationStatus = 'PASS';

            currentStage = 'CONTRACT_MIGRATIONS';
            traceUpdateProgress('lifecycle:contract-migrations');
            if (contractMigrationRunner) {
                const migResult = contractMigrationRunner({
                    rootPath: normalizedTarget,
                    preservedCompileGateCommand
                });
                contractMigrationCount = migResult.appliedCount || 0;
                contractMigrationFiles = migResult.appliedFiles || [];
                contractMigrationStatus = 'PASS';
            } else {
                contractMigrationStatus = 'SKIPPED_NO_RUNNER';
            }

            currentStage = 'VERIFY';
            traceUpdateProgress('lifecycle:verify');
            if (skipVerify) {
                verifyStatus = 'SKIPPED';
            } else if (verifyRunner) {
                verifyRunner({
                    targetRoot: normalizedTarget,
                    sourceOfTruth: sources.sourceOfTruth,
                    initAnswersPath: sources.initAnswersResolvedPath
                });
                verifyStatus = 'PASS';
            } else {
                verifyStatus = 'SKIPPED_NO_RUNNER';
            }

            // Removal runs after verify on purpose: an older caller may pass its own verify, which
            // still requires the retired copies. The rollback snapshot of live/ restores them if a
            // later stage fails.
            currentStage = 'RETIRED_SKILLS';
            traceUpdateProgress('lifecycle:retired-skills');
            retiredSkillCopies = removeShippedRetiredSkillCopies(normalizedTarget, bundleRoot);

            currentStage = 'MANIFEST_VALIDATION';
            traceUpdateProgress('lifecycle:manifest-validation');
            if (skipManifestValidation) {
                manifestStatus = 'SKIPPED';
            } else if (manifestRunner) {
                manifestRunner({ targetRoot: normalizedTarget });
                manifestStatus = 'PASS';
            } else {
                manifestStatus = 'SKIPPED_NO_RUNNER';
            }

            currentStage = 'INVARIANT_CHECK';
            traceUpdateProgress('lifecycle:invariant-check');
            const invariantResult = validateBundleInvariants(
                path.join(normalizedTarget, resolveBundleName()),
                expectedInvariantPaths
            );
            if (!invariantResult.isValid) {
                throw new Error(`Bundle invariant violation after update: ${invariantResult.violations.join('; ')}`);
            }
            invariantStatus = 'PASS';
            writeProtectedControlPlaneManifest(normalizedTarget);

            const previousAgentInitStateResult = readAgentInitStateSafe(normalizedTarget);
            const previousAgentInitState = previousAgentInitStateResult.state;
            const activeEntryFiles = getActiveAgentEntrypointFiles(
                sources.activeAgentFilesSeed,
                sources.sourceOfTruth
            );

            const preserveExistingCheckpoints = doesAgentInitStateMatchAnswers(previousAgentInitState, {
                AssistantLanguage: sources.assistantLanguage,
                SourceOfTruth: sources.sourceOfTruth,
                ActiveAgentFiles: activeEntryFiles
            });

            writeAgentInitState(normalizedTarget, buildRefreshAgentInitState({
                previousState: previousAgentInitState,
                preserveExistingCheckpoints,
                assistantLanguage: sources.assistantLanguage,
                sourceOfTruth: sources.sourceOfTruth,
                orchestratorVersion: sources.bundleVersion,
                activeAgentFiles: activeEntryFiles,
                verificationPassed: skipVerify ? null : true,
                manifestValidationPassed: skipManifestValidation ? null : true,
                autoConfirmPrompts: true,
                autoAcceptRules: true
            }));

            if (pathExists(sources.liveVersionPath)) {
                try {
                    const newLiveVersion = getLiveVersionPayload(readJsonFile(sources.liveVersionPath));
                    if (newLiveVersion && newLiveVersion.Version) {
                        const newParsed = String(newLiveVersion.Version).trim();
                        if (newParsed) updatedVersion = newParsed;
                    }
                } catch (_e) {
                    updatedVersion = 'unknown';
                }
            }
            if (workflowMigration) recordWorkflowConfigMigration(normalizedTarget, workflowMigration);
            if (taskVerification && !skipVerify && !skipManifestValidation
                && verifyStatus === 'PASS' && manifestStatus === 'PASS') {
                currentStage = 'TASK_UPDATE_VERIFICATION';
                // Runner return values cannot stand in for native validation of the installed state.
                const verified = runVerify({ targetRoot: normalizedTarget, sourceOfTruth: sources.sourceOfTruth,
                    initAnswersPath: sources.initAnswersResolvedPath });
                if (!verified.passed) throw new Error(formatVerifyResult(verified));
                const manifest = validateManifest(path.join(bundleRoot, 'MANIFEST.md'), normalizedTarget);
                if (!manifest.passed) throw new Error(formatManifestResult(manifest));
                verifiedProtectedState = scanProtectedPathHashes(normalizedTarget, [...taskVerification.protectedRoots],
                    { readOnly: true, noCache: true });
                for (const file of Object.keys(verifiedProtectedState))
                    bindContainedDestination(normalizedTarget, path.join(normalizedTarget, file));
            }
        }
    } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);

        switch (currentStage) {
            case 'INSTALL': installStatus = 'FAIL'; break;
            case 'BUNDLE_SYNC': installStatus = 'FAIL'; break;
            case 'MATERIALIZATION': materializationStatus = 'FAIL'; break;
            case 'CONTRACT_MIGRATIONS': contractMigrationStatus = 'FAIL'; break;
            case 'VERIFY': verifyStatus = 'FAIL'; break;
            case 'MANIFEST_VALIDATION': manifestStatus = 'FAIL'; break;
            case 'INVARIANT_CHECK': invariantStatus = 'FAIL'; break;
        }

        if (!dryRun && rollbackSnapshotCreated) {
            try {
                restoreRollbackSnapshot(normalizedTarget, rollbackSnapshotPath, rollbackRecords);
                rollbackStatus = 'SUCCESS';
            } catch (rollbackError: unknown) {
                const rollbackMsg = getErrorMessage(rollbackError);
                rollbackStatus = `FAILED: ${rollbackMsg}`;
                throw new Error(
                    `Update failed during ${currentStage}. Original error: ${errorMessage}. Rollback failed: ${rollbackMsg}`
                );
            }
            throw new Error(
                `Update failed during ${currentStage} and rollback completed successfully. Original error: ${errorMessage}`
            );
        }
        throw new Error(`Update failed during ${currentStage}. Error: ${errorMessage}`);
    }

    if (!dryRun && rollbackSnapshotCreated && rollbackStatus === 'NOT_NEEDED') {
        rollbackStatus = 'NOT_TRIGGERED';
    }

    const result = {
        installStatus,
        materializationStatus,
        workflowConfigMergeStatus,
        optionalQualityChecksNotice,
        projectMemoryMaintenanceSummaryLine,
        projectMemoryRefreshHandoffPrompt,
        projectMemoryDiagnostics,
        contractMigrationStatus,
        contractMigrationCount,
        contractMigrationFiles,
        ruleRefresh,
        verifyStatus,
        manifestStatus,
        invariantStatus,
        updatedVersion,
        rollbackStatus,
        retiredSkillCopies
    };
    if (taskVerification && verifiedProtectedState) {
        Object.freeze(result);
        verifiedUpdatePipelines.set(result, { transaction: taskVerification.transaction,
            root: path.resolve(normalizedTarget), bundle: path.resolve(bundleRoot), protectedState: verifiedProtectedState });
    }
    return result;
}
