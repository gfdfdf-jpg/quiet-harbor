import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoCurrentCycleReviewRecordedBeforeRouting } from '../../../../../../src/cli/commands/gate-review-handlers/context/review-context-runtime-validation';
import type { ReviewDependencyTimelineEvent } from '../../../../../../src/gates/review/review-dependencies';

test('routing unlocks only after a successful authenticated restart invalidates its lane', () => {
    const recorded: ReviewDependencyTimelineEvent = { event_type: 'REVIEW_RECORDED', sequence: 1, details: { review_type: 'test' } };
    const prefix: ReviewDependencyTimelineEvent[] = [{ event_type: 'COMPILE_GATE_PASSED', sequence: 0, details: {} }, recorded];
    const restart: ReviewDependencyTimelineEvent = {
        event_type: 'REVIEW_CYCLE_RESTARTED', task_id: 'T-ROUTE', actor: 'orchestrator', outcome: 'PASS', sequence: 2,
        integrity: { schema_version: 1, task_sequence: 3, prev_event_sha256: null, event_sha256: 'a'.repeat(64) },
        details: { task_id: 'T-ROUTE', event_type: 'REVIEW_CYCLE_RESTARTED', status: 'PASSED', invalidated_review_types: ['test'] }
    };
    const check = (event: ReviewDependencyTimelineEvent) => assertNoCurrentCycleReviewRecordedBeforeRouting([...prefix, event], 'test', 'T-ROUTE');
    assert.doesNotThrow(() => check(restart));
    for (const changed of [
        { ...restart, outcome: 'FAIL' }, { ...restart, actor: '' }, { ...restart, task_id: 'T-FOREIGN' },
        { ...restart, details: { ...restart.details, status: 'BLOCKED' } },
        { ...restart, details: { ...restart.details, invalidated_review_types: ['security'] } }
    ]) assert.throws(() => check(changed), /locked because current-cycle REVIEW_RECORDED/u);
    assert.throws(() => assertNoCurrentCycleReviewRecordedBeforeRouting([...prefix, restart, { ...recorded, sequence: 3 }], 'test', 'T-ROUTE'),
        /locked because current-cycle REVIEW_RECORDED/u);
});
