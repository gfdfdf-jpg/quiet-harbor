import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import {
    createTempRepo, getReviewsRoot, initializeGitRepo, loadTaskEntryRulePack,
    runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue
} from './gates-preflight-fixtures';

const TASK_ID = 'T-CORRUPT-TASK-EVIDENCE';
const CLI = path.resolve('bin/garda.js');

function runCli(repoRoot: string, args: string[]) {
    const result = spawnSync(process.execPath, [CLI, 'gate', ...args, '--repo-root', repoRoot], {
        cwd: repoRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true
    });
    assert.ifError(result.error);
    return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function fixture(): string {
    const repoRoot = createTempRepo();
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
    seedInitAnswers(repoRoot);
    initializeGitRepo(repoRoot);
    seedTaskQueue(repoRoot, TASK_ID);
    const entry = runEnterTaskMode({ repoRoot, taskId: TASK_ID, taskSummary: 'Update app flow',
        plannedChangedFiles: ['src/app.ts'] });
    assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
    assert.equal(loadTaskEntryRulePack(repoRoot, TASK_ID).exitCode, 0);
    runHandshakeForTask(repoRoot, TASK_ID);
    return repoRoot;
}

test('real CLI refuses corrupt preflight for downstream gates and next-step selects recovery', { timeout: 300_000 }, () => {
    const repoRoot = fixture();
    try {
        runShellSmokeForTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src/app.ts'), '\nexport const changed = true;\n');
        const preflight = path.join(getReviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Update app flow',
            changedFiles: ['src/app.ts'], outputPath: preflight, emitMetrics: false });
        const cases = [
            { gate: 'load-rule-pack', args: ['--stage', 'POST_PREFLIGHT', '--loaded-rule-file', 'garda-agent-orchestrator/live/docs/agent-rules/00-core.md'] },
            { gate: 'bind-rule-pack-to-preflight' },
            { gate: 'restart-coherent-cycle' }, { gate: 'restart-review-cycle' },
            { gate: 'record-no-op', args: ['--classification', 'AUDIT_ONLY', '--reason', 'fixture'] },
            { gate: 'quality-checklist' }, { gate: 'run-intermediate-command' }, { gate: 'project-memory-impact' },
            { gate: 'compile-gate' }, { gate: 'build-scoped-diff', noTaskId: true, args: ['--review-type', 'test'] },
            { gate: 'build-review-context', noTaskId: true, args: ['--review-type', 'test', '--depth', '2'] },
            { gate: 'required-reviews-check' }, { gate: 'doc-impact-gate' }, { gate: 'full-suite-validation' },
            { gate: 'full-suite-run-marker-recovery' }, { gate: 'record-review-result', args: ['--review-type', 'test'] },
            { gate: 'record-review-receipt', args: ['--review-type', 'test'] }, { gate: 'completion-gate' }
        ];
        for (const content of ['{broken', 'null', '[]']) {
            fs.writeFileSync(preflight, content);
            const selectedCases = content === '{broken' ? cases
                : cases.filter(entry => ['compile-gate', 'doc-impact-gate', 'full-suite-validation'].includes(entry.gate));
            for (const entry of selectedCases) {
                const result = runCli(repoRoot, [entry.gate, ...('noTaskId' in entry ? [] : ['--task-id', TASK_ID]),
                    '--preflight-path', preflight, ...(entry.args ?? [])]);
                assert.equal(result.code, EXIT_GATE_FAILURE, `${entry.gate}: ${result.output}`);
                assert.match(result.output, new RegExp(`${entry.gate.toUpperCase().replace(/-/gu, '_')}_REFUSED`, 'u'));
                assert.match(result.output, /corrupt.*Nothing was changed[\s\S]*Run next-step/iu);
                assert.doesNotMatch(result.output, /SyntaxError|GARDA_CLI_FAILED|TypeError/u);
                assert.equal(fs.readFileSync(preflight, 'utf8'), content);
            }
            const implicitGates = content === '{broken'
                ? ['compile-gate', 'quality-checklist', 'restart-coherent-cycle', 'restart-review-cycle'] : ['compile-gate'];
            for (const gate of implicitGates) {
                const result = runCli(repoRoot, [gate, '--task-id', TASK_ID]);
                assert.equal(result.code, EXIT_GATE_FAILURE, `${gate} default path: ${result.output}`);
                assert.match(result.output, new RegExp(`${gate.toUpperCase().replace(/-/gu, '_')}_REFUSED`, 'u'));
                assert.match(result.output, /corrupt.*Run next-step/isu);
            }
            if (content === '{broken') {
                for (const gate of ['record-review-routing', 'prepare-reviewer-launch', 'record-review-invocation',
                    'record-reviewer-delegation-started', 'record-reviewer-launch-failed', 'complete-reviewer-launch']) {
                    const result = runCli(repoRoot, [gate, '--task-id', TASK_ID, '--review-type', 'code']);
                    assert.equal(result.code, EXIT_GATE_FAILURE, `${gate} default path: ${result.output}`);
                    assert.match(result.output, new RegExp(`${gate.toUpperCase().replace(/-/gu, '_')}_REFUSED`, 'u'));
                    assert.match(result.output, /corrupt.*Nothing was changed[\s\S]*Run next-step/iu);
                }
            }
            const next = runCli(repoRoot, ['next-step', '--task-id', TASK_ID, '--preflight-path', preflight, '--as-json']);
            assert.equal(next.code, 0, next.output);
            const decision = JSON.parse(next.output) as { next_gate: string; reason: string };
            assert.equal(decision.next_gate, 'classify-change', decision.reason);
        }
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

interface Decision { status: string; next_gate: string; reason: string; commands: Array<{ command: string }> }

function nextStep(repoRoot: string): Decision {
    const next = runCli(repoRoot, ['next-step', '--task-id', TASK_ID, '--as-json']);
    assert.equal(next.code, 0, next.output);
    return JSON.parse(next.output) as Decision;
}

function damageHandshake(handshake: string, content: string | null): void {
    if (content === null) fs.rmSync(handshake);
    else fs.writeFileSync(handshake, content);
}

// The restart cannot read a corrupt preflight, but the preflight is classified again anyway: Garda rebuilds the startup
// evidence through the real gates first, so classify-change publishes the preflight after it and no command is missing.
test('lost startup and corrupt preflight rebuild startup evidence before classifying the preflight again', { timeout: 300_000 }, () => {
    const repoRoot = fixture();
    try {
        // The real handshake gate checks the shared start-task router.
        fs.appendFileSync(path.join(repoRoot, '.git', 'info', 'exclude'), '.agents/\n');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# Start task\n');
        runShellSmokeForTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src/app.ts'), '\nexport const changed = true;\n');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflight = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const snapshot = path.join(reviewsRoot, `${TASK_ID}-preflight-snapshot.json`);
        runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Update app flow',
            changedFiles: ['src/app.ts'], outputPath: preflight, emitMetrics: false });
        fs.writeFileSync(preflight, '{broken');
        fs.writeFileSync(path.join(reviewsRoot, `${TASK_ID}-handshake.json`), '{broken');
        const decision = nextStep(repoRoot);
        assert.equal(decision.next_gate, 'handshake-diagnostics', decision.reason);
        assert.match(decision.reason, /classified preflight is lost too and is classified again after it/u);
        assert.doesNotMatch(decision.reason, /task-reset|restore the original/u);
        assert.equal(decision.commands.length, 1);
        assert.match(decision.commands[0].command, /gate handshake-diagnostics/u);
        // Nothing is repaired silently: the corrupt preflight stays until classify-change replaces it.
        assert.equal(fs.readFileSync(preflight, 'utf8'), '{broken');
        assert.ok(fs.existsSync(snapshot));
        const rerun = runCli(repoRoot, ['handshake-diagnostics', '--task-id', TASK_ID]);
        assert.equal(rerun.code, 0, rerun.output);
        assert.equal(nextStep(repoRoot).next_gate, 'shell-smoke-preflight');
        runShellSmokeForTask(repoRoot, TASK_ID);
        assert.equal(nextStep(repoRoot).next_gate, 'classify-change');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

// Operator decision 2026-11-04: lost or corrupt startup evidence binds no review. Before preflight Garda repeats the
// startup checks through the real gates (new evidence, new authenticated events) instead of asking for task-reset.
test('real CLI rebuilds lost or corrupt handshake evidence before preflight through the startup gates', { timeout: 300_000 }, () => {
    for (const smokeFirst of [false, true]) {
        for (const content of ['{broken', 'null', '[]', null]) {
            const label = `${smokeFirst ? 'after' : 'before'} shell smoke, ${content === null ? 'deleted' : content}`;
            const repoRoot = fixture();
            try {
                // The real handshake gate rebuilds the evidence; it checks the shared start-task router.
                fs.appendFileSync(path.join(repoRoot, '.git', 'info', 'exclude'), '.agents/\n');
                fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# Start task\n');
                if (smokeFirst) runShellSmokeForTask(repoRoot, TASK_ID);
                const handshake = path.join(getReviewsRoot(repoRoot), `${TASK_ID}-handshake.json`);
                damageHandshake(handshake, content);
                if (!smokeFirst) {
                    const smoke = runCli(repoRoot, ['shell-smoke-preflight', '--task-id', TASK_ID]);
                    assert.equal(smoke.code, EXIT_GATE_FAILURE, smoke.output);
                    assert.match(smoke.output,
                        /Handshake diagnostics evidence (?:is invalid JSON|is not a JSON object|missing)/u, label);
                }
                const recovery = nextStep(repoRoot);
                assert.equal(recovery.status, 'BLOCKED', label);
                assert.equal(recovery.next_gate, 'handshake-diagnostics', `${label}: ${recovery.reason}`);
                assert.doesNotMatch(recovery.reason, /task-reset/u, label);
                assert.equal(recovery.commands.length, 1, label);
                assert.match(recovery.commands[0].command, /gate handshake-diagnostics/u, label);
                if (smokeFirst) {
                    // The gate the walk would have run refuses with the same route and exact commands.
                    const classify = runCli(repoRoot, ['classify-change', '--task-id', TASK_ID, '--changed-file', 'src/app.ts',
                        '--task-intent', 'Update app flow']);
                    assert.notEqual(classify.code, 0, classify.output);
                    assert.doesNotMatch(classify.output, /SyntaxError|TypeError/u);
                    assert.match(classify.output, /Run handshake-diagnostics again, then shell-smoke-preflight[\s\S]*gate handshake-diagnostics/u);
                    assert.doesNotMatch(classify.output, /task-reset/u, label);
                }

                const rerun = runCli(repoRoot, ['handshake-diagnostics', '--task-id', TASK_ID]);
                assert.equal(rerun.code, 0, `${label}: ${rerun.output}`);
                assert.notEqual(fs.readFileSync(handshake, 'utf8'), content, label);
                assert.equal(nextStep(repoRoot).next_gate, 'shell-smoke-preflight', label);
                // This fixture is not a materialized bundle, so the real shell-smoke probes cannot pass here; the fixture
                // records a passed shell smoke bound to the new handshake (the walk test drives the real gate).
                runShellSmokeForTask(repoRoot, TASK_ID);
                assert.equal(nextStep(repoRoot).next_gate, 'classify-change', label);
            } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
        }
    }
});

test('real CLI keeps the operator handoff when the task timeline cannot prove the startup sequence', { timeout: 120_000 }, () => {
    const repoRoot = fixture();
    try {
        runShellSmokeForTask(repoRoot, TASK_ID);
        const handshake = path.join(getReviewsRoot(repoRoot), `${TASK_ID}-handshake.json`);
        fs.writeFileSync(handshake, '{broken');
        // Rewrite the authenticated handshake event in place: the timeline no longer verifies.
        const timeline = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${TASK_ID}.jsonl`);
        const lines = fs.readFileSync(timeline, 'utf8').split(/\n/u);
        const index = lines.findIndex(line => line.includes('"HANDSHAKE_DIAGNOSTICS_RECORDED"'));
        assert.ok(index >= 0);
        lines[index] = lines[index].replace('Handshake diagnostics passed', 'Handshake diagnostics passed (edited)');
        fs.writeFileSync(timeline, lines.join('\n'));
        const decision = nextStep(repoRoot);
        assert.equal(decision.status, 'BLOCKED');
        // Edited authenticated history stops every append, so the integrity handoff comes before the startup route.
        assert.equal(decision.next_gate, 'task-reset', decision.reason);
        assert.match(decision.reason, /Authenticated task history changed[\s\S]*restore the authentic timeline[\s\S]*reset the task/iu);
        // The operator handoff still names an executable command: the side-effect-free reset preview.
        assert.equal(decision.commands.length, 1);
        assert.match(decision.commands[0].command, /gate task-reset --task-id "[^"]+" --reopen --dry-run/u);
        assert.equal(fs.readFileSync(handshake, 'utf8'), '{broken');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

// A restart for lost startup evidence after classification reclassifies with the intent the current preflight was
// classified with, not the task-mode summary: an unchanged intent keeps the task-criteria binding of passed reviews.
test('real CLI names the classified task intent in every restart command for lost startup evidence', { timeout: 300_000 }, () => {
    const repoRoot = createTempRepo();
    try {
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, TASK_ID);
        const entry = runEnterTaskMode({ repoRoot, taskId: TASK_ID, taskSummary: 'Implement the app flow change',
            plannedChangedFiles: ['src/app.ts'] });
        assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
        assert.equal(loadTaskEntryRulePack(repoRoot, TASK_ID).exitCode, 0);
        runHandshakeForTask(repoRoot, TASK_ID);
        runShellSmokeForTask(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src/app.ts'), '\nexport const changed = true;\n');
        const preflight = path.join(getReviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        runClassifyChangeCommand({ repoRoot, taskId: TASK_ID, taskIntent: 'Update app flow',
            changedFiles: ['src/app.ts'], outputPath: preflight, emitMetrics: false });
        fs.rmSync(path.join(getReviewsRoot(repoRoot), `${TASK_ID}-handshake.json`));
        const restart = /gate restart-coherent-cycle[^\n]*--task-intent ['"]Update app flow['"]/u;
        // classify-change prints the command through the same startup-evidence check compile-gate uses.
        const classify = runCli(repoRoot, ['classify-change', '--task-id', TASK_ID, '--changed-file', 'src/app.ts',
            '--task-intent', 'Update app flow']);
        assert.notEqual(classify.code, 0, classify.output);
        assert.match(classify.output, restart, classify.output);
        assert.doesNotMatch(classify.output, /Implement the app flow change/u);
        const decision = nextStep(repoRoot);
        assert.equal(decision.next_gate, 'restart-coherent-cycle', decision.reason);
        assert.match(decision.commands[0].command, restart);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

// One unparseable timeline line makes every append refuse. next-step names that exact line and an executable command
// instead of looping on effects; once the operator removes only that line, routing resumes from intact history.
test('real CLI hands an unparseable task timeline line to the operator with an executable command', { timeout: 300_000 }, () => {
    const repoRoot = fixture();
    try {
        runShellSmokeForTask(repoRoot, TASK_ID);
        const timeline = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${TASK_ID}.jsonl`);
        const intact = fs.readFileSync(timeline, 'utf8');
        const before = nextStep(repoRoot);
        fs.appendFileSync(timeline, '{torn\n');
        const line = intact.split('\n').filter(Boolean).length + 1;
        const decision = nextStep(repoRoot);
        assert.equal(decision.status, 'BLOCKED');
        assert.equal(decision.next_gate, 'task-reset', decision.reason);
        assert.ok(decision.reason.includes(`has 1 unparseable line(s): ${line}.`), decision.reason);
        assert.match(decision.reason, /remove exactly these lines[\s\S]*every passed review is kept/u);
        assert.equal(decision.commands.length, 1);
        assert.match(decision.commands[0].command, /gate task-reset --task-id "[^"]+" --reopen --dry-run/u);
        assert.equal(fs.readFileSync(timeline, 'utf8'), intact + '{torn\n', 'next-step never edits task history');
        const preview = runCli(repoRoot, ['task-reset', '--task-id', TASK_ID, '--reopen', '--dry-run']);
        assert.equal(preview.code, 0, preview.output);
        assert.equal(fs.readFileSync(timeline, 'utf8'), intact + '{torn\n', 'the advertised preview preserves task history');
        // With an edited authenticated event as well, removing lines cannot restore intact history.
        fs.writeFileSync(timeline, intact.replace('Handshake diagnostics passed', 'Handshake diagnostics passed (edited)') + '{torn\n');
        const tampered = nextStep(repoRoot);
        assert.equal(tampered.next_gate, 'task-reset', tampered.reason);
        assert.doesNotMatch(tampered.reason, /unparseable line/u);
        assert.match(tampered.reason, /Authenticated task history changed/u);
        assert.match(tampered.commands[0]?.command ?? '', /gate task-reset --task-id "[^"]+" --reopen --dry-run/u);
        fs.writeFileSync(timeline, intact);
        assert.equal(nextStep(repoRoot).next_gate, before.next_gate);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
