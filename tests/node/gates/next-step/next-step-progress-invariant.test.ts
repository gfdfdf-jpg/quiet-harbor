import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    AGENT_ACTION_GATES,
    OPERATOR_DECISION_GATES,
    SAFE_EXIT_LABEL,
    applyNextStepSafeExit,
    findNextStepProgressViolation,
    type NextStepProgressSubject
} from '../../../../src/gates/next-step/next-step-progress-invariant';
import type { NextStepCommand } from '../../../../src/gates/next-step/next-step';
import { renderNextStepOutput, type RenderNextStepOutputParams } from '../../../../src/gates/next-step/next-step-output-rendering';
import { resolveClassifyDecisionRoute, resolveCompletedCloseoutDecisionRoute } from '../../../../src/gates/next-step/next-step-decision-route-groups';
import { createNextStepDecisionRouteCoordinator } from '../../../../src/gates/next-step/next-step';
import { NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE } from '../../../../src/gates/next-step/next-step-decision-engine';
import {
    isResolvedRetryExhausted,
    isProtectedPreflightFailureResolved
} from '../../../../src/gates/next-step/next-step-preflight-recovery';
import { computePreflightCauseWitness, PREFLIGHT_CAUSE_WITNESS_FIELD } from '../../../../src/gates/preflight/preflight-cause-witness';
import { PARENT_SOURCE_PREREQUISITES_REASON } from '../../../../src/gates/parent-audit/parent-audit-navigation';
import { getCurrentWorkflowConfigFileHashes } from '../../../../src/gates/workflow-config/workflow-config-work-paths';

const CLI = 'node garda-agent-orchestrator/bin/garda.js';
const subject = (overrides: Partial<NextStepProgressSubject>): NextStepProgressSubject => ({
    taskId: 'T-9', navigatorCommand: `${CLI} next-step "T-9" --repo-root "."`, status: 'BLOCKED',
    nextGate: 'compile-gate', reason: 'Blocked.', commands: [], ...overrides
});
const doctor = { label: 'Inspect Garda installation', command: `${CLI} doctor --target-root "."` };
const gate = { label: 'Retry', command: `${CLI} gate classify-change --task-id "T-9" --repo-root "."` };
const preview = { label: SAFE_EXIT_LABEL, command: `${CLI} gate task-reset --task-id "T-9" --reopen --dry-run --repo-root "."` };

test('the progress invariant rejects commandless, diagnostic-only and operator-only routes and accepts the rest', () => {
    // Field shapes: OP-046/OP-048/OP-054/OP-055 (no command) and OP-056 (doctor only) on a route without a decision.
    for (const nextGate of ['compile-gate', 'classify-change', 'task-reset', null]) {
        assert.match(String(findNextStepProgressViolation(subject({ nextGate }))), /has no command/u, String(nextGate));
    }
    assert.match(String(findNextStepProgressViolation(subject({ commands: [doctor] }))), /no agent command/u);
    const operatorOnly = { label: 'Reset', command: `${CLI} gate task-reset --task-id "T-9" --reopen --confirm --repo-root "."` };
    assert.match(String(findNextStepProgressViolation(subject({ commands: [operatorOnly] }))), /no agent command/u);
    // The safe-exit preview is the fallback itself: it never counts as progress.
    assert.match(String(findNextStepProgressViolation(subject({ commands: [preview] }))), /has no command/u);
    assert.equal(findNextStepProgressViolation(subject({ commands: [doctor, gate] })), null);
    assert.equal(findNextStepProgressViolation(subject({ commands: [gate] })), null);
    assert.equal(findNextStepProgressViolation(subject({ status: 'DONE', nextGate: null })), null);
    assert.equal(findNextStepProgressViolation(subject({ status: 'SPLIT_REQUIRED', nextGate: 'split-required-latch' })), null);
    // Justified exemptions: operator decisions and the agent's own stated work, each only with a stated reason.
    for (const [nextGate, entry] of Object.entries(OPERATOR_DECISION_GATES)) {
        assert.ok(entry.why.length > 10, `${nextGate} states why it is an operator decision`);
        const commands = entry.requiresCommand ? [doctor] : [];
        assert.equal(findNextStepProgressViolation(subject({ nextGate, commands })), null, nextGate);
        assert.match(String(findNextStepProgressViolation(subject({ nextGate, commands, reason: ' ' }))), /states no decision/u, nextGate);
    }
    // LOW-5: the guard route always carries a real command, so a regression to none (or the preview alone) is reported.
    assert.match(String(findNextStepProgressViolation(subject({ nextGate: 'post-review-source-mutation-guard' }))), /lost the command/u);
    assert.match(String(findNextStepProgressViolation(subject({ nextGate: 'post-review-source-mutation-guard', commands: [preview] }))), /lost the command/u);
    // HIGH-1 / MEDIUM-2: the exemptions follow the producing route's marker, not a shared gate name.
    for (const nextGate of ['project-validation-evidence', 'task-audit-summary']) {
        assert.match(String(findNextStepProgressViolation(subject({ nextGate }))), /has no command/u, nextGate);
        assert.equal(findNextStepProgressViolation(subject({ nextGate, decision: 'operator' })), null, nextGate);
        assert.match(String(findNextStepProgressViolation(subject({ nextGate, decision: 'operator', reason: '' }))), /states no decision/u);
    }
    for (const nextGate of AGENT_ACTION_GATES) {
        assert.equal(findNextStepProgressViolation(subject({ nextGate })), null, nextGate);
        assert.match(String(findNextStepProgressViolation(subject({ nextGate, reason: '' }))), /names no action/u, nextGate);
    }
    // A transient external cause (unreadable Git index): the stated retry of next-step is the progressing command.
    const retry = { label: 'Retry next-step', command: `${CLI} next-step "T-9" --repo-root "."` };
    assert.equal(findNextStepProgressViolation(subject({ nextGate: 'git-observation', commands: [retry] })), null);
    assert.match(String(findNextStepProgressViolation(subject({ commands: [retry] }))), /no agent command/u);
});

test('the safe exit adds the read-only reopen preview once, keeps the route and never adds authority', () => {
    const exit = applyNextStepSafeExit(subject({ nextGate: 'operator-maintenance', commands: [doctor], reason: 'Doctor only.' }));
    assert.equal(exit.nextGate, 'operator-maintenance');
    assert.deepEqual(exit.commands[0], doctor);
    assert.equal(exit.commands.length, 2);
    assert.deepEqual(exit.commands[1], preview);
    assert.doesNotMatch(exit.commands[1].command, /--confirm|--operator-confirmed/u);
    assert.ok(exit.reason.startsWith('Doctor only. '), exit.reason);
    assert.match(exit.reason, /read-only preview/u);
    assert.doesNotMatch(exit.reason, /files are kept|preserv/iu, 'the wording claims only what is verified');
    assert.equal(applyNextStepSafeExit(exit), exit, 'idempotent');
    const progressing = subject({ commands: [gate] });
    assert.equal(applyNextStepSafeExit(progressing), progressing);
    const agentAction = subject({ nextGate: 'implementation' });
    assert.equal(applyNextStepSafeExit(agentAction), agentAction);
});

const render = (nextGate: string | null, commands: NextStepCommand[]) => renderNextStepOutput({
    taskId: 'T-9', navigatorCommand: `${CLI} next-step "T-9" --repo-root "."`, status: 'BLOCKED', nextGate,
    title: 'Blocked.', reason: 'Blocked.', commands, missingArtifacts: [], presentArtifacts: [],
    invalidationImpact: null, knownNonBlockingSignals: []
} as unknown as RenderNextStepOutputParams);
const check = (result: ReturnType<typeof render>) => findNextStepProgressViolation({ taskId: result.task_id,
    navigatorCommand: result.navigator_command, status: result.status, nextGate: result.next_gate, reason: result.reason, commands: result.commands,
    decision: result.route_decision });

test('meta: the safe exit never hides a route without an agent command from the check on the rendered answer', () => {
    const gates = ['compile-gate', 'classify-change', 'task-reset', 'review-validation-checkpoint', null,
        ...Object.keys(OPERATOR_DECISION_GATES), ...AGENT_ACTION_GATES];
    for (const nextGate of gates) for (const commands of [[], [doctor], [gate], [doctor, gate]]) {
        const result = render(nextGate, commands);
        const listed = nextGate !== null ? OPERATOR_DECISION_GATES[nextGate] : undefined;
        const decided = nextGate !== null && (AGENT_ACTION_GATES.includes(nextGate)
            || (listed !== undefined && (!listed.requiresCommand || commands.length > 0)));
        const lacksAgentCommand = !commands.includes(gate);
        assert.equal(check(result) !== null, !decided && lacksAgentCommand, `${String(nextGate)} with ${commands.length} command(s)`);
        assert.deepEqual(result.commands.slice(0, commands.length), commands, 'Original commands keep their order');
        const agentAction = nextGate !== null && AGENT_ACTION_GATES.includes(nextGate);
        assert.equal(result.commands.at(-1)?.label === SAFE_EXIT_LABEL, lacksAgentCommand && !agentAction);
    }
});

test('meta: a real route resolver that returns no command is reported on the rendered answer (T-403 H1)', () => {
    const route = resolveClassifyDecisionRoute({
        preflightExists: true, classifyChangePassed: false,
        readFailedGateRecovery: () => ({ nextGate: 'compile-gate', title: 'Stuck.', reason: 'A failed step without a retry.' }),
        resolveStrictDecompositionRoute: () => null, resolveProtectedScopeRoute: () => null,
        buildClassifyCommand: () => gate.command
    });
    assert.ok(route);
    assert.deepEqual(route.commands, []);
    const result = render(route.nextGate, route.commands);
    // The user still gets the safe exit, but the invariant reports the route as a regression.
    assert.equal(result.commands.at(-1)?.label, SAFE_EXIT_LABEL);
    assert.match(String(check(result)), /has no command/u);
});

test('a resolved stale failure re-offers the failed classification instead of its maintenance route (OP-056)', () => {
    const route = resolveClassifyDecisionRoute({
        preflightExists: true,
        classifyChangePassed: false,
        readFailedGateRecovery: () => ({
            nextGate: 'classify-change', title: 'Retry the failed classification: its cause is resolved.',
            reason: 'Latest PREFLIGHT_FAILED event (seq 355) reported a protected workflow-config change, but the current files match.',
            resolvedFailure: true
        }),
        resolveStrictDecompositionRoute: () => null,
        resolveProtectedScopeRoute: () => null,
        buildClassifyCommand: () => gate.command
    });
    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.equal(route.commands[0]?.command, gate.command);
    assert.match(route.reason, /seq 355/u);
    // A remaining cause keeps its own route; the resolved flag is the only thing that falls through.
    const kept = resolveClassifyDecisionRoute({
        preflightExists: true,
        classifyChangePassed: false,
        readFailedGateRecovery: () => ({ nextGate: 'operator-maintenance', title: 'Self-guard.', reason: 'Drift remains.', command: doctor.command }),
        resolveStrictDecompositionRoute: () => null,
        resolveProtectedScopeRoute: () => null,
        buildClassifyCommand: () => { throw new Error('A remaining cause must not fall through to classify.'); }
    });
    assert.equal(kept?.nextGate, 'operator-maintenance');
});

test('a resolved failure is never proven by an unreadable Git workspace (T-403 M1)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-t403-m1-'));
    try {
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{}\n');
        for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'base']]) {
            execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
        }
        const hashes = getCurrentWorkflowConfigFileHashes(repoRoot);
        assert.ok(Object.keys(hashes).length > 0);
        const taskMode = { workflow_config_file_hashes: hashes };
        assert.equal(isProtectedPreflightFailureResolved(repoRoot, taskMode, () => null), false);
        assert.equal(isProtectedPreflightFailureResolved(repoRoot, taskMode, () => ({ changed_files: [] }) as never), true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

const WITNESS_A = 'a'.repeat(64);
const WITNESS_B = 'b'.repeat(64);
const failure = (sequence: number, error: string, witness?: string | null) => ({
    sequence, event_type: 'PREFLIGHT_FAILED', timestamp_utc: new Date(1000 * sequence).toISOString(),
    details: { error, ...(witness === undefined ? {} : { [PREFLIGHT_CAUSE_WITNESS_FIELD]: witness }) }
}) as never;
const workflowConfigError = 'Workflow config files changed before task-mode: use enter-task-mode --workflow-config-work with --orchestrator-work';
const controlPlaneError = 'Preflight scope touches protected orchestrator control-plane files without task-mode --orchestrator-work: '
    + 'garda-agent-orchestrator/dist/x.js. Restart task mode as orchestrator work before preflight classification. '
    + 'Suggested command: node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "T-9" --orchestrator-work';

test('the failed classification is re-offered once per observed content resolution (T-403 M2, M3, N2)', () => {
    for (const error of [workflowConfigError, controlPlaneError]) {
        const first = failure(5, error, WITNESS_A);
        let reads = 0;
        const read = (witness: string | null) => () => { reads += 1; return witness; };
        assert.equal(isResolvedRetryExhausted([first], first, 1, read(null)), false, 'a first failure is always re-offered');
        assert.equal(reads, 0, 'a first failure needs no witness');
        // The field sequence: the retry failed while still drifted (witness A), then the operator rolled back (content B).
        const second = failure(9, error, WITNESS_A);
        assert.equal(isResolvedRetryExhausted([first, second], second, 1, read(WITNESS_B)), false, 'rollback after the failed retry re-offers once');
        // A retry that failed after the cause was observed gone (content unchanged since) is not offered again: no endless loop.
        assert.equal(isResolvedRetryExhausted([first, second], second, 1, read(WITNESS_A)), true);
        // Unknown witnesses fail closed: unreadable now, or never recorded (an older failure event).
        assert.equal(isResolvedRetryExhausted([first, second], second, 1, read(null)), true, 'an unreadable current witness stays conservative');
        for (const recorded of [undefined, null, '', 'not-a-sha']) {
            const legacy = failure(9, error, recorded);
            assert.equal(isResolvedRetryExhausted([first, legacy], legacy, 1, read(WITNESS_B)), true, `recorded witness ${String(recorded)}`);
        }
        assert.equal(isResolvedRetryExhausted([first, second], second, 7, read(WITNESS_A)), false, 'a failure before the current task-mode entry does not count');
        assert.equal(isResolvedRetryExhausted([failure(3, 'No such file'), second], second, 1, read(WITNESS_A)), false);
    }
});

/** A minimal installed layout: the workflow-config file and one bundle runtime file under the protected roots. */
function writeProtectedLayout(repoRoot: string): { config: string; bundleFile: string } {
    const config = path.join(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
    const bundleFile = path.join(repoRoot, 'garda-agent-orchestrator/dist/x.js');
    for (const [file, text] of [[config, '{}\n'], [bundleFile, 'module.exports = 1;\n']] as const) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    return { config, bundleFile };
}

test('the content witness sees a restore that keeps the old modification time (T-403 N2, N3)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-t403-n3-'));
    try {
        const files = writeProtectedLayout(repoRoot);
        const resolvedWitness = computePreflightCauseWitness(repoRoot);
        assert.match(String(resolvedWitness), /^[a-f0-9]{64}$/u);
        assert.equal(computePreflightCauseWitness(repoRoot), resolvedWitness, 'the witness is stable for unchanged content');
        // Both variants: a Garda update rewrites the workflow-config file or a manifest-covered bundle file.
        for (const [file, error] of [[files.config, workflowConfigError], [files.bundleFile, controlPlaneError]] as const) {
            const original = fs.readFileSync(file);
            const before = fs.statSync(file);
            fs.writeFileSync(file, original.toString('utf8') + '// update\n');
            const driftedWitness = computePreflightCauseWitness(repoRoot);
            assert.ok(driftedWitness && driftedWitness !== resolvedWitness, file);
            const first = failure(5, error, driftedWitness);
            const retriedWhileDrifted = failure(9, error, driftedWitness);
            // The operator restores the original bytes with their original (older than the failure) modification time.
            fs.writeFileSync(file, original);
            fs.utimesSync(file, before.atime, before.mtime);
            assert.ok(Math.abs(fs.statSync(file).mtimeMs - before.mtimeMs) < 1, 'the restore keeps the old time');
            const current = () => computePreflightCauseWitness(repoRoot);
            assert.equal(current(), resolvedWitness);
            assert.equal(isResolvedRetryExhausted([first, retriedWhileDrifted], retriedWhileDrifted, 1, current), false,
                'a content change counts as a resolution whatever its modification time');
            // The re-offered retry failed again on the restored content: unchanged content is not re-offered again.
            const retriedAfterRestore = failure(12, error, resolvedWitness);
            assert.equal(isResolvedRetryExhausted([first, retriedWhileDrifted, retriedAfterRestore], retriedAfterRestore, 1, current), true);
        }
        // An unreadable input (an invalid trusted manifest) gives no witness, and no witness means exhausted.
        const manifestPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/protected-control-plane-manifest.json');
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, '{ not json');
        assert.equal(computePreflightCauseWitness(repoRoot), null);
        const drifted = failure(9, controlPlaneError, WITNESS_A);
        assert.equal(isResolvedRetryExhausted([failure(5, controlPlaneError, WITNESS_A), drifted], drifted, 1,
            () => computePreflightCauseWitness(repoRoot)), true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('the operator decision of a not-ready final report reaches the rendered next-step answer (T-403 N1)', () => {
    const route = resolveCompletedCloseoutDecisionRoute({
        completionGatePassed: true, latestCompletionCurrent: true, postDoneDriftBlocked: false, postDoneDriftReason: '',
        finalReportContractReady: false, finalReportContractBlocker: 'Review receipt bindings are missing.', finalReport: null,
        taskAuditCommand: `${CLI} gate task-audit-summary --task-id "T-9" --repo-root "."`, taskAuditTaskId: 'T-9',
        missingArtifacts: []
    });
    assert.ok(route);
    assert.equal(route.nextGate, 'task-audit-summary');
    assert.equal(route.decision, 'operator', 'the payload rebuild keeps the marker of the producing route');
    // The navigator's decision coordinator selects the route at its checkpoint and keeps the marker.
    const select = createNextStepDecisionRouteCoordinator({ source: 'authenticated-resolution-context', taskId: 'T-9',
        taskModePath: 'garda-agent-orchestrator/runtime/reviews/T-9-task-mode.json', preflightSha256: 'p' });
    const closeoutIndex = NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE.indexOf('completed-closeout');
    for (const checkpoint of NEXT_STEP_DECISION_CHECKPOINT_PRECEDENCE.slice(0, closeoutIndex)) {
        assert.equal(select(checkpoint, 'normal', null), null);
    }
    const selected = select('completed-closeout', 'normal', route);
    assert.ok(selected);
    // The payload fields go to the output builder as the navigator's route result passes them.
    const result = renderNextStepOutput({
        taskId: 'T-9', navigatorCommand: `${CLI} next-step "T-9" --repo-root "."`, ...selected,
        missingArtifacts: selected.missingArtifacts ?? [], presentArtifacts: [], invalidationImpact: null, knownNonBlockingSignals: []
    } as unknown as RenderNextStepOutputParams);
    assert.equal(result.route_decision, 'operator');
    assert.equal(check(result), null, 'a legitimate operator decision is not a dead end');
    assert.equal(result.commands.at(-1)?.label, SAFE_EXIT_LABEL, 'the operator still gets the read-only reopen preview');
    // Without the marker the same answer is the reported dead end: the exemption rests on the marker alone.
    assert.match(String(check({ ...result, route_decision: undefined })), /'task-audit-summary' has no command/u);
});

test('a navigator run of another task or with effects is a stated step, a plain rerun of this task is not', () => {
    const other = { label: 'Continue parent', command: `${CLI} next-step "T-PARENT" --repo-root "."` };
    const effects = { label: 'Publish', command: `${CLI} next-step "T-9" --repo-root "." --execute-effects --effect-plan-sha256 abc` };
    assert.equal(findNextStepProgressViolation(subject({ commands: [other] })), null);
    assert.equal(findNextStepProgressViolation(subject({ commands: [effects] })), null);
});

test('a gate-less operator decision is accepted only for the exported parent-acceptance reason (LOW-4)', () => {
    const reason = PARENT_SOURCE_PREREQUISITES_REASON;
    assert.equal(findNextStepProgressViolation(subject({ nextGate: null, reason })), null);
    assert.match(String(findNextStepProgressViolation(subject({ nextGate: null, reason: 'Something else.' }))), /has no command/u);
});
