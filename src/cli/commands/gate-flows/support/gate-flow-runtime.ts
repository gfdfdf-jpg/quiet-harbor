import * as path from 'node:path';

import {
    getHandshakeEvidence,
    getHandshakeEvidenceViolations
} from '../../../../gates/diagnostics/handshake-diagnostics';
import {
    getShellSmokeEvidence,
    getShellSmokeEvidenceViolations
} from '../../../../gates/diagnostics/shell-smoke-preflight';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    readStartupEvidenceRecovery,
    type StartupEvidenceRecovery
} from '../../../../gates/diagnostics/startup-evidence-recovery';
import { buildCoherentCycleRestartCommand } from '../../../../gates/completion/completion-reporting';
import { resolveRestartTaskIntentFromPreflightPath } from '../../../../gates/review-context/review-context-task-criteria-binding';
import { buildGateCommandPrefix } from '../task-mode/task-mode-command-format';
import { buildNextStepRecoveryCommand } from '../compile/compile-flow-shared-evidence';
import { forEachJsonlLine } from '../../../../gate-runtime/task-events';
import {
    computeOptionalSkillTaskTextSha256,
    getOptionalSkillSelectionGateViolations,
    isOptionalSkillSelectionPolicyConfigured,
    loadOptionalSkillSelectionHeadlinesCache,
    readOptionalSkillSelectionPolicyConfig,
    readOptionalSkillSelectionTimelineEvidence
} from '../../../../runtime/optional-skill-selection';

type OptionalSkillTimelineEvidence = ReturnType<typeof readOptionalSkillSelectionTimelineEvidence>;

export interface GateFlowTimelineRequirement {
    eventType: string;
    recoveryInstruction: string;
}

export interface GateFlowTimelineReadiness {
    timelinePath: string;
    timelineEvidence: OptionalSkillTimelineEvidence;
    violations: string[];
}

export function resolveGateFlowTimelinePath(repoRoot: string, taskId: string): string {
    return gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
}

function recoverRequiredEventTypesFromTruncatedTimeline(
    timelinePath: string,
    taskId: string,
    requirements: GateFlowTimelineRequirement[],
    timelineEvidence: OptionalSkillTimelineEvidence
): void {
    if (!timelineEvidence.boundedRead?.truncated) {
        return;
    }
    const missingEventTypes = new Set(
        requirements
            .map((requirement) => requirement.eventType.trim().toUpperCase())
            .filter((eventType) => eventType && !timelineEvidence.eventTypes.has(eventType))
    );
    if (missingEventTypes.size === 0) {
        return;
    }

    forEachJsonlLine(timelinePath, (rawLine) => {
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
            timelineEvidence.invalidJson = true;
            return;
        }
        const eventTaskId = String(event.task_id || '').trim();
        if (eventTaskId && eventTaskId !== taskId) {
            return;
        }
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (missingEventTypes.has(eventType)) {
            timelineEvidence.eventTypes.add(eventType);
            missingEventTypes.delete(eventType);
        }
    });
}

export function evaluateGateFlowTimelineReadiness(params: {
    orchestratorRoot: string;
    repoRoot: string;
    taskId: string;
    requirements: GateFlowTimelineRequirement[];
    timelinePath?: string | null;
}): GateFlowTimelineReadiness {
    const timelinePath = params.timelinePath || resolveGateFlowTimelinePath(params.repoRoot, params.taskId);
    const timelineEvidence = readOptionalSkillSelectionTimelineEvidence(
        params.orchestratorRoot,
        params.taskId,
        timelinePath
    );
    recoverRequiredEventTypesFromTruncatedTimeline(
        timelinePath,
        params.taskId,
        params.requirements,
        timelineEvidence
    );
    const violations: string[] = [];
    if (!timelineEvidence.exists) {
        violations.push(`Task timeline not found: ${gateHelpers.normalizePath(timelineEvidence.timelinePath)}`);
    } else if (timelineEvidence.invalidJson) {
        violations.push(`Task timeline contains invalid JSON line: ${gateHelpers.normalizePath(timelineEvidence.timelinePath)}`);
    }

    if (violations.length === 0) {
        for (const requirement of params.requirements) {
            if (!timelineEvidence.eventTypes.has(requirement.eventType)) {
                violations.push(
                    `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing ${requirement.eventType}. ${requirement.recoveryInstruction}`
                );
            }
        }
    }

    return {
        timelinePath,
        timelineEvidence,
        violations
    };
}

export function evaluateGateFlowStartupDiagnostics(params: {
    repoRoot: string;
    taskId: string;
    taskModePath?: string;
    timelinePath: string;
    /** The preflight a coherent-cycle restart starts from when the lost evidence is behind the current preflight. */
    preflightPath?: string | null;
}): string[] {
    const handshakeEvidence = getHandshakeEvidence(params.repoRoot, params.taskId, {
        taskModePath: params.taskModePath || '',
        timelinePath: params.timelinePath
    });
    const shellSmokeEvidence = getShellSmokeEvidence(params.repoRoot, params.taskId, {
        timelinePath: params.timelinePath
    });
    const violations = [
        ...getHandshakeEvidenceViolations(handshakeEvidence),
        ...getShellSmokeEvidenceViolations(shellSmokeEvidence)
    ];
    if (violations.length === 0) return violations;
    const recovery = readStartupEvidenceRecovery({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        taskModePath: params.taskModePath,
        timelinePath: params.timelinePath,
        handshakeEvidence,
        shellSmokeEvidence
    });
    if (!recovery) return violations;
    return [...violations, `${recovery.guidance}${formatStartupEvidenceRecoveryCommands(recovery, params)}`];
}

/** Exact commands for the route the shared startup-evidence check selected; the navigator names the same route. */
function formatStartupEvidenceRecoveryCommands(
    recovery: StartupEvidenceRecovery,
    params: { repoRoot: string; taskId: string; taskModePath?: string; preflightPath?: string | null }
): string {
    if (!recovery.recoverable) return '';
    const gateCommand = (gate: string): string => `${buildGateCommandPrefix(params.repoRoot)} gate ${gate} `
        + `--task-id "${params.taskId}" --repo-root "."`;
    if (recovery.nextGate === 'handshake-diagnostics') {
        return ` Commands: ${gateCommand('handshake-diagnostics')} ; ${gateCommand('shell-smoke-preflight')} ; `
            + `${buildNextStepRecoveryCommand(params.repoRoot, params.taskId)}`;
    }
    if (recovery.nextGate === 'shell-smoke-preflight') {
        return ` Commands: ${gateCommand('shell-smoke-preflight')} ; ${buildNextStepRecoveryCommand(params.repoRoot, params.taskId)}`;
    }
    const preflightPath = String(params.preflightPath || '').trim();
    return preflightPath
        ? ` Command: ${buildCoherentCycleRestartCommand(params.repoRoot, params.taskId, gateHelpers.normalizePath(preflightPath),
            String(params.taskModePath || '').trim() || null, null, null,
            { taskIntent: resolveRestartTaskIntentFromPreflightPath(params.repoRoot, params.taskId, preflightPath) })}`
        : ` Run ${buildNextStepRecoveryCommand(params.repoRoot, params.taskId)} for the exact restart-coherent-cycle command.`;
}

export function evaluateGateFlowOptionalSkillSelection(params: {
    orchestratorRoot: string;
    taskId: string;
    expectedPreflightPath: string;
    expectedPreflightSha256: string | null;
    taskSummary: string;
    timelineEvidence: OptionalSkillTimelineEvidence;
}): string[] {
    const optionalSkillPolicyMode = isOptionalSkillSelectionPolicyConfigured(params.orchestratorRoot)
        ? readOptionalSkillSelectionPolicyConfig(params.orchestratorRoot).mode
        : null;
    const loadedHeadlinesCache = optionalSkillPolicyMode
        ? loadOptionalSkillSelectionHeadlinesCache(params.orchestratorRoot, optionalSkillPolicyMode, {
            preferPersistedSurface: true
        })
        : null;
    const expectedTaskTextSha256 = computeOptionalSkillTaskTextSha256(params.taskSummary);
    return getOptionalSkillSelectionGateViolations(params.orchestratorRoot, params.taskId, {
        expectedPreflightPath: params.expectedPreflightPath,
        expectedPreflightSha256: params.expectedPreflightSha256,
        expectedTaskTextSha256,
        timelineEvidence: params.timelineEvidence,
        loadedHeadlinesCache
    });
}
