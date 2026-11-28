import './engine/walk-route-observer';
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
import { readCompileEvidenceSummary } from '../../../src/cli/commands/gate-flows/review-context/review-context-flow-current-pass-reuse';
import { readReviewArtifactJsonFile, withReviewArtifactReadBarrier } from '../../../src/gate-runtime/review-artifacts';
import { withNextStepMeasurement } from '../../../src/core/next-step-measurement';
import { readRecordedOutOfScopeFailures } from '../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { resolveNextStep } from '../../../src/gates/next-step';
import { buildTaskTestSelectionCommand, buildTaskTestSelectionPrefill } from '../../../src/gates/next-step/next-step-full-suite-routing';
import { evaluateProtectedControlPlaneManifest } from '../../../src/gates/protected-control-plane/protected-control-plane';
import { splitCommandLine } from '../../../src/core/command-line';
import { runGit } from '../cli/commands/gate-test-helpers';
import { runCliWithCapturedOutput } from '../cli/commands/gate-test-cli-capture';
import { createWalkTemplate, WALK_TASK_ID as TASK_ID } from './engine/navigator-walk';
import { fillQualityAnswers, NODE_WALK_FIXTURE } from './engine/walk-fixture';

const TASK_TITLE = NODE_WALK_FIXTURE.taskTitle;
const PROVIDER_ARGS = ['--provider', 'Codex'];
const runtime = DEFAULT_BUNDLE_NAME + '/runtime';
const timeline = (root: string) => path.join(root, runtime, 'task-events', TASK_ID + '.jsonl');
const events = (root: string) => readTaskTimelineJsonlEntries(timeline(root)).map(entry =>
    entry.record as { event_type: string; outcome: string; details?: Record<string, unknown> });
const timelineEvents = (root: string) => fs.existsSync(timeline(root))
    ? events(root).map(event => event.event_type + ':' + event.outcome) : [];
const workspaces: string[] = [];
after(() => {
    for (const root of workspaces) {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^garda-walk-template-/u);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
});
let template: string | undefined;
const clone = async () => {
    if (!template) {
        template = await createWalkTemplate(process.cwd());
        workspaces.push(template);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-walk-template-port-'));
    workspaces.push(root);
    fs.cpSync(template, root, { recursive: true });
    return root;
};

async function cli(root: string, args: string[]) {
    const result = await runCliWithCapturedOutput(args, { cwd: root });
    return { exitCode: result.exitCode, text: [...result.logs, ...result.errors].join('\n') };
}

async function run(root: string, args: string[]) {
    const result = await cli(root, args);
    assert.equal(result.exitCode, 0, result.text);
    return result.text;
}

function cliArgs(command: string): string[] {
    const args = splitCommandLine(command);
    return args.slice(args.findIndex(value => ['gate', 'workflow', 'next-step'].includes(value)));
}

function statedCommands(text: string): string[] {
    const block = text.split(/^Commands:\r?$/mu)[1]?.split(/^AfterCommand:/mu)[0] ?? '';
    return [...block.matchAll(/^ {2}[^:\n]+: (.+)$/gmu)].map(match => match[1].trim());
}

async function navigate(root: string): Promise<string> {
    const result = await run(root, ['next-step', TASK_ID]);
    const effects = statedCommands(result).find(command => command.includes('--execute-effects'));
    if (!effects) return result;
    await run(root, cliArgs(effects));
    return run(root, ['next-step', TASK_ID]);
}

async function runPrintedCommand(root: string, gate: string): Promise<void> {
    const navigation = await navigate(root);
    assert.ok(navigation.includes('NextGate: ' + gate), navigation);
    const [command] = statedCommands(navigation);
    assert.ok(command, navigation);
    await run(root, cliArgs(command));
}

const enter = (...files: string[]) => ['gate', 'enter-task-mode', '--task-id', TASK_ID, '--entry-mode',
    'EXPLICIT_TASK_EXECUTION', '--task-summary', TASK_TITLE, ...PROVIDER_ARGS,
    ...files.flatMap(file => ['--planned-changed-file', file])];

test('field: a fresh linked worktree points to the checkout holding the workspace without offering setup', async () => {
    const root = await clone();
    const linked = path.join(root, 'linked workspace');
    assert.equal(runGit(root, ['worktree', 'add', '--detach', linked, 'HEAD']).status, 0);
    try {
        for (const args of [['next-step', TASK_ID], ['gate', 'enter-task-mode', '--task-id', TASK_ID, ...PROVIDER_ARGS]]) {
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

test('field: entry routes protected drift to approval before any startup evidence', async () => {
    const root = await clone();
    const packagePath = path.join(root, 'package.json');
    fs.writeFileSync(packagePath, JSON.stringify({ name: 'garda-agent-orchestrator' }));
    assert.equal(runGit(root, ['add', 'package.json']).status, 0);
    assert.equal(runGit(root, ['commit', '-qm', 'Use source checkout entry policy']).status, 0);
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\nOperator changed protected rules.\n');
    const output = await run(root, ['next-step', TASK_ID]);
    assert.match(output, /NextGate: enter-task-mode/u);
    assert.deepEqual(timelineEvents(root), []);
    const refused = await cli(root, ['gate', 'enter-task-mode', '--task-id', TASK_ID, '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
        '--task-summary', TASK_TITLE, ...PROVIDER_ARGS]);
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.text, /Protected control-plane manifest drift.*Ask the operator/u);
    assert.equal(events(root).some(event => event.event_type === 'TASK_MODE_ENTERED'), false);
    assert.deepEqual(timelineEvents(root), ['TASK_MODE_ENTRY_FAILED:FAIL']);
    const route = resolveNextStep({ repoRoot: root, taskId: TASK_ID });
    assert.equal(route.commands[0].execution_boundary, 'operator');
    const [command] = statedCommands(await run(root, ['next-step', TASK_ID]));
    assert.match(command, /gate enter-task-mode .*--orchestrator-work --operator-confirmed yes/u);
    const approved = await run(root, cliArgs(command.replace('<ISO-8601 timestamp>', new Date().toISOString())));
    assert.match(approved, /TASK_MODE_ENTERED/u);
    assert.match(await run(root, ['next-step', TASK_ID]), /NextGate: load-rule-pack/u);
});

test('field: declining protected drift and restoring the files returns to ordinary entry', async t => {
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

    const deniedPath = `${DEFAULT_BUNDLE_NAME}/live/docs/agent-rules`;
    const read = fs.readdirSync;
    const denied = t.mock.method(require('node:fs') as typeof fs, 'readdirSync', (...args: unknown[]) => {
        if (String(args[0]) === path.join(root, deniedPath))
            throw Object.assign(new Error('Fixture denied protected directory traversal'), { code: 'EACCES' });
        return Reflect.apply(read, fs, args);
    });
    try {
        const retry = await run(root, ['next-step', TASK_ID]);
        assert.ok(retry.includes(`${deniedPath} (EACCES)`), retry);
        assert.ok(retry.includes('repair inspect --target-root "."'), retry);
        assert.deepEqual(statedCommands(retry), [afterRestore]);
        assert.equal(resolveNextStep({ repoRoot: root, taskId: TASK_ID }).commands[0].execution_boundary, 'operator');
    } finally { denied.mock.restore(); }

    fs.writeFileSync(protectedFile, originalRules);
    const restored = await run(root, ['next-step', TASK_ID]);
    assert.match(restored, /The protected tree matches the trusted baseline again/u);
    const commands = statedCommands(restored);
    assert.deepEqual(commands, [afterRestore]);
    assert.equal(resolveNextStep({ repoRoot: root, taskId: TASK_ID }).commands[0].execution_boundary, 'agent');
    assert.deepEqual(timelineEvents(root), ['TASK_MODE_ENTRY_FAILED:FAIL']);
    assert.match(await run(root, cliArgs(commands[0])), /TASK_MODE_ENTERED/u);
    assert.match(await run(root, ['next-step', TASK_ID]), /NextGate: load-rule-pack/u);
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
        if (invalid) assert.match(route.commands[0].command, / repair inspect /u);
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
                assert.equal(retryRoute.commands[0].execution_boundary, 'operator');
                const originalTimeline = fs.readFileSync(timeline(root));
                const reviews = path.join(root, runtime, 'reviews');
                const originalArtifacts = fs.readdirSync(reviews).sort();
                await run(root, ['next-step', TASK_ID]);
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
        await run(root, enter('src/app.ts'));
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
        const footer = /^Next action: (.+gate handshake-diagnostics .+)$/mu.exec(entered)?.[1];
        assert.ok(footer, entered);
        assert.equal((entered.match(/^Next action: .+$/gmu) ?? []).length, 1);
        await run(root, cliArgs(footer));
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

async function runChecklistIfRequired(root: string): Promise<void> {
    const answersPath = path.join(root, runtime, 'tmp', TASK_ID + '-quality-checklist-answers.json');
    const checklist = await navigate(root);
    if (/NextGate: quality-checklist/u.test(checklist)) {
        let [command] = statedCommands(checklist);
        if (!fs.existsSync(answersPath) && command) await cli(root, cliArgs(command));
        if (fs.existsSync(answersPath)) {
            fillQualityAnswers(answersPath, ['src/app.ts', own]);
            [command] = statedCommands(await run(root, ['next-step', TASK_ID]));
            if (command?.includes('gate quality-checklist ')) await run(root, cliArgs(command));
        }
    }
}

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
    await run(root, enter('src/app.ts', own));
    await runPrintedCommand(root, 'load-rule-pack');
    await runPrintedCommand(root, 'handshake-diagnostics');
    await runPrintedCommand(root, 'shell-smoke-preflight');
    fs.appendFileSync(path.join(root, 'src/app.ts'), 'export const done = true;\n');
    fs.appendFileSync(path.join(root, own), '// Current fixture regression.\n');
    await runPrintedCommand(root, 'classify-change');
    const rules = await navigate(root);
    const ruleGate = /^NextGate: (load-rule-pack|bind-rule-pack-to-preflight)$/mu.exec(rules)?.[1];
    assert.ok(ruleGate, rules);
    await runPrintedCommand(root, ruleGate);
    await runChecklistIfRequired(root);
    await runPrintedCommand(root, 'compile-gate');
    await run(root, ['workflow', 'set', '--target-root', '.', '--task-id', TASK_ID, '--task-test-command', broad,
        '--focused-required-test-path', own, '--reason', selectionReason]);
    const beforeValidation = await run(root, ['next-step', TASK_ID]);
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
    await runChecklistIfRequired(root);
    const selection = await navigate(root);
    const [prefill] = statedCommands(selection);
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
    const metricsRetry = await cli(root, [...args, '--emit-metrics', 'false']);
    assert.notEqual(metricsRetry.exitCode, 0, metricsRetry.text);
    assert.match(metricsRetry.text, /compile-gate/iu);
    assert.doesNotMatch(metricsRetry.text, /cannot resume a changed recovery request/iu);
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

test('field: compile summary shares the authenticated artifact payload within a navigator step', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-summary-'));
    t.after(() => {
        assert.ok(path.basename(root).startsWith('garda-compile-summary-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const reviews = path.join(root, runtime, 'reviews');
    fs.mkdirSync(reviews, { recursive: true });
    const compile = path.join(reviews, TASK_ID + '-compile-gate.json');
    fs.writeFileSync(compile, JSON.stringify({ status: 'PASSED', preflight_path: 'preflight.json' }));
    let work: Record<string, number> | undefined;
    withNextStepMeasurement(() => withReviewArtifactReadBarrier(reviews, () => {
        assert.deepEqual(readReviewArtifactJsonFile(compile), { status: 'PASSED', preflight_path: 'preflight.json' });
        assert.equal(readCompileEvidenceSummary(root, TASK_ID).status, 'PASSED');
        assert.equal(readCompileEvidenceSummary(root, TASK_ID).status, 'PASSED');
    }), result => { work = result.work; });
    const payloadReads = Object.entries(work ?? {}).filter(([key]) =>
        key.startsWith('payload_read:') && key.toLowerCase().endsWith((TASK_ID + '-compile-gate.json').toLowerCase()));
    assert.equal(payloadReads.reduce((sum, [, count]) => sum + count, 0), 1, JSON.stringify(work));
});
