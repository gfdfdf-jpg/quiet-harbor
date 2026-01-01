import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathRealpathInsideRoot, joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isCanonicalTaskId } from '../../core/task-ids';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { parseOptions } from './cli-parsing';

type OptionDefinitions = Parameters<typeof parseOptions>[1];
type ParseConfig = NonNullable<Parameters<typeof parseOptions>[2]> & {
    allowResetPreflight?: boolean;
    defaultPreflightForTask?: boolean;
};

export class MissingPreflightError extends Error {
    constructor(
        readonly repoRoot: string,
        readonly taskId: string | null,
        readonly preflightPath: string,
        readonly removedByReset: boolean
    ) {
        super('The preflight is missing.');
        this.name = 'MissingPreflightError';
    }
}

export class InvalidPreflightError extends Error {
    constructor(
        readonly repoRoot: string,
        readonly taskId: string | null,
        readonly preflightPath: string,
        readonly reason: string
    ) {
        super('The preflight is corrupt.');
        this.name = 'InvalidPreflightError';
    }
}

function samePath(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** A reset deletes the task timeline; any new entry or classification supersedes its report. */
function resetStillExplainsMissingPreflight(repoRoot: string, taskId: string): boolean {
    // If the timeline itself was lost after re-entry, the current task-mode artifact is
    // still enough to avoid attributing a missing preflight to the older reset.
    if (fs.existsSync(joinOrchestratorPath(repoRoot, `runtime/reviews/${taskId}-task-mode.json`))) return false;
    const eventsPath = joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`);
    if (!isPathRealpathInsideRoot(eventsPath, repoRoot, { allowMissing: true })) return false;
    let superseded = false;
    const inspection = inspectTaskEventFile(eventsPath, taskId, {
        onIntegrityEvent: event => {
            if (event.event_type === 'TASK_MODE_ENTERED' || event.event_type === 'PREFLIGHT_CLASSIFIED') superseded = true;
        }
    });
    // Missing is the normal state immediately after reset. Do not infer anything from
    // an unreadable, legacy, or otherwise unauthenticated timeline.
    return inspection.status === 'MISSING' || (inspection.status === 'PASS' && !superseded);
}

/** Claim a reset only when its report and the current task history support it. */
function findUnavailablePreflight(
    options: ReturnType<typeof parseOptions>['options'], defaultPreflightForTask: boolean
): MissingPreflightError | InvalidPreflightError | null {
    const explicitInput = typeof options.preflightPath === 'string' ? options.preflightPath.trim() : '';
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const explicitTaskId = String(options.taskId || '').trim();
    if (explicitTaskId && !isCanonicalTaskId(explicitTaskId)) return null;
    const input = explicitInput || (defaultPreflightForTask && explicitTaskId
        ? joinOrchestratorPath(repoRoot, `runtime/reviews/${explicitTaskId}-preflight.json`) : '');
    if (!input) return null;
    const preflightPath = path.resolve(repoRoot, input);
    const basename = path.basename(preflightPath);
    const inferredTaskId = basename.endsWith('-preflight.json') ? basename.slice(0, -'-preflight.json'.length) : '';
    const candidate = explicitTaskId || inferredTaskId;
    const taskId = isCanonicalTaskId(candidate) ? candidate : null;
    if (fs.existsSync(preflightPath)) {
        // Leave containment and non-file errors to the normal gate validation. Never
        // read a path outside the repository merely to improve a refusal message.
        if (!isPathRealpathInsideRoot(preflightPath, repoRoot) || !fs.statSync(preflightPath).isFile()) return null;
        let contents: string;
        try { contents = fs.readFileSync(preflightPath, 'utf8'); } catch { return null; }
        try {
            const value: unknown = JSON.parse(contents);
            if (value && typeof value === 'object' && !Array.isArray(value)) return null;
            return new InvalidPreflightError(repoRoot, taskId, preflightPath, 'not a JSON object (corrupt)');
        } catch {
            return new InvalidPreflightError(repoRoot, taskId, preflightPath, 'corrupt (invalid JSON)');
        }
    }
    // Keep each gate's existing missing-default behavior; this adds only the
    // malformed-default refusal when a gate actually reads that default.
    if (!explicitInput) return null;
    const missing = () => new MissingPreflightError(repoRoot, taskId, preflightPath, false);
    if (!taskId || !samePath(path.join(path.dirname(preflightPath), `${taskId}-preflight.json`), preflightPath)) return missing();
    const reportPath = path.join(path.dirname(preflightPath), `${taskId}-reset-report.json`);
    try {
        if (!isPathRealpathInsideRoot(reportPath, repoRoot)) return missing();
        const report: unknown = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        if (!report || typeof report !== 'object' || Array.isArray(report)) return missing();
        const record = report as Record<string, unknown>;
        if (record.event_source !== 'task-reset' || record.task_id !== taskId || !Array.isArray(record.removed_artifacts)) return missing();
        if (!record.removed_artifacts.some(value => typeof value === 'string' && samePath(path.resolve(repoRoot, value), preflightPath))) return missing();
        if (!resetStillExplainsMissingPreflight(repoRoot, taskId)) return missing();
        return new MissingPreflightError(repoRoot, taskId, preflightPath, true);
    } catch {
        return missing();
    }
}

/** Review launch gates resolve this path internally and do not expose --preflight-path. */
export function findInvalidDefaultPreflight(repoRoot: string, taskId: string): InvalidPreflightError | null {
    const unavailable = findUnavailablePreflight({ repoRoot, taskId }, true);
    return unavailable instanceof InvalidPreflightError ? unavailable : null;
}

/** Validate the normal CLI syntax and containment before checking reset evidence. */
export function parseGateOptions(argv: string[], definitions: OptionDefinitions, config?: ParseConfig): ReturnType<typeof parseOptions> {
    const parsed = parseOptions(argv, definitions, config);
    if (definitions['--preflight-path'] && !config?.allowResetPreflight) {
        const unavailable = findUnavailablePreflight(parsed.options, config?.defaultPreflightForTask === true);
        if (unavailable) throw unavailable;
    }
    return parsed;
}
