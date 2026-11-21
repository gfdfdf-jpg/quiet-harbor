import { appendMandatoryTaskEvent } from '../../gate-runtime/task-events';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isTaskQueueDoneStatus } from '../../core/active-task-state';
import { isPlainRecord } from '../../core/records';
import { readParentEvents, withParentAuditMutation } from './parent-audit-auth';
import { parentEventHash, readParentQueue } from './parent-audit-contract';
import { assertFullSuiteRepairParentWipPreserved } from './parent-audit-full-suite-wip';
import { inspectParentCompletion } from './parent-audit-state';

export function hasRestoredParentAcceptanceEvidence(root: string, taskId: string): boolean {
    const inspection = inspectParentCompletion(root, taskId);
    if (!inspection?.ready || !isTaskQueueDoneStatus(readParentQueue(root).entries.get(taskId)?.status ?? null)) return false;
    const events = readParentEvents(root, taskId);
    return assertFullSuiteRepairParentWipPreserved(root, inspection.contract, events)
        && events.some(event => Boolean(parentEventHash(event)) && event.event_type === 'DECOMPOSED_PARENT_COMPLETED'
            && event.outcome === 'INFO' && isPlainRecord(event.details)
            && event.details.reason === 'restored_full_suite_parent_accepted'
            && event.details.previous_status === 'DONE' && event.details.new_status === 'DONE'
            && event.details.contract_sha256 === inspection.contractSha256);
}

/** A restored repair parent completes its own implementation before SOURCE acceptance.
 * Publish aggregate acceptance separately; its earlier DONE row is not that proof. */
export function completeRestoredParentAcceptance(root: string, taskId: string): void {
    withParentAuditMutation(root, taskId, () => {
        const inspection = inspectParentCompletion(root, taskId);
        const events = readParentEvents(root, taskId);
        if (!inspection?.ready || !isTaskQueueDoneStatus(readParentQueue(root).entries.get(taskId)?.status ?? null)
            || !assertFullSuiteRepairParentWipPreserved(root, inspection.contract, events)) {
            throw new Error('Restored parent completion requires accepted native parent SOURCE, repair children, WIP and original validations.');
        }
        if (events.some(event => event.event_type === 'DECOMPOSED_PARENT_COMPLETED')) return;
        appendMandatoryTaskEvent(joinOrchestratorPath(root, ''), taskId, 'DECOMPOSED_PARENT_COMPLETED', 'INFO',
            'Restored full-suite parent and its repair children have native SOURCE and accepted parent obligations.',
            { previous_status: 'DONE', new_status: 'DONE', reason: 'restored_full_suite_parent_accepted',
                contract_sha256: inspection.contractSha256 }, { actor: 'orchestrator' });
    });
}
