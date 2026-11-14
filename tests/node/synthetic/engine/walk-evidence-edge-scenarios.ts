import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../../cli/commands/gate-test-helpers';
import { COVERAGE_WALK_SCENARIOS } from './walk-coverage-scenarios';
import type { WalkScenario } from './navigator-walk';
import { handleSet } from '../../../../src/cli/commands/workflow/workflow-command-set';
import { splitCommandLine } from '../../../../src/core/command-line';
import { resolveTaskQueueTransactionLockPath } from '../../../../src/core/task-queue/task-queue-repository';
import { legacyTaskFixture } from './walk-legacy-task-contract';

const REVIEWS = 'garda-agent-orchestrator/runtime/reviews';
const CLEAN = {
    edits: [{ path: 'src/app.ts', append: '// evidence edge\n' }, { path: 'tests/app.test.ts', append: '// evidence edge\n' }],
    expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL']
};
const RECIPE_BASE = legacyTaskFixture('node --test --test-reporter=tap tests/app.test.ts');
const RECIPE_FIXTURE = { ...RECIPE_BASE,
    files: { ...RECIPE_BASE.files, 'tests/app.test.ts': 'import test from "node:test"; import assert from "node:assert/strict";\n'
        + 'import { renderStatus } from "../src/app.ts";\ntest("status", () => assert.equal(renderStatus(), "ready"));\n' },
    caseCommand: 'node --test --test-reporter=tap tests/app.test.ts',
    cases: [{ source: 'tests/app.test.ts', case_id: 'status', selector: 'status' }],
    trustBoundaryMatrix: [{ boundary_id: 'TB-RECIPE-STATUS', boundary: 'Status source to the rendered result',
        authority_source: 'src/app.ts', mutable_inputs: ['status source'], integrity_evidence: ['source sha256'],
        canonical_reconstruction: 'Read the task source and execute its status regression.', toctou_replay: 'Reject changed status behavior.',
        negative_paths: [{ kind: 'replaced', scenario: 'status', expected_behavior: 'Preserve the ready status.',
            evidence_files: ['tests/app.test.ts#status'] }] }] };

function configureDeclaredRecipe(root: string): void {
    const declaration = { schema_version: 1, recipes: [{ id: 'stand-status', purpose: 'test', executable: process.execPath,
        argv: ['--test', '--test-reporter=tap', 'tests/app.test.ts'], cwd: '.', environment: {},
        inputs: [{ path: 'tests/app.test.ts', role: 'test' }],
        targets: [{ id: 'status', source: 'tests/app.test.ts', selector: 'status' }],
        // The declared opaque path requires the modeled reviewer to resolve the actual selected case.
        required_capabilities: [], result_format: 'opaque', timeout_ms: 5000, max_attempts: 1,
        max_output_bytes: 32768, max_input_bytes: 65536 }] };
    fs.writeFileSync(path.join(root, 'recipes.json'), JSON.stringify(declaration));
    if (runGit(root, ['add', 'recipes.json']).status !== 0
        || runGit(root, ['commit', '-qm', 'Declare disposable stand recipe']).status !== 0)
        throw new Error('Cannot retain the disposable fixture validation declaration.');
}

function obstructQueuePublication(root: string): void {
    const lock = resolveTaskQueueTransactionLockPath(path.join(root, 'TASK.md'));
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    // A real invalid filesystem entry, not a fabricated gate failure or authenticated lock owner.
    fs.writeFileSync(lock, 'Stand fault: operator must repair this obstructed task-queue lock.');
}

export const EVIDENCE_EDGE_WALK_SCENARIOS: readonly WalkScenario[] = [
    {
        id: 'coverage-docs-only-validation-conflict', profile: 'docs-only',
        counterState: 'declared-recipe-task-local-docs-only',
        // This handoff is a real conflict: the docs-only profile cannot review its own changed executable case.
        edits: [{ path: 'docs/guide.md', append: 'Clarify the documented contract.\n' },
            { path: 'tests/app.test.ts', append: '// Verify the documented status contract.\n' }],
        fixture: RECIPE_FIXTURE, selectionTargets: ['tests/app.test.ts'],
        testSelectionCommand: RECIPE_BASE.taskTestCommand,
        expectedReviews: {}, expectedModes: [], expectedBlockedGate: 'project-validation-evidence',
        expectedGuidance: /Task\/validation contract conflict:.*docs-only.*Ask the operator to resolve the task scope or validation contract/u,
        configure: configureDeclaredRecipe,
        prepare: async (root, steps) => {
            if (!steps.length) handleSet({ targetRoot: root, projectValidationContract: 'recipes.json',
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString(), json: true });
            if (steps.some(step => step.gate === 'required-reviews-check' || step.gate === 'run-intermediate-command'))
                throw new Error('The explicit task/profile conflict must refuse before recipe execution or review closeout.');
        }
    },
    {
        ...CLEAN, id: 'coverage-declared-recipe', configure: configureDeclaredRecipe,
        fixture: RECIPE_FIXTURE,
        selectionTargets: ['tests/app.test.ts'],
        counterState: 'declared-recipe-task-local-reviewed',
        expectedGates: ['run-intermediate-command'],
        prepare: async (root, steps) => {
            if (!steps.length) handleSet({ targetRoot: root, projectValidationContract: 'recipes.json',
                operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString(), json: true });
            const last = steps.at(-1);
            if (last?.gate === 'run-intermediate-command' && last.command?.includes('--recipe-id')
                && (last.exitCode !== 0 || !/PROJECT_VALIDATION_PROCESS_PASSED[\s\S]*ResultStatus: UNRESOLVED[\s\S]*ExitCode: 0/u.test(last.output || '')))
                throw new Error('Opaque recipe execution must pass while independent case semantics remain unresolved.');
        }
    },
    {
        ...CLEAN, id: 'coverage-completed-launch-output-loss',
        disturbanceReason: 'Lose actual reviewer output after native launch completion, before result acceptance.',
        // A digest-bound copy of completed reviewer output is restored; the review is not repeated.
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate !== 'complete-reviewer-launch' || last.exitCode !== 0
                || steps.filter(step => step.gate === 'complete-reviewer-launch').length !== 1) return;
            const args = splitCommandLine(last.command!);
            const launch = JSON.parse(fs.readFileSync(path.resolve(root, args[args.indexOf('--reviewer-launch-artifact-path') + 1]), 'utf8'));
            fs.unlinkSync(path.resolve(root, launch.review_output_path));
        }
    },
    {
        ...CLEAN, id: 'coverage-corrupt-correction-package',
        disturbances: [{ kind: 'invalid-report-shape', lane: 'test' }],
        expectedFailingGates: ['record-review-result'],
        disturbanceReason: 'Corrupt the native correction package after report validation rejects an extra property.',
        expectedBlockedGate: 'task-reset', expectedGuidance: /corrupt.*operator.*task-reset.*fresh ordered reviews/isu,
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate !== 'record-review-result' || !last.exitCode) return;
            if (!last.output.includes("report contains unknown field 'unexpected'"))
                throw new Error('Expected the native malformed-report refusal before corrupting its correction package.');
            const file = path.join(root, REVIEWS, 'T-WALK-test-output-correction.json');
            if (!fs.existsSync(file)) throw new Error('Native correction package missing before corruption.');
            fs.writeFileSync(file, '{corrupt');
        }
    },
    ...(['scope', 'review'] as const).map((kind): WalkScenario => ({
        ...CLEAN, id: 'coverage-' + kind + '-latch-write-failure',
        ...(kind === 'scope' ? { edits: [...CLEAN.edits, { path: 'src/extra.ts', append: 'export const extra = true;\n' }] } : { failures: { code: 1 } }),
        disturbanceReason: 'Obstruct the native task-queue lock before latch status publication.',
        expectedReviews: kind === 'scope' ? {} : { code: 1 }, expectedModes: kind === 'scope' ? [] : ['code:FULL'],
        expectedBlockedGate: 'split-required-latch', expectedGuidance: /TASK.md status sync failed/iu,
        configure: root => {
            const file = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (kind === 'scope') Object.assign(config.scope_budget_guard,
                { enabled: true, profiles: ['balanced'], action: 'BLOCK_FOR_SPLIT', max_files: 2, warn_files: 1, block_files: 2 });
            else Object.assign(config.review_cycle_guard,
                { enabled: true, action: 'BLOCK_FOR_OPERATOR_DECISION', max_failed_non_test_reviews: 1, auto_split_enabled: true });
            fs.writeFileSync(file, JSON.stringify(config));
        },
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (kind === 'scope' ? last?.gate === 'classify-change' && steps.some(step => step.gate === 'implementation')
                : last?.gate === 'record-review-result') obstructQueuePublication(root);
        }
    })),
    {
        ...CLEAN, id: 'coverage-invalid-optional-selection',
        disturbanceReason: 'Corrupt selection_phase in native optional-skill selection after classification.',
        prepare: async (root, steps) => {
            const classifications = steps.filter(step => step.gate === 'classify-change');
            const last = steps.at(-1);
            if (last?.gate !== 'classify-change' || last.exitCode !== 0) return;
            if (classifications.length === 1) {
                const file = path.join(root, REVIEWS, 'T-WALK-optional-skill-selection.json');
                const selection = JSON.parse(fs.readFileSync(file, 'utf8'));
                selection.selection_phase = 'invalid-stand-phase';
                fs.writeFileSync(file, JSON.stringify(selection));
            } else if (classifications.length === 2 && !last.reason.includes('current optional-skill selection artifact is invalid')) {
                throw new Error('Invalid optional-skill selection did not select its native recovery route.');
            }
        }
    },
    ...(['deny', 'no-reset', 'protected-source'] as const).map(mode => ({
        ...CLEAN, id: 'coverage-operator-' + mode,
        expectedReviews: {}, expectedModes: [],
        expectedBlockedGate: mode === 'protected-source' ? 'enter-task-mode' : 'operator-maintenance',
        expectedGuidance: mode === 'deny' ? /operator/iu : mode === 'no-reset'
            ? /Audited task reset must be enabled/iu : /fresh operator approval is required/iu,
        disturbanceReason: 'Protected control-plane edit after entry requires explicit operator recovery.',
        configure: (root: string) => {
            const file = path.join(root, 'garda-agent-orchestrator/live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            config.orchestrator_work_policy.mode = mode === 'deny' ? 'deny_agent_entry' : 'require_operator_confirmation';
            config.task_reset.enabled = false;
            fs.writeFileSync(file, JSON.stringify(config));
        },
        prepare: async (root: string, steps: Parameters<NonNullable<WalkScenario['prepare']>>[1]) => {
            const last = steps.at(-1);
            if (last?.gate !== 'load-rule-pack' || !last.command?.includes('POST_PREFLIGHT') || last.exitCode !== 0) return;
            const relative = 'garda-agent-orchestrator/' + (mode === 'protected-source'
                ? 'src/cli/operator-owned-probe.ts' : 'live/config/workflow-config.json');
            const file = path.join(root, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, '\n');
            if (mode === 'protected-source' && runGit(root, ['add', '--force', relative]).status !== 0) {
                throw new Error('Cannot stage the protected source disturbance in its disposable fixture.');
            }
        }
    } satisfies WalkScenario)),
    {
        ...COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-planned-scope')!,
        id: 'coverage-compile-plan-drift',
        edits: [...CLEAN.edits, { path: 'src/auth.ts', append: '// outside frozen plan\n' }],
        disturbanceReason: 'Introduce a production edit outside the original approved task plan.',
        expectedReviews: {}, expectedModes: [], expectedFailingGates: ['compile-gate'], expectedGates: [],
        expectedBlockedGate: 'compile-gate',
        expectedGuidance: /last compile rejected.*outside the approved task plan.*Otherwise revert/isu
    },
    {
        ...CLEAN, id: 'coverage-lost-receipts-after-completion',
        disturbanceReason: 'Lose canonical and immutable test receipts after the native completion gate.',
        expectedBlockedGate: 'task-audit-summary', expectedGuidance: /restart|reset|restore/iu,
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate !== 'completion-gate' || steps.at(-1)?.exitCode !== 0) return;
            const reviews = path.join(root, REVIEWS);
            const receipts = fs.readdirSync(reviews).filter(name => /^T-WALK-test.*receipt.*\.json$/u.test(name));
            if (!receipts.length) throw new Error('No native test receipts to remove after completion.');
            for (const name of receipts) fs.unlinkSync(path.join(reviews, name));
        }
    },
    ...(['handshake', 'shell-smoke'] as const).map((kind): WalkScenario => ({
        ...CLEAN, id: 'coverage-lost-startup-' + kind,
        disturbanceReason: 'Lose the native ' + kind + ' artifact after the startup sequence passed.',
        // Startup evidence binds no review: rebuild it, then run the as-yet unstarted reviews once.
        expectedGates: [kind === 'handshake' ? 'handshake-diagnostics' : 'shell-smoke-preflight'],
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate === 'classify-change') {
                const handshakes = steps.filter(step => step.gate === 'handshake-diagnostics');
                const smokes = steps.filter(step => step.gate === 'shell-smoke-preflight');
                if (handshakes.length !== (kind === 'handshake' ? 2 : 1) || smokes.length !== 2
                    || !steps.some(step => step.reason.includes('binds no review'))
                    || steps.some(step => step.gate === 'record-reviewer-delegation-started')) {
                    throw new Error('Lost startup evidence must be rebuilt before the first planned review.');
                }
            }
            if (last?.gate === 'shell-smoke-preflight' && last.exitCode === 0
                && steps.filter(step => step.gate === 'shell-smoke-preflight').length === 1) {
                fs.unlinkSync(path.join(root, REVIEWS, 'T-WALK-' + kind + '.json'));
            }
        }
    })),
    {
        ...CLEAN, id: 'coverage-lost-code-context-before-test',
        disturbanceReason: 'Lose the accepted code context before the downstream test review starts.',
        // A digest-bound review context is restored without repeating the accepted code review.
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate === 'record-review-result' && last.exitCode === 0
                && steps.filter(step => step.gate === 'record-review-result').length === 1) {
                fs.unlinkSync(path.join(root, REVIEWS, 'T-WALK-code-review-context.json'));
            }
        }
    }
];
