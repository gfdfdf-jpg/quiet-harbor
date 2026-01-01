import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTask } from './engine/navigator-walk';
import { removeWalkDirectory } from './engine/walk-checkpoint';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { buildSweepScenarios } from './engine/walk-sweep';

test('a failed compile is retried and an authorized task reset repeats completed reviews', { timeout: 1_800_000 }, async () => {
    const baseline = WALK_SCENARIOS.find(scenario => scenario.id === 'clean-pass');
    assert.ok(baseline);
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const initial = await walkTask(template, baseline);
        assert.equal(initial.outcome, 'done', initial.detail);
        assert.deepEqual(compareWalk(baseline, initial), []);
        const compileStep = initial.steps.find(step => step.gate === 'compile-gate')?.index;
        const resetStep = initial.steps.find(step => step.gate === 'completion-gate')?.index;
        assert.notEqual(compileStep, undefined);
        assert.notEqual(resetStep, undefined);
        const variants = buildSweepScenarios([{ scenario: baseline, result: initial }], 1785881697);
        const retry = variants.find(scenario => scenario.injection && scenario.injection.step === compileStep
            && scenario.injection.disturbances.length === 1 && scenario.injection.disturbances[0].kind === 'fail-gate');
        const reset = variants.find(scenario => scenario.injection && scenario.injection.step === resetStep
            && scenario.injection.disturbances.length === 1 && scenario.injection.disturbances[0].kind === 'reset-task');
        const mixedReset = variants.find(scenario => {
            const kinds = scenario.injection?.disturbances.map(entry => entry.kind).sort().join(',');
            return kinds === 'edit-document,edit-test,repeat-last,reset-task';
        });
        assert.ok(retry && reset && mixedReset);

        const recovered = await walkTask(template, retry);
        assert.equal(recovered.outcome, 'done', recovered.detail);
        assert.deepEqual(compareWalk(retry, recovered), []);
        const compileAttempts = recovered.steps.filter(step => step.gate === 'compile-gate' && step.index >= compileStep!);
        assert.ok(compileAttempts.some(step => step.exitCode !== 0));
        assert.ok(compileAttempts.some(step => step.exitCode === 0));

        const restarted = await walkTask(template, reset);
        assert.equal(restarted.outcome, 'done', restarted.detail);
        assert.deepEqual(compareWalk(reset, restarted), []);
        assert.ok(restarted.steps.find(step => step.index === resetStep)?.preparation?.some(entry => /^RESET_COMPLETE$/mu.test(entry.output)));
        const repeated = restarted.reviews.filter(review => review.step !== undefined && review.step > resetStep!)
            .map(review => review.lane + ':' + review.mode);
        assert.deepEqual(repeated, ['code:FULL', 'test:FULL']);

        const mixed = await walkTask(template, mixedReset);
        assert.equal(mixed.outcome, 'done', mixed.detail);
        assert.deepEqual(mixed.reviews.map(review => review.lane + ':' + review.mode), ['code:FULL', 'test:FULL'],
            'An injected edit must not hide the original planned implementation');
        assert.ok(mixed.steps.some(step => step.gate === 'record-review-result' && step.exitCode === 0),
            'A mixed test/document review must retain its document coverage citations');
    } finally {
        removeWalkDirectory(template);
    }
});
