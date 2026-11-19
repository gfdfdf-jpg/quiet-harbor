import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveReviewRestartApproval } from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-restart-approval';

// Policy-level tests complement the real end-to-end walks: invalid consent must never authorize a late write.
test('late review restart requires fresh, separate consent; unchanged evidence recovery needs none', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-approval-'));
    const originalNow = Date.now;
    const now = Date.now();
    Date.now = () => now;
    try {
        execFileSync('git', ['init', '--quiet'], { cwd: repoRoot, windowsHide: true });
        const runtime = path.join(repoRoot, 'garda-agent-orchestrator/runtime');
        const timelinePath = path.join(runtime, 'task-events/T-approval.jsonl');
        const preflightPath = path.join(runtime, 'reviews/T-approval-preflight.json');
        fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
        fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/\n');
        execFileSync('git', ['add', '.gitignore'], { cwd: repoRoot, windowsHide: true });
        execFileSync('git', ['-c', 'user.name=Stand', '-c', 'user.email=stand@example.invalid', 'commit', '--quiet', '-m', 'fixture'],
            { cwd: repoRoot, windowsHide: true });
        fs.writeFileSync(timelinePath, JSON.stringify({ event_type: 'REVIEW_GATE_PASSED' }) + '\n');
        fs.writeFileSync(preflightPath, JSON.stringify({
            detection_source: 'git_auto', changed_files: [], metrics: { changed_lines_total: 0 }
        }));
        const input = { repoRoot, taskId: 'T-approval', preflightPath, taskMode: {} };
        assert.equal(resolveReviewRestartApproval(input).required, false);
        fs.writeFileSync(path.join(repoRoot, 'late.ts'), 'export const late = true;\n');
        const timelineBefore = fs.readFileSync(timelinePath, 'utf8');
        const preflightBefore = fs.readFileSync(preflightPath, 'utf8');
        for (const [approval, message] of [
            [{}, /requires the user's approval/u],
            [{ approved: 'yes' }, /requires --review-restart-approved-at-utc/u],
            [{ approved: 'no', approvedAtUtc: new Date().toISOString() }, /exact value "yes"/u],
            [{ approved: 'yes', approvedAtUtc: 'invalid' }, /valid ISO-8601 timestamp/u],
            [{ approved: 'yes', approvedAtUtc: new Date(now - 10 * 60_000 - 1).toISOString() }, /stale/u],
            [{ approved: 'yes', approvedAtUtc: new Date(Date.now() + 120_000).toISOString() }, /in the future/u]
        ] as const) {
            assert.throws(() => resolveReviewRestartApproval({ ...input, ...approval }), message);
            assert.equal(fs.readFileSync(timelinePath, 'utf8'), timelineBefore);
            assert.equal(fs.readFileSync(preflightPath, 'utf8'), preflightBefore);
        }
        const approvedAtUtc = new Date().toISOString();
        const accepted = resolveReviewRestartApproval({ ...input, approved: 'yes', approvedAtUtc });
        assert.equal(accepted.required, true);
        assert.equal(accepted.approvedAtUtc, approvedAtUtc);
        assert.deepEqual(accepted.changedFilesAfterReviewGate, ['late.ts']);
        assert.equal(resolveReviewRestartApproval({ ...input, approved: 'yes',
            approvedAtUtc: new Date(now - 10 * 60_000).toISOString() }).required, true,
        'the documented ten-minute boundary is inclusive');
        fs.rmSync(path.join(repoRoot, 'late.ts'));
        assert.equal(resolveReviewRestartApproval(input).required, false, 'reverting keeps the passed review cycle');
    } finally {
        Date.now = originalNow;
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
