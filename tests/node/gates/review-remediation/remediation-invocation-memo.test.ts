import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import { collectDatabaseProjectEvidence } from '../../../../src/gates/preflight/classify-change-db-evidence';
import { validateReviewRemediationBaselineArtifact } from '../../../../src/gates/review-remediation/review-remediation-baseline';
import { getReviewRemediationDeltaBaseViolations } from '../../../../src/gates/review-remediation/review-remediation-delta-contract';
import { getReviewRemediationScopeReviewTypesViolations } from '../../../../src/gates/review-remediation/review-remediation-scope-review-types';
import { buildDefaultReviewRemediationModePolicy } from '../../../../src/policy/review-remediation-mode-policy';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../../src/policy/review-trigger-policy';
import { createTempRepo } from '../../cli/commands/gate-test-helpers';
import { buildLeafTestDeltaClassification } from '../next-step/next-step-benchmark-remediation-fixture';

const requireFromTest = createRequire(__filename);

function fixture() {
    const repoRoot = createTempRepo();
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.copyFileSync(path.resolve('template/config/paths.json'), path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json'));
    const preflightPath = path.join(reviewsRoot, 'T-MEMO-preflight.json');
    fs.writeFileSync(preflightPath, '{}\n');
    const policy = buildDefaultReviewRemediationModePolicy();
    const profilePolicySnapshot = { review_remediation_mode_policy: policy };
    const delta = buildLeafTestDeltaClassification({ repoRoot, taskId: 'T-MEMO', reviewType: 'test',
        changedFile: 'src/app.ts', unchangedScopeFiles: { 'src/other.ts': 'export const other = true;\n' },
        preflightPath, preflightSha256: sha256RedactedJsonPayload({}), profilePolicySnapshot, modePolicy: policy });
    const options = { artifactPath: delta.baseline.artifact_path, expectedArtifactSha256: delta.baseline.artifact_sha256,
        expectedTaskId: delta.task_id, expectedReviewType: delta.review_type };
    return { repoRoot, delta, options, profilePolicySnapshot };
}

test('baseline results retain every expected binding, copy isolation and one consistency validation per pinned file', () => {
    const f = fixture();
    try {
        const wrong = '9'.repeat(64);
        const options = [f.options, { ...f.options, expectedArtifactSha256: wrong },
            { ...f.options, expectedTaskId: 'T-OTHER' }, { ...f.options, expectedReviewType: 'api' },
            { ...f.options, expectedReceiptSha256: wrong }, { ...f.options, expectedReviewContextSha256: wrong },
            { ...f.options, expectedReviewTreeStateSha256: wrong }, { ...f.options, expectedScopeSha256: wrong },
            { ...f.options, expectedProfilePolicySnapshotSha256: wrong }];
        const expected = options.map(value => validateReviewRemediationBaselineArtifact(value));
        assert.equal(expected[0].valid, true, expected[0].violations.join('\n'));
        for (const result of expected.slice(1)) assert.equal(result.valid, false);
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            for (let iteration = 0; iteration < 5; iteration++) {
                for (const [index, value] of options.entries()) {
                    assert.deepEqual(validateReviewRemediationBaselineArtifact(value), expected[index]);
                }
            }
            const changed = validateReviewRemediationBaselineArtifact(f.options);
            changed.violations.push('caller mutation');
            changed.artifact!.delta_base!.changed_files.push('caller mutation');
            assert.deepEqual(validateReviewRemediationBaselineArtifact(f.options), expected[0]);
        }), value => { measured = value; });
        assert.equal(measured!.work['visit:review-remediation-delta-contract:event:514'],
            expected[0].artifact!.delta_base!.entries.length);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('changed baseline bytes are refused between invocations and at invocation exit', () => {
    const f = fixture();
    try {
        const before = fs.readFileSync(f.options.artifactPath);
        const changed = Buffer.from(before);
        assert.equal(changed[changed.length - 1], 10);
        changed[changed.length - 1] = 32;
        assert.equal(withInvocationReadObservation(() => validateReviewRemediationBaselineArtifact(f.options)).valid, true);
        fs.writeFileSync(f.options.artifactPath, changed);
        const expected = validateReviewRemediationBaselineArtifact(f.options);
        const next = withInvocationReadObservation(() => validateReviewRemediationBaselineArtifact(f.options));
        assert.deepEqual(next, expected);
        assert.equal(next.valid, false);
        assert.match(next.violations.join(' '), /remediation baseline artifact hash mismatch/u);
        fs.writeFileSync(f.options.artifactPath, before);
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(validateReviewRemediationBaselineArtifact(f.options).valid, true);
            fs.writeFileSync(f.options.artifactPath, changed);
            validateReviewRemediationBaselineArtifact(f.options);
        }), /Invocation (?:file|content) observation changed/u);
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('accessor options cannot poison validation or task-role authentication memo keys', () => {
    const f = fixture();
    try {
        const wrongTask = { ...f.options, expectedTaskId: 'T-OTHER' };
        const expectedWrongTask = validateReviewRemediationBaselineArtifact(wrongTask);
        let taskReads = 0;
        const changingOptions = { ...f.options, get expectedTaskId() { return ++taskReads === 1 ? 'T-OTHER' : f.delta.task_id; } };
        withInvocationReadObservation(() => {
            validateReviewRemediationBaselineArtifact(changingOptions);
            assert.deepEqual(validateReviewRemediationBaselineArtifact(wrongTask), expectedWrongTask);
        });

        const text = JSON.stringify({ task_id: f.delta.task_id, declared_test_paths: [] });
        const invalid = { repoRoot: f.repoRoot, profilePolicySnapshot: f.profilePolicySnapshot,
            delta: { ...f.delta, task_role_preflight_text: text }, authenticatedPreflightSha256: '9'.repeat(64) };
        const expectedInvalid = getReviewRemediationScopeReviewTypesViolations(invalid);
        assert.match(expectedInvalid.join(' '), /not authenticated/u);
        let roleReads = 0;
        const changing = { ...invalid, delta: { ...f.delta,
            get task_role_preflight_text() { return ++roleReads === 1 ? text : undefined; } } };
        withInvocationReadObservation(() => {
            getReviewRemediationScopeReviewTypesViolations(changing);
            assert.deepEqual(getReviewRemediationScopeReviewTypesViolations(invalid), expectedInvalid);
        });
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('database evidence shares candidate roots and detects changed manifests and newly created markers', () => {
    const repoRoot = createTempRepo();
    try {
        const nested = path.join(repoRoot, 'backend', 'module');
        fs.mkdirSync(nested, { recursive: true });
        const pom = path.join(repoRoot, 'backend', 'pom.xml');
        fs.writeFileSync(pom, '<dependency>hibernate</dependency>\n');
        const files = ['backend/module/Repository.java'];
        const expected = collectDatabaseProjectEvidence(repoRoot, files);
        const otherFiles = ['backend/Other.java'];
        const expectedOther = collectDatabaseProjectEvidence(repoRoot, otherFiles);
        assert.ok(expected.includes('backend/pom.xml:hibernate'));
        let measured: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            for (let i = 0; i < 10; i++) assert.deepEqual(collectDatabaseProjectEvidence(repoRoot, files), expected);
            assert.deepEqual(collectDatabaseProjectEvidence(repoRoot, otherFiles), expectedOther);
        }), value => { measured = value; });
        assert.equal(measured!.work['payload_read:' + path.resolve(pom)], 1);
        assert.throws(() => withInvocationReadObservation(() => {
            collectDatabaseProjectEvidence(repoRoot, files);
            fs.writeFileSync(pom, '<dependency>postgresx</dependency>\n');
            collectDatabaseProjectEvidence(repoRoot, files);
        }), /Invocation (?:file|content) observation changed/u);
        assert.throws(() => withInvocationReadObservation(() => {
            collectDatabaseProjectEvidence(repoRoot, files);
            fs.mkdirSync(path.join(nested, 'db'));
            collectDatabaseProjectEvidence(repoRoot, files);
        }), /Invocation database evidence changed/u);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('relative database probes remain tied to their original root after a cwd change', () => {
    const repoRoot = createTempRepo();
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'remediation-cwd-'));
    const previousCwd = process.cwd();
    try {
        fs.mkdirSync(path.join(repoRoot, 'backend', 'module'), { recursive: true });
        fs.cpSync(repoRoot, path.join(otherCwd, path.basename(repoRoot)), { recursive: true });
        process.chdir(path.dirname(repoRoot));
        assert.throws(() => withInvocationReadObservation(() => {
            collectDatabaseProjectEvidence(path.basename(repoRoot), ['backend/module/Repository.java']);
            fs.mkdirSync(path.join(repoRoot, 'backend', 'module', 'db'));
            process.chdir(otherCwd);
        }), /Invocation database evidence changed/u);
    } finally {
        process.chdir(previousCwd);
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(otherCwd, { recursive: true, force: true });
    }
});

test('scope classification is shared only for matching files and authenticated options', context => {
    const f = fixture();
    try {
        const base = { repoRoot: f.repoRoot, delta: f.delta, profilePolicySnapshot: f.profilePolicySnapshot };
        const otherDelta = structuredClone(f.delta);
        otherDelta.changed_files = ['src/auth/session.ts'];
        const other = { ...base, delta: otherDelta };
        const roleDelta = structuredClone(f.delta);
        roleDelta.task_role_preflight_text = JSON.stringify({ task_id: f.delta.task_id, declared_test_paths: [] });
        const roleHash = createHash('sha256').update(roleDelta.task_role_preflight_text).digest('hex');
        const validRole = { ...base, delta: roleDelta, authenticatedPreflightSha256: roleHash };
        const invalidRole = { ...base, delta: roleDelta, authenticatedPreflightSha256: '9'.repeat(64) };
        const policyVariant = { ...base, profilePolicySnapshot: { ...f.profilePolicySnapshot,
            review_trigger_policy: { ...DEFAULT_REVIEW_TRIGGER_POLICY, test_refactor_changed_lines_threshold: 1 } } };
        const cases = [base, other, validRole, invalidRole, policyVariant];
        const expected = cases.map(getReviewRemediationScopeReviewTypesViolations);
        const malformed = { ...base, delta: { ...f.delta, changed_files: [1 as unknown as string] } };
        const expectedMalformed = getReviewRemediationScopeReviewTypesViolations(malformed);
        assert.match(expected[3].join(' '), /not authenticated/u);
        assert.doesNotMatch(expected[2].join(' '), /not authenticated/u);
        const classifyModule = requireFromTest('../../../../src/gates/preflight/classify-change') as typeof import('../../../../src/gates/preflight/classify-change');
        const original = classifyModule.classifyChange;
        let calls = 0;
        context.mock.method(classifyModule, 'classifyChange', (value: Parameters<typeof original>[0]) => { calls++; return original(value); });
        withInvocationReadObservation(() => {
            for (const [index, value] of cases.entries()) {
                assert.deepEqual(getReviewRemediationScopeReviewTypesViolations(value), expected[index]);
            }
            const firstPassCalls = calls;
            assert.ok(firstPassCalls >= 3, 'different file sets and effective configurations need distinct classifications');
            for (let i = 0; i < 10; i++) {
                for (const [index, value] of cases.entries()) {
                    assert.deepEqual(getReviewRemediationScopeReviewTypesViolations(value), expected[index]);
                }
            }
            assert.equal(calls, firstPassCalls);
            assert.deepEqual(getReviewRemediationScopeReviewTypesViolations(malformed), expectedMalformed);
            assert.deepEqual(getReviewRemediationScopeReviewTypesViolations(malformed), expectedMalformed);
            assert.equal(calls, firstPassCalls + 2, 'malformed file inputs must not reuse a classification');
        });
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('both delta seals retain the existing redacted serialization for unusual and invalid entries', () => {
    const f = fixture();
    try {
        const baseline = validateReviewRemediationBaselineArtifact(f.options).artifact!;
        for (const entries of [baseline.delta_base!.entries, ['token=secret', 'x\ny'],
            [{ path: 'src/secret.ts', redacted_lines: ['Authorization: Bearer secret\n'], token: 'private' }]]) {
            const base = { ...baseline.delta_base!, entries, entries_sha256: sha256RedactedJsonPayload(entries) };
            const { snapshot_sha256: _, ...payload } = base;
            const sealed = { ...payload, snapshot_sha256: sha256RedactedJsonPayload(payload) };
            const violations = getReviewRemediationDeltaBaseViolations(sealed);
            assert.ok(!violations.some(value => /entries_sha256 does not match|snapshot_sha256 does not match/u.test(value)), violations.join('\n'));
            const broken = getReviewRemediationDeltaBaseViolations({ ...sealed, entries_sha256: '0'.repeat(64), snapshot_sha256: '1'.repeat(64) });
            assert.ok(broken.some(value => /entries_sha256 does not match/u.test(value)));
            assert.ok(broken.some(value => /snapshot_sha256 does not match/u.test(value)));
        }
    } finally { fs.rmSync(f.repoRoot, { recursive: true, force: true }); }
});
