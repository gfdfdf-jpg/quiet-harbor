import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { compareWalk, createWalkTemplate, walkTask, type WalkScenario } from '../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';
import { hasHumanRecovery } from '../../synthetic/engine/walk-sweep';

// Decision 4: a production edit during a docs-only task keeps hitting the code-review safety floor. The refusal
// must name its way out: revert the edit, or re-enter the task with a profile that has the code review.
test('a production edit in a docs-only task is refused with a named way out', { timeout: 900_000, concurrency: false }, async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const documentOnly = WALK_SCENARIOS.find(entry => entry.id === 'document-only')!;
        const scenario: WalkScenario = { ...documentOnly, id: 'docs-only-production-edit', expectedReviews: {}, expectedModes: [],
            injection: { seed: 1, baseline: 'document-only', step: 2, gate: 'handshake-diagnostics', disturbances: [{ kind: 'edit-production' }] } };
        const result = await walkTask(template, scenario);
        const refusal = result.steps.find(step => step.gate === 'classify-change' && step.exitCode);
        assert.ok(refusal, 'classify-change must refuse the production edit');
        assert.match(refusal.output, /code-review safety floor cannot be satisfied/u, 'The safety floor still refuses');
        assert.match(refusal.output, /Revert the code edit so the task stays within its profile/u);
        assert.match(refusal.output, /reset the task \(garda gate task-reset\) and enter it again with a profile whose review policy includes the code review/u);
        assert.ok(hasHumanRecovery(refusal.output, 'classify-change'), 'The refusal names a different way out');
        assert.equal(result.outcome, 'blocked', result.detail);
        assert.equal(result.steps.filter(step => step.gate === 'classify-change' && step.exitCode).length, 1, 'The agent stops at the refusal instead of repeating it');
        assert.deepEqual(compareWalk(scenario, result).map(finding => finding.id), []);
    } finally {
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
