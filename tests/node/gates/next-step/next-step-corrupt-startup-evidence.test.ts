import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTask, type WalkScenario } from '../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';
import type { SweepDisturbance } from '../../synthetic/engine/walk-sweep';

// Operator decision 2026-11-04: corrupt startup evidence binds no review, so Garda rebuilds it through the real gates
// instead of refusing until a task reset. Before preflight the startup checks repeat; after it the coherent cycle
// restarts. The walk reaches DONE, every review runs once as planned, and nothing asks for task-reset.
test('corrupt startup evidence is rebuilt by Garda before and after preflight', { timeout: 1_800_000, concurrency: false }, async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const clean = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass')!;
        const baseline = await walkTask(template, clean);
        assert.equal(baseline.outcome, 'done', baseline.detail);
        const classify = baseline.steps.find(step => step.gate === 'classify-change')!;
        const compile = baseline.steps.find(step => step.gate === 'compile-gate')!;
        const handshake = classify.reads?.find(read => /handshake/u.test(read.path));
        assert.ok(handshake, 'classify-change must read the handshake artifact: ' + JSON.stringify(classify.reads));
        const cases: Array<{ step: typeof classify; gate: string; recovery: string }> = [
            { step: classify, gate: 'classify-change', recovery: 'handshake-diagnostics' },
            { step: compile, gate: 'compile-gate', recovery: 'restart-coherent-cycle' }
        ];
        for (const entry of cases) {
            const disturbance: SweepDisturbance = { kind: 'corrupt-artifact', artifact: handshake };
            const scenario: WalkScenario = { ...clean, id: 'corrupt-startup-' + entry.gate, expectedReviews: {}, expectedModes: [],
                injection: { seed: 1, baseline: 'clean-pass', step: entry.step.index, gate: entry.gate, disturbances: [disturbance] } };
            const result = await walkTask(template, scenario);
            assert.equal(result.outcome, 'done', entry.gate + ': ' + result.detail);
            const after = result.steps.filter(step => step.index >= entry.step.index);
            assert.ok(after.some(step => step.gate === entry.recovery), entry.gate + ': ' + after.map(step => step.gate).join(' > '));
            assert.ok(!after.some(step => /task-reset/u.test(step.reason) || step.gate === 'startup-evidence-recovery'), entry.gate);
            assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode).sort(), ['code:FULL', 'test:FULL'], entry.gate);
            assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id), [], entry.gate);
        }
    } finally {
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
