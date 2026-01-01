import '../../../../src/bin/garda/derivation-source-receipts';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { ALL_REVIEW_FLAGS, TASK_ID, appendEvent, eventsRoot, makeTempRepo, seedStartedTask, writePreflight } from './next-step-review-cycle-fixtures';
import { assertP5ActiveBudget, assertP5HistoryGrowth, assertP5NoIndex, assertP5ProcessBudget, measureP5, p5Differences, readP5AddedHistory } from './next-step-p5-cost-fixture';

// Ordinary regression assertions; history follows the operator's single-pass linear tolerance.
for (const route of ['enter-task-mode', 'classify-change', 'compile-gate'] as const) {
    test('P5 T-451-2-3/T-451-3 active route ' + route, { timeout: 120_000 }, async t => {
        const repoRoot = makeTempRepo();
        // Keep timeline existence/ACL contracts equal in both samples.
        for (let index = 0; index < 2; index++) appendEvent(repoRoot, TASK_ID, 'P5_HISTORY_NOTE', 'INFO', { index });
        if (route !== 'enter-task-mode') seedStartedTask(repoRoot, TASK_ID);
        if (route === 'compile-gate') writePreflight(repoRoot, TASK_ID, ALL_REVIEW_FLAGS);
        const read = () => resolveNextStep({ repoRoot, taskId: TASK_ID });
        const control = measureP5(route, 'stable-control', read);
        const before = measureP5(route, '2-notes', read);
        assert.equal(before.result.next_gate, route, before.result.reason);
        const timelinePath = path.join(eventsRoot(repoRoot), TASK_ID + '.jsonl');
        const beforeBytes = fs.statSync(timelinePath).size;
        for (let index = 2; index < 128; index++) appendEvent(repoRoot, TASK_ID, 'P5_HISTORY_NOTE', 'INFO', { index });
        const historyInput = readP5AddedHistory(timelinePath, beforeBytes);
        assert.equal(historyInput.events, 126);
        const after = measureP5(route, '128-notes', read);
        const stable = (result: typeof before.result) => ({ ...result, generated_utc: '<time>' });
        assert.deepEqual(stable(after.result), stable(before.result), 'History-only growth must preserve the entire navigation result');
        // The shared fixture's afterEach also runs after subtests. Finish all filesystem work first.
        await t.test('unchanged-input control has identical work', () => {
            assert.deepEqual(p5Differences(control, before), []);
        });
        await t.test('report/clones and repeated hashes stay absent', () => {
            assertP5ActiveBudget(before); assertP5ActiveBudget(after);
        });
        await t.test('T-451-2-3 active navigation acquires no review index (compile RED on base)', () => {
            assertP5NoIndex(before); assertP5NoIndex(after);
        });
        const differences = p5Differences(before, after);
        await t.test('T-416 counters: history adds no Git/ACL, probes, reads or hashes', () => {
            const gitMaximum = { 'enter-task-mode': 0, 'classify-change': 4, 'compile-gate': 16 }[route];
            const aclMaximum = route === 'enter-task-mode' ? 4 : 7;
            assertP5ProcessBudget(before, gitMaximum, aclMaximum); assertP5ProcessBudget(after, gitMaximum, aclMaximum);
            assert.deepEqual(differences.filter(row => /^(?:process:|acl_|file_hash:|payload_read:|artifact_)/u.test(row.counter)
                || /^io:(?:statSync|lstatSync|fstatSync|existsSync|realpathSync(?:\.native)?|readlinkSync|readdirSync|readFileSync|openSync|readSync|closeSync)$/u.test(row.counter)), []);
        });
        await t.test('T-451-3 history grows by one canonical pass; non-history work has zero growth', () => {
            assertP5HistoryGrowth(before, after, historyInput);
        });
        t.diagnostic('Raw counts retained in GARDA_P5_REPORT_PATH');
    });
}
