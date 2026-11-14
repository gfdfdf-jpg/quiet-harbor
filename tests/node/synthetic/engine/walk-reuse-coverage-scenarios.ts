import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitCommandLine } from '../../../../src/core/command-line';
import { readReviewCycleGuardEvaluation } from '../../../../src/gates/next-step/next-step-review-cycle-guard-evaluation';
import { buildReviewCycleContinuationCommand } from '../../../../src/gates/next-step/next-step-review-cycle-guard-operator-block';
import { COVERAGE_WALK_SCENARIOS } from './walk-coverage-scenarios';
import type { WalkScenario, WalkStep } from './navigator-walk';

const BUNDLE = 'garda-agent-orchestrator';
const EDITS = [{ path: 'src/app.ts', append: '// current-cycle reuse\n' }, { path: 'tests/app.test.ts', append: '// current-cycle reuse\n' }];
type Prepare = NonNullable<WalkScenario['prepare']>;

const recorded = (lane: string) => (step: WalkStep | undefined): boolean =>
    step?.gate === 'record-review-result' && !!step.command?.includes('--review-type "' + lane + '"');

/**
 * Compile-newer-than-review states without running a gate out of order. In each cycle, once `after` holds, the
 * authenticated compile report is lost. next-step names compile-gate as the way out, and the walker runs it. The
 * native review-cycle guard then counts the timeline integrity incident and blocks for an operator decision; the
 * synthetic operator approves exactly one more cycle with the native continuation command. The source still matches
 * the reviewed state while the latest compile is newer than the review: what a repeated compile with unchanged source
 * produced before compile-gate refused it as out of order. `then` runs once that approval is recorded.
 */
export function lostCompileEvidence(cycles: ReadonlyArray<{ after: (last: WalkStep | undefined) => boolean; then?: (root: string) => void }>): Prepare {
    let cycle = 0, lost = false;
    return async (root, steps, run) => {
        if (!steps.length) { cycle = 0; lost = false; }
        if (cycle >= cycles.length) return;
        const last = steps.at(-1);
        if (!lost && cycles[cycle].after(last)) {
            fs.unlinkSync(path.join(root, BUNDLE, 'runtime/reviews/T-WALK-compile-gate.json'));
            lost = true;
        } else if (lost && last?.gate === 'compile-gate' && last.exitCode === 0) {
            const { evaluation } = readReviewCycleGuardEvaluation(root, path.join(root, BUNDLE, 'runtime/task-events'), 'T-WALK');
            if (evaluation.should_block) {
                const argv = splitCommandLine(buildReviewCycleContinuationCommand('node bin/garda.js', 'T-WALK', evaluation)
                    .replace('<ISO-8601 timestamp>', new Date().toISOString()));
                await run(argv.slice(argv.indexOf('gate') + 1));
            }
            cycles[cycle].then?.(root);
            cycle += 1; lost = false;
        }
    };
}

function recompiledAfterReview(lane: 'code' | 'test' | 'security', loseScoped = false): WalkScenario {
    const lanes = lane === 'security' ? ['code', 'security', 'test'] : ['code', 'test'];
    return {
        id: 'coverage-repeat-compile-' + lane + (loseScoped ? '-lost-scoped' : ''),
        edits: EDITS, requiredLanes: lanes, fullSuitePlacement: 'before_completion',
        expectedReviews: Object.fromEntries(lanes.map(type => [type, 1])), expectedModes: lanes.map(type => type + ':FULL'),
        disturbanceReason: 'Lose the compile report after the accepted ' + lane + ' review; compile as next-step names and approve one more review cycle'
            + (loseScoped ? ', then lose the native security scoped metadata.' : '.'),
        prepare: lostCompileEvidence([{ after: last => recorded(lane)(last) && last!.exitCode === 0,
            then: loseScoped ? root => fs.unlinkSync(path.join(root, BUNDLE, 'runtime/reviews/T-WALK-security-scoped.json')) : undefined }])
    };
}

function upstreamReuseAfterEvidenceLoss(loseScoped: boolean): WalkScenario {
    const lanes = ['refactor', 'code', 'security', 'test'];
    const order = ['refactor', 'code', 'db', 'security', 'api', 'performance', 'infra', 'dependency', 'test'];
    // First cycle once every review is recorded; next-step then materializes reuse after that compile. Second cycle once
    // security reuse is bound to that compile; then the refactor context (and, scoped, the security metadata) is lost.
    const prepare = lostCompileEvidence([
        { after: last => recorded('test')(last) && last!.exitCode === 0 },
        { after: last => last?.gate === 'build-review-context' && last.exitCode === 0 && !!last.command?.includes('--review-type "security"'),
            then: root => {
                fs.unlinkSync(path.join(root, BUNDLE, 'runtime/reviews/T-WALK-refactor-review-context.json'));
                if (loseScoped) fs.unlinkSync(path.join(root, BUNDLE, 'runtime/reviews/T-WALK-security-scoped.json'));
            } }
    ]);
    return {
        id: 'coverage-upstream-reuse-' + (loseScoped ? 'lost-scoped' : 'context'),
        edits: EDITS, requiredLanes: lanes, fullSuitePlacement: 'before_completion',
        dependencyGraph: { preparation_order: order,
            dependencies: Object.fromEntries(order.map(lane => [lane, lane === 'test' ? lanes.slice(0, -1) : []])) },
        expectedReviews: Object.fromEntries(lanes.map(lane => [lane, 1])), expectedModes: lanes.map(lane => lane + ':FULL'),
        disturbanceReason: 'Lose the compile report twice, compiling as next-step names and approving each further cycle; lose the refactor context while an authenticated security reuse belongs to the preceding compile'
            + (loseScoped ? ', also losing its scoped metadata.' : '.'),
        expectedBlockedGate: loseScoped ? 'build-scoped-diff' : 'build-review-context',
        expectedGuidance: loseScoped ? /requires lane-domain-current 'security' PASS evidence to be rebound/u
            : /current-cycle 'security' binding before downstream 'refactor' review-context preparation/u,
        prepare
    };
}

export const REUSE_COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = [
    {
        ...COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-review-follow-ups')!,
        id: 'coverage-per-finding-follow-ups',
        configure: root => {
            const file = path.join(root, BUNDLE, 'live/config/profiles.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8'));
            config.built_in_profiles.balanced.review_follow_up_policy.materialization_mode = 'per_finding';
            fs.writeFileSync(file, JSON.stringify(config));
        }
    },
    recompiledAfterReview('code'), recompiledAfterReview('test'), recompiledAfterReview('security', true),
    upstreamReuseAfterEvidenceLoss(false), upstreamReuseAfterEvidenceLoss(true)
];
