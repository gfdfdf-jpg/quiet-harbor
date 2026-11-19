import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { joinOrchestratorPath } from '../../../src/core/orchestrator-paths';
import { isTaskOwnedRuntimeTmpPath, resolveRuntimeTmpTaskId } from '../../../src/lifecycle/cleanup/runtime-cleanup-ownership';
import { recordTaskCompositeRecommendationStop } from '../../../src/gates/next-step/next-step-composite-recommendation-context';
import type { NextStepResult } from '../../../src/gates/next-step';

import {
    findRuntimeCleanupOwnershipEntry,
    getRuntimeCleanupTaskPurgeModeForCandidateCategory,
    isRuntimeCleanupTaskPurgeDeletionCategory,
    listRuntimeCleanupCollectorContracts,
    listRuntimeCleanupSideEffectActionsForRemovedCategories,
    listRuntimeCleanupOwnershipEntries,
    listTaskPurgeableRuntimeCandidateCategories,
    resolveRuntimeCleanupStandardPaths
} from '../../../src/lifecycle/cleanup';

function tailPathSegment(value: string): string {
    return value.split(/[\\/]/u).at(-1) || '';
}

describe('runtime cleanup ownership contract', () => {
    for (const taskId of ['T-991-1-F1', 'T-CLEANUP-ART']) {
        for (const materialized of [false, true]) {
            it(`owns the actual composite stall record for ${taskId} in ${materialized ? 'a bundle' : 'a workspace'}`, (t) => {
                const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-composite-cleanup-'));
                t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
                if (materialized) fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator'));
                const operation = { operation_id: 'handshake-diagnostics' as const, arguments: { task_id: taskId } };
                const result = { task_id: taskId, status: 'BLOCKED', next_gate: 'handshake-diagnostics', reason: 'Same state.',
                    commands: [{ label: 'Run handshake diagnostics', command: 'handshake' }] } as NextStepResult;
                assert.equal(recordTaskCompositeRecommendationStop(repoRoot, taskId, result, operation, 'repeated-state'), null);
                const runtime = joinOrchestratorPath(repoRoot, 'runtime');
                const file = path.join(runtime, 'tmp', `${taskId}-composite-recommendation-stop.json`);
                assert.ok(fs.existsSync(file), 'the actual writer must use the task-prefixed tmp file');
                assert.equal(isTaskOwnedRuntimeTmpPath(runtime, file), true);
                assert.equal(resolveRuntimeTmpTaskId(path.basename(file)), taskId, 'the complete task id owns the file');
                assert.equal(isTaskOwnedRuntimeTmpPath(runtime,
                    path.join(runtime, 'tmp', 'task-composite', `${taskId}-recommendation-stop.json`)), false);
            });
        }
    }
    it('keeps WIP packages outside automatic task purge and retention collectors', () => {
        const entry = findRuntimeCleanupOwnershipEntry('wip-task-packages');
        assert.ok(entry);
        assert.equal(entry.ownership, 'mixed');
        assert.equal(entry.taskPurgeMode, 'exclude-from-task-purge');
        assert.equal(entry.retentionMode, 'operator-managed');
        assert.equal(entry.collectorKey, undefined);
        assert.equal(entry.candidateCategory, undefined);
        assert.ok(entry.notes.some(note => /retired.*orphan/iu.test(note)));
    });

    it('defines each required runtime cleanup area exactly once', () => {
        const entries = listRuntimeCleanupOwnershipEntries();
        const ids = entries.map((entry) => entry.id);

        assert.deepEqual(ids, [...new Set(ids)], 'ownership entry ids must be unique');

        for (const requiredId of [
            'manual-validation-task-root',
            'compact-task-root',
            'plans-task-markdown',
            'project-memory-task-artifacts',
            'project-memory-bootstrap-report',
            'reviews-task-artifacts',
            'reviews-index',
            'task-events-timelines',
            'task-events-completeness-cache',
            'task-events-all-tasks-aggregate',
            'task-events-timeline-summary',
            'task-ledger-files',
            'tmp-review-scratch',
            'tmp-task-prefixed-root-artifacts',
            'tmp-generic-shared-scratch',
            'metrics-jsonl',
            'general-runtime-cleanup-zones'
        ]) {
            assert.ok(findRuntimeCleanupOwnershipEntry(requiredId), `missing ownership entry '${requiredId}'`);
        }
    });

    it('keeps task-scoped purgeable entries separate from shared aggregates and generated zones', () => {
        const entries = listRuntimeCleanupOwnershipEntries();
        const taskScoped = entries.filter((entry) => entry.ownership === 'task-scoped');
        const sharedState = entries.filter((entry) => entry.ownership !== 'task-scoped');

        assert.ok(taskScoped.length > 0, 'expected task-scoped ownership entries');
        assert.ok(sharedState.length > 0, 'expected shared or mixed ownership entries');

        for (const entry of taskScoped) {
            assert.notEqual(
                entry.taskPurgeMode,
                'exclude-from-task-purge',
                `task-scoped entry '${entry.id}' must be purgeable`
            );
            assert.match(
                entry.retentionMode,
                /task-age-or-count/,
                `task-scoped entry '${entry.id}' must follow task retention`
            );
        }

        for (const entry of sharedState.filter((item) => item.ownership !== 'mixed')) {
            assert.notEqual(
                entry.taskPurgeMode,
                'delete-owned-artifacts',
                `shared entry '${entry.id}' must not be treated like a plain task-owned delete`
            );
        }
    });

    it('documents shared side effects for aggregate and index artifacts', () => {
        const aggregateIds = [
            'reviews-task-artifacts',
            'reviews-index',
            'task-events-timelines',
            'task-events-completeness-cache',
            'task-events-all-tasks-aggregate',
            'task-events-timeline-summary',
            'metrics-jsonl'
        ];

        for (const id of aggregateIds) {
            const entry = findRuntimeCleanupOwnershipEntry(id);
            assert.ok(entry, `missing entry '${id}'`);
            assert.ok(
                entry.sharedSideEffects.length > 0 || entry.taskPurgeMode === 'prune-or-rebuild-shared-state-only',
                `entry '${id}' must describe shared prune/rebuild behavior`
            );
        }
    });

    it('classifies authenticated remediation cycle and baseline snapshots as task-owned review evidence', () => {
        const entry = findRuntimeCleanupOwnershipEntry('reviews-task-artifacts');
        assert.ok(entry);
        assert.equal(entry.candidateCategory, 'reviews');
        assert.ok(entry.examples.includes('runtime/reviews/<task-id>-review-remediation-cycle.json'));
        assert.ok(entry.examples.includes('runtime/reviews/<task-id>-<review-type>-remediation-baseline.json'));
        assert.equal(entry.taskPurgeMode, 'delete-owned-artifacts-and-rebuild-shared-state');
    });

    it('drives task purge category and side-effect decisions from the ownership map', () => {
        assert.deepEqual(listTaskPurgeableRuntimeCandidateCategories(), [
            'manual-validation',
            'compact',
            'reviews',
            'task-events',
            'plans',
            'project-memory',
            'task-ledger',
            'tmp'
        ]);
        assert.deepEqual(
            listRuntimeCleanupSideEffectActionsForRemovedCategories(new Set(['reviews'])),
            ['invalidate-reviews-index']
        );
        assert.deepEqual(
            listRuntimeCleanupSideEffectActionsForRemovedCategories(new Set(['task-events'])),
            ['prune-all-tasks-aggregate', 'prune-timeline-summary']
        );
        assert.deepEqual(
            listRuntimeCleanupSideEffectActionsForRemovedCategories(new Set(['manual-validation', 'tmp'])),
            []
        );
        assert.equal(getRuntimeCleanupTaskPurgeModeForCandidateCategory('reviews'), 'delete-owned-artifacts-and-rebuild-shared-state');
        assert.equal(getRuntimeCleanupTaskPurgeModeForCandidateCategory('manual-validation'), 'delete-owned-artifacts');
        assert.equal(getRuntimeCleanupTaskPurgeModeForCandidateCategory('metrics'), null);
        assert.equal(isRuntimeCleanupTaskPurgeDeletionCategory('task-events'), true);
        assert.equal(isRuntimeCleanupTaskPurgeDeletionCategory('metrics'), false);
    });

    it('registers cleanup collectors through ownership entries', () => {
        const contracts = listRuntimeCleanupCollectorContracts();
        const byKey = new Map(contracts.map((contract) => [contract.key, contract]));

        assert.deepEqual(contracts.map((contract) => contract.key), [
            'manual-validation-task-root',
            'compact-task-root',
            'plans-task-markdown',
            'project-memory-task-artifacts',
            'reviews-task-artifacts',
            'task-events-task-artifacts',
            'task-ledger-files',
            'tmp-task-artifacts'
        ]);
        assert.equal(byKey.get('manual-validation-task-root')?.candidateCategory, 'manual-validation');
        assert.deepEqual(byKey.get('task-events-task-artifacts')?.ownershipEntryIds, [
            'task-events-timelines',
            'task-events-completeness-cache'
        ]);
        assert.deepEqual(byKey.get('task-events-task-artifacts')?.sharedSideEffectActions, [
            'prune-all-tasks-aggregate',
            'prune-timeline-summary'
        ]);
    });

    it('marks generic tmp scratch as non-task-purgeable and task-prefixed tmp artifacts as ownership-aware', () => {
        const taskPrefixed = findRuntimeCleanupOwnershipEntry('tmp-task-prefixed-root-artifacts');
        const genericScratch = findRuntimeCleanupOwnershipEntry('tmp-generic-shared-scratch');

        assert.equal(taskPrefixed?.ownership, 'mixed');
        assert.equal(taskPrefixed?.taskPurgeMode, 'delete-owned-artifacts');
        assert.equal(genericScratch?.ownership, 'shared-generated');
        assert.equal(genericScratch?.taskPurgeMode, 'exclude-from-task-purge');
    });

    it('keeps standard cleanup paths aligned with the canonical ownership map', () => {
        const standardPaths = resolveRuntimeCleanupStandardPaths('C:\\repo\\garda-agent-orchestrator\\runtime');
        const sharedZones = findRuntimeCleanupOwnershipEntry('general-runtime-cleanup-zones');

        assert.ok(sharedZones);
        assert.match(sharedZones.location, /\.test-scratch/);
        assert.equal(tailPathSegment(standardPaths.testScratchDir), '.test-scratch');
        assert.equal(tailPathSegment(standardPaths.manualValidationDir), 'manual-validation');
        assert.equal(tailPathSegment(standardPaths.reviewsDir), 'reviews');
        assert.equal(tailPathSegment(standardPaths.taskEventsDir), 'task-events');
        assert.equal(tailPathSegment(standardPaths.projectMemoryDir), 'project-memory');
        assert.equal(tailPathSegment(standardPaths.taskLedgerDir), 'task-ledger');
        assert.equal(tailPathSegment(standardPaths.tmpDir), 'tmp');
    });
});
