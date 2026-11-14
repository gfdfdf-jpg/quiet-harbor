import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    createTempRepo, seedTaskQueue, seedInitAnswers, runEnterTaskMode, loadTaskEntryRulePack,
    runHandshakeForTask, runShellSmokeForTask, runExplicitPreflight
} from '../../gate-test-helpers';
import { prepareOperatorTaskIntentUpdate, recordOperatorTaskIntentUpdate } from '../../../../../../src/gates/review-context/review-context-task-intent';
import { computeTaskCriteriaBinding, hasTaskCriteriaChanged } from '../../../../../../src/gates/review-context/review-context-task-criteria-binding';
import { assessTrustBoundaryAnalysisApplicability } from '../../../../../../src/core/trust-boundary-analysis';

test('classify-change retains operator authorization obligations through agent descriptions on a neutral path', () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-operator-authorization';
    const operatorIntent = 'Enforce the authorization boundary before rendering status';
    try {
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src/status.ts'), 'export const status = 0;\n');
        runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Render status', plannedChangedFiles: ['src/status.ts'] });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'src/status.ts'), 'export const status = 1;\n');
        const update = prepareOperatorTaskIntentUpdate({ repoRoot, taskId, previousIntent: 'Render status',
            taskIntent: operatorIntent, operatorConfirmed: 'yes' });
        assert.ok(update);
        recordOperatorTaskIntentUpdate(repoRoot, update);
        const classify = (intent: string) => JSON.parse(fs.readFileSync(
            runExplicitPreflight(repoRoot, taskId, intent, ['src/status.ts']), 'utf8'));
        const confirmed = classify(operatorIntent);
        const described = classify('Render status with clearer labels');
        assert.equal(confirmed.triggers.security_intent, true);
        assert.equal(described.triggers.security_intent, true);
        assert.equal(described.required_reviews.security, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability(described).required, true);
        assert.equal(hasTaskCriteriaChanged(computeTaskCriteriaBinding({ repoRoot, taskId, preflight: confirmed }),
            computeTaskCriteriaBinding({ repoRoot, taskId, preflight: described })), false);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
