import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { writePreflight, writeWorkflowConfig } from './task-audit-summary-fixtures';

test('task audit refuses an omitted legacy API lane even for a retained DONE task', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-audit-required-reviews-'));
    const taskId = 'T-retained-done', reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator/runtime/task-events'), { recursive: true });
        writeWorkflowConfig(repoRoot, false);
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${taskId} | DONE | P1 | app | Scope request | agent | 2026-10-29 | balanced | Reviews: api; Required reviews: code, test. |`
        ].join('\n'));
        const inspect = (api: unknown) => {
            writePreflight(reviewsRoot, taskId, { task_id: taskId, required_reviews: { code: true, test: true, api } });
            return buildTaskAuditSummary({ repoRoot, taskId });
        };
        for (const value of [false, 'true', undefined]) {
            const result = inspect(value);
            assert.ok(result.blockers.some(b => b.gate === 'required-reviews-check'
                && b.reason.includes('preflight omits currently declared required reviews: api')));
            assert.notEqual(result.status, 'PASS');
        }
        assert.equal(inspect(true).blockers.some(b => b.reason.includes('preflight omits currently declared')), false);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
