import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTaskQueueActiveStatus, isTaskQueueDoneStatus, resolveActiveTaskIds } from '../../../../src/core/active-task-state';
import { splitCommandLine } from '../../../../src/core/command-line';
import { resolveTaskResetAvailability } from '../../../../src/core/task-reset-availability';
import { formatNextStepText } from '../../../../src/gates/next-step/next-step';
import { readParentQueue } from '../../../../src/gates/parent-audit/parent-audit-contract';
import { writeProtectedControlPlaneManifest } from '../../../../src/gates/protected-control-plane/protected-control-plane';
import type { WalkScenario } from './navigator-walk';
import { nativeOwnerClockOffset } from './walk-clock';
import { nativeWalkCommand } from './walk-native';
import { RECOVERY_COVERAGE_WALK_SCENARIOS } from './walk-recovery-coverage-scenarios';

const BUNDLE = 'garda-agent-orchestrator';
const VERSION = BUNDLE + '/VERSION';
const UPDATE_SOURCE = '.git/walk-update-source';
const IDLE_WALK = {
    edits: [], expectedReviews: {}, expectedModes: [], expectedBlockedGate: 'enter-task-mode',
    expectedGuidance: /No TASK_MODE_ENTERED event exists for this task/u
} satisfies Partial<WalkScenario>;

function seedUpdate(root: string): void {
    const source = path.join(root, UPDATE_SOURCE);
    fs.mkdirSync(source);
    // The bundle already contains the candidate runtime. A local version payload drives real sync and materialization.
    fs.copyFileSync(path.join(root, VERSION), path.join(source, 'VERSION'));
    fs.writeFileSync(path.join(root, VERSION), '1.4.3\n');
}

function runCli(root: string, args: string[]) {
    const child = spawnSync(process.execPath, args,
        { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    return { exitCode: child.status, output: child.stdout, error: child.stderr };
}

function update(root: string) {
    // Lifecycle lock handoff binds wall-clock time to the CLI process's real start time.
    return runCli(root, [path.join(root, BUNDLE, 'bin/garda.js'), 'update',
        '--source-path', path.join(root, UPDATE_SOURCE), '--trust-override', '--no-prompt', '--json']);
}

function assertApplied(root: string): void {
    const applied = update(root);
    assert.equal(applied.exitCode, 0, applied.error || applied.output);
    const result = JSON.parse(applied.output) as { updateApplied: boolean; updateReportPath: string };
    assert.equal(result.updateApplied, true, applied.output);
    assert.match(result.updateReportPath, /^garda-agent-orchestrator\/runtime\/update-reports\/update-[\w-]+\.md$/u);
    const report = fs.readFileSync(path.join(root, result.updateReportPath), 'utf8');
    assert.match(report, /^Materialization: PASS$/mu);
    assert.match(report, /^Verify: PASS$/mu);
    assert.deepEqual(fs.readFileSync(path.join(root, VERSION)), fs.readFileSync(path.join(root, UPDATE_SOURCE, 'VERSION')));
    assert.ok(fs.readdirSync(path.join(root, BUNDLE, 'runtime/bundle-backups')).length > 0);
}

/** Cover every project entry, including the installed bundle and its ignored runtime backups. */
function projectDigest(root: string): string {
    const hash = createHash('sha256');
    const visit = (relative: string): void => {
        for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(relative, entry.name);
            hash.update(JSON.stringify([file, entry.isDirectory() ? 'directory' : createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
            if (entry.isDirectory()) visit(file);
        }
    };
    visit('');
    return hash.digest('hex');
}

export function activeUpdateFieldScenario(): WalkScenario {
    let refused = false;
    return {
        id: 'field-r144-update-active-task',
        disturbanceReason: '06e0fa24: apply an update during an active task and retry after native DONE.',
        profile: 'docs-only',
        edits: [{ path: 'docs/guide.md', append: '\nDescribe the status renderer.\n' }],
        expectedReviews: {}, expectedModes: [], enforceReviewExpectations: true,
        setup: root => {
            refused = false;
            seedUpdate(root);
        },
        prepare: async (root, steps) => {
            const last = steps.at(-1);
            if (refused || last?.gate !== 'enter-task-mode' || last.exitCode !== 0) return;
            assert.match(readParentQueue(root).entries.get('T-WALK')?.status ?? '', /\bIN_PROGRESS\b/u);
            const before = projectDigest(root);
            const blocked = update(root);
            assert.notEqual(blocked.exitCode, 0, 'An active task must refuse update: ' + blocked.output);
            assert.match(blocked.error + blocked.output, /Finish task T-WALK .*on the current Garda version, then run update again[.]/u);
            assert.equal(projectDigest(root), before, 'Refusal must precede any backup or materialization');
            refused = true;
        },
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'done', result.detail);
            assert.match(readParentQueue(root).entries.get('T-WALK')?.status ?? '', /\bDONE\b/u);
            assert.ok(refused, 'The same project first refused the update while active');
            assertApplied(root);
        }
    };
}

export function draftUpdateFieldScenario(): WalkScenario {
    return {
        ...IDLE_WALK,
        id: 'field-r144-update-draft-status',
        disturbanceReason: 'e055ed71: an idle project retains its own DRAFT queue status during update.',
        setup: root => fs.appendFileSync(path.join(root, 'TASK.md'),
            '| T-DRAFT | DRAFT | P1 | testing | Draft status behavior | fixture | 2026-11-26 | balanced | Project-specific planning status. |\n'),
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'blocked', result.detail);
            seedUpdate(root);
            assert.equal(readParentQueue(root).entries.get('T-DRAFT')?.status, 'DRAFT');
            assertApplied(root);
            assert.equal(readParentQueue(root).entries.get('T-DRAFT')?.status, 'DRAFT');
        }
    };
}

export function reviewCycleMarkBlockedFieldScenario(): WalkScenario {
    const guard = RECOVERY_COVERAGE_WALK_SCENARIOS.find(scenario => scenario.id === 'coverage-review-cycle-attempt-guard');
    assert.ok(guard);
    let guidance = '';
    return {
        ...guard,
        id: 'field-r144-review-cycle-mark-blocked',
        disturbanceReason: 'Dead-end A: follow the review-cycle guard instructions to stop an active attempt with reset initially disabled.',
        enforceReviewExpectations: true,
        setup: () => { guidance = ''; },
        inspectNavigation: result => {
            if (result.next_gate === 'review-cycle-attempt-guard') {
                guidance = formatNextStepText(result).split('\n').find(line => line.startsWith('  - mark_blocked:')) ?? '';
            }
        },
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'blocked', result.detail);
            assert.equal(result.steps.at(-1)?.gate, 'review-cycle-attempt-guard');
            assert.equal(resolveTaskResetAvailability(root).enabled, false);
            const bundleRoot = path.join(root, BUNDLE);
            assert.ok(resolveActiveTaskIds(root, bundleRoot).has('T-WALK'));
            const commands = /(?<enable>node .*? workflow set .*?) with the UTC timestamp of approval\. Then run (?<reset>node .*? gate task-reset .+)$/u
                .exec(guidance)?.groups;
            assert.ok(commands, 'Expected both executable mark_blocked commands. Printed guidance: ' + guidance);
            const approvalTime = new Date(Date.now() - nativeOwnerClockOffset()).toISOString();
            for (const command of [commands.enable.replace('<ISO-8601 timestamp>', approvalTime), commands.reset]) {
                const [executable, ...args] = splitCommandLine(command);
                assert.equal(executable, 'node');
                const run = runCli(root, args);
                assert.equal(run.exitCode, 0, run.error || run.output);
                if (command !== commands.reset) assert.equal(resolveTaskResetAvailability(root).enabled, true);
            }
            assert.match(readParentQueue(root).entries.get('T-WALK')?.status ?? '', /\bTODO\b/u);
            assert.equal(resolveActiveTaskIds(root, bundleRoot).has('T-WALK'), false);
        }
    };
}

export function closedTaskUpdateFieldScenario(): WalkScenario {
    return {
        ...IDLE_WALK,
        id: 'field-r144-update-operator-closed-task',
        disturbanceReason: 'Dead-end B: an operator closes a task in TASK.md while its native runtime is still active.',
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'blocked', result.detail);
            const queuePath = path.join(root, 'TASK.md');
            const bundleRoot = path.join(root, BUNDLE);
            const queueTask = readParentQueue(root).entries.get('T-WALK');
            assert.ok(queueTask?.title);
            const entered = runCli(root, [path.join(bundleRoot, 'bin/garda.js'), 'gate', 'enter-task-mode',
                '--task-id', 'T-WALK', '--provider', 'Codex', '--entry-mode', 'EXPLICIT_TASK_EXECUTION',
                '--requested-depth', '2', '--task-summary', queueTask.title, '--planned-changed-file', 'docs/guide.md',
                '--repo-root', '.']);
            assert.equal(entered.exitCode, 0, entered.error || entered.output);
            assert.ok(isTaskQueueActiveStatus(readParentQueue(root).entries.get('T-WALK')?.status ?? null));
            const timelinePath = path.join(bundleRoot, 'runtime/task-events/T-WALK.jsonl');
            const activeTimeline = fs.readFileSync(timelinePath);
            const queue = fs.readFileSync(queuePath, 'utf8');
            fs.writeFileSync(queuePath, queue.replace(/^(\| T-WALK \|)[^|]+/mu, '$1 DONE '));
            assert.equal(readParentQueue(root).entries.get('T-WALK')?.status, 'DONE');
            assert.deepEqual(fs.readFileSync(timelinePath), activeTimeline);
            assert.ok(resolveActiveTaskIds(root, bundleRoot).has('T-WALK'));
            seedUpdate(root);
            assertApplied(root);
            assert.ok(isTaskQueueDoneStatus(readParentQueue(root).entries.get('T-WALK')?.status ?? null));
        }
    };
}

export function workflowNoChangeScenario(): WalkScenario {
    return {
        ...IDLE_WALK,
        id: 'field-r144-workflow-set-no-change',
        disturbanceReason: '7e157d09: reorder a set of optional-quality regexes and request the existing workflow setting.',
        inspectResult: (root, result) => {
            assert.equal(result.outcome, 'blocked', result.detail);
            const file = path.join(root, BUNDLE, 'live/config/workflow-config.json');
            const audit = path.join(root, BUNDLE, 'runtime/workflow-config-audit.jsonl');
            const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
                parent_audit: { enabled: boolean };
                optional_quality_checks: { rules: { id: string; included_changed_file_regexes?: string[] }[] };
            };
            const regexes = config.optional_quality_checks.rules.find(rule => rule.id === 'ops_shell_strict_error_handling')?.included_changed_file_regexes;
            assert.ok(regexes && new Set(regexes).size > 1);
            regexes.sort().reverse();
            const before = JSON.stringify(config, null, 2) + '\n';
            fs.writeFileSync(file, before);
            writeProtectedControlPlaneManifest(root);
            const readAudit = () => fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8') : null;
            const auditBefore = readAudit();
            const set = (enabled: boolean, confirmation: string[] = []) =>
                nativeWalkCommand(['workflow', 'set', '--parent-audit-enabled', String(enabled), '--json', ...confirmation]);

            const same = set(config.parent_audit.enabled);
            assert.equal(same.exitCode, 0, 'A normalized no-op needs no operator confirmation: ' + same.output);
            const noChange = JSON.parse(same.output) as { status: string; changed_fields: string[]; audit_path: string | null };
            assert.equal(noChange.status, 'NO_CHANGE');
            assert.deepEqual(noChange.changed_fields, []);
            assert.equal(noChange.audit_path, null);
            assert.equal(fs.readFileSync(file, 'utf8'), before);
            assert.equal(readAudit(), auditBefore);

            assert.equal(config.parent_audit.enabled, false);
            const refused = set(true);
            assert.notEqual(refused.exitCode, 0);
            assert.match(refused.output, /Ask the operator to approve this workflow-config mutation/u);
            assert.equal(fs.readFileSync(file, 'utf8'), before);
            assert.equal(readAudit(), auditBefore);

            const confirmed = set(true, ['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()]);
            assert.equal(confirmed.exitCode, 0, confirmed.output);
            const changed = JSON.parse(confirmed.output) as { status: string; changed_fields: string[]; audit_path: string | null };
            assert.equal(changed.status, 'CHANGED');
            assert.deepEqual(changed.changed_fields, ['parent_audit.enabled']);
            assert.ok(changed.audit_path);
            const auditAfter = fs.readFileSync(audit, 'utf8');
            assert.ok(auditAfter.startsWith(auditBefore ?? ''));
            assert.equal(auditAfter.slice(auditBefore?.length ?? 0).trim().split('\n').filter(Boolean).length, 1);
        }
    };
}
