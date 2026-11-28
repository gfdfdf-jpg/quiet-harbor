import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTask, type WalkResult } from '../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';

// Operator decision 3: a write after REVIEW_GATE_PASSED does not start a new review cycle by itself. next-step
// asks the agent to revert and keep closing; a restart runs a new review cycle only with the user's approval
// (--review-restart-approved), never with the task-mode --operator-confirmed consent. Operator decision 5: the
// approved cycle follows the rules of a change before the gate, through restart-review-cycle and the passed baseline.

function approvalRequest(result: WalkResult) {
    return result.steps.find(step => step.status === 'BLOCKED' && step.gate === 'restart-review-cycle'
        && /--review-restart-approved yes/u.test(step.command ?? ''));
}

test('a write after the review gate passed is reverted and the task closes without a new review cycle', { timeout: 1_800_000, concurrency: false }, async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const base = WALK_SCENARIOS.find(entry => entry.id === 'source-edit-before-completion')!;
        const scenario = { ...base, id: base.id + '-unapproved-try', tryRestartWithoutApproval: true };
        const result = await walkTask(template, scenario);
        assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id + ': ' + finding.summary), []);
        assert.equal(result.outcome, 'done', result.detail);
        assert.deepEqual(result.reviewsByLane, { code: 1, test: 1 });

        const request = approvalRequest(result);
        assert.ok(request, 'next-step must stop on the write after REVIEW_GATE_PASSED');
        assert.match(request.reason, /src\/app\.ts/u);
        assert.match(request.reason, /revert that change and rerun next-step to continue closing/u);
        assert.match(request.reason, /tell the user and ask for approval/u);
        assert.match(request.command ?? '', /<ISO-8601 timestamp of the user approval>/u);
        assert.doesNotMatch(request.command ?? '', /--operator-confirmed/u, 'the review restart approval is not task-mode consent');
        assert.equal(request.reverted, true);

        const refused = request.unapprovedRestart;
        assert.ok(refused, 'the walk tried the restart without approval');
        assert.notEqual(refused.exitCode, 0);
        assert.notEqual(refused.threw, true, refused.output);
        assert.match(refused.output, /REVIEW_CYCLE_RESTART_REFUSED/u);
        assert.match(refused.output, /requires the user's approval/u);
        assert.match(refused.output, /Revert the change and continue closing/u);
        assert.equal(result.events.filter(event => /CYCLE_RESTARTED$/u.test(event.type)).length, 0,
            'the refused restart changed nothing');
    } finally {
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('with the user approval the write after the review gate starts a new, recorded cycle that repeats only what it reaches', { timeout: 1_800_000, concurrency: false }, async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const scenario = WALK_SCENARIOS.find(entry => entry.id === 'source-edit-before-completion-user-approves')!;
        const result = await walkTask(template, scenario);
        assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id + ': ' + finding.summary), []);
        assert.equal(result.outcome, 'done', result.detail);
        assert.deepEqual(result.reviewsByLane, { code: 2, test: 2 });
        assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode), ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA']);
        assert.ok(!result.steps.some(step => step.gate === 'restart-coherent-cycle'), 'the approved cycle keeps the passed baseline');
        const request = approvalRequest(result);
        assert.ok(request?.userApproval, 'the restart ran only after the synthetic user approved it');
        assert.equal(request.exitCode, 0, request.output);
        const restarts = result.events.filter(event => event.type === 'REVIEW_CYCLE_RESTARTED');
        assert.equal(restarts.length, 1);
        assert.equal(restarts[0].details.review_restart_approved, true);
        assert.equal(restarts[0].details.review_restart_after_event, 'REVIEW_GATE_PASSED');
        assert.match(String(restarts[0].details.review_restart_approved_at_utc), /^\d{4}-\d{2}-\d{2}T/u);
        assert.ok((restarts[0].details.review_restart_changed_files as string[]).includes('src/app.ts'));
    } finally {
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
