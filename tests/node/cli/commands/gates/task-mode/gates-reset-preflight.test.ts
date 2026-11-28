import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import { appendTaskEvent, inspectTaskEventFile } from '../../../../../../src/gate-runtime/task-events';
import { createTempRepo, initializeGitRepo, removeTempRepoWithRetry } from '../../gate-test-repo-bootstrap';
import { appendPreflightClassifiedEvent, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask,
    runShellSmokeForTask, seedInitAnswers, seedTaskQueue, writePreflight } from '../../gate-test-seed-helpers';

const TASK_ID = 'T-RESET-STALE';
const CLI = path.resolve('bin/garda.js');
const PREFLIGHT = `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json`;
const RULE_PACK_ARGS = ['load-rule-pack', '--task-id', TASK_ID, '--preflight-path', PREFLIGHT,
    '--stage', 'POST_PREFLIGHT', ...['00-core.md', '15-project-memory.md', '30-code-style.md',
        '35-strict-coding-rules.md', '40-commands.md', '50-structure-and-docs.md', '70-security.md',
        '80-task-workflow.md', '90-skill-catalog.md']
        .flatMap(file => ['--loaded-rule-file', `garda-agent-orchestrator/live/docs/agent-rules/${file}`])];

function runCli(repoRoot: string, args: string[]) {
    const result = spawnSync(process.execPath, [CLI, 'gate', ...args, '--repo-root', repoRoot], {
        cwd: repoRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true
    });
    assert.ifError(result.error);
    return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function makeResetFixture(): { repoRoot: string; report: string } {
    const repoRoot = createTempRepo();
    seedInitAnswers(repoRoot);
    seedTaskQueue(repoRoot, TASK_ID);
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
    initializeGitRepo(repoRoot);
    assert.equal(runEnterTaskMode({ repoRoot, taskId: TASK_ID, taskSummary: 'Exercise stale preflight',
        plannedChangedFiles: ['src/app.ts'] }).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(repoRoot, TASK_ID).exitCode, 0);
    const preflight = path.join(repoRoot, PREFLIGHT);
    assert.equal(writePreflight(repoRoot, TASK_ID), preflight);
    appendPreflightClassifiedEvent(repoRoot, TASK_ID, preflight);
    const original = runCli(repoRoot, RULE_PACK_ARGS);
    assert.equal(original.code, 0, original.output);
    assert.match(original.output, /RULE_PACK_LOADED/u);
    const reset = runCli(repoRoot, ['task-reset', '--task-id', TASK_ID, '--reopen', '--confirm', '--one-action',
        '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
    assert.equal(reset.code, 0, reset.output);
    assert.match(reset.output, /RESET_COMPLETE/u);
    assert.equal(fs.existsSync(preflight), false);
    return { repoRoot, report: path.join(path.dirname(preflight), `${TASK_ID}-reset-report.json`) };
}

test('real CLI refuses commands naming a preflight removed by task reset', { timeout: 180_000 }, () => {
    const { repoRoot, report } = makeResetFixture();
    try {
        const reportBytes = fs.readFileSync(report);
        const taskBytes = fs.readFileSync(path.join(repoRoot, 'TASK.md'));
        const reviewsBefore = fs.readdirSync(path.dirname(report)).sort();
        const cases: Array<{ gate: string; args?: string[]; noTaskId?: boolean }> = [
            { gate: 'load-rule-pack', args: ['--stage', 'POST_PREFLIGHT', '--loaded-rule-file', 'garda-agent-orchestrator/live/docs/agent-rules/00-core.md'] },
            { gate: 'bind-rule-pack-to-preflight' },
            { gate: 'restart-coherent-cycle' },
            { gate: 'restart-review-cycle' },
            { gate: 'record-no-op', args: ['--classification', 'AUDIT_ONLY', '--reason', 'fixture'] },
            { gate: 'record-review-cycle-split-decision' },
            { gate: 'quality-checklist' },
            { gate: 'run-intermediate-command' },
            { gate: 'project-memory-impact' },
            { gate: 'compile-gate' },
            { gate: 'build-scoped-diff', args: ['--review-type', 'test'], noTaskId: true },
            { gate: 'build-review-context', args: ['--review-type', 'test', '--depth', '2'], noTaskId: true },
            { gate: 'required-reviews-check' },
            { gate: 'doc-impact-gate' },
            { gate: 'full-suite-validation' },
            { gate: 'full-suite-run-marker-recovery' },
            { gate: 'materialize-full-suite-repair-task' },
            { gate: 'record-review-result', args: ['--review-type', 'test'] },
            { gate: 'record-review-receipt', args: ['--review-type', 'test'] },
            { gate: 'completion-gate' }
        ];
        for (const [index, entry] of cases.entries()) {
            const preflightArgs = index % 2 ? [`--preflight-path=${PREFLIGHT}`] : ['--preflight-path', PREFLIGHT];
            const args = entry.gate === 'load-rule-pack' ? RULE_PACK_ARGS
                : [entry.gate, ...(entry.noTaskId ? [] : ['--task-id', TASK_ID]), ...preflightArgs, ...(entry.args || [])];
            const result = runCli(repoRoot, args);
            assert.equal(result.code, EXIT_GATE_FAILURE, `${entry.gate}: ${result.output}`);
            assert.match(result.output, new RegExp(`${entry.gate.toUpperCase().replace(/-/gu, '_')}_REFUSED`, 'u'));
            assert.match(result.output, /was reset.*preflight no longer exists.*missing/iu);
            assert.match(result.output, /Run next-step and follow the gate it names/iu);
            assert.match(result.output, /gate next-step.*--task-id/iu);
            assert.doesNotMatch(result.output, /Path not found:|GARDA_CLI_FAILED|SyntaxError/u);
        }
        assert.deepEqual(fs.readFileSync(report), reportBytes);
        assert.deepEqual(fs.readFileSync(path.join(repoRoot, 'TASK.md')), taskBytes);
        assert.deepEqual(fs.readdirSync(path.dirname(report)).sort(), reviewsBefore);
        const next = runCli(repoRoot, ['next-step', '--task-id', TASK_ID, '--preflight-path', PREFLIGHT]);
        assert.equal(next.code, 0, next.output);
        assert.doesNotMatch(next.output, /PREFLIGHT_RESET_REFUSED/u);
        const audit = runCli(repoRoot, ['task-audit-summary', '--task-id', TASK_ID, '--preflight-path', PREFLIGHT]);
        assert.doesNotMatch(audit.output, /TASK_AUDIT_SUMMARY_REFUSED/u);
    } finally {
        removeTempRepoWithRetry(repoRoot);
    }
});

test('real CLI gives the plain missing reason after re-entry and a recreated preflight is lost', { timeout: 180_000 }, () => {
    const { repoRoot, report } = makeResetFixture();
    try {
        const reportBytes = fs.readFileSync(report);
        const reentry = runCli(repoRoot, ['enter-task-mode', '--task-id', TASK_ID, '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
            '--task-summary', 'Exercise stale preflight', '--provider', 'Codex', '--routed-to', 'AGENTS.md',
            '--start-banner', 'Garda captures my mind', '--planned-changed-file', 'src/app.ts']);
        assert.equal(reentry.code, 0, reentry.output);
        const compileArgs = ['compile-gate', '--task-id', TASK_ID, '--preflight-path', PREFLIGHT];
        const taskMode = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews', `${TASK_ID}-task-mode.json`);
        const savedTaskMode = `${taskMode}.saved`;
        fs.renameSync(taskMode, savedTaskMode);
        const afterEntry = runCli(repoRoot, compileArgs);
        fs.renameSync(savedTaskMode, taskMode);
        assert.equal(loadTaskEntryRulePack(repoRoot, TASK_ID).exitCode, 0);
        runHandshakeForTask(repoRoot, TASK_ID);
        runShellSmokeForTask(repoRoot, TASK_ID);
        const classify = runCli(repoRoot, ['classify-change', '--task-id', TASK_ID, '--task-intent', 'Exercise stale preflight',
            '--changed-file', 'src/app.ts', '--output-path', PREFLIGHT]);
        assert.equal(classify.code, 0, classify.output);
        const preflight = path.join(repoRoot, PREFLIGHT);
        assert.equal(fs.existsSync(preflight), true);
        fs.unlinkSync(preflight);

        const missing = runCli(repoRoot, compileArgs);
        assert.equal(missing.code, EXIT_GATE_FAILURE, missing.output);
        assert.match(missing.output, /COMPILE_GATE_REFUSED/u);
        assert.match(missing.output, /preflight is missing.*Run next-step/isu);
        assert.match(missing.output, /gate next-step.*--task-id/iu);
        assert.doesNotMatch(missing.output, /was reset/iu);
        assert.equal(afterEntry.code, EXIT_GATE_FAILURE, afterEntry.output);
        assert.match(afterEntry.output, /preflight is missing.*Run next-step/isu);
        assert.doesNotMatch(afterEntry.output, /was reset/iu);
        const timeline = path.join(repoRoot, 'garda-agent-orchestrator/runtime/task-events', `${TASK_ID}.jsonl`);
        const eventTypes: unknown[] = [];
        const inspection = inspectTaskEventFile(timeline, TASK_ID, {
            onIntegrityEvent: event => { eventTypes.push(event.event_type); }
        });
        assert.equal(inspection.status, 'PASS');
        assert.ok(eventTypes.includes('TASK_MODE_ENTERED'));
        assert.ok(eventTypes.includes('PREFLIGHT_CLASSIFIED'));
        const timelineBytes = fs.readFileSync(timeline);
        fs.unlinkSync(timeline);
        const withoutTimeline = runCli(repoRoot, compileArgs);
        assert.equal(withoutTimeline.code, EXIT_GATE_FAILURE, withoutTimeline.output);
        assert.match(withoutTimeline.output, /preflight is missing/iu);
        assert.doesNotMatch(withoutTimeline.output, /was reset/iu);
        fs.writeFileSync(timeline, timelineBytes);
        assert.deepEqual(fs.readFileSync(report), reportBytes);
    } finally {
        removeTempRepoWithRetry(repoRoot);
    }
});

test('reset attribution checks authenticated timeline events and fails closed on damaged history', { timeout: 90_000 }, () => {
    const { repoRoot } = makeResetFixture();
    try {
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const timeline = path.join(orchestratorRoot, 'runtime/task-events', `${TASK_ID}.jsonl`);
        const compileArgs = ['compile-gate', '--task-id', TASK_ID, '--preflight-path', PREFLIGHT];
        appendTaskEvent(orchestratorRoot, TASK_ID, 'NOTE', 'INFO', 'Unrelated event after reset', {});
        const unrelated = runCli(repoRoot, compileArgs);
        assert.equal(unrelated.code, EXIT_GATE_FAILURE, unrelated.output);
        assert.match(unrelated.output, /was reset/iu);
        appendTaskEvent(orchestratorRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', 'New classification', {
            output_path: path.join(repoRoot, PREFLIGHT).replace(/\\/gu, '/')
        });
        const classified = runCli(repoRoot, compileArgs);
        assert.equal(classified.code, EXIT_GATE_FAILURE, classified.output);
        assert.match(classified.output, /preflight is missing.*Run next-step/isu);
        assert.doesNotMatch(classified.output, /was reset/iu);

        fs.writeFileSync(timeline, '{broken json\n');
        const damaged = runCli(repoRoot, compileArgs);
        assert.equal(damaged.code, EXIT_GATE_FAILURE, damaged.output);
        assert.match(damaged.output, /preflight is missing.*Run next-step/isu);
        assert.doesNotMatch(damaged.output, /was reset/iu);
    } finally {
        removeTempRepoWithRetry(repoRoot);
    }
});

test('reset refusal requires the matching removed artifact and preserves normal CLI validation', { timeout: 90_000 }, () => {
    const { repoRoot, report } = makeResetFixture();
    try {
        const common = ['load-rule-pack', '--task-id', TASK_ID, '--stage', 'POST_PREFLIGHT'];
        const unrelated = runCli(repoRoot, [...common, '--preflight-path', 'garda-agent-orchestrator/runtime/reviews/T-OTHER-preflight.json']);
        assert.equal(unrelated.code, EXIT_GATE_FAILURE, unrelated.output);
        assert.match(unrelated.output, /preflight is missing.*Run next-step/isu);
        assert.doesNotMatch(unrelated.output, /was reset/iu);
        const mismatch = runCli(repoRoot, ['load-rule-pack', '--task-id', 'T-OTHER', '--stage', 'POST_PREFLIGHT', '--preflight-path', PREFLIGHT]);
        assert.doesNotMatch(mismatch.output, /was reset/iu);
        const unknown = runCli(repoRoot, [...common, '--preflight-path', PREFLIGHT, '--unknown-option', 'x']);
        assert.match(unknown.output, /Unknown option/iu);
        const escape = runCli(repoRoot, [...common, '--preflight-path', '../outside-preflight.json']);
        assert.match(escape.output, /inside repo root|inside workspace root/iu);

        const originalReport = fs.readFileSync(report, 'utf8');
        const reportData = JSON.parse(originalReport) as { removed_artifacts: string[] };
        reportData.removed_artifacts = [];
        fs.writeFileSync(report, JSON.stringify(reportData));
        const noMatch = runCli(repoRoot, [...common, '--preflight-path', PREFLIGHT]);
        assert.equal(noMatch.code, EXIT_GATE_FAILURE, noMatch.output);
        assert.match(noMatch.output, /preflight is missing.*Run next-step/isu);
        assert.doesNotMatch(noMatch.output, /was reset/iu);
        const noTaskId = runCli(repoRoot, ['build-scoped-diff', '--review-type', 'test', '--preflight-path', 'missing.json']);
        assert.equal(noTaskId.code, EXIT_GATE_FAILURE, noTaskId.output);
        assert.match(noTaskId.output, /preflight is missing.*next-step.*<task-id>/isu);

        fs.writeFileSync(report, originalReport);
        fs.writeFileSync(path.join(repoRoot, PREFLIGHT), '{}');
        const recreated = runCli(repoRoot, ['bind-rule-pack-to-preflight', '--task-id', TASK_ID, '--preflight-path', PREFLIGHT]);
        assert.doesNotMatch(recreated.output, /was reset/iu);
        assert.match(recreated.output, /RULE_PACK_BIND_FAILED/u);
    } finally {
        removeTempRepoWithRetry(repoRoot);
    }
});
