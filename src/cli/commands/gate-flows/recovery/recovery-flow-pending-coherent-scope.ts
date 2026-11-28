import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPlainRecord } from '../../../../core/records';
import { coherentScopeStageReceipt, readProtectedCoherentScope, writeProtectedCoherentScopeForAppend,
    type ProtectedCoherentScope } from '../../../../core/auth/protected-coherent-scope';
import type { TaskEvent } from '../../../../gate-runtime/timeline/task-events-io-types';
import { validationDigest } from '../../../../core/project-validation-identity';
import { fileSha256 } from '../../../../gate-runtime/hash';
import { getHandshakeEvidence } from '../../../../gates/diagnostics/handshake-diagnostics';
import { getShellSmokeEvidence } from '../../../../gates/diagnostics/shell-smoke-preflight';
import { readOperatorTaskIntent, recordOperatorTaskIntentUpdate,
    type prepareOperatorTaskIntentUpdate } from '../../../../gates/review-context/review-context-task-intent';
import type { CoherentScopeApproval } from '../task-mode/task-mode-coherent-scope-approval';
import { coherentEventHash, currentCoherentClassification, readCoherentScopeTimeline } from '../task-mode/task-mode-coherent-scope-approval';
import { COHERENT_RED_PENDING_EVENT, normalizedCoherentRequest } from './recovery-flow-validation-checkpoint';
import type { ResolvedReplayScope, RestartCoherentCycleCommandOptions } from './recovery-flow-types';

type IntentUpdate = NonNullable<ReturnType<typeof prepareOperatorTaskIntentUpdate>>;

export interface PendingCoherentScope {
    request_sha256: string;
    request: Record<string, unknown>;
    task_summary: string;
    replay_scope: ResolvedReplayScope;
    intent_update: IntentUpdate | null;
    restart_details: Record<string, unknown>;
}

export function coherentScopeRequestSha256(repoRoot: string, options: RestartCoherentCycleCommandOptions): string {
    return validationDigest(normalizedCoherentRequest(repoRoot, options));
}

export function readPendingCoherentScope(input: {
    repoRoot: string; taskId: string; taskModePath: string; plannedFiles: string[];
    options?: RestartCoherentCycleCommandOptions;
}) {
    const events = readCoherentScopeTimeline(input.repoRoot, input.taskId, true);
    const authority = readProtectedCoherentScope(input.repoRoot, input.taskId);
    const modeIndex = events.map(event => event.event_type).lastIndexOf('TASK_MODE_ENTERED');
    const mode = events[modeIndex];
    const details = isPlainRecord(mode?.details) ? mode.details : null;
    if (authority?.revoked_by_reset) {
        if (details?.pending_coherent_scope) throw new Error('Protected coherent scope approval was revoked by operator reset.');
        return null;
    }
    if (authority?.ended_by) {
        if (!events.some(event => coherentEventHash(event) === authority.ended_by))
            throw new Error('Protected coherent scope approval already ended; its timeline may have been rolled back.');
        return null;
    }
    if (!authority && !details?.pending_coherent_scope) return null;
    if (!authority || authority.entry.event_sha256 !== coherentEventHash(mode))
        throw new Error('Pending coherent scope expansion has no matching protected admission receipt.');
    const currentEvents = events.slice(modeIndex + 1);
    if (currentEvents.some(event => ['COHERENT_CYCLE_RESTARTED', 'TASK_RESET', 'TASK_DISCARDED', 'REVIEW_GATE_PASSED',
        'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'COMPLETION_GATE_PASSED'].includes(String(event.event_type))))
        throw new Error('Pending coherent scope expansion cannot resume after a new lifecycle boundary.');
    const { approval, ...pending } = authority.admission;
    const marker = details?.pending_coherent_scope;
    if (mode.actor !== 'gate' || mode.outcome !== 'PASS' || !details || !isPlainRecord(marker) || !isPlainRecord(approval)
        || !isDeepStrictEqual(approval, details.coherent_scope_approval) || marker.request_sha256 !== pending.request_sha256
        || marker.admitted_task_mode_sha256 !== authority.entry.artifact_sha256
        || authority.entry.artifact_sha256 !== fileSha256(input.taskModePath)
        || authority.entry.artifact_path !== path.resolve(input.taskModePath)
        || path.resolve(String(details.artifact_path)) !== path.resolve(input.taskModePath)
        || !isPlainRecord(pending.request) || validationDigest(pending.request) !== pending.request_sha256
        || typeof pending.task_summary !== 'string'
        || !isPlainRecord(pending.replay_scope) || !isDeepStrictEqual(pending.replay_scope.plannedChangedFiles, input.plannedFiles))
        throw new Error('Pending coherent scope expansion does not match the authenticated admitted task mode.');
    if (input.options && pending.request_sha256 !== coherentScopeRequestSha256(input.repoRoot, input.options))
        throw new Error('Pending coherent scope expansion cannot resume a changed recovery request.');
    const preflightPath = verifyPendingClassification(authority, currentEvents);
    if (authority.red && !currentEvents.some(event => coherentEventHash(event) === authority.red?.event_sha256))
        throw new Error('Pending coherent scope RED checkpoint timeline was rolled back.');
    return { pending: pending as unknown as PendingCoherentScope, approval: approval as unknown as CoherentScopeApproval,
        preflightPath, currentEvents, authority };
}

export function readPendingCoherentScopeStartup(input: {
    repoRoot: string; taskId: string; taskModePath: string; timelinePath: string;
}): { handshake: boolean; smoke: boolean } {
    const { repoRoot, taskId, taskModePath, timelinePath } = input;
    const handshake = getHandshakeEvidence(repoRoot, taskId, { taskModePath, timelinePath }).evidence_status === 'PASS';
    const smoke = handshake && getShellSmokeEvidence(repoRoot, taskId, { timelinePath }).evidence_status === 'PASS';
    return { handshake, smoke };
}

export const MISSING_PENDING_SCOPE_STARTUP = 'The protected classification requires its current startup evidence.';

function verifyPendingClassification(authority: ProtectedCoherentScope, events: readonly Readonly<Record<string, unknown>>[]): string | null {
    if (authority.red) {
        // A prepared RED recovery has its own authenticated checkpoint and can refresh preflight within it.
        return authority.classification?.artifact_path ?? null;
    }
    const classification = currentCoherentClassification(events);
    if (!classification && !authority.classification) return null;
    const receipt = authority.classification;
    if (!receipt || !classification || coherentEventHash(classification.event) !== receipt.event_sha256
        || classification.details.output_sha256 !== receipt.artifact_sha256
        || path.resolve(String(classification.details.output_path)) !== receipt.artifact_path
        || fileSha256(receipt.artifact_path) !== receipt.artifact_sha256)
        throw new Error('Pending coherent scope expansion requires its own protected classification and unchanged preflight bytes.');
    return receipt.artifact_path;
}

export function bindCoherentScopeStage(input: { repoRoot: string; taskId: string; taskModePath: string; plannedFiles: string[];
    requestSha256: string; stage: 'classification' | 'red'; event: Readonly<TaskEvent> }): void {
    const pending = readPendingCoherentScope(input);
    const expectedType = input.stage === 'classification' ? 'PREFLIGHT_CLASSIFIED' : COHERENT_RED_PENDING_EVENT;
    const details = input.event.details;
    if (!pending || pending.pending.request_sha256 !== input.requestSha256 || pending.authority[input.stage]
        || input.event.event_type !== expectedType || !isPlainRecord(details))
        throw new Error('Cannot bind a stage to the current protected coherent scope request.');
    const prefix = input.stage === 'classification' ? 'output' : 'artifact';
    const receipt = coherentScopeStageReceipt(input.event, String(details[`${prefix}_path`]), details[`${prefix}_sha256`]);
    if (fileSha256(receipt.artifact_path) !== receipt.artifact_sha256)
        throw new Error('Cannot bind changed coherent scope stage artifact bytes.');
    writeProtectedCoherentScopeForAppend(input.repoRoot, { ...pending.authority, [input.stage]: receipt }, input.event);
}

export function recordCoherentScopeIntent(repoRoot: string, intent: IntentUpdate): void {
    const current = readOperatorTaskIntent(repoRoot, intent.task_id);
    if (current?.task_intent_sha256 === intent.task_intent_sha256) return;
    if (current && current.task_intent_sha256 !== intent.previous_task_intent_sha256)
        throw new Error('Pending coherent scope approval no longer matches the current operator task intent.');
    recordOperatorTaskIntentUpdate(repoRoot, intent);
}
