import { T212_FIELD_CASE_IDS } from './walk-decomposition-field-scenarios';

/** Field cases for the defects of the 1.4.4 final review (sol-r144-*, opus-r144-freshness, opus-fix144-review). */
export const R144_FIELD_CASE_IDS = ['field-r144-lane-enable-keeps-passed-reviews', 'field-r144-lane-disable-keeps-passed-reviews',
    'field-r144-lane-enable-with-criteria-change',
    'field-r144-protected-restart-keeps-criteria', 'field-r144-protected-restart-after-agent-supplement',
    'field-r144-protected-restart-operator-criteria-change', 'field-r144-protected-restart-confirms-agent-supplement',
    'field-r144-omitted-required-lane-refresh', 'field-r144-unavailable-required-lane', 'field-r144-disabled-required-lane-after-selection',
    'field-r144-red-changed-declared-fixture', 'field-r144-failed-task-local-compile-retry',
    'field-r144-criteria-change-double-context', 'field-r144-criteria-change-double-context-operator-intent',
    'field-r144-depth-change-double-context'] as const;

/**
 * Ready but not registered.
 * - Legacy prefix: such a history cannot reach review in 1.4.4 because task-test selection still requires a strict PASS history
 *   (T-469 item 3, moved to 2.0). Register these when T-469 lands; until then they would fail on that known defect.
 */
export const R144_KNOWN_GAP_IDS = ['field-r144-legacy-prefix-continue', 'field-r144-legacy-prefix-forged-launch'] as const;

export const R144_BACKFILL_FIELD_CASE_IDS = ['field-r144-renamed-parent-audit', 'field-r144-update-active-task',
    'field-r144-update-draft-status', 'field-r144-workflow-set-no-change',
    'field-r144-review-cycle-mark-blocked', 'field-r144-update-operator-closed-task'] as const;

/** Stable public selection: GARDA_SYNTHETIC_WALK_ONLY=field-cases. */
export const FIELD_CASE_IDS = ['field-misleading-in-scope-refusal',
    'field-onlinestore-passed-delta-after-test-repair', 'field-project-command-reselection', 'field-cmd-call-argv', 'field-onlinestore-op035-follow-up-attribution', 'field-onlinestore-t006-7-1-audit-only',
    'field-onlinestore-t022-1-closeout', 'field-onlinestore-op050-case-source',
    // T-403: a stale failure whose cause is gone must route to the retry of the failed step (OP-056).
    'field-onlinestore-op056-config-drift-resolved', 'field-onlinestore-op056-retry-while-drifted-resolved',
    'field-onlinestore-op056-control-plane-retry-while-drifted-resolved',
    // T-437: next-step's own task-test selection must progress while the live quality baseline is older than shipped.
    'field-t437-stale-quality-baseline-selection',
    // T-437: an agent mistake in a closeout evidence step on the unchanged reviewed tree is corrected by rerunning that step.
    'field-t437-doc-impact-flag-mismatch', 'field-t437-unchanged-reclassification-keeps-reviews', ...R144_FIELD_CASE_IDS,
    // T-212: a decomposition decision is checked against the work, and an authenticated split gets its rows from Garda.
    ...T212_FIELD_CASE_IDS, ...R144_BACKFILL_FIELD_CASE_IDS] as const;
