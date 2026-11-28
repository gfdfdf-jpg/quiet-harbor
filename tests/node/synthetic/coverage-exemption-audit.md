# Coverage exemption audit at 17f4edb7

All production references below were re-read at this HEAD, including callers and native writers. No production branch was changed. File:line:column IDs below have the prefix `src/gates/next-step/`; `gate:` IDs are literal. A retained exemption is not scenario coverage.

Result: **32 → 24 exemptions**. All 23 A/B proofs hold; eight C entries have passing native scenarios. C/248 remains with a sharper prerequisite. No A/B proof was found wrong.

## Per-ID disposition

| ID | Group | Verdict | Scenario / proof |
|---|---|---|---|
| `next-step-review-reuse-routing.ts:509:16` | A | Proof holds | A1 |
| `next-step-review-reuse-routing.ts:522:12` | A | Proof holds | A1 |
| `next-step-review-reuse-routing.ts:235:20` | A | Citation fixed; proof holds | A2 |
| `next-step-review-reuse-routing.ts:223:20` | A | Citation fixed; proof holds | A3 |
| `next-step-pre-review-routing.ts:121:20` | A | Proof holds | A4 |
| `next-step-pre-review-routing.ts:133:16` | A | Proof holds | A4 |
| `next-step-pre-review-routing.ts:217:16` | A | Proof holds | A5 |
| `next-step-validation-routes.ts:39:26` | A | Proof holds | A6 |
| `next-step-review-cycle-routing.ts:42:16` | A | Proof holds | A7 |
| `gate:startup-readiness` | A | Proof holds | A8 |
| `next-step-review-lifecycle-routes.ts:205:12` | A | Citation fixed; proof holds | A9 |
| `next-step-decision-route-groups.ts:342:12` | A | Citation fixed; proof holds | A10 |
| `next-step-startup-routing.ts:409:16` | A | Citation fixed; proof holds | A11 |
| `next-step-startup-routing.ts:421:16` | A | Proof holds | A11 |
| `gate:reviewer-launch-retry` | B | Proof holds | B1 |
| `gate:review-evidence-refresh` | B | Proof holds | B1 |
| `next-step-review-reuse-routing.ts:330:16` | B | Proof holds | B1 |
| `next-step-review-reuse-routing.ts:348:16` | B | Proof holds | B1 |
| `next-step-review-reuse-routing.ts:364:16` | B | Proof holds | B1 |
| `next-step-review-reuse-routing.ts:381:16` | B | Proof holds | B1 |
| `next-step-pre-review-routing.ts:230:20` | B | Proof holds | B2 |
| `next-step-pre-review-routing.ts:147:20` | B | Citation fixed; proof holds | B3 |
| `next-step.ts:3451:20` | B | Proof holds | B4 |
| `gate:await-project-validation` | C | Now covered by a new scenario | `coverage-declared-recipe-in-flight` |
| `next-step-validation-routes.ts:48:36` | C | Now covered by a new scenario | `coverage-declared-recipe-in-flight` |
| `next-step-full-suite-routing.ts:315:16` | C | Now covered by a new scenario | `coverage-full-suite-owner-in-flight` |
| `next-step-full-suite-routing.ts:365:12` | C | Now covered by a new scenario | `coverage-full-suite-owner-crashed` |
| `gate:record-review-output-correction-transport` | C | Now covered by a new scenario | `coverage-publication-correction-transport` |
| `next-step-review-reuse-routing.ts:259:16` | C | Now covered by a new scenario | `coverage-publication-correction-transport` |
| `next-step-review-reuse-routing.ts:248:20` | C | Kept; reason sharpened | C1 |
| `next-step-review-readiness-routing.ts:181:20` | C | Now covered by a new scenario | `coverage-publication-delegation-start` |
| `next-step-review-readiness-routing.ts:208:20` | C | Now covered by a new scenario | `coverage-publication-launch-complete` |

## Re-verified proofs

A1. `findReviewGateStaleContextPrecheckRecovery` (`next-step-review-evidence.ts:585-612`) selects an unsatisfied required state. The launch plan in `next-step.ts:3076-3125` consumes that same predicate before post-review routing. Linkage and override exceptions require a passed review gate, which disables this recovery in `next-step-post-review-routes.ts:279-288`. Semantic acceptance requires a committed semantic-cycle manifest. Searching all of `src` finds `executeSemanticCycleRebindTransaction` only at its definition (`semantic-cycle-transaction.ts:1033`); there is no native command producer. Both metadata alternatives remain dormant.

A2. The sole production call is `next-step.ts:4995`, with an unconditional `recordCorrectionTransport: buildCommand(...)` at 5100. An absent optional property is impossible at this native call. The old 4971/5076 citations were stale.

A3. `next-step-review-artifact-readers.ts:2536-2545` requires a nonempty original invocation for transport selection; 2588-2598 authenticates it. Lines 2635-2647 turn invalid provenance into full-review-required, and 2661 puts the authenticated ID in the handoff. The sole caller forwards that handoff unchanged. The old 2525/2623/2650 references were stale.

A4. `compile-flow-classify.ts:836-857` derives protected scope from native changed files and adds an error without `orchestrator_work`. Line 989 throws before publication. A native re-entry removing that authority makes preflight older than task entry; `next-step-doc-closeout-readiness.ts:477-486` and the earlier pre-guard branch reject it before either protected-preflight fallback. The live workspace guard is a separate route.

A5. A stale workspace invokes `readPendingPreflightRefresh` at `next-step.ts:3732-3734`. Every valid nonempty timeline with a coherent boundary returns recovery (`next-step-preflight-recovery.ts:836-881`), consumed at pre-review routing 205. Without a boundary, coherent readiness only needs the ordered handshake/shell-smoke prefix enforced before native preflight publication (`compile-flow-classify.ts:905-932`). Missing/unreadable timelines and absent preflight return ready. The remaining conjunction cannot arise.

A6. Native current validation phases are structurally BOUND and non-REJECTED before this selector. `project-validation-recipes.ts:138` rejects an empty recipe list. `quality-checklist-validation-phases.ts` derives OBSERVED only when all nonempty executions are observed, REJECTED if any is rejected, otherwise PENDING. The task-command producer emits one execution. Excluding OBSERVED and REJECTED therefore leaves an actual pending execution; the fallback cannot be selected.

A7. `computeReviewLaunchPlan` (`review-execution-policy.ts:188-280`) prefers an unblocked failed lane, then an unblocked unsatisfied lane, before the blocked fallback. `review-dependency-graph.ts` rejects cycles and dependencies outside required lanes; every unsatisfied finite DAG has an unblocked minimal lane. Implicit dependency modes are acyclic too. `next-step.ts:4590-4616` returns the extra full-suite boundary before active-review preparation at 4639. The graph argument, rather than the old ledger's unverified exhaustive-count claim, establishes this proof.

A8. All `ready:false` returns from `readStartupCycleReadiness` name load-rule-pack, handshake-diagnostics or shell-smoke-preflight. The pending-refresh override in `next-step.ts:3738-3743` also names load-rule-pack. No native caller supplies false readiness with a null gate, so startup routing's `|| 'startup-readiness'` is dead.

A9. The sole caller builds `preparationRoute` at `next-step.ts:5177` with empty dependencies and the same state/context booleans passed to `resolveContextPreparationLifecycleRoute` at 5207. Preparation returns null only for existing/current context; that makes `contextReady` true and returns at lifecycle line 201. Otherwise the non-null preparation is returned at 203. The old 5153/5183 references were stale.

A10. One immutable optional-skill value (`next-step.ts:3959`) is passed to the pre-guard at 4128, which returns at 4130-4136 whenever it exists (`next-step-pre-review-routing.ts:249-265`). Reaching the later caller at 4395 implies null, so its duplicate fallback is dead. The old 4394 citation was stale.

A11. Startup readiness returns before both fallback objects. Both current-cycle success paths require actual handshake and shell-smoke events (`next-step-startup-readiness.ts:122-164,197-247`). `task-audit-summary-lifecycle.ts:68-69,260-268,562-606` counts the same events as PASS without a compile filter or alternative failure event. No task-mode state is already handled earlier. Artifact loss cannot remove these authenticated events. The success-path citation was extended to include the final return.

B1. All four special failure kinds have assignments only in `next-step-review-artifact-readers.ts:2145-2167`, after the legacy-text verdict selector. `review-findings-artifact-verdict.ts:36-40` requires findings JSON for schema >=3. Native preflight requires coverage (`classify-change.ts:404`), native context writes schema 4 (`build-review-context.ts:564`), and `review-context-contract.ts:958-964` rejects downgrade. Current JSON findings use authenticated disposition, not these textual heuristics. A fresh native sequence cannot publish the retained old context/receipt/preflight combination.

B2. `awaitingMaterializedPlannedScope` requires absent `metrics.actual_changed_files` (`next-step-preflight-workspace-readiness.ts:438,696-706`). Native classification always writes the snapshot array, even when empty (`compile-flow-classify.ts:546`). The current clean planned-scope route is elsewhere; deleting the field would invent a historical format.

B3. Closed-cycle remediation requires both an actually failed required lane (or authenticated fix_now disposition, `next-step.ts:3700-3706`) and the same cycle's passed review gate (4077). Current JSON failure comes from authenticated validation/disposition, and required-reviews refuses those blockers. The tiny-code override cannot skip mandatory authorship (`required-reviews-check-output.ts:120-125`, propagated through `review-flow.ts:504-510`). After PASS, `review-lifecycle-guard.ts:116-168` prevents a late review-phase result; restart establishes another boundary. The old review-flow:486 citation was stale; the current propagation is at 504-510. Current native publications cannot produce the combination. Historical or restored earlier rejected evidence is required; neither is manufactured here.

B4. `next-step.ts:3444` needs a materialized unscoped handoff. `full-suite-repair-materialization.ts:316-361` admits that only for legacy schema with no scoped fields; current schema rejects missing/invalid scopes. The writer at 1107-1111 and WIP writer in `full-suite-repair-capture.ts:612-624` always publish the current schema and validated scopes. Native scoped child cases cannot cover this historical branch.

C1. Interrupting initial correction transport publication retains the authenticated launch/context/invocation that supplies recovery identity. Branch 248 additionally requires that identity to be unavailable. The allowed interruption alone does not supply this second prerequisite. No independent native interruption sequence producing both conditions has been established; deleting or rewriting those bindings is disallowed. This remains an exemption, not a claim of dead code.

## Removal candidates

All 14 A IDs in the table are confirmed dormant branches/fallback alternatives in the current native graph and candidates for a separate production removal review. For `gate:startup-readiness`, only the string fallback is a candidate; its containing BLOCKED object is live. For A1, removal should account for any future activation of the currently uncalled semantic-cycle writer. The nine B IDs preserve historical formats and are not proposed for removal by this audit.

## Validation and remaining work

The six-scenario focused walk: **6 cases / 169 steps / 0 findings / 0 anomalies / 0 invalid exemptions**. Both removed gate IDs and all six removed source IDs each have `steps: 1` in its actual coverage arrays. Terminal outcomes and counts:

| Scenario | Steps | Outcome |
|---|---:|---|
| `coverage-full-suite-owner-in-flight` | 32 | DONE |
| `coverage-declared-recipe-in-flight` | 36 | DONE |
| `coverage-full-suite-owner-crashed` | 15 | Exact interrupted-run BLOCKED handoff; owner and child reported dead |
| `coverage-publication-delegation-start` | 32 | DONE |
| `coverage-publication-launch-complete` | 32 | DONE |
| `coverage-publication-correction-transport` | 22 | Native stateless transport recorded; exact correction-only invocation BLOCKED handoff |

The crashed-owner case also requires both the native owner and its test child to be dead. Branch 248 (C1) stays exempt: it needs a pending correction transport together with an unavailable reviewer identity, and no permitted native interruption produces both.
