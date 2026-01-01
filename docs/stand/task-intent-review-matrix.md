# Task intent and review retention matrix

This permanent regression matrix implements C6.2.4. Intent wording explains the task; durable task scope and acceptance criteria govern review invalidation. Independent hashes audit the wording and the criteria.

| Scenario | Required outcome | Executable coverage |
| --- | --- | --- |
| Code, db and security passed FULL; refine “Export personal data securely” to name authentication, authorization, archive integrity and access revocation; scope, acceptance criteria, policy and verification obligations stay unchanged | Keep all three passed lanes; zero additional fresh reviews. Record both intents and their task-bound hashes in the restart event. The next reviewer sees the refinement; the original review contexts and immutable receipt snapshots retain the old intent. | `tests/node/cli/commands/gates/review-cycle/gates-review-cycle-intent.test.ts` |
| Edit linked task-card acceptance criteria | Every required lane FULL; no passed lane reusable | `gates-review-cycle-remediation-protected-signals.test.ts`: changed numbered card criteria |
| Edit task-row scope | Every required lane FULL | Same file: row-scope change |
| Change attached approved plan bytes while keeping entry metadata | Every required lane FULL; old contexts fail the criteria contract | Same file: plan change; `gates-review-reuse-task-criteria.test.ts`: plan bytes |
| Change review policy without approved adoption | Every required lane FULL | `gates-review-cycle-remediation-protected-signals.test.ts`: policy-source remediation |
| Intent is the only requirement source, or activates a previously absent verification obligation | Fail closed to FULL; move added requirements into durable criteria before acceptance | `review-context-task-criteria-binding.test.ts`; `gates-review-cycle-remediation-protected-signals.test.ts`: intent-obligations change |
| First test review; frozen policy lists test as DELTA-eligible | FULL, with the reason “no earlier review”, never policy ineligibility | `review-remediation-recovery-routing.test.ts`: first test FULL |

The matrix does not assert semantic equivalence from arbitrary natural language. Reviewers must flag requirements present only in explanatory intent and require their inclusion in durable criteria. Security intent can also activate the trust-boundary matrix; that changes what must be verified and cannot reuse a review that did not cover it. Older binding schemas remain fail-closed rather than being silently migrated.
