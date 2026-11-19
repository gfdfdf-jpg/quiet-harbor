import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareWalk, createWalkTemplate, walkTask, type WalkScenario } from '../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';
import type { SweepDisturbance } from '../../synthetic/engine/walk-sweep';

test('lost reservation and corrupt launched control stop with an operator recovery, without reconstructing authority',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const clean = WALK_SCENARIOS.find(scenario => scenario.id === 'clean-pass')!;
            const baseline = await walkTask(template, clean);
            assert.equal(baseline.outcome, 'done', baseline.detail);
            for (const [gate, kind, suffix] of [
                ['record-reviewer-delegation-started', 'delete-artifact', '.lane-reservation.json'],
                ['record-review-result', 'stale-artifact', '']
            ] as const) {
                const checkpoint = baseline.steps.find(step => step.gate === gate && step.command?.includes('--review-type "code"'));
                assert.ok(checkpoint);
                const disturbance: SweepDisturbance = { kind, artifact: {
                    path: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/code/reviewer-launch.json' + suffix, kind: 'launch'
                } };
                const scenario: WalkScenario = { ...clean, id: 'lost-launch-control-' + kind,
                    injection: { seed: 1, baseline: clean.id, step: checkpoint.index, gate, disturbances: [disturbance] } };
                const result = await walkTask(template, scenario);
                assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id + ': ' + finding.summary), []);
                assert.equal(result.outcome, 'blocked', result.detail);
                assert.match(result.detail, /Ask the operator to reset this task with task-reset and enter it again/u);
                assert.doesNotMatch(result.detail, /ENOENT:|SyntaxError:/u);
            }
        } finally { fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    });
