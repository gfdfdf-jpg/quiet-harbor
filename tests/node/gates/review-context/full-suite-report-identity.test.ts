import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validationDigest } from '../../../../src/core/project-validation-identity';
import type { TaskValidationProcessEvidence } from '../../../../src/core/task-validation-plan';
import { completeValidationReportCapture, prepareValidationReportCapture } from '../../../../src/core/validation-report-capture';
import { fullSuiteReportIdentity } from '../../../../src/gates/review-context/full-suite-report-identity';

const REPORT = 'reports/junit.xml';
const EXTRA = 'reports/extra.bin';
const XML = '<testsuite timestamp="earlier"><testcase name="adds"/></testsuite>\n';
const EVIDENCE = 'evidence';

function tempRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-report-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function waitPastClockTick(): void {
    const until = Date.now() + 3;
    while (Date.now() < until) { /* let the filesystem clock move past the capture anchor */ }
}

function capturedRun(root: string, files: Record<string, string | Buffer>, paths = Object.keys(files), writeAfterExit = false) {
    fs.rmSync(path.join(root, 'reports'), { recursive: true, force: true });
    const declarations = paths.map(file => ({ path: file, max_bytes: 65536 }));
    const start = prepareValidationReportCapture(root, declarations, { evidenceDirectory: EVIDENCE })!;
    waitPastClockTick();
    const startedAt = new Date().toISOString();
    const executionId = `run-${startedAt}`;
    const earlyExit = writeAfterExit ? new Date().toISOString() : undefined;
    waitPastClockTick();
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    }
    waitPastClockTick();
    const completedAt = earlyExit ?? new Date().toISOString();
    const capture = completeValidationReportCapture(root, start, [executionId])!;
    const process: TaskValidationProcessEvidence = { schema_version: 1, selection_sha256: 'a'.repeat(64), invocations: [{
        execution_id: executionId, invocation: 0, executable: 'node', argv: ['--test'], cwd: '.',
        started_at: startedAt, completed_at: completedAt, exit_code: 0, timed_out: false, cancelled: false,
        output_sha256: validationDigest('output'), scope_before: 's', scope_after: 's'
    }] };
    return { capture, process, declarations };
}

type Run = ReturnType<typeof capturedRun>;
const adapterOnly = { command: 'node --test', targets: [], reportFiles: [] };

function adapterIdentity(root: string, run: Run) {
    return fullSuiteReportIdentity(root, adapterOnly, { adapterCaptures: [run.capture], process: run.process });
}

test('complete report identities compare exact bytes by path regardless of capture order or format', t => {
    const root = tempRoot(t);
    const binary = Buffer.from([0, 255, 0, 13, 10]);
    const reviewed = adapterIdentity(root, capturedRun(root, { [REPORT]: XML, [EXTRA]: binary }));
    assert.deepEqual(reviewed, new Map([[REPORT, validationDigest(XML)], [EXTRA, validationDigest(binary)]]));
    assert.deepEqual(adapterIdentity(root, capturedRun(root, { [EXTRA]: binary, [REPORT]: XML })), reviewed);

    const changed = adapterIdentity(root, capturedRun(root, { [REPORT]: XML.replace('earlier', 'later'), [EXTRA]: binary }));
    assert.notEqual(changed, null);
    assert.notDeepEqual(changed, reviewed);
    const extra = adapterIdentity(root, capturedRun(root, { [REPORT]: XML, [EXTRA]: binary, 'reports/another.txt': 'extra' }));
    assert.notEqual(extra, null);
    assert.notDeepEqual(extra, reviewed);
});

test('missing or unowned adapter reports yield no comparable identity', t => {
    const root = tempRoot(t);
    const reviewed = capturedRun(root, { [REPORT]: XML });
    const missing = capturedRun(root, { [REPORT]: XML }, [REPORT, EXTRA]);
    assert.equal(missing.capture.reports.length, 1);
    assert.equal(adapterIdentity(root, missing), null);
    assert.equal(adapterIdentity(root, { ...missing, capture: { ...missing.capture, violations: [] } }), null);
    assert.equal(fullSuiteReportIdentity(root, adapterOnly, { process: reviewed.process }), null);
    assert.equal(fullSuiteReportIdentity(root, adapterOnly, { adapterCaptures: [reviewed.capture] }), null);

    const rerun = capturedRun(root, { [REPORT]: XML });
    assert.equal(adapterIdentity(root, { ...rerun, capture: reviewed.capture }), null);
    const foreign = structuredClone(rerun);
    foreign.capture.execution_ids = ['different-process'];
    assert.equal(adapterIdentity(root, foreign), null);
    const tampered = structuredClone(rerun);
    tampered.capture.reports[0].content_base64 = Buffer.from(XML + ' ').toString('base64');
    assert.equal(adapterIdentity(root, tampered), null);
    const stale = structuredClone(rerun);
    stale.capture.start.before[0] = stale.capture.reports[0].observation;
    assert.equal(adapterIdentity(root, stale), null);
});

test('the adapter must cover every Maven target even if an omitted capture left no violation', t => {
    const root = tempRoot(t);
    const first = 'reports/module/target/surefire-reports/TEST-app.First.xml';
    const second = 'reports/module/target/failsafe-reports/TEST-app.Second.xml';
    const declarations = { command: 'mvn test', targets: [
        'reports/module/src/test/java/app/First.java', 'reports/module/src/test/java/app/Second.java'
    ], reportFiles: [] };
    const reviewed = capturedRun(root, { [first]: XML, [second]: XML });
    assert.deepEqual(fullSuiteReportIdentity(root, declarations, { adapterCaptures: [reviewed.capture], process: reviewed.process }),
        new Map([[first, validationDigest(XML)], [second, validationDigest(XML)]]));
    const partial = capturedRun(root, { [first]: XML });
    assert.deepEqual(partial.capture.violations, []);
    assert.equal(fullSuiteReportIdentity(root, declarations, { adapterCaptures: [partial.capture], process: partial.process }), null);
});

function retainedAttempt(root: string, run: Run) {
    const outputPath = `${EVIDENCE}/output.json`;
    const output = JSON.stringify({ report_capture: run.capture });
    fs.writeFileSync(path.join(root, outputPath), output);
    return { attempt_id: 'attempt', attempt: 1, scope_content_sha256: 's',
        report_evidence: { declarations: run.declarations, start_sha256: validationDigest(run.capture.start), evidence_directory: EVIDENCE },
        output_path: outputPath, output_sha256: validationDigest(output), output_bytes: Buffer.byteLength(output), violations: [] };
}

test('configured reports require a complete bound final attempt even when an adapter captured the same paths', t => {
    const root = tempRoot(t);
    const run = capturedRun(root, { [REPORT]: XML });
    const attempt = retainedAttempt(root, run);
    const declarations = { ...adapterOnly, reportFiles: run.declarations };
    const options = { process: run.process, adapterCaptures: [run.capture] };
    assert.deepEqual(fullSuiteReportIdentity(root, declarations, { ...options, attempts: [attempt] }),
        new Map([[REPORT, validationDigest(XML)]]));
    assert.equal(fullSuiteReportIdentity(root, declarations, options), null);
    assert.equal(fullSuiteReportIdentity(root, adapterOnly, { ...options, attempts: [attempt] }), null);

    const later = capturedRun(root, { [REPORT]: XML });
    assert.equal(fullSuiteReportIdentity(root, declarations, { process: later.process, attempts: [attempt] }), null);
    fs.appendFileSync(path.join(root, attempt.output_path), ' ');
    assert.equal(fullSuiteReportIdentity(root, declarations, { ...options, attempts: [attempt] }), null);
});

test('a matching report written after the selected process exited does not qualify', t => {
    const root = tempRoot(t);
    const reviewed = capturedRun(root, { [REPORT]: XML });
    assert.deepEqual(adapterIdentity(root, reviewed), new Map([[REPORT, validationDigest(XML)]]));

    const late = capturedRun(root, { [REPORT]: XML }, [REPORT], true);
    assert.deepEqual(late.capture.violations, []);
    const exit = BigInt(Date.parse(late.process.invocations[0].completed_at)) * 1_000_000n;
    assert.ok(BigInt(late.capture.reports[0].observation.modified_ns) > exit);
    assert.equal(adapterIdentity(root, late), null);
    assert.equal(fullSuiteReportIdentity(root, { ...adapterOnly, reportFiles: late.declarations },
        { attempts: [retainedAttempt(root, late)], process: late.process }), null);
});
