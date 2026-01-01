import '../../../../src/bin/garda/derivation-source-receipts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { createAuthenticatedNextStepHistoryFixture, completeAuthenticatedHistoryFixture } from './next-step-authenticated-history-fixture';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { assertP5ActiveBudget, assertP5HistoryGrowth, assertP5NoIndex, assertP5ProcessBudget, measureP5, p5Differences, readP5AddedHistory, type P5Sample } from './next-step-p5-cost-fixture';

test('P5 T-451-2-3/T-451-3 authenticated active, required-review, DONE and drift routes', { timeout: 600_000 }, async t => {
    const active: P5Sample[] = [];
    const fixture = await createAuthenticatedNextStepHistoryFixture(1, 1, state => {
        const sample = measureP5('active-review', 'native-one-cycle', () => resolveNextStep(state));
        assert.equal(sample.result.next_gate, 'record-review-result', sample.result.reason);
        active.push(sample);
    });
    const required = measureP5('required-reviews-check', 'native-one-cycle', () => resolveNextStep(fixture));
    assert.equal(required.result.next_gate, 'required-reviews-check', required.result.reason);
    await t.test('current authenticated review routes avoid report projections and timeline copies', () => {
        for (const sample of [...active, required]) {
            assertP5ActiveBudget(sample); assertP5ProcessBudget(sample, 18, 13);
        }
    });
    await t.test('T-451-2-3 current authenticated review routes avoid catalog acquisition/enumeration', () => {
        for (const sample of [...active, required]) assertP5NoIndex(sample);
    });
    await completeAuthenticatedHistoryFixture(fixture);
    const control = measureP5('DONE', 'stable-control', () => resolveNextStep(fixture));
    const done = measureP5('DONE', 'native-one-cycle', () => resolveNextStep(fixture));
    assert.equal(done.result.status, 'DONE', done.result.reason);
    await t.test('unchanged terminal inputs have identical work', () => {
        assert.deepEqual(p5Differences(control, done), []);
    });
    const timelinePath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/task-events', fixture.taskId + '.jsonl');
    const beforeBytes = fs.statSync(timelinePath).size;
    // Use the native producer so history growth keeps the signed cadence head current. Direct
    // JSONL edits change a second authority input and belong to cadence/recovery negative controls.
    for (let index = 0; index < 126; index++) appendMandatoryTaskEvent(path.join(fixture.repoRoot, 'garda-agent-orchestrator'), fixture.taskId,
        'P5_HISTORY_NOTE', 'INFO', 'P5 history note', { index }, { lowNoiseRuntimeWrites: true });
    const historyInput = readP5AddedHistory(timelinePath, beforeBytes);
    assert.equal(historyInput.events, 126);
    const longer = measureP5('DONE', '126-extra-notes', () => resolveNextStep(fixture));
    assert.equal(longer.result.status, 'DONE', longer.result.reason);
    const stable = (sample: P5Sample) => ({ ...sample.result, generated_utc: '<time>' });
    assert.deepEqual(stable(longer), stable(done), 'History-only growth must preserve the entire terminal navigation result');
    await t.test('T-451-2-3 DONE uses authenticated materialized projection without report/index work', () => {
        for (const sample of [done, longer]) {
            assert.equal(sample.measurement.work.terminal_materialized_projection_selected, 1);
            assertP5ProcessBudget(sample, 10, 8);
            assertP5ActiveBudget(sample); assertP5NoIndex(sample);
        }
    });
    await t.test('T-451-3 DONE history grows by one canonical pass; non-history work has zero growth', () => {
        assertP5HistoryGrowth(done, longer, historyInput);
    });
    fs.appendFileSync(path.join(fixture.repoRoot, fixture.files[0]), 'export const p5Drift = true;\n');
    const drift = measureP5('post-done-drift', '126-extra-notes', () => resolveNextStep(fixture));
    assert.equal(drift.result.next_gate, 'post-done-drift', drift.result.reason);
    await t.test('T-451-2-3 source drift keeps projection authentication without history/index work (RED on base)', () => {
        assert.equal(drift.measurement.work.terminal_materialized_projection_selected, 1);
        assertP5ProcessBudget(drift, 10, 8);
        assertP5ActiveBudget(drift); assertP5NoIndex(drift);
    });
});
