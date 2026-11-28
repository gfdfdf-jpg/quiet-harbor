import { resolveReviewReuseClassificationConfig } from '../review-reuse/review-reuse';
import { isSafeOrdinaryDocumentationPath } from '../preflight/classify-change-doc-safety';
import type { ResolvedClassificationConfig } from '../preflight/classify-change-config';
import { createTaskTestScopeMatcher } from '../../core/file-role-bindings';
import { loadTaskFullSuiteConfig } from '../full-suite/task-full-suite-config';
import { isClassifiedProductCodePath, isClassifiedTestPath } from '../preflight/classify-change-scope-category';
import { normalizeGitChangeClassificationEvidence } from '../../core/git-change-classification';
import { readCurrentGitWorkspaceSnapshot } from '../scope/docs-only-delta-readiness';
import type { WorkspaceSnapshotRequest } from '../workspace/workspace-snapshot-cache';

/** Recovery can refresh before implementation only when every classified and live change is a known test. */
export function hasNonTestCoherentRecoveryChange(preflight: Record<string, unknown>, repoRoot: string,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest): boolean {
    const workspace = readCurrentGitWorkspaceSnapshot(repoRoot, true, workspaceSnapshotRequest);
    const liveChanges = normalizeGitChangeClassificationEvidence(workspace?.git_change_classification);
    const classifiedChanges = normalizeGitChangeClassificationEvidence(preflight.git_change_classification);
    if (!liveChanges || !Array.isArray(preflight.changed_files)
        || (preflight.git_change_classification != null && !classifiedChanges)) return true;
    const files = new Set<unknown>([
        ...preflight.changed_files, ...liveChanges.effective_changed_files
    ]);
    for (const change of [...liveChanges.file_classifications, ...classifiedChanges?.file_classifications ?? []]) {
        files.add(change.path);
        if (change.change_kind === 'renamed') files.add(change.previous_path);
    }
    const config = resolveReviewReuseClassificationConfig(preflight, repoRoot);
    return [...files].some(file => typeof file !== 'string' || !isClassifiedTestPath(file, config));
}

/** Test declarations never excuse changes the classifier recognizes as product code. */
export function isExpectedRedTestScope(preflight: Record<string, unknown>, repoRoot: string, taskId: string,
    capturedTargets: readonly string[] = []): boolean {
    if (preflight.scope_category === 'test-only' && !capturedTargets.length
        && !(Array.isArray(preflight.declared_test_paths) && preflight.declared_test_paths.length)) return true;
    const config = resolveReviewReuseClassificationConfig(preflight, repoRoot);
    const selection = loadTaskFullSuiteConfig(repoRoot, taskId).selection;
    const plan = selection.status === 'current' ? selection.plan : undefined;
    const declared = Array.isArray(preflight.declared_test_paths)
        ? preflight.declared_test_paths.filter((file): file is string => typeof file === 'string') : [];
    const support = plan?.support.map(item => item.path) ?? [];
    const isTest = createTaskTestScopeMatcher(config.test_trigger_regexes, config.file_roles,
        [...declared, ...capturedTargets, ...plan?.targets.map(item => item.path) ?? []], support);
    const inputs = new Set(support);
    const required = requiredExpectedRedFiles(preflight, repoRoot, config);
    return required.length > 0 && required.every(file => typeof file === 'string'
        && !isClassifiedProductCodePath(file, config) && (isTest(file) || inputs.has(file)));
}

/** Only classifier-ordinary documentation is exempt from changed-source RED coverage. */
export function requiredExpectedRedFiles(
    preflight: Record<string, unknown>, repoRoot: string,
    config: ResolvedClassificationConfig = resolveReviewReuseClassificationConfig(preflight, repoRoot)
): unknown[] {
    const declaredTests = new Set(Array.isArray(preflight.declared_test_paths) ? preflight.declared_test_paths : []);
    const changed = Array.isArray(preflight.changed_files) ? preflight.changed_files : [];
    return changed.filter(file => typeof file !== 'string' || declaredTests.has(file)
        || !isSafeOrdinaryDocumentationPath(file, config));
}
