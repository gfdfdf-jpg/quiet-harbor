import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertCommitBoundRuntime, isDeadEnd, measureFixture, measureFriction, writeFrictionReport } from '../../../scripts/node-foundation/e2e/friction-meter';
import { buildPublishRuntime, getRepoRoot } from '../../../scripts/node-foundation/build';

test('friction meter distinguishes an actionable instruction from a navigator dead end', () => {
    assert.equal(isDeadEnd({ status: 'BLOCKED', commands: [] }, 'Command: none\n'), true);
    assert.equal(isDeadEnd({ status: 'BLOCKED', commands: [] }, 'Command: none\nNext: edit the answers file.\n'), false);
    // The default compact answer: `Next:` is the title, the instruction is `Instruction:`.
    assert.equal(isDeadEnd({ status: 'BLOCKED', commands: [] }, 'Next: Fill the answers.\nCommands: none\n'), true);
    assert.equal(isDeadEnd({ status: 'BLOCKED', commands: [] }, 'Next: Fill the answers.\nCommands: none\nInstruction: edit the answers file.\n'), false);
    assert.equal(isDeadEnd({ status: 'BLOCKED', commands: [{ command: 'node cli.js gate compile-gate' }] }, ''), false);
    assert.equal(isDeadEnd({ status: 'READY', commands: [] }, ''), false);
});

function git(cwd: string, args: string[]): string {
    const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args],
        { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

test('commit-bound measurement rejects another baseline, changed runtime inputs and untracked runtime inputs', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-friction-binding-'));
    try {
        git(repo, ['init', '-q']);
        fs.mkdirSync(path.join(repo, 'src'));
        fs.writeFileSync(path.join(repo, 'src', 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        fs.writeFileSync(path.join(repo, 'VERSION'), '1.0.0\n', 'utf8');
        git(repo, ['add', '-A']);
        git(repo, ['commit', '-q', '-m', 'first']);
        fs.appendFileSync(path.join(repo, 'VERSION'), 'second\n', 'utf8');
        git(repo, ['commit', '-q', '-am', 'second']);
        const head = git(repo, ['rev-parse', 'HEAD']);
        assert.equal(assertCommitBoundRuntime(repo), head);
        assert.equal(assertCommitBoundRuntime(repo, 'HEAD'), head);
        assert.throws(() => assertCommitBoundRuntime(repo, 'HEAD^'), /does not match checked-out HEAD/u);
        fs.appendFileSync(path.join(repo, 'src', 'runtime.ts'), 'export const changed = 2;\n', 'utf8');
        assert.throws(() => assertCommitBoundRuntime(repo), /runtime_source/u);
        git(repo, ['checkout', '--', 'src/runtime.ts']);
        fs.writeFileSync(path.join(repo, 'src', 'added.ts'), 'export const added = 3;\n', 'utf8');
        assert.throws(() => assertCommitBoundRuntime(repo), /Untracked runtime inputs/u);
    } finally {
        const relative = path.relative(os.tmpdir(), repo);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('python friction measurement writes real command outcomes and preserves blocked navigation', { timeout: 180_000 }, () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-friction-report-'));
    const callerProvider = process.env.GARDA_EXECUTION_PROVIDER;
    process.env.GARDA_EXECUTION_PROVIDER = 'foreign-fixture-caller';
    try {
        const outputPath = path.join(outputRoot, 'report.json');
        assert.throws(() => measureFriction({ fixtures: ['python'], outputPath, baselineRef: 'HEAD^' }),
            /does not match checked-out HEAD/u);
        assert.equal(fs.existsSync(outputPath), false);
        // The commit binding is checked on a committed temporary repository above, so this run does not depend on the working tree state.
        const runtimeCommit = git(getRepoRoot(), ['rev-parse', 'HEAD']);
        const report = writeFrictionReport(getRepoRoot(), runtimeCommit, { fixtures: ['python'], outputPath });
        assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), report);
        assert.equal(report.schema_version, 1);
        assert.match(report.runtime_commit, /^[a-f0-9]{40}$/u);
        assert.equal(report.fixtures.length, 1);
        const fixture = report.fixtures[0];
        assert.equal(fixture.fixture, 'python');
        assert.ok(fixture.commands_executed > 0);
        assert.equal(fixture.commands_executed, fixture.commands.length);
        assert.ok(fixture.commands.some(command => command.phase === 'setup' && command.exit_code === 0), fixture.failure);
        assert.ok(fixture.commands.some(command => command.command.includes('next-step') && command.exit_code === 0));
        assert.ok(Number.isFinite(fixture.wall_time_ms) && fixture.wall_time_ms >= 0);
        assert.ok(Number.isInteger(fixture.preflight_refreshes) && fixture.preflight_refreshes >= 1,
            JSON.stringify({ gate: fixture.last_gate_reached, failure: fixture.failure }));
        assert.equal(fixture.task_resets, 0);
        assert.equal(fixture.dead_ends_count, fixture.dead_ends.length);
        assert.ok(fixture.last_gate_reached);
        assert.ok(['reviewer_boundary', 'blocked'].includes(fixture.stop_reason));
        assert.ok(fixture.commands.every(command => !command.command.includes('record-reviewer-delegation-started')));
        assert.ok(fixture.commands.every(command => command.exit_code === 0), JSON.stringify(fixture.failure));
    } finally {
        if (callerProvider === undefined) delete process.env.GARDA_EXECUTION_PROVIDER;
        else process.env.GARDA_EXECUTION_PROVIDER = callerProvider;
        const relative = path.relative(os.tmpdir(), outputRoot);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        fs.rmSync(outputRoot, { recursive: true, force: true });
    }
});

test('composite mode reaches the same reviewer boundary with fewer agent commands and reports internal sub-gates', { timeout: 900_000 }, (t) => {
    // measureFixture measures the runtime built from this checkout; measureFriction adds the commit binding on top.
    buildPublishRuntime();
    const repoRoot = getRepoRoot();
    const setupPhases = new Set(['fixture_git', 'setup', 'configure', 'agent_init']);
    const agentCommands = (fixture: ReturnType<typeof measureFixture>) =>
        fixture.commands.filter(command => !setupPhases.has(command.phase)).length;
    const individual = measureFixture(repoRoot, 'rust', 'individual');
    const composite = measureFixture(repoRoot, 'rust', 'composite');
    const navigator = measureFixture(repoRoot, 'rust', 'navigator');
    t.diagnostic(JSON.stringify([individual, composite, navigator].map(fixture => ({ mode: fixture.mode,
        total_commands: fixture.commands_executed, agent_commands: agentCommands(fixture),
        internal_subgates: fixture.internal_subgates_executed, stop: fixture.last_gate_reached }))));
    for (const fixture of [individual, composite, navigator]) {
        assert.equal(fixture.stop_reason, 'reviewer_boundary', JSON.stringify({ mode: fixture.mode, failure: fixture.failure,
            gate: fixture.last_gate_reached, blocked: fixture.blocked_reason }));
        assert.equal(fixture.last_gate_reached, 'prepare-reviewer-launch');
        assert.equal(fixture.dead_ends_count, 0);
        assert.equal(fixture.preflight_refreshes, 1, fixture.mode);
        assert.ok(fixture.commands.every(command => command.exit_code === 0));
        assert.ok(fixture.commands.every(command => !command.command.includes('record-reviewer-delegation-started')));
    }
    assert.equal(individual.internal_subgates_executed, 0);
    assert.ok(individual.commands.every(command => !command.phase.startsWith('composite_')));
    assert.ok(navigator.internal_subgates_executed > 0);
    assert.ok(navigator.commands.some(command => command.phase === 'navigator_composite'));
    assert.ok(navigator.commands.every(command => !command.phase.startsWith('composite_')), 'no guessed composites');
    assert.ok(agentCommands(navigator) < agentCommands(individual),
        JSON.stringify({ individual: agentCommands(individual), navigator: agentCommands(navigator) }));
    assert.ok(composite.internal_subgates_executed > 0);
    assert.ok(composite.commands.some(command => command.phase === 'composite_advance'));
    assert.ok(agentCommands(composite) < agentCommands(individual),
        JSON.stringify({ individual: agentCommands(individual), composite: agentCommands(composite) }));
});
