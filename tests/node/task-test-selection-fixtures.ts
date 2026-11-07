import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validationDigest } from '../../src/core/project-validation-identity';
import { taskValidationLiteralAssociation } from '../../src/core/task-validation-plan';
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
    if (!fs.existsSync(path.join(repoRoot, 'tests'))) {
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests/fixture-task-validation.test.cjs'),
            "require('node:test').test('fixture regression input', () => {});\n");
    }
    const planned = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const plannedFiles = Array.isArray(planned.changed_files) && planned.changed_files.length
        ? planned.changed_files.map(String) : ['tests/fixture-task-validation.test.cjs'];
    const entered = runEnterTaskMode({ repoRoot, taskId, provider: 'Codex', requestedDepth: 3, plannedChangedFiles: plannedFiles,
        taskSummary: 'Validate the full-suite evidence contract for this fixture task.' });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    const legacyPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    if (!Array.isArray(legacyPreflight.changed_files) || !legacyPreflight.changed_files.length) {
        legacyPreflight.changed_files = ['tests/fixture-task-validation.test.cjs'];
        fs.writeFileSync(preflightPath, JSON.stringify(legacyPreflight));
    }
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
    const targets = [...getChangedTestPaths(repoRoot, Array.isArray(preflight.changed_files) ? preflight.changed_files.map(String) : [])];
    // Routing/receipt fixtures use stub project commands. Declare their concrete regression
    // input and symbolic entrypoint just as an agent must under the generic contract.
    if (!targets.length) {
        // Prefer the real test/script input already used by this fixture's command.
        for (const token of parseCommandChain(config.command).flat().slice(1)) {
            const candidate = path.relative(repoRoot, path.resolve(repoRoot, token)).replace(/\\/gu, '/');
            if (!candidate.startsWith('../') && !path.isAbsolute(candidate)
                && fs.existsSync(path.join(repoRoot, candidate)) && fs.statSync(path.join(repoRoot, candidate)).isFile())
                targets.push(candidate);
        }
    }
    if (!targets.length && fs.existsSync(path.join(repoRoot, 'tests'))) {
        const existing = fs.readdirSync(path.join(repoRoot, 'tests'), { recursive: true })
            .map(String).map(file => `tests/${file.replace(/\\/gu, '/')}`);
        targets.push(...getChangedTestPaths(repoRoot, existing).slice(0, 1));
    }
    if (!targets.length && fs.existsSync(path.join(repoRoot, 'tests/fixture-task-validation.test.cjs')))
        targets.push('tests/fixture-task-validation.test.cjs');
    assert.ok(targets.length, 'Seed a concrete fixture test input before task/preflight capture.');
    const taskMode = JSON.parse(fs.readFileSync(path.join(repoRoot,
        'garda-agent-orchestrator/runtime/reviews', `${taskId}-task-mode.json`), 'utf8')) as Record<string, unknown>;
    const taskFiles = [...new Set([...(Array.isArray(preflight.changed_files) ? preflight.changed_files.map(String) : []),
        ...(Array.isArray(taskMode.planned_changed_files) ? taskMode.planned_changed_files.map(String) : [])])];
    const reason = `${taskId}: ${targets.join(', ')} verifies the fixture task behavior in ${taskFiles.join(', ')}.`;
    const plan = { targets: targets.flatMap(target =>
        parseCommandChain(config.command).map((argv, invocation) => ({ path: target, invocation,
            ...(taskValidationLiteralAssociation(argv, target) ? {} : { entrypoint: argv[0] }), reason }))) };
    const command = buildTaskTestSelectionCommand('garda', taskId, targets, false);
    // Substitute parsed argv values: a quoted executable inside the test command must
    // remain one --full-suite-command value, including Windows paths containing spaces.
    const args = parseCommandChain(command)[0].slice(1).map(arg => arg
        .replace('<command that runs only this task\'s tests and required regressions>', config.command)
        .replace('<task behavior and regression relationships>', reason));
    args.push('--task-test-plan', JSON.stringify(plan));
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
    preflight.authorized_files = snapshot.authorized_files;
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

/** Process facts for isolated routing fixtures; admission still uses the real workflow command. */
export function fixtureTaskTestProcessEvidence(repoRoot: string, taskId: string, artifact: Record<string, unknown>): Record<string, unknown> {
    const plan = loadTaskFullSuiteConfig(repoRoot, taskId).selection.plan;
    if (!plan || artifact.status === 'SKIPPED') return {};
    const cycle = artifact.cycle_binding as Record<string, unknown> | undefined;
    const scope = validationDigest([cycle?.scope_binding, plan]);
    const now = new Date(Math.max(Date.now(), Date.parse(plan.binding!.selected_at))).toISOString();
    return { task_test_validation_plan: plan, task_test_process_evidence: { schema_version: 1, selection_sha256: validationDigest(plan),
        invocations: plan.descriptor.invocations.map((invocation, index) => ({ execution_id: randomUUID(),
            invocation: index, ...invocation, cwd: plan.binding!.workspace_root,
            started_at: now, completed_at: now, exit_code: artifact.exit_code,
            timed_out: artifact.timed_out === true, cancelled: false,
            output_sha256: validationDigest('fixture output'), scope_before: scope, scope_after: scope })) } };
}

/** Bind explicitly seeded routing evidence without repairing any existing process record. */
export function bindFixtureFullSuiteArtifact(repoRoot: string, taskId: string): Record<string, unknown> {
    const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews', `${taskId}-full-suite-validation.json`);
    if (!fs.existsSync(artifactPath)) return {};
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    if (artifact.task_test_process_evidence === undefined) {
        const process = fixtureTaskTestProcessEvidence(repoRoot, taskId, artifact);
        if (Object.keys(process).length) fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, ...process }, null, 2));
    }
    return { artifact_path: artifactPath.replace(/\\/gu, '/'), artifact_sha256: fileSha256(artifactPath),
        command: artifact.command, placement: artifact.placement, cycle_binding: artifact.cycle_binding, timeout_policy: artifact.timeout_policy };
}

export function recordFixtureFullSuiteArtifact(repoRoot: string, taskId: string): void {
    const details = bindFixtureFullSuiteArtifact(repoRoot, taskId);
    const artifact = JSON.parse(fs.readFileSync(String(details.artifact_path), 'utf8')) as Record<string, unknown>;
    const bundle = path.join(repoRoot, 'garda-agent-orchestrator');
    const timelinePath = path.join(bundle, 'runtime/task-events', `${taskId}.jsonl`);
    const entries = fs.readFileSync(timelinePath, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);
    const latest = [...entries].reverse().find(event => /^FULL_SUITE_VALIDATION_(?:PASSED|WARNED|FAILED|SKIPPED)$/u.test(String(event.event_type)));
    if (latest?.event_type === `FULL_SUITE_VALIDATION_${artifact.status}`
        && (latest.details as Record<string, unknown> | undefined)?.artifact_sha256 === details.artifact_sha256) return;
    appendMandatoryTaskEvent(bundle, taskId, `FULL_SUITE_VALIDATION_${artifact.status}`,
        artifact.status === 'WARNED' ? 'WARN' : artifact.status === 'FAILED' ? 'FAIL' : 'PASS',
        'Fixture execution bound to its declared task plan.', details);
}
