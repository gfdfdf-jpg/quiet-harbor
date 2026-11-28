import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { redactSecretText, serializeRedactedJson } from '../../../../src/core/redaction';
import {
    buildBoundedLineEvidence,
    buildReviewRemediationDeltaBase,
    getReviewRemediationDeltaBaseViolations,
    REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE,
    REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES,
    REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES,
    REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES
} from '../../../../src/gates/review-remediation/review-remediation-delta-contract';

const SECRET_NAMED_LITERAL_FILE = [
    '        mvc.perform(get("/not-found?token=" + SECRET))',
    '            .andExpect(status().isNotFound())',
    '            .andExpect(jsonPath("$.title").value("Not Found"));',
    ''
].join('\n');

test('line evidence keeps one redacted line per source line for a quoted secret-named literal', () => {
    const result = buildBoundedLineEvidence(Buffer.from(SECRET_NAMED_LITERAL_FILE, 'utf8'));
    assert.equal(result.failure, null);
    assert.equal(result.evidence?.lineHashes.length, 3);
    assert.equal(result.evidence?.redactedLines.length, 3);
    assert.equal(result.evidence?.redactionApplied, true, 'the secret-named literal must actually be redacted');
    assert.match(result.evidence?.redactedLines.join('') ?? '', /<redacted>/u);
    assert.equal(
        redactSecretText(SECRET_NAMED_LITERAL_FILE, { preserveLineCount: true }).split('\n').length,
        SECRET_NAMED_LITERAL_FILE.split('\n').length
    );
});

test('line evidence is withheld, as in 1.4.4, when redaction changes the line structure', () => {
    const files: Record<string, string> = {
        'src/basic-split.txt': 'Authorization: Basic\nsecret-credential-value\nnext\n',
        'src/bearer-split.txt': 'Authorization: Bearer   \n  secret-credential-value\nnext\n',
        'src/tab-split.txt': 'Authorization:\tBearer\n\nsecret-credential-value\nnext\n',
        'src/bearer-eof.txt': 'Authorization: Bearer\nsecret-credential-value',
        'src/bearer-eof-crlf.txt': 'Authorization: Bearer\r\nsecret-credential-value',
        'src/header-after-text.txt': 'first\nAuthorization: Bearer\nsecret-credential-value',
        'src/private-key-eof.txt': '-----BEGIN PRIVATE KEY-----\nsecret-credential-value\n-----END PRIVATE KEY-----',
        'src/json-eof.txt': 'header\n"token": "secret-credential-value\nsecret-credential-value"',
        'src/assignment-eof.txt': 'API_KEY = "secret-credential-value\nsecret-credential-value"',
        'src/assignment-eof-crlf.ts': 'const API_KEY = "secret-credential-value\r\nsecret-credential-value"'
    };
    for (const content of Object.values(files)) {
        const result = buildBoundedLineEvidence(Buffer.from(content, 'utf8'));
        assert.equal(result.evidence, null, JSON.stringify(content));
        assert.equal(result.failure, 'redaction_line_mismatch', JSON.stringify(content));
    }
    assertSerializedBaseHidesSecret(files, 'secret-credential-value');
});

const PATTERN_FRAGMENTS = [
    'xauth =', 'auth =example', 'Authorization: Bearer', 'Authorization: Basic   ', 'Authorization:\tBearer abc', 'sample',
    'API_KEY = "first', 'second"', '"token": "x', 'y"', '\'secret\': \'p', 'q\'', 'password=hunter2', 'token =', 'AUTH_TOKEN: "',
    '"', 'url = https://user:pw@host/x', '-----BEGIN PRIVATE KEY-----', 'abc', '-----END PRIVATE KEY-----',
    `ghp_${'A'.repeat(24)}`, 'plain text', '', '<redacted>', 'const PRIVATE_KEY = \'v', 'w\';'
];

/** Each persisted entry is either evidence that reloads byte-identically or a capture-time redaction_line_mismatch. */
function assertPersistedLineEvidenceRoundTrips(files: Record<string, string>): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-line-evidence-mix-'));
    try {
        for (const [file, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), content, 'utf8');
        }
        const base = buildReviewRemediationDeltaBase({ repoRoot: root, taskId: 'T-mix', reviewType: 'code',
            reviewTreeStateSha256: 'b'.repeat(64), changedFiles: Object.keys(files) });
        for (const entry of base.entries) {
            assert.ok(['available', 'redaction_line_mismatch'].includes(entry.line_analysis),
                `${entry.path}: ${entry.line_analysis} for ${JSON.stringify(files[entry.path])}`);
        }
        const reloaded = JSON.parse(serializeRedactedJson(base)) as typeof base;
        assert.deepEqual(getReviewRemediationDeltaBaseViolations(reloaded), []);
        for (const [index, entry] of reloaded.entries.entries()) {
            assert.deepEqual(entry.redacted_lines, base.entries[index].redacted_lines, JSON.stringify(files[entry.path]));
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('persisted line evidence round-trips when whole-file and per-line redaction disagree', () => {
    const input = 'xauth =\nauth =example\nAuthorization: Bearer\nsample';
    assertPersistedLineEvidenceRoundTrips({ 'src/sol.txt': input, 'src/sol-crlf.txt': input.replace(/\n/gu, '\r\n') });
});

test('persisted line evidence round-trips for a generated mix of secret patterns, line endings and file ends', () => {
    let seed = 0x2d7fa3cc;
    const next = (bound: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % bound;
    };
    const files: Record<string, string> = {};
    for (let index = 0; index < 300; index += 1) {
        const fragments = Array.from({ length: 2 + next(5) }, () => PATTERN_FRAGMENTS[next(PATTERN_FRAGMENTS.length)]);
        const lineEnding = next(3) === 0 ? '\r\n' : '\n';
        files[`src/mix-${index}.txt`] = fragments.join(lineEnding) + (next(2) === 0 ? lineEnding : '');
    }
    assertPersistedLineEvidenceRoundTrips(files);
});

test('line evidence names a redaction alignment failure instead of a line limit failure', () => {
    const merging = (text: string): string => text.replace(/\n/gu, '');
    const result = buildBoundedLineEvidence(Buffer.from(SECRET_NAMED_LITERAL_FILE, 'utf8'), merging);
    assert.equal(result.evidence, null);
    assert.equal(result.failure, 'redaction_line_mismatch');
});

test('line evidence splits redacted text on the same line feeds as the line hashes', () => {
    const identity = (text: string): string => text;
    const variants = [
        'first second\nthird\n',
        'first second\r\nthird\r',
        'first\r\nsecond\r\nthird'
    ];
    for (const variant of variants) {
        const result = buildBoundedLineEvidence(Buffer.from(variant, 'utf8'), identity);
        assert.equal(result.failure, null);
        assert.equal(result.evidence?.redactedLines.length, result.evidence?.lineHashes.length);
        assert.equal(result.evidence?.redactedLines.join(''), variant);
    }
});

test('line evidence reports the line limit only above the per-file line budget', () => {
    const within = Buffer.from('x\n'.repeat(REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE), 'utf8');
    const beyond = Buffer.from('x\n'.repeat(REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE + 1), 'utf8');
    assert.equal(buildBoundedLineEvidence(within).failure, null);
    assert.equal(buildBoundedLineEvidence(beyond).failure, 'line_count_limit_exceeded');
});

test('capture records the snapshot line budget instead of evidence whose redacted bytes exceed the validated cap', () => {
    const body = `${'a'.repeat(511)}\n`.repeat(2047) + `${'b'.repeat(498)}\n`;
    // Redaction grows this one-line value ('"x"' becomes '"<redacted>"') without changing the line structure.
    const tail = 'K_TOKEN = "x"';
    const content = body + tail;
    assert.equal(Buffer.byteLength(content, 'utf8'), REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-line-evidence-cap-'));
    try {
        const files = ['src/a.txt', 'src/b.txt', 'src/c.txt', 'src/d.txt'];
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        for (const file of files) fs.writeFileSync(path.join(root, file), content, 'utf8');
        const base = buildReviewRemediationDeltaBase({ repoRoot: root, taskId: 'T-cap', reviewType: 'code',
            reviewTreeStateSha256: 'c'.repeat(64), changedFiles: files });
        const redactedBytes = base.entries.reduce((total, entry) =>
            total + Buffer.byteLength((entry.redacted_lines ?? []).join(''), 'utf8'), 0);
        assert.ok(redactedBytes <= REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_BYTES, `${redactedBytes} redacted bytes`);
        assert.ok(base.entries.some(entry => entry.line_analysis === 'snapshot_line_budget_exceeded'),
            base.entries.map(entry => entry.line_analysis).join(', '));
        assert.deepEqual(getReviewRemediationDeltaBaseViolations(base), []);
        assert.deepEqual(getReviewRemediationDeltaBaseViolations(JSON.parse(serializeRedactedJson(base)) as typeof base), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a file with a lone CR, U+2028 or U+2029 gets no line evidence and persists nothing unredacted', () => {
    const files: Record<string, string> = {
        'src/sol-cr.env': 'OAUTH=\rAUTH_TOKEN=example\r',
        'src/mixed-crlf.env': 'NAME=value\r\nOAUTH=\rAUTH_TOKEN=example\r\nOTHER=1\r\n',
        'src/line-separator.env': 'OAUTH=\u2028AUTH_TOKEN=example\n',
        'src/paragraph-separator.env': 'OAUTH=\u2029AUTH_TOKEN=example\n'
    };
    for (const content of Object.values(files)) {
        const result = buildBoundedLineEvidence(Buffer.from(content, 'utf8'));
        assert.equal(result.evidence, null, JSON.stringify(content));
        assert.equal(result.failure, 'redaction_line_mismatch', JSON.stringify(content));
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-line-evidence-cr-'));
    try {
        for (const [file, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), content, 'utf8');
        }
        const base = buildReviewRemediationDeltaBase({ repoRoot: root, taskId: 'T-cr', reviewType: 'code',
            reviewTreeStateSha256: 'd'.repeat(64), changedFiles: Object.keys(files) });
        for (const entry of base.entries) {
            assert.equal(entry.line_analysis, 'redaction_line_mismatch', entry.path);
            assert.equal(entry.redacted_lines, null, entry.path);
        }
        const persisted = serializeRedactedJson(base);
        assert.doesNotMatch(persisted, /example/u);
        assert.deepEqual(getReviewRemediationDeltaBaseViolations(JSON.parse(persisted) as typeof base), []);
        // Evidence forged or written with such a line is refused on reload and rewritten by the serializer.
        const lines = ['OAUTH=\rAUTH_TOKEN=example\r'];
        const forged = structuredClone(base);
        Object.assign(forged.entries[0], { line_hashes: ['e'.repeat(64)], redacted_lines: lines,
            redacted_lines_sha256: createHash('sha256').update(lines.join(''), 'utf8').digest('hex'), line_analysis: 'available' });
        assert.ok(getReviewRemediationDeltaBaseViolations(forged).some((violation) => /control or line separator/u.test(violation)));
        assert.doesNotMatch(serializeRedactedJson({ redacted_lines: lines }), /example/u);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an ordinary CRLF file, and one ending in a bare CR, keep their line evidence', () => {
    const cases: Array<[string, string[]]> = [
        ['first\r\nsecond\r\n', ['first\r\n', 'second\r\n']],
        ['first\r\nsecond\r', ['first\r\n', 'second\r']]
    ];
    for (const [content, expected] of cases) {
        const result = buildBoundedLineEvidence(Buffer.from(content, 'utf8'));
        assert.equal(result.failure, null, JSON.stringify(content));
        assert.deepEqual(result.evidence?.redactedLines, expected);
    }
    assertPersistedLineEvidenceRoundTrips({ 'src/crlf.txt': 'API_KEY = "a"\r\nplain\r\n' });
});

/** Every code point line evidence refuses: C0 controls but TAB and LF, a lone CR, DEL, C1 controls, U+2028, U+2029. */
function lineEvidenceDisallowedCodePoints(): number[] {
    const codePoints: number[] = [];
    for (let codePoint = 0; codePoint <= 0x9f; codePoint += 1) {
        if (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) codePoints.push(codePoint);
        if (codePoint >= 0x7f) codePoints.push(codePoint);
    }
    return [...codePoints, 0x2028, 0x2029];
}

/** The persisted base of these files never holds the secret, whatever line evidence capture keeps. */
function assertSerializedBaseHidesSecret(files: Record<string, string>, secret: string): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-line-evidence-secret-'));
    try {
        for (const [file, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), content, 'utf8');
        }
        const base = buildReviewRemediationDeltaBase({ repoRoot: root, taskId: 'T-secret', reviewType: 'code',
            reviewTreeStateSha256: 'f'.repeat(64), changedFiles: Object.keys(files) });
        const persisted = serializeRedactedJson(base);
        assert.equal(persisted.includes(secret), false, JSON.stringify(files));
        assert.deepEqual(getReviewRemediationDeltaBaseViolations(JSON.parse(persisted) as typeof base), []);
        for (const entry of base.entries) {
            // A NUL byte already makes the file binary ('not_text'); either way it carries no line evidence.
            assert.ok(['redaction_line_mismatch', 'not_text'].includes(entry.line_analysis), `${entry.path}: ${JSON.stringify(files[entry.path])}`);
            assert.equal(entry.redacted_lines, null);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('no control or separator character after an empty assignment lets a secret into line evidence', () => {
    const authorization = 'Authorization: Bearer\nabc\n';
    for (const codePoint of lineEvidenceDisallowedCodePoints()) {
        const separator = String.fromCharCode(codePoint);
        const line = `OAUTH=${separator}AUTH_TOKEN=example\n`;
        const result = buildBoundedLineEvidence(Buffer.from(line, 'utf8'));
        assert.equal(result.evidence, null, `U+${codePoint.toString(16).padStart(4, '0')}`);
        assert.equal(result.failure, 'redaction_line_mismatch');
        assertSerializedBaseHidesSecret({ 'src/plain.env': line, 'src/with-header.env': authorization + line }, 'example');
    }
});

/**
 * The 1.4.4 release capture: line hashes split on LF bytes, redacted lines split on CRLF, LF or CR, and evidence
 * only when both counts agree. redactSecretText is unchanged from that release, so this reproduces its lines.
 */
function releaseLineEvidence(content: string): string[] | null {
    if (!content) return [];
    const hashLineCount = (content.match(/[^\n]*\n|[^\n]+/gu) ?? []).length;
    const redacted = redactSecretText(content, { preserveLineCount: true });
    const lines = redacted.match(/.*?(?:\r\n|\n|\r|$)/gu)?.filter((line) => line.length > 0) ?? [];
    return lines.length === hashLineCount ? lines : null;
}

/** Every separator the line evidence allowlist accepts between an empty assignment and the next key. */
const ALLOWED_SEPARATORS = [' ', '\t', '\n', '\r\n',
    ...[0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x202f, 0x205f, 0x3000, 0xfeff].map((codePoint) => String.fromCharCode(codePoint))];

const SECRET = 'synthetic-secret';
/** sha256 of the 1.4.4 release redaction of the generated invariant inputs, in generation order. */
const RELEASE_REDACTION_DIGEST = 'd4c52799439997c1810ac25b29f351a104144fa8c0e0a99efa7ca56f44c65fa3';
const TEXT_FRAGMENTS = [
    'Authorization: Bearer', `${SECRET}`, 'Authorization: Basic   ', `  ${SECRET}`, `AUTH_TOKEN="one \\" ${SECRET}"`,
    `const header = \`Authorization: Bearer`, `${SECRET}\`;`, `const t = \`AUTH_TOKEN=${'${'}value}`, `${SECRET}\`;`,
    `API_KEY = "first`, `${SECRET}"`, `"token": "x`, `${SECRET}"`, 'plain text', '',
    ...ALLOWED_SEPARATORS.map((separator) => `OAUTH=${separator}AUTH_TOKEN=${SECRET}`)
];
const CONTROL_FRAGMENTS = lineEvidenceDisallowedCodePoints()
    .map((codePoint) => `OAUTH=${String.fromCharCode(codePoint)}AUTH_TOKEN=${SECRET}`);
const INVARIANT_FRAGMENTS = [...TEXT_FRAGMENTS, ...CONTROL_FRAGMENTS];

test('line evidence is kept only where the 1.4.4 capture kept the same lines, so no secret it hid is stored', () => {
    let seed = 0x1044;
    const next = (bound: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % bound;
    };
    const files: Record<string, string> = {};
    INVARIANT_FRAGMENTS.forEach((fragment, index) => {
        files[`src/single-${index}.txt`] = fragment;
        files[`src/single-lf-${index}.txt`] = `${fragment}\n`;
    });
    for (let index = 0; index < 600; index += 1) {
        const fragments = Array.from({ length: 2 + next(5) }, () => (next(8) === 0
            ? CONTROL_FRAGMENTS[next(CONTROL_FRAGMENTS.length)] : TEXT_FRAGMENTS[next(TEXT_FRAGMENTS.length)]));
        const lineEnding = next(3) === 0 ? '\r\n' : '\n';
        files[`src/mix-${index}.txt`] = fragments.join(lineEnding) + (next(2) === 0 ? lineEnding : '');
    }
    // The oracle reuses redactSecretText, so pin its output to the 1.4.4 release for these inputs: a redaction change
    // fails here first and must re-prove that it keeps no line evidence the release withheld.
    const redactedDigest = createHash('sha256').update(JSON.stringify(Object.values(files)
        .map((content) => redactSecretText(content, { preserveLineCount: true }))), 'utf8').digest('hex');
    assert.equal(redactedDigest, RELEASE_REDACTION_DIGEST);
    let kept = 0;
    for (const [file, content] of Object.entries(files)) {
        const result = buildBoundedLineEvidence(Buffer.from(content, 'utf8'));
        if (result.evidence) {
            kept += 1;
            assert.deepEqual(result.evidence.redactedLines, releaseLineEvidence(content), `${file}: ${JSON.stringify(content)}`);
        }
    }
    assert.ok(kept > 100, `only ${kept} inputs kept line evidence`);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-line-evidence-invariant-'));
    try {
        for (const [file, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), content, 'utf8');
        }
        const paths = Object.keys(files);
        for (let offset = 0; offset < paths.length; offset += 256) {
            const base = buildReviewRemediationDeltaBase({ repoRoot: root, taskId: 'T-invariant', reviewType: 'code',
                reviewTreeStateSha256: '1'.repeat(64), changedFiles: paths.slice(offset, offset + 256) });
            const persisted = JSON.parse(serializeRedactedJson(base)) as typeof base;
            assert.deepEqual(getReviewRemediationDeltaBaseViolations(persisted), []);
            for (const entry of persisted.entries) {
                const stored = (entry.redacted_lines ?? []).join('');
                if (stored.includes(SECRET)) {
                    assert.ok((releaseLineEvidence(files[entry.path]) ?? []).join('').includes(SECRET),
                        `${entry.path}: ${JSON.stringify(files[entry.path])}`);
                }
            }
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('line evidence capture stays linear on a 1 MiB adversarial assignment file', () => {
    const line = `${'OAUTH= '.repeat(36)}xyz\n`;
    const content = line.repeat(REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE);
    assert.equal(Buffer.byteLength(content, 'utf8'), REVIEW_REMEDIATION_DELTA_MAX_TEXT_BYTES);
    const started = process.hrtime.bigint();
    buildBoundedLineEvidence(Buffer.from(content, 'utf8'));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `capture took ${elapsedMs} ms`);
});

/**
 * The 1.4.4 release snapshot: files in path order, the per-file line limit, then the shared line budget, charged
 * with each file's evidence lines and spent in full by the first file that does not fit.
 */
function releaseSnapshotEvidence(files: Record<string, string>): Map<string, string[] | null> {
    const evidence = new Map<string, string[] | null>();
    let remainingLines = REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES;
    for (const file of Object.keys(files).sort()) {
        const content = files[file];
        const hashLineCount = (content.match(/[^\n]*\n|[^\n]+/gu) ?? []).length;
        const lines = hashLineCount > REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE ? null : releaseLineEvidence(content);
        if (lines !== null && lines.length > remainingLines) {
            remainingLines = 0;
            evidence.set(file, null);
            continue;
        }
        remainingLines -= lines?.length ?? 0;
        evidence.set(file, lines);
    }
    return evidence;
}

/** Every entry with line evidence matches the release snapshot entry, so no file or secret beyond it is stored. */
function assertSnapshotWithinRelease(files: Record<string, string>): number {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-line-evidence-snapshot-'));
    try {
        for (const [file, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), content, 'utf8');
        }
        const release = releaseSnapshotEvidence(files);
        const base = buildReviewRemediationDeltaBase({ repoRoot: root, taskId: 'T-snapshot', reviewType: 'code',
            reviewTreeStateSha256: '2'.repeat(64), changedFiles: Object.keys(files) });
        const persisted = JSON.parse(serializeRedactedJson(base)) as typeof base;
        assert.deepEqual(getReviewRemediationDeltaBaseViolations(persisted), []);
        let kept = 0;
        for (const entry of persisted.entries) {
            if (entry.redacted_lines === null) continue;
            kept += 1;
            assert.deepEqual(entry.redacted_lines, release.get(entry.path), `${entry.path} has evidence the release withheld`);
        }
        return kept;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('a file whose evidence is withheld still spends the release line budget, so no later file gains evidence', () => {
    const escape = String.fromCharCode(0x1b);
    const fullFile = 'x\n'.repeat(REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE);
    const files: Record<string, string> = {
        'src/a.txt': `${escape}[0m\n${'x\n'.repeat(REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE - 1)}`,
        'src/b.txt': fullFile,
        'src/c.txt': fullFile,
        'src/d.txt': fullFile,
        'src/e.env': `OAUTH= AUTH_TOKEN=${SECRET}\n`
    };
    assert.equal(REVIEW_REMEDIATION_DELTA_MAX_SNAPSHOT_LINES, 4 * REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE);
    assert.equal(releaseSnapshotEvidence(files).get('src/e.env'), null, 'the release gave the fifth file no evidence');
    assertSnapshotWithinRelease(files);
});

test('every generated multi-file snapshot keeps line evidence only for files and lines the release snapshot kept', () => {
    let seed = 0x5a1;
    const next = (bound: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % bound;
    };
    // Withheld only now (refused control characters other than NUL, which makes a file binary for both), or
    // withheld by the release too (a redaction that changes the line structure).
    const withheld = [...CONTROL_FRAGMENTS.slice(1), ...CONTROL_FRAGMENTS.slice(1), 'Authorization: Bearer\nabc',
        'API_KEY = "first\nsecond"', 'Authorization: Basic\nsecret-value'];
    let kept = 0;
    for (let snapshot = 0; snapshot < 24; snapshot += 1) {
        const files: Record<string, string> = {};
        const count = 4 + next(6);
        for (let index = 0; index < count; index += 1) {
            const lines = next(3) === 0 ? 1 + next(40) : 1500 + next(REVIEW_REMEDIATION_DELTA_MAX_LINES_PER_FILE - 1499);
            const head = next(2) === 0 ? withheld[next(withheld.length)] : TEXT_FRAGMENTS[next(TEXT_FRAGMENTS.length)];
            const body = 'x\n'.repeat(Math.max(0, lines - 2));
            files[`src/s${snapshot}-${String.fromCharCode(97 + next(26))}${index}.txt`] = `${head}\n${body}${`OAUTH= AUTH_TOKEN=${SECRET}`}\n`;
        }
        kept += assertSnapshotWithinRelease(files);
    }
    assert.ok(kept > 20, `only ${kept} files kept line evidence`);
});
