import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createWalkTemplate, walkTask, type WalkScenario } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';

test('a reviewer that may have read changed context is repeated, not completed using a restored copy',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        let changedAndRead = false;
        const variant: WalkScenario = { ...baseline, id: 'active-context-changed-input', expectedReviews: {}, expectedModes: [],
            prepare: async (repoRoot, steps, run) => {
                await baseline.prepare?.(repoRoot, steps, run);
                if (steps.length !== 19 || changedAndRead) return;
                const file = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-review-context.json');
                const context = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
                context.task_criteria = { changed_during_review: 'Reviewer observed different criteria' };
                fs.writeFileSync(file, JSON.stringify(context, null, 2) + '\n');
                changedAndRead = fs.readFileSync(file, 'utf8').includes('Reviewer observed different criteria');
            }
        };
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const result = await walkTask(template, variant);
            assert.equal(changedAndRead, true);
            assert.equal(result.outcome, 'done', result.detail);
            assert.deepEqual(result.reviewsByLane, { code: 2, test: 1 });
            assert.deepEqual(result.reviews.map(review => `${review.lane}:${review.mode}`), ['code:FULL', 'code:FULL', 'test:FULL']);
            assert.ok(result.events.some(event => event.type === 'COMPLETION_GATE_PASSED'));
        } finally { removeWalkDirectory(template); }
    });

test('a context damaged after signed post-run proof is restored without repeating the review',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        let damaged = false;
        const variant: WalkScenario = { ...baseline, id: 'recorded-context-post-run-proof', expectedReviews: {}, expectedModes: [],
            prepare: async (repoRoot, steps, run) => {
                await baseline.prepare?.(repoRoot, steps, run);
                if (steps.length !== 21 || damaged) return;
                const file = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-review-context.json');
                const context = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
                context.task_criteria = { changed_after_recording: true };
                fs.writeFileSync(file, JSON.stringify(context, null, 2) + '\n');
                damaged = true;
            }
        };
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const result = await walkTask(template, variant);
            assert.equal(damaged, true);
            assert.equal(result.outcome, 'done', result.detail);
            assert.deepEqual(result.reviewsByLane, { code: 1, test: 1 });
            assert.ok(result.events.some(event => event.type === 'REVIEW_RECORDED' && event.details.review_type === 'code'
                && event.details.reviewer_input_proof));
            assert.ok(result.steps.some(step => step.gate === 'next-step-effect' && /review context/iu.test(step.reason)));
        } finally { removeWalkDirectory(template); }
    });
