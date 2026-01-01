import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveFullSuiteRepairDecompositionState } from '../../../../src/gates/full-suite/full-suite-repair-decomposition';
import { readTaskQueueEntries, resolveSplitRequiredDecompositionState } from '../../../../src/gates/next-step/next-step-task-queue';
import { collectRuntimeTaskState } from '../../../../src/core/active-task-state';

it('keeps repair cardinality separate from split-required while preserving child quality checks', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-cardinality-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const parent = 'T-REPAIR', child = parent + '-F1';
    function seed(options: { linked?: boolean; missing?: boolean; status?: string; title?: string; scope?: string; sibling?: boolean } = {}) {
        fs.writeFileSync(path.join(root, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${parent} | IN_PROGRESS | P1 | tests | Parent test changes | synthetic | 2026-11-01 | strict | ${options.linked === false ? '' : `child tasks: \`${child}\`${options.sibling ? `, \`${parent}-F2\`` : ''}.`} |`,
            ...(options.missing ? [] : [
                `| ${child} | ${options.status ?? 'TODO'} | P1 | architecture | ${options.title ?? 'Repair module boundary debt'} | synthetic | 2026-11-01 | strict | Child of ${parent}. ${options.scope ?? 'Repair scope paths: `src/boundary.ts`;'} |`
            ]),
            ...(options.sibling ? [
                `| ${parent}-F2 | TODO | P1 | architecture | Repair other boundary debt | synthetic | 2026-11-01 | strict | Child of ${parent}. Repair scope paths: \`src/boundary.ts\`; |`
            ] : [])
        ].join('\n'));
    }
    const repair = (allowCompletedChildren = false) => resolveFullSuiteRepairDecompositionState(root, parent,
        { requireChildScopes: true, allowCompletedChildren });
    seed();
    assert.equal(repair().ready, true);
    assert.deepEqual(repair().child_task_ids, [child]);
    assert.equal(resolveSplitRequiredDecompositionState(readTaskQueueEntries(root), parent).ready, false,
        'One valid repair child must not satisfy split-required decomposition');
    for (const [options, expected] of [
        [{ linked: false }, /at least one meaningful linked child task/u],
        [{ missing: true }, /rows are missing/u],
        [{ status: 'DONE' }, /terminal child tasks/u],
        [{ status: 'BLOCKED' }, /not executable/u],
        [{ title: 'TODO' }, /placeholder child tasks/u],
        [{ scope: '' }, /Repair scope paths/u],
        [{ sibling: true }, /overlap|independent/u]
    ] as const) {
        seed(options);
        assert.equal(repair().ready, false);
        assert.match(repair().violations.join(' '), expected);
    }
    seed({ status: 'DONE' });
    assert.equal(repair(true).ready, true, 'Completed children remain valid only for the existing restore handoff');
    seed({ status: 'CANCELLED' });
    assert.equal(repair(true).ready, false, 'Restore cannot excuse a non-executable cancelled child');
});

it('resumes runtime ownership only for a successful restore bound to this repair parent', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-runtime-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const taskId = 'T-REPAIR', eventsRoot = path.join(root, 'runtime/task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const event = { task_id: taskId, event_type: 'FULL_SUITE_REPAIR_WIP_RESTORED', outcome: 'PASS',
        details: { parent_status_sync: { task_id: taskId, next_status: 'IN_PROGRESS', outcome: 'updated' } } };
    function state(restore: unknown, done = false) {
        fs.writeFileSync(path.join(eventsRoot, taskId + '.jsonl'), [
            { event_type: 'STATUS_CHANGED', details: { new_status: 'SPLIT_REQUIRED' } }, restore,
            ...(done ? [{ event_type: 'COMPLETION_GATE_PASSED' }] : [])
        ].map(value => JSON.stringify(value)).join('\n'));
        return collectRuntimeTaskState(root);
    }
    assert.equal(state(event).activeTaskIds.has(taskId), true);
    for (const invalid of [
        { ...event, outcome: 'FAIL' }, { ...event, task_id: 'T-FOREIGN' }, { ...event, details: {} },
        { ...event, details: { parent_status_sync: { task_id: taskId, next_status: 'IN_PROGRESS', outcome: 'write_failed' } } },
        { ...event, details: { parent_status_sync: { task_id: 'T-FOREIGN', next_status: 'IN_PROGRESS', outcome: 'updated' } } },
        { ...event, details: { parent_status_sync: { task_id: taskId, next_status: 'DONE', outcome: 'updated' } } }
    ]) assert.equal(state(invalid).activeTaskIds.has(taskId), false);
    assert.equal(state(event, true).activeTaskIds.has(taskId), false, 'A later completed parent remains terminal');
});
