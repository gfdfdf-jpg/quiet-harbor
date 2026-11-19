import type { NextStepResult } from '../../../../src/gates/next-step';

export const LONG_TEST_COMMAND = `npm run test:sharded -- ${Array.from({ length: 12 }, (_, index) => `tests/node/suite-${index}.test.ts`).join(' ')}`;
export const COMPILE_COMMAND = 'node bin/garda.js gate compile-gate --task-id "T-TEXT-1" '
    + Array.from({ length: 20 }, (_, index) => `--changed-file "src/module-${index}.ts"`).join(' ')
    + ' --preflight-path "garda-agent-orchestrator/runtime/reviews/T-TEXT-1-preflight.json" --repo-root "."';

export function buildResult(overrides: Partial<NextStepResult> = {}): NextStepResult {
    return {
        schema_version: 1,
        task_id: 'T-TEXT-1',
        generated_utc: '2026-11-16T00:00:00.000Z',
        navigator_command: 'node bin/garda.js next-step "T-TEXT-1" --repo-root "."',
        status: 'BLOCKED',
        next_gate: 'compile-gate',
        title: 'Run compile gate for the current preflight.',
        reason: 'Compile evidence is missing for the current preflight.',
        commands: [{ label: 'Run compile gate', command: COMPILE_COMMAND }],
        missing_artifacts: [{ key: 'compile-gate', path: 'garda-agent-orchestrator/runtime/reviews/T-TEXT-1-compile-gate.json', exists: false }],
        present_artifacts: [{ key: 'preflight', path: 'garda-agent-orchestrator/runtime/reviews/T-TEXT-1-preflight.json', exists: true }],
        full_suite_validation: {
            enabled: true,
            command: LONG_TEST_COMMAND,
            placement: 'after_compile_before_reviews',
            config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
            config_source: 'task_test_selection',
            note: 'Task test selection is current.',
            performance_guidance_note: `mode=optimized_sharded; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="${LONG_TEST_COMMAND}"`
        },
        project_memory: null,
        review: {
            required_reviews: ['code', 'test'],
            review_execution_policy_mode: 'strict_sequential',
            review_execution_policy_source: 'preflight',
            review_finding_policy_id: 'balanced',
            review_finding_policy_source: 'preflight_profile_policy_snapshot',
            review_finding_policy_actions: {
                critical: 'fix_now', high: 'fix_now', medium: 'fix_now', low: 'create_follow_up', residual_risk: 'create_follow_up'
            },
            launchable_review_types: ['code'],
            blocked_review_lanes: [{ review_type: 'test', blocked_by: ['code'], reason: 'Waiting for code.' }],
            failed_review_type: null,
            next_review_type: 'code',
            blocked_review_dependencies: [],
            ordinary_doc_review_skips: [],
            trust: null,
            trust_note: null
        },
        task_queue_status_contract: {
            visible_summary_line: 'Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE.'
        } as NextStepResult['task_queue_status_contract'],
        audit_status: 'INCOMPLETE',
        profile: null,
        markdown_working_plan: null,
        optional_skill_selection: null,
        task_start_guidance: null,
        quality_checklist: null,
        warnings: [],
        invalidation_impact: null,
        known_non_blocking_signals: [],
        review_cycle_block: null,
        final_report: null,
        ...overrides
    };
}


export function buildReviewCycleBlock(): NonNullable<NextStepResult['review_cycle_block']> {
    return {
        kind: 'review_cycle_guard',
        operator_decision_required: true,
        wait_for_operator: true,
        auto_split_enabled: false,
        reason: 'Failed non-test reviews reached the configured limit.',
        max_failed_non_test_reviews: 2,
        max_total_non_test_reviews: 6,
        total_non_test_review_count: 4,
        failed_non_test_review_count: 2,
        counts_by_review_type: { code: { total: 4, failed: 2, passed: 2, pending: 0 } },
        cumulative_total_non_test_review_count: 4,
        cumulative_failed_non_test_review_count: 2,
        current_scope_total_non_test_review_count: 2,
        current_scope_failed_non_test_review_count: 1,
        current_scope_counts_by_review_type: { code: { total: 2, failed: 1, passed: 1, pending: 0 } },
        fresh_non_test_review_count: 4,
        reused_non_test_review_count: 0,
        fresh_reused_by_review_type: { code: { fresh: 4, reused: 0 } },
        scope_hash_count_by_review_type: { code: 1 },
        top_scope_hashes_by_review_type: {
            code: [{ scope_hash: 'a'.repeat(64), total: 4, failed: 2, passed: 2, pending: 0, fresh: 4, reused: 0, current_scope: true }]
        },
        excluded_review_types: ['test'],
        latest_failed_review: {
            review_type: 'code', event_type: 'REVIEW_RECORDED', outcome: 'FAIL', verdict_token: 'REVIEW_FAILED',
            reviewer_identity: 'agent:reviewer', review_artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-TEXT-1-code.md',
            summary: 'Two high findings remain.', sequence: 41, timestamp_utc: '2026-11-16T00:00:00.000Z'
        },
        choices: ['allow_one_more_cycle', 'split_task', 'raise_limits'],
        operator_choice_guidance: [
            'allow_one_more_cycle: record a task-scoped one-shot continuation after operator approval.',
            'split_task: record a manual split decision and continue in child tasks.'
        ],
        auto_split_prompt: null
    };
}

