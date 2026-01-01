import { normalizePath } from '../shared/helpers';
import { declaredFileRole, isTestScopePath, type FileRoleBindings } from '../../core/file-role-bindings';
import { DEFAULT_DEPENDENCY_TRIGGER_REGEXES } from '../../policy/default-path-regexes';

const FIXTURE_DATA_PATTERN = /(?:^|\/)(?:__fixtures__|fixtures?|testdata)\/|(?:^|\/)tests?\/(?:[^/]+\/)*?(?:data|resources)\//iu;
const DEPENDENCY_MANIFEST_PATTERNS = DEFAULT_DEPENDENCY_TRIGGER_REGEXES.map((pattern) => new RegExp(pattern, 'iu'));
const SOURCE_E2E_FOLDER = /(?:^|\/)(?:src|lib|app|internal|pkg|cmd|Sources|scripts|bin)\/(?:[^/]+\/)*e2e\//iu;
const DEFAULT_E2E_ROOT_PATTERN = '(^|/)e2e/';

export function isReviewRemediationFixtureDataPath(filePath: string): boolean {
    return FIXTURE_DATA_PATTERN.test(normalizePath(filePath));
}

export function isReviewRemediationDependencyManifestPath(filePath: string, fileRoles?: FileRoleBindings): boolean {
    const normalized = normalizePath(filePath);
    return declaredFileRole(normalized, fileRoles) !== 'test' && !isReviewRemediationFixtureDataPath(normalized)
        && DEPENDENCY_MANIFEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface ReviewRemediationScopeBoundary {
    fileRoles?: FileRoleBindings;
    status: 'OK' | 'BLOCKED';
    previousChangedFiles: string[];
    currentChangedFiles: string[];
    expandedFiles: string[];
    expandedNonTestFiles: string[];
    allowedTestOnlyExpansionFiles: string[];
    allowedDocumentExpansionFiles?: string[];
}

export function normalizeReviewRemediationChangedFiles(values: readonly unknown[]): string[] {
    return [...new Set(values.map((entry) => normalizePath(String(entry || '').trim())).filter(Boolean))].sort();
}

export function isTestLikeRemediationPath(relativePath: string, testTriggerRegexes: readonly string[], fileRoles?: FileRoleBindings): boolean {
    const normalized = normalizePath(relativePath);
    // The historical default matches every e2e directory, including production modules below a source root.
    // Real test roots, file names, explicit roles and additional project patterns still establish test scope.
    const patterns = SOURCE_E2E_FOLDER.test(normalized)
        ? testTriggerRegexes.filter((pattern) => pattern !== DEFAULT_E2E_ROOT_PATTERN) : testTriggerRegexes;
    return isTestScopePath(normalized, patterns, fileRoles)
        && !isReviewRemediationDependencyManifestPath(relativePath, fileRoles);
}

export function getTaskManualValidationBoundaryFiles(taskId: string, currentChangedFiles: readonly string[]): string[] {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
        return [];
    }
    const taskManualValidationPath = normalizePath(`garda-agent-orchestrator/runtime/manual-validation/${normalizedTaskId}`);
    const deployedTaskManualValidationPath = normalizePath(`runtime/manual-validation/${normalizedTaskId}`);
    return normalizeReviewRemediationChangedFiles(currentChangedFiles).filter((entry) => (
        entry === taskManualValidationPath
        || entry.startsWith(`${taskManualValidationPath}/`)
        || entry === deployedTaskManualValidationPath
        || entry.startsWith(`${deployedTaskManualValidationPath}/`)
    ));
}

export function assessReviewRemediationScopeBoundary(
    previousChangedFiles: readonly string[],
    currentChangedFiles: readonly string[],
    allowedBoundaryFiles: readonly string[] = [],
    testTriggerRegexes: readonly string[] = [],
    fileRoles?: FileRoleBindings,
    isOrdinaryDocument: (filePath: string) => boolean = () => false
): ReviewRemediationScopeBoundary {
    const previous = normalizeReviewRemediationChangedFiles(previousChangedFiles);
    const current = normalizeReviewRemediationChangedFiles(currentChangedFiles);
    const previousSet = new Set(previous);
    const allowedSet = new Set(normalizeReviewRemediationChangedFiles([...previous, ...allowedBoundaryFiles]));
    const expandedFiles = current.filter((entry) => !previousSet.has(entry));
    // A new document widens no review, so it needs no restart of the whole cycle.
    const unplannedFiles = current.filter((entry) => !allowedSet.has(entry));
    const allowedDocumentExpansionFiles = unplannedFiles.filter((entry) => isOrdinaryDocument(entry));
    const unplannedExpandedFiles = unplannedFiles.filter((entry) => !isOrdinaryDocument(entry));
    const expandedNonTestFiles = unplannedExpandedFiles.filter((entry) => !isTestLikeRemediationPath(entry, testTriggerRegexes, fileRoles));
    const allowedTestOnlyExpansionFiles = unplannedExpandedFiles.filter((entry) => isTestLikeRemediationPath(entry, testTriggerRegexes, fileRoles));
    return {
        ...(fileRoles ? { fileRoles } : {}),
        status: expandedNonTestFiles.length > 0 ? 'BLOCKED' : 'OK',
        previousChangedFiles: previous,
        currentChangedFiles: current,
        expandedFiles,
        expandedNonTestFiles,
        allowedTestOnlyExpansionFiles,
        allowedDocumentExpansionFiles
    };
}
