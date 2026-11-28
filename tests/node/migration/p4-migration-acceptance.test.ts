import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import '../isolate-compile-cache';
import { inspectTaskEventFile } from '../../../src/gate-runtime/timeline/task-events-integrity';
import { isAuthenticatedTaskHistoryStatus } from '../../../src/gate-runtime/timeline/task-history-authentication';
import { loadTaskFullSuiteConfig } from '../../../src/gates/full-suite/task-full-suite-config';
import { readRecordedOutOfScopeFailures } from '../../../src/gates/full-suite/recorded-out-of-scope-failures';
import { taskTestProcessEvidenceViolations } from '../../../src/gates/full-suite/task-test-execution-proof';
import { parseCanonicalActiveTaskQueue } from '../../../src/core/task-md-table';
import { readRollbackRecords } from '../../../src/lifecycle/lifecycle-common';
import { BASELINES, BROAD_COMMAND, BUNDLE, OWN_COMMAND, PREFLIGHT, TASK, assertRetained, buildRuntime, cli,
    command, createProject, digest, enter, events, follow, gate, interruptUpdate, json, navigate, ownRunCount, packRuntime, prepare, quality, refresh, retainedBytes, review, select,
    succeeds, tempRoot, upgrade, type CommandResult, type Project, type Runtime } from './p4-fixtures';

let root: string;
let old: Runtime;
let candidate: Runtime;
let tagged: Runtime;
let packedCandidate: ReturnType<typeof packRuntime>;
const routeText = (next: Record<string, unknown>) => JSON.stringify({ gate: next.next_gate, title: next.title,
    reason: next.reason, commands: next.commands });

function projectFiles(project: Project): Map<string, string> {
    return new Map(fs.readdirSync(project.root, { recursive: true, withFileTypes: true }).map(entry => {
        const file = path.join(entry.parentPath, entry.name);
        const state = entry.isDirectory() ? 'directory' : entry.isSymbolicLink()
            ? `link:${fs.readlinkSync(file)}` : digest(fs.readFileSync(file));
        return [path.relative(project.root, file), state];
    }));
}

function assertUpdateRefused(project: Project, apply: () => CommandResult,
    expected = `Finish task ${TASK} (or bring it to DONE / a terminal state) on the current Garda version, then run update again.`): void {
    const before = projectFiles(project);
    const result = apply();
    assert.notEqual(result.code, 0, result.output);
    assert.ok(result.output.includes(expected), result.output);
    assert.deepEqual(projectFiles(project), before, 'refusal must leave the project byte-for-byte intact, including snapshots and live files');
}

before(() => {
    root = tempRoot();
    old = buildRuntime(root, BASELINES[0]);
    candidate = buildRuntime(root, 'HEAD', true);
    tagged = buildRuntime(root, BASELINES[1]);
}, { timeout: 600_000 });
after(() => {
    if (root && process.env.GARDA_P4_KEEP_FIXTURES !== '1') {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('garda-p4-'));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
});

test('P4/T-441 §8.1–4: real old PASS stays readable and update refuses the active task', { timeout: 180_000 }, () => {
    const project = createProject(root, old, 'pass');
    prepare(project);
    succeeds(select(project));
    succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT]));
    succeeds(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT]));
    assert.equal(ownRunCount(project), 1, 'the old test must really execute, independent of its retained event');
    const pass = events(project).find(event => event.event_type === 'FULL_SUITE_VALIDATION_PASSED')!;
    assert.ok(pass);
    assertUpdateRefused(project, () => upgrade(project, candidate));
    const retained = retainedBytes(project);
    const next = gate(project, 'next-step', ['--as-json'], candidate.readerCli);
    succeeds(next);
    assertRetained(project, retained);
    const route = JSON.parse(next.output) as Record<string, unknown>;
    const checklistState = route.quality_checklist as { evidence_status: string; status: string };
    assert.equal(checklistState.evidence_status, 'stale', 'the older checklist policy needs a refresh');
    assert.equal(checklistState.status, 'PASS', 'the old verdict stays readable');
    assert.equal(route.next_gate, 'next-step-effect', routeText(route));
    assert.match(String(route.reason), /Materialize the quality-checklist answers template/u);
    assert.doesNotMatch(routeText(route),
        /integrity.*(?:invalid|mismatch)|operator.*(?:reset|decision)/iu);
    const timeline = path.join(project.root, BUNDLE, `runtime/task-events/${TASK}.jsonl`);
    assert.ok(isAuthenticatedTaskHistoryStatus(inspectTaskEventFile(timeline, TASK).status));
    const selected = loadTaskFullSuiteConfig(project.root, TASK).selection;
    assert.equal(selected.status, 'current', 'P4: sufficient old bindings should be reusable');
    assert.equal(selected.command, OWN_COMMAND);
    const passDetails = pass.details as { artifact_path: string; artifact_sha256: string };
    const passBytes = fs.readFileSync(path.resolve(project.root, passDetails.artifact_path));
    assert.equal(digest(passBytes), passDetails.artifact_sha256);
    assert.deepEqual(taskTestProcessEvidenceViolations(selected.plan, JSON.parse(passBytes.toString('utf8')), selected.legacyPlan), [],
        'a sufficiently bound old PASS must satisfy process identity without rerunning the tests');
    const checklist = json(project.root, `${BUNDLE}/runtime/reviews/${TASK}-quality-checklist.json`);
    assert.equal(checklist.status, 'PASS', 'the old native checklist must also survive reader migration');
    const auditPath = path.join(project.root, BUNDLE, 'runtime/workflow-config-audit.jsonl');
    const auditBytes = fs.readFileSync(auditPath);
    try {
        fs.writeFileSync(auditPath, auditBytes.toString('utf8').replace('"actor":"task_selection_command"', '"actor":"operator_command"'));
        const damaged = loadTaskFullSuiteConfig(project.root, TASK).selection;
        assert.equal(damaged.status, 'stale');
        assert.match(damaged.reason || '', /audit digest.*(?:missing|invalid)/u);
    } finally { fs.writeFileSync(auditPath, auditBytes); }
    const legacyAudit = auditBytes.toString('utf8')
        .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
        .reverse().find(record => record.actor === 'task_selection_command')!;
    succeeds(select(project, OWN_COMMAND, candidate.readerCli));
    const replacement = events(project).reverse().find(event => event.event_type === 'TASK_TEST_SELECTION_RECORDED')!;
    assert.equal(((replacement.details as Record<string, unknown>).task_test_selection_authority as Record<string, unknown>).previous_selection_sha256,
        digest(Buffer.from(JSON.stringify(legacyAudit.task_test_selection_authority))), 'replacement must reference the authentic legacy audit selection');
});

for (const baseline of BASELINES) {
    test(`P4/T-441 §8.3,6: ${baseline} broad FAILED narrows without attribution or a broad rerun`, { timeout: 180_000 }, () => {
        const project = createProject(root, baseline === BASELINES[0] ? old : tagged, 'broad-failed');
        // Publish digest-bearing rule-pack stages while the historical CLI produces the validation evidence.
        prepare(project, candidate.readerCli);
        // 9cc56c65 predates mandatory selections and cannot admit this opaque broad runner.
        // Its real global-command run is exactly the legacy missing-selection case; never forge a selection for it.
        if (baseline !== BASELINES[0]) succeeds(select(project, BROAD_COMMAND));
        succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT]));
        const failed = gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT]);
        assert.notEqual(failed.code, 0, failed.output);
        assert.equal(ownRunCount(project), 1, 'the broad command must really execute its own test before the unrelated failure');
        const event = events(project).find(event => event.event_type === 'FULL_SUITE_VALIDATION_FAILED')!;
        assert.ok(event, 'the older Garda must produce an authenticated FAILED event');
        const details = event.details as Record<string, unknown>;
        const artifactPath = path.resolve(project.root, String(details.artifact_path));
        const artifactBytes = fs.readFileSync(artifactPath);
        const artifact = JSON.parse(artifactBytes.toString()) as Record<string, unknown>;
        assert.equal(artifact.status, 'FAILED');
        assert.equal(digest(artifactBytes), details.artifact_sha256);
        assert.equal(typeof details.output_artifact_path, 'string', 'the native broad failure retains raw output');
        const rawOutputPath = path.resolve(project.root, String(details.output_artifact_path));
        const rawOutput = fs.readFileSync(rawOutputPath);
        assert.equal(digest(rawOutput), (details.output_retention as { raw_output_sha256: string }).raw_output_sha256);
        assert.deepEqual(details.out_of_scope_failure_refs ?? artifact.out_of_scope_failure_refs ?? [], [],
            'fixture must exercise missing attribution without rewriting the old event');
        const timelineBefore = fs.readFileSync(path.join(project.root, BUNDLE, `runtime/task-events/${TASK}.jsonl`));
        const previousSelectionLine = timelineBefore.toString('utf8').trim().split('\n').reverse()
            .find(line => (JSON.parse(line) as Record<string, unknown>).event_type === 'TASK_TEST_SELECTION_RECORDED');
        succeeds(select(project, OWN_COMMAND, candidate.readerCli));
        const records = readRecordedOutOfScopeFailures(project.root, TASK);
        assert.equal(records.length, 1);
        assert.equal(records[0].attribution, 'not attributed');
        assert.equal(records[0].command, BROAD_COMMAND);
        assert.equal(records[0].artifact_sha256, digest(artifactBytes));
        assert.deepEqual(records[0].artifact, artifact);
        assert.ok(records[0].failure_event_sha256);
        assert.equal(loadTaskFullSuiteConfig(project.root, TASK).selection.status, 'current');
        const executions = events(project).filter(event => /^FULL_SUITE_VALIDATION_(?:PASSED|FAILED)$/u.test(String(event.event_type)));
        assert.equal(executions.length, 1, 'narrowing must not run the broad command again');
        const after = fs.readFileSync(path.join(project.root, BUNDLE, `runtime/task-events/${TASK}.jsonl`));
        assert.deepEqual(after.subarray(0, timelineBefore.length), timelineBefore);
        succeeds(gate(project, 'materialize-review-follow-up-tasks', ['--review-type', 'recorded-out-of-scope'], candidate.readerCli));
        const children = parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(project.root, 'TASK.md'), 'utf8')).rows
            .filter(row => row.notes.includes('out_of_scope_follow_up=grouped') && row.notes.includes(`out_of_scope_parent=${TASK}`));
        assert.equal(children.length, 1, 'one grouped follow-up must retain the original unattributed failure');
        assert.match(children[0].notes, /Tests: not attributed/u);
        assert.ok(children[0].notes.includes(digest(artifactBytes)));
        const narrowedNext = navigate(project, candidate.readerCli);
        assert.equal(narrowedNext.next_gate, 'full-suite-validation', routeText(narrowedNext));
        succeeds(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT], candidate.readerCli));
        assert.equal(ownRunCount(project), 2, 'narrow validation must execute only the own-test command');
        assert.deepEqual(readRecordedOutOfScopeFailures(project.root, TASK)[0].artifact, artifact,
            'a narrow PASS must not turn the retained broad failure into PASS');
        if (previousSelectionLine) {
            const previousSelection = JSON.parse(previousSelectionLine) as { integrity: { event_sha256: string }; details: { task_test_selection_authority: unknown } };
            const replacement = events(project).filter(event => event.event_type === 'TASK_TEST_SELECTION_RECORDED').at(-1)!;
            const lineage = JSON.stringify(replacement.details);
            assert.ok([digest(Buffer.from(previousSelectionLine)), previousSelection.integrity.event_sha256,
                digest(Buffer.from(JSON.stringify(previousSelection.details.task_test_selection_authority)))]
                .some(hash => lineage.includes(hash)), 'T-441 §8.6: replacement must reference the authenticated previous selection identity');
        }
        assert.ok(fs.existsSync(rawOutputPath), 'T-441 §8.1,3: narrow PASS must retain the original authenticated broad FAILED output');
        assert.deepEqual(fs.readFileSync(rawOutputPath), rawOutput, 'old raw failure output must remain byte-for-byte intact');
    });
}

test('P4/T-457: update refuses a task after reset and real re-entry', { timeout: 180_000 }, () => {
    const project = createProject(root, tagged, 'reset');
    prepare(project);
    assert.equal(loadTaskFullSuiteConfig(project.root, TASK).selection.status, 'missing');
    succeeds(select(project));
    assert.equal(loadTaskFullSuiteConfig(project.root, TASK).selection.status, 'current');
    enter(project, candidate.readerCli);
    const reentered = loadTaskFullSuiteConfig(project.root, TASK).selection;
    assert.equal(reentered.status, 'stale', 'a new entry invalidates prior execution authority');
    assert.equal(reentered.command, null);
    assert.equal(reentered.reviewedPreflight, undefined);
    succeeds(gate(project, 'task-reset', ['--reopen', '--confirm', '--one-action', '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', new Date().toISOString()], candidate.readerCli));
    const missing = { status: 'missing', command: null, targets: [] };
    assert.deepEqual(loadTaskFullSuiteConfig(project.root, TASK).selection, missing);
    enter(project, candidate.readerCli);
    assert.deepEqual(loadTaskFullSuiteConfig(project.root, TASK).selection, missing);
    assertUpdateRefused(project, () => upgrade(project, candidate, ['check-update', '--apply']));
    const premature = gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT], candidate.readerCli);
    assert.notEqual(premature.code, 0);
    assert.doesNotMatch(premature.output, /FULL_SUITE_VALIDATION_PASSED/u);
    assert.equal(ownRunCount(project), 0);
});

test('P4/T-441: a failed own target cannot be dropped while migrating to a new selection', { timeout: 180_000 }, () => {
    const project = createProject(root, old, 'own-failed');
    fs.writeFileSync(path.join(project.root, project.sourcePath), 'exports.total = (a, b) => a - b;\n');
    prepare(project, candidate.readerCli);
    succeeds(select(project));
    succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT]));
    assert.notEqual(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT]).code, 0);
    const originalFailure = events(project).filter(event => event.event_type === 'FULL_SUITE_VALIDATION_FAILED').at(-1)!;
    const failureOutputPath = path.resolve(project.root, String((originalFailure.details as Record<string, unknown>).output_artifact_path));
    const failureOutput = fs.readFileSync(failureOutputPath);
    const before = events(project).filter(event => event.event_type === 'TASK_TEST_SELECTION_RECORDED').length;
    const dropped = select(project, 'node -e "process.exit(0)"', candidate.readerCli);
    assert.notEqual(dropped.code, 0, dropped.output);
    assert.match(dropped.output, /target|selection|test/iu);
    assert.equal(events(project).filter(event => event.event_type === 'TASK_TEST_SELECTION_RECORDED').length, before);
    const timelineBefore = fs.readFileSync(path.join(project.root, BUNDLE, `runtime/task-events/${TASK}.jsonl`));
    fs.writeFileSync(path.join(project.root, project.sourcePath), 'exports.total = (a, b) => a + b;\n// task implementation\n');
    let fixedNext = navigate(project, candidate.readerCli);
    for (let step = 0; step < 4 && ['load-rule-pack', 'handshake-diagnostics', 'shell-smoke-preflight',
        'restart-coherent-cycle'].includes(String(fixedNext.next_gate)); step += 1) {
        succeeds(follow(project, (fixedNext.commands as Array<{ command: string }>)[0].command, candidate.readerCli));
        fixedNext = navigate(project, candidate.readerCli);
    }
    refresh(project, candidate.readerCli);
    succeeds(select(project, project.ownCommand, candidate.readerCli));
    succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT], candidate.readerCli));
    fixedNext = navigate(project, candidate.readerCli);
    for (let step = 0; step < 6; step += 1) {
        if (['restart-coherent-cycle', 'compile-gate'].includes(String(fixedNext.next_gate))) {
            succeeds(follow(project, (fixedNext.commands as Array<{ command: string }>)[0].command, candidate.readerCli));
        } else if (fixedNext.next_gate === 'quality-checklist') quality(project, candidate.readerCli);
        else if (fixedNext.next_gate === 'task-test-selection') succeeds(select(project, project.ownCommand, candidate.readerCli));
        else break;
        fixedNext = navigate(project, candidate.readerCli);
    }
    assert.equal(fixedNext.next_gate, 'full-suite-validation', 'a fixed own failure must route to the same own-test command: ' + routeText(fixedNext));
    succeeds(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT], candidate.readerCli));
    assert.equal(ownRunCount(project), 2, 'the own target must fail first and genuinely run again after its source fix');
    const timelineAfter = fs.readFileSync(path.join(project.root, BUNDLE, `runtime/task-events/${TASK}.jsonl`));
    assert.deepEqual(timelineAfter.subarray(0, timelineBefore.length), timelineBefore);
    assert.equal(events(project).filter(event => event.event_type === 'FULL_SUITE_VALIDATION_FAILED').length, 1);
    assert.deepEqual(fs.readFileSync(failureOutputPath), failureOutput, 'own-failure raw evidence also survives recovery');
});

test('P4/T-441 §8.5: an old active task without execution identity gets an own-test selection route', { timeout: 180_000 }, () => {
    const project = createProject(root, old, 'no-execution');
    succeeds(cli(project, ['workflow', 'set', '--target-root', project.root, '--full-suite-command', OWN_COMMAND,
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]));
    prepare(project, candidate.readerCli);
    succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT]));
    succeeds(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT]));
    assert.equal(ownRunCount(project), 1, 'legacy PASS without a selection must be genuinely produced');
    const before = retainedBytes(project);
    assert.equal(loadTaskFullSuiteConfig(project.root, TASK).selection.status, 'missing');
    const next = gate(project, 'next-step', ['--as-json'], candidate.readerCli);
    succeeds(next);
    assertRetained(project, before);
    const missingIdentityNext = JSON.parse(next.output) as Record<string, unknown>;
    assert.equal(missingIdentityNext.next_gate, 'task-test-selection', routeText(missingIdentityNext));
    assert.doesNotMatch(routeText(missingIdentityNext), /ask (?:the )?operator|operator-only/iu);
    succeeds(select(project, OWN_COMMAND, candidate.readerCli));
    const selectedNext = navigate(project, candidate.readerCli);
    assert.equal(selectedNext.next_gate, 'full-suite-validation',
        'T-441 §8.5: navigator must require a fresh own-test run, not reuse a PASS recorded before selection identity existed: ' + routeText(selectedNext));
    succeeds(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT], candidate.readerCli));
    assert.equal(ownRunCount(project), 2, 'missing old identity requires a new own-test process, not reuse of the old PASS');
});

test('P4/T-441: selecting the old project command offers executable own-test reselection', { timeout: 180_000 }, () => {
    const project = createProject(root, tagged, 'project-command');
    prepare(project, candidate.readerCli);
    succeeds(select(project, BROAD_COMMAND));
    succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT]));
    const next = routeText(navigate(project, candidate.readerCli));
    assert.match(next, /workflow set/u);
    assert.match(next, /tests\/total[.]test[.]cjs/u);
    assert.match(next, /<command that runs only this task/u);
    assert.doesNotMatch(next, /operator.*(?:decision|confirmation).*required/iu);
});

for (const mode of ['throw', 'exit'] as const) {
    test(`P4/T-441: active task is refused before an update can reach the ${mode} interruption`, { timeout: 180_000 }, () => {
        const project = createProject(root, old, `active-update-${mode}`);
        enter(project);
        assertUpdateRefused(project, () => interruptUpdate(project, candidate, mode));
    });
}

test('P4/T-441: interrupted update exception rolls back real materialization with no active task', { timeout: 300_000 }, () => {
    const project = createProject(root, old, 'update-exception');
    const before = retainedBytes(project);
    const queueBefore = fs.readFileSync(path.join(project.root, 'TASK.md'));
    const launcherBefore = fs.readFileSync(project.cli);
    const failed = interruptUpdate(project, candidate, 'throw');
    assert.equal(failed.code, 19, failed.output);
    assert.match(failed.output, /rollback completed successfully.*P4 interruption/isu);
    assertRetained(project, before, true);
    assert.deepEqual(fs.readFileSync(path.join(project.root, 'TASK.md')), queueBefore);
    assert.deepEqual(fs.readFileSync(project.cli), launcherBefore);
    succeeds(cli(project, ['workflow', 'show', '--target-root', project.root]));
});

test('P4/T-441: actual killed update with no active task retains a verified snapshot and safe recovery', { timeout: 300_000 }, () => {
    const project = createProject(root, old, 'update-crash');
    const before = retainedBytes(project);
    const queueBefore = fs.readFileSync(path.join(project.root, 'TASK.md'));
    const stopped = interruptUpdate(project, candidate, 'exit');
    assert.equal(stopped.code, 17, stopped.output);
    assert.ok(fs.existsSync(path.join(project.root, BUNDLE, 'live/docs/agent-rules/90-review-trigger-matrix.md')),
        'the candidate rules must have materialized before the crash');
    const snapshotsRoot = path.join(project.root, BUNDLE, 'runtime/update-rollbacks');
    const snapshots = fs.readdirSync(snapshotsRoot).filter(name => name.startsWith('update-'));
    assert.equal(snapshots.length, 1, 'the real update must leave its authenticated rollback snapshot');
    const snapshot = path.join(snapshotsRoot, snapshots[0]);
    assert.ok(readRollbackRecords(snapshot).length > 0, 'read and verify the actual snapshot even if rollback is refused');
    const rolledBack = cli(project, ['rollback', '--target-root', project.root, '--snapshot-path',
        snapshot], candidate.readerCli, 240_000);
    if (rolledBack.code === 0) {
        assertRetained(project, before, true);
        assert.deepEqual(fs.readFileSync(path.join(project.root, 'TASK.md')), queueBefore);
        succeeds(cli(project, ['workflow', 'show', '--target-root', project.root]));
    } else {
        assert.match(rolledBack.output, /integrity|authority|owner|lock|sentinel|process/iu, 'only a real safety boundary may refuse rollback');
        assert.match(rolledBack.output, /(?:node .*garda[.]js|garda) (?:rollback|repair|doctor|gate) /iu,
            'T-441/R7: a refused interrupted update needs an executable recovery route');
        assertRetained(project, before, true);
    }
});

test('P4/T-441 §8.2: a damaged old execution artifact cannot become reusable PASS', { timeout: 180_000 }, () => {
    const project = createProject(root, tagged, 'tampered');
    prepare(project);
    succeeds(select(project));
    succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT]));
    succeeds(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT]));
    assert.equal(loadTaskFullSuiteConfig(project.root, TASK).selection.status, 'current');
    const event = events(project).find(event => event.event_type === 'FULL_SUITE_VALIDATION_PASSED')!;
    assert.ok(event);
    const artifact = path.resolve(project.root, String((event.details as Record<string, unknown>).artifact_path));
    fs.appendFileSync(artifact, ' '); // Negative control: deliberately damage bytes, never re-sign them.
    const next = gate(project, 'next-step', ['--as-json'], candidate.readerCli);
    const output = next.code === 0 ? routeText(JSON.parse(next.output) as Record<string, unknown>) : next.output;
    assert.match(output, /(?:hash|digest|integrity|artifact|evidence).*(?:mismatch|changed|invalid|stale|missing)|full-suite-validation/isu);
    assert.match(output, /gate |workflow set/u, 'a refusal needs an executable route');
    assert.doesNotMatch(output, /"gate"\s*:\s*"(?:completion-gate|human-commit)"/u);
});

test('P4/T-406,T-408: packed tarball update refuses an active owner', { timeout: 300_000 }, () => {
    const packed = packedCandidate ??= packRuntime(root, candidate);
    const project = createProject(root, old, 'pack-active');
    enter(project);
    assertUpdateRefused(project, () => upgrade(project, packed, ['update'], ['--package-spec', packed.tarball]));
});

test('P4: alternate bundle replacement commands refuse an active task', { timeout: 180_000 }, () => {
    const project = createProject(root, old, 'alternate-update');
    enter(project);
    for (const args of [
        ['update', 'git', '--repo-url', candidate.root, '--trust-override', '--no-prompt'],
        ['install'],
        ['setup'],
        ['rollback', '--to-version', '9.9.9']
    ]) {
        assertUpdateRefused(project, () => command(process.execPath, [
            candidate.cli, ...args, '--target-root', project.root
        ], project.root));
    }
});

test('P4: packed upgrade from 1.4.4 syncs the bundle, migrates config and preserves finished history', { timeout: 300_000 }, () => {
    const packed = packedCandidate ??= packRuntime(root, candidate);
    assert.match(fs.readFileSync(path.join(packed.root, 'docs/configuration.md'), 'utf8'), /task_test_validation.*full_suite_validation/u);
    assert.match(fs.readFileSync(path.join(packed.root, 'AGENT_INIT_PROMPT.md'), 'utf8'),
        /workflow set --task-test-enabled true --task-test-command/u);

    const project = createProject(root, old, 'pack-idle');
    const bundle = path.join(project.root, BUNDLE);
    assert.equal(fs.readFileSync(path.join(bundle, 'VERSION'), 'utf8').trim(), '1.4.4');
    // Seed the existing DONE row's history with the historical runtime's signed event writer.
    succeeds(command(process.execPath, ['-e',
        "const [bundle] = process.argv.slice(1); " +
        "require(require('node:path').join(bundle, 'dist/src/gate-runtime/task-events.js')).appendTaskEvent(" +
        "bundle, 'T-HISTORY', 'STATUS_CHANGED', 'INFO', 'Historical closeout', { new_status: 'DONE' });", bundle], project.root));
    const history = path.join(bundle, 'runtime/task-events/T-HISTORY.jsonl');
    const historyBefore = fs.readFileSync(history);
    assert.ok(isAuthenticatedTaskHistoryStatus(inspectTaskEventFile(history, 'T-HISTORY').status));
    const configPath = `${BUNDLE}/live/config/workflow-config.json`;
    const configBefore = json(project.root, configPath);
    const selectionModule = 'dist/src/cli/commands/workflow/workflow-command-task-test-selection.js';
    const packedModule = fs.readFileSync(path.join(packed.root, selectionModule));
    assert.notDeepEqual(fs.readFileSync(path.join(bundle, selectionModule)), packedModule);

    succeeds(upgrade(project, packed));

    const triggerMatrix = 'docs/agent-rules/90-review-trigger-matrix.md';
    assert.deepEqual(fs.readFileSync(path.join(bundle, 'live', triggerMatrix)),
        fs.readFileSync(path.join(packed.root, 'template', triggerMatrix)));
    assert.deepEqual(fs.readFileSync(project.cli), fs.readFileSync(packed.cli));
    assert.deepEqual(fs.readFileSync(path.join(bundle, selectionModule)), packedModule);
    const configAfter = json(project.root, configPath);
    assert.notDeepEqual(configAfter, configBefore, 'update must refresh the legacy config');
    assert.equal((configAfter.full_suite_validation as { command: string }).command, BROAD_COMMAND);
    assert.deepEqual(fs.readFileSync(history), historyBefore);
    const closed = cli(project, ['gate', 'task-events-summary', '--repo-root', project.root, '--task-id', 'T-HISTORY', '--as-json']);
    succeeds(closed);
    assert.ok(isAuthenticatedTaskHistoryStatus(JSON.parse(closed.stdout).integrity.status));
    assert.match(closed.stdout, /STATUS_CHANGED/u);
});

for (const shape of ['python', 'opaque'] as const) {
    test(`P4/T-406,T-408: ${shape} project shape resumes an old active task through native own-test execution`, { timeout: 180_000 }, () => {
        if (shape === 'python') succeeds(command('python', ['--version'], root));
        const project = createProject(root, old, `shape-${shape}`, false, shape);
        prepare(project, candidate.readerCli);
        // Independent fixture sanity, never offered to Garda as execution evidence.
        succeeds(shape === 'python' ? command('python', ['-m', 'unittest', 'tests/test_total.py'], project.root)
            : command(process.execPath, ['tooling/orbit.cjs', 'specs/total.case'], project.root));
        const entryBefore = fs.readFileSync(path.join(project.root, BUNDLE, `runtime/reviews/${TASK}-task-mode.json`));
        succeeds(select(project, project.ownCommand, candidate.readerCli));
        succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT], candidate.readerCli));
        succeeds(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT], candidate.readerCli));
        const passed = events(project).filter(event => event.event_type === 'FULL_SUITE_VALIDATION_PASSED');
        assert.equal(passed.length, 1);
        assert.equal((passed[0].details as Record<string, unknown>).command, project.ownCommand);
        assert.deepEqual(fs.readFileSync(path.join(project.root, BUNDLE, `runtime/reviews/${TASK}-task-mode.json`)), entryBefore);
        const next = navigate(project, candidate.readerCli);
        assert.notEqual(next.status, 'ERROR', JSON.stringify(next));
        assert.doesNotMatch(routeText(next), /ask (?:the )?operator|unknown stack|unsupported stack/iu);
        assert.ok((next.commands as unknown[]).length, 'continuation must expose an executable next step');
    });
}

test('P4/T-441 §8.1,7: update refuses after an old failed test review', { timeout: 420_000 }, async () => {
    const project = createProject(root, old, 'failed-review');
    prepare(project);
    succeeds(select(project));
    succeeds(gate(project, 'compile-gate', ['--preflight-path', PREFLIGHT]));
    succeeds(gate(project, 'full-suite-validation', ['--preflight-path', PREFLIGHT]));
    succeeds(await review(project, 'code', 'PASS'));
    const failed = await review(project, 'test', 'FAIL');
    assert.doesNotMatch(failed.output, /GARDA_CLI_FAILED|REVIEW_RESULT_REFUSED/u);
    const recorded = events(project).filter(event => event.event_type === 'REVIEW_RECORDED');
    assert.equal(recorded.length, 2, 'both old review verdicts must come from native receipt publication');
    const failedRecord = recorded.find(event => (event.details as Record<string, unknown>).review_type === 'test')!;
    const failedDetails = failedRecord.details as { review_findings_disposition: { verdict: string }; review_artifact_sha256: string };
    assert.equal(failedDetails.review_findings_disposition.verdict, 'fail_for_fix_now', 'the old failed review must really be recorded');
    const failedArtifact = fs.readFileSync(path.join(project.root, BUNDLE, `runtime/reviews/${TASK}-test.md`));
    assert.equal(digest(failedArtifact), failedDetails.review_artifact_sha256);
    assertUpdateRefused(project, () => upgrade(project, candidate));
});

test('P4/T-450-1-F1: update refuses the owner accepted by native legacy entry', { timeout: 180_000 }, () => {
    const project = createProject(root, old, 'legacy-update', true);
    enter(project);
    assertUpdateRefused(project, () => upgrade(project, candidate));
});

test('P4: update refuses unknown active task discovery and explains how to recover', { timeout: 180_000 }, () => {
    const project = createProject(root, old, 'unknown-update');
    const queue = path.join(project.root, 'TASK.md');
    fs.renameSync(queue, path.join(project.root, 'original-task-queue.md'));
    fs.mkdirSync(queue);
    assertUpdateRefused(project, () => {
        const result = upgrade(project, candidate, ['check-update', '--apply']);
        assert.match(result.output, /task queue TASK[.]md.*not a regular single-link file/iu);
        assert.match(result.output, /Restore readable, project-local task state.*then run update again[.]/iu);
        return result;
    }, 'Active task discovery is unknown');
});
