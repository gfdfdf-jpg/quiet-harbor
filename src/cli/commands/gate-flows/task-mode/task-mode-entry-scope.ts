import { assertNoInstalledBundleScope } from '../../../../gates/protected-control-plane/installed-bundle-guard';
import {
    normalizePlannedChangedFiles,
    selectProtectedControlPlaneScope
} from '../../../../gates/task-mode/task-mode-plan-protection';

export { normalizePlannedChangedFiles };

export interface TaskModeEntryScope {
    plannedChangedFiles: string[];
    protectedPlannedFiles: string[];
    workflowConfigPlannedFiles: string[];
}

export function resolveTaskModeEntryScope(repoRoot: string, rawPlannedChangedFiles: unknown): TaskModeEntryScope {
    const plannedChangedFiles = normalizePlannedChangedFiles(repoRoot, rawPlannedChangedFiles);
    assertNoInstalledBundleScope(repoRoot, plannedChangedFiles);
    const {
        protectedFiles: protectedPlannedFiles,
        workflowConfigFiles: workflowConfigPlannedFiles
    } = selectProtectedControlPlaneScope(repoRoot, plannedChangedFiles);
    return {
        plannedChangedFiles,
        protectedPlannedFiles,
        workflowConfigPlannedFiles
    };
}
