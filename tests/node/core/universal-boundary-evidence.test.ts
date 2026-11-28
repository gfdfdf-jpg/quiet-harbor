import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as boundary from '../../../src/core/trust-boundary-analysis';
import { readValidationFile, validationDigest } from '../../../src/core/project-validation-identity';
import type { ValidationFileIdentity } from '../../../src/core/project-validation-contract';
import { captureIntermediateSelection } from '../../../src/core/intermediate-selected-cases';
import { inspectValidationCommand } from '../../../src/core/validation-command-contract';

it('captures case-distinct source paths independently on Windows', t => {
    const upper = 'tests/Permission.js', lower = 'tests/permission.js';
    const f = fixture({ [upper]: 'upperCase', 'tests/distinct.js': 'lowerCase' });
    const caseInsensitive = fs.existsSync(path.join(f.root, lower));
    if (!caseInsensitive) fs.writeFileSync(path.join(f.root, lower), 'lowerCase');
    const identity = require('../../../src/core/project-validation-identity') as typeof import('../../../src/core/project-validation-identity');
    const read = identity.readValidationFile;
    if (caseInsensitive) {
        // Model a case-sensitive directory with two real, separately identified files.
        t.mock.method(identity, 'readValidationFile', (root: string, file: string, limit: number) => {
            const actual = read(root, file === lower ? 'tests/distinct.js' : file, limit);
            return { ...actual, identity: { ...actual.identity, path: file } };
        });
    }
    const { descriptor } = inspectValidationCommand('node runner selector', 'validation');
    assert.ok(descriptor);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
        const first = { source: upper, case_id: 'upperCase', selector: 'selector' };
        const second = { source: lower, case_id: 'lowerCase', selector: 'selector' };
        const selection = captureIntermediateSelection(f.root, descriptor, [first, second]);
        assert.deepEqual(selection.sources.map(({ path, sha256 }) => [path, sha256]),
            [[upper, validationDigest('upperCase')], [lower, validationDigest('lowerCase')]]);
        assert.throws(() => captureIntermediateSelection(f.root, descriptor, [first, { ...second, case_id: first.case_id }]),
            (error: Error) => error.message.includes(`source "${lower}", case "upperCase", selector "selector"`));
        fs.writeFileSync(path.join(f.root, upper), 'upperCase commonCase');
        fs.writeFileSync(path.join(f.root, caseInsensitive ? 'tests/distinct.js' : lower), 'lowerCase commonCase');
        const common = captureIntermediateSelection(f.root, descriptor,
            [{ ...first, case_id: 'commonCase' }, { ...second, case_id: 'commonCase' }]);
        assert.equal(common.cases.length, 2);
    } finally {
        Object.defineProperty(process, 'platform', platform);
        f.remove();
    }
});

it('rejects claim aliases of the same physical file even with distinct literal selectors', t => {
    const upper = 'tests/Permission.js', lower = 'tests/permission.js';
    const f = fixture({ [upper]: 'function rejectsUnauthorized() {}' });
    const caseInsensitive = fs.existsSync(path.join(f.root, lower));
    const identity = require('../../../src/core/project-validation-identity') as typeof import('../../../src/core/project-validation-identity');
    const realRead = identity.readValidationFile;
    const read = t.mock.method(identity, 'readValidationFile', (root: string, file: string, limit: number) => {
        // On a case-sensitive host, resolve both requested paths to the same verified file.
        const actual = realRead(root, caseInsensitive ? file : upper, limit);
        return { ...actual, identity: { ...actual.identity, path: file } };
    });
    const { descriptor } = inspectValidationCommand('node runner first second', 'validation');
    assert.ok(descriptor);
    try {
        assert.throws(() => captureIntermediateSelection(f.root, descriptor, [
            { source: upper, case_id: 'rejectsUnauthorized', selector: 'first' },
            { source: lower, case_id: 'rejectsUnauthorized', selector: 'second' }
        ]), /Selected case source identities are ambiguous/u);
        assert.deepEqual(read.mock.calls.map(call => call.arguments[1]), [upper, lower]);
    } finally { f.remove(); }
});

type BoundAssessment = boundary.TrustBoundaryMatrixAssessment & { source_bindings_sha256: string };
type BindSources = (matrix: unknown, options: {
    repoRoot: string; expectedSources?: readonly ValidationFileIdentity[];
}) => BoundAssessment;

function bindSources(matrix: unknown, options: Parameters<BindSources>[1]): BoundAssessment {
    return (boundary as unknown as { assessBoundTrustBoundaryMatrix: BindSources })
        .assessBoundTrustBoundaryMatrix(matrix, options);
}

function matrix(references: string[]) {
    return [{
        boundary_id: 'AUTH', boundary: 'Запрос к защищённому ресурсу',
        authority_source: 'Current project authorization', mutable_inputs: ['request'],
        integrity_evidence: ['bound source and actual case evidence'],
        canonical_reconstruction: 'Current source, execution and independent semantic review',
        toctou_replay: 'Source and execution identities must remain current',
        negative_paths: [{ kind: 'other', scenario: 'Проверка拒绝',
            expected_behavior: 'Недействительный запрос отклонён', evidence_files: references }]
    }];
}

function fixture(files: Record<string, string | Buffer>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-universal-boundary-'));
    for (const [relative, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
    }
    return { root, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('universal boundary source evidence', () => {
    it('binds the original Unicode case token and hashes its bytes across source encodings', () => {
        const caseId = 'test_café';
        const text = `def ${caseId}(): pass\n`;
        const utf16 = Buffer.from(text, 'utf16le');
        const files = {
            'latin.py': Buffer.from(text, 'latin1'),
            'utf8.py': Buffer.from(text, 'utf8'),
            'utf8bom.py': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
            'utf16le.py': Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]),
            'utf16be.py': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()])
        };
        const f = fixture(files);
        try {
            for (const [file, bytes] of Object.entries(files)) {
                const bound = bindSources(matrix([`${file}#${caseId}`]), { repoRoot: f.root });
                assert.equal(bound.structural_status, 'BOUND', file);
                assert.equal(bound.source_evidence?.[0].case_id, caseId, file);
                assert.equal(bound.source_evidence?.[0].source_identity.sha256, validationDigest(bytes), file);
                assert.equal(bindSources(matrix([`${file}#test_caf`]), { repoRoot: f.root }).structural_status, 'INVALID', file);
            }
            assert.equal(bindSources(matrix(['latin.py#test_caf\ufffd']), { repoRoot: f.root }).structural_status, 'INVALID');
        } finally { f.remove(); }
    });

    it('rejects malformed BOM-marked sources without replacing invalid characters', () => {
        const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('test_caf'), Buffer.from([0xe9])]);
        const f = fixture({ 'bad.py': raw });
        try {
            const bound = bindSources(matrix(['bad.py#test_caf']), { repoRoot: f.root });
            assert.equal(bound.structural_status, 'INVALID');
            assert.match(bound.violations.join(' '), /Boundary source rejected/u);
        } finally { f.remove(); }
    });

    it('binds ordinary Java/JUnit camelCase evidence without a project declaration or JS grammar', () => {
        const source = 'api-gateway/src/test/java/example/GatewaySecurityCompatibilityTest.java';
        const caseId = 'privateRequestRejectsInvalidBearerToken';
        const f = fixture({ [source]: `@Test void ${caseId}() { assertThat(upstreamRequests).hasValue(0); }` });
        try {
            const result = bindSources(matrix([`${source}#${caseId}`]), { repoRoot: f.root });
            assert.deepEqual(result.violations, []);
            assert.equal(result.structural_status, 'BOUND');
            assert.equal(result.semantic_status, 'PENDING_INDEPENDENT_REVIEW');
            assert.equal(result.source_evidence?.[0].case_id, caseId);
            assert.equal(result.source_evidence?.[0].source_identity.sha256,
                validationDigest(fs.readFileSync(path.join(f.root, source))));
            assert.equal(result.source_evidence?.[0].syntax_status, 'UNRESOLVED');
            assert.equal(fs.existsSync(path.join(f.root, 'project-validation.json')), false);
        } finally { f.remove(); }
    });

    it('uses the same source identity contract for JavaScript and unconventional Unicode source paths', () => {
        const f = fixture({
            'RootSuite.js': "test('customerAccess', () => { assert.equal(response.status, 403); });",
            'проверки/λ': '\ufeffunknown project test syntax for "任意 case"'
        });
        try {
            const result = bindSources(matrix(['RootSuite.js#customerAccess', 'проверки/λ#任意 case']),
                { repoRoot: f.root });
            assert.deepEqual(result.violations, []);
            assert.deepEqual(result.source_evidence?.map(item => [item.case_id, item.selector, item.syntax_status]),
                [['customerAccess', 'customerAccess', 'UNRESOLVED'], ['任意 case', '任意 case', 'UNRESOLVED']]);
            assert.equal(result.semantic_status, 'PENDING_INDEPENDENT_REVIEW');
        } finally { f.remove(); }
    });

    it('never turns a source binding or an inert test body into execution or semantic success', () => {
        const f = fixture({ 'Source': '// opaque-case and no assertions' });
        try {
            const result = bindSources(matrix(['Source#opaque-case']), { repoRoot: f.root });
            assert.equal(result.structural_status, 'BOUND');
            assert.equal(result.semantic_status, 'PENDING_INDEPENDENT_REVIEW');
            assert.equal(result.source_evidence?.[0].syntax_status, 'UNRESOLVED');
            assert.equal('execution' in result, false);
            assert.equal('passed' in result, false);
        } finally { f.remove(); }
    });

    it('rejects absent identifiers and substrings of Unicode identifiers', () => {
        const f = fixture({ 'Source': 'deniedÉ denied\u0301 𐐀denied denied𐐀' });
        try {
            const result = bindSources(matrix(['Source#denied', 'Source#absent']), { repoRoot: f.root });
            assert.equal(result.structural_status, 'INVALID');
            assert.deepEqual(result.source_evidence, []);
            assert.match(result.violations.join(' '), /case "denied".*selector unknown/u);
            assert.match(result.violations.join(' '), /case "absent".*selector unknown/u);
        } finally { f.remove(); }
    });

    it('rejects malformed, missing and out-of-root references instead of binding arbitrary evidence', () => {
        const f = fixture({ 'Source': 'source' });
        try {
            const malformed = bindSources(matrix(['Source']), { repoRoot: f.root });
            const missing = bindSources(matrix(['Missing#case']), { repoRoot: f.root });
            const traversal = bindSources(matrix(['../Source#case']), { repoRoot: f.root });
            assert.deepEqual([malformed, missing, traversal].map(item => item.structural_status),
                ['INVALID', 'INVALID', 'INVALID']);
            assert.equal([malformed, missing, traversal].every(item => item.violations.length > 0), true);
        } finally { f.remove(); }
    });

    it('rejects source substitution against a retained source identity', () => {
        const f = fixture({ 'Source': 'original source for case' });
        try {
            const expected = readValidationFile(f.root, 'Source').identity;
            const first = bindSources(matrix(['Source#case']), { repoRoot: f.root, expectedSources: [expected] });
            assert.equal(first.structural_status, 'BOUND');
            fs.writeFileSync(path.join(f.root, 'Source'), 'substituted source for case');
            const changed = bindSources(matrix(['Source#case']), { repoRoot: f.root, expectedSources: [expected] });
            assert.equal(changed.structural_status, 'INVALID');
            assert.match(changed.violations.join(' '), /identity|changed/i);
        } finally { f.remove(); }
    });

    it('keeps the exact retained source set and does not accept ambiguous identities', () => {
        const f = fixture({ 'Source': 'source for case', 'Foreign': 'foreign' });
        try {
            const identity = readValidationFile(f.root, 'Source').identity;
            const foreign = readValidationFile(f.root, 'Foreign').identity;
            const duplicated = bindSources(matrix(['Source#case']),
                { repoRoot: f.root, expectedSources: [identity, identity] });
            const incomplete = bindSources(matrix(['Source#case']), { repoRoot: f.root, expectedSources: [] });
            const excessive = bindSources(matrix(['Source#case']),
                { repoRoot: f.root, expectedSources: [identity, foreign] });
            assert.deepEqual([duplicated, incomplete, excessive].map(item => item.structural_status),
                ['INVALID', 'INVALID', 'INVALID']);
        } finally { f.remove(); }
    });

    it('counts a shared source once against the source byte budget while retaining every exact case', () => {
        const f = fixture({ 'LargeSource': 'one two\n' + 'x'.repeat(6 * 1024 * 1024 - 8) });
        try {
            const result = bindSources(matrix(['LargeSource#one', 'LargeSource#two']), { repoRoot: f.root });
            assert.deepEqual(result.violations, []);
            assert.deepEqual(result.source_evidence?.map(item => item.case_id), ['one', 'two']);
            assert.equal(result.source_evidence?.[0].source_identity.sha256,
                result.source_evidence?.[1].source_identity.sha256);
        } finally { f.remove(); }
    });

    it('binds case meaning references and source bytes into the retained digest', () => {
        const f = fixture({ 'Source': 'case and another-case' });
        try {
            const first = bindSources(matrix(['Source#case']), { repoRoot: f.root });
            const repeated = bindSources(matrix(['Source#case']), { repoRoot: f.root });
            const different = bindSources(matrix(['Source#another-case']), { repoRoot: f.root });
            fs.writeFileSync(path.join(f.root, 'Source'), 'changed source for case and another-case');
            const changed = bindSources(matrix(['Source#case']), { repoRoot: f.root });
            assert.match(first.source_bindings_sha256, /^[a-f0-9]{64}$/u);
            assert.equal(first.source_bindings_sha256, repeated.source_bindings_sha256);
            assert.notEqual(first.source_bindings_sha256, different.source_bindings_sha256);
            assert.notEqual(first.source_bindings_sha256, changed.source_bindings_sha256);
        } finally { f.remove(); }
    });
});
