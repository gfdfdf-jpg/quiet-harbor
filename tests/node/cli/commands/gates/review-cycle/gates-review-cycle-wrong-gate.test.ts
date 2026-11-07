import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTaskFamily, type WalkScenario } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import type { WrongGate } from '../../../../synthetic/engine/walk-sweep';
import { readPrematureCompletionRefusal } from '../../../../../../src/gates/completion/completion-premature-refusal';
import {
    INTACT_CYCLE_FORWARD_GATES,
    POST_REVIEW_GATES,
    REVIEW_LAUNCH_GATES,
    routesIntactCycleElsewhere,
    type NavigatorRoute
} from '../../../../../../src/cli/commands/gate-flows/support/out-of-order-gate-guard';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';

// An agent that ignores next-step and runs another gate must not cost a new review cycle (tests/node/synthetic/README.md).

test('a premature completion-gate is refused only before the current cycle passed its review gate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-premature-completion-'));
    try {
        const timeline = path.join(root, 'T-1.jsonl');
        const write = (...types: string[]) => fs.writeFileSync(timeline, types.map(type => JSON.stringify({
            event_type: type, timestamp_utc: '2026-11-01T00:00:00.000Z', details: {} })).join('\n') + '\n');
        write('TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_RECORDED');
        assert.match(readPrematureCompletionRefusal('T-1', timeline)?.reason ?? '', /REVIEW_GATE_PASSED in the current task cycle/u);
        write('TASK_MODE_ENTERED', 'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED', 'DOC_IMPACT_ASSESSED');
        assert.equal(readPrematureCompletionRefusal('T-1', timeline), null);
        write('TASK_MODE_ENTERED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE');
        assert.equal(readPrematureCompletionRefusal('T-1', timeline), null);
        for (const restart of ['COHERENT_CYCLE_RESTARTED', 'REVIEW_CYCLE_RESTARTED', 'TASK_RESET', 'TASK_MODE_ENTERED']) {
            write('TASK_MODE_ENTERED', 'REVIEW_GATE_PASSED', restart, 'COMPILE_GATE_PASSED');
            assert.ok(readPrematureCompletionRefusal('T-1', timeline), 'A review gate before ' + restart + ' is not current');
        }
        // An unreadable or missing timeline is judged by the gate itself, never refused here.
        fs.writeFileSync(timeline, '{broken\n');
        assert.equal(readPrematureCompletionRefusal('T-1', timeline), null);
        assert.equal(readPrematureCompletionRefusal('T-1', path.join(root, 'missing.jsonl')), null);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the out-of-order guard refuses only when the navigator routes an intact cycle elsewhere', () => {
    const route = (nextGate: string | null, status = 'BLOCKED', commands: string[] = []): NavigatorRoute =>
        ({ nextGate, status, lane: '', navigatorCommand: 'garda next-step T-1', commands });
    assert.equal(routesIntactCycleElsewhere(route('record-review-result'), 'restart-coherent-cycle', INTACT_CYCLE_FORWARD_GATES), true);
    assert.equal(routesIntactCycleElsewhere(route('restart-coherent-cycle'), 'restart-coherent-cycle', INTACT_CYCLE_FORWARD_GATES), false);
    assert.equal(routesIntactCycleElsewhere(route('completion-gate', 'BLOCKED', ['garda gate restart-coherent-cycle --task-id T-1']),
        'restart-coherent-cycle', INTACT_CYCLE_FORWARD_GATES), false, 'A command naming the gate is a route to it');
    assert.equal(routesIntactCycleElsewhere(route('full-suite-validation', 'BLOCKED', ['garda gate compile-gate-extra --task-id T-1']),
        'compile-gate', INTACT_CYCLE_FORWARD_GATES), true, 'Only the exact gate name counts');
    for (const recovery of ['next-step-effect', 'quality-checklist', 'classify-change', 'review-cycle-attempt-guard'])
        assert.equal(routesIntactCycleElsewhere(route(recovery), 'restart-coherent-cycle', INTACT_CYCLE_FORWARD_GATES), false, recovery);
    assert.equal(routesIntactCycleElsewhere(route(null, 'DONE'), 'compile-gate', INTACT_CYCLE_FORWARD_GATES), false);
    assert.equal(routesIntactCycleElsewhere(null, 'compile-gate', INTACT_CYCLE_FORWARD_GATES), false, 'A navigator that cannot route never blocks');
    assert.ok(REVIEW_LAUNCH_GATES.every(gate => INTACT_CYCLE_FORWARD_GATES.includes(gate)));
    assert.ok(POST_REVIEW_GATES.every(gate => INTACT_CYCLE_FORWARD_GATES.includes(gate)));
});

test('wrong gates while a review is in flight and after reviews are recorded cost no extra review or restart',
    { timeout: 900_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        // Step indexes of the clean-pass baseline: 19 waits for the code review result, 26 for required-reviews-check.
        const checkpoints: Array<{ step: number; gate: string; route: string; wrong: WrongGate[] }> = [
            { step: 20, gate: 'record-review-result', route: 'BLOCKED/record-review-result/code',
                wrong: ['compile-gate', 'build-review-context', 'completion-gate', 'restart-coherent-cycle'] },
            { step: 27, gate: 'required-reviews-check', route: 'BLOCKED/required-reviews-check',
                wrong: ['compile-gate', 'build-review-context', 'completion-gate', 'restart-coherent-cycle'] }
        ];
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            for (const checkpoint of checkpoints) {
                const variants: WalkScenario[] = checkpoint.wrong.map(gate => ({ ...baseline, id: 'wrong-' + gate + '-s' + checkpoint.step,
                    expectedReviews: {}, expectedModes: [],
                    injection: { seed: 0, baseline: baseline.id, step: checkpoint.step, gate: checkpoint.gate,
                        disturbances: [{ kind: 'wrong-gate', gate }],
                        undisturbed: { reviews: { code: 1, test: 1 }, restarts: {}, returnRoutes: [checkpoint.route],
                            milestones: ['COMPILE_GATE_PASSED', 'FULL_SUITE_VALIDATION_PASSED', 'REVIEW_GATE_PASSED', 'COMPLETION_GATE_PASSED'] } } }));
                const results = await walkTaskFamily(template, baseline, variants);
                for (const result of results.filter(entry => !entry.checkpointControl)) {
                    const variant = variants.find(entry => entry.id === result.scenarioId)!;
                    const wrong = result.steps.find(step => step.wrongGate)?.wrongGate;
                    assert.ok(wrong, result.scenarioId + ': ' + result.detail);
                    assert.notEqual(wrong.exitCode, 0, result.scenarioId + ' must refuse: ' + wrong.output.slice(0, 600));
                    assert.match(wrong.output, /_REFUSED\b/u, result.scenarioId);
                    assert.equal(result.outcome, 'done', result.scenarioId + ': ' + result.detail.slice(0, 600));
                    assert.deepEqual(result.reviewsByLane, { code: 1, test: 1 }, result.scenarioId);
                    assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), [], result.scenarioId);
                }
            }
        } finally { removeWalkDirectory(template); }
    });
