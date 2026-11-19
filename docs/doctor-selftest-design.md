# Doctor Selftest Design — G-01

Design revision: 1. Status: S0 design only, 2026-10-24. Owner: T-420-1.
Implementation and actual qualification belong to T-420-2 in S7, after validation
recipes stabilize. **The current CLI does not accept `garda doctor --selftest`.**
This document supplies neither an executable command nor passing selftest evidence.

The proposal replaces the historical T-420 design. A syntax error in one source
file cannot establish that every configured command is correct. A junction,
symlink, copied working directory or file hash does not enforce read-only access
or constitute a sandbox. The optional diagnostic must state the exact obligation
it tested and the real safety mechanism under which it ran.

## Purpose and Limits

The eventual explicitly invoked selftest asks whether a configured command can
detect a **particular declared failure**. `OK` means that matched obligation was
observed, not that the whole suite asserts correct behavior, every source is
covered, every possible bad wrapper is detected, or the host is generally safe.
Normal compile, validation, review and completion gates remain unchanged. Setup
or workflow changes may suggest the diagnostic after implementation; they must
never run it implicitly or use its result as ordinary task-acceptance evidence.

Keep generic providers and stacks supported. Probe selection follows declared
command roles and source/build/test boundaries, with language-specific mutation
data only where needed. Discovery can suggest a probe; a filename, language
guess, registry entry or generic syntax token is not proof of applicability.

## Per-command Contract

Freeze a read-only plan for each configured compile, full-suite or admitted
validation recipe. A command is eligible only when its actual trusted executable,
arguments, environment and resource use can be represented without silently
changing its meaning. Preserve the existing configuration/admission authority;
do not discover and execute a replacement binary or invent a validation command.

| Contract field | Required meaning |
|---|---|
| Identity | Diagnostic run ID, original project realpath/identity, source revision or content snapshot, configuration/recipe identity and digest, exact command role and invocation. A copied workspace or receipt grants no execution authority. |
| Relevant boundary | Explicit source/input paths, package/cwd, build outputs, test targets/selectors and expected observed items. Unknown dependencies or absolute original-project paths cannot be silently rebound. |
| Resources | All required dependencies, caches, configuration files, toolchain roots, subprocess services and declared output/report locations; state which are disposable copies, executable read-only resources or protected originals. |
| Probe | Bounded mutation data, contained target, preimage/postimage digests, intended obligation, applicability evidence, expected negative observation and conditions that make the result ambiguous. Mutation data is not another executable recipe. |
| Freshness | How the selected source is consumed, outputs are freshly rebuilt or independently bound, and report/case counts identify this run. A stale compiled artifact cannot stand in for the mutation. |
| Safety and budgets | Actual enforced capabilities, denial-probe results, child/environment/network policy, configured timeout/attempt/output limits, cancellation and cleanup ownership. |

Unconfigured commands are `SKIPPED`. Configured commands with a missing or
unsupported contract are `INCONCLUSIVE`, naming the missing boundary/capability;
they are not silently excluded or blamed as defective.

### Match the Mutation to the Obligation

| Command role | Suitable bounded probe | Required interpretation |
|---|---|---|
| Compile/typecheck | A known-invalid language/type change in a declared input consumed by that exact build, using a qualified mutation adapter. | Fresh baseline succeeds; the mutated build rejects the intended input for the expected reason. One parser rejection proves only that obligation. |
| Behavioral tests | A deterministic violated assertion or behavior contract in a known selected test/production boundary, with current build and actual case execution. | Identify the intended case and its failing assertion. A missing dependency, import crash, timeout or unrelated failure is not the required assertion failure. |
| Documentation validator | An invalid link, schema field or other documented rule in a file the validator actually reads. | Require that rule's negative observation. A production syntax error unrelated to the validator supplies no evidence. |
| Different package | A probe within that command's own package and declared inputs. | Do not expect package B to fail because package A changed. Unknown package association is `INCONCLUSIVE`. |
| Other validation recipe | An explicit bounded obligation/probe/report contract for that role. | Unsupported or opaque semantics remain `INCONCLUSIVE`; never infer a mandatory failure from an extension or command name. |

A declared compile command consisting of `echo ok`, or an applicable test command
whose failure is masked by `|| true`, must be detected when the matched probe
establishes that required failure. An unrelated or unsupported recipe must not be
condemned just because it still exits zero. Missing applicability is a diagnostic
gap, not evidence that the operator's command is wrong.

## Disposable Resources and Enforced Safety

Default to independent disposable **copies** of tracked and relevant untracked
inputs plus required ignored dependencies/caches. Do not share mutable original
`node_modules`, virtual environments, Gradle state, target/build output or similar
directories through links. Enumerate and copy their actual required contents
under bounded ownership/resource budgets; if a complete safe copy is unavailable,
report the resource and `INCONCLUSIVE` before executing that command.

Inspect links, junctions, reparse points and hardlink identity before copying.
Reject ambiguous/outside traversal or copy an explicitly admitted contained
target as independent bytes; never preserve a hidden writable alias into the
original. Future read-only sharing is outside the default design. It may be
introduced only with an actual enforcing mechanism and successful write-denial
tests on each platform where that mode is claimed. Attribute flags, hashes and
the continued existence of a junction target do not satisfy that proof.

Copies isolate mutations, but cannot constrain a command's absolute paths,
subprocesses, services or network effects. Before any baseline or mutated run,
the runner must establish the declared write/network containment and make the
original project and protected external resources inaccessible for writes. It
must also prove that the selected probe consumes the copied inputs rather than
quietly reading originals. A temporary cwd alone is insufficient.

Current recipe declarations already name `offline` and `write_confinement` in
`src/core/project-validation-recipes.ts`. The current
`src/gates/project-validation/execution.ts` explicitly refuses required
capabilities because no enforcing provider is installed and local hashes are
not capability attestation. **Preserve that refusal.** S7 must qualify a bounded
real enforcing runner for the selected platform/command contract; it cannot
turn the declaration into proof or weaken ordinary recipe execution. If no such
runner is available, selftest reports `INCONCLUSIVE: enforcing capability
unavailable` without running the command. This prerequisite is not a promise to
build a general-purpose sandbox or an excuse to execute unsafely.

The report names precisely which paths/effects the verified mechanism constrains
and what remains outside its guarantee. It must not advertise general host
isolation. A configured trusted command whose effects cannot be bounded by this
contract is ineligible. Unsupported safety on one platform is not another
platform's PASS and does not remove generic Garda support.

## Child, Environment and Network Policy

- Run only the frozen operator-configured invocation through existing trusted
  process/timeout infrastructure and the qualified containment mechanism. No
  opportunistic compiler, shell, toolchain installation, backend download or
  network fallback may replace it.
- Give every command an owned disposable cwd and fresh command-specific outputs.
  Admit only declared environment values; redirect configuration/cache/temp roots
  into the disposable area. Remove credential/agent/socket/service endpoints and
  reject required absolute original-project or unknown external state that cannot
  be safely represented. Environment sanitization alone is not enforcement.
- Require enforced offline behavior for the probe execution. A legitimate
  network-only recipe remains `INCONCLUSIVE: offline obligation unsupported`;
  selftest must not make external requests merely to obtain a green baseline.
- Track the actual child tree and creation/execution identity. On timeout or
  cancellation, terminate and reap only that owned tree, await completion, then
  inspect resources and clean up. Never kill unrelated runtimes or leave a child
  writing after snapshots or cleanup. A timeout is not an expected negative probe.
- Preserve configured budgets and bounded raw diagnostics. Run attempts in order;
  no automatic unbounded retry or probe fan-out across shared resources. A changed
  command, resource identity, configuration or source snapshot invalidates the plan.

## Execution and Observation Sequence

1. Freeze trusted configuration, relevant boundaries and original resource
   identities. Refuse incomplete discovery, a conflicting active writer or unsafe
   copy/output roots. Create an owned run directory outside the original project;
   do not copy task authentication keys, active runtime authority or acceptance
   receipts into a context that could authorize ordinary Garda mutations.
2. Snapshot original tracked paths, relevant untracked inputs and directory
   membership, required ignored resources and all admitted external link targets.
   Include content/type/link identity and new/deleted paths, not just tracked-file
   hashes or a check that targets survive. A changing/incomplete snapshot is
   `INCONCLUSIVE`; do not overwrite concurrent user changes to force stability.
3. Materialize complete independent copies and fresh outputs, then qualify the
   actual containment/denial conditions. Missing enforcement stops execution.
4. Run the unmodified command for that contract. A failing baseline, timeout,
   cancellation, unavailable dependency, stale/ambiguous report or zero required
   test items makes that obligation `INCONCLUSIVE`, preserving the exact reason.
5. Start a fresh copy from the same frozen inputs, apply only the matched bounded
   mutation and run the exact command. Retain invocation/source/output identity,
   exit/signal/timeout facts and the actual diagnostic or executed case/report.
6. Evaluate applicability, freshness and the expected negative observation.
   `OK` requires the declared failure; an applicable probe that is accepted or
   whose genuine failure is masked is `PROBLEM`. Unrelated failure, stale build,
   no observed target or ambiguous output is `INCONCLUSIVE`, never `OK`.
7. Recheck all original resources and identities after baseline, after the probe
   and after child termination/cleanup. An unexpected outside change stops later
   probes and yields an explicit safety failure or `INCONCLUSIVE` attribution;
   no command result can remain `OK` while safety is unknown. Preserve evidence
   and do not automatically restore or erase user-owned bytes.
8. Retire only the verified owned copies after child exit. Keep bounded detached
   diagnostic evidence outside protected inputs. No original stage/commit,
   configuration edit, native task completion or release acceptance is performed.

Run-specific reports must be freshly produced, contained and bound to this
command. A result file is not trusted because its name or digest looks right;
use current execution identity and actual producer/output facts. A failure of
admission or containment is not a successful mutation observation.

## Cleanup Contract

Use contained filesystem/process primitives with current ownership checks.
Revalidate the real run root, parent identity and every traversed entry immediately
before removal. Remove a link itself without following it; refuse foreign or
replaced roots/targets. Never recursively delete through a junction/symlink or
an absolute path from mutable report content. Complete copies avoid needing to
delete anything in original dependency/cache directories.

Use bounded Windows EBUSY retries only after the owned children have exited.
On unresolved lock, ownership ambiguity, interrupted removal or resource change,
retain the owned package and report the exact path/state and safe recovery action.
Do not claim successful cleanup or fabricate full resource preservation. Shared
targets must be byte/identity-unchanged after cleanup, not merely present.

## Results and Exit Precedence

Report one row per configured command/obligation: command identity/role,
applicability and safety mechanism, baseline result, mutation and expected
observation, actual exit/cases/output, resource/cleanup status, verdict and reason.
Separate command-detection defects from safety/admission failures.

| Verdict | Meaning |
|---|---|
| OK | Applicable matched probe; genuine green baseline; fresh attributable expected failure; safety/resource checks and owned cleanup complete. It proves only this obligation. |
| PROBLEM | A conclusive applicable command-detection defect, including accepted breakage or masked failure; or a conclusively observed diagnostic safety failure, explicitly labelled as such. |
| INCONCLUSIVE | Unknown/inapplicable/unsupported obligation, unavailable enforcement/toolchain, non-green baseline, stale/zero-item/ambiguous output, timeout/cancellation, uncertain outside mutation or unresolved safe cleanup. |
| SKIPPED | No configured command for that slot. A configured but unsupported command is not SKIPPED. |

Aggregate exit precedence is deterministic: `1` if any PROBLEM or conclusive
safety failure exists; otherwise `2` if any INCONCLUSIVE exists; otherwise `0`
for only OK/SKIPPED. If all slots are SKIPPED, explicitly report that no configured
obligation was verified; exit zero is not a quality guarantee. Preserve every row
in mixed outcomes. No uncertainty may be promoted to OK to make the aggregate green.

For a configuration PROBLEM, name the exact setting/recipe and provide only a
currently supported remediation command with placeholders for operator choices.
Do not invent a replacement command, automatically run `workflow set`, supply
operator consent or disable a gate. Safety failures need their own concrete
recovery/containment explanation, not an unrelated command-setting hint.

## S7 Acceptance Matrix

These are **required future fixtures and observations**, not tests executed by
this S0 document. Qualify Python and a second real toolchain with the configured
commands, and record actual native OS/capability results. Simulated backend
fixtures cannot prove native enforcement.

| Case | Required observation / result |
|---|---|
| A-01 Matched real compile | Green baseline, qualified invalid input rejected for the intended reason, protected resources unchanged: OK. |
| A-02 Declared compile is `echo ok` | Valid applicable compile obligation and mutation, same zero exit accepting breakage: PROBLEM with exact-setting hint. |
| A-03 Masked behavioral failure | Actual intended assertion fails but wrapper masks the failure or required result: PROBLEM; preserve raw case and exit facts. |
| A-04 Legitimate docs/other-package command | Do not condemn it for unrelated production syntax. Use its own matched probe or INCONCLUSIVE if unavailable. |
| A-05 Baseline already failing | Preserve original failure and report INCONCLUSIVE; do not plant a mutation and claim success. |
| A-06 Missing/unsupported command | Unconfigured slot: SKIPPED. Configured unmatched role/probe: INCONCLUSIVE with the missing requirement. |
| A-07 Stale build, report or zero required cases | Refuse stale or unobserved-target success; INCONCLUSIVE, with no reused positive proof. |
| A-08 Dependency/cache writes | Copies may change; original tracked, relevant untracked, ignored resources and directory membership remain unchanged. Probe attempts to write protected originals are demonstrably denied. |
| A-09 Junction/symlink/hardlink escape | Detect aliases/outside targets before execution; copying does not preserve a writable original alias. Read-only sharing needs actual native denial proof or remains unavailable. |
| A-10 Absolute paths, environment, service or network escape | Enforce the declared boundaries; an unsafe/unrepresentable command never starts. A declaration or cwd-only fake backend yields INCONCLUSIVE, not OK. |
| A-11 Timeout/cancel and descendants | Stop/reap only the owned tree; no late writes; preserve timeout/cancel facts and INCONCLUSIVE rather than expected-red success. |
| A-12 Cleanup link swap / foreign root / lock | Refuse foreign traversal/deletion, preserve targets byte-for-byte, use bounded retries and retain an honest incomplete cleanup outcome. |
| A-13 Concurrent or incomplete original observations | Revalidate source/resource identity; refuse stale plans and stop without overwriting user changes or claiming preservation. |
| A-14 Mixed verdicts and empty configuration | Verify exit precedence 1, then 2, then 0, preserve every row and label all-SKIPPED as no verification. |
| A-15 Explicit invocation and authority separation | Ordinary doctor/setup/task gates do not run selftest implicitly; probe reports cannot satisfy task review/compile/completion receipts or grant configuration/publication authority. |

G-01 traceability: per-command boundaries/mutations are defined above (requirement
1); green-baseline and matched-negative semantics plus INCONCLUSIVE are explicit
(2); independent copies and verified enforcement replace link claims (3);
child/environment/network policy rejects cwd-only isolation (4); complete original
resource and cleanup observations cover untracked/ignored/link targets (5); A-02,
A-03 and A-04 distinguish always-success wrappers from unrelated valid recipes (6).

S7 implementation ownership starts at `src/validators/doctor/` and the doctor
integration in `src/validators/doctor.ts`, CLI parsing/help in
`src/cli/commands/status-command.ts` and `cli-help-output.ts`, with owning tests
under `tests/node/validators/`. Reuse existing command/admission/process and
filesystem ownership contracts; do not modify ordinary gate implementations.
Refine exact files and a qualified enforcing runner before S7 entry. Actual
results feed [2.0 acceptance](release-2.0-acceptance.md), T-406/T-408 and T-440-2;
the design alone closes none of their runtime or release obligations.
