import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readReviewTaskCard } from '../../../../src/gates/review-context/review-context-task-card';
import { buildTaskCriteria, buildTaskCriteriaMarkdown } from '../../../../src/gates/review-context/review-context-task-criteria';
import { buildAuthoritativeReviewCoverageContract } from '../../../../src/gates/review-context/review-context-coverage';
import { getReviewCoverageContractViolations } from '../../../../src/gates/review/review-coverage-ledger';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-card-'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'TASK.md'), '| T-006-4-F1 | TODO | P1 | phase-04 | Grouped findings | agent | 2026-10-30 | fast | Operator scope: addresses and history |\n[T-006-4-F1](docs/tasks.md#t-006-4-f1)');
    fs.writeFileSync(path.join(root, 'docs/tasks.md'), '### T-006-4-F1 — Complete CRM\n\n**Deliverable:** Add addresses and history.\n#### Acceptance criteria\n- Persist postal addresses with organization isolation.\n- Persist ordered relationship history.\n### T-006-5 — Other task\n- Other task must not leak into this card.');
    return root;
}

describe('linked task acceptance material', () => {
    it('preserves full follow-up requirements without an attached plan and makes each criterion mandatory coverage', t => {
        const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const preflight = { task_id: 'T-006-4-F1', task_intent: 'Grouped findings', changed_files: ['tests/crm.test.ts'] };
        const criteria = buildTaskCriteria({ repoRoot: root, taskId: preflight.task_id, preflight, taskModeEvidence: null });
        assert.equal(criteria.plan.status, 'not_provided');
        assert.equal(criteria.task_card?.acceptance_criteria.length, 2);
        const markdown = buildTaskCriteriaMarkdown(criteria).join('\n');
        assert.match(markdown, /postal addresses/);
        assert.doesNotMatch(criteria.task_card!.section, /Other task/);
        const first = buildAuthoritativeReviewCoverageContract({ repoRoot: root, preflight, reviewType: 'code' });
        assert.equal(first.contract.obligations.filter(x => x.kind === 'criterion').length, 2);
        assert.deepEqual(getReviewCoverageContractViolations(first.contract, { reviewType: 'code', ...first }), []);
        fs.appendFileSync(path.join(root, 'docs/tasks.md'), '\n');
        fs.writeFileSync(path.join(root, 'docs/tasks.md'), fs.readFileSync(path.join(root, 'docs/tasks.md'), 'utf8').replace('Persist ordered', 'Preserve immutable ordered'));
        const changed = buildAuthoritativeReviewCoverageContract({ repoRoot: root, preflight, reviewType: 'code' });
        assert.notEqual(changed.contract.contract_sha256, first.contract.contract_sha256);
        assert.ok(getReviewCoverageContractViolations(first.contract, { reviewType: 'code', ...changed }).length);
    });
    it('rejects unsafe, missing and ambiguous links instead of silently dropping criteria', t => {
        const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        for (const link of ['../outside.md#t-006-4-f1', 'https://example.com/task.md#t-006-4-f1', 'docs/tasks.md#missing', 'docs/missing.md#t-006-4-f1']) {
            fs.writeFileSync(path.join(root, 'TASK.md'), '[T-006-4-F1](' + link + ')');
            assert.throws(() => readReviewTaskCard(root, 'T-006-4-F1'), Error, link);
        }
        fs.writeFileSync(path.join(root, 'TASK.md'), '[T-006-4-F1](docs/tasks.md#t-006-4-f1)\n[T-006-4-F1](other.md#t-006-4-f1)');
        assert.throws(() => readReviewTaskCard(root, 'T-006-4-F1'), /Ambiguous/);
        fs.writeFileSync(path.join(root, 'TASK.md'), 'No linked card');
        assert.equal(readReviewTaskCard(root, 'T-006-4-F1'), null);
    });

    it('shares one task-card lookup within navigation without exposing its cached result', t => {
        const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        let one!: NextStepMeasurement, two!: NextStepMeasurement;
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            assert.equal(readReviewTaskCard(root, 'T-006-4-F1')?.acceptance_criteria.length, 2);
        }), value => { one = value; });
        withNextStepMeasurement(() => withInvocationReadObservation(() => {
            const first = readReviewTaskCard(root, 'T-006-4-F1')!;
            first.acceptance_criteria.push('caller mutation');
            assert.equal(readReviewTaskCard(root, 'T-006-4-F1')?.acceptance_criteria.length, 2);
        }), value => { two = value; });
        assert.equal(two.io?.existsSync?.count, one.io?.existsSync?.count);
    });

    it('rejects a changed card or a newly created task queue before navigation returns', t => {
        const root = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        assert.throws(() => withInvocationReadObservation(() => {
            assert.ok(readReviewTaskCard(root, 'T-006-4-F1'));
            fs.appendFileSync(path.join(root, 'docs/tasks.md'), '\nChanged.');
            assert.ok(readReviewTaskCard(root, 'T-006-4-F1'));
        }), /changed|stale|identity|replaced/iu);
        fs.rmSync(path.join(root, 'TASK.md'));
        assert.throws(() => withInvocationReadObservation(() => {
            assert.equal(readReviewTaskCard(root, 'T-006-4-F1'), null);
            fs.writeFileSync(path.join(root, 'TASK.md'), 'new queue');
            assert.equal(readReviewTaskCard(root, 'T-006-4-F1'), null);
        }), /changed|stale|identity|replaced/iu);
    });
});
