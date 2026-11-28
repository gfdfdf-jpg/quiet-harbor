import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPlainRecord } from '../../../../core/records';
import { fileSha256 } from '../../../../gate-runtime/hash';
import { joinOrchestratorPath } from '../../../../core/orchestrator-paths';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events';
import { parseOperatorConfirmationYes, validateFreshOperatorConfirmation } from '../../../../core/operator-confirmation';
import { taskIntentSha256 } from '../../../../gates/review-context/review-context-task-intent';
import type { TaskModeEvidenceResult } from '../../../../gates/task-mode/task-mode-contracts';

export interface CoherentScopeApproval {
    approved_at_utc: string;
    added_files: string[];
    previous_task_mode_sha256: string;
    previous_task_mode_event_sha256: string;
    previous_preflight_path: string;
    previous_preflight_sha256: string;
    previous_preflight_event_sha256: string;
    previous_timeline_head_sha256: string;
    task_intent_sha256: string;
}

export function readCoherentScopeTimeline(repoRoot: string, taskId: string, allowLegacyOnly = false): Readonly<Record<string, unknown>>[] {
    const events: Readonly<Record<string, unknown>>[] = [];
    const result = inspectTaskEventFile(joinOrchestratorPath(repoRoot, 'runtime/task-events/' + taskId + '.jsonl'), taskId,
        { onIntegrityEvent: event => { events.push(event); } });
    if (result.status === 'PASS' || result.status === 'PASS_WITH_LEGACY_PREFIX') return events;
    if (allowLegacyOnly && result.status === 'LEGACY_ONLY') return [];
    throw new Error('Coherent scope expansion requires an authenticated task timeline.');
}

export function coherentEventHash(event?: Readonly<Record<string, unknown>>): string | null {
    return isPlainRecord(event?.integrity) && typeof event.integrity.event_sha256 === 'string' ? event.integrity.event_sha256 : null;
}

export function currentCoherentClassification(events: readonly Readonly<Record<string, unknown>>[]) {
    const classify = [...events].reverse().find(event => ['TASK_MODE_ENTERED', 'PREFLIGHT_STARTED', 'PREFLIGHT_CLASSIFIED', 'PREFLIGHT_FAILED',
        'TASK_RESET', 'TASK_DISCARDED'].includes(String(event.event_type)));
    return classify?.event_type === 'PREFLIGHT_CLASSIFIED' && classify.actor === 'gate'
        && isPlainRecord(classify.details) ? { event: classify, details: classify.details } : null;
}

export function readCoherentScopePredecessor(input: { repoRoot: string; taskId: string; taskMode: TaskModeEvidenceResult;
    taskModePath: string; preflightPath: string }) {
    const events = readCoherentScopeTimeline(input.repoRoot, input.taskId);
    const mode = events.filter(event => event.event_type === 'TASK_MODE_ENTERED').at(-1);
    const classify = currentCoherentClassification(events);
    const modeSha256 = fileSha256(input.taskModePath);
    const preflightSha256 = fileSha256(input.preflightPath);
    const modeEventSha256 = coherentEventHash(mode);
    const preflightEventSha256 = coherentEventHash(classify?.event);
    const timelineHeadSha256 = coherentEventHash(events.at(-1));
    if (mode?.actor !== 'gate' || mode.outcome !== 'PASS' || !modeEventSha256 || !preflightEventSha256 || !timelineHeadSha256
        || !isPlainRecord(mode.details) || path.resolve(String(mode.details.artifact_path)) !== path.resolve(input.taskModePath)
        || input.taskMode.evidence_status !== 'PASS' || !modeSha256 || modeSha256 !== input.taskMode.evidence_hash
        || !preflightSha256 || classify?.details.output_sha256 !== preflightSha256
        || path.resolve(String(classify.details.output_path)) !== path.resolve(input.preflightPath))
        throw new Error('Coherent scope expansion requires the current authenticated task-mode entry and preflight.');
    return {
        previous_task_mode_sha256: modeSha256, previous_task_mode_event_sha256: modeEventSha256,
        previous_preflight_path: path.resolve(input.preflightPath), previous_preflight_sha256: preflightSha256,
        previous_preflight_event_sha256: preflightEventSha256, previous_timeline_head_sha256: timelineHeadSha256
    };
}

export function confirmCoherentScopeExpansion(confirmed: unknown, approvedAtUtc: string): void {
    validateFreshOperatorConfirmation({
        actionLabel: 'restart-coherent-cycle with expanded planned scope',
        confirmed: parseOperatorConfirmationYes(confirmed), confirmedAtUtc: approvedAtUtc, requireConfirmedAtUtc: true,
        instruction: 'Ask the operator to approve the exact added files and the coherent-cycle restart together, then pass the confirmation and its timestamp.'
    });
}

export function assertCoherentScopePublication(input: {
    repoRoot: string; taskId: string; taskModePath: string; previous: TaskModeEvidenceResult | null;
    plannedFiles: string[]; taskSummary: string; operatorConfirmed: unknown; operatorConfirmedAtUtc: unknown;
    approval: CoherentScopeApproval;
}): void {
    const { approval, previous } = input;
    if (!previous) throw new Error('Coherent scope approval has no current predecessor.');
    const predecessor = readCoherentScopePredecessor({ ...input, taskMode: previous, preflightPath: approval.previous_preflight_path });
    const addition = input.plannedFiles.filter(file => !previous.planned_changed_files.includes(file)).sort();
    if (!Object.entries(predecessor).every(([key, value]) => approval[key as keyof CoherentScopeApproval] === value)
        || !isDeepStrictEqual(addition, approval.added_files) || !addition.length
        || previous.planned_changed_files.some(file => !input.plannedFiles.includes(file))
        || approval.task_intent_sha256 !== taskIntentSha256(input.taskId, input.taskSummary)
        || String(input.operatorConfirmedAtUtc ?? '').trim() !== approval.approved_at_utc)
        throw new Error('Coherent scope approval no longer matches the current task, preflight, planned files or intent.');
    confirmCoherentScopeExpansion(input.operatorConfirmed, approval.approved_at_utc);
}
