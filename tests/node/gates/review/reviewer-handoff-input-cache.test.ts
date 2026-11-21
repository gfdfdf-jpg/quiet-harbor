import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { preserveReviewerHandoffInputs, restoreReviewerHandoffInputsBeforeHandoff as restoreReviewerHandoffInputs } from '../../../../src/gates/review/review-prompt-artifact';

test('handoff recovery accepts only exact pinned bytes and never changes the review context or a valid input', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-handoff-cache-'));
    try {
        const contextPath = path.join(repoRoot, 'reviews', 'T-CACHE-code-review-context.json');
        fs.mkdirSync(path.dirname(contextPath));
        const file = contextPath.replace(/\.json$/u, '.md');
        const original = 'Authenticated original reviewer input\n';
        const digest = createHash('sha256').update(original).digest('hex');
        const reviewContext = { rule_context: { artifact_sha256: digest, artifact_path: file } };
        const contextText = JSON.stringify(reviewContext);
        fs.writeFileSync(contextPath, contextText);
        fs.writeFileSync(file, original);
        const options = { repoRoot, taskId: 'T-CACHE', contextPath, reviewContext };
        preserveReviewerHandoffInputs(options);
        const cache = path.join(repoRoot, 'tmp', '.reviewer-input-cache', 'T-CACHE', digest);
        for (const damaged of [null, 'corrupt input']) {
            if (damaged === null) fs.unlinkSync(file); else fs.writeFileSync(file, damaged);
            assert.equal(restoreReviewerHandoffInputs(options), true);
            assert.equal(fs.readFileSync(file, 'utf8'), original);
            assert.equal(fs.readFileSync(contextPath, 'utf8'), contextText);
        }
        assert.equal(restoreReviewerHandoffInputs(options), false);
        fs.writeFileSync(cache, 'poisoned cache');
        fs.writeFileSync(file, 'corrupt input');
        assert.equal(restoreReviewerHandoffInputs(options), false);
        assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt input');
        assert.throws(() => preserveReviewerHandoffInputs(options), /unauthenticated reviewer input/u);
        fs.unlinkSync(cache);
        assert.equal(restoreReviewerHandoffInputs(options), false);
        assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt input');
        const source = path.join(repoRoot, 'source.ts');
        fs.writeFileSync(source, 'existing source');
        fs.writeFileSync(cache, original);
        assert.equal(restoreReviewerHandoffInputs({ ...options,
            reviewContext: { rule_context: { artifact_sha256: digest, artifact_path: source } } }), false);
        assert.equal(fs.readFileSync(source, 'utf8'), 'existing source', 'cached bytes must not become authority to overwrite source');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
