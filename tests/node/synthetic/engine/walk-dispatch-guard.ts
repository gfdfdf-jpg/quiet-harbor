import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inspectTaskEventFile } from '../../../../src/gate-runtime/task-events';
import { isPlainRecord } from '../../../../src/core/records';
import { splitCommandLine } from '../../../../src/core/command-line';

/**
 * Loop detection on what the agent actually DISPATCHED: the gate and its exact argv against the semantic state the
 * navigator saw. Metadata that grows with every attempt (event counts, timestamps, hashes of timestamped artifacts)
 * cannot make a repeated command look like progress. The same gate and argv at an unchanged semantic state fails on
 * the second dispatch, unless the scenario declares a bounded retry for that gate and the previous attempt left an
 * observable failed outcome. Field defects this class covers: a timed-out intermediate command offered unchanged
 * (849f0d04), a rejected restart route offered again (OP-055, d0e95287), an unusable recovery repeated (OP-047, 53e0a522).
 */
export interface DispatchedCommand {
    taskId: string;
    gate: string | null;
    lane: string;
    command: string;
    /** Semantic state: workspace plus current authenticated task evidence. */
    state: string;
}
export interface BoundedRetry { gate: string; attempts: number }
export interface DispatchContext {
    /** Declared bounded retries of the scenario (a retry is allowed only after an observable failed attempt). */
    retries: readonly BoundedRetry[];
    /** The previous dispatch of the same command left an observable failed outcome (nonzero exit, or an interrupted attempt with output). */
    previousFailed: boolean;
}

const VOLATILE_FIELDS = new Set(['timestamp_utc', 'timestamp', 'generated_utc', 'recorded_at_utc', 'started_at_utc',
    'completed_at_utc', 'finished_at_utc', 'finished_at', 'approved_at_utc', 'operator_confirmed_at_utc',
    'review_restart_approved_at_utc', 'elapsed_ms', 'duration_ms', 'gate_pid', 'child_pid', 'owner_pid', 'execution_id']);
const VOLATILE_FLAGS = new Set(['--operator-confirmed-at-utc', '--review-restart-approved-at-utc', '--timestamp-utc', '--generated-utc']);
const ARTIFACT_HASH_FIELDS = {
    artifact_path: ['artifact_sha256', 'artifact_hash'],
    output_path: ['output_sha256'],
    restart_artifact_path: ['restart_artifact_sha256'],
    preflight_path: ['preflight_sha256'],
    compile_path: ['compile_sha256']
} as const;

export function normalizeDispatchedArgv(command: string): string[] {
    const argv = splitCommandLine(command);
    const normalized: string[] = [];
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        const equals = token.indexOf('=');
        const flag = equals < 0 ? token : token.slice(0, equals);
        normalized.push(flag === token || VOLATILE_FLAGS.has(flag) ? flag : token);
        if (VOLATILE_FLAGS.has(flag) && (equals >= 0 || argv[index + 1] && !argv[index + 1].startsWith('--'))) {
            normalized.push('<volatile>');
            if (equals < 0) index++;
        }
    }
    return normalized;
}

export function canonicalEvidenceText(value: unknown): string {
    const visit = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(visit);
        if (!isPlainRecord(node)) return node;
        return Object.fromEntries(Object.entries(node)
            .filter(([key]) => !VOLATILE_FIELDS.has(key)).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, visit(entry)]));
    };
    return JSON.stringify(visit(value));
}

function boundArtifact(root: string, reviews: string, candidate: string, sha256: string): unknown {
    const absolute = path.resolve(root, candidate);
    if (path.dirname(absolute) !== reviews) return 'outside reviews';
    try {
        if (!fs.lstatSync(absolute).isFile() || path.dirname(fs.realpathSync(absolute)) !== fs.realpathSync(reviews)) return 'unavailable';
        const bytes = fs.readFileSync(absolute);
        if (createHash('sha256').update(bytes).digest('hex') !== sha256) return 'digest mismatch';
        try { return JSON.parse(bytes.toString('utf8')) as unknown; }
        catch { return sha256; }
    } catch { return 'unavailable'; }
}

function currentEventFacts(events: readonly Readonly<Record<string, unknown>>[], root: string, reviews: string): unknown[] {
    const latest = new Map<string, Readonly<Record<string, unknown>>>();
    for (const event of events) {
        if (['TASK_MODE_ENTERED', 'TASK_RESET', 'TASK_DISCARDED'].includes(String(event.event_type))) latest.clear();
        const details = isPlainRecord(event.details) ? event.details : {};
        latest.set(JSON.stringify([event.event_type, details.review_type, details.stage, details.recipe_id]), event);
    }
    return [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, event]) => {
        const details = isPlainRecord(event.details) ? { ...event.details } : {};
        for (const [fileKey, hashKeys] of Object.entries(ARTIFACT_HASH_FIELDS)) {
            const file = details[fileKey];
            const hashKey = hashKeys.find(entry => typeof details[entry] === 'string');
            if (typeof file !== 'string' || !hashKey) continue;
            details[hashKey] = boundArtifact(root, reviews, file, String(details[hashKey]));
        }
        return [key, event.outcome, details];
    });
}

/** Observe only current facts from this task's authenticated timeline and its bound artifacts. */
export function semanticEvidenceState(root: string, taskId: string, workspaceSha256: string, bundle = 'garda-agent-orchestrator'): string {
    const runtime = path.join(root, bundle, 'runtime');
    const timeline = path.join(runtime, 'task-events', taskId + '.jsonl');
    const events: Readonly<Record<string, unknown>>[] = [];
    const inspection = inspectTaskEventFile(timeline, taskId, { onIntegrityEvent: event => { events.push(event); } });
    const facts = ['PASS', 'PASS_WITH_LEGACY_PREFIX'].includes(inspection.status)
        ? currentEventFacts(events, root, path.join(runtime, 'reviews')) : [];
    return createHash('sha256').update(canonicalEvidenceText([workspaceSha256, inspection.status, facts])).digest('hex');
}

export class WalkDispatchGuard {
    private readonly attempts = new Map<string, number>();

    /** Returns the violation text for a dispatch that repeats gate, argv and semantic state, or null. */
    observe(dispatch: DispatchedCommand, context: DispatchContext): string | null {
        const key = JSON.stringify([dispatch.taskId, dispatch.gate, dispatch.lane, normalizeDispatchedArgv(dispatch.command), dispatch.state]);
        const count = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, count);
        if (count === 1) return null;
        const declared = context.retries.find(entry => entry.gate === dispatch.gate)?.attempts ?? 0;
        if (count - 1 <= declared && context.previousFailed) return null;
        return 'Dispatch ' + count + ' of ' + dispatch.gate + (dispatch.lane ? '/' + dispatch.lane : '')
            + ' repeats the same argv at an unchanged semantic state' + (declared ? ' beyond its declared bounded retry' : '')
            + ': ' + dispatch.command.slice(0, 240);
    }
}
