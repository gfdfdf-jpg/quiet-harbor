import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveReviewOutputInput } from '../../../../../../src/cli/commands/gate-review-handlers/result/review-output-input';

test('missing or consumed reviewer output refuses reuse and names authenticated recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-missing-review-output-'));
    const reviews = path.join(root, 'reviews'); fs.mkdirSync(reviews);
    const canonical = path.join(reviews, 'T-MISSING-code-review-output.md');
    fs.writeFileSync(canonical, 'Unverified canonical content must never be used as a fallback.');
    try {
        await assert.rejects(resolveReviewOutputInput({ reviewOutputPath: 'runtime/tmp/consumed.md' }, root, reviews, 'T-MISSING', 'code'), error => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Review output not found/u);
            assert.match(error.message, /Restore the original delegated review output artifact/u);
            assert.match(error.message, /do not fabricate or reconstruct/u);
            assert.match(error.message, /next-step "T-MISSING" --repo-root/u);
            return true;
        });
        assert.equal(fs.readFileSync(canonical, 'utf8'), 'Unverified canonical content must never be used as a fallback.');
        assert.equal(fs.existsSync(path.join(root, 'runtime/tmp/consumed.md')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
