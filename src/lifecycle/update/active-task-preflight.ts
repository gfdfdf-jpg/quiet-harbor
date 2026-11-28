import * as path from 'node:path';
import { quoteCommandValue } from '../../core/command-quoting';
import { resolveBundleNameForTarget } from '../../core/constants';
import { resolveActiveTaskIds } from '../../core/active-task-state';
import { buildTaskResetEnablementCommand } from '../../core/task-reset-availability';

export function assertNoActiveTasksBeforeUpdateApply(
    targetRoot: string,
    deployedBundleRoot = path.join(targetRoot, resolveBundleNameForTarget(targetRoot))
): void {
    const discoveryErrors: string[] = [];
    const activeTaskIds = resolveActiveTaskIds(targetRoot, deployedBundleRoot, undefined, {
        respectTerminalQueueStatus: true,
        onDiscoveryError(error) {
            discoveryErrors.push(error instanceof Error ? error.message : String(error));
        }
    });
    const cliPath = path.resolve(deployedBundleRoot, 'bin', 'garda.js').split(path.sep).join('/');
    const cliPrefix = 'node ' + quoteCommandValue(cliPath);
    const finishTasks = [...activeTaskIds].sort().map(taskId =>
        `Finish task ${taskId} (or bring it to DONE / a terminal state) on the current Garda version, then run update again. `
        + `To stop the attempt from the project root, run ${cliPrefix} gate task-reset --task-id ${quoteCommandValue(taskId)} --reopen --confirm --repo-root "."`).join(' ');
    if (discoveryErrors.length > 0) {
        throw new Error('Active task discovery is unknown, so update is refused. '
            + discoveryErrors.join(' ') + ' '
            + 'Restore readable, project-local task state. '
            + (finishTasks || 'Finish any active tasks on the current Garda version, then run update again.'));
    }
    if (finishTasks) {
        throw new Error('Update refused because the project has active tasks. '
            + `From the project root, if reset is disabled, approve and run ${buildTaskResetEnablementCommand(cliPrefix)} with the UTC timestamp of approval. `
            + finishTasks);
    }
}
