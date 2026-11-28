import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    detectStrictDecompositionTaskPlan,
    readContainedBoundedText,
    readStrictDecompositionTaskPlan
} from '../../../../src/gates/task-mode/strict-decomposition-plan';
import {
    assessStrictDecompositionPlanConformance,
    normalizeStrictDecompositionPlanDispositions,
    resolveEffectiveStrictDecompositionFileCap,
    type StrictDecompositionPlanConformanceInput
} from '../../../../src/gates/task-mode/strict-decomposition-plan-conformance';
import {
    assessStrictDecompositionRecheck,
    resolveStrictDecompositionFailedReviewCheckpoint
} from '../../../../src/gates/task-mode/strict-decomposition-recheck';

/** The field T-212 row: its notes plan sub-cards and point at an approved card with a six-file cap per sub-card. */
const FIELD_PARENT_NOTES = 'Card: docs_local/task-cards/proposals/T-212-proposal.md (approved 2026-10-20; run its sub-cards in order, '
    + 'one task each; save an approved task plan before start). Card: docs_local/task-cards/T-212.md (DRAFT). Read T-212-1 history.';
const FIELD_CARD = [
    '# T-212 - Explicit unknown runtime discovery', '',
    '## Scope and sub-cards',
    '1. **T-212-2:** active-task discovery owner, facade types and owning tests; maximum six files.',
    '2. **T-212-3, only if needed:** exact destructive consumers and their tests; maximum six files.', ''
].join('\n');
const FIELD_DISPOSITIONS = [
    'T-212-1: accepted earlier; this row only reads its history.',
    'T-212-2: stays its own row; this parent reconciles it afterwards.',
    'T-212-3: stays its own row and runs only if T-212-2 needs it.'
];

function withCardRepo(run: (repoRoot: string) => void): void {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-decomposition-plan-'));
    try {
        const card = path.join(repoRoot, 'docs_local', 'task-cards', 'proposals', 'T-212-proposal.md');
        fs.mkdirSync(path.dirname(card), { recursive: true });
        fs.writeFileSync(card, FIELD_CARD, 'utf8');
        run(repoRoot);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

function conformance(input: Partial<StrictDecompositionPlanConformanceInput> & Pick<StrictDecompositionPlanConformanceInput, 'plan'>): string {
    return assessStrictDecompositionPlanConformance({
        decision: 'single-cycle', taskId: 'T-212', estimatedChangedFiles: null, planDispositions: [], planCapRevision: null,
        recheckBaseline: null, ...input
    }).join(' ');
}

describe('gates/task-mode strict decomposition task plan', () => {
    it('reads the sub-card plan and the file cap from the notes and the referenced card', () => {
        withCardRepo((repoRoot) => {
            const plan = detectStrictDecompositionTaskPlan(repoRoot, 'T-212', FIELD_PARENT_NOTES);
            assert.equal(plan.sub_card_plan, true);
            assert.equal(plan.file_cap, 6);
            assert.equal(plan.file_cap_hard, false);
            assert.deepEqual(plan.planned_child_task_ids, ['T-212-1', 'T-212-2', 'T-212-3']);
            assert.equal(plan.task_is_planned_sub_card, false);
            assert.deepEqual(plan.sources.map((source) => [source.path, source.status]), [
                ['TASK.md', 'read'],
                ['docs_local/task-cards/proposals/T-212-proposal.md', 'read'],
                ['docs_local/task-cards/T-212.md', 'missing']
            ]);
        });
    });

    it('treats a row that the card names as one of its sub-cards as that sub-card', () => {
        withCardRepo((repoRoot) => {
            const plan = detectStrictDecompositionTaskPlan(repoRoot, 'T-212-2', FIELD_PARENT_NOTES);
            assert.equal(plan.task_is_planned_sub_card, true);
            assert.deepEqual(plan.planned_child_task_ids, []);
            assert.equal(conformance({ taskId: 'T-212-2', plan, estimatedChangedFiles: 5 }), '');
        });
    });

    it('reads a file cap written in the notes themselves and ignores unsafe card paths', () => {
        withCardRepo((repoRoot) => {
            const plan = detectStrictDecompositionTaskPlan(repoRoot, 'T-212-3',
                'Parent: T-212 (child 1 of 2). Scope, at most six files: a.ts, b.ts. Card: ../outside.md');
            assert.equal(plan.file_cap, 6);
            assert.equal(plan.sub_card_plan, false);
            assert.deepEqual(plan.sources.map((source) => source.status), ['read', 'unreadable']);
        });
    });

    it('takes a file count as a cap only from an explicit task-scope statement', () => {
        withCardRepo((repoRoot) => {
            for (const notes of ['The fixture emits at most two files per module.', 'The generator writes up to three files.',
                'Logs keep a maximum of five files.']) {
                assert.equal(detectStrictDecompositionTaskPlan(repoRoot, 'T-9', notes).file_cap, null, notes);
            }
            for (const [notes, cap] of [['Scope: at most two files.', 2], ['This task changes at most four files.', 4],
                ['Keep a three-file cap.', 3], ['Touch no more than five files in total.', 5]] as const) {
                assert.equal(detectStrictDecompositionTaskPlan(repoRoot, 'T-9', notes).file_cap, cap, notes);
            }
            const hard = detectStrictDecompositionTaskPlan(repoRoot, 'T-9', 'Scope: hard cap, at most two files.');
            assert.equal(hard.file_cap_hard, true);
        });
    });

    it('accepts a justified estimate over a soft cap and refuses it over a hard cap', () => {
        withCardRepo((repoRoot) => {
            const soft = detectStrictDecompositionTaskPlan(repoRoot, 'T-9', 'Scope: at most two files.');
            const revision = 'The writer and its only reader share one format version, so the three files cannot land apart.';
            assert.match(conformance({ taskId: 'T-9', plan: soft, estimatedChangedFiles: 3 }), /pass --plan-cap-revision/u);
            assert.equal(conformance({ taskId: 'T-9', plan: soft, estimatedChangedFiles: 3, planCapRevision: revision }), '');
            assert.match(conformance({ taskId: 'T-9', plan: soft, estimatedChangedFiles: 2, planCapRevision: revision }),
                /only for an estimate over the planned file cap/u);
            const hard = detectStrictDecompositionTaskPlan(repoRoot, 'T-9', 'Scope: hard cap, at most two files.');
            assert.match(conformance({ taskId: 'T-9', plan: hard, estimatedChangedFiles: 3, planCapRevision: revision }),
                /exceeds the hard cap of 2 files/u);
        });
    });

    it('takes a change-verb count as a cap only when the task is its subject', () => {
        withCardRepo((repoRoot) => {
            for (const notes of ['The fixture changes at most two source files.', 'The generator touches up to three files.']) {
                assert.equal(detectStrictDecompositionTaskPlan(repoRoot, 'T-9', notes).file_cap, null, notes);
            }
            for (const [notes, cap] of [['This task changes at most four files.', 4], ['Touch no more than five files in total.', 5],
                ['Scope: change at most two files.', 2], ['It must touch at most three files.', 3]] as const) {
                assert.equal(detectStrictDecompositionTaskPlan(repoRoot, 'T-9', notes).file_cap, cap, notes);
            }
        });
    });

    it('keeps the hard cap when a revision lifts a smaller soft cap', () => {
        withCardRepo((repoRoot) => {
            const plan = detectStrictDecompositionTaskPlan(repoRoot, 'T-9',
                'Scope: at most two files. Scope: no more than four files; this is a hard cap.');
            assert.equal(plan.file_cap, 2);
            assert.equal(plan.hard_file_cap, 4);
            const revision = 'The writer and its only reader share one format version, so the files cannot land apart.';
            assert.equal(conformance({ taskId: 'T-9', plan, estimatedChangedFiles: 3, planCapRevision: revision }), '');
            assert.match(conformance({ taskId: 'T-9', plan, estimatedChangedFiles: 5, planCapRevision: revision }),
                /exceeds the hard cap of 4 files/u);
            assert.equal(resolveEffectiveStrictDecompositionFileCap(plan, revision), 4);
            assert.equal(resolveEffectiveStrictDecompositionFileCap(plan, null), 2);
        });
    });

    it('never opens a plan source that is not a regular file', (t) => {
        withCardRepo((repoRoot) => {
            fs.mkdirSync(path.join(repoRoot, 'docs', 'not-a-card.md'), { recursive: true });
            const opened = t.mock.method(require('node:fs') as typeof fs, 'openSync');
            assert.equal(readContainedBoundedText(repoRoot, 'docs/not-a-card.md', 1024).status, 'unreadable');
            assert.equal(opened.mock.callCount(), 0, 'A FIFO or device opened here would block the reader');
        });
    });

    it('needs the estimate for dirty work recorded before any preflight', () => {
        withCardRepo((repoRoot) => {
            const unplanned = detectStrictDecompositionTaskPlan(repoRoot, 'T-9', 'No plan here.');
            const dirty = { preflight_changed_files_count: null, failed_non_test_review_count: 0, workspace_changed_files_count: 3 };
            assert.match(conformance({ taskId: 'T-9', plan: unplanned, recheckBaseline: dirty }),
                /while the workspace already changes 3 files must pass --estimated-changed-files/u);
            assert.equal(conformance({ taskId: 'T-9', plan: unplanned, recheckBaseline: dirty, estimatedChangedFiles: 3 }), '');
            assert.equal(conformance({ taskId: 'T-9', plan: unplanned, recheckBaseline: { ...dirty, workspace_changed_files_count: 0 } }), '');
        });
    });

    it('needs exactly one disposition per planned sub-card task, by exact id', () => {
        withCardRepo((repoRoot) => {
            const plan = detectStrictDecompositionTaskPlan(repoRoot, 'T-212', FIELD_PARENT_NOTES);
            const dispositions = (entries: string[]) => normalizeStrictDecompositionPlanDispositions(entries);
            assert.match(conformance({ plan, estimatedChangedFiles: 6 }), /one --plan-disposition per planned task/u);
            // Substrings of other ids are not the planned ids.
            assert.match(conformance({ plan, estimatedChangedFiles: 6, planDispositions: dispositions([
                'T-212-10: a different row that only looks like the first sub-card.',
                'T-212-20: a different row that only looks like the second sub-card.',
                FIELD_DISPOSITIONS[2]]) }), /missing for T-212-1, T-212-2.*names tasks the plan does not list: T-212-10, T-212-20/u);
            assert.match(conformance({ plan, estimatedChangedFiles: 6, planDispositions: dispositions([...FIELD_DISPOSITIONS,
                'T-212-3: stated a second time for the same sub-card.']) }), /repeats T-212-3/u);
            assert.equal(conformance({ plan, estimatedChangedFiles: 6, planDispositions: dispositions(FIELD_DISPOSITIONS) }), '');
            assert.throws(() => dispositions(['T-212-2 and T-212-3 stay separate rows.']), /must have the form/u);
        });
    });

    it('needs the estimate whenever a plan or changed files exist', () => {
        withCardRepo((repoRoot) => {
            const plan = detectStrictDecompositionTaskPlan(repoRoot, 'T-212', FIELD_PARENT_NOTES);
            const planDispositions = normalizeStrictDecompositionPlanDispositions(FIELD_DISPOSITIONS);
            assert.match(conformance({ plan, planDispositions }), /for a planned task must pass --estimated-changed-files/u);
            const unplanned = detectStrictDecompositionTaskPlan(repoRoot, 'T-9', 'No plan here.');
            const changed = { preflight_changed_files_count: 4, failed_non_test_review_count: 0 };
            assert.match(conformance({ taskId: 'T-9', plan: unplanned, recheckBaseline: changed }),
                /already changes 4 files must pass --estimated-changed-files/u);
            assert.match(conformance({ taskId: 'T-9', plan: unplanned, recheckBaseline: changed, estimatedChangedFiles: 3 }), /below the 4 files/u);
            assert.equal(conformance({ taskId: 'T-9', plan: unplanned, recheckBaseline: { ...changed, preflight_changed_files_count: 0 } }), '');
            assert.equal(conformance({ plan, decision: 'split-required' }), '');
        });
    });

    it('reads TASK.md only inside the repository and within its size bound', (t) => {
        withCardRepo((repoRoot) => {
            const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-decomposition-outside-'));
            try {
                fs.writeFileSync(path.join(outside, 'TASK.md'), '| T-9 | TODO | P1 | a | b | c | d | strict | Scope: at most one file. |\n');
                try {
                    fs.symlinkSync(path.join(outside, 'TASK.md'), path.join(repoRoot, 'TASK.md'), 'file');
                } catch {
                    t.skip('File symlinks are not available on this host.');
                    return;
                }
                assert.throws(() => readStrictDecompositionTaskPlan(repoRoot, 'T-9'), /must be a regular file inside the repository/u);
                fs.rmSync(path.join(repoRoot, 'TASK.md'));
                fs.writeFileSync(path.join(repoRoot, 'TASK.md'), 'x'.repeat(4 * 1024 * 1024 + 1));
                assert.throws(() => readStrictDecompositionTaskPlan(repoRoot, 'T-9'), /at most 4194304 bytes/u);
            } finally {
                fs.rmSync(outside, { recursive: true, force: true });
            }
        });
    });
});

describe('gates/task-mode strict decomposition recheck', () => {
    const baseline = { preflight_changed_files_count: 2, failed_non_test_review_count: 0 };
    const noFailures = () => ({ failedNonTestReviewCount: 0, maxFailedNonTestReviews: 10 });

    it('routes back to a re-decision when the scope outgrows the estimate or the planned cap', () => {
        assert.equal(assessStrictDecompositionRecheck({ estimatedChangedFiles: 6, planFileCap: null, baseline,
            currentChangedFiles: 6, readFailedReviews: noFailures }), null);
        const estimate = assessStrictDecompositionRecheck({ estimatedChangedFiles: 6, planFileCap: null, baseline,
            currentChangedFiles: 9, readFailedReviews: noFailures });
        assert.equal(estimate?.kind, 'changed-files');
        assert.match(estimate?.detail ?? '', /changes 9 files, more than the recorded estimate of 6/u);
        const cap = assessStrictDecompositionRecheck({ estimatedChangedFiles: null, planFileCap: 6, baseline: null,
            currentChangedFiles: 7, readFailedReviews: () => null });
        assert.match(cap?.detail ?? '', /planned file cap of 6/u);
    });

    it('sets failed-review checkpoints well below the review-cycle guard', () => {
        assert.equal(resolveStrictDecompositionFailedReviewCheckpoint(0, 10), 3);
        assert.equal(resolveStrictDecompositionFailedReviewCheckpoint(3, 10), 6);
        assert.equal(resolveStrictDecompositionFailedReviewCheckpoint(9, 10), null);
        assert.equal(resolveStrictDecompositionFailedReviewCheckpoint(0, 2), null);
        const read = (failed: number) => () => ({ failedNonTestReviewCount: failed, maxFailedNonTestReviews: 10 });
        assert.equal(assessStrictDecompositionRecheck({ estimatedChangedFiles: 6, planFileCap: null, baseline,
            currentChangedFiles: 4, readFailedReviews: read(2) }), null);
        assert.equal(assessStrictDecompositionRecheck({ estimatedChangedFiles: 6, planFileCap: null, baseline,
            currentChangedFiles: 4, readFailedReviews: read(3) })?.kind, 'failed-reviews');
        // A legacy decision without a recorded baseline has no failure checkpoint of its own.
        assert.equal(assessStrictDecompositionRecheck({ estimatedChangedFiles: null, planFileCap: null, baseline: null,
            currentChangedFiles: 4, readFailedReviews: read(9) }), null);
    });

    it('re-decides a decision without an estimate once the preflight changes files', () => {
        const recorded = assessStrictDecompositionRecheck({ estimatedChangedFiles: null, planFileCap: null, baseline,
            currentChangedFiles: 2, readFailedReviews: noFailures });
        assert.equal(recorded?.kind, 'changed-files');
        assert.match(recorded?.detail ?? '', /recorded no changed-file estimate, and the current preflight changes 2 files/u);
        assert.equal(assessStrictDecompositionRecheck({ estimatedChangedFiles: null, planFileCap: null, baseline,
            currentChangedFiles: 0, readFailedReviews: noFailures }), null);
    });

    it('does not read the review history before a preflight exists', () => {
        // Without a preflight no review can bind it; next-step refreshes the preflight and checks on that navigation.
        assert.equal(assessStrictDecompositionRecheck({ estimatedChangedFiles: 6, planFileCap: null, baseline,
            currentChangedFiles: null, readFailedReviews: () => assert.fail('The review history was read before the preflight') }), null);
    });

    it('re-decides when navigation reads another preflight or events root than the recorded baseline', () => {
        const recorded = { ...baseline, preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-9-preflight.json',
            events_root: 'garda-agent-orchestrator/runtime/task-events' };
        const same = { preflightPath: recorded.preflight_path, eventsRoot: recorded.events_root };
        assert.equal(assessStrictDecompositionRecheck({ estimatedChangedFiles: 6, planFileCap: null, baseline: recorded,
            currentChangedFiles: 2, readFailedReviews: noFailures, navigationInputs: same }), null);
        const other = assessStrictDecompositionRecheck({ estimatedChangedFiles: 6, planFileCap: null, baseline: recorded,
            currentChangedFiles: 2, readFailedReviews: noFailures, navigationInputs: { ...same, eventsRoot: 'alt/task-events' } });
        assert.equal(other?.kind, 'inputs');
        assert.match(other?.detail ?? '', /events root garda-agent-orchestrator\/runtime\/task-events \(navigation reads alt\/task-events\)/u);
    });
});
