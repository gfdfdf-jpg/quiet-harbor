import {
    appendTaskEvent,
    assert,
    createTempRepo,
    fileSha256,
    fs,
    getOrchestratorRoot,
    getReviewsRoot,
    path
} from './gates-review-cycle-fixtures';
import test from 'node:test';
import {
    resolveRemediationDeltaReviewTriggers,
    resolveRuntimeDecisionInputs
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import { resolveAuthoritativeReviewRemediationDecision } from '../../../../../../src/gates/review-remediation/review-remediation-recovery-routing';
import type { ReviewRemediationDeltaClassification } from '../../../../../../src/gates/review-remediation/review-remediation-delta';
import { buildDefaultReviewRemediationModePolicy } from '../../../../../../src/policy/review-remediation-mode-policy';
import { buildDefaultReviewRemediationRerunPolicy } from '../../../../../../src/policy/review-remediation-rerun-policy';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../../../../src/policy/review-trigger-policy';
import { computeTaskCriteriaBinding } from '../../../../../../src/gates/review-context/review-context-task-criteria-binding';
import { buildLeafTestDeltaClassification } from '../../../../gates/next-step/next-step-benchmark-remediation-fixture';

// Reviewed task-scope files that stay byte-identical after the failed review.
const UNCHANGED_PROTECTED_SCOPE: Readonly<Record<string, string>> = {
    'package.json': '{ "name": "billing", "version": "1.0.0" }\n',
    'src/routes/invoice-routes.ts': 'export const routes = ["/invoices"];\n',
    'src/policy/review-remediation-mode-policy.ts': 'export const policy = "frozen";\n',
    'TASK.md': '# TASK.md\n'
};

const TRIGGER_POLICY = {
    test_path_regexes: ['(^|/)tests?/'],
    test_refactor_structural_path_regexes: ['(^|/)tests?/helpers?/'],
    test_refactor_changed_lines_threshold: 50
};

interface ScenarioResult {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    requiredReviews: Record<string, boolean>;
    decision: ReturnType<typeof resolveRuntimeDecisionInputs>;
}

function runRemediationScenario(options: {
    taskId: string;
    reviewType: string;
    remediatedFile: string;
    unchangedScopeFiles?: Readonly<Record<string, string>>;
    requiredReviews: Record<string, boolean>;
    preflightTriggers: Record<string, unknown>;
    corruptPathsConfig?: boolean;
    invalidSecurityRegex?: boolean;
    /** Writes task criteria sources and returns the review context the failed review ran against. */
    reviewedContext?: (repoRoot: string) => Record<string, unknown>;
    /** Edits made after the failed review, before the restart decides DELTA or FULL. */
    afterFailedReview?: (repoRoot: string) => void;
    taskCriteria?: { authenticated: string; current: string; currentTaskIntent?: string };
}): ScenarioResult {
    const repoRoot = createTempRepo();
    const reviewContext = options.reviewedContext?.(repoRoot);
    // The shared review-cycle fixture treats every file as a security trigger; use the shipped triggers instead.
    fs.copyFileSync(
        path.resolve('template/config/paths.json'),
        path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'paths.json')
    );
    const reviewsRoot = getReviewsRoot(repoRoot);
    const profilePolicySnapshot = {
        review_remediation_rerun_policy: buildDefaultReviewRemediationRerunPolicy(),
        review_remediation_rerun_policy_diagnostics: ['protected-signal fixture rerun policy'],
        review_remediation_mode_policy: buildDefaultReviewRemediationModePolicy(),
        review_remediation_mode_policy_diagnostics: ['protected-signal fixture mode policy']
    };
    const scopeFiles = [options.remediatedFile, ...Object.keys(options.unchangedScopeFiles ?? {})].sort();
    const preflightPayload = {
        changed_files: scopeFiles,
        triggers: options.preflightTriggers,
        required_reviews: options.requiredReviews
    };
    const preflightPath = path.join(reviewsRoot, `${options.taskId}-preflight.json`);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(preflightPath, `${JSON.stringify(preflightPayload)}\n`, 'utf8');
    const preflightSha256 = fileSha256(preflightPath);
    assert.ok(preflightSha256);
    buildLeafTestDeltaClassification({
        repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        changedFile: options.remediatedFile,
        preflightPath,
        preflightSha256,
        profilePolicySnapshot,
        unchangedScopeFiles: options.unchangedScopeFiles,
        reviewContext
    });
    if (options.corruptPathsConfig) {
        fs.writeFileSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'paths.json'), '{ "triggers": ', 'utf8');
    }
    if (options.invalidSecurityRegex) {
        const pathsPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'paths.json');
        const pathsConfig = JSON.parse(fs.readFileSync(pathsPath, 'utf8')) as { triggers: Record<string, string[]> };
        pathsConfig.triggers.security = ['(unclosed'];
        fs.writeFileSync(pathsPath, JSON.stringify(pathsConfig), 'utf8');
    }
    const mutableBaselinePath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}-remediation-baseline.json`);
    const baselineSha256 = fileSha256(mutableBaselinePath);
    assert.ok(baselineSha256);
    const immutableBaselinePath = path.join(
        reviewsRoot,
        `${options.taskId}-${options.reviewType}-remediation-baseline-${baselineSha256}.json`
    );
    fs.copyFileSync(mutableBaselinePath, immutableBaselinePath);
    appendTaskEvent(getOrchestratorRoot(repoRoot), options.taskId, 'REVIEW_RECORDED', 'PASS', 'Failed FULL review recorded.', {
        review_type: options.reviewType,
        review_execution_mode: 'FULL',
        remediation_baseline_snapshot_path: immutableBaselinePath,
        remediation_baseline_snapshot_sha256: baselineSha256
    });
    options.afterFailedReview?.(repoRoot);
    const decision = resolveRuntimeDecisionInputs({
        repoRoot,
        taskId: options.taskId,
        remediationReviewType: options.reviewType,
        requiredReviewTypes: Object.keys(options.requiredReviews).filter((lane) => options.requiredReviews[lane]),
        remediationFixClassification: {
            category: 'production',
            reason: 'fixture remediation of the failed lane finding',
            blocked_before_reuse: false,
            invalidated_review_types: [options.reviewType]
        },
        profilePolicySnapshot,
        currentChangedFiles: scopeFiles,
        reviewTriggerPolicy: TRIGGER_POLICY,
        allowAuthenticatedDelta: true,
        preflightPayload,
        authenticatedTaskCriteria: options.taskCriteria?.authenticated ?? 'Fix the invoice rounding defect.',
        currentTaskCriteria: options.taskCriteria?.current ?? 'Fix the invoice rounding defect.',
        currentTaskIntent: options.taskCriteria?.currentTaskIntent
    });
    return { repoRoot, taskId: options.taskId, reviewType: options.reviewType, requiredReviews: options.requiredReviews, decision };
}

function deltaOf(result: ScenarioResult): ReviewRemediationDeltaClassification {
    const classification = result.decision.classification as { source: string; delta?: ReviewRemediationDeltaClassification };
    assert.equal(classification.source, 'delta', JSON.stringify(result.decision.classification));
    assert.ok(classification.delta);
    return classification.delta;
}

function assertDelta(result: ScenarioResult): void {
    const delta = deltaOf(result);
    assert.equal(delta.full_review_required, false, JSON.stringify(delta.full_review_reasons));
    assert.equal(delta.mode_policy_assessment?.mode, 'DELTA');
    assert.deepEqual(delta.mode_policy_assessment?.protected_boundary_signals, []);
}

function assertFull(result: ScenarioResult, reason: RegExp): void {
    const delta = deltaOf(result);
    assert.equal(delta.full_review_required, true);
    assert.equal(delta.mode_policy_assessment?.mode, 'FULL');
    assert.match(delta.full_review_reasons.join('\n'), reason);
}

function cleanup(result: ScenarioResult): void {
    fs.rmSync(result.repoRoot, { recursive: true, force: true });
}

test('code remediation of one production file stays DELTA when protected files elsewhere in the task scope are unchanged', () => {
    const result = runRemediationScenario({
        taskId: 'T-R7-1-code-unchanged-protected-scope',
        reviewType: 'code',
        remediatedFile: 'src/invoice.ts',
        unchangedScopeFiles: UNCHANGED_PROTECTED_SCOPE,
        requiredReviews: { code: true, api: true, dependency: true, test: true },
        preflightTriggers: { api: true, dependency: true, api_path_changed_files: ['src/routes/invoice-routes.ts'] }
    });
    try {
        assertDelta(result);
        assert.deepEqual(deltaOf(result).changed_files, ['src/invoice.ts']);
        assert.equal(result.decision.modePolicyValidationInputs?.policyChanged, false);
        assert.equal(result.decision.modePolicyValidationInputs?.taskCriteriaChanged, false);
        assert.deepEqual(result.decision.modePolicyValidationInputs?.protectedBoundarySignals, []);
    } finally {
        cleanup(result);
    }
});

test('a small production config-package fix follows ordinary scope and DELTA rules', () => {
    const result = runRemediationScenario({
        taskId: 'T-CONFIG-PACKAGE', reviewType: 'code',
        remediatedFile: 'src/main/java/com/acme/integration/config/RestConfig.java',
        requiredReviews: { code: true, security: true, test: true }, preflightTriggers: {}
    });
    try {
        assertDelta(result);
        assert.equal(deltaOf(result).category, 'production');
        const decision = resolveAuthoritativeReviewRemediationDecision({
            taskId: result.taskId, currentReviewType: result.decision.currentReviewType,
            classification: result.decision.classification, modePolicyValidationInputs: result.decision.modePolicyValidationInputs,
            requiredReviews: result.requiredReviews, reviewExecutionPolicyMode: 'strict_sequential'
        });
        assert.equal(decision.lane_decisions.find(lane => lane.review_type === 'code')?.mode, 'DELTA');
        assert.equal(decision.lane_decisions.find(lane => lane.review_type === 'security')?.invalidated, false);
    } finally { cleanup(result); }
});

test('security remediation in a task that requires security review stays DELTA for an ordinary source fix', () => {
    const result = runRemediationScenario({
        taskId: 'T-R7-1-security-ordinary-fix',
        reviewType: 'security',
        remediatedFile: 'src/format.ts',
        requiredReviews: { code: true, security: true, test: true },
        preflightTriggers: { security: true, security_intent: true }
    });
    try {
        assertDelta(result);
    } finally {
        cleanup(result);
    }
});

test('an authentication fix requires FULL only for its security owner', () => {
    const result = runRemediationScenario({
        taskId: 'T-R7-1-auth-fix',
        reviewType: 'code',
        remediatedFile: 'src/auth/session.ts',
        requiredReviews: { code: true, security: true, test: true },
        preflightTriggers: { security: true }
    });
    try {
        assert.equal(deltaOf(result).full_review_required, false);
        assert.deepEqual(deltaOf(result).mode_policy_assessment?.full_review_types, ['security']);
        assert.ok(deltaOf(result).mode_policy_assessment?.delta_eligible_review_types.includes('code'));
    } finally {
        cleanup(result);
    }
});

test('a dependency manifest fix requires FULL only for its dependency owner', () => {
    const result = runRemediationScenario({
        taskId: 'T-R7-1-dependency-fix',
        reviewType: 'code',
        remediatedFile: 'package.json',
        requiredReviews: { code: true, dependency: true, test: true },
        preflightTriggers: { dependency: true }
    });
    try {
        assert.equal(deltaOf(result).full_review_required, false);
        assert.deepEqual(deltaOf(result).mode_policy_assessment?.full_review_types, ['dependency']);
        assert.ok(deltaOf(result).mode_policy_assessment?.delta_eligible_review_types.includes('code'));
    } finally {
        cleanup(result);
    }
});

test('remediation that edits task criteria or review policy sources still requires FULL review', () => {
    const taskFile = runRemediationScenario({
        taskId: 'T-R7-1-task-criteria-fix',
        reviewType: 'code',
        remediatedFile: 'TASK.md',
        requiredReviews: { code: true, test: true },
        preflightTriggers: {}
    });
    const policySource = runRemediationScenario({
        taskId: 'T-R7-1-policy-source-fix',
        reviewType: 'code',
        remediatedFile: 'src/policy/review-remediation-mode-policy.ts',
        unchangedScopeFiles: { 'package.json': '{ "name": "garda-agent-orchestrator" }\n' },
        requiredReviews: { code: true, test: true },
        preflightTriggers: {}
    });
    try {
        assertFull(taskFile, /task criteria changed after the authenticated review baseline/u);
        assertFull(policySource, /review policy changed after the authenticated review baseline/u);
    } finally {
        cleanup(taskFile);
        cleanup(policySource);
    }
});

test('an unreadable paths.json keeps the task-wide preflight triggers instead of default domain triggers', () => {
    const repoRoot = createTempRepo();
    try {
        const pathsConfig = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'paths.json');
        fs.mkdirSync(path.dirname(pathsConfig), { recursive: true });
        fs.writeFileSync(pathsConfig, '{ "triggers": ', 'utf8');
        const preflightPayload = { changed_files: ['src/invoice.ts'], triggers: { security: true }, required_reviews: { code: true } };
        const resolved = resolveRemediationDeltaReviewTriggers({
            repoRoot,
            remediationDeltaFiles: ['src/invoice.ts'],
            profilePolicySnapshot: { review_trigger_policy: DEFAULT_REVIEW_TRIGGER_POLICY },
            preflightPayload
        });
        assert.equal(resolved.triggersPayload, preflightPayload);
        assert.equal(resolved.classified, false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('remediation falls back to FULL when the delta cannot be classified, even with no protected preflight signal', () => {
    const result = runRemediationScenario({
        taskId: 'T-R7-1-unclassified-delta',
        reviewType: 'code',
        remediatedFile: 'src/invoice.ts',
        requiredReviews: { code: true, test: true },
        preflightTriggers: {},
        corruptPathsConfig: true
    });
    try {
        assert.equal(result.decision.classification.source, 'runtime_fix');
        assert.equal(result.decision.modePolicyValidationInputs, null);
        const decision = resolveAuthoritativeReviewRemediationDecision({
            taskId: result.taskId,
            currentReviewType: result.decision.currentReviewType,
            classification: result.decision.classification,
            modePolicyValidationInputs: result.decision.modePolicyValidationInputs,
            requiredReviews: result.requiredReviews,
            reviewExecutionPolicyMode: 'strict_sequential'
        });
        assert.equal(decision.status, 'READY', JSON.stringify(decision));
        assert.ok(decision.lane_decisions.every((entry) => entry.mode === 'FULL' && entry.invalidated),
            JSON.stringify(decision.lane_decisions));
    } finally {
        cleanup(result);
    }
});

test('remediation falls back to FULL when a protected trigger regex is invalid', () => {
    const result = runRemediationScenario({
        taskId: 'T-R7-10-invalid-trigger-regex',
        reviewType: 'code',
        remediatedFile: 'src/invoice.ts',
        requiredReviews: { code: true, test: true },
        preflightTriggers: {},
        invalidSecurityRegex: true
    });
    try {
        assert.equal(result.decision.classification.source, 'runtime_fix');
        const decision = resolveAuthoritativeReviewRemediationDecision({ taskId: result.taskId,
            currentReviewType: result.decision.currentReviewType, classification: result.decision.classification,
            requiredReviews: result.requiredReviews, reviewExecutionPolicyMode: 'strict_sequential' });
        assert.ok(decision.lane_decisions.every((lane) => lane.invalidated && lane.mode === 'FULL'));
    } finally {
        cleanup(result);
    }
});

test('without an authenticated baseline every required review re-opens, whatever the impact analysis claims', () => {
    const repoRoot = createTempRepo();
    try {
        const inputs = resolveRuntimeDecisionInputs({
            repoRoot,
            taskId: 'T-R7-10-missing-baseline',
            remediationReviewType: 'test',
            requiredReviewTypes: ['code', 'refactor', 'test'],
            remediationFixClassification: {
                category: 'test_coverage_only',
                reason: 'the agent reports a test-only fix',
                blocked_before_reuse: false,
                invalidated_review_types: ['refactor', 'test']
            },
            profilePolicySnapshot: {},
            currentChangedFiles: ['tests/helpers/render.ts'],
            reviewTriggerPolicy: DEFAULT_REVIEW_TRIGGER_POLICY,
            allowAuthenticatedDelta: true
        });
        const classification = inputs.classification as { classification: { reason: string; invalidated_review_types: string[] } };
        assert.match(classification.classification.reason, /baseline is unavailable/u);
        assert.deepEqual(classification.classification.invalidated_review_types, ['code', 'refactor', 'test']);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('the delta-scoped assessment validates on authoritative remediation routing', () => {
    const result = runRemediationScenario({
        taskId: 'T-R7-1-routing-validation',
        reviewType: 'code',
        remediatedFile: 'src/invoice.ts',
        unchangedScopeFiles: UNCHANGED_PROTECTED_SCOPE,
        requiredReviews: { code: true, api: true, dependency: true, test: true },
        preflightTriggers: { api: true, dependency: true }
    });
    try {
        assertDelta(result);
        const decision = resolveAuthoritativeReviewRemediationDecision({
            taskId: result.taskId,
            currentReviewType: result.decision.currentReviewType,
            classification: result.decision.classification,
            modePolicyValidationInputs: result.decision.modePolicyValidationInputs,
            requiredReviews: result.requiredReviews,
            reviewExecutionPolicyMode: 'strict_sequential'
        });
        assert.equal(decision.status, 'READY', JSON.stringify(decision));
        assert.equal(decision.lane_decisions.find((entry) => entry.review_type === 'code')?.mode, 'DELTA',
            JSON.stringify(decision.lane_decisions));
    } finally {
        cleanup(result);
    }
});

for (const broken of ['unreadable', 'invalid-regex'] as const) test('documents-only fix falls back to all FULL with ' + broken + ' paths config', () => {
    const result = runRemediationScenario({ taskId: 'T-DOC-FALLBACK-' + broken, reviewType: 'code',
        remediatedFile: 'docs/guide.md', requiredReviews: { code: true, security: true, test: true }, preflightTriggers: {},
        corruptPathsConfig: broken === 'unreadable', invalidSecurityRegex: broken === 'invalid-regex' });
    try {
        assert.equal(result.decision.classification.source, 'runtime_fix');
        const decision = resolveAuthoritativeReviewRemediationDecision({ taskId: result.taskId,
            currentReviewType: result.decision.currentReviewType, classification: result.decision.classification,
            requiredReviews: result.requiredReviews, reviewExecutionPolicyMode: 'strict_sequential' });
        assert.ok(decision.lane_decisions.every((lane) => lane.invalidated && lane.mode === 'FULL'));
    } finally { cleanup(result); }
});

// After a failed review, task criteria follow the one rule of the passed-review path: the binding recorded in the
// review context the failed review ran against, compared with the current criteria under the restart's intent.
const CRITERIA_TASK_TITLE = 'Fix the invoice rounding';
const CRITERIA_TASK_SUMMARY = 'Implement invoice rounding fix';

function writeCriteriaSources(repoRoot: string, taskId: string, criteria: string[] | null): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${taskId} | IN_PROGRESS | P1 | billing | ${CRITERIA_TASK_TITLE} | me | 2026-11-04 | default | ${criteria ? `[${taskId}](docs/cards.md#${taskId.toLowerCase()})` : 'Keep two decimals.'} |`,
        ''
    ].join('\n'), 'utf8');
    if (!criteria) return;
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'docs', 'cards.md'), ['# Cards', '', `## ${taskId}`, '', ...criteria, ''].join('\n'), 'utf8');
}

function criteriaScenario(taskId: string, options: {
    recordBinding: boolean;
    afterFailedReview?: (repoRoot: string) => void;
    taskCriteria?: { authenticated: string; current: string };
}): ScenarioResult {
    return runRemediationScenario({
        taskId,
        reviewType: 'code',
        remediatedFile: 'src/invoice.ts',
        requiredReviews: { code: true, test: true },
        preflightTriggers: {},
        reviewedContext: (repoRoot) => {
            // Contexts from before the binding field are exercised without a linked card, as such tasks had none.
            writeCriteriaSources(repoRoot, taskId, options.recordBinding
                ? ['### Acceptance criteria', '', '1. Rounds half up', '2. Keeps two decimals'] : null);
            return options.recordBinding
                ? { task_criteria_binding: computeTaskCriteriaBinding({ repoRoot, taskId, preflight: { task_intent: CRITERIA_TASK_TITLE } }) }
                : { task_criteria: { task_intent: { source: 'preflight' } } };
        },
        afterFailedReview: options.afterFailedReview,
        // The restart reclassifies with the intent the failed review's preflight was classified with.
        taskCriteria: { ...(options.taskCriteria ?? { authenticated: CRITERIA_TASK_SUMMARY, current: CRITERIA_TASK_TITLE }),
            currentTaskIntent: CRITERIA_TASK_TITLE }
    });
}

const changeNumberedCriteria = (repoRoot: string) => fs.writeFileSync(path.join(repoRoot, 'docs', 'cards.md'),
    fs.readFileSync(path.join(repoRoot, 'docs', 'cards.md'), 'utf8').replace('Rounds half up', 'Rounds half even'), 'utf8');

test('after a failed review, unchanged recorded criteria keep DELTA even when the task-mode summary differs from the intent', () => {
    const result = criteriaScenario('T-criteria-failed-unchanged', { recordBinding: true });
    try {
        assertDelta(result);
        assert.equal(result.decision.modePolicyValidationInputs?.taskCriteriaChanged, false);
    } finally {
        cleanup(result);
    }
});

test('after a failed review, changed numbered card criteria repeat every review in FULL', () => {
    const result = criteriaScenario('T-criteria-failed-changed', { recordBinding: true, afterFailedReview: changeNumberedCriteria });
    try {
        assertFull(result, /task_criteria_or_policy|task criteria/iu);
        assert.equal(result.decision.modePolicyValidationInputs?.taskCriteriaChanged, true);
    } finally {
        cleanup(result);
    }
});

test('after a failed review, card line endings and trailing whitespace keep DELTA', () => {
    const result = criteriaScenario('T-criteria-failed-whitespace', {
        recordBinding: true,
        afterFailedReview: (repoRoot) => fs.writeFileSync(path.join(repoRoot, 'docs', 'cards.md'),
            fs.readFileSync(path.join(repoRoot, 'docs', 'cards.md'), 'utf8').replace('1. Rounds half up', '1. Rounds half up  ')
                .replace(/\n/gu, '\r\n'), 'utf8')
    });
    try {
        assertDelta(result);
    } finally {
        cleanup(result);
    }
});

test('after a failed review, internal card whitespace changes the signed criteria', () => {
    const result = criteriaScenario('T-criteria-failed-internal-whitespace', {
        recordBinding: true,
        afterFailedReview: (repoRoot) => fs.writeFileSync(path.join(repoRoot, 'docs', 'cards.md'),
            fs.readFileSync(path.join(repoRoot, 'docs', 'cards.md'), 'utf8').replace('Rounds half up', 'Rounds  half up'), 'utf8')
    });
    try { assertFull(result, /task_criteria_or_policy|task criteria/iu); }
    finally { cleanup(result); }
});

test('after a failed review, a context without a criteria binding keeps the older comparison', () => {
    const summaryChanged = criteriaScenario('T-criteria-failed-legacy-summary', { recordBinding: false });
    const unchanged = criteriaScenario('T-criteria-failed-legacy-unchanged', {
        recordBinding: false, taskCriteria: { authenticated: CRITERIA_TASK_SUMMARY, current: CRITERIA_TASK_SUMMARY }
    });
    try {
        // The older comparison: the task-mode summary against the restart's intent.
        assertFull(summaryChanged, /task_criteria_or_policy|task criteria/iu);
        assertDelta(unchanged);
    } finally {
        cleanup(summaryChanged);
        cleanup(unchanged);
    }
});
