import { resolveReviewReuseClassificationConfig } from '../review-reuse/review-reuse';
import { isSafeOrdinaryDocumentationPath } from '../preflight/classify-change-doc-safety';
import type { ResolvedClassificationConfig } from '../preflight/classify-change-config';
import { createTaskTestScopeMatcher } from '../../core/file-role-bindings';
import { loadTaskFullSuiteConfig } from '../full-suite/task-full-suite-config';
import { isClassifiedProductCodePath } from '../preflight/classify-change-scope-category';

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
