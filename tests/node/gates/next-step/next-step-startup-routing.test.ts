import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { inspectTaskEventFile, withTaskTimelineReadSnapshot } from '../../../../src/gate-runtime/task-events';

import {
    readTaskTimelineIntegrityRoute,
    resolveNextStepStartupRoute,
    type NextStepStartupRouteOptions
} from '../../../../src/gates/next-step/next-step-startup-routing';

test('timeline integrity routing reuses the inspected snapshot without file probes or subprocesses', t => {
    const eventsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-integrity-route-'));
    const timeline = path.join(eventsRoot, 'T-SNAPSHOT.jsonl');
    fs.writeFileSync(timeline, '{broken\n');
    try {
        withInvocationReadObservation(() => withTaskTimelineReadSnapshot(eventsRoot, 'T-SNAPSHOT', () => {
            assert.equal(inspectTaskEventFile(timeline, 'T-SNAPSHOT').status, 'FAILED');
            const nativeFs = require('node:fs') as typeof import('node:fs');
            const childProcess = require('node:child_process') as typeof import('node:child_process');
            const mocks = [
                ...(['existsSync', 'statSync', 'lstatSync', 'realpathSync', 'openSync', 'readSync', 'readFileSync'] as const)
                    .map(method => t.mock.method(nativeFs, method, () => { throw new Error('Unexpected file probe: ' + method); })),
                ...(['execSync', 'execFileSync', 'spawnSync'] as const)
                    .map(method => t.mock.method(childProcess, method, () => { throw new Error('Unexpected subprocess: ' + method); }))
            ];
            try {
                const route = readTaskTimelineIntegrityRoute(timeline, 'T-SNAPSHOT', 'garda');
                assert.ok(route);
                assert.equal(route.nextGate, 'task-reset');
                assert.match(route.commands[0].command, /--reopen --dry-run/u);
                for (const mock of mocks) assert.equal(mock.mock.callCount(), 0);
            } finally { for (const mock of mocks) mock.mock.restore(); }
        }));
    } finally { fs.rmSync(eventsRoot, { recursive: true, force: true }); }
});

function baseOptions(overrides?: Partial<NextStepStartupRouteOptions>): NextStepStartupRouteOptions {
    return {
        enterTaskModePassed: true,
        defaultExecutionProvider: 'Codex',
        enterTaskModeCommand: 'node bin/garda.js gate enter-task-mode --task-id "T-1"',
        startupCycleReadiness: {
            ready: true,
            nextGate: 'none',
            title: 'ready',
            reason: 'ready'
        },
        loadRulePackPassed: true,
        rulePackStage: 'TASK_ENTRY',
        preflightExists: false,
        taskEntryRulePackCommand: 'node bin/garda.js gate load-rule-pack --task-id "T-1"',
        handshakeDiagnosticsPassed: true,
        handshakeDiagnosticsCommand: 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"',
        shellSmokePreflightPassed: true,
        shellSmokePreflightCommand: 'node bin/garda.js gate shell-smoke-preflight --task-id "T-1"',
        ...overrides
    };
}

test('resolveNextStepStartupRoute routes missing task mode before startup diagnostics', () => {
    const route = resolveNextStepStartupRoute(baseOptions({
        enterTaskModePassed: false,
        startupCycleReadiness: {
            ready: false,
            nextGate: 'load-rule-pack',
            title: 'Load rules',
            reason: 'rules missing'
        }
    }));

    assert.ok(route);
    assert.equal(route.status, 'BLOCKED');
    assert.equal(route.nextGate, 'enter-task-mode');
    assert.equal(route.commands[0].label, 'Enter task mode');
    assert.equal(route.commands[0].command, 'node bin/garda.js gate enter-task-mode --task-id "T-1"');
});

test('resolveNextStepStartupRoute delegates current startup cycle gate commands', () => {
    const route = resolveNextStepStartupRoute(baseOptions({
        startupCycleReadiness: {
            ready: false,
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics for the current task-mode cycle.',
            reason: 'handshake missing'
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'handshake-diagnostics');
    assert.equal(route.title, 'Run handshake diagnostics for the current task-mode cycle.');
    assert.equal(route.reason, 'handshake missing');
    assert.equal(route.commands[0].label, 'Run handshake diagnostics');
    assert.equal(route.commands[0].command, 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"');
});

test('resolveNextStepStartupRoute preserves legacy task-entry fallbacks after startup readiness', () => {
    const route = resolveNextStepStartupRoute(baseOptions({
        loadRulePackPassed: false
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'load-rule-pack');
    assert.equal(route.title, 'Record TASK_ENTRY rule files.');
    assert.equal(route.reason, 'Task execution must record the loaded core workflow rule pack before preflight.');
    assert.equal(route.commands[0].label, 'Load TASK_ENTRY rules');
});

test('resolveNextStepStartupRoute asks the operator about a changed review policy instead of reloading rules', () => {
    const refusal = 'Task profile policy inputs changed after preflight (review lane policy). '
        + 'The task keeps the review policy frozen at task-mode entry.';
    // The failed POST_PREFLIGHT load also leaves the rule-pack gate unpassed.
    const refused = { loadRulePackPassed: false, rulePackStage: 'POST_PREFLIGHT', preflightExists: true };
    const command = 'node bin/garda.js gate enter-task-mode --task-id "T-1" --adopt-changed-review-policy "<digest>" '
        + '--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --repo-root "."';
    const route = resolveNextStepStartupRoute(baseOptions({
        ...refused,
        profilePolicyAdoption: { reason: refusal, laneChanges: ['code: true -> "auto"'], unadoptableChanges: [], command }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'enter-task-mode');
    assert.ok(route.reason.startsWith(refusal));
    assert.match(route.reason, /Review lanes would change: code: true -> "auto"\. [\s\S]*Revert the change[\s\S]*digest/u);
    assert.equal(route.commands[0].command, command);

    // A change beyond review lanes offers no adoption command: revert it or reset the task.
    const unadoptable = resolveNextStepStartupRoute(baseOptions({
        ...refused,
        profilePolicyAdoption: { reason: refusal, laneChanges: [], unadoptableChanges: ['finding_policy', 'review_finding_policy'], command }
    }));
    assert.equal(unadoptable?.nextGate, 'enter-task-mode');
    assert.match(unadoptable?.reason ?? '', /also alters finding_policy, review_finding_policy[\s\S]*reset the task/u);
    assert.deepEqual(unadoptable?.commands, []);
    // With the reset preview available, the operator handoff names it as its executable command.
    const reset = 'garda gate task-reset --task-id "T-1" --reopen --dry-run --repo-root "."';
    const unadoptableWithReset = resolveNextStepStartupRoute(baseOptions({
        ...refused, taskResetPreviewCommand: reset,
        profilePolicyAdoption: { reason: refusal, laneChanges: [], unadoptableChanges: ['review_finding_policy'], command }
    }));
    assert.equal(unadoptableWithReset?.nextGate, 'enter-task-mode');
    assert.deepEqual(unadoptableWithReset?.commands.map(entry => entry.command), [reset]);

    // Without a current drift (for example after a revert) the ordinary rule reload resumes.
    assert.equal(resolveNextStepStartupRoute(baseOptions({ ...refused, profilePolicyAdoption: null }))?.nextGate, 'load-rule-pack');
});

test('startup finishes an authenticated pending review before policy adoption, but never before task-mode recovery', () => {
    const pending = { status: 'BLOCKED' as const, nextGate: 'complete-reviewer-launch', title: 'Finish review',
        reason: 'Frozen context is current', commands: [{ label: 'Finish review', command: 'complete' }] };
    const adoption = { reason: 'policy changed', laneChanges: ['code: true -> auto'], unadoptableChanges: [], command: 'adopt' };
    assert.deepEqual(resolveNextStepStartupRoute(baseOptions({ profilePolicyAdoption: adoption,
        pendingPolicyReview: () => pending })), pending);
    assert.equal(resolveNextStepStartupRoute(baseOptions({ profilePolicyAdoption: adoption,
        pendingPolicyReview: () => null }))?.nextGate, 'enter-task-mode');
    assert.equal(resolveNextStepStartupRoute(baseOptions({ enterTaskModePassed: false,
        profilePolicyAdoption: adoption, pendingPolicyReview: () => pending }))?.nextGate, 'enter-task-mode');
    assert.equal(resolveNextStepStartupRoute(baseOptions({ unapprovedActiveTaskOwners: ['T-2'],
        profilePolicyAdoption: adoption, pendingPolicyReview: () => pending }))?.nextGate, 'enter-task-mode');
});

test('resolveNextStepStartupRoute returns null after startup gates are satisfied', () => {
    assert.equal(resolveNextStepStartupRoute(baseOptions()), null);
});
