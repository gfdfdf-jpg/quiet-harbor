import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRecordedOutOfScopeFailures } from '../../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { recordedOutOfScopeFollowUpViolations } from '../../../../src/gates/full-suite/recorded-out-of-scope-follow-ups';
import { runGit } from '../../cli/commands/gate-test-helpers';
import type { WalkScenario } from './navigator-walk';

/**
 * Stack independence: the project's broad test runner prints text no Garda parser understands and fails on
 * something outside the task. The agent narrows to its own test, the broad failure goes to the grouped follow-up
 * as a whole, and the task reaches DONE without any per-test attribution of the runner output.
 */
function opaqueRunnerNarrowingScenario(): WalkScenario {
    let narrowAfterFailure = false;
    return {
        id: 'coverage-opaque-runner-out-of-scope-narrow',
        get testSelectionCommand() { return narrowAfterFailure ? 'node --test tests/app.test.ts' : undefined; },
        counterState: 'full-suite-out-of-scope-narrow',
        fullSuitePlacement: 'after_compile_before_reviews',
        edits: [{ path: 'tests/app.test.ts', append: '// task-only regression\n' }],
        expectedGates: ['task-test-selection', 'full-suite-validation', 'materialize-review-follow-up-tasks'],
        expectedFailingGates: ['full-suite-validation'],
        expectedReviews: { test: 1 },
        expectedModes: ['test:FULL'],
        setup: root => {
            // No file reference, no TAP, no Maven/JUnit markers: only free text and a failing exit code.
            fs.writeFileSync(path.join(root, 'scripts/full-suite-check.cjs'), [
                'console.log("suite run 7f3a: 412 checks");',
                'console.log("14:19:54.151 worker-2 note: retrying flaky resource");',
                'console.error("3 checks broke in the production module boundary area");',
                'process.exitCode = 1;',
                ''
            ].join('\n'));
            runGit(root, ['add', 'scripts/full-suite-check.cjs']);
            runGit(root, ['commit', '-qm', 'Seed an opaque unrelated failure in disposable fixture']);
        },
        prepare: async (root, steps) => {
            if (!steps.length) narrowAfterFailure = false;
            const last = steps.at(-1);
            if (last?.gate === 'full-suite-validation' && last.exitCode !== 0) narrowAfterFailure = true;
            if (last?.gate === 'materialize-review-follow-up-tasks' && last.exitCode === 0) {
                const queue = fs.readFileSync(path.join(root, 'TASK.md'), 'utf8');
                assert.match(queue, /T-WALK-1\b/u);
                const recorded = readRecordedOutOfScopeFailures(root, 'T-WALK');
                assert.equal(recorded.length, 1);
                assert.equal(recorded[0].command, 'node scripts/full-suite-check.cjs');
                assert.deepEqual(recordedOutOfScopeFollowUpViolations(root, 'T-WALK'), []);
            }
        }
    };
}

export const OPAQUE_RUNNER_WALK_SCENARIOS: readonly WalkScenario[] = [opaqueRunnerNarrowingScenario()];
