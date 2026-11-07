import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCanonicalActiveTaskQueue } from '../../core/task-md-table';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import { withLifecycleRuntimeMutationGeneration } from '../../lifecycle/runtime-mutation-generation';
import { joinOrchestratorPath, resolvePathInsideRepo } from '../shared/helpers';

/** Task-owned copies can be discarded independently, even when their bytes are identical. */
export function resolveTaskReviewCopyDirectories(repoRoot: string, taskId: string): string[] {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId) || taskId.length > 128) return [];
    return ['.reviewer-output-cache', '.review-context-cache']
        .map(name => joinOrchestratorPath(repoRoot, path.join('runtime', 'tmp', name, taskId)));
}

export function removeTaskReviewCopies(options: { repoRoot: string; taskId: string; removeLegacy?: boolean }): void {
    const directories = resolveTaskReviewCopyDirectories(options.repoRoot, options.taskId);
    if (!directories.some(directory => fs.existsSync(path.dirname(directory)))) return;
    withLifecycleRuntimeMutationGeneration(joinOrchestratorPath(options.repoRoot, ''), 'review-copy-cleanup', () => {
        for (const directory of directories) {
            if (!resolvePathInsideRepo(directory, options.repoRoot, { allowMissing: true, enforceInside: true })) continue;
            // Do not traverse a redirected cache parent, including links that remain inside the repository.
            const parent = path.dirname(directory);
            if (!fs.existsSync(parent)) continue;
            const actual = fs.realpathSync(parent);
            const expected = path.resolve(parent);
            if ((process.platform === 'win32' ? actual.toLowerCase() : actual)
                !== (process.platform === 'win32' ? expected.toLowerCase() : expected)) continue;
            fs.rmSync(directory, { recursive: true, force: true });
        }
        if (options.removeLegacy !== false) removeUnreferencedLegacyReviewCopies(options);
    });
}

/** Older shared copies may be needed by any open task. Treat ambiguous history as open. */
function hasOtherOpenTask(repoRoot: string, taskId: string): boolean {
    try {
        const queue = parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'));
        if (!queue.found || queue.diagnostics?.length) return true;
        if (queue.rows.some(row => row.taskId !== taskId
            && ['IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'].includes(readTaskQueueStatusToken(row.status) || ''))) return true;
        const eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
        const actualRoot = fs.realpathSync(eventsRoot), expectedRoot = path.resolve(eventsRoot);
        if ((process.platform === 'win32' ? actualRoot.toLowerCase() : actualRoot)
            !== (process.platform === 'win32' ? expectedRoot.toLowerCase() : expectedRoot)) return true;
        for (const entry of fs.readdirSync(eventsRoot, { withFileTypes: true })) {
            const name = entry.name;
            if (!name.endsWith('.jsonl') || name === 'all-tasks.jsonl' || name === `${taskId}.jsonl`) continue;
            if (!entry.isFile() || entry.isSymbolicLink()) return true;
            const otherTaskId = name.slice(0, -6);
            let open = true;
            const report = inspectTaskEventFile(path.join(eventsRoot, name), otherTaskId, { onIntegrityEvent: event => {
                if (['TASK_MODE_ENTERED', 'REVIEW_CYCLE_RESTARTED', 'COHERENT_CYCLE_RESTARTED',
                    'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'IMPLEMENTATION_STARTED', 'REVIEW_PHASE_STARTED',
                    'REVIEWER_DELEGATION_ROUTED', 'REVIEWER_LAUNCH_PREPARED', 'REVIEWER_DELEGATION_STARTED',
                    'REVIEW_RECORDED'].includes(String(event.event_type))) open = true;
                if (['TASK_RESET', 'TASK_DISCARDED', 'COMPLETION_GATE_PASSED'].includes(String(event.event_type))
                    && event.outcome === 'PASS') open = false;
            } });
            if (!report.status.startsWith('PASS') || report.violations.length || open) return true;
        }
        return false;
    } catch { return true; }
}

function removeUnreferencedLegacyReviewCopies(options: { repoRoot: string; taskId: string }): void {
    if (hasOtherOpenTask(options.repoRoot, options.taskId)) return;
    for (const name of ['.reviewer-output-cache', '.review-context-cache']) {
        const root = joinOrchestratorPath(options.repoRoot, path.join('runtime', 'tmp', name));
        if (!resolvePathInsideRepo(root, options.repoRoot, { allowMissing: true, enforceInside: true })
            || !fs.existsSync(root)) continue;
        const actual = fs.realpathSync(root), expected = path.resolve(root);
        if ((process.platform === 'win32' ? actual.toLowerCase() : actual)
            !== (process.platform === 'win32' ? expected.toLowerCase() : expected)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.isFile() && /^[0-9a-f]{64}$/u.test(entry.name)) fs.rmSync(path.join(root, entry.name));
        }
        try { fs.rmdirSync(root); } catch (error: unknown) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
        }
    }
}
