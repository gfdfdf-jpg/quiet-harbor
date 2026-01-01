import { REVIEW_LANES, type FileRole, type ReviewLane } from './model';

/**
 * Independent expectations of the stand. They restate the documented review
 * contract (docs/configuration.md, the review-chain token-economy notes and the
 * shipped profile defaults) and must never import a production predicate.
 */

export const REMEDIATION_CATEGORIES = Object.freeze([
    'leaf_test', 'structural_test', 'shared_test_helper_or_harness', 'production', 'global', 'generated_churn', 'ambiguous'
] as const);

export type RemediationCategory = typeof REMEDIATION_CATEGORIES[number];

/** How many reviews a remediation of one failed lane re-opens, from narrowest to broadest. */
export const RERUN_EFFECTS = Object.freeze(['current_lane', 'refactor_test', 'code_refactor_test', 'all_required'] as const);

export type RerunEffect = typeof RERUN_EFFECTS[number];

export const CATEGORY_EFFECT: Readonly<Record<RemediationCategory, RerunEffect>> = Object.freeze({
    leaf_test: 'current_lane',
    production: 'current_lane',
    structural_test: 'refactor_test',
    shared_test_helper_or_harness: 'refactor_test',
    global: 'all_required',
    generated_churn: 'all_required',
    ambiguous: 'all_required'
});

export const DOMAIN_LANES = Object.freeze(['api', 'db', 'security', 'infra', 'dependency'] as const satisfies readonly ReviewLane[]);

export type DomainLane = typeof DOMAIN_LANES[number];

/** Independent list of protected signals and their owners from the operator's rules. */
export const PROTECTED_SIGNAL_OWNERS = Object.freeze({
    security: 'security', auth_or_permission: 'security', secret: 'security', api_contract: 'api',
    database: 'db', schema_or_migration: 'db', dependency: 'dependency', lockfile: 'dependency', infrastructure: 'infra',
    task_criteria_or_policy: null
} as const);
export type ProtectedSignal = keyof typeof PROTECTED_SIGNAL_OWNERS;

/** Test-refactor threshold and FULL/DELTA bounds of the shipped balanced profile. */
export const CONTRACT = Object.freeze({
    testRefactorChangedLinesThreshold: 50,
    deltaEligibleLanes: REVIEW_LANES,
    forceFullCategories: ['ambiguous', 'generated_churn', 'global'] as readonly RemediationCategory[],
    maxDeltaChangedFiles: 4,
    maxDeltaChangedLines: 240,
    maxConsecutiveDeltaReviews: 3
});

export function expectedRefactorPathScope(filePath: string): boolean {
    const normalized = filePath.replace(/\\/gu, '/');
    const filename = normalized.split('/').at(-1) || '';
    const sourceOrConfig = /\.(?:java|kt|kts|groovy|scala|sc|clj|cljs|cljc|ts|tsx|js|jsx|cjs|mjs|vue|svelte|cs|fs|vb|go|py|rb|php|rs|swift|m|mm|c|cc|cpp|cxx|h|hh|hpp|hxx|ex|exs|erl|hrl|dart|lua|hs|ml|mli|jl|r|nim|zig|cr|pl|pm|sh|bash|ps1|psm1|json|ya?ml|toml|xml)$/iu.test(filename);
    return sourceOrConfig && /config|settings|options|schema|contract|dto/iu.test(filename)
        || /(?:^|\/)(?:configs?|schemas?|contracts?)(?:\/|$)/iu.test(normalized)
        || /(?:config|settings|paths)[^/]*\.(?:json|ya?ml|toml|xml)$/iu.test(filename);
}

export interface RoleExpectation {
    isTest: boolean;
    /** Domain review the file must raise; null when it must raise none. */
    domainLane: DomainLane | null;
    effect: RerunEffect;
}

export type FileOperation = 'modified' | 'added' | 'deleted';

export function expectedForRole(role: FileRole, operation: FileOperation, changedLines: number, filePath = ''): RoleExpectation {
    switch (role) {
        case 'PROD':
            return { isTest: false, domainLane: null, effect: 'current_lane' };
        case 'UNIT_TEST':
            return {
                isTest: true,
                domainLane: null,
                effect: operation !== 'added' && (operation === 'deleted' || changedLines > CONTRACT.testRefactorChangedLinesThreshold)
                    ? 'refactor_test'
                    : 'current_lane'
            };
        case 'TEST_HELPER':
        case 'TEST_FIXTURE':
            return { isTest: true, domainLane: null, effect: operation === 'added' ? 'current_lane' : 'refactor_test' };
        case 'DOCS':
            return { isTest: false, domainLane: null, effect: /\.(?:ts|html)$/iu.test(filePath) ? 'all_required' : 'current_lane' };
        case 'CONFIG':
        case 'GENERATED':
            return { isTest: false, domainLane: null, effect: 'all_required' };
        case 'DEP_MANIFEST':
            return { isTest: false, domainLane: 'dependency', effect: 'current_lane' };
        case 'INFRA':
            return { isTest: false, domainLane: 'infra', effect: 'current_lane' };
        case 'API':
            return { isTest: false, domainLane: 'api', effect: 'current_lane' };
        case 'DB_MIGRATION':
            return { isTest: false, domainLane: 'db', effect: 'current_lane' };
        case 'AUTH':
            return { isTest: false, domainLane: 'security', effect: 'current_lane' };
    }
}

/** Roles whose change crosses a protected boundary (API, database, authentication, dependencies, infrastructure). */
export const PROTECTED_ROLES: readonly FileRole[] = Object.freeze(['API', 'DB_MIGRATION', 'AUTH', 'DEP_MANIFEST', 'INFRA']);

const TEST_CATEGORY_ORDER: readonly RemediationCategory[] = ['leaf_test', 'structural_test', 'shared_test_helper_or_harness'];

/** Remediation category the contract assigns to one changed file of a role. */
export function expectedFileCategory(role: FileRole, operation: FileOperation, changedLines: number, filePath = ''): RemediationCategory {
    if (role === 'GENERATED') return 'generated_churn';
    if (role === 'TEST_HELPER' || role === 'TEST_FIXTURE') return operation === 'added' ? 'leaf_test' : 'shared_test_helper_or_harness';
    switch (expectedForRole(role, operation, changedLines, filePath).effect) {
        case 'current_lane':
            return expectedForRole(role, operation, changedLines).isTest ? 'leaf_test' : 'production';
        case 'refactor_test':
            return 'structural_test';
        case 'code_refactor_test':
            return 'shared_test_helper_or_harness';
        case 'all_required':
            return 'global';
    }
}

/**
 * Category of a whole remediation delta: compatible test classes combine into the
 * most structural one and keep their constituents; any other mix is ambiguous.
 */
export function aggregateCategories(fileCategories: readonly RemediationCategory[]): {
    category: RemediationCategory;
    constituents: RemediationCategory[];
} {
    const unique = [...new Set(fileCategories)];
    if (unique.length > 0 && unique.every((category) => TEST_CATEGORY_ORDER.includes(category))) {
        const category = [...TEST_CATEGORY_ORDER].reverse().find((entry) => unique.includes(entry)) as RemediationCategory;
        return { category, constituents: TEST_CATEGORY_ORDER.filter((entry) => unique.includes(entry)) };
    }
    if (unique.includes('production') && unique.every((entry) => entry === 'production' || TEST_CATEGORY_ORDER.includes(entry))) {
        return { category: 'production', constituents: unique.filter((entry) => TEST_CATEGORY_ORDER.includes(entry)) };
    }
    return { category: unique.length === 1 ? unique[0] : 'ambiguous', constituents: [] };
}

export interface ModeCase {
    lane: ReviewLane;
    category: RemediationCategory;
    changedFiles: number;
    changedLines: number | null;
    consecutiveDeltaReviews: number;
    protectedSignal: ProtectedSignal | null;
    initialReview: boolean;
    taskCriteriaChanged: boolean;
    policyChanged: boolean;
    scopeMembershipChanged: boolean;
    uncertainCrossFileImpact: boolean;
}

export function expectedMode(input: ModeCase): 'FULL' | 'DELTA' {
    const deltaAllowed = !input.initialReview
        && CONTRACT.deltaEligibleLanes.includes(input.lane)
        && !CONTRACT.forceFullCategories.includes(input.category)
        && input.changedFiles >= 1
        && input.changedFiles <= CONTRACT.maxDeltaChangedFiles
        && input.changedLines !== null
        && input.changedLines <= CONTRACT.maxDeltaChangedLines
        && input.consecutiveDeltaReviews < CONTRACT.maxConsecutiveDeltaReviews
        && !(input.protectedSignal && (PROTECTED_SIGNAL_OWNERS[input.protectedSignal] === null
            || PROTECTED_SIGNAL_OWNERS[input.protectedSignal] === input.lane))
        && !input.taskCriteriaChanged
        && !input.policyChanged
        && !input.scopeMembershipChanged
        && !input.uncertainCrossFileImpact;
    return deltaAllowed ? 'DELTA' : 'FULL';
}

export interface RerunCase {
    executionMode?: 'strict_sequential' | 'parallel_all' | 'test_after_code' | 'code_first_optional';
    failedLane: ReviewLane;
    category: RemediationCategory;
    requiredLanes: readonly ReviewLane[];
    /** Per-file categories of a compatible test remediation; their rules combine (1.4.4 contract). */
    constituentCategories: readonly RemediationCategory[];
}

function lanesForCategory(category: RemediationCategory, failedLane: ReviewLane, required: readonly ReviewLane[]): ReviewLane[] {
    // Only a failed lane that is no longer required falls back to every required lane.
    const keepOrFallBack = (lanes: readonly ReviewLane[]): ReviewLane[] => {
        const selected = required.filter((lane) => lanes.includes(lane));
        return selected.length > 0 || required.includes(failedLane) ? selected : [...required];
    };
    switch (CATEGORY_EFFECT[category]) {
        case 'current_lane':
            return keepOrFallBack([failedLane]);
        case 'refactor_test':
            return keepOrFallBack(['refactor', 'test']);
        case 'code_refactor_test':
            return keepOrFallBack(['refactor', 'test']);
        case 'all_required':
            return [...required];
    }
}

/** Lanes the category rules of the fix re-open, in strict sequential order. */
export function categoryRerunLanes(input: RerunCase): ReviewLane[] {
    const required = REVIEW_LANES.filter((lane) => input.requiredLanes.includes(lane));
    const selected = new Set<ReviewLane>();
    for (const category of new Set([input.category, ...input.constituentCategories])) {
        for (const lane of lanesForCategory(category, input.failedLane, required)) selected.add(lane);
    }
    return required.filter((lane) => selected.has(lane));
}

/** Lanes re-opened after the remediation: the category lanes plus the failed lane, whose verdict is never reusable. */
export function expectedRerunLanes(input: RerunCase): ReviewLane[] {
    const selected = new Set<ReviewLane>([...categoryRerunLanes(input), input.failedLane]);
    return REVIEW_LANES.filter((lane) => input.requiredLanes.includes(lane) && selected.has(lane));
}
