# P4: migration acceptance for universal 1.4.4

Phase 2 acceptance on universal base `49924597`, including lifecycle compatibility fixes and T-457 task test validation naming. Historical baselines stay pinned.
Requirements come from T-441 (bounded scope), T-450-1-F1, T-457 and concept §8.

This is a standalone, explicitly selected acceptance suite. The existing `npm test` directory list does not discover
`tests/node/migration`; running the ordinary groups alone does not qualify P4. The coordinator must run the filtered
commands below on the merged base and include this selection in the later manual release qualification.

`p4-fixtures.ts` exports each pinned older source with `git archive`, builds its real publication runtime using the
existing dependency junction, and runs that version's actual CLI in disposable Git projects. It does not create a
worktree, install dependencies, contact a registry, start CI or run Garda against the source checkout. The old refs are
`9cc56c65` and `pre-universal-2026-11-06` (peeled commit `aafb5119`). The candidate is HEAD with current product files
overlaid, so phase 2 can test the merged implementation without changing these fixtures.

Every task entry, preflight, selection, checklist, execution, review launch, receipt, update sentinel and rollback
snapshot is produced by Garda. Ordinary inputs (project code, queue, init answers, self-check answers and reviewer
output) are seeded. Negative controls damage bytes without re-signing them. Authenticated records are never patched,
backdated or reconstructed. Evidence stays at its original absolute project root; copying authenticated projects would
invalidate their workspace bindings.

The 9cc baseline stores selected-command authority in its real workflow-config audit and also permits native execution
without a selection. Both cases are exercised. Child processes lose inherited `NODE_TEST_*` so the outer test runner
cannot skip their task tests; a file counter independently proves actual Node test execution and fresh-run recovery.

Compatibility tests invoke the candidate's real `dist/src/cli/main.js` with an explicit repository root. This avoids
the public launcher's intentional delegation to the installed old bundle. The packed-upgrade test starts through the
old installed launcher, runs the actual update path from an extracted locally packed publication, and then uses the
new installed launcher. `npm pack --ignore-scripts` is local; no `npm install`/`npm ci` is used.

The review fixture uses a separately spawned controlled process which consumes the exact pinned reviewer input and
checks all six input hashes. Real elapsed time and the older CLI's prepare/start/complete/result commands produce its
receipts. This verifies migration mechanics; it is **not real-model reviewer or native client acceptance**.
The Node and Python shapes execute real local test frameworks. The opaque fixture executes its own small interpreter
and assertions with unknown source/test extensions and no recognized project manifest. These are representative
smokes, not a claim of the full R6 matrix or Maven/.NET/Linux/macOS toolchain acceptance.

Run with `C:\Windows\System32` first on PATH and inherited `GIT_CONFIG_*` removed. Test homes/caches are isolated.
To retain the live, workspace-bound fixtures and their complete CLI transcripts, set `GARDA_P4_KEEP_FIXTURES=1`.
Each runtime records its source ref/commit; the packed candidate additionally records its tarball digest/integrity.
Without that variable the test-owned temp root is removed at suite completion.

Keep runs filtered and below about 15 minutes. For example, substitute each pattern below in this command:

```powershell
node scripts/node-foundation/build-scripts.cjs test.js --garda-shard-timeout-ms 840000 --test-name-pattern '<pattern>' tests/node/migration/p4-migration-acceptance.test.ts
```

| Pattern | Contract |
| --- | --- |
| `real old PASS\|broad FAILED\|failed own target` | Old selection/checklist/execution, retained unattributed failure and raw output after narrow PASS, predecessor identity, grouped follow-up, protected targets |
| `reset and real\|without execution identity\|old project command\|damaged old` | No inherited selection, own-test recovery, project-command reselection, integrity control |
| `interrupted update exception\|actual killed update\|focused packed upgrade\|native legacy entry` | Real materialization rollback, hard exit and safe recovery/refusal route, packaged update, accepted legacy owner |
| `project shape\|old failed test review` | Python/opaque active tasks, old failed review and preservation of an independent passed lane |

The pipe characters above are regular-expression alternatives; use them without the Markdown escaping backslashes.
Run `p4-legacy-queue-alignment.test.ts` separately for fast content-builder regressions. Its canonical/closed-task control
must stay green; its headerless-owner case reproduces T-450-1-F1 on `aafb5119` and must pass on the candidate. Run `p4-task-validation-names.test.ts` for aliases, configuration normalization and missing-identity negative controls.

Also run the required focused `synthetic-policy-reuse.test.ts` and `synthetic-walk-economy.test.ts` guards, both strict
unused-symbol typechecks, ESLint on changed TS files and `git diff --check`. Do not run complete groups or full/sweep
stands. A red acceptance remains a real assertion failure with its requirement in the title; it is never skipped or
converted to an expected-success test.

Select each of the eight policy-reuse cases separately by its exact test name: the whole file exceeds the shared
machine's per-run budget. `--garda-shard-timeout-ms` limits idle time, not total wall time; monitor the 15-minute wall
budget separately. Completed cases need not be repeated when continuing the remaining selections.

The original acceptance set is still 17 cases (15 lifecycle/compatibility plus 2 queue controls). Additional ambiguity and naming/integrity controls are reported separately. Display names use task test validation; legacy internal IDs remain unchanged. The packed continuation executes the new installed command and option aliases and checks the independent own-test process counter.

The phase-2 candidate overlay includes working publication docs as well as runtime sources. The final packed check verifies the configuration migration note in the tarball. The failed-review case additionally performs actual installed update and then follows the new installed launcher, preserving both old receipts and the passed code lane.
