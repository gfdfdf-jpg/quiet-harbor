import { splitCommandLine } from '../../../../src/core/command-line';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { WalkScenario } from './navigator-walk';
import { LEGACY_TASK_COMMAND, narrowLegacyFailure } from './walk-legacy-task-contract';

const scenarios: WalkScenario[] = [
    {
        id: 'coverage-full-suite-manual-retry',
        edits: [{ path: 'src/app.ts', append: '// manual retry\n' }, { path: 'tests/app.test.ts', append: '// manual retry\n' }],
        disturbances: [{ kind: 'fail-full-suite' }], expectedFailingGates: ['full-suite-validation'],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'],
        prepare: async (root, steps, run) => {
            const last = steps.at(-1);
            if (last?.gate !== 'full-suite-validation') return;
            if (last.exitCode) {
                const command = LEGACY_TASK_COMMAND;
                const reviews = 'garda-agent-orchestrator/runtime/reviews/';
                const preflight = reviews + 'T-WALK-preflight.json';
                await run(['run-intermediate-command', '--task-id', 'T-WALK', '--command-source', 'targeted-test',
                    '--command', command, '--preflight-path', preflight, '--repo-root', '.']);
                const hash = (file: string) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
                const file = path.join(root, 'garda-agent-orchestrator/runtime/manual-validation/T-WALK/full-suite-retry-evidence.json');
                fs.mkdirSync(path.dirname(file), { recursive: true });
                // Supplemental, unauthenticated retry guidance never replaces the mandatory native full-suite PASS.
                fs.writeFileSync(file, JSON.stringify({ task_id: 'T-WALK', reason_kind: 'focused_pass_after_failure',
                    preflight_sha256: hash(preflight), full_suite_failure_artifact_sha256: hash(reviews + 'T-WALK-full-suite-validation.json'),
                    focused_validation: { command, exit_code: 0, status: 'PASSED' } }));
            }
        }
    },
    {
        id: 'coverage-full-suite-targeted-diagnostic',
        edits: [{ path: 'src/app.ts', append: '// diagnostic recovery\n' }, { path: 'tests/app.test.ts', append: '// diagnostic recovery\n' }],
        disturbances: [{ kind: 'fail-full-suite' }], expectedFailingGates: ['full-suite-validation'],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'],
        prepare: async (_root, steps, run) => {
            const last = steps.at(-1);
            if (last?.gate !== 'full-suite-validation') return;
            if (last.exitCode) {
                await run(['run-intermediate-command', '--task-id', 'T-WALK', '--command-source', 'targeted-test',
                    '--command', LEGACY_TASK_COMMAND, '--preflight-path',
                    'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json', '--repo-root', '.']);
            }
        }
    },
    {
        id: 'coverage-provider-failed-launch',
        edits: [{ path: 'src/app.ts', append: '// launch recovery\n' }, { path: 'tests/app.test.ts', append: '// launch recovery\n' }],
        expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'code:FULL', 'test:FULL'],
        expectedGates: ['restart-review-cycle'],
        disturbanceReason: 'Provider explicitly fails the first authenticated delegated launch before any review output exists.',
        prepare: async (_root, steps, run) => {
            const last = steps.at(-1);
            if (last?.gate !== 'record-reviewer-delegation-started' || last.exitCode !== 0
                || steps.filter(step => step.gate === 'record-reviewer-delegation-started').length !== 1) return;
            const args = splitCommandLine(last.command!);
            const flags = ['--task-id', '--review-type', '--reviewer-execution-mode', '--reviewer-identity',
                '--reviewer-launch-artifact-path', '--provider-invocation-id'];
            const bindings = flags.flatMap(flag => {
                const index = args.indexOf(flag);
                if (index < 0 || !args[index + 1]) throw new Error('Missing native launch binding: ' + flag);
                return [flag, args[index + 1]];
            });
            await run(['record-reviewer-launch-failed', ...bindings,
                '--failure-reason', 'Provider terminated this delegated reviewer before returning output.', '--repo-root', '.']);
        }
    },
    {
        id: 'coverage-full-suite-before-test-failure', fullSuitePlacement: 'before_test_review',
        edits: [{ path: 'src/app.ts', append: '// full suite recovery\n' }, { path: 'tests/app.test.ts', append: '// full suite recovery\n' }],
        disturbances: [{ kind: 'fail-full-suite' }], expectedFailingGates: ['full-suite-validation'],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL']
    },
    {
        id: 'coverage-full-suite-malformed-marker',
        edits: [{ path: 'src/app.ts', append: '// marker refusal\n' }, { path: 'tests/app.test.ts', append: '// marker refusal\n' }],
        disturbanceReason: 'Corrupt full-suite run marker before execution; the navigator must preserve diagnostic evidence.',
        expectedReviews: {}, expectedModes: [], expectedBlockedGate: 'full-suite-validation',
        expectedGuidance: /marker.*malformed.*Do not start a fresh task test run.*preserve evidence/isu,
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate === 'compile-gate' && steps.at(-1)?.exitCode === 0) {
                fs.writeFileSync(path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-WALK-full-suite-run-marker.json'), '{broken');
            }
        },
        inspectResult: root => assert.equal(fs.readFileSync(path.join(root,
            'garda-agent-orchestrator/runtime/reviews/T-WALK-full-suite-run-marker.json'), 'utf8'), '{broken',
        'The malformed marker remains untouched for the operator')
    }
];

export const LAUNCH_COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = scenarios.map(scenario => ['coverage-full-suite-manual-retry', 'coverage-full-suite-targeted-diagnostic',
    'coverage-full-suite-before-test-failure'].includes(scenario.id) ? narrowLegacyFailure(scenario) : scenario);
