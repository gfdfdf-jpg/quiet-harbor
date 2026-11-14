import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getSafeWorktreePathState } from '../../../../src/gates/workspace/worktree-path-state';
import {
    resolveReviewedTreeUpstreamReadiness,
    reviewerFinishedBeforeWorkspaceChange
} from '../../../../src/gates/review-remediation/reviewed-tree-upstream-reviews';

// A passed review may be recorded against the tree it reviewed after the workspace changed only when its reviewer
// demonstrably finished first: its output is older than every reviewed file that changed. Anything else fails closed.

const FILES = ['src/app.ts', 'tests/app.test.ts'];
const OUTPUT = 'garda-agent-orchestrator/runtime/tmp/reviews/T-902/code/review-output.json';

function withRepo(run: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-reviewed-upstream-'));
    try {
        fs.mkdirSync(path.join(root, 'src'));
        fs.mkdirSync(path.join(root, 'tests'));
        fs.writeFileSync(path.join(root, 'src/app.ts'), 'export const status = "ok";\n');
        fs.writeFileSync(path.join(root, 'tests/app.test.ts'), 'import "../src/app";\n');
        run(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

/** The reviewed tree as build-review-context records it, then the reviewer's output written at `finishedAt`. */
function finishReview(root: string, finishedAt: Date, useStaged = false): Record<string, unknown> {
    const context = { tree_state: { use_staged: useStaged, tree_state_sha256: 'a'.repeat(64),
        entries: FILES.map(file => ({ path: file, worktree: { ...getSafeWorktreePathState(root, file) } })) } };
    fs.mkdirSync(path.dirname(path.join(root, OUTPUT)), { recursive: true });
    fs.writeFileSync(path.join(root, OUTPUT), '{}\n');
    fs.utimesSync(path.join(root, OUTPUT), finishedAt, finishedAt);
    return context;
}

function edit(root: string, file: string, at: Date): void {
    fs.appendFileSync(path.join(root, file), 'export const extra = 1;\n');
    fs.utimesSync(path.join(root, file), at, at);
}

const T0 = new Date('2026-11-03T10:00:00.000Z');
const BEFORE = new Date('2026-11-03T09:59:00.000Z');
const AFTER = new Date('2026-11-03T10:01:00.000Z');

test('an unchanged reviewed tree and a change after the reviewer finished prove the review', () => {
    withRepo((root) => {
        const context = finishReview(root, T0);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: context, reviewOutputPath: OUTPUT }), true);
        edit(root, 'src/app.ts', AFTER);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: context, reviewOutputPath: OUTPUT }), true);
    });
});

test('a reviewed file changed before the output was written fails closed', () => {
    withRepo((root) => {
        const context = finishReview(root, T0);
        edit(root, 'src/app.ts', BEFORE);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: context, reviewOutputPath: OUTPUT }), false);
        // The same instant is no proof either.
        edit(root, 'src/app.ts', T0);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: context, reviewOutputPath: OUTPUT }), false);
    });
});

test('a restored output uses its authenticated original timestamp when checking later edits', () => {
    withRepo(root => {
        const context = finishReview(root, T0);
        const originalMtime = fs.statSync(path.join(root, OUTPUT)).mtimeMs;
        edit(root, 'src/app.ts', AFTER);
        const restoredAt = new Date(AFTER.getTime() + 60_000);
        fs.utimesSync(path.join(root, OUTPUT), restoredAt, restoredAt);
        const input = { repoRoot: root, reviewContext: context, reviewOutputPath: OUTPUT };
        assert.equal(reviewerFinishedBeforeWorkspaceChange(input), false);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ ...input, authenticatedOutputMtimeMs: originalMtime }), true);
        edit(root, 'src/app.ts', BEFORE);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ ...input, authenticatedOutputMtimeMs: originalMtime }), false);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ ...input, authenticatedOutputMtimeMs: Number.NaN }), false);
    });
});

test('a deleted reviewed file, a staged review tree, a missing output or an unreadable context fail closed', () => {
    withRepo((root) => {
        const context = finishReview(root, T0);
        fs.rmSync(path.join(root, 'tests/app.test.ts'));
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: context, reviewOutputPath: OUTPUT }), false);
    });
    withRepo((root) => {
        const context = finishReview(root, T0, true);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: context, reviewOutputPath: OUTPUT }), false);
    });
    withRepo((root) => {
        const context = finishReview(root, T0);
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: context,
            reviewOutputPath: OUTPUT + '.missing' }), false);
        const contextPath = path.join(root, 'context.json');
        fs.writeFileSync(contextPath, '{ not json');
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: contextPath, reviewOutputPath: OUTPUT }), false);
        fs.writeFileSync(contextPath, JSON.stringify(context));
        assert.equal(reviewerFinishedBeforeWorkspaceChange({ repoRoot: root, reviewContext: contextPath, reviewOutputPath: OUTPUT }), true);
    });
});

test('upstream readiness on the reviewed tree needs a content-bound context and an authenticated timeline', () => {
    withRepo((root) => {
        const options = { repoRoot: root, taskId: 'T-902', reviewType: 'test', preflightPath: path.join(root, 'preflight.json'),
            preflightPayload: { required_reviews: { code: true, test: true } } };
        assert.equal(resolveReviewedTreeUpstreamReadiness({ ...options, reviewContextSha256: 'not-a-hash' }).ready, false);
        // No task timeline: nothing proves that the upstream review passed before this reviewer started.
        assert.equal(resolveReviewedTreeUpstreamReadiness({ ...options, reviewContextSha256: 'b'.repeat(64) }).ready, false);
    });
});
