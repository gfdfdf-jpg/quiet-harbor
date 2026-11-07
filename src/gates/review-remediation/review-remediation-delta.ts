import { countNextStepWork } from '../../core/next-step-measurement';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { declaredFileRole, type FileRoleBindings } from '../../core/file-role-bindings';

import { sha256RedactedJsonPayload } from '../../core/redaction';
import {
    CODE_EXTENSION_GROUP,
    DEFAULT_INFRA_TRIGGER_REGEXES,
    DEFAULT_RUNTIME_ROOTS,
    DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES,
    FEATURE_TEST_NAME_COLLISION_REGEX
} from '../../policy/default-path-regexes';
import { isDocumentationLikePath, isProjectInstructionPath } from '../preflight/classify-change-doc-safety';
import { fileSha256 } from '../../gate-runtime/hash';
import { readReviewTaskCard } from '../review-context/review-context-task-card';
import { resolveFailedReviewTaskCriteriaChange } from './review-remediation-task-criteria';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../policy/review-trigger-policy';
import type { ReviewRemediationDeltaCategory } from '../../policy/review-remediation-rerun-policy';
import {
    evaluateReviewRemediationMode,
    collectReviewRemediationProtectedBoundarySignals,
    PROTECTED_BOUNDARY_SIGNAL_OWNERS,
    type ReviewRemediationModeAssessment,
    type ReviewRemediationModePolicy,
    type ReviewRemediationProtectedBoundarySignal
} from '../../policy/review-remediation-mode-policy';
import { normalizePath } from '../shared/helpers';
import { isReviewRemediationDependencyManifestPath, isReviewRemediationFixtureDataPath, isTestLikeRemediationPath } from './review-remediation-scope-boundary';
import { buildReviewRemediationFindingScope } from './review-remediation-finding-scope';
import {
    buildReviewRemediationDeltaBase,
    getReviewRemediationDeltaBaseViolations,
    REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES,
    type ReviewRemediationDeltaBaseEntry
} from './review-remediation-delta-contract';
import {
    buildReviewRemediationLineDelta,
    buildReviewRemediationReadableDiffEvidence,
    collectReviewRemediationChangedLineEvidence,
    getLcsLength,
    REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS,
    type ReviewRemediationLineComparisonBudget,
    type ReviewRemediationReadableDiffEvidence,
    type ReviewRemediationReadableDiffLine
} from './review-remediation-readable-diff';
import {
    validateReviewRemediationBaselineArtifact,
    type ReviewRemediationBaselineArtifact
} from './review-remediation-baseline';

export const REVIEW_REMEDIATION_DELTA_SCHEMA_VERSION = 1;
export {
    REVIEW_REMEDIATION_DELTA_DIFF_PAGE_MAX_BYTES,
    REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS
} from './review-remediation-readable-diff';
export type {
    ReviewRemediationReadableDiffEvidence,
    ReviewRemediationReadableDiffLine,
    ReviewRemediationReadableDiffOperation,
    ReviewRemediationReadableDiffPage
} from './review-remediation-readable-diff';

export type { ReviewRemediationDeltaCategory } from '../../policy/review-remediation-rerun-policy';

export type ReviewRemediationDeltaOperation = 'added' | 'deleted' | 'modified' | 'type_changed';

export interface ReviewRemediationFileDelta {
    path: string;
    operation: ReviewRemediationDeltaOperation;
    category: ReviewRemediationDeltaCategory;
    reason: string;
    baseline_status: ReviewRemediationDeltaBaseEntry['status'];
    current_status: ReviewRemediationDeltaBaseEntry['status'];
    baseline_mode: number | null;
    current_mode: number | null;
    baseline_content_sha256: string | null;
    current_content_sha256: string | null;
    baseline_line_count: number | null;
    current_line_count: number | null;
    additions: number | null;
    deletions: number | null;
    changed_lines: number | null;
}

export interface ReviewRemediationDeltaScope {
    full_review_scope: string[];
    full_review_scope_sha256: string;
    required_delta_targets: string[];
    required_delta_targets_sha256: string;
    optional_context_files: string[];
    optional_context_files_sha256: string;
    membership_unchanged: boolean;
}

export interface ReviewRemediationDeltaClassification {
    schema_version: typeof REVIEW_REMEDIATION_DELTA_SCHEMA_VERSION;
    task_id: string;
    review_type: string;
    status: 'CLASSIFIED';
    category: ReviewRemediationDeltaCategory;
    reason: string;
    baseline: {
        artifact_path: string;
        artifact_sha256: string;
        review_tree_state_sha256: string;
        delta_base_snapshot_sha256: string;
    };
    current_snapshot_sha256: string;
    full_review_required: boolean;
    full_review_reasons: string[];
    scope: ReviewRemediationDeltaScope;
    /** The fix changed nothing but documents, so it carries no boundary signal and reaches no other review. */
    documents_only?: boolean;
    changed_files: string[];
    unchanged_files: string[];
    file_deltas: ReviewRemediationFileDelta[];
    additions_total: number | null;
    deletions_total: number | null;
    changed_lines_total: number | null;
    readable_diff: ReviewRemediationReadableDiffEvidence;
    mode_policy_assessment?: ReviewRemediationModeAssessment;
    /** Carried passed lanes may need their own earlier reviewed tree as the DELTA base. */
    lane_deltas?: Record<string, ReviewRemediationDeltaClassification>;
    classification_sha256: string;
}

export interface ClassifyReviewRemediationDeltaOptions {
    fileRoles?: FileRoleBindings;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    baselineArtifactPath: string;
    baselineArtifactSha256: string;
    currentChangedFiles: readonly string[];
    testPathRegexes?: readonly string[];
    structuralTestPathRegexes?: readonly string[];
    structuralTestChangedLinesThreshold?: number;
    /** Documents never reach a review: preflight's own test for an ordinary document decides. */
    isOrdinaryDocument?: (filePath: string) => boolean;
    /**
     * The intent the new preflight is classified with. When given, task criteria are compared by the shared
     * rule: the binding recorded in the failed review's context against the current one.
     */
    currentTaskIntent?: string | null;
    modePolicy?: ReviewRemediationModePolicy;
    modePolicyLegacyFallback?: boolean;
    consecutiveDeltaReviews?: number;
    protectedBoundarySignals?: readonly ReviewRemediationProtectedBoundarySignal[];
    taskCriteriaChanged?: boolean;
    policyChanged?: boolean;
    /**
     * Derives the protected-boundary, task-criteria and policy guards from the
     * classified delta files. When present it replaces the three static inputs above.
     */
    resolveModeGuards?: (deltaChangedFiles: readonly string[], deltaChangedLines: readonly string[], fileDeltas: readonly ReviewRemediationFileDelta[], redactedChangedLine: boolean, taskCriteriaChanged: boolean, taskCriteriaBindingRecorded: boolean) => {
        protectedBoundarySignals: readonly ReviewRemediationProtectedBoundarySignal[];
        scopeReviewTypes?: readonly string[] | null;
        taskCriteriaChanged: boolean;
        policyChanged: boolean;
        uncertainCrossFileImpact?: boolean;
    };
    scopeReviewTypes?: readonly string[] | null;
    uncertainCrossFileImpact?: boolean;
}

const GENERATED_PATH_PATTERN = /(?:^|\/)(?:\.node-build|\.scripts-build|generated|__generated__|snapshots?)(?:\/|$)|\.snap$|[._]generated\.[^/]+$|\.(?:pb|pb\.gw|g|designer|freezed|min)\.[^/]+$|_pb2(?:_grpc)?\.pyi?$|_pb\.(?:js|d\.ts)$|(?:^|\/)zz_generated[^/]*$|\.gen\.[^/]+$|_gen\.go$/iu;
// Third-party code, at any depth outside test folders: a test file inside it is not a test of this project.
const VENDORED_PATH_PATTERN = /(?:^|\/)(?:vendor|third[-_]?party|node_modules|Pods|DerivedData|__pycache__|\.gradle|\.next|\.nuxt)\//iu;
const BUILD_OUTPUT_PATH_PATTERN = /(?:^|\/)(?:gen|obj|target|build|_build|out|coverage|dist)\//iu;
// Folders that hold source files directly, unlike package containers: `packages/ui/build/` is
// output, while `src/build/` and `crates/gen/src/` are modules that happen to share the name.
const SOURCE_FOLDER_NAMES = 'src|lib|app|internal|pkg|cmd|Sources|scripts|bin';
const INSIDE_SOURCE_FOLDER_PATTERN = new RegExp(`(?:^|/)(?:${SOURCE_FOLDER_NAMES})/`, 'iu');
const STARTS_SOURCE_FOLDER_PATTERN = new RegExp(`^(?:${SOURCE_FOLDER_NAMES})/`, 'iu');
const INSIDE_RUNTIME_ROOT_PATTERN = new RegExp(
    `(?:^|/)(?:${DEFAULT_RUNTIME_ROOTS.map((root) => root.slice(0, -1)).join('|')})/`, 'iu'
);
const FEATURE_CONTENT_PATTERN = /(?:^|\/)features\/[^/]+\/(.*)/iu;
const AMBIGUOUS_TEST_LAYOUT_PATTERN = /(?:^|\/)(?:spec|cypress|[^/]+\.specs?)\//iu;
const FEATURE_TEST_CONTEXT_PATTERN = /(?:^|\/)(?:__mocks__|__fixtures__|mocks?|fixtures?|qa|integration|acceptance)\/|(?:^|\/)setupTests\.[^/]+$/iu;
const FEATURE_TEST_NAME_COLLISION_PATTERN = new RegExp(FEATURE_TEST_NAME_COLLISION_REGEX, 'iu');
const PRODUCTION_PATH_PATTERN = /^(?:src|bin|scripts)\/|^garda-agent-orchestrator\/(?:src|bin|scripts)\//iu;
// Source files of any common stack are production code wherever the project keeps them.
const SOURCE_FILE_PATTERN = new RegExp(`\\.(?:${CODE_EXTENSION_GROUP.slice(3, -1)}|sql|html?|css|scss|sass|less)$`, 'iu');
const CODE_FILE_PATTERN = new RegExp(`\\.${CODE_EXTENSION_GROUP}$`, 'iu');
// A path names test code by a whole token (`tests/`, `__mocks__/`, `test-utils`, `testutil/`, `qa/`) or a
// camel-case part (`setupTests`, `InvoiceFixtures`); `special` or `latest` do not.
const TEST_CODE_TOKEN_PATTERN = /(?:^|[/._-])(?:__)?(?:tests?|specs?|mocks?|fixtures?|testing|test(?:utils?|helpers?|support|kit|lib)|e2e|qa|integration|acceptance)(?:__)?(?=[/._-]|$)/iu;
const TEST_CODE_CAMEL_PATTERN = /[a-z0-9](?:Tests?|Specs?|Mocks?|Fixtures?)(?=[/._A-Z-]|$)|(?:^|[/._-])(?:[Tt]ests?|[Ss]pecs?|[Mm]ocks?|[Ff]ixtures?)(?=[A-Z])/u;
const DEFAULT_STRUCTURAL_PATTERN_SOURCES = new Set(
    DEFAULT_TEST_REFACTOR_STRUCTURAL_PATH_REGEXES.map((pattern) => new RegExp(pattern, 'iu').source)
);
// Runtime and tool configuration, including configuration files kept under source roots; source code in
// a `config` package below a source root is not configuration (see `isSourceCodeInConfigPackage`).
const CONFIGURATION_FOLDER_PATTERN = /(?:^|\/)configs?\//iu;
const CONFIGURATION_FILE_PATTERN = new RegExp([
    '\\.(?:ya?ml|toml|ini|cfg|conf|properties|config|plist)$',
    '(?:^|/)\\.env(?:\\.[^/]+)?$',
    '(?:^|/)\\.[^/]+rc(?:\\.[^/]+)?$',
    '(?:^|/)[^/]+\\.config\\.[^/]+$',
    '(?:^|/)[^/]+\\.conf\\.[^/]+$',
    '(?:^|/)[^/]*(?:config|settings)[^/]*\\.(?:jsonc?|xml)$',
    '(?:^|/)(?:(?:local|base|dev|prod|production|staging)_)?settings(?:_[^/]+)?\\.py$',
    '(?:^|/)settings/(?:[^/]+/)*[^/]+\\.py$',
    '\\.gradle(?:\\.kts)?$',
    '(?:^|/)buildSrc/'
].join('|'), 'iu');
const DOCUMENTATION_FOLDER_PATTERN = /(?:^|\/)docs?\//iu;
// Data for tests: manifests and documents here are inputs of a test, not project files.

function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * Older comparison, kept only for a failed review whose context records no task-criteria binding: compare the
 * same linked card and section that supplied the authenticated coverage contract.
 */
function linkedTaskCardChanged(repoRoot: string, taskId: string, baseline: ReviewRemediationBaselineArtifact,
    currentChangedFiles: readonly string[]): boolean {
    const card = readReviewTaskCard(repoRoot, taskId);
    const previous = baseline.origin_coverage_contract?.obligations
        .filter((entry) => entry.kind === 'criterion').map((entry) => entry.task_criterion);
    if (!card) return Boolean(previous?.length);
    if (!previous) return true;
    const current = card.acceptance_criteria.map((text) => ({ text, source: card.path, section_sha256: card.sha256 }));
    if (JSON.stringify(previous) !== JSON.stringify(current)) return true;
    // The card may have no acceptance items, or may also have changed outside its linked section.
    // If it was in the reviewed file snapshot, compare its full authenticated content as well.
    const entry = baseline.delta_base?.entries.find((item) => item.path === card.path);
    if (entry) return entry.status !== 'text' || !entry.content_sha256
        || entry.content_sha256 !== fileSha256(path.resolve(repoRoot, card.path));
    // An added card in the task scope has no authenticated old file bytes to compare.
    return current.length === 0 || currentChangedFiles.some((file) => normalizePath(file).toLowerCase() === card.path.toLowerCase());
}

function compilePatterns(patterns: readonly string[], subject: string): RegExp[] {
    return patterns.map((pattern) => {
        try {
            return new RegExp(pattern, 'iu');
        } catch (error: unknown) {
            throw new Error(
                `Review remediation delta ${subject} contains invalid regex '${pattern}': `
                + (error instanceof Error ? error.message : String(error))
            );
        }
    });
}

// Manifests such as `mix.exs`, `Package.swift` or `build.gradle.kts` have source extensions but change dependencies.
const INFRASTRUCTURE_PATTERNS = compilePatterns(DEFAULT_INFRA_TRIGGER_REGEXES, 'infrastructure defaults');

function normalizeChangedFiles(files: readonly string[]): string[] {
    return [...new Set(files.map((file) => normalizePath(file)).filter(Boolean))].sort();
}

function sameEntry(left: ReviewRemediationDeltaBaseEntry, right: ReviewRemediationDeltaBaseEntry): boolean {
    // Fail closed when bounded snapshot evidence has no content hash: size or path metadata
    // cannot authenticate that an unreviewable file retained the same content.
    const comparableContent = left.content_sha256 !== null
        || left.status === 'missing'
        || (left.status === 'symbolic_link' && left.link_sha256 !== null);
    return comparableContent
        && left.status === right.status
        && left.mode === right.mode
        && left.content_sha256 === right.content_sha256
        && left.link_sha256 === right.link_sha256;
}

function missingEntry(filePath: string): ReviewRemediationDeltaBaseEntry {
    return {
        path: filePath,
        status: 'missing',
        mode: null,
        content_sha256: null,
        link_sha256: null,
        line_hashes: [],
        redacted_lines: [],
        redacted_lines_sha256: sha256Text(''),
        redaction_applied: false,
        line_count: 0,
        line_analysis: 'available'
    };
}

function getOperation(
    baseline: ReviewRemediationDeltaBaseEntry,
    current: ReviewRemediationDeltaBaseEntry
): ReviewRemediationDeltaOperation {
    if (baseline.status === 'missing' && current.status !== 'missing') {
        return 'added';
    }
    if (baseline.status !== 'missing' && current.status === 'missing') {
        return 'deleted';
    }
    if (baseline.status !== current.status) {
        return 'type_changed';
    }
    return 'modified';
}

function categorizeFile(options: {
    fileRoles?: FileRoleBindings;
    filePath: string;
    operation: ReviewRemediationDeltaOperation;
    changedLines: number | null;
    lineDeltaUnavailableReason: string | null;
    baselineStatus: ReviewRemediationDeltaBaseEntry['status'];
    currentStatus: ReviewRemediationDeltaBaseEntry['status'];
    testPathRegexes: readonly string[];
    structuralPatterns: readonly RegExp[];
    structuralThreshold: number;
}): { category: ReviewRemediationDeltaCategory; reason: string } {
    if (
        options.changedLines === null
        || options.baselineStatus === 'symbolic_link'
        || options.currentStatus === 'symbolic_link'
        || options.baselineStatus === 'unreviewable'
        || options.currentStatus === 'unreviewable'
    ) {
        return {
            category: 'ambiguous',
            reason: options.lineDeltaUnavailableReason
                || `line delta is unavailable for ${options.baselineStatus} -> ${options.currentStatus}`
        };
    }
    const role = declaredFileRole(options.filePath, options.fileRoles);
    if (role === 'source') return { category: 'production', reason: 'path has an explicit source role' };
    const testLike = isTestLikeRemediationPath(options.filePath, options.testPathRegexes, options.fileRoles);
    const testCode = testLike && CODE_FILE_PATTERN.test(options.filePath);
    if (role !== 'test' && GENERATED_PATH_PATTERN.test(options.filePath)) {
        return { category: 'generated_churn', reason: 'path is a generated or snapshot artifact' };
    }
    // What a folder means depends on what contains it: a test folder owns everything below it.
    const insideTests = (folder: string): boolean => isTestLikeRemediationPath(`${folder}x`, options.testPathRegexes, options.fileRoles)
        || namesStructuralTestCode(folder) || isReviewRemediationFixtureDataPath(folder);
    if (role !== 'test' && isBuildOutput(options.filePath, insideTests)) {
        return { category: 'generated_churn', reason: 'path is build output or vendored code' };
    }
    const fixtureData = isReviewRemediationFixtureDataPath(options.filePath);
    // Helper-like names (`setup.py`) and test folders (`cypress/package.json`) must not hide a real manifest.
    if (isReviewRemediationDependencyManifestPath(options.filePath, options.fileRoles)) {
        return { category: 'production', reason: 'path is a dependency manifest' };
    }
    if (!testLike && !SOURCE_FILE_PATTERN.test(options.filePath)
        && INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(options.filePath))) {
        return { category: 'production', reason: 'path is infrastructure configuration' };
    }
    const documentationFolder = DOCUMENTATION_FOLDER_PATTERN.exec(options.filePath);
    if (isProjectInstructionPath(options.filePath)) {
        return { category: 'production', reason: 'path contains project instructions' };
    }
    if (CONFIGURATION_FILE_PATTERN.test(options.filePath)
        && collectReviewRemediationProtectedBoundarySignals({ changedFiles: [options.filePath] })
            .some((signal) => signal in PROTECTED_BOUNDARY_SIGNAL_OWNERS)) {
        return { category: 'production', reason: 'path is owned configuration' };
    }
    const testDocument = documentationFolder ? insideTests(options.filePath.slice(0, documentationFolder.index + 1)) : testLike;
    if (!testCode && !testDocument && !fixtureData && isDocumentation(options.filePath, documentationFolder)) {
        return { category: 'global', reason: 'path is documentation' };
    }
    const configurationFile = CONFIGURATION_FILE_PATTERN.test(options.filePath);
    const folder = options.filePath.slice(0, options.filePath.lastIndexOf('/') + 1);
    // Source code in a `config` package below a source root (`src/config/limits.ts`, Java `com/acme/config/`)
    // is production code; test paths keep the configuration handling below.
    const configurationFolder = CONFIGURATION_FOLDER_PATTERN.test(options.filePath)
        && (testLike || namesStructuralTestCode(folder) || !isSourceCodeInConfigPackage(options.filePath));
    const configuration = configurationFile || configurationFolder;
    // The folder decides for configuration: `config/test-setup.yml` configures the application.
    if (configuration && !testLike && !namesStructuralTestCode(folder)) {
        return { category: 'global', reason: 'path is runtime or tool configuration' };
    }
    if (testLike && options.operation === 'added') {
        return { category: 'leaf_test', reason: 'new test files reach only the test review' };
    }
    // A feature named support or steps remains production even when it contains
    // helper-like folders; explicit test paths and project patterns still apply.
    const feature = FEATURE_CONTENT_PATTERN.exec(options.filePath);
    const unconfirmedFeatureHelper = feature !== null && (/(?:^|\/)features\/(?:support|steps)\//iu.test(options.filePath)
        || !FEATURE_TEST_CONTEXT_PATTERN.test(feature[1]));
    if (isSharedTestHelper(options.filePath, options.structuralPatterns,
        testLike || namesStructuralTestCode(options.filePath),
        !testLike && (unconfirmedFeatureHelper || FEATURE_TEST_NAME_COLLISION_PATTERN.test(options.filePath)
            || AMBIGUOUS_TEST_LAYOUT_PATTERN.test(options.filePath)))) {
        return {
            category: 'shared_test_helper_or_harness',
            reason: 'path matches the frozen shared test helper or harness policy'
        };
    }
    // A test file in a `config` package (`tests/config/test_parser.py`) is an ordinary test.
    const namedAsTest = SOURCE_FILE_PATTERN.test(options.filePath) && namesTestCode(options.filePath.slice(folder.length));
    if (testLike && (configurationFile || (configuration && !namedAsTest))) {
        return { category: 'shared_test_helper_or_harness', reason: 'path configures the test harness' };
    }
    if (testLike) {
        if (options.operation === 'deleted' || options.operation === 'type_changed') {
            return {
                category: 'structural_test',
                reason: `test file operation '${options.operation}' changes test structure`
            };
        }
        if (options.changedLines > options.structuralThreshold) {
            return {
                category: 'structural_test',
                reason: `test delta ${options.changedLines} exceeds frozen structural threshold ${options.structuralThreshold}`
            };
        }
        return {
            category: 'leaf_test',
            reason: `existing leaf test delta ${options.changedLines} is within frozen threshold ${options.structuralThreshold}`
        };
    }
    if (configuration) {
        return { category: 'global', reason: 'path is runtime or tool configuration' };
    }
    if (SOURCE_FILE_PATTERN.test(options.filePath) || PRODUCTION_PATH_PATTERN.test(options.filePath)) {
        return { category: 'production', reason: 'path is production runtime source' };
    }
    return { category: 'ambiguous', reason: 'path does not match a frozen remediation delta class' };
}

function namesTestCode(filePath: string): boolean {
    return TEST_CODE_TOKEN_PATTERN.test(filePath) || TEST_CODE_CAMEL_PATTERN.test(filePath);
}

function namesStructuralTestCode(filePath: string): boolean {
    // TestCase and Base*Test can be production domain classes; their filename
    // alone cannot establish test context for the default base-class pattern.
    let contextPath = filePath.replace(/(?:^|\/)(?:Test(?:Base|Case)|(?:Abstract|Base)[^/]*Tests?)\.[^/]+$/iu, '');
    if (INSIDE_RUNTIME_ROOT_PATTERN.test(filePath)) {
        // A production folder can itself be named spec or fixtures. Explicit
        // test paths and unmistakable names such as __mocks__ retain context.
        contextPath = contextPath.replace(/(^|[/._-])specs?(?=\/)/giu, '$1')
            .replace(/(^|\/)fixtures?(?=\/)/giu, '$1');
    }
    const sourceFolder = INSIDE_SOURCE_FOLDER_PATTERN.exec(contextPath);
    if (sourceFolder) {
        // These names also describe ordinary production modules and files under source roots.
        const end = sourceFolder.index + sourceFolder[0].length;
        contextPath = contextPath.slice(0, end) + contextPath.slice(end)
            .replace(/(^|[/._-])(?:integration|acceptance|qa|e2e)(?=[/._-]|$)/giu, '$1');
    }
    return namesTestCode(contextPath);
}

function isBuildOutput(filePath: string, insideTests: (folder: string) => boolean): boolean {
    const vendored = VENDORED_PATH_PATTERN.exec(filePath);
    if (vendored && !insideTests(filePath.slice(0, vendored.index + 1))) {
        return true;
    }
    const output = BUILD_OUTPUT_PATH_PATTERN.exec(filePath);
    if (!output) {
        return false;
    }
    const container = filePath.slice(0, output.index + 1);
    return !insideTests(container)
        && !INSIDE_SOURCE_FOLDER_PATTERN.test(container)
        && !STARTS_SOURCE_FOLDER_PATTERN.test(filePath.slice(output.index + output[0].length));
}

function isSourceCodeInConfigPackage(filePath: string): boolean {
    // A `config/` folder at the repository or package root (Rails `config/initializers/`, Laravel `config/app.php`)
    // configures the application; below a source folder (`src/`, `app/`, `internal/`, `lib/`) it is a module.
    const configFolder = CONFIGURATION_FOLDER_PATTERN.exec(filePath);
    return configFolder !== null && CODE_FILE_PATTERN.test(filePath)
        && INSIDE_SOURCE_FOLDER_PATTERN.test(filePath.slice(0, configFolder.index + 1));
}

function isDocumentation(filePath: string, documentationFolder: RegExpExecArray | null): boolean {
    if (isDocumentationLikePath(filePath)) {
        return true;
    }
    // Code under a source folder serves documentation pages (`src/app/docs/page.tsx`); it is code.
    return documentationFolder !== null && !(CODE_FILE_PATTERN.test(filePath)
        && INSIDE_SOURCE_FOLDER_PATTERN.test(filePath.slice(0, documentationFolder.index + 1)));
}

function isSharedTestHelper(
    filePath: string, structuralPatterns: readonly RegExp[], testContext: boolean, ignoreDefaultPatterns: boolean
): boolean {
    const matched = structuralPatterns.filter((pattern) => pattern.test(filePath));
    if (matched.length === 0) {
        return false;
    }
    // Default helper folder names also name production code (Rails `app/helpers/`, `bin/setup`):
    // a file counts only when its path names test code. Ambiguous feature and
    // suite names cannot establish that context. Project-added patterns still apply.
    return (!ignoreDefaultPatterns && testContext)
        || matched.some((pattern) => !DEFAULT_STRUCTURAL_PATTERN_SOURCES.has(pattern.source));
}

function classifyFromBaseline(options: {
    fileRoles?: FileRoleBindings;
    repoRoot: string;
    taskId: string;
    reviewType: string;
    baselineArtifactPath: string;
    baselineArtifactSha256: string;
    baseline: ReviewRemediationBaselineArtifact;
    currentChangedFiles: readonly string[];
    testPathRegexes: readonly string[];
    structuralTestPathRegexes: readonly string[];
    structuralTestChangedLinesThreshold: number;
    isOrdinaryDocument: (filePath: string) => boolean;
}): ReviewRemediationDeltaClassification {
    const deltaBase = options.baseline.delta_base;
    if (!deltaBase) {
        throw new Error(
            `Review remediation delta requires a schema v${options.baseline.schema_version} baseline with delta_base evidence.`
        );
    }
    const baseViolations = getReviewRemediationDeltaBaseViolations(deltaBase, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewTreeStateSha256: options.baseline.bindings.tree.review_tree_state_sha256
    });
    if (baseViolations.length > 0) {
        throw new Error(`Review remediation delta baseline is incomplete: ${baseViolations.join(' ')}`);
    }
    if (options.currentChangedFiles.length > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES) {
        throw new Error(
            `Review remediation delta accepts at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES} current changed files.`
        );
    }
    const baselineReviewScope = normalizeChangedFiles(deltaBase.changed_files);
    const currentReviewScope = normalizeChangedFiles(options.currentChangedFiles);
    const isDocument = options.isOrdinaryDocument;
    // New documents and tests widen no review except the test review, which reads them as its delta.
    const isReviewedCode = (filePath: string): boolean => !isDocument(filePath)
        && !isTestLikeRemediationPath(filePath, options.testPathRegexes, options.fileRoles);
    const membershipUnchanged = JSON.stringify(baselineReviewScope.filter(isReviewedCode))
        === JSON.stringify(currentReviewScope.filter(isReviewedCode));
    const allFiles = normalizeChangedFiles([
        ...deltaBase.changed_files,
        ...options.currentChangedFiles
    ]);
    if (allFiles.length > REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES) {
        throw new Error(
            `Review remediation delta union accepts at most ${REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_FILES} changed files.`
        );
    }
    const currentSnapshot = buildReviewRemediationDeltaBase({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewTreeStateSha256: deltaBase.review_tree_state_sha256,
        changedFiles: allFiles,
        deferSnapshotPath: isDocument
    });
    const baselineEntries = new Map(deltaBase.entries.map((entry) => (countNextStepWork('visit:review-remediation-delta:event:312'), [entry.path, entry])));
    const currentEntries = new Map(currentSnapshot.entries.map((entry) => (countNextStepWork('visit:review-remediation-delta:event:313'), [entry.path, entry])));
    const structuralPatterns = compilePatterns(
        options.structuralTestPathRegexes,
        'structural test path policy'
    );
    const fileDeltas: ReviewRemediationFileDelta[] = [];
    const documentDeltas: ReviewRemediationFileDelta[] = [];
    const unchangedFiles: string[] = [];
    const readableDiffFiles: Array<{ path: string; lines: ReviewRemediationReadableDiffLine[] }> = [];
    const readableDocumentFiles: Array<{ path: string; lines: ReviewRemediationReadableDiffLine[] }> = [];
    const fullReviewReasons: string[] = [];
    if (!membershipUnchanged) {
        fullReviewReasons.push('full review scope membership changed after the authenticated baseline');
    }
    const lineComparisonBudget: ReviewRemediationLineComparisonBudget = {
        remainingWorkUnits: REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS
    };
    const documentComparisonBudget: ReviewRemediationLineComparisonBudget = {
        remainingWorkUnits: REVIEW_REMEDIATION_DELTA_MAX_DIFF_WORK_UNITS
    };
    for (const filePath of allFiles) {
        const capturedBaselineEntry = baselineEntries.get(filePath);
        const baselineEntry = capturedBaselineEntry || missingEntry(filePath);
        const currentEntry = currentEntries.get(filePath) || missingEntry(filePath);
        const currentOnlyMissing = !capturedBaselineEntry && currentEntry.status === 'missing';
        if (!currentOnlyMissing && sameEntry(baselineEntry, currentEntry)) {
            unchangedFiles.push(filePath);
            continue;
        }
        const operation = currentOnlyMissing ? 'deleted' : getOperation(baselineEntry, currentEntry);
        const document = isDocument(filePath)
            && ['text', 'missing'].includes(baselineEntry.status)
            && ['text', 'missing'].includes(currentEntry.status)
            && !(operation === 'modified' && baselineEntry.mode !== currentEntry.mode);
        const lineDelta = currentOnlyMissing
            ? {
                additions: null,
                deletions: null,
                changedLines: null,
                unavailableReason: 'path entered the current task scope after the baseline and is now missing',
                readableLines: null
            }
            : buildReviewRemediationLineDelta(baselineEntry, currentEntry, document ? documentComparisonBudget : lineComparisonBudget);
        const classification = currentOnlyMissing
            ? { category: 'ambiguous' as const, reason: lineDelta.unavailableReason as string }
            : document ? { category: 'production' as const, reason: 'path is a document' } : categorizeFile({
            filePath,
            operation,
            changedLines: lineDelta.changedLines,
            lineDeltaUnavailableReason: lineDelta.unavailableReason,
            baselineStatus: baselineEntry.status,
            currentStatus: currentEntry.status,
            testPathRegexes: options.testPathRegexes,
            fileRoles: options.fileRoles,
            structuralPatterns,
            structuralThreshold: options.structuralTestChangedLinesThreshold
        });
        const fileDelta: ReviewRemediationFileDelta = {
            path: filePath,
            operation,
            category: classification.category,
            reason: classification.reason,
            baseline_status: baselineEntry.status,
            current_status: currentEntry.status,
            baseline_mode: baselineEntry.mode,
            current_mode: currentEntry.mode,
            baseline_content_sha256: baselineEntry.content_sha256,
            current_content_sha256: currentEntry.content_sha256,
            baseline_line_count: baselineEntry.line_count,
            current_line_count: currentEntry.line_count,
            additions: lineDelta.additions,
            deletions: lineDelta.deletions,
            changed_lines: lineDelta.changedLines
        };
        if (document && !currentOnlyMissing) {
            documentDeltas.push(fileDelta);
            if (lineDelta.readableLines) readableDocumentFiles.push({ path: filePath, lines: lineDelta.readableLines });
            continue;
        }
        fileDeltas.push(fileDelta);
        if (lineDelta.readableLines) {
            readableDiffFiles.push({ path: filePath, lines: lineDelta.readableLines });
        }
        const addedTest = operation === 'added' && classification.category === 'leaf_test' && currentEntry.status === 'text'
            && isTestLikeRemediationPath(filePath, options.testPathRegexes, options.fileRoles);
        if (operation !== 'modified' && !addedTest) {
            fullReviewReasons.push(`${filePath}: ${operation} paths require FULL review`);
        }
        if (operation === 'modified' && baselineEntry.mode !== currentEntry.mode) {
            fullReviewReasons.push(`${filePath}: file mode changed after the authenticated baseline`);
        }
        if (!addedTest && (baselineEntry.status !== 'text' || currentEntry.status !== 'text')) {
            fullReviewReasons.push(
                `${filePath}: ${baselineEntry.status} -> ${currentEntry.status} content is not an ordinary text modification`
            );
        }
        if (lineDelta.unavailableReason) {
            fullReviewReasons.push(`${filePath}: ${lineDelta.unavailableReason}`);
        }
    }
    // A fix of documents alone still closes the failed review; beside code they only add context.
    const documentsOnly = fileDeltas.length === 0 && documentDeltas.length > 0;
    if (documentsOnly) {
        fileDeltas.push(...documentDeltas);
        readableDiffFiles.push(...readableDocumentFiles);
        // A reviewer cites reviewed code, and no reviewed code changed, so the failed review repeats whole.
        fullReviewReasons.push('a fix of documents alone leaves nothing for a DELTA review to cite');
    } else {
        unchangedFiles.push(...documentDeltas.map((entry) => entry.path));
        unchangedFiles.sort();
    }
    const categories = [...new Set(fileDeltas.map((entry) => entry.category))].sort();
    const compatibleTestCategories = categories.length > 0 && categories.every(category =>
        category === 'leaf_test' || category === 'structural_test' || category === 'shared_test_helper_or_harness');
    const category: ReviewRemediationDeltaCategory = compatibleTestCategories
        ? categories.includes('shared_test_helper_or_harness')
            ? 'shared_test_helper_or_harness'
            : categories.includes('structural_test') ? 'structural_test' : 'leaf_test'
        : categories.includes('production') && categories.every((entry) => entry === 'production'
            || entry === 'leaf_test' || entry === 'structural_test' || entry === 'shared_test_helper_or_harness')
            ? 'production' : categories.length === 1 ? categories[0] : 'ambiguous';
    const baseReason = fileDeltas.length === 0
        ? 'no post-baseline file content changes were detected'
        : category === 'ambiguous' && categories.length === 1
            ? `ambiguous remediation delta: ${fileDeltas.map((entry) => `${entry.path}: ${entry.reason}`).join('; ')}`
        : categories.length === 1
            ? `all changed files classify as ${categories[0]}`
            : compatibleTestCategories
                ? `compatible test remediation classes: ${categories.join(', ')}; classified as ${category}`
                : `mixed remediation delta classes: ${categories.join(', ')}`;
    const findingScope = buildReviewRemediationFindingScope(
        options.baseline, fileDeltas.map((entry) => entry.path), allFiles
    );
    fullReviewReasons.push(...findingScope.fullReviewReasons);
    const normalizedFullReviewReasons = [...new Set(fullReviewReasons)].sort();
    const reason = normalizedFullReviewReasons.length > 0
        ? `${baseReason}; FULL review required: ${normalizedFullReviewReasons.join('; ')}`
        : baseReason;
    const allLineStatsAvailable = fileDeltas.every((entry) => entry.changed_lines !== null);
    const additionsTotal = allLineStatsAvailable
        ? fileDeltas.reduce((total, entry) => total + (entry.additions || 0), 0)
        : null;
    const deletionsTotal = allLineStatsAvailable
        ? fileDeltas.reduce((total, entry) => total + (entry.deletions || 0), 0)
        : null;
    const requiredDeltaTargets = fileDeltas.map((entry) => entry.path);
    const optionalContextFiles = unchangedFiles;
    const scope: ReviewRemediationDeltaScope = {
        full_review_scope: allFiles,
        full_review_scope_sha256: sha256Text(allFiles.join('\n')),
        required_delta_targets: requiredDeltaTargets,
        required_delta_targets_sha256: sha256Text(requiredDeltaTargets.join('\n')),
        optional_context_files: optionalContextFiles,
        optional_context_files_sha256: sha256Text(optionalContextFiles.join('\n')),
        membership_unchanged: membershipUnchanged
    };
    const readableDiff = buildReviewRemediationReadableDiffEvidence(readableDiffFiles);
    const baseResult: Omit<ReviewRemediationDeltaClassification, 'classification_sha256'> = {
        schema_version: REVIEW_REMEDIATION_DELTA_SCHEMA_VERSION,
        task_id: options.taskId,
        review_type: options.reviewType,
        status: 'CLASSIFIED' as const,
        category,
        reason,
        baseline: {
            artifact_path: normalizePath(options.baselineArtifactPath),
            artifact_sha256: options.baselineArtifactSha256,
            review_tree_state_sha256: deltaBase.review_tree_state_sha256,
            delta_base_snapshot_sha256: deltaBase.snapshot_sha256
        },
        current_snapshot_sha256: currentSnapshot.snapshot_sha256,
        full_review_required: normalizedFullReviewReasons.length > 0,
        full_review_reasons: normalizedFullReviewReasons,
        scope,
        documents_only: documentsOnly,
        changed_files: requiredDeltaTargets,
        unchanged_files: unchangedFiles,
        file_deltas: fileDeltas,
        additions_total: additionsTotal,
        deletions_total: deletionsTotal,
        changed_lines_total: additionsTotal === null || deletionsTotal === null
            ? null
            : additionsTotal + deletionsTotal,
        readable_diff: readableDiff
    };
    return {
        ...baseResult,
        classification_sha256: sha256RedactedJsonPayload(baseResult)
    };
}

/**
 * Pure T-979-37 classification boundary. It deliberately does not select or rerun
 * review lanes: T-979-38 maps this result to the snapshotted rerun policy and
 * T-979-40 integrates that policy with recovery routing.
 */
export function classifyReviewRemediationDelta(
    options: ClassifyReviewRemediationDeltaOptions
): ReviewRemediationDeltaClassification {
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    const baselineValidation = validateReviewRemediationBaselineArtifact({
        artifactPath: options.baselineArtifactPath,
        expectedArtifactSha256: options.baselineArtifactSha256,
        expectedTaskId: options.taskId,
        expectedReviewType: reviewType
    });
    if (!baselineValidation.valid || !baselineValidation.artifact || !baselineValidation.artifact_sha256) {
        throw new Error(
            `Review remediation delta requires a current authenticated baseline: ${baselineValidation.violations.join(' ')}`
        );
    }
    const structuralThreshold = options.structuralTestChangedLinesThreshold
        ?? DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_changed_lines_threshold;
    if (!Number.isInteger(structuralThreshold) || structuralThreshold < 1) {
        throw new Error('Review remediation delta structural test changed-lines threshold must be a positive integer.');
    }
    const delta = classifyFromBaseline({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType,
        baselineArtifactPath: options.baselineArtifactPath,
        baselineArtifactSha256: baselineValidation.artifact_sha256,
        baseline: baselineValidation.artifact,
        currentChangedFiles: options.currentChangedFiles,
        testPathRegexes: options.testPathRegexes ?? DEFAULT_REVIEW_TRIGGER_POLICY.test_path_regexes,
        fileRoles: options.fileRoles,
        structuralTestPathRegexes: options.structuralTestPathRegexes
            ?? DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes,
        structuralTestChangedLinesThreshold: structuralThreshold,
        isOrdinaryDocument: options.isOrdinaryDocument ?? (() => false)
    });
    if (!options.modePolicy) {
        return delta;
    }
    // One rule with the passed-review path: the failed review's recorded criteria binding against the current one.
    const recordedCriteriaChange = typeof options.currentTaskIntent === 'string'
        ? resolveFailedReviewTaskCriteriaChange({ repoRoot: options.repoRoot, taskId: options.taskId,
            baseline: baselineValidation.artifact, baselineSha256: baselineValidation.artifact_sha256,
            currentTaskIntent: options.currentTaskIntent })
        : null;
    const taskCardChanged = recordedCriteriaChange ?? linkedTaskCardChanged(options.repoRoot, options.taskId,
        baselineValidation.artifact, options.currentChangedFiles);
    const changedLineEvidence = delta.documents_only ? { lines: [], redactedChangedLine: false }
        : collectReviewRemediationChangedLineEvidence(delta.readable_diff);
    const secretChanged = changedLineEvidence.redactedChangedLine && !delta.file_deltas.every((entry) =>
        entry.operation === 'added' && entry.category === 'leaf_test');
    const modeGuards = options.resolveModeGuards
        ? options.resolveModeGuards(
            delta.documents_only ? [] : delta.changed_files,
            changedLineEvidence.lines,
            delta.documents_only ? [] : delta.file_deltas,
            secretChanged,
            taskCardChanged,
            recordedCriteriaChange !== null
        )
        : options;
    const assessment = evaluateReviewRemediationMode({
        policy: options.modePolicy,
        legacyFallback: options.modePolicyLegacyFallback,
        reviewType,
        category: delta.category,
        changedFilesCount: delta.changed_files.length,
        changedLinesTotal: delta.changed_lines_total,
        consecutiveDeltaReviews: options.consecutiveDeltaReviews ?? 0,
        protectedBoundarySignals: [...new Set([...(modeGuards.protectedBoundarySignals ?? []),
            ...(secretChanged ? ['secret' as const] : [])])],
        scopeReviewTypes: modeGuards.scopeReviewTypes,
        taskCriteriaChanged: modeGuards.taskCriteriaChanged === true || taskCardChanged,
        policyChanged: modeGuards.policyChanged,
        scopeMembershipChanged: !delta.scope.membership_unchanged,
        uncertainCrossFileImpact: options.uncertainCrossFileImpact === true || modeGuards.uncertainCrossFileImpact === true,
        existingFullReviewReasons: delta.full_review_reasons
    });
    const deltaWithoutHash = { ...delta } as Omit<ReviewRemediationDeltaClassification, 'classification_sha256'>
        & { classification_sha256?: string };
    delete deltaWithoutHash.classification_sha256;
    const fullReviewReasons = [...new Set([
        ...delta.full_review_reasons,
        ...assessment.full_review_reasons
    ])].sort();
    const classified = {
        ...deltaWithoutHash,
        reason: fullReviewReasons.length > 0
            ? `${delta.reason}; conservative mode policy requires FULL: ${fullReviewReasons.join('; ')}`
            : delta.reason,
        full_review_required: fullReviewReasons.length > 0,
        full_review_reasons: fullReviewReasons,
        mode_policy_assessment: assessment
    };
    return {
        ...classified,
        classification_sha256: sha256RedactedJsonPayload(classified)
    };
}

export const reviewRemediationDeltaInternals = {
    categorizeFile,
    compilePatterns,
    getLcsLength,
    sha256Text
};
