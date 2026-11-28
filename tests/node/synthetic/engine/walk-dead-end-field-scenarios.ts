import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WalkScenario, WalkStep } from './navigator-walk';
import { runOperatorApprovedCommand } from './walk-operator-approval';
import { OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION } from '../../../../src/core/optional-quality-checks';
import { writeProtectedControlPlaneManifest } from '../../../../src/gates/protected-control-plane/protected-control-plane';
import { runCompletionGate } from '../../../../src/gates/completion/completion';
import { joinOrchestratorPath } from '../../../../src/gates/shared/helpers';
import { emitMandatoryCompletionGateEventAsync } from '../../../../src/gate-runtime/timeline/lifecycle-event-emitters';

const WORKFLOW_CONFIGS = ['garda-agent-orchestrator/live/config/workflow-config.json', 'garda-agent-orchestrator/template/config/workflow-config.json'];
/** A manifest-covered installed rule file outside the workflow-config files and the loaded rule pack: the control-plane variant. */
const CONTROL_PLANE_FILES = ['garda-agent-orchestrator/live/docs/agent-rules/70-security.md'];

export const T437_STALE_BASELINE_FIELD_CASE_ID = 'field-t437-stale-quality-baseline-selection';
/** The live quality baseline of the T-437 deployment: older than the shipped one. */
const T437_LIVE_BASELINE = '2026-07-21.t969';

export const OP056_FIELD_CASE_IDS = ['field-onlinestore-op056-config-drift-resolved', 'field-onlinestore-op056-retry-while-drifted-resolved',
    'field-onlinestore-op056-control-plane-retry-while-drifted-resolved'] as const;

interface DriftVariant {
    files: readonly string[];
    /** The failed step names the drifted files. */
    output: RegExp;
    /** The rollback keeps the original modification times (Explorer copy, robocopy, `cp -p`). */
    keepTimes: boolean;
}

/** Runs the printed gate during a simulated Garda update of the protected files, then the operator's rollback. */
async function runDuringProtectedUpdate(root: string, step: WalkStep, attempts: number, variant: DriftVariant): Promise<void> {
    const originals = variant.files.map(file => {
        const absolute = path.join(root, file);
        const bytes = fs.readFileSync(absolute);
        const stat = fs.statSync(absolute);
        // The newer build rewrites the files; their content is irrelevant to the task.
        fs.writeFileSync(absolute, bytes.toString('utf8').trimEnd() + '\n\n');
        return { absolute, bytes, atime: stat.atime, mtime: stat.mtime };
    });
    // Each attempt fails while the files are still drifted; the agent may retry before anyone rolls back.
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await runOperatorApprovedCommand(step, []);
        } catch (error) {
            // A native gate may refuse by throwing; the walk records it as a failed step.
            step.exitCode = 1; step.threw = true;
            step.output = error instanceof Error ? error.message : String(error);
        }
        assert.notEqual(step.exitCode, 0, 'The drifted protected files must fail attempt ' + attempt + ': ' + step.output);
        assert.match(step.output, variant.output, step.output);
    }
    // The operator rolls the update back: the files regain the bytes the task-mode baseline and manifest pinned.
    for (const original of originals) {
        fs.writeFileSync(original.absolute, original.bytes);
        if (variant.keepTimes) fs.utimesSync(original.absolute, original.atime, original.mtime);
    }
}

/**
 * OP-056 (OnlineStore T-014-1-2, 2026-11-23), dead-end class (a): a Garda update changed both workflow-config files
 * under the active task, so the preflight classification failed with a protected workflow-config signal; the operator
 * rolled the update back. The latest PREFLIGHT_FAILED event must no longer pin the navigator to the self-guard
 * maintenance route (doctor only): next-step re-checks the cause against the current files and offers the failed
 * step again, and that retry progresses to DONE. The field's drift hit the classification inside a coherent restart; in the
 * walk the same drift fails task-mode re-entry first and leaves no PREFLIGHT_FAILED latch, so the first classification is used.
 * `retry-while-drifted`: the agent retried the classification before the rollback, so the failure repeats while the cause
 * is still present; the rollback is a new resolution and must be re-offered once (a retry failing after it must not be).
 * `control-plane-retry-while-drifted`: the same with a manifest-covered installed rule file instead of the workflow-config
 * files, rolled back with its original modification time kept: the resolution is seen by content, not by time.
 */
export function workflowConfigDriftResolvedScenario(id: typeof OP056_FIELD_CASE_IDS[number]): WalkScenario {
    const failingGate = 'classify-change';
    const attempts = id === OP056_FIELD_CASE_IDS[0] ? 1 : 2;
    const variant: DriftVariant = id === OP056_FIELD_CASE_IDS[2]
        ? { files: CONTROL_PLANE_FILES, output: /70-security\.md/u, keepTimes: true }
        : { files: WORKFLOW_CONFIGS, output: /workflow-config\.json/u, keepTimes: false };
    let drifted = false, retryOffered = false, failedIndex = -1;
    return {
        id,
        edits: [{ path: 'src/app.ts', append: '// Product change.\n' }, { path: 'tests/app.test.ts', append: '// Task regression.\n' }],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'], enforceReviewExpectations: true,
        expectedFailingGates: [failingGate],
        disturbanceReason: 'OP-056: a Garda update changes the pinned ' + (variant.files === WORKFLOW_CONFIGS ? 'workflow-config' : 'control-plane')
            + ' files during ' + failingGate + '; the operator rolls it back.',
        configure: () => { drifted = false; retryOffered = false; failedIndex = -1; },
        execute: async (root, step) => {
            if (drifted || step.gate !== failingGate) return false;
            drifted = true;
            failedIndex = step.index;
            await runDuringProtectedUpdate(root, step, attempts, variant);
            return true;
        },
        inspectNavigation: (result, steps) => {
            // The navigation right after the failed step, before anything else ran.
            if (!drifted || retryOffered || steps.at(-1)?.index !== failedIndex) return;
            retryOffered = true;
            const command = result.commands[0]?.command ?? '';
            assert.notEqual(result.next_gate, 'operator-maintenance', 'A resolved cause must not stay on maintenance: ' + result.reason);
            assert.ok(command.includes(' gate ' + failingGate + ' '), 'The resolved failure offers the failed step again: ' + command);
        },
        inspectResult: (_root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            assert.ok(retryOffered, 'The navigation after the rollback was observed');
            const retried = result.steps.find(step => step.index > failedIndex && step.gate === failingGate);
            assert.equal(retried?.exitCode, 0, 'The offered retry is accepted by its handler: ' + (retried?.output ?? ''));
            assert.ok(!result.steps.some(step => / doctor /u.test(step.command ?? '')), 'No maintenance-only route is taken');
            assert.equal(result.events.filter(event => event.type === 'PREFLIGHT_FAILED').length, attempts, 'Only the drifted attempts failed');
        }
    };
}

function liveQualityBaseline(root: string): string {
    const config = JSON.parse(fs.readFileSync(path.join(root, WORKFLOW_CONFIGS[0]), 'utf8')) as { optional_quality_checks: { baseline_version: string } };
    return config.optional_quality_checks.baseline_version;
}

/**
 * T-437 (real 2.0 deployment, 2026-11-24), dead-end class (b): the installed live workflow config still carries an older
 * quality baseline than the shipped one. Next-step offers its own `workflow set --task-test-command ...` selection; the
 * selector counted the automatic baseline stamp as a second requested setting and refused it, so the only way on was a
 * Garda update. The offered selection must be accepted by its handler while the live baseline stays untouched (the selection
 * writes only its own audit), and the task must reach DONE with its ordinary review contract.
 */
export function staleQualityBaselineSelectionScenario(): WalkScenario {
    let offered = false, repoRoot = '';
    assert.notEqual(T437_LIVE_BASELINE, OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION, 'The field baseline must be older than the shipped one');
    return {
        id: T437_STALE_BASELINE_FIELD_CASE_ID,
        edits: [{ path: 'src/app.ts', append: '// Product change.\n' }, { path: 'tests/app.test.ts', append: '// Task regression.\n' }],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'], enforceReviewExpectations: true,
        expectedGates: ['task-test-selection'],
        disturbanceReason: 'T-437: the installed live workflow config keeps an older quality baseline than the shipped one while next-step offers the task-test selection.',
        // After agent-init (which stamps the shipped baseline): the older installation's live config and the
        // protected manifest that installation trusted, before task entry.
        setup: root => {
            offered = false; repoRoot = root;
            const file = path.join(root, WORKFLOW_CONFIGS[0]);
            const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { optional_quality_checks: { baseline_version: string } };
            config.optional_quality_checks.baseline_version = T437_LIVE_BASELINE;
            fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
            writeProtectedControlPlaneManifest(root);
        },
        inspectNavigation: result => {
            if (offered || result.next_gate !== 'task-test-selection') return;
            offered = true;
            assert.equal(liveQualityBaseline(repoRoot), T437_LIVE_BASELINE, 'The selection is offered while the live baseline is older than shipped');
            assert.ok((result.commands[0]?.command ?? '').includes(' workflow set --task-test-command '), result.commands[0]?.command);
        },
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            assert.ok(offered, 'Next-step offered the task-test selection under the older live baseline');
            const selections = result.steps.filter(step => step.gate === 'task-test-selection');
            assert.ok(selections.length > 0 && selections.every(step => step.exitCode === 0),
                'The offered selection is accepted by its handler: ' + selections.map(step => step.output).join('\n'));
            assert.equal(liveQualityBaseline(root), T437_LIVE_BASELINE, 'The selection never rewrites the live config or its baseline');
        }
    };
}

export const T437_DOC_IMPACT_FLAG_MISMATCH_FIELD_CASE_ID = 'field-t437-doc-impact-flag-mismatch';
export const T437_UNCHANGED_RECLASSIFICATION_FIELD_CASE_ID = 'field-t437-unchanged-reclassification-keeps-reviews';
const PROJECT_MEMORY_FLAGS = ['--project-memory-updated true', '--project-memory-update-not-needed true'] as const;
const SCOPE_FIELDS = ['mode', 'changed_files_count', 'changed_lines_total', 'scope_sha256', 'scope_content_sha256', 'task_criteria_sha256', 'required_reviews'] as const;

/** The agent reruns its own earlier classification command on the unchanged tree. */
async function reclassifyUnchangedScope(steps: readonly WalkStep[], step: WalkStep): Promise<void> {
    const classify = [...steps].reverse().find(entry => entry.gate === 'classify-change' && entry.exitCode === 0);
    assert.ok(classify?.command, 'The task classified its scope before the reviews');
    const refresh: WalkStep = { ...step, command: classify.command, output: '' };
    await runOperatorApprovedCommand(refresh, []);
    assert.equal(refresh.exitCode, 0, 'The agent reclassifies the unchanged tree: ' + refresh.output);
    step.output = [step.output, refresh.output].filter(Boolean).join('\n');
}

/**
 * T-437 (real 2.0 deployment, 2026-11-24), dead-end class (c): all reviews passed, project-memory-impact recorded its
 * status, and the agent ran doc-impact-gate with the other project-memory flag than the one next-step offered. Completion
 * rejected the mismatch; next-step then asked for a preflight refresh, the agent reclassified the unchanged tree, and the
 * navigator offered an operator-confirmed restart with every review again. The walk agent repeats both mistakes (it runs
 * completion itself, as that release offered, so COMPLETION_GATE_FAILED is recorded as in the field). The correction must be the agent's own: the reclassification of the
 * unchanged tree opens no new cycle, next-step routes back to doc-impact-gate with the offered flag (the wrong record stays
 * in the timeline), no lane is reviewed again and the task reaches DONE.
 * `unchanged-reclassification-keeps-reviews` is the general rule without the doc-impact mistake: an agent that
 * reclassifies the unchanged tree after the review gate keeps every passed review and needs no restart.
 */
export function closeoutEvidenceMistakeScenario(id: typeof T437_DOC_IMPACT_FLAG_MISMATCH_FIELD_CASE_ID
    | typeof T437_UNCHANGED_RECLASSIFICATION_FIELD_CASE_ID): WalkScenario {
    const flagMistake = id === T437_DOC_IMPACT_FLAG_MISMATCH_FIELD_CASE_ID;
    let mistaken = false, reclassified = false, offeredFlag = '';
    let seenSteps: readonly WalkStep[] = [];
    return {
        id,
        edits: [{ path: 'src/app.ts', append: '// Product change.\n' }, { path: 'tests/app.test.ts', append: '// Task regression.\n' }],
        expectedReviews: { code: 1, test: 1 }, expectedModes: ['code:FULL', 'test:FULL'], enforceReviewExpectations: true,
        expectedFailingGates: [],
        disturbanceReason: flagMistake
            ? 'T-437: the agent passes the other project-memory flag to doc-impact-gate, then reclassifies the unchanged tree after the completion failure.'
            : 'T-437: general rule, the agent reclassifies the unchanged tree after the review gate passed.',
        configure: () => { mistaken = false; reclassified = false; offeredFlag = ''; seenSteps = []; },
        execute: async (root, step) => {
            if (flagMistake && !mistaken && step.gate === 'doc-impact-gate') {
                offeredFlag = PROJECT_MEMORY_FLAGS.find(flag => (step.command ?? '').includes(flag)) ?? '';
                assert.ok(offeredFlag, 'next-step offers a project-memory flag for the internal behavior change: ' + step.command);
                mistaken = true;
                await runOperatorApprovedCommand(step, [[offeredFlag, PROJECT_MEMORY_FLAGS.find(flag => flag !== offeredFlag) ?? '']]);
                assert.equal(step.exitCode, 0, 'doc-impact-gate records the wrong flag: ' + step.output);
                // As in T-437, the agent goes straight on to completion, which rejects the contradicting claim and records
                // COMPLETION_GATE_FAILED. The release T-437 ran on routed this state to completion-gate; the current CLI
                // refuses that out-of-order call without a record, so the walk runs the gate's own verdict and records its
                // failure through the same lifecycle emitter the completion-gate handler uses.
                const taskId = /--task-id "([^"]+)"/u.exec(step.command ?? '')?.[1];
                const preflightPath = /--preflight-path "([^"]+)"/u.exec(step.command ?? '')?.[1];
                assert.ok(taskId && preflightPath, step.command ?? 'no doc-impact command');
                const verdict = runCompletionGate({ repoRoot: root, preflightPath: path.resolve(root, preflightPath), taskId });
                const violations = (verdict.violations ?? []).map(String);
                assert.notEqual(verdict.outcome, 'PASS', 'Completion rejects the contradicting project-memory claim');
                assert.ok(violations.some(violation => /project_memory_update(_not_needed|d)=true/u.test(violation)),
                    'Completion names the project-memory claim: ' + violations.join(' | '));
                await emitMandatoryCompletionGateEventAsync(joinOrchestratorPath(root, ''), taskId, false, {
                    status: verdict.status, outcome: verdict.outcome, preflight_path: verdict.preflight_path,
                    timeline_path: verdict.timeline_path, violations
                });
                step.output = [step.output, 'COMPLETION_GATE_FAILED', ...violations].join('\n');
                // ...and then reclassifies the unchanged tree, as the navigator of that release asked.
                reclassified = true;
                await reclassifyUnchangedScope(seenSteps, step);
                return true;
            }
            if (!flagMistake && !reclassified && step.gate === 'doc-impact-gate') {
                // Instead of the offered closeout step, the agent reclassifies the unchanged tree.
                reclassified = true;
                step.output = '';
                await reclassifyUnchangedScope(seenSteps, step);
                step.exitCode = 0;
                return true;
            }
            return false;
        },
        inspectNavigation: (result, steps) => {
            seenSteps = steps;
            assert.notEqual(result.next_gate, 'restart-coherent-cycle', 'An unchanged tree needs no restart: ' + result.reason);
            const command = result.commands.map(entry => entry.command).join('\n');
            assert.doesNotMatch(command, /--operator-confirmed/u, 'An agent mistake needs no operator confirmation: ' + command);
            if (flagMistake && reclassified && result.next_gate === 'doc-impact-gate') {
                assert.ok(command.includes(offeredFlag), 'The corrected doc-impact rerun carries the offered flag: ' + command);
            }
        },
        inspectResult: (_root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            assert.ok(reclassified, 'The unchanged tree was reclassified during the walk');
            assert.ok(!result.steps.some(step => step.gate === 'restart-coherent-cycle' || step.gate === 'restart-review-cycle'),
                'No cycle or review restart is taken');
            const docImpacts = result.events.filter(event => event.type === 'DOC_IMPACT_ASSESSED').length;
            const failures = result.events.flatMap((event, index) => event.type === 'COMPLETION_GATE_FAILED' ? [index] : []);
            assert.equal(failures.length, flagMistake ? 1 : 0, 'The field sequence records exactly its one completion failure');
            if (flagMistake) {
                // The field sequence: the completion failure, then the identical classification of the unchanged tree.
                const classificationOf = (index: number) => SCOPE_FIELDS.map(field => JSON.stringify(result.events[index]?.details?.[field]));
                const before = result.events.map((event, index) => ({ event, index }))
                    .filter(entry => entry.event.type === 'PREFLIGHT_CLASSIFIED' && entry.index < failures[0]).at(-1);
                const after = result.events.findIndex((event, index) => index > failures[0] && event.type === 'PREFLIGHT_CLASSIFIED');
                assert.ok(before && after > failures[0], 'A classification follows the completion failure');
                assert.deepEqual(classificationOf(after), classificationOf(before.index), 'The reclassification is identical');
            }
            assert.ok(docImpacts >= (flagMistake ? 2 : 1), 'The wrong doc-impact record stays and the corrected one follows it');
        }
    };
}
