import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createWalkTemplate, walkTask } from '../../synthetic/engine/navigator-walk';
import { r144FieldCase } from '../../synthetic/engine/walk-field-r144-scenarios';

test('required-lane recovery reaches DONE and approved lane adoption keeps passed code and test reviews', async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        for (const id of ['field-r144-unavailable-required-lane', 'field-r144-lane-enable-keeps-passed-reviews'] as const) {
            const result = await walkTask(template, r144FieldCase(id));
            assert.equal(result.outcome, 'done', result.detail);
            assert.equal(result.reviewsByLane.code, 1, 'approved lane adoption keeps the passed code review');
            assert.equal(result.reviewsByLane.test, 1, 'approved lane adoption keeps the passed test review');
            assert.equal(result.reviewsByLane.api, 1, 'the newly enabled required lane runs once');
            const adoption = result.steps.findIndex(step => step.command?.includes('--adopt-changed-review-policy'));
            assert.ok(adoption >= 0, 'the navigator offers the existing policy adoption route');
            assert.equal(result.steps[adoption].exitCode, 0, result.steps[adoption].output);
            assert.ok(result.steps.slice(adoption + 1).some(step => step.exitCode === 0 && step.gate !== 'enter-task-mode'),
                'navigation makes progress after the approved command');
            if (id === 'field-r144-lane-enable-keeps-passed-reviews') {
                for (const lane of ['code', 'test']) assert.ok(result.steps.slice(0, adoption)
                    .some(step => step.gate === 'record-review-result' && step.exitCode === 0
                        && step.command?.includes(`--review-type "${lane}"`)), `${lane} passed before adoption`);
            }
        }
    } finally { fs.rmSync(template, { recursive: true, force: true }); }
});
