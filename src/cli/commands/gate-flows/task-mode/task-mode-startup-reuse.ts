import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPlainRecord } from '../../../../core/records';
import { inspectTaskEventFile, readTaskTimelineJsonlEntries, withTaskTimelineReadSnapshot,
    type TaskTimelineJsonlEntry } from '../../../../gate-runtime/task-events';
import { getRulePackEvidence, resolveRulePackArtifactPath } from '../../../../gates/rule-pack/rule-pack';
import { readExistingRulePackArtifact } from '../../../../gates/rule-pack/rule-pack-artifact-store';
import type { TaskModeArtifact, TaskModeEvidenceResult } from '../../../../gates/task-mode/task-mode-contracts';
import * as gateHelpers from '../../../../gates/shared/helpers';

type Stage = 'TASK_ENTRY' | 'POST_PREFLIGHT';
interface ReusableRuleStage {
    stage: Stage;
    details: Record<string, unknown>;
    eventSha256: string;
}

export interface ReusableStartupRules {
    artifactPath: string;
    predecessorEventSha256: string;
    stages: ReusableRuleStage[];
}

function isScopeOnlyUpgrade(previous: TaskModeEvidenceResult, next: TaskModeArtifact): boolean {
    return previous.evidence_status === 'PASS' && previous.planned_changed_files.length < next.planned_changed_files.length
        && previous.planned_changed_files.every(file => next.planned_changed_files.includes(file))
        && previous.provider === next.provider && previous.routed_to === next.routed_to
        && previous.execution_provider_source === next.execution_provider_source
        && previous.task_summary === next.task_summary && previous.entry_mode === next.entry_mode
        && previous.requested_depth === next.requested_depth && previous.effective_depth === next.effective_depth
        && previous.orchestrator_work === next.orchestrator_work && previous.workflow_config_work === next.workflow_config_work
        && isDeepStrictEqual(previous.workflow_config_file_hashes, next.workflow_config_file_hashes)
        && previous.plan?.plan_sha256 === next.plan?.plan_sha256
        && previous.profile_policy_snapshot?.snapshot_hash === next.profile_policy_snapshot?.snapshot_hash;
}

function selectRuleStage(entries: readonly TaskTimelineJsonlEntry[], stage: Stage): ReusableRuleStage | null {
    const entry = entries.find(({ record }) => (record?.event_type === 'RULE_PACK_LOADED'
        || record?.event_type === 'RULE_PACK_LOAD_FAILED') && isPlainRecord(record.details) && record.details.stage === stage);
    const record = entry?.record;
    if (!entry || record?.event_type !== 'RULE_PACK_LOADED' || record.actor !== 'gate' || record.outcome !== 'PASS'
        || !isPlainRecord(record.integrity) || !isPlainRecord(record.details) || typeof record.details.stage_sha256 !== 'string') return null;
    return { stage, details: record.details, eventSha256: gateHelpers.stringSha256(entry.rawLine.trim())! };
}

export function matchesRetainedRuleStage(artifactPath: string, stage: ReusableRuleStage): boolean {
    const artifact = readExistingRulePackArtifact(artifactPath);
    const retained = artifact?.stages[stage.stage === 'TASK_ENTRY' ? 'task_entry' : 'post_preflight'];
    return !!retained && gateHelpers.stringSha256(JSON.stringify(retained)) === stage.details.stage_sha256;
}

export function readReusableStartupRules(input: { repoRoot: string; taskId: string; taskModePath: string;
    previous: TaskModeEvidenceResult; next: TaskModeArtifact }): ReusableStartupRules | null {
    const { repoRoot, taskId, taskModePath, previous, next } = input;
    if (!isScopeOnlyUpgrade(previous, next)) return null;

    const eventsRoot = gateHelpers.joinOrchestratorPath(repoRoot, 'runtime/task-events');
    const timeline = path.join(eventsRoot, taskId + '.jsonl');
    const artifactPath = resolveRulePackArtifactPath(repoRoot, taskId, '');
    return withTaskTimelineReadSnapshot(eventsRoot, taskId, () => {
        if (inspectTaskEventFile(timeline, taskId).status !== 'PASS') return null;
        const entries = [...readTaskTimelineJsonlEntries(timeline)].reverse();
        const modeIndex = entries.findIndex(({ record }) => record?.event_type === 'TASK_MODE_ENTERED');
        const mode = entries[modeIndex];
        if (mode?.record?.actor !== 'gate' || mode.record.outcome !== 'PASS'
            || !isPlainRecord(mode.record.details)
            || path.resolve(String(mode.record.details.artifact_path)) !== path.resolve(taskModePath)
            || !previous.evidence_hash || gateHelpers.fileSha256(taskModePath) !== previous.evidence_hash) return null;
        const stageEntries = entries.slice(0, modeIndex);
        const rules = selectRuleStage(stageEntries, 'TASK_ENTRY');
        if (!rules || !matchesRetainedRuleStage(artifactPath, rules)
            || getRulePackEvidence(repoRoot, taskId, 'TASK_ENTRY', { taskModePath, artifactPath }).evidence_status !== 'PASS') return null;
        const post = selectRuleStage(stageEntries, 'POST_PREFLIGHT');
        return { artifactPath, predecessorEventSha256: gateHelpers.stringSha256(mode.rawLine.trim())!,
            stages: post && matchesRetainedRuleStage(artifactPath, post) ? [rules, post] : [rules] };
    });
}
