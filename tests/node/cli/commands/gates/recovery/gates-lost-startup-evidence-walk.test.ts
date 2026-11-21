import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTaskFamily, type WalkResult, type WalkScenario } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import type { EconomyFacts } from '../../../../synthetic/engine/walk-economy';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';

// Operator decision 2026-11-04: lost or corrupt startup evidence binds no review. Garda rebuilds it through the real
// startup gates: before preflight by repeating handshake-diagnostics and shell-smoke-preflight, after it through
// restart-coherent-cycle, which keeps passed reviews for an unchanged workspace and asks no approval.

// The clean-pass baseline: code launches at 18 and records at 19, test launches at 24 and records at 25.
const CLEAN: EconomyFacts = { dependencies: {}, scope: ['src/app.ts', 'tests/app.test.ts'], reviews: [
    { lane: 'code', mode: 'FULL', launched: 18, recorded: 19 }, { lane: 'test', mode: 'FULL', launched: 24, recorded: 25 }] };
const HANDSHAKE = 'garda-agent-orchestrator/runtime/reviews/T-WALK-handshake.json';

const describe = (result: WalkResult): string => result.scenarioId + ': ' + result.outcome + ' ' + result.detail.slice(0, 400)
    + ' routes=' + result.steps.filter(step => !step.reusedPrefix).map(step => step.gate + (step.exitCode ? '(exit ' + step.exitCode + ')' : '')).join(' > ');

const CASES = [
    // Before preflight: the startup checks repeat, then the ordinary walk continues to classify-change.
    { step: 3, gate: 'shell-smoke-preflight', loss: 'delete-artifact', recovery: 'handshake-diagnostics' },
    { step: 4, gate: 'classify-change', loss: 'corrupt-artifact', recovery: 'handshake-diagnostics' },
    // After preflight, before reviews: the coherent cycle restarts, then compile and the planned reviews.
    { step: 12, gate: 'compile-gate', loss: 'delete-artifact', recovery: 'restart-coherent-cycle' },
    { step: 12, gate: 'compile-gate', loss: 'corrupt-artifact', recovery: 'restart-coherent-cycle' },
    // After passed reviews: the restart keeps them and completion reaches DONE without repeating them.
    { step: 29, gate: 'doc-impact-gate', loss: 'delete-artifact', recovery: 'restart-coherent-cycle' },
    { step: 30, gate: 'completion-gate', loss: 'corrupt-artifact', recovery: 'restart-coherent-cycle' }
] as const;

test('lost or corrupt handshake evidence is rebuilt by Garda before and after preflight without repeating reviews',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const variants: WalkScenario[] = CASES.map(entry => ({ ...baseline,
            id: 'handshake-' + entry.loss + '-at-' + entry.step, expectedReviews: {}, expectedModes: [],
            injection: { seed: 0, baseline: baseline.id, step: entry.step, gate: entry.gate, economy: CLEAN,
                disturbances: [{ kind: entry.loss, artifact: { path: HANDSHAKE, kind: 'report' } }] } }));
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            // A checkpoint family shares one injection step, so each step walks as its own family.
            const results: WalkResult[] = [];
            for (const step of [...new Set(CASES.map(entry => entry.step))]) {
                results.push(...await walkTaskFamily(template, baseline,
                    variants.filter(variant => variant.injection?.step === step)));
            }
            for (const entry of CASES) {
                const variant = variants.find(candidate => candidate.id === 'handshake-' + entry.loss + '-at-' + entry.step)!;
                const result = results.find(candidate => candidate.scenarioId === variant.id);
                assert.ok(result, variant.id);
                assert.equal(result.outcome, 'done', describe(result));
                const after = result.steps.filter(step => !step.reusedPrefix && step.index >= entry.step);
                const gates = after.map(step => step.gate);
                assert.ok(gates.includes(entry.recovery), 'routes ' + entry.recovery + ': ' + describe(result));
                assert.ok(!gates.includes('task-reset') && !gates.includes('startup-evidence-recovery'), describe(result));
                if (entry.recovery === 'handshake-diagnostics') {
                    const recoveryIndex = gates.indexOf('handshake-diagnostics');
                    assert.deepEqual(gates.slice(recoveryIndex, recoveryIndex + 2), ['handshake-diagnostics', 'shell-smoke-preflight'],
                        describe(result));
                    assert.ok(gates.slice(recoveryIndex).includes('classify-change'), describe(result));
                }
                // No approval is asked and every review runs exactly as in the clean walk: once, in FULL.
                assert.ok(!after.some(step => /--review-restart-approved/u.test(step.command || '')), describe(result));
                assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode).sort(), ['code:FULL', 'test:FULL'],
                    describe(result));
                if (entry.step >= 26) {
                    assert.deepEqual(result.reviews.filter(review => (review.step ?? -1) >= entry.step), [],
                        'passed reviews are kept: ' + describe(result));
                }
                assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), [], describe(result));
            }
        } finally { removeWalkDirectory(template); }
    });
