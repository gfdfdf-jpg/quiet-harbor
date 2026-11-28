import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildEnterTaskModeCommand } from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';
import {
    plannedFilesNeedOrchestratorWork,
    withProtectedEntryScopeHint
} from '../../../../src/gates/next-step/next-step-protected-entry-hint';
import { buildDefaultWorkflowConfig, resolveNextStep } from './next-step-test-support';

const TASK_ID = 'T-PROTECTED-ENTRY';

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Fresh task in a repository that is a Garda source checkout when `sourceCheckout` is set. */
function makeRepo(sourceCheckout: boolean): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-protected-entry-'));
    const bundle = path.join(repoRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundle, 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'src', 'cli'), { recursive: true });
    if (sourceCheckout) writeJson(path.join(repoRoot, 'package.json'), { name: 'garda-agent-orchestrator', version: '0.0.0' });
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md', '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | gates | Change the navigator | agent | 2026-11-21 | strict | Fixture. |`, ''
    ].join('\n'), 'utf8');
    writeJson(path.join(bundle, 'runtime', 'init-answers.json'), { SourceOfTruth: 'Codex' });
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.project_memory_maintenance.enabled = false;
    writeJson(path.join(bundle, 'live', 'config', 'workflow-config.json'), workflowConfig);
    writeJson(path.join(bundle, 'live', 'config', 'profiles.json'), {
        version: 1, active_profile: 'strict',
        built_in_profiles: { strict: { description: 'Strict fixture profile', depth: 3, task_decomposition: { enabled: true },
            review_policy: { code: 'auto', test: 'auto' }, token_economy: { enabled: false }, skills: { auto_suggest: true } } },
        user_profiles: {}
    });
    return repoRoot;
}

describe('gates/next-step protected task-mode entry scope', () => {
    it('uses the entry gate predicate for protected planned files', () => {
        assert.equal(plannedFilesNeedOrchestratorWork(process.cwd(), ['src/gates/next-step/next-step.ts']), true);
        assert.equal(plannedFilesNeedOrchestratorWork(process.cwd(), ['tests/node/example.test.ts', 'docs/x.md']), false);
    });

    it('declares orchestrator work when a scope upgrade adds protected files', () => {
        const taskMode = { planned_changed_files: ['tests/task.test.ts'], task_summary: 'Verify task behavior',
            provider: 'Codex', requested_depth: 2, orchestrator_work: false };
        const widened = buildEnterTaskModeCommand(process.cwd(), 'garda', 'T-UPGRADE', null, 'Codex', taskMode, [],
            ['tests/task.test.ts', 'src/cli/commands/repair.ts']);
        for (const flag of ['--upgrade-existing-task-mode', '--orchestrator-work', '--operator-confirmed yes',
            '--operator-confirmed-at-utc "<ISO-8601 timestamp>"', '--planned-changed-file "src/cli/commands/repair.ts"']) {
            assert.ok(widened.includes(flag), widened);
        }
        const unprotected = buildEnterTaskModeCommand(process.cwd(), 'garda', 'T-UPGRADE', null, 'Codex', taskMode, [],
            ['tests/task.test.ts', 'tests/other.test.ts']);
        assert.doesNotMatch(unprotected, /--orchestrator-work/u);
    });

    it('explains protected entry scope only for an entry command without the flag', () => {
        const route = { reason: 'No TASK_MODE_ENTERED event exists for this task.',
            commands: [{ label: 'Enter task mode', command: 'garda gate enter-task-mode --task-id "T"' }] };
        const hinted = withProtectedEntryScopeHint(process.cwd(), route);
        assert.match(hinted.reason, /^No TASK_MODE_ENTERED event exists for this task\. If your planned files include protected orchestrator files/u);
        assert.match(hinted.reason, /src\/cli\//u);
        assert.match(hinted.reason, /ask the operator to confirm orchestrator work/u);
        assert.match(hinted.reason, /--orchestrator-work --operator-confirmed yes --operator-confirmed-at-utc/u);
        assert.deepEqual(hinted.commands, route.commands);
        const declared = { ...route, commands: [{ label: 'Enter', command: `${route.commands[0].command} --orchestrator-work` }] };
        assert.equal(withProtectedEntryScopeHint(process.cwd(), declared), declared);
        const other = { ...route, commands: [{ label: 'Load rules', command: 'garda gate load-rule-pack --task-id "T"' }] };
        assert.equal(withProtectedEntryScopeHint(process.cwd(), other), other);
    });

    it('states the protected scope requirement before the first entry call in a source checkout', t => {
        const repoRoot = makeRepo(true);
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.next_gate, 'enter-task-mode');
        assert.match(result.reason, /If your planned files include protected orchestrator files \(for example [^)]*src\/cli\//u);
        assert.match(result.reason, /Never supply the confirmation without the operator's answer\./u);
        assert.match(result.commands[0].command, /gate enter-task-mode/u);
        assert.doesNotMatch(result.commands[0].command, /--orchestrator-work/u);
    });

    it('adds no protected entry hint where the self-guard refuses agent orchestrator work', t => {
        const repoRoot = makeRepo(false);
        t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.next_gate, 'enter-task-mode');
        assert.doesNotMatch(result.reason, /protected orchestrator files/u);
    });
});
