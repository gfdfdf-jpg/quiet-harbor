import * as path from 'node:path';

import { assertValidTaskId } from '../../../../gate-runtime/task-events';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import {
    getTaskModeEvidence,
    getTaskModeEvidenceViolations
} from '../../../../gates/task-mode/task-mode';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';
import {
    runGateFlowPreflightPipelineSync
} from '../support/gate-flow-preflight-pipeline';
import {
    evaluateGateFlowTimelineReadiness,
    resolveGateFlowTimelinePath
} from '../support/gate-flow-runtime';
import { resolveRecoveryPreflightPath } from './recovery-flow-restart-evidence';

type TaskModeEvidence = ReturnType<typeof getTaskModeEvidence>;
type PreflightContext = ReturnType<typeof getPreflightContext>;
type TimelineReadiness = ReturnType<typeof evaluateGateFlowTimelineReadiness>;

export interface RecoveryFlowPreflightPipelineInput {
    readonly repoRoot?: string;
    readonly taskId?: unknown;
    readonly taskModePath?: string;
    readonly preflightPath?: string;
}

interface RecoveryFlowParsedPreflight {
    readonly repoRoot: string;
    readonly resolvedTaskId: string;
    readonly timelinePath: string;
}

export interface RecoveryFlowPreflightPipelineOutput
    extends RecoveryFlowTaskModePipelineOutput {
    readonly previousPreflight: PreflightContext;
}

interface RecoveryFlowTaskModePipelineOutput extends RecoveryFlowParsedPreflight {
    readonly resolvedTaskModePath: string;
    readonly resolvedPreflightPath: string;
    readonly previousTaskMode: TaskModeEvidence;
    readonly timelineReadiness: TimelineReadiness;
}

export function runRecoveryFlowPreflightPipeline(
    input: RecoveryFlowPreflightPipelineInput
): RecoveryFlowPreflightPipelineOutput {
    return runRecoveryFlowPipeline(input, getPreflightContext);
}

export function runRecoveryFlowTaskModePipeline(input: RecoveryFlowPreflightPipelineInput): RecoveryFlowTaskModePipelineOutput {
    return runRecoveryFlowPipeline(input, () => null);
}

function runRecoveryFlowPipeline<T>(
    input: RecoveryFlowPreflightPipelineInput,
    readPreflight: (preflightPath: string, taskId: string) => T
): RecoveryFlowTaskModePipelineOutput & { previousPreflight: T } {
    return runGateFlowPreflightPipelineSync(input, {
        parse(currentInput) {
            const repoRoot = path.resolve(String(currentInput.repoRoot || '.'));
            const resolvedTaskId = assertValidTaskId(String(currentInput.taskId || '').trim());
            return {
                repoRoot,
                resolvedTaskId,
                timelinePath: resolveGateFlowTimelinePath(repoRoot, resolvedTaskId)
            };
        },
        loadTaskModeEvidence({ input: currentInput, parsed }) {
            const previousTaskMode = getTaskModeEvidence(
                parsed.repoRoot,
                parsed.resolvedTaskId,
                String(currentInput.taskModePath || '')
            );
            const taskModeViolations = getTaskModeEvidenceViolations(previousTaskMode);
            if (taskModeViolations.length > 0) {
                throw new Error(taskModeViolations.join(' '));
            }
            return previousTaskMode;
        },
        loadPreflight({ input: currentInput, parsed, taskModeEvidence }) {
            const resolvedTaskModePath = String(
                currentInput.taskModePath || taskModeEvidence.evidence_path || ''
            ).trim();
            const resolvedPreflightPath = resolveRecoveryPreflightPath(
                parsed.repoRoot,
                parsed.resolvedTaskId,
                currentInput.preflightPath,
                'PreflightPath'
            );
            return {
                resolvedTaskModePath,
                resolvedPreflightPath,
                previousPreflight: readPreflight(resolvedPreflightPath, parsed.resolvedTaskId)
            };
        },
        evaluateTimelineReadiness({ parsed }) {
            return evaluateGateFlowTimelineReadiness({
                orchestratorRoot: resolveOrchestratorRoot(parsed.repoRoot),
                repoRoot: parsed.repoRoot,
                taskId: parsed.resolvedTaskId,
                timelinePath: parsed.timelinePath,
                requirements: [{
                    eventType: 'TASK_MODE_ENTERED',
                    recoveryInstruction: 'Run enter-task-mode before recovery.'
                }]
            });
        },
        emit({ parsed, taskModeEvidence, preflight, timelineReadiness }) {
            if (timelineReadiness.violations.length > 0) {
                throw new Error(timelineReadiness.violations.join(' '));
            }
            return {
                ...parsed,
                ...preflight,
                previousTaskMode: taskModeEvidence,
                timelineReadiness
            };
        }
    });
}
