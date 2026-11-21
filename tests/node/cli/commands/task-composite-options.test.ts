import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';
import { runGit } from './gate-test-helpers';
import {
    PROVIDER_ARGS,
    TASK_ID,
    cli,
    countEvents,
    createCompositeFixture,
    type CompositeFixture
} from './task-composite-test-fixture';

const WORKFLOW_CONFIG = `${DEFAULT_BUNDLE_NAME}/live/config/workflow-config.json`;

let fixture: CompositeFixture;

function readTaskMode(repoRoot: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(
        path.join(repoRoot, DEFAULT_BUNDLE_NAME, 'runtime', 'reviews', `${TASK_ID}-task-mode.json`), 'utf8')) as Record<string, unknown>;
}

/** A Garda source checkout lets agents declare protected work once the operator has confirmed it. */
function cloneSourceCheckout(): string {
    const repoRoot = fixture.clone();
    fs.writeFileSync(path.join(repoRoot, 'package.json'), `${JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2)}\n`);
    runGit(repoRoot, ['add', 'package.json']);
    runGit(repoRoot, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source checkout']);
    return repoRoot;
}

describe('task <id> start option forwarding and failure exit', { concurrency: false }, () => {
    before(async () => { fixture = await createCompositeFixture(); });
    after(() => fixture.dispose());

    it('forwards the requested depth and task summary into the task-mode evidence', async () => {
        const repoRoot = fixture.clone();
        const result = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, '--requested-depth', '3', '--task-summary', 'Explicit agent summary']);
        assert.equal(result.exitCode, 0, result.text);
        const taskMode = readTaskMode(repoRoot);
        assert.equal(taskMode.requested_depth, 3);
        assert.equal(taskMode.task_summary, 'Explicit agent summary');
        assert.equal(taskMode.orchestrator_work, false);
    });

    it('forwards --orchestrator-work with the operator confirmation, and refuses the entry without that confirmation', async () => {
        const repoRoot = cloneSourceCheckout();
        const planned = ['--planned-changed-file', 'AGENTS.md'];
        const unconfirmed = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, ...planned, '--orchestrator-work']);
        assert.notEqual(unconfirmed.exitCode, 0, unconfirmed.text);
        assert.match(unconfirmed.text, /Outcome: FAILED/u);
        assert.match(unconfirmed.text, /FailedGate: enter-task-mode/u);
        assert.match(unconfirmed.text, /operator-confirmed/u);
        assert.doesNotMatch(unconfirmed.text, /requires --orchestrator-work/u, 'the flag reached the entry gate');
        assert.equal(countEvents(repoRoot, 'TASK_MODE_ENTERED'), 0);
        const confirmed = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, ...planned, '--orchestrator-work',
            '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
        assert.equal(confirmed.exitCode, 0, confirmed.text);
        assert.match(confirmed.text, /1\. enter-task-mode: PASS/u);
        assert.equal(readTaskMode(repoRoot).orchestrator_work, true);
        assert.equal(countEvents(repoRoot, 'TASK_MODE_ENTERED'), 1);
    });

    it('forwards --workflow-config-work to the entry gate, which then asks for trusted task ownership', async () => {
        const repoRoot = cloneSourceCheckout();
        const common = ['task', TASK_ID, 'start', ...PROVIDER_ARGS, '--planned-changed-file', WORKFLOW_CONFIG, '--orchestrator-work',
            '--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()];
        const withoutFlag = await cli(repoRoot, common);
        assert.notEqual(withoutFlag.exitCode, 0, withoutFlag.text);
        assert.match(withoutFlag.text, /--workflow-config-work/u);
        const withFlag = await cli(repoRoot, [...common, '--workflow-config-work']);
        assert.notEqual(withFlag.exitCode, 0, withFlag.text);
        assert.match(withFlag.text, /FailedGate: enter-task-mode/u);
        assert.match(withFlag.text, /trusted TASK\.md metadata/u);
        assert.equal(countEvents(repoRoot, 'TASK_MODE_ENTERED'), 0);
    });

    it('a failed entry exits non-zero with the failure block and the navigator recovery line', async () => {
        const repoRoot = cloneSourceCheckout();
        const result = await cli(repoRoot, ['task', TASK_ID, 'start', ...PROVIDER_ARGS, '--planned-changed-file', 'AGENTS.md',
            '--orchestrator-work', '--as-json']);
        assert.notEqual(result.exitCode, 0, result.text);
        const parsed = JSON.parse(result.text) as { outcome: string; failed: { gate: string; error: string | null } | null; completed: unknown[] };
        assert.equal(parsed.outcome, 'FAILED');
        assert.equal(parsed.failed?.gate, 'enter-task-mode');
        assert.match(parsed.failed?.error ?? '', /operator-confirmed/u, 'the refusal text is carried in the report');
        assert.deepEqual(parsed.completed, []);
    });
});
