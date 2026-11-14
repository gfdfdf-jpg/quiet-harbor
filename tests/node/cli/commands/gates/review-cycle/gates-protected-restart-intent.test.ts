import {
    assert, it, fs, path, createTempRepo, getReviewsRoot, initializeGitRepo, markAsSourceCheckout, writeProtectedControlPlaneManifest,
    seedRemediationRepoBase, writeCurrentReviewCycleValidationSource, prepareCurrentReviewCycleValidation, writeReviewCapabilitiesConfig,
    writeProfilesConfig, writeWorkflowConfig, seedTaskQueue, seedInitAnswers, runEnterTaskMode,
    loadTaskEntryRulePack, runHandshakeForTask, runShellSmokeForTask, runExplicitPreflight,
    loadPostPreflightRulePack, runRestartCoherentCycleCommand, readTaskTimelineEvents
} from './gates-review-cycle-fixtures';
import { executeNextStepEffects, resolveNextStep } from '../../../../../../src/gates/next-step/next-step';
import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import { readOperatorTaskIntent } from '../../../../../../src/gates/review-context/review-context-task-intent';
import {
    computeTaskCriteriaBinding,
    resolvePreflightTaskIntent,
    resolveRestartTaskIntent
} from '../../../../../../src/gates/review-context/review-context-task-criteria-binding';
import { evaluateGateFlowStartupDiagnostics, resolveGateFlowTimelinePath } from '../../../../../../src/cli/commands/gate-flows/support/gate-flow-runtime';
import { buildCoherentCycleRestartCommand } from '../../../../../../src/gates/completion/completion-reporting';

// Operator rule: an agent supplement never changes task criteria; only an operator-confirmed intent change does, and the
// product never infers that from wording. A protected task's navigator restart carries the operator confirmation for
// protected task-mode re-entry, so it must not also carry an intent that the operator did not state.

type RestartOptions = Parameters<typeof runRestartCoherentCycleCommand>[0];

const RESTART_FLAGS: Readonly<Record<string, keyof RestartOptions>> = {
    '--repo-root': 'repoRoot', '--task-id': 'taskId', '--preflight-path': 'preflightPath', '--task-mode-path': 'taskModePath',
    '--task-intent': 'taskIntent', '--changed-file': 'changedFiles', '--use-staged': 'useStaged',
    '--operator-confirmed': 'operatorConfirmed', '--operator-confirmed-at-utc': 'operatorConfirmedAtUtc',
    '--review-restart-approved': 'reviewRestartApproved', '--review-restart-approved-at-utc': 'reviewRestartApprovedAtUtc',
    '--commands-path': 'commandsPath', '--output-filters-path': 'outputFiltersPath'
};

/** The navigator command exactly as printed; only the operator's approval time is filled in. */
function parseNavigatorRestartCommand(command: string, repoRoot: string): RestartOptions {
    const tokens = [...command.matchAll(/'((?:[^']|'')*)'|"([^"]*)"|(\S+)/gu)]
        .map(match => match[1] !== undefined ? match[1].replace(/''/gu, "'") : match[2] ?? match[3]);
    const start = tokens.indexOf('restart-coherent-cycle');
    assert.ok(start >= 0, command);
    const options: Record<string, unknown> = {};
    for (let index = start + 1; index < tokens.length; index += 1) {
        const key = RESTART_FLAGS[tokens[index]];
        assert.ok(key, `unexpected navigator restart flag ${tokens[index]} in ${command}`);
        if (key === 'useStaged') { options.useStaged = true; continue; }
        let value = tokens[++index];
        if (/^<ISO-8601 timestamp/u.test(value)) value = new Date().toISOString();
        if (key === 'changedFiles') options.changedFiles = [...(options.changedFiles as string[] | undefined) ?? [], value];
        else options[key] = value;
    }
    options.repoRoot = repoRoot;
    return options as RestartOptions;
}

const TASK_SUMMARY = 'Export personal data securely';
const AGENT_SUPPLEMENT = 'Export personal data securely; the agent also covers empty input';

/** A protected task with an intact cycle whose classified intent is the task summary or a later agent description. */
async function prepareProtectedTask(taskId: string, classifiedIntent: string) {
    const repoRoot = createTempRepo();
    seedRemediationRepoBase(repoRoot);
    markAsSourceCheckout(repoRoot);
    writeCurrentReviewCycleValidationSource(repoRoot);
    writeReviewCapabilitiesConfig(repoRoot);
    writeProfilesConfig(repoRoot);
    writeWorkflowConfig(repoRoot, 'parallel_all');
    initializeGitRepo(repoRoot);
    writeProtectedControlPlaneManifest(repoRoot);
    seedTaskQueue(repoRoot, taskId);
    seedInitAnswers(repoRoot, 'Codex');
    const changedFiles = ['src/app.ts', 'tests/app.test.ts'];
    const entered = runEnterTaskMode({ repoRoot, taskId, taskSummary: TASK_SUMMARY, plannedChangedFiles: changedFiles,
        orchestratorWork: true, operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
    assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
    loadTaskEntryRulePack(repoRoot, taskId);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 2;\n');
    fs.writeFileSync(path.join(repoRoot, 'tests/app.test.ts'), 'it("checks export", () => {});\n');
    const preflightPath = runExplicitPreflight(repoRoot, taskId, classifiedIntent, changedFiles);
    await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
    loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
    const criteriaSha256 = () => computeTaskCriteriaBinding({ repoRoot, taskId,
        preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) }).sha256;
    return { repoRoot, preflightPath, criteriaBefore: criteriaSha256(), criteriaSha256 };
}

/** The intact cycle routes forward, so a coherent restart is not required there. */
function assertIntactCycleRoutesForward(repoRoot: string, taskId: string): void {
    const next = resolveNextStep({ repoRoot, taskId });
    assert.equal(next.next_gate, 'build-review-context', JSON.stringify(next));
}

async function prepareProtectedTaskAtNavigatorRestart(taskId: string, classifiedIntent: string) {
    const fixture = await prepareProtectedTask(taskId, classifiedIntent);
    // Lost startup and compile evidence: the navigator rebuilds the cycle through restart-coherent-cycle.
    fs.rmSync(path.join(getReviewsRoot(fixture.repoRoot), `${taskId}-handshake.json`));
    fs.rmSync(path.join(getReviewsRoot(fixture.repoRoot), `${taskId}-compile-gate.json`));
    const next = resolveNextStep({ repoRoot: fixture.repoRoot, taskId });
    assert.equal(next.next_gate, 'restart-coherent-cycle', JSON.stringify(next));
    const command = next.commands.find(entry => /restart-coherent-cycle/u.test(entry.command))?.command;
    assert.ok(command, JSON.stringify(next.commands));
    // Protected re-entry still asks for the operator's confirmation.
    assert.match(command, /--operator-confirmed yes/u);
    return { ...fixture, command };
}

const intentUpdates = (repoRoot: string, taskId: string) => readTaskTimelineEvents(repoRoot, taskId)
    .filter(event => event.event_type === 'TASK_INTENT_UPDATED').length;

for (const variant of ['task summary', 'agent supplement'] as const) {
    it(`protected task: navigator coherent restart keeps the ${variant} an agent description and the task criteria`, async () => {
        const taskId = variant === 'task summary' ? 'T-protected-restart-summary' : 'T-protected-restart-supplement';
        const classifiedIntent = variant === 'task summary' ? TASK_SUMMARY : AGENT_SUPPLEMENT;
        const fixture = await prepareProtectedTaskAtNavigatorRestart(taskId, classifiedIntent);
        try {
            const restart = await runRestartCoherentCycleCommand(parseNavigatorRestartCommand(fixture.command, fixture.repoRoot));
            assert.equal(restart.exitCode, 0, restart.outputLines.join('\n'));
            assert.equal(intentUpdates(fixture.repoRoot, taskId), 0, 'a navigator restart cannot change task criteria');
            assert.equal(readOperatorTaskIntent(fixture.repoRoot, taskId) ?? null, null);
            // The classified agent wording survives as the description; the criteria passed reviews bind to stay equal.
            assert.equal(resolvePreflightTaskIntent(JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'))), classifiedIntent);
            assert.equal(fixture.criteriaSha256(), fixture.criteriaBefore);
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });
}

it('protected task: a navigator-built coherent restart on an intact cycle stays refused as not required', async () => {
    const taskId = 'T-protected-restart-unrequired';
    const fixture = await prepareProtectedTask(taskId, AGENT_SUPPLEMENT);
    try {
        assertIntactCycleRoutesForward(fixture.repoRoot, taskId);
        // Built as the navigator builds every protected restart command: classified intent plus re-entry confirmation.
        const preflightPath = path.relative(fixture.repoRoot, fixture.preflightPath).replace(/\\/gu, '/');
        const command = buildCoherentCycleRestartCommand(fixture.repoRoot, taskId, preflightPath, null, null, null, {
            requiresOperatorConfirmation: true,
            taskIntent: resolveRestartTaskIntent({ repoRoot: fixture.repoRoot, taskId,
                preflight: JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) })
        });
        const restart = await runRestartCoherentCycleCommand(parseNavigatorRestartCommand(command, fixture.repoRoot));
        assert.notEqual(restart.exitCode, 0, restart.outputLines.join('\n'));
        assert.match(restart.outputLines.join('\n'), /Nothing requires a coherent-cycle restart/u);
        assert.equal(intentUpdates(fixture.repoRoot, taskId), 0);
        assert.equal(fixture.criteriaSha256(), fixture.criteriaBefore);
    } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
});

it('protected task: the navigator restart re-entering with an agent description still needs the operator confirmation', async () => {
    const taskId = 'T-protected-restart-unconfirmed';
    const fixture = await prepareProtectedTaskAtNavigatorRestart(taskId, AGENT_SUPPLEMENT);
    try {
        const options = parseNavigatorRestartCommand(fixture.command, fixture.repoRoot);
        delete options.operatorConfirmed;
        delete options.operatorConfirmedAtUtc;
        const restart = await runRestartCoherentCycleCommand(options);
        assert.notEqual(restart.exitCode, 0, restart.outputLines.join('\n'));
        assert.match(restart.outputLines.join('\n'), /operator confirmation|--operator-confirmed/u);
        assert.equal(intentUpdates(fixture.repoRoot, taskId), 0);
    } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
});

for (const variant of ['changed intent', 'earlier agent supplement'] as const) {
    it(`protected task: an operator who confirms the ${variant} through the coherent restart still changes the criteria`, async () => {
        const taskId = variant === 'changed intent' ? 'T-protected-restart-operator' : 'T-protected-restart-confirm';
        const fixture = await prepareProtectedTaskAtNavigatorRestart(taskId,
            variant === 'changed intent' ? TASK_SUMMARY : AGENT_SUPPLEMENT);
        try {
            const operatorIntent = variant === 'changed intent'
                ? 'Export personal data securely; reject archives for revoked accounts' : AGENT_SUPPLEMENT;
            const restart = await runRestartCoherentCycleCommand({
                ...parseNavigatorRestartCommand(fixture.command, fixture.repoRoot), taskIntent: operatorIntent });
            assert.equal(restart.exitCode, 0, restart.outputLines.join('\n'));
            assert.equal(intentUpdates(fixture.repoRoot, taskId), 1);
            assert.equal(readOperatorTaskIntent(fixture.repoRoot, taskId)?.task_intent, operatorIntent);
            assert.notEqual(fixture.criteriaSha256(), fixture.criteriaBefore);
        } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
    });
}

// Recovery hints printed by compile and classify-change build the same coherent restart as the navigator.
it('protected task: the startup-evidence recovery hint names the restart without a restated task intent', async () => {
    const taskId = 'T-protected-restart-hint';
    const fixture = await prepareProtectedTaskAtNavigatorRestart(taskId, AGENT_SUPPLEMENT);
    try {
        const violations = evaluateGateFlowStartupDiagnostics({
            repoRoot: fixture.repoRoot, taskId, taskModePath: '',
            timelinePath: resolveGateFlowTimelinePath(fixture.repoRoot, taskId),
            preflightPath: path.relative(fixture.repoRoot, fixture.preflightPath).replace(/\\/gu, '/')
        });
        const hint = violations.join('\n');
        const command = /Command: (.*restart-coherent-cycle.*)/u.exec(hint)?.[1];
        assert.ok(command, hint);
        assert.match(command, /--operator-confirmed yes/u);
        assert.doesNotMatch(command, /--task-intent/u);
        const restart = await runRestartCoherentCycleCommand(parseNavigatorRestartCommand(command, fixture.repoRoot));
        assert.equal(restart.exitCode, 0, restart.outputLines.join('\n'));
        assert.equal(intentUpdates(fixture.repoRoot, taskId), 0);
        assert.equal(fixture.criteriaSha256(), fixture.criteriaBefore);
    } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
});

it('protected task: a restart over a preflight replaced by an older classification is refused before any state change', async () => {
    const taskId = 'T-protected-restart-stale-preflight';
    const fixture = await prepareProtectedTaskAtNavigatorRestart(taskId, AGENT_SUPPLEMENT);
    try {
        const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8'));
        // An older copy of the same task's preflight: it carries the earlier classified wording.
        preflight.effective_review_snapshot.inputs.task_intent = TASK_SUMMARY;
        if ('task_intent' in preflight) preflight.task_intent = TASK_SUMMARY;
        fs.writeFileSync(fixture.preflightPath, `${JSON.stringify(preflight, null, 2)}\n`);
        const eventsBefore = readTaskTimelineEvents(fixture.repoRoot, taskId).length;
        const restart = await runRestartCoherentCycleCommand(parseNavigatorRestartCommand(fixture.command, fixture.repoRoot));
        assert.notEqual(restart.exitCode, 0, restart.outputLines.join('\n'));
        assert.match(restart.outputLines.join('\n'), /COHERENT_CYCLE_RESTART_REFUSED/u);
        assert.match(restart.outputLines.join('\n'), /last classified/u);
        assert.equal(readTaskTimelineEvents(fixture.repoRoot, taskId).length, eventsBefore);
    } finally { fs.rmSync(fixture.repoRoot, { recursive: true, force: true }); }
});

// A real older classification (valid snapshot hash, earlier wording) replaces the preflight after a later classification.
it('protected task: a refused restart over a really older preflight leads through next-step to a recovery that makes progress', async () => {
    const taskId = 'T-protected-restart-older-copy';
    const repoRoot = createTempRepo();
    try {
        seedRemediationRepoBase(repoRoot);
        markAsSourceCheckout(repoRoot);
        writeCurrentReviewCycleValidationSource(repoRoot);
        writeReviewCapabilitiesConfig(repoRoot);
        writeProfilesConfig(repoRoot);
        writeWorkflowConfig(repoRoot, 'parallel_all');
        initializeGitRepo(repoRoot);
        writeProtectedControlPlaneManifest(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const changedFiles = ['src/app.ts', 'tests/app.test.ts'];
        const entered = runEnterTaskMode({ repoRoot, taskId, taskSummary: TASK_SUMMARY, plannedChangedFiles: changedFiles,
            orchestratorWork: true, operatorConfirmed: 'yes', operatorConfirmedAtUtc: new Date().toISOString() });
        assert.equal(entered.exitCode, 0, entered.outputLines.join('\n'));
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'src/app.ts'), 'export const value = 2;\n');
        fs.writeFileSync(path.join(repoRoot, 'tests/app.test.ts'), 'it("checks export", () => {});\n');
        const preflightPath = runExplicitPreflight(repoRoot, taskId, TASK_SUMMARY, changedFiles);
        const olderBytes = fs.readFileSync(preflightPath);
        runExplicitPreflight(repoRoot, taskId, AGENT_SUPPLEMENT, changedFiles);
        const latestBytes = fs.readFileSync(preflightPath);
        assert.notDeepEqual(olderBytes, latestBytes);
        await prepareCurrentReviewCycleValidation(repoRoot, taskId, preflightPath);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        fs.rmSync(path.join(getReviewsRoot(repoRoot), `${taskId}-handshake.json`));
        fs.rmSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`));
        const first = resolveNextStep({ repoRoot, taskId });
        assert.equal(first.next_gate, 'restart-coherent-cycle', JSON.stringify(first));
        const restartCommand = first.commands.find(entry => /restart-coherent-cycle/u.test(entry.command))?.command;
        assert.ok(restartCommand);
        // The older copy is a real earlier output of the product, so its snapshot hash is valid.
        fs.writeFileSync(preflightPath, olderBytes);
        const refused = await runRestartCoherentCycleCommand(parseNavigatorRestartCommand(restartCommand, repoRoot));
        assert.notEqual(refused.exitCode, 0, refused.outputLines.join('\n'));
        assert.match(refused.outputLines.join('\n'), /COHERENT_CYCLE_RESTART_REFUSED/u);
        const criteriaOf = (bytes: Buffer) => computeTaskCriteriaBinding({ repoRoot, taskId, preflight: JSON.parse(bytes.toString('utf8')) }).sha256;
        const recoveryGates = ['restart-coherent-cycle', 'handshake-diagnostics', 'shell-smoke-preflight', 'classify-change'];
        const gates: string[] = [];
        let next = resolveNextStep({ repoRoot, taskId });
        for (let step = 0; step < 8; step += 1) {
            // Side-effect-free inspection may first ask for a guarded effect plan; run it, then take the gate.
            for (let guard = 0; next.next_gate === 'next-step-effect' && guard < 4; guard += 1) {
                const planSha256 = /--effect-plan-sha256 "([a-f0-9]{64})"/u.exec(next.commands[0].command)?.[1];
                assert.ok(planSha256, JSON.stringify(next.commands));
                next = executeNextStepEffects({ taskId, repoRoot }, planSha256);
            }
            if (!recoveryGates.includes(String(next.next_gate))) break;
            const command = next.commands[0]?.command ?? '';
            assert.ok(command, JSON.stringify(next));
            gates.push(String(next.next_gate));
            if (next.next_gate === 'handshake-diagnostics') runHandshakeForTask(repoRoot, taskId);
            else if (next.next_gate === 'shell-smoke-preflight') runShellSmokeForTask(repoRoot, taskId);
            else if (next.next_gate === 'classify-change') {
                // The recovery names the classified intent, never the older copy's wording.
                assert.ok(command.includes(`--task-intent "${AGENT_SUPPLEMENT}"`), command);
                runClassifyChangeCommand({ repoRoot, taskId, taskIntent: AGENT_SUPPLEMENT, changedFiles, outputPath: preflightPath,
                    taskModePath: '', emitMetrics: false });
            } else assert.fail(`the recovery must not offer ${next.next_gate}: ${command}`);
            next = resolveNextStep({ repoRoot, taskId });
        }
        // Startup evidence is rebuilt in order, then the preflight is classified again; the restart is never offered.
        assert.deepEqual(gates.slice(0, 3), ['handshake-diagnostics', 'shell-smoke-preflight', 'classify-change'], gates.join(','));
        assert.ok(!gates.includes('restart-coherent-cycle'), gates.join(','));
        assert.ok(!recoveryGates.includes(String(next.next_gate)), JSON.stringify(next));
        // The task criteria never moved to the older wording, and nothing changed them without the operator.
        const finalPreflight = fs.readFileSync(preflightPath);
        assert.equal(resolvePreflightTaskIntent(JSON.parse(finalPreflight.toString('utf8'))), AGENT_SUPPLEMENT);
        assert.equal(criteriaOf(finalPreflight), criteriaOf(latestBytes));
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).filter(event => event.event_type === 'TASK_INTENT_UPDATED').length, 0);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});
