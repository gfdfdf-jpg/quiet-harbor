import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

test('exact-cell Windows diagnosis is manual, fails on native findings and cannot claim release acceptance', () => {
    const text = fs.readFileSync('.github/workflows/reference-review-cells.yml', 'utf8');
    // Keep the dispatch independent of the ten-input release workflow.
    assert.match(text, /^ {2}workflow_dispatch:/mu);
    assert.doesNotMatch(text, /^ {2}(?:push|pull_request|schedule|release|workflow_call):/mu);
    assert.match(text, /runs-on: windows-latest/u);
    assert.match(text, /node-version: '24'/u);
    assert.match(text, /review-matrix\.cjs run --only \$env:REVIEW_CELLS/u);
    assert.match(text, /exit \$LASTEXITCODE/u);
    assert.doesNotMatch(text, /continue-on-error:|stand\.cjs|review-matrix\.cjs merge/u);
    assert.match(text, /does not certify the release stand/u);
    assert.match(text, /include-hidden-files: true/u);
    assert.match(text, /if: always\(\)/u);
});
