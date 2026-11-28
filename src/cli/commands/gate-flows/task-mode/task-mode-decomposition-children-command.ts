import * as path from 'node:path';

import { materializeDecompositionChildren } from '../../../../gates/task-mode/decomposition-children-materialization';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import { buildGateCommandPrefix } from './task-mode-command-format';

export interface MaterializeDecompositionChildrenCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    workPackageContractPath?: unknown;
}

export function runMaterializeDecompositionChildrenCommand(
    options: MaterializeDecompositionChildrenCommandOptions
): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const result = materializeDecompositionChildren({
        repoRoot,
        taskId: options.taskId,
        workPackageContractPath: options.workPackageContractPath,
        cliPrefix: buildGateCommandPrefix(repoRoot)
    });
    return { outputLines: result.outputLines, exitCode: result.status === 'BLOCKED' ? EXIT_GATE_FAILURE : 0 };
}
