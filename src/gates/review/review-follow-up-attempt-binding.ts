import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readReviewArtifactFileSha256, readReviewArtifactJsonFile } from '../../gate-runtime/review/review-artifacts';
import { normalizePath } from '../../core/orchestrator-paths';
import { isPlainRecord } from '../../core/records';
import { readTaskQueueEntries } from '../../core/task-queue-read';
import { joinOrchestratorPath } from '../shared/helpers';
import { resolveCurrentReviewFollowUpMaterializationBinding } from '../next-step/next-step-review-artifact-readers';

export const REVIEW_FOLLOW_UP_BLOCKED_ATTEMPT_ARTIFACT_TYPE = 'review_findings_follow_up_blocked_attempt';

const ATTEMPT_INPUT_FILE_LIMIT = 512;
const RECORDED_VIOLATION_LIMIT = 20;

export interface ReviewFollowUpAttemptBindingInput {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewTypes: readonly string[];
    // Overrides the running Garda version; only tests use it.
    runtimeVersion?: string;
}

// Bumped whenever grouped admission logic changes in a way that could admit a
// previously refused batch, in addition to the running Garda version.
const ATTEMPT_ADMISSION_LOGIC_MARKER = 'grouped-follow-up-admission-3';
let cachedRuntimeVersion: string | null = null;

export function resolveGardaRuntimeVersion(): string {
    if (cachedRuntimeVersion !== null) return cachedRuntimeVersion;
    let current = path.resolve(__dirname);
    let version = 'unknown';
    for (;;) {
        try {
            if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'VERSION'))) {
                version = fs.readFileSync(path.join(current, 'VERSION'), 'utf8').trim() || 'unknown';
                break;
            }
        } catch {
            break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    cachedRuntimeVersion = version;
    return version;
}

export interface RecordedReviewFollowUpBlockedAttempt {
    reviewTypes: string[];
    confirmedReviewTypes: string[];
    refusalCode: string;
    violations: string[];
}

export function getReviewFollowUpBlockedAttemptPath(reviewsRoot: string, taskId: string): string {
    return path.join(reviewsRoot, `${taskId}-review-follow-up-materialization-blocked-attempt.json`);
}

function sha256Json(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeReviewTypes(reviewTypes: readonly unknown[]): string[] {
    return [...new Set(reviewTypes.map((reviewType) => String(reviewType || '').trim().toLowerCase()).filter(Boolean))].sort();
}

function isGroupedChildOrParent(parentTaskId: string, taskId: string): boolean {
    return taskId === parentTaskId
        || (taskId.startsWith(`${parentTaskId}-F`) && /^[1-9][0-9]*$/u.test(taskId.slice(parentTaskId.length + 2)));
}

function readTimelineTail(repoRoot: string, taskId: string): unknown {
    const timelinePath = path.join(joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')), `${taskId}.jsonl`);
    let content: string;
    try {
        content = fs.readFileSync(timelinePath, 'utf8');
    } catch {
        return null;
    }
    const lastLine = content.split(/\r?\n/u).filter((line) => line.trim()).at(-1) || '';
    try {
        const event = JSON.parse(lastLine) as unknown;
        const integrity = isPlainRecord(event) && isPlainRecord(event.integrity) ? event.integrity : null;
        return {
            task_sequence: integrity?.task_sequence ?? null,
            event_sha256: integrity?.event_sha256 ?? null,
            line_sha256: createHash('sha256').update(lastLine).digest('hex')
        };
    } catch {
        return { line_sha256: createHash('sha256').update(lastLine).digest('hex') };
    }
}

/**
 * Fingerprints every input that decides a grouped follow-up admission outcome:
 * the current group binding, the parent timeline tail, the parent and child queue
 * rows, and every review evidence file of the parent task in the reviews root
 * (receipts and their snapshots, review reports, contexts, validation,
 * disposition and follow-up artifacts). Diagnostics are excluded. The same
 * fingerprint means the same command would meet the same evidence again.
 */
export function buildReviewFollowUpAttemptInputSha256(input: ReviewFollowUpAttemptBindingInput): string | null {
    const reviewTypes = normalizeReviewTypes(input.reviewTypes);
    if (reviewTypes.length === 0) return null;
    const binding = resolveCurrentReviewFollowUpMaterializationBinding(input.repoRoot, input.reviewsRoot, input.taskId);
    if (!binding || binding.mode !== 'grouped_by_parent' || !binding.groupFingerprint) return null;
    const recordName = path.basename(getReviewFollowUpBlockedAttemptPath(input.reviewsRoot, input.taskId));
    let names: string[];
    try {
        const prefix = `${input.taskId}-`;
        names = fs.readdirSync(input.reviewsRoot, { withFileTypes: true })
            .filter((entry) => entry.name.startsWith(prefix) && !entry.isDirectory()
                && entry.name !== recordName && !entry.name.endsWith('-blocked.json'))
            .map((entry) => entry.name)
            .sort();
    } catch {
        return null;
    }
    if (names.length > ATTEMPT_INPUT_FILE_LIMIT) return null;
    const files = names.map((name) => [name, readReviewArtifactFileSha256(path.join(input.reviewsRoot, name))]);
    let queueRows: Array<[string, string, string]>;
    try {
        queueRows = [...readTaskQueueEntries(input.repoRoot).values()]
            .filter((entry) => isGroupedChildOrParent(input.taskId, entry.taskId))
            .map((entry): [string, string, string] => [entry.taskId, entry.status || '', entry.notes || ''])
            .sort((left, right) => left[0].localeCompare(right[0]));
    } catch {
        return null;
    }
    return sha256Json({
        schema_version: 2,
        garda_runtime_version: input.runtimeVersion ?? resolveGardaRuntimeVersion(),
        admission_logic_marker: ATTEMPT_ADMISSION_LOGIC_MARKER,
        task_id: input.taskId,
        review_types: reviewTypes,
        snapshot_hash: binding.snapshotHash,
        cycle_id: binding.cycleId,
        group_fingerprint: binding.groupFingerprint,
        preflight_sha256: binding.preflightSha256,
        compile_timestamp: binding.compileTimestamp,
        timeline_tail: readTimelineTail(input.repoRoot, input.taskId),
        files,
        queue_rows: queueRows
    });
}

export function buildReviewFollowUpBlockedAttemptRecord(params: {
    taskId: string;
    reviewTypes: readonly string[];
    reviewsRoot: string;
    confirmedReviewTypes: readonly string[];
    refusalCode: string;
    inputSha256: string;
    violations: readonly string[];
}): Record<string, unknown> {
    return {
        schema_version: 2,
        artifact_type: REVIEW_FOLLOW_UP_BLOCKED_ATTEMPT_ARTIFACT_TYPE,
        task_id: params.taskId,
        command: {
            form: 'review_types_batch',
            review_types: normalizeReviewTypes(params.reviewTypes),
            reviews_root: normalizePath(params.reviewsRoot),
            operator_confirmed_unmaterialized_lanes: normalizeReviewTypes(params.confirmedReviewTypes)
        },
        refusal_code: params.refusalCode,
        input_sha256: params.inputSha256,
        created_at_utc: new Date().toISOString(),
        violations: params.violations.slice(0, RECORDED_VIOLATION_LIMIT).map((violation) => String(violation))
    };
}

export interface UnmaterializedLaneRecoveryCandidates {
    childTaskId: string;
    reviewTypes: string[];
    // Pending lanes without any follow-up artifact entry, bound to the child or not.
    lanesWithoutArtifact: string[];
    // Pending lanes the current child does not bind, with or without an artifact.
    unboundPendingLanes: string[];
}

function followUpArtifactEntryMissing(input: ReviewFollowUpAttemptBindingInput, reviewType: string): boolean {
    try {
        fs.lstatSync(path.join(input.reviewsRoot, `${input.taskId}-${reviewType}-findings-follow-ups.json`));
        return false;
    } catch (error) {
        return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
    }
}

/**
 * Lists the pending lanes an operator may confirm as never materialized: the
 * current-group child must be unique and pending, and each lane must have no
 * follow-up artifact entry at all and no binding in any child. This only shapes
 * navigator guidance; the gate re-checks every condition under the queue lock.
 */
export function findUnmaterializedLaneRecoveryCandidates(
    input: ReviewFollowUpAttemptBindingInput
): UnmaterializedLaneRecoveryCandidates | null {
    const binding = resolveCurrentReviewFollowUpMaterializationBinding(input.repoRoot, input.reviewsRoot, input.taskId);
    if (!binding || binding.mode !== 'grouped_by_parent' || !binding.groupFingerprint) return null;
    let children: Array<{ taskId: string; status: string; notes: string }>;
    let parentNotes: string;
    try {
        const entries = [...readTaskQueueEntries(input.repoRoot).values()];
        parentNotes = entries.find((entry) => entry.taskId === input.taskId)?.notes || '';
        children = entries
            .filter((entry) => entry.taskId !== input.taskId && isGroupedChildOrParent(input.taskId, entry.taskId))
            .map((entry) => ({ taskId: entry.taskId, status: entry.status || '', notes: entry.notes || '' }));
    } catch {
        return null;
    }
    const currentChildren = children.filter((child) => (
        child.notes.match(/review_follow_up_group_fingerprint=([0-9a-f]{64})/iu)?.[1]?.toLowerCase() === binding.groupFingerprint
    ));
    const [child] = currentChildren;
    if (currentChildren.length !== 1 || !/TODO/iu.test(child.status)) return null;
    const lanesWithoutArtifact = normalizeReviewTypes(input.reviewTypes)
        .filter((reviewType) => followUpArtifactEntryMissing(input, reviewType));
    const reviewTypes = lanesWithoutArtifact.filter((reviewType) => (
        !children.some((candidate) => new RegExp(`review_follow_up_lane_binding=${reviewType}:`, 'iu').test(candidate.notes))
        && !parentNotes.includes(`${input.taskId}-${reviewType}-findings-follow-ups.json`)
    ));
    const unboundPendingLanes = normalizeReviewTypes(input.reviewTypes).filter((reviewType) => (
        !new RegExp(`review_follow_up_lane_binding=${reviewType}:`, 'iu').test(child.notes)
    ));
    return reviewTypes.length > 0
        ? { childTaskId: child.taskId, reviewTypes, lanesWithoutArtifact, unboundPendingLanes }
        : null;
}

/**
 * Returns the recorded refused attempt only when it was made by the same standard
 * batch command against unchanged inputs. The record is a mutable diagnostic: it
 * can stop the navigator from repeating a command, but it never authorizes any
 * evidence.
 */
export function readMatchingReviewFollowUpBlockedAttempt(
    input: ReviewFollowUpAttemptBindingInput
): RecordedReviewFollowUpBlockedAttempt | null {
    const recordPath = getReviewFollowUpBlockedAttemptPath(input.reviewsRoot, input.taskId);
    let record: unknown;
    try {
        if (!fs.existsSync(recordPath)) return null;
        record = readReviewArtifactJsonFile(recordPath);
    } catch {
        return null;
    }
    const command = isPlainRecord(record) && isPlainRecord(record.command) ? record.command : null;
    if (!isPlainRecord(record) || !command || record.artifact_type !== REVIEW_FOLLOW_UP_BLOCKED_ATTEMPT_ARTIFACT_TYPE
        || record.schema_version !== 2 || record.task_id !== input.taskId || command.form !== 'review_types_batch'
        || !Array.isArray(command.review_types) || !Array.isArray(command.operator_confirmed_unmaterialized_lanes)
        || typeof record.refusal_code !== 'string' || !record.refusal_code) {
        return null;
    }
    const reviewTypes = normalizeReviewTypes(input.reviewTypes);
    const expectedReviewsRoot = normalizePath(path.relative(input.repoRoot, input.reviewsRoot));
    if (JSON.stringify(normalizeReviewTypes(command.review_types)) !== JSON.stringify(reviewTypes)
        || command.reviews_root !== expectedReviewsRoot) {
        return null;
    }
    const inputSha256 = buildReviewFollowUpAttemptInputSha256(input);
    if (!inputSha256 || record.input_sha256 !== inputSha256) return null;
    return {
        reviewTypes,
        confirmedReviewTypes: normalizeReviewTypes(command.operator_confirmed_unmaterialized_lanes),
        refusalCode: record.refusal_code,
        violations: Array.isArray(record.violations) ? record.violations.map(String) : []
    };
}
