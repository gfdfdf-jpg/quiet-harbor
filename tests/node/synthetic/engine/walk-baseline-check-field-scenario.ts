import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WalkScenario } from './navigator-walk';

export const T473_FIELD_CASE_ID = 'field-onlinestore-t473-baseline-project-checks';

const TASK = 'T-WALK';
const PLAN = 'docs/plan.md';
const CHECK = 'tools/validate-plan.cjs';
const OLD_CARDS = `node ${CHECK}`;
const APP_CARDS = `node ${CHECK} --app`;
const EVENTS = `garda-agent-orchestrator/runtime/task-events/${TASK}.jsonl`;
const CONFIG = 'garda-agent-orchestrator/live/config/workflow-config.json';
const PRODUCT_MARK = 'Product change.';
const PLAN_CARD = 'plan card T-007-1';
const RED_STOP = /Project check node tools\/validate-plan\.cjs is red before this task\. Fix it first \(separately\), or remove it from baseline_checks \(workflow set --baseline-checks\), then run enter-task-mode again\./u;

/**
 * The project's own plan validator, as in the OnlineStore shop: no Garda gate runs it. Default mode reports the old
 * missing cards (red before the task until the operator adds them). `--app` is green at entry and fails while the
 * product change has no plan card in the regression test, and reports whether the task row is active yet (entry runs it
 * before the status change).
 */
const VALIDATOR = `'use strict';
const fs = require('node:fs');
if (process.argv[2] === '--app') {
    const uncovered = fs.readFileSync('src/app.ts', 'utf8').includes('${PRODUCT_MARK}')
        && !fs.readFileSync('tests/app.test.ts', 'utf8').includes('${PLAN_CARD}');
    if (uncovered) { console.log('src/app.ts: product change has no plan card'); process.exit(2); }
    const row = fs.readFileSync('TASK.md', 'utf8').split(/\\r?\\n/u).find(line => line.startsWith('| ${TASK} |')) ?? '';
    console.log('plan ok; ${TASK} ' + (row.includes('IN_PROGRESS') ? 'is active' : 'is not active yet'));
    process.exit(0);
}
const missing = fs.readFileSync('${PLAN}', 'utf8').split(/\\r?\\n/u).filter(line => line.includes('(missing card)'));
for (const line of missing) console.log('Missing card ' + line.split(' ')[1] + ' in ${PLAN}');
process.exit(missing.length ? 1 : 0);
`;

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

function events(root: string, type: string): Array<{ outcome: string; details: Record<string, unknown> }> {
    const file = path.join(root, EVENTS);
    return (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/u) : []).filter(Boolean)
        .map(line => JSON.parse(line) as { event_type: string; outcome: string; details: Record<string, unknown> })
        .filter(event => event.event_type === type);
}

/**
 * T-473 (OnlineStore): T-007-1 only added a contract document, but the project's required plan validator was already red
 * on old cards, and nothing told the agent how to treat a red check it did not cause. With both checks declared as
 * baseline checks, the red plan validator stops task-mode entry with one instruction; the operator adds the old cards
 * separately (its own commit) and entry proceeds with both checks green. The task then breaks `--app`: task test
 * validation fails, real next-step routing sends it to a fix, and after the fix the task reaches DONE.
 */
export function baselineProjectCheckScenario(): WalkScenario {
    let operatorFixed = false;
    let fixed = false;
    let failureRouted = false;
    let repoRoot = '';
    return {
        id: T473_FIELD_CASE_ID,
        edits: [{ path: 'src/app.ts', append: `// ${PRODUCT_MARK}\n` }, { path: 'tests/app.test.ts', append: '// Task regression.\n' }],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'], enforceReviewExpectations: true,
        // Entry stops once on the red plan validator. The first task test validation fails on the check the task broke;
        // after the file fix the offered re-evaluation asks for a refreshed preflight first (the implementation step).
        expectedFailingGates: ['enter-task-mode', 'full-suite-validation', 'implementation'],
        // The refused entry writes nothing; after the operator's own commit the same entry command runs once more.
        boundedRetries: [{ gate: 'enter-task-mode', attempts: 1 }],
        disturbanceReason: 'T-473: the project plan validator is red on old cards before the task, and the task breaks a second plan check.',
        configure: root => {
            operatorFixed = false; fixed = false; failureRouted = false;
            const config = JSON.parse(fs.readFileSync(path.join(root, CONFIG), 'utf8')) as Record<string, unknown>;
            config.baseline_checks = { commands: [OLD_CARDS, APP_CARDS] };
            fs.writeFileSync(path.join(root, CONFIG), `${JSON.stringify(config, null, 2)}\n`);
        },
        setup: root => {
            repoRoot = root;
            fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
            fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
            fs.writeFileSync(path.join(root, PLAN), '# Plan\n- T-006-6-2 (missing card)\n- T-006-7 (missing card)\n- T-007-1 (card)\n');
            fs.writeFileSync(path.join(root, CHECK), VALIDATOR);
            git(root, ['add', '--', PLAN, CHECK]);
            git(root, ['commit', '-qm', 'Seed the project plan validator']);
        },
        inspectNavigation: (result, steps) => {
            const last = steps.at(-1);
            if (!operatorFixed && last?.gate === 'enter-task-mode' && last.exitCode) {
                // The stop names the red check with the one instruction; the operator adds the old cards separately.
                assert.match(last.output, RED_STOP, last.output);
                assert.doesNotMatch(last.output, /--app -> RED/u, 'The green check is not named');
                assert.equal(fs.existsSync(path.join(repoRoot, EVENTS)), false, 'The red check stopped the entry and wrote nothing to the task timeline');
                fs.writeFileSync(path.join(repoRoot, PLAN), '# Plan\n- T-006-6-2 (card)\n- T-006-7 (card)\n- T-007-1 (card)\n');
                git(repoRoot, ['add', '--', PLAN]);
                git(repoRoot, ['commit', '-qm', 'Operator: add the missing plan cards']);
                operatorFixed = true;
                return;
            }
            if (fixed || result.next_gate !== 'implementation'
                || !/Declared baseline check "node tools\/validate-plan\.cjs --app" is red/u.test(result.reason)) return;
            failureRouted = true;
            assert.deepEqual(result.commands.map(entry => entry.label),
                ['Run task test validation to evaluate the declared baseline checks on the current tree'], 'The fix is followed by a re-evaluation');
            // The agent fixes its own part before it runs the offered command: the regression test now carries the plan card.
            fs.appendFileSync(path.join(repoRoot, 'tests/app.test.ts'), `// ${PLAN_CARD}\n`);
            fixed = true;
        },
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            assert.ok(operatorFixed, 'Entry stopped on the red plan validator first');
            const entered = events(root, 'BASELINE_CHECK_RECORDED');
            assert.deepEqual(entered.map(event => [event.details.command, event.outcome, event.details.verdict]),
                [[OLD_CARDS, 'PASS', 'GREEN'], [APP_CARDS, 'PASS', 'GREEN']], 'Only the green entry results are recorded');
            assert.match(String(entered[1].details.output_excerpt), new RegExp(`${TASK} is not active yet`, 'u'),
                'Entry ran the checks before it moved the task row to IN_PROGRESS');
            assert.equal(result.steps.filter(step => step.gate === 'enter-task-mode' && step.exitCode).length, 1, 'Entry stopped exactly once');
            const verdicts = events(root, 'BASELINE_CHECK_EVALUATED').map(event => `${String(event.details.command)}:${String(event.details.verdict)}`);
            assert.deepEqual(verdicts.slice(0, 2), [`${OLD_CARDS}:GREEN`, `${APP_CARDS}:RED`], verdicts.join(', '));
            assert.deepEqual(verdicts.slice(-2), [`${OLD_CARDS}:GREEN`, `${APP_CARDS}:GREEN`], verdicts.join(', '));
            assert.ok(failureRouted && fixed, 'next-step routed the task-caused failure to a fix');
            const failed = result.steps.filter(step => step.gate === 'full-suite-validation' && step.exitCode);
            assert.equal(failed.length, 1, 'Only the run with the task-caused failure fails');
            assert.match(failed[0].output, /node tools\/validate-plan\.cjs --app -> RED \(it exited 2\); a red declared check is a failure of this task\./u);
            const recheck = result.steps.filter(step => step.gate === 'implementation' && step.exitCode);
            assert.equal(recheck.length, 1, 'Only the re-evaluation right after the file fix is refused');
            assert.match(recheck[0].output, /changed after selection\. Refresh preflight/u, recheck[0].output);
            assert.deepEqual(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8').split(/\r?\n/u).filter(line => line.startsWith(`| ${TASK}-`)), [],
                'No follow-up row');
        }
    };
}
