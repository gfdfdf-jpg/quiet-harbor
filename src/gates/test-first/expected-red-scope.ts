import { resolveReviewReuseClassificationConfig } from '../review-reuse/review-reuse';
import { isSafeOrdinaryDocumentationPath } from '../preflight/classify-change-doc-safety';
import type { ResolvedClassificationConfig } from '../preflight/classify-change-config';
import { createTaskTestScopeMatcher, declaredFileRole, isTestScopePath } from '../../core/file-role-bindings';
import { matchAnyRegex } from '../../gate-runtime/text-utils';
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

// Conservative coverage only: these names never establish a runner, invocation or assertion result.
const CONVENTIONAL_TEST_SOURCE_NAME = /(?:^|[._-])(?:[Tt]ests?|[Ss]pecs?)(?:[._-]|$)|(?:Test|Tests|Spec|Specs)\.[^/.]+$|^Test[^/]*\.java$/u;

/** Frozen classification identifies support inputs, never a runnable command or case. */
function isTestSupport(file: string, preflight: Record<string, unknown>, config: ResolvedClassificationConfig): boolean {
    if (declaredFileRole(file, config.file_roles) || (Array.isArray(preflight.declared_test_paths)
        && preflight.declared_test_paths.includes(file))) return false;
    const normalized = file.replace(/\\/gu, '/');
    const name = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (!isTestScopePath(normalized, config.test_trigger_regexes, config.file_roles)
        || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/iu.test(normalized)
        || CONVENTIONAL_TEST_SOURCE_NAME.test(name)) return false;
    return matchAnyRegex(normalized, config.test_refactor_structural_trigger_regexes,
        { skipInvalidRegex: true, caseInsensitive: true });
}

/**
 * Includes support and docs for byte binding, while production implementation may evolve after RED.
 * With a task id, the task test plan's declared targets and support inputs are bound too. A caller that holds
 * the authenticated declaration in effect when RED was recorded passes its plan, so the binding names exactly
 * the inputs the task test scope classified then; otherwise the current selection's plan applies.
 */
export function expectedRedInputFiles(preflight: Record<string, unknown>, repoRoot: string, taskId?: string,
    redPlan?: { targets: readonly string[]; support: readonly string[] } | null): string[] {
    const config = resolveReviewReuseClassificationConfig(preflight, repoRoot);
    let isTaskTestInput = (_file: string): boolean => false;
    if (taskId) {
        let plan = redPlan ?? undefined;
        if (!plan) {
            const selection = loadTaskFullSuiteConfig(repoRoot, taskId).selection;
            const current = selection.status === 'current' ? selection.plan : undefined;
            plan = current ? { targets: current.targets.map(item => item.path), support: current.support.map(item => item.path) } : undefined;
        }
        const declared = Array.isArray(preflight.declared_test_paths)
            ? preflight.declared_test_paths.filter((file): file is string => typeof file === 'string') : [];
        const support = [...plan?.support ?? []];
        const isTest = createTaskTestScopeMatcher(config.test_trigger_regexes, config.file_roles,
            [...declared, ...plan?.targets ?? []], support);
        const inputs = new Set(support);
        isTaskTestInput = file => isTest(file) || inputs.has(file);
    }
    return (Array.isArray(preflight.changed_files) ? preflight.changed_files : []).filter((file): file is string =>
        typeof file === 'string' && (isTestScopePath(file, config.test_trigger_regexes, config.file_roles)
            || isTaskTestInput(file) || isSafeOrdinaryDocumentationPath(file, config)));
}

/** Support inputs are covered by their using tests; their bytes remain part of the RED scope binding. */
export function requiredExpectedRedFiles(
    preflight: Record<string, unknown>, repoRoot: string,
    config: ResolvedClassificationConfig = resolveReviewReuseClassificationConfig(preflight, repoRoot)
): unknown[] {
    const declaredTests = new Set(Array.isArray(preflight.declared_test_paths) ? preflight.declared_test_paths : []);
    const changed = Array.isArray(preflight.changed_files) ? preflight.changed_files : [];
    return changed.filter(file => typeof file !== 'string' || declaredTests.has(file)
        || !isSafeOrdinaryDocumentationPath(file, config) && !isTestSupport(file, preflight, config));
}
