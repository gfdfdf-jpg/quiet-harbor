import { stringSha256 } from '../../gate-runtime/hash';
import { appendMandatoryTaskEvent, inspectTaskEventFile } from '../../gate-runtime/task-events';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { parseOperatorConfirmationYes, validateFreshOperatorConfirmation } from '../../core/operator-confirmation';

export interface OperatorTaskIntent {
    task_intent: string;
    task_intent_sha256: string;
    event_sha256: string;
}

export function normalizeTaskCriteriaText(value: unknown): string {
    return String(value ?? '').replace(/\r\n?/gu, '\n').replace(/[\t ]+$/gmu, '');
}

export function taskIntentSha256(taskId: string, intent: string): string {
    return stringSha256(JSON.stringify([taskId, normalizeTaskCriteriaText(intent)]))!;
}

export function prepareOperatorTaskIntentUpdate(options: {
    repoRoot: string; taskId: string; previousIntent: string; taskIntent: string; operatorConfirmed?: unknown; operatorConfirmedAtUtc?: unknown;
}) {
    if (!String(options.operatorConfirmed || '').trim()) return null;
    const previousCriteriaIntent = readOperatorTaskIntent(options.repoRoot, options.taskId)?.task_intent ?? '';
    if (taskIntentSha256(options.taskId, previousCriteriaIntent) === taskIntentSha256(options.taskId, options.taskIntent)) return null;
    validateFreshOperatorConfirmation({
        actionLabel: 'Changing task intent criteria',
        confirmed: parseOperatorConfirmationYes(options.operatorConfirmed),
        confirmedAtUtc: String(options.operatorConfirmedAtUtc || '').trim(),
        instruction: 'Use the operator-confirmed path to change task criteria.'
    });
    return {
        task_id: options.taskId,
        previous_task_intent: normalizeTaskCriteriaText(previousCriteriaIntent),
        previous_task_intent_sha256: taskIntentSha256(options.taskId, previousCriteriaIntent),
        task_intent: normalizeTaskCriteriaText(options.taskIntent),
        task_intent_sha256: taskIntentSha256(options.taskId, options.taskIntent),
        operator_confirmed: true,
        operator_confirmed_at_utc: String(options.operatorConfirmedAtUtc || '').trim() || null
    };
}

/** Called only by a confirmed intent-changing path, before classification or review context construction. */
export function recordOperatorTaskIntentUpdate(repoRoot: string, update: NonNullable<ReturnType<typeof prepareOperatorTaskIntentUpdate>>): void {
    appendMandatoryTaskEvent(joinOrchestratorPath(repoRoot, ''), update.task_id, 'TASK_INTENT_UPDATED', 'PASS',
        'Operator changed the task intent criteria; every mandatory review repeats in FULL.', update, { actor: 'orchestrator' });
}

/** A later agent description cannot replace the last authenticated operator requirement. */
export function readOperatorTaskIntent(repoRoot: string, taskId: string): OperatorTaskIntent | null {
    if (!taskId) return null;
    let latest: OperatorTaskIntent | null = null;
    const inspection = inspectTaskEventFile(joinOrchestratorPath(repoRoot, `runtime/task-events/${taskId}.jsonl`), taskId, {
        onIntegrityEvent: event => {
            if (event.event_type !== 'TASK_INTENT_UPDATED' || event.actor !== 'orchestrator' || event.outcome !== 'PASS') return;
            const details = event.details as Record<string, unknown> | null;
            const integrity = event.integrity as Record<string, unknown> | null;
            if (!details || details.task_id !== taskId || details.operator_confirmed !== true
                || typeof details.task_intent !== 'string' || !details.task_intent.trim()
                || details.task_intent_sha256 !== taskIntentSha256(taskId, details.task_intent)
                || !/^[a-f0-9]{64}$/u.test(String(integrity?.event_sha256 || ''))) {
                throw new Error('Operator task intent evidence is invalid.');
            }
            latest = { task_intent: details.task_intent, task_intent_sha256: details.task_intent_sha256 as string,
                event_sha256: integrity!.event_sha256 as string };
        }
    });
    if (!['PASS', 'PASS_WITH_LEGACY_PREFIX', 'MISSING', 'EMPTY', 'LEGACY_ONLY'].includes(inspection.status)) {
        throw new Error('Operator task intent history cannot be authenticated; reviewing task criteria requires an intact task event history.');
    }
    return latest;
}
