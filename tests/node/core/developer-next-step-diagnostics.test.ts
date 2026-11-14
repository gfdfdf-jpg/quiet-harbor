import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { createDiagnosticSession, parseTiming, readDiagnosticRecords, runDiagnostics, summarizeDiagnostics,
    type DiagnosticRecord } from '../../../scripts/node-foundation/diagnose-next-step';

const TASK_ID = 'T-DIAGNOSTIC-1';
const TIMING = 'GARDA_NEXT_STEP_TIMING {"phases_ms":{"total":1},"work":{}}\n';
const RESULT_SCRIPT = `
process.stdout.write(JSON.stringify({ task_id: process.argv[3], status: 'READY', next_gate: 'quality-checklist',
    generated_utc: new Date().toISOString(), review: { next_review_type: 'test' },
    received: { argv: process.argv.slice(2), cwd: process.cwd(), timing: process.env.GARDA_NEXT_STEP_TIMING,
        token: process.env.GARDA_DIAGNOSTIC_TEST_TOKEN || null, node_options: process.env.NODE_OPTIONS || null } }) + '\\n');
`;
const GOOD_SCRIPT = RESULT_SCRIPT + `process.stderr.write(${JSON.stringify(TIMING)});\n`;

function fixture(t: TestContext, script = GOOD_SCRIPT) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-developer-diagnostic-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repoRoot = path.join(root, 'repo with spaces & literal'), outputDir = path.join(root, 'external logs');
    const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const launcher = path.join(runtimeRoot, 'bin', 'garda.js');
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, script);
    fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{"name":"diagnostic-fixture","type":"commonjs"}\n');
    fs.writeFileSync(path.join(repoRoot, 'keep.txt'), 'unchanged repository sentinel\n');
    return { root, repoRoot, outputDir, runtimeRoot, launcher, options: { repoRoot, outputDir, launcher, taskId: TASK_ID, timeoutMs: 10_000 } };
}

function repositoryContents(root: string): Record<string, string> {
    const contents: Record<string, string> = {};
    const visit = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute);
            if (entry.isDirectory()) { contents[relative + '/'] = 'directory'; visit(absolute); }
            else contents[relative] = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        }
    };
    visit(root);
    return contents;
}

function outside(file: string, repoRoot: string): void {
    const relative = path.relative(fs.realpathSync.native(repoRoot), fs.realpathSync.native(file));
    assert.ok(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), file);
}

function setEnvironment(t: TestContext, key: string, value: string): void {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

test('records repeated real navigator processes with literal arguments, inherited environment and separate raw output', t => {
    const f = fixture(t), before = repositoryContents(f.repoRoot);
    setEnvironment(t, 'GARDA_DIAGNOSTIC_TEST_TOKEN', 'literal & token');
    setEnvironment(t, 'GARDA_NEXT_STEP_TIMING', 'caller-value');
    setEnvironment(t, 'NODE_OPTIONS', '--no-warnings');
    const run = runDiagnostics({ ...f.options, repeat: 3, label: 'baseline' });
    assert.equal(run.exitCode, 0);
    assert.equal(run.records.length, 3);
    assert.equal(new Set(run.records.map(record => record.stdout_file)).size, 3);
    assert.equal(new Set(run.records.map(record => record.record_id)).size, 3);
    for (const [index, record] of run.records.entries()) {
        assert.equal(record.index, index + 1);
        assert.equal(record.label, 'baseline');
        assert.equal(record.native_exit_code, 0);
        assert.equal(record.runtime_selection, 'not_observed');
        assert.equal(record.core_ms, 1);
        assert.ok(record.wall_ms >= record.core_ms);
        assert.equal(record.outside_core_ms, record.wall_ms - 1);
        assert.equal(record.next_gate, 'quality-checklist');
        assert.equal(record.review_lane, 'test');
        assert.equal(record.node_options_present, true);
        assert.deepEqual(record.issues, []);
        assert.deepEqual(record.runtime_descriptor_before, record.runtime_descriptor_after);
        assert.deepEqual(record.command.slice(1), [fs.realpathSync.native(f.launcher), 'next-step', TASK_ID,
            '--repo-root', fs.realpathSync.native(f.repoRoot), '--as-json']);
        const output = JSON.parse(fs.readFileSync(record.stdout_file, 'utf8'));
        assert.deepEqual(output.received.argv, ['next-step', TASK_ID, '--repo-root', fs.realpathSync.native(f.repoRoot), '--as-json']);
        assert.equal(output.received.cwd, fs.realpathSync.native(f.repoRoot));
        assert.equal(output.received.timing, '1');
        assert.equal(output.received.token, 'literal & token');
        assert.equal(output.received.node_options, '--no-warnings');
        assert.equal(fs.readFileSync(record.stderr_file, 'utf8'), TIMING);
        outside(record.stdout_file, f.repoRoot); outside(record.stderr_file, f.repoRoot);
    }
    assert.equal(process.env.GARDA_NEXT_STEP_TIMING, 'caller-value');
    assert.equal(new Set(run.records.map(record => record.navigator_state_sha256)).size, 1,
        'generated timestamps alone must not split an otherwise identical navigator state');
    assert.deepEqual(readDiagnosticRecords(run.runDir), run.records);
    assert.deepEqual(readDiagnosticRecords(f.outputDir), run.records);
    const summary = JSON.parse(fs.readFileSync(path.join(run.runDir, 'summary.json'), 'utf8'));
    assert.equal(summary.groups.length, 1); assert.equal(summary.groups[0].wall.count, 3);
    assert.deepEqual(repositoryContents(f.repoRoot), before);
});

for (const [name, stderr, issue] of [
    ['missing', 'ordinary stderr\n', 'missing_timing_record'],
    ['multiple', TIMING + TIMING, 'multiple_timing_records'],
    ['malformed JSON', 'GARDA_NEXT_STEP_TIMING {not-json}\n', 'malformed_timing_record'],
    ['invalid metric', 'GARDA_NEXT_STEP_TIMING {"phases_ms":{"total":1},"work":{"visits":-1}}\n', 'malformed_timing_record'],
    ['impossible core duration', 'GARDA_NEXT_STEP_TIMING {"phases_ms":{"total":1000000000000},"work":{}}\n', 'core_exceeds_process_wall']
]) test(`retains raw output and rejects ${name} timing without repeating a failed sample`, t => {
    const f = fixture(t, RESULT_SCRIPT + `process.stderr.write(${JSON.stringify(stderr)});`);
    const run = runDiagnostics({ ...f.options, repeat: 3 });
    assert.equal(run.exitCode, 2); assert.equal(run.records.length, 1);
    assert.equal(run.records[0].native_exit_code, 0);
    assert.ok(run.records[0].issues.includes(issue));
    assert.equal(fs.readFileSync(run.records[0].stderr_file, 'utf8'), stderr);
    assert.equal(summarizeDiagnostics(run.records).groups.length, 0);
    assert.equal(summarizeDiagnostics(run.records).rejected_count, 1);
});

test('timing parsing accepts one marker among ordinary stderr but rejects invalid structures and non-finite numbers', () => {
    assert.deepEqual(parseTiming('before\r\n' + TIMING.replace('\n', '\r\n') + 'after\r\n'),
        { timing: { phases_ms: { total: 1 }, work: {} } });
    for (const payload of ['null', '[]', '{}', '{"phases_ms":[],"work":{}}',
        '{"phases_ms":{"total":"1"},"work":{}}', '{"phases_ms":{"total":1e400},"work":{}}',
        '{"phases_ms":{"total":1,"parse":-1},"work":{}}', '{"phases_ms":{"total":1},"work":{"visits":"2"}}']) {
        assert.deepEqual(parseTiming('GARDA_NEXT_STEP_TIMING ' + payload), { timing: null, issue: 'malformed_timing_record' });
    }
    assert.equal(parseTiming('prefix ' + TIMING).issue, 'missing_timing_record');
});

test('preserves native nonzero exit and excludes its apparently valid timing from comparison', t => {
    const f = fixture(t, GOOD_SCRIPT + '\nprocess.exitCode = 7;');
    const run = runDiagnostics({ ...f.options, repeat: 2 });
    assert.equal(run.exitCode, 7); assert.equal(run.records.length, 1);
    assert.equal(run.records[0].native_exit_code, 7);
    assert.equal(run.records[0].core_ms, 1);
    assert.equal(summarizeDiagnostics(run.records).rejected_count, 1);
    assert.equal(summarizeDiagnostics(run.records).groups.length, 0);
});

test('times out the actual child and retains its partial diagnostics without claiming successful execution', t => {
    const f = fixture(t, GOOD_SCRIPT + '\nsetTimeout(() => {}, 30_000);');
    const before = repositoryContents(f.repoRoot);
    const run = runDiagnostics({ ...f.options, repeat: 2, timeoutMs: 300 });
    assert.equal(run.exitCode, 2); assert.equal(run.records.length, 1);
    assert.equal(run.records[0].timed_out, true);
    assert.notEqual(run.records[0].native_exit_code, 0);
    assert.ok(run.records[0].issues.includes('child_process_error'));
    assert.ok(fs.existsSync(run.records[0].stdout_file)); assert.ok(fs.existsSync(run.records[0].stderr_file));
    assert.equal(summarizeDiagnostics(run.records).groups.length, 0);
    assert.deepEqual(repositoryContents(f.repoRoot), before);
});

test('captures a real Node CPU profile exclusively outside the target repository', t => {
    const f = fixture(t), before = repositoryContents(f.repoRoot);
    const run = runDiagnostics({ ...f.options, cpuProfile: true });
    assert.equal(run.exitCode, 0, JSON.stringify(run.records[0].issues));
    const sample = run.records[0];
    assert.equal(sample.cpu_profile, true); assert.ok(sample.cpu_profile_file);
    outside(sample.cpu_profile_file, f.repoRoot);
    const profile = JSON.parse(fs.readFileSync(sample.cpu_profile_file, 'utf8'));
    assert.ok(profile.nodes.length > 0);
    assert.ok(typeof profile.startTime === 'number'); assert.ok(profile.endTime >= profile.startTime);
    assert.equal(fs.readdirSync(run.runDir).filter(file => file.endsWith('.cpuprofile')).length, 1);
    assert.deepEqual(repositoryContents(f.repoRoot), before);
});

test('refuses direct and junction-resolved internal output before launching or creating project artifacts', t => {
    const f = fixture(t), before = repositoryContents(f.repoRoot);
    for (const outputDir of [f.repoRoot, path.join(f.repoRoot, 'not-yet-created', 'logs')]) {
        assert.throws(() => runDiagnostics({ ...f.options, outputDir }), /outside|inside/);
        assert.throws(() => createDiagnosticSession({ ...f.options, outputDir }), /outside|inside/);
    }
    const link = path.join(f.root, 'external-junction');
    fs.symlinkSync(f.repoRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    for (const outputDir of [link, path.join(link, 'missing', 'logs')]) {
        assert.throws(() => runDiagnostics({ ...f.options, outputDir }), /outside|inside/);
        assert.throws(() => createDiagnosticSession({ ...f.options, outputDir }), /outside|inside/);
    }
    assert.deepEqual(repositoryContents(f.repoRoot), before);
    assert.equal(fs.existsSync(f.outputDir), false);
});

test('detects a child changing its own fixture runtime descriptor and stops repeated sampling', t => {
    const f = fixture(t, `require('node:fs').appendFileSync(require('node:path').join(__dirname, '..', 'package.json'), '\\n');\n` + GOOD_SCRIPT);
    const run = runDiagnostics({ ...f.options, repeat: 3 });
    assert.equal(run.exitCode, 2); assert.equal(run.records.length, 1);
    const sample = run.records[0], packageFile = path.join(f.runtimeRoot, 'package.json');
    assert.equal(sample.native_exit_code, 0);
    assert.ok(sample.issues.includes('runtime_descriptor_changed'));
    assert.notEqual(sample.runtime_descriptor_before[packageFile], sample.runtime_descriptor_after[packageFile]);
    assert.equal(summarizeDiagnostics(run.records).groups.length, 0);
});

test('summary deduplicates the same sample and keeps states, profiles and runtime descriptors separate', t => {
    const f = fixture(t), base = runDiagnostics(f.options).records[0];
    const first: DiagnosticRecord = { ...base, record_id: 'first', wall_ms: 4, core_ms: 1, outside_core_ms: 3 };
    const second: DiagnosticRecord = { ...first, record_id: 'second', wall_ms: 12, core_ms: 3, outside_core_ms: 9 };
    const changed: DiagnosticRecord[] = [
        { ...first, record_id: 'state', navigator_state_sha256: 'changed' },
        { ...first, record_id: 'profile', cpu_profile: true },
        { ...first, record_id: 'runtime', runtime_descriptor_sha256: 'different' },
        { ...first, record_id: 'lane', review_lane: 'code' }
    ];
    const failed: DiagnosticRecord = { ...first, record_id: 'failed', native_exit_code: 9 };
    const summary = summarizeDiagnostics([first, second, ...changed, failed, first]);
    assert.equal(summary.recorded_count, 7); assert.equal(summary.duplicate_count, 1);
    assert.equal(summary.rejected_count, 1); assert.equal(summary.groups.length, 5);
    const combined = summary.groups.find(group => group.wall.count === 2)!;
    assert.ok(combined); assert.equal(combined.first_wall_ms, 4);
    assert.deepEqual(combined.wall, { count: 2, mean_ms: 8, median_ms: 8, p95_ms: 12, min_ms: 4, max_ms: 12 });
    assert.deepEqual(combined.core, { count: 2, mean_ms: 2, median_ms: 2, p95_ms: 3, min_ms: 1, max_ms: 3 });
    assert.equal(summary.groups.filter(group => group.cpu_profile).length, 1);
});

test('generated external session wrapper records successive invocations without changing the target repository', t => {
    const f = fixture(t), before = repositoryContents(f.repoRoot);
    const session = createDiagnosticSession({ ...f.options, label: 'external agent session' });
    outside(session, f.repoRoot);
    assert.deepEqual(readDiagnosticRecords(session), []);
    const wrapper = path.join(session, 'next-step.cjs');
    for (let index = 0; index < 2; index++) {
        const child = spawnSync(process.execPath, [wrapper, TASK_ID], { cwd: f.root, encoding: 'utf8', shell: false, timeout: 15_000 });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout).task_id, TASK_ID);
        assert.match(child.stderr, /Developer next-step diagnostics:/);
    }
    const records = readDiagnosticRecords(session);
    assert.equal(records.length, 2);
    assert.notEqual(records[0].stdout_file, records[1].stdout_file);
    assert.equal(summarizeDiagnostics(records).groups.length, 1);
    assert.equal(records[0].label, 'external agent session');
    const refused = spawnSync(process.execPath, [wrapper, TASK_ID, '--repo-root', f.root],
        { cwd: f.root, encoding: 'utf8', shell: false, timeout: 10_000 });
    assert.equal(refused.status, 2); assert.match(refused.stderr, /Usage:/);
    assert.equal(readDiagnosticRecords(session).length, 2);
    assert.deepEqual(repositoryContents(f.repoRoot), before);
});

test('exclusive raw-output creation refuses a collision without overwriting retained evidence or launching the child', t => {
    const f = fixture(t), before = repositoryContents(f.repoRoot);
    fs.mkdirSync(f.outputDir);
    const occupied = path.join(f.outputDir, 'occupied-run'); fs.mkdirSync(occupied);
    const stdout = path.join(occupied, 'call-0001.stdout.txt'); fs.writeFileSync(stdout, 'retained evidence');
    const nativeFs = require('node:fs') as typeof fs;
    const spy = t.mock.method(nativeFs, 'mkdtempSync', (prefix: string) => {
        assert.equal(path.dirname(prefix), fs.realpathSync.native(f.outputDir));
        return occupied;
    });
    assert.throws(() => runDiagnostics(f.options), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
    spy.mock.restore();
    assert.equal(fs.readFileSync(stdout, 'utf8'), 'retained evidence');
    assert.equal(fs.existsSync(path.join(occupied, 'call-0001.stderr.txt')), false);
    assert.deepEqual(repositoryContents(f.repoRoot), before);
});

for (const [name, stdout] of [
    ['malformed JSON', '{broken'],
    ['foreign task result', JSON.stringify({ task_id: 'T-FOREIGN', status: 'READY', next_gate: 'quality-checklist' })]
]) test(`does not compare a sample with ${name} even when timing is valid`, t => {
    const f = fixture(t, `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(TIMING)});`);
    const run = runDiagnostics(f.options), sample = run.records[0];
    assert.equal(run.exitCode, 2);
    assert.ok(sample.issues.includes('navigator_output_unparseable_or_task_mismatch'));
    assert.equal(sample.navigator_state_sha256, null);
    assert.equal(fs.readFileSync(sample.stdout_file, 'utf8'), stdout);
    assert.equal(summarizeDiagnostics(run.records).groups.length, 0);
});

test('retained record reader rejects malformed samples instead of silently admitting them into a summary', t => {
    const f = fixture(t), run = runDiagnostics(f.options);
    const recordFile = path.join(run.runDir, 'call-0001.json');
    const original = fs.readFileSync(recordFile, 'utf8');
    fs.writeFileSync(recordFile, JSON.stringify({ ...run.records[0], wall_ms: -1 }));
    assert.throws(() => readDiagnosticRecords(run.runDir), /Invalid diagnostic record/);
    fs.writeFileSync(recordFile, original);
    assert.deepEqual(readDiagnosticRecords(run.runDir), run.records);
    assert.equal(fs.readFileSync(run.records[0].stderr_file, 'utf8'), TIMING);
});

test('cache controls and Node executable/platform/architecture never share a comparison group', t => {
    const f = fixture(t);
    setEnvironment(t, 'NODE_DISABLE_COMPILE_CACHE', '0');
    const enabled = runDiagnostics(f.options).records[0];
    process.env.NODE_DISABLE_COMPILE_CACHE = '1';
    const disabled = runDiagnostics(f.options).records[0];
    assert.notEqual(enabled.environment_sha256, disabled.environment_sha256);
    const changed = [
        { ...enabled, record_id: 'other-exe', node_executable: enabled.node_executable + '.other' },
        { ...enabled, record_id: 'other-platform', node_platform: 'other' },
        { ...enabled, record_id: 'other-arch', node_arch: 'other' }
    ];
    assert.equal(summarizeDiagnostics([enabled, disabled, ...changed]).groups.length, 5);
});

test('retained samples cannot conceal invalid durations, interrupted execution or missing state with empty issues', t => {
    const f = fixture(t), run = runDiagnostics(f.options), original = run.records[0];
    const recordFile = path.join(run.runDir, 'call-0001.json');
    const alterations: Partial<DiagnosticRecord>[] = [
        { core_ms: original.wall_ms + 1 }, { signal: 'SIGTERM' }, { process_error: 'execution failed' },
        { timed_out: true }, { status: null }, { navigator_state_sha256: null }
    ];
    for (const alteration of alterations) {
        const changed = { ...original, ...alteration, issues: [] };
        assert.equal(summarizeDiagnostics([changed]).groups.length, 0);
        fs.writeFileSync(recordFile, JSON.stringify(changed));
        const retained = readDiagnosticRecords(run.runDir);
        assert.ok(retained[0].issues.length > 0);
        assert.equal(summarizeDiagnostics(retained).groups.length, 0);
    }
});

test('timeout remains bounded when a POSIX child ignores SIGTERM', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
    const started = performance.now();
    const run = runDiagnostics({ ...f.options, timeoutMs: 300 });
    assert.ok(performance.now() - started < 5000);
    assert.equal(run.records[0].timed_out, true);
    assert.equal(run.records[0].signal, 'SIGKILL');
    assert.equal(summarizeDiagnostics(run.records).groups.length, 0);
});

test('developer recorder stays outside production compilation and npm package roots', () => {
    const root = getRepoRoot();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { files: string[] };
    const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.build.json'), 'utf8')) as { include: string[] };
    const candidates = ['scripts/node-foundation/diagnose-next-step.ts', 'scripts/node-foundation/diagnose-next-step.README.md',
        '.scripts-build/scripts/node-foundation/diagnose-next-step.js', 'tests/node/core/developer-next-step-diagnostics.test.ts'];
    for (const candidate of candidates) {
        for (const entry of pkg.files) {
            const normalized = entry.replace(/^\.\//u, '').replace(/\/$/u, '');
            assert.equal(candidate === normalized || candidate.startsWith(normalized + '/') || path.posix.matchesGlob(candidate, normalized), false,
                `${candidate} must not enter npm files through ${entry}`);
        }
        assert.equal(config.include.some(pattern => path.posix.matchesGlob(candidate, pattern)), false, candidate);
    }
    // Core-only builds need not have a publish artifact. Packaging validation owns that build.
    const manifestPath = path.join(root, 'dist/publish-runtime-manifest.json');
    if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files: string[] };
        assert.equal(manifest.files.some(file => file.includes('diagnose-next-step') || file.includes('developer-next-step-diagnostics')), false);
    }
});
