import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTask, type WalkScenario } from '../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';
import type { SweepDisturbance } from '../../synthetic/engine/walk-sweep';
import { removeWalkDirectory } from '../../synthetic/engine/walk-checkpoint';

// Decision 1: a lost or corrupt pinned task-mode policy is never regenerated. next-step must not recommend
// enter-task-mode (which refuses to replace the frozen snapshot); it names the operator reset and re-entry.
const TASK_MODE = { path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-task-mode.json', kind: 'report' as const };

test('a lost, corrupt or stale pinned task-mode policy ends at an operator reset handoff, never at re-entry', { timeout: 900_000, concurrency: false }, async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const clean = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass')!;
        for (const kind of ['delete-artifact', 'corrupt-artifact', 'stale-artifact'] as const) {
            const disturbance: SweepDisturbance = { kind, artifact: TASK_MODE };
            const scenario: WalkScenario = { ...clean, id: 'lost-task-mode-policy-' + kind, expectedReviews: {}, expectedModes: [],
                injection: { seed: 1, baseline: 'clean-pass', step: 2, gate: 'handshake-diagnostics', disturbances: [disturbance] } };
            const result = await walkTask(template, scenario);
            const terminal = result.steps.at(-1)!;
            assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id + ': ' + finding.summary), [], kind);
            assert.equal(result.steps.some(entry => entry.gate === 'enter-task-mode' && !!entry.exitCode), false,
                kind + ': next-step must not recommend a re-entry that refuses');
            // Rebinding the artifact's timestamps and scope digests leaves the pinned snapshot itself intact here.
            if (kind === 'stale-artifact' && result.outcome === 'done') continue;
            assert.equal(result.outcome, 'blocked', kind + ': ' + result.detail);
            assert.equal(terminal.gate, 'task-reset', kind + ': ' + terminal.reason);
            assert.match(terminal.reason, /never regenerates a frozen task policy/u, kind);
            assert.match(terminal.reason, /Ask the operator to preserve the task evidence and source work, reset the task, then enter it again\./u, kind);
            assert.match(String(terminal.command), /gate task-reset --task-id "T-WALK" --reopen --dry-run/u, kind);
            assert.equal(terminal.exitCode, 0, kind + ': the reset preview must run: ' + terminal.output);
            assert.equal(result.steps.some(entry => entry.index > 2 && entry.gate === 'enter-task-mode'), false,
                kind + ': next-step must not recommend re-entry');
        }
    } finally {
        removeWalkDirectory(template);
    }
});
