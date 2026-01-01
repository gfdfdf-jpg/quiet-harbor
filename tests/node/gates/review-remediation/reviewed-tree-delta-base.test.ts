import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { getSafeWorktreePathState } from '../../../../src/gates/workspace/worktree-path-state';
import {
    buildReviewRemediationDeltaBase,
    type ReviewRemediationDeltaBase
} from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import {
    deltaBaseMatchesReviewedTree,
    getReviewedTreeDeltaBasePath,
    readReviewedTreeDeltaBase,
    writeReviewedTreeDeltaBase
} from '../../../../src/gates/review-remediation/reviewed-tree-delta-base';

const TASK_ID = 'T-901';
const TREE = 'a'.repeat(64);
const FILES = ['src/app.ts', 'tests/app.test.ts'];

function withRepo(run: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-reviewed-tree-'));
    try {
        fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
        fs.mkdirSync(path.join(root, 'src'));
        fs.mkdirSync(path.join(root, 'tests'));
        fs.writeFileSync(path.join(root, 'src/app.ts'), 'export const status = "ok";\nexport const render = () => status;\n');
        fs.writeFileSync(path.join(root, 'tests/app.test.ts'), 'import { render } from "../src/app";\nrender();\n');
        run(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

/** The review context's tree state as build-review-context records it: per-file worktree state and its hash. */
function reviewContext(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        tree_state: {
            use_staged: false,
            tree_state_sha256: TREE,
            entries: FILES.map((file) => ({ path: file, worktree: { ...getSafeWorktreePathState(root, file) } })),
            ...overrides
        }
    };
}

const read = (root: string, context: Record<string, unknown>, tree = TREE, changedFiles: readonly string[] = FILES) =>
    readReviewedTreeDeltaBase({ repoRoot: root, taskId: TASK_ID, reviewType: 'code', changedFiles, reviewContext: context,
        reviewTreeStateSha256: tree });

function rewrite(root: string, edit: (base: ReviewRemediationDeltaBase) => void): void {
    const file = getReviewedTreeDeltaBasePath(root, TASK_ID, 'code');
    const base = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewRemediationDeltaBase;
    edit(base);
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    for (const entry of base.entries) {
        if (entry.redacted_lines) {
            entry.line_hashes = entry.redacted_lines.map((line) => sha(line));
            entry.redacted_lines_sha256 = sha(entry.redacted_lines.join(''));
            entry.line_count = entry.redacted_lines.length;
        }
    }
    base.entries_sha256 = sha256RedactedJsonPayload(base.entries);
    const { snapshot_sha256: _snapshot, ...payload } = base;
    base.snapshot_sha256 = sha256RedactedJsonPayload(payload);
    fs.writeFileSync(file, JSON.stringify(base));
}

test('the content captured with a review context stays its baseline after the files change', () => {
    withRepo((root) => {
        const context = reviewContext(root);
        writeReviewedTreeDeltaBase({ repoRoot: root, taskId: TASK_ID, reviewType: 'code', changedFiles: FILES, reviewContext: context });
        fs.appendFileSync(path.join(root, 'src/app.ts'), '// changed after the review\n');
        const current = buildReviewRemediationDeltaBase({ repoRoot: root, taskId: TASK_ID, reviewType: 'code',
            reviewTreeStateSha256: TREE, changedFiles: FILES });
        assert.equal(deltaBaseMatchesReviewedTree(current, context, TREE), false, 'The changed file is not reviewed content');
        const reviewed = read(root, context);
        assert.ok(reviewed, 'The captured snapshot reproduces the reviewed tree');
        assert.equal(reviewed.entries.find((entry) => entry.path === 'src/app.ts')?.line_count, 2);
        assert.equal(read(root, context, 'b'.repeat(64)), null, 'Another tree is not this review');
        assert.equal(read(root, context, TREE, ['src/app.ts']), null, 'Another scope is not this review');
    });
});

test('a snapshot that does not reproduce the reviewed content is never used', () => {
    withRepo((root) => {
        const context = reviewContext(root);
        writeReviewedTreeDeltaBase({ repoRoot: root, taskId: TASK_ID, reviewType: 'code', changedFiles: FILES, reviewContext: context });
        rewrite(root, (base) => {
            base.entries[0].redacted_lines![0] = 'export const status = "forged";\n';
        });
        assert.equal(read(root, context), null, 'Consistent hashes over different lines do not reproduce the reviewed file');
        rewrite(root, (base) => {
            const entry = base.entries[0];
            entry.content_sha256 = createHash('sha256').update(entry.redacted_lines!.join('')).digest('hex');
        });
        assert.equal(read(root, context), null, 'A content hash other than the reviewed one is refused');
        fs.writeFileSync(getReviewedTreeDeltaBasePath(root, TASK_ID, 'code'), '{broken');
        assert.equal(read(root, context), null);
        fs.rmSync(getReviewedTreeDeltaBasePath(root, TASK_ID, 'code'));
        assert.equal(read(root, context), null);
    });
});

test('a staged review tree, a mismatching tree state or redacted lines leave no usable snapshot', () => {
    withRepo((root) => {
        const staged = reviewContext(root, { use_staged: true });
        writeReviewedTreeDeltaBase({ repoRoot: root, taskId: TASK_ID, reviewType: 'code', changedFiles: FILES, reviewContext: staged });
        assert.equal(fs.existsSync(getReviewedTreeDeltaBasePath(root, TASK_ID, 'code')), false, 'Staged content is not the worktree');
        assert.equal(read(root, staged), null);

        const context = reviewContext(root);
        fs.writeFileSync(path.join(root, 'src/app.ts'), 'changed before capture\n');
        writeReviewedTreeDeltaBase({ repoRoot: root, taskId: TASK_ID, reviewType: 'code', changedFiles: FILES, reviewContext: context });
        assert.equal(fs.existsSync(getReviewedTreeDeltaBasePath(root, TASK_ID, 'code')), false,
            'A file that changed between the tree state and the capture is not captured');

        fs.writeFileSync(path.join(root, 'src/app.ts'), 'const token = "ghp_' + 'a'.repeat(36) + '";\n');
        const secret = reviewContext(root);
        writeReviewedTreeDeltaBase({ repoRoot: root, taskId: TASK_ID, reviewType: 'code', changedFiles: FILES, reviewContext: secret });
        assert.equal(read(root, secret), null, 'Redacted lines cannot prove the reviewed content');
    });
});
