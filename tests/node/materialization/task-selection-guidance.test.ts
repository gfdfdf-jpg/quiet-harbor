import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { migrateLegacyTaskTestSelectionGuidance } from '../../../src/materialization/rule-materialization';
import { assertGenericTaskEventAdmission } from '../../../src/gate-runtime/timeline/task-event-generic-admission';

const legacy = '- `garda workflow set` is a guarded workflow-config mutation surface and requires separate explicit operator approval with `--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`; agents must not approve workflow-config mutations for themselves.';
const template = fs.readFileSync(path.join(getRepoRoot(), 'template/docs/agent-rules/80-task-workflow.md'), 'utf8');

test('task-selection guidance migrates only the exact legacy sentence and preserves custom text', () => {
    for (const newline of ['\n', '\r\n']) {
        const input = ['User heading', legacy, legacy + ' custom rule', 'Quote: ' + legacy, 'User footer $&'].join(newline);
        const migrated = migrateLegacyTaskTestSelectionGuidance(input, template);
        assert.ok(migrated.includes('task_test_selection.require_operator_confirmation'));
        assert.ok(migrated.includes(legacy + ' custom rule'));
        assert.ok(migrated.includes('Quote: ' + legacy));
        assert.ok(migrated.endsWith('User footer $&'));
        assert.equal(migrateLegacyTaskTestSelectionGuidance(migrated, template), migrated);
        assert.equal(migrateLegacyTaskTestSelectionGuidance(input, 'Missing replacement'), input);
        if (newline === '\r\n') assert.equal(migrated.replaceAll('\r\n', '').includes('\n'), false);
    }
});

test('shipped workflow rules direct blocked work through the navigator instead of reserved event logging', () => {
    assert.doesNotMatch(template, /Log terminal event:/);
    assert.match(template, /run it before the first gate, after every suggested command, and after any gate failure/);
    assert.match(template, /task_test_selection.require_operator_confirmation/);
    // Terminal lifecycle events are gate-owned: log-task-event refuses them instead of relying on prose.
    for (const eventType of ['TASK_DONE', 'TASK_BLOCKED']) {
        assert.throws(() => assertGenericTaskEventAdmission(eventType), /is reserved and cannot be emitted via log-task-event/);
    }
});
