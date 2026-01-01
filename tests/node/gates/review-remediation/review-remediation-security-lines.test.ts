import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { redactSecretText } from '../../../../src/core/redaction';
import { resolveRuntimeReviewRemediationModeGuards } from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import { buildDefaultReviewRemediationModePolicy, evaluateReviewRemediationMode } from '../../../../src/policy/review-remediation-mode-policy';
import { buildReviewRemediationReadableDiffEvidence, collectReviewRemediationChangedLineEvidence } from '../../../../src/gates/review-remediation/review-remediation-readable-diff';
import { mentionsReviewSecurityWord } from '../../../../src/gates/review-remediation/review-remediation-scope-review-types';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function evidence(text: string, original = text) {
    return buildReviewRemediationReadableDiffEvidence([{ path: 'src/app.ts', lines: [{ operation: 'addition',
        baseline_line: null, current_line: 1, segment_index: 1, segment_count: 1, text, source_line_sha256: hash(original) }] }]);
}

test('security words survive readable-diff page boundaries and acronym identifiers', () => {
    const line = '// ' + 'x'.repeat(16377) + ' permission boundary fixed\n';
    const diff = evidence(line);
    assert.ok(diff.pages.length > 1);
    const changed = collectReviewRemediationChangedLineEvidence(diff);
    assert.deepEqual(changed.lines, [line]);
    assert.equal(changed.redactedChangedLine, false);
    assert.equal(mentionsReviewSecurityWord(changed.lines, ['permission']), true);
    assert.equal(mentionsReviewSecurityWord(['JWTToken'], ['jwt', 'token']), true);
    assert.equal(mentionsReviewSecurityWord(['tokenizer'], ['token']), false);
});

test('changed redacted secrets reach their security owner without treating a literal marker as a secret', () => {
    const original = 'const apiKey = "password_abcdefghijklmnop";\n';
    const redacted = redactSecretText(original, { preserveLineCount: true });
    assert.notEqual(redacted, original);
    const changed = collectReviewRemediationChangedLineEvidence(evidence(redacted, original));
    assert.equal(changed.redactedChangedLine, true);
    assert.equal(mentionsReviewSecurityWord(changed.lines, ['password']), false);
    const guards = resolveRuntimeReviewRemediationModeGuards({ remediationDeltaFiles: ['src/app.ts'],
        remediationProductionChanged: true, remediationDeltaSecretChanged: changed.redactedChangedLine });
    assert.deepEqual(guards.protectedBoundarySignals, ['secret']);
    const assessment = evaluateReviewRemediationMode({ policy: buildDefaultReviewRemediationModePolicy(), reviewType: 'code',
        category: 'production', changedFilesCount: 1, changedLinesTotal: 1, consecutiveDeltaReviews: 0, ...guards });
    assert.equal(assessment.mode, 'DELTA');
    assert.deepEqual(assessment.full_review_types, ['security']);
    const marker = 'const label = "<redacted>";\n';
    assert.equal(collectReviewRemediationChangedLineEvidence(evidence(marker)).redactedChangedLine, false);
});

test('incomplete changed-line segments fail closed', () => {
    const diff = evidence('x'.repeat(17000));
    diff.pages.pop();
    assert.throws(() => collectReviewRemediationChangedLineEvidence(diff), /segments are incomplete/u);
    diff.pages[0].lines[0].segment_count = 1;
    assert.throws(() => collectReviewRemediationChangedLineEvidence(diff), /source hash/u);
});

test('multiline secret redaction reaches security only when a transformed line changes', () => {
    const context = { operation: 'context' as const, baseline_line: 1, current_line: 1, segment_index: 1, segment_count: 1,
        text: '<redacted-private-key>\n', source_line_sha256: hash('-----BEGIN PRIVATE KEY-----\n') };
    const changed = { operation: 'addition' as const, baseline_line: null, current_line: 2, segment_index: 1, segment_count: 1,
        text: '\n', source_line_sha256: hash('changed-secret-data\n') };
    const diff = buildReviewRemediationReadableDiffEvidence([{ path: 'src/app.ts', lines: [context, changed] }]);
    assert.equal(collectReviewRemediationChangedLineEvidence(diff).redactedChangedLine, true);
    const unrelated = 'const unchangedBoundary = true;\n';
    const ordinary = buildReviewRemediationReadableDiffEvidence([{ path: 'src/app.ts', lines: [context,
        { ...changed, text: unrelated, source_line_sha256: hash(unrelated) }] }]);
    assert.equal(collectReviewRemediationChangedLineEvidence(ordinary).redactedChangedLine, false);
    context.source_line_sha256 = hash(context.text);
    const literal = buildReviewRemediationReadableDiffEvidence([{ path: 'src/app.ts', lines: [context, changed] }]);
    assert.throws(() => collectReviewRemediationChangedLineEvidence(literal), /source hash/u);
});
