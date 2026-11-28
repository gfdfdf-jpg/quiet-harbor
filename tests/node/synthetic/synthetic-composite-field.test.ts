import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import { buildEventIntegrityHash, inspectTaskEventFile, readTaskTimelineJsonlEntries } from '../../../src/gate-runtime/task-events';
import * as taskEventIo from '../../../src/gate-runtime/timeline/task-events-io';
import * as timelineSnapshot from '../../../src/gate-runtime/timeline/task-timeline-read-snapshot';
import { readProtectedCoherentScope } from '../../../src/core/auth/protected-coherent-scope';
import { withNextStepMeasurement } from '../../../src/core/next-step-measurement';
import { readRecordedOutOfScopeFailures } from '../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { resolveNextStep } from '../../../src/gates/next-step';
import { buildTaskTestSelectionCommand, buildTaskTestSelectionPrefill } from '../../../src/gates/next-step/next-step-full-suite-routing';
import { selectNextStepRecommendedAction } from '../../../src/gates/next-step/next-step-recommended-action';
import { readNextStepCommandExecution } from '../../../src/gates/next-step/next-step-command-execution';
import { evaluateProtectedControlPlaneManifest } from '../../../src/gates/protected-control-plane/protected-control-plane';
import {
    cli, createCompositeFixture, PROVIDER_ARGS, runPrintedCommand, TASK_ID, TASK_TITLE, timelineEvents, writeTaskEdit
} from '../cli/commands/task-composite-test-fixture';
import { runGit } from '../cli/commands/gate-test-helpers';
import { cliArgs, fillAnswers, run, statedCommands, walkOrdinaryTask } from './engine/default-text-consumer';

const bundle = DEFAULT_BUNDLE_NAME;
const runtime = bundle + '/runtime';
const timeline = (root: string) => path.join(root, runtime, 'task-events', TASK_ID + '.jsonl');
const events = (root: string) => readTaskTimelineJsonlEntries(timeline(root)).map(entry =>
    entry.record as { event_type: string; details?: Record<string, unknown> });
const fixture = createCompositeFixture();
after(async () => (await fixture).dispose());
const clone = async () => (await fixture).clone();

const walkOrdinary = async (root: string, rendered: boolean, docs: boolean): Promise<string> => (await walkOrdinaryTask(root, rendered, docs)).outcome;

test('field: a fresh linked worktree points to the checkout holding the workspace without offering setup', async () => {
    const root = await clone();
    const linked = path.join(root, 'linked workspace');
    assert.equal(runGit(root, ['worktree', 'add', '--detach', linked, 'HEAD']).status, 0);
    try {
        for (const args of [['next-step', TASK_ID], ['task', TASK_ID, 'start', ...PROVIDER_ARGS]]) {
            const result = await cli(linked, args);
            assert.notEqual(result.exitCode, 0, result.text);
            assert.match(result.text, /linked Git worktree has no Garda workspace/u);
            assert.match(result.text, /checkout that holds the Garda workspace: cd /u);
            assert.doesNotMatch(result.text, /\bsetup\b/u);
        }
        assert.equal(fs.existsSync(path.join(linked, 'TASK.md')), false);
        assert.deepEqual(timelineEvents(root), []);
    } finally {
        assert.equal(runGit(root, ['worktree', 'remove', linked]).status, 0);
    }
});

test('field: default dirty-start action names the planned scope and preserves operator files', async () => {
    const root = await clone();
    fs.writeFileSync(path.join(root, 'README.md'), 'Operator work\n');
    const summary = 'Keep $& and $1 literally';
    const refusedTime = '2026-11-22T10:00:00Z';
    const refused = await run(root, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, '--task-summary', summary,
        '--operator-confirmed', 'no', '--operator-confirmed-at-utc', refusedTime]);
    const retry = cliArgs(statedCommands(refused)[0]);
    assert.equal(retry[retry.indexOf('--task-summary') + 1], summary);
    assert.equal(retry[retry.indexOf('--operator-confirmed') + 1], 'no');
    assert.equal(retry[retry.indexOf('--operator-confirmed-at-utc') + 1], refusedTime);
    const stopped = await run(root, ['task', TASK_ID, 'start', ...PROVIDER_ARGS]);
    assert.match(stopped, /StopReason: .*README\.md/u);
    assert.deepEqual(timelineEvents(root), []);
    const [command] = statedCommands(stopped);
    assert.match(command, /--planned-changed-file "<task-owned-file>"/u);
    await run(root, cliArgs(command.replace('<task-owned-file>', 'src/app.ts')));
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'Operator work\n');
    assert.equal(events(root).filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 1);
});

test('field: entry routes protected drift to approval before any startup evidence', async () => {
    const root = await clone();
    const packagePath = path.join(root, 'package.json');
    fs.writeFileSync(packagePath, JSON.stringify({ name: 'garda-agent-orchestrator' }));
    assert.equal(runGit(root, ['add', 'package.json']).status, 0);
    assert.equal(runGit(root, ['commit', '-qm', 'Use source checkout entry policy']).status, 0);
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nOperator changed protected rules.\n');
    const output = await run(root, ['next-step', TASK_ID]);
    assert.match(output, /The entry gate verifies the protected workspace/u);
    assert.deepEqual(timelineEvents(root), []);
    const refused = await cli(root, ['gate', 'enter-task-mode', '--task-id', TASK_ID, '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
        '--task-summary', TASK_TITLE, ...PROVIDER_ARGS]);
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.text, /Protected control-plane manifest drift.*Ask the operator/u);
    assert.equal(events(root).some(event => event.event_type === 'TASK_MODE_ENTERED'), false);
    assert.deepEqual(timelineEvents(root), ['TASK_MODE_ENTRY_FAILED:FAIL']);
    const route = resolveNextStep({ repoRoot: root, taskId: TASK_ID });
    assert.equal(readNextStepCommandExecution(route.commands[0])?.boundary, 'operator');
    const [command] = statedCommands(await run(root, ['next-step', TASK_ID]));
    assert.match(command, /gate enter-task-mode .*--orchestrator-work --operator-confirmed yes/u);
    const approved = await run(root, cliArgs(command.replace('<ISO-8601 timestamp>', new Date().toISOString())));
    assert.match(approved, /TASK_MODE_ENTERED/u);
    assert.match(await run(root, ['next-step', TASK_ID]), /NextGate: load-rule-pack/u);
});

test('field: declining protected drift and restoring the files returns to ordinary entry', async () => {
    const root = await clone();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    assert.equal(runGit(root, ['add', 'package.json']).status, 0);
    assert.equal(runGit(root, ['commit', '-qm', 'Use source checkout entry policy']).status, 0);
    const protectedFile = path.join(root, 'AGENTS.md');
    const originalRules = fs.readFileSync(protectedFile);
    fs.appendFileSync(protectedFile, 'Operator changed protected rules.');
    const refused = await cli(root, ['gate', 'enter-task-mode', '--task-id', TASK_ID, '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
        '--task-summary', TASK_TITLE, ...PROVIDER_ARGS]);
    assert.notEqual(refused.exitCode, 0, refused.text);
    assert.match(refused.text, /Protected control-plane manifest drift.*Ask the operator/u);
    const blocked = await run(root, ['next-step', TASK_ID]);
    const [approval, afterRestore] = statedCommands(blocked);
    assert.match(approval, /gate enter-task-mode .*--orchestrator-work --operator-confirmed yes/u);
    assert.match(blocked, /If the operator declines, restore the drifted files/u);
    assert.match(afterRestore, /gate enter-task-mode/u);
    assert.doesNotMatch(afterRestore, /--orchestrator-work|--operator-confirmed/u);

    fs.writeFileSync(protectedFile, originalRules);
    const restored = await run(root, ['next-step', TASK_ID]);
    assert.match(restored, /The protected tree matches the trusted baseline again/u);
    const commands = statedCommands(restored);
    assert.deepEqual(commands, [afterRestore]);
    assert.deepEqual(timelineEvents(root), ['TASK_MODE_ENTRY_FAILED:FAIL']);
    assert.match(await run(root, cliArgs(commands[0])), /TASK_MODE_ENTERED/u);
    assert.match(await run(root, ['next-step', TASK_ID]), /NextGate: load-rule-pack/u);
});

test('field: ordinary default-text walks reach the same end state and events as JSON', async () => {
    for (const docs of [true, false]) {
        const json = await clone(), text = await clone();
        const expected = docs ? 'DONE' : 'reviewer-boundary';
        assert.equal(await walkOrdinary(json, false, docs), expected);
        assert.equal(await walkOrdinary(text, true, docs), expected);
        assert.deepEqual(timelineEvents(text), timelineEvents(json));
    }
});

test('field: entry verifies ignored protected bytes and navigation validates the manifest envelope', async t => {
    for (const change of ['same-size', 'added', 'deleted', 'unreadable', 'missing-digest', 'invalid-roots'] as const) {
        const root = await clone();
        const baseline = evaluateProtectedControlPlaneManifest(root, null, true);
        assert.equal(baseline.status, 'MATCH');
        const file = 'garda-agent-orchestrator/live/docs/agent-rules/30-code-style.md';
        assert.equal(runGit(root, ['check-ignore', file]).status, 0);
        const absolute = path.join(root, file);
        const unreadable = path.join(path.dirname(absolute), 'read-denied');
        if (change === 'same-size') {
            const fixedTime = new Date('2026-01-01T00:00:00Z');
            fs.utimesSync(absolute, fixedTime, fixedTime);
            assert.equal(evaluateProtectedControlPlaneManifest(root).status, 'MATCH');
            const bytes = fs.readFileSync(absolute);
            bytes[0] ^= 1;
            fs.writeFileSync(absolute, bytes);
            fs.utimesSync(absolute, fixedTime, fixedTime);
        } else if (change === 'added') fs.writeFileSync(path.join(path.dirname(absolute), 'protected-addition.md'), 'addition');
        else if (change === 'deleted') fs.unlinkSync(absolute);
        else if (change === 'unreadable') fs.mkdirSync(unreadable);
        else {
            const manifest = { ...baseline.manifest } as Record<string, unknown>;
            if (change === 'missing-digest') delete manifest.protected_snapshot_sha256;
            else manifest.protected_roots = 'invalid';
            fs.writeFileSync(path.resolve(root, baseline.manifest_path), JSON.stringify(manifest));
        }
        const invalid = change === 'missing-digest' || change === 'invalid-roots';
        let work: Record<string, number> | undefined;
        const route = withNextStepMeasurement(() => resolveNextStep({ repoRoot: root, taskId: TASK_ID }), result => { work = result.work; });
        assert.equal(work?.['file_probes:readdirSync'] ?? 0, 0, change);
        assert.equal(route.next_gate, invalid ? 'operator-maintenance' : 'enter-task-mode', route.reason);
        if (invalid) assert.match(route.commands[0].command, / doctor /u);
        const read = fs.readdirSync;
        const denied = change === 'unreadable' ? t.mock.method(require('node:fs') as typeof fs, 'readdirSync', (...args: unknown[]) => {
            if (String(args[0]) === unreadable) throw Object.assign(new Error('Fixture denied protected directory traversal'), { code: 'EACCES' });
            return Reflect.apply(read, fs, args);
        }) : null;
        let retryEntry: string | undefined;
        try {
            const refused = await cli(root, ['gate', 'enter-task-mode', '--task-id', TASK_ID, '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
                '--task-summary', TASK_TITLE, ...PROVIDER_ARGS]);
            assert.notEqual(refused.exitCode, 0, refused.text);
            assert.match(refused.text, denied ? /protected tree/iu : invalid ? /manifest is invalid/iu : /self-guard/iu);
            assert.deepEqual(timelineEvents(root), ['TASK_MODE_ENTRY_FAILED:FAIL'], refused.text);
            if (denied) {
                const details = events(root)[0].details;
                const failedPath = path.posix.join(path.posix.dirname(file), 'read-denied');
                assert.equal(details?.observed_protected_snapshot_sha256, null);
                assert.deepEqual(details?.traversal_error, { path: failedPath, code: 'EACCES' });
                assert.deepEqual(details?.affected_protected_paths, [failedPath]);
                const blocked = await run(root, ['next-step', TASK_ID]);
                assert.match(blocked, /protected tree.*readable/iu);
                assert.ok(blocked.includes(`${failedPath} (EACCES)`), blocked);
                assert.ok(blocked.includes('repair inspect --target-root "."'), blocked);
                [retryEntry] = statedCommands(blocked);
                assert.match(retryEntry, /gate enter-task-mode/u);
                assert.doesNotMatch(blocked, /recover-task-mode-protected-manifest/u);
                const retryRoute = resolveNextStep({ repoRoot: root, taskId: TASK_ID });
                assert.equal(readNextStepCommandExecution(retryRoute.commands[0])?.boundary, 'operator');
                const originalTimeline = fs.readFileSync(timeline(root));
                const reviews = path.join(root, runtime, 'reviews');
                const originalArtifacts = fs.readdirSync(reviews).sort();
                for (let repeat = 0; repeat < 2; repeat++) {
                    const stopped = JSON.parse(await run(root, ['task', TASK_ID, 'advance', '--as-json']));
                    assert.equal(stopped.stop.kind, 'operator');
                    assert.equal(stopped.counters.subgates_attempted, 0);
                }
                assert.deepEqual(fs.readFileSync(timeline(root)), originalTimeline);
                assert.deepEqual(fs.readdirSync(reviews).sort(), originalArtifacts);
                assert.notEqual((await cli(root, cliArgs(retryEntry))).exitCode, 0);
            }
        } finally { denied?.mock.restore(); }
        if (retryEntry) {
            await run(root, cliArgs(retryEntry));
            assert.equal(events(root).filter(event => event.event_type === 'TASK_MODE_ENTERED').length, 1);
            assert.match(await run(root, ['next-step', TASK_ID]), /NextGate: load-rule-pack/u);
        }
    }
});

test('field: scope-only re-entry rebinds current startup evidence and types a stale diagnostic route', async () => {
    for (const probeCleanupFails of [false, true]) {
        const root = await clone();
        await run(root, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, '--planned-changed-file', 'src/app.ts']);
        await runPrintedCommand(root, 'load-rule-pack');
        await runPrintedCommand(root, 'handshake-diagnostics');
        await runPrintedCommand(root, 'shell-smoke-preflight');
        const entered = await run(root, ['gate', 'enter-task-mode', '--task-id', TASK_ID, '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
            '--task-summary', TASK_TITLE, ...PROVIDER_ARGS, '--upgrade-existing-task-mode', '--planned-changed-file', 'src/app.ts',
            '--planned-changed-file', 'src/another.ts']);
        const startupEvents = events(root).filter(event => ['RULE_PACK_LOADED', 'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED'].includes(event.event_type));
        assert.deepEqual(startupEvents.filter(event => event.details?.reused_from_event_sha256).map(event => event.event_type),
            ['RULE_PACK_LOADED'], entered);
        assert.equal(startupEvents.filter(event => !event.details?.reused_from_event_sha256).length, 3);
        assert.equal(inspectTaskEventFile(timeline(root), TASK_ID).status, 'PASS');
        const route = resolveNextStep({ repoRoot: root, taskId: TASK_ID });
        assert.equal(route.next_gate, 'handshake-diagnostics', route.reason);
        assert.match(selectNextStepRecommendedAction(route)?.command ?? '', /task .* advance/u);
        await runPrintedCommand(root, 'handshake-diagnostics');
        if (probeCleanupFails) {
            const unlink = fs.unlinkSync;
            const filesystem = require('node:fs') as typeof fs;
            filesystem.unlinkSync = (file) => {
                if (String(file).includes('shell-smoke') && String(file).endsWith('.tmp')) {
                    throw Object.assign(new Error('Probe directory denies deletion'), { code: 'EACCES' });
                }
                return unlink(file);
            };
            try {
                const refused = await cli(root, ['gate', 'shell-smoke-preflight', '--task-id', TASK_ID, '--provider', 'Codex']);
                assert.notEqual(refused.exitCode, 0, refused.text);
                assert.match(refused.text, /Probe directory denies deletion/u);
            } finally { filesystem.unlinkSync = unlink; }
        } else {
            await runPrintedCommand(root, 'shell-smoke-preflight');
        }
    }
});

const own = 'tests/app.test.cjs';
const outside = 'tests/unrelated.test.cjs';
const helper = 'scripts/node-foundation/e2e/friction-meter.ts';
const testRunner = 'scripts/report-tests.cjs';
const broad = `node ${testRunner} ${own} ${outside}`;
const narrow = `node ${testRunner} ${own}`;
const preflight = runtime + '/reviews/' + TASK_ID + '-preflight.json';
const selectionReason = `${TASK_ID} verifies ${own} against the behavior exported by src/app.ts`;

async function reachOutsideFailure(root: string): Promise<string> {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, helper)), { recursive: true });
    fs.writeFileSync(path.join(root, own), "require('node:test')('status regression', () => {});\n");
    fs.writeFileSync(path.join(root, outside), "require('node:test')('reports navigator mode failure', () => { throw new Error('fixture regression'); });\n");
    fs.writeFileSync(path.join(root, helper), 'export const fixture = true;\n');
    fs.writeFileSync(path.join(root, testRunner), [
        'const env = { ...process.env };',
        'delete env.NODE_TEST_CONTEXT;',
        "const run = require('node:child_process').spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...process.argv.slice(2)], { env, stdio: 'inherit' });",
        'process.exitCode = run.status ?? 1;'
    ].join('\n'));
    await run(root, ['workflow', 'set', '--target-root', '.', '--full-suite-command', broad,
        '--full-suite-enabled', 'true', '--full-suite-placement', 'after_compile_before_reviews',
        '--full-suite-out-of-scope-failure-policy', 'AUDIT_AND_BLOCK',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
    assert.equal(runGit(root, ['add', 'tests', helper, testRunner]).status, 0);
    assert.equal(runGit(root, ['commit', '-qm', 'Seed task and unrelated test']).status, 0);
    await run(root, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, '--planned-changed-file', 'src/app.ts', '--planned-changed-file', own]);
    await runPrintedCommand(root, 'load-rule-pack');
    writeTaskEdit(root);
    fs.appendFileSync(path.join(root, own), '// Current fixture regression.\n');
    await run(root, ['task', TASK_ID, 'advance']);
    await runPrintedCommand(root, 'load-rule-pack');
    fillAnswers(root, runtime + '/tmp/' + TASK_ID + '-quality-checklist-answers.json');
    await run(root, ['task', TASK_ID, 'advance']);
    await run(root, ['workflow', 'set', '--target-root', '.', '--task-id', TASK_ID, '--task-test-command', broad,
        '--focused-required-test-path', own, '--reason', selectionReason]);
    const beforeValidation = await run(root, ['task', TASK_ID, 'advance']);
    const validate = statedCommands(beforeValidation).find(value => value.includes('gate task-test-validation '));
    assert.ok(validate, beforeValidation);
    const failed = await cli(root, cliArgs(validate));
    assert.notEqual(failed.exitCode, 0, failed.text);
    assert.match(failed.text, /FULL_SUITE_VALIDATION_FAILED|TASK_TEST_VALIDATION_FAILED/u);
    return await run(root, ['next-step', TASK_ID]);
}

test('field: one fresh approval expands the exact planned files and restarts a failed validation cycle', async t => {
    const root = await clone();
    const stopped = await reachOutsideFailure(root);
    const commands = statedCommands(stopped);
    const command = commands.find(value => value.includes('gate restart-coherent-cycle'));
    assert.ok(command, stopped);
    assert.match(command, /--planned-changed-file.*--operator-confirmed yes.*--operator-confirmed-at-utc/u);
    const time = new Date().toISOString();
    const args = cliArgs(command.replace('<operator-approved repair source path>', helper)
        .replace('<operator-stated task intent>', TASK_TITLE).replace('<ISO-8601 timestamp>', time));
    const unapproved = args.filter((_arg, index) => !['--operator-confirmed', '--operator-confirmed-at-utc'].includes(args[index - 1])
        && !['--operator-confirmed', '--operator-confirmed-at-utc'].includes(args[index]));
    const before = timelineEvents(root);
    assert.notEqual((await cli(root, unapproved)).exitCode, 0);
    assert.deepEqual(timelineEvents(root), before);
    const overbroad = await cli(root, [...args, '--changed-file', 'src/unapproved.ts']);
    assert.notEqual(overbroad.exitCode, 0, overbroad.text);
    assert.match(overbroad.text, /approve.*(?:exact|added).*src\/unapproved\.ts/isu);
    assert.deepEqual(timelineEvents(root), before);
    const taskMode = path.join(root, runtime, 'reviews', `${TASK_ID}-task-mode.json`);
    const predecessor = fs.readFileSync(taskMode);
    const history = fs.readFileSync(timeline(root));
    const append = taskEventIo.appendMandatoryTaskEvent;
    const concurrentReview = t.mock.method(require('../../../src/gate-runtime/timeline/task-events-io') as typeof taskEventIo,
        'appendMandatoryTaskEvent', (...params: Parameters<typeof append>) => {
            if (params[2] === 'TASK_MODE_ENTERED') append(params[0], TASK_ID, 'REVIEW_GATE_PASSED', 'PASS', 'Concurrent review boundary.', {});
            return append(...params);
        });
    try {
        const raced = await cli(root, args);
        assert.notEqual(raced.exitCode, 0, raced.text);
        assert.match(raced.text, /timeline changed before conditional append/u);
        assert.deepEqual(fs.readFileSync(taskMode), predecessor);
        assert.deepEqual(timelineEvents(root), [...before, 'REVIEW_GATE_PASSED:PASS']);
    } finally {
        concurrentReview.mock.restore();
        fs.writeFileSync(timeline(root), history);
    }
    const appendLine = timelineSnapshot.appendTaskTimelineLineSync;
    const receiptPath = path.join(root, '.git/garda-private/coherent-scope', TASK_ID + '.json');
    let restartArgs = args;
    for (const eventType of ['TASK_MODE_ENTERED', 'PREFLIGHT_CLASSIFIED', 'COHERENT_CYCLE_RESTARTED']) {
        let previousReceipt: ReturnType<typeof readProtectedCoherentScope> | undefined;
        let orphanBytes: Buffer | undefined;
        let refusedHash: string | undefined;
        const fault = t.mock.method(require('../../../src/gate-runtime/timeline/task-timeline-read-snapshot') as typeof timelineSnapshot,
            'appendTaskTimelineLineSync', (...params: Parameters<typeof appendLine>) => {
                const event = JSON.parse(params[1]);
                if (event.event_type !== eventType) return appendLine(...params);
                previousReceipt = readProtectedCoherentScope(root, TASK_ID);
                if (eventType === 'TASK_MODE_ENTERED') orphanBytes = fs.readFileSync(receiptPath);
                refusedHash = event.integrity.event_sha256;
                throw new Error('Fixture rejected the canonical timeline append');
            });
        try {
            const failed = await cli(root, restartArgs);
            assert.notEqual(failed.exitCode, 0, failed.text);
            assert.match(failed.text, /Fixture rejected the canonical timeline append/u);
            assert.ok(previousReceipt && !previousReceipt.revoked_by_reset, failed.text);
            assert.ok(refusedHash);
            assert.equal(readTaskTimelineJsonlEntries(timeline(root)).some(({ record }) =>
                (record?.integrity as { event_sha256?: string } | undefined)?.event_sha256 === refusedHash), false);
            const receipt = readProtectedCoherentScope(root, TASK_ID);
            if (eventType === 'TASK_MODE_ENTERED') {
                assert.equal(receipt, null);
                assert.deepEqual(fs.readFileSync(taskMode), predecessor);
                assert.ok(orphanBytes);
                fs.writeFileSync(receiptPath, orphanBytes);
                try {
                    const orphaned = await run(root, ['next-step', TASK_ID]);
                    assert.match(orphaned, /NextGate: task-reset/u);
                    assert.ok(statedCommands(orphaned).some(value => value.includes('--one-action --confirm')));
                } finally { fs.unlinkSync(receiptPath); }
            } else {
                assert.ok(receipt && !receipt.revoked_by_reset);
                if (eventType === 'PREFLIGHT_CLASSIFIED') {
                    assert.equal(receipt.classification, null);
                    const pending = await run(root, ['next-step', TASK_ID]);
                    const resume = statedCommands(pending).find(value => value.includes('--resume-pending-scope'));
                    assert.ok(resume, pending);
                    restartArgs = cliArgs(resume);
                } else assert.equal(receipt.ended_by, null);
            }
        } finally { fault.mock.restore(); }
    }
    const restarted = await run(root, restartArgs);
    assert.match(restarted, /COHERENT_CYCLE_RESTARTED/u);
    const recorded = events(root);
    const entry = recorded.filter(event => event.event_type === 'TASK_MODE_ENTERED').at(-1);
    const restart = recorded.filter(event => event.event_type === 'COHERENT_CYCLE_RESTARTED').at(-1);
    assert.ok(entry?.details?.coherent_scope_approval);
    assert.deepEqual(restart?.details?.coherent_scope_approval, entry.details.coherent_scope_approval);
    assert.equal((entry.details.coherent_scope_approval as Record<string, unknown>).approved_at_utc, time);
    assert.match(JSON.stringify(entry.details.coherent_scope_approval), /scripts\/node-foundation\/e2e\/friction-meter\.ts/u);
    assert.equal(args.filter(arg => arg.endsWith('confirmed-at-utc')).length, 1);
    assert.equal(recorded.filter(event => event.event_type === 'TASK_TEST_SELECTION_RECORDED').length, 1);
    let selection = await run(root, ['next-step', TASK_ID]);
    let [prefill] = statedCommands(selection);
    if (prefill?.includes(` task "${TASK_ID}" advance `)) {
        selection = await run(root, cliArgs(prefill));
        [prefill] = statedCommands(selection);
    }
    assert.match(selection, /^NextGate: task-test-selection$/mu);
    assert.match(prefill, /--focused-required-test-path "tests\/app\.test\.cjs"/u);
    assert.ok(prefill.includes(broad), selection);
});

test('field: a narrowed failure follow-up retains the real failing test file and name', async () => {
    const root = await clone();
    const stopped = await reachOutsideFailure(root);
    const command = statedCommands(stopped).find(value => value.includes(' workflow set '));
    assert.ok(command, stopped);
    const args = cliArgs(command);
    args[args.indexOf('--task-test-command') + 1] = narrow;
    args[args.indexOf('--reason') + 1] = selectionReason;
    await run(root, args);
    await run(root, ['gate', 'materialize-review-follow-up-tasks', '--task-id', TASK_ID,
        '--review-type', 'recorded-out-of-scope']);
    const [failure] = readRecordedOutOfScopeFailures(root, TASK_ID);
    assert.deepEqual(failure.failing_tests, [outside]);
    assert.deepEqual(failure.artifact.out_of_scope_failed_tests, [{ file: outside, name: 'reports navigator mode failure' }]);
    assert.match(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'),
        /Failing tests: tests\/unrelated\.test\.cjs#reports navigator mode failure/u);
});

test('field: pending scope with lost or unbound classification evidence states an executable operator reset', async t => {
    for (const scenario of ['lost-startup', 'ad-hoc-classification'] as const) {
        await t.test(scenario, async () => {
            const root = await clone();
            const command = statedCommands(await reachOutsideFailure(root)).find(value => value.includes('gate restart-coherent-cycle'));
            assert.ok(command);
            const args = cliArgs(command.replace('<operator-approved repair source path>', helper)
                .replace('<operator-stated task intent>', TASK_TITLE).replace('<ISO-8601 timestamp>', new Date().toISOString()));
            const append = taskEventIo.appendMandatoryTaskEvent;
            const fault = t.mock.method(require('../../../src/gate-runtime/timeline/task-events-io') as typeof taskEventIo,
                'appendMandatoryTaskEvent', (...params: Parameters<typeof append>) => {
                    if (params[2] === (scenario === 'lost-startup' ? 'COHERENT_CYCLE_RESTARTED' : 'PREFLIGHT_CLASSIFIED'))
                        throw new Error('Fixture interrupted the pending restart');
                    return append(...params);
                });
            try {
                const failed = await cli(root, args);
                assert.notEqual(failed.exitCode, 0, failed.text);
                assert.match(failed.text, /Fixture interrupted the pending restart/u);
            } finally { fault.mock.restore(); }
            if (scenario === 'lost-startup') {
                fs.unlinkSync(path.join(root, runtime, 'reviews', TASK_ID + '-shell-smoke.json'));
            } else {
                await run(root, ['gate', 'classify-change', '--task-id', TASK_ID, '--task-intent', TASK_TITLE]);
            }
            const blocked = await run(root, ['next-step', TASK_ID]);
            assert.match(blocked, /NextGate: task-reset/u);
            assert.doesNotMatch(blocked, /--resume-pending-scope/u);
            const preview = /Preview the reset with (node .+?) before obtaining explicit confirmation/u.exec(blocked)?.[1];
            assert.ok(preview, blocked);
            assert.match(preview, /gate task-reset .*--reopen --dry-run/u);
            const [reset] = statedCommands(blocked);
            assert.match(reset, /--one-action --confirm/u);
            const beforePreview = fs.readFileSync(timeline(root));
            const receipt = readProtectedCoherentScope(root, TASK_ID);
            assert.match(await run(root, cliArgs(preview)), /DRY_RUN/u);
            assert.deepEqual(fs.readFileSync(timeline(root)), beforePreview);
            assert.deepEqual(readProtectedCoherentScope(root, TASK_ID), receipt);
            assert.match(await run(root, cliArgs(reset.replace('<ISO-8601 timestamp>', new Date().toISOString()))), /RESET_COMPLETE/u);
            assert.deepEqual(readProtectedCoherentScope(root, TASK_ID), { task_id: TASK_ID, revoked_by_reset: true });
            const afterReset = await run(root, ['next-step', TASK_ID]);
            assert.match(afterReset, /NextGate: enter-task-mode/u);
            assert.doesNotMatch(afterReset, /--resume-pending-scope/u);
        });
    }
});

test('field: an interrupted widening resumes only the admitted request', async () => {
    const root = await clone();
    const build = path.join(root, 'scripts/build-check.cjs');
    fs.writeFileSync(build, "if (require('node:fs').existsSync('.git/fail-restart-compile')) process.exit(1);\n");
    assert.equal(runGit(root, ['add', 'scripts/build-check.cjs']).status, 0);
    assert.equal(runGit(root, ['commit', '-qm', 'Allow a transient compile interruption']).status, 0);
    const stopped = await reachOutsideFailure(root);
    const command = statedCommands(stopped).find(value => value.includes('gate restart-coherent-cycle'));
    assert.ok(command, stopped);
    const args = cliArgs(command.replace('<operator-approved repair source path>', helper)
        .replace('<operator-stated task intent>', TASK_TITLE).replace('<ISO-8601 timestamp>', new Date().toISOString()));
    const marker = path.join(root, '.git/fail-restart-compile');
    fs.writeFileSync(marker, '');
    const failed = await cli(root, args);
    assert.notEqual(failed.exitCode, 0, failed.text);
    assert.match(failed.text, /compile-gate/iu);
    const admitted = events(root).filter(event => event.event_type === 'TASK_MODE_ENTERED').at(-1);
    assert.ok(admitted?.details?.coherent_scope_approval, failed.text);
    const before = timelineEvents(root);
    const changed = await cli(root, [...args, '--planned-changed-file', 'src/unapproved.ts']);
    assert.notEqual(changed.exitCode, 0, changed.text);
    assert.match(changed.text, /cannot resume a changed/iu);
    assert.deepEqual(timelineEvents(root), before);
    const pending = await run(root, ['next-step', TASK_ID]);
    const resume = statedCommands(pending).find(value => value.includes('--resume-pending-scope'));
    assert.ok(resume, pending);
    const competing = path.join(root, 'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`);
    const pendingHistory = fs.readFileSync(competing);
    const records = pendingHistory.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const types = records.map(event => event.event_type);
    const newestEntry = types.lastIndexOf('TASK_MODE_ENTERED');
    const lastClassification = types.lastIndexOf('PREFLIGHT_CLASSIFIED');
    for (const index of [newestEntry, lastClassification]) {
        const altered = structuredClone(records);
        if (index === newestEntry) altered[index].details.coherent_scope_approval.approved_at_utc = '2090-01-01T00:00:00Z';
        else altered[index].details.changed_files_count++;
        for (let offset = index; offset < altered.length; offset++) {
            altered[offset].integrity.prev_event_sha256 = altered[offset - 1].integrity.event_sha256;
            altered[offset].integrity.event_sha256 = buildEventIntegrityHash(altered[offset]);
        }
        try {
            fs.writeFileSync(competing, altered.map(event => JSON.stringify(event)).join('\n') + '\n');
            assert.equal(inspectTaskEventFile(competing, TASK_ID).status, 'PASS');
            const refused = await cli(root, args);
            assert.notEqual(refused.exitCode, 0, refused.text);
            assert.match(refused.text, index === newestEntry ? /protected admission receipt/iu : /protected classification/iu);
        } finally { fs.writeFileSync(competing, pendingHistory); }
    }
    fs.unlinkSync(marker);
    assert.match(await run(root, cliArgs(resume)), /COHERENT_CYCLE_RESTARTED/u);
    assert.deepEqual(events(root).filter(event => event.event_type === 'TASK_MODE_ENTERED').at(-1), admitted);
    const completedHistory = fs.readFileSync(competing);
    try {
        fs.writeFileSync(competing, pendingHistory);
        const rolledBack = await cli(root, args);
        assert.notEqual(rolledBack.exitCode, 0, rolledBack.text);
        assert.match(rolledBack.text, /protected.*(?:already ended|rolled back)/iu);
    } finally { fs.writeFileSync(competing, completedHistory); }
});

test('field: a task test plan outside the checkout accepts test support as an input, with no ops-only checklist rules', async () => {
    const prefill = buildTaskTestSelectionPrefill({ changedTests: [own, helper], carriedTargets: [own], recordedTargets: [],
        previous: { command: narrow, reason: selectionReason, targets: [own] } });
    assert.deepEqual(prefill.focusedTargets, [own]);
    assert.deepEqual(prefill.declaration, { support: [{ path: helper, role: 'helper', targets: [own] }] });
    const suggested = buildTaskTestSelectionCommand('node garda.js', TASK_ID, prefill.focusedTargets,
        false, undefined, prefill.previous, prefill.declaration);
    assert.match(suggested, /--task-test-plan "@<path to task test plan JSON>"/u);
    assert.doesNotMatch(suggested, /--focused-required-test-path "[^"]*friction-meter/u);
    const root = await clone();
    await reachOutsideFailure(root);
    const planFile = path.join(os.tmpdir(), `garda-f1-1-plan-${process.pid}.json`);
    try {
        fs.writeFileSync(planFile, JSON.stringify(prefill.declaration), { flag: 'wx' });
        await run(root, ['workflow', 'set', '--target-root', '.', '--task-id', TASK_ID, '--task-test-command', narrow,
            '--focused-required-test-path', own, '--reason', selectionReason, '--task-test-plan', '@' + planFile]);
        const last = events(root).filter(event => event.event_type === 'TASK_TEST_SELECTION_RECORDED').at(-1);
        assert.match(JSON.stringify(last?.details), /"role":"helper"/u);
        // A TypeScript support script is covered by general checks. A shell file still adds the ops checks.
        const { DEFAULT_OPTIONAL_QUALITY_CHECK_RULES } = await import('../../../src/core/optional-quality-checks');
        const ops = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.filter(rule => rule.id.startsWith('ops_'));
        assert.ok(ops.every(rule => !rule.included_changed_file_regexes?.some(pattern => new RegExp(pattern, 'iu').test(helper))));
        assert.ok(ops.every(rule => rule.included_changed_file_regexes?.some(pattern => new RegExp(pattern, 'iu').test('scripts/release.ps1'))));
        assert.ok(fs.existsSync(path.join(root, preflight)));
    } finally {
        fs.rmSync(planFile, { force: true });
    }
});
