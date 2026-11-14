import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleGate } from '../../../../src/cli/commands/gate-command';
import { handleReviewCapabilities } from '../../../../src/cli/commands/review-capabilities-command';
import { splitCommandLine } from '../../../../src/core/command-line';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { runGit } from '../../cli/commands/gate-test-helpers';
// navigator-walk installs the route observer; load it lazily so importing this catalog never loads next-step first.
import type { WalkScenario, WalkStep } from './navigator-walk';
import { captureWalkOutput } from './walk-output';
import { LEGACY_BROAD_COMMAND, LEGACY_TASK_TARGET, legacySourceRoute } from './walk-legacy-task-contract';
import { STACK_MANIFESTS, readStackExecutions } from './walk-stack-fixtures';
import { stackScenario } from './walk-stack-scenarios';
import type { R144_FIELD_CASE_IDS, R144_KNOWN_GAP_IDS } from './walk-field-case-ids';
import { criteriaDoubleContext, protectedRestart } from './walk-field-r144-restart-scenarios';

/*
 * Permanent field cases for the defects the 1.4.4 final review found after the stand was green (reports
 * sol-r144-r1..r3, opus-r144-freshness, opus-fix144-review). Each expectation is derived from the concept rules:
 * an approved lane-policy change keeps passed reviews and a criteria change reruns FULL (C6.2.4); a refusal names
 * the missing fact and an executable route, and only an authority decision is an operator handoff (C2.4); every
 * offered command must be accepted by its handler; RED is bound to the declared targets, and declared support is
 * covered by its target's result (C5.1.1, C3.1.3); a reviewer's required self-check accepts authenticated history.
 */
const BUNDLE = 'garda-agent-orchestrator';
const TASK = 'T-WALK';
const REVIEWS = BUNDLE + '/runtime/reviews';
const TIMELINE = BUNDLE + '/runtime/task-events/' + TASK + '.jsonl';
const ROUTE = 'src/routes/status.ts';
const EDITS = [{ path: 'src/app.ts', append: '// field r144\n' }, { path: 'tests/app.test.ts', append: '// field r144\n' }];
const CLEAN = { selectionTargets: [LEGACY_TASK_TARGET], testSelectionCommand: LEGACY_BROAD_COMMAND };
const PACKAGE = { name: 'garda-agent-orchestrator', version: '0.0.0-stand' };
const UNCONFIGURED_COMPILE = '__COMPILE_GATE_COMMAND_UNCONFIGURED__';
const UNKNOWN = STACK_MANIFESTS.find(manifest => manifest.id === 'unknown-quartz')!;

type Last = WalkStep | undefined;
const passed = (gate: string, lane?: string) => (last: Last) => last?.gate === gate && last.exitCode === 0
    && (!lane || !!last.command?.includes('--review-type "' + lane + '"'));
function once(when: (last: Last, steps: readonly WalkStep[]) => boolean, then: (root: string, steps: readonly WalkStep[]) => void | Promise<void>): NonNullable<WalkScenario['prepare']> {
    let done = false;
    return async (root, steps) => {
        if (!steps.length) done = false;
        if (done || !when(steps.at(-1), steps)) return;
        done = true;
        await then(root, steps);
    };
}

/** A real gate in-process, exactly as the walk agent runs printed commands. */
async function runWalkGate(argv: readonly string[]): Promise<{ exitCode: number; output: string }> {
    const output: string[] = [], previous = process.exitCode;
    try {
        process.exitCode = 0;
        await captureWalkOutput(output, () => handleGate([...argv]));
        return { exitCode: Number(process.exitCode ?? 0), output: output.join('\n') };
    } catch (error) {
        return { exitCode: 1, output: [...output, error instanceof Error ? error.stack || error.message : String(error)].join('\n') };
    } finally { process.exitCode = previous; }
}
const gateArgv = (command: string) => { const argv = splitCommandLine(command); return argv.slice(argv.indexOf('gate') + 1); };

/** The operator changes a lane through the documented workflow command, never by editing config by hand. */
async function reviewCapability(root: string, action: 'enable' | 'disable', lane: string): Promise<void> {
    const output: string[] = [];
    await captureWalkOutput(output, async () => { handleReviewCapabilities([action, lane, '--target-root', root, '--json'], PACKAGE); });
}
const capabilityEnabled = (root: string, lane: string) => (JSON.parse(fs.readFileSync(
    path.join(root, BUNDLE, 'live/config/review-capabilities.json'), 'utf8')) as Record<string, unknown>)[lane] === true;
const notes = (root: string, append: string) => {
    const file = path.join(root, 'TASK.md');
    const text = fs.readFileSync(file, 'utf8');
    const changed = text.replace('Synthetic navigator walk.', 'Synthetic navigator walk. ' + append);
    assert.notEqual(changed, text, 'The task notes must exist before the operator edits them');
    fs.writeFileSync(file, changed);
};

/** The modeled operator approves exactly the adoption the navigator shows, filling only its approval time. */
async function approveOfferedAdoption(_root: string, step: WalkStep): Promise<boolean> {
    if (!step.command || !/\s--adopt-changed-review-policy\s/u.test(step.command) || !step.command.includes('<ISO-8601 timestamp>')) return false;
    step.command = step.command.replace('<ISO-8601 timestamp>', new Date().toISOString());
    step.userApproval = true;
    const run = await runWalkGate(gateArgv(step.command));
    step.exitCode = run.exitCode; step.output = run.output;
    return true;
}

/** R2-2: enabling or disabling an optional lane for an unchanged scope keeps every passed review. */
function laneChange(id: typeof R144_FIELD_CASE_IDS[number], variant: 'enable' | 'disable' | 'enable-with-criteria'): WalkScenario {
    const action = variant === 'disable' ? 'disable' : 'enable';
    const modes = variant === 'disable' ? ['code:FULL', 'api:FULL', 'test:FULL']
        : variant === 'enable' ? ['code:FULL', 'test:FULL', 'api:FULL']
            // Changed acceptance criteria rerun every required lane FULL; the newly enabled lane runs once FULL.
            : ['code:FULL', 'test:FULL', 'code:FULL', 'api:FULL', 'test:FULL'];
    return { ...CLEAN, id, edits: [...EDITS, { path: ROUTE, append: '// field r144 route\n' }], reviewerSelfCheck: true,
        // The frozen task policy refuses the capability change at POST_PREFLIGHT; the operator then approves its adoption.
        // With criteria changed too, the first coherent restart also meets the pending policy change and names its adoption.
        expectedFailingGates: variant === 'enable-with-criteria' ? ['load-rule-pack', 'restart-coherent-cycle'] : ['load-rule-pack'],
        disturbanceReason: 'R2-2: after code and test reviews pass, the operator ' + action + 's the API review capability for the unchanged API scope'
            + (variant === 'enable-with-criteria' ? ' and changes the task acceptance criteria.' : '.'),
        expectedModes: modes, expectedReviews: Object.fromEntries([...new Set(modes.map(mode => mode.split(':')[0]))]
            .map(lane => [lane, modes.filter(mode => mode.startsWith(lane + ':')).length])),
        setup: root => {
            fs.mkdirSync(path.join(root, path.dirname(ROUTE)), { recursive: true });
            fs.writeFileSync(path.join(root, ROUTE), 'export function statusRoute() {\n    return "ready";\n}\n');
            runGit(root, ['add', '--', ROUTE]); runGit(root, ['commit', '-qm', 'Seed the API route of the field case']);
            if (variant !== 'disable') handleReviewCapabilities(['disable', 'api', '--target-root', root, '--json'], PACKAGE);
            assert.equal(capabilityEnabled(root, 'api'), variant === 'disable');
        },
        prepare: once(passed('record-review-result', 'test'), async root => {
            await reviewCapability(root, action, 'api');
            if (variant === 'enable-with-criteria') {
                const file = path.join(root, 'TASK.md');
                fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Change the status renderer', 'Change the status renderer and reject empty status'));
            }
        }),
        execute: approveOfferedAdoption,
        inspectResult: (root, result) => {
            if (result.outcome === 'done') assert.equal(capabilityEnabled(root, 'api'), action === 'enable');
        } };
}

const LEGACY_EVENT = JSON.stringify({ timestamp_utc: '2026-03-02T09:00:00.000Z', task_id: TASK, event_type: 'TASK_NOTE', outcome: 'INFO',
    actor: 'orchestrator', message: 'Recorded by a release before task-event integrity existed.', details: {} });
const seedLegacyPrefix = (root: string) => {
    fs.mkdirSync(path.dirname(path.join(root, TIMELINE)), { recursive: true });
    fs.writeFileSync(path.join(root, TIMELINE), LEGACY_EVENT + '\n');
};
const timelineLines = (root: string) => fs.readFileSync(path.join(root, TIMELINE), 'utf8').split('\n').filter(line => line.trim());

/** R3-2: a history whose authenticated chain starts after an unsigned prefix continues through every gate. */
function legacyPrefixContinue(): WalkScenario {
    return { ...CLEAN, id: 'field-r144-legacy-prefix-continue', edits: EDITS, reviewerSelfCheck: true,
        disturbanceReason: 'R3-2: the task timeline keeps one unsigned event written before task-event integrity existed.',
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'],
        setup: seedLegacyPrefix,
        inspectResult: (root, result) => {
            if (result.outcome !== 'done') return;
            const [first, ...signed] = timelineLines(root);
            assert.equal(first, LEGACY_EVENT, 'The unsigned prefix stays byte-identical');
            assert.ok(signed.length && signed.every(line => isRecord((JSON.parse(line) as Record<string, unknown>).integrity)),
                'Every event after the prefix is signed');
            const checks = result.steps.flatMap(step => step.reviewerSelfCheck ? [step.reviewerSelfCheck] : []);
            assert.deepEqual(checks.map(check => check.lane + ':' + check.exitCode), ['code:0', 'test:0'],
                'Each reviewer ran its required self-check once and it accepted the authenticated history');
        } };
}
const isRecord = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);

/** R3-2 negative control: an unsigned prefix authenticates nothing, so a launch found only there is refused. */
function legacyPrefixForgedLaunch(): WalkScenario {
    let refused = '';
    return { ...CLEAN, id: 'field-r144-legacy-prefix-forged-launch', edits: EDITS, reviewerSelfCheck: true,
        disturbanceReason: 'R3-2 negative control: move the signed code launch into the unsigned prefix and cut the chain before it.',
        expectedReviews: {}, expectedModes: [],
        expectedBlockedGate: 'task-reset', expectedGuidance: /task-reset --task-id "T-WALK" --reopen --dry-run/u,
        setup: root => { refused = ''; seedLegacyPrefix(root); },
        prepare: once(passed('prepare-reviewer-launch', 'code'), async root => {
            const lines = timelineLines(root);
            const index = lines.findIndex(line => (JSON.parse(line) as { event_type: string }).event_type === 'REVIEWER_LAUNCH_PREPARED');
            assert.ok(index > 0, 'The native code launch was prepared and signed');
            const forged = JSON.parse(lines[index]) as Record<string, unknown>;
            delete forged.integrity;
            fs.writeFileSync(path.join(root, TIMELINE), [JSON.stringify(forged), ...lines.slice(1, index), ''].join('\n'));
            const launch = path.join(root, BUNDLE, 'runtime/tmp/reviews', TASK, 'code', 'reviewer-launch.json');
            const handoff = '--task-id "' + TASK + '" --reviewer-launch-artifact-path "' + launch + '"';
            const walk = await import('./navigator-walk');
            walk.writeReviewerReport(root, handoff, 'code', 'clean');
            const selfCheck = walk.reviewerSelfCheckCommand(launch);
            assert.ok(selfCheck, 'The prepared handoff names its required self-check');
            const run = await runWalkGate(gateArgv(selfCheck));
            assert.notEqual(run.exitCode, 0, 'A launch found only in the unsigned prefix must not authenticate a review: ' + run.output);
            assert.doesNotMatch(run.output, /REVIEW_OUTPUT_SELF_CHECK_PASSED/u);
            assert.ok(!fs.existsSync(path.join(root, REVIEWS, TASK + '-code-receipt.json')), 'No receipt exists');
            refused = run.output;
        }),
        inspectResult: () => { assert.ok(refused, 'The forged-launch self-check ran and was refused'); } };
}

/** R1-1: a lane the operator adds to the task after preflight is recovered by an executable refresh. */
function omittedRequiredLane(): WalkScenario {
    let injected = false, offered = false;
    return { ...CLEAN, id: 'field-r144-omitted-required-lane-refresh', edits: EDITS, reviewerSelfCheck: true,
        disturbanceReason: 'R1-1: after preflight the operator adds "Required reviews: api." to the task notes; api is available.',
        expectedReviews: { code: 1, api: 1, test: 1 }, expectedModes: ['code:FULL', 'api:FULL', 'test:FULL'],
        setup: () => { injected = false; offered = false; },
        prepare: once(passed('classify-change'), root => { notes(root, 'Required reviews: api.'); injected = true; }),
        inspectNavigation: result => {
            if (!injected || offered) return;
            // C2.4: the omitted lane is a recoverable fact, so the very next navigation offers an executable route.
            assert.ok(result.commands.length > 0, 'An omitted available lane must offer an executable recovery: '
                + result.next_gate + ': ' + result.reason);
            offered = true;
        },
        inspectResult: (_root, result) => { if (result.outcome === 'done') assert.ok(offered); } };
}

/** R1-1 (round 2): an unavailable declared lane is an operator decision; the navigator must not loop on a refresh. */
function unavailableRequiredLane(id: typeof R144_FIELD_CASE_IDS[number], selectedBeforeDisable: boolean): WalkScenario {
    let refusals = 0;
    return { ...CLEAN, id, edits: EDITS, reviewerSelfCheck: true, execute: approveOfferedAdoption, expectedFailingGates: ['load-rule-pack'],
        disturbanceReason: selectedBeforeDisable
            ? 'R1-1: the task declares api, it is selected, then the operator disables the api capability after preflight.'
            : 'R1-1: api is disabled and the operator adds "Required reviews: api." to the task notes after preflight.',
        expectedReviews: { code: 1, api: 1, test: 1 }, expectedModes: ['code:FULL', 'api:FULL', 'test:FULL'],
        setup: root => {
            refusals = 0;
            if (selectedBeforeDisable) notes(root, 'Required reviews: api.');
            else handleReviewCapabilities(['disable', 'api', '--target-root', root, '--json'], PACKAGE);
        },
        prepare: once(passed('classify-change'), async root => {
            if (selectedBeforeDisable) await reviewCapability(root, 'disable', 'api');
            else notes(root, 'Required reviews: api.');
        }),
        act: async (root, gate) => {
            if (gate !== 'task-metadata-validation' || capabilityEnabled(root, 'api')) return false;
            // Two consecutive navigations give the same refusal and change nothing: no hidden loop, no mutation.
            const inputs = () => [path.join(root, 'TASK.md'), path.join(root, REVIEWS, TASK + '-preflight.json')]
                .map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
            const before = inputs();
            const [first, second] = [resolveNextStep({ taskId: TASK, repoRoot: root }), resolveNextStep({ taskId: TASK, repoRoot: root })];
            assert.deepEqual(inputs(), before, 'The refusal must not change TASK.md or the preflight');
            for (const result of [first, second]) {
                assert.equal(result.status, 'BLOCKED');
                assert.equal(result.next_gate, 'task-metadata-validation');
                assert.match(result.reason, /\bapi\b/u, 'The refusal names the unavailable lane');
                assert.match(result.reason, /operator/iu, 'Enabling a lane is an operator authority decision');
                assert.deepEqual(result.commands, [], 'No agent command can resolve an unavailable lane');
            }
            assert.equal(first.reason, second.reason);
            refusals += 1;
            // The modeled operator takes the named route: enable the lane through the existing workflow.
            await reviewCapability(root, 'enable', 'api');
            return true;
        },
        inspectResult: (_root, result) => { if (result.outcome === 'done') assert.equal(refusals, 1, 'Exactly one operator refusal'); } };
}

/** R1-2: a changed declared fixture is covered by its target's RED result, with no standalone result of its own. */
function redChangedDeclaredFixture(): WalkScenario {
    const base = stackScenario(UNKNOWN, 7, 'generic');
    const support = UNKNOWN.helpers[0];
    const target = UNKNOWN.suites[0].target;
    return { ...base, id: 'field-r144-red-changed-declared-fixture', counterState: undefined, reviewerSelfCheck: true,
        fixture: { ...base.fixture!, taskTestSupport: [{ path: support, role: 'fixture', targets: [target] }] },
        edits: [...base.edits, { path: support, append: '# purchase membership row changed with the task test\n' }],
        disturbanceReason: 'R1-2: the TDD task changes its test and the declared fixture that test reads; RED runs only the test.',
        inspectResult: (root, result) => {
            base.inspectResult?.(root, result);
            if (result.outcome !== 'done') return;
            const red = result.events.filter(event => event.type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED');
            assert.equal(red.length, 1, 'One accepted RED, never a repeated RED request');
            assert.ok(readStackExecutions(root).every(record => !record.targets.includes(support)), 'The fixture is never run as a test');
        } };
}

/** Every alternative the navigator offers must be accepted by its own handler; a refused offer is a dead end. */
async function assertAlternativesAdmissible(step: WalkStep, offered: readonly string[], fill: (arg: string) => string): Promise<void> {
    for (const alternative of offered.slice(1)) {
        const argv = gateArgv(alternative).map(arg => /^<[^>]+>$/u.test(arg) ? fill(arg) : arg);
        const run = await runWalkGate(argv);
        (step.preparation ??= []).push({ command: 'offered alternative: ' + argv.join(' '), output: run.output });
        assert.equal(run.exitCode, 0, 'The navigator offered a command its handler refuses: ' + argv.join(' ') + '\n' + run.output);
    }
}

/** Resolved from the source checkout at catalog load (the walk later runs inside its fixture); absent before fix B. */
const STORED_COMPILE_RETRY_ROUTE = (() => {
    try { return legacySourceRoute('src/gates/next-step/next-step-pre-review-routing.ts', 'Fix the failure and rerun the stored task compile.'); }
    catch { return null; }
})();

/** R1-3: after a real task-local compile failure with no project command, the route retries the stored command. */
function failedTaskLocalCompile(): WalkScenario {
    const base = stackScenario(UNKNOWN, 1, 'generic');
    const fixture = { ...base.fixture!, configuredCompileCommand: UNCONFIGURED_COMPILE };
    let failed = false, checked = false, offered: string[] = [];
    return { ...base, id: 'field-r144-failed-task-local-compile-retry', fixture, counterState: undefined, reviewerSelfCheck: true,
        disturbanceReason: 'R1-3: the project compile command is unconfigured and the declared task-local compile fails once.',
        expectedFailingGates: ['compile-gate'],
        // Source routes are asserted by the coverage replay; a source without the retry route can never satisfy this.
        expectedRoutes: [STORED_COMPILE_RETRY_ROUTE ?? 'absent:stored-task-compile-retry-route'],
        configure: root => {
            failed = false; checked = false; offered = [];
            base.configure?.(root);
            fs.writeFileSync(path.join(root, '.git/stand-fail-compile-once'), '');
        },
        prepare: async (root, steps, run) => {
            await base.prepare?.(root, steps, run);
            if (steps.at(-1)?.gate === 'compile-gate' && steps.at(-1)?.exitCode) failed = true;
        },
        inspectNavigation: result => { if (result.next_gate === 'compile-gate') offered = result.commands.map(entry => entry.command); },
        execute: async (_root, step) => {
            if (!failed || checked || step.gate !== 'compile-gate') return false;
            checked = true;
            await assertAlternativesAdmissible(step, offered, arg => arg === '<task-compile-command>' ? fixture.compileCommand
                : 'The declared task compile already ran for this task.');
            return false;
        },
        inspectResult: (root, result) => {
            base.inspectResult?.(root, result);
            if (result.outcome !== 'done') return;
            const compiles = readStackExecutions(root).filter(record => record.purpose === 'compile');
            assert.ok(compiles.length >= 2 && compiles[0].exitCode !== 0 && compiles.at(-1)!.exitCode === 0,
                'The real compile failed once and the stored command passed only after it was actually rerun');
            assert.ok(checked, 'The route after the failure was inspected');
        } };
}

export function r144FieldCase(id: typeof R144_FIELD_CASE_IDS[number]): WalkScenario {
    switch (id) {
        case 'field-r144-protected-restart-keeps-criteria': return protectedRestart(id, false);
        case 'field-r144-protected-restart-after-agent-supplement': return protectedRestart(id, true);
        case 'field-r144-protected-restart-operator-criteria-change': return protectedRestart(id, false, true);
        case 'field-r144-protected-restart-confirms-agent-supplement': return protectedRestart(id, true, true);
        case 'field-r144-lane-enable-keeps-passed-reviews': return laneChange(id, 'enable');
        case 'field-r144-lane-disable-keeps-passed-reviews': return laneChange(id, 'disable');
        case 'field-r144-lane-enable-with-criteria-change': return laneChange(id, 'enable-with-criteria');
        case 'field-r144-omitted-required-lane-refresh': return omittedRequiredLane();
        case 'field-r144-unavailable-required-lane': return unavailableRequiredLane(id, false);
        case 'field-r144-disabled-required-lane-after-selection': return unavailableRequiredLane(id, true);
        case 'field-r144-red-changed-declared-fixture': return redChangedDeclaredFixture();
        case 'field-r144-failed-task-local-compile-retry': return failedTaskLocalCompile();
    }
}

/** Known gaps (T-469 item 3, T-468): complete scenarios kept outside the registered catalog. */
export function r144KnownGapCase(id: typeof R144_KNOWN_GAP_IDS[number]): WalkScenario {
    if (id === 'field-r144-criteria-change-double-context') return criteriaDoubleContext(id, false);
    if (id === 'field-r144-criteria-change-double-context-operator-intent') return criteriaDoubleContext(id, true);
    return id === 'field-r144-legacy-prefix-continue' ? legacyPrefixContinue() : legacyPrefixForgedLaunch();
}
