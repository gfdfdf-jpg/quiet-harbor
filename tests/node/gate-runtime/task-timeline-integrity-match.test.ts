import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { isMatchingVerifiedTaskTimeline } from '../../../src/gate-runtime/timeline/task-timeline-integrity-match';
import { collectOrderedTimelineEvents } from '../../../src/gates/completion/completion-evidence';
import { readReviewDependencyTimelineEvents } from '../../../src/gates/required-reviews/required-reviews-check-dependencies';

test('order preservation authenticates the same timeline view used by both gates', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-order-timeline-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const taskId = 'T-ORDER-TIMELINE';
    const file = path.join(root, 'runtime', 'task-events', `${taskId}.jsonl`);
    const written = appendTaskEvent(root, taskId, 'REVIEW_CYCLE_RESTARTED', 'PASS', 'Evidence-only restart',
        { detection_source: 'review_evidence_only', detected_changed_files_count: 0 },
        { passThru: true, lowNoiseRuntimeWrites: true });
    assert.equal(written?.commit_status, 'committed');

    for (const readEvents of [
        () => collectOrderedTimelineEvents(file, []),
        () => readReviewDependencyTimelineEvents(file)
    ]) {
        const expected = readEvents();
        const verify = (expectedEvents: typeof expected) => isMatchingVerifiedTaskTimeline({
            timelinePath: file, taskId, expectedEvents, readEvents
        });
        assert.equal(verify(expected), true);
        const forged = expected.map(event => ({ ...event, details: { ...event.details, detected_changed_files_count: 1 } }));
        assert.equal(verify(forged), false, 'a matching-looking event hash must not authenticate changed details');
    }

    const expected = collectOrderedTimelineEvents(file, []);
    const original = fs.readFileSync(file, 'utf8');
    const altered = original.replace('review_evidence_only', 'review_evidence_other');
    assert.notEqual(altered, original);
    fs.writeFileSync(file, altered);
    assert.equal(isMatchingVerifiedTaskTimeline({ timelinePath: file, taskId, expectedEvents: expected,
        readEvents: () => collectOrderedTimelineEvents(file, []) }), false);
});
