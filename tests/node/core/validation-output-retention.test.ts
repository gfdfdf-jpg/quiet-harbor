import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
    beginValidationOutputRun,
    cleanupAuthorizedValidationOutput,
    cleanupTaskValidationOutput,
    readValidationTaskId,
    validationOutputRoot,
    VALIDATION_REPO_ROOT_ENV,
    VALIDATION_TASK_ID_ENV
} from '../../../src/core/validation-output-retention';
import { cleanupCompactAtTaskBoundary } from '../../../src/core/compact/lifecycle';
import { resolveCoverageTestArgs, runCoverageProcess } from '../../../scripts/node-foundation/coverage';

function fixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda validation Юникод-'));
    t.after(() => removeFixtureTree(root));
    return root;
}

function removeFixtureTree(target: string): void {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const name of fs.readdirSync(target)) removeFixtureTree(path.join(target, name));
        fs.rmdirSync(target);
    } else fs.unlinkSync(target);
}

function taskContext(t: TestContext, root: string, taskId: string): void {
    for (const [key, value] of [[VALIDATION_REPO_ROOT_ENV, root], [VALIDATION_TASK_ID_ENV, taskId]]) {
        const previous = process.env[key];
        process.env[key] = value;
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
}

function seedQueue(root: string, statuses: Record<string, string>): void {
    fs.writeFileSync(path.join(root, 'TASK.md'), [
        '## Active Queue', '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        ...Object.entries(statuses).map(([id, status]) => `| ${id} | ${status} | P2 | test | test | test | 2026-10-05 | balanced | |`)
    ].join('\n'));
}

function hash(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readManifest(root: string, runId: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(validationOutputRoot(root), runId, 'manifest.json'), 'utf8'));
}

function changeManifest(root: string, runId: string, changes: Record<string, unknown>): void {
    const file = path.join(validationOutputRoot(root), runId, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ ...readManifest(root, runId), ...changes }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date a run: its finalization time (when given) and the run directory's last change. */
function ageRun(root: string, runId: string, ageMs: number, finishedAgeMs?: number): void {
    if (finishedAgeMs !== undefined) {
        changeManifest(root, runId, { finished_at_utc: new Date(Date.now() - finishedAgeMs).toISOString() });
    }
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(path.join(validationOutputRoot(root), runId), when, when);
}

async function deadPid(): Promise<number> {
    const child = childProcess.spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await once(child, 'close');
    return child.pid!;
}

test('successful runs remove scratch after final reporting and preserve durable report hashes', t => {
    const root = fixture(t);
    const run = beginValidationOutputRun(root, 'coverage');
    fs.writeFileSync(path.join(run.scratchDir, 'coverage-123.json'), 'raw V8 data');
    const report = path.join(run.reportsDir, 'lcov.info');
    fs.writeFileSync(report, 'TN:\nSF:program.js\nend_of_record\n');
    const before = hash(report);
    run.finish(0);
    run.finish(0);
    assert.equal(fs.existsSync(run.scratchDir), false);
    assert.equal(hash(report), before);
    assert.equal(readManifest(root, run.runId).state, 'CLEANED');
    assert.match(String(readManifest(root, run.runId).reports_sha256), /^[a-f0-9]{64}$/u);
    assert.throws(() => run.trackChild(process.pid), /already finished/);
});

test('accepted completion cleans exact task attempts; DONE alone preserves diagnostics and all reports', async t => {
    const root = fixture(t);
    taskContext(t, root, 'T-1');
    const failed = beginValidationOutputRun(root, 'node-tests');
    fs.writeFileSync(path.join(failed.scratchDir, 'shard.log'), 'failed attempt');
    failed.finish(7);
    process.env[VALIDATION_TASK_ID_ENV] = 'T-10';
    const other = beginValidationOutputRun(root, 'node-tests');
    fs.writeFileSync(path.join(other.scratchDir, 'shard.log'), 'other task');
    other.finish(1);
    seedQueue(root, { 'T-1': 'DONE', 'T-10': 'IN_REVIEW' });
    const result = path.join(failed.reportsDir, 'result.json');
    const digest = hash(result);
    assert.equal(fs.existsSync(path.join(root, 'garda-agent-orchestrator/runtime/compact')), false);
    assert.deepEqual(await cleanupCompactAtTaskBoundary(root), []);
    assert.equal(fs.existsSync(failed.scratchDir), true, 'DONE is not accepted cleanup permission');
    assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-1'])), []);
    assert.equal(fs.existsSync(failed.scratchDir), false);
    assert.equal(fs.existsSync(other.scratchDir), true);
    assert.equal(hash(result), digest);
    assert.deepEqual(await cleanupCompactAtTaskBoundary(root), []);
    seedQueue(root, { 'T-1': 'DONE', 'T-10': '🟩 DONE' });
    assert.deepEqual(await cleanupCompactAtTaskBoundary(root), []);
    assert.equal(fs.existsSync(other.scratchDir), true);
    assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-10'])), []);
    assert.equal(fs.existsSync(other.scratchDir), false);
});

test('an unfinished producer and a finalizing or blocked task keep their scratch', async t => {
    const root = fixture(t);
    taskContext(t, root, 'T-RUNNING');
    const active = beginValidationOutputRun(root, 'coverage');
    const failed = beginValidationOutputRun(root, 'coverage');
    fs.writeFileSync(path.join(active.scratchDir, 'raw.json'), 'active');
    failed.finish(1);
    seedQueue(root, { 'T-RUNNING': 'DONE' });
    const lock = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-RUNNING-completion-gate.lock');
    fs.mkdirSync(lock, { recursive: true });
    assert.deepEqual(await cleanupCompactAtTaskBoundary(root), []);
    assert.equal(fs.existsSync(failed.scratchDir), true);
    fs.rmSync(lock, { recursive: true });
    seedQueue(root, { 'T-RUNNING': 'BLOCKED' });
    await cleanupCompactAtTaskBoundary(root);
    assert.equal(fs.existsSync(failed.scratchDir), true);
    await cleanupCompactAtTaskBoundary(root, 'T-RUNNING');
    assert.equal(fs.existsSync(failed.scratchDir), true);
    cleanupTaskValidationOutput(root, new Set(['T-RUNNING']));
    assert.equal(fs.existsSync(failed.scratchDir), false);
    assert.equal(fs.existsSync(active.scratchDir), true);
});

test('an active child prevents cleanup after finish; a later sweep cleans only after it exits', async t => {
    const root = fixture(t);
    taskContext(t, root, 'T-ACTIVE');
    const run = beginValidationOutputRun(root, 'coverage');
    const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore', windowsHide: true
    });
    t.after(() => { child.kill(); });
    const closed = once(child, 'close');
    run.trackChild(child.pid);
    run.finish(1);
    assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-ACTIVE'])), []);
    assert.equal(fs.existsSync(run.scratchDir), true);
    assert.equal(readManifest(root, run.runId).cleanup_authorized, true);
    child.kill();
    await closed;
    assert.deepEqual(await cleanupCompactAtTaskBoundary(root), []);
    assert.equal(fs.existsSync(run.scratchDir), false);
});

test('transient parent DONE without a completion lock never authorizes deletion before successful finalization', async t => {
    const root = fixture(t);
    taskContext(t, root, 'T-PARENT');
    const run = beginValidationOutputRun(root, 'coverage');
    run.finish(1);
    seedQueue(root, { 'T-PARENT': 'DONE', 'T-CHILD': 'IN_REVIEW' });
    await cleanupCompactAtTaskBoundary(root);
    assert.equal(fs.existsSync(run.scratchDir), true, 'next-step can roll back parent DONE without a completion lock');
    const lock = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-CHILD-completion-gate.lock');
    fs.mkdirSync(lock, { recursive: true });
    await cleanupCompactAtTaskBoundary(root);
    assert.equal(fs.existsSync(run.scratchDir), true);
    seedQueue(root, { 'T-PARENT': 'DECOMPOSED', 'T-CHILD': 'IN_REVIEW' });
    fs.rmdirSync(lock);
    await cleanupCompactAtTaskBoundary(root);
    assert.equal(fs.existsSync(run.scratchDir), true);
    seedQueue(root, { 'T-PARENT': 'DONE', 'T-CHILD': 'DONE' });
    await cleanupCompactAtTaskBoundary(root);
    assert.equal(fs.existsSync(run.scratchDir), true);
    cleanupTaskValidationOutput(root, new Set(['T-PARENT', 'T-CHILD']));
    assert.equal(fs.existsSync(run.scratchDir), false);
});

test('concurrent run directories never share scratch or discard failure evidence on another run success', t => {
    const root = fixture(t);
    taskContext(t, root, 'T-CONCURRENT');
    const failed = beginValidationOutputRun(root, 'coverage');
    const successful = beginValidationOutputRun(root, 'coverage');
    assert.notEqual(failed.scratchDir, successful.scratchDir);
    fs.writeFileSync(path.join(failed.scratchDir, 'raw.json'), 'failed');
    failed.finish(1);
    successful.finish(0);
    assert.equal(fs.existsSync(successful.scratchDir), false);
    assert.equal(fs.readFileSync(path.join(failed.scratchDir, 'raw.json'), 'utf8'), 'failed');
});

test('POSIX descendants keep their producer group active after its leader exits', {
    skip: process.platform === 'win32'
}, async t => {
    const root = fixture(t);
    taskContext(t, root, 'T-GROUP');
    const run = beginValidationOutputRun(root, 'coverage');
    const child = childProcess.spawn(process.execPath, ['-e',
        'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});'
        + 'c.unref();'
    ], { detached: true, stdio: 'ignore' });
    const pid = child.pid!;
    t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already gone. */ } });
    run.trackChild(pid);
    await once(child, 'close');
    run.finish(1);
    assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-GROUP'])), []);
    assert.equal(fs.existsSync(run.scratchDir), true, 'a live descendant must keep raw output available');
});

test('unattributed legacy directories and standalone failures are never inferred to belong to a closed task', t => {
    const root = fixture(t);
    const legacy = path.join(root, 'coverage/tmp');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'coverage-1.json'), 'legacy');
    const standalone = beginValidationOutputRun(root, 'node-tests');
    standalone.finish(1);
    assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-ANY'])), []);
    assert.equal(fs.existsSync(standalone.scratchDir), true);
    assert.equal(fs.readFileSync(path.join(legacy, 'coverage-1.json'), 'utf8'), 'legacy');
});

test('context from another checkout or an invalid task ID cannot bind a run', t => {
    const root = fixture(t);
    assert.equal(readValidationTaskId(root, {
        [VALIDATION_REPO_ROOT_ENV]: path.join(root, 'other'), [VALIDATION_TASK_ID_ENV]: 'T-VALID'
    }), null);
    for (const id of ['../T-VALID', 'T-VALID/../../other', '']) {
        assert.equal(readValidationTaskId(root, {
            [VALIDATION_REPO_ROOT_ENV]: root, [VALIDATION_TASK_ID_ENV]: id
        }), null);
    }
    assert.equal(readValidationTaskId(root, {
        [VALIDATION_REPO_ROOT_ENV]: root, [VALIDATION_TASK_ID_ENV]: 'T-VALID'
    }), 'T-VALID');
    if (process.platform === 'win32') assert.equal(readValidationTaskId(root, {
        [VALIDATION_REPO_ROOT_ENV]: root.toLowerCase(), [VALIDATION_TASK_ID_ENV]: 'T-VALID'
    }), 'T-VALID');
});

test('report tampering blocks scratch deletion without rewriting the recorded report digest', t => {
    const root = fixture(t);
    taskContext(t, root, 'T-REPORT');
    const run = beginValidationOutputRun(root, 'coverage');
    run.finish(1);
    const manifestBefore = fs.readFileSync(path.join(validationOutputRoot(root), run.runId, 'manifest.json'), 'utf8');
    fs.appendFileSync(path.join(run.reportsDir, 'result.json'), 'tampered');
    assert.match(cleanupTaskValidationOutput(root, new Set(['T-REPORT'])).join('\n'), /reports changed/);
    assert.equal(fs.existsSync(run.scratchDir), true);
    assert.equal(fs.readFileSync(path.join(validationOutputRoot(root), run.runId, 'manifest.json'), 'utf8'), manifestBefore);
});

test('foreign manifests and damaged ownership records are retained without following arbitrary deletion paths', t => {
    const root = fixture(t);
    taskContext(t, root, 'T-FOREIGN');
    const run = beginValidationOutputRun(root, 'coverage');
    run.finish(1);
    changeManifest(root, run.runId, { host: 'foreign-host' });
    assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-FOREIGN'])), []);
    assert.equal(fs.existsSync(run.scratchDir), true);
    changeManifest(root, run.runId, { host: os.hostname(), run_id: 'forged' });
    assert.match(cleanupTaskValidationOutput(root, new Set(['T-FOREIGN'])).join('\n'), /ownership manifest/);
    assert.equal(fs.existsSync(run.scratchDir), true);
    // A manifest naming another path of the repository (another mount) belongs to that path: kept, no warning.
    changeManifest(root, run.runId, { run_id: run.runId, repo_root: path.dirname(root), scratch_dir: path.dirname(root) });
    assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-FOREIGN'])), []);
    assert.deepEqual(cleanupAuthorizedValidationOutput(root), []);
    assert.equal(fs.existsSync(run.scratchDir), true);
});

test('symlink or junction scratch and storage ancestors cannot cause deletion outside the owned run', t => {
    const root = fixture(t);
    taskContext(t, root, 'T-LINK');
    const run = beginValidationOutputRun(root, 'coverage');
    run.finish(1);
    const foreign = path.join(root, 'foreign-data');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep.json'), 'keep');
    fs.rmdirSync(run.scratchDir);
    fs.symlinkSync(foreign, run.scratchDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.match(cleanupTaskValidationOutput(root, new Set(['T-LINK'])).join('\n'), /symbolic link/);
    assert.equal(fs.readFileSync(path.join(foreign, 'keep.json'), 'utf8'), 'keep');
    fs.unlinkSync(run.scratchDir);
    const rootStorage = validationOutputRoot(root);
    removeFixtureTree(rootStorage);
    fs.symlinkSync(foreign, rootStorage, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => beginValidationOutputRun(root, 'coverage'), /symbolic link/);
    assert.match(cleanupTaskValidationOutput(root, new Set(['T-LINK'])).join('\n'), /symbolic link/);
    assert.equal(fs.readFileSync(path.join(foreign, 'keep.json'), 'utf8'), 'keep');
});

test('coverage uses the same canonical test scope and preserves quoted argument boundaries without a nested build lock', t => {
    const root = fixture(t);
    const scripts = {
        test: 'node scripts/node-foundation/build-scripts.cjs test.js "tests/space path" --test-name-pattern="a b"',
        'test:fast': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/core'
    };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
    const argv = resolveCoverageTestArgs(root, 'test', ['--test-timeout=1200']);
    assert.deepEqual(argv.slice(2), ['tests/space path', '--test-name-pattern=a b', '--test-timeout=1200']);
    assert.equal(path.basename(argv[1]), 'test.js');
    assert.deepEqual(resolveCoverageTestArgs(root, 'test:fast', []).slice(2), ['tests/node/core']);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: `${scripts.test} && node other.js` } }));
    assert.throws(() => resolveCoverageTestArgs(root, 'test', []), /canonical guarded/);
});

for (const outcome of ['pass', 'child-failure', 'threshold-failure'] as const) {
    test(`real c8 ${outcome}: preserves reports and exit status, and cleanup respects report completion`, async t => {
        const root = fixture(t);
        taskContext(t, root, 'T-C8');
        fs.writeFileSync(path.join(root, 'program.js'), 'function answer() { return 42; }\nconsole.log(answer());\n'
            + (outcome === 'child-failure' ? 'process.exitCode = 7;\n' : ''));
        if (outcome === 'threshold-failure') fs.writeFileSync(path.join(root, 'uncovered.js'), 'function unused() { return 0; }\nunused();\n');
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
            c8: { all: true, include: ['program.js', 'uncovered.js'], reporter: ['lcov'],
                'check-coverage': true, statements: 100, branches: 100, functions: 100, lines: 100 }
        }));
        const code = await runCoverageProcess(root, [process.execPath, 'program.js'], { inheritStdio: false });
        assert.equal(code, outcome === 'pass' ? 0 : outcome === 'child-failure' ? 7 : 1);
        const runs = fs.readdirSync(validationOutputRoot(root));
        assert.equal(runs.length, 1);
        const runDir = path.join(validationOutputRoot(root), runs[0]);
        const report = path.join(runDir, 'reports/lcov.info');
        const published = path.join(root, 'coverage/lcov.info');
        assert.ok(fs.readFileSync(report, 'utf8').includes('SF:program.js'));
        const digest = hash(report);
        assert.equal(hash(published), digest);
        const scratch = path.join(runDir, 'scratch');
        if (outcome === 'pass') assert.equal(fs.existsSync(scratch), false);
        else {
            assert.ok(fs.readdirSync(scratch).some(file => file.endsWith('.json')));
            assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-C8'])), []);
            assert.equal(fs.existsSync(scratch), false);
            assert.equal(hash(report), digest);
            assert.equal(hash(published), digest);
        }
    });
}

for (const interruption of ['timeout', 'cancel'] as const) {
    test(`real c8 ${interruption}: retains interrupted scratch until task close`, async t => {
        const root = fixture(t);
        taskContext(t, root, 'T-INTERRUPTED');
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ c8: { reporter: ['lcov'] } }));
        fs.writeFileSync(path.join(root, 'program.js'), 'setInterval(()=>{},1000);');
        const controller = new AbortController();
        const timer = interruption === 'cancel' ? setTimeout(() => controller.abort(), 400) : null;
        t.after(() => { if (timer) clearTimeout(timer); });
        const code = await runCoverageProcess(root, [process.execPath, 'program.js'], {
            inheritStdio: false, timeoutMs: interruption === 'timeout' ? 400 : 0, signal: controller.signal
        });
        assert.notEqual(code, 0);
        const runs = fs.readdirSync(validationOutputRoot(root));
        const scratch = path.join(validationOutputRoot(root), runs[0], 'scratch');
        assert.equal(fs.existsSync(scratch), true);
        assert.deepEqual(cleanupTaskValidationOutput(root, new Set(['T-INTERRUPTED'])), []);
        assert.equal(fs.existsSync(scratch), false);
    });
}

test('cleaned runs are removed whole after seven days; tampered reports are kept with a note', t => {
    const root = fixture(t);
    const fresh = beginValidationOutputRun(root, 'node-tests');
    fresh.finish(0);
    const expired = beginValidationOutputRun(root, 'node-tests');
    expired.finish(0);
    const legacy = beginValidationOutputRun(root, 'node-tests');
    legacy.finish(0);
    const tampered = beginValidationOutputRun(root, 'node-tests');
    tampered.finish(0);
    ageRun(root, fresh.runId, 6 * DAY_MS, 6 * DAY_MS);
    ageRun(root, expired.runId, 8 * DAY_MS, 8 * DAY_MS);
    changeManifest(root, legacy.runId, { finished_at_utc: undefined });
    ageRun(root, legacy.runId, 8 * DAY_MS);
    fs.appendFileSync(path.join(tampered.reportsDir, 'result.json'), 'tampered');
    ageRun(root, tampered.runId, 8 * DAY_MS, 8 * DAY_MS);
    const runDir = (run: { runId: string }): string => path.join(validationOutputRoot(root), run.runId);

    const notes = cleanupAuthorizedValidationOutput(root);
    assert.equal(fs.existsSync(runDir(fresh)), true);
    assert.equal(readManifest(root, fresh.runId).state, 'CLEANED');
    assert.equal(fs.existsSync(runDir(expired)), false);
    assert.equal(fs.existsSync(runDir(legacy)), false, 'without a recorded finalization time the folder age counts');
    assert.equal(fs.existsSync(path.join(tampered.reportsDir, 'result.json')), true);
    assert.equal(notes.length, 1);
    assert.match(notes[0], new RegExp(`${tampered.runId}: Validation reports changed after finalization`, 'u'));
});

test('failed runs outside task mode are released after seven days; task-bound failures wait for their task', t => {
    const root = fixture(t);
    const recent = beginValidationOutputRun(root, 'node-tests');
    fs.writeFileSync(path.join(recent.scratchDir, 'shard.log'), 'recent');
    recent.finish(1);
    const old = beginValidationOutputRun(root, 'node-tests');
    fs.writeFileSync(path.join(old.scratchDir, 'shard.log'), 'old');
    old.finish(1);
    const oldLegacy = beginValidationOutputRun(root, 'node-tests');
    oldLegacy.finish(1);
    taskContext(t, root, 'T-STILL-ACTIVE');
    const taskBound = beginValidationOutputRun(root, 'node-tests');
    taskBound.finish(1);
    ageRun(root, recent.runId, 6 * DAY_MS, 6 * DAY_MS);
    ageRun(root, old.runId, 8 * DAY_MS, 8 * DAY_MS);
    changeManifest(root, oldLegacy.runId, { finished_at_utc: undefined });
    ageRun(root, oldLegacy.runId, 8 * DAY_MS);
    ageRun(root, taskBound.runId, 30 * DAY_MS, 30 * DAY_MS);

    assert.deepEqual(cleanupAuthorizedValidationOutput(root), []);
    assert.equal(fs.existsSync(recent.scratchDir), true);
    assert.equal(readManifest(root, recent.runId).state, 'FINISHED');
    assert.equal(fs.existsSync(path.join(validationOutputRoot(root), old.runId)), false,
        'released and past the cleaned-run retention: removed in the same pass');
    assert.equal(fs.existsSync(oldLegacy.scratchDir), false);
    assert.equal(readManifest(root, oldLegacy.runId).state, 'CLEANED');
    assert.equal(readManifest(root, oldLegacy.runId).cleanup_authorized, true);
    assert.equal(fs.existsSync(taskBound.scratchDir), true);
    assert.equal(readManifest(root, taskBound.runId).cleanup_authorized, false);
});

test('a run left RUNNING by a dead producer is finalized after a day; a live pid is never touched', async t => {
    const root = fixture(t);
    const abandoned = beginValidationOutputRun(root, 'node-tests');
    fs.writeFileSync(path.join(abandoned.reportsDir, 'partial.txt'), 'partial report');
    fs.writeFileSync(path.join(abandoned.scratchDir, 'shard.log'), 'interrupted');
    const recent = beginValidationOutputRun(root, 'node-tests');
    const live = beginValidationOutputRun(root, 'node-tests');
    const liveChild = beginValidationOutputRun(root, 'node-tests');
    const dead = await deadPid();
    changeManifest(root, abandoned.runId, { owner_pid: dead });
    changeManifest(root, recent.runId, { owner_pid: dead });
    changeManifest(root, liveChild.runId, { owner_pid: dead, child_pids: [process.pid] });
    ageRun(root, abandoned.runId, 2 * DAY_MS);
    ageRun(root, recent.runId, DAY_MS / 2);
    ageRun(root, live.runId, 30 * DAY_MS);
    ageRun(root, liveChild.runId, 30 * DAY_MS);
    const partial = hash(path.join(abandoned.reportsDir, 'partial.txt'));

    assert.deepEqual(cleanupAuthorizedValidationOutput(root), []);
    const finalized = readManifest(root, abandoned.runId);
    assert.equal(finalized.state, 'FINISHED');
    assert.equal(finalized.abandoned, true);
    assert.equal(finalized.exit_code, 1);
    assert.equal(hash(path.join(abandoned.reportsDir, 'partial.txt')), partial);
    assert.equal(fs.existsSync(abandoned.scratchDir), true, 'abandoned output is released by the failed-run retention');
    for (const run of [recent, live, liveChild]) {
        assert.equal(readManifest(root, run.runId).state, 'RUNNING');
        assert.equal(fs.existsSync(run.scratchDir), true);
    }
    // Its last activity was two days ago; after seven, the failed-run retention releases it.
    ageRun(root, abandoned.runId, 8 * DAY_MS, 8 * DAY_MS);
    assert.deepEqual(cleanupAuthorizedValidationOutput(root), []);
    assert.equal(fs.existsSync(path.join(validationOutputRoot(root), abandoned.runId)), false);
});
