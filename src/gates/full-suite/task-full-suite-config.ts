import * as path from 'node:path';
import { resolveWorkflowConfigPath } from '../../core/full-suite-validation-config';
import { loadFullSuiteValidationConfig, type FullSuiteValidationConfig } from '../../core/full-suite-validation-config';
import { readDeclaredTaskTestSelection, readReviewedTaskTestSelection, readTaskTestSelection, type CurrentTaskTestSelection } from '../../cli/commands/workflow/workflow-command-task-test-selection';

export function loadDeclaredTaskTestPaths(repoRoot: string, taskId: string): string[] {
    return loadDeclaredTaskTestSelection(repoRoot, taskId)?.targets.map(target => target.path) ?? [];
}

export function loadDeclaredTaskTestSelection(repoRoot: string, taskId: string) {
    const configPath = resolveWorkflowConfigPath(repoRoot);
    return readDeclaredTaskTestSelection({ targetRoot: repoRoot, configPath,
        bundleRoot: path.dirname(path.dirname(path.dirname(configPath))),
        optionalSkillSelectionPolicyPath: path.join(path.dirname(configPath), 'optional-skill-selection-policy.json') }, taskId);
}

export function loadTaskFullSuiteConfig(repoRoot: string, taskId: string | null | undefined,
    reviewedPreflightSha256?: string | null): {
    config: FullSuiteValidationConfig; selection: CurrentTaskTestSelection;
} {
    const config = loadFullSuiteValidationConfig(repoRoot);
    const configPath = resolveWorkflowConfigPath(repoRoot);
    const bundleRoot = path.dirname(path.dirname(path.dirname(configPath)));
    const roots = { targetRoot: repoRoot, bundleRoot,
        configPath,
        optionalSkillSelectionPolicyPath: path.join(bundleRoot, 'live/config/optional-skill-selection-policy.json') };
    // Existing review contexts already name their authenticated preflight. Their retained selection
    // needs its task/HEAD/hash binding, not another current-worktree scope calculation.
    const selection = (reviewedPreflightSha256 ? readReviewedTaskTestSelection(roots, taskId || '', reviewedPreflightSha256) : null)
        ?? readTaskTestSelection(roots, taskId || '');
    const reviewed = selection.reviewedPreflight;
    if (selection.status === 'stale' && reviewedPreflightSha256 && reviewed?.sha256 === reviewedPreflightSha256) {
        return { config: { ...config, command: reviewed.command },
            selection: { status: 'current', command: reviewed.command, targets: [...reviewed.targets], ...(reviewed.plan ? { plan: reviewed.plan } : {}),
                ...(reviewed.legacyPlan ? { legacyPlan: reviewed.legacyPlan } : {}) } };
    }
    return { config: selection.status === 'current' && selection.command
        ? { ...config, command: selection.command } : config, selection };
}

export const STALE_TASK_TEST_SELECTION = 'The task-scoped test selection is no longer current. Select the current task tests again through the audited workflow test-selection route.';
export const MISSING_TASK_TEST_SELECTION = 'Select tests for this task before full-suite validation through the audited workflow test-selection route.';
