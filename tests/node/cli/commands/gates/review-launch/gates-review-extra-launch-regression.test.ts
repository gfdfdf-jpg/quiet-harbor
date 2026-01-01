import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareWalk, createWalkTemplate, walkTask, walkTaskFamily, type WalkScenario } from '../../../../synthetic/engine/navigator-walk';
import { WALK_SCENARIOS } from '../../../../synthetic/engine/walk-scenarios';
import { removeWalkDirectory } from '../../../../synthetic/engine/walk-checkpoint';
import { inspectTaskEventFile } from '../../../../../../src/gate-runtime/timeline/task-events-integrity';

test('real review gates keep the unaffected result and restore a corrupt output',
    { timeout: 7_200_000 }, async t => {
        const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
        assert.ok(baseline);
        const variants: WalkScenario[] = [
            { ...baseline, id: 'kept-test-after-lost-code-disposition', expectedReviews: {}, expectedModes: [],
                injection: { seed: 1785881697, baseline: baseline.id, step: 27, gate: 'required-reviews-check',
                    disturbances: [{ kind: 'delete-artifact', artifact: {
                        path: 'garda-agent-orchestrator/runtime/reviews/T-WALK-code-findings-disposition.json', kind: 'report'
                    } }] } },
            { ...baseline, id: 'corrupt-open-code-review-output', expectedReviews: {}, expectedModes: [],
                injection: { seed: 1785881697, baseline: baseline.id, step: 20, gate: 'record-review-result',
                    disturbances: [{ kind: 'corrupt-artifact', artifact: {
                        path: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/code/review-output-aaaaaaaaaaaaaaaa.md', kind: 'report'
                    } }] } },
            { ...baseline, id: 'deleted-open-code-review-output', expectedReviews: {}, expectedModes: [],
                injection: { seed: 1785881697, baseline: baseline.id, step: 20, gate: 'record-review-result',
                    disturbances: [{ kind: 'delete-artifact', artifact: {
                        path: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/code/review-output-aaaaaaaaaaaaaaaa.md', kind: 'report'
                    } }] } },
            { ...baseline, id: 'corrupt-test-output-and-test-edit', expectedReviews: {}, expectedModes: [],
                injection: { seed: 1785881697, baseline: baseline.id, step: 26, gate: 'record-review-result',
                    disturbances: [{ kind: 'corrupt-artifact', artifact: {
                        path: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/test/review-output-aaaaaaaaaaaaaaaa.md', kind: 'report'
                    } }, { kind: 'edit-test' }] } },
            { ...baseline, id: 'restored-test-output-retouched-after-test-edit', expectedReviews: {}, expectedModes: [],
                injection: { seed: 1785881697, baseline: baseline.id, step: 26, gate: 'record-review-result',
                    disturbances: [{ kind: 'corrupt-artifact', artifact: {
                        path: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/test/review-output-aaaaaaaaaaaaaaaa.md', kind: 'report'
                    } }, { kind: 'edit-test' }] },
                execute: async (root, step) => {
                    if (step.index === 27 && step.gate === 'record-review-result') {
                        const launch = JSON.parse(fs.readFileSync(path.join(root,
                            'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/test/reviewer-launch.json'), 'utf8')) as {
                                review_output_sha256: string; review_output_path: string;
                            };
                        const copy = path.join(root, 'garda-agent-orchestrator/runtime/tmp/.reviewer-output-cache/T-WALK', launch.review_output_sha256);
                        // Model a previous restoration followed by a retry: the file's new mtime is not its original authorship time.
                        fs.copyFileSync(copy, launch.review_output_path);
                        const retouched = new Date(Date.now() + 60_000);
                        fs.utimesSync(launch.review_output_path, retouched, retouched);
                    }
                    return false;
                } },
            ...(['missing', 'tampered'] as const).map(kind => ({
                ...baseline, id: `${kind}-test-output-copy`, expectedReviews: {}, expectedModes: [],
                injection: { seed: 1785881697, baseline: baseline.id, step: 26, gate: 'record-review-result',
                    disturbances: [{ kind: 'corrupt-artifact' as const, artifact: {
                        path: 'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/test/review-output-aaaaaaaaaaaaaaaa.md',
                        kind: 'report' as const
                    } }] },
                execute: async (root: string, step: { index: number; gate: string | null }) => {
                    if (step.index === 27 && step.gate === 'record-review-result') {
                        const launch = JSON.parse(fs.readFileSync(path.join(root,
                            'garda-agent-orchestrator/runtime/tmp/reviews/T-WALK/test/reviewer-launch.json'), 'utf8')) as { review_output_sha256: string };
                        assert.match(launch.review_output_sha256, /^[a-f0-9]{64}$/u);
                        const copy = path.join(root, 'garda-agent-orchestrator/runtime/tmp/.reviewer-output-cache/T-WALK', launch.review_output_sha256);
                        if (kind === 'missing') fs.unlinkSync(copy); else fs.writeFileSync(copy, 'tampered');
                    }
                    return false;
                }
            }))
        ];
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            for (const step of [...new Set(variants.map(variant => variant.injection!.step))]) {
                const group = variants.filter(variant => variant.injection!.step === step);
                const results = await walkTaskFamily(template, baseline, group);
                for (const variant of group) {
                    await t.test(variant.id, () => {
                        const result = results.find(entry => entry.scenarioId === variant.id);
                        assert.ok(result);
                        assert.equal(result.outcome, 'done', result.detail);
                        const kept = variant.id.startsWith('kept-');
                        const lostCopy = variant.id.endsWith('-test-output-copy');
                        const edited = variant.id === 'corrupt-test-output-and-test-edit'
                            || variant.id === 'restored-test-output-retouched-after-test-edit';
                        assert.deepEqual(result.reviewsByLane, kept ? { code: 2, test: 1 }
                            : lostCopy || edited ? { code: 1, test: 2 } : { code: 1, test: 1 });
                        if (!lostCopy && !edited && !variant.id.startsWith('deleted-')) {
                            assert.deepEqual(compareWalk(variant, result).map(finding => finding.id + ': ' + finding.summary), []);
                        }
                        if (kept) {
                            assert.ok(result.steps.some(step => step.gate === 'restart-review-cycle'
                                && step.command?.includes('--review-evidence-only')));
                            assert.equal(result.steps.filter(step => step.gate === 'completion-gate').length, 1);
                        } else if (lostCopy) {
                            assert.ok(result.events.some(event => event.type === 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED'));
                            const launches = result.events.filter(event => event.type === 'REVIEWER_DELEGATION_STARTED'
                                && event.details?.review_type === 'test');
                            assert.equal(launches.length, 2);
                            assert.notEqual(launches[0].details.reviewer_identity, launches[1].details.reviewer_identity);
                        } else {
                            assert.ok(!result.events.some(event => event.type === 'REVIEW_OUTPUT_CORRECTION_REQUIRED'));
                            assert.ok(!result.events.some(event => event.type === 'REVIEW_OUTPUT_CORRECTION_FULL_REVIEW_REQUIRED'));
                            if (edited) {
                                const testRecorded = result.events.findIndex(event => event.type === 'REVIEW_RECORDED'
                                    && event.details?.review_type === 'test');
                                const restart = result.events.findIndex(event => event.type === 'REVIEW_CYCLE_RESTARTED');
                                assert.ok(testRecorded >= 0 && restart > testRecorded, 'record the completed review before classifying the edit');
                            }
                        }
                    });
                }
            }
        } finally {
            removeWalkDirectory(template);
        }
    });

test('two successive lost dispositions preserve the later completed review', { timeout: 7_200_000 }, async () => {
    const baseline = WALK_SCENARIOS.find(entry => entry.id === 'clean-pass');
    assert.ok(baseline);
    let disturbance = 0;
    let tamperedHistoryRejected = false;
    const scenario: WalkScenario = { ...baseline, id: 'two-evidence-only-restarts', mode: 'strict_sequential', requiredLanes: ['security'],
        expectedReviews: { code: 2, security: 2, test: 1 }, expectedModes: [],
        disturbanceReason: 'Lose code and then security disposition after each retained test review is authenticated.',
        prepare: async (root, _steps, run) => {
            const timeline = path.join(root, 'garda-agent-orchestrator/runtime/task-events/T-WALK.jsonl');
            if (!fs.existsSync(timeline)) return;
            const originalTimeline = fs.readFileSync(timeline, 'utf8');
            const events = originalTimeline.trim().split('\n').map(line => JSON.parse(line) as {
                event_type: string; actor?: string; details?: { review_type?: string };
            });
            const last = (type: string, lane?: string) => {
                for (let index = events.length - 1; index >= 0; index -= 1) {
                    if (events[index].event_type === type && (!lane || events[index].details?.review_type === lane)) return index;
                }
                return -1;
            };
            const reviews = path.join(root, 'garda-agent-orchestrator/runtime/reviews');
            if (disturbance === 0 && ['code', 'security', 'test'].every(lane => last('REVIEW_RECORDED', lane) >= 0)) {
                fs.unlinkSync(path.join(reviews, 'T-WALK-code-findings-disposition.json'));
                disturbance = 1;
            } else if (disturbance === 1 && last('REVIEW_CYCLE_RESTARTED') >= 0
                && last('REVIEW_RECORDED', 'code') > last('REVIEW_CYCLE_RESTARTED')
                && last('REVIEW_CONTEXT_REUSE_ACCEPTED', 'test') > last('REVIEW_RECORDED', 'code')) {
                fs.unlinkSync(path.join(reviews, 'T-WALK-security-findings-disposition.json'));
                disturbance = 2;
            } else if (disturbance === 2 && !tamperedHistoryRejected
                && events.filter(entry => entry.event_type === 'REVIEW_CYCLE_RESTARTED').length === 2
                && last('REVIEW_RECORDED', 'security') > last('REVIEW_CYCLE_RESTARTED')
                && last('REVIEW_CONTEXT_REUSE_ACCEPTED', 'test') > last('REVIEW_RECORDED', 'security')) {
                // Keep the original event hash while modifying its actor: the real gate must refuse this chain.
                const restart = events.find(entry => entry.event_type === 'REVIEW_CYCLE_RESTARTED');
                assert.ok(restart);
                restart.actor = 'tampered';
                fs.writeFileSync(timeline, events.map(entry => JSON.stringify(entry)).join('\n') + '\n');
                try {
                    assert.equal(inspectTaskEventFile(timeline, 'T-WALK').status, 'FAILED');
                    await assert.rejects(run(['required-reviews-check', '--task-id', 'T-WALK',
                        '--preflight-path', 'garda-agent-orchestrator/runtime/reviews/T-WALK-preflight.json',
                        '--repo-root', root]), /started before upstream review|task timeline.*(?:integrity|mismatch)/iu);
                    tamperedHistoryRejected = true;
                } finally {
                    fs.writeFileSync(timeline, originalTimeline);
                }
            }
        } };
    const template = await createWalkTemplate(path.resolve('.'));
    try {
        const result = await walkTask(template, scenario);
        assert.equal(disturbance, 2);
        assert.equal(result.outcome, 'done', result.detail + '\n' + JSON.stringify(result.steps.slice(-8).map(step => ({
            index: step.index, gate: step.gate, exitCode: step.exitCode, reason: step.reason, output: step.output
        }))));
        assert.equal(tamperedHistoryRejected, true, JSON.stringify(result.events
            .filter(event => ['REVIEW_CYCLE_RESTARTED', 'REVIEW_RECORDED', 'REVIEW_CONTEXT_REUSE_ACCEPTED'].includes(event.type))
            .map(event => ({ type: event.type, lane: event.details?.review_type }))));
        assert.deepEqual(result.reviewsByLane, scenario.expectedReviews);
        assert.equal(result.steps.filter(step => step.gate === 'restart-review-cycle' && step.exitCode === 0).length, 2);
    } finally { removeWalkDirectory(template); }
});
