import {
    appendTaskEvent,
    createTempRepo,
    fileSha256,
    fs,
    getOrchestratorRoot,
    getReviewsRoot,
    path
} from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import { buildLeafTestDeltaClassification } from '../../gates/next-step/next-step-benchmark-remediation-fixture';
import { resolveRuntimeDecisionInputs } from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import { compileReviewDependencyGraph } from '../../../../src/core/review-dependency-graph';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import { buildDefaultReviewRemediationModePolicy } from '../../../../src/policy/review-remediation-mode-policy';
import { buildDefaultReviewRemediationRerunPolicy } from '../../../../src/policy/review-remediation-rerun-policy';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../../src/policy/review-trigger-policy';
import {
    FILE_ROLES,
    REVIEW_LANES,
    createRandom,
    pick,
    type FileRole,
    type ReviewLane,
    type StandFinding
} from '../../../../scripts/node-foundation/synthetic/model';
import {
    aggregateCategories,
    categoryRerunLanes,
    expectedFileCategory,
    expectedForRole,
    expectedMode,
    expectedRerunLanes,
    expectedRefactorPathScope
} from '../../../../scripts/node-foundation/synthetic/oracle';
import { STACK_ADAPTERS } from '../../../../scripts/node-foundation/synthetic/stacks';

/**
 * Remediation decision engine of the synthetic stand. A scenario is one failed
 * review and its fix; the engine runs the real restart-cycle decision path
 * (delta classification, FULL/DELTA guards, rerun and reuse decision) in-process
 * and compares it with the independent oracle.
 */

export interface ScopeFile {
    role: FileRole;
    path: string;
    lines: number;
}

export interface FixEdit {
    role: FileRole;
    path: string;
    operation: 'modified' | 'added' | 'deleted';
    changedLines: number;
}

export interface EngineScenario {
    id: string;
    stack: string;
    failedLane: ReviewLane;
    requiredLanes: ReviewLane[];
    scope: ScopeFile[];
    fix: FixEdit[];
    /** A reviewed scope file that left the task diff, such as an edit restored to Git HEAD. */
    leftScope?: string;
}

export interface EngineObservation {
    category: string;
    failedLaneMode: string;
    failedLaneReason: string;
    invalidatedLanes: string[];
    laneDecisions: Array<{ lane: string; mode: string; invalidated: boolean; reuseEligible: boolean; satisfied: boolean }>;
    fullReviewReasons: string[];
}

export interface EngineExpectation {
    category: string;
    failedLaneMode: 'FULL' | 'DELTA';
    invalidatedLanes: ReviewLane[];
    /** Whether the category's rerun rule itself names the failed lane. */
    ruleCoversFailedLane: boolean;
}

const PROBE_FILE = 'docs/review-probe.md';
const PROBE_CONTENT = 'assert.equal(actual, expected);\n';
const LINE_STEPS = [1, 10, 49, 50, 51, 120, 239, 240, 241, 300];

function requireSha256(file: string): string {
    const sha256 = fileSha256(file);
    if (!sha256) throw new Error(`Synthetic stand could not hash ${file}`);
    return sha256;
}

function fileContent(file: string, lines: number, offset = 0): string {
    return Array.from({ length: lines }, (_, index) => `${file} line ${offset + index + 1}`).join('\n') + '\n';
}

/** Required lanes follow the contract: code and test always, plus the domain lanes the scope roles raise. */
export function requiredLanesForScope(scope: readonly ScopeFile[]): ReviewLane[] {
    const lanes = new Set<ReviewLane>(['code', 'test']);
    for (const file of scope) {
        const domain = expectedForRole(file.role, 'modified', 1).domainLane;
        if (domain) lanes.add(domain);
    }
    return REVIEW_LANES.filter((lane) => lanes.has(lane));
}

export function generateScenario(seed: number): EngineScenario {
    const random = createRandom(seed);
    const stack = pick(random, STACK_ADAPTERS);
    const scope: ScopeFile[] = [];
    const scopeSize = 2 + Math.floor(random() * 7);
    for (let attempt = 0; attempt < 20 && scope.length < scopeSize; attempt += 1) {
        const role = pick(random, FILE_ROLES);
        const file = pick(random, stack.paths[role]);
        if (!scope.some((entry) => entry.path === file)) scope.push({ role, path: file, lines: 5 + Math.floor(random() * 60) });
    }
    const fix: FixEdit[] = [];
    const fixSize = 1 + Math.floor(random() * 5);
    for (let attempt = 0; attempt < 20 && fix.length < fixSize; attempt += 1) {
        if (random() < 0.15) {
            const role = pick(random, FILE_ROLES);
            const file = stack.paths[role].find((candidate) => !scope.some((entry) => entry.path === candidate)
                && !fix.some((entry) => entry.path === candidate));
            if (file) fix.push({ role, path: file, operation: 'added', changedLines: pick(random, LINE_STEPS) });
            continue;
        }
        const target = pick(random, scope);
        if (!fix.some((entry) => entry.path === target.path)) {
            const deleted = random() < 0.1;
            fix.push({
                role: target.role,
                path: target.path,
                operation: deleted ? 'deleted' : 'modified',
                changedLines: deleted ? target.lines : pick(random, LINE_STEPS)
            });
        }
    }
    const lanes = new Set<ReviewLane>(requiredLanesForScope(scope));
    if (random() < 0.3) lanes.add('refactor');
    if (random() < 0.2) lanes.add('performance');
    const requiredLanes = REVIEW_LANES.filter((lane) => lanes.has(lane));
    const untouched = scope.filter((entry) => !fix.some((edit) => edit.path === entry.path));
    const scenario = { id: `seed-${seed}`, stack: stack.id, failedLane: pick(random, requiredLanes), requiredLanes, scope, fix };
    return untouched.length > 0 && random() < 0.1 ? { ...scenario, leftScope: pick(random, untouched).path } : scenario;
}

export function expectScenario(scenario: EngineScenario): EngineExpectation {
    const ordinaryDocument = (file: { role: FileRole; path: string }): boolean => file.role === 'DOCS'
        && expectedForRole(file.role, 'modified', 1, file.path).effect === 'current_lane';
    const edits = scenario.fix.filter((edit) => !ordinaryDocument(edit));
    const documentsOnly = edits.length === 0;
    const { category, constituents } = aggregateCategories(
        (documentsOnly ? scenario.fix : edits).map((edit) => expectedFileCategory(edit.role, edit.operation, edit.changedLines, edit.path))
    );
    const changedLines = edits.reduce((total, edit) => total + edit.changedLines, 0);
    const owners = edits.map((edit) => expectedForRole(edit.role, edit.operation, edit.changedLines).domainLane);
    const scopeMembershipChanged = (scenario.leftScope !== undefined
        && !scenario.scope.some((file) => file.path === scenario.leftScope && (ordinaryDocument(file) || expectedForRole(file.role, 'modified', 1).isTest)))
        || edits.some((edit) => edit.operation === 'added' && !expectedForRole(edit.role, edit.operation, edit.changedLines).isTest);
    const nonEditRequiresFull = edits.some((edit) => edit.operation !== 'modified'
        && !(edit.operation === 'added' && expectedForRole(edit.role, edit.operation, edit.changedLines).isTest));
    const failedLaneMode = documentsOnly || nonEditRequiresFull || owners.includes(scenario.failedLane as typeof owners[number]) ? 'FULL' : expectedMode({
        lane: scenario.failedLane,
        category,
        changedFiles: edits.length,
        changedLines,
        consecutiveDeltaReviews: 0,
        protectedSignal: null,
        initialReview: false,
        taskCriteriaChanged: false,
        policyChanged: false,
        scopeMembershipChanged,
        uncertainCrossFileImpact: false
    });
    const rerunCase = {
        failedLane: scenario.failedLane,
        category,
        requiredLanes: scenario.requiredLanes,
        constituentCategories: constituents
    };
    const scopeLanes = new Set<ReviewLane>();
    for (const edit of edits) {
        const role = expectedForRole(edit.role, edit.operation, edit.changedLines);
        if (role.domainLane) scopeLanes.add(role.domainLane);
        if (!role.isTest && expectedRefactorPathScope(edit.path)) scopeLanes.add('refactor');
        if (role.isTest) scopeLanes.add('test');
        else if (['PROD', 'API', 'AUTH', 'DB_MIGRATION'].includes(edit.role)) {
            scopeLanes.add('code');
            scopeLanes.add('test');
        }
    }
    const invalidatedLanes = scenario.requiredLanes.filter((lane) => scopeMembershipChanged
        || (documentsOnly ? lane === scenario.failedLane : expectedRerunLanes(rerunCase).includes(lane) || scopeLanes.has(lane)));
    return {
        category,
        failedLaneMode,
        invalidatedLanes: REVIEW_LANES.filter((lane) => invalidatedLanes.includes(lane)),
        ruleCoversFailedLane: categoryRerunLanes(rerunCase).includes(scenario.failedLane)
    };
}

/** Runs the real remediation decision path for one scenario in a disposable repository. */
export function observeScenario(scenario: EngineScenario): EngineObservation {
    const repoRoot = createTempRepo();
    try {
        fs.copyFileSync(path.resolve('template/config/paths.json'),
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'paths.json'));
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskId = `T-SYN-${scenario.id}`;
        const profilePolicySnapshot = {
            review_trigger_policy: DEFAULT_REVIEW_TRIGGER_POLICY,
            review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy(),
            review_remediation_rerun_policy_diagnostics: ['synthetic stand rerun policy'],
            review_remediation_mode_policy: buildDefaultReviewRemediationModePolicy(),
            review_remediation_mode_policy_diagnostics: ['synthetic stand mode policy']
        };
        const scopeFiles = [...scenario.scope.map((entry) => entry.path), PROBE_FILE].sort();
        const preflightPayload = { changed_files: scopeFiles, required_reviews: Object.fromEntries(
            scenario.requiredLanes.map((lane) => [lane, true])) };
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(preflightPath, `${JSON.stringify(preflightPayload)}\n`, 'utf8');
        buildLeafTestDeltaClassification({
            repoRoot,
            taskId,
            reviewType: scenario.failedLane,
            changedFile: PROBE_FILE,
            preflightPath,
            preflightSha256: requireSha256(preflightPath),
            profilePolicySnapshot,
            unchangedScopeFiles: Object.fromEntries(scenario.scope.map((entry) => [entry.path, fileContent(entry.path, entry.lines)]))
        });
        // The fixture remediates its probe file; restore it so the fix below is the whole delta.
        fs.writeFileSync(path.join(repoRoot, ...PROBE_FILE.split('/')), PROBE_CONTENT, 'utf8');
        for (const edit of scenario.fix) {
            const target = path.join(repoRoot, ...edit.path.split('/'));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (edit.operation === 'added') {
                fs.writeFileSync(target, fileContent(edit.path, edit.changedLines), 'utf8');
            } else if (edit.operation === 'deleted') {
                fs.rmSync(target);
            } else {
                const lines = scenario.scope.find((entry) => entry.path === edit.path)?.lines ?? 0;
                fs.appendFileSync(target, fileContent(edit.path, edit.changedLines, lines), 'utf8');
            }
        }
        const baselinePath = path.join(reviewsRoot, `${taskId}-${scenario.failedLane}-remediation-baseline.json`);
        const baselineSha256 = requireSha256(baselinePath);
        const immutableBaselinePath = path.join(reviewsRoot,
            `${taskId}-${scenario.failedLane}-remediation-baseline-${baselineSha256}.json`);
        fs.copyFileSync(baselinePath, immutableBaselinePath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'Synthetic failed FULL review.', {
            review_type: scenario.failedLane,
            review_execution_mode: 'FULL',
            remediation_baseline_snapshot_path: immutableBaselinePath,
            remediation_baseline_snapshot_sha256: baselineSha256
        });
        const currentChangedFiles = [...new Set([...scopeFiles, ...scenario.fix.map((edit) => edit.path)])]
            .filter((file) => file !== scenario.leftScope).sort();
        const requiredReviews = Object.fromEntries(scenario.requiredLanes.map((lane) => [lane, true]));
        const inputs = resolveRuntimeDecisionInputs({
            repoRoot,
            taskId,
            remediationReviewType: scenario.failedLane,
            requiredReviewTypes: scenario.requiredLanes,
            remediationFixClassification: {
                category: 'production',
                reason: 'synthetic remediation of the failed review finding',
                blocked_before_reuse: false,
                invalidated_review_types: [scenario.failedLane]
            },
            profilePolicySnapshot,
            currentChangedFiles,
            reviewTriggerPolicy: DEFAULT_REVIEW_TRIGGER_POLICY,
            allowAuthenticatedDelta: true,
            preflightPayload: { ...preflightPayload, changed_files: currentChangedFiles },
            authenticatedTaskCriteria: 'Synthetic remediation task.',
            currentTaskCriteria: 'Synthetic remediation task.'
        });
        const decision = resolveAuthoritativeReviewRemediationDecision({
            taskId,
            currentReviewType: inputs.currentReviewType,
            classification: inputs.classification,
            modePolicyValidationInputs: inputs.modePolicyValidationInputs,
            requiredReviews,
            reviewExecutionPolicyMode: 'strict_sequential',
            // Every task carries this graph unless its profile declares one.
            reviewDependencyGraph: compileReviewDependencyGraph({
                catalogLaneIds: [...REVIEW_LANES],
                activeLaneIds: [...REVIEW_LANES],
                requiredReviewIds: scenario.requiredLanes,
                mode: 'strict_sequential'
            })
        });
        const classification = inputs.classification as { source: string; delta?: { full_review_reasons: string[] };
            classification?: { reason: string } };
        const failedLaneDecision = decision.lane_decisions.find((entry) => entry.review_type === scenario.failedLane);
        return {
            category: decision.category,
            failedLaneMode: decision.status === 'BLOCKED'
                ? `BLOCKED: ${decision.blocked_reasons.join(' ')}`
                : failedLaneDecision?.satisfied ? 'SATISFIED' : failedLaneDecision?.mode ?? 'MISSING',
            failedLaneReason: failedLaneDecision ? `${failedLaneDecision.reason_code}: ${failedLaneDecision.reason}` : '',
            invalidatedLanes: REVIEW_LANES.filter((lane) => decision.invalidated_review_types.includes(lane)),
            laneDecisions: decision.lane_decisions.map((entry) => ({
                lane: entry.review_type,
                mode: entry.mode,
                invalidated: entry.invalidated,
                reuseEligible: entry.reuse_eligible,
                satisfied: entry.satisfied
            })),
            fullReviewReasons: classification.delta?.full_review_reasons
                ?? (classification.classification ? [classification.classification.reason] : [])
        };
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

/** Finding ids name the root cause, not the sampled file mix, so one defect keeps one id across seeds. */
function signature(aspect: string, expected: string, observed: string, cause: string): string {
    return `engine:${aspect}:${expected}->${observed}:${cause}`;
}

export function compareScenario(scenario: EngineScenario, expected: EngineExpectation, observed: EngineObservation): StandFinding[] {
    const detail = { scenario, expected, observed };
    const findings: StandFinding[] = [];
    if (observed.failedLaneMode !== expected.failedLaneMode) {
        findings.push({
            id: signature('mode', expected.failedLaneMode, observed.failedLaneMode.split(':')[0],
                expected.ruleCoversFailedLane ? `category-${expected.category}` : 'failed-lane-outside-rerun-rule'),
            layer: 'engine',
            kind: observed.failedLaneMode === 'FULL' ? 'economy'
                : observed.failedLaneMode.startsWith('BLOCKED') ? 'contract' : 'safety',
            summary: `failed ${scenario.failedLane} review re-runs ${observed.failedLaneMode}; contract expects ${expected.failedLaneMode}`,
            detail
        });
    }
    const missing = expected.invalidatedLanes.filter((lane) => !observed.invalidatedLanes.includes(lane));
    const extra = observed.invalidatedLanes.filter((lane) => !(expected.invalidatedLanes as string[]).includes(lane));
    if (missing.length > 0) {
        findings.push({
            id: signature('rerun-missing', expected.category, observed.category, `lanes-${missing.join('+')}`),
            layer: 'engine', kind: 'safety',
            summary: `reviews not re-opened: ${missing.join(', ')}`, detail
        });
    }
    if (extra.length > 0) {
        findings.push({
            id: signature('rerun-extra', expected.category, observed.category, `lanes-${extra.join('+')}`),
            layer: 'engine', kind: 'economy',
            summary: `reviews re-opened without need: ${extra.join(', ')}`, detail
        });
    }
    findings.push(...compareLaneDecisions(scenario, expected, observed));
    return findings;
}

/** Every required lane, not only the failed one: no receipts exist yet, so nothing may count as reused or satisfied. */
function compareLaneDecisions(scenario: EngineScenario, expected: EngineExpectation, observed: EngineObservation): StandFinding[] {
    const detail = { scenario, expected, observed };
    const findings: StandFinding[] = [];
    for (const lane of scenario.requiredLanes.filter((required) => !observed.laneDecisions.some((entry) => entry.lane === required))) {
        findings.push({
            id: signature('lane-state', 'decided', 'missing', `lane-${lane}`),
            layer: 'engine', kind: 'safety',
            summary: `required ${lane} review has no decision`, detail
        });
    }
    for (const lane of observed.laneDecisions) {
        const rerun = (expected.invalidatedLanes as string[]).includes(lane.lane);
        if (lane.satisfied || lane.mode === 'REUSE') {
            findings.push({
                id: signature('lane-state', 'pending', lane.satisfied ? 'satisfied' : 'reuse', `lane-${lane.lane}`),
                layer: 'engine', kind: 'safety',
                summary: `${lane.lane} review counts as done before any evidence exists`, detail
            });
        }
        if (lane.invalidated !== rerun || lane.reuseEligible === rerun) {
            findings.push({
                id: signature('lane-state', rerun ? 'rerun' : 'reuse-pending', rerun ? 'reuse-pending' : 'rerun', `lane-${lane.lane}`),
                layer: 'engine', kind: rerun ? 'safety' : 'economy',
                summary: `${lane.lane} review decision disagrees with the rerun set`, detail
            });
        }
        if (rerun && lane.lane !== scenario.failedLane && lane.mode !== 'FULL') {
            findings.push({
                id: signature('lane-mode', 'FULL', lane.mode, `lane-${lane.lane}`),
                layer: 'engine', kind: 'safety',
                summary: `unreviewed ${lane.lane} review runs ${lane.mode}; initial reviews require FULL`, detail
            });
        }
    }
    return findings;
}

export function runScenario(scenario: EngineScenario): { expected: EngineExpectation; observed: EngineObservation; findings: StandFinding[] } {
    const expected = expectScenario(scenario);
    const observed = observeScenario(scenario);
    return { expected, observed, findings: compareScenario(scenario, expected, observed) };
}

/** Removes untouched scope files and fix edits while the same finding signature still reproduces. */
export function minimizeScenario(scenario: EngineScenario, findingId: string): EngineScenario {
    const reproduces = (candidate: EngineScenario) => candidate.fix.length > 0
        && runScenario(candidate).findings.some((finding) => finding.id === findingId);
    let current = scenario;
    const fixedPaths = new Set(current.fix.map((edit) => edit.path));
    for (const file of current.scope.filter((entry) => !fixedPaths.has(entry.path) && entry.path !== current.leftScope)) {
        const candidate = { ...current, scope: current.scope.filter((entry) => entry !== file) };
        candidate.requiredLanes = requiredLanesForScope(candidate.scope);
        if (candidate.requiredLanes.includes(candidate.failedLane) && reproduces(candidate)) current = candidate;
    }
    for (const edit of [...current.fix]) {
        const candidate = { ...current, fix: current.fix.filter((entry) => entry !== edit) };
        if (reproduces(candidate)) current = candidate;
    }
    return current;
}
