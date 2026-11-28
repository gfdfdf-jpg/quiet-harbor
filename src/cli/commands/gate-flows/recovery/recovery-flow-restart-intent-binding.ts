import * as path from 'node:path';

import { collectOrderedTimelineEvents, findLatestTimelineEvent } from '../../../../gates/completion/completion-evidence';
import { readLostPreflightSnapshot } from '../../../../gates/preflight/preflight-restoration';
import { resolvePreflightTaskIntent } from '../../../../gates/review-context/review-context-task-criteria-binding';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';
import { buildNextStepRecoveryCommand } from '../compile/compile-flow-shared-evidence';

/**
 * A restart takes its intent from the preflight artifact. The last authenticated PREFLIGHT_CLASSIFIED event records
 * the wording that classification used, so a preflight replaced by an older copy of the same task cannot lend the
 * restart a stale intent (and with it the lanes that intent no longer enables). Returns the refusal, or null.
 */
export function readRestartPreflightIntentViolation(input: {
    repoRoot: string;
    taskId: string;
    preflight: Record<string, unknown>;
    preflightPath?: string;
}): string | null {
    const errors: string[] = [];
    const events = collectOrderedTimelineEvents(path.join(
        resolveOrchestratorRoot(input.repoRoot), 'runtime', 'task-events', `${input.taskId}.jsonl`
    ), errors);
    const classified = errors.length === 0
        ? findLatestTimelineEvent(events, (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED')
        : null;
    if (!classified) return null;
    // The classified bytes cover every field, including an absent intent. readLostPreflightSnapshot is non-null only
    // when the current bytes differ from the latest authenticated output_sha256 and retained evidence lets next-step
    // restore them, so this refusal always leads to a recovery.
    if (input.preflightPath && readLostPreflightSnapshot(input.repoRoot, input.taskId, path.resolve(input.repoRoot, input.preflightPath))) {
        return `The preflight artifact bytes differ from the last classified ones `
            + `(PREFLIGHT_CLASSIFIED seq ${classified.sequence}); it may have been replaced by an older copy. `
            + `Run ${buildNextStepRecoveryCommand(input.repoRoot, input.taskId)} to restore the classified preflight.`;
    }
    const recordedIntent = resolvePreflightTaskIntent((classified.details ?? null) as Record<string, unknown> | null);
    const preflightIntent = resolvePreflightTaskIntent(input.preflight);
    if (!recordedIntent.trim() || !preflightIntent.trim() || recordedIntent === preflightIntent) return null;
    return `The preflight artifact carries a task intent that differs from the last classified one `
        + `(PREFLIGHT_CLASSIFIED seq ${classified.sequence}); it may have been replaced by an older copy. `
        + `Run ${buildNextStepRecoveryCommand(input.repoRoot, input.taskId)} for the current recovery route.`;
}
