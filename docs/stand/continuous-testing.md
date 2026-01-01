# Continuous testing with the reference stand

The reference stand is the acceptance oracle of the navigator. This page says what runs when. How the stand works is in [the stand README](../../tests/node/synthetic/README.md). The directory name `tests/node` only says that Garda's own test code is written for Node. The scenarios cover 19 project stacks and an unknown stack, and no stack is favored.

## Levels

| Level | What it runs | Where | When |
|---|---|---|---|
| `short` | A representative sample | Locally | While developing a change |
| Selected scenarios | `--only <ids>` | Locally | To prove one fix or replay one finding |
| `full` | Every scenario family. Linux: deep review families on all stacks. Windows: the seeded rotation of deep families | CI, `reference-stand.yml`, in shards | On every integrated change |
| `sweep` | `full` plus seeded disturbances at random moments of a task | CI, the same workflow with `level=sweep` | After `full` is green, then continuously |

The ordinary `ci.yml` run covers unit, gate, CLI, lifecycle, smoke and release validation. It runs on every integrated change, next to `full`.

## Continuous cycle

1. **Every integrated change:** the ordinary CI and the `full` stand on Linux and Windows.
2. **Sweep with a new seed, on a schedule (planned, nightly):** on the latest integrated commit. A new seed covers other moments of failure, so coverage keeps growing without new code. The schedule is not configured yet; until it is, start the workflow by hand.
3. **Before a release:** `sweep` on Linux and Windows with three different seeds, all green, plus a timing baseline on a quiet machine.

## Rules

- Run `sweep` only on a green `full`. On a red `full`, disturbances only multiply known failures.
- A shard is never a verdict. Only the merged result of every shard is.
- Every failure must be replayable by its scenario ID and seed.
- A failing disturbance, and every bug found in real work, becomes a permanent scenario: see [field cases](field-cases.md).
- Baselines and expectation seals change only through the `stand.cjs baseline` command, with a written reason. Never raise a budget to hide a failure.
- Do not change a checkout while a stand runs from it.
- Timing is meaningful only on a quiet machine. On CI runners it is always inconclusive.
