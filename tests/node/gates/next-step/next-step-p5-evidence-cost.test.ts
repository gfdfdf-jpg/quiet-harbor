import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { withTaskTimelineReadSnapshot } from '../../../../src/gate-runtime/task-events';
import { readCompleteReviewTimelineEvidence } from '../../../../src/gates/next-step/next-step-review-evidence';
import { TASK_ID, appendEvent, eventsRoot, makeTempRepo } from './next-step-review-cycle-fixtures';

test('P5 T-451-3 current compile witness costs no more with 16 closed compiles than with 2 (RED on base)', t => {
    const samples: { cycles: number; candidates: number }[] = [];
    for (const cycles of [2, 16]) {
        const repoRoot = makeTempRepo();
        for (let index = 0; index < cycles; index++) {
            appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
            appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_PASSED');
        }
        let measurement: NextStepMeasurement | undefined;
        const evidence = withNextStepMeasurement(() => withInvocationReadObservation(() =>
            withTaskTimelineReadSnapshot(eventsRoot(repoRoot), TASK_ID, () =>
                readCompleteReviewTimelineEvidence(eventsRoot(repoRoot), TASK_ID))), value => { measurement = value; });
        assert.ok(evidence);
        assert.equal(evidence.latestCompileSequence, cycles * 2);
        assert.equal(evidence.events.length, cycles * 2);
        assert.equal(measurement!.work.timeline_verify, 1);
        assert.equal(measurement!.work['timeline_payload_read:' + path.join(eventsRoot(repoRoot), TASK_ID + '.jsonl')], 1);
        assert.equal(measurement!.work['visit:timeline_cloned_event'] || 0, 0);
        samples.push({ cycles, candidates: measurement!.work['visit:review_evidence_compile_candidate'] || 0 });
    }
    t.diagnostic(JSON.stringify(samples));
    assert.ok(samples[0].candidates <= 1, 'A current maximum needs at most one candidate after the canonical pass');
    assert.equal(samples[1].candidates, samples[0].candidates, 'Closed compiles must not add consumer work');
});
