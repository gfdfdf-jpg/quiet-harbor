# Retryable navigation observations

The navigator contract requires a refusal to retain its real cause and name an
executable recovery (C2.4 and C3.4.4 in [concept rules](concept-rules.md)). The
ordinary `--as-json` contract returns a task-bound result on stdout, including
`BLOCKED` decisions. An exception printed only on stderr supplies no such result.

When planned-source visibility or an authenticated workspace snapshot generation
changes during inspection, the navigator discards that inspection and its effect
plan. Both `next-step` and `gate next-step` return JSON with:

```json
{
  "status": "BLOCKED",
  "next_gate": "git-observation",
  "retryable": true,
  "reason": "The original freshness refusal and retry instruction",
  "commands": [{ "label": "Retry next-step", "command": "The navigator inspection command" }]
}
```

The existing workspace/Git observation route is shared; only `retryable: true`
authorizes an automatic retry. Ordinary Git failures retain their existing behavior.
The full response keeps the normal schema and task identity. Its one command is
also `navigator_command`; it preserves repository/events/reviews roots and starts
a fresh inspection, without `--execute-effects` or a retained effect-plan hash.
Like other successfully reported `BLOCKED` decisions, it exits zero. Unexpected
exceptions and integrity failures are not classified as retryable by message text.

The stand retains the refused navigation as a measured step and follows this
machine-readable instruction once. A consecutive retryable refusal fails the walk
with its original reason. Empty/malformed stdout, nonzero process exit, and damaged
diagnostic evidence remain failures; stderr text alone never authorizes a retry.

The field RED case must complete without a retry when the workspace is unchanged.
Its cold selection reader must restore authenticated task-mode planned visibility
before capturing a workspace generation. A real later scope/entry/publication
change still invalidates that generation.
