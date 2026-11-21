# Native selected-case evidence

An ordinary `gate run-intermediate-command` with the current native preflight
records contained file operands before execution and checks their identities
afterwards. This association uses literal arguments, without a runner-name,
option-name or source-extension list. The authenticated task timeline records
the selection before starting the process; the completed record retains the
process status, actual invocation arguments, output and source identities.

A symbolic selector can name a case without naming its source in the command.
Supply repeated `--selected-case` JSON values with `source`, `case_id` and
`selector` fields. For example, a PowerShell invocation can include:

```powershell
--command 'widget-check --scenario=refund-empty' `
--selected-case '{"source":"checks/refund.case","case_id":"refund-empty","selector":"refund-empty"}'
```

Literal file operands are candidate observations: they can include generated
reports. Current native evidence requires unchanged before/after/current identity
for every captured input, including the selected source and observed helpers.
An option name such as `--report` does not establish an output role. Declare a
mutable report with `--report-file` so its authenticated output capture supplies
that exception; a changed undeclared captured operand invalidates the evidence
even when stdout contains a case result. Unobservable automatic operands remain
diagnostics: they cannot stand in for a captured source or prove input freshness.
Explicit source claims must pass the source identity checks before execution.

The selector must occur literally in the actual command, either as an argument
or as the value following `=`. Sources must be contained regular files. Claims
are bounded and cannot authorize a command, change its arguments or establish
that an assertion ran. A direct file operand uses the same relation without
requiring explicit case metadata.

Each case uses its latest matching execution by attempt start order. An older
process finishing later cannot override a newer attempt. An unsuccessful or unfinished
matching attempt supersedes an older success, including a repeated identical
invocation that omits earlier case metadata. Invocation identity uses the
literal executable and argument vector, so equivalent whitespace and quoting
do not create a new identity. An unrelated case keeps its own
execution. Changed, replaced, foreign or unavailable source/output evidence
cannot close a case. Historical records retain their existing conservative
currentness rules.

Exit zero establishes a successful process only. Case outcomes remain
`UNRESOLVED` until independent review inspects the selected assertion and the
retained output. Missing or skipped assertions cannot become a semantic PASS
through selection metadata.

For a command that writes its results to files, include repeated `--report-file`
JSON declarations with repository-relative `path` and positive `max_bytes` fields:

```powershell
--report-file '{"path":"reports/purchase.xml","max_bytes":1048576}'
```

The declaration records existing project output; it does not change the command
or require a report-format adapter. Garda captures a native start observation,
then retains freshly written file bytes alongside process output. Up to 32 files
and 16 MiB in total may be declared. Paths must stay inside the repository and
cannot replace captured inputs or execution evidence. Missing, stale, linked,
oversized or foreign replacement files fail the execution evidence. Reviewers
quote the retained bytes, so a later run overwriting the original report cannot
rewrite an earlier result. File output still requires independent case semantics.

Focused review checks consume this same captured relation. An unfamiliar bare
executable, literal option or symbolic selector can supply a focused target
through its authenticated current execution, without a runner-name or target
extension list. Metadata alone and an unbound broad command cannot supply that
authority. Existing shell, containment, mutation, network and interactive-command
restrictions still apply. A newer failed or unfinished matching attempt blocks
older focused success; source and retained output are checked again when read.

Directory operands remain recorded as scope observations. A directory run needs
an explicit source-bound case selector in the actual arguments to qualify as
focused; a source path, directory path or mode flag cannot supply that selector.
Historical observations that omitted directory scope retain legacy command
validation. Source-printing and inspection-only commands do not become focused
validation through a successful process observation.

Optional admitted recipes apply only to their exact invocation; they do not
replace unrelated ordinary focused commands. A successful recipe process with
opaque output remains available as an observation pending independent case
review. Its canonical result stays `UNRESOLVED` until the existing semantic
contract is satisfied. Failed, cancelled, timed-out or altered recipe evidence
cannot supply successful process observation. Recipe working-directory and
environment requirements remain explicit.

## Equivalent preflight refreshes

New native observations can survive a preflight refresh inside the same authenticated
execution context when only `budget_forecast.timestamp_utc` changes. Object keys are
canonicalized, while array order, unknown fields, policy, authorized scope and the
source/index fingerprints remain binding. A malformed timestamp or unsupported
identity version cannot authorize this equivalence.

The timestamp field must remain present with a valid UTC value. Removing it,
changing another forecast field or adding a new field changes the semantic hash.
The semantic hash establishes execution eligibility; it never replaces a raw
artifact hash used to authenticate retained bytes.

The versioned identity binds the physical repository/worktree, task, task-mode run
and execution epoch. Task re-entry, rework and recorded review/recovery failure
boundaries require their own current observation. Successful review preparation
does not relabel an earlier execution. Recovery controllers must establish a new
meaningful epoch before obtaining the execution they intend to retain.

Native classification records both the exact raw preflight hash and its semantic
hash. Command START records the observed identity; the immutable command record
and terminal event bind observations from before and after execution. Every
intervening classification must preserve the same semantic identity. An A-to-B-to-A
scope or policy transition cannot revive A's old success, even if the final source
bytes match again. Missing, malformed or legacy intermediate bindings cannot bridge
a refresh.

The original command, selected inputs, record bytes, raw hashes and retained output
are preserved. Current case obligations bind the current raw preflight and still
require independent assertion review. Later overlapping failed, cancelled or
unfinished attempts can veto older success across an equivalent refresh. Existing
coverage bindings and caller-supplied review freshness boundaries remain mandatory.

Legacy command records keep their strict raw-hash and sequence rules. No old record
is rewritten or promoted to the new identity format. Recipe contracts and expected-RED
run boundaries keep their existing separate validation rules.
