// Child-only native CJS tests. The parent controls early bootstrap; no fabricated receipts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../src/core/next-step-measurement';
import { captureLoadedCodeClosure } from '../../../src/core/loaded-code-identity';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
import { readInvocationFileContent, readInvocationPathObservation } from '../../../src/core/invocation-file-observation';
const scenario = process.argv[2], supplied = process.argv[3];
const created = supplied ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'garda-loaded-code-'));
// A canonical scratch root keeps fixture filenames equal to their native realpath despite 8.3 TEMP spellings.
const root = supplied || (process.platform === 'win32' ? fs.realpathSync.native(created!) : created!);
const policy = path.join(root, 'policy.js'), dependency = path.join(root, 'dependency.js');
const bootstrap = require.resolve('../../../src/bin/garda/derivation-source-receipts');
const keyPath = path.join(root, 'fixture-key'), proofPath = path.join(root, 'proof.json');
function generic() {
    const loaded = require(policy) as { result(): string };
    return { loaded, code: captureLoadedCodeClosure('garda.test-policy-code.v1', [require.resolve(policy)]) };
}
function writePolicy() {
    fs.writeFileSync(dependency, "exports.value = 'A';\n");
    fs.writeFileSync(policy, "const dependency = require('./dependency'); exports.result = () => dependency.value;\n");
}
function copyRuntime() {
    const destination = path.join(root, 'runtime');
    fs.cpSync(path.resolve(__dirname, '../../../src'), destination, { recursive: true });
    return destination;
}
function mutate(file: string, before: string, after: string) {
    const text = fs.readFileSync(file, 'utf8'); assert.ok(text.includes(before), 'real compiled fixture must contain the selected implementation');
    fs.writeFileSync(file, text.replace(before, after));
}
function measured<T>(action: () => T): { value: T; work: Record<string, number> } {
    let measurement: NextStepMeasurement | undefined;
    const value = withNextStepMeasurement(action, result => { measurement = result; });
    return { value, work: measurement!.work };
}
const observedCapture = () => withInvocationReadObservation(() => generic().code.sha256);
// The win32 reuse applies only where loader filenames already equal their native realpath (no 8.3 or case aliases).
const canonicalBuild = process.platform !== 'win32' || fs.realpathSync.native(__dirname) === __dirname;
const optimizedHere = process.platform === 'win32' && canonicalBuild && fs.realpathSync.native(root) === root;
// A non-canonical compiled build mixes reused fixture files with fallback build modules, so exact totals are skipped.
const exactCounts = canonicalBuild;
const probes = (work: Record<string, number>) => work.loaded_code_identity_probe || 0;
// Whole seconds survive utimes exactly, so replacements can keep the observed mtime bit-for-bit.
const FIXED_SECONDS = 1_700_000_000;
function pinTime(file: string) {
    fs.utimesSync(file, FIXED_SECONDS, FIXED_SECONDS); assert.equal(fs.statSync(file).mtimeMs, FIXED_SECONDS * 1000);
}
// Replace a path with a new inode whose size and mtime equal the pinned observed file.
function replaceKeepingSizeAndTime(file: string, bytes: string) {
    const stat = fs.statSync(file); assert.equal(Buffer.byteLength(bytes), stat.size, 'replacement must keep the observed size');
    fs.renameSync(file, file + '.' + randomBytes(4).toString('hex')); fs.writeFileSync(file, bytes); pinTime(file);
}
function pinnedPolicy() { writePolicy(); pinTime(dependency); require(policy); }
function trySymlink(target: string, link: string, type: 'file' | 'junction'): boolean {
    try { fs.symlinkSync(target, link, type); return true; }
    catch (error) { if (type === 'file' && (error as NodeJS.ErrnoException).code === 'EPERM') return false; throw error; }
}
try {
    if (scenario === 'diagnostics') {
        writePolicy(); require(policy);
        let measurement: NextStepMeasurement | undefined;
        const measured = withNextStepMeasurement(() => withInvocationReadObservation(() => generic().code.sha256),
            value => { measurement = value; });
        const plain = withInvocationReadObservation(() => generic().code.sha256);
        assert.equal(measured, plain);
        for (const phase of ['code.capture', 'code.initial_graph', 'code.initial_files', 'code.file_content', 'code.final_graph',
            'invocation.dependency_validation', 'file.path_probe', 'file.path_validation', 'file.content_read_hash']) {
            assert.ok(measurement!.phases_ms[phase] >= 0, phase);
            assert.ok(measurement!.cpu_ms![phase].user >= 0, phase);
        }
        // Win32 Q2 reads made now carry identity()'s fields; other platforms keep the native identity phases.
        for (const phase of ['code.identity_stat', 'code.identity_realpath']) {
            if (optimizedHere) assert.equal(measurement!.phases_ms[phase], undefined, phase);
            else assert.ok(measurement!.phases_ms[phase] >= 0 && measurement!.cpu_ms![phase].user >= 0, phase);
        }
        let native: NextStepMeasurement | undefined;
        withNextStepMeasurement(() => generic(), value => { native = value; });
        for (const phase of ['code.identity_stat', 'code.identity_realpath', 'code.native_read']) assert.ok(native!.phases_ms[phase] >= 0, phase);
        assert.equal(measurement!.work['code.capture'], 1);
        assert.equal(measurement!.work['code.final_graph'], 1);
        assert.equal(measurement!.work['invocation.dependency_validation'], 1);
    } else if (scenario === 'observed-identity-equivalence') {
        writePolicy(); require(policy);
        observedCapture(); // Load the observation path's lazy modules before comparing closure graphs.
        const outside = measured(() => generic().code), files = outside.work['visit:loaded_code_initial_file'];
        assert.ok(files >= 3);
        assert.equal(probes(outside.work), 4 * files, 'Outside observation keeps identity() around each native hash.');
        // assertCurrent() recomputes identity() natively, so it accepts only identities equal to identity() strings.
        const inside = measured(() => withInvocationReadObservation(() => { const { code } = generic(); code.assertCurrent(); return code.sha256; }));
        assert.equal(inside.work['visit:loaded_code_initial_file'], files);
        if (exactCounts) assert.equal(probes(inside.work), (optimizedHere ? 4 : 6) * files);
        assert.equal(inside.work.loaded_code_retained_content_identity_check, undefined);
        assert.equal(inside.value, outside.value.sha256);
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        // Some win32 Node releases (22.13 on current runners) return path stats without the volume id while
        // descriptor stats carry it. Only the real win32 branch completes that identity, so a POSIX emulation
        // on such a host must fail closed instead of measuring a POSIX run.
        const incompletePathStats = process.platform === 'win32' && fs.statSync(dependency).dev === 0;
        let posix: { value: string; work: Record<string, number> } | undefined;
        let posixError: unknown;
        Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
        try { posix = measured(observedCapture); }
        catch (error) { posixError = error; }
        finally { Object.defineProperty(process, 'platform', platform); }
        if (incompletePathStats) {
            assert.equal(posix, undefined, 'POSIX emulation must not accept a path stat without a volume id.');
            assert.match(String((posixError as Error | undefined)?.message), /Invocation descriptor does not match observed file/);
        } else {
            if (posixError !== undefined) throw posixError;
            // process.platform is part of the binding digest, so only the identity() path is compared here.
            assert.equal(probes(posix!.work), 2 * files, 'Other platforms keep both identity() checks under observation.');
        }
    } else if (scenario === 'observed-same-size-mtime-replaced') {
        pinnedPolicy();
        const original = fs.readFileSync(dependency, 'utf8');
        replaceKeepingSizeAndTime(dependency, "exports.value = 'B';\n");
        assert.throws(observedCapture, /Loaded code differs from current executable bytes/);
        replaceKeepingSizeAndTime(dependency, original);
        const sha = observedCapture();
        assert.throws(() => withInvocationReadObservation(() => {
            generic(); replaceKeepingSizeAndTime(dependency, "exports.value = 'C';\n");
        }), /Invocation file observation changed/);
        replaceKeepingSizeAndTime(dependency, original);
        assert.throws(() => withInvocationReadObservation(() => {
            generic(); replaceKeepingSizeAndTime(dependency, original);
        }), /Invocation file observation changed/, 'A same-byte, same-size, same-mtime replacement remains a new file.');
        assert.throws(() => withInvocationReadObservation(() => {
            const { code } = generic(); replaceKeepingSizeAndTime(dependency, original); code.assertCurrent();
        }), /file identity changed before publication/);
        assert.equal(observedCapture(), sha);
    } else if (scenario === 'observed-read-race') {
        pinnedPolicy();
        const original = fs.readFileSync(dependency, 'utf8'), io = require('node:fs') as typeof import('node:fs');
        const nativeOpen = io.openSync, nativeRead = io.readSync;
        // Write through the captured native open so the race does not re-enter the patched functions.
        const nativeWrite = (file: string, text: string) => {
            const descriptor = nativeOpen(file, 'w');
            try { io.writeSync(descriptor, text); } finally { io.closeSync(descriptor); }
        };
        for (const mode of ['in-place', 'replace']) {
            let descriptor: number | null = null, changed = false;
            io.openSync = function (this: unknown, ...args: unknown[]) {
                const result = Reflect.apply(nativeOpen, this, args) as number;
                if (path.resolve(String(args[0])) === dependency) descriptor = result;
                return result;
            } as typeof io.openSync;
            io.readSync = function (this: unknown, ...args: unknown[]) {
                const result = Reflect.apply(nativeRead, this, args) as number;
                if (args[0] === descriptor && !changed) {
                    changed = true;
                    if (mode === 'in-place') nativeWrite(dependency, "exports.value = 'D';\n");
                    else { fs.renameSync(dependency, dependency + '.raced'); nativeWrite(dependency, original); }
                }
                return result;
            } as typeof io.readSync;
            try {
                assert.throws(observedCapture, /changed during read|Invocation file observation changed|Loaded code differs/, mode);
                assert.ok(changed, 'The race must occur inside the native content read: ' + mode);
            } finally { io.openSync = nativeOpen; io.readSync = nativeRead; }
            replaceKeepingSizeAndTime(dependency, original);
        }
        observedCapture();
    } else if (scenario === 'observed-retained-content') {
        pinnedPolicy();
        const original = fs.readFileSync(dependency, 'utf8');
        const retained = measured(() => withInvocationReadObservation(() => { readInvocationFileContent(dependency); return generic().code.sha256; }));
        if (optimizedHere) {
            assert.equal(retained.work.loaded_code_retained_content_identity_check, 1);
            assert.equal(probes(retained.work), 1, 'A retained read keeps one fresh native identity check.');
        }
        // The reused branch must fail during capture; the unchanged branch may fail only at final validation.
        const retainedFailure = optimizedHere ? /Loaded-code file identity changed during capture/
            : /file identity changed during capture|Invocation file observation changed/;
        assert.throws(() => withInvocationReadObservation(() => {
            readInvocationFileContent(dependency); replaceKeepingSizeAndTime(dependency, original); generic();
        }), retainedFailure);
        assert.throws(() => withInvocationReadObservation(() => {
            readInvocationFileContent(dependency); replaceKeepingSizeAndTime(dependency, "exports.value = 'E';\n"); generic();
        }), retainedFailure);
        replaceKeepingSizeAndTime(dependency, original);
        assert.equal(observedCapture(), retained.value);
    } else if (scenario === 'observed-link-and-case') {
        const lib = path.join(root, 'lib'), libPolicy = path.join(lib, 'policy.js'), libDependency = path.join(lib, 'dependency.js');
        fs.mkdirSync(lib); fs.writeFileSync(libDependency, "exports.value = 'A';\n");
        fs.writeFileSync(libPolicy, "const dependency = require('./dependency'); exports.result = () => dependency.value;\n");
        require(libPolicy);
        const capture = () => captureLoadedCodeClosure('garda.test-link-code.v1', [require.resolve(libPolicy)]);
        withInvocationReadObservation(capture);
        const copy = path.join(root, 'dependency-copy.js'), moved = libDependency + '.moved';
        fs.copyFileSync(libDependency, copy);
        let linked = false;
        assert.throws(() => withInvocationReadObservation(() => {
            capture(); fs.renameSync(libDependency, moved);
            linked = trySymlink(copy, libDependency, 'file');
            if (!linked) fs.copyFileSync(moved, libDependency);
        }), /Invocation file observation changed/, 'A symlink to identical bytes changes the observed path state.');
        if (!linked) process.stdout.write('file symlink privilege unavailable; replacement fallback exercised\n');
        fs.unlinkSync(libDependency); fs.renameSync(moved, libDependency);
        withInvocationReadObservation(capture);
        assert.throws(() => withInvocationReadObservation(() => {
            capture(); fs.renameSync(lib, lib + '-real'); trySymlink(lib + '-real', lib, 'junction');
        }), /Invocation file observation changed/, 'A junction to the same inodes changes the observed path state.');
        fs.unlinkSync(lib); fs.renameSync(lib + '-real', lib);
        withInvocationReadObservation(capture);
        // Case aliases exist only on case-insensitive volumes; the reuse itself is win32-only.
        if (process.platform === 'win32') {
            assert.throws(() => withInvocationReadObservation(() => {
                capture(); fs.renameSync(libDependency, path.join(lib, 'Dependency.js'));
            }), /Invocation file observation changed/, 'A case-only rename changes the native path observation.');
            fs.renameSync(path.join(lib, 'Dependency.js'), libDependency);
            // A loader filename whose spelling differs from the native realpath keeps both identity() checks.
            const caseDir = path.join(root, 'case-dir'); fs.mkdirSync(caseDir);
            fs.writeFileSync(path.join(caseDir, 'case-module.js'), "exports.value = 'K';\n");
            const aliased = path.join(caseDir, 'CASE-MODULE.js'); require(aliased);
            assert.ok(require.cache[aliased], 'The loader must retain the requested spelling for this alias scenario.');
            if (optimizedHere) {
                const run = measured(() => withInvocationReadObservation(() =>
                    captureLoadedCodeClosure('garda.test-case-code.v1', [aliased]).sha256));
                assert.equal(probes(run.work), 2, 'Only the aliased module falls back to fresh identity() checks.');
            }
            fs.writeFileSync(path.join(caseDir, 'case-module.js'), "exports.value = 'L';\n");
            assert.throws(() => withInvocationReadObservation(() => captureLoadedCodeClosure('garda.test-case-code.v1', [aliased])),
                /Loaded code differs from current executable bytes/);
        }
    } else if (scenario === 'observed-stale-path-observation') {
        pinnedPolicy();
        const original = fs.readFileSync(dependency, 'utf8');
        // The path was observed earlier in this invocation; the read made now must still reject a later replacement.
        assert.throws(() => withInvocationReadObservation(() => {
            readInvocationPathObservation(dependency); replaceKeepingSizeAndTime(dependency, original); generic();
        }), /Invocation file changed before read/);
        replaceKeepingSizeAndTime(dependency, original);
        observedCapture();
    } else if (scenario === 'observed-graph-changed') {
        fs.writeFileSync(dependency, "exports.value = 'A';\n"); fs.writeFileSync(path.join(root, 'lazy.js'), "exports.lazy = true;\n");
        fs.writeFileSync(policy, "const dependency = require('./dependency'); exports.result = () => dependency.value; exports.lazy = () => require('./lazy');\n");
        const loaded = require(policy) as { lazy(): unknown };
        assert.throws(() => withInvocationReadObservation(() => { generic(); loaded.lazy(); }),
            /Loaded-code dependency graph changed|Loaded-code module instance changed/);
    } else if (scenario === 'observed-sequential-invocations') {
        pinnedPolicy();
        const original = fs.readFileSync(dependency, 'utf8');
        const first = measured(() => withInvocationReadObservation(() => generic().code));
        const files = first.work['visit:loaded_code_initial_file'];
        replaceKeepingSizeAndTime(dependency, original);
        const second = measured(() => withInvocationReadObservation(() => generic().code));
        // No observation, content or derived identity survives an invocation: every file is read and validated again.
        for (const run of [first, second]) {
            assert.ok(run.work['file.content_read_hash'] >= files);
            if (exactCounts) assert.equal(probes(run.work), optimizedHere ? 0 : 2 * files);
        }
        assert.equal(second.value.sha256, first.value.sha256);
        assert.throws(() => first.value.assertCurrent(), /file identity changed before publication/,
            'Publication still re-runs native identity against the identity recorded at capture.');
        second.value.assertCurrent();
        const outside = measured(() => generic().code);
        assert.equal(probes(outside.work), 4 * outside.work['visit:loaded_code_initial_file']);
        outside.value.assertCurrent();
    } else if (scenario === 'seed') {
        writePolicy(); fs.writeFileSync(keyPath, randomBytes(32));
        const { loaded, code } = generic(); assert.equal(loaded.result(), 'A'); code.assertCurrent();
        const payload = JSON.stringify({ code: code.sha256, result: loaded.result() });
        fs.writeFileSync(proofPath, JSON.stringify({ payload, mac: createHmac('sha256', fs.readFileSync(keyPath)).update(payload).digest('hex') }));
    } else if (scenario === 'cold-hit') {
        const { loaded, code } = generic(); const envelope = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
        assert.equal(envelope.mac, createHmac('sha256', fs.readFileSync(keyPath)).update(envelope.payload).digest('hex'));
        const proof = JSON.parse(envelope.payload); code.assertCurrent();
        assert.equal(proof.code, code.sha256, 'A fresh process must actually accept the unchanged code binding.');
        assert.equal(proof.result, loaded.result());
    } else if (scenario === 'loaded-json-replaced') {
        const jsonFile = path.join(root, 'dependency.json');
        fs.writeFileSync(jsonFile, '{"value":"A"}');
        fs.writeFileSync(policy, "const dependency = require('./dependency.json'); exports.result = () => dependency.value;\n");
        const first = generic(); assert.equal(first.loaded.result(), 'A'); first.code.assertCurrent();
        fs.writeFileSync(jsonFile, '{"value":"B"}');
        assert.equal(first.loaded.result(), 'A');
        assert.throws(() => generic(), /Loaded code differs from current executable bytes/);
        assert.throws(() => first.code.assertCurrent(), /Loaded code differs|file identity changed/);
    } else if (scenario === 'native-json-error') {
        const io = require('node:fs') as typeof import('node:fs'), originalRead = io.readFileSync;
        const jsonFile = path.join(root, 'invalid.json'); fs.writeFileSync(jsonFile, '{invalid');
        assert.throws(() => require(jsonFile), SyntaxError);
        assert.equal(io.readFileSync, originalRead, 'Native JSON exception must restore the exact read function.');
        writePolicy(); generic().code.assertCurrent();
    } else if (scenario === 'loaded-dependency-replaced') {
        writePolicy(); const first = generic(); assert.equal(first.loaded.result(), 'A'); first.code.assertCurrent();
        fs.writeFileSync(dependency, "exports.value = 'B';\n");
        assert.equal(first.loaded.result(), 'A', 'The executing reducer is still A after disk becomes B.');
        assert.throws(() => generic(), /Loaded code differs from current executable bytes/);
        assert.throws(() => first.code.assertCurrent(), /Loaded code differs from current executable bytes|Loaded-code file identity changed/);
    } else if (scenario === 'final-source-replaced') {
        writePolicy(); require(policy);
        assert.throws(() => withInvocationReadObservation(() => {
            captureLoadedCodeClosure('garda.test-policy-code.v1', [require.resolve(policy)]);
            fs.writeFileSync(dependency, "exports.value = 'B';\n");
        }), /Invocation.*changed|Loaded code/);
    } else if (scenario === 'same-byte-file-replaced') {
        writePolicy(); const first = generic(); const bytes = fs.readFileSync(policy);
        fs.renameSync(policy, policy + '.original'); fs.writeFileSync(policy, bytes);
        assert.throws(() => first.code.assertCurrent(), /file identity changed/);
    } else if (scenario === 'custom-loader') {
        const nativeModule = require('node:module') as { prototype: { _compile(source: string, file: string): unknown } };
        const previous = nativeModule.prototype._compile;
        nativeModule.prototype._compile = function(source: string, file: string) { return Reflect.apply(previous, this, [source, file]); };
        require(bootstrap);
        assert.equal(Object.getOwnPropertyDescriptor(globalThis, Symbol.for('garda.loaded-source-receipts.v1')), undefined,
            'A non-native loader closure must not acquire a receipt authority.');
        writePolicy(); assert.equal((require(policy) as { result(): string }).result(), 'A');
    } else if (scenario === 'module-instance-replaced') {
        writePolicy(); const first = generic();
        delete require.cache[require.resolve(policy)]; require(policy);
        assert.throws(() => first.code.assertCurrent(), /module instance changed/);
    } else if (scenario === 'late-bootstrap') {
        writePolicy(); const loaded = require(policy) as { result(): string };
        require(bootstrap); // It may attest future loads, never modules already executed.
        assert.equal(loaded.result(), 'A');
        assert.throws(() => captureLoadedCodeClosure('garda.test-policy-code.v1', [require.resolve(policy)]), /receipt|unavailable/);
    } else if (scenario === 'no-bootstrap') {
        writePolicy(); const loaded = require(policy) as { result(): string };
        assert.equal(loaded.result(), 'A');
        assert.throws(() => captureLoadedCodeClosure('garda.test-policy-code.v1', [require.resolve(policy)]), /unavailable/);
    } else if (scenario === 'real-reducer-replaced' || scenario === 'real-renderer-replaced') {
        const runtime = copyRuntime(), reducer = scenario === 'real-reducer-replaced';
        const file = path.join(runtime, reducer ? 'gates/review-attempts/review-closed-cycle-summary.js' : 'gates/task-audit/task-audit-summary-final-report.js');
        const loaded = require(file) as { createClosedReviewProducerState(task: string): { lastReviewLineOrdinal: number }; formatReviewResultStatus(text: string): string };
        const value = () => reducer ? loaded.createClosedReviewProducerState('T-code').lastReviewLineOrdinal : loaded.formatReviewResultStatus('REVIEW PASSED');
        const original = value(); assert.equal(original, reducer ? -1 : 'findings-satisfied');
        const code = captureLoadedCodeClosure(reducer ? 'garda.closed-review-code-test.v1' : 'garda.terminal-code-test.v1', [file]);
        code.assertCurrent();
        if (reducer) mutate(file, 'lastReviewLineOrdinal: -1', 'lastReviewLineOrdinal: 0');
        else mutate(file, "return 'findings-satisfied';", "return 'changed-code-result';");
        assert.equal(value(), original, 'Actual native export remains loaded A while the executable file is B.');
        assert.throws(() => captureLoadedCodeClosure('garda.replaced-code-test.v1', [file]), /Loaded code differs from current executable bytes/);
        assert.throws(() => code.assertCurrent(), /Loaded code differs from current executable bytes|Loaded-code file identity changed/);
        const fresh = spawnSync(process.execPath, ['-r', bootstrap, __filename, reducer ? 'fresh-reducer' : 'fresh-renderer', root],
            { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    } else if (scenario === 'fresh-reducer' || scenario === 'fresh-renderer') {
        const reducer = scenario === 'fresh-reducer';
        const file = path.join(root, 'runtime', reducer ? 'gates/review-attempts/review-closed-cycle-summary.js' : 'gates/task-audit/task-audit-summary-final-report.js');
        const loaded = require(file) as { createClosedReviewProducerState(task: string): { lastReviewLineOrdinal: number }; formatReviewResultStatus(text: string): string };
        assert.equal(reducer ? loaded.createClosedReviewProducerState('T-code').lastReviewLineOrdinal : loaded.formatReviewResultStatus('REVIEW PASSED'), reducer ? 0 : 'changed-code-result');
        captureLoadedCodeClosure('garda.fresh-code-test.v1', [file]).assertCurrent();
    } else throw new Error('Unknown loaded-code scenario.');
} finally { if (!supplied) fs.rmSync(root, { recursive: true, force: true }); }
