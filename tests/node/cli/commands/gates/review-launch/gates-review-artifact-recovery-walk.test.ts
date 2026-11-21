import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { compareWalk, createWalkTemplate, walkTaskFamily, type WalkScenario, type WalkResult } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';
import type { SweepDisturbance } from '../../../../synthetic/engine/walk-sweep';

const snapshotDigest = 'a'.repeat(64); // resolveSweepArtifact binds the actual fresh snapshot of the restored checkpoint.
const cases = [
    // After the handoff the reviewer reads its inputs from disk: without a recorded post-run proof, only that review repeats
    // (after prepare only, the failed-launch recovery gives a fresh attempt before the launch is counted, so the lane counts once).
    { group: 'handoff-prepared', step: 18, gate: 'record-reviewer-delegation-started', file: 'code-role-prompt.md', freshAttempt: true },
    { group: 'handoff-started', step: 19, gate: 'complete-reviewer-launch', file: 'code-prompt-template.md', repeat: 'code' },
    { group: 'handoff-finished', step: 20, gate: 'record-review-result', file: 'code-review-context.md', repeat: 'code' },
    { group: 'rebuilt-context', step: 19, gate: 'complete-reviewer-launch', file: 'code-review-context.json', repeat: 'code' },
    { group: 'prepared-context', step: 18, gate: 'record-reviewer-delegation-started', file: 'code-review-context.json' },
    { group: 'finished-context', step: 20, gate: 'record-review-result', file: 'code-review-context.json', repeat: 'code' },
    { group: 'recompiled-task-evidence', step: 20, gate: 'record-review-result', file: 'compile-gate.json' },
    { group: 'lost-launch-control', step: 18, gate: 'record-reviewer-delegation-started', file: 'code-reviewer-launch.json',
        inputPath: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/code/reviewer-launch.json', operatorControl: true },
    { group: 'lost-launch-input', step: 18, gate: 'record-reviewer-delegation-started', file: 'code-reviewer-launch-input.json',
        inputPath: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/code/reviewer-launch-input.json' },
    { group: 'recorded-report', step: 21, gate: 'build-review-context', file: 'code.md', repeat: 'code' },
    { group: 'recorded-receipt', step: 21, gate: 'build-review-context', file: 'code-receipt.json', repeat: 'code' },
    { group: 'recorded-validation', step: 21, gate: 'build-review-context', file: 'code-findings-validation.json', repeat: 'code' },
    // A lost snapshot of the current test result is lost evidence of that review only: no operator stop, no reset.
    { group: 'immutable-report', step: 27, gate: 'required-reviews-check', file: `test-artifact-${snapshotDigest}.md`, repeat: 'test' },
    { group: 'immutable-receipt', step: 27, gate: 'required-reviews-check', file: `test-receipt-${snapshotDigest}.json`, repeat: 'test' },
    { group: 'immutable-validation', step: 27, gate: 'required-reviews-check', file: `test-findings-validation-${snapshotDigest}.json`, repeat: 'test' },
    // The recorded result proved these inputs intact after the run: the exact copy restores them and nothing repeats,
    // the same in the dependency gate (upstream-*) and in required-reviews-check (recorded-input).
    { group: 'upstream-build', step: 21, gate: 'build-review-context', file: 'code-review-context.md' },
    { group: 'upstream-launch', step: 23, gate: 'prepare-reviewer-launch', file: 'code-review-context.md' },
    { group: 'recorded-input', step: 27, gate: 'required-reviews-check', file: 'test-review-context.md' },
    { group: 'disposition', step: 27, gate: 'required-reviews-check', file: 'test-findings-disposition.json', repeat: 'test' },
    { group: 'disposition-snapshot', step: 27, gate: 'required-reviews-check', file: `test-findings-disposition-${snapshotDigest}.json`, repeat: 'test' }
];

for (const kind of ['delete-artifact', 'corrupt-artifact'] as const) {
    test(`${kind}: real review gates recover each evidence group without loops or unrelated reviewers`,
        { timeout: 7_200_000, concurrency: false }, async t => {
            const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
            assert.ok(baseline);
            const variants: WalkScenario[] = cases.map(entry => ({
                ...baseline, id: `review-recovery-${kind}-${entry.group}`, expectedReviews: {}, expectedModes: [],
                injection: { seed: 0, baseline: baseline.id, step: entry.step, gate: entry.gate,
                    disturbances: [{ kind, artifact: { path: entry.inputPath || 'garda-agent-orchestrator/runtime/reviews/T-WALK-' + entry.file,
                        kind: entry.operatorControl ? 'launch' : 'report' } } satisfies SweepDisturbance] }
            }));
            const template = await createWalkTemplate(path.resolve('.'));
            try {
                const results: WalkResult[] = [];
                for (const step of new Set(cases.map(entry => entry.step))) {
                    results.push(...await walkTaskFamily(template, baseline, variants.filter(variant => variant.injection?.step === step)));
                    console.log(`${kind}: recovery family completed at step ${step}`);
                }
                for (const [index, entry] of cases.entries()) {
                    await t.test(entry.group, () => {
                        const variant = variants[index];
                        const result = results.find(result => result.scenarioId === variant.id);
                        assert.ok(result, variant.id);
                        assert.equal(result.outcome, entry.operatorControl ? 'blocked' : 'done', variant.id + ': ' + result.detail.slice(0, 1200));
                        assert.deepEqual(result.reviewsByLane, entry.operatorControl ? {} : { code: entry.repeat === 'code' ? 2 : 1, test: entry.repeat === 'test' ? 2 : 1 }, variant.id);
                        assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), [], variant.id);
                        if (!entry.operatorControl) {
                            assert.ok(!result.steps.some(step => step.gate === 'review-cycle-attempt-guard'
                                || /task-reset/u.test(step.command || '')), variant.id);
                        }
                        if (entry.operatorControl) assert.match(result.detail, /Ask the operator.*task-reset/u);
                        const restarts = result.steps.filter(step => step.gate === 'restart-review-cycle');
                        if (entry.group === 'prepared-context') {
                            assert.equal(restarts.length, 0, variant.id + ': the authenticated context copy keeps the review attempt');
                        } else if (entry.group === 'lost-launch-input' || entry.repeat || entry.freshAttempt) {
                            assert.ok(restarts.length, variant.id);
                            assert.ok(restarts.every(step => step.command?.includes('--review-evidence-only')), variant.id);
                        }
                    });
                }
            } finally { removeWalkDirectory(template); }
        });
}

test('reset applies the whole recreated artifact batch before an honest startup-evidence handoff',
    { timeout: 7_200_000 }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const variant: WalkScenario = { ...baseline, id: 'review-recovery-reset-artifact-batch', expectedReviews: {}, expectedModes: [],
            injection: { seed: 1785881697, baseline: baseline.id, step: 9, gate: 'load-rule-pack', disturbances: [
                { kind: 'corrupt-artifact', artifact: { path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json', kind: 'preflight' } },
                { kind: 'corrupt-artifact', artifact: { path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-handshake.json', kind: 'report' } },
                { kind: 'stale-artifact', artifact: { path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-task-mode.json', kind: 'report' } },
                { kind: 'reset-task' }
            ] } };
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const results = await walkTaskFamily(template, baseline, [variant]);
            const result = results.find(result => result.scenarioId === variant.id);
            assert.ok(result);
            assert.equal(result.sweep?.applied.length, 4);
            assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), []);
        } finally { removeWalkDirectory(template); }
    });

test('upstream prompt loss without an exact recovery copy repeats only that review',
    { timeout: 7_200_000 }, async t => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const removed = new Set<string>();
        const variants: WalkScenario[] = (['delete-artifact', 'corrupt-artifact'] as const).map(kind => ({
            ...baseline, id: 'review-recovery-uncached-upstream-' + kind, expectedReviews: {}, expectedModes: [],
            injection: { seed: 1785881697, baseline: baseline.id, step: 21, gate: 'build-review-context',
                disturbances: [{ kind, artifact: { path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-review-context.md', kind: 'context' } }] },
            prepare: async (repoRoot, steps, run) => {
                await baseline.prepare?.(repoRoot, steps, run);
                if (steps.length !== 21 || removed.has(kind)) return;
                const context = JSON.parse(fs.readFileSync(path.join(repoRoot,
                    'garda-agent-orchestrator/runtime/reviews/T-WALK-code-review-context.json'), 'utf8'));
                const digest = String(context.rule_context.artifact_sha256);
                assert.match(digest, /^[0-9a-f]{64}$/u);
                const cache = path.join(repoRoot, 'garda-agent-orchestrator/runtime/tmp/.reviewer-input-cache/T-WALK', digest);
                assert.ok(fs.existsSync(cache), 'the original native prepare kept the exact bytes');
                fs.unlinkSync(cache); // Model a task prepared before these disposable copies existed.
                removed.add(kind);
            }
        }));
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const results = await walkTaskFamily(template, baseline, variants);
            for (const variant of variants) await t.test(variant.id, () => {
                const result = results.find(result => result.scenarioId === variant.id);
                assert.ok(result);
                assert.equal(removed.size, 2);
                assert.equal(result.outcome, 'done', result.detail);
                assert.deepEqual(result.reviewsByLane, { code: 2, test: 1 });
                assert.ok(result.events.some(event => event.type === 'REVIEWER_HANDOFF_INPUTS_REJECTED'
                    && event.details?.upstream_review_type === 'code'));
                assert.ok(result.steps.some(step => step.gate === 'restart-review-cycle'
                    && step.command?.includes('--review-evidence-only')));
                assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), []);
            });
        } finally { removeWalkDirectory(template); }
    });

test('a tampered or missing copy of a recorded review input repeats only that review, and closeout removes the copies',
    { timeout: 7_200_000 }, async t => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const copies = (repoRoot: string) => path.join(repoRoot, 'garda-agent-orchestrator/runtime/tmp/.reviewer-input-cache/T-WALK');
        const extraCopies = (repoRoot: string, task: string) => ['.reviewer-output-cache', '.review-context-cache']
            .map(name => path.join(repoRoot, 'garda-agent-orchestrator/runtime/tmp', name, task));
        const changed = new Set<string>();
        const observed = new Map<string, boolean[]>();
        const observedExtra = new Map<string, boolean[][]>();
        const otherCopies = new Map<string, boolean[]>();
        const variants: WalkScenario[] = (['tampered', 'missing'] as const).map(copy => ({
            ...baseline, id: 'review-recovery-recorded-input-copy-' + copy, expectedReviews: {}, expectedModes: [],
            injection: { seed: 1785881697, baseline: baseline.id, step: 27, gate: 'required-reviews-check',
                disturbances: [{ kind: 'corrupt-artifact', artifact: {
                    path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-test-review-context.md', kind: 'context' } }] },
            prepare: async (repoRoot, steps, run) => {
                await baseline.prepare?.(repoRoot, steps, run);
                observed.set(copy, [...observed.get(copy) ?? [], fs.existsSync(copies(repoRoot))]);
                observedExtra.set(copy, [...observedExtra.get(copy) ?? [], extraCopies(repoRoot, 'T-WALK').map(dir => fs.existsSync(dir))]);
                otherCopies.set(copy, extraCopies(repoRoot, 'T-OTHER').map(dir => fs.existsSync(path.join(dir, 'shared'))));
                if (steps.length !== 27 || changed.has(copy)) return;
                for (const dir of extraCopies(repoRoot, 'T-OTHER')) {
                    fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(path.join(dir, 'shared'), 'another active task');
                }
                const context = JSON.parse(fs.readFileSync(path.join(repoRoot,
                    'garda-agent-orchestrator/runtime/reviews/T-WALK-test-review-context.json'), 'utf8'));
                const cache = path.join(copies(repoRoot), String(context.rule_context.artifact_sha256));
                assert.ok(fs.existsSync(cache), 'the original native prepare kept the exact bytes for this task');
                // A tampered copy is never trusted; a missing one models an older task prepared without copies.
                if (copy === 'tampered') fs.writeFileSync(cache, 'tampered copy\n'); else fs.unlinkSync(cache);
                changed.add(copy);
            }
        }));
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const results = await walkTaskFamily(template, baseline, variants);
            for (const variant of variants) await t.test(variant.id, () => {
                const result = results.find(result => result.scenarioId === variant.id);
                assert.ok(result);
                assert.equal(changed.size, 2);
                assert.equal(result.outcome, 'done', result.detail.slice(0, 1200));
                assert.deepEqual(result.reviewsByLane, { code: 1, test: 2 });
                assert.ok(result.steps.some(step => step.gate === 'restart-review-cycle'
                    && step.command?.includes('--review-evidence-only') && step.command.includes('test')));
                assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), []);
                const seen = observed.get(variant.id.endsWith('tampered') ? 'tampered' : 'missing') ?? [];
                assert.ok(seen.includes(true), 'copies existed while the task was open');
                assert.equal(seen.at(-1), false, 'final closeout removed this task\'s copies');
                const extra = observedExtra.get(variant.id.endsWith('tampered') ? 'tampered' : 'missing') ?? [];
                assert.ok(extra.some(states => states.every(Boolean)), 'output and context copies existed while open');
                assert.deepEqual(extra.at(-1), [false, false], 'final closeout removed output and context copies');
                assert.deepEqual(otherCopies.get(variant.id.endsWith('tampered') ? 'tampered' : 'missing'), [true, true]);
            });
        } finally { removeWalkDirectory(template); }
    });
