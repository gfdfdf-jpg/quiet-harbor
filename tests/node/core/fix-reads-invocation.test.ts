import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileSha256 } from '../../../src/core/file-hashing';
import { readTransactionBytes } from '../../../src/core/file-transaction-journal';
import { readInvocationTextFile } from '../../../src/core/invocation-file-observation';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { joinOrchestratorPath } from '../../../src/core/orchestrator-paths';
import { readBoundedTaskPlanFile } from '../../../src/core/task-plan-read';
import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { resolveRestartCommandScope } from '../../../src/gates/recovery/restart-command-scope';
import { readTaskReviewArtifactTexts } from '../../../src/gates/review-remediation/ignored-remediation-targets';
import { collectLostRecordedReviewEvidenceTypes } from '../../../src/gates/review-remediation/review-evidence-only-restart-scope';
import { readRestartReviewClassification, writeReviewClassificationSnapshot } from '../../../src/gates/review-remediation/review-remediation-classification-evidence';
import { resolveFailedReviewTaskCriteriaChange } from '../../../src/gates/review-remediation/review-remediation-task-criteria';
import type { ReviewRemediationBaselineArtifact } from '../../../src/gates/review-remediation/review-remediation-baseline';

function fixture(t: TestContext) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fix-reads-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const reviewsRoot = path.join(repoRoot, 'runtime/reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    return { repoRoot, reviewsRoot, taskId: 'T-READS' };
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function sharedReads(files: string[], read: () => unknown, expected: unknown): void {
    let measured: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => {
        for (const file of files) {
            readInvocationTextFile(file);
            fileSha256(file);
        }
        for (let i = 0; i < 5; i++) assert.deepEqual(read(), expected);
    }), value => { measured = value; });
    for (const file of files) {
        assert.equal(measured!.work['payload_read:' + path.resolve(file)], 1, 'payload: ' + file);
        assert.equal(measured!.work['file_hash:' + path.resolve(file)], 1, 'hash: ' + file);
    }
}

function freshness(file: string, read: () => unknown, expected: unknown, changed: string, checkChanged: () => void): void {
    const original = fs.readFileSync(file);
    assert.throws(() => withInvocationReadObservation(() => {
        assert.deepEqual(read(), expected);
        fs.writeFileSync(file, changed);
    }), /Invocation (?:file|content) observation changed/u, 'exit must reject a write without another read');
    withInvocationReadObservation(checkChanged);
    fs.writeFileSync(file, original);
    assert.deepEqual(withInvocationReadObservation(read), expected);
}

for (const input of ['receipt', 'review', 'validation'] as const) {
    test('lost-evidence ' + input + ' shares payload/hash and retains exit and between-call freshness', t => {
        const f = fixture(t);
        const files = {
            receipt: path.join(f.reviewsRoot, 'receipt.json'),
            review: path.join(f.reviewsRoot, 'review.md'),
            validation: path.join(f.reviewsRoot, 'validation.json')
        };
        for (const file of Object.values(files)) fs.writeFileSync(file, 'recorded evidence');
        appendTaskEvent(f.repoRoot, f.taskId, 'REVIEW_RECORDED', 'PASS', 'Accepted review', {
            task_id: f.taskId, review_type: 'code', verdict_token: 'CODE REVIEW PASSED', cadence_failed: false,
            receipt_path: files.receipt, receipt_sha256: hash('recorded evidence'),
            review_artifact_path: files.review, review_artifact_sha256: hash('recorded evidence'),
            review_findings_validation: { accepted: true, artifact_path: files.validation, artifact_sha256: hash('recorded evidence') }
        }, { actor: 'gate' });
        const read = () => collectLostRecordedReviewEvidenceTypes(f);
        sharedReads([files[input]], read, []);
        freshness(files[input], read, [], 'lost evidence', () => assert.deepEqual(read(), ['code']));
    });
}

test('ignored remediation report and receipt share bytes and detect edits independently', t => {
    const f = fixture(t);
    const report = path.join(f.reviewsRoot, `${f.taskId}-test.md`);
    const receipt = path.join(f.reviewsRoot, `${f.taskId}-test-receipt.json`);
    const text = 'TEST REVIEW FAILED\n';
    fs.writeFileSync(report, text);
    fs.writeFileSync(receipt, JSON.stringify({ task_id: f.taskId, review_type: 'test', review_artifact_sha256: hash(text) }));
    const read = () => readTaskReviewArtifactTexts(f.repoRoot, f.taskId);
    sharedReads([report, receipt], read, [text]);
    freshness(report, read, [text], 'changed report', () => assert.deepEqual(read(), []));
    freshness(receipt, read, [text], '{}', () => assert.deepEqual(read(), []));
});

for (const reader of ['plan', 'restart'] as const) {
    test(reader + ' preflight shares ordinary reads and observes changes at exit and between calls', t => {
        const f = fixture(t);
        const file = path.join(f.reviewsRoot, 'preflight.json');
        const text = JSON.stringify({ changed_files: ['src/a.ts'], detection_source: 'git_staged_only' });
        const changed = JSON.stringify({ changed_files: ['src/b.ts'] });
        fs.writeFileSync(file, text);
        const read = reader === 'plan' ? () => readBoundedTaskPlanFile(f.repoRoot, file, 1024)
            : () => resolveRestartCommandScope(f.repoRoot, file);
        const expected = reader === 'plan' ? text : { changedFiles: ['src/a.ts'], useStaged: true };
        sharedReads([file], read, expected);
        freshness(file, read, expected, changed, () => assert.deepEqual(read(), reader === 'plan'
            ? changed : { changedFiles: ['src/b.ts'], useStaged: false }));
    });
}

test('classification shares transaction bytes/hash and rejects changed snapshots at exit and between calls', t => {
    const f = fixture(t);
    const classification = { required_review_types: ['code'] };
    const reference = writeReviewClassificationSnapshot({ ...f, classification });
    const read = () => readRestartReviewClassification({ ...f, details: { authoritative_review_classification_reference: reference } });
    sharedReads([reference.artifact_path], read, classification);
    freshness(reference.artifact_path, read, classification, '{}', () => assert.throws(read, /hash does not match/u));
    withInvocationReadObservation(() => {
        const result = read() as typeof classification;
        result.required_review_types.push('caller mutation');
        assert.deepEqual(read(), classification);
    });
});

test('failed-review criteria shares the bound context and refuses changed context at exit and between calls', t => {
    const f = fixture(t);
    const context = path.join(f.reviewsRoot, `${f.taskId}-code-review-context.json`);
    fs.writeFileSync(context, '{}');
    const baseline = { review_type: 'code', bindings: { context: {
        review_context_path: context, review_context_sha256: hash('{}')
    } } } as unknown as ReviewRemediationBaselineArtifact;
    const read = () => resolveFailedReviewTaskCriteriaChange({ ...f, baseline, baselineSha256: 'b'.repeat(64), currentTaskIntent: 'Read' });
    sharedReads([context], read, null);
    freshness(context, read, null, '{"changed":true}', () => assert.equal(read(), true));
});

test('bundle path selection probes markers once per invocation and retains missing/present witnesses', t => {
    const f = fixture(t);
    const deployed = path.join(f.repoRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(deployed);
    const manifest = path.join(deployed, 'MANIFEST.md'), version = path.join(deployed, 'VERSION');
    fs.writeFileSync(manifest, 'manifest'); fs.writeFileSync(version, '1.4.4');
    const native = require('node:fs') as typeof fs;
    const exists = native.existsSync;
    const probes = new Map<string, number>();
    t.mock.method(native, 'existsSync', (file: fs.PathLike) => {
        if ([manifest, version].includes(String(file))) probes.set(String(file), (probes.get(String(file)) ?? 0) + 1);
        return exists(file);
    });
    for (let call = 0; call < 2; call++) {
        probes.clear();
        withInvocationReadObservation(() => {
            for (let i = 0; i < 100; i++) for (const root of [f.repoRoot, deployed]) {
                assert.equal(joinOrchestratorPath(root, 'runtime/reviews'), path.join(deployed, 'runtime/reviews'));
            }
        });
        assert.ok((probes.get(manifest) ?? 0) <= 1, 'MANIFEST selection is invocation scoped');
        assert.ok((probes.get(version) ?? 0) <= 2, 'VERSION also participates in bundle-name selection');
        assert.ok((probes.get(manifest) ?? 0) > 0, 'the next invocation probes again');
    }
    for (const marker of [manifest, version]) {
        const bytes = fs.readFileSync(marker);
        assert.throws(() => withInvocationReadObservation(() => {
            joinOrchestratorPath(f.repoRoot, 'runtime');
            fs.unlinkSync(marker);
        }), /Invocation.*changed/iu);
        assert.throws(() => withInvocationReadObservation(() => {
            joinOrchestratorPath(f.repoRoot, 'runtime');
            fs.writeFileSync(marker, bytes);
        }), /Invocation.*changed/iu);
    }
    fs.rmSync(deployed, { recursive: true });
    assert.equal(withInvocationReadObservation(() => joinOrchestratorPath(f.repoRoot, 'runtime')), path.join(f.repoRoot, 'runtime'));
});

test('retained bytes cannot bypass bounded plan and transaction safety checks', t => {
    const f = fixture(t);
    const file = path.join(f.reviewsRoot, 'input.json');
    fs.writeFileSync(file, '123456789');
    for (const read of [() => readBoundedTaskPlanFile(f.repoRoot, file, 8),
        () => readTransactionBytes(f.reviewsRoot, file, 8)]) {
        withInvocationReadObservation(() => {
            readInvocationTextFile(file);
            assert.throws(read, /limit|bound|oversized/u);
        });
    }
    const alias = path.join(f.reviewsRoot, 'linked.json');
    fs.linkSync(file, alias);
    for (const read of [() => readBoundedTaskPlanFile(f.repoRoot, file, 1024),
        () => readTransactionBytes(f.reviewsRoot, file, 1024)]) {
        withInvocationReadObservation(() => {
            readInvocationTextFile(file);
            assert.throws(read, /unshared|Unsafe transaction path/u);
        });
    }
});

test('cold bounded plan capture retains descriptor identity checks during a write', t => {
    const f = fixture(t);
    const file = path.join(f.reviewsRoot, 'input.json');
    fs.writeFileSync(file, '{}');
    const native = require('node:fs') as typeof fs;
    const read = native.readSync;
    let changed = false;
    t.mock.method(native, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        const count = read(fd, buffer, offset, length, position);
        if (count > 0 && !changed) { changed = true; fs.appendFileSync(file, ' '); }
        return count;
    });
    assert.throws(() => withInvocationReadObservation(() => readBoundedTaskPlanFile(f.repoRoot, file, 1024)), /changed|grew/u);
});

test('classification read refuses a hard-linked snapshot even when its bytes are retained', t => {
    const f = fixture(t);
    const reference = writeReviewClassificationSnapshot({ ...f, classification: { source: 'delta' } });
    fs.linkSync(reference.artifact_path, path.join(f.reviewsRoot, 'hardlink.json'));
    withInvocationReadObservation(() => {
        readInvocationTextFile(reference.artifact_path);
        assert.throws(() => readRestartReviewClassification({ ...f,
            details: { authoritative_review_classification_reference: reference } }), /Unsafe transaction path/u);
    });
});
