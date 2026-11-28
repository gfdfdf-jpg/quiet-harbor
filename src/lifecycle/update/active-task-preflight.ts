import * as path from 'node:path';
import { quoteCommandValue } from '../../core/command-quoting';
import { resolveBundleNameForTarget } from '../../core/constants';
import { buildTaskResetEnablementCommand } from '../../core/task-reset-availability';
import {
    describeIncompleteActiveTaskDiscovery,
    resolveActiveTaskDiscovery
} from '../../core/task-queue/active-task-state';

export function assertNoActiveTasksBeforeUpdateApply(
    targetRoot: string,
    deployedBundleRoot = path.join(targetRoot, resolveBundleNameForTarget(targetRoot))
): void {
    const discovery = resolveActiveTaskDiscovery(targetRoot, deployedBundleRoot, undefined, { respectTerminalQueueStatus: true });
    const incomplete = describeIncompleteActiveTaskDiscovery(discovery, 'update');
    const cliPath = path.resolve(deployedBundleRoot, 'bin', 'garda.js').replace(/\\/gu, '/');
    const cliPrefix = `node ${quoteCommandValue(cliPath)}`;
    const finishTasks = [...discovery.activeTaskIds].sort().map(taskId =>
        `Finish task ${taskId} (or bring it to DONE / a terminal state) on the current Garda version, then run update again. `
        + `To stop the attempt from the project root, run ${cliPrefix} gate task-reset --task-id "${taskId}" --reopen --confirm --repo-root "."`).join(' ');
    if (incomplete) {
        throw new Error(incomplete
            + '. Restore readable, project-local task state at the paths identified above and check for active tasks on the current Garda version. '
            + (finishTasks || 'Then run update again.'));
    }
    if (finishTasks) {
        throw new Error('Update refused because the project has active tasks. '
            + `From the project root, if reset is disabled, approve and run ${buildTaskResetEnablementCommand(cliPrefix)} with the UTC timestamp of approval. `
            + finishTasks);
    }
}
