import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { countNextStepWork } from '../../core/next-step-measurement';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { joinOrchestratorPath, normalizePath, isPathRealpathInsideRoot } from '../../core/orchestrator-paths';
import { readReviewArtifactFileSha256, withReviewArtifactLock, writeArtifactFileAtomically } from '../../gate-runtime/review-artifacts';
import { readInvocationVerifiedTaskEventTimeline, readTaskTimelineRouteQuery } from '../../gate-runtime/timeline/task-events-integrity';
import { routePreparedAfter } from '../../gate-runtime/timeline/task-route-query';
import { isAuthenticatedReviewRestartBoundary, isAuthenticatedReviewRestartEvent } from '../../gate-runtime/review/review-restart-boundary';
import { getCanonicalReviewContextPath } from '../review-context/review-context-paths';
import { readRestartReviewClassification } from '../review-remediation/review-remediation-classification-evidence';
import type { ReviewDependencyTimelineEvent } from './review-dependencies';

const reviewTimelineSources = new WeakMap<object, string>();

/** Source association is only a lookup hint; replay authority always comes from the verified native timeline. */
export function rememberReviewTimelineSource(events: object, timelinePath: string): void {
    reviewTimelineSources.set(events, timelinePath);
}

interface CompileReplay {
    firstSequence: number;
    latestSequence: number;
    timestamps: readonly string[];
}

function compileReplayKey(event: Readonly<Record<string, unknown>>, nativeEnvelope = true): string | null {
    const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
        ? event.details as Record<string, unknown> : null;
    if (event.event_type !== 'COMPILE_GATE_PASSED'
        || ((nativeEnvelope || event.actor != null) && event.actor !== 'gate') || event.outcome !== 'PASS'
        || details?.status !== 'PASSED' || details.exit_code !== 0
        || typeof details.preflight_path !== 'string' || !details.preflight_path.trim()
        || !Array.isArray(details.command_descriptors) || !details.command_descriptors.length
        || !Array.isArray(details.compile_commands) || !details.compile_commands.length) return null;
    const hashes = ['preflight_hash_sha256', 'scope_changed_files_sha256', 'scope_sha256', 'scope_content_sha256']
        .map(key => details[key]);
    if (hashes.some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))) return null;
    return JSON.stringify([details.preflight_path, ...hashes, details.command_descriptors,
        details.compile_commands, details.workflow_config_path, details.commands_path]);
}

/**
 * Rebuilding task evidence for exactly the same reviewed tree/policy/commands does not start a review cycle.
 * No incomplete proof, failed compile, task entry/reset or explicit review restart can cross this boundary.
 * Called only after a changed evidence binding or a missing current routing match, never on ordinary navigation.
 */
export function readAuthenticatedCompileReplay(timelinePath: string, taskId: string): CompileReplay | null {
    let key: string | null = null;
    let passes: Array<{ sequence: number; timestamp: string }> = [];
    const inspection = inspectTaskEventFile(timelinePath, taskId, { onIntegrityEvent: event => {
        countNextStepWork('visit:compile_replay_verified_event');
        const type = String(event.event_type || '');
        if (/^(?:TASK_(?:RESET|MODE_)|PREFLIGHT_|COHERENT_CYCLE_RESTARTED|REVIEW_CYCLE_RESTARTED|COMPILE_GATE_FAILED)/u.test(type)
            || event.outcome === 'FAIL') {
            key = null;
            passes = [];
        }
        if (type !== 'COMPILE_GATE_PASSED') return;
        const nextKey = compileReplayKey(event);
        const integrity = event.integrity as Record<string, unknown> | undefined;
        const sequence = Number(integrity?.task_sequence);
        const timestamp = String(event.timestamp_utc || '').trim();
        if (!nextKey || !Number.isInteger(sequence) || sequence < 1 || !timestamp) {
            key = null;
            passes = [];
            return;
        }
        if (key !== nextKey) passes = [];
        key = nextKey;
        passes.push({ sequence, timestamp });
    } });
    return inspection.status === 'PASS' && passes.length > 1 ? {
        firstSequence: passes[0].sequence,
        latestSequence: passes[passes.length - 1].sequence,
        timestamps: passes.map(pass => pass.timestamp)
    } : null;
}

/** CLI readers use ordinal sequences; map the verified replay boundary back to that same source array. */
export function resolveReviewCompileFloorSequence(
    events: readonly ReviewDependencyTimelineEvent[], latestSequence: number | null
): number | null {
    const source = reviewTimelineSources.get(events);
    if (!source || latestSequence == null) return latestSequence;
    const compiles = events.filter(event => (countNextStepWork('visit:compile_replay_candidate'), event.event_type === 'COMPILE_GATE_PASSED'));
    if (compiles.length < 2) return latestSequence;
    const latest = compiles[compiles.length - 1];
    const previous = compiles[compiles.length - 2];
    const key = compileReplayKey(latest as unknown as Record<string, unknown>, false);
    if (!key || key !== compileReplayKey(previous as unknown as Record<string, unknown>, false)) return latestSequence;
    const taskId = String(latest.task_id || latest.details?.task_id || '').trim();
    if (!taskId) return latestSequence;
    const replay = readAuthenticatedCompileReplay(source, taskId);
    return replay && replay.latestSequence === latest.integrity?.task_sequence
        ? compiles.find(event => event.integrity?.task_sequence === replay.firstSequence)?.sequence ?? latestSequence
        : latestSequence;
}

/** Missing launch-control authority cannot be reconstructed from an unauthenticated artifact. */
export const LOST_LAUNCH_CONTROL_RECOVERY = 'Ask the operator to reset this task with task-reset and enter it again. '
    + 'Do not reconstruct missing or corrupt launch-control or lane-reservation evidence.';

/**
 * A started launch can be failed using its authenticated control evidence even if its prompt was lost. The reviewer
 * already read its inputs, so this is lost evidence of this review only: next-step closes the attempt through the
 * failed-launch recovery and names its own operator handoff only if the launch-control evidence is lost as well.
 */
export function reviewerPromptRecovery(gateName: string): string {
    if (gateName === 'complete-reviewer-launch') {
        return 'Run next-step: it closes this authenticated started attempt through record-reviewer-launch-failed and '
            + 'repeats only this review with a fresh attempt. Do not restore or reconstruct the lost reviewer input.';
    }
    if (gateName === 'prepare-reviewer-launch' || gateName === 'record-reviewer-delegation-started') {
        return 'Run build-review-context to rebuild current review inputs, then run next-step to prepare a fresh reviewer attempt.';
    }
    if (gateName === 'record-review-result' || gateName === 'record-review-receipt'
        || gateName === 'record-review-invocation' || gateName === 'required-reviews-check') {
        return 'Run next-step to recover the affected review through authenticated review-evidence-only recovery. '
            + 'Do not reconstruct lost receipt-bound evidence by hand or restart unrelated passed reviews.';
    }
    return 'Run restart-coherent-cycle to rebuild ordered evidence and run fresh reviews. Do not restore review bindings from unauthenticated content.';
}

export function reviewArtifactReadRecovery(label: string): string {
    if (/^Reviewer launch (?:artifact|input artifact|lane reservation)$/u.test(label)) return LOST_LAUNCH_CONTROL_RECOVERY;
    if (label === 'Review context artifact') {
        return 'Run next-step to recover through fresh ordered reviews. Do not reconstruct authenticated review context by hand.';
    }
    return '';
}

/**
 * These lost receipt-bound objects require fresh ordered reviews, not an unrelated upstream rebind. A present file
 * whose bytes the receipt or review context does not authenticate is lost too: it is never trusted or repaired.
 */
export function findLostReviewGateEvidence(violations: readonly string[]): string | null {
    return violations.find(violation => /^Review findings disposition (?:snapshot|artifact) '[^']+' (?:is missing|is not valid JSON|sha256 mismatch: expected [0-9a-f]{64}, found [0-9a-f]{64})\.$/u.test(violation)
        || /^Review findings disposition snapshot '[^']+' does not match the receipt-bound artifact sha256\.$/u.test(violation)
        || /^required-reviews-check (?:requires a (?:readable|hashable) reviewer prompt artifact|cannot continue because reviewer prompt artifact is stale) for /u.test(violation)) ?? null;
}

interface ContextCopyOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    contextPath: string;
}

function hasCanonicalParent(file: string, repoRoot: string): boolean {
    try {
        const root = path.resolve(repoRoot);
        const realRoot = fs.realpathSync(root);
        let existing = path.dirname(file);
        for (;;) {
            try { fs.lstatSync(existing); break; } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
                const parent = path.dirname(existing);
                if (parent === existing) return false;
                existing = parent;
            }
        }
        const actual = path.resolve(fs.realpathSync(existing));
        const expected = path.resolve(realRoot, path.relative(root, existing));
        return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    } catch { return false; }
}

function copyPaths(options: ContextCopyOptions, sha256: string): { context: string; copy: string; legacy: string } | null {
    if (!/^[a-f0-9]{64}$/u.test(sha256) || !/^[a-z0-9][a-z0-9_-]*$/iu.test(options.reviewType)
        || !/^[a-z0-9][a-z0-9_-]*$/iu.test(options.taskId)) return null;
    const reviewsRoot = joinOrchestratorPath(options.repoRoot, 'runtime/reviews');
    const context = getCanonicalReviewContextPath(reviewsRoot, options.taskId, options.reviewType);
    const copy = joinOrchestratorPath(options.repoRoot, `runtime/tmp/.review-context-cache/${options.taskId}/${sha256}`);
    const legacy = joinOrchestratorPath(options.repoRoot, `runtime/tmp/.review-context-cache/${sha256}`);
    if (path.resolve(options.contextPath) !== path.resolve(context)
        || !isPathRealpathInsideRoot(context, options.repoRoot, { allowMissing: true })
        || !isPathRealpathInsideRoot(context, reviewsRoot, { allowMissing: true })
        || !isPathRealpathInsideRoot(copy, options.repoRoot, { allowMissing: true })
        || !isPathRealpathInsideRoot(legacy, options.repoRoot, { allowMissing: true })
        || !hasCanonicalParent(context, options.repoRoot) || !hasCanonicalParent(copy, options.repoRoot)
        || !hasCanonicalParent(legacy, options.repoRoot)) return null;
    return { context, copy, legacy };
}

function matchingBytes(file: string, sha256: string): Buffer | null {
    try {
        const bytes = fs.readFileSync(file);
        return crypto.createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null;
    } catch { return null; }
}

/** Keep bytes, not authority: a later authenticated event must independently pin their digest. */
export function preserveReviewContextCopy(options: ContextCopyOptions, text: string): void {
    const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const paths = copyPaths(options, sha256);
    if (!paths) return;
    if (!matchingBytes(paths.copy, sha256)) {
        fs.mkdirSync(path.dirname(paths.copy), { recursive: true });
        writeArtifactFileAtomically(paths.copy, text);
    }
}

/** Inspect a copy only against a digest supplied by the authenticated task timeline. */
export function canRestoreReviewContextCopy(options: ContextCopyOptions, expectedSha256: string): boolean {
    const paths = copyPaths(options, expectedSha256);
    return Boolean(paths && !matchingBytes(paths.context, expectedSha256)
        && (matchingBytes(paths.copy, expectedSha256) || matchingBytes(paths.legacy, expectedSha256)));
}

/** Read cached bytes under an externally authenticated digest without changing the live context. */
export function readPreservedReviewContextCopy(options: ContextCopyOptions, expectedSha256: string): Buffer | null {
    const paths = copyPaths(options, expectedSha256);
    return paths ? matchingBytes(paths.copy, expectedSha256) || matchingBytes(paths.legacy, expectedSha256) : null;
}

/** Recheck the digest and destination under the artifact lock immediately before writing. */
export function restoreReviewContextCopy(options: ContextCopyOptions, expectedSha256: string, damagedSha256: string | null): boolean {
    const paths = copyPaths(options, expectedSha256);
    if (!paths) return false;
    return withReviewArtifactLock(paths.context, () => {
        const currentPaths = copyPaths(options, expectedSha256);
        if (!currentPaths) return false;
        let currentSha256: string | null = null;
        try {
            currentSha256 = crypto.createHash('sha256').update(fs.readFileSync(currentPaths.context)).digest('hex');
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        }
        if (currentSha256 !== damagedSha256 || currentSha256 === expectedSha256) return false;
        const bytes = matchingBytes(currentPaths.copy, expectedSha256) || matchingBytes(currentPaths.legacy, expectedSha256);
        if (!bytes || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return false;
        writeArtifactFileAtomically(currentPaths.context, bytes.toString('utf8'));
        return true;
    }).result;
}

interface ReviewContextRecoveryState { reviewType: string; contextPath: string; }

const CONTEXT_EVENTS = new Set([
    'REVIEWER_LAUNCH_PREPARED', 'REVIEWER_LAUNCH_INPUT_PINNED', 'REVIEWER_DELEGATION_STARTED',
    'REVIEWER_LAUNCH_COMPLETED', 'REVIEWER_INVOCATION_ATTESTED'
]);

/** Compare event paths using the filesystem's path case rules. */
export function sameReviewContextPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
    const first = normalizePath(path.resolve(left));
    const second = normalizePath(path.resolve(right));
    return platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

/** A prepare retry may restore inputs only when the verified lane history proves no handoff has occurred. */
export function canRestoreReviewerInputsBeforeHandoff(options: {
    repoRoot: string; taskId: string; reviewType: string; contextPath: string; contextSha256: string;
}): boolean {
    const timeline = joinOrchestratorPath(options.repoRoot, `runtime/task-events/${options.taskId}.jsonl`);
    let prepared = false;
    let handedOff = false;
    const inspection = inspectTaskEventFile(timeline, options.taskId, { onIntegrityEvent: event => {
        const type = String(event.event_type || '');
        if (['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED'].includes(type)
            || isAuthenticatedReviewRestartBoundary(event as Record<string, unknown>, options.taskId, options.reviewType)) {
            prepared = false; handedOff = false; return;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown> : {};
        if (String(details.review_type || details.reviewType || '').trim().toLowerCase() !== options.reviewType) return;
        if (type === 'REVIEW_PHASE_STARTED' && event.actor === 'gate' && event.outcome === 'INFO'
            && sameReviewContextPath(path.resolve(options.repoRoot, String(details.output_path || '')), options.contextPath)) {
            prepared = true;
        } else if (type === 'REVIEWER_DELEGATION_ROUTED' && event.actor === 'orchestrator' && event.outcome === 'INFO'
            && /^[0-9a-f]{64}$/u.test(options.contextSha256) && details.review_context_sha256 === options.contextSha256
            && !handedOff) {
            prepared = true;
        } else if (['REVIEWER_DELEGATION_STARTED', 'REVIEWER_LAUNCH_COMPLETED', 'REVIEWER_INVOCATION_ATTESTED', 'REVIEW_RECORDED']
            .includes(type)) {
            handedOff = true;
        }
    } });
    return ['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status) && prepared && !handedOff;
}

/** Find only copies pinned by the current lane's verified native events; never use the copy as its own authority. */
export function findReviewContextRecoveryCandidates(options: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    states: readonly ReviewContextRecoveryState[];
}): Array<{ state: ReviewContextRecoveryState; sha256: string; copyAvailable: boolean; launchPrepared: boolean }> {
    const timeline = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    const query = readTaskTimelineRouteQuery(timeline, options.taskId);
    // A lane that has never prepared a context is ordinary planned work, not evidence loss.
    const states = query ? options.states.filter(state => routePreparedAfter(query, state.reviewType, state.contextPath, 0)) : options.states;
    if (!states.length) return [];
    const expected = new Map<string, string>();
    const prepared = new Set<string>();
    const launched = new Set<string>();
    const handedOff = new Set<string>();
    const postRunProof = new Map<string, string>();
    const routing = new Map<string, string>();
    const invalidated = new Set<string>();
    const lanes = new Set(states.map(state => state.reviewType));
    const accept = (event: Readonly<Record<string, unknown>>): void => {
        const type = String(event.event_type || '');
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown> : {};
        if (['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED'].includes(type)) {
            expected.clear(); prepared.clear(); launched.clear(); handedOff.clear(); postRunProof.clear(); routing.clear(); invalidated.clear(); return;
        }
        if (type === 'COHERENT_CYCLE_RESTARTED' || type === 'REVIEW_CYCLE_RESTARTED') {
            let legacyUnclassifiedScope = false;
            if (type === 'REVIEW_CYCLE_RESTARTED' && isAuthenticatedReviewRestartEvent(event as Record<string, unknown>, options.taskId)) {
                try {
                    const classification = readRestartReviewClassification({ reviewsRoot: path.dirname(states[0].contextPath),
                        taskId: options.taskId, details });
                    const record = classification && typeof classification === 'object' && !Array.isArray(classification)
                        ? classification as Record<string, unknown> : null;
                    const delta = record?.delta && typeof record.delta === 'object' && !Array.isArray(record.delta)
                        ? record.delta as Record<string, unknown> : null;
                    const assessment = delta?.mode_policy_assessment && typeof delta.mode_policy_assessment === 'object'
                        && !Array.isArray(delta.mode_policy_assessment) ? delta.mode_policy_assessment as Record<string, unknown> : null;
                    legacyUnclassifiedScope = record?.source === 'delta' && !!assessment
                        && assessment.scope_review_types === undefined && assessment.full_review_types === undefined;
                } catch {
                    // An unreadable classification does not establish a new pin or weaken the normal validation.
                }
            }
            // Legacy unclassified scopes repeat every lane in FULL, even if their old invalidated list was narrower.
            // This only discards older pins; the fresh context and its restart authority are still validated normally.
            for (const lane of lanes) if (legacyUnclassifiedScope
                || isAuthenticatedReviewRestartBoundary(event as Record<string, unknown>, options.taskId, lane)) {
                expected.delete(lane); prepared.delete(lane); launched.delete(lane); handedOff.delete(lane);
                postRunProof.delete(lane); routing.delete(lane); invalidated.add(lane);
            }
            return;
        }
        const lane = String(details.review_type || details.reviewType || '').trim().toLowerCase();
        if (!lanes.has(lane)) return;
        const state = states.find(entry => entry.reviewType === lane)!;
        const digest = String(details.review_context_sha256 || details.reviewContextSha256 || '').trim().toLowerCase();
        const validDigest = /^[a-f0-9]{64}$/u.test(digest);
        if (prepared.has(lane) && (!validDigest || !expected.has(lane) || expected.get(lane) === digest)
            && ['REVIEWER_DELEGATION_STARTED', 'REVIEWER_LAUNCH_COMPLETED',
            'REVIEWER_INVOCATION_ATTESTED', 'REVIEW_RECORDED'].includes(type)) {
            // Even malformed later telemetry is not evidence that the reviewer never received the context.
            handedOff.add(lane);
            postRunProof.delete(lane);
        } else if (prepared.has(lane) && ['REVIEWER_LAUNCH_PREPARED', 'REVIEWER_LAUNCH_INPUT_PINNED',
            'REVIEWER_LAUNCH_FAILED'].includes(type)) {
            postRunProof.delete(lane);
        }
        if (type === 'REVIEW_PHASE_STARTED' && event.actor === 'gate' && event.outcome === 'INFO') {
            const output = String(details.output_path || details.outputPath || '');
            if (!sameReviewContextPath(path.resolve(options.repoRoot, output), state.contextPath)) {
                expected.delete(lane); prepared.delete(lane); launched.delete(lane);
                postRunProof.delete(lane); routing.delete(lane); return;
            }
            prepared.add(lane);
            launched.delete(lane);
            postRunProof.delete(lane);
            routing.delete(lane);
            if (validDigest) expected.set(lane, digest); else expected.delete(lane);
        } else if (prepared.has(lane) && type === 'REVIEWER_DELEGATION_ROUTED') {
            // A later route supersedes an earlier receipt or launch pin, even when that route cannot itself
            // authenticate a replacement. Otherwise recovery could restore a previous reviewer's context
            // over the context of a newer attempt.
            expected.delete(lane); routing.delete(lane); launched.delete(lane); postRunProof.delete(lane);
            if (event.actor !== 'orchestrator' || event.outcome !== 'INFO') return;
            const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
                ? event.integrity as Record<string, unknown> : {};
            const routingSha256 = String(integrity.event_sha256 || '').trim().toLowerCase();
            if (/^[a-f0-9]{64}$/u.test(routingSha256)) routing.set(lane, routingSha256); else routing.delete(lane);
            if (validDigest) expected.set(lane, digest); else expected.delete(lane);
        } else if (prepared.has(lane) && CONTEXT_EVENTS.has(type)
            && event.actor === 'orchestrator' && event.outcome === 'INFO' && validDigest
            && String(details.task_id || '') === options.taskId && routing.has(lane)
            && String(details.routing_event_sha256 || '').trim().toLowerCase() === routing.get(lane)) {
            expected.set(lane, digest);
            if (type === 'REVIEWER_LAUNCH_PREPARED') launched.add(lane);
        } else if (prepared.has(lane) && type === 'REVIEW_RECORDED' && event.actor === 'gate'
            && event.outcome === 'PASS' && validDigest && String(details.task_id || '') === options.taskId
            && (!expected.has(lane) || expected.get(lane) === digest)
            && sameReviewContextPath(path.resolve(options.repoRoot, String(details.review_context_path || '')), state.contextPath)) {
            expected.set(lane, digest);
            const proof = details.reviewer_input_proof && typeof details.reviewer_input_proof === 'object'
                && !Array.isArray(details.reviewer_input_proof) ? details.reviewer_input_proof as Record<string, unknown> : null;
            if (proof?.review_context_sha256 === digest && Array.isArray(proof.inputs)) postRunProof.set(lane, digest);
            if (details.reused_existing_review !== true) invalidated.delete(lane);
        }
    };
    const verified = readInvocationVerifiedTaskEventTimeline(timeline, options.taskId);
    if (verified) {
        if (verified.result.status !== 'PASS') return [];
        for (const entry of verified.events) accept(entry.event);
    } else {
        const inspection = inspectTaskEventFile(timeline, options.taskId, { onIntegrityEvent: accept });
        if (inspection.status !== 'PASS') return [];
    }
    const candidates = states.flatMap(state => {
        const sha256 = expected.get(state.reviewType);
        if (!sha256) return [];
        const damaged = readReviewArtifactFileSha256(state.contextPath) !== sha256;
        return damaged || invalidated.has(state.reviewType)
            ? [{ state, sha256, damaged, launchPrepared: launched.has(state.reviewType),
                restoreAllowed: !handedOff.has(state.reviewType) || postRunProof.get(state.reviewType) === sha256 }] : [];
    });
    if (!candidates.length || path.resolve(options.eventsRoot) !== path.resolve(joinOrchestratorPath(options.repoRoot, 'runtime/task-events'))) return [];
    return candidates.map(({ state, sha256, damaged, launchPrepared, restoreAllowed }) => ({ state, sha256, launchPrepared,
        copyAvailable: damaged && restoreAllowed
            && canRestoreReviewContextCopy({ ...options, reviewType: state.reviewType, contextPath: state.contextPath }, sha256) }));
}

export function findRestorableReviewContexts(
    options: Parameters<typeof findReviewContextRecoveryCandidates>[0]
): Array<{ state: ReviewContextRecoveryState; sha256: string }> {
    return findReviewContextRecoveryCandidates(options).filter(candidate => candidate.copyAvailable);
}
