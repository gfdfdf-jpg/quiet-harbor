import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readTaskQueueEntries } from '../../../../src/core/task-queue-read';
import type { NextStepEffectController } from '../../../../src/gates/next-step/next-step-effects';
import {
    buildStrictDecompositionDecisionRequirement,
    hasAuthenticatedStrictSplitDecision,
    resolveStrictDecompositionContinuationRoute
} from '../../../../src/gates/next-step/next-step-strict-decomposition-routing';
import { resolveStrictDecompositionSplitRoutingState } from '../../../../src/gates/next-step/next-step-task-queue';
import { materializeDecompositionChildren } from '../../../../src/gates/task-mode/decomposition-children-materialization';
import { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';
import { resolveTaskQueueTransactionLockPath } from '../../../../src/core/task-queue/task-queue-repository';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { fileSha256 } from '../../../../src/gates/shared/helpers';
import { eventsRoot, makeTempRepo, reviewsRoot, writeJson } from '../next-step/next-step-completion-fixtures';
import { initGitRepo } from '../git-fixtures';

const PARENT = 'T-DEC-1';
const TITLE = 'Split the lifecycle discovery work';
const CHILDREN = [`${PARENT}-1`, `${PARENT}-2`];
const STRICT_PROFILE = { task_decomposition_enabled: true, effective_profile: 'strict', task_selected_profile: 'strict' };

function writeQueue(repoRoot: string, extraRows: string[] = [], title = TITLE): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK', '', '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${PARENT} | IN_PROGRESS | P1 | lifecycle-state | ${title} | agent | 2026-11-25 | strict | Original parent obligations. |`,
        ...extraRows, ''
    ].join('\n'), 'utf8');
}

/** The split as record-strict-decomposition-decision leaves it: the artifact and its recorded event. */
function seedSplitDecision(repoRoot: string, options: { recordEvent?: boolean } = {}): void {
    const artifactPath = path.join(reviewsRoot(repoRoot), `${PARENT}-strict-decomposition-decision.json`);
    writeSplitArtifact(artifactPath);
    if (options.recordEvent === false) return;
    appendTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), PARENT, 'STRICT_DECOMPOSITION_DECISION_RECORDED', 'INFO',
        'Strict decomposition decision recorded.', { decision: 'split-required', artifact_sha256: fileSha256(artifactPath) });
}

function writeSplitArtifact(artifactPath: string): void {
    writeJson(artifactPath, buildStrictDecompositionDecisionArtifact({
        taskId: PARENT, decision: 'split-required', taskProfile: 'strict', taskSummary: TITLE,
        reason: 'Discovery and its destructive consumers are separate root causes.',
        scopeRisk: 'Each child stays within its own six-file cap.', expectedReviewTypes: ['code', 'test'],
        atomicityConstraints: ['Each package lands with its own regression.'],
        workPackageContract: {
            schema_version: 1,
            finding_obligations: [],
            work_packages: CHILDREN.map((taskId, index) => ({
                task_id: taskId, profile: 'strict', root_cause_area: `discovery-part-${index + 1}`,
                objective: `Reconcile lifecycle discovery part ${index + 1}`,
                scope_obligations: [`Keep part ${index + 1} within its owning files`],
                validation_contract: [`Prove part ${index + 1} with its focused regression`],
                finding_obligation_ids: [], required_review_types: ['code', 'test']
            }))
        }
    }));
}

function recordingEffects(): NextStepEffectController {
    return { run: (definition) => definition.preview(), pendingPlan: () => null, executedCount: () => 0 };
}

function splitRoute(repoRoot: string) {
    const taskEntries = readTaskQueueEntries(repoRoot);
    const requiredReviewTypes = ['code', 'test'];
    const requirement = buildStrictDecompositionDecisionRequirement({
        taskId: PARENT, taskEntry: taskEntries.get(PARENT) ?? null,
        taskMode: null, preflight: null, profileSummary: null, requiredReviewTypes
    });
    return resolveStrictDecompositionContinuationRoute({
        repoRoot, eventsRoot: eventsRoot(repoRoot), taskEntries, taskId: PARENT,
        cliPrefix: 'node bin/garda.js',
        requirement: { ...requirement, required: true },
        requiredReviewTypes, baseMissingArtifacts: [], basePresentArtifacts: [], effects: recordingEffects()
    });
}

describe('gates/task-mode materialize-decomposition-children', () => {
    it('materializes a recorded split after the parent title changes', () => {
        const repoRoot = makeTempRepo();
        writeQueue(repoRoot);
        initGitRepo(repoRoot);
        seedSplitDecision(repoRoot);
        const translatedTitle = 'Ermittlung des Lebenszyklus aufteilen';
        writeQueue(repoRoot, [], translatedTitle);

        const parent = readTaskQueueEntries(repoRoot).get(PARENT)!;
        assert.equal(hasAuthenticatedStrictSplitDecision(repoRoot, PARENT, parent, null, STRICT_PROFILE), true);
        assert.equal(splitRoute(repoRoot)?.nextGate, 'strict-decomposition-split-routing');
        const result = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(result.status, 'MATERIALIZED', result.outputLines.join('\n'));
        assert.deepEqual(result.childTaskIds, CHILDREN);
        assert.equal(readTaskQueueEntries(repoRoot).get(PARENT)?.title, translatedTitle);
    });

    it('offers the command at the split route and makes the parent route to its first child afterwards', () => {
        const repoRoot = makeTempRepo();
        writeQueue(repoRoot);
        initGitRepo(repoRoot);
        seedSplitDecision(repoRoot);
        const parent = readTaskQueueEntries(repoRoot).get(PARENT)!;
        assert.equal(hasAuthenticatedStrictSplitDecision(repoRoot, PARENT, parent, null, STRICT_PROFILE), true);
        assert.equal(hasAuthenticatedStrictSplitDecision(repoRoot, PARENT, parent, { task_summary: 'Changed task criteria' }, STRICT_PROFILE), false);
        const before = splitRoute(repoRoot);
        assert.equal(before?.nextGate, 'strict-decomposition-split-routing');
        assert.match(before?.reason ?? '', /Create and link parent-derived/u);
        assert.equal(before?.commands[0]?.command, `node bin/garda.js gate materialize-decomposition-children --task-id "${PARENT}" --repo-root "."`);

        const result = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(result.status, 'MATERIALIZED', result.outputLines.join('\n'));
        assert.deepEqual(result.childTaskIds, CHILDREN);
        const entries = readTaskQueueEntries(repoRoot);
        assert.match(entries.get(PARENT)?.notes ?? '',
            /Original parent obligations\. Decomposition source: orchestrator \(\d{4}-\d{2}-\d{2}\); child range `T-DEC-1-1` through `T-DEC-1-2`; execute sequentially\./u);
        assert.equal(entries.get(CHILDREN[0])?.title, 'Reconcile lifecycle discovery part 1');
        assert.equal(entries.get(CHILDREN[0])?.profile, 'strict');
        assert.match(entries.get(CHILDREN[1])?.notes ?? '', /^Parent: T-DEC-1 \(work package 2 of 2; .*Required reviews: code, test\.$/u);
        assert.equal(resolveStrictDecompositionSplitRoutingState(entries, PARENT, CHILDREN, 'strict').ready, true);
        assert.ok(fs.existsSync(path.join(reviewsRoot(repoRoot), `${PARENT}-decomposition-children.json`)));
        assert.match(fs.readFileSync(path.join(eventsRoot(repoRoot), `${PARENT}.jsonl`), 'utf8'), /DECOMPOSITION_CHILDREN_MATERIALIZED/u);

        const after = splitRoute(repoRoot);
        assert.equal(after?.status, 'DECOMPOSED');
        assert.equal(after?.nextGate, 'child-task');
        assert.match(after?.commands[0]?.command ?? '', /next-step "T-DEC-1-1"/u);

        const queue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const rerun = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(rerun.status, 'ALREADY_MATERIALIZED');
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), queue);
    });

    it('refuses an artifact-only split that the timeline does not record', () => {
        const repoRoot = makeTempRepo();
        writeQueue(repoRoot);
        seedSplitDecision(repoRoot, { recordEvent: false });
        const queue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const result = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(result.status, 'BLOCKED');
        assert.match(result.outputLines.join('\n'), /task timeline is not intact|does not record this split-required artifact/u);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), queue);
    });

    it('authenticates the split only by an event of the signed chain, not by an unsigned legacy prefix', () => {
        const repoRoot = makeTempRepo();
        writeQueue(repoRoot);
        seedSplitDecision(repoRoot, { recordEvent: false });
        const artifactPath = path.join(reviewsRoot(repoRoot), `${PARENT}-strict-decomposition-decision.json`);
        // An unsigned matching decision event in a legacy prefix, then an unrelated signed event that makes the timeline pass.
        const timeline = path.join(eventsRoot(repoRoot), `${PARENT}.jsonl`);
        fs.mkdirSync(path.dirname(timeline), { recursive: true });
        fs.writeFileSync(timeline, `${JSON.stringify({ task_id: PARENT, event_type: 'STRICT_DECOMPOSITION_DECISION_RECORDED', outcome: 'INFO',
            actor: 'gate', message: 'Strict decomposition decision recorded.', timestamp_utc: new Date().toISOString(),
            details: { decision: 'split-required', artifact_sha256: fileSha256(artifactPath) } })}\n`);
        appendTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), PARENT, 'TASK_MODE_ENTERED', 'INFO', 'Unrelated signed event.', {});
        const parent = readTaskQueueEntries(repoRoot).get(PARENT)!;
        assert.equal(hasAuthenticatedStrictSplitDecision(repoRoot, PARENT, parent, null, STRICT_PROFILE), false);
        const queue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const result = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(result.status, 'BLOCKED', result.outputLines.join('\n'));
        assert.match(result.outputLines.join('\n'), /does not record this split-required artifact/u);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), queue);
    });

    it('blocks when the decision bytes change between the signed event check and contract use', (t) => {
        const repoRoot = makeTempRepo();
        writeQueue(repoRoot);
        seedSplitDecision(repoRoot);
        const taskPath = path.join(repoRoot, 'TASK.md');
        const queue = fs.readFileSync(taskPath, 'utf8');
        const timeline = path.join(eventsRoot(repoRoot), `${PARENT}.jsonl`);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${PARENT}-strict-decomposition-decision.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        const nativeFs = require('node:fs') as typeof fs;
        const openSync = nativeFs.openSync;
        let replaced = false;
        t.mock.method(nativeFs, 'openSync', (filePath: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
            if (filePath === timeline && !replaced) {
                replaced = true;
                writeJson(artifactPath, { ...artifact, work_package_contract: null });
            }
            return openSync(filePath, flags, mode);
        });

        const result = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(replaced, true);
        assert.equal(result.status, 'BLOCKED', result.outputLines.join('\n'));
        assert.match(result.outputLines.join('\n'), /rerun next-step/u);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), queue);
        assert.equal(fs.existsSync(path.join(reviewsRoot(repoRoot), `${PARENT}-decomposition-children.json`)), false);
    });

    it('does not link children while the parent implementation WIP is not suspended', () => {
        const repoRoot = makeTempRepo();
        writeQueue(repoRoot);
        seedSplitDecision(repoRoot);
        // A current parent preflight whose workspace cannot be shown clean: the late split still has WIP to suspend.
        writeJson(path.join(reviewsRoot(repoRoot), `${PARENT}-preflight.json`), { task_id: PARENT, changed_files: ['src/discovery.ts'] });
        const queue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const result = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(result.status, 'BLOCKED');
        assert.match(result.outputLines.join('\n'), /implementation WIP is not suspended yet.*Run next-step/u);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), queue);
    });

    it('checks and writes under one queue lock hold and rolls back only its own change', () => {
        const repoRoot = makeTempRepo();
        writeQueue(repoRoot);
        initGitRepo(repoRoot);
        seedSplitDecision(repoRoot);
        const taskPath = path.join(repoRoot, 'TASK.md');
        const queue = fs.readFileSync(taskPath, 'utf8');
        const lockPath = resolveTaskQueueTransactionLockPath(taskPath);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, 'Another writer holds the queue.');
        const locked = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(locked.status, 'BLOCKED');
        assert.match(locked.outputLines.join('\n'), /TASK\.md lock could not be acquired/u);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), queue);
        fs.rmSync(lockPath, { recursive: true, force: true });
        // The evidence write fails after the rows were written: the command restores exactly the queue it replaced.
        fs.mkdirSync(path.join(reviewsRoot(repoRoot), `${PARENT}-decomposition-children.json`), { recursive: true });
        assert.throws(() => materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' }));
        assert.equal(fs.readFileSync(taskPath, 'utf8'), queue);
    });

    it('refuses without an authenticated split and leaves a partial hand edit to the agent', () => {
        const repoRoot = makeTempRepo();
        writeQueue(repoRoot);
        const unsplit = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(unsplit.status, 'BLOCKED');
        assert.match(unsplit.outputLines.join('\n'), /No authenticated split decision exists for T-DEC-1/u);
        assert.match(unsplit.outputLines.join('\n'), /NextStep: node bin\/garda\.js next-step "T-DEC-1"/u);

        writeQueue(repoRoot, [`| ${CHILDREN[0]} | TODO | P1 | lifecycle-state | Hand-added child | agent | 2026-11-25 | strict | Parent: ${PARENT}. |`]);
        initGitRepo(repoRoot);
        seedSplitDecision(repoRoot);
        const queue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const partial = materializeDecompositionChildren({ repoRoot, taskId: PARENT, cliPrefix: 'node bin/garda.js' });
        assert.equal(partial.status, 'BLOCKED');
        assert.match(partial.outputLines.join('\n'), /already holds part of this decomposition \(existing child rows: T-DEC-1-1/u);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), queue);
        assert.equal(splitRoute(repoRoot)?.commands.length, 0, 'a partial queue keeps its listed violations, not the materialize command');
    });
});
