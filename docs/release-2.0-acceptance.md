# Garda 2.0 Acceptance Contract

Contract revision: 4. Phase: S0 definition with S1 child assignments. Updated: 2026-10-24.

This document defines the finite 2.0 scope and the evidence needed to release it.
It does not declare a release candidate accepted. The source version is still
1.4.4; no 2.0 candidate, package digest, GA date or completed RC period is recorded
here. T-440-1 owns this definition; T-440-2 closes it in S7. A completed task or a
green selected test cannot substitute for the release criteria below.

The local phased `TASK.md` Order is the execution queue. Its ignored cards and
the 2026-10-23 final audit provide planning provenance; this tracked contract
makes the release obligations available without those local files. Future task
splits retain their parent's obligations and phase assignments.

## Support and Verification

Garda remains provider- and stack-neutral. The generic path uses `AGENTS.md`,
`next-step`, configurable validation commands and stack-neutral discovery. It
supports any provider and stack that can follow that contract. An absent native
adapter, framework pack or separately verified combination does not remove that
generic support. Prefer the generic path over additional provider special cases.

"Verified" applies only to the concrete client/version/surface, stack, OS,
runtime, artifact and scenario actually exercised end to end. Registry presence,
generated instructions, fixture reviews and a passing helper test do not prove
actual client loading. CLI, IDE and desktop surfaces require separate records.
Other combinations remain **supported through the generic path; not separately
verified**. A capability that a particular client cannot expose must be reported
as unavailable in that scenario, with the generic workflow requirement retained.

The 2.0 runtime policy is Node 24 or newer. Qualification must cover Node 24 and
Node 26 and the release platforms Windows, Linux and macOS. Select and record
actual client/stack combinations within that matrix; do not imply an exhaustive
Cartesian product of all providers and languages. Changes to runtime support
need an explicit contract revision, migration guidance and matching evidence.

### Recorded Supporting Observations

| Client / stack | OS / runtime | Actual evidence | Limit |
|---|---|---|---|
| Codex, current desktop delegation surface; Garda TypeScript source checkout and Markdown task | Windows, Node 24.22.1 | T-439 completed the real task lifecycle, five independent reviews, scoped checks and native source acceptance at `a48cb79c35d28fe2756fea70fd03cffe8a33fd8e` | Verified source-task scenario; client version was not captured. This is not packaged 2.0 or another client's acceptance. |
| Fixture-driven T-401 friction baseline | Windows and WSL2, original baseline runtime context | Baseline source `be35bac6cd5fea969071374dc484ec78938bb09d`; accepted driver source `528186953cb46e2b86e98b04e4df086061646250` | Fixture reviewer responses and partial stack coverage are measurement inputs, not native client or final Linux/macOS qualification. |
| T-410 runtime-policy checks | Windows, Node 24; additional targeted Node 26.12.1 execution | Accepted source `570f4a9f53a78a55a8385e33be3ecf07ab10a2dc` | The initial Node 26 run had one failure; its corrected exact case passed. No fresh aggregate Node 26 or provider E2E PASS is asserted. |

The **2.0 exact-candidate verified matrix is currently empty**. At each phase exit,
append only real observations with their original commit and scope. S7 must
record exact client versions, surfaces, stack/toolchain versions, OS versions,
Node versions, package digest, scenarios, results and retained evidence locations.
Windows, WSL2 or a simulated fixture cannot silently satisfy an unavailable
native platform obligation. Failed, skipped and unavailable rows remain visible.

## Phase Outputs and Queue Assignments

Each row below assigns the current Active Queue IDs, including retained DONE
history and decomposed parents. Assignment is not completion or validation of a
later commit. Parent rows route to children; completed historical children are
not redispatched. A phase exit requires its output and the criteria that apply
to it, then an update to this contract by that phase's closing task owner.

| Phase | Assigned queue IDs | Output and exit obligation |
|---|---|---|
| S0 — release contract | T-401, T-435, T-436, T-438, T-410, T-439, T-440, T-440-1, T-420, T-420-1 | Reproducible baseline, Node policy, current-source reconciliation, manual-workflow documentation, complete test assignment, this scope/support contract and selftest redesign. T-435/T-436/T-438 are retained source-history dispositions, not new implementation. T-420-1 is **redesign only** now; implementation remains T-420-2 in S7. |
| S1 — secure execution and complete observation | T-428, T-444, T-196, T-196-1, T-196-2, T-196-2-1, T-196-2-2, T-204, T-204-I1, T-204-1, T-204-2, T-212, T-212-2, T-206, T-422 | Explicit execution trust, visible declared scope, trigger coverage, complete/unknown state and local HTTP boundaries. T-196-1 owns automatic execution denial; T-196-2 routes package repair through T-196-2-1 and genuine source/package/bundle compatibility through T-196-2-2. Negative paths cannot execute untrusted candidates, hide planned source or authorize mutation from unknown state. Retained T-204 children preserve their accepted source history. |
| S2 — dependable lifecycle recovery | T-423, T-418, T-418-1, T-418-2, T-418-3, T-437, T-443, T-192, T-193, T-239, T-254, T-167, T-211, T-169-2, T-067 | State/transition and execution identity contracts, crash-tail recovery, review/WIP preservation and mandatory invariant sequences. Interruptions have a safe resumable outcome; stale owners/evidence gain no authority. T-067 correctness starts here and is qualified again in S7. |
| S3 — simpler normal work | T-409, T-409-1, T-409-2, T-409-3, T-409-4, T-403, T-403-1, T-403-2, T-403-3, T-402, T-402-1, T-402-2, T-402-3, T-139, T-411, T-417, T-421, T-442, T-445, T-135, T-135-1, T-135-2, T-135-3, T-135-4, T-241, T-241-7 | Mechanical commands, actionable navigation, conservative advice, report-format guidance, audited deferral and CLI/UI setting parity. Reach the T-401 fixture target without hiding review/recovery cost or weakening authority. |
| S4 — bounded runtime cost and storage | T-415, T-415-1, T-415-2, T-415-3, T-415-4, T-415-5, T-416, T-186, T-186-1, T-186-2-3-3-3-2-F1, T-186-2, T-186-2-1-F1, T-186-3, T-186-4, T-407, T-065, T-065-1, T-065-2, T-065-3, T-065-4, T-065-5, T-066, T-070, T-070-2, T-070-1 | Complete snapshot/cache inputs, producer-integrated retirement, measured budgets and bounded ownership simplification. Preserve evidence/user data, invalidate changed trust inputs and prove normal producer integration. Retained DONE children are history. Conditional T-068 is governed below. |
| S5 — installation and migration | T-187, T-188, T-429, T-432, T-433, T-433-1, T-433-2, T-433-3, T-434, T-441, T-133 | One provider registry and channel contract, preserved user content and a versioned exact-package 1.4.4-to-2.0 transition matrix. Verify actual instruction/skill/profile loading for selected client surfaces and label other generic combinations honestly. |
| S6 — product surfaces and guidance | T-430, T-431, T-405, T-218 | Stable help/JSON/error/exit contracts, guarded update UI, local value reporting, usable/accessibly localized UI and request ownership. Shipped guidance must support install, inspect, recovery, update and closeout. Apply the optional-scope decisions below. |
| S7 — qualification and freeze | T-406, T-408, T-420-2, T-440-2 | Exact-candidate evidence bundle, real toolchain/client/platform acceptance, final T-067 regression, redesigned T-420-2 implementation/qualification, RC operation and maintenance handoff. Close T-440 only after the later child and required parent acceptance. No missing external obligation becomes PASS. |
| Operator-only acceptance, prepared early and performed with the operator last | T-077, T-131, T-210 | Actual CodeQL/security coverage, native client skill loading and secret-scanner canaries. Prepare exact repository/client/check/evidence requests; these tasks are not started by the autonomous local queue run. Their unmet release obligations stay blocking. |

T-420 therefore has two explicit phase obligations: T-420-1 design in S0/S1 and
T-420-2 implementation/qualification in S7. The [G-01 replacement design](doctor-selftest-design.md)
records command-specific probes and real safety prerequisites; it supplies no
implemented command or passing selftest evidence. T-067 has S2 correctness and S7 regression.
T-440 has S0 definition through T-440-1 and S7 closure through T-440-2. New derived
children inherit these obligations; phase owners must add their exact IDs here
when decomposing. T-430's channel implementation depends on the S5 T-432 contract.
Its existing help/CLI changes must be checked against current source before
implementing the remaining UI/update work.

Launcher trust qualification retains two separate proofs. T-196-1 source
acceptance at `5fc0291eee42ac5c9f216cdeae03c4a7efa7e251` establishes the policy and
its Windows assertion-based RED/GREEN evidence. T-196-2-1 source acceptance at
`e05c3ef28d4b5205f184cecbe23622b899a261b9` repairs the two missing linked public
documents; its manifest assertion does not qualify an installed runtime.
T-196-2-2 uses the owning offline pack/install and compiled published-runtime
cases to exercise real help/version,
hostile cwd/ancestor/bundle and target-root selection, explicit known source and
materialized bundle CLI paths, and no-delegate continuation. Its native retained
execution output must bind the actual package digest, working-tree or supplied
candidate origin, checkout reference and local OS/Node version. The existing
exit/timeout controls and Windows skips retain their T-196-1 provenance; they
are not fresh cross-platform results. The original failed package execution
remains historical evidence. These leaves do not qualify the final 2.0 candidate;
both nested parents require their accepted child proofs and original obligations.

### Explicit Optional and Parked Dispositions

| Work | 2.0 decision | Evidence / re-entry condition |
|---|---|---|
| T-405 telemetry form | Include local gate-catch/value reporting from existing task evidence. Exclude a hosted collection service and external telemetry backend from the frozen 2.0 promise. | Keep local reporting useful offline; no automatic upload. A later external service needs its own privacy, operational and operator decision. |
| T-431 redesign | Include the already requested bounded visual/usability work, including language-switch stability. No new frontend framework, runtime dependency or behavior/API rewrite. | Operator approval of the concrete design note/mockups precedes full rollout. Preserve keyboard/focus/contrast, RTL, reduced motion and offline assets; finish before RC freeze. |
| T-061 and its derived children; T-062, T-063, T-064 | Parked outside the 2.0 feature promise. | Full task/backup erasure and bulk deletion require their own accepted ownership and recovery contracts. Existing retention/archive behavior must be documented without claiming complete erasure. This does not defer T-186's required safe producer-integrated cleanup. |
| T-127 and its derived children; T-128 | Parked outside the 2.0 rewrite scope. | Do not revive a manifest/consumer migration under a human hold. Required effective-setting and CLI/UI parity remain covered by T-241/T-241-7 and release acceptance. |
| T-068 | Conditional S4 work, currently parked/folded into T-415/T-416. | Re-enter only for a measured remaining Windows ACL-cache/report-refresh defect after those tasks. Record fixture sizes, cold/warm/invalidated/concurrent latency and trust invalidation; no blanket async/SQLite rewrite. |
| All-framework skill packs and automatic provider expansion | Excluded as an exhaustive feature campaign. | T-434 refreshes the built-in packs and packs for actually E2E-verified stacks; generic support remains available to other stacks/providers. Registry entries alone do not create verified integration claims. |

These are scope dispositions, not fabricated task completion or erasure of
historical obligations. A confirmed release-critical defect found in parked work
still blocks release at its authoritative consumer; it cannot be hidden by the
exclusion, a follow-up task or an operator-deferral mechanism.

## Checkable Release Criteria

All criteria are **OPEN for the 2.0 candidate** until their own exact evidence is
recorded. S0 establishes the checks; it does not mark future checks passed.

| ID | Required result and evidence | Blocking condition |
|---|---|---|
| RC-01 Correctness and authority | Resolve audit K-01 through K-04 at authoritative consumers: launcher trust, declared source visibility and complete/unknown lifecycle/discovery. Retain negative execution/scope/destructive-authority tests and triage every confirmed critical finding. | Any confirmed untrusted execution, lost required scope, data loss or authority from unknown state; a deferral cannot hide it. |
| RC-02 Lifecycle | Repeat normal completion, failed review/remediation, genuine restart, split/WIP preservation, cancellation, hold, reopen, interrupted mutation, owner replacement and post-cleanup recovery. Include concurrent invocations, timeouts and termination through public boundaries. | Missing sequence proof, lost WIP/valid RED, stale-owner authority or a nonterminal state without a safe next action. |
| RC-03 Test completeness | Inventory every discovered test and assign it to an executed check or explicit justified exclusion. The final candidate's required aggregate suite, lint/typecheck, packaging and security checks must pass with real case/job counts and retained output. | Unassigned tests, skipped mandatory items, incomplete platform results, timeout or failure. Routine development tasks continue to use justified task-scoped tests; this document authorizes no whole-suite or cloud run. |
| RC-04 Platforms and clients | Native qualification on Windows, Linux and macOS with Node 24/26, and real instruction/skill/profile loading on every specifically verified/advertised client surface. Record actual versions and the chosen stack combinations. | Unfulfilled selected native/client obligations, substituted host/fixture results or claims exceeding their evidence. Keep generic support distinct from individually verified surfaces. |
| RC-05 Migration | T-441's exact packaged 1.4.4-to-2.0 matrix passes: fresh install, initialized/active/failed-review/split/reopened/completed states, custom profiles/skills/catalog, user instructions, linked worktrees, legacy hooks and modified managed files. Preserve user bytes and evidence identity; inject interruption at durable boundaries and prove safe retry. Installed/source behavior agrees where promised. | Data loss, nonconvergent recovery, forged migrated evidence or a downgrade lacking either a tested reverse transition or safe refusal before partial replacement. |
| RC-06 Distribution | Verify release/version parity, package allowlist/checksums, clean install, offline/proxy/timeout failures, trusted update provenance and consistent channel identity. Preserve the releasable tarball, SBOM and provenance beyond temporary CI retention. | Wrong/missing bytes, unsupported channel/downgrade behavior, missing integrity or expired sole copies. No production tag is moved for a test. |
| RC-07 Usability | Repeat T-401 fixtures: at most 15 commands before first review for the intended small task, and separately report total completion, review handoffs/recovery, wall time, resets and dead ends. Help/parser options agree; JSON/error/exit contracts are stable; UI settings survive reload and stale requests cannot act on another task. | Hidden costs, unexplained reset/dead end, misleading help or stale cross-task actions. Suggestions cannot silently lower authority. |
| RC-08 Resilience | The local server survives corrupt or temporarily unavailable runtime data. Bound corrupt JSON, permission failures, full disk and process interruption. Cleanup preserves foreign artifacts and required recovery evidence. Retain failed-cleanup and crash-tail scenarios. | Process-wide failure from a bounded request, destructive action from incomplete observation, foreign deletion or lost recovery proof. |
| RC-09 Performance and storage | Record fixture sizes, workload duration, hardware/OS/runtime context, cold/warm/invalidated budgets, complete cache invalidation and bounded diagnostic growth during real producer use. Compare T-401 baselines after S3/S4. | Missing contextual budgets, unbounded growth or stale trust reused after inputs change. No invented universal millisecond target or arbitrary zero-cycle/file-size rewrite. |
| RC-10 Release-candidate operation | Run a **2–4 week RC period**, with at least **14 elapsed days and 30 representative real tasks** across the chosen stacks; target 28 days for broader observation. OnlineStore tasks count when version/scope/results are recorded. Include deliberate failure, remediation, restart, interruption, WIP and recovery scenarios. Retain dates, scenario counts, defects and resolutions. | Fewer than 14 days or 30 real tasks, missing recovery scenarios or untriaged release-critical defects. Time alone is not proof of correctness; disclose any observation beyond the four-week target. |
| RC-11 Documentation and support | Install/recovery/update/rollback guidance matches the shipped behavior. Manual CI responsibilities, exact compatibility evidence, feasible security-reporting promises, the fixed 1.x horizon and maintenance handoff are agreed and current. | Contradictory guidance, an unagreed support end date or an infeasible security commitment. No inherited receipt proves a later candidate. |
| RC-12 Feature freeze | Freeze after S6; admit only defect/acceptance fixes and documentation corrections, with affected evidence invalidated and rerun on the changed candidate. | New provider/framework campaigns, redesign ideas or unexplained scope growth entering the RC. |

### Manual Execution and Evidence Freshness

Repository CI, security and SBOM workflows use explicitly authorized
`workflow_dispatch`. This contract starts no run. Follow [manual CI
selection](manual-ci.md): exact project/repository, commit, checks, platform and
runtime; check shared allowance and expected consumption before any separately
authorized hosted run. After failure, inspect its logs and select only the failed
job/platform/runtime. A fixed commit needs its own selected run; retrying the old
run never validates the fix. No push, PR, tag or schedule is permission to run CI.

A changed candidate invalidates the evidence affected by that change. Retain the
prior result under its original identity; record a dependency-based explanation
for any evidence retained as unaffected. Never relabel source-checkout, fixture,
skipped, historical, foreign-platform or old-package results as current success.

## Finite 1.x Maintenance Policy

The S0 support draft is **six calendar months after the first stable 2.0 GA** for
security and critical correctness/data-loss fixes on `release/1.x`; no new
features or indefinite parallel maintenance. The exact UTC GA date and resulting
end date must be agreed and recorded in S7 before release. For an invalid
month-end day, use the last day of the target month. Missing agreement blocks
RC-11; it does not create an open-ended support promise.

T-432 must use one validated non-range maintenance dist-tag, `v1-latest`, and
separate it from stable `latest` and prerelease `next`. Do not use semver-range
`1.x` as an npm tag. T-440-2 must reconcile SECURITY.md and release guidance with
the final dates and feasible acknowledgement/mitigation promises. Until 2.0 GA,
the current published security policy remains in force. This draft creates no
branch, moves no tag and authorizes no publication. After the fixed horizon,
1.x users receive migration guidance to the maintained 2.x line.

## Evidence Bundle and Phase Handoff

The final release-owned index must record at least:

- Contract revision; candidate source commit, package version, tarball name and
  digest; contents-manifest digest; effective configuration/schema versions.
- Client/version/surface, stack/toolchain, native OS and Node matrix, with scenario
  IDs and explicit passed/failed/skipped/unavailable results and exclusions.
- Discovered test inventory and complete assignment; exact commands, job/run
  identities where relevant, counts, timestamps, outputs/digests and source/package
  bindings. A zero-item or skipped mandatory check is not PASS.
- Criterion RC-01 through RC-12 dispositions, evidence locations/digests,
  unresolved findings, explicit exceptions and the responsible follow-up owner.
- Migration starting/target states, preserved bytes and recovery points;
  fault/sequence, rollback and safe-refusal results; performance/storage fixtures
  and contextual budgets; RC dates, at least 30 real-task records and defect triage.
- Support GA/end dates and agreement; security-reporting owner and escalation;
  install/update/recovery/rollback runbooks; durable tarball/SBOM/provenance archive
  locations; exact manual maintenance/check responsibilities and remaining risks.

T-440-2 owns the detached final index, intended at
`docs/releases/2.0.0/acceptance.json`, and its durable referenced artifacts. Produce
the index after packing; do not insert a tarball's own digest into that tarball.
A tracked bookkeeping copy must identify the actual candidate commit, separately
from its own commit. Validate and release the frozen candidate from its matching
clean checkout; a later bookkeeping HEAD inherits no candidate PASS.

At each S0–S6 exit, the closing task owner updates phase status, exact source
references, changed task assignments, observed matrix rows and unresolved
requirements in this document. Until the phase's real acceptance exists, mark it
open or blocked. Prepare operator-only and unavailable native/browser/account
evidence requests early, specifying the exact client/repository/version/check and
the result needed, without starting the operator's tasks or spending cloud minutes.

S7 requires the complete bundle, rehearsal and maintenance handoff, not merely
the presence of this index. T-440-2 and any required native parent closeout may
complete only when their actual obligations are satisfied. A local task commit
authorizes neither publishing nor release approval.
