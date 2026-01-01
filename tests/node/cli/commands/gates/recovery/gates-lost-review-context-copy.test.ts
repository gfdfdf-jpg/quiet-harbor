import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWalkTemplate, walkTaskFamily, type WalkResult, type WalkScenario } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import type { EconomyFacts } from '../../../../synthetic/engine/walk-economy';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';
import * as taskEventIo from '../../../../../../src/gate-runtime/timeline/task-events-io';
import * as lifecycleEvents from '../../../../../../src/gate-runtime/timeline/lifecycle-event-emitters';

const CLEAN: EconomyFacts = { dependencies: {}, scope: ['src/app.ts', 'tests/app.test.ts'], reviews: [
    { lane: 'code', mode: 'FULL', launched: 18, recorded: 19 },
    { lane: 'test', mode: 'FULL', launched: 24, recorded: 25 }
] };

function describe(result: WalkResult): string {
    return result.scenarioId + ': ' + result.outcome + ' ' + result.detail.slice(0, 600) + ' '
        + result.steps.filter(step => !step.reusedPrefix).map(step => step.route + (step.exitCode ? '(exit ' + step.exitCode + ')' : '')).join(' > ');
}

test('a lost context restores its authenticated copy, or repeats only that review after recording the finished other review',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const cases = [
            ['deleted-valid', 'delete-artifact', 'valid', 'code'], ['corrupt-valid', 'corrupt-artifact', 'valid', 'code'],
            ['deleted-missing', 'delete-artifact', 'missing', 'code'], ['corrupt-missing', 'corrupt-artifact', 'missing', 'code'],
            ['corrupt-tampered', 'corrupt-artifact', 'tampered', 'code'], ['deleted-older-task', 'delete-artifact', 'older', 'code'],
            ['json-valid', 'corrupt-artifact', 'valid', 'code'], ['json-missing', 'corrupt-artifact', 'missing', 'code'],
            ['test-context-valid', 'delete-artifact', 'valid', 'test'], ['test-context-missing', 'delete-artifact', 'missing', 'test']
        ] as const;
        const variants: WalkScenario[] = cases.map(([id, kind, copy, lane]) => {
            let prepared = false;
            let original = '';
            return { ...baseline, id: 'context-copy-' + id, expectedReviews: {}, expectedModes: [],
                disturbanceReason: 'Exercise review-context recovery after a reviewer finished.',
                prepare: async (repoRoot, steps) => {
                    const root = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
                    const context = path.join(root, 'reviews', `T-WALK-${lane}-review-context.json`);
                    if (steps.length === 27 && id.startsWith('json-') && original) {
                        const changed = JSON.parse(original) as Record<string, unknown>;
                        changed.unexpected_context_change = true;
                        fs.writeFileSync(context, JSON.stringify(changed, null, 2) + '\n');
                        original = '';
                    }
                    if (prepared || steps.length !== 26) return;
                    prepared = true;
                    if (id.startsWith('json-')) original = fs.readFileSync(context, 'utf8');
                    if (copy === 'valid') return;
                    const sha = crypto.createHash('sha256').update(fs.readFileSync(context)).digest('hex');
                    const cache = path.join(root, 'tmp', '.review-context-cache', 'T-WALK');
                    const cached = path.join(cache, sha);
                    assert.ok(fs.existsSync(cached), 'the real build and routing preserved the reviewed context');
                    if (copy === 'tampered') fs.writeFileSync(cached, 'tampered');
                    else if (copy === 'older') for (const file of fs.readdirSync(cache)) fs.unlinkSync(path.join(cache, file));
                    else fs.unlinkSync(cached);
                },
                injection: { seed: 0, baseline: baseline.id, step: 26, gate: 'record-review-result', economy: CLEAN,
                    disturbances: [{ kind, artifact: { path: `garda-agent-orchestrator/runtime/reviews/T-WALK-${lane}-review-context.json`, kind: 'context' } }] }
            };
        });
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const results = await walkTaskFamily(template, baseline, variants);
            if (results.some(result => result.outcome !== 'done' || result.events.some(event => event.type === 'COMPLETION_GATE_FAILED')
                || result.steps.some(step => step.gate === 'restart-coherent-cycle'))) {
                fs.writeFileSync(path.join(os.tmpdir(), 'garda-context-copy-regression-failures.json'), JSON.stringify(results.map(result => ({
                    id: result.scenarioId, outcome: result.outcome, detail: result.detail, reviews: result.reviews,
                    steps: result.steps.filter(step => !step.reusedPrefix).map(step => ({
                        index: step.index, route: step.route, reason: step.reason, exitCode: step.exitCode, output: step.output
                    }))
                })), null, 2));
            }
            for (const [id, , copy, lane] of cases) {
                const result = results.find(entry => entry.scenarioId === 'context-copy-' + id);
                assert.ok(result, id);
                assert.equal(result.outcome, 'done', describe(result));
                // Only the already-recorded code review has post-run proof for its context.
                const restored = lane === 'code' && copy === 'valid';
                assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode),
                    restored ? ['code:FULL', 'test:FULL'] : ['code:FULL', 'test:FULL', lane + ':FULL'], describe(result));
                assert.equal(result.events.some(event => event.type === 'COMPLETION_GATE_FAILED'), false, describe(result));
                assert.equal(result.steps.some(step => step.gate === 'restart-coherent-cycle'), false, describe(result));
            }
        } finally { removeWalkDirectory(template); }
    });

test('a parseable corruption of the unrecorded test context repeats only test even when a copy exists',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const variants: WalkScenario[] = ['valid', 'missing'].map(copy => {
            let original = '';
            let prepared = false;
            return { ...baseline, id: 'parseable-test-context-' + copy, expectedReviews: {}, expectedModes: [],
                disturbanceReason: 'Change a finished reviewer context without breaking JSON.',
                prepare: async (repoRoot, steps) => {
                    const root = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
                    const context = path.join(root, 'reviews', 'T-WALK-test-review-context.json');
                    if (steps.length === 27 && original) {
                        const changed = JSON.parse(original) as Record<string, unknown>;
                        changed.unexpected_context_change = true;
                        fs.writeFileSync(context, JSON.stringify(changed, null, 2) + '\n');
                        original = '';
                    }
                    if (prepared || steps.length !== 26) return;
                    prepared = true;
                    original = fs.readFileSync(context, 'utf8');
                    if (copy === 'missing') {
                        const sha = crypto.createHash('sha256').update(original).digest('hex');
                        fs.unlinkSync(path.join(root, 'tmp', '.review-context-cache', 'T-WALK', sha));
                    }
                },
                injection: { seed: 0, baseline: baseline.id, step: 26, gate: 'record-review-result', economy: CLEAN,
                    disturbances: [{ kind: 'corrupt-artifact', artifact: {
                        path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-test-review-context.json', kind: 'context'
                    } }] }
            };
        });
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const results = await walkTaskFamily(template, baseline, variants);
            fs.writeFileSync(path.join(os.tmpdir(), 'terra-context-copy-parseable-test-result.json'), JSON.stringify(results));
            for (const copy of ['valid', 'missing']) {
                const result = results.find(entry => entry.scenarioId === 'parseable-test-context-' + copy);
                assert.ok(result);
                assert.equal(result.outcome, 'done', describe(result));
                assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode),
                    ['code:FULL', 'test:FULL', 'test:FULL'], describe(result));
                assert.equal(result.events.filter(event => event.type === 'REVIEW_PHASE_STARTED' && event.details.review_type === 'test').length,
                    2, 'a lost context is rebuilt before a fresh reviewer is launched: ' + describe(result));
                assert.equal(result.events.some(event => event.type === 'COMPLETION_GATE_FAILED'), false, describe(result));
                assert.equal(result.steps.some(step => step.gate === 'restart-coherent-cycle'), false, describe(result));
            }
        } finally { removeWalkDirectory(template); }
    });

test('a lost context without a copy after the review gate repeats only its review',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        let removed = false;
        const variant: WalkScenario = { ...baseline, id: 'context-copy-missing-after-review-gate', expectedReviews: {}, expectedModes: [],
            disturbanceReason: 'Exercise lost review context after the review gate passed.',
            prepare: async (repoRoot, steps) => {
                if (removed || steps.length !== 29) return;
                removed = true;
                const root = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
                const context = path.join(root, 'reviews', 'T-WALK-code-review-context.json');
                const sha = crypto.createHash('sha256').update(fs.readFileSync(context)).digest('hex');
                fs.unlinkSync(path.join(root, 'tmp', '.review-context-cache', 'T-WALK', sha));
            },
            injection: { seed: 0, baseline: baseline.id, step: 29, gate: 'doc-impact-gate', economy: CLEAN,
                disturbances: [{ kind: 'delete-artifact', artifact: {
                    path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-review-context.json', kind: 'context'
                } }] }
        };
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const result = (await walkTaskFamily(template, baseline, [variant])).find(entry => entry.scenarioId === variant.id);
            assert.ok(result);
            fs.writeFileSync(path.join(os.tmpdir(), 'terra-context-copy-after-gate-result.json'), JSON.stringify(result));
            assert.equal(result.outcome, 'done', describe(result));
            assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode),
                ['code:FULL', 'test:FULL', 'code:FULL'], describe(result));
            assert.ok(result.steps.some(step => step.gate === 'project-memory-impact' && step.exitCode === 0), describe(result));
            assert.equal(result.events.some(event => event.type === 'COMPLETION_GATE_FAILED'), false, describe(result));
            assert.equal(result.steps.some(step => step.gate === 'restart-coherent-cycle'), false, describe(result));
        } finally { removeWalkDirectory(template); }
    });

test('a finished test is recorded before recovering a lost code context without a copy',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        let removed = false;
        const variant: WalkScenario = { ...baseline, id: 'context-copy-no-code-copy-finished-test', expectedReviews: {}, expectedModes: [],
            disturbanceReason: 'Exercise a finished unrecorded test while code context is lost.',
            prepare: async (repoRoot, steps) => {
                if (removed || steps.length !== 26) return;
                removed = true;
                const root = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
                const context = path.join(root, 'reviews', 'T-WALK-code-review-context.json');
                const sha = crypto.createHash('sha256').update(fs.readFileSync(context)).digest('hex');
                fs.unlinkSync(path.join(root, 'tmp', '.review-context-cache', 'T-WALK', sha));
            },
            injection: { seed: 0, baseline: baseline.id, step: 26, gate: 'record-review-result', economy: CLEAN,
                disturbances: [{ kind: 'corrupt-artifact', artifact: {
                    path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-review-context.json', kind: 'context'
                } }] }
        };
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const result = (await walkTaskFamily(template, baseline, [variant])).find(entry => entry.scenarioId === variant.id);
            assert.ok(result);
            fs.writeFileSync(path.join(os.tmpdir(), 'terra-context-copy-finished-test-result.json'), JSON.stringify(result));
            assert.equal(result.outcome, 'done', describe(result));
            assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode),
                ['code:FULL', 'test:FULL', 'code:FULL'], describe(result));
            const testRecord = result.events.findIndex(event => event.type === 'REVIEW_RECORDED' && event.details.review_type === 'test');
            const restart = result.events.findIndex(event => event.type === 'REVIEW_CYCLE_RESTARTED');
            assert.ok(testRecord >= 0 && restart > testRecord, 'record the finished test before restarting code: ' + describe(result));
            assert.equal(result.events.some(event => event.type === 'COMPLETION_GATE_FAILED'), false, describe(result));
            assert.equal(result.steps.some(step => step.gate === 'restart-coherent-cycle'), false, describe(result));
        } finally { removeWalkDirectory(template); }
    });

test('an older authenticated history without context copies keeps the finished other review',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        let removed = false;
        let restoredTelemetry = false;
        const variant: WalkScenario = { ...baseline, id: 'legacy-context-copy-finished-test', expectedReviews: {}, expectedModes: [],
            disturbanceReason: 'Exercise a context loss from before context-copy telemetry existed.',
            prepare: async (repoRoot, steps) => {
                if (removed || steps.length !== 26) return;
                removed = true;
                const cache = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', '.review-context-cache', 'T-WALK');
                for (const file of fs.readdirSync(cache)) fs.unlinkSync(path.join(cache, file));
                restoreCurrentTelemetry();
            },
            injection: { seed: 0, baseline: baseline.id, step: 26, gate: 'record-review-result', economy: CLEAN,
                disturbances: [{ kind: 'delete-artifact', artifact: {
                    path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-review-context.json', kind: 'context'
                } }] }
        };
        // Emit the older event shape through the ordinary authenticated writer. Launch and receipt events
        // still carry their original context hashes, as they did before context copies were introduced.
        const append = taskEventIo.appendMandatoryTaskEventAsync;
        const route = lifecycleEvents.emitReviewerDelegationRoutedEventAsync;
        const appendMock = mock.method(taskEventIo, 'appendMandatoryTaskEventAsync', (...args: Parameters<typeof append>) => {
            if (args[2] === 'REVIEW_PHASE_STARTED' && args[5] && typeof args[5] === 'object' && !Array.isArray(args[5])) {
                const details = { ...args[5] as Record<string, unknown> };
                delete details.review_context_sha256;
                args[5] = details;
            }
            return append(...args);
        });
        const routeMock = mock.method(lifecycleEvents, 'emitReviewerDelegationRoutedEventAsync', (...args: Parameters<typeof route>) => {
            if (args[6]) args[6] = { ...args[6], reviewContextSha256: undefined };
            return route(...args);
        });
        const restoreCurrentTelemetry = (): void => {
            if (restoredTelemetry) return;
            routeMock.mock.restore();
            appendMock.mock.restore();
            restoredTelemetry = true;
        };
        let template: string | null = null;
        try {
            template = await createWalkTemplate(path.resolve('.'));
            const result = (await walkTaskFamily(template, baseline, [variant])).find(entry => entry.scenarioId === variant.id);
            assert.ok(result);
            fs.writeFileSync(path.join(os.tmpdir(), 'terra-context-copy-legacy-history-result.json'), JSON.stringify(result));
            const earlierEvents = ['code', 'test'].flatMap(lane => ['REVIEW_PHASE_STARTED', 'REVIEWER_DELEGATION_ROUTED']
                .map(type => result.events.find(event => event.type === type && event.details.review_type === lane)));
            assert.ok(earlierEvents.every(event => event && !('review_context_sha256' in event.details)), 'the history has the older event shape');
            const launch = result.events.find(event => event.type === 'REVIEWER_LAUNCH_PREPARED' && event.details.review_type === 'code');
            assert.match(String(launch?.details.review_context_sha256 || ''), /^[a-f0-9]{64}$/u);
            assert.equal(result.outcome, 'done', describe(result));
            assert.deepEqual(result.reviews.map(review => review.lane + ':' + review.mode),
                ['code:FULL', 'test:FULL', 'code:FULL'], describe(result));
            const testRecord = result.events.findIndex(event => event.type === 'REVIEW_RECORDED' && event.details.review_type === 'test');
            const restart = result.events.findIndex(event => event.type === 'REVIEW_CYCLE_RESTARTED');
            assert.ok(testRecord >= 0 && restart > testRecord, 'record the finished legacy test before restarting code: ' + describe(result));
            assert.equal(result.events.some(event => event.type === 'COMPLETION_GATE_FAILED'), false, describe(result));
            assert.equal(result.steps.some(step => step.gate === 'restart-coherent-cycle'), false, describe(result));
        } finally {
            restoreCurrentTelemetry();
            if (template) removeWalkDirectory(template);
        }
    });
