# Garda reference stand: four pillars

The stand checks that Garda spends review work only where the review contract requires it, and never less. The path, policy and remediation layers run in-process without real agents or network. The navigator walk drives the real task and gate flows in disposable repositories with a synthetic agent.

## One entry point

Run from the repository root. This is local developer tooling; it never dispatches CI. The entry point clears inherited
`GIT_CONFIG_*` and puts System32 first on Windows PATH. It uses the existing build lock and does not install dependencies.

```powershell
node tests/node/synthetic/stand.cjs short --jobs 2 --report "$env:TEMP\reference-short"
node tests/node/synthetic/stand.cjs full --jobs 6 --report "$env:TEMP\reference-full"
node tests/node/synthetic/stand.cjs sweep --jobs 6 --report "$env:TEMP\reference-sweep"
```

| Level | Use | Selection |
|---|---|---|
| `short` (`sample` alias) | Every fix; minutes on the reserved stand machine | Stand units, whole unknown-stack product contract (including rename and negative controls), fixture contract, walk-economy, one policy-reuse walk (`a policy change finishes and reuses an already-started reviewer`); four representative walks (clean, source fix, opaque RED/GREEN/finding tour, polyglot A3); sampled policy and corpus layers |
| `full` | Every merge; coordinator owns the whole matrix | All walk scenarios, all 198 primary matrix walks, A8 variants and opaque tours; exhaustive policy/corpus layers and the same contract/economy checks |
| `sweep` | Before release | Full plus the existing checkpoint disturbance families and their restored undisturbed controls |

The entry is `stand.cjs`; the older individual test commands below remain useful for an exact failed check.
The product contract is split into three exact name selections (ordinary cases, original full tour, renamed full tour),
with at most two contract processes at once. All 13 cases remain required; `contract.json` aggregates their checksums/logs.
`--only id1,id2` is an explicitly partial walk selection, never full-level acceptance. `--seed` defaults to `1785881697`.
The worker count may change on resume. The full matrix and sweep must be reserved separately from other heavy work.

```powershell
node tests/node/synthetic/stand.cjs short --jobs 2 --resume "$env:TEMP\reference-short"
```

Resume requires identical source/dirty bytes, fixtures, expectations, baseline policy, seed, provider, level and selection.
Finished test stages are retained with log checksums; walks use their checksummed scenario records. Finished failures are
retained too. To verify a fix, start a fresh report on the fixed source; changing source never reuses old acceptance.
Stop the entire previous process tree before resuming. Keep the report directory and its linked artifacts together.

## Reading the single report

Open **`summary.md`** or **`summary.json`** in the printed report directory. They are atomically replaced while stages and
walks proceed, and marked `final` when the invocation ends. Each of the four pillars has binary `PASS`/`FAIL`, an
assessment (`PASS`, `FAIL`, `INCOMPLETE`, `INCONCLUSIVE` or `UNBASELINED`), reasons and relative links to evidence.
Known open findings remain red in this summary. A successful child test that permits an existing finding cannot erase it.
Coverage, review counts/FULL/DELTA/economy, counter anomalies, outcome counts and ETA are aggregated there; full raw records
remain in `walk/`, stage logs, `policy.json` and `timing/`. The parent refreshes during long scenarios and prints a
30-second heartbeat. A worker crash, unfinished stage or absent detail report cannot become a pillar PASS.

Speed has two independent assessments: deterministic **work budgets** and **step timing**. Speed PASS requires both,
including complete checkpoint coverage. A normal short run leaves timing `INCONCLUSIVE` and Speed `FAIL`: it proves only
the executed checks. Its exit status permits omitted/inconclusive timing; full/sweep exit successfully only with all four
pillars PASS. Never present a partial selection, an unreserved-machine diagnostic or an empty baseline as acceptance.

## Step timing on a reserved machine

The machine is currently shared/busy. This diagnostic exercises the refusal mechanism without claiming performance:

```powershell
node tests/node/synthetic/stand.cjs timing --jobs 1 --machine-busy --timing-routes startup/history-short,selection/history-short --report "$env:TEMP\reference-timing-busy"
```

For actual measurement, first reserve an otherwise idle machine, stop other executors/builds/CI/indexing, then set
`$env:GARDA_TIMING_MACHINE_RESERVED = '1'`. Use `short --jobs 1 --step-timing` to add timing after correctness checks, or
`timing --jobs 1` for timing alone. The latter leaves the other pillars incomplete. `--timing-routes` selects checkpoint
keys from `step-timing-manifest.json`; a subset never proves complete timing coverage.
For full acceptance in one command use `full --jobs 6 --step-timing` (or `sweep`): correctness workers finish first,
then the separate timing worker always uses `JOBS=1` after its quiet check. Only the correctness prefix uses `--jobs 6`.

Preflight samples host CPU for 30 seconds (<10% average), inventories heavy processes and records machine/OS build,
exact Node/arch, CPU/RAM/disk, power plan, Defender, coverage/cache mode and source/package/harness/checkpoint hashes.
Unavailable monitoring, an absent operator reservation, busy CPU/processes or a changed power plan gives `INCONCLUSIVE`.
The environment is monitored during each series too; invalid series retain their raw samples and are never retried until
a convenient number appears. Compile cache and Defender are not disabled. `cli-cold` is not mixed into this series.

The timing worker uses the actual compiled `resolveNextStep`, with a fresh native observation on every call. It disables
source-route instrumentation and `GARDA_NEXT_STEP_TIMING`; counters are captured in a separate pass. Five warmups precede
exactly 100 sequential calls. Only the call is between the two `process.hrtime.bigint()` reads, including native dependency
validation and snapshot/barrier closure; fixture setup, hashing, comparison, output and writes stay outside. Returned
gate/status/commands and semantic inputs must remain unchanged. Undeclared writes invalidate the series; the manifest
currently allows no advisory writes. Raw and semantic manifests are retained; only explicitly listed runtime fields and
fixture-root/native Git bindings are normalized. Target bytes, commands, roles, lanes, settings and history size remain
significant. Conservative identity mismatches are reported, never silently normalized away.

Short/long checkpoints share the same scope and commands; long adds 50 authenticated inert history events, outside the
timer, then restores the checkpoint in place. Fixed work and subprocess ceilings cannot grow; per-event parsing/visits
may grow linearly, at most once per added event. Canonical timeline-byte work is retained in raw counters. This is the
operator's reasonable-growth rule, not a zero-history-growth requirement.

Median averages the central pair; p95 is nearest-rank `ceil(.95*N)-1`. Both show baseline/candidate, Δms and Δ%; baseline
zero gives null %. FAIL means growth exceeds `max(absolute, relative*baseline)`: initially median 10%/20ms, p95 15%/50ms,
sealed before the candidate. Baseline machine/OS/Node/mode/protocol/checkpoint/semantic identities must match. New or missing
checkpoints are unbaselined/incomplete. Raw accepted release inputs/samples stay embedded/linked in evidence. A paired
previous-release control can be retained as a separate timing run; it is not fabricated by this harness.

`timing/step-timing.json` is written after each checkpoint, including progress/ETA and counters. Resume runs a new idle
check and rebuilds navigation prefixes; only completed, unchanged timing series survive, while interrupted series start
from the beginning. Source/package/environment/checkpoint/protocol mismatches refuse resume. There is deliberately no
accepted timing baseline in the initial stand: the busy machine cannot supply one.

## Deliberate baseline decisions

Normal runs never write budgets, timing baselines or expectations. `baseline-policy.json` seals their bytes; editing
them (or the expectation source manifests) without a recorded decision makes the report red. Prepare and review the
candidate first, then use the same entry point with a written reason and exact release/full source commit:

```powershell
node tests/node/synthetic/stand.cjs baseline --kind timing --candidate "$env:TEMP\quiet-release\timing\step-timing.json" --reason 'Accept independently measured release on reserved perf machine' --release 1.4.4 --source-commit <40-hex-sha> --expected-sha256 <current-baseline-sha256>
```

Kinds: `counters`, `timing`, `timing-manifest`, `expectations`. `--expected-sha256` prevents overwriting an intervening
decision. `expectations --candidate current` seals the reviewed current review/scenario/oracle source hashes without
changing expectations. Other candidates are JSON files. Timing requires complete quiet 100-sample records, and counter
updates cannot raise/remove existing subprocess ceilings. A timing-manifest change (including normalization or limits)
also needs its own reason. Evidence under `baseline-decisions/` retains the previous and accepted JSON, hashes, reason,
release and commit; it is written before replacement. Review and commit that evidence with the proposed baseline.
A red report never invokes this command, and raising a budget to hide a red result is not an acceptable decision.

Code lives in `scripts/node-foundation/synthetic/`:

- `model.ts`: file roles, review lanes, seeded random generator.
- `stacks.ts`: conventional paths per technology stack for every role, plus conventions a path cannot express.
- `oracle.ts`: independent expectations written from the documented contract. It never imports a production predicate.
- `path-layer.ts`: every stack × role × change variant through the shipped classifiers (test path, domain reviews, remediation category).
- `policy-layer.ts`: every combination of the FULL/DELTA remediation mode inputs and every rerun case of the remediation rerun policy.
- `stand.ts`: runs the layers, replays the corpus and compares the findings with `known-findings.json`.

The remediation engine lives in `engine/remediation-engine.ts` because it reuses the review-cycle test fixtures. A scenario is one failed review and its fix on one stack: scope files by role, the failed lane, and fix edits sized around the thresholds. The engine builds the authenticated review baseline in a disposable repository and runs the real restart-cycle decision path in-process (delta classification, FULL/DELTA guards, rerun and reuse decision), then compares the decision of every required lane with the oracle. A failed verdict is never reusable, so the failed lane is always reviewed again, and no lane may count as reused before evidence exists.

## Runs

| Run | Command | When |
|---|---|---|
| Sample | part of the normal test suite (`tests/node/policy/synthetic-review-stand.test.ts`, `tests/node/cli/commands/gates/review-cycle/gates-review-cycle-synthetic-remediation.test.ts`) | every test run |
| Exhaustive | `node scripts/node-foundation/build-scripts.cjs test.js tests/node/synthetic/synthetic-stand-exhaustive.test.ts` | before each release |
| Random | `GARDA_SYNTHETIC_SCENARIOS=500 GARDA_SYNTHETIC_SEED=<n> node scripts/node-foundation/build-scripts.cjs test.js tests/node/synthetic/synthetic-remediation-random.test.ts` | before each release and whenever review logic changes; about 0.4 s per scenario |

Random runs pick a new first seed unless `GARDA_SYNTHETIC_SEED` is set; the report names it, so any run can be replayed. Unexplained findings are minimized and written to the report as corpus candidates.

The exhaustive run writes a JSON and Markdown report to `GARDA_SYNTHETIC_STAND_REPORT` (or a temporary folder) and prints its path. It is not an npm script on purpose: `scripts/manual-ci-evidence.cjs` seals the complete npm script set as the reviewed CI contract.

## Findings

Each finding has a stable id and a kind:

- `safety`: Garda does less review work than the contract requires.
- `economy`: Garda spends review work the contract does not require.

The engine runs with the review dependency graph every task gets by default (`strict_sequential` without a declared graph). Graphs a profile declares are covered by `review-remediation-rerun-policy.test.ts`.

`known-findings.json` lists open findings with a note. The exhaustive run fails on any finding missing from the list and on any listed finding that no longer reproduces, so fixes must remove their entries. The sample run does the same for path findings only, because a sample may legitimately miss a policy case, and the random run only reports findings missing from the list. Engine findings are identified by root cause and need their own entry; `known-engine-scenarios.json` holds a minimized reproduction for each, and the normal suite checks that they still reproduce. An open path finding does not explain an engine finding on the same file.

## Corpus

`corpus/*.json` (path and policy cases) and `corpus-engine/*.json` (engine scenarios) hold minimized cases of past defects and must stay green. The sample and exhaustive runs replay `corpus/`; the normal suite replays `corpus-engine/` (`gates-review-cycle-synthetic-remediation.test.ts`). The random run replays neither, so run it together with the normal suite. Add an entry when a stand finding is fixed.

## Navigator walk

The navigator stand is developer-only code under `tests/node/synthetic/engine/`. Nothing in `src/` imports it. It drives real `resolveNextStep`, real task/gate flows and authenticated synthetic reviewer launches in disposable Git repositories. It shifts the fixture clock rather than sleeping through reviewer timing windows. The walk sets the documented `GARDA_UPDATE_CHECK=0` opt-out: otherwise enter-task-mode starts a detached update-availability scheduler that keeps writing into the fixture while the walk copies, measures and removes it. Walk directories are removed with `removeWalkDirectory`, which enumerates the tree again when a late write leaves an entry behind. It does not exercise a live provider or a network transport.

Set `GARDA_SYNTHETIC_WALK_PROVIDER` to a registered provider with a detection marker, such as `Claude`; the default is `Codex`. The stand clears inherited provider markers and installs the selected provider's marker, so detection is exercised rather than inherited from the shell. The `reviewer-report-broken` walk models the calling agent returning to its original reviewer, recording the bound response and submitting its correction: that lane must have exactly one launch. `reviewer-report-unreachable` and `coverage-correction-lost-launch` require exactly one additional FULL launch of the affected lane. These walks use synthetic provider receipts and do not prove a live provider transport.

### Run levels

On Windows, put the system `tar.exe` first on `PATH`. For example, in PowerShell:

```powershell
$env:PATH = "$env:SystemRoot\System32;$env:PATH"
$env:GARDA_SYNTHETIC_WALK_LEVEL = 'sample'
$env:GARDA_SYNTHETIC_WALK_JOBS = '2'
$env:GARDA_SYNTHETIC_WALK_REPORT = "$env:TEMP\garda-walk-sample"
node scripts/node-foundation/build-scripts.cjs test.js tests/node/synthetic/synthetic-navigator-walk.test.ts
```

Set `GARDA_SYNTHETIC_WALK_LEVEL` to:

| Level | Work | What it proves |
|---|---|---|
| `sample` (default) | Existing clean pass and failed-review source fix, opaque gate tour, Maven/TypeScript A3 | Representative liveness, review economy, opaque case evidence and multiple commands. It reports incomplete coverage. The default timeout remains 30 minutes. |
| `full` | All old scenarios, all 198 primary matrix walks, 15 A8 review variants and two opaque tours | Exact outcomes/review modes, counters and source-derived route accounting. Every unexplained gate or BLOCKED route point fails. |
| `sweep` | Full plus existing disturbances and bounded unknown/Maven/polyglot recovery families | The three additional A1 baselines receive observed artifact loss/corruption/staleness, repeated/wrong commands, criteria/policy changes, resets and seeded combinations. Node-specific source edits and failure flags are excluded from these extra families. The emitted manifest defines coverage. |

`GARDA_SYNTHETIC_WALK_JOBS=1..24` controls processes for all levels and sweep families. Use 20 on the 24-core stand machine. A process runs one scenario at a time because cwd, the shifted clock and the observer are process scoped. The parent merges worker results and enforces coverage only after aggregation; an absent or crashed worker is a finding. A checkpoint family executes its prefix once, requires an undisturbed restored control to reach DONE, then restores the same fixture path and native identities for each variant. Unchanged evidence timestamps are preserved. Shared prefix traces are marked and excluded from duplicate measurement/coverage counts. Build entrypoints still use the existing single-build lock.

The existing normal-suite sample remains `tests/node/cli/commands/gates/review-cycle/gates-review-cycle-synthetic-walk.test.ts`. The short stand-contract tests are `tests/node/policy/synthetic-walk-contract.test.ts`. Neither normal test path dispatches a full or sweep run. Output capture belongs to the gate's asynchronous context and forwards Node's test protocol; a sentinel regression checks that an earlier failed test remains visible and its child process exits nonzero.

### Project descriptors and stack matrix (1.4.4)

`engine/walk-fixture.ts` owns project files, compile/project-reference commands, native case claims,
trust-boundary evidence and the reviewer output contract. Its default Node descriptor preserves the old
fixture bytes and commands. A fixture does not need `package.json`, `src/app.ts`, `tests/app.test.ts` or TAP.
Garda's own package/runtime inputs are still required to install the real native gates in a disposable project.

`tests/fixtures/stacks/catalog.json` lists 19 projects. Each `fixture.json` names its sources, test groups,
technology-specific argv, helper/data inputs and optional adapter identity; `project/` contains its manifests
and source tree. `tasks.json` specifies nine distinct tasks. The shared `runner.cjs` is copied into each project,
behind executable-name-preserving `.cmd` and POSIX wrappers. It checks exact cwd/argv/module/filter/targets,
reads the actual test and production patches, and emits realistic output plus optional XML/TRX. Its log is
only an independent harness oracle in `.git/stand-invocations.jsonl`; it never creates Garda artifacts.
The modeled reviewer reads current source hashes and the retained native output before resolving a case.

| Projects | Shape |
|---|---|
| `spring-maven`, `java-gradle`, `kotlin-gradle` | External Spring Boot parent, three-module reactor, unrelated JaCoCo excludes, `-pl` lists and `-Dtest`; Java/Kotlin multi-project Gradle |
| `dotnet`, `go`, `rust`, `python`, `node` | Solution/two test projects with same-named classes; Go packages; Cargo workspace; pytest packages/helpers/data; Node modules/TAP |
| `php-phpunit`, `php-laravel` | Composer/PHPUnit and Laravel feature/unit tests |
| `vite-playwright`, `pnpm-nx` | Vitest and browser invocations; pnpm/Nx projects with Jest targets |
| `ruby`, `elixir`, `swift`, `cmake` | RSpec, ExUnit umbrella, XCTest targets, separate CMake build and CTest filtering |
| `unknown-quartz` | Invented `.qz` production, `.case` tests, opaque output, helper/data operands, no known manifest |
| `polyglot-maven-ts`, `polyglot-python-go` | A single task owns targets in two technologies and needs both invocations |

Every project has A1 production/regression, A2 test-only boundary, A3 two components, A4 docs-only,
A5 own failure/fix, A6 retained broad failure/narrowing/follow-up, A7 RED before implementation/GREEN,
A8 security/refactor lanes and A9 native parent/two children/aggregate audit. A9 checks review modes
per child task ID and accepts native SOURCE only in the disposable Git repository. A4 requires zero
reviewer launches and no compile/test subprocess. Ordinary agents choose only their task's targets,
one invocation per technology; A6 is an explicit mistaken or inherited broad attempt, performed once.

IDs are `stack-<fixture>-a<N>-generic` and `stack-<fixture>-a<N>-auto`. There are **171 generic + 27 auto =
198 primary walks**: Node, Maven and Maven/TypeScript have adapter peers. Auto supplies additional reports;
generic omits them. Both use identical native gate handlers. An admitted generic result must retain its
outcome, reviews and modes in auto. A partial adapter-only selection reports its missing generic peer.
Representative opaque/Maven/polyglot A8 variants append `-test-fix`, `-protected-fix` or `-scope-expansion`;
their independent oracle requires test DELTA, protected security FULL, or expanded-scope FULL respectively.

`engine/walk-unknown-stack-contract.ts` declares the long opaque gate tour and its executable/extension/layout
rename control. Compile and test commands start unconfigured; the agent attempts task-local compile declaration.
`UNKNOWN_GATE_OBLIGATIONS` requires actual native routes, including RED, two targets, checklist, focused
validation, reviews, follow-up and completion. Unknown-stack refusal is never a declared successful handoff.
The product contract and source-derived route inventory remain separate acceptance checks.

The small runner contract suite is `synthetic-stack-fixtures.test.ts`. Negative controls include no-op,
ignored selectors, wrong module/filter, stale XML, exit zero with zero cases, skipped cases, dropped second
module and stdout/report disagreement. Partial polyglot GREEN and source changes after execution fail the oracle.
These controls test the simulator/reviewer contract; they are not native toolchain acceptance or a substitute
for the product's authenticated-evidence integrity controls.

The run manifest seals fixture manifests, every project/runner byte, task specifications, adapter identity/mode
and oracle version in addition to the existing source-input identity. Changing any refuses resume. Completed
PASS and FAIL records retain the same atomic/checksum semantics; changing worker count remains allowed.
Old review expectations and counter budgets are unchanged. New route/state calibration stays pending until
an undisturbed native route is reached and independently measured; an early blocked walk is not calibration.

Small local smoke selection (PowerShell, after putting System32 first and removing `GIT_CONFIG_*`):

```powershell
$env:GARDA_SYNTHETIC_WALK_LEVEL = 'full'
$env:GARDA_SYNTHETIC_SEED = '1785881697'
$env:GARDA_SYNTHETIC_WALK_PROVIDER = 'Codex'
$env:GARDA_SYNTHETIC_WALK_JOBS = '4'
$env:GARDA_SYNTHETIC_WALK_ONLY = 'stack-unknown-quartz-a1-generic,stack-unknown-quartz-a6-generic,stack-spring-maven-a1-generic,stack-spring-maven-a6-generic,stack-polyglot-maven-ts-a1-generic,stack-polyglot-maven-ts-a6-generic'
node scripts/node-foundation/build-scripts.cjs test.js tests/node/synthetic/synthetic-navigator-walk.test.ts
```

For adapter smoke, append the four corresponding `-auto` IDs for Maven and Maven/TypeScript to this selection;
keep their generic peers in the same report so parity can be assessed. This is ten walks, not the full matrix.

Do not run the whole matrix as an ordinary local check. Current product failures stay red and are reported by
their native gate; neither a fixture-specific handoff nor a wider counter budget hides them.

Planning estimates, not new benchmark claims: sample at two workers 5–20 minutes; the 198-walk matrix at
20 workers about 1–3 hours, with old scenarios and extra controls added separately. At four workers allow
roughly 3–6 hours for the matrix, especially A9. Full costs matrix + old scenarios + controls. Sweep needs
its emitted manifest and observed checkpoint durations before an ETA is meaningful; it must not be estimated
by multiplying every old disturbance by every stack. These Windows simulator measurements do not certify
real Maven/Gradle/browser toolchains or native Linux/macOS behavior.

### Durable progress and resume

Each finished scenario, including each restored sweep control and variant, is immediately written to
`scenarios/<id-hash>.json` using a temporary file and atomic rename. Records contain the complete
result and its per-scenario findings, a run identity and a checksum. Temporary, corrupt or mismatched
records are unfinished. The parent prints one `Walk finished/total id outcome elapsed=... counts ETA=...`
line per completion (parallel workers are polled every 250 ms). `progress.json` and
`partial-findings.json` are replaced atomically after every observed completion. A parent heartbeat refreshes
them and prints progress every 30 seconds, including while a long A9 has not completed a scenario. Partial findings judge
outcomes, handoff/guidance, review counts/modes, expected gates/source routes, loops and review economy;
coverage and cross-scenario counter budgets are explicitly incomplete until final aggregation.
During sweep planning the total grows to include generated variants and controls. ETA uses this
invocation's completion rate; before a fresh completion it is unknown. Reused results are labelled.

To continue an interrupted run, stop its entire process tree, keep the same code and selection, and set:

```powershell
$env:GARDA_SYNTHETIC_WALK_LEVEL = 'full' # or the earlier level
$env:GARDA_SYNTHETIC_WALK_JOBS = '10'   # may differ from the earlier run
$env:GARDA_SYNTHETIC_WALK_RESUME = 'C:\reports\earlier-walk'
# Preserve the earlier seed/provider/ONLY/disturbance/replay/quiet/diagnostics settings.
# Remove a stale REPORT setting to continue in the earlier directory:
Remove-Item Env:GARDA_SYNTHETIC_WALK_REPORT -ErrorAction SilentlyContinue
node scripts/node-foundation/build-scripts.cjs test.js tests/node/synthetic/synthetic-navigator-walk.test.ts
```

`REPORT` may instead name a new empty directory; reused records are copied there. Resume verifies
`run-manifest.json` and the canonical `run-inputs.json` hash before reusing or overwriting evidence.
Seed, level, provider, selection/scenario manifest, source commit, source bytes, Node version and OS
must match; changed inputs cause a clear refusal. Pre-checkpoint reports without these files cannot
be resumed. Finished failures are reused too; use a fresh run after changing code. Only missing or
invalid scenarios execute. A sweep family is reusable only with its completion marker and all matching
control/variant records. A partial family reruns entirely, restoring a fresh control first and preserving
shared-prefix accounting. The final results, findings, coverage, budgets and reports use all results.
Do not run concurrent writers against a report directory.

Explicit full/sweep/selected walks have no default Node test or shard idle timeout. Heartbeats remain
enabled. `GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS` (including `0` to disable) and
`--garda-shard-timeout-ms` still override the shard deadline; the environment takes precedence.
The ordinary discovery sample retains its 30-minute Node test limit.

### Coverage evidence

`walk-routes.ts` parses the TypeScript AST of every source file in `src/gates/next-step/` and the explicitly listed external native route builder `src/gates/parent-audit/parent-audit-navigation.ts`. Both are instrumented and retained as run inputs. It inventories executable `nextGate`/`next_gate` assignments, including conditional alternatives, and objects whose status expression can produce BLOCKED. Comments, interface types and timeline events merely labelled BLOCKED do not count. Source IDs are file:line:column; source edits deliberately invalidate old exemptions. Tests pin a minimum source inventory and representative unusual routes, and exercise conditional extraction and negative cases. An imported or computed gate/status expression that cannot be resolved causes an explicit `unresolved-source-*` accounting failure even if no scenario reaches it; extend the extractor before claiming coverage of that syntax.

A test-only module loader instruments source expressions in memory. Object identity follows the selected route through property reads, spreads, result builders and the output renderer. Evaluating a candidate does not count as reaching it, even if its text equals the selected candidate. No source or built production file is rewritten. Each step records status, gate, lane-qualified route and source point IDs. Effect-command returns are recorded too; coverage counts each gate/source point once per physical step. Atomic `scenarios/*.json` records and the final merged `results.json` retain commands, outcomes, artifact inputs, measurements and task event counts. Each report scenario retains its terminal route, full refusal/error detail and replay. `run-inputs.json` hashes all stand, production, template and fixture inputs (tracked files, deletions and untracked source files); `run-inputs/` retains their source and baseline bytes alongside the original source commit.

`navigator-walk.json` and `navigator-walk.md` contain reached and unreached gates and BLOCKED points, with step counts. `known-uncovered-routes.json` is an array of `{ "id": "gate:... or source:line:column", "reason": "concrete external prerequisite" }`. A removed/unknown ID, empty explanation or "hard to reach" explanation fails. A full/sweep run fails for every uncovered entry without an explanation. The current 24 exemptions retain 14 dormant native-graph entries, nine historical-format entries, and one interrupted correction state that additionally needs unavailable reviewer identity. Each proof and native producer is audited in `coverage-exemption-audit.md`. Current native review gates produce schema 4 and reject downgrades; current JSON findings still use their real dispositions. The dead `startup-readiness` string fallback's containing BLOCKED source point still needs coverage. Remaining unexplained gaps are failures. Read `coverage.unaccounted` for the exact outstanding list. `known-walk-findings.json` also stays empty.

`engine/walk-route-closure-scenarios.ts` closes routes the families above never reached. Each scenario deletes or changes one file at a fixed moment of an ordinary task (startup, preflight, task-mode, correction package, launch input, context, prompt, snapshot, receipt or launch evidence; a token-economy or review-lane policy change), never writes authenticated evidence, and pins the selected source route in `expectedRoutes`. Recoverable losses must reach DONE with only the rule-required repeat (the affected lane once in FULL); a lost frozen task policy, an unprovable startup timeline and an unadoptable policy change end at an operator handoff that names the side-effect-free `task-reset --reopen --dry-run` preview. Routes proven unreachable for current gates (correction-only invocation and pending transport selection since provider-agnostic correction, a failure kind without a producer, a discarded effect-execution result and two dead duplicates) are explained in `known-uncovered-routes.json` instead.

The malformed-timeline cases must stop before pending effects and name the reset preview. A separate modeled operator repair removes only the unparseable line, rebuilds derived indexes and reaches DONE with code=1/test=1. The upstream-prompt loss before downstream launch must pass both review gates after evidence-only recovery with code=2/test=1. Scripted policy/evidence-loss injections select their checkpoint by gate and review lane; quality-checklist preparation can add lifecycle steps, so they do not use fixed offsets. Generated sweep manifests retain exact numeric replay indices. `synthetic-policy-reuse.test.ts` also checks all three `coverage-policy-change-*` checkpoints explicitly: each retains code=1/test=1, both FULL.

### Disturbances and replay

The exemption audit at `17f4edb7` is in [`coverage-exemption-audit.md`](coverage-exemption-audit.md), with a disposition for each of the original 32 IDs. It retains 24 exemptions: 14 dormant native branches, nine historical-format routes, and one correction-identity combination. The eight removed entries are asserted by six new scenarios:

- `coverage-full-suite-owner-in-flight` and `coverage-declared-recipe-in-flight` run real native gates in child owners. An ordinary fixture test waits on a `.git/walk-owner/release` file while the instrumented navigator selects the active-owner route; release and native result collection precede continuation to DONE.
- `coverage-full-suite-owner-crashed` waits for the native cycle-bound marker and the actual test child's readiness, then terminates the recorded child and owner before publication. It asserts the exact interrupted-run handoff. A Windows descendant-scan permission failure remains native diagnostic evidence and never authorizes marker cleanup.
- `coverage-publication-delegation-start`, `coverage-publication-launch-complete`, and `coverage-publication-correction-transport` start unmodified native gate code under Node's debugger. A unique compiled statement supplies the breakpoint between durable publication and the next authenticated write. Only a pause at that breakpoint permits interruption. Both launch recoveries continue to DONE without rewriting returned reviewer output; the correction scenario retries the interrupted closed-session transport publication and then performs one FULL restart of the affected lane.

These are deliberately disturbed scheduling/publication cases; their measurements are retained as disturbed work, with no new counter budgets or performance acceptance claim. `expectedRoutes` asserts selected source IDs independently of gate names. Every readiness/debugger/exit wait has a monotonic deadline, and scenario cleanup runs before fixture removal on success or failure. The blocker files are ordinary ignored fixture controls, never authenticated artifacts, PIDs, events, receipts, or run markers. The owner records its real native marker in the trace before interruption. No production hook, source rewrite, or authenticated evidence mutation creates these states. Replay them with `GARDA_SYNTHETIC_WALK_ONLY` as described below; the ordinary sample remains unchanged.

`sweep-manifest.json` names every mutation, baseline, checkpoint, variant and unsigned 32-bit seed. Replay IDs hash ordered mutation roles and normalize fresh artifact nonces; adding another single mutation does not renumber existing IDs. Colliding roles fail. `sweep-applicability.json` names what was applicable and what was omitted at each step. The default seed is fixed (`0x6a726461`); change it with `GARDA_SYNTHETIC_SEED`. The generator applies every single applicable mutation and selects reproducible combinations of two to four compatible mutations. It does not combine contradictory mutations of the same artifact.

Mutations include production/test/document edits, repeating the preceding executed command (including effects), actual configured compile/full-suite command failures, stale task-event locks, changed task criteria or the task's own profile `review_policy`, reset attempts, and deleting/corrupting/staling existing preflight, context, report, receipt, launch and checklist inputs. The added single edits cover a production change over 240 lines, a test change over 50 lines, a new production file, a new test file, an existing shared test helper, and an existing protected auth file. The helper and auth edits apply after implementation in the `security-refactor-pass` baseline, where both files are in scope and both reviews are required. The new edits and `change-policy` are singles, so they do not change existing seeded combinations. Input discovery observes the real action's content/descriptor reads and exists/stat/lstat metadata probes, including effect execution; newly created outputs and transaction staging files are excluded. Digest-named inputs replay only when their role resolves uniquely. Synthetic staleness changes same-task content bindings and timestamps, preserves task identity, and does not assume that mtime alone determines freshness. This is binding invalidation, not replay of an older authenticated artifact version.

An injected edit before implementation does not replace the task's planned work: if navigation moves ahead because the injected file is already dirty, the agent still makes the planned edits once and refreshes the affected evidence. When the policy-change gate explicitly asks to re-enter task mode and refresh preflight, the agent tries the prior unconfirmed entry command once. It never supplies operator confirmation; after a passed review gate it waits for the separately modeled user approval before that recovery.

For the current baseline traces (30, 18 and 44 nonterminal steps), each of `change-policy`, `edit-production-large`, `edit-test-large`, `add-production-file` and `add-test-file` adds 92 single variants. `edit-shared-test-helper` and `edit-protected` add 37 each, after implementation in the four-lane baseline. These 534 singles are in addition to the variants the third baseline adds for existing kinds; actual counts follow the emitted manifest if a baseline changes.

`wrong-gate` models an agent that ignores `next-step`. At a checkpoint step, instead of the named command, the agent runs a different real gate with valid arguments: `compile-gate`, `build-review-context` (code lane), `required-reviews-check` (with a code/test authorship attestation), `completion-gate` or `restart-coherent-cycle` (task intent and the scenario's changed files). Then it follows `next-step` again. The checkpoints are the first step of `implementation`, `compile-gate`, `full-suite-validation`, `build-review-context`, `record-review-result`, `required-reviews-check` and `completion-gate` in each baseline. Every wrong gate except the named one runs at each checkpoint: 31 cases on `clean-pass`, 22 on `document-only`, plus those on the `security`/`refactor` baseline. They reuse existing checkpoint families, so they add no prefix or control runs. Wrong gates are single variants only; combinations draw from the other disturbances, so existing combinations and replay IDs are unchanged. The step retains the wrong gate's command, exit status and output in `wrongGate`. The gate may refuse or do harmless work, but the agent's mistake must never cost a new review cycle. Findings, all compared with the same baseline without the disturbance (the manifest carries its review counts, milestones, restart events and acceptable return routes in `undisturbed`):

- `walk:wrong-gate-crashed`: the gate failed with a programming error such as a `TypeError` or `SyntaxError`, not a refusal.
- `walk:wrong-gate-extra-reviews`: any lane launched more fresh reviews than the baseline, whatever the terminal outcome.
- `walk:wrong-gate-restart`: more `REVIEW_CYCLE_RESTARTED`, `COHERENT_CYCLE_RESTARTED` or `TASK_RESET` events than the baseline.
- `walk:wrong-gate-not-returned`: the next navigation after the wrong gate names neither the step it named before nor the step the baseline reaches right after its own later run of that gate (legitimate early work).
- For a variant that reaches DONE: `walk:wrong-gate-fewer-reviews` (fewer fresh reviews in a lane) and `walk:wrong-gate-skipped` (the baseline's compile, full-suite, review-gate and completion evidence is missing, in the baseline's order, after the latest `IMPLEMENTATION_STARTED` or `COHERENT_CYCLE_RESTARTED`).
- The ordinary loop, exception and stuck outcomes.

Garda's side of this contract: `restart-coherent-cycle`, `compile-gate`, `build-review-context` and `completion-gate` ask the side-effect-free navigator before changing anything (`src/cli/commands/gate-flows/support/out-of-order-gate-guard.ts`). When it positively routes an intact cycle forward elsewhere, they refuse with a `*_REFUSED` header and name `next-step`. A restart is refused at any forward gate from implementation to completion; compile after its pass is still current, or before implementation; a review context while that lane's launch is in flight or after every review is recorded; completion before the current cycle's `REVIEW_GATE_PASSED` (checked from the timeline, so no `COMPLETION_GATE_FAILED` forces a new cycle) or while next-step routes to an earlier gate. A navigator that throws or needs effects executed never blocks a gate, so recovery paths stay available; startup and preflight-preparation routes are not judged. `tests/node/cli/commands/gates/review-cycle/gates-review-cycle-wrong-gate.test.ts` is the normal-suite regression: real wrong gates at the in-flight code review and at `required-reviews-check` of `clean-pass`.

Reset policy and confirmation requirements stay real. For a reset disturbance the modeled operator confirms Garda's audited one-action reset; the fixture's permanent reset policy remains disabled. `RESET_COMPLETE` is required when there is task state to remove; at the initial TODO checkpoint Garda can instead report `ALREADY_RESET` with no remaining artifacts. On re-entry the operator supplies the known task and injected edit paths as planned scope. Preserved implementation is not written a second time, and an injected edit cannot substitute for planned implementation that has not yet happened. In a combination the reset runs first, and an artifact removed by reset is disturbed when its unique role is recreated. The stand reports a scheduled disturbance that never takes effect. An ordinary BLOCKED gate is not automatically an acceptable terminal state. A stopped walk, unhandled exception, repeated command without progress, missing scheduled injection or diverged prefix is a finding. Workspace hashes include Git outputs and untracked file content, never child process IDs. A multi-gate recovery cycle cannot count extra telemetry or fresh command hashes as workspace progress. Full scenario families additionally check independent review counts/modes. A mutation may legitimately change the baseline's exact review counts, so sweep variants check liveness/refusal and judge their reviews against the rule-derived bound in "Review economy of disturbed variants" below.

`engine/walk-coverage-scenarios.ts` groups additional test-first, decomposition, timeout, optional-skill, task-plan and recovery cases. Configuration runs before fixture initialization; preparation and agent-action hooks record real gate commands and refuse failed admissions. They never manufacture authenticated lifecycle evidence. Named fault cases carry a disturbance reason and retain their counter measurements in the disturbed report. Ordinary family cases remain subject to counter budgets and growth checks. The current-cycle reuse cases (`coverage-repeat-compile-*`, `coverage-failed-review-recompile*`, `coverage-upstream-reuse-*`) no longer repeat compile-gate with unchanged source, which compile-gate now refuses as out of order. They lose the authenticated compile report after a recorded review; next-step names compile-gate, the native review-cycle guard counts the integrity incident, and the synthetic operator approves exactly one more cycle with the native `record-review-cycle-continuation` command. The source still matches the reviewed state while the latest compile is newer than the review. A stray source edit after a review is not an equivalent: next-step measures it against the passed reviews through `restart-review-cycle` (see "Review economy of disturbed variants").

Declared human handoffs require the exact terminal status, gate (including a deliberate null gate), and specific guidance. Reaching DONE instead is a failure. Required intermediate gates are also asserted. A handoff returned by effect execution is retained as the actual terminal result, so the walker does not discard it and manufacture a loop. Executable optional-skill, planned-scope and review-follow-up cases continue to DONE; the Node backend case requires the additional API review.

For a write after `REVIEW_GATE_PASSED`, `source-edit-before-completion` follows the instruction to revert the agent's late edit and reaches DONE with one code review and one test review. `source-edit-before-completion-user-approves` models explicit user permission, supplies `--review-restart-approved yes` and the approval timestamp, and reaches DONE after a second review cycle that follows the rules of a change before the gate (operator decision 5): `restart-review-cycle` measures the small source fix against the passed baseline, so code and test repeat in `DELTA`. A sweep variant whose injected edit lands after `REVIEW_GATE_PASSED` has nothing the agent can revert, so the synthetic user approves the new cycle the same way and the economy judgment sees it. The separate approval never supplies task-mode `--operator-confirmed` consent. Lost review evidence with an unchanged workspace follows ordinary recovery without this approval.

Repeated-command attempts retain their command, exit status, exception flag, output and duration in `repeatedCommand`, then let navigation continue. A failed attempt remains a finding unless it is an actionable integrity refusal, or the out-of-order refusal of `out-of-order-gate-guard.ts` for that same gate (a `*_REFUSED` header, the route next-step names, "Nothing was changed." and next-step as the way out) and the workspace and every runtime artifact and event are byte-identical before and after the attempt (`repeatedCommand.stateUnchanged`). Command handoffs are checked against Garda's registered gate names; merely suggesting the same rejected command is insufficient. Explicit upstream-review handoffs must identify actual review lanes. Messages containing only words such as "invalid" or "missing" never excuse a thrown command. Each exception is judged at its own step: a later human handoff cannot excuse an earlier unactionable exception. The specific stale effect-plan instruction to rerun read-only inspection is distinguished from repeating rejected effect execution.

An actionable refusal may return a normal nonzero CLI status or throw; the stand recognizes both. A sweep containing only edits, repeated commands, a failed or wrong gate, changed criteria or policy, a stale lock, or an authorized reset must reach DONE. The exception is an actual code-review safety-floor refusal that names both reverting the edit and an operator reset with a profile including code review. Other outcomes produce `walk:operator-stop:<kinds>:<scenario>` with the stop text, including a BLOCKED outcome, a clean `task-reset --dry-run` preview, a generic request for approval or a loop; the loop and other stand diagnostics remain separate findings. Damaged task-history or task-entry integrity evidence may require a concrete human repair or reset. Lost reviewer launch control or its lane reservation may require the explicit operator reset that forbids reconstructing authority. Lost startup, preflight or full-suite evidence alone must be rebuilt, and a lost review's evidence requires recovery of that review. Even on a permitted stop, launches already made are checked against the upper bound. A direction to run `next-step` or another gate returns to navigation, where a dead end or loop is a finding. Explicitly declared non-sweep handoffs keep their own exact guidance. Historical traces where the agent continued past a valid human refusal remain failing `ignored-refusal`/`ignored-instruction` stand findings, with their original guidance.

Replay one finding by setting `GARDA_SYNTHETIC_WALK_ONLY` to its scenario ID and using the same seed and level. For a sweep ID, the runner rebuilds its baselines and manifest and selects that ID. Unknown IDs fail. For example:

```sh
GARDA_SYNTHETIC_WALK_ONLY=sweep-clean-pass-s10-d26617844c725-seed1785881697 \
GARDA_SYNTHETIC_SEED=1785881697 GARDA_SYNTHETIC_WALK_JOBS=1 \
node scripts/node-foundation/build-scripts.cjs test.js tests/node/synthetic/synthetic-navigator-walk.test.ts
```

Use the actual ID and decimal seed from your report; the command above only illustrates the format. A selected replay is partial and does not certify full coverage.

For an exact replay or continuation of a retained run, also set `GARDA_SYNTHETIC_WALK_REPLAY_MANIFEST` to that run's `sweep-manifest.json` and set `GARDA_SYNTHETIC_WALK_ONLY` to the selected IDs. The stand validates each ID, seed, checkpoint gate and baseline economy facts against the fresh baseline, uses the saved disturbances, and still restores a fresh checkpoint control. This preserves a combination even when a fresh baseline observes a different set of artifact reads; unresolved or diverged inputs fail explicitly instead of being silently dropped.

### Review economy of disturbed variants

`engine/walk-economy.ts` judges launches in every terminal sweep variant against a bound computed from the operator's review rules. A launch is counted when delegation starts, including when the reviewer has not returned before the walk stops; its mode is read from the context at that point. An unfinished walk cannot yet miss a future required launch, but every launch already made is judged. The bound uses facts of the undisturbed baseline (the steps that launched, completed and recorded each review, the files its reviews covered, a declared dependency graph) and of the disturbance (the edit's file, role and line count from `SWEEP_EDITS`, the lane an artifact belongs to). A scenario can independently declare lanes removed by changed criteria or reset; Garda's own reclassification cannot erase a baseline requirement. A final preflight's positive selection can also establish a first required lane. Launches before the injection step belong to the shared prefix. The baseline's launches from that step on are planned with their baseline modes. A still-open review reached by an edit cannot yet authenticate its reviewed tree, so its fresh review is FULL. On top of the planned launches a lane that already finished may repeat as follows:

For first reviews the fixture also independently requires `code` for production changes, `test` for the new test or a large/shared-helper test change, and `security` for the protected auth change. An incorrect negative preflight cannot hide those first launches. A large or shared-helper test edit reaches `refactor`, but does not by itself turn an optional, previously unrequired lane into a required one; a separately required `refactor` review is checked as planned or repeated.

| Disturbance | Repeats allowed |
|---|---|
| `stale-lock`, `repeat-last`, `fail-gate` | None. A finished but unrecorded result is simply recorded. |
| `edit-production` | `code` and `test` (the test review covers the code its tests verify), once each: `DELTA` for a small fix, `FULL` otherwise. Other lanes are kept. A finished but unrecorded review counts as passed: it is recorded against the tree it reviewed, then this rule applies. |
| `edit-test` | `test` (plus `refactor` above 50 changed lines), once: `DELTA` when small. Other lanes, finished but unrecorded ones included, are kept. |
| `edit-test-large`, `edit-shared-test-helper` | Required `refactor` and `test` reviews repeat in `DELTA` for these small fixes; `code` is kept. |
| `edit-production-large` | Reached reviews repeat in `FULL`, because the fix exceeds 240 lines. |
| `add-test-file` | Only `test` repeats, in `DELTA` when small; the new test alone does not expand scope. |
| `add-production-file` | A non-test, non-document file expands scope: every existing lane repeats in `FULL`. |
| `edit-protected` | `security`, the auth owner, repeats in `FULL`; other reached lanes follow the small-fix rule. |
| `edit-document` | None. |
| `change-criteria`, `change-policy` | Every lane once, in `FULL`. |
| `delete`/`corrupt`/`stale-artifact` of a lane's receipt, report, context or launch artifact | That lane and its dependents in a declared `review_dependency_graph`, once, in either mode (the rule names none). An implied graph re-opens nothing. A corrupted or stale report of a reviewer that is still open costs no new launch; the same reviewer corrects it. |
| The same mutations of an artifact that belongs to no lane (`full-suite-validation.json`, `preflight.json`) | None: the code did not change, only that evidence is rebuilt. |
| A code or test edit together with lost evidence of a lane that already ran | That lane once, in `FULL`; the edit follows its rule for the other lanes, dependents of that lane in a declared graph included. |
| `reset-task` | Every lane that already ran, once, in `FULL`. |
| Single `wrong-gate` | None. These variants keep the stricter `walk:wrong-gate-*` checks and are not reported twice. |
| Combinations | Every part applies. Changed criteria decide everything. |

A fix is small when non-document changes cover at most 4 files and 240 lines, have fewer than three consecutive `DELTA` reviews, and do not expand production scope. New test files alone are permitted. A lane the baseline never reviewed may run once in `FULL` after a criteria or policy change or scope expansion; an in-scope edit can require it only when it reaches the lane. The policy layer also tests every specified protected signal and its owning lane; other reached owners remain `DELTA` for a small fix. Garda control-plane source files remain ordinary files. Failed-review and unclassifiable-fix rules are covered by scenario families; a baseline with a failed review carries no sweep economy facts.

Protected-signal owners are `security` for `security`, `auth_or_permission` and `secret`; `api` for `api_contract`; `db` for `database` and `schema_or_migration`; `dependency` for `dependency` and `lockfile`; and `infra` for `infrastructure`. `task_criteria_or_policy` has no owner and requires FULL across lanes.

An extra launch, or a `FULL` where the bound allows only `DELTA`, is an `economy` finding `walk:economy:<extra-launch|full-where-delta>:<lane>:<scenario>`, one per lane and kind. `DELTA` where only `FULL` is allowed and a launch with unknown mode are `safety` findings `walk:economy:<delta-where-full|unknown-mode>:<lane>:<scenario>`; an extra launch does not hide either safety finding. The baseline mode of each planned launch is checked too. The finding's route is the last restart before the launch, otherwise the rebuild of its review context.

The bound is two-sided where the rules decide. A still-required first review runs in `FULL`; changed criteria repeat each still-required review in `FULL`; a reset repeats every still-required review that ran; a code or test edit inside the scope of a passed (or finished, unrecorded) review repeats it, even when that lane also lost derived evidence; a deleted or corrupted receipt or review artifact of a recorded review repeats that review. A run that skips such a review is a `safety` finding `walk:economy:missed-review:<lane>:<scenario>`, with the same replay. Where the rules do not decide (dependents of a lost review, derived lane files such as a review context, a stale timestamp), nothing is required unless another rule requires it.

Two parts of the model keep these judgments honest. A disturbance edit is stamped on the stand clock, the clock on which the modeled reviewer works and returns its output, so an edit after a finished review is also later on disk; Garda records a finished review against its reviewed tree only when its output is older than every reviewed file that changed. The modeled reviewer cites only its evidence location domain (the context's file obligations), so a `DELTA` review of a test-only fix cites the test file, as the reviewer prompt requires.

Where the rules do not decide, the bound does not guess: such a case becomes an operator question in `ECONOMY_QUESTIONS`. Its widest answer repeats each review that already ran once in `FULL`; a planned review still runs once. Launches beyond that are judged under every answer; launches between the strict bound and the widest answer stay unjudged until the operator answers, and the answer becomes a rule in `reviewEconomyBound`. No question is open: on 2 November 2026 the operator answered the four earlier ones (`ECONOMY_ANSWERS`, rules `small-fix`/`outside-scope` for an unrecorded review, `task-evidence`, `lost-evidence-with-fix` and `reset`). The report section "Review economy of disturbed variants" (`economy` in `navigator-walk.json`) groups findings by recovery route and disturbance kind, with source routes and a replay, and lists open questions with up to eight examples and their replays.

To replay every variant of one disturbance kind, set `GARDA_SYNTHETIC_WALK_DISTURBANCE` instead. It walks only the three sweep baselines, their checkpoint controls and the variants containing that kind, and skips coverage enforcement as a partial selection. A comma-separated list selects the union of several whole kinds and shares each checkpoint control; a combination matching multiple selected kinds runs once:

```sh
GARDA_SYNTHETIC_WALK_DISTURBANCE=wrong-gate GARDA_SYNTHETIC_WALK_JOBS=12 \
GARDA_SYNTHETIC_WALK_REPORT="$TEMP/garda-walk-wrong-gate" \
node scripts/node-foundation/build-scripts.cjs test.js tests/node/synthetic/synthetic-navigator-walk.test.ts
```

### Measurements and anomalies

Budgets and growth are calibrated on undisturbed runs and judged on undisturbed runs only. Recovery from a sweep mutation legitimately costs more navigation and gate work; route counters and over-budget observations of sweep variants are reported in `disturbed` (grouped by route and counter, with the largest observation's replay) and never fail the run. Their review launches are not exempt: "Review economy of disturbed variants" judges them.

Growth with event history means the same inputs cost more as history grows. Counted inputs keep their identity (the hashed file relative to the fixture, the subprocess argument digest), and calls of one decision are fitted within cohorts of identical inputs. Calls that count a different input set are different evidence states, for example a second cycle that also hashes the first cycle's receipts; they are listed in `evidenceCohorts` with the added and removed inputs and the slope of the inputs every call shares, for review, and are not growth failures. On Windows the ACL pair batch (`icacls <dir> /T`) declines once a directory holds 32 entries, so a later call runs one more per-file `icacls`; that is the main shared-input difference and depends on artifact count, not on events.

Every in-process navigation call uses `withNextStepMeasurement`. Reports retain subprocess counts by program, file probes, hashes, payload reads, timeline events/bytes and inclusive phase timings. Paths and command digests are normalized out of aggregate counter keys; raw measurements remain in traces. `walk-counter-baseline.json` holds explicit per-route counter expectations, tolerances and declarations of which counters must stay constant with event history. The runner never rewrites that file. Missing routes/counters, counters above their budgets, and positive fitted growth above the declared tolerance for a constant counter fail. An initial baseline needs a measured, reviewed calibration; do not populate it from disturbed results merely to turn a run green.

The snapshot reader also captures the task-mode JSON as well as task timelines. Its raw `timeline_bytes` counter retains every byte from both; for the stand budget, `timeline_bytes_normalized` replaces only occurrences of the disposable fixture root, including JSON-escaped paths, with a fixed root matching the length and separator shape of the original Windows calibration. Other content and extra reads still count. A normalization error is a finding and falls back to the raw count. Native child-process diagnostics do not install the stand projection, so their byte budget observations remain raw and can depend on the fixture location. Task-mode artifacts retain the complete redacted policy snapshot in compact JSON, reducing actual payload reads without removing policy data.

The 1.4.4 round's `run-intermediate-command` expectation is recalibrated from 84,711 to 90,135 bytes for the corrected test-layout policy snapshots and authenticated preflight hashes. The retained preflight snapshot adds two identity and two native-realpath probes to the Windows ACL batch, whose before-and-after checks cover every sibling. The two observed routes' probe expectations increase by two for each counter. `walk-counter-calibration-evidence.json` records the file-level byte comparison, per-commit attribution and repeated snapshot-present/absent probe. The existing 4,096-byte numeric envelope, all other route budgets and all tolerance and growth rules remain unchanged.

The stand baseline also supports independently measured fixture states. A named family does not change earlier ordinary steps: overrides activate only after the actual RED, skill-selection, strict-decomposition or recorded-review admission event. Each override retains the constant-work growth check; other routes and counters keep the ordinary budget. `walk-counter-calibration-evidence.json` records the history-only comparisons, the justified ignored-remediation Git query/recheck pair (20 versus 18), and the two additional cadence authentication hash inputs when that evidence first appears. Existing route entries were unchanged by this calibration. Three new recorded-RED timeline-byte limits include a derived nine-byte envelope for three NTFS inode strings: the calibration had 17 decimal digits, while a 64-bit inode can have 20. Exact file hashes and constant-work growth tolerances remain unchanged. Raw step records retain the active counter state, and the scenario table names its calibration family.

Route measurements include wall/core/outside-core median, p95 and maximum, phases and fitted growth per 100 task events. Fits stay within one scenario, selected source-route chain and action/stage, never across unrelated decisions, profiles or project sizes; headline growth is the largest positive fit. Exact work-growth checks need two calls with differing event counts and do not inherit timing's noise threshold. Time spikes exceed both 250 ms and eight times the matching source decision/action median. Fitted wall growth above 500 ms/100 events is flagged when at least three calls span 50 events. Time flags are warnings on a loaded run; `GARDA_SYNTHETIC_WALK_QUIET=1` makes them failures. Work-counter findings always fail. A subprocess stopped by its own timeout (for example `icacls.exe` at the 1,000 ms ACL inspection limit, which its caller retries once) is recorded as `subprocess_timeout:<program>`. That attempt is not counted as `subprocess:<program>` work; it is reported as a `time-subprocess-timeout` flag with its scenario, step and replay, under the same warning/quiet rule. Every other extra call still fails its budget. Quiet mode is an operator assertion, not something the runner infers.

Ordinary wall time covers the in-process navigator invocation. Core is its measured `total` phase and outside-core is the difference. Startup/shutdown and other gate command time are not part of that metric. Set `GARDA_SYNTHETIC_WALK_DIAGNOSTICS=<outside-journal-dir>` for a native child process on each navigator call, including startup/shutdown; the reports retain its work counters as well as wall/core/outside-core and recorder journals. Native children do not run the test-only route observer, so this mode cannot establish BLOCKED source-point coverage. Inclusive phases overlap and must not be summed. These are local Windows observations, not native Linux/macOS acceptance.

`GARDA_SYNTHETIC_WALK_DIAGNOSTICS_CPU=1` records profiles for navigator calls outside disposable task directories, so an anomalous call's profile survives cleanup. With native diagnostics it uses the recorder's CPU profiler; otherwise it uses Node inspector around the actual in-process call. Reports link profiles to route, scenario and step. This opt-in currently retains profiles for ordinary calls too, so allow additional disk space.

Project-size scenarios verify exactly 2, 2,000 and 20,000 tracked files using Git, then measure the same task. Scaffolding remains present but ignored in those disposable repositories. `projectSize` in the report gives per-route observations for each size. Do not mix this effect with growth in task events.

The 1.4.4 selection/carry counter evidence is in `release144SelectionCounterCalibration` in `walk-counter-calibration-evidence.json`. It covers the mandatory selection route both initially and after a reviewed scope changes. The product shares invocation reads, pins admitted command inputs by hash, rejects an already different preflight before querying Git, and reads optional-skill history through the immutable timeline snapshot. Consumed reviewer launches are rejected from pending-policy recovery before opening their ACL-protected input/output snapshots. Unused semantic-carry candidates do not require authentication of their complete artifact chains.

The review-fix evidence in that section's `reviewFixes` gives an exact route/step witness for every revised limit. On `performance-failed-large-fix` step 47, payload reads fall from 482 to 161; repeated reads fall from 361 to 39. Each of `profiles.json`, `paths.json`, `isolation-mode.json`, `package.json`, `review-capabilities.json` and `workflow-config.json` is read once. The 22 payload limits are reduced to measured route maxima, with zero numeric payload tolerance. The thirteen raised `task-test-selection` entries are measured on that decision's own `workflow set` command, including initial selection and selection after changed scope; they are not copied from the neighbouring full-suite step. Ordinary consumers share invocation bytes, including contained review-artifact readers. Their SHA and path observations now include the previously raw config inputs; hash/metadata changes list the distinct inputs and keep the existing validation checks.

Required live rereads remain in `invocation-file-observation.ts` (descriptor/path checks and final stat, identity, realpath and link checks), invocation dependency assertions, workflow/review transaction-owner validation, authenticated timeline/task-mode and active-owner checks, and the `observeReads=false` review-index freshness witness. These are separate checks, not an allowance for rereading ordinary configuration. The independent five-event probe adds no Git, ACL, hash, payload-read or file-probe work. The selection route permits zero cloned events. Git/ACL budgets and constant-work growth tolerances are unchanged.

The 37 metadata/hash entries above the `9cc56c65` reference retain their historical values and receive a same-route native-versus-original-Git control. Accepted native-ref reads name `.git/HEAD`, the branch ref and the config/format guards; a control forces the unchanged `git -C <repo> rev-parse HEAD` fallback on the identical fixture. Review routes measure 20 Git subprocesses with that command and 18 with native refs. This does not claim a net historical reduction where `9cc56c65` also measured 18. Routes which no longer consume native refs explicitly retire the old blanket attribution rather than claim an unmeasured saving. Only an unambiguous files-backend format takes the native path; reftable, unknown syntax and unresolved symbolic refs use Git.

Original native traces and their original numeric findings are preserved; a JSON-only calibration reassessment uses the same report builder and records hashes of its inputs. The requested 16-scenario selection runs at level `full`, seed `1785881697`, provider `Codex`, with four workers. This selected Windows run is not a complete scenario-inventory or cross-platform acceptance claim.

### Current limits

The universal merge calibrates only A1/A6 on `unknown-quartz`, `spring-maven` and
`polyglot-maven-ts`, including their available auto peers. Ten ordinary smoke walks
and twelve legacy representatives were run at `full`, seed `1785881697`, provider
`Codex`, `JOBS=6`. All reached DONE with the expected review counts and modes. The
legacy runs retain the same eight pre-existing findings and all old budget entries.
Three new, natively admitted fixture states override only exceeded measured fields;
Git/ACL limits and growth tolerances are unchanged. Other matrix shapes remain
uncalibrated and the full 198-case matrix has not been run.

`universalMergeStackCalibration` in `walk-counter-calibration-evidence.json` retains
29 independent five-event comparisons from six generic walks. After one native
publisher warmup, every comparison keeps its route and adds zero non-history work.
The task JSONL is parsed and verified once per call, with no cloned events. Raw
input identities are retained; only ephemeral transaction lease IDs are normalized
for comparison. Ordinary bounds come from a separate run without the probe hook.

To reproduce only that experiment, set `GARDA_STACK_CALIBRATION_ROOT` to this
worktree, `GARDA_STACK_CALIBRATION_OUTPUT` to a fresh temporary folder and
`NODE_OPTIONS` to `--require="<worktree-with-forward-slashes>/tests/node/synthetic/engine/walk-stack-counter-calibration.cjs"`.
Run the six generic A1/A6 smoke IDs above with the same level, seed, provider and
jobs. Unset all three variables before ordinary acceptance. The hook adds native
INFO events only inside the disposable repositories and preserves gate decisions.

Only the source inventory and emitted sweep manifest define the coverage claim. Follow the report's unexplained route list; this expansion is not a claim that every gate or BLOCKED branch has been reached. Real provider tool behavior, model quality, network transports, native Linux/macOS paths and concurrent reviewer scheduling remain outside this synthetic agent. Parallel policy/graph scenarios exercise launch eligibility and dependency order while the synthetic reviewer finishes one launch at a time. Full-suite failure injection uses real fixture commands for compile/full-suite only; other gates get the observed artifact rejection mutations, and the applicability report explicitly names the missing generic failure injection. Strict decomposition now includes native two-child execution, SOURCE acceptance and an aggregate follow-up. Full-suite repair includes two isolated repair children and WIP restoration; its final acceptance and calibration must be checked in the latest report. Manual-validation attachment recovery and reset/re-entry paths beyond the sweep's confirmed one-action reset still need dedicated scenario coverage. These omissions must not be described as green acceptance.

The inventory handles the tested assignment/object syntax and local value aliases; it is not whole-program data-flow analysis. Opaque helper-generated statuses without an identifiable route property still need semantic extraction support. The future-source guarantee must not be extended to arbitrary computed JavaScript beyond the extractor's tested forms.

### Measured status, 31 October 2026

These are loaded local Windows runs. They are red evidence, not release acceptance. No exemption or counter budget was widened to remove a finding.

| Run | Processes | Cases / actual navigator calls | Elapsed | Result |
|---|---:|---:|---:|---|
| Current default sample | 2 | 2 / 79 | 3m49s | Both DONE; 33 counter-growth findings |
| Full phase of the complete sweep | 16 | 83 / 3,549 | about 20m18s | 75 DONE, eight expected handoffs; 33/67 gates and 42/137 BLOCKED points |
| Complete archived sweep | 16 | 1,587 / 18,095 | 92m19s | All 1,456 variants and 48 controls finished; 34/67 gates and 52/137 BLOCKED points |
| Four refusal replays, CPU enabled | 4 | 10 / 182 | 2m55s | Four correct BLOCKED outcomes, all controls/baselines DONE; 17 counter findings |
| Post-DONE handoff replay, CPU enabled | 2 | 4 / 84 | 2m37s | Correct BLOCKED handoff, all controls/baselines DONE; six counter findings |

The original 53-scenario set remains 2,748 steps, 25 gates and 30 BLOCKED points. The complete sweep has 1,408 single mutations plus 48 combinations, seed `1785881697`. Its raw outcomes were 639 DONE / 447 BLOCKED / 369 loops / one stuck agent among the disturbed variants. All 48 restored controls reached DONE. The under-one-hour target was missed.

Reports are retained under `%TEMP%/garda-walk-sweep-complete`. Its `run-inputs/` and original report are immutable evidence of the execution used. `reassessed/` retains the reviewed classifier sources, every added/removed finding ID, the unchanged coverage and measurements, `audit-routes.tsv`, detailed open outcomes and `operator-questions.json`. The corrected assessment still has 15,466 failures: 118 coverage gaps, 12,103 counter-budget findings, 989 missing budgets, 1,545 counter-growth findings and 711 behavioral/stand findings. The last group contains 93 historical stand misclassifications; the remaining 618 records need semantic/recovery triage. Three time-growth warnings remain. Findings are records, not counts of distinct Garda defects.

The complete sweep predates the final stand refusal/handoff refinements. Only focused replays validate those refinements; a complete sweep on the final stand version is unfinished. The two narrow production fixes were unchanged throughout the complete sweep and the focused runs. The focused CPU runs retained all 266 call profiles, including a profile for each of their 23 anomalies. The complete sweep itself had CPU profiling disabled.

The project-size cases verified exactly 2 / 2,000 / 20,000 tracked files. Their 31-query navigator totals were 59,928 / 58,530 / 67,233 ms, and wall medians were 1,967 / 2,105 / 2,161 ms. Each did 444 Git subprocesses, 285 ACL subprocesses, 570 file hashes and 8,847 payload reads. Raw route distributions and phases are in the report. These three observations do not establish a quiet scaling benchmark.

Work counts are exact observations. Attributing their fitted growth to event history alone still needs controlled comparisons with unchanged artifacts and cache state; current route/action/source cohorts can also differ in available evidence and cache warmth. Keep those flags red until their cause is reviewed. Remaining refusal-classification questions include closed-cycle restart messages that correctly name `restart-coherent-cycle` without one of the current integrity keywords, and provider timing/invocation handoffs. Those are not confirmed Garda dead ends. Other open work includes authenticated artifact-loss recovery, closed-cycle recovery guidance, profile re-entry after out-of-profile edits, the 118 unexplained source routes and the scenario omissions above. Review, integrity, provenance and timing checks remain in force.

### Measured status, 1 November 2026 — Stage C

The complete 20-worker sweep in `%TEMP%/garda-stage-c-sweep-complete` finished all 1,456 disturbances and 48 restored controls: 1,614 cases, 17,899 executed navigator calls, 96m48s. It was red with 95 findings: 82 unexplained coverage routes, eight counter findings and five behavioral records. Coverage was 54/69 gates and 73/147 BLOCKED points. There were three disturbed loops, all lost test-review disposition/snapshot/prompt evidence, compared with 369 in the older sweep. No undisturbed constant-counter growth was reported; eleven timing warnings remain observations under load.

The later fixed replay in `%TEMP%/garda-stage-c-final-replay` ran all five behavioral IDs, nine new recovery scenarios, the post-DONE disturbance, baselines and controls: 20 cases / 477 calls, zero findings, zero warnings and zero loops. It is a partial selection, not a green complete sweep. Its source inventory is 69 gates / 148 BLOCKED points; it reaches 30 gates and 30 points. The three dedicated lost-review scenarios require fresh code and test reviews, rather than accepting silent historical reconstruction. Task-policy loss has explicit operator reset guidance and a typed CLI refusal without a stack trace.

Fourteen new routes and four natively admitted evidence states have separately measured calibration in `walk-counter-calibration-evidence.json`. Every pre-existing route budget is unchanged. The old sweep's remaining six ordinary counter findings are retained: five security-route timeline byte overruns of eight bytes (numeric inode/duration widths), and four extra DONE lstat calls for two Stage A source files and their compiled copies. Independent five-event probes do not increase those lstat calls. The two post-DONE counter failures were a stand labeling bug: declared disturbances are now retained and measured separately.

Twelve route exemptions have concrete source reasons: a dead startup fallback; six legacy-schema-only entries; two in-flight validation entries; two interrupted correction-transport publication entries; and a task-queue write-time synchronization failure. Other gaps remain failing. The native two-child SOURCE/aggregate-handoff prototype is retained in `%TEMP%/garda-stage-c-parent-handoff`, but is not part of the suite: its distinct child-tree counter states still need independent calibration. Coverage completion and a complete sweep on the final fixes remain unfinished.

### Stand finish work, 1 November 2026

The later full ordinary run in `%TEMP%/garda-walk-report-mUWOyr` ran 132 cases / 4,955 calls and remained red: 60 coverage findings, 576 counter-budget findings, 11 missing budgets and one behavioral finding. It reached 63/69 gates and 78/148 BLOCKED points. This was not a disturbance sweep. The native strict child-tree and aggregate follow-up reached DONE; independent history-only probes retained zero constant-work increases. The full-suite WIP case exposed missing native parent archive qualification and incomplete aggregate publication after the resumed parent's own SOURCE acceptance. Fixes and focused validation are in progress; the final complete sweep remains outstanding.

`walk-counter-calibration-evidence.json` records a finite 4,096-byte envelope for timeline numeric serialization (128 scalar slots × 32 ASCII bytes), consistently applied to existing route and state budgets. The longest retained ordinary fixture contains 84 timing scalars; its 291 events were unchanged while numeric widths moved. Original expected values and measured spread remain recorded. DONE also has a 79-probe lstat allowance, 2% of its previous 3,925-call ceiling, for source and compiled file-set variation. These allowances are explicit structural tolerances. Constant hash, payload-read, parse, verification and subprocess growth still has zero tolerance, and counter values remain visible. They do not excuse a behavioral finding or admit a failed child-tree run as calibration.

The focused replay in `%TEMP%/garda-finish-v11` subsequently passed at 20 jobs: 13 cases / 816 steps, zero findings. It includes native parent acceptance (102 steps), aggregate follow-up (145), restored full-suite WIP (120), two long remediation/counter regressions, and exact-guidance recovery/refusal cases. Its partial coverage is 33/69 gates and 35/148 BLOCKED points, with 21 concrete exemptions and no invalid exemption IDs. It does not certify complete coverage. The WIP state's independently retained 102 unchanged-input comparisons each append five events and show zero constant-work increases; its ordinary calibration uses 106 admitted steps across 42 routes.

Coverage work also found an unresolved policy conflict in a temporary native declared-recipe probe: a docs-only task has no mandatory code/test lane, while an approved case-bearing recipe requires independent semantic review in such a lane. The final docs-only rules suppress those lanes, and the task loops at required-reviews-check. Its trace is `%TEMP%/garda-finish-edge-recipe/trace.json`; it has not been exempted or admitted as a passing scenario. An operator-only refusal versus another already-approved policy needs a decision before implementation. No final-source complete sweep has been run.
