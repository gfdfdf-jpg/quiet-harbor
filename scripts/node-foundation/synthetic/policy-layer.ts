import {
    buildDefaultReviewRemediationModePolicy,
    evaluateReviewRemediationMode
} from '../../../src/policy/review-remediation-mode-policy';
import {
    buildDefaultReviewRemediationRerunPolicy,
    resolveReviewRemediationRerunLanes
} from '../../../src/policy/review-remediation-rerun-policy';
import { compileReviewDependencyGraph } from '../../../src/core/review-dependency-graph';
import { REVIEW_LANES, createRandom, type LayerResult, type ReviewLane, type StandFinding } from './model';
import {
    REMEDIATION_CATEGORIES,
    PROTECTED_SIGNAL_OWNERS,
    expectedMode,
    expectedRerunLanes,
    type ModeCase,
    type RemediationCategory,
    type RerunCase
} from './oracle';

export type PolicySelection = { kind: 'exhaustive' } | { kind: 'sample'; seed: number; fraction: number };

const TEST_CATEGORIES: readonly RemediationCategory[] = ['leaf_test', 'structural_test', 'shared_test_helper_or_harness'];
const FILE_COUNTS = [0, 1, 4, 5];
const LINE_COUNTS: ReadonlyArray<number | null> = [null, 0, 49, 50, 51, 239, 240, 241];
const DELTA_DEPTHS = [0, 1, 2, 3];
const FLAG_NAMES = ['initialReview', 'taskCriteriaChanged', 'policyChanged', 'scopeMembershipChanged', 'uncertainCrossFileImpact'] as const;

function* modeCases(): Generator<ModeCase> {
    for (const lane of REVIEW_LANES) for (const category of REMEDIATION_CATEGORIES)
        for (const changedFiles of FILE_COUNTS) for (const changedLines of LINE_COUNTS)
            for (const consecutiveDeltaReviews of DELTA_DEPTHS) for (const protectedSignal of [null, ...Object.keys(PROTECTED_SIGNAL_OWNERS) as Array<keyof typeof PROTECTED_SIGNAL_OWNERS>])
                for (let flags = 0; flags < 1 << FLAG_NAMES.length; flags += 1) {
                    const flag = (index: number) => (flags & (1 << index)) !== 0;
                    yield {
                        lane, category, changedFiles, changedLines, consecutiveDeltaReviews, protectedSignal,
                        initialReview: flag(0), taskCriteriaChanged: flag(1), policyChanged: flag(2),
                        scopeMembershipChanged: flag(3), uncertainCrossFileImpact: flag(4)
                    };
                }
}

/** Category plus constituents as the 1.4.4 delta classifier aggregates compatible test classes. */
function* categoryShapes(): Generator<{ category: RemediationCategory; constituents: RemediationCategory[] }> {
    for (const category of REMEDIATION_CATEGORIES.filter((entry) => !TEST_CATEGORIES.includes(entry))) {
        yield { category, constituents: [] };
    }
    for (let mask = 1; mask < 1 << TEST_CATEGORIES.length; mask += 1) {
        const constituents = TEST_CATEGORIES.filter((_, index) => (mask & (1 << index)) !== 0);
        const category = constituents.includes('shared_test_helper_or_harness') ? 'shared_test_helper_or_harness'
            : constituents.includes('structural_test') ? 'structural_test' : 'leaf_test';
        yield { category, constituents };
    }
}

function* rerunCases(): Generator<RerunCase> {
    for (const failedLane of REVIEW_LANES) {
        const others = REVIEW_LANES.filter((lane) => lane !== failedLane);
        for (let mask = 0; mask < 1 << others.length; mask += 1) {
            const requiredLanes: ReviewLane[] = [failedLane, ...others.filter((_, index) => (mask & (1 << index)) !== 0)];
            for (const shape of categoryShapes()) for (const executionMode of ['strict_sequential', 'parallel_all', 'test_after_code', 'code_first_optional'] as const) {
                yield { failedLane, category: shape.category, requiredLanes, constituentCategories: shape.constituents, executionMode };
            }
        }
    }
}

export function observeMode(input: ModeCase): 'FULL' | 'DELTA' {
    const assessment = evaluateReviewRemediationMode({
        policy: buildDefaultReviewRemediationModePolicy(),
        reviewType: input.lane,
        category: input.category,
        changedFilesCount: input.changedFiles,
        changedLinesTotal: input.changedLines,
        consecutiveDeltaReviews: input.consecutiveDeltaReviews,
        protectedBoundarySignals: input.protectedSignal ? [input.protectedSignal] : [],
        initialReview: input.initialReview,
        taskCriteriaChanged: input.taskCriteriaChanged,
        policyChanged: input.policyChanged,
        scopeMembershipChanged: input.scopeMembershipChanged,
        uncertainCrossFileImpact: input.uncertainCrossFileImpact
    });
    return assessment.full_review_types?.includes(input.lane) ? 'FULL' : assessment.mode;
}

export function observeRerunLanes(input: RerunCase): string[] {
    return resolveReviewRemediationRerunLanes({
        policy: buildDefaultReviewRemediationRerunPolicy(),
        category: input.category,
        constituentCategories: input.constituentCategories,
        currentReviewType: input.failedLane,
        requiredReviews: Object.fromEntries(input.requiredLanes.map((lane) => [lane, true])),
        reviewExecutionPolicyMode: input.executionMode ?? 'strict_sequential',
        reviewDependencyGraph: compileReviewDependencyGraph({ catalogLaneIds: REVIEW_LANES, activeLaneIds: input.requiredLanes,
            requiredReviewIds: input.requiredLanes, mode: input.executionMode ?? 'strict_sequential' })
    }).ordered_rerun_lanes;
}

export function compareMode(input: ModeCase, observed: 'FULL' | 'DELTA'): StandFinding | null {
    const expected = expectedMode(input);
    if (observed === expected) return null;
    return {
        id: `policy-mode:${JSON.stringify(input)}`,
        layer: 'policy-mode',
        kind: observed === 'FULL' ? 'economy' : 'safety',
        summary: `remediation review mode ${observed}; contract expects ${expected}`,
        detail: { input, expected, observed }
    };
}

export function compareRerunLanes(input: RerunCase, observed: readonly string[]): StandFinding | null {
    const expected = expectedRerunLanes(input);
    if (JSON.stringify(observed) === JSON.stringify(expected)) return null;
    const missing = expected.filter((lane) => !observed.includes(lane));
    return {
        id: `policy-rerun:${JSON.stringify(input)}`,
        layer: 'policy-rerun',
        kind: missing.length > 0 ? 'safety' : 'economy',
        summary: `re-opened ${observed.join(',') || 'none'}; contract expects ${expected.join(',')}`,
        detail: { input, expected, observed }
    };
}

function selected(selection: PolicySelection, random: () => number): boolean {
    return selection.kind === 'exhaustive' || random() < selection.fraction;
}

export function runPolicyLayers(selection: PolicySelection): LayerResult[] {
    const random = createRandom(selection.kind === 'sample' ? selection.seed : 0);
    const mode: LayerResult = { layer: 'policy-mode', cases: 0, findings: [] };
    for (const input of modeCases()) {
        if (!selected(selection, random)) continue;
        mode.cases += 1;
        const finding = compareMode(input, observeMode(input));
        if (finding) mode.findings.push(finding);
    }
    const rerun: LayerResult = { layer: 'policy-rerun', cases: 0, findings: [] };
    for (const input of rerunCases()) {
        if (!selected(selection, random)) continue;
        rerun.cases += 1;
        const finding = compareRerunLanes(input, observeRerunLanes(input));
        if (finding) rerun.findings.push(finding);
    }
    return [mode, rerun];
}
