import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
    compareWalk,
    createWalkTemplate,
    isDeadEnd,
    walkTask,
    type WalkResult,
    type WalkScenario
} from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';

// Sample of the navigator walk (tests/node/synthetic/README.md); the release run walks every scenario.
const SAMPLE_SCENARIO_ID = 'test-failed-fixed-in-source';

function walkResult(overrides: Partial<WalkResult>): WalkResult {
    return {
        scenarioId: 'stub', outcome: 'done', detail: '', steps: [], reviewsByLane: { code: 1 }, reviews: [{ lane: 'code', mode: 'FULL' }], events: [],
        ...overrides
    };
}

const STUB_SCENARIO: WalkScenario = { id: 'stub', edits: [], expectedReviews: { code: 1 }, expectedModes: ['code:FULL'] };

test('the walk treats a blocked step without a command or an instruction as a dead end', () => {
    const blocked = { task_id: 'T-1', navigator_command: 'garda next-step T-1', reason: '', commands: [] };
    assert.equal(isDeadEnd({ ...blocked, status: 'BLOCKED', next_gate: 'unknown-gate' }), true);
    assert.equal(isDeadEnd({ ...blocked, status: 'BLOCKED', next_gate: 'implementation' }), false);
    assert.equal(isDeadEnd({ ...blocked, status: 'DONE', next_gate: null }), false);
    assert.equal(isDeadEnd({ ...blocked, status: 'BLOCKED', next_gate: 'unknown-gate', commands: [{ command: 'garda gate x' }] as never }), false);
});

test('the walk reports every way a task can go wrong', () => {
    const ids = (result: Partial<WalkResult>, scenario = STUB_SCENARIO) => compareWalk(scenario, walkResult(result)).map((finding) => finding.id);
    assert.deepEqual(ids({}), []);
    assert.deepEqual(ids({ outcome: 'dead_end', detail: 'x' }), ['walk:outcome:dead_end:stub']);
    assert.deepEqual(ids({ outcome: 'loop', detail: 'x' }), ['walk:outcome:loop:stub']);
    assert.deepEqual(ids({ reviewsByLane: { code: 2 } }), ['walk:reviews:1->2:code:stub']);
    assert.deepEqual(ids({ reviewsByLane: {} }), ['walk:reviews:1->0:code:stub']);
    assert.deepEqual(ids({ reviews: [{ lane: 'code', mode: 'DELTA' }] }), ['walk:modes:stub']);
    const failedStep = { gate: 'compile-gate', exitCode: 1, output: 'failed' } as WalkResult['steps'][number];
    assert.deepEqual(ids({ steps: [failedStep] }), ['walk:gate-failed:compile-gate:stub']);
    assert.deepEqual(ids({ steps: [failedStep] }, { ...STUB_SCENARIO, expectedFailingGates: ['compile-gate'] }), []);
});

test('a small production fix reaches DONE with DELTA for both reached reviews', { timeout: 1_800_000, concurrency: false }, async () => {
    const scenario = WALK_SCENARIOS.find((entry) => entry.id === SAMPLE_SCENARIO_ID);
    assert.ok(scenario);
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const result = await walkTask(template, scenario);
        assert.deepEqual(compareWalk(scenario, result).map((finding) => `${finding.id}: ${finding.summary}`), []);
        assert.deepEqual(result.reviews.map((review) => `${review.lane}:${review.mode}`), ['code:FULL', 'test:FULL', 'code:DELTA', 'test:DELTA']);
        const effects = result.steps.filter(step => step.gate === 'next-step-effect');
        assert.ok(effects.length > 0, 'The sample must exercise effect execution');
        for (const effect of effects) {
            assert.ok(effect.reads?.some(input => input.kind === 'preflight'), 'Effect execution must discover its preflight input');
            assert.ok(effect.effectResult?.routes.length, 'Effect execution must retain its selected source route');
        }
    } finally {
        removeWalkDirectory(template);
    }
});
