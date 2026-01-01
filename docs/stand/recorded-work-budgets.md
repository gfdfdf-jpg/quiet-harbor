# Work budgets relative to recorded task inputs

This is the model specification for recorded-review work. The runner implements it in
[`walk-recorded-work.ts`](../../tests/node/synthetic/engine/walk-recorded-work.ts).
Review admission remains governed by the [review transition matrix](review-transition-matrix.md):
first review or changed criteria/policy requires FULL, scope changes require FULL/DELTA
according to the rules, and unchanged evidence is reused. There is no maximum number of
reviews, lanes or review cycles. Repeated reviews after changes are separate recorded units.

## Inputs and the constant part

The allowance is `accepted route constant + sum(source operation cost × distinct input units)`.
The constant is the existing ordinary route's `expected + tolerance`; it is not fitted to
the result being judged. Fixed counters outside the model and all subprocess ceilings keep
their existing state-specific values. Timeline events/bytes retain the earlier one-pass rule
and zero additive allowance.

Outside navigator measurement, each step retains `recordedWorkInput`: event positions of
REVIEW_RECORDED, REVIEW_PHASE_STARTED, entries/restarts, the union of required lanes, and
distinct artifact paths named by review, reviewer, preflight and skill events. Mutable paths
and immutable snapshots are separate inputs. Shared paths earn one unit across the complete
history. Scope expansion, more lanes and a restarted cycle introduce their actual additional
artifacts; no five/seven/nine-lane or restart multiplier is needed. Ancestor directories are
deduplicated within the fixture. Existing raw records can be reassessed from the retained
timeline prefix (`taskEvents`), without running the product or changing their checksums.
The scenario's declared source paths also name ancestor directories inspected during
review scope validation. They contribute only directory observations after task entry; they
give no extra source-file hash, payload, Git or ACL allowance. Their paths are fixture inputs,
not inferred from an observed probe count, and have no lane-count or cycle-count threshold.
Top-level module directories are input units too; the common bundle root stays in the
ordinary route constant.
Selected skills also contribute their independently read `skill.json` and declared reference
paths. The snapshot retains the metadata's SHA-256 and names; it never discovers references
from the product's read counters. Historical reassessment may use the checksum-verified
archived fixture metadata, and must state that provenance.
For parent acceptance, the same independent timeline read extracts compact input units from
every distinct consumed task history. Review/cycle/context/lane identities include their task; a `code` lane in two
children is two units. Shared artifact paths and ancestor directories still earn credit once.
The reducer retains these manifests through merge. Child-tree families therefore need no
fixed four/five-lane replacement budget.
Malformed task facts earn no review units and retain their decoding error. Fact decoding
does not change the existing raw timeline event/byte inspection or native refusal.

Loaded-code units come from the identity reader's actual file arguments, including the
receipt issuer. The transparent observer retains domain/root/file identities and whether
bytes were retained or the native identity fallback ran. Shared files earn one hash/read
allowance across domains; a second capture of the same domain/root/file cannot mint a unit.
One retained-content identity witness adds one lstat/native-realpath pair; the fallback's
before/after witnesses add two pairs. No limit on capture count or task count is imposed.
An actual module instance first loaded during measurement also earns its one loader read,
separately from the required fresh identity read. The observer inventories `require.cache`
at the measurement boundary to identify that work; this is never source-receipt authority.
An old cold trace can be reassessed only when its one capture, complete distinct runtime hash
set, initial-file count and absence of retained/extra reads agree; otherwise fresh input
attribution is required. A repeated operation cannot create an additional unit. This measures
the cost of the native path; it does not replace genuine early-loader receipts, authenticate
the runtime, suppress a capture refusal or permit the coverage loader to stand in for it.

## Source-derived costs

For the ordinary Windows regular-file path with complete bigint identity:

| Unit | Hash | Payload read | fstat | lstat | stat | native realpath | directory realpath |
|---|---:|---:|---:|---:|---:|---:|---:|
| Distinct recorded artifact or loaded file | 1 | 1 | 2 | 6 | 1 | 3 | 0 |
| Distinct ancestor directory | 0 | 0 | 0 | 4 | 0 | 0 | 2 |

Recorded artifacts additionally allow one canonical-path admission and one regular-file
predicate. `isSafeCanonicalArtifactPath` in `task-audit-summary-review-common.ts` uses two
presence queries and two native realpaths; `fileExists` in `next-step-review-artifact-readers.ts`
uses one presence query and one stat. Thus this admission adds exactly three `existsSync`,
two native realpaths and one stat per artifact. It adds no read/hash and gives loaded-code
files no credit. A cold canonical review snapshot (`review-artifacts.ts`) additionally performs
three lstats (before/after reading and the exit witness) and six realpaths: candidate, matching
root, registered parent, bounded-read containment, and two exit comparisons. Thus the artifact
admission total adds three exists, one stat, three lstats and eight native realpaths, retaining
all native freshness witnesses. `reviews-index.ts:resolveContainedRegularReviewArtifact` also
checks each entry with one lstat and one ordinary realpath; those input-proportional index
witnesses are included separately. The complete artifact addition is therefore three exists,
one stat, four lstats, eight native realpaths and one ordinary realpath. These are upper bounds
for one traversal of the recorded inputs, rather than
an assertion that every route needs every guard. A duplicate payload or derivation still fails
its separate per-identity ceiling even when this aggregate allowance is unused.

`src/core/invocation-file-observation.ts` supplies the derivation: `captureContent` hashes and
reads once, compares two descriptor stats and a final path stat; `capturePath` acquires two
lstats and a canonical realpath. A file's path is checked initially, after reading and at
invocation exit. An ancestor is checked initially and at exit. `src/core/file-stat.ts` supplies
the native canonical realpath on Windows. This is an operation count, not a regression on
product output. Symlink handling and incomplete-device-ID reconstruction receive no guessed
credit. POSIX canonicalization must use its own realpath counter; this Windows candidate is
not native Linux/macOS calibration.

Review-context contract and persisted execution-authority derivations allow one reduction
per recorded review/context (`max(REVIEW_RECORDED, REVIEW_PHASE_STARTED)`); authoritative scope
allows one reduction per distinct recorded lane/scope/criteria/policy binding. A repeated
unchanged preflight creates no extra scope unit. The stand's measurement observer also hashes each
existing memo factory's semantic input key and attributes the actual derivation counter to it.
A second derivation for that key fails even when other recorded units were not processed.
The observer forwards every original call, return value, exception and native validator;
it changes no executable bytes, loader hook or receipt. A derivation outside its expected
memo boundary is reported explicitly. Old traces without these identities support aggregate
reassessment only; they cannot prove absence of same-unit duplication. Functional checks still
require every review. Timeline traversal remains
event-proportional. No extra per-cycle constant is invented: a new cycle contributes its
recorded contexts and distinct lineage artifacts.

## Strictness and decisions

Growth is judged on positive excess over the complete constant-plus-input allowance. Within
an unchanged recorded input set, consumed-file set and acquisition protocol, raw work must
also have zero positive slope, even below that aggregate ceiling. Native batch/fallback and
timeout protocols form separate cohorts; they grant no additional budget and never disable
the separate ACL subject-acquisition or route subprocess limits.

The reducer separately rejects a second hash/read of the same recorded artifact or loaded
file, regardless of unused route allowance. Lexical aliases and Windows case variants share
one identity. The task-mode envelope, transaction-owner and timeline live freshness reads
are outside this duplicate check; preflight retains one ordinary read plus the two native
review-index witnesses (`reviews-index.ts`, `observeReads=false`). Those witnesses add no
aggregate budget credit. A Git query permits its existing acquisition
and exit freshness observation; a third identical query fails even below the route ceiling.
ACL phase/subject acquisition limits remain in force. All original route process ceilings
still apply, independently of these stricter duplicate checks.

The unit controls cover five and nine lanes, repeated reviews across twelve cycles, every
relative counter at its boundary plus one operation, one closed review derived twice, one
artifact read/hashed twice, a repeated loaded-file hash, and duplicate Git/ACL queries. Merge
reduction retains the input manifests and derivation counters used by the verdict.
For source attribution only, `GARDA_STAND_COUNTER_ATTRIBUTION=1` adds probe input/caller
counters to a native diagnostic replay. It forwards each probe unchanged and participates in
resume identity. Its extra stack-capture time is not timing acceptance or calibration data.

`CounterBaseline.recordedWork` enables the reviewed model (`version: 1`, `loadedCode`,
`retireStates`). It is a baseline decision, not an automatic calibration step. The candidate
removes only the relative counters from obsolete lane-count/restart input-shape overrides;
their other counters, inheritance and process ceilings remain exact. Until accepted, the
ordinary runner keeps the accepted absolute budgets. Loaded-code allowance needs an explicit
decision with `loadedCode: true`; leaving it false exposes the native identity cost. Candidates,
calibration evidence and an exact expectation manifest must be prepared outside the source
tree and accepted through the normal coordinator procedure. The stand never writes them from
a red result. Performance acceptance remains red for repeated work or an unaccepted decision.

Archived calibration fingerprints continue to certify the absolute baseline they measured.
After an accepted migration, `walk-counter-history.ts` follows the checksummed baseline-decision
ledger back to that baseline for these historical assertions. It refuses a missing or changed
decision and verifies that the migration preserved ordinary constants, inheritance and every
unrelated ceiling. Current relative rules have independent input vectors and negative controls;
old maxima do not become relative coefficients. No historical evidence or seal is rewritten.
