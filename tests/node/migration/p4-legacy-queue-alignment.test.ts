import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCanonicalActiveTaskQueue } from '../../../src/core/task-md-table';
import { readTaskQueueStatusToken } from '../../../src/core/task-queue/task-queue-status';
import { buildTaskContentWithExistingQueue } from '../../../src/materialization/content-builders/content-builders-task-queue';
import { sourceRoot } from './p4-fixtures';

const template = fs.readFileSync(path.join(sourceRoot(), 'template/TASK.md'), 'utf8');
const header = '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |\n'
    + '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
const active = '| T-LEGACY | IN_PROGRESS | P1 | migration | Continue accepted work | agent:legacy | 2026-11-05 | balanced | keep \\| escaped note |';
const closed = '| T-CLOSED | DONE | P2 | migration | Historical task | agent:previous | 2026-11-04 | balanced | never reopen |';

test('P4/T-450-1-F1: alignment keeps every accepted headerless legacy owner and row field', () => {
    const input = `# Project tasks\n\nKeep user prose.\n\n${header}${active}\n${closed}\n\n## Local planning\nKeep this too.\n`;
    const before = parseCanonicalActiveTaskQueue(input);
    assert.deepEqual(before.rows.map(row => row.taskId), ['T-LEGACY', 'T-CLOSED'], 'legacy input must be accepted before alignment');
    const output = buildTaskContentWithExistingQueue(template, input)!;
    const after = parseCanonicalActiveTaskQueue(output);
    const fields = (row: typeof before.rows[number]) => row.cells.map((cell, index) => index === 1
        ? readTaskQueueStatusToken(cell.trimmed) : cell.trimmed);
    assert.deepEqual(after.rows.map(fields), before.rows.map(fields),
        'T-450-1-F1: alignment must not replace accepted owners with template T-001');
    assert.match(output, /Keep user prose[.]/u);
    assert.match(output, /## Local planning\nKeep this too[.]/u);
});

test('P4/T-441 §8.8: canonical active and closed tasks retain status through alignment', () => {
    const input = `# Project tasks\n\n## Active Queue\n\n${header}${active}\n${closed}\n\n## Local planning\nKeep prose.\n`;
    const output = buildTaskContentWithExistingQueue(template, input)!;
    const rows = parseCanonicalActiveTaskQueue(output).rows;
    assert.deepEqual(rows.map(row => [row.taskId, readTaskQueueStatusToken(row.status), row.owner]),
        [['T-LEGACY', 'IN_PROGRESS', 'agent:legacy'], ['T-CLOSED', 'DONE', 'agent:previous']]);
    assert.match(output, /Keep prose[.]/u);
});

test('P4/T-450-1-F1: ambiguous legacy queues refuse alignment with a repair route', () => {
    for (const input of [`${header}${active}\n${active}\n`, `${header}${active}\n\n${header}${closed}\n`,
        `${header}| T-BROKEN | IN_PROGRESS |\n`]) {
        assert.throws(() => buildTaskContentWithExistingQueue(template, input), /ambiguous.*(?:Fix|Keep).*retry/isu);
    }
});
