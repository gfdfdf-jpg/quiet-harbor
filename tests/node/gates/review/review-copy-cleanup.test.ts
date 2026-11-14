import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { readRuntimeMutationGeneration } from '../../../../src/gate-runtime/runtime-mutation-generation';
import { removeTaskReviewCopies } from '../../../../src/gates/review/review-copy-cleanup';

test('legacy shared copies survive other open tasks and are removed after they close', t => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-copy-cleanup-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const queue = (status: string) => [
        '## Active Queue', '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| T-OTHER | ${status} | P1 | code | other | agent | - | balanced | - |`, ''
    ].join('\n');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), queue('IN_PROGRESS'));
    const events = path.join(repoRoot, 'runtime', 'task-events');
    fs.mkdirSync(events, { recursive: true });
    appendTaskEvent(repoRoot, 'T-OTHER', 'TASK_MODE_ENTERED', 'PASS', 'started', {});
    const digest = 'a'.repeat(64);
    const roots = ['.reviewer-output-cache', '.review-context-cache']
        .map(name => path.join(repoRoot, 'runtime', 'tmp', name));
    for (const root of roots) {
        fs.mkdirSync(path.join(root, 'T-OTHER'), { recursive: true });
        fs.writeFileSync(path.join(root, digest), 'shared');
        fs.writeFileSync(path.join(root, 'T-OTHER', digest), 'private');
    }
    const beforeCleanup = readRuntimeMutationGeneration(repoRoot).generation;
    removeTaskReviewCopies({ repoRoot, taskId: 'T-CLOSED' });
    assert.ok(readRuntimeMutationGeneration(repoRoot).generation > beforeCleanup);
    for (const root of roots) assert.ok(fs.existsSync(path.join(root, digest)));
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), queue('DONE'));
    removeTaskReviewCopies({ repoRoot, taskId: 'T-CLOSED' });
    for (const root of roots) assert.ok(fs.existsSync(path.join(root, digest)), 'open history overrides a stale queue');
    appendTaskEvent(repoRoot, 'T-OTHER', 'COMPLETION_GATE_PASSED', 'PASS', 'finished', {});
    removeTaskReviewCopies({ repoRoot, taskId: 'T-CLOSED', removeLegacy: false });
    for (const root of roots) assert.ok(fs.existsSync(path.join(root, digest)), 'a failed reset must preserve shared copies');
    removeTaskReviewCopies({ repoRoot, taskId: 'T-CLOSED' });
    for (const root of roots) {
        assert.equal(fs.existsSync(path.join(root, digest)), false);
        assert.equal(fs.readFileSync(path.join(root, 'T-OTHER', digest), 'utf8'), 'private');
        fs.rmSync(path.join(root, 'T-OTHER'), { recursive: true });
    }
    removeTaskReviewCopies({ repoRoot, taskId: 'T-CLOSED' });
    for (const root of roots) assert.equal(fs.existsSync(root), false, 'empty legacy roots are removed');
});
