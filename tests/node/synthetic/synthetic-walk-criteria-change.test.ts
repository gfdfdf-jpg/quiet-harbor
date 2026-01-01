import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTask } from './engine/navigator-walk';
import { removeWalkDirectory } from './engine/walk-checkpoint';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { buildSweepScenarios } from './engine/walk-sweep';

test('changed task criteria after passed reviews repeat every review in FULL after the coherent restart', { timeout: 1_800_000 }, async () => {
    const baseline = WALK_SCENARIOS.find(scenario => scenario.id === 'clean-pass');
    assert.ok(baseline);
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const initial = await walkTask(template, baseline);
        assert.equal(initial.outcome, 'done', initial.detail);
        const lastRecorded = Math.max(...initial.steps.filter(step => step.gate === 'record-review-result').map(step => step.index));
        const checkStep = initial.steps.find(step => step.gate === 'required-reviews-check' && step.index > lastRecorded)?.index;
        assert.notEqual(checkStep, undefined);
        // The criteria change once both reviews have passed (the stand rewrites the task's TASK.md title).
        const changed = buildSweepScenarios([{ scenario: baseline, result: initial }], 1785881697).filter(scenario =>
            scenario.injection && scenario.injection.step > checkStep! && scenario.injection.disturbances.length === 1
            && scenario.injection.disturbances[0].kind === 'change-criteria')
            .sort((left, right) => left.injection!.step - right.injection!.step)[0];
        assert.ok(changed, 'the sweep offers a criteria change after the passed reviews');

        const walked = await walkTask(template, changed);
        assert.equal(walked.outcome, 'done', walked.detail);
        assert.deepEqual(compareWalk(changed, walked), []);
        const injection = changed.injection!.step;
        assert.ok(walked.steps.some(step => step.index >= injection && step.gate === 'restart-coherent-cycle'));
        const repeated = walked.reviews.filter(review => review.step !== undefined && review.step >= injection)
            .map(review => review.lane + ':' + review.mode);
        assert.deepEqual(repeated, ['code:FULL', 'test:FULL']);
        assert.ok(walked.steps.every(step => step.index < injection || !/ReviewReuseEvidence: REUSED/u.test(String(step.output))),
            'no review is kept on the old criteria');
        const completion = walked.steps.find(step => step.gate === 'completion-gate' && step.exitCode === 0)?.index;
        assert.ok(completion !== undefined && completion > Math.max(...walked.reviews.map(review => review.step ?? 0)),
            'the task completes only on the repeated reviews');
    } finally {
        removeWalkDirectory(template);
    }
});
