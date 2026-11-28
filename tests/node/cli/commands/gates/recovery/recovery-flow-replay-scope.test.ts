import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';

import {
    getEffectiveDepthFromPreflight,
    getReviewCyclePrePreflightRefreshPlan,
    resolveReplayScope,
    resolveReviewCycleReplayScope
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-replay-scope';

describe('cli/commands/gate-flows/recovery replay scope', () => {
    it('retains declared audit targets independently of coherent restart classification scope', () => {
        const targets = ['tests/PartnerCrmDraftPostgresIntegrationTest.java', 'tests/PartnerIsolationPostgresIntegrationTest.java'];
        const previousMode = { planned_changed_files: targets };
        const previousPreflight = { detection_source: 'explicit_changed_files', changed_files: [] };
        const replay = resolveReplayScope({}, previousPreflight as never, previousMode);

        assert.deepEqual(replay.plannedChangedFiles, targets);
        assert.deepEqual(replay.changedFiles, []);
        assert.equal(replay.detectionSource, 'explicit_changed_files');

        const emptyExplicit = resolveReplayScope({ changedFiles: [] }, previousPreflight as never, previousMode);
        assert.deepEqual(emptyExplicit.plannedChangedFiles, targets);
        assert.deepEqual(emptyExplicit.changedFiles, []);
        const emptyAuto = resolveReplayScope({}, { detection_source: 'git_auto_current_workspace', changed_files: [] } as never, previousMode);
        assert.deepEqual(emptyAuto.plannedChangedFiles, targets);
        assert.equal(emptyAuto.changedFiles, undefined);
    });

    it('retains declarations with explicit or staged changed files without classifying declarations as edits', () => {
        const previousMode = { planned_changed_files: ['tests/unchanged.test.ts'] };
        const previousPreflight = {
            detection_source: 'git_auto_current_workspace', changed_files: ['src/previous.ts'], include_untracked: false
        };
        const explicit = resolveReplayScope({ changedFiles: ['src/new.ts'] }, previousPreflight as never, previousMode);
        assert.deepEqual(explicit.plannedChangedFiles, ['src/new.ts', 'tests/unchanged.test.ts']);
        assert.deepEqual(explicit.changedFiles, ['src/new.ts']);
        const staged = resolveReplayScope({ useStaged: true }, previousPreflight as never, previousMode);
        assert.deepEqual(staged.plannedChangedFiles, ['src/previous.ts', 'tests/unchanged.test.ts']);
        assert.equal(staged.changedFiles, undefined);
        assert.equal(staged.useStaged, true);
    });

    it('honors explicit empty scope and staged options before previous detection source', () => {
        const previousPreflight = {
            detection_source: 'git_staged_plus_untracked',
            changed_files: ['src/previous.ts'],
            include_untracked: true
        };

        assert.deepEqual(resolveReplayScope({ changedFiles: [] }, previousPreflight as never), {
            plannedChangedFiles: [],
            changedFiles: [],
            detectionSource: 'explicit_changed_files'
        });
        assert.deepEqual(resolveReplayScope({ useStaged: true, includeUntracked: false }, previousPreflight as never), {
            plannedChangedFiles: ['src/previous.ts'],
            useStaged: true,
            includeUntracked: false,
            detectionSource: 'git_staged_only'
        });
        assert.deepEqual(resolveReplayScope({}, {
            detection_source: 'git_auto_current_workspace',
            changed_files: []
        } as never), {
            plannedChangedFiles: [],
            changedFiles: undefined,
            detectionSource: 'git_auto_current_workspace'
        });
    });

    it('uses current workspace for a clean review restart and preserves explicit staged replay', () => {
        const previousPreflight = {
            detection_source: 'explicit_changed_files',
            changed_files: ['src/previous.ts'],
            include_untracked: false
        };
        const cleanTaskMode = { dirty_workspace_baseline: { changed_files: [] } };

        assert.deepEqual(resolveReviewCycleReplayScope({}, previousPreflight as never, cleanTaskMode as never), {
            plannedChangedFiles: ['src/previous.ts'],
            changedFiles: undefined,
            detectionSource: 'git_auto_current_workspace'
        });
        assert.deepEqual(resolveReviewCycleReplayScope(
            { useStaged: true, includeUntracked: true },
            previousPreflight as never,
            cleanTaskMode as never
        ), {
            plannedChangedFiles: ['src/previous.ts'],
            useStaged: true,
            includeUntracked: true,
            detectionSource: 'git_staged_plus_untracked'
        });
    });

    it('prefers risk-aware depth and falls back to task-mode depth', () => {
        const taskMode = { effective_depth: 2, requested_depth: 1 };
        assert.equal(getEffectiveDepthFromPreflight(taskMode as never, {
            preflight: { risk_aware_depth: { effective_depth: 3 } }
        } as never), 3);
        assert.equal(getEffectiveDepthFromPreflight(taskMode as never, { preflight: {} } as never), 2);
    });

    it('plans startup replay from ordered events and rejects shell smoke without handshake', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-replay-scope-'));
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        try {
            assert.deepEqual(getReviewCyclePrePreflightRefreshPlan(repoRoot, 'T-101'), {
                rerunHandshakeDiagnostics: true,
                rerunShellSmokePreflight: true
            });
            appendTaskEvent(orchestratorRoot, 'T-101', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'PASS', 'Handshake ready.', {});
            assert.deepEqual(getReviewCyclePrePreflightRefreshPlan(repoRoot, 'T-101'), {
                rerunHandshakeDiagnostics: false,
                rerunShellSmokePreflight: true
            });
            appendTaskEvent(orchestratorRoot, 'T-101', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PASS', 'Shell ready.', {});
            assert.deepEqual(getReviewCyclePrePreflightRefreshPlan(repoRoot, 'T-101'), {
                rerunHandshakeDiagnostics: false,
                rerunShellSmokePreflight: false
            });

            appendTaskEvent(orchestratorRoot, 'T-102', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PASS', 'Shell without handshake.', {});
            assert.throws(
                () => getReviewCyclePrePreflightRefreshPlan(repoRoot, 'T-102'),
                /SHELL_SMOKE_PREFLIGHT_RECORDED without matching HANDSHAKE_DIAGNOSTICS_RECORDED/u
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('permits verified lost-context recovery past a review gate but never past completion', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-replay-lost-context-'));
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        try {
            appendTaskEvent(orchestratorRoot, 'T-103', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'PASS', 'Handshake ready.', {});
            appendTaskEvent(orchestratorRoot, 'T-103', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PASS', 'Shell ready.', {});
            appendTaskEvent(orchestratorRoot, 'T-103', 'REVIEW_GATE_PASSED', 'PASS', 'Reviews passed.', {});
            assert.throws(() => getReviewCyclePrePreflightRefreshPlan(repoRoot, 'T-103'), /already reached 'REVIEW_GATE_PASSED'/u);
            assert.deepEqual(getReviewCyclePrePreflightRefreshPlan(repoRoot, 'T-103', { verifiedLostReviewContextRecovery: true }), {
                rerunHandshakeDiagnostics: false, rerunShellSmokePreflight: false
            });
            appendTaskEvent(orchestratorRoot, 'T-103', 'COMPLETION_GATE_PASSED', 'PASS', 'Completed.', {});
            assert.throws(() => getReviewCyclePrePreflightRefreshPlan(repoRoot, 'T-103', { verifiedLostReviewContextRecovery: true }),
                /already reached 'COMPLETION_GATE_PASSED'/u);
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('preserves dirty-baseline task-owned scope when restarting a coherent cycle', () => {
        const previousPreflight = {
            detection_source: 'git_auto_current_workspace',
            changed_files: [
                'src/gates/task-owned.ts',
                'src/local-baseline.ts',
                'src/notes/untouched-baseline.md'
            ],
            triggers: {
                dirty_workspace_task_owned_files: ['src/gates/task-owned.ts'],
                dirty_workspace_untouched_baseline_files: [
                    'src/local-baseline.ts',
                    'src/notes/untouched-baseline.md'
                ]
            }
        };

        const replayScope = resolveReplayScope({}, previousPreflight as never);

        assert.deepEqual(replayScope.plannedChangedFiles, ['src/gates/task-owned.ts']);
        assert.deepEqual(replayScope.changedFiles, ['src/gates/task-owned.ts']);
        assert.equal(replayScope.detectionSource, 'explicit_changed_files');
    });

    it('preserves previous changed files when replay triggers omit dirty-baseline arrays', () => {
        const previousPreflight = {
            detection_source: 'git_auto_current_workspace',
            changed_files: [
                'src/gates/task-owned.ts',
                'src/local-baseline.ts'
            ],
            triggers: {
                unrelated_recovery_trigger: true
            }
        };

        const replayScope = resolveReplayScope({}, previousPreflight as never);

        assert.deepEqual(replayScope.plannedChangedFiles, [
            'src/gates/task-owned.ts',
            'src/local-baseline.ts'
        ]);
        assert.deepEqual(replayScope.changedFiles, [
            'src/gates/task-owned.ts',
            'src/local-baseline.ts'
        ]);
        assert.equal(replayScope.detectionSource, 'explicit_changed_files');
    });

    it('preserves dirty-baseline task-owned scope when restarting a review cycle', () => {
        const previousPreflight = {
            detection_source: 'git_auto_current_workspace',
            changed_files: [
                'src/gates/task-owned.ts',
                'src/local-baseline.ts',
                'src/notes/untouched-baseline.md'
            ],
            triggers: {
                dirty_workspace_task_owned_files: ['src/gates/task-owned.ts'],
                dirty_workspace_untouched_baseline_files: [
                    'src/local-baseline.ts',
                    'src/notes/untouched-baseline.md'
                ]
            }
        };
        const previousTaskMode = {
            dirty_workspace_baseline: {
                changed_files: [
                    'src/local-baseline.ts',
                    'src/notes/untouched-baseline.md'
                ]
            }
        };

        const replayScope = resolveReviewCycleReplayScope(
            {},
            previousPreflight as never,
            previousTaskMode as never
        );

        assert.deepEqual(replayScope.plannedChangedFiles, ['src/gates/task-owned.ts']);
        assert.deepEqual(replayScope.changedFiles, ['src/gates/task-owned.ts']);
        assert.equal(replayScope.detectionSource, 'explicit_changed_files');
    });
});
