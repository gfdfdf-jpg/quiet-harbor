import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitCommandLine } from '../../../../src/core/command-line';
import { runRequiredReviewsCheckCommand } from '../../../../src/cli/commands/gate-flows/review/review-flow';
import { runRepairRebuildIndexes } from '../../../../src/cli/commands/repair-command';
import type { WalkScenario, WalkStep } from './navigator-walk';
import type { SweepInjection } from './walk-sweep';
import { REUSE_COVERAGE_WALK_SCENARIOS } from './walk-reuse-coverage-scenarios';
import { LEGACY_BROAD_COMMAND, LEGACY_TASK_TARGET, legacySourceRoute } from './walk-legacy-task-contract';

/*
 * Each scenario applies one agent-side fault at a fixed moment of an ordinary task and lets the real navigator and
 * real gates decide the recovery. It closes a source route the other families never reached; `expectedRoutes` pins it.
 * Faults delete or change files only; no authenticated evidence is written, so every recovery is native.
 */
const BUNDLE = 'garda-agent-orchestrator';
const REVIEWS = BUNDLE + '/runtime/reviews';
const NEXT = 'src/gates/next-step/';
const EDITS = [{ path: 'src/app.ts', append: '// route closure\n' }, { path: 'tests/app.test.ts', append: '// route closure\n' }];
const CLEAN = { edits: EDITS, selectionTargets: [LEGACY_TASK_TARGET], testSelectionCommand: LEGACY_BROAD_COMMAND,
    expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'] };
const CODE_REPEATS = { expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'code:FULL', 'test:FULL'] };
const SEED = 1785881697;
const route = (file: string, signature: string) => legacySourceRoute(NEXT + file, signature);
const UNPARSEABLE_TIMELINE_ROUTE = route('next-step-startup-routing.ts', 'Ask the operator to remove unparseable task timeline lines.');
const TAMPERED_TIMELINE_ROUTE = route('next-step-startup-routing.ts', 'Ask the operator to restore authentic task history.');

type Last = WalkStep | undefined;
const passed = (gate: string, lane?: string) => (last: Last) => last?.gate === gate && last.exitCode === 0
    && (!lane || !!last.command?.includes('--review-type "' + lane + '"'));
const failed = (gate: string, lane?: string) => (last: Last) => last?.gate === gate && !!last.exitCode
    && (!lane || !!last.command?.includes('--review-type "' + lane + '"'));

/** Applies one agent-side fault the first time `when` holds; real gates then decide the recovery. */
function once(when: (last: Last, steps: readonly WalkStep[]) => boolean, then: (root: string) => void): WalkScenario['prepare'] {
    let done = false;
    return async (root, steps) => {
        if (!steps.length) done = false;
        if (done || !when(steps.at(-1), steps)) return;
        done = true;
        then(root);
    };
}

const reviews = (root: string, name: string) => path.join(root, REVIEWS, name);
const remove = (file: string) => fs.rmSync(file, { force: true, recursive: true });
const corrupt = (file: string) => {
    if (!fs.existsSync(file)) throw new Error('No native artifact to change: ' + file + ' in ' + fs.readdirSync(path.dirname(file)).join(', '));
    fs.appendFileSync(file, '\nsynthetic stray edit\n');
};
const loseContext = (root: string, lane: string) => {
    remove(reviews(root, 'T-WALK-' + lane + '-review-context.json'));
    remove(path.join(root, BUNDLE, 'runtime/tmp/.review-context-cache'));
};
/** The reviewer prompt bound by the lane context, together with every digest-bound copy that could restore it. */
const losePrompt = (root: string, lane: string) => {
    const context = JSON.parse(fs.readFileSync(reviews(root, 'T-WALK-' + lane + '-review-context.json'), 'utf8')) as
        { rule_context?: { preferred_prompt_artifact?: string; artifact_path?: string } };
    corrupt(path.resolve(root, context.rule_context?.preferred_prompt_artifact || context.rule_context?.artifact_path || ''));
    remove(path.join(root, BUNDLE, 'runtime/tmp/.reviewer-input-cache'));
};
const loseLaunchInput = (root: string, lane: string) => {
    const dir = path.join(root, BUNDLE, 'runtime/tmp/reviews/T-WALK', lane);
    const inputs = fs.readdirSync(dir).filter(name => name.startsWith('reviewer-launch-input'));
    if (!inputs.length) throw new Error('No native reviewer launch input to lose: ' + fs.readdirSync(dir).join(', '));
    for (const name of inputs) remove(path.join(dir, name));
};
const timelinePath = (root: string) => path.join(root, BUNDLE, 'runtime/task-events/T-WALK.jsonl');
const recordedSnapshots = (root: string, lane: string) => !fs.existsSync(timelinePath(root)) ? [] : fs.readFileSync(timelinePath(root), 'utf8')
    .split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as { event_type: string; details?: Record<string, unknown> })
    .filter(event => event.event_type === 'REVIEW_RECORDED' && event.details?.review_type === lane)
    .map(event => String(event.details?.review_artifact_snapshot_path || ''));
const loseLatestSnapshot = (root: string, lane: string) => {
    const snapshot = recordedSnapshots(root, lane).at(-1);
    if (!snapshot) throw new Error('The recorded ' + lane + ' review has no immutable snapshot path.');
    remove(path.resolve(root, snapshot));
};

function policyChange(id: string, gate: string, extra: Partial<WalkScenario> = {}): WalkScenario {
    const injection: SweepInjection = { seed: SEED, baseline: 'clean-pass', step: -1, gate, checkpoint: { lane: 'code' }, disturbances: [{ kind: 'change-policy' }] };
    return { ...CLEAN, id, injection, disturbanceReason: 'Change the task profile review policy at ' + gate + '.',
        expectedRoutes: [route('next-step.ts', `nextGate: '${gate}', ...finish`),
            route('next-step-startup-routing.ts', 'Ask the operator to approve the changed review policy, or revert it.'),
            route('next-step-pre-review-routing.ts', 'Restart the latest coherent task cycle.')], ...extra };
}

/** The scoped twin is `coverage-review-gate-stale-upstream-scoped`; here the security metadata stays intact. */
function staleUpstreamContext(): WalkScenario {
    let injected = false;
    return {
        id: 'coverage-review-gate-stale-upstream-context', edits: EDITS, requiredLanes: ['code', 'security', 'test'],
        expectedReviews: { code: 1, security: 1, test: 1 }, expectedModes: ['code:FULL', 'security:FULL', 'test:FULL'],
        disturbanceReason: 'Supply a mismatched expected verdict to native review validation, then accept current code context.',
        expectedRoutes: [route('next-step-review-reuse-routing.ts', 'Recover stale upstream')],
        prepare: async (root, steps, run) => {
            if (!steps.length) injected = false;
            const last = steps.at(-1);
            if (injected || last?.gate !== 'record-review-result' || !last.command?.includes('--review-type "test"')) return;
            injected = true;
            const result = runRequiredReviewsCheckCommand({ repoRoot: root, taskId: 'T-WALK',
                preflightPath: REVIEWS + '/T-WALK-preflight.json', codeReviewVerdict: 'DIFFERENT_EXPECTED_TOKEN',
                reviewAuthorshipAttestationJson: JSON.stringify({ code: true, security: true, test: true }), emitMetrics: false });
            if (result.exitCode === 0 || !result.outputLines.join('\n').includes('DIFFERENT_EXPECTED_TOKEN')) {
                throw new Error('Expected native review gate refusal for the mismatched verdict.');
            }
            const command = steps.find(step => step.gate === 'build-review-context' && step.command?.includes('--review-type "code"'))?.command;
            if (!command) throw new Error('No native code context command to accept after review validation failure.');
            const argv = splitCommandLine(command);
            await run(argv.slice(argv.indexOf('gate') + 1));
        }
    };
}

/**
 * Review-cycle guard blocking for the operator. A recompile after the code review re-records it by reuse in the same
 * open cycle, sharing its immutable snapshot. Losing that snapshot is lost evidence of the code result only, so the
 * guard must not mistake the earlier record it rebinds for damaged history and stop for an operator reset.
 */
function guardedReusedSnapshotLoss(): WalkScenario {
    const base = REUSE_COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-repeat-compile-code')!;
    const lose = once(passed('record-review-result', 'test'), root => loseLatestSnapshot(root, 'code'));
    return { ...base, id: 'coverage-guarded-reused-snapshot-loss',
        selectionTargets: [LEGACY_TASK_TARGET], testSelectionCommand: LEGACY_BROAD_COMMAND,
        // Lost evidence of the code result only: the code review repeats once, the test review is rebound, not relaunched.
        expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'test:FULL', 'code:FULL'],
        expectedRoutes: [route('next-step.ts', 'Do not reconstruct the snapshot by hand.')],
        disturbanceReason: base.disturbanceReason + ' With the review-cycle guard on, lose the shared code snapshot after the test review.',
        configure: root => {
            base.configure?.(root);
            const file = path.join(root, BUNDLE, 'live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { review_cycle_guard: Record<string, unknown> };
            Object.assign(config.review_cycle_guard, { enabled: true, action: 'BLOCK_FOR_OPERATOR_DECISION',
                max_failed_non_test_reviews: 15, max_total_non_test_reviews: 30, auto_split_enabled: false });
            fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
        },
        prepare: async (root, steps, run) => {
            await base.prepare?.(root, steps, run);
            await lose!(root, steps, run);
        } };
}

export const ROUTE_CLOSURE_WALK_SCENARIOS: readonly WalkScenario[] = [
    // Startup evidence binds no review: after preflight Garda rebuilds it through restart-coherent-cycle.
    { ...CLEAN, id: 'coverage-lost-startup-after-preflight', expectedGates: ['restart-coherent-cycle'],
        disturbanceReason: 'Lose the handshake evidence after the preflight was classified and compiled.',
        prepare: once(passed('compile-gate'), root => remove(reviews(root, 'T-WALK-handshake.json'))) },
    // The restart has no preflight to read, so the startup chain is rebuilt first and classify-change follows it.
    { ...CLEAN, id: 'coverage-lost-startup-and-preflight', expectedGates: ['handshake-diagnostics', 'classify-change'],
        disturbanceReason: 'Lose the handshake evidence and the preflight after compile.',
        prepare: once(passed('compile-gate'), root => {
            remove(reviews(root, 'T-WALK-handshake.json')); remove(reviews(root, 'T-WALK-preflight.json'));
        }) },
    // Before compile no compile event can authenticate a reconstruction, so no lost preflight is retained.
    { ...CLEAN, id: 'coverage-lost-preflight-and-snapshot', expectedRoutes: [route('next-step-startup-routing.ts', 'Record TASK_ENTRY rule files.')],
        disturbanceReason: 'Lose the preflight and its retained snapshot after POST_PREFLIGHT rules, before compile.',
        prepare: once((last, steps) => passed('load-rule-pack')(last) && !!last?.command?.includes('POST_PREFLIGHT')
            && steps.some(step => step.gate === 'implementation'), root => {
            remove(reviews(root, 'T-WALK-preflight.json')); remove(reviews(root, 'T-WALK-preflight-snapshot.json'));
        }) },
    // Garda never regenerates a frozen task policy: only the operator reset previewed here continues.
    { ...CLEAN, id: 'coverage-lost-task-mode-policy', expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Lose the task-mode artifact that pins the task policy after compile.',
        expectedBlockedGate: 'task-reset', expectedGuidance: /reset the task[\s\S]*task-reset --task-id "T-WALK" --reopen --dry-run/iu,
        expectedRoutes: [route('next-step-startup-routing.ts', 'Ask the operator to reset the task: its pinned task-mode policy is lost.')],
        prepare: once(passed('compile-gate'), root => remove(reviews(root, 'T-WALK-task-mode.json'))) },
    // The timeline can no longer prove the startup sequence: again only the previewed operator reset continues.
    { ...CLEAN, id: 'coverage-lost-startup-damaged-timeline', expectedReviews: {}, expectedModes: [],
        // Edited authenticated history stops every append: the integrity handoff precedes any startup or effect route.
        disturbanceReason: 'Lose the handshake evidence before compile and edit its authenticated timeline event in place.',
        expectedBlockedGate: 'task-reset',
        expectedGuidance: /Authenticated task history changed[\s\S]*task-reset --task-id "T-WALK" --reopen --dry-run/iu,
        expectedRoutes: [TAMPERED_TIMELINE_ROUTE],
        prepare: once(passed('quality-checklist'), root => {
            remove(reviews(root, 'T-WALK-handshake.json'));
            const timeline = path.join(root, BUNDLE, 'runtime/task-events/T-WALK.jsonl');
            const lines = fs.readFileSync(timeline, 'utf8').split('\n');
            const index = lines.findIndex(line => line.includes('"HANDSHAKE_DIAGNOSTICS_RECORDED"'));
            if (index < 0) throw new Error('No native handshake event to edit.');
            lines[index] = lines[index].replace('Handshake diagnostics passed', 'Handshake diagnostics passed (edited)');
            fs.writeFileSync(timeline, lines.join('\n'));
        }) },
    // A token-economy change is policy drift outside review-lane selection: it cannot be adopted, only reverted or reset.
    { ...CLEAN, id: 'coverage-unadoptable-policy-change', expectedReviews: {}, expectedModes: [],
        disturbanceReason: 'Change the token-economy configuration the task policy froze, after preflight.',
        expectedFailingGates: ['load-rule-pack'], expectedBlockedGate: 'enter-task-mode', expectedGuidance: /cannot adopt[\s\S]*task-reset/iu,
        expectedRoutes: [route('next-step-startup-routing.ts', 'Revert the review-policy change, or ask the operator to reset the task.')],
        prepare: once(passed('classify-change'), root => {
            const file = path.join(root, BUNDLE, 'live/config/token-economy.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { fail_tail_lines: number };
            config.fail_tail_lines += 1;
            fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
        }) },
    // A rejected report whose correction package is lost cannot be corrected: one FULL code review repeats.
    { ...CLEAN, ...CODE_REPEATS, id: 'coverage-lost-correction-package', disturbances: [{ kind: 'invalid-report-shape', lane: 'code' }],
        expectedFailingGates: ['record-review-result'], expectedRoutes: [route('next-step.ts', 'correction package.`')],
        disturbanceReason: 'Lose the native correction package after the reviewer report was rejected.',
        prepare: once(failed('record-review-result', 'code'), root => remove(reviews(root, 'T-WALK-code-output-correction.json'))) },
    // Without the launch input the reviewer identity is not authenticated: one fresh FULL code review.
    { ...CLEAN, ...CODE_REPEATS, id: 'coverage-correction-lost-launch-input', disturbances: [{ kind: 'invalid-report-shape', lane: 'code' }],
        expectedFailingGates: ['record-review-result'], expectedRoutes: [route('next-step-review-reuse-routing.ts', 'reviewer identity before recording corrected findings.')],
        disturbanceReason: 'Lose the reviewer launch input after the reviewer report was rejected.',
        prepare: once(failed('record-review-result', 'code'), root => loseLaunchInput(root, 'code')) },
    // An open launch whose input was lost cannot complete: one fresh FULL code review.
    { ...CLEAN, ...CODE_REPEATS, id: 'coverage-orphaned-launch-input', expectedRoutes: [route('next-step-review-readiness-routing.ts', 'Recover orphaned')],
        disturbanceReason: 'Lose the code reviewer launch input after delegation started.',
        prepare: once(passed('record-reviewer-delegation-started', 'code'), root => loseLaunchInput(root, 'code')) },
    // The prepared attempt never started, so it closes without counting a launch.
    { ...CLEAN, id: 'coverage-changed-templates-after-prepare', expectedFailingGates: ['record-reviewer-delegation-started'],
        expectedRoutes: [route('next-step-review-lifecycle-routes.ts', 'reviewer launch: its reviewer handoff inputs changed.')],
        disturbanceReason: 'Change the code reviewer templates after the launch attempt was prepared.',
        prepare: once(passed('prepare-reviewer-launch', 'code'), root => {
            for (const name of ['prompt-template', 'output-template']) corrupt(reviews(root, 'T-WALK-code-' + name + '.md'));
        }) },
    // Lost review evidence without a verified copy repeats only that review.
    { ...CLEAN, ...CODE_REPEATS, id: 'coverage-lost-context-without-copy', expectedRoutes: [route('next-step.ts', 'review context.`')],
        disturbanceReason: 'Lose the accepted code context and its cached copy before the test review.',
        prepare: once(passed('record-review-result', 'code'), root => loseContext(root, 'code')) },
    // The finished test review is recorded first and later rebound to the repeated code review, not relaunched.
    { ...CLEAN, id: 'coverage-lost-context-finished-downstream',
        expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'test:FULL', 'code:FULL'],
        expectedRoutes: [route('next-step.ts', 'review before recovering'), route('next-step.ts', 'review context.`'),
            route('next-step-review-reuse-routing.ts', 'review context after upstream review reuse.')],
        disturbanceReason: 'Lose the accepted code context and its cached copy while the finished test review is unrecorded.',
        prepare: once(passed('complete-reviewer-launch', 'test'), root => loseContext(root, 'code')) },
    // A lost immutable snapshot repeats only its review; the downstream test review is rebound, not relaunched.
    { ...CLEAN, id: 'coverage-lost-code-snapshot-after-test',
        expectedReviews: { code: 2, test: 1 }, expectedModes: ['code:FULL', 'test:FULL', 'code:FULL'],
        expectedRoutes: [route('next-step.ts', 'Do not reconstruct the snapshot by hand.'),
            route('next-step-review-reuse-routing.ts', 'review context after upstream review reuse.')],
        disturbanceReason: 'Lose the immutable code review snapshot after the test review was recorded.',
        prepare: once(passed('record-review-result', 'test'), root => loseLatestSnapshot(root, 'code')) },
    // The same with a scoped downstream lane: its scoped metadata is rebuilt before it is rebound.
    { id: 'coverage-lost-code-snapshot-scoped-downstream', edits: EDITS, requiredLanes: ['code', 'security', 'test'],
        expectedReviews: { code: 2, security: 1, test: 1 }, expectedModes: ['code:FULL', 'security:FULL', 'test:FULL', 'code:FULL'],
        expectedRoutes: [route('next-step-review-reuse-routing.ts', 'scoped diff metadata before rebuilding the review context.'),
            route('next-step-review-reuse-routing.ts', 'review context after upstream review reuse.')],
        disturbanceReason: 'Lose the immutable code review snapshot and the security scoped metadata after the test review was recorded.',
        prepare: once(passed('record-review-result', 'test'), root => {
            loseLatestSnapshot(root, 'code'); remove(reviews(root, 'T-WALK-security-scoped.json'));
        }) },
    // A changed upstream prompt without a copy is lost evidence of that review: the downstream gate refuses once, then
    // only the upstream review repeats; the launch gate refuses the stale prompt once and the context is rebuilt.
    { ...CLEAN, ...CODE_REPEATS, id: 'coverage-lost-upstream-prompt-before-context',
        expectedFailingGates: ['build-review-context', 'prepare-reviewer-launch'], expectedRoutes: [route('next-step.ts', 'The upstream gate still refuses these inputs.')],
        disturbanceReason: 'Change the recorded code reviewer prompt and lose its cached copy before the test context is built.',
        prepare: once(passed('record-review-result', 'code'), root => losePrompt(root, 'code')) },
    // The same after the test context exists: both review gates accept the authenticated recovered launch order.
    { ...CLEAN, ...CODE_REPEATS, id: 'coverage-lost-upstream-prompt-before-launch',
        expectedFailingGates: ['record-review-routing', 'prepare-reviewer-launch'], expectedRoutes: [route('next-step.ts', 'The upstream gate still refuses these inputs.')],
        disturbanceReason: 'Change the recorded code reviewer prompt and lose its cached copy after the test context is built.',
        prepare: once(passed('build-review-context', 'test'), root => losePrompt(root, 'code')) },
    // After REVIEW_GATE_PASSED a review-phase recovery becomes a coherent restart. A lost receipt repeats its review once.
    { ...CLEAN, id: 'coverage-lost-receipt-after-gate',
        expectedReviews: { code: 1, test: 2 }, expectedModes: ['code:FULL', 'test:FULL', 'test:FULL'],
        expectedGates: ['restart-coherent-cycle'], expectedRoutes: [route('next-step.ts', 'Restart the coherent cycle: the review stage already passed.')],
        disturbanceReason: 'Lose the test receipt after the review gate passed.',
        prepare: once(passed('required-reviews-check'), root => remove(reviews(root, 'T-WALK-test-receipt.json'))) },
    // A lost launch artifact after the gate repeats no review.
    { ...CLEAN, id: 'coverage-lost-launch-after-gate', expectedGates: ['restart-coherent-cycle'], expectedRoutes: [route('next-step.ts', 'Restart the coherent cycle: the review stage already passed.')],
        disturbanceReason: 'Lose the test reviewer launch artifact after the review gate passed.',
        prepare: once(passed('required-reviews-check'), root => remove(path.join(root, BUNDLE, 'runtime/tmp/reviews/T-WALK/test/reviewer-launch.json'))) },
    staleUpstreamContext(),
    { ...CLEAN, id: 'coverage-guarded-malformed-review-history', expectedReviews: { code: 1 }, expectedModes: ['code:FULL'],
        expectedBlockedGate: 'task-reset', expectedRoutes: [UNPARSEABLE_TIMELINE_ROUTE],
        expectedGuidance: /unparseable line[\s\S]*task-reset --task-id "T-WALK" --reopen --dry-run/iu,
        disturbanceReason: 'Append an unparseable timeline line after a passed code review with the attempt guard enabled.',
        configure: root => {
            const file = path.join(root, BUNDLE, 'live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { review_cycle_guard: Record<string, unknown> };
            Object.assign(config.review_cycle_guard, { enabled: true, action: 'BLOCK_FOR_OPERATOR_DECISION', auto_split_enabled: false });
            fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
        },
        prepare: once(passed('record-review-result', 'code'), root => fs.appendFileSync(timelinePath(root), '{bad\n')) },
    // An unparseable line stops every append. next-step names it with the reset preview; the modeled operator instead
    // removes exactly that line and rebuilds derived indexes, and the task finishes with its passed code review kept.
    { ...CLEAN, id: 'coverage-malformed-timeline-operator-repair', expectedRoutes: [UNPARSEABLE_TIMELINE_ROUTE],
        disturbanceReason: 'Append an unparseable timeline line after the code review; the modeled operator removes that line.',
        prepare: once(passed('record-review-result', 'code'), root => fs.appendFileSync(timelinePath(root), '{bad\n')),
        execute: async (root, step) => {
            if (step.gate !== 'task-reset' || !step.reason.includes('unparseable line')) return false;
            const lines = fs.readFileSync(timelinePath(root), 'utf8').split('\n');
            const parses = (line: string) => { try { JSON.parse(line); return true; } catch { return false; } };
            fs.writeFileSync(timelinePath(root), lines.filter(line => !line.trim() || parses(line)).join('\n'));
            runRepairRebuildIndexes(root, true);
            step.output = 'Modeled operator removed the unparseable timeline line and rebuilt derived indexes.';
            return true;
        } },
    guardedReusedSnapshotLoss(),
    // A policy change while a reviewer is working: finish and record it on its frozen context, then adopt; passed
    // reviews on unchanged code are kept (the standalone checks are in synthetic-policy-reuse.test.ts).
    policyChange('coverage-policy-change-delegated-review', 'complete-reviewer-launch'),
    policyChange('coverage-policy-change-unrecorded-review', 'record-review-result'),
    policyChange('coverage-policy-change-unattested-review', 'record-review-invocation', { separateReviewInvocation: true })
];
