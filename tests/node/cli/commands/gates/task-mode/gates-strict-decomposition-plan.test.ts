import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { splitCommandLine } from '../../../../../../src/core/command-line';
import { handleRecordStrictDecompositionDecision } from '../../../../../../src/cli/commands/gate-task-handlers';
import { runRecordStrictDecompositionDecisionCommand } from '../../../../../../src/cli/commands/gates';
import { getStrictDecompositionDecisionEvidence } from '../../../../../../src/gates/task-mode/strict-decomposition-decision';

const TASK_ID = 'T-212';
const DISPOSITIONS = ['T-212-2: stays its own row; this parent reconciles it afterwards.',
    'T-212-3: stays its own row and runs only if T-212-2 needs it.'];
const FIELD_REASON = 'One root cause; the owner and its destructive consumers form one authority contract; about six files including tests, one review cycle.';

const tempRoots: string[] = [];
afterEach(() => {
    for (const repoRoot of tempRoots.splice(0)) fs.rmSync(repoRoot, { recursive: true, force: true });
});

function withFieldRepo<T>(run: (repoRoot: string) => T, notes = 'Card: docs/cards/T-212-proposal.md (approved; run its sub-cards in order, one task each).'): T {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-decomposition-plan-cli-'));
    tempRoots.push(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${TASK_ID} | IN_PROGRESS | P1 | lifecycle-state | Distinguish unknown lifecycle state from missing state | agent | 2026-11-25 | balanced | ${notes} |`, ''
    ].join('\n'), 'utf8');
    const card = path.join(repoRoot, 'docs', 'cards', 'T-212-proposal.md');
    fs.mkdirSync(path.dirname(card), { recursive: true });
    fs.writeFileSync(card, '## Scope and sub-cards\n1. **T-212-2:** discovery owner; maximum six files.\n2. **T-212-3:** destructive consumers; maximum six files.\n', 'utf8');
    return run(repoRoot);
}

function fieldDecision(repoRoot: string, extra: Partial<Parameters<typeof runRecordStrictDecompositionDecisionCommand>[0]> = {}) {
    return runRecordStrictDecompositionDecisionCommand({
        repoRoot, taskId: TASK_ID, decision: 'single-cycle', taskProfile: 'balanced',
        taskSummary: 'Distinguish unknown lifecycle state from missing state', reason: FIELD_REASON,
        scopeRisk: 'Guarded decomposition prompt required by next-step risk signals: task_text:broad-domains.',
        expectedReviewTypes: ['code', 'security', 'test'],
        atomicityConstraints: ['Discovery status and its destructive consumers must change in the same cycle.'],
        ...extra
    });
}

describe('cli/gates record-strict-decomposition-decision against the task plan (field T-212)', () => {
    it('refuses the field single-cycle decision that ignores the planned sub-cards and routes to the split', () => {
        withFieldRepo((repoRoot) => {
            assert.throws(() => fieldDecision(repoRoot), (error: Error) => {
                assert.match(error.message, /one --plan-disposition per planned task/u);
                assert.match(error.message, /cap this work at 6 files/u);
                assert.match(error.message, /Split the work instead: .*record-strict-decomposition-decision .*--decision 'split-required'/u);
                assert.match(error.message, /--proposed-child-task-id 'T-212-2' --proposed-child-task-id 'T-212-3'/u);
                return true;
            });
            assert.equal(fs.existsSync(path.join(repoRoot, 'runtime', 'reviews', `${TASK_ID}-strict-decomposition-decision.json`)), false);
        });
    });

    it('refuses an estimate above the planned cap', () => {
        withFieldRepo((repoRoot) => {
            assert.throws(() => fieldDecision(repoRoot, {
                estimatedChangedFiles: '9',
                planDispositions: DISPOSITIONS
            }), /exceeds the planned cap of 6 files; split the work, or for indivisible work pass --plan-cap-revision/u);
        });
    });

    it('records the split offered for a balanced hard-cap refusal with a one-child plan and two packages', async () => {
        await withFieldRepo(async (repoRoot) => {
            const childIds = [`${TASK_ID}-2`, `${TASK_ID}-3`];
            fs.writeFileSync(path.join(repoRoot, 'contract.json'), JSON.stringify({
                schema_version: 2,
                finding_obligations: [],
                work_packages: childIds.map((taskId) => ({
                    task_id: taskId, profile: 'balanced', root_cause_area: `root-${taskId}`,
                    objective: `Resolve the root cause of ${taskId}.`, scope_obligations: [`Bound ${taskId} scope.`],
                    validation_contract: [`Verify ${taskId} independently.`], finding_obligation_ids: [],
                    required_review_types: ['code', 'security', 'test']
                }))
            }));
            let recovery = '';
            assert.throws(() => fieldDecision(repoRoot, {
                taskProfile: 'strict', estimatedChangedFiles: '3', planDispositions: [DISPOSITIONS[0]]
            }), (error: Error) => {
                assert.match(error.message, /exceeds the hard cap of 2 files/u);
                recovery = error.message.split('Split the work instead: ')[1];
                return true;
            });
            const args = splitCommandLine(recovery);
            const gateArgs = args.slice(args.indexOf('record-strict-decomposition-decision') + 1);
            gateArgs[gateArgs.indexOf('--repo-root') + 1] = repoRoot;
            gateArgs[gateArgs.indexOf('--reason') + 1] = 'The two root causes can ship independently.';
            gateArgs[gateArgs.indexOf('--atomicity-constraint') + 1] = 'Keep the tests with their respective packages.';
            gateArgs[gateArgs.indexOf('--work-package-contract-path') + 1] = 'contract.json';
            await handleRecordStrictDecompositionDecision(gateArgs);
            const evidence = getStrictDecompositionDecisionEvidence(repoRoot, TASK_ID);
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.task_profile, 'balanced');
            assert.deepEqual(evidence.proposed_child_task_ids, childIds);
        }, 'Planned sub-card: T-212-2. Scope: hard cap, at most two files.');
    });

    it('records the structured estimate, the plan and the recheck baseline when the decision addresses the plan', () => {
        withFieldRepo((repoRoot) => {
            const result = fieldDecision(repoRoot, {
                estimatedChangedFiles: '6',
                planDispositions: DISPOSITIONS
            });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('EstimatedChangedFiles: 6'), result.outputLines.join('\n'));
            const artifactPath = path.join(repoRoot, 'runtime', 'reviews', `${TASK_ID}-strict-decomposition-decision.json`);
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(artifact.estimated_changed_files, 6);
            assert.deepEqual((artifact.task_plan as { file_cap: number }).file_cap, 6);
            assert.deepEqual(artifact.recheck_baseline, { preflight_changed_files_count: null, failed_non_test_review_count: 0,
                preflight_path: 'runtime/reviews/T-212-preflight.json', events_root: 'runtime/task-events', workspace_changed_files_count: null });
            assert.deepEqual((artifact.plan_dispositions as Array<{ task_id: string }>).map((entry) => entry.task_id), ['T-212-2', 'T-212-3']);
            const evidence = getStrictDecompositionDecisionEvidence(repoRoot, TASK_ID);
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.estimated_changed_files, 6);
            assert.equal(evidence.plan_file_cap, 6);
            // A hand edit that raises the estimate past the recorded cap no longer authenticates.
            fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, estimated_changed_files: 9 }));
            assert.match(getStrictDecompositionDecisionEvidence(repoRoot, TASK_ID).evidence_status, /exceeds the planned cap/u);
        });
    });

    it('reads the baseline from the preflight next-step navigates with', () => {
        withFieldRepo((repoRoot) => {
            // Field round 2: an alternate preflight with nine files must not pass an estimate the default path would allow.
            const alternate = path.join(repoRoot, 'alt', 'T-212-preflight.json');
            fs.mkdirSync(path.dirname(alternate), { recursive: true });
            fs.writeFileSync(alternate, JSON.stringify({ task_id: TASK_ID, changed_files: Array.from({ length: 9 }, (_v, i) => `src/f${i}.ts`) }));
            assert.throws(() => fieldDecision(repoRoot, { estimatedChangedFiles: '6', planDispositions: DISPOSITIONS,
                preflightPath: 'alt/T-212-preflight.json' }), /below the 9 files the current preflight already changes/u);
            assert.throws(() => fieldDecision(repoRoot, { estimatedChangedFiles: '6', planDispositions: DISPOSITIONS,
                preflightPath: '../outside-preflight.json' }), /inside repo root/u);
        }, 'Distinguish unknown state; one task, no plan here.');
    });

    it('treats an unreadable preflight as missing, the same way next-step does', () => {
        withFieldRepo((repoRoot) => {
            // Field round 3: a truncated alternate preflight made the command next-step offered throw, every time.
            const alternate = path.join(repoRoot, 'alt', 'T-212-preflight.json');
            fs.mkdirSync(path.dirname(alternate), { recursive: true });
            fs.writeFileSync(alternate, '{"task_id": "T-212", "changed_files": ["src/a.ts"');
            const result = fieldDecision(repoRoot, { estimatedChangedFiles: '2', preflightPath: 'alt/T-212-preflight.json' });
            assert.equal(result.exitCode, 0);
            const artifact = JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtime', 'reviews', `${TASK_ID}-strict-decomposition-decision.json`), 'utf8'));
            assert.equal(artifact.recheck_baseline.preflight_changed_files_count, null);
            assert.equal(artifact.recheck_baseline.preflight_path, 'alt/T-212-preflight.json');
        }, 'Distinguish unknown state; one task, no plan here.');
    });

    it('prints and records the justification of an estimate over a soft cap', () => {
        withFieldRepo((repoRoot) => {
            const justification = 'The owner and its two consumers share one status contract, so the seven files cannot land apart.';
            const result = fieldDecision(repoRoot, { estimatedChangedFiles: '7', planDispositions: DISPOSITIONS, planCapRevision: justification });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes(`PlanCapRevision: estimate 7 over the cap of 6 files: ${justification}`), result.outputLines.join('\n'));
            const events = fs.readFileSync(path.join(repoRoot, 'runtime', 'task-events', `${TASK_ID}.jsonl`), 'utf8');
            assert.ok(events.includes(justification), 'The task event carries the justification');
        });
    });

    it('keeps rows without a plan unchanged and still allows the split', () => {
        withFieldRepo((repoRoot) => {
            assert.equal(fieldDecision(repoRoot).exitCode, 0);
        }, 'Distinguish unknown state; no plan here.');
    });
});
