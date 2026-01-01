/** Field cases for the defects of the 1.4.4 final review (sol-r144-*, opus-r144-freshness, opus-fix144-review). */
export const R144_FIELD_CASE_IDS = ['field-r144-lane-enable-keeps-passed-reviews', 'field-r144-lane-disable-keeps-passed-reviews',
    'field-r144-lane-enable-with-criteria-change',
    'field-r144-protected-restart-keeps-criteria', 'field-r144-protected-restart-after-agent-supplement',
    'field-r144-protected-restart-operator-criteria-change', 'field-r144-protected-restart-confirms-agent-supplement',
    'field-r144-omitted-required-lane-refresh', 'field-r144-unavailable-required-lane', 'field-r144-disabled-required-lane-after-selection',
    'field-r144-red-changed-declared-fixture', 'field-r144-failed-task-local-compile-retry'] as const;

/**
 * Ready but not registered.
 * - Legacy prefix: such a history cannot reach review in 1.4.4 because task-test selection still requires a strict PASS history
 *   (T-469 item 3, moved to 2.0). Register these when T-469 lands; until then they would fail on that known defect.
 * - Criteria change with a double context build (R2-1, T-468): the public CLI refuses the second build-review-context
 *   (REVIEW_CONTEXT_REFUSED, the route is already record-review-routing) before reuse is evaluated, on the commits before and
 *   after the fix, so the walk cannot prove the defect. The fix (85ca862f) is covered by product tests; register these once
 *   T-468 finds a CLI path that reaches reuse.
 */
export const R144_KNOWN_GAP_IDS = ['field-r144-legacy-prefix-continue', 'field-r144-legacy-prefix-forged-launch',
    'field-r144-criteria-change-double-context', 'field-r144-criteria-change-double-context-operator-intent'] as const;

/** Stable public selection: GARDA_SYNTHETIC_WALK_ONLY=field-cases. */
export const FIELD_CASE_IDS = ['field-misleading-in-scope-refusal',
    'field-onlinestore-passed-delta-after-test-repair', 'field-project-command-reselection', 'field-cmd-call-argv', 'field-onlinestore-op035-follow-up-attribution', 'field-onlinestore-t006-7-1-audit-only',
    'field-onlinestore-t022-1-closeout', ...R144_FIELD_CASE_IDS] as const;
