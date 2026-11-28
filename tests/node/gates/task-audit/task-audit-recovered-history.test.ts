import { createWalkTemplate, walkTaskFamily, type WalkScenario } from '../../synthetic/engine/navigator-walk';
import '../../../../src/bin/garda/derivation-source-receipts';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { handleTaskAuditSummary } from '../../../../src/cli/commands/gate-task-handlers';
import { readTaskTimelineEvents } from '../../cli/commands/gates/review-cycle/gates-review-cycle-fixtures';
import { removeWalkDirectory } from '../../synthetic/engine/walk-checkpoint';
import { WALK_SCENARIOS } from '../../synthetic/engine/walk-scenarios';

test('recorded lost receipt and findings-validation snapshots recover, but later unrecorded damage blocks audit',
    { timeout: 1_800_000, concurrency: false }, async () => {
        const clean = WALK_SCENARIOS.find(scenario => scenario.id === 'clean-pass');
        assert.ok(clean);
        let checked = false;
        const scenario: WalkScenario = { ...clean, cleanup: async repoRoot => {
            const events = readTaskTimelineEvents(repoRoot, 'T-WALK');
            const restart = events.find(event => event.event_type === 'REVIEW_CYCLE_RESTARTED'
                && Array.isArray((event.details as Record<string, unknown>)?.lost_review_history_snapshots)
                && ((event.details as Record<string, unknown>).lost_review_history_snapshots as unknown[]).length > 0);
            if (!restart) return;
            const losses = (restart.details as { lost_review_history_snapshots: Array<{ missing_snapshots: Array<{ kind: string }> }> })
                .lost_review_history_snapshots;
            assert.ok(losses.some(loss => loss.missing_snapshots.some(snapshot => snapshot.kind === 'findings_validation')));
            const output = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'audit-recovered-test.json');
            const audit = async () => {
                const savedExit = process.exitCode;
                try {
                    process.exitCode = 0;
                    await handleTaskAuditSummary(['--repo-root', repoRoot, '--task-id', 'T-WALK', '--as-json', '--output-path', output]);
                    return { exit: Number(process.exitCode), summary: JSON.parse(fs.readFileSync(output, 'utf8')) as {
                        status: string; blockers: Array<{ gate: string }> } };
                } finally { process.exitCode = savedExit; }
            };
            const recovered = await audit();
            assert.equal(recovered.exit, 0, JSON.stringify(recovered.summary.blockers));
            assert.equal(recovered.summary.status, 'PASS');
            const recorded = events.find(event => event.event_type === 'REVIEW_RECORDED'
                && (event.details as Record<string, unknown>)?.review_type === 'test');
            const report = String((recorded?.details as Record<string, unknown>)?.review_artifact_snapshot_path || '');
            assert.ok(report && fs.existsSync(report));
            fs.appendFileSync(report, 'unrecorded change');
            const damaged = await audit();
            assert.notEqual(damaged.exit, 0);
            assert.equal(damaged.summary.status, 'BLOCKED');
            assert.ok(damaged.summary.blockers.some(blocker => blocker.gate === 'review-history-integrity'));
            checked = true;
        } };
        const variant: WalkScenario = { ...scenario, id: 'lost-test-history-receipt', expectedReviews: {}, expectedModes: [],
            injection: { seed: 1785881697, baseline: clean.id, step: 27, gate: 'required-reviews-check',
                disturbances: [{ kind: 'delete-artifact', artifact: { kind: 'receipt',
                    path: `garda-agent-orchestrator/runtime/reviews/T-WALK-test-receipt-${'0'.repeat(64)}.json` } }] } };
        const validationVariant: WalkScenario = { ...scenario, id: 'lost-test-history-findings-validation', expectedReviews: {}, expectedModes: [],
            injection: { seed: 1785881697, baseline: clean.id, step: 27, gate: 'required-reviews-check',
                disturbances: [{ kind: 'delete-artifact', artifact: { kind: 'report',
                    path: `garda-agent-orchestrator/runtime/reviews/T-WALK-test-findings-validation-${'0'.repeat(64)}.json` } }] } };
        const template = await createWalkTemplate(path.resolve('.'));
        try {
            const [control, recovered, validationRecovered] = await walkTaskFamily(template, scenario, [variant, validationVariant]);
            assert.equal(control.outcome, 'done', control.detail);
            assert.equal(recovered.outcome, 'done', recovered.detail);
            assert.equal(recovered.reviewsByLane.code, 1);
            assert.equal(recovered.reviewsByLane.test, 2);
            assert.equal(validationRecovered.outcome, 'done', validationRecovered.detail);
            assert.equal(validationRecovered.reviewsByLane.code, 1);
            assert.equal(validationRecovered.reviewsByLane.test, 2);
            assert.equal(checked, true, 'completion and explicit task-audit must both run');
        } finally { removeWalkDirectory(template); }
    });
