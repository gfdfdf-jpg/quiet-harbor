import * as fs from 'node:fs';
import * as path from 'node:path';
import { readInvocationTextFile } from '../../core/invocation-file-observation';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile, isSignedTaskEvent, readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { normalizePath } from '../shared/helpers';
import { buildCommand, quoteCommandValue } from './next-step-command-formatters';
import type { NextStepDecisionRoutePayload } from './next-step-decision-route-groups';
import { PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE } from './next-step-reviewer-launch-evidence-shared';

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function commandValue(command: string, flag: string): string | null {
    const match = new RegExp(`\\s${flag}\\s+"([^"]+)"`, 'u').exec(command);
    return match ? match[1] : null;
}

function attemptOf(record: unknown): string {
    const details = isPlainRecord(record) && isPlainRecord(record.details) ? record.details : null;
    const value = details?.reviewer_launch_attempt_id ?? details?.reviewerLaunchAttemptId;
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * A prepared launch whose REVIEWER_LAUNCH_PREPARED event exists only in the unsigned legacy prefix authenticates
 * nothing, yet its on-disk control artifact stays an immutable prepared attempt that prepare-reviewer-launch neither
 * overwrites nor reuses. Offering that command would be refused, so the route names the operator handoff instead:
 * keep the timeline and launch artifact for audit, restore the authentic history or reset the task (preview only).
 * Narrow by construction: only a legacy-prefixed history can carry an unsigned event, and an interrupted ordinary
 * preparation has no such event at all.
 */
export function readUnsignedPreparedLaunchRoute(options: {
    repoRoot: string; taskId: string; timelinePath: string; cliPrefix: string; route: NextStepDecisionRoutePayload;
}): NextStepDecisionRoutePayload | null {
    if (options.route.nextGate !== 'prepare-reviewer-launch') return null;
    const command = options.route.commands.find(entry => / gate prepare-reviewer-launch /u.test(entry.command))?.command;
    const artifactValue = command ? commandValue(command, '--reviewer-launch-artifact-path') : null;
    const reviewType = command ? commandValue(command, '--review-type') : null;
    if (!artifactValue || !reviewType) return null;
    const artifactPath = path.resolve(options.repoRoot, artifactValue);
    let artifact: unknown;
    if (!fs.existsSync(artifactPath)) return null;
    try { artifact = JSON.parse(readInvocationTextFile(artifactPath)); } catch { return null; }
    if (!isPlainRecord(artifact) || artifact.evidence_type !== PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
        || artifact.attestation_state !== 'prepared') return null;
    const attemptId = String(artifact.reviewer_launch_attempt_id ?? '').trim().toLowerCase();
    if (!ATTEMPT_ID.test(attemptId)) return null;
    if (inspectTaskEventFile(options.timelinePath, options.taskId).status !== 'PASS_WITH_LEGACY_PREFIX') return null;
    const prepared = readTaskTimelineJsonlEntries(options.timelinePath)
        .filter(entry => entry.record?.event_type === 'REVIEWER_LAUNCH_PREPARED' && attemptOf(entry.record) === attemptId);
    if (!prepared.length || prepared.some(entry => isSignedTaskEvent(entry.record))) return null;
    return {
        status: 'BLOCKED',
        nextGate: 'task-reset',
        title: 'Ask the operator to restore authentic task history for an unsigned reviewer launch.',
        reason: `The '${reviewType}' reviewer launch attempt '${attemptId}' at ${normalizePath(artifactPath)} is recorded only `
            + `in the unsigned legacy prefix of ${normalizePath(options.timelinePath)}, so it authenticates nothing; `
            + 'prepare-reviewer-launch keeps an immutable prepared attempt and would refuse a new one. Ask the operator to keep '
            + 'a copy of the timeline and the launch artifact for audit, restore the authentic timeline from a preserved copy, run '
            + `${options.cliPrefix} repair rebuild-indexes --confirm --repo-root ".", then run next-step. Without an authentic copy, `
            + 'reset the task, which repeats the reviews; the command below only previews it.',
        commands: [buildCommand('Preview task reset after preserving evidence',
            `${options.cliPrefix} gate task-reset --task-id ${quoteCommandValue(options.taskId)} --reopen --dry-run --repo-root "."`)]
    };
}
