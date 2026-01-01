import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { taskCompileApplicability } from '../../../../src/gates/compile/task-compile-applicability';
import { retainedTaskCompileDeclaration } from '../../../../src/gates/compile/compile-gate';
import { runCompileGateCommand } from '../../../../src/cli/commands/gate-flows/compile/compile-flow';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../../src/core/constants';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { createTempRepo, removeTempRepoWithRetry, seedTaskQueue, seedInitAnswers, getReviewsRoot,
    initializeGitRepo, runGit, runEnterTaskMode, loadTaskEntryRulePack,
    runHandshakeForTask, runShellSmokeForTask, runExplicitPreflight, loadPostPreflightRulePack,
    readTaskTimelineEvents } from '../../cli/commands/gate-test-helpers';

const TASK = 'T-DOCS-COMPILE';

function fixture(changedFiles: string[], configured = true) {
    const root = createTempRepo();
    seedTaskQueue(root, TASK);
    seedInitAnswers(root);
    const write = (file: string, text: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };
    const runner = 'garda-agent-orchestrator/runtime/compile-probe.cjs';
    const marker = path.join(root, 'garda-agent-orchestrator/runtime/compile-ran');
    const fail = path.join(root, 'garda-agent-orchestrator/runtime/compile-fail');
    write(runner, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n');
        if (fs.existsSync(${JSON.stringify(fail)})) process.exit(3);`);
    const command = `node ${runner}`;
    const config = buildDefaultWorkflowConfig();
    config.compile_gate.command = configured ? command : UNCONFIGURED_COMPILE_GATE_COMMAND;
    write('garda-agent-orchestrator/live/config/workflow-config.json', JSON.stringify(config));
    for (const file of ['docs/guide.md', ...changedFiles]) write(file, 'before\n');
    assert.equal(runEnterTaskMode({ repoRoot: root, taskId: TASK, taskSummary: 'Update task documentation' }).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(root, TASK).exitCode, 0);
    runHandshakeForTask(root, TASK);
    runShellSmokeForTask(root, TASK);
    initializeGitRepo(root);
    for (const file of changedFiles) fs.appendFileSync(path.join(root, file), 'after\n');
    const refresh = (files = changedFiles) => {
        const preflightPath = runExplicitPreflight(root, TASK, 'Update task documentation', files);
        assert.equal(loadPostPreflightRulePack(root, TASK, preflightPath).exitCode, 0);
        return preflightPath;
    };
    const preflightPath = refresh();
    const run = (options: Partial<Parameters<typeof runCompileGateCommand>[0]> = {}) =>
        runCompileGateCommand({ repoRoot: root, taskId: TASK, preflightPath, emitMetrics: false, ...options });
    const evidence = () => JSON.parse(fs.readFileSync(path.join(getReviewsRoot(root), `${TASK}-compile-gate.json`), 'utf8'));
    return { root, run, evidence, marker, fail, refresh, command };
}

it('only exempts safe ordinary documentation, independently of the requested profile/category', () => {
    const root = createTempRepo();
    try {
        const applicability = (changedFiles: string[], preflight = {}) => taskCompileApplicability({
            repoRoot: root, changedFiles, preflight, gitChangeClassification: null });
        assert.equal(applicability(['README.md', 'docs/guide.md']).kind, 'not_applicable');
        for (const file of ['src/app.ts', 'docs/tool.cjs', 'docs/page.json', 'docs/build.yaml', 'docs/CMakeLists.txt',
            'requirements.txt', 'src/page.mdx', 'product/unknown.zsrc', 'AGENTS.md']) {
            assert.equal(applicability(['docs/guide.md', file], { scope_category: 'docs-only', profile: 'docs-only' }).kind,
                'applicable', file);
        }
        assert.equal(applicability([]).kind, 'applicable');
        assert.equal(applicability(['docs/guide.md'], { declared_test_paths: ['docs/guide.md'] }).kind, 'applicable');
        const native = { actor: 'gate', event_type: 'COMPILE_GATE_PASSED', integrity: { task_sequence: 10 }, details: {
            compile_command_source: 'docs_only', compile_declaration: { kind: 'not_applicable', reason: 'Documentation only.' } } };
        assert.equal(retainedTaskCompileDeclaration([native]), null, 'Automatic docs applicability cannot become a stack exemption');
    } finally { removeTempRepoWithRetry(root); }
});

for (const configured of [true, false]) it(`records bound docs-only evidence without compiling (configured=${configured})`, async () => {
    const f = fixture(['docs/guide.md'], configured);
    try {
        const result = await f.run();
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.equal(fs.existsSync(f.marker), false);
        const evidence = f.evidence();
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.compile_command_source, 'docs_only');
        assert.equal(evidence.compile_applicability.kind, 'not_applicable');
        assert.equal(evidence.compile_declaration.kind, 'not_applicable');
        assert.deepEqual(evidence.compile_commands, []);
        assert.deepEqual(evidence.invocation_executions, []);
        assert.equal(evidence.compile_output_path, null);
        assert.match(evidence.preflight_hash_sha256, /^[a-f0-9]{64}$/u);
        assert.match(evidence.scope_content_sha256, /^[a-f0-9]{64}$/u);
        const event = readTaskTimelineEvents(f.root, TASK).reverse().find(event => event.event_type === 'COMPILE_GATE_PASSED');
        assert.deepEqual((event?.details as Record<string, unknown>).compile_applicability, evidence.compile_applicability);
    } finally { removeTempRepoWithRetry(f.root); }
});

for (const file of ['src/app.ts', 'docs/build.json', 'product/unknown.zsrc']) it(`keeps configured compilation mandatory when ${file} changes`, async () => {
    const f = fixture(['docs/guide.md', file]);
    try {
        for (const options of [{ compileNotApplicableReason: 'Only documentation has changed in this task.' },
            { compileCommand: 'node --check docs/guide.md' }]) {
            const refused = await f.run(options);
            assert.equal(refused.exitCode, EXIT_GATE_FAILURE, refused.outputLines.join('\n'));
            assert.match(refused.outputLines.join('\n'), /configured mandatory compile command/iu);
            assert.equal(fs.existsSync(f.marker), false);
        }
        const result = await f.run();
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.equal(fs.existsSync(f.marker), true);
        assert.equal(f.evidence().compile_applicability.kind, 'applicable');
        assert.equal(f.evidence().invocation_executions.length, 1);
    } finally { removeTempRepoWithRetry(f.root); }
});

it('does not exempt a source renamed into a document', async () => {
    const f = fixture(['src/app.ts']);
    try {
        assert.equal(runGit(f.root, ['checkout', '--', 'src/app.ts']).status, 0);
        assert.equal(runGit(f.root, ['mv', '-f', 'src/app.ts', 'docs/guide.md']).status, 0);
        const result = await f.run({ preflightPath: f.refresh(['src/app.ts', 'docs/guide.md']) });
        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.equal(f.evidence().compile_applicability.kind, 'applicable');
        assert.equal(fs.existsSync(f.marker), true);
    } finally { removeTempRepoWithRetry(f.root); }
});

it('rejects stale docs evidence before granting an exemption', async () => {
    const f = fixture(['docs/guide.md']);
    try {
        fs.appendFileSync(path.join(f.root, 'docs/guide.md'), 'stale\n');
        const result = await f.run();
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(fs.existsSync(f.marker), false);
        assert.equal(f.evidence().status, 'FAILED');
    } finally { removeTempRepoWithRetry(f.root); }
});

it('preserves an executed compile failure after refreshing to docs-only scope', async () => {
    const f = fixture(['src/app.ts']);
    try {
        fs.writeFileSync(f.fail, 'fail');
        assert.equal((await f.run()).exitCode, EXIT_GATE_FAILURE);
        assert.equal(f.evidence().invocation_executions.length, 1);
        assert.equal(runGit(f.root, ['checkout', '--', 'src/app.ts']).status, 0);
        fs.appendFileSync(path.join(f.root, 'docs/guide.md'), 'after\n');
        const refused = await f.run({ preflightPath: f.refresh(['docs/guide.md']) });
        assert.equal(refused.exitCode, EXIT_GATE_FAILURE);
        assert.match(refused.outputLines.join('\n'), /cannot close a failed required compile/iu);
        assert.equal(fs.readFileSync(f.marker, 'utf8'), 'ran\n');
    } finally { removeTempRepoWithRetry(f.root); }
});
