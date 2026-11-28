import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo } from '../git-fixtures';
import { resolveNextStep } from './next-step-test-support';
import {
    TASK_ID, ALL_REVIEW_FLAGS, makeTempRepo, seedStartedTask, writeGitAutoPreflight, seedGitAutoCompilePass,
    seedReviewGatePass, seedDocImpactPass, seedCompletionPass, materializeFinalCloseout
} from './next-step-completion-fixtures';

/*
 * T-469 item 7(a): a DONE task closes out against its authenticated classification. An older or edited preflight copy
 * with the same review graph but a wider scope must not hide post-DONE drift.
 */
it('a DONE task with a replaced wider preflight copy still detects post-DONE drift against the authenticated scope', () => {
    const repoRoot = makeTempRepo();
    try {
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { retainClassifiedSnapshot: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        materializeFinalCloseout(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'src', 'post-done-drift.ts'), 'export const drift = true;\n', 'utf8');

        // The drift is reported as a file outside the authenticated completed scope, which does not contain it.
        const outsideAuthenticatedScope = /Post-DONE workspace drift detected outside completed scope \[(?:(?!post-done-drift)[^\]])*\]: \[?src\/post-done-drift\.ts/u;
        const authentic = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(authentic.next_gate, 'post-done-drift', authentic.reason);
        assert.match(authentic.reason, outsideAuthenticatedScope);

        // Same review graph, wider scope: only the bytes differ from the authenticated output_sha256.
        const replaced = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        replaced.changed_files = [...(replaced.changed_files as string[]), 'src/post-done-drift.ts'];
        replaced.authorized_files = replaced.changed_files;
        fs.writeFileSync(preflightPath, `${JSON.stringify(replaced, null, 2)}\n`);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.status, 'BLOCKED', result.reason);
        assert.equal(result.next_gate, 'post-done-drift', result.reason);
        assert.match(result.reason, outsideAuthenticatedScope, 'the drift outside the authenticated scope stays visible');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
