import * as path from 'node:path';
import { isVerifiedProtectedTaskContinuation, type ProtectedTaskContinuation } from '../../../../core/auth/protected-task-continuation';
import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../../core/operator-confirmation';
import {
    formatGardaSelfGuardProtectedControlPlaneGuidance,
    isGardaSelfGuardDenyAgentEntryForBundle
} from '../../../../core/workflow-config';
import {
    normalizeTaskModeEntryMode,
    parseTaskModeDepth
} from '../../../../gates/task-mode/task-mode';
import * as gateHelpers from '../../../../gates/shared/helpers';
import type {
    WorkflowConfigPreTaskBaselineState
} from '../../../../gates/workflow-config/workflow-config-work';
import {
    taskMetadataAllowsWorkflowConfigWork,
    WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE
} from '../../../../gates/workflow-config/workflow-config-work-paths';
export { WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE } from '../../../../gates/workflow-config/workflow-config-work-paths';
import {
    quotePowerShellCliValue,
    buildGateCommandPrefix
} from './task-mode-command-format';
import type { ProtectedScopeSelection } from '../../../../gates/task-mode/task-mode-plan-protection';
import { resolveProtectedManifestEntry } from '../../../../gates/protected-control-plane/protected-manifest-guard';
import type { ProtectedControlPlaneManifestEvidence } from '../../../../core/protected-control-plane-contracts';

export class TaskModeProtectedManifestEntryError extends Error {
    constructor(message: string, readonly evidence?: ProtectedControlPlaneManifestEvidence,
        readonly requiresOrchestratorApproval = false,
        /** Blocking drift only: compatible workflow config admitted at entry is excluded; the evidence stays raw for audit. */
        readonly affectedProtectedPaths?: readonly string[]) {
        super(message);
        this.name = 'TaskModeProtectedManifestEntryError';
    }
}

interface TaskModeHandoffOptions {
    entryMode?: unknown;
    requestedDepth?: unknown;
    effectiveDepth?: unknown;
    taskSummary?: unknown;
    startBanner?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    actor?: unknown;
    planPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

interface TaskQueueMetadataForProtectedEntry {
    area?: string | null;
    title?: string | null;
    notes?: string | null;
}

export interface AssertTaskModeProtectedEntryAllowedOptions {
    repoRoot: string;
    orchestratorRoot: string;
    taskId: string;
    options: TaskModeHandoffOptions & {
        orchestratorWork?: unknown;
        workflowConfigWork?: unknown;
        operatorConfirmed?: unknown;
        operatorConfirmedAtUtc?: unknown;
    };
    plannedChangedFiles: string[];
    protectedPlannedFiles: string[];
    workflowConfigPlannedFiles: string[];
    /** Protected files named by the attached task plan; checked together with the planned-file flags. */
    planScopeProtection?: ProtectedScopeSelection;
    dirtyWorkflowConfigFiles: string[];
    workflowConfigPreTaskBaseline: WorkflowConfigPreTaskBaselineState;
    workflowConfigFileHashes: Readonly<Record<string, string | null>>;
    orchestratorWork: boolean;
    workflowConfigWork: boolean;
    allowedDirtyWorkflowConfigFiles?: unknown;
    taskQueueMetadata: TaskQueueMetadataForProtectedEntry | null;
    protectedContinuation?: ProtectedTaskContinuation | null;
    inheritedWorkspaceFiles?: string[];
}

function buildProtectedOperatorConfirmationCommandParts(): string[] {
    return [
        '--operator-confirmed yes',
        '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
    ];
}

export function buildOrchestratorWorkHandoffCommand(
    repoRoot: string,
    taskId: string,
    options: TaskModeHandoffOptions,
    plannedChangedFiles: string[],
    includeWorkflowConfigWork = false
): string {
    const requestedDepthRaw = String(options.requestedDepth || '').trim();
    const parts: string[] = [
        `${buildGateCommandPrefix(repoRoot)} gate enter-task-mode`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--entry-mode ${quotePowerShellCliValue(normalizeTaskModeEntryMode(options.entryMode || 'EXPLICIT_TASK_EXECUTION'))}`,
        `--task-summary ${quotePowerShellCliValue(String(options.taskSummary || '').trim())}`,
        '--orchestrator-work'
    ];
    if (requestedDepthRaw) {
        parts.splice(4, 0, `--requested-depth ${quotePowerShellCliValue(String(parseTaskModeDepth(requestedDepthRaw, 'RequestedDepth', 2)))}`);
    }
    if (includeWorkflowConfigWork) {
        parts.push('--workflow-config-work');
    }
    parts.push(...buildProtectedOperatorConfirmationCommandParts());
    const startBanner = String(options.startBanner || '').trim();
    if (startBanner) {
        parts.push(`--start-banner ${quotePowerShellCliValue(startBanner)}`);
    }

    const effectiveDepthRaw = String(options.effectiveDepth || '').trim();
    if (effectiveDepthRaw) {
        const effectiveDepthFallback = requestedDepthRaw
            ? parseTaskModeDepth(requestedDepthRaw, 'RequestedDepth', 2)
            : 2;
        parts.push(`--effective-depth ${quotePowerShellCliValue(String(parseTaskModeDepth(effectiveDepthRaw, 'EffectiveDepth', effectiveDepthFallback)))}`);
    }
    const provider = String(options.provider || '').trim();
    if (provider) {
        parts.push(`--provider ${quotePowerShellCliValue(provider)}`);
    }
    const routedTo = String(options.routedTo || '').trim();
    if (routedTo) {
        parts.push(`--routed-to ${quotePowerShellCliValue(routedTo)}`);
    }
    const actor = String(options.actor || '').trim();
    if (actor) {
        parts.push(`--actor ${quotePowerShellCliValue(actor)}`);
    }
    const planPath = String(options.planPath || '').trim();
    if (planPath) {
        parts.push(`--plan-path ${quotePowerShellCliValue(planPath)}`);
    }
    const artifactPath = String(options.artifactPath || '').trim();
    if (artifactPath) {
        parts.push(`--artifact-path ${quotePowerShellCliValue(artifactPath)}`);
    }
    const metricsPath = String(options.metricsPath || '').trim();
    if (metricsPath) {
        parts.push(`--metrics-path ${quotePowerShellCliValue(metricsPath)}`);
    }
    if (options.emitMetrics === false || String(options.emitMetrics || '').trim().toLowerCase() === 'false') {
        parts.push('--emit-metrics false');
    }
    for (const plannedChangedFile of plannedChangedFiles) {
        parts.push(`--planned-changed-file ${quotePowerShellCliValue(plannedChangedFile)}`);
    }
    return parts.join(' ');
}

export function isGardaSelfGuardDenyAgentEntry(repoRoot: string, orchestratorRoot: string): boolean {
    return isGardaSelfGuardDenyAgentEntryForBundle(
        gateHelpers.isOrchestratorSourceCheckout(repoRoot),
        orchestratorRoot
    );
}

export function buildGardaSelfGuardDenialMessage(protectedFiles: readonly string[]): string {
    return formatGardaSelfGuardProtectedControlPlaneGuidance({
        protectedFiles,
        includeWorkflowConfigWork: true
    });
}

function buildProtectedManifestRepairCommand(repoRoot: string): string {
    return `${buildGateCommandPrefix(repoRoot)} repair protected-manifest --target-root "." --confirm`;
}

function isProtectedManifestOnlyBaselineDrift(
    dirtyWorkflowConfigFiles: readonly string[],
    workflowConfigPreTaskBaseline: WorkflowConfigPreTaskBaselineState
): boolean {
    const dirtyFiles = [...dirtyWorkflowConfigFiles].sort();
    const manifestFiles = [...workflowConfigPreTaskBaseline.protected_manifest_changed_files].sort();
    return dirtyFiles.length > 0
        && workflowConfigPreTaskBaseline.protected_manifest_status === 'present'
        && workflowConfigPreTaskBaseline.git_changed_files.length === 0
        && dirtyFiles.every((entry) => manifestFiles.includes(entry));
}

function normalizeWorkflowConfigPathList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(
        value
            .map((entry) => gateHelpers.normalizePath(entry))
            .filter((entry) => entry && gateHelpers.isWorkflowConfigControlPlanePath(entry))
    )].sort();
}

function canReplayDirtyWorkflowConfigFiles(input: {
    dirtyWorkflowConfigFiles: readonly string[];
    workflowConfigPlannedFiles: readonly string[];
    allowedDirtyWorkflowConfigFiles: readonly string[];
    orchestratorWork: boolean;
    workflowConfigWork: boolean;
}): boolean {
    if (
        input.dirtyWorkflowConfigFiles.length === 0
        || !input.orchestratorWork
        || !input.workflowConfigWork
        || input.allowedDirtyWorkflowConfigFiles.length === 0
    ) {
        return false;
    }
    const allowed = new Set(input.allowedDirtyWorkflowConfigFiles);
    const planned = new Set(input.workflowConfigPlannedFiles.map((entry) => gateHelpers.normalizePath(entry)));
    return input.dirtyWorkflowConfigFiles.every((entry) => allowed.has(entry) && planned.has(entry));
}

export function requireTaskModeOperatorConfirmation(
    options: {
        operatorConfirmed?: unknown;
        operatorConfirmedAtUtc?: unknown;
    },
    scopeLabel: string
): void {
    const rawConfirmation = String(options.operatorConfirmed || '').trim();
    const confirmed = rawConfirmation ? parseOperatorConfirmationYes(rawConfirmation) : false;
    validateFreshOperatorConfirmation({
        actionLabel: `enter-task-mode ${scopeLabel}`,
        confirmed,
        confirmedAtUtc: String(options.operatorConfirmedAtUtc || '').trim(),
        requireConfirmedAtUtc: true,
        instruction:
            'Ask the operator to approve this protected task-mode entry, then rerun with --operator-confirmed yes and --operator-confirmed-at-utc "<ISO-8601 timestamp>". ' +
            'Agents must not approve --orchestrator-work or --workflow-config-work for themselves.'
    });
}

export function assertTaskModeProtectedEntryAllowed(input: AssertTaskModeProtectedEntryAllowedOptions): void {
    const {
        repoRoot,
        orchestratorRoot,
        taskId,
        options,
        plannedChangedFiles,
        protectedPlannedFiles,
        workflowConfigPlannedFiles,
        dirtyWorkflowConfigFiles,
        workflowConfigPreTaskBaseline,
        orchestratorWork,
        workflowConfigWork,
        allowedDirtyWorkflowConfigFiles,
        taskQueueMetadata
    } = input;
    // Protected scope may come from the flags or from the attached plan. The union only adds stops:
    // the requirement that --workflow-config-work names a workflow-config file still reads the flags.
    const protectedScopeFiles = [...new Set([...protectedPlannedFiles, ...input.planScopeProtection?.protectedFiles ?? []])].sort();
    const workflowConfigScopeFiles = [...new Set([
        ...workflowConfigPlannedFiles, ...input.planScopeProtection?.workflowConfigFiles ?? []
    ])].sort();
    // A suggested rerun names the plan's workflow-config files as planned files too, so it passes this gate in one step.
    const suggestedPlannedFiles = [...new Set([
        ...plannedChangedFiles, ...input.planScopeProtection?.workflowConfigFiles ?? []
    ])].sort();
    const replayAllowedDirtyWorkflowConfigFiles = normalizeWorkflowConfigPathList(allowedDirtyWorkflowConfigFiles);

    if (
        dirtyWorkflowConfigFiles.length > 0
        && !canReplayDirtyWorkflowConfigFiles({
            dirtyWorkflowConfigFiles,
            workflowConfigPlannedFiles,
            allowedDirtyWorkflowConfigFiles: replayAllowedDirtyWorkflowConfigFiles,
            orchestratorWork,
            workflowConfigWork
        })
    ) {
        if (workflowConfigPreTaskBaseline.protected_manifest_status === 'invalid'
            || workflowConfigPreTaskBaseline.protected_manifest_status === 'missing') {
            throw new TaskModeProtectedManifestEntryError(
                `Trusted protected control-plane manifest is ${workflowConfigPreTaskBaseline.protected_manifest_status} before task-mode entry for workflow config files: ${dirtyWorkflowConfigFiles.join(', ')}. ` +
                'Inspect the protected state and use the guarded task-mode recovery workflow.'
            );
        }
        if (isProtectedManifestOnlyBaselineDrift(dirtyWorkflowConfigFiles, workflowConfigPreTaskBaseline)) {
            throw new TaskModeProtectedManifestEntryError(
                `Trusted protected control-plane manifest is stale before task-mode entry for workflow config files: ${dirtyWorkflowConfigFiles.join(', ')}. ` +
                'Git status is clean for these workflow-config paths; this is trusted baseline drift, not a task-owned workflow-config edit. ' +
                `Run guarded repair after operator verification: ${buildProtectedManifestRepairCommand(repoRoot)}. ` +
                'Then rerun next-step for this task.'
            );
        }
        throw new Error(
            `Workspace already contains workflow config changes before task-mode entry: ${dirtyWorkflowConfigFiles.join(', ')}. ` +
            'Enter task mode before editing workflow-config.json so the change cannot be laundered into the baseline.'
        );
    }

    if (
        isGardaSelfGuardDenyAgentEntry(repoRoot, orchestratorRoot)
        && (orchestratorWork || workflowConfigWork || protectedScopeFiles.length > 0)
    ) {
        throw new Error(buildGardaSelfGuardDenialMessage(protectedScopeFiles));
    }

    if (workflowConfigWork && !orchestratorWork) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, suggestedPlannedFiles, true);
        throw new Error(
            'Task-mode --workflow-config-work requires --orchestrator-work because workflow-config.json is part of the protected orchestrator control plane. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    if (workflowConfigWork && workflowConfigPlannedFiles.length === 0) {
        throw new Error(
            'Task-mode --workflow-config-work requires the planned task scope to include a protected workflow-config.json file. ' +
            'Add the intended workflow-config.json path to the planned changed files before entering task mode.'
        );
    }

    if (workflowConfigWork && !taskMetadataAllowsWorkflowConfigWork(taskQueueMetadata)) {
        throw new Error(
            'Task-mode --workflow-config-work requires trusted TASK.md metadata to explicitly own workflow-config policy changes. ' +
            `Update the task row Area, Title, or Notes to include the exact ownership phrase '${WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE}' before entering task mode.`
        );
    }

    if (workflowConfigScopeFiles.length > 0 && !workflowConfigWork) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, suggestedPlannedFiles, true);
        throw new Error(
            `Planned task scope includes workflow config files: ${workflowConfigScopeFiles.join(', ')}. ` +
            'Re-run enter-task-mode with --orchestrator-work --workflow-config-work before preflight so this high-risk config intent stays explicit and auditable. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    if (!orchestratorWork && protectedScopeFiles.length > 0) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, suggestedPlannedFiles, workflowConfigWork);
        throw new Error(
            `Planned task scope includes protected orchestrator files: ${protectedScopeFiles.join(', ')}. ` +
            'Re-run enter-task-mode with --orchestrator-work before preflight so the intent stays explicit and auditable. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    const selfGuard = isGardaSelfGuardDenyAgentEntry(repoRoot, orchestratorRoot);
    const manifestEntry = resolveProtectedManifestEntry({ repoRoot, orchestratorWork, selfGuard, verifyTree: true,
        inheritedFiles: () => input.inheritedWorkspaceFiles ?? [],
        matchesWorkflowConfigCompatibilityBaseline: (file, sha256) =>
            workflowConfigPreTaskBaseline.compatibility_baseline_files.includes(file)
            && input.workflowConfigFileHashes[file] === sha256
    });
    if (manifestEntry?.kind === 'maintenance') {
        if (manifestEntry.invalid && manifestEntry.evidence.manifest) throw new TaskModeProtectedManifestEntryError(
            'Strict traversal could not verify the protected tree. Make the protected tree readable, then retry task-mode entry.',
            manifestEntry.evidence);
        if (selfGuard && !manifestEntry.invalid) throw new TaskModeProtectedManifestEntryError(
            buildGardaSelfGuardDenialMessage(manifestEntry.changedFiles), manifestEntry.evidence, false, manifestEntry.changedFiles);
        throw new TaskModeProtectedManifestEntryError(
            `Trusted protected control-plane manifest is ${manifestEntry.invalid ? 'invalid' : 'drifted'} before task-mode entry. `
            + 'Inspect with doctor and have the operator verify the protected files before guarded repair: '
            + buildProtectedManifestRepairCommand(repoRoot), manifestEntry.evidence, false,
            manifestEntry.invalid ? undefined : manifestEntry.changedFiles);
    }
    if (manifestEntry?.kind === 'approval') {
        const command = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, suggestedPlannedFiles, workflowConfigWork);
        throw new TaskModeProtectedManifestEntryError(`Protected control-plane manifest drift before task-mode entry: ${manifestEntry.changedFiles.join(', ')}. `
            + 'Ask the operator to confirm orchestrator work. After approval, run: ' + command, manifestEntry.evidence, true, manifestEntry.changedFiles);
    }

    const continuationVerified = isVerifiedProtectedTaskContinuation(input.protectedContinuation, {
        repoRoot, taskId, plannedChangedFiles, orchestratorWork, workflowConfigWork,
        taskSummary: String(options.taskSummary || ''), provider: String(options.provider || ''), routedTo: String(options.routedTo || '')
    });
    if ((orchestratorWork || workflowConfigWork) && !continuationVerified) {
        requireTaskModeOperatorConfirmation(
            options,
            workflowConfigWork ? '--orchestrator-work --workflow-config-work' : '--orchestrator-work'
        );
    }

}
