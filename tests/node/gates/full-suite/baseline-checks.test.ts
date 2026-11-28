import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseBaselineCheckCommands } from '../../../../src/core/baseline-check-config';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { assertGenericTaskEventAdmission } from '../../../../src/gate-runtime/timeline/task-event-generic-admission';
import { BASELINE_CHECK_EVALUATED_EVENT, BASELINE_CHECK_RECORDED_EVENT, baselineCheckCompletionViolations, baselineCheckReviewAdmissionViolations,
    entryRedInstruction, evaluateBaselineChecks, prepareTaskEntryBaselineChecks, readBaselineCheckDecision, recordTaskEntryBaselineChecks,
    redRunReason, refuseRedTaskEntryBaselineChecks, type BaselineCheckRun } from '../../../../src/gates/full-suite/baseline-checks';
import { resolveBaselineCheckRoute } from '../../../../src/gates/next-step/next-step-baseline-check-route';
import { collectRuntimeTaskState, resolveActiveTaskIds } from '../../../../src/core/task-queue/active-task-state';
import { validateWorkflowConfig } from '../../../../src/schemas/config-artifacts-workflow';

const TASK_ID = 'T-473';
const BUNDLE = 'garda-agent-orchestrator';
const EVENTS = `${BUNDLE}/runtime/task-events/${TASK_ID}.jsonl`;

/**
 * The project's own plan validator. Default mode is red while plan.md lists a missing card; `--app` is green until the
 * task change; `--sleep` hangs. Each run appends one line to runs.log, so a test sees whether a check ran.
 */
const CHECK = `const fs = require('node:fs');
const mode = process.argv[2] || '';
fs.appendFileSync('runs.log', (mode || 'plan') + '\\n');
if (mode === '--sleep') setTimeout(() => {}, 60000);
else if (mode === '--app') {
    if (fs.readFileSync('src/app.txt', 'utf8').includes('task change')) { console.log('app breaks the plan'); process.exit(2); }
    process.exit(0);
} else {
    const missing = fs.readFileSync('plan.md', 'utf8').split(/\\r?\\n/u).filter(line => line.includes('(missing card)'));
    for (const line of missing) console.log('Missing card ' + line.split(' ')[1]);
    process.exit(missing.length ? 1 : 0);
}
`;

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const TTV = 'garda gate task-test-validation';
const PLAN_RED = 'node check.cjs';
const APP = 'node check.cjs --app';

function fixture(t: TestContext, commands: string[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-t473-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, '.gitignore'), `${BUNDLE}/\nTASK.md\nruns.log\n`);
    fs.writeFileSync(path.join(root, 'src/app.txt'), 'base\n');
    fs.writeFileSync(path.join(root, 'plan.md'), '# Plan\n- T-006-7 (missing card)\n- T-007-1 (card)\n');
    fs.writeFileSync(path.join(root, 'check.cjs'), CHECK);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'stand@example.invalid']);
    git(root, ['config', 'user.name', 'Stand']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Baseline']);
    const bundle = path.join(root, BUNDLE);
    fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
    const declare = (list: string[]) => fs.writeFileSync(path.join(bundle, 'live/config/workflow-config.json'),
        JSON.stringify({ baseline_checks: { commands: list } }, null, 2) + '\n');
    declare(commands);
    /** enter-task-mode as the gate runs it: the checks first, a red one stops entry, else the entry event and the green record. */
    const enter = async (timeoutMs?: number) => {
        const prepared = await prepareTaskEntryBaselineChecks(root, TASK_ID, timeoutMs);
        const refusal = refuseRedTaskEntryBaselineChecks(prepared);
        if (refusal) return { prepared, refusal, lines: [] as string[] };
        appendTaskEvent(bundle, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Fixture task mode.', {});
        return { prepared, refusal, lines: recordTaskEntryBaselineChecks(root, TASK_ID, prepared) };
    };
    const change = (text = 'base\ntask change\n') => fs.writeFileSync(path.join(root, 'src/app.txt'), text);
    const compile = () => appendTaskEvent(bundle, TASK_ID, 'COMPILE_GATE_PASSED', 'PASS', 'Fixture compile.', {});
    const review = (outcome: 'PASS' | 'FAIL') => appendTaskEvent(bundle, TASK_ID, 'REVIEW_RECORDED', outcome, 'Fixture review.', {});
    const reviewGate = () => appendTaskEvent(bundle, TASK_ID, 'REVIEW_GATE_PASSED', 'PASS', 'Fixture review gate.', {});
    const events = (type: string) => (fs.existsSync(path.join(root, EVENTS)) ? fs.readFileSync(path.join(root, EVENTS), 'utf8').split(/\r?\n/u) : [])
        .filter(Boolean).map(line => JSON.parse(line) as { event_type: string; outcome: string; details: Record<string, unknown> })
        .filter(event => event.event_type === type);
    const runs = () => fs.existsSync(path.join(root, 'runs.log')) ? fs.readFileSync(path.join(root, 'runs.log'), 'utf8').split('\n').filter(Boolean) : [];
    const route = () => resolveBaselineCheckRoute({ repoRoot: root, taskId: TASK_ID, taskTestValidationCommand: TTV });
    return { root, bundle, declare, enter, change, compile, review, reviewGate, events, runs, route };
}

const run = (overrides: Partial<BaselineCheckRun>): BaselineCheckRun => ({ command: PLAN_RED, started: true, exit_code: 0,
    timed_out: false, cancelled: false, termination_signal: null, output_excerpt: [], ...overrides });

describe('declared baseline checks', () => {
    it('proceeds on a green entry and records the green result bound to that entry', async t => {
        const f = fixture(t, [APP]);
        const { refusal, lines } = await f.enter();
        assert.equal(refusal, null);
        assert.deepEqual(lines, [`BaselineCheck: ${APP} -> GREEN at task-mode entry.`]);
        const [event] = f.events(BASELINE_CHECK_RECORDED_EVENT);
        assert.deepEqual([event.outcome, event.details.verdict, event.details.exit_code], ['PASS', 'GREEN', 0]);
        assert.match(String(event.details.task_mode_entry_sha256), /^[a-f0-9]{64}$/u);
        assert.equal(event.details.head_commit, git(f.root, ['rev-parse', 'HEAD']).trim());
    });

    it('stops entry on a red check with one instruction and writes no task events', async t => {
        const f = fixture(t, [APP, PLAN_RED]);
        const { refusal } = await f.enter();
        assert.ok(refusal);
        assert.equal(refusal[0], 'TASK_MODE_ENTRY_REFUSED');
        assert.ok(refusal.includes(`BaselineCheck: ${PLAN_RED} -> RED before this task (it exited 1).`), refusal.join('\n'));
        assert.ok(refusal.includes('    Missing card T-006-7'));
        assert.ok(refusal.includes(entryRedInstruction(PLAN_RED)));
        assert.equal(entryRedInstruction(PLAN_RED), `Project check ${PLAN_RED} is red before this task. Fix it first (separately), or remove `
            + 'it from baseline_checks (workflow set --baseline-checks), then run enter-task-mode again.');
        assert.ok(!refusal.some(line => line.includes(APP)), 'A green check is not named');
        assert.equal(fs.existsSync(path.join(f.root, EVENTS)), false, 'A refused entry writes nothing to the task timeline');
        const discovery = collectRuntimeTaskState(f.bundle);
        assert.ok(![...discovery.activeTaskIds, ...discovery.ambiguousTaskIds].includes(TASK_ID), 'The never-entered task is not discovered');
        assert.ok(!resolveActiveTaskIds(f.root, f.bundle).has(TASK_ID));
        // The operator fixes the plan separately; the next entry runs the checks again and proceeds.
        fs.writeFileSync(path.join(f.root, 'plan.md'), '# Plan\n- T-007-1 (card)\n');
        const again = await f.enter();
        assert.equal(again.refusal, null);
        assert.equal(f.events('TASK_MODE_ENTERED').length, 1);
        assert.deepEqual(f.events(BASELINE_CHECK_RECORDED_EVENT).filter(event => event.details.verdict === 'GREEN')
            .map(event => event.details.command), [APP, PLAN_RED]);
    });

    it('stops entry on a check that did not finish', async t => {
        const f = fixture(t, ['node check.cjs --sleep']);
        const { refusal } = await f.enter(300);
        assert.ok(refusal?.includes('BaselineCheck: node check.cjs --sleep -> RED before this task (it timed out after 300 ms).'), refusal?.join('\n'));
        assert.equal(redRunReason(run({ started: false, exit_code: null, error: 'Executable not found' })), 'it could not start (Executable not found)');
        assert.equal(redRunReason(run({ cancelled: true })), 'it was cancelled');
        assert.equal(redRunReason(run({ termination_signal: 'SIGKILL' })), 'it was terminated by signal SIGKILL');
        assert.equal(redRunReason(run({})), null);
    });

    it('does not rerun a check that was green at an earlier entry, and runs a check declared mid-task at the next entry', async t => {
        const f = fixture(t, [APP]);
        await f.enter();
        assert.deepEqual(f.runs(), ['--app']);
        f.change();
        const reentry = await f.enter();
        assert.deepEqual([reentry.refusal, reentry.prepared?.runs.length, reentry.lines], [null, 0, []], 'The first-entry green stands');
        assert.deepEqual(f.runs(), ['--app'], 'A re-entry does not rerun it, although the task change would make it red');
        f.declare([APP, PLAN_RED]);
        const next = await f.enter();
        assert.deepEqual(next.prepared?.runs.map(entry => entry.command), [PLAN_RED], 'Only the newly declared check runs');
        assert.ok(next.refusal?.includes(entryRedInstruction(PLAN_RED)));
    });

    it('runs the entry check again when the timeline was reset and the green result is gone', async t => {
        const f = fixture(t, [APP]);
        await f.enter();
        fs.rmSync(path.join(f.root, EVENTS));
        f.change();
        const { refusal } = await f.enter();
        assert.ok(refusal?.includes(entryRedInstruction(APP)), 'A red check after a reset stops the entry');
        assert.deepEqual(f.runs(), ['--app', '--app']);
    });

    it('fails task test validation on a check the task broke, routes the fix and a rerun, and blocks review and completion', async t => {
        const f = fixture(t, [APP]);
        await f.enter();
        f.change();
        f.compile();
        const evaluation = await evaluateBaselineChecks(f.root, TASK_ID);
        assert.equal(evaluation.failed, true);
        assert.equal(evaluation.lines[0], `BaselineCheck: ${APP} -> RED (it exited 2); a red declared check is a failure of this task.`);
        assert.ok(evaluation.lines.includes('    app breaks the plan'));
        assert.ok(evaluation.lines.includes('  Next: fix this failure in this task, then follow next-step to rerun task test validation.'));
        const [event] = f.events(BASELINE_CHECK_EVALUATED_EVENT);
        assert.deepEqual([event.outcome, event.details.verdict], ['FAIL', 'RED']);
        const route = f.route();
        assert.equal(route?.nextGate, 'implementation');
        assert.equal(route?.title, 'Make the declared project check green again.');
        assert.match(route?.reason ?? '', /Fix it in this task so the check passes/u);
        assert.deepEqual(route?.commands.map(command => command.command), [TTV]);
        assert.match(baselineCheckReviewAdmissionViolations(f.root, TASK_ID)[0] ?? '', /is red \(it exited 2\)/u);
        assert.match(baselineCheckCompletionViolations(f.root, TASK_ID)[0] ?? '', /is red in this task and has no later green result/u);
        f.change('base\nfixed\n');
        f.compile();
        assert.deepEqual(readBaselineCheckDecision(f.root, TASK_ID)?.missing, [APP], 'The new compile pass needs a new evaluation');
        assert.equal(f.route()?.nextGate, 'full-suite-validation');
        const fixed = await evaluateBaselineChecks(f.root, TASK_ID);
        assert.deepEqual(fixed, { lines: [`BaselineCheck: ${APP} -> GREEN.`], failed: false });
        assert.equal(f.route(), null);
        assert.deepEqual(baselineCheckReviewAdmissionViolations(f.root, TASK_ID), []);
        assert.deepEqual(baselineCheckCompletionViolations(f.root, TASK_ID), []);
    });

    it('routes only a rerun for a run that did not finish', async t => {
        const f = fixture(t, []);
        await f.enter();
        f.declare(['node check.cjs --sleep']);
        f.compile();
        const evaluation = await evaluateBaselineChecks(f.root, TASK_ID, 300);
        assert.equal(evaluation.failed, true);
        assert.ok(evaluation.lines.some(line => /Next: the run did not finish/u.test(line)), evaluation.lines.join('\n'));
        assert.match(f.route()?.reason ?? '', /The run did not finish: remove the cause and rerun\./u);
    });

    it('requires a fresh green evaluation after each compile until all required reviews passed, then freezes', async t => {
        const f = fixture(t, [APP]);
        await f.enter();
        f.compile();
        assert.match(baselineCheckReviewAdmissionViolations(f.root, TASK_ID)[0] ?? '', /has no result for the current compiled scope/u);
        assert.equal(baselineCheckCompletionViolations(f.root, TASK_ID).length, 1, 'Completion refuses a missing evaluation');
        await evaluateBaselineChecks(f.root, TASK_ID);
        f.review('PASS'); // The code review passed.
        f.review('FAIL'); // The test review failed, and its fix breaks the check.
        f.change();
        f.compile();
        assert.deepEqual(readBaselineCheckDecision(f.root, TASK_ID), { failures: [], missing: [APP], reviewed: false },
            'A partial review does not freeze the evaluation');
        const broken = await evaluateBaselineChecks(f.root, TASK_ID);
        assert.equal(broken.failed, true, 'The red after a partial review is the task failure');
        assert.equal(baselineCheckReviewAdmissionViolations(f.root, TASK_ID).length, 1, 'The next review is not admitted');
        f.change('base\n');
        f.compile();
        await evaluateBaselineChecks(f.root, TASK_ID);
        f.review('PASS');
        f.reviewGate();
        f.declare([APP, PLAN_RED]);
        assert.deepEqual(readBaselineCheckDecision(f.root, TASK_ID), { failures: [], missing: [], reviewed: true },
            'After all required reviews passed nothing is evaluated, and a check declared later does not apply');
        assert.equal(f.route(), null);
        assert.deepEqual(baselineCheckCompletionViolations(f.root, TASK_ID), []);
        const after = await evaluateBaselineChecks(f.root, TASK_ID);
        assert.deepEqual(after, { lines: ['BaselineChecks: not evaluated again; all required reviews already passed in this task-mode cycle.'], failed: false });
        // A post-review change starts a new review cycle (restart-review-cycle): the compile after the review gate unfreezes.
        f.declare([APP]);
        f.change();
        f.compile();
        assert.deepEqual(readBaselineCheckDecision(f.root, TASK_ID), { failures: [], missing: [APP], reviewed: false },
            'A compile after the review gate pass needs a new evaluation');
        assert.equal(baselineCheckReviewAdmissionViolations(f.root, TASK_ID).length, 1, 'The next review needs it');
        assert.equal(baselineCheckCompletionViolations(f.root, TASK_ID).length, 1, 'Completion needs it');
        const restarted = await evaluateBaselineChecks(f.root, TASK_ID);
        assert.equal(restarted.failed, true, 'The change after the review broke the check: it is the task failure');
        assert.equal(f.route()?.nextGate, 'implementation');
    });

    it('treats a cycle without a compile pass as not evaluated instead of throwing', async t => {
        const f = fixture(t, [APP]);
        assert.deepEqual(readBaselineCheckDecision(f.root, TASK_ID), { failures: [], missing: [APP], reviewed: false }, 'No entry yet');
        await f.enter();
        assert.deepEqual(readBaselineCheckDecision(f.root, TASK_ID), { failures: [], missing: [APP], reviewed: false }, 'Entry without a compile');
        assert.equal(baselineCheckCompletionViolations(f.root, TASK_ID).length, 1);
        assert.equal(f.route()?.nextGate, 'full-suite-validation');
        // Task test validation before any compile pass cannot create an evaluation.
        const early = await evaluateBaselineChecks(f.root, TASK_ID);
        assert.equal(early.failed, true, early.lines.join('\n'));
        assert.deepEqual(f.events(BASELINE_CHECK_EVALUATED_EVENT), []);
        await f.enter();
        assert.deepEqual(readBaselineCheckDecision(f.root, TASK_ID), { failures: [], missing: [APP], reviewed: false });
    });

    it('cannot freeze on a review override or use a green result from an earlier compile', async t => {
        const f = fixture(t, [APP]);
        await f.enter();
        f.compile();
        await evaluateBaselineChecks(f.root, TASK_ID);
        appendTaskEvent(f.bundle, TASK_ID, 'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'PASS', 'Fixture review override.', {});
        assert.equal(readBaselineCheckDecision(f.root, TASK_ID)?.reviewed, false);
        f.compile();
        f.reviewGate();
        assert.deepEqual(readBaselineCheckDecision(f.root, TASK_ID), { failures: [], missing: [APP], reviewed: true });
        assert.equal(baselineCheckCompletionViolations(f.root, TASK_ID).length, 1);
    });

    it('accepts only literal check commands and reserves the event names', () => {
        assert.deepEqual(parseBaselineCheckCommands(['node docs/development/validate-plan.mjs']), ['node docs/development/validate-plan.mjs']);
        for (const command of ['node a.mjs | tee out', 'node a.mjs > out.log', 'FOO=1 node a.mjs', 'node a.mjs && node b.mjs', '']) {
            assert.throws(() => parseBaselineCheckCommands([command]), /baseline_checks\.commands\[0\]/u, command);
        }
        assert.throws(() => parseBaselineCheckCommands(['node a.mjs', 'node a.mjs']), /must not repeat/u);
        assert.throws(() => validateWorkflowConfig({ full_suite_validation: { enabled: false, command: 'npm test', timeout_ms: 1000,
            green_summary_max_lines: 5, red_failure_chunk_lines: 50, out_of_scope_failure_policy: 'AUDIT_AND_BLOCK' },
        baseline_checks: { commands: ['node a.mjs'], timeout_ms: 1 } }), /unknown keys: timeout_ms/u);
        for (const eventType of [BASELINE_CHECK_RECORDED_EVENT, BASELINE_CHECK_EVALUATED_EVENT]) {
            assert.throws(() => assertGenericTaskEventAdmission(eventType), /reserved/u);
        }
    });
});
