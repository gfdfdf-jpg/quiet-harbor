# Common native review transition matrix

`tests/node/synthetic/engine/common-review-matrix.ts` is the shared, explicit review oracle. Every row runs on all 19 stack fixtures and all four review execution policies. Stack adapters change project files, syntax, selectors and commands; they do not change the expected review decisions. The current catalogue has 46 rows, giving 3,496 native cells per operating system.

The matrix drives real installation, task entry, classification, compilation and task-test gates, review handoffs, signed receipts, repair, reuse, audit and completion in disposable projects. Only compilers, test tools and reviewer responses are simulated. It certifies Garda's protocol rather than the real compilers or a human/AI reviewer's judgement.

The registered finite guard classes are:

| Rows | Required result |
| --- | --- |
| Initial FULL | Each required lane launches once in FULL. |
| Small test/source repair | TEST alone, or CODE and TEST, repeat in DELTA; unrelated accepted reviews stay accepted. |
| Documents after failure | The failed review remains required; no fabricated docs-only DELTA. |
| Added test / added source | A test joins actual selected validation without restarting unrelated reviews; production scope expansion requires FULL. |
| Accepted DELTA then TEST repair | Original CODE/API DELTA survives a later test repair, including native validation refresh. |
| Accepted DELTA then two TEST repairs | Both carries keep the same original contract and `reused_from_*` lineage. |
| Test refactor boundary | 49, 50 and 51 changed lines; REFACTOR repeats only above 50. |
| DELTA line boundary | 239, 240 and 241 lines; exceeding 240 changes affected reviews to FULL, preserving unrelated reviews. |
| DELTA file boundary | Three, four and five in-scope files; exceeding four changes affected reviews to FULL. |
| Consecutive DELTA limit | Three DELTAs, then FULL, then a new DELTA. |
| Failed review without repair | Native blocker; no additional reviewer launches. |
| Failure of every upstream lane | Failed owner and genuinely affected lanes repeat; unrelated lanes stay accepted. |
| Independent / chain / fanout | Production and middle-node helper repairs require different downstream sets. |
| Missing/corrupt receipt/report/context | Authentic result evidence is required; a derived context is rebuilt without a new review. |
| Invalid report | Original reviewer corrects its report; an unavailable reviewer permits only that lane's fresh launch. |
| T-022-2 S1: CODE failure and config scope expansion | CODE repeats in FULL; first reviews of other required lanes are FULL. |
| T-022-2 S2: changed task-intent after CODE/DB/SECURITY PASS | Native coherent restart; all mandatory lanes are FULL and old PASS evidence cannot be reused. |
| T-022-2 S3: bounded production and structural test fix after PERFORMANCE FAIL | CODE/REFACTOR/PERFORMANCE DELTA; first TEST FULL; unrelated accepted lanes recorded as reuse. |
| T-022-2 S4: 28 structural test lines after TEST FAIL | REFACTOR/TEST DELTA; all other accepted lanes recorded as reuse. |
| T-022-2 recovery | Invalid command and a real occupied test marker are refused; closeout recovery adds zero fresh launches. |

The original stand also retains its policy, scope, protected-boundary, launch, reset, evidence, scheduling and disturbance families. Release CI selects all deep families on every stack on both Linux and Windows. This matrix complements those checks; it does not replace their counter ceilings, integrity checks or route coverage.

For ordinary-test rows, Rust's contract-named tests are renamed to ordinary test names so that an extra API-path signal does not change the input facts. The unchanged Rust contract paths remain covered by the original stack stand. Unknown extensions use the same explicit frozen source/test role declarations as supported by Garda.

The shared-helper rows include that helper in the initial reviewed task scope and declare its relation to the selected tests. A helper absent from the reviewed snapshot would exercise the added-test branch instead; the oracle explicitly requires the intended shared-helper classification.

Every cell asserts exact launch counts, order and FULL/DELTA modes. DONE alone never establishes success. Every carried lane must retain the original report bytes, bind the current preflight and record native reuse with the original context/tree/scope/code lineage. Preserved DELTA cells additionally verify native preservation authority and refusal of tampered receipt/report/validation/history, a foreign preflight, a forged contract and attempts to promote a reuse-only context into a fresh launch. Missing, duplicate, foreign, unfinished or modified evidence refuses the combined GREEN verdict.

## Commands and CI evidence

Inventory:

```text
node tests/node/synthetic/review-matrix.cjs inventory
```

One explicit diagnostic cell:

```text
node tests/node/synthetic/review-matrix.cjs run --only review-matrix-node--passed-delta-then-test--strict_sequential --report <new-external-directory>
```

The public entry invokes the locked, fingerprint-checked build driver before loading compiled code. Reports bind the source tree, commit, OS, architecture, Node and provider. Successful raw traces are compressed losslessly; failures retain readable traces and synthetic native evidence. Next-step timings and gate timings remain distinct. These in-process measurements are not cold CLI latency or a quiet timing baseline.

`reference-stand.yml` runs both the original stand and a disjoint shard of the common matrix. A separate merge rejudges every native trace and refuses missing cells or a rewritten summary. Matrix files stay outside the sealed original shard. A single selected shard is diagnostic evidence and cannot produce a complete acceptance verdict.

The default manual selection is `suite=all`. After a failure, `suite=stand` or `suite=review-matrix` with the exact OS and shard checks only the failed component. Such filtered runs are explicitly diagnostic and do not certify the combined release stand.

An ordinary `stand.cjs full` command by itself does not execute this additional matrix. The reference CI workflow's combined verdict requires both. Development commands and traces live under `tests/` and external report directories; they are not loaded by the installed CLI.

This is a finite matrix of explicit states and guard boundaries. It makes no claim to enumerate infinitely many histories. Every newly discovered review incident still requires a permanent field regression and a corresponding matrix row or transition witness; a previous green run is not proof of an unregistered case.

## Exact fresh-launch oracle

The five `audit-*` controls come from section 6 of `sol-t022-2-review-audit.report.md`. They are rule controls, not claims of confirmed needless launches in that task. S3/S4 freeze the field project's structural-test threshold of 20 before task entry, so 28 lines require REFACTOR. The ordinary matrix threshold remains 50. S1 adds a real config file and a small production fix; S2 changes the actual `--task-intent` through native coherent restart. It does not duplicate the separate refined-initial-intent scenario owned by `w1-intent`. Recovery uses an actual native task-test owner and its emitted marker, preserves that marker during the rejected concurrent call, then lets the owner finish. No marker, PASS, source receipt or lifecycle event is fabricated. Inventory exposes the five rules and their launch contracts as `auditControls`.

The same launch sequence is expected on every stack. In parallel policies the deterministic synthetic agent selects the canonical permitted launch order. Reuse does not add a fresh launch.

| Row | Fresh launches in order |
| --- | --- |
| `audit-s1-config-expansion` | code:FULL → code:FULL → refactor:FULL → api:FULL → test:FULL |
| `audit-s2-changed-intent` | code:FULL → db:FULL → security:FULL → code:FULL → db:FULL → security:FULL → test:FULL |
| `audit-s3-production-structural-fix` | code:FULL → db:FULL → security:FULL → refactor:FULL → api:FULL → performance:FULL → code:DELTA → refactor:DELTA → performance:DELTA → test:FULL |
| `audit-s4-structural-test-28` | code:FULL → db:FULL → security:FULL → refactor:FULL → api:FULL → performance:FULL → test:FULL → refactor:DELTA → test:DELTA |
| `audit-recovery-no-fresh-review` | code:FULL → refactor:FULL → api:FULL → test:FULL |
| `initial-full` | code:FULL → refactor:FULL → api:FULL → test:FULL |
| `test-small-test` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:DELTA |
| `test-small-source` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:DELTA → test:DELTA |
| `test-document` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:FULL |
| `test-new-test` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:DELTA |
| `test-new-source` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:FULL → refactor:FULL → api:FULL → test:FULL |
| `passed-delta-then-test` | code:FULL → refactor:FULL → api:FULL → code:DELTA → api:DELTA → test:FULL → test:DELTA |
| `source-then-two-test-repairs` | code:FULL → refactor:FULL → api:FULL → code:DELTA → api:DELTA → test:FULL → test:DELTA → test:DELTA |
| `test-refactor-49` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:DELTA |
| `test-refactor-50` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:DELTA |
| `test-refactor-51` | code:FULL → refactor:FULL → api:FULL → test:FULL → refactor:DELTA → test:DELTA |
| `source-line-limit-239` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:DELTA → test:DELTA |
| `source-line-limit-240` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:DELTA → test:DELTA |
| `source-line-limit-241` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:FULL → test:FULL |
| `source-file-limit-3` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:DELTA → test:DELTA |
| `source-file-limit-4` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:DELTA → test:DELTA |
| `source-file-limit-5` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:FULL → test:FULL |
| `consecutive-delta-cap` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:DELTA → test:DELTA → test:DELTA → test:FULL → test:DELTA |
| `failed-review-blocks` | code:FULL → refactor:FULL → api:FULL → test:FULL |
| `failed-code-production` | code:FULL → code:DELTA → refactor:FULL → api:FULL → test:FULL |
| `failed-db-production` | code:FULL → db:FULL → code:DELTA → db:DELTA → refactor:FULL → api:FULL → test:FULL |
| `failed-security-production` | code:FULL → security:FULL → code:DELTA → security:DELTA → refactor:FULL → api:FULL → test:FULL |
| `failed-refactor-production` | code:FULL → refactor:FULL → code:DELTA → refactor:DELTA → api:FULL → test:FULL |
| `failed-api-production` | code:FULL → refactor:FULL → api:FULL → code:DELTA → api:DELTA → test:FULL |
| `failed-performance-production` | code:FULL → refactor:FULL → api:FULL → performance:FULL → code:DELTA → performance:DELTA → test:FULL |
| `failed-infra-production` | code:FULL → refactor:FULL → api:FULL → infra:FULL → code:DELTA → infra:DELTA → test:FULL |
| `failed-dependency-production` | code:FULL → refactor:FULL → api:FULL → dependency:FULL → code:DELTA → dependency:DELTA → test:FULL |
| `dependency-independent` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:DELTA → test:DELTA |
| `dependency-helper-independent` | code:FULL → refactor:FULL → api:FULL → test:FULL → refactor:DELTA → test:DELTA |
| `dependency-chain` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:DELTA → refactor:DELTA → api:DELTA → test:DELTA |
| `dependency-helper-chain` | code:FULL → refactor:FULL → api:FULL → test:FULL → refactor:DELTA → api:DELTA → test:DELTA |
| `dependency-fanout` | code:FULL → refactor:FULL → api:FULL → test:FULL → code:DELTA → refactor:DELTA → api:DELTA → test:DELTA |
| `dependency-helper-fanout` | code:FULL → refactor:FULL → api:FULL → test:FULL → refactor:DELTA → test:DELTA |
| `evidence-lost-receipt` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:FULL |
| `evidence-corrupt-receipt` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:FULL |
| `evidence-lost-report` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:FULL |
| `evidence-corrupt-report` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:FULL |
| `evidence-lost-context` | code:FULL → refactor:FULL → api:FULL → test:FULL |
| `evidence-corrupt-context` | code:FULL → refactor:FULL → api:FULL → test:FULL |
| `report-correction-same-reviewer` | code:FULL → refactor:FULL → api:FULL → test:FULL |
| `report-correction-unavailable-reviewer` | code:FULL → refactor:FULL → api:FULL → test:FULL → test:FULL |
