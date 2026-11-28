import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureContainedDirectory, removeContainedPath, writeContainedFile } from '../contained-filesystem';
import { readTransactionBytes } from '../file-transaction-journal';
import { joinOrchestratorPath } from '../orchestrator-paths';
import { isPlainRecord } from '../records';
import { assertCanonicalTaskId } from '../task-ids';
import { decodeClosedReviewEnvelope, encodeClosedReviewEnvelope, isClosedReviewDigest,
    resolveClosedReviewAuthentication, resolveClosedReviewWorkspace } from '../../gate-runtime/review/review-closed-cycle-auth';
import type { TaskEvent } from '../../gate-runtime/timeline/task-events-io-types';

const MAX_STATE_BYTES = 1024 * 1024;

export interface CoherentScopeStageReceipt {
    event_sha256: string;
    artifact_path: string;
    artifact_sha256: string;
}

export interface ProtectedCoherentScope {
    task_id: string;
    revoked_by_reset?: never;
    entry: CoherentScopeStageReceipt;
    admission: Record<string, unknown>;
    classification: CoherentScopeStageReceipt | null;
    ended_by: string | null;
}

type CoherentScopeState = ProtectedCoherentScope | { task_id: string; revoked_by_reset: true };

const appendRollbacks = new WeakMap<Readonly<TaskEvent>, () => void>();

function statePath(gitDirectory: string, taskId: string): string {
    return path.join(gitDirectory, 'garda-private', 'coherent-scope', `${assertCanonicalTaskId(taskId)}.json`);
}

function isStageReceipt(value: unknown): value is CoherentScopeStageReceipt {
    return isPlainRecord(value) && isClosedReviewDigest(value.event_sha256)
        && typeof value.artifact_path === 'string' && path.isAbsolute(value.artifact_path)
        && isClosedReviewDigest(value.artifact_sha256);
}

function findStatePath(repoRoot: string, taskId: string): { gitDirectoryRealpath: string; file: string } | null {
    const gitPath = path.join(repoRoot, '.git');
    if (!fs.lstatSync(gitPath, { throwIfNoEntry: false })) return null;
    const { gitDirectoryRealpath } = resolveClosedReviewWorkspace(repoRoot);
    return { gitDirectoryRealpath, file: statePath(gitDirectoryRealpath, taskId) };
}

export function hasProtectedCoherentScopeReceipt(repoRoot: string, taskId: string): boolean {
    const gitPath = path.join(repoRoot, '.git');
    const git = fs.lstatSync(gitPath, { throwIfNoEntry: false });
    if (!git) return false;
    if (git.isDirectory()) return !!fs.lstatSync(statePath(gitPath, taskId), { throwIfNoEntry: false });
    const location = findStatePath(repoRoot, taskId);
    return !!location && !!fs.lstatSync(location.file, { throwIfNoEntry: false });
}

export function readProtectedCoherentScope(repoRoot: string, taskId: string): CoherentScopeState | null {
    const location = findStatePath(repoRoot, taskId);
    if (!location) return null;
    const bytes = readTransactionBytes(location.gitDirectoryRealpath, location.file, MAX_STATE_BYTES);
    if (!bytes) return null;
    const auth = resolveClosedReviewAuthentication(repoRoot, false);
    const state = decodeClosedReviewEnvelope(auth, 'coherent-scope', bytes);
    if (isPlainRecord(state) && state.task_id === taskId && state.revoked_by_reset === true)
        return { task_id: taskId, revoked_by_reset: true };
    if (!isPlainRecord(state) || state.task_id !== taskId || state.revoked_by_reset !== undefined
        || !isPlainRecord(state.admission) || !isStageReceipt(state.entry)
        || (state.classification !== null && !isStageReceipt(state.classification))
        || (state.ended_by !== null && !isClosedReviewDigest(state.ended_by)))
        throw new Error('Invalid protected coherent scope receipt.');
    return state as unknown as ProtectedCoherentScope;
}

export function coherentScopeStageReceipt(event: Readonly<TaskEvent>, artifactPath: string, artifactSha256: unknown): CoherentScopeStageReceipt {
    const stage = { event_sha256: event.integrity?.event_sha256, artifact_path: path.resolve(artifactPath), artifact_sha256: artifactSha256 };
    if (!isStageReceipt(stage)) throw new Error('Coherent scope publication requires canonical event and artifact bindings.');
    return stage;
}

function encodeState(auth: ReturnType<typeof resolveClosedReviewAuthentication>, state: CoherentScopeState): Buffer {
    const bytes = encodeClosedReviewEnvelope(auth, 'coherent-scope', state);
    if (bytes.length > MAX_STATE_BYTES) throw new Error('Protected coherent scope exceeds its receipt byte limit.');
    return bytes;
}

// A failed append can undo the exact receipt bytes while the task lock is still held.
export function writeProtectedCoherentScopeForAppend(
    repoRoot: string, state: ProtectedCoherentScope, event: Readonly<TaskEvent>, create = false
): void {
    const auth = resolveClosedReviewAuthentication(repoRoot, create);
    const root = auth.gitDirectoryRealpath;
    const file = statePath(root, state.task_id);
    const bytes = encodeState(auth, state);
    const before = readTransactionBytes(root, file, MAX_STATE_BYTES);
    if (appendRollbacks.has(event)) throw new Error('Canonical append already prepared a coherent scope receipt.');
    appendRollbacks.set(event, () => {
        const current = readTransactionBytes(root, file, MAX_STATE_BYTES);
        if (before ? current?.equals(before) : !current) return;
        if (!current?.equals(bytes)) throw new Error('Protected coherent scope changed before append rollback.');
        if (before) writeContainedFile(root, file, before);
        else removeContainedPath(root, file);
    });
    ensureContainedDirectory(root, path.dirname(file));
    writeContainedFile(root, file, bytes);
}

export function settleProtectedCoherentScopeAppend(event: Readonly<TaskEvent>, assertUnchangedTimeline?: () => void): void {
    const rollback = appendRollbacks.get(event);
    appendRollbacks.delete(event);
    if (!rollback || !assertUnchangedTimeline) return;
    assertUnchangedTimeline();
    rollback();
}

// Reset replaces the receipt under the task lock so restoring an old timeline cannot revive it.
export function revokeProtectedCoherentScopeForReset(repoRoot: string, taskId: string): void {
    const location = findStatePath(repoRoot, taskId);
    if (!location || !fs.lstatSync(location.file, { throwIfNoEntry: false })) return;
    const auth = resolveClosedReviewAuthentication(repoRoot, false);
    writeContainedFile(auth.gitDirectoryRealpath, statePath(auth.gitDirectoryRealpath, taskId),
        encodeState(auth, { task_id: taskId, revoked_by_reset: true }));
}

const END_TYPES = new Set(['TASK_MODE_ENTERED', 'COHERENT_CYCLE_RESTARTED', 'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'COMPLETION_GATE_PASSED', 'TASK_RESET', 'TASK_DISCARDED', 'TASK_DONE']);

export function endProtectedCoherentScopeForEvent(orchestratorRoot: string, eventsRoot: string, event: TaskEvent): void {
    if (!END_TYPES.has(event.event_type)) return;
    const eventHash = event.integrity?.event_sha256;
    if (!eventHash) throw new Error('Coherent scope supersession requires a canonical event hash.');
    for (const candidate of [orchestratorRoot, path.dirname(orchestratorRoot)]) {
        if (path.relative(joinOrchestratorPath(candidate, 'runtime/task-events'), eventsRoot)) continue;
        const state = readProtectedCoherentScope(candidate, event.task_id);
        if (!state) continue;
        if (!state.revoked_by_reset && !state.ended_by && state.entry.event_sha256 !== eventHash) {
            writeProtectedCoherentScopeForAppend(candidate, { ...state, ended_by: eventHash }, event);
        }
        return;
    }
}
