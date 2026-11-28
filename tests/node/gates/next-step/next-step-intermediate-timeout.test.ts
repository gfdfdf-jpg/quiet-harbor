import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    readTimedOutIntermediateAttempt,
    resolveTimedOutIntermediateRoute,
    type TimedOutIntermediateAttempt
} from '../../../../src/gates/next-step/next-step-intermediate-timeout';
import { quoteCommandValue } from '../../../../src/gates/next-step/next-step-command-formatters';
import {
    ALL_REVIEW_FLAGS,
    TASK_ID,
    appendEvent,
    fileSha256,
    makeTempRepo,
    normalizeForTimeline,
    reviewsRoot,
    seedStartedTask,
    writeJson,
    writePreflight
} from './next-step-full-suite-fixtures';

const SLOW_COMMAND = 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/slow-suite.test.ts';
const PREFLIGHT = `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json`;
const offeredCommand = `node bin/garda.js gate run-intermediate-command --task-id "${TASK_ID}" --command-source targeted-test `
    + `--command ${quoteCommandValue(SLOW_COMMAND)} --preflight-path "${PREFLIGHT}" --repo-root "."`;
const timedOut: TimedOutIntermediateAttempt = { command: SLOW_COMMAND, durationMs: 120_743, suggestedTimeoutMs: 300_000 };

function route(commands: string[], nextGate = 'run-intermediate-command') {
    return { status: 'BLOCKED' as const, nextGate, title: 'Run current validation.', reason: 'Validation is pending.',
        commands: commands.map(command => ({ label: 'Execute current project check', command })) };
}

let tempRoots: string[] = [];
afterEach(() => {
    for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
    tempRoots = [];
});

function recordAttempt(repoRoot: string, record: Record<string, unknown>, outcome: string): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-intermediate-command-targeted-test-slow.json`);
    writeJson(artifactPath, { schema_version: 1, task_id: TASK_ID, command_source: 'targeted-test', command: SLOW_COMMAND,
        cancelled: false, output_truncated: false, ...record });
    appendEvent(repoRoot, TASK_ID, 'INTERMEDIATE_COMMAND_RUN', outcome, {
        command_source: 'targeted-test', command: SLOW_COMMAND,
        artifact_path: normalizeForTimeline(artifactPath), artifact_sha256: fileSha256(artifactPath),
        preflight_path: normalizeForTimeline(preflightPath), preflight_sha256: fileSha256(preflightPath),
        exit_code: record.exit_code, duration_ms: record.duration_ms
    });
}

describe('gates/next-step intermediate command timeout', () => {
    it('does not re-offer a timed-out check unchanged: operator-confirmed longer limit or --selected-case split', () => {
        const result = resolveTimedOutIntermediateRoute({ route: route([offeredCommand]), readAttempt: () => timedOut,
            cliPrefix: 'node bin/garda.js', taskId: TASK_ID, preflightCommandPath: PREFLIGHT });

        assert.equal(result.nextGate, 'run-intermediate-command');
        assert.equal(result.commands.length, 1);
        assert.notEqual(result.commands[0].command, offeredCommand);
        assert.ok(result.commands[0].command.endsWith(' --timeout-ms 300000 --repo-root "."'), result.commands[0].command);
        assert.ok(result.commands[0].command.startsWith(offeredCommand.replace(/ --repo-root "\."$/u, '')));
        assert.equal(result.commands[0].label, 'Run the check with a longer limit after operator confirmation');
        assert.match(result.reason, /timed out after 121 s/u);
        assert.match(result.reason, /--selected-case/u);
    });

    it('keeps other routes, other commands and explicit limits unchanged', () => {
        const options = { readAttempt: () => timedOut, cliPrefix: 'node bin/garda.js', taskId: TASK_ID, preflightCommandPath: PREFLIGHT };
        const other = route([offeredCommand.replace('slow-suite', 'other-suite')]);
        assert.equal(resolveTimedOutIntermediateRoute({ ...options, route: other }), other);
        const explicit = route([offeredCommand.replace(' --repo-root', ' --timeout-ms 600000 --repo-root')]);
        assert.equal(resolveTimedOutIntermediateRoute({ ...options, route: explicit }), explicit);
        const compile = route(['node bin/garda.js gate compile-gate --task-id "T"'], 'compile-gate');
        assert.equal(resolveTimedOutIntermediateRoute({ ...options, route: compile }), compile);
        const noAttempt = route([offeredCommand]);
        assert.equal(resolveTimedOutIntermediateRoute({ ...options, readAttempt: () => null, route: noAttempt }), noAttempt);
    });

    it('reads only an authenticated timed-out latest attempt of the current preflight', () => {
        const repoRoot = makeTempRepo();
        tempRoots.push(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        assert.equal(readTimedOutIntermediateAttempt(repoRoot, TASK_ID), null);

        recordAttempt(repoRoot, { status: 'FAILED', exit_code: 1, timed_out: false, duration_ms: 5_000 }, 'FAILED');
        assert.equal(readTimedOutIntermediateAttempt(repoRoot, TASK_ID), null, 'an ordinary failure is not a timeout');

        recordAttempt(repoRoot, { status: 'FAILED', exit_code: 1, timed_out: true, duration_ms: 120_743 }, 'FAILED');
        assert.deepEqual(readTimedOutIntermediateAttempt(repoRoot, TASK_ID),
            { command: SLOW_COMMAND, durationMs: 120_743, suggestedTimeoutMs: 300_000 });

        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-intermediate-command-targeted-test-slow.json`);
        fs.appendFileSync(artifactPath, ' ');
        assert.equal(readTimedOutIntermediateAttempt(repoRoot, TASK_ID), null, 'a changed artifact grants nothing');

        recordAttempt(repoRoot, { status: 'PASSED', exit_code: 0, timed_out: false, duration_ms: 137_000 }, 'PASSED');
        assert.equal(readTimedOutIntermediateAttempt(repoRoot, TASK_ID), null, 'a later run replaces the timeout');
    });
});
