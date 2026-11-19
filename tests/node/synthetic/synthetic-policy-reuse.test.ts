import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createWalkTemplate, walkTask } from './engine/navigator-walk';
import { WALK_SCENARIOS } from './engine/walk-scenarios';
import { validatePreflightForReview } from '../../../src/gates/required-reviews/required-reviews-check-contracts';
import { readImmutableValidationEventSnapshot } from '../../../src/gates/project-validation/attempt-evidence';
import { runIntermediateCommandCommand } from '../../../src/cli/commands/gates';
import { handleGate } from '../../../src/cli/commands/gate-command';
import { captureWalkOutput } from './engine/walk-output';
import type { SweepInjection } from './engine/walk-sweep';

const coveragePolicyChangeScenarios = WALK_SCENARIOS.filter(scenario => scenario.id.startsWith('coverage-policy-change-'));
assert.equal(coveragePolicyChangeScenarios.length, 3);
for (const scenario of coveragePolicyChangeScenarios) {
test(`coverage policy-change checkpoint ${scenario.id} keeps one code and one test review`, { timeout: 7200000 }, async () => {
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const result = await walkTask(template, scenario);
        assert.equal(result.outcome, 'done', scenario.id + ': ' + result.detail);
        assert.deepEqual(result.reviewsByLane, { code: 1, test: 1 }, scenario.id);
        assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode), ['code:FULL', 'test:FULL'], scenario.id);
        assert.ok(!result.steps.some(step => step.gate === 'completion-gate' && step.exitCode), scenario.id);
    } finally { fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
}

async function inspectGate(argv: string[]) {
    const output: string[] = [], previousExitCode = process.exitCode;
    try {
        process.exitCode = 0;
        await captureWalkOutput(output, () => handleGate(argv));
        return { exitCode: Number(process.exitCode ?? 0), output: output.join('\n') };
    } catch (error) { return { exitCode: 1, output: [...output, String(error)].join('\n') }; }
    finally { process.exitCode = previousExitCode; }
}

function changeLane(repoRoot: string, lane: string) {
    const file = path.join(repoRoot, 'garda-agent-orchestrator/live/config/profiles.json');
    const profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').split(/\r?\n/u).find(line => /^\|\s*T-WALK\s*\|/u.test(line));
    const profile = row!.split('|')[8].trim();
    profiles.built_in_profiles[profile].review_policy[lane] = true;
    fs.writeFileSync(file, JSON.stringify(profiles, null, 2) + '\n');
}

// Quality-checklist preparation can add a step; gate/lane checkpoints follow the actual lifecycle.
for (const [injectionGate, injectionLane] of [['complete-reviewer-launch', 'code'], ['record-review-result', 'code'],
    ['prepare-reviewer-launch', 'security']] as const)
test(`policy adoption at ${injectionGate}/${injectionLane} carries focused execution and passed review through coherent-cycle recovery`, { timeout: 7200000 }, async () => {
    const base = WALK_SCENARIOS.find(scenario => scenario.id === 'security-refactor-pass');
    assert.ok(base);
    const template = await createWalkTemplate(path.resolve('.'));
    const injection: SweepInjection = { seed: 1785881697, baseline: base.id, step: -1, gate: injectionGate,
        checkpoint: { lane: injectionLane }, disturbances: [{ kind: 'change-policy' }] };
    let inspectedFrozenEvidence = false;
    let checkedNewLaunch = false;
    try {
        const result = await walkTask(template, { ...base, id: 'focused-validation-policy-change',
            execute: async (repoRoot, step) => {
                if (injectionGate === 'prepare-reviewer-launch' && !checkedNewLaunch && injection.step >= 0 && step.index >= injection.step) {
                    const preflight = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json');
                    if (validatePreflightForReview(preflight, 'T-WALK').errors.some(error => error.includes('policy inputs changed'))) {
                        checkedNewLaunch = true;
                        const build = await inspectGate(['build-review-context', '--repo-root', repoRoot,
                            '--review-type', 'security', '--depth', '3', '--preflight-path', preflight]);
                        assert.notEqual(build.exitCode, 0);
                        assert.match(build.output, /policy inputs changed|next-step/iu);
                        const prepare = await inspectGate(['prepare-reviewer-launch', '--task-id', 'T-WALK',
                            '--review-type', 'security', '--reviewer-execution-mode', 'delegated_subagent',
                            '--reviewer-launch-artifact-path', 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/security/reviewer-launch.json',
                            '--repo-root', repoRoot]);
                        assert.notEqual(prepare.exitCode, 0);
                        assert.match(prepare.output, /policy inputs changed/iu);
                    }
                }
                if (inspectedFrozenEvidence || !step.reason.startsWith('Review policy inputs changed while this reviewer')) return false;
                inspectedFrozenEvidence = true;
                const preflight = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json');
                assert.ok(validatePreflightForReview(preflight, 'T-WALK').errors.some(error => error.includes('policy inputs changed')),
                    'new launches must still reject unadopted live policy drift');
                assert.deepEqual(validatePreflightForReview(preflight, 'T-WALK', '', 'frozen-validation-evidence').errors, [],
                    'the started reviewer retains its authenticated frozen validation obligations');
                return false;
            },
            injection });
        if (result.outcome !== 'done') fs.writeFileSync(path.join(os.tmpdir(), `focused-policy-carry-failure-${injectionGate}.json`), JSON.stringify(result, null, 2));
        assert.equal(result.outcome, 'done', result.detail);
        if (injectionGate === 'prepare-reviewer-launch') assert.ok(checkedNewLaunch, 'both fresh context and launch must refuse before executable adoption');
        if (injectionGate !== 'prepare-reviewer-launch') assert.ok(inspectedFrozenEvidence, 'finish the started review before adoption');
        assert.deepEqual(result.sweep?.applied, ['change-policy']);
        assert.ok(!result.steps.some(step => step.gate === 'project-validation-evidence'),
            'adoption and recovery must retain usable authenticated execution evidence');
        assert.equal(result.steps.filter(step => step.gate === 'run-intermediate-command').length, 1,
            'the original focused execution must survive adoption and coherent recovery');
        assert.equal(result.reviewsByLane.code, 1, 'unchanged code must retain its passed review');
        assert.ok(result.events.some(event => event.type === 'REVIEW_RECORDED'
            && event.details.reused_existing_review === true && event.details.review_type === 'code'));
        assert.ok(result.steps.some(step => step.gate === 'restart-coherent-cycle' && step.exitCode === 0));
    } finally {
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('adoption, rerun, coherent recovery and second adoption finish with passed lanes kept and a new lane once FULL', { timeout: 7200000 }, async () => {
    const base = WALK_SCENARIOS.find(scenario => scenario.id === 'security-refactor-pass')!;
    const template = await createWalkTemplate(path.resolve('.'));
    let reran = false, changedAgain = false;
    try {
        const result = await walkTask(template, { ...base, id: 'rerun-recovery-second-adoption', approvedPolicyAdoptions: 2,
            execute: async (repoRoot, step) => {
                let snapshot: ReturnType<typeof readImmutableValidationEventSnapshot>;
                try { snapshot = readImmutableValidationEventSnapshot(repoRoot, 'T-WALK'); } catch { return false; }
                const modes = snapshot.events.filter(event => event.event_type === 'TASK_MODE_ENTERED');
                const firstAdoption = modes.find(event => event.details?.review_policy_adoption);
                if (!firstAdoption) return false;
                if (!reran && snapshot.preflight_sequence > Number(firstAdoption.integrity?.task_sequence)) {
                    const original = snapshot.events.find(event => event.event_type === 'INTERMEDIATE_COMMAND_RUN' && event.details?.exit_code === 0)!;
                    const data = original.details!;
                    const rerun = await runIntermediateCommandCommand({ repoRoot, taskId: 'T-WALK',
                        commandSource: String(data.command_source), command: String(data.command), preflightPath: snapshot.preflight_path });
                    assert.equal(rerun.exitCode, 0, rerun.outputLines.join('\n'));
                    reran = true;
                } else if (reran && !changedAgain && modes.at(-1) !== firstAdoption
                    && step.gate === 'required-reviews-check'
                    && ['code', 'security', 'refactor', 'test'].every(lane => snapshot.events.some(event =>
                        event.event_type === 'REVIEW_RECORDED' && event.details?.review_type === lane))) {
                    changeLane(repoRoot, 'performance'); changedAgain = true;
                }
                return false;
            },
            injection: { seed: 1785881697, baseline: base.id, step: -1, gate: 'prepare-reviewer-launch', checkpoint: { lane: 'security' },
                disturbances: [{ kind: 'change-policy' }] } });
        fs.writeFileSync(path.join(os.tmpdir(), 'rerun-recovery-second-adoption.json'), JSON.stringify(result, null, 2));
        assert.equal(result.outcome, 'done', result.detail);
        assert.ok(reran && changedAgain);
        assert.equal(result.events.filter(event => event.type === 'TASK_MODE_ENTERED' && event.details.review_policy_adoption).length, 2);
        assert.ok(result.steps.some(step => step.gate === 'restart-coherent-cycle' && step.exitCode === 0));
        assert.equal(result.reviewsByLane.code, 1);
        for (const lane of ['test', 'security', 'refactor', 'performance']) assert.equal(result.reviewsByLane[lane], 1, lane);
        assert.deepEqual(result.reviews.filter(review => review.lane === 'performance').map(review => review.mode), ['FULL']);
    } finally { fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('an adoption without retained carry authority routes to a real focused rerun and finishes', { timeout: 7200000 }, async () => {
    const base = WALK_SCENARIOS.find(scenario => scenario.id === 'security-refactor-pass')!;
    const template = await createWalkTemplate(path.resolve('.'));
    let removed = false;
    try {
        const result = await walkTask(template, { ...base, id: 'legacy-adoption-without-carry',
            execute: async (repoRoot, step) => {
                if (!removed && step.gate === 'enter-task-mode' && step.command?.includes('--adopt-changed-review-policy')) {
                    // Older adoption records did not retain validation carry. Missing original facts likewise
                    // make the real adoption gate publish no carry authority; never invent historical evidence.
                    fs.unlinkSync(path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json'));
                    removed = true;
                }
                return false;
            },
            injection: { seed: 1785881697, baseline: base.id, step: -1, gate: 'prepare-reviewer-launch', checkpoint: { lane: 'security' },
                disturbances: [{ kind: 'change-policy' }] } });
        fs.writeFileSync(path.join(os.tmpdir(), 'legacy-adoption-without-carry.json'), JSON.stringify(result, null, 2));
        assert.ok(removed);
        assert.equal(result.outcome, 'done', result.detail);
        const adoption = result.events.find(event => event.type === 'TASK_MODE_ENTERED' && event.details.review_policy_adoption)!;
        assert.equal((adoption.details.review_policy_adoption as { validation_carry: unknown }).validation_carry, null);
        assert.ok(result.steps.some(step => step.index > result.sweep!.step && step.gate === 'run-intermediate-command'),
            'missing historical carry must yield an executable focused-test route');
        assert.equal(result.reviewsByLane.code, 1);
    } finally { fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('a policy change finishes and reuses an already-started reviewer', { timeout: 7200000 }, async () => {
    const base = WALK_SCENARIOS.find(scenario => scenario.id === 'clean-pass');
    assert.ok(base);
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const result = await walkTask(template, { ...base, id: 'pending-review-policy-change',
            injection: { seed: 1785881697, baseline: base.id, step: -1, gate: 'complete-reviewer-launch', checkpoint: { lane: 'code' },
                disturbances: [{ kind: 'change-policy' }] } });
        assert.equal(result.outcome, 'done', result.detail);
        assert.deepEqual(result.sweep?.applied, ['change-policy']);
        assert.equal(result.reviewsByLane.code, 1, 'the in-flight code review must not launch again');
        assert.equal(result.reviewsByLane.test, 1);
        assert.ok(result.events.some(event => event.type === 'REVIEW_RECORDED'
            && event.details.reused_existing_review === true && event.details.review_type === 'code'));
        const recorded = result.steps.findIndex(step => step.index >= result.sweep!.step && step.gate === 'record-review-result' && step.exitCode === 0);
        const adopted = result.steps.findIndex(step => step.gate === 'enter-task-mode' && step.userApproval);
        assert.ok(recorded >= 0 && adopted > recorded, 'record the frozen review before policy adoption');
    } finally {
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test('an approved code-policy change keeps an already recorded custom review', { timeout: 7200000 }, async () => {
    const base = WALK_SCENARIOS.find(scenario => scenario.id === 'custom-trigger-reopens-passed-lane');
    assert.ok(base);
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const result = await walkTask(template, { ...base, id: 'custom-policy-preserves-review', failures: {}, fix: undefined,
            injection: { seed: 1785881697, baseline: base.id, step: -1, gate: 'build-review-context', checkpoint: { lane: 'test' },
                disturbances: [{ kind: 'change-policy' }] } });
        assert.equal(result.outcome, 'done', result.detail);
        assert.deepEqual(result.sweep?.applied, ['change-policy']);
        assert.ok(result.steps.some(step => step.index < result.sweep!.step && step.gate === 'record-review-result'
            && step.command?.includes('--review-type "custom-quality"') && step.exitCode === 0));
        assert.ok(result.steps.some(step => step.gate === 'enter-task-mode' && step.userApproval));
        assert.equal(result.reviewsByLane['custom-quality'], 1, 'the passed custom lane must not launch again');
        assert.ok(result.events.some(event => event.type === 'REVIEW_RECORDED'
            && event.details.reused_existing_review === true && event.details.review_type === 'custom-quality'));
    } finally {
        fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
