import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import { resolveNextStep, type NextStepResult } from '../../../src/gates/next-step';
import { readNextStepCommandExecution } from '../../../src/gates/next-step/next-step-command-execution';
import {
    runTaskComposite,
    type TaskCompositeRunResult
} from '../../../src/cli/commands/task-composite/task-composite-runner';
import {
    executeTaskCompositeOperation,
    type TaskCompositeEntryInputs
} from '../../../src/cli/commands/task-composite/task-composite-actions';
import {
    OTHER_TASK_ID,
    PROVIDER_ARGS,
    TASK_ID,
    cli,
    countEvents,
    createCompositeFixture,
    runPrintedCommand,
    timelineEvents,
    writeTaskEdit,
    type CompositeFixture
} from '../cli/commands/task-composite-test-fixture';

// Reference-stand properties of the composite startup runner (T-409-1): the runner is judged against individual
// navigator-printed commands in real disposable workspaces, never against its own report alone.

const ENTRY: TaskCompositeEntryInputs = {
    provider: 'Codex', routedTo: 'AGENTS.md', requestedDepth: null, taskSummary: null, plannedChangedFiles: [],
    orchestratorWork: false, workflowConfigWork: false, operatorConfirmed: null, operatorConfirmedAtUtc: null
};
const STARTUP_GATES = ['handshake-diagnostics', 'shell-smoke-preflight', 'classify-change', 'next-step-effect'];

let fixturePromise: Promise<CompositeFixture> | null = null;
const workspace = async (): Promise<string> => (await (fixturePromise ??= createCompositeFixture())).clone();
after(async () => { if (fixturePromise) (await fixturePromise).dispose(); });

function runtimeFiles(repoRoot: string, directory: string): string[] {
    const root = path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', directory);
    return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.startsWith(TASK_ID)).sort() : [];
}

function composite(repoRoot: string, mode: 'start' | 'advance', overrides: Partial<Parameters<typeof runTaskComposite>[0]> = {}) {
    return runTaskComposite({ taskId: TASK_ID, repoRoot, mode, entryInputs: mode === 'start' ? ENTRY : null, ...overrides });
}

async function startAndReadRules(
    repoRoot: string, overrides: Partial<Parameters<typeof runTaskComposite>[0]> = {}
): Promise<TaskCompositeRunResult> {
    const started = await composite(repoRoot, 'start', overrides);
    assert.equal(started.stop?.kind, 'agent');
    await runPrintedCommand(repoRoot, 'load-rule-pack');
    return started;
}

interface ObservedStartup {
    repoRoot: string;
    started: TaskCompositeRunResult;
    advanced: TaskCompositeRunResult;
    /** `<next_gate>:<boundary>:<operation>` of every navigator resolution the runner made, in order. */
    observed: string[];
}

/**
 * One real composite startup (start, the agent's rule read, the implementation edit, advance) shared by the
 * equivalence and route-coverage cases. Observing a resolution only reads it, so both cases judge the same run.
 */
let observedStartupPromise: Promise<ObservedStartup> | null = null;
function observedStartup(): Promise<ObservedStartup> {
    observedStartupPromise ??= (async () => {
        const repoRoot = await workspace();
        const observed: string[] = [];
        const resolve = (options: { taskId: string; repoRoot: string }): NextStepResult => {
            const result = resolveNextStep(options);
            const execution = result.commands.length === 1 ? readNextStepCommandExecution(result.commands[0]) : null;
            observed.push(`${result.next_gate}:${execution?.boundary ?? 'none'}:${execution?.operation?.operation_id ?? 'stop'}`);
            return result;
        };
        const started = await startAndReadRules(repoRoot, { resolve });
        writeTaskEdit(repoRoot);
        const advanced = await composite(repoRoot, 'advance', { resolve });
        return { repoRoot, started, advanced, observed };
    })();
    return observedStartupPromise;
}

test('composite startup executes the same ordered transitions and artifacts as individual commands, with separate counters', async () => {
    const individual = await workspace();
    let individualAgentCommands = 0;
    for (const [gate, edit] of [['enter-task-mode', false], ['load-rule-pack', false], ['handshake-diagnostics', true],
        ['shell-smoke-preflight', false], ['classify-change', false], ['next-step-effect', false]] as const) {
        if (edit) writeTaskEdit(individual);
        await runPrintedCommand(individual, gate, gate === 'enter-task-mode' ? { '--provider': 'Codex', '--routed-to': 'AGENTS.md' } : {});
        individualAgentCommands += 1;
    }

    const { repoRoot, started, advanced } = await observedStartup();

    assert.deepEqual(timelineEvents(repoRoot), timelineEvents(individual));
    assert.deepEqual(runtimeFiles(repoRoot, 'reviews'), runtimeFiles(individual, 'reviews'));
    assert.deepEqual(runtimeFiles(repoRoot, 'tmp'), runtimeFiles(individual, 'tmp'));
    assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, resolveNextStep({ taskId: TASK_ID, repoRoot: individual }).next_gate);
    // Fewer agent invocations must never mean fewer transitions: every individually executed gate ran internally.
    const internal = [...started.completed, ...advanced.completed].map((step) => step.gate);
    assert.deepEqual(internal, ['enter-task-mode', ...STARTUP_GATES]);
    assert.equal(started.counters.subgates_succeeded + advanced.counters.subgates_succeeded, individualAgentCommands - 1);
    assert.equal(started.counters.agent_invocations + advanced.counters.agent_invocations + 1, 3);
    assert.ok(individualAgentCommands > 3);
    assert.equal(advanced.counters.navigator_resolutions, advanced.counters.subgates_attempted + 1);
    assert.equal(advanced.counters.effects_executed, 2);
});

test('no stop boundary is passed: rules, operator approval, unscoped scope and unclassified steps are blocked before any write', async () => {
    const owners = await workspace();
    assert.equal((await cli(owners, ['gate', 'enter-task-mode', '--task-id', OTHER_TASK_ID, '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
        '--requested-depth', '2', '--task-summary', 'Second composite fixture task', ...PROVIDER_ARGS, '--repo-root', '.'])).exitCode, 0);
    assert.equal((await composite(owners, 'start')).stop?.kind, 'operator');
    assert.deepEqual(timelineEvents(owners), []);

    const dirty = await workspace();
    writeTaskEdit(dirty);
    const unscoped = await composite(dirty, 'start');
    assert.equal(unscoped.stop?.kind, 'agent');
    assert.deepEqual([unscoped.completed, timelineEvents(dirty)], [[], []]);

    const unclassified = await workspace();
    const stripped = await composite(unclassified, 'start', {
        resolve: (options) => {
            const result = resolveNextStep(options);
            return { ...result, commands: result.commands.map((command) => ({ ...command })) };
        }
    });
    assert.equal(stripped.stop?.kind, 'unclassified');
    assert.deepEqual(timelineEvents(unclassified), []);
    assert.deepEqual(runtimeFiles(unclassified, 'reviews'), []);

    // The refused start wrote nothing, so the same untouched workspace serves the rule-reading case.
    const rules = unclassified;
    await composite(rules, 'start');
    const entered = timelineEvents(rules);
    const atTaskEntry = await composite(rules, 'advance');
    assert.deepEqual([atTaskEntry.stop?.kind, atTaskEntry.next?.next_gate, atTaskEntry.completed], ['agent', 'load-rule-pack', []]);
    assert.deepEqual(timelineEvents(rules), entered);
    await runPrintedCommand(rules, 'load-rule-pack');
    writeTaskEdit(rules);
    const atPostPreflight = await composite(rules, 'advance');
    assert.deepEqual([atPostPreflight.stop?.kind, atPostPreflight.next?.next_gate], ['agent', 'load-rule-pack']);
    const classified = timelineEvents(rules);
    assert.deepEqual((await composite(rules, 'advance')).completed, []);
    assert.deepEqual(timelineEvents(rules), classified);
});

test('freshness: no stale state is acted on; each internal step uses state observed after the previous step', async () => {
    const repoRoot = await workspace();
    await startAndReadRules(repoRoot);
    writeTaskEdit(repoRoot);
    const lateFile = path.join(repoRoot, 'src', 'late.ts');
    const result = await composite(repoRoot, 'advance', {
        execute: async (operation, context) => {
            const outcome = await executeTaskCompositeOperation(operation, context);
            // A change between shell smoke and classification must reach classification, not a stale plan.
            if (operation.operation_id === 'shell-smoke-preflight') fs.writeFileSync(lateFile, 'export const late = 1;\n', 'utf8');
            return outcome;
        }
    });
    assert.deepEqual(result.completed.map((step) => step.gate), STARTUP_GATES);
    const preflight = JSON.parse(fs.readFileSync(path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews',
        `${TASK_ID}-preflight.json`), 'utf8')) as { changed_files: string[] };
    assert.ok(preflight.changed_files.includes('src/late.ts'), JSON.stringify(preflight.changed_files));
});

test('crash and resume: interruption before or after a gate write resumes without a second cycle or duplicate transitions', async () => {
    const repoRoot = await workspace();
    await startAndReadRules(repoRoot);
    writeTaskEdit(repoRoot);
    const beforeWrite = await composite(repoRoot, 'advance', {
        execute: async (operation, context) => {
            if (operation.operation_id === 'shell-smoke-preflight') throw new Error('interrupted before shell smoke');
            return executeTaskCompositeOperation(operation, context);
        }
    });
    assert.deepEqual([beforeWrite.outcome, beforeWrite.failed?.gate, beforeWrite.completed.map((step) => step.gate)],
        ['FAILED', 'shell-smoke-preflight', ['handshake-diagnostics']]);
    assert.equal(countEvents(repoRoot, 'SHELL_SMOKE_PREFLIGHT_RECORDED'), 0);

    const afterWrite = await composite(repoRoot, 'advance', {
        execute: async (operation, context) => {
            const outcome = await executeTaskCompositeOperation(operation, context);
            if (operation.operation_id === 'shell-smoke-preflight') throw new Error('response lost after shell smoke');
            return outcome;
        }
    });
    assert.deepEqual([afterWrite.failed?.gate, afterWrite.completed], ['shell-smoke-preflight', []]);
    assert.equal(countEvents(repoRoot, 'SHELL_SMOKE_PREFLIGHT_RECORDED'), 1);

    const resumed = await composite(repoRoot, 'advance');
    assert.deepEqual(resumed.completed.map((step) => step.gate), ['classify-change', 'next-step-effect']);
    const resumedAgain = await composite(repoRoot, 'start');
    assert.deepEqual(resumedAgain.completed, []);
    for (const eventType of ['TASK_MODE_ENTERED', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED']) {
        assert.equal(countEvents(repoRoot, eventType), 1, eventType);
    }
});

test('internal route coverage: every startup route the runner resolves is observed with its descriptor', async () => {
    const { observed } = await observedStartup();
    assert.deepEqual(observed, [
        'enter-task-mode:agent:enter-task-mode',
        'load-rule-pack:agent:stop',
        'handshake-diagnostics:mechanical:handshake-diagnostics',
        'shell-smoke-preflight:mechanical:shell-smoke-preflight',
        'classify-change:mechanical:classify-change',
        'next-step-effect:mechanical:execute-next-step-effects',
        'load-rule-pack:agent:stop'
    ]);
});

test('invalid or lost evidence: forged task-mode evidence fails at its verifying gate before any downstream write, lost startup evidence is rebuilt by its own gate', async () => {
    const tampered = await workspace();
    await startAndReadRules(tampered);
    const taskModePath = path.join(tampered, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`);
    const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(taskModePath, `${JSON.stringify({ ...taskMode, provider: 'Forged' }, null, 2)}\n`, 'utf8');
    const before = timelineEvents(tampered);
    const refused = await composite(tampered, 'advance');
    // The gate that verifies the forged evidence refuses it; the run ends there and no downstream gate writes.
    assert.deepEqual([refused.outcome, refused.failed?.gate, refused.completed], ['FAILED', 'handshake-diagnostics', []]);
    assert.ok(refused.failed?.output_lines.includes('HANDSHAKE_DIAGNOSTICS_FAILED'));
    const after = timelineEvents(tampered).slice(before.length);
    // A refusal that appended nothing would make the "every" check vacuous, so the refusal itself must be recorded.
    assert.ok(after.some((entry) => entry.startsWith('HANDSHAKE_DIAGNOSTICS_RECORDED:FAIL')), JSON.stringify(after));
    assert.ok(after.every((entry) => entry.startsWith('HANDSHAKE_DIAGNOSTICS_RECORDED:FAIL')), JSON.stringify(after));
    assert.equal(countEvents(tampered, 'SHELL_SMOKE_PREFLIGHT_RECORDED') + countEvents(tampered, 'PREFLIGHT_CLASSIFIED'), 0);

    const lost = await workspace();
    await startAndReadRules(lost);
    writeTaskEdit(lost);
    const interrupted = await composite(lost, 'advance', {
        execute: async (operation, context) => {
            if (operation.operation_id === 'classify-change') throw new Error('interrupted before classification');
            return executeTaskCompositeOperation(operation, context);
        }
    });
    assert.deepEqual(interrupted.completed.map((step) => step.gate), ['handshake-diagnostics', 'shell-smoke-preflight']);
    fs.rmSync(path.join(lost, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-handshake.json`));
    const rebuilt = await composite(lost, 'advance');
    assert.equal(rebuilt.outcome, 'STOPPED', JSON.stringify(rebuilt.failed));
    assert.equal(rebuilt.completed[0]?.gate, 'handshake-diagnostics', JSON.stringify(rebuilt.completed.map((step) => step.gate)));
    assert.ok(rebuilt.completed.some((step) => step.gate === 'classify-change'));
    assert.equal(countEvents(lost, 'PREFLIGHT_CLASSIFIED'), 1);
    assert.equal(countEvents(lost, 'TASK_MODE_ENTERED'), 1);
});
