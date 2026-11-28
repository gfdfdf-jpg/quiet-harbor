import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareWalk, createWalkTemplate, walkTask } from '../../synthetic/engine/navigator-walk';
import { r144FieldCase } from '../../synthetic/engine/walk-field-r144-scenarios';

/*
 * T-469 item 3: a history whose signed chain starts after an unsigned prefix (PASS_WITH_LEGACY_PREFIX) is a genuine
 * PASS from its first signed event on. Task-test selection and the later gates continue it to DONE, while a launch
 * found only in the unsigned prefix still authenticates nothing.
 */
test('a legacy-prefixed task history reaches DONE and a launch found only in the unsigned prefix is refused', async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const scenario = r144FieldCase('field-r144-legacy-prefix-continue');
        const result = await walkTask(template, scenario);
        const trace = result.steps.map(step => `${step.gate}:${step.exitCode}`).join(' > ');
        assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id), [], `${result.outcome} ${result.detail}\n${trace}`);
        assert.equal(result.outcome, 'done', `${result.detail}\n${trace}`);
        assert.deepEqual(result.reviewsByLane, { code: 1, test: 1 });

        // Negative control: its oracle asserts the refused self-check, the missing receipt and an executable operator
        // handoff (the reset preview runs and keeps the forged evidence); the walk must end at that handoff.
        const forgedScenario = r144FieldCase('field-r144-legacy-prefix-forged-launch');
        const forged = await walkTask(template, forgedScenario);
        const forgedTrace = forged.steps.map(step => `${step.gate}:${step.exitCode}`).join(' > ');
        assert.deepEqual(compareWalk(forgedScenario, forged).map(finding => finding.id), [],
            `${forged.outcome} ${forged.detail}\n${forgedTrace}`);
        assert.equal(forged.outcome, 'blocked', forged.detail);
        assert.equal(forged.reviewsByLane.code ?? 0, 0, 'no code review is recorded from the forged launch');
    } finally { fs.rmSync(template, { recursive: true, force: true }); }
});
