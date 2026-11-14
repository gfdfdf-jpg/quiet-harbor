import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { fileSha256 } from '../shared/helpers';
import { readLostPreflightSnapshot } from '../preflight/preflight-restoration';
import { findLatestTimelineEvent, readTimelineEvents } from './handshake-diagnostics-timeline';
import { getHandshakeEvidence } from './handshake-diagnostics-evidence';
import type { HandshakeEvidenceResult } from './handshake-diagnostics-types';
import { getShellSmokeEvidence, type ShellSmokeEvidenceResult } from './shell-smoke-preflight';

/**
 * Startup evidence (`<task>-handshake.json` and the shell-smoke evidence bound to it) binds no review: reviews bind
 * code, tests, the preflight scope and the suite command. When such a file is gone or no longer matches its
 * authenticated timeline event, Garda rebuilds it through the real startup gates instead of asking for a task reset
 * (which repeats every review). Only a timeline that cannot prove the startup sequence any more stays with the operator.
 */
const LOST_STARTUP_EVIDENCE_STATUSES: ReadonlySet<string> = new Set([
    'EVIDENCE_FILE_MISSING',
    'EVIDENCE_INVALID_JSON',
    'EVIDENCE_TASK_MISMATCH',
    'EVIDENCE_SOURCE_INVALID',
    'EVIDENCE_TIMELINE_UNBOUND'
]);
const TRUSTED_TIMELINE_STATUSES: ReadonlySet<string> = new Set(['PASS', 'PASS_WITH_LEGACY_PREFIX']);
const STARTUP_EVENT_TYPES: ReadonlySet<string> = new Set([
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED'
]);
/** Both diagnostics gates record their events as `gate` with an integrity block; reserved types cannot be logged by hand. */
const DIAGNOSTIC_EVENT_TYPES: ReadonlySet<string> = new Set([
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED'
]);

export type StartupEvidenceRecoveryStage = 'before-preflight' | 'after-preflight';
export type StartupEvidenceRecoveryGate =
    | 'handshake-diagnostics'
    | 'shell-smoke-preflight'
    | 'restart-coherent-cycle'
    | 'startup-evidence-recovery';

export interface StartupEvidenceRecovery {
    /** False when the task timeline cannot prove the startup sequence: only the operator can continue. */
    recoverable: boolean;
    stage: StartupEvidenceRecoveryStage;
    nextGate: StartupEvidenceRecoveryGate;
    lostEvidence: Array<'handshake' | 'shell-smoke'>;
    violations: string[];
    /** Plain guidance without commands; callers add the exact command they can build. */
    guidance: string;
}

interface StartupEvent {
    type: string;
    position: number;
    passed: boolean;
    authenticated: boolean;
    taskEntryRulePack: boolean;
    outputPath: string;
}

function toStartupEvent(event: Readonly<Record<string, unknown>>, position: number): StartupEvent {
    const details = isPlainRecord(event.details) ? event.details : null;
    return {
        type: String(event.event_type || '').trim().toUpperCase(),
        position,
        passed: event.outcome === 'PASS' || details?.passed === true,
        authenticated: event.actor === 'gate' && isPlainRecord(event.integrity),
        taskEntryRulePack: String(details?.stage || '').trim().toUpperCase() === 'TASK_ENTRY',
        outputPath: typeof details?.output_path === 'string' ? details.output_path : ''
    };
}

/**
 * The classified preflight is gone when its file is missing, no longer a JSON object of this task, or replaced by other
 * bytes (an older copy) while an authenticated retained snapshot of the classified bytes exists to restore from.
 */
function classifiedPreflightLost(repoRoot: string, taskId: string, outputPath: string): boolean {
    if (!outputPath) return false;
    const root = path.resolve(repoRoot);
    const file = path.resolve(root, outputPath);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    try {
        const payload: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return !isPlainRecord(payload) || payload.task_id !== taskId
            || readLostPreflightSnapshot(root, taskId, file) !== null;
    } catch (error) {
        // Only a missing or unparseable file is lost; an unreadable path keeps its ordinary refusal.
        return (error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError;
    }
}

function findLast(events: readonly StartupEvent[], predicate: (event: StartupEvent) => boolean): StartupEvent | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) return events[index];
    }
    return null;
}

const OPERATOR_GUIDANCE = 'Garda does not regenerate startup evidence silently when the task timeline cannot prove the startup sequence. '
    + 'Ask the operator to preserve the task evidence and source work, reset the task (garda gate task-reset), then enter it again.';

/**
 * Cheap screen for the navigator, which names gates that verify startup evidence on every ordinary step: one read
 * per startup file under `reviewsRoot`, hashed in memory, against the hash its latest timeline event recorded.
 * True when a file is gone or differs, so the full check of {@link readStartupEvidenceRecovery} is worth running.
 */
export function startupEvidenceFileMayBeLost(reviewsRoot: string, taskId: string, timelinePath: string): boolean {
    let recordedEvents: ReturnType<typeof readTimelineEvents>;
    try { recordedEvents = readTimelineEvents(timelinePath); } catch { return false; }
    for (const [suffix, eventType] of [
        ['-handshake.json', 'HANDSHAKE_DIAGNOSTICS_RECORDED'],
        ['-shell-smoke.json', 'SHELL_SMOKE_PREFLIGHT_RECORDED']
    ] as const) {
        const event = findLatestTimelineEvent(recordedEvents, eventType);
        if (!event) continue;
        let bytes: Buffer;
        try { bytes = fs.readFileSync(path.join(reviewsRoot, `${taskId}${suffix}`)); } catch { return true; }
        const recorded = typeof event.details?.artifact_hash === 'string' ? event.details.artifact_hash : '';
        if (recorded && createHash('sha256').update(bytes).digest('hex') !== recorded.toLowerCase()) return true;
    }
    return false;
}

/**
 * Decide whether lost or corrupt startup evidence is recoverable by Garda. Returns null when no startup evidence
 * file is lost or corrupt (other startup failures keep their own routes).
 */
export function readStartupEvidenceRecovery(params: {
    repoRoot: string;
    taskId: string;
    taskModePath?: string;
    timelinePath: string;
    handshakeEvidence?: HandshakeEvidenceResult;
    shellSmokeEvidence?: ShellSmokeEvidenceResult;
}): StartupEvidenceRecovery | null {
    const handshake = params.handshakeEvidence ?? getHandshakeEvidence(params.repoRoot, params.taskId, {
        taskModePath: params.taskModePath || '',
        timelinePath: params.timelinePath
    });
    const handshakeCandidate = LOST_STARTUP_EVIDENCE_STATUSES.has(handshake.evidence_status);
    if (!handshakeCandidate && handshake.evidence_status !== 'PASS') return null;
    const shellSmoke = params.shellSmokeEvidence ?? getShellSmokeEvidence(params.repoRoot, params.taskId, {
        timelinePath: params.timelinePath
    });
    const shellSmokeCandidate = LOST_STARTUP_EVIDENCE_STATUSES.has(shellSmoke.evidence_status);
    if (!handshakeCandidate && !shellSmokeCandidate) return null;

    // The file is lost when it is gone, or corrupt when its bytes differ from the hash its timeline event recorded.
    // A file that matches its event (or an event without a recorded hash) is not lost evidence. The recorded hash is
    // read from the plain timeline so that a damaged timeline still reaches the operator handoff below.
    let recordedEvents: ReturnType<typeof readTimelineEvents> = [];
    try { recordedEvents = readTimelineEvents(params.timelinePath); } catch { recordedEvents = []; }
    const differsFromEvent = (status: string, evidencePath: string | null, eventType: string): boolean => {
        if (status === 'EVIDENCE_FILE_MISSING') return true;
        const details = findLatestTimelineEvent(recordedEvents, eventType)?.details ?? null;
        const recorded = typeof details?.artifact_hash === 'string' && details.artifact_hash ? details.artifact_hash : null;
        return !!recorded && !!evidencePath && fileSha256(evidencePath) !== recorded;
    };
    const handshakeLost = handshakeCandidate
        && differsFromEvent(handshake.evidence_status, handshake.evidence_path, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    const shellSmokeLost = shellSmokeCandidate
        && differsFromEvent(shellSmoke.evidence_status, shellSmoke.evidence_path, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
    if (!handshakeLost && (!shellSmokeLost || handshake.evidence_status !== 'PASS')) return null;

    const events: StartupEvent[] = [];
    const inspection = inspectTaskEventFile(params.timelinePath, params.taskId, {
        onIntegrityEvent: (event, lineNumber) => {
            if (STARTUP_EVENT_TYPES.has(String(event.event_type || '').trim().toUpperCase())) {
                events.push(toStartupEvent(event, lineNumber));
            }
        }
    });
    const trustedTimeline = TRUSTED_TIMELINE_STATUSES.has(inspection.status);

    const lostEvidence: StartupEvidenceRecovery['lostEvidence'] = [
        ...(handshakeLost ? ['handshake' as const] : []),
        ...(shellSmokeLost ? ['shell-smoke' as const] : [])
    ];
    const violations = [
        ...(handshakeLost ? handshake.violations : []),
        ...(shellSmokeLost ? shellSmoke.violations : [])
    ];

    const latestTaskMode = findLast(events, (event) => event.type === 'TASK_MODE_ENTERED');
    const cycle = latestTaskMode ? events.filter((event) => event.position > latestTaskMode.position) : [];
    const latestPreflight = findLast(cycle, (event) => event.type === 'PREFLIGHT_CLASSIFIED');
    const stage: StartupEvidenceRecoveryStage = latestPreflight ? 'after-preflight' : 'before-preflight';
    const operator = (problem: string): StartupEvidenceRecovery => ({
        recoverable: false,
        stage,
        nextGate: 'startup-evidence-recovery',
        lostEvidence,
        violations,
        guidance: `${problem} ${OPERATOR_GUIDANCE}`
    });

    if (!trustedTimeline) {
        return operator(`The task timeline is damaged or unverifiable (${inspection.status}${
            inspection.violations.length > 0 ? `: ${inspection.violations.slice(0, 3).join(' ')}` : ''}).`);
    }
    if (!latestTaskMode) {
        return operator('The task timeline has no TASK_MODE_ENTERED event that could bind startup evidence.');
    }
    if (cycle.some((event) => DIAGNOSTIC_EVENT_TYPES.has(event.type) && !event.authenticated)) {
        return operator('A startup diagnostics event in the current task cycle was not recorded by a Garda gate.');
    }

    // A restart needs the classified preflight as input. When that file is gone too, the preflight is classified again
    // anyway, so the startup chain is rebuilt as before preflight and classify-change then restores the startup order.
    const preflightLost = !!latestPreflight && classifiedPreflightLost(params.repoRoot, params.taskId, latestPreflight.outputPath);
    if (latestPreflight && !preflightLost) {
        // The current preflight was classified after a passed handshake and a passed shell smoke bound to it.
        const beforePreflight = cycle.filter((event) => event.position < latestPreflight.position);
        const rulePack = findLast(beforePreflight, (event) => event.type === 'RULE_PACK_LOADED' && event.taskEntryRulePack);
        const handshakeEvent = findLast(beforePreflight, (event) => event.type === 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        const shellSmokeEvent = findLast(beforePreflight, (event) => event.type === 'SHELL_SMOKE_PREFLIGHT_RECORDED');
        if (!rulePack || !handshakeEvent || !shellSmokeEvent || !handshakeEvent.passed || !shellSmokeEvent.passed
            || rulePack.position > handshakeEvent.position || handshakeEvent.position > shellSmokeEvent.position) {
            return operator('The startup events before the current PREFLIGHT_CLASSIFIED are missing, failed or out of order.');
        }
        return {
            recoverable: true,
            stage,
            nextGate: 'restart-coherent-cycle',
            lostEvidence,
            violations,
            guidance: 'Lost or damaged startup evidence binds no review. The current preflight was classified after it, so '
                + 'repeating handshake-diagnostics alone would break the startup order. Run restart-coherent-cycle: it rebuilds '
                + 'handshake, shell smoke and preflight in order through the real gates and, with an unchanged workspace, '
                + 'keeps passed reviews.'
        };
    }

    const rulePack = findLast(cycle, (event) => event.type === 'RULE_PACK_LOADED' && event.taskEntryRulePack);
    const handshakeEvent = rulePack
        ? findLast(cycle, (event) => event.type === 'HANDSHAKE_DIAGNOSTICS_RECORDED' && event.position > rulePack.position)
        : null;
    if (!rulePack || !handshakeEvent) {
        return operator('The startup evidence has no HANDSHAKE_DIAGNOSTICS_RECORDED event after TASK_ENTRY rules in the current cycle.');
    }
    const preflightState = preflightLost
        ? 'the classified preflight is lost too and is classified again after it'
        : 'no preflight exists yet in this cycle';
    return {
        recoverable: true,
        stage,
        nextGate: handshakeLost ? 'handshake-diagnostics' : 'shell-smoke-preflight',
        lostEvidence,
        violations,
        guidance: handshakeLost
            ? `Lost or damaged startup evidence binds no review and ${preflightState}. `
                + 'Run handshake-diagnostics again, then shell-smoke-preflight, then continue with next-step.'
            : `Lost or damaged shell-smoke evidence binds no review and ${preflightState}. `
                + 'Run shell-smoke-preflight again, then continue with next-step.'
    };
}
