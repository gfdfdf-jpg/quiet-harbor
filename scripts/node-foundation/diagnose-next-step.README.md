# Developer next-step diagnostics

This opt-in recorder lives outside `src`. It is not compiled into `dist`, is not a Garda command, and is excluded by the npm package file whitelist. No production flag, dependency or project configuration is added.

## Capture a real task as it runs

From the source checkout, create a session **outside the measured project**:

```powershell
node scripts/node-foundation/build-scripts.cjs diagnose-next-step.js init-session --repo-root "D:/Projects/OnlineStore" --output-dir "D:/Projects/GardaDiagnostics" --label "OnlineStore live task"
```

This only creates an external session. It does not invoke Garda or change the project. The printed session directory contains a standalone recorder and `next-step.cjs`. It remains usable independently of later source worktree builds.

Tell the task agent to replace each ordinary navigator invocation with:

```powershell
node "<session>/next-step.cjs" T-006-2
```

Run the single command suggested by Garda normally, then call this wrapper again. Even when the shell batch contains a preceding gate, the recorder's measured interval covers only its own navigator child process. The wrapper itself launches **only** `node <launcher> next-step <task> --repo-root <root> --as-json` and sets `GARDA_NEXT_STEP_TIMING=1` only in that child's environment. It never executes suggested gates/effects, changes their arguments or authorizes task actions.

For a selected slow call, add `--cpu-profile`. This records Node's CPU profile in the external session. Profiling changes overhead; profiled and unprofiled observations are never pooled.

The session can record several tasks. Each invocation gets a unique run directory, and every sample retains task, caller label, actual route/review lane, result hash, exact argv, timestamps, native exit/signal/timeout, stdout/stderr, full timing JSON and runtime descriptors. Direct use supports `--repeat 1..100` and `--timeout-ms`; normal live-task use records one invocation at a time. Every repetition starts a fresh Node process; the first is not guaranteed to have cold OS caches.

## Record gates and other task commands too

For a full task investigation, add the command recorder to an existing external session (no project changes):

```powershell
node scripts/node-foundation/build-scripts.cjs diagnose-task-command.js install-session "<session>"
```

It adds `commands.cjs` and one unified `run.cjs` without overwriting the original recorder or logs:

```powershell
node "<session>/run.cjs" T-006-3 next-step
node "<session>/run.cjs" T-006-3 -- node garda-agent-orchestrator/bin/garda.js gate <gate-name> <exact-gate-arguments>
node "<session>/run.cjs" T-006-3 -- <executable> <literal-arguments>
```

The navigator uses the existing session settings and records a CPU profile for each call. Other commands stream stdout/stderr to the agent while retaining exact bytes in `commands/command-*/`. `started.json` and `result.json` retain exact requested/executed argv, cwd, UTC timestamps, child wall time, exit/signal/error/timeout and output hashes. Failed commands remain evidence; the native nonzero exit is preserved. No suggested gate is executed automatically. A started record without a result is incomplete, not PASS.

Commands using the recorder's verified Node binary automatically receive a CPU profile in that external run directory. Other executables retain wall/output evidence and an explicit reason why no profile was collected; PATH resolution is never replaced with a different Node installation. CPU profiles cover the Node process itself, not Maven, Git or other subprocess internals. Stdin is inherited. The normal command timeout is one hour; timeout or a handled interrupt attempts to terminate the recorder's child process tree and records failure/incomplete profiling. An uncatchable termination can leave only an incomplete started record. For Windows `.cmd` tools, invoke an explicit shell or their native executable; the recorder never silently enables shell interpretation. Preserve raw logs privately because command arguments/output may contain project data.

Use this full recorder for every task command whose duration/failure must be investigated. Direct commands are not intercepted and cannot be reconstructed later. Next-step logs remain separate from gate/build/test logs, so a long gate can never be counted as navigator time. CPU profiling adds overhead: do not pool these samples with the earlier unprofiled baseline. Keep both series. This instrumentation is developer-only and remains outside the shipped package.

## Summarize navigator samples

```powershell
node "<session>/recorder.cjs" summarize --input "<session>"
```

Several `--input` arguments combine sessions or individual runs. Duplicate record IDs are counted once. Groups separate repository, task, label, route/status/review lane, full navigator output hash (only `generated_utc` removed), runtime descriptor, Node/environment identity, recorder build and profiling mode. Different states are intentionally not averaged together. Raw records remain available for chronological investigation and first/last-stage comparisons.

`wall_ms` measures the child process, excluding this recorder's build, metadata acquisition and report generation. `core_ms` comes only from exactly one valid native timing record. `outside_core_ms` includes startup, shutdown and other work outside that native timer; it is not a pure startup measurement. Nested phase timers must not be summed. Subprocess/IO details depend on the measured runtime's existing telemetry; the recorder does not invent missing detail.

Missing/duplicate/malformed timing, invalid navigator output, timeout, native failure, a changing runtime descriptor or missing CPU profile is retained as an invalid sample. Repetition stops, the wrapper returns an error, and that sample is excluded from successful timing statistics. A native nonzero exit remains a nonzero exit. Raw output is retained even if it exceeds the 64 MiB parsing limit.

The launcher can select `dist` or `.node-build`. Both candidates' descriptors and launcher support modules are recorded. Actual runtime selection is explicitly **not observed** by this external recorder; descriptors are not full bundle authentication. Do not infer an authenticated candidate commit from a package version. Environment values are hashed for grouping rather than dumped. Keep candidate installations unchanged during comparisons and retain their update/package verification reports separately.

The new recorder cannot reconstruct internal timings for previous tasks that did not use it. In particular, a shell batch containing gates and `next-step` is not a navigator measurement.

## Shipping boundary

No runtime module imports this file. `tsconfig.build.json` includes only `src/**/*.ts`; the npm `files` allowlist excludes `scripts`, `.scripts-build`, tests, local reports and session artifacts. Verify the actual npm pack listing before merging changes to these boundaries. Sessions belong outside both measured projects and release artifacts. Consumers continue using the ordinary launcher without recording anything.
