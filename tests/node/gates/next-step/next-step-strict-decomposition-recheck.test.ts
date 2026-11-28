import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type { TaskQueueEntry } from '../../../../src/core/task-queue-read';
import { resolveStrictDecompositionContinuationRoute } from '../../../../src/gates/next-step/next-step-strict-decomposition-routing';
import { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';
import { TASK_ID, makeTempRepo, eventsRoot, reviewsRoot, writeJson, seedStartedTask } from './next-step-completion-fixtures';

const SUMMARY = 'Seeded next-step task';

function seedDecision(repoRoot: string, extra: Record<string, unknown>): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-strict-decomposition-decision.json`), buildStrictDecompositionDecisionArtifact({
        taskId: TASK_ID, decision: 'single-cycle', taskProfile: 'strict', taskSummary: SUMMARY,
        reason: 'One root cause with one review cycle for owner and consumers.',
        scopeRisk: 'Owner and consumers form one authority contract.', expectedReviewTypes: ['code'],
        atomicityConstraints: ['Owner and consumers land together.'], ...extra
    }));
}

function route(options: {
    decision: Record<string, unknown>;
    changedFiles: number;
    failed?: number;
    enabled?: boolean;
}) {
    const repoRoot = makeTempRepo();
    seedStartedTask(repoRoot, TASK_ID);
    seedDecision(repoRoot, options.decision);
    return resolveStrictDecompositionContinuationRoute({
        repoRoot, eventsRoot: eventsRoot(repoRoot), taskEntries: new Map<string, TaskQueueEntry>(), taskId: TASK_ID,
        cliPrefix: 'node bin/garda.js',
        requirement: { required: true, decompositionEnabled: options.enabled ?? true, taskSummary: SUMMARY, taskProfile: 'strict',
            taskDecompositionProvenance: 'profile', riskSignals: ['changed_files_count=3'] },
        requiredReviewTypes: ['code'], baseMissingArtifacts: [], basePresentArtifacts: [],
        preflight: { changed_files: Array.from({ length: options.changedFiles }, (_value, index) => `src/file-${index}.ts`) },
        readFailedReviews: () => ({ failedNonTestReviewCount: options.failed ?? 0, maxFailedNonTestReviews: 10 })
    });
}

describe('gates/next-step strict decomposition recheck (field T-212: six estimated files, nine changed, nine failed reviews)', () => {
    it('routes back to a re-decision once the changed files exceed the recorded estimate', () => {
        const result = route({ decision: { estimatedChangedFiles: 6 }, changedFiles: 9 });
        assert.equal(result?.status, 'BLOCKED');
        assert.equal(result?.nextGate, 'record-strict-decomposition-decision');
        assert.match(result?.reason ?? '', /changes 9 files, more than the recorded estimate of 6/u);
        assert.match(result?.commands[0]?.command ?? '', /record-strict-decomposition-decision .*--estimated-changed-files "9"/u);
        assert.match(result?.commands[0]?.command ?? '', /recheck:changed-files/u);
    });

    it('routes back to a re-decision at the failed-review checkpoint, well before the review-cycle guard', () => {
        const baseline = { preflight_changed_files_count: 4, failed_non_test_review_count: 0 };
        assert.equal(route({ decision: { estimatedChangedFiles: 6, recheckBaseline: baseline }, changedFiles: 4, failed: 2 }), null);
        const result = route({ decision: { estimatedChangedFiles: 6, recheckBaseline: baseline }, changedFiles: 4, failed: 3 });
        assert.equal(result?.nextGate, 'record-strict-decomposition-decision');
        assert.match(result?.reason ?? '', /3 non-test reviews have failed .*checkpoint is 3, below the review-cycle guard limit of 10/u);
        // The re-recorded decision carries the new baseline, so the next checkpoint moves on.
        assert.equal(route({ decision: { estimatedChangedFiles: 6, recheckBaseline: { ...baseline, failed_non_test_review_count: 3 } },
            changedFiles: 4, failed: 5 }), null);
    });

    it('continues silently only while the recorded decision still covers the work', () => {
        assert.equal(route({ decision: { estimatedChangedFiles: 6 }, changedFiles: 6 }), null);
        assert.equal(route({ decision: { estimatedChangedFiles: 6 }, changedFiles: 9, enabled: false }), null);
    });
});
