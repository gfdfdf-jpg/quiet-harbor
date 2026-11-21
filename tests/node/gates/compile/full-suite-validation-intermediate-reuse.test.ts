import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    runCliWithCapturedOutput, createTempRepo, seedTaskQueue, seedInitAnswers, runEnterTaskMode,
    loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask, runExplicitPreflight,
    loadPostPreflightRulePack, writeBudgetOutputFilters
} from '../../cli/commands/gate-test-helpers';
import { runCompileGateCommand, runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { selectConfiguredTaskTests } from '../../task-test-selection-fixtures';
import { DEFAULT_FULL_SUITE_VALIDATION_CONFIG } from '../../../../src/core/full-suite-validation-config';
import { loadTaskFullSuiteConfig } from '../../../../src/gates/full-suite/task-full-suite-config';
import { taskTestProcessEvidenceViolations } from '../../../../src/gates/full-suite/task-test-execution-proof';

const TARGET = 'tests/intermediate-reuse.test.cjs';
const COMMAND = `node ${TARGET}`;
const MARKER = 'executions.txt';

interface Fixture {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    artifactPath: string;
    executions: () => number;
    intermediate: (command?: string) => Promise<string>;
    validate: () => Promise<{ exitCode: number; text: string; artifact: Record<string, unknown> }>;
}

async function fixture(taskId: string, options: { selectAfterIntermediate?: boolean } = {}): Promise<Fixture> {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot);
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator/live/config');
    const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews');
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
        compile_gate: { command: 'node --version' },
        project_memory_maintenance: { enabled: false },
        full_suite_validation: { ...DEFAULT_FULL_SUITE_VALIDATION_CONFIG, enabled: true, command: COMMAND, timeout_ms: 30000 }
    }));
    writeBudgetOutputFilters(repoRoot);
    assert.equal(runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Reuse a green intermediate task test run',
        provider: 'Codex', plannedChangedFiles: [TARGET] }).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    fs.writeFileSync(path.join(repoRoot, TARGET), [
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(MARKER)}, 'executed\\n');`,
        "if (fs.existsSync('fail.flag')) { console.log('red run'); process.exit(1); }",
        "console.log('green run');"
    ].join('\n'));
    const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Reuse a green intermediate task test run', [TARGET]);
    assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
    const intermediate = async (command = COMMAND): Promise<string> => {
        const run = await runIntermediateCommandCommand({ repoRoot, taskId, commandSource: 'targeted-test',
            command, preflightPath });
        const artifact = run.outputLines.find(line => line.startsWith('ArtifactPath: '))?.slice('ArtifactPath: '.length);
        assert.ok(artifact, run.outputLines.join('\n'));
        return artifact;
    };
    if (!options.selectAfterIntermediate) selectConfiguredTaskTests(repoRoot, taskId, preflightPath);
    const compile = await runCompileGateCommand({ repoRoot, taskId, preflightPath, emitMetrics: false });
    assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
    const artifactPath = path.join(reviewsDir, `${taskId}-full-suite-validation.json`);
    return {
        repoRoot, taskId, preflightPath, artifactPath, intermediate,
        executions: () => fs.existsSync(path.join(repoRoot, MARKER))
            ? fs.readFileSync(path.join(repoRoot, MARKER), 'utf8').split('\n').filter(Boolean).length : 0,
        validate: async () => {
            const result = await runCliWithCapturedOutput(['gate', 'task-test-validation', '--task-id', taskId,
                '--preflight-path', preflightPath, '--repo-root', repoRoot], { cwd: process.cwd() });
            return { exitCode: result.exitCode, text: result.logs.concat(result.errors).join('\n'),
                artifact: JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown> };
        }
    };
}

function latestValidationEvent(f: Fixture): Record<string, unknown> {
    const timeline = path.join(f.repoRoot, 'garda-agent-orchestrator/runtime/task-events', `${f.taskId}.jsonl`);
    const events = fs.readFileSync(timeline, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    return [...events].reverse().find(event => String(event.event_type).startsWith('FULL_SUITE_VALIDATION_'))!;
}

describe('gates/full-suite-validation intermediate run reuse', () => {
    it('accepts the latest green intermediate run of exactly the selected command as task test execution', async t => {
        const f = await fixture('T-INTERMEDIATE-REUSE');
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const intermediateArtifact = await f.intermediate();
        assert.equal(f.executions(), 1);
        const result = await f.validate();
        assert.equal(result.exitCode, 0, result.text);
        assert.equal(f.executions(), 1, 'task-test-validation must not execute the selected command again');
        assert.match(result.text, /Reused the passing intermediate run/u);
        const reuse = result.artifact.reused_intermediate_execution as Record<string, unknown>;
        assert.equal(path.resolve(String(reuse.artifact_path)), path.resolve(intermediateArtifact));
        assert.equal(reuse.artifact_sha256, createHash('sha256').update(fs.readFileSync(intermediateArtifact)).digest('hex'));
        assert.equal(reuse.command, COMMAND);
        assert.equal(result.artifact.status, 'PASSED');
        const selection = loadTaskFullSuiteConfig(f.repoRoot, f.taskId).selection;
        assert.deepEqual(taskTestProcessEvidenceViolations(selection.plan, result.artifact, selection.legacyPlan), []);
        const process = (result.artifact.task_test_process_evidence as { invocations: Array<Record<string, unknown>> }).invocations;
        assert.equal(process.length, 1);
        assert.equal(process[0].execution_id, reuse.execution_id);
        const event = latestValidationEvent(f);
        assert.equal(event.event_type, 'FULL_SUITE_VALIDATION_PASSED');
        assert.deepEqual((event.details as Record<string, unknown>).reused_intermediate_execution, reuse);
    });

    it('executes the command when a later attempt of the same command failed', async t => {
        const f = await fixture('T-INTERMEDIATE-REUSE-LATER-RED');
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        await f.intermediate();
        fs.writeFileSync(path.join(f.repoRoot, 'fail.flag'), '');
        await f.intermediate();
        fs.rmSync(path.join(f.repoRoot, 'fail.flag'));
        const result = await f.validate();
        assert.equal(result.exitCode, 0, result.text);
        assert.equal(f.executions(), 3);
        assert.equal(result.artifact.reused_intermediate_execution, undefined);
    });

    it('executes the command when the green run used a different selection', async t => {
        const f = await fixture('T-INTERMEDIATE-REUSE-OTHER-COMMAND');
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        await f.intermediate(`node ${TARGET} --other`);
        const result = await f.validate();
        assert.equal(result.exitCode, 0, result.text);
        assert.equal(f.executions(), 2);
        assert.equal(result.artifact.reused_intermediate_execution, undefined);
    });

    it('executes the command when the retained intermediate artifact was tampered with', async t => {
        const f = await fixture('T-INTERMEDIATE-REUSE-TAMPERED');
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        const artifact = await f.intermediate();
        fs.appendFileSync(artifact, ' ');
        const result = await f.validate();
        assert.equal(result.exitCode, 0, result.text);
        assert.equal(f.executions(), 2);
        assert.equal(result.artifact.reused_intermediate_execution, undefined);
    });

    it('executes the command when the green run predates the task test selection', async t => {
        const f = await fixture('T-INTERMEDIATE-REUSE-BEFORE-SELECTION', { selectAfterIntermediate: true });
        t.after(() => fs.rmSync(f.repoRoot, { recursive: true, force: true }));
        await f.intermediate();
        selectConfiguredTaskTests(f.repoRoot, f.taskId, f.preflightPath);
        const compile = await runCompileGateCommand({ repoRoot: f.repoRoot, taskId: f.taskId,
            preflightPath: f.preflightPath, emitMetrics: false });
        assert.equal(compile.exitCode, 0, compile.outputLines.join('\n'));
        const result = await f.validate();
        assert.equal(result.exitCode, 0, result.text);
        assert.equal(f.executions(), 2);
        assert.equal(result.artifact.reused_intermediate_execution, undefined);
    });
});
