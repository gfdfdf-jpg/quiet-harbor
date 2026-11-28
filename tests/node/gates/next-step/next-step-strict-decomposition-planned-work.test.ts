import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskQueueEntry } from '../../../../src/core/task-queue-read';
import { buildStrictDecompositionDecisionRequirement } from '../../../../src/gates/next-step/next-step-strict-decomposition-routing';
import type { NextStepProfileSummary } from '../../../../src/gates/next-step/next-step';

const TASK_ID = 'T-014-2';
const ENABLED = { task_decomposition_enabled: true, effective_profile: 'strict', task_decomposition_provenance: 'profile' } as unknown as NextStepProfileSummary;
// The first preflight runs before implementation: no diff and no required reviews yet.
const BASELINE_PREFLIGHT = { changed_files: [], scope_category: 'empty', metrics: { changed_files_count: 0, changed_lines_total: 0 } };

function entry(notes: string): TaskQueueEntry {
    return { taskId: TASK_ID, status: 'IN_PROGRESS', area: 'shop', title: 'Show the order total', profile: 'strict', notes };
}

function requirement(notes: string, plannedFiles: string[] = [], preflight: Record<string, unknown> = BASELINE_PREFLIGHT) {
    return buildStrictDecompositionDecisionRequirement({
        taskId: TASK_ID, taskEntry: entry(notes), taskMode: { task_summary: 'Show the order total', planned_changed_files: plannedFiles },
        preflight, profileSummary: ENABLED, requiredReviewTypes: []
    });
}

describe('gates/next-step strict decomposition decision before implementation (field shop T-014-2, T-212)', () => {
    it('asks for the decision at the first preflight when the notes plan sub-cards or cap the files', () => {
        const subCards = requirement('Card approved; run its sub-cards in order, one task each.');
        assert.equal(subCards.required, true);
        assert.ok(subCards.riskSignals.includes('task_plan:sub-cards'), subCards.riskSignals.join(','));
        const cap = requirement('Scope: maximum six files.');
        assert.equal(cap.required, true);
        assert.ok(cap.riskSignals.includes('task_plan:file-cap=6'), cap.riskSignals.join(','));
    });

    it('asks for the decision at the first preflight from the planned files before any diff exists', () => {
        const planned = requirement('Show the total.', ['src/order.ts', 'src/total.ts', 'tests/total.test.ts']);
        assert.equal(planned.required, true);
        assert.deepEqual(planned.riskSignals, ['planned_changed_files_count=3']);
    });

    it('keeps a small unplanned baseline task free of the decision and leaves the real diff to the preflight signals', () => {
        assert.equal(requirement('Show the total.', ['src/order.ts']).required, false);
        const changed = requirement('Show the total.', ['src/a.ts', 'src/b.ts', 'src/c.ts'],
            { changed_files: ['src/a.ts'], scope_category: 'code', metrics: { changed_files_count: 1, changed_lines_total: 4 } });
        assert.ok(!changed.riskSignals.some(signal => signal.startsWith('planned_changed_files_count')), changed.riskSignals.join(','));
    });
});
