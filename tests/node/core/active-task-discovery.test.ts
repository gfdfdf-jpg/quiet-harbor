import { describe, it, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assertActiveTaskDiscoveryComplete,
    collectRuntimeTaskState,
    resolveActiveTaskDiscovery,
    resolveActiveTaskIds
} from '../../../src/core/active-task-state';
import { runCleanup, runGc, runTaskRuntimeBatchPurge, runTaskRuntimePurge } from '../../../src/lifecycle/cleanup';
import { previewTaskErasure } from '../../../src/lifecycle/cleanup/task-erasure-preview';
import { assertNoActiveTasksBeforeUpdateApply } from '../../../src/lifecycle/update/active-task-preflight';

const QUEUE_HEADER = [
    '# TASK.md',
    '',
    '## Active Queue',
    '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
    '|---|---|---|---|---|---|---|---|---|'
];

interface Workspace {
    root: string;
    bundleRoot: string;
    taskEventsDir: string;
}

function createWorkspace(t: TestContext, rows: Array<[string, string]> = [['T-500', 'IN_PROGRESS'], ['T-501', 'DONE']]): Workspace {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-active-discovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    const lines = [...QUEUE_HEADER, ...rows.map(([id, status]) =>
        `| ${id} | ${status} | P2 | test | Task | test | 2026-11-25 | balanced | note |`)];
    fs.writeFileSync(path.join(root, 'TASK.md'), `${lines.join('\n')}\n`, 'utf8');
    return { root, bundleRoot, taskEventsDir: path.join(bundleRoot, 'runtime', 'task-events') };
}

function writeTimeline(workspace: Workspace, taskId: string, content: string): void {
    fs.mkdirSync(workspace.taskEventsDir, { recursive: true });
    fs.writeFileSync(path.join(workspace.taskEventsDir, `${taskId}.jsonl`), content, 'utf8');
}

function failTaskEventsDirectoryRead(t: TestContext, workspace: Workspace, code: string): void {
    // The directory exists as a real entry, so the failure comes from discovery's enumeration, not from a missing path.
    // Other readers of the directory (lock scans) keep working: only active task discovery is under test.
    fs.mkdirSync(workspace.taskEventsDir, { recursive: true });
    const original = fs.readdirSync;
    const target = path.resolve(workspace.taskEventsDir);
    const failing = mock.method(fs, 'readdirSync', function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string' && path.resolve(args[0]) === target
            && String(new Error().stack).includes('collectRuntimeTaskState')) {
            throw Object.assign(new Error(`${code}: simulated task-events read failure`), { code });
        }
        return (original as (...values: unknown[]) => unknown).apply(this, args);
    });
    t.after(() => failing.mock.restore());
}

describe('active task discovery status', () => {
    it('allows update after operator closure while default discovery still protects the runtime', (t) => {
        const statuses = ['DONE', 'BLOCKED', 'SPLIT_REQUIRED', 'DECOMPOSED'];
        const workspace = createWorkspace(t, statuses.map((status, index) => [`t-closed-${index}`, status]));
        for (const index of statuses.keys()) {
            writeTimeline(workspace, `T-CLOSED-${index}`,
                JSON.stringify({ event_type: 'STATUS_CHANGED', details: { new_status: 'IN_PROGRESS' } }) + '\n');
        }
        assert.equal(resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot).activeTaskIds.size, statuses.length);
        assert.doesNotThrow(() => assertNoActiveTasksBeforeUpdateApply(workspace.root, workspace.bundleRoot));
    });

    it('retains active timeline evidence when a malformed queue row is dropped', (t) => {
        const workspace = createWorkspace(t, [['T-42', 'DONE']]);
        fs.appendFileSync(path.join(workspace.root, 'TASK.md'),
            '| T-43 | IN_PROGRESS | P2 | test | Task | test | 2026-11-25 | balanced | note | extra |\n');
        writeTimeline(workspace, 'T-42', '{"event_type":"STATUS_CHANGED","details":{"new_status":"IN_PROGRESS"}}\n');

        assert.throws(() => assertNoActiveTasksBeforeUpdateApply(workspace.root, workspace.bundleRoot),
            /Update refused because the project has active tasks.*Finish task T-42/u);
    });

    it('identifies the lowercase queue ID that must be corrected before update', (t) => {
        const workspace = createWorkspace(t, [['t-42', 'IN_PROGRESS']]);

        assert.throws(() => assertNoActiveTasksBeforeUpdateApply(workspace.root, workspace.bundleRoot), (error: Error) => {
            assert.match(error.message, /Active task discovery is unknown.*TASK\.md line 6.*"t-42".*Correct the task ID/u);
            assert.doesNotMatch(error.message, /gate task-reset/u);
            return true;
        });
    });

    it('refuses update for active queue rows and unreadable state despite a terminal row', (t) => {
        const workspace = createWorkspace(t, [['t-closed', 'DONE'], ['T-REVIEW', 'IN_REVIEW'], ['T-WORK', 'IN_PROGRESS']]);
        const queuePath = path.join(workspace.root, 'TASK.md');
        writeTimeline(workspace, 'T-REVIEW', '{"event_type":"COMPLETION_GATE_PASSED"}\n');
        assert.throws(() => assertNoActiveTasksBeforeUpdateApply(workspace.root, workspace.bundleRoot),
            /gate task-reset --task-id "T-REVIEW".*gate task-reset --task-id "T-WORK"/u);

        fs.writeFileSync(queuePath, [...QUEUE_HEADER, '| t-closed | DONE | P2 | test | Task | test | 2026-11-25 | balanced | note |'].join('\n'));
        writeTimeline(workspace, 'T-CLOSED', 'not json\n');
        assert.throws(() => assertNoActiveTasksBeforeUpdateApply(workspace.root, workspace.bundleRoot), /T-CLOSED/u);

        fs.unlinkSync(queuePath);
        fs.mkdirSync(queuePath);
        assert.throws(() => assertNoActiveTasksBeforeUpdateApply(workspace.root, workspace.bundleRoot),
            /Active task discovery is unknown.*TASK\.md/u);
    });

    it('reports a confirmed absent runtime as missing and keeps TASK and explicit fallbacks complete', (t) => {
        const workspace = createWorkspace(t);
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'missing');
        assert.deepEqual(runtimeState.discoveryErrors, []);

        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot, ['T-777']);
        assert.equal(discovery.discoveryStatus, 'complete');
        assert.equal(discovery.runtimeDiscoveryStatus, 'missing');
        assert.deepEqual([...discovery.activeTaskIds].sort(), ['T-500', 'T-777']);
        assert.doesNotThrow(() => assertActiveTaskDiscoveryComplete(discovery, 'runtime cleanup'));
    });

    it('keeps a corrupt timeline conservative while the directory scan stays complete', (t) => {
        const workspace = createWorkspace(t);
        writeTimeline(workspace, 'T-600', 'not json\n');
        writeTimeline(workspace, 'T-501', `${JSON.stringify({ event_type: 'COMPLETION_GATE_PASSED' })}\n`);
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'complete');
        assert.equal(runtimeState.activeTaskIds.has('T-600'), true, 'a corrupt timeline must stay active');
        assert.equal(runtimeState.terminalTaskIds.has('T-501'), true);

        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
        assert.equal(discovery.discoveryStatus, 'complete');
        assert.deepEqual([...discovery.activeTaskIds].sort(), ['T-500', 'T-600']);
    });

    it('marks a task-events path that is not a directory as unknown instead of empty', (t) => {
        const workspace = createWorkspace(t);
        fs.writeFileSync(workspace.taskEventsDir, 'not a directory', 'utf8');
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'unknown');
        assert.equal(runtimeState.discoveryErrors.length, 1);
        assert.match(runtimeState.discoveryErrors[0] ?? '', /runtime task-events directory: (ENOTDIR|ENOENT|EINVAL)?/u);

        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot, ['T-777']);
        assert.equal(discovery.discoveryStatus, 'unknown');
        assert.deepEqual([...discovery.activeTaskIds].sort(), ['T-500', 'T-777'], 'known IDs stay available for diagnostics');
        assert.deepEqual([...resolveActiveTaskIds(workspace.root, workspace.bundleRoot, ['T-777'])].sort(), ['T-500', 'T-777']);
    });

    it('treats a dangling task-events or runtime link as unknown, not as confirmed absence', (t) => {
        for (const linkedSegment of ['task-events', 'runtime'] as const) {
            const workspace = createWorkspace(t);
            const runtimeDir = path.join(workspace.bundleRoot, 'runtime');
            const linkPath = linkedSegment === 'runtime' ? runtimeDir : workspace.taskEventsDir;
            fs.rmSync(linkPath, { recursive: true, force: true });
            const vanishedTarget = path.join(workspace.root, `vanished-${linkedSegment}`);
            fs.mkdirSync(vanishedTarget);
            fs.symlinkSync(vanishedTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
            fs.rmSync(vanishedTarget, { recursive: true, force: true });

            const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
            assert.equal(runtimeState.discoveryStatus, 'unknown', `dangling ${linkedSegment} link must not read as missing`);
            assert.match(runtimeState.discoveryErrors.join('\n'), linkedSegment === 'task-events'
                ? /runtime task-events directory: is a link/u
                : /runtime task-events directory entry: ENOENT /u);
            // Discovery refuses before the mutation journal opens, so neither case may fail later in the journal.
            assert.throws(() => runTaskRuntimePurge({
                targetRoot: workspace.root, bundleRoot: workspace.bundleRoot, taskId: 'T-501', confirm: true
            }), /Active task discovery is unknown, so task runtime purge is refused/u);
        }
    });

    it('refuses a readable task-events link that resolves outside the runtime', (t) => {
        const workspace = createWorkspace(t);
        const foreignInventory = path.join(workspace.root, 'foreign-task-events');
        fs.mkdirSync(foreignInventory);
        fs.writeFileSync(path.join(foreignInventory, 'T-900.jsonl'), 'not json\n', 'utf8');
        fs.symlinkSync(foreignInventory, workspace.taskEventsDir, process.platform === 'win32' ? 'junction' : 'dir');
        const linkEnumerations: string[] = [];
        const original = fs.readdirSync;
        const enumeration = mock.method(fs, 'readdirSync', function (this: unknown, ...args: unknown[]) {
            if (typeof args[0] === 'string' && path.resolve(args[0]) === path.resolve(workspace.taskEventsDir)) {
                linkEnumerations.push(args[0]);
            }
            return (original as (...values: unknown[]) => unknown).apply(this, args);
        });

        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        enumeration.mock.restore();
        assert.deepEqual(linkEnumerations, [], 'the linked inventory is rejected before it is enumerated');
        assert.equal(runtimeState.discoveryStatus, 'unknown');
        assert.equal(runtimeState.activeTaskIds.size, 0, 'a foreign inventory must not contribute task IDs');
        assert.match(runtimeState.discoveryErrors.join('\n'), /is a link/u);
        assert.throws(() => runTaskRuntimePurge({
            targetRoot: workspace.root, bundleRoot: workspace.bundleRoot, taskId: 'T-501', confirm: true
        }), /task runtime purge is refused/u);
    });

    it('keeps a task active when a later status transition is unrecognized', (t) => {
        const workspace = createWorkspace(t, [['T-501', 'DONE']]);
        const transition = (status: string) => JSON.stringify({ event_type: 'STATUS_CHANGED', details: { new_status: status } });
        writeTimeline(workspace, 'T-620', `${[transition('IN_PROGRESS'), transition('PAUSED_SOMEHOW')].join('\n')}\n`);
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'complete');
        assert.equal(runtimeState.activeTaskIds.has('T-620'), true, 'an unrecognized status must not clear observed activity');
        const purge = runTaskRuntimePurge({
            targetRoot: workspace.root, bundleRoot: workspace.bundleRoot, taskId: 'T-620', confirm: true
        });
        assert.equal(purge.activeTaskProtected, true);

        writeTimeline(workspace, 'T-621', `${[transition('IN_PROGRESS'), transition('DONE')].join('\n')}\n`);
        assert.equal(collectRuntimeTaskState(workspace.bundleRoot).terminalTaskIds.has('T-621'), true, 'recognized terminal status stays terminal');
    });

    it('keeps a task active when a later status value is not a string', (t) => {
        const workspace = createWorkspace(t, [['T-501', 'DONE']]);
        const lines = [
            { event_type: 'STATUS_CHANGED', details: { new_status: 'IN_PROGRESS' } },
            { event_type: 'STATUS_CHANGED', details: { new_status: ['DONE'] } }
        ].map(value => JSON.stringify(value));
        writeTimeline(workspace, 'T-622', `${lines.join('\n')}\n`);
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.activeTaskIds.has('T-622'), true, 'a coerced status must not clear observed activity');
        assert.equal(runtimeState.terminalTaskIds.has('T-622'), false);
    });

    it('does not let a linked timeline file supply a terminal state', (t) => {
        const workspace = createWorkspace(t, [['T-630', 'IN_PROGRESS']]);
        const foreignTimeline = path.join(workspace.root, 'foreign-T-630.jsonl');
        fs.writeFileSync(foreignTimeline, `${JSON.stringify({ event_type: 'COMPLETION_GATE_PASSED' })}\n`, 'utf8');
        fs.mkdirSync(workspace.taskEventsDir, { recursive: true });
        try {
            fs.symlinkSync(foreignTimeline, path.join(workspace.taskEventsDir, 'T-630.jsonl'), 'file');
        } catch (error) {
            t.skip(`file symlinks are unavailable here: ${(error as NodeJS.ErrnoException).code}`);
            return;
        }
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.terminalTaskIds.has('T-630'), false);
        assert.equal(runtimeState.activeTaskIds.has('T-630'), true);
        assert.equal(resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot).activeTaskIds.has('T-630'), true);
    });

    it('accepts a real task-events directory whose stored name differs only by case', (t) => {
        const workspace = createWorkspace(t);
        const mixedCase = path.join(workspace.bundleRoot, 'runtime', 'Task-Events');
        fs.mkdirSync(mixedCase);
        if (!fs.existsSync(workspace.taskEventsDir)) {
            t.skip('case-sensitive file system: the lowercase task-events path does not open the mixed-case folder');
            return;
        }
        fs.writeFileSync(path.join(mixedCase, 'T-640.jsonl'), 'not json\n', 'utf8');
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'complete');
        assert.equal(runtimeState.activeTaskIds.has('T-640'), true);
    });

    it('does not let a hard-linked timeline supply a terminal state', (t) => {
        const workspace = createWorkspace(t, [['T-650', 'IN_PROGRESS']]);
        const foreignTimeline = path.join(workspace.root, 'foreign-T-650.jsonl');
        fs.writeFileSync(foreignTimeline, `${JSON.stringify({ event_type: 'COMPLETION_GATE_PASSED' })}\n`, 'utf8');
        fs.mkdirSync(workspace.taskEventsDir, { recursive: true });
        fs.linkSync(foreignTimeline, path.join(workspace.taskEventsDir, 'T-650.jsonl'));
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.terminalTaskIds.has('T-650'), false);
        assert.equal(runtimeState.activeTaskIds.has('T-650'), true);
    });

    it('does not accept malformed event types or another task ID as terminal evidence', (t) => {
        const workspace = createWorkspace(t, [['T-660', 'IN_PROGRESS'], ['T-661', 'IN_PROGRESS']]);
        writeTimeline(workspace, 'T-660', `${JSON.stringify({ event_type: ['COMPLETION_GATE_PASSED'] })}\n`);
        writeTimeline(workspace, 'T-661', `${JSON.stringify({ task_id: 'T-999', event_type: 'COMPLETION_GATE_PASSED' })}\n`);
        writeTimeline(workspace, 'T-662', `${JSON.stringify({ task_id: 't-662', event_type: 'COMPLETION_GATE_PASSED' })}\n`);
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        for (const taskId of ['T-660', 'T-661']) {
            assert.equal(runtimeState.terminalTaskIds.has(taskId), false, `${taskId} must not become terminal`);
        }
        assert.equal(runtimeState.activeTaskIds.has('T-660'), true, 'a malformed event type keeps the task protected');
        assert.equal(runtimeState.activeTaskIds.has('T-661'), true, 'a timeline with only another task\'s records stays protected');
        assert.equal(runtimeState.terminalTaskIds.has('T-662'), true, 'a matching task ID stays valid terminal evidence');
        assert.deepEqual(
            [...resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot).activeTaskIds].sort(), ['T-660', 'T-661']);
    });

    it('keeps a task active when its timeline holds only another task\'s records', (t) => {
        const workspace = createWorkspace(t, [['T-501', 'DONE']]);
        writeTimeline(workspace, 'T-670', `${JSON.stringify({ task_id: 'T-999', event_type: 'TASK_MODE_ENTERED' })}\n`);
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'complete');
        assert.equal(runtimeState.activeTaskIds.has('T-670'), true);
    });

    it('keeps a task active when a later status transition is incomplete', (t) => {
        const workspace = createWorkspace(t, [['T-501', 'DONE']]);
        const incompleteTransitions: unknown[] = [undefined, {}, [], { new_status: null }, { new_status: '  ' }];
        incompleteTransitions.forEach((details, index) => {
            const taskId = `T-68${index}`;
            const lines = [{ event_type: 'COMPLETION_GATE_PASSED' }, { event_type: 'STATUS_CHANGED', details }];
            writeTimeline(workspace, taskId, `${lines.map(value => JSON.stringify(value)).join('\n')}\n`);
        });
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        incompleteTransitions.forEach((_, index) => {
            const taskId = `T-68${index}`;
            assert.equal(runtimeState.terminalTaskIds.has(taskId), false, `${taskId} must not stay terminal`);
            assert.equal(runtimeState.activeTaskIds.has(taskId), true);
        });
    });

    it('does not let a later record without an event type leave earlier terminal evidence authoritative', (t) => {
        const incompleteRecords: Array<Record<string, unknown>> = [{}, { event_type: null }, { event_type: '   ' }, { task_id: 'T-693' }];
        const rows: Array<[string, string]> = incompleteRecords.map((_, index) => [`T-69${index}`, 'IN_PROGRESS']);
        const workspace = createWorkspace(t, rows);
        incompleteRecords.forEach((record, index) => {
            const lines = [{ event_type: 'COMPLETION_GATE_PASSED' }, record];
            writeTimeline(workspace, `T-69${index}`, `${lines.map(value => JSON.stringify(value)).join('\n')}\n`);
        });
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
        for (const [taskId] of rows) {
            assert.equal(runtimeState.terminalTaskIds.has(taskId), false, `${taskId} must not stay terminal`);
            assert.equal(runtimeState.activeTaskIds.has(taskId), true);
            assert.equal(discovery.activeTaskIds.has(taskId), true, `${taskId} keeps its active queue row`);
        }
    });

    it('reads a timeline whose stored extension differs only by case', (t) => {
        const workspace = createWorkspace(t, [['T-695', 'DONE']]);
        fs.mkdirSync(workspace.taskEventsDir, { recursive: true });
        fs.writeFileSync(path.join(workspace.taskEventsDir, 'T-695.JSONL'),
            `${JSON.stringify({ event_type: 'STATUS_CHANGED', details: { new_status: 'IN_PROGRESS' } })}\n`, 'utf8');
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
        assert.equal(discovery.discoveryStatus, 'complete');
        assert.equal(discovery.activeTaskIds.has('T-695'), true, 'live .JSONL history must not be skipped');
    });

    it('treats a fresh repair-parent restoration that names the task in another case as a restart', (t) => {
        const workspace = createWorkspace(t, [['T-ab7', 'IN_PROGRESS']]);
        const lines = [
            { task_id: 'T-AB7', event_type: 'STATUS_CHANGED', details: { new_status: 'DONE' } },
            { task_id: 'T-AB7', event_type: 'COMPLETION_GATE_PASSED' },
            {
                task_id: 'T-AB7', event_type: 'FULL_SUITE_REPAIR_WIP_RESTORED', outcome: 'PASS',
                details: { parent_status_sync: { task_id: 'T-AB7', next_status: 'IN_PROGRESS', outcome: 'updated' } }
            }
        ];
        writeTimeline(workspace, 'T-ab7', `${lines.map(value => JSON.stringify(value)).join('\n')}\n`);
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.terminalTaskIds.has('T-ab7'), false, 'the restart must outrank earlier terminal evidence');
        assert.equal(resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot).activeTaskIds.has('T-ab7'), true);
    });

    it('does not accept a completion record with a failing, blank or unknown outcome as terminal evidence', (t) => {
        const outcomes = ['FAIL', null, '', ' PASS', 'pass', 'BLOCKED'];
        const taskIds = outcomes.map((_outcome, index) => `T-69${index + 2}`);
        const workspace = createWorkspace(t, taskIds.map((taskId): [string, string] => [taskId, 'IN_PROGRESS']));
        outcomes.forEach((outcome, index) => {
            const lines = [
                { event_type: 'STATUS_CHANGED', details: { new_status: 'DONE' } },
                { event_type: 'COMPLETION_GATE_PASSED', outcome }
            ];
            writeTimeline(workspace, `T-69${index + 2}`, `${lines.map(value => JSON.stringify(value)).join('\n')}\n`);
        });
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
        for (const taskId of taskIds) {
            assert.equal(runtimeState.terminalTaskIds.has(taskId), false, `${taskId} must not be released by a failed completion`);
            assert.equal(discovery.activeTaskIds.has(taskId), true);
        }
    });

    it('gives a noncanonical timeline name no terminal authority', (t) => {
        const workspace = createWorkspace(t, [['T-694', 'IN_PROGRESS']]);
        fs.mkdirSync(workspace.taskEventsDir, { recursive: true });
        const terminalLines = [
            { event_type: 'STATUS_CHANGED', details: { new_status: 'DONE' } },
            { event_type: 'COMPLETION_GATE_PASSED' }
        ];
        fs.writeFileSync(path.join(workspace.taskEventsDir, 'T-694.JSONL'),
            `${terminalLines.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8');
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.terminalTaskIds.has('T-694'), false, 'only the canonical .jsonl name may release a task');
        assert.equal(runtimeState.activeTaskIds.has('T-694'), true);
        assert.equal(resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot).activeTaskIds.has('T-694'), true,
            'the active queue row stays protected');
    });

    it('keeps a task protected when case-equivalent timeline names are listed', (t) => {
        const workspace = createWorkspace(t, [['T-ab6', 'IN_PROGRESS']]);
        writeTimeline(workspace, 'T-ab6', `${JSON.stringify({ event_type: 'COMPLETION_GATE_PASSED' })}\n`);
        const original = fs.readdirSync;
        const target = path.resolve(workspace.taskEventsDir);
        const listing = mock.method(fs, 'readdirSync', function (this: unknown, ...args: unknown[]) {
            if (typeof args[0] === 'string' && path.resolve(args[0]) === target) {
                return ['T-ab6.jsonl', 'T-AB6.JSONL'];
            }
            return (original as (...values: unknown[]) => unknown).apply(this, args);
        });
        t.after(() => listing.mock.restore());
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'complete');
        assert.equal(runtimeState.activeTaskIds.has('T-ab6'), true, 'the first spelling stays protected');
        assert.equal(runtimeState.activeTaskIds.has('T-AB6'), true);
        assert.equal(resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot).activeTaskIds.has('T-ab6'), true,
            'the queued active row is not suppressed by the earlier terminal record');
    });

    it('does not let a stale first timeline drop protection when an extension-only duplicate is listed', (t) => {
        const workspace = createWorkspace(t, [['T-501', 'DONE']]);
        writeTimeline(workspace, 'T-ab7', `${JSON.stringify({ event_type: 'STATUS_CHANGED', details: { new_status: 'IN_PROGRESS' } })}\n`);
        const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        fs.utimesSync(path.join(workspace.taskEventsDir, 'T-ab7.jsonl'), old, old);
        const original = fs.readdirSync;
        const target = path.resolve(workspace.taskEventsDir);
        const listing = mock.method(fs, 'readdirSync', function (this: unknown, ...args: unknown[]) {
            if (typeof args[0] === 'string' && path.resolve(args[0]) === target) {
                return ['T-ab7.jsonl', 'T-ab7.JSONL'];
            }
            return (original as (...values: unknown[]) => unknown).apply(this, args);
        });
        t.after(() => listing.mock.restore());
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.activeTaskIds.has('T-ab7'), true);
        assert.equal(runtimeState.staleRuntimeActiveTaskIds.has('T-ab7'), false, 'a conflicted timeline gives no stale authority');
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot, undefined, {
            includeStaleRuntimeActiveTasks: false
        });
        assert.equal(discovery.activeTaskIds.has('T-ab7'), true, 'stale exclusion must not drop a conflicted timeline');
    });

    it('treats a task-events directory reached through a linked runtime ancestor as unknown', (t) => {
        const workspace = createWorkspace(t, [['T-501', 'IN_PROGRESS']]);
        const runtimeDir = path.join(workspace.bundleRoot, 'runtime');
        const foreignRuntime = path.join(workspace.root, 'foreign-runtime');
        fs.mkdirSync(path.join(foreignRuntime, 'task-events'), { recursive: true });
        fs.writeFileSync(path.join(foreignRuntime, 'task-events', 'T-501.jsonl'),
            `${JSON.stringify({ event_type: 'COMPLETION_GATE_PASSED' })}\n`, 'utf8');
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.symlinkSync(foreignRuntime, runtimeDir, process.platform === 'win32' ? 'junction' : 'dir');
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
        assert.equal(discovery.discoveryStatus, 'unknown');
        assert.match(discovery.discoveryErrors.join('\n'), /linked runtime ancestor/u);
        assert.equal(discovery.activeTaskIds.has('T-501'), true, 'foreign terminal evidence must not suppress the active row');
    });

    it('treats an empty, invalid or null task ID in a later record as corruption', (t) => {
        const workspace = createWorkspace(t, [['T-697', 'IN_PROGRESS'], ['T-698', 'IN_PROGRESS'], ['T-699', 'IN_PROGRESS']]);
        const invalidTaskIds = ['', 'not a task', null];
        invalidTaskIds.forEach((invalidTaskId, index) => {
            // Read as a legacy own record, the later records would make the task terminal; corruption must keep it active.
            const lines = [
                { event_type: 'STATUS_CHANGED', details: { new_status: 'IN_PROGRESS' } },
                { task_id: invalidTaskId, event_type: 'STATUS_CHANGED', details: { new_status: 'DONE' } },
                { task_id: invalidTaskId, event_type: 'COMPLETION_GATE_PASSED' }
            ];
            writeTimeline(workspace, `T-69${index + 7}`, `${lines.map(value => JSON.stringify(value)).join('\n')}\n`);
        });
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
        for (const taskId of ['T-697', 'T-698', 'T-699']) {
            assert.equal(runtimeState.terminalTaskIds.has(taskId), false, `${taskId} must not stay terminal`);
            assert.equal(discovery.activeTaskIds.has(taskId), true);
        }
    });

    it('treats a missing task-events folder under a linked runtime as unknown, not as missing', (t) => {
        const workspace = createWorkspace(t);
        const runtimeDir = path.join(workspace.bundleRoot, 'runtime');
        const foreignRuntime = path.join(workspace.root, 'foreign-runtime');
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.mkdirSync(foreignRuntime);
        fs.symlinkSync(foreignRuntime, runtimeDir, process.platform === 'win32' ? 'junction' : 'dir');
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'unknown');
        assert.match(runtimeState.discoveryErrors.join('\n'), /absent under a linked runtime ancestor/u);
        assert.equal(resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot).discoveryStatus, 'unknown');
    });

    it('keeps a missing task-events folder as missing when the whole bundle is reached through a link', (t) => {
        const workspace = createWorkspace(t);
        const linkedBundleRoot = path.join(workspace.root, 'linked-bundle');
        fs.symlinkSync(workspace.bundleRoot, linkedBundleRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const runtimeState = collectRuntimeTaskState(linkedBundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'missing');
        assert.deepEqual(runtimeState.discoveryErrors, []);
    });

    it('keeps a missing runtime as missing when the bundle itself does not exist', (t) => {
        const workspace = createWorkspace(t);
        fs.rmSync(workspace.bundleRoot, { recursive: true, force: true });
        assert.equal(collectRuntimeTaskState(workspace.bundleRoot).discoveryStatus, 'missing');
    });

    for (const code of ['EACCES', 'EIO', 'EPERM']) {
        it(`marks a ${code} task-events directory read as unknown`, (t) => {
            const workspace = createWorkspace(t);
            writeTimeline(workspace, 'T-600', 'not json\n');
            failTaskEventsDirectoryRead(t, workspace, code);
            const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
            assert.equal(discovery.discoveryStatus, 'unknown');
            assert.equal(discovery.runtimeDiscoveryStatus, 'unknown');
            assert.match(discovery.discoveryErrors.join('\n'), new RegExp(`runtime task-events directory: ${code} `, 'u'));
            assert.deepEqual([...discovery.activeTaskIds], ['T-500']);
            assert.throws(
                () => assertActiveTaskDiscoveryComplete(discovery, 'runtime cleanup'),
                /Active task discovery is unknown, so runtime cleanup is refused[\s\S]*Known active tasks: T-500\./u
            );
        });
    }

    it('keeps IDs found before a scan failure and reports the scan as unknown', (t) => {
        const workspace = createWorkspace(t);
        writeTimeline(workspace, 'T-610', 'not json\n');
        const original = fs.readdirSync;
        const target = path.resolve(workspace.taskEventsDir);
        // A non-string entry makes the per-entry scan throw after T-610 was already classified.
        const partial = mock.method(fs, 'readdirSync', function (this: unknown, ...args: unknown[]) {
            if (typeof args[0] === 'string' && path.resolve(args[0]) === target) {
                return ['T-610.jsonl', 42];
            }
            return (original as (...values: unknown[]) => unknown).apply(this, args);
        });
        t.after(() => partial.mock.restore());
        const runtimeState = collectRuntimeTaskState(workspace.bundleRoot);
        assert.equal(runtimeState.discoveryStatus, 'unknown');
        assert.equal(runtimeState.activeTaskIds.has('T-610'), true);
        assert.match(runtimeState.discoveryErrors.join('\n'), /runtime task-events scan: /u);
    });

    it('reports discovery as unknown when TASK.md exists but cannot be read, keeping runtime and explicit IDs', (t) => {
        const workspace = createWorkspace(t);
        writeTimeline(workspace, 'T-600', 'not json\n');
        const planPath = path.join(workspace.bundleRoot, 'runtime', 'plans', 'T-500.md');
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(planPath, '# plan of a queue-only active task\n', 'utf8');
        fs.rmSync(path.join(workspace.root, 'TASK.md'));
        fs.mkdirSync(path.join(workspace.root, 'TASK.md'));
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot, ['T-777']);
        assert.equal(discovery.runtimeDiscoveryStatus, 'complete');
        assert.equal(discovery.discoveryStatus, 'unknown', 'queue-only active tasks cannot be excluded');
        assert.match(discovery.discoveryErrors.join('\n'), /task queue TASK\.md: /u);
        assert.deepEqual([...discovery.activeTaskIds].sort(), ['T-600', 'T-777']);
        const base = { targetRoot: workspace.root, bundleRoot: workspace.bundleRoot };
        assert.throws(() => runTaskRuntimePurge({ ...base, taskId: 'T-500', confirm: true }), /task runtime purge is refused/u);
        assert.throws(() => runTaskRuntimeBatchPurge({ ...base, confirm: true }), /task runtime batch purge is refused/u);
        assert.equal(fs.existsSync(planPath), true, 'a queue-only active task keeps its artifacts');
    });

    it('reports discovery as unknown when TASK.md is a dangling link, and points the preview at TASK.md', (t) => {
        const workspace = createWorkspace(t);
        const taskPath = path.join(workspace.root, 'TASK.md');
        const vanishedQueue = path.join(workspace.root, 'vanished-queue');
        fs.rmSync(taskPath);
        fs.mkdirSync(vanishedQueue);
        fs.symlinkSync(vanishedQueue, taskPath, process.platform === 'win32' ? 'junction' : 'dir');
        fs.rmSync(vanishedQueue, { recursive: true, force: true });
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
        assert.equal(discovery.runtimeDiscoveryStatus, 'missing');
        assert.equal(discovery.discoveryStatus, 'unknown', 'a queue that cannot be looked up is not an absent queue');
        assert.match(discovery.discoveryErrors.join('\n'), /task queue TASK\.md: /u);
        const base = { targetRoot: workspace.root, bundleRoot: workspace.bundleRoot };
        assert.throws(() => runTaskRuntimePurge({ ...base, taskId: 'T-501', confirm: true }), /task runtime purge is refused/u);
        const preview = runTaskRuntimePurge({ ...base, taskId: 'T-501' });
        assert.equal(preview.result, 'PARTIAL');
        assert.ok(preview.errors.some(error => path.resolve(error.path) === path.resolve(taskPath)
            && /task queue TASK\.md/u.test(error.message)), JSON.stringify(preview.errors));
    });

    it('reports discovery as unknown when a readable TASK.md symbolic or hard link points at another queue', (t) => {
        const workspace = createWorkspace(t, [['T-500', 'IN_PROGRESS']]);
        const taskPath = path.join(workspace.root, 'TASK.md');
        const foreignQueue = path.join(workspace.root, 'foreign-TASK.md');
        fs.writeFileSync(foreignQueue, `${[...QUEUE_HEADER,
            '| T-500 | DONE | P2 | test | Task | test | 2026-11-25 | balanced | note |'].join('\n')}\n`, 'utf8');
        const planPath = path.join(workspace.bundleRoot, 'runtime', 'plans', 'T-500.md');
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(planPath, '# plan of a locally active task\n', 'utf8');
        const linkKinds: Array<['symbolic' | 'hard', () => void]> = [
            ['symbolic', () => fs.symlinkSync(foreignQueue, taskPath, 'file')],
            ['hard', () => fs.linkSync(foreignQueue, taskPath)]
        ];
        for (const [kind, createLink] of linkKinds) {
            fs.rmSync(taskPath, { force: true });
            try {
                createLink();
            } catch (error) {
                // Accounts without the file-symlink privilege cannot build this fixture; the hard link still runs.
                if (kind === 'symbolic') {
                    t.diagnostic(`file symlinks are unavailable here: ${(error as NodeJS.ErrnoException).code}`);
                    continue;
                }
                throw error;
            }
            const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot);
            assert.equal(discovery.discoveryStatus, 'unknown', `a ${kind}-linked queue cannot release local tasks`);
            assert.match(discovery.discoveryErrors.join('\n'), /task queue TASK\.md: is a link or not a regular single-link file/u);
            assert.throws(() => runTaskRuntimePurge({
                targetRoot: workspace.root, bundleRoot: workspace.bundleRoot, taskId: 'T-500', confirm: true
            }), /task runtime purge is refused/u, kind);
            assert.equal(fs.existsSync(planPath), true, kind);
        }
    });

    it('keeps discovery complete when TASK.md is absent', (t) => {
        const workspace = createWorkspace(t);
        writeTimeline(workspace, 'T-600', 'not json\n');
        fs.rmSync(path.join(workspace.root, 'TASK.md'));
        const discovery = resolveActiveTaskDiscovery(workspace.root, workspace.bundleRoot, ['T-777']);
        assert.equal(discovery.discoveryStatus, 'complete');
        assert.deepEqual([...discovery.activeTaskIds].sort(), ['T-600', 'T-777']);
    });
});

describe('destructive consumers of unknown active task discovery', () => {
    function seedDoneTaskArtifact(workspace: Workspace, taskId: string): string {
        const planPath = path.join(workspace.bundleRoot, 'runtime', 'plans', `${taskId}.md`);
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(planPath, '# plan\n', 'utf8');
        return planPath;
    }

    it('refuses confirmed cleanup, gc and task purges without deleting, while dry runs stay readable', (t) => {
        const workspace = createWorkspace(t);
        const planPath = seedDoneTaskArtifact(workspace, 'T-501');
        failTaskEventsDirectoryRead(t, workspace, 'EACCES');
        const base = { targetRoot: workspace.root, bundleRoot: workspace.bundleRoot };
        const refused = /Active task discovery is unknown/u;

        const diagnostic = /Active task discovery is unknown, so confirmed [a-z ]+ is refused[\s\S]*EACCES/u;
        const dryRuns = [
            runTaskRuntimePurge({ ...base, taskId: 'T-501' }),
            runTaskRuntimeBatchPurge({ ...base }),
            runCleanup({ ...base, dryRun: true }),
            runGc({ ...base })
        ];
        for (const dryRun of dryRuns) {
            assert.equal(dryRun.dryRun, true);
            assert.equal(dryRun.removed.length, 0);
            assert.equal(dryRun.result, 'PARTIAL', 'a dry run must not look clean while discovery is unknown');
            assert.ok(dryRun.errors.some(error => diagnostic.test(error.message)
                && path.resolve(error.path) === path.resolve(workspace.taskEventsDir)), JSON.stringify(dryRun.errors));
        }

        const activePreview = runTaskRuntimePurge({ ...base, taskId: 'T-500' });
        assert.equal(activePreview.activeTaskProtected, true);
        assert.equal(activePreview.result, 'PARTIAL', 'a known active task does not hide the incomplete discovery');
        assert.ok(activePreview.errors.some(error => diagnostic.test(error.message)), JSON.stringify(activePreview.errors));

        assert.throws(() => runTaskRuntimePurge({ ...base, taskId: 'T-501', confirm: true }), /task runtime purge is refused/u);
        assert.throws(() => runTaskRuntimeBatchPurge({ ...base, confirm: true }), /task runtime batch purge is refused/u);
        assert.throws(() => runCleanup({ ...base }), refused);
        assert.throws(() => runGc({ ...base, confirm: true }), /runtime gc is refused/u);
        assert.equal(fs.existsSync(planPath), true, 'no deletion may happen while discovery is unknown');
    });

    it('refuses a confirmed run when discovery becomes unknown after the check before the journal', (t) => {
        const operations: Array<[string, (base: { targetRoot: string; bundleRoot: string }) => unknown, RegExp]> = [
            ['single purge', base => runTaskRuntimePurge({ ...base, taskId: 'T-501', confirm: true }), /task runtime purge is refused/u],
            ['batch purge', base => runTaskRuntimeBatchPurge({ ...base, confirm: true }), /task runtime batch purge is refused/u],
            ['cleanup', base => runCleanup({ ...base }), /runtime cleanup is refused/u],
            ['gc', base => runGc({ ...base, confirm: true }), /runtime gc is refused/u]
        ];
        for (const [label, run, refusal] of operations) {
            const workspace = createWorkspace(t);
            const planPath = seedDoneTaskArtifact(workspace, 'T-501');
            fs.mkdirSync(workspace.taskEventsDir, { recursive: true });
            const original = fs.readdirSync;
            const target = path.resolve(workspace.taskEventsDir);
            let discoveryScans = 0;
            // The first discovery scan (before the journal) succeeds; the second one inside the run fails.
            const later = mock.method(fs, 'readdirSync', function (this: unknown, ...args: unknown[]) {
                if (typeof args[0] === 'string' && path.resolve(args[0]) === target
                    && String(new Error().stack).includes('collectRuntimeTaskState')) {
                    discoveryScans += 1;
                    if (discoveryScans > 1) {
                        throw Object.assign(new Error('EIO: simulated later task-events read failure'), { code: 'EIO' });
                    }
                }
                return (original as (...values: unknown[]) => unknown).apply(this, args);
            });
            try {
                assert.throws(() => run({ targetRoot: workspace.root, bundleRoot: workspace.bundleRoot }), refusal, label);
            } finally {
                later.mock.restore();
            }
            assert.equal(discoveryScans, 2, `${label} must check discovery again inside the run`);
            assert.equal(fs.existsSync(planPath), true, `${label} must not delete after the later failure`);
        }
    });

    it('does not refuse confirmed purges when the runtime is confirmed missing', (t) => {
        const workspace = createWorkspace(t);
        const base = { targetRoot: workspace.root, bundleRoot: workspace.bundleRoot, confirm: true };
        const single = runTaskRuntimePurge({ ...base, taskId: 'T-501' });
        assert.equal(single.result, 'SUCCESS');
        assert.equal(single.activeTaskProtected, false);
        const active = runTaskRuntimePurge({ ...base, taskId: 'T-500' });
        assert.equal(active.activeTaskProtected, true, 'TASK.md fallback still protects the queued active task');
        assert.doesNotThrow(() => runTaskRuntimeBatchPurge({ ...base }));
        const dryRun = runTaskRuntimePurge({ ...base, confirm: false, taskId: 'T-501' });
        assert.equal(dryRun.result, 'SUCCESS');
        assert.deepEqual(dryRun.errors, [], 'complete discovery adds no dry-run diagnostic');
    });

    it('refuses a confirmed purge through a linked runtime without task-events and keeps the link target intact', (t) => {
        const workspace = createWorkspace(t);
        const runtimeDir = path.join(workspace.bundleRoot, 'runtime');
        const foreignRuntime = path.join(workspace.root, 'foreign-runtime');
        const foreignPlan = path.join(foreignRuntime, 'plans', 'T-501.md');
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(foreignPlan), { recursive: true });
        fs.writeFileSync(foreignPlan, '# foreign plan\n', 'utf8');
        fs.symlinkSync(foreignRuntime, runtimeDir, process.platform === 'win32' ? 'junction' : 'dir');
        const base = { targetRoot: workspace.root, bundleRoot: workspace.bundleRoot };

        assert.throws(() => runTaskRuntimePurge({ ...base, taskId: 'T-501', confirm: true }), /task runtime purge is refused/u);
        assert.throws(() => runTaskRuntimeBatchPurge({ ...base, confirm: true }), /task runtime batch purge is refused/u);
        assert.throws(() => runCleanup({ ...base }), /runtime cleanup is refused/u);
        assert.throws(() => runGc({ ...base, confirm: true }), /runtime gc is refused/u);
        assert.equal(fs.existsSync(foreignPlan), true, 'a purge must not delete inside the link target');
        assert.deepEqual(fs.readdirSync(foreignRuntime).sort(), ['plans'],
            'a refused confirmed run must not write its mutation journal into the link target');
        const dryRun = runTaskRuntimePurge({ ...base, taskId: 'T-501' });
        assert.equal(dryRun.result, 'PARTIAL');
        assert.match(dryRun.errors.map(error => error.message).join('\n'), /absent under a linked runtime ancestor/u);
    });

    it('blocks task erasure preview when active task discovery is unknown', (t) => {
        const workspace = createWorkspace(t, [['T-501', 'DONE']]);
        failTaskEventsDirectoryRead(t, workspace, 'EIO');
        const preview = previewTaskErasure({ targetRoot: workspace.root, taskIds: ['T-501'] });
        assert.equal(preview.status, 'BLOCKED');
        const blocker = preview.blockers.find(item => item.code === 'ACTIVE_TASK_DISCOVERY_UNKNOWN');
        assert.ok(blocker, JSON.stringify(preview.blockers));
        assert.match(blocker.detail, /EIO/u);
    });
});
