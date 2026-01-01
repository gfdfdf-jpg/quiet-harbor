import { NATIVE_RECOVERY_WALK_SCENARIOS } from './walk-native-recovery-scenarios';
import { UNKNOWN_STACK_CONTRACT_SCENARIOS } from './walk-unknown-stack-contract';
import { STACK_WALK_SCENARIOS, STACK_REVIEW_VARIANTS } from './walk-stack-scenarios';
import type { WalkEdit, WalkScenario } from './navigator-walk';
import { TEST_SELECTION_WALK_SCENARIOS } from './walk-test-selection-scenarios';
import { OPAQUE_RUNNER_WALK_SCENARIOS } from './walk-opaque-runner-scenarios';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COVERAGE_WALK_SCENARIOS } from './walk-coverage-scenarios';
import { RECOVERY_COVERAGE_WALK_SCENARIOS } from './walk-recovery-coverage-scenarios';
import { PARENT_COVERAGE_WALK_SCENARIOS } from './walk-parent-coverage-scenarios';
import { LAUNCH_COVERAGE_WALK_SCENARIOS } from './walk-launch-coverage-scenarios';
import { FULL_SUITE_CHILD_WALK_SCENARIOS } from './walk-full-suite-child-scenarios';
import { EVIDENCE_EDGE_WALK_SCENARIOS } from './walk-evidence-edge-scenarios';
import { REUSE_COVERAGE_WALK_SCENARIOS } from './walk-reuse-coverage-scenarios';
import { FINAL_COVERAGE_WALK_SCENARIOS } from './walk-final-coverage-scenarios';
import { BOUNDARY_COVERAGE_WALK_SCENARIOS } from './walk-boundary-coverage-scenarios';
import { OWNER_COVERAGE_WALK_SCENARIOS } from './walk-owner-coverage-scenarios';
import { PUBLICATION_COVERAGE_WALK_SCENARIOS } from './walk-publication-coverage-scenarios';
import { ROUTE_CLOSURE_WALK_SCENARIOS } from './walk-route-closure-scenarios';
import { narrowLegacyFailure } from './walk-legacy-task-contract';
import { STACK_COMPACT_REVIEW_SCENARIOS, STACK_DEEP_REVIEW_SCENARIOS } from './walk-stack-review-scenarios';
import { FIELD_CASE_SCENARIOS } from './walk-field-cases';

const SOURCE_EDIT: WalkEdit = { path: 'src/app.ts', append: 'export const changed = true;\n' };
const TEST_EDIT: WalkEdit = { path: 'tests/app.test.ts', append: '// covered\n' };
const BASE_EDITS = [SOURCE_EDIT, TEST_EDIT];
const SOURCE_FIX: WalkEdit = { path: 'src/app.ts', append: '// fixed\n' };
const TEST_FIX: WalkEdit = { path: 'tests/app.test.ts', append: '// fixed\n' };
const LARGE_SOURCE_FIX: WalkEdit = { path: 'src/app.ts', append: '// fixed\n'.repeat(260) };
const SECURITY_EDIT: WalkEdit = { path: 'src/auth/session.ts', append: 'export const session = "s";\n' };
const SECURITY_FIX: WalkEdit = { path: 'src/auth/session.ts', append: '// fixed\n' };
const NEW_TEST_FIX: WalkEdit = { path: 'tests/extra.test.ts', append: '// new coverage\n' };
const DOCUMENT_FIX: WalkEdit = { path: 'docs/guide.md', append: 'Fixed wording.\n' };
const FOUR_LANE_EDITS: WalkEdit[] = [
    SOURCE_EDIT,
    { path: 'src/db/orders.sql', append: 'select 1;\n' },
    SECURITY_EDIT,
    { path: 'src/cache/CacheStore.ts', append: 'export const store = new Map();\n' },
    TEST_EDIT
];

// Hand-written from the operator's review rules: a review repeats when it failed or when the fix reached its scope,
// a small fix without a protected signal repeats in DELTA, a larger one restarts from the first review in FULL,
// reviews the fix did not reach stay accepted, and documents never trigger a review.
export const WALK_SCENARIOS: readonly WalkScenario[] = [
    ...FIELD_CASE_SCENARIOS,
    ...STACK_COMPACT_REVIEW_SCENARIOS,
    ...STACK_DEEP_REVIEW_SCENARIOS,
    ...TEST_SELECTION_WALK_SCENARIOS,
    ...OPAQUE_RUNNER_WALK_SCENARIOS,
    ...OWNER_COVERAGE_WALK_SCENARIOS,
    ...PUBLICATION_COVERAGE_WALK_SCENARIOS,
    ...BOUNDARY_COVERAGE_WALK_SCENARIOS,
    ...FINAL_COVERAGE_WALK_SCENARIOS,
    ...COVERAGE_WALK_SCENARIOS,
    ...RECOVERY_COVERAGE_WALK_SCENARIOS,
    ...PARENT_COVERAGE_WALK_SCENARIOS,
    ...LAUNCH_COVERAGE_WALK_SCENARIOS,
    ...FULL_SUITE_CHILD_WALK_SCENARIOS,
    ...EVIDENCE_EDGE_WALK_SCENARIOS,
    ...REUSE_COVERAGE_WALK_SCENARIOS,
    ...ROUTE_CLOSURE_WALK_SCENARIOS,
    ...NATIVE_RECOVERY_WALK_SCENARIOS,
    // These are invalid operator inputs, not fabricated gate-owned lifecycle evidence. The routing
    // contract requires an exact repair handoff before any lifecycle command may execute.
    ...[
        { id: 'task-id-case-mismatch', gate: 'task-id-casing', guidance: /Use the exact TASK.md task id/iu,
            change: (text: string) => text.replace('T-WALK', 'T-Walk') },
        { id: 'invalid-required-review-declaration', gate: 'task-metadata-validation', guidance: /Correct the task notes/iu,
            change: (text: string) => text.replace('Synthetic navigator walk.', 'Required reviews: imaginary-lane.') },
        { id: 'split-required-without-owned-latch', gate: 'split-required-latch', guidance: /operator repairs or resets the task/iu,
            change: (text: string) => text.replace('🟦 TODO', 'SPLIT_REQUIRED') }
    ].map((handoff): WalkScenario => ({
        id: handoff.id, edits: BASE_EDITS, expectedReviews: {}, expectedModes: [],
        expectedBlockedGate: handoff.gate, expectedGuidance: handoff.guidance,
        setup: root => {
            const file = path.join(root, 'TASK.md');
            fs.writeFileSync(file, handoff.change(fs.readFileSync(file, 'utf8')));
        }
    })),
    { id: 'quality-checklist-rework', edits: BASE_EDITS, qualityRework: true,
        fix: [{ path: 'src/app.ts', append: '// The status change is intentionally isolated from other renderers.\n' }],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'], expectedFailingGates: ['quality-checklist'] },
    { id: 'post-done-document-drift', edits: BASE_EDITS, disturbances: [{ kind: 'after-done-edit', edit: DOCUMENT_FIX }],
        expectedBlockedGate: 'post-done-drift', expectedGuidance: /reopen\/reset/iu,
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'] },
    ...(['after_compile_before_reviews', 'before_test_review', 'before_completion'] as const).map((fullSuitePlacement): WalkScenario => ({
        id: 'barrier-' + fullSuitePlacement, fullSuitePlacement, edits: BASE_EDITS,
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL']
    })),
    ...(['fast', 'balanced'] as const).map((profile): WalkScenario => ({
        id: 'profile-' + profile, profile, edits: BASE_EDITS,
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL']
    })),
    { id: 'profile-strict-decomposition', profile: 'strict', edits: BASE_EDITS,
        expectedBlockedGate: 'record-strict-decomposition-decision', expectedGuidance: /decomposition|decision/iu,
        expectedReviews: {}, expectedModes: [] },
    { id: 'document-only', profile: 'docs-only', edits: [DOCUMENT_FIX], expectedReviews: {}, expectedModes: [] },
    { id: 'invalid-workflow-config', edits: BASE_EDITS,
        setup: root => fs.writeFileSync(path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json'), '{broken\n'),
        expectedBlockedGate: 'workflow-config-validation', expectedGuidance: /workflow validate/iu,
        expectedReviews: {}, expectedModes: [] },
    { id: 'foreign-active-task', edits: BASE_EDITS, foreignTask: true,
        setup: root => fs.appendFileSync(path.join(root, 'TASK.md'), '| T-FOREIGN | 🟨 IN_PROGRESS | P1 | app | Other work | another-agent | 2026-10-30 | balanced | Preserve it. |\n'),
        expectedBlockedGate: 'enter-task-mode', expectedGuidance: /Ask the operator to confirm/iu,
        expectedReviews: {}, expectedModes: [] },
    { id: 'dirty-workspace', edits: BASE_EDITS,
        setup: root => fs.appendFileSync(path.join(root, 'src/app.ts'), '// existing work by operator\n'),
        expectedBlockedGate: 'manual-scope-selection', expectedGuidance: /--changed-file/iu,
        expectedReviews: {}, expectedModes: [], expectedFailingGates: ['classify-change'] },
    ...(['strict_sequential', 'parallel_all', 'test_after_code', 'code_first_optional'] as const).flatMap(mode =>
        ['independent', 'chain', 'fanout'].map((graph): WalkScenario => {
            const order = ['code', 'db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency', 'test'];
            return { id: 'graph-' + mode + '-' + graph, mode, edits: BASE_EDITS, requiredLanes: ['performance'],
                dependencyGraph: { preparation_order: order, dependencies: Object.fromEntries(order.map(lane => {
                    const required = ['code', 'performance', 'test'], index = required.indexOf(lane);
                    return [lane, graph === 'chain' && index > 0 ? [required[index - 1]] : graph === 'fanout' && index > 0 ? ['code'] : []];
                })) },
                expectedReviews: { code: 1, performance: 1, test: 1 }, expectedModes: ['code:FULL', 'performance:FULL', 'test:FULL'] };
        })),
    ...[2, 2_000, 20_000].map((trackedFiles): WalkScenario => ({
        id: 'project-size-' + trackedFiles, trackedFiles, edits: BASE_EDITS,
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL']
    })),
    ...(['parallel_all', 'test_after_code', 'code_first_optional'] as const).flatMap((mode): WalkScenario[] => [
        { id: mode + '-test-failed-fixed-in-test', mode, edits: BASE_EDITS, failures: { test: 1 }, fix: [TEST_FIX],
            expectedReviews: { code: 1, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'test:DELTA'] },
        { id: mode + '-test-failed-document-fix', mode, edits: BASE_EDITS, failures: { test: 1 }, fix: [DOCUMENT_FIX],
            expectedReviews: { code: 1, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'test:FULL'] }
    ]),
    {
        id: 'test-then-code-failure-keeps-performance', edits: BASE_EDITS, requiredLanes: ['performance'],
        failureAttempts: { test: [1], code: [2] }, fix: [SOURCE_FIX],
        expectedReviews: { code: 3, performance: 1, test: 2 },
        expectedModes: ['code:FULL', 'performance:FULL', 'test:FULL', 'code:DELTA', 'code:DELTA', 'test:FULL']
    },
    {
        id: 'custom-trigger-reopens-passed-lane', edits: BASE_EDITS, customLane: true,
        requiredLanes: ['custom-quality'],
        reviewOrder: ['code', 'db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency', 'custom-quality', 'test'],
        failures: { test: 1 }, fix: [SOURCE_FIX], expectedReviews: { code: 2, 'custom-quality': 2, test: 2 },
        expectedModes: ['code:FULL', 'custom-quality:FULL', 'test:FULL', 'code:DELTA', 'custom-quality:DELTA', 'test:DELTA']
    },
    ...['db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency'].map((lane): WalkScenario => ({
        id: lane + '-failed-small-production-fix', edits: BASE_EDITS, requiredLanes: [lane],
        // API was absent from the later task-selection calibration. Keep the original route budgets;
        // name these two independently measured fixture input states instead of widening every task.
        get counterState() {
            if (lane !== 'api') return undefined;
            const source = path.join(process.cwd(), SOURCE_FIX.path);
            return fs.existsSync(source) && fs.readFileSync(source, 'utf8').includes(SOURCE_FIX.append!)
                ? 'native-api-selected-remediation' : 'native-api-selected-initial';
        },
        failures: { [lane]: 1 }, fix: [SOURCE_FIX],
        expectedReviews: { code: 2, [lane]: 2, test: 1 },
        expectedModes: ['code:FULL', lane + ':FULL', 'code:DELTA', lane + ':DELTA', 'test:FULL']
    })),
    {
        id: 'parallel-test-passed-before-production-fix', mode: 'parallel_all', requiredLanes: ['performance'],
        reviewOrder: ['code', 'test', 'db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency'],
        edits: BASE_EDITS, failures: { performance: 1 }, fix: [SOURCE_FIX],
        expectedReviews: { code: 2, test: 2, performance: 2 },
        expectedModes: ['code:FULL', 'test:FULL', 'performance:FULL', 'code:DELTA', 'test:DELTA', 'performance:DELTA']
    },
    {
        id: 'parallel-test-failed-production-fix', mode: 'parallel_all', edits: BASE_EDITS,
        failures: { test: 1 }, fix: [SOURCE_FIX], expectedReviews: { code: 2, test: 2 },
        expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA']
    },
    ...(['test_after_code', 'code_first_optional'] as const).map((mode): WalkScenario => ({
        id: mode + '-test-failed-production-fix', mode, edits: BASE_EDITS,
        failures: { test: 1 }, fix: [SOURCE_FIX], expectedReviews: { code: 2, test: 2 },
        expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA']
    })),
    {
        id: 'security-word-adds-owner', edits: BASE_EDITS, failures: { test: 1 },
        fix: [{ path: 'src/app.ts', append: '// permission boundary fixed\n' }],
        expectedReviews: { code: 2, test: 2 },
        expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA']
    },
    ...[
        { id: 'security-word-across-diff-pages', append: '// ' + 'x'.repeat(16377) + ' permission boundary fixed\n' },
        { id: 'redacted-secret-adds-owner', append: 'export const apiKey = "password_abcdefghijklmnop";\n' }
    ].map((fix): WalkScenario => ({
        id: fix.id, edits: BASE_EDITS, failures: { test: 1 }, fix: [{ path: 'src/app.ts', append: fix.append }],
        expectedReviews: { code: 2, ...(fix.id === 'redacted-secret-adds-owner' ? { security: 1 } : {}), test: 2 },
        expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA',
            ...(fix.id === 'redacted-secret-adds-owner' ? ['security:FULL'] : []), 'test:DELTA']
    })),
    ...(['code_first_optional', 'test_after_code'] as const).map((mode): WalkScenario => ({
        id: mode + '-source-fix-keeps-performance', mode, edits: BASE_EDITS, requiredLanes: ['performance'],
        failures: { test: 1 }, fix: [SOURCE_FIX], expectedReviews: { code: 2, performance: 1, test: 2 },
        expectedModes: ['code:FULL', 'performance:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA']
    })),
    {
        id: 'security-word-repeats-passed-security', edits: BASE_EDITS, requiredLanes: ['security'],
        failures: { test: 1 }, fix: [{ path: 'src/app.ts', append: '// permission boundary fixed\n' }],
        expectedReviews: { code: 2, security: 2, test: 2 },
        expectedModes: ['code:FULL', 'security:FULL', 'test:FULL', 'code:DELTA', 'security:DELTA', 'test:DELTA']
    },
    {
        id: 'parallel-infra-fix-keeps-test', mode: 'parallel_all', requiredLanes: ['infra'],
        reviewOrder: ['code', 'test', 'db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency'],
        edits: [...BASE_EDITS, { path: 'Dockerfile', append: '# initial edit\n' }],
        failures: { infra: 1 }, fix: [{ path: 'Dockerfile', append: '# fixed\n' }],
        expectedReviews: { code: 1, test: 1, infra: 2 },
        expectedModes: ['code:FULL', 'test:FULL', 'infra:FULL', 'infra:FULL']
    },
    {
        id: 'second-failure-keeps-unaffected-lanes', edits: FOUR_LANE_EDITS,
        failures: { performance: 2 }, fix: [SOURCE_FIX],
        expectedModes: ['code:FULL', 'db:FULL', 'security:FULL', 'performance:FULL', 'code:DELTA', 'performance:DELTA', 'code:DELTA', 'performance:DELTA', 'test:FULL'], expectedReviews: { code: 3, db: 1, security: 1, performance: 3, test: 1 }
    },
    {
        id: 'long-production-remediation', edits: BASE_EDITS, failures: { test: 6 }, fix: [SOURCE_FIX],
        expectedReviews: { code: 7, test: 7 },
        expectedModes: ['code:FULL', 'test:FULL', ...Array.from({ length: 6 }, (_, index) =>
            index === 3 ? ['code:FULL', 'test:FULL'] : ['code:DELTA', 'test:DELTA']).flat()]
    },
    { id: 'clean-pass', edits: BASE_EDITS, expectedModes: ['code:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 1 } },
    {
        id: 'security-refactor-pass', edits: [...BASE_EDITS, SECURITY_EDIT,
            { path: 'tests/helpers/render.ts', append: '// shared fixture change\n' }], requiredLanes: ['security', 'refactor'],
        expectedModes: ['code:FULL', 'security:FULL', 'refactor:FULL', 'test:FULL'],
        expectedReviews: { code: 1, security: 1, refactor: 1, test: 1 }
    },
    {
        // This edited leaf is outside NODE_WALK_FIXTURE's auth-case matrix evidence.
        // Keep already-passed security/refactor lanes while the failed test reviews its delta.
        id: 'leaf-test-fix-keeps-security-refactor', counterState: 'leaf-test-review-reuse', edits: BASE_EDITS, requiredLanes: ['security', 'refactor'],
        failures: { test: 1 }, fix: [TEST_FIX],
        expectedModes: ['code:FULL', 'security:FULL', 'refactor:FULL', 'test:FULL', 'test:DELTA'],
        expectedReviews: { code: 1, security: 1, refactor: 1, test: 2 }
    },
    {
        id: 'test-failed-fixed-in-test', edits: BASE_EDITS, failures: { test: 1 }, fix: [TEST_FIX],
        expectedModes: ['code:FULL', 'test:FULL', 'test:DELTA'], expectedReviews: { code: 1, test: 2 }
    },
    {
        id: 'test-failed-fixed-in-source', edits: BASE_EDITS, failures: { test: 1 }, fix: [SOURCE_FIX],
        expectedReviews: { code: 2, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA']
    },
    {
        id: 'performance-failed-small-fix', edits: FOUR_LANE_EDITS, failures: { performance: 1 }, fix: [SOURCE_FIX],
        expectedReviews: { code: 2, db: 1, security: 1, performance: 2, test: 1 },
        expectedModes: ['code:FULL', 'db:FULL', 'security:FULL', 'performance:FULL', 'code:DELTA', 'performance:DELTA', 'test:FULL']
    },
    {
        id: 'performance-failed-large-fix', edits: FOUR_LANE_EDITS, failures: { performance: 1 }, fix: [LARGE_SOURCE_FIX],
        expectedReviews: { code: 2, db: 1, security: 1, performance: 2, test: 1 },
        expectedModes: ['code:FULL', 'db:FULL', 'security:FULL', 'performance:FULL', 'code:FULL', 'performance:FULL', 'test:FULL']
    },
    {
        id: 'test-failed-new-test-file', edits: BASE_EDITS, failures: { test: 1 }, fix: [NEW_TEST_FIX],
        expectedReviews: { code: 1, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'test:DELTA']
    },
    {
        id: 'test-failed-production-scope-expansion', edits: BASE_EDITS, failures: { test: 1 },
        fix: [{ path: 'src/extra.ts', append: 'export const extra = true;\n' }],
        expectedReviews: { code: 2, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'code:FULL', 'test:FULL']
    },
    {
        id: 'test-failed-manifest-under-tests', edits: BASE_EDITS, failures: { test: 1 },
        fix: [{ path: 'tests/package.json', append: '{"private":true}\n' }],
        expectedReviews: { code: 2, dependency: 1, test: 2 },
        expectedModes: ['code:FULL', 'test:FULL', 'code:FULL', 'dependency:FULL', 'test:FULL']
    },
    {
        id: 'control-plane-source-is-ordinary-code',
        edits: [{ path: 'src/gates/check.ts', append: 'export const check = true;\n' }, TEST_EDIT],
        failures: { test: 1 }, fix: [{ path: 'src/gates/check.ts', append: '// fixed\n' }],
        expectedReviews: { code: 2, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA']
    },
    {
        id: 'test-failed-document-fix', edits: BASE_EDITS, failures: { test: 1 }, fix: [DOCUMENT_FIX],
        expectedModes: ['code:FULL', 'test:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 2 }
    },
    {
        id: 'code-failed-source-and-document-fix', edits: BASE_EDITS, failures: { code: 1 },
        fix: [SOURCE_FIX, { ...DOCUMENT_FIX, append: DOCUMENT_FIX.append.repeat(450) }],
        expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'code:DELTA', 'test:FULL']
    },
    {
        id: 'code-failed-source-and-test-document-fix', edits: BASE_EDITS, failures: { code: 1 },
        fix: [SOURCE_FIX, { path: 'tests/README.md', append: DOCUMENT_FIX.append.repeat(450) }],
        expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'code:DELTA', 'test:FULL']
    },
    {
        id: 'test-failed-twice-fixed-in-source', edits: BASE_EDITS, failures: { test: 2 }, fix: [SOURCE_FIX],
        expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA', 'code:DELTA', 'test:DELTA'], expectedReviews: { code: 3, test: 3 }
    },
    {
        id: 'test-failed-large-fix-in-source', edits: BASE_EDITS, failures: { test: 1 }, fix: [LARGE_SOURCE_FIX],
        expectedReviews: { code: 2, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'code:FULL', 'test:FULL']
    },
    {
        id: 'test-failed-fixed-in-security-file', edits: [SECURITY_EDIT, TEST_EDIT], failures: { test: 1 }, fix: [SECURITY_FIX],
        expectedReviews: { code: 2, security: 2, test: 2 },
        expectedModes: ['code:FULL', 'security:FULL', 'test:FULL', 'code:DELTA', 'security:FULL', 'test:DELTA']
    },
    {
        id: 'code-failed-fixed-in-source', edits: BASE_EDITS, failures: { code: 1 }, fix: [SOURCE_FIX],
        expectedModes: ['code:FULL', 'code:DELTA', 'test:FULL'], expectedReviews: { code: 2, test: 1 }
    },
    {
        id: 'test-failed-twice', edits: BASE_EDITS, failures: { test: 2 }, fix: [TEST_FIX],
        expectedModes: ['code:FULL', 'test:FULL', 'test:DELTA', 'test:DELTA'], expectedReviews: { code: 1, test: 3 }
    },
    {
        id: 'security-failed-fixed-in-source',
        edits: [SECURITY_EDIT, TEST_EDIT], failures: { security: 1 }, fix: [SECURITY_FIX],
        expectedReviews: { code: 2, security: 2, test: 1 },
        expectedModes: ['code:FULL', 'security:FULL', 'code:DELTA', 'security:FULL', 'test:FULL']
    },
    {
        id: 'compile-fails-once', edits: BASE_EDITS, disturbances: [{ kind: 'fail-compile' }],
        expectedModes: ['code:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 1 }, expectedFailingGates: ['compile-gate']
    },
    narrowLegacyFailure({
        id: 'full-suite-fails-once', edits: BASE_EDITS, disturbances: [{ kind: 'fail-full-suite' }],
        expectedModes: ['code:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 1 }, expectedFailingGates: ['full-suite-validation']
    }),
    {
        id: 'finished-commands-repeat', edits: BASE_EDITS,
        disturbances: [{ kind: 'repeat-command', gate: 'compile-gate' }, { kind: 'repeat-command', gate: 'record-review-result' }],
        expectedModes: ['code:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 1 }
    },
    {
        id: 'source-edit-after-reviews', edits: BASE_EDITS,
        disturbances: [{ kind: 'late-edit', gate: 'required-reviews-check', edit: SOURCE_FIX }],
        expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA'], expectedReviews: { code: 2, test: 2 }
    },
    {
        // A write after REVIEW_GATE_PASSED: next-step asks the agent to revert it and keep closing (decision 3).
        id: 'source-edit-before-completion', edits: BASE_EDITS,
        disturbances: [{ kind: 'late-edit', gate: 'completion-gate', edit: SOURCE_FIX }],
        expectedModes: ['code:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 1 }
    },
    {
        // The same write, kept because the user approved the new review cycle. Operator decision 5: the approved cycle
        // follows the rules of a change before the gate, so the small source fix repeats code and test in DELTA.
        id: 'source-edit-before-completion-user-approves', edits: BASE_EDITS, approveReviewRestart: true,
        disturbances: [{ kind: 'late-edit', gate: 'completion-gate', edit: SOURCE_FIX }],
        expectedModes: ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA'], expectedReviews: { code: 2, test: 2 }
    },
    {
        id: 'reviewer-report-broken', edits: BASE_EDITS, disturbances: [{ kind: 'broken-report', lane: 'test' }],
        expectedModes: ['code:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 1 }, expectedFailingGates: ['record-review-result']
    },
    {
        id: 'reviewer-report-unreachable', edits: BASE_EDITS, disturbances: [{ kind: 'broken-report', lane: 'test' }],
        unreachableReviewer: true,
        expectedModes: ['code:FULL', 'test:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 2 },
        expectedFailingGates: ['record-review-result']
    },
    {
        id: 'reviewer-too-fast', edits: BASE_EDITS, disturbances: [{ kind: 'fast-reviewer', lane: 'test' }],
        expectedModes: ['code:FULL', 'test:FULL', 'test:FULL'], expectedReviews: { code: 1, test: 2 }, expectedFailingGates: ['record-review-result', 'complete-reviewer-launch']
    },
    ...UNKNOWN_STACK_CONTRACT_SCENARIOS,
    ...STACK_WALK_SCENARIOS,
    ...STACK_REVIEW_VARIANTS
];
