---
layout: doc
title: Maxx Automation Trigger Runner
description: Runner behavior for explicit events that launch visible Maxx tabs.
section: reference
---

# Maxx Automation Trigger Runner

The automation trigger runner is the small, local-first piece that **executes** a
configured action in a visible Maxx tab when an external trigger arrives. It is
the execution counterpart to the [connector adapter layer](connector-adapters.html):
the connector layer _resolves_ a structured payload into a `sessions.create`
control request and stops there on purpose; the runner _runs_ it.

Maxx stays the visible terminal-native runtime/control plane, never the workflow
brain. The runner receives an explicit event, launches an explicit command or
prompt in a normal visible tab through the [Control API](control-api.html), and
records what happened. It assigns no workflow meaning to anything.

## The product boundary

- Maxx owns the **visible local execution surface**: opening a tab, launching a
  process with an explicit command/cwd/env, attaching provenance, and exposing
  the normal tab/session controls (inspect, stop, restart).
- The runner is the **thin glue** between a trigger source and that surface:
  receive event → filter explicit predicates → resolve configured action →
  suppress duplicates → launch → record.
- Workflow reasoning lives **downstream**, in the launched command (its prompt,
  skill, or upstream configuration) — never in the runner.

## The narrow pipeline

Every trigger, regardless of type, flows through one pipeline mirroring
`TriggerEvent -> RunnerAction -> VisibleTabExecution`:

1. **Receive** the payload bytes. Three trigger types deliver them; all converge
   on a structured payload handed to a connector adapter.
2. **Filter** with configured predicates over explicit adapter fields. A
   mismatch records `filtered` and stops before launch side effects.
3. **Resolve** the payload (adapter → `TriggerEvent`) and the configured launch
   template (`connector.resolve` → `LaunchRequest`).
4. **Suppress duplicates** against the persistent dedup store.
5. **Execute**: inject the capability token, send `sessions.create` to the
   running Maxx, and deliver the prompt out of band for `stdin`/`file` delivery.
6. **Record** an activity record and mark the event seen.

## Trigger types

The trigger type is **provenance only** — it is recorded and displayed, but never
changes how the action is selected.

| Type            | How the payload arrives                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `poll`          | A configured **check command** runs; it fires only when its exit code matches the contract, and its stdout is the payload. |
| `script`        | A local process calls `maxx +runner run` with a concrete payload on stdin or in a file.                                    |
| `webhook_relay` | A local relay endpoint/client delivers an event and pipes it into `maxx +runner run`.                                      |

`script` and `webhook_relay` are identical to the runner (a payload arrives); they
differ only in the recorded provenance, so an operator can see where an event
came from.

## No-inference rule

This is the load-bearing constraint, enforced by design and asserted in tests.
The runner MUST NOT:

- scrape, regex, or otherwise interpret terminal output to decide what to do;
- guess intent from process names, branch names, paths, tab titles, or idle time;
- attach Maxx domain meaning to source concepts.

The polling case has a precise boundary worth stating outright:

- The decision to **fire** is the configured **exit-code contract** only
  (`--fire-on`, default `0`). The runner never reads the check's output to decide
  whether something happened.
- The check's **stdout is an opaque structured payload**, forwarded verbatim to
  the configured adapter, which copies only explicit fields. The runner does not
  interpret it.

So a polling check is a pure data source: "exit `0` means an event occurred; here
is its payload." What that event _means_ is the adapter's and the launched
command's concern.

## Watch-mode polling

By default `maxx +runner poll` remains a one-shot check: run the configured
command once, fire only if the exit code matches `--fire-on`, print one activity
record, and exit.

Add `--interval <duration>` to make the runner durable:

```sh
maxx +runner poll --source linear --command 'claude ${issue.identifier}' \
    --trigger linear-todo \
    --check './scripts/poll-linear-todo.sh' \
    --fire-on 0 \
    --interval 60s
```

`--watch` is shorthand for watch mode with the default 60s interval. Durations
use the same style as control waits: bare numbers are seconds, or add `ms`, `s`,
`m`, or `h`. A successful/idle/duplicate/filtered cycle sleeps for the configured
interval. A failed cycle is reported as a structured `outcome: "failed"` record
and retried with exponential backoff, capped by `--max-backoff` (default: a
bounded value derived from the interval). Pass `--fail-fast` if configuration or
check failures should terminate the loop instead of retrying.

The loop handles SIGINT/SIGTERM by finishing normal code paths, saving dirty
dedup state when possible, and exiting. It does not do filesystem work inside the
signal handler itself.

## Predicate filtering

`run` and `poll` accept the same predicate model as webhook routes:

- `--predicate FIELD=VALUE` — exact string equality.
- `--predicate-bool FIELD=true|false` — exact boolean equality.
- `--predicate-present FIELD` — field must be present.

All predicates must match. They are evaluated after the adapter parses the
payload and before template resolution, control-dir lookup, duplicate
suppression, prompt-file writes, or launch. A mismatch prints an activity record
with `outcome: "filtered"` and exits `0`; nothing is recorded as seen.

Examples:

```sh
# Launch only for Linear issue payloads whose explicit state name is Todo.
maxx +runner run --source linear --command 'claude' \
    --predicate issue.state.name=Todo --payload event.json

# Launch only for GitHub pull_request payloads whose explicit merged flag is true.
maxx +runner run --source github --command 'codex run cleanup-merged-pr' \
    --predicate object.type=pull_request \
    --predicate-bool pull_request.merged=true \
    --payload delivered.json
```

## Duplicate suppression

The runner records each firing in a small persistent JSON store
(`<control-dir>/runner-seen.json`, override with `--state-file`) keyed on
`(trigger, source, key)`, where `key` is the **explicit** adapter event id or a
configured cursor (`--dedup-key`). A re-delivered event — a webhook retry, a poll
that still reports the same id — is suppressed instead of launching twice.

- When a source emits **stable** event ids/cursors, suppression is exact.
- When a source has **no stable identity** (it rotates ids on each delivery), the
  runner cannot tell a retry from a new event and will act once per id. This is
  documented best-effort, never a guess — disable it with `--no-dedup` if a source
  is unsuitable.
- A `key`/trigger/source longer than the dedup store's field caps could never be
  recorded, so (with dedup enabled) the runner **rejects it up front** — before
  any launch — rather than spawn a tab whose dedup record is impossible and would
  re-fire on every retry. Use `--no-dedup` if a source legitimately needs keys
  that large.

Only a **successful** launch is recorded as seen, so a transient failure (a denied
policy, an unreachable socket) can be retried. The store is bounded on the write
side as well as the read side — by count (oldest records dropped past a cap), by
age (records past ~30 days pruned before each save), and by size (per-field length
caps keep each record small, and `save` refuses to write a file that would exceed
the read cap rather than persist one the next run would reject). It is written
`0600` and atomically (per-process temp + rename), leaves a newer-schema file
untouched (fail-open, no clobber), and recovers from a corrupt file by starting
empty. If the seen-marker cannot be persisted (unwritable directory, disk full, or
the size backstop), the run reports an `error_code` and exits non-zero — the tab
launched, but a retry could duplicate it, so the operator is not falsely told the
event was recorded.

A given `--state-file` is meant to be driven by **one runner at a time** (the
usual model: one poll loop or one webhook relay per trigger). Atomic writes mean
neither writer ever sees a half file, but the final rename is last-writer-wins, so
two runners racing on the same state file can each drop the other's most recent
record (and so re-launch). Use a distinct `--state-file` per concurrent runner.

## Prompt delivery

The resolved prompt reaches the launched command per `--prompt-delivery`:

- `env` (default) — carried in the `sessions.create` request as
  `MAXX_CONNECTOR_PROMPT`.
- `stdin` — after the tab is created, the runner sends a `sessions.action`
  `input` request that types the prompt into the new session. That follow-up is
  attributed to the **same policy `caller`** as the create (so `input:send` is
  evaluated against the configured source, never silently the trusted local
  source), and its response is checked: if delivery is denied or fails, the
  activity record carries an `error_code` and the command exits non-zero. The
  launch itself is still recorded (the tab exists; re-firing would duplicate it),
  so re-deliver the prompt explicitly with `sessions action <id> --action input`
  rather than re-running the trigger.
- `file` — the runner writes the prompt to a `0600` temp file (a per-launch
  unique `maxx-prompt-<event-id>-<pid>-<nanos>.txt` in the control directory,
  created exclusively so concurrent launches never overwrite each other) and
  injects its path as `MAXX_CONNECTOR_PROMPT_FILE` at create time. The file must
  outlive the runner process (the launched agent reads it asynchronously), so the
  runner cannot delete its own; instead each `.file` run best-effort sweeps prompt
  files left by previous runs once they age past ~1 day.

## Visibility and control

- The launched tab is a **normal visible Maxx tab**. Inspect, stop (`sessions
  action <id> --action interrupt`/`cancel`), or restart it with the usual
  tab/session controls — triggered execution is never hidden background work.
- Each launch carries explicit provenance metadata on the tab: the connector
  keys (`connector`, `connector.event_id`, …) and the runner keys
  (`runner.trigger`, `runner.trigger_type`, `runner.received_at`).
- Every invocation prints a JSON **activity record**: the trigger name, type,
  received time, source, event id, dedup key, the command/title launched, the
  outcome (`launched` / `duplicate` / `failed` / `dry_run` / `filtered`), the
  resulting `session_id`, and any `error_code`/`error_message`.
  `maxx +runner list-seen` prints the recorded suppression entries.

## Target tab behavior

Each firing opens a **new visible tab** (the `sessions.create` `location` is
`tab`). Reusing an already-open named tab or an explicitly configured session id
is a deliberate follow-up, not an inference the runner makes: it would require a
create-or-attach lookup against the control registry, and conflating "the tab
named X" with a workflow target is exactly the kind of guess Maxx avoids. Until
that lands, a caller that wants to drive an existing session does so explicitly
with the Control API (`sessions action <id> --action input`).

## Errors

Operational failures are visible and actionable, never silent. Configuration and
parse errors (unknown source, malformed template placeholder, missing required
field, unspawnable check) print a clear message and exit non-zero. Execution
failures (denied by policy, unreachable socket, prompt-delivery failure) are
surfaced in the activity record's `error_code`/`error_message` with a non-zero
exit, and are not recorded as seen so they can be retried.

## CLI

```
# A local script triggers a launch from a concrete payload (stdin).
cat event.json | maxx +runner run --source linear --command 'claude' \
    --trigger linear-issues --trigger-type script

# A webhook relay pipes a delivered event in.
maxx +runner run --source github --command 'codex' \
    --trigger gh-prs --trigger-type webhook_relay --payload delivered.json

# A polling trigger: fire only when the check exits 0; its stdout is the payload.
maxx +runner poll --source linear --command 'claude ${issue.identifier}' \
    --trigger linear-poll --check './scripts/poll-linear.sh' --fire-on 0

# Keep polling every minute until SIGINT/SIGTERM; duplicate issue ids are
# suppressed through the same runner-seen state file across restarts.
maxx +runner poll --source linear --command 'claude ${issue.identifier}' \
    --trigger linear-todo --check './scripts/poll-linear-todo.sh' \
    --fire-on 0 --interval 60s

# Add predicates to run/poll payloads before any launch side effects.
maxx +runner poll --source github --command 'codex run cleanup-merged-pr' \
    --trigger gh-pr-merged --check './scripts/poll-gh-pr.sh' \
    --predicate object.type=pull_request \
    --predicate-bool pull_request.merged=true

# Attribute the launch to a policy source and group it for a supervisor.
maxx +runner run --source linear --command 'claude' \
    --as linear-webhook --group 'issue-${issue.identifier}' --payload event.json

# Resolve and dedup-check without launching (no running Maxx required).
cat event.json | maxx +runner run --source linear --command 'claude' --dry-run

# Inspect duplicate-suppression state.
maxx +runner list-seen
```

`run`/`poll` exit `0` for `launched`, `duplicate`, `dry_run`, `filtered`, and a
poll that did not fire (nothing to do); they exit `1` for a failed launch or a
configuration error.

## Linear Todo poller shape

The check command owns the Linear query. Maxx only sees its explicit exit code
and the structured payload it writes to stdout. A simple Todo poller can use a
non-fire exit code such as `7` for idle and emit the existing Linear adapter's
webhook-shaped payload when it finds work:

```sh
#!/usr/bin/env bash
set -euo pipefail

: "${LINEAR_API_KEY:?set LINEAR_API_KEY}"
TEAM_KEY="${LINEAR_TEAM_KEY:-MAX}"
IDLE_EXIT="${MAXX_RUNNER_IDLE_EXIT:-7}"

query='
query TodoIssue($team: String!) {
  issues(
    filter: { team: { key: { eq: $team } }, state: { name: { eq: "Todo" } } }
    first: 1
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      url
      description
      state { id name type }
    }
  }
}'

response="$(
  jq -n --arg query "$query" --arg team "$TEAM_KEY" \
    '{query: $query, variables: {team: $team}}' |
  curl -fsS https://api.linear.app/graphql \
    -H "Authorization: $LINEAR_API_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary @-
)"

issue="$(jq -c '.data.issues.nodes[0] // empty' <<<"$response")"
if [[ -z "$issue" ]]; then
  exit "$IDLE_EXIT"
fi

jq -n --argjson issue "$issue" \
  '{type:"Issue", action:"poll", data:$issue, url:$issue.url}'
exit 0
```

Run it with `--fire-on 0`. The adapter uses `data.id` as the event id, so a Todo
issue that remains visible across repeated checks launches at most once for the
same trigger/source/dedup state. If a source needs a different explicit cursor,
pass `--dedup-key <key>` from the surrounding runner configuration.

> **Grouped launches and policy.** A `sessions.create` that sets `--group` is
> gated by the control server on **both** `tabs:spawn` and `groups:create`. The
> built-in `trusted-automation` source has only `tabs:spawn`/`state:set`, so
> pairing `--as trusted-automation` with `--group` is rejected (`unauthorized`,
> no tab spawned). A grouped webhook launch needs a configured policy source
> such as `linear-webhook` granted both capabilities. See
> [configured policy sources](control-api.html#configured-policy-sources).

## Relationship to the connector layer

`+connector resolve` and `+runner` are deliberately split so resolution stays
pure and exhaustively testable while execution stays small and local:

| Concern                              | `+connector resolve` | `+runner` |
| ------------------------------------ | -------------------- | --------- |
| Parse payload → `TriggerEvent`       | ✓                    | ✓         |
| Evaluate explicit predicates         | —                    | ✓         |
| Resolve template → `sessions.create` | ✓                    | ✓         |
| Inject capability token              | —                    | ✓         |
| Send to the running Maxx             | —                    | ✓         |
| Deliver `stdin`/`file` prompt        | —                    | ✓         |
| Duplicate suppression                | —                    | ✓         |
| Run a polling check                  | —                    | ✓         |
