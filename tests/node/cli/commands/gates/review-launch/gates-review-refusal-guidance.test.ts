import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createTempRepo, seedPromptBoundReviewFixture, getOrchestratorRoot } from './gates-command-review-launch-fixtures';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { runRequiredReviewsCheckCommand } from '../../../../../../src/cli/commands/gates';
import { writeBudgetOutputFilters } from '../../gate-test-helpers';

test('required-reviews-check preserves concrete recovery even when the refusal is truncated', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-review-refusal';
    try {
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Passed stage fixture.', {});
        const result = runRequiredReviewsCheckCommand({ repoRoot, taskId, preflightPath: fixture.preflightPath,
            outputFiltersPath: writeBudgetOutputFilters(repoRoot), emitMetrics: false });
        assert.notEqual(result.exitCode, 0);
        const output = result.outputLines.join('\n');
        assert.match(output, /REVIEW_GATE_FAILED/u);
        assert.match(output, /Recovery after REVIEW_GATE_PASSED: run next-step to continue closing/u);
        assert.match(output, /Do not repeat required-reviews-check in place\./u);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
