import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleWorkflow } from '../../src/cli/commands/workflow-command';
import { runFullSuiteValidationCommand } from '../../src/cli/commands/gate-flows/full-suite/full-suite-validation-flow';
import { loadFullSuiteValidationConfig } from '../../src/core/full-suite-validation-config';
import { getChangedTestPaths } from '../../src/gates/full-suite/full-suite-test-selection';
import { isFullSuiteNotRequiredForDocsOnlyScope } from '../../src/gates/full-suite/full-suite-validation';
import { loadTaskFullSuiteConfig } from '../../src/gates/full-suite/task-full-suite-config';
import { buildTaskTestSelectionCommand } from '../../src/gates/next-step/next-step-full-suite-routing';
import { parseCommandChain } from '../../src/core/command-line';
import { getWorkspaceSnapshot } from '../../src/gates/compile/compile-gate';
import { appendMandatoryTaskEvent, buildEventIntegrityHash } from '../../src/gate-runtime/task-events';
import { fileSha256 } from '../../src/gate-runtime/hash';
import { runEnterTaskMode, seedInitAnswers, seedTaskQueue, writeBalancedProfilesConfig } from './cli/commands/gate-test-seed-helpers';
import { parseCanonicalActiveTaskQueue, replaceTaskMdTableCell } from '../../src/core/task-md-table';

/** A started-task fixture represents an active queue row, as native task entry would publish it. */
export function activateStartedFixtureTask(repoRoot: string, taskId: string): void {
    const queuePath = path.join(repoRoot, 'TASK.md');
    const text = fs.readFileSync(queuePath, 'utf8');
    const row = parseCanonicalActiveTaskQueue(text).rows.find(row => row.taskId === taskId);
    if (row?.status === 'TODO') {
        fs.writeFileSync(queuePath, text.replace(row.rawLine, replaceTaskMdTableCell(row.rawLine, 1, 'IN_PROGRESS')!));
    }
}

/** Upgrade a positive legacy artifact fixture to native task entry and selection evidence. */
export function admitLegacyFullSuiteFixture(repoRoot: string, taskId: string, preflightPath: string): void {
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const timeline = path.join(bundleRoot, 'runtime/task-events', `${taskId}.jsonl`);
    const prior = fs.existsSync(timeline) ? fs.readFileSync(timeline, 'utf8').trim().split('\n')
        .filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [];
    assert.ok(prior.every(event => event.event_type === 'COMPILE_GATE_PASSED' && !event.integrity),
        'Legacy admission only upgrades unbound positive compile fixtures.');
    // These fixtures contained only unbound compile observations. Recreate those after native admission.
    fs.mkdirSync(path.dirname(timeline), { recursive: true });
    fs.writeFileSync(timeline, '');
    if (!fs.existsSync(path.join(repoRoot, 'TASK.md'))) seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot, 'Codex');
    const profilesPath = path.join(bundleRoot, 'live/config/profiles.json');
    if (!fs.existsSync(profilesPath)) writeBalancedProfilesConfig(repoRoot);
    const legacyMode = path.join(bundleRoot, 'runtime/reviews', `${taskId}-task-mode.json`);
    if (fs.existsSync(legacyMode)) fs.unlinkSync(legacyMode);
    const entered = runEnterTaskMode({ repoRoot, taskId, provider: 'Codex', requestedDepth: 3,
        taskSummary: 'Validate the full-suite evidence contract for this fixture task.' });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    prepareFixtureTaskTestSelection(repoRoot, taskId, preflightPath);
    for (const event of prior.filter(event => event.event_type === 'COMPILE_GATE_PASSED')) {
        appendFixtureCompileEvent(repoRoot, taskId, String(event.timestamp_utc), event.details || {});
    }
}

export function appendFixtureCompileEvent(repoRoot: string, taskId: string, timestamp: string, details: unknown = {}): void {
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const timeline = path.join(bundleRoot, 'runtime/task-events', `${taskId}.jsonl`);
    appendMandatoryTaskEvent(bundleRoot, taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Fixture compile passed.', details);
    const lines = fs.readFileSync(timeline, 'utf8').trim().split('\n');
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    last.timestamp_utc = timestamp;
    (last.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(last);
    lines[lines.length - 1] = JSON.stringify(last);
    fs.writeFileSync(timeline, lines.join('\n') + '\n');
}

/** A fixture agent consciously keeps its configured command through the public workflow route. */
export function selectConfiguredTaskTests(repoRoot: string, taskId: string, preflightPath = path.join(
    repoRoot, 'garda-agent-orchestrator/runtime/reviews', `${taskId}-preflight.json`
)): void {
    const config = loadFullSuiteValidationConfig(repoRoot);
    if (!config.enabled) return;
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    if (isFullSuiteNotRequiredForDocsOnlyScope(preflight)) return;
    const selected = loadTaskFullSuiteConfig(repoRoot, taskId).selection;
    if (selected.status === 'current' && selected.command === config.command) return;
    const targets = getChangedTestPaths(repoRoot, Array.isArray(preflight.changed_files) ? preflight.changed_files.map(String) : []);
    const command = buildTaskTestSelectionCommand('garda', taskId, targets, false, config.command)
        .replace('<task behavior and regression relationships>', 'the current task behavior and acceptance criteria');
    const args = parseCommandChain(command)[0].slice(1);
    const previousCwd = process.cwd();
    const log = console.log;
    try {
        process.chdir(repoRoot);
        console.log = () => undefined;
        const result = handleWorkflow(args.slice(1), { name: 'garda-agent-orchestrator', version: '1.4.4' });
        assert.ok(result, `Task test selection did not run: ${command}`);
        assert.equal(loadTaskFullSuiteConfig(repoRoot, taskId).selection.status, 'current');
    } finally {
        console.log = log;
        process.chdir(previousCwd);
    }
}

/** Give older hand-built preflights the native scope and event binding required by selection. */
export function prepareFixtureTaskTestSelection(repoRoot: string, taskId: string, preflightPath: string): void {
    if (!loadFullSuiteValidationConfig(repoRoot).enabled) return;
    if (loadTaskFullSuiteConfig(repoRoot, taskId).selection.status === 'current') return;
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const files = Array.isArray(preflight.changed_files) ? preflight.changed_files.map(String) : [];
    const source = String(preflight.detection_source || 'explicit_changed_files');
    const snapshot = getWorkspaceSnapshot(repoRoot, source, preflight.include_untracked !== false, files);
    preflight.detection_source = source;
    preflight.changed_files = snapshot.changed_files;
    preflight.metrics = { ...(preflight.metrics as Record<string, unknown>),
        changed_lines_total: snapshot.changed_lines_total, changed_files_sha256: snapshot.changed_files_sha256,
        scope_sha256: snapshot.scope_sha256, scope_content_sha256: snapshot.scope_content_sha256 };
    fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2));
    recordFixturePreflightClassification(repoRoot, taskId, preflightPath);
    selectConfiguredTaskTests(repoRoot, taskId, preflightPath);
}

/** Bind the exact seeded bytes, including intentional formatting, before the real selector reads them. */
export function recordFixturePreflightClassification(repoRoot: string, taskId: string, preflightPath: string): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics as Record<string, unknown>;
    appendMandatoryTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO',
        'Fixture agent classified the current task before selecting tests.', {
            output_path: preflightPath.replace(/\\/gu, '/'), output_sha256: fileSha256(preflightPath),
            scope_sha256: metrics.scope_sha256, scope_content_sha256: metrics.scope_content_sha256,
            effective_review_snapshot: preflight.effective_review_snapshot
        });
}

/** Legacy execution fixtures also perform the newly mandatory admission step. */
export async function runFullSuiteValidationWithSelection(
    options: Parameters<typeof runFullSuiteValidationCommand>[0]
): ReturnType<typeof runFullSuiteValidationCommand> {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const taskId = String(options.taskId);
    if (loadTaskFullSuiteConfig(repoRoot, taskId).selection.status !== 'current') {
        selectConfiguredTaskTests(repoRoot, taskId, typeof options.preflightPath === 'string' ? options.preflightPath : undefined);
    }
    return runFullSuiteValidationCommand(options);
}
