import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../../cli/commands/gate-test-helpers';
import type { WalkScenario } from './navigator-walk';
import { COVERAGE_WALK_SCENARIOS } from './walk-coverage-scenarios';

const BUNDLE = 'garda-agent-orchestrator';
const TASK = 'T-WALK';
const EDITS = [{ path: 'src/app.ts', append: '// recovery family\n' }, { path: 'tests/app.test.ts', append: '// recovery family\n' }];
const CLEAN = { edits: EDITS, expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'] };
function family(id: string): WalkScenario {
    const scenario = COVERAGE_WALK_SCENARIOS.find(entry => entry.id === id);
    if (!scenario) throw new Error('Missing coverage fixture: ' + id);
    return scenario;
}

export const RECOVERY_COVERAGE_WALK_SCENARIOS: readonly WalkScenario[] = [
    ...(['disposition', 'disposition-snapshot', 'prompt'] as const).map(kind => ({ ...CLEAN,
        id: 'coverage-lost-review-' + kind, disturbanceReason: 'Delete authenticated test-review ' + kind + ' before the review gate.',
        // Lost review evidence repeats only its lane; a verified prompt copy needs no repeat.
        expectedReviews: kind === 'prompt' ? { code: 1, test: 1 } : { code: 1, test: 2 },
        expectedModes: kind === 'prompt' ? ['code:FULL', 'test:FULL'] : ['code:FULL', 'test:FULL', 'test:FULL'],
        expectedFailingGates: kind === 'prompt' ? [] : ['required-reviews-check'],
        expectedGates: kind === 'prompt' ? [] : ['restart-review-cycle'],
        prepare: async (root: string, steps: readonly import('./navigator-walk').WalkStep[]) => {
            const last = steps.at(-1);
            if (last?.gate === 'required-reviews-check' && last.exitCode) {
                if (!last.output.includes('Recovery:') || !last.output.includes('authenticated review-evidence-only recovery')) {
                    throw new Error('Review integrity refusal lost its concrete recovery instruction.');
                }
            }
            if (last?.gate !== 'record-review-result' || last.exitCode !== 0 || !last.command?.includes('--review-type "test"')
                || steps.some(step => step.gate === 'required-reviews-check')) return;
            const reviews = path.join(root, BUNDLE, 'runtime/reviews');
            const names = kind === 'disposition-snapshot'
                ? fs.readdirSync(reviews).filter(name => /^T-WALK-test-findings-disposition-[a-f0-9]{64}\.json$/u.test(name))
                : [kind === 'prompt' ? TASK + '-review-context.md' : TASK + '-findings-disposition.json'].map(name => name.replace(TASK + '-', TASK + '-test-'));
            if (names.length !== 1) throw new Error('Expected exactly one native review artifact: ' + kind);
            fs.unlinkSync(path.join(reviews, names[0]));
        }
    })),
    { ...CLEAN, id: 'coverage-changed-reviewer-templates',
        disturbanceReason: 'Corrupt the code reviewer prompt and output templates after routing, before the launch is prepared.',
        expectedFailingGates: ['prepare-reviewer-launch'], expectedGates: ['build-review-context'],
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (last?.gate !== 'record-review-routing' || last.exitCode !== 0 || !last.command?.includes('--review-type "code"')
                || steps.some(step => step.gate === 'prepare-reviewer-launch')) return;
            for (const name of ['prompt-template', 'output-template']) {
                fs.writeFileSync(path.join(root, BUNDLE, 'runtime/reviews', TASK + '-code-' + name + '.md'), '{broken synthetic artifact\n');
            }
        } },
    { ...CLEAN, id: 'coverage-separate-review-invocation', separateReviewInvocation: true, expectedGates: ['record-review-invocation'] },
    { ...CLEAN, id: 'coverage-stateless-output-correction', reviewerAttestation: 'controller',
        disturbances: [{ kind: 'invalid-report-shape', lane: 'code' }],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'],
        // A reachable original reviewer corrects its report without another launch.
        expectedFailingGates: ['record-review-result'] },
    { ...CLEAN, id: 'coverage-missing-correction-package',
        disturbanceReason: 'Replace report bytes after authenticated launch completion; rejection cannot publish a correction package.',
        // A digest-bound completed output replaces modified transport bytes before validation.
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate !== 'complete-reviewer-launch' || steps.at(-1)?.exitCode !== 0
                || steps.filter(step => step.gate === 'complete-reviewer-launch').length !== 1) return;
            const launch = JSON.parse(fs.readFileSync(path.join(root, BUNDLE, 'runtime/tmp/reviews', TASK, 'code/reviewer-launch.json'), 'utf8')) as { review_output_path: string };
            const report = JSON.parse(fs.readFileSync(launch.review_output_path, 'utf8')) as Record<string, unknown>;
            report.unexpected = true;
            fs.writeFileSync(launch.review_output_path, JSON.stringify(report, null, 2) + '\n');
            const now = new Date(); fs.utimesSync(launch.review_output_path, now, now);
        } },
    // Only unparseable bytes: the operator handoff names the line and keeps every passed review if it is removed.
    { ...family('coverage-optional-skill-activation'), id: 'coverage-malformed-task-events',
        disturbanceReason: 'Append malformed timeline bytes before optional-skill activation.',
        expectedReviews: {}, expectedModes: [], expectedGates: [],
        expectedBlockedGate: 'task-reset', expectedGuidance: /unparseable line[\s\S]*task-reset --task-id "T-WALK" --reopen --dry-run/iu,
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate === 'classify-change' && steps.at(-1)?.exitCode === 0) {
                fs.appendFileSync(path.join(root, BUNDLE, 'runtime/task-events', TASK + '.jsonl'), '{bad\n');
            }
        } },
    { ...CLEAN, id: 'coverage-review-cycle-attempt-guard', failures: { code: 1 },
        expectedReviews: { code: 1 }, expectedModes: ['code:FULL'],
        expectedBlockedGate: 'review-cycle-attempt-guard', expectedGuidance: /operator decision|operator-decision/iu,
        configure: root => {
            const file = path.join(root, BUNDLE, 'live/config/workflow-config.json');
            const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { review_cycle_guard: Record<string, unknown> };
            Object.assign(config.review_cycle_guard, { enabled: true, action: 'BLOCK_FOR_OPERATOR_DECISION', max_failed_non_test_reviews: 1, auto_split_enabled: false });
            fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
        } },
    { ...family('coverage-review-follow-ups'), id: 'coverage-lost-follow-up-scope',
        disturbanceReason: 'Remove the native grouped follow-up evidence after completing its parent.',
        expectedGates: [], expectedBlockedGate: 'follow-up-scope-evidence', expectedGuidance: /authenticated.*follow-up|follow-up.*authenticated/iu,
        inspectTask: steps => steps.some(step => step.gate === 'completion-gate' && step.exitCode === 0) ? TASK + '-F1' : TASK,
        prepare: async (root, steps) => {
            if (steps.at(-1)?.gate !== 'completion-gate' || steps.at(-1)?.exitCode !== 0) return;
            for (const argv of [['add', 'src/app.ts', 'tests/app.test.ts'], ['commit', '-qm', 'Complete isolated parent before its native follow-up']]) {
                const run = runGit(root, argv); if (run.status !== 0) throw new Error(run.stderr);
            }
            fs.unlinkSync(path.join(root, BUNDLE, 'runtime/reviews', TASK + '-code-findings-follow-ups.json'));
        } }
];
