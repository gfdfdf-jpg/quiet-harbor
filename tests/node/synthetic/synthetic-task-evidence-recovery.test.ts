import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWalkTemplate, walkTaskFamily, type WalkScenario } from './engine/navigator-walk';
import { WALK_SCENARIOS } from './engine/walk-scenarios';

test('a finished review survives loss of both preflight and its retained copy', { timeout: 600_000 }, async () => {
    const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
    assert.ok(baseline);
    const variant: WalkScenario = {
        ...baseline,
        id: 'preflight-loss-without-retained-copy',
        expectedReviews: {},
        expectedModes: [],
        injection: {
            seed: 1785881697,
            baseline: baseline.id,
            step: -1, checkpoint: { lane: 'code' },
            gate: 'record-review-result',
            disturbances: [
                { kind: 'delete-artifact', artifact: {
                    kind: 'preflight', path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json'
                } },
                { kind: 'delete-artifact', artifact: {
                    kind: 'preflight', path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight-snapshot.json'
                } }
            ]
        }
    };
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const [control, recovered] = await walkTaskFamily(template, baseline, [variant]);
        assert.equal(control.outcome, 'done', control.detail);
        assert.equal(recovered.outcome, 'done', recovered.detail);
        assert.deepEqual(recovered.reviewsByLane, control.reviewsByLane);
        assert.equal(recovered.reviewsByLane.code, 1);
        assert.ok(recovered.events.some(event => event.type === 'PREFLIGHT_EVIDENCE_RESTORED'));
    } finally {
        assert.equal(path.dirname(template), os.tmpdir());
        assert.match(path.basename(template), /^garda-walk-template-/u);
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('a lost preflight and changed reviewed tree require a new review', { timeout: 600_000 }, async () => {
    const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
    assert.ok(baseline);
    const variant: WalkScenario = {
        ...baseline,
        id: 'preflight-loss-with-changed-tree',
        expectedReviews: {},
        expectedModes: [],
        injection: {
            seed: 1785881697,
            baseline: baseline.id,
            step: -1, checkpoint: { lane: 'code' },
            gate: 'record-review-result',
            disturbances: [
                { kind: 'delete-artifact', artifact: {
                    kind: 'preflight', path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json'
                } },
                { kind: 'edit-production' }
            ]
        }
    };
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const [control, changed] = await walkTaskFamily(template, baseline, [variant]);
        assert.equal(control.outcome, 'done', control.detail);
        assert.equal(changed.outcome, 'done', changed.detail);
        assert.equal(control.reviewsByLane.code, 1);
        assert.equal(changed.reviewsByLane.code, 2, JSON.stringify(changed.reviews));
        assert.ok(changed.events.filter(event => event.type === 'PREFLIGHT_CLASSIFIED').length >= 2);
    } finally {
        assert.equal(path.dirname(template), os.tmpdir());
        assert.match(path.basename(template), /^garda-walk-template-/u);
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('a lost full-suite result and changed reviewed tree require a new review', { timeout: 600_000 }, async () => {
    const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
    assert.ok(baseline);
    const variant: WalkScenario = {
        ...baseline,
        id: 'full-suite-loss-with-changed-tree',
        expectedReviews: {},
        expectedModes: [],
        injection: {
            seed: 1785881697,
            baseline: baseline.id,
            step: -1, checkpoint: { lane: 'test' },
            gate: 'prepare-reviewer-launch',
            disturbances: [
                { kind: 'delete-artifact', artifact: {
                    kind: 'report', path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-full-suite-validation.json'
                } },
                { kind: 'edit-production' }
            ]
        }
    };
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const [control, changed] = await walkTaskFamily(template, baseline, [variant]);
        assert.equal(control.outcome, 'done', control.detail);
        assert.equal(changed.outcome, 'done', changed.detail);
        assert.equal(control.reviewsByLane.code, 1);
        assert.equal(changed.reviewsByLane.code, 2, JSON.stringify(changed.reviews));
        const passes = changed.events.filter(event => event.type === 'FULL_SUITE_VALIDATION_PASSED');
        assert.ok(passes.length >= 2, JSON.stringify(changed.events));
        assert.notDeepEqual(passes[0].details.cycle_binding, passes.at(-1)?.details.cycle_binding);
    } finally {
        assert.equal(path.dirname(template), os.tmpdir());
        assert.match(path.basename(template), /^garda-walk-template-/u);
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
