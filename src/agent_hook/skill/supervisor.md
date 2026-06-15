---
name: maxx-supervisor-workflows
description: Supervise child Maxx tabs from a parent Claude Code or Codex session. Teaches a supervisor agent to fan work out into visible child tabs, preserve their session ids, declare explicit state/metadata and parent/group relationships, watch/wait on explicit Maxx events, intervene only when a child declares it needs input, and synthesize results from child-authored summaries — never by scraping terminal output. Use when one agent coordinates several child agents or tabs (e.g. "fan this out across tabs", "spawn workers", "supervise/orchestrate these tasks", "run these in parallel tabs", "wait for the child tabs", "summarize the group", "merge the children's results").
---

<!-- managed by maxx-agent-hook; do not edit (reinstalled from Maxx settings) -->

# Supervising child Maxx tabs

You are a **supervisor**: one Claude Code or Codex session coordinating several
child agents that each run in their own visible Maxx tab. This skill is the
playbook for that. Basic single-tab management (open, rename, prompt, close) is
the companion **`maxx-tabs`** skill; this one is about parent/child
orchestration.

**You** own the workflow: how to split the task, what each child should do, what
"done" means, and how to combine results. **Maxx** spawns visible tabs and
reports **explicit facts** (process lifecycle, ids, timestamps, and whatever an
agent _declares_ through the control API) — it will not figure any of the
workflow out for you. The product boundary is fixed:

> Maxx is the visible terminal-native runtime/control plane, not the workflow brain.

## The no-inference rule (read this first)

Maxx never guesses workflow meaning, and neither should you when reading it
back. Coordinate **only** on explicit signals:

- explicit **mechanical facts** Maxx owns — a session/tab exists, its process is
  running or `exited`, its ids, its timestamps; and
- explicit **agent-declared facts** — a state, summary, metadata key, or event a
  child (or you) declared through `maxx +control`.

Never derive a child's progress by **scraping or regexing its terminal output**,
by reading its **process name, branch, path, worktree, cwd, or tab title**, or
by treating **idle time** as "finished". A process that `exited` is a mechanical
fact, _not_ a success — only an explicit `complete`/`failed` declaration tells
you the outcome. If a status you want has no declaration path, ask the child to
declare it (see _summarize_), or report the gap — do not infer it.

## Two control surfaces

| Surface                                                  | Reach                                               | Use it for                                                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxx-agent-hook` (in-tab CLI, on PATH inside Maxx tabs) | The current window's tabs, via AppleScript          | Quick visible ops: `new-tab`, `list-tabs`, `send`, `rename-tab`, `close-tab`. See the **`maxx-tabs`** skill.                                 |
| `maxx +control sessions …` (the control API)             | Any **API-created** session, by stable `session_id` | Everything a supervisor needs: spawn with a recorded command, declare state/metadata, set parent/group, `watch`/`wait`, stream group events. |

Prefer the **control API** for supervised work: a `sessions create` returns a
stable `session_id` that survives renames, restarts, and reconnects, and it
unlocks state/metadata/group/watch. (`maxx-agent-hook new-tab` opens a visible
tab too, but it is _not_ an API-created session, so it has no `session_id` and
none of those primitives — you can only observe it through `list-tabs`' hook
state.) The control API only ever sees **API-created** sessions; the user's
hand-opened terminals are never reachable through it.

Notes on invocation:

- The binary is the Maxx app's CLI: `maxx +control …` (on a dev build or the
  Ghostty CLI it is the same `ghostty +control …`). It finds the per-user
  socket and capability token for you.
- It talks to the running app over `/tmp/maxx-control-<uid>/`. To target a
  specific app instance (e.g. a dev build), export `MAXX_CONTROL_DIR` and pass
  the **same** value to every call.
- Every call prints one JSON response. Capture `session_id` with `jq`.
- A flag value that begins with `+` must use `--flag=value` form
  (`--command=+x`); otherwise Maxx's `+action` detection grabs it.

## The six supervisor moves

### 1. spawn — create a visible child tab with an explicit prompt

> **`--command` runs in the child's _login shell_.** Maxx launches the session by
> typing `<command>; exit` into a shell, so the whole string is shell-parsed —
> unlike `maxx-agent-hook new-tab -- claude "<prompt>"`, which passes its args
> verbatim with no shell. **Never interpolate untrusted or variable prompt text**
> (an issue title, a user message, a file's contents) into `--command`: a prompt
> containing `$(…)`, backticks, `;`, or quotes would be evaluated by the shell
> before the agent even starts, and embedded quotes would break the command.

So spawn the agent and its **permission flags** as the command (no task text in
it), capture the returned `session_id`, then deliver the task as **literal
input** (next step) — `--action input` is sent verbatim to the running agent and
is never shell-parsed, so it is safe even for untrusted prompts.

```sh
# Claude Code child — launcher only; the task is delivered as input below.
child=$(maxx +control sessions create \
  --title "Fix parser" \
  --cwd "$PWD" \
  --agent-type claude-code \
  --group refactor-2026 \
  --metadata role=worker --metadata task=MAX-123 \
  --command 'claude --permission-mode acceptEdits' \
  | jq -r .result.session.session_id)

# Codex child (note the different permission flags).
child=$(maxx +control sessions create \
  --title "Add CSV export" \
  --cwd "$PWD" \
  --agent-type codex \
  --group refactor-2026 \
  --metadata role=worker --metadata task=MAX-124 \
  --command 'codex --full-auto' \
  | jq -r .result.session.session_id)

# Deliver the task prompt as literal input once the agent is up (give it a
# moment to start its prompt). Safe for variable/untrusted text — no shell parses it.
# --action input sends the bytes verbatim and does NOT press Enter, so end the
# text with a newline ($'…\n') to actually submit it.
maxx +control sessions action "$child" --action input \
  --input $'Fix the JSON parser overflow in src/parse.zig; run the parser tests.\n'
```

`--action input` is the literal-input channel used throughout this skill (task
delivery, follow-ups, answering `needsInput`); it never synthesizes Enter, so
always include the trailing `\n` when the agent should act on the line.

(A short, fixed prompt you author yourself _can_ be embedded directly in
`--command` — single-quote the whole command and keep `$`, backticks, and quotes
out of the prompt — but route anything dynamic through `--action input` so an
injected prompt can never reach the shell.)

**Preserve the returned `session_id`** — it is the handle for every later move.
Do not rediscover children by tab title, process name, or cwd. To attach a child
to a parent that already exists, pass `--parent <parent_session_id>` at create,
or `sessions set-parent <child> --parent <parent>` afterward.

### 2. declare — set explicit state and metadata (never inferred)

Two kinds of declaration, both stored and replayed verbatim by Maxx:

```sh
# Displayed workflow-state badge + one-line summary (for humans watching the UI).
# State is exactly one of: running | needsInput | blocked | complete | failed.
maxx +control sessions set-state   "$child" --state running
maxx +control sessions set-summary "$child" --summary "Reproducing the overflow"

# Agent-reported metadata: namespaced key -> any JSON value (parent/group/role/
# task/issue/PR/...). Stored and filtered verbatim; never read as workflow state.
maxx +control sessions set-metadata "$child" --key linear.issue --value MAX-123
maxx +control sessions set-metadata "$child" --key pr.url --value https://github.com/org/repo/pull/456
maxx +control sessions set-metadata "$child" --key run --value-json '{"id":"run_abc","attempt":2}'

# Relationships are explicit metadata too:
maxx +control sessions set-parent "$child" --parent "$supervisor_session"
maxx +control sessions set-group  "$child" --group refactor-2026
```

For machine coordination (so a `wait` can match), use the free-form
`declare-state` and named `emit-event` instead of — or alongside — the display
badge:

```sh
maxx +control sessions declare-state "$child" --state tests:passed --message "all green" --source worker
maxx +control sessions emit-event    "$child" --event pr.opened --payload-json '{"pr":456}'
```

**A child declares its own state.** Tell the child (in its prompt) to declare
progress. Inside its tab it resolves its own `session_id` by matching its
surface id — no scraping, no guessing:

```sh
self=$(maxx +control sessions list \
  | jq -r --arg s "$GHOSTTY_AGENT_SURFACE_ID" \
      '.result.sessions[] | select((.surface_id|ascii_downcase)==($s|ascii_downcase)) | .session_id')
maxx +control sessions set-state   "$self" --state complete
maxx +control sessions set-summary "$self" --summary "Parser overflow fixed; 12 tests green"
```

You can also declare on a child's behalf (you hold its `session_id`) — but a
_child-authored_ summary is the truthful source for synthesis.

### 3. watch — wait for explicit state/event changes

Follow **one** child. `sessions wait` takes exactly one of `--lifecycle` (a
Maxx-owned process fact), `--event` (an edge-triggered `emit-event`), or
`--state` (level-triggered on the free-form `status` an agent sets with
`declare-state` / `update --status`). Note: `--state` matches `status`, **not**
the `set-state` display badge (`workflow_state`) — those are separate fields:

```sh
maxx +control sessions watch "$child" --json                          # stream lifecycle + declarations
maxx +control sessions wait  "$child" --lifecycle exited --timeout 1h  # mechanical: the process ended
maxx +control sessions wait  "$child" --event pr.opened --timeout 30m  # a milestone the child emit-event'd
maxx +control sessions wait  "$child" --state needs-review --timeout 30m  # a free-form status it declare-state'd
```

A mechanical `exited` does not say whether the work succeeded — after it, read
the child's declared `workflow_state` / `summary` (`sessions get`) to learn the
outcome.

Follow a **whole group** on the cross-resource event stream (resumable via the
monotonic `--since` cursor, so a dropped connection never loses events). Here
`--all declared:<state>` matches each member's `set-state` badge:

```sh
maxx +control stream watch --group refactor-2026 --json          # every event in the group
maxx +control stream wait  --group refactor-2026 --all exited --timeout 1h     # every process ended (mechanical)
maxx +control stream wait  --group refactor-2026 --all declared:complete       # every set-state badge == complete
maxx +control stream wait  --group refactor-2026 --all idle                    # none currently declared running
maxx +control stream wait  --group refactor-2026 --event deploy.done           # any member emits this event
```

`wait`/`stream wait` exit codes let scripts branch without reading output:
`0` matched, `2` timeout, `3` no such session, `4` target ended before matching,
`6` confirmation required. Durations take `ms`/`s`/`m`/`h` (a bare number is
seconds).

### 4. intervene — act only when a child's _declared_ state calls for it

Do not poke a running child. Step in only on an explicit `needsInput` (or a
declared `blocked`/`failed`):

```sh
maxx +control sessions action "$child" --action focus                       # bring it on screen
maxx +control sessions action "$child" --action input --input $'yes, proceed\n'   # answer its prompt
maxx +control sessions action "$child" --action interrupt --signal SIGINT   # stop the foreground process
```

A menu or permission prompt inside an agent reads **key presses**, not pasted
text. From inside the window, the in-tab helper presses keys for that terminal:

```sh
maxx-agent-hook send --key enter <terminal-id>     # confirm the highlighted choice
```

### 5. summarize — synthesize from declared facts, not from scrollback

Ask each child to declare a summary, then read the **declared** facts back:

```sh
# Prompt the child to wrap up and declare (see the template below), then:
maxx +control sessions get "$child" | jq '.result.session | {workflow_state, summary, metadata}'
maxx +control sessions list --group refactor-2026 \
  | jq '.result.sessions[] | {id:.session_id, state:.workflow_state, summary, task:.metadata.task}'
maxx +control sessions events "$child"   # the full audit log of declarations + lifecycle
```

Build your final report from each child's declared `workflow_state`, its
authored `summary`, its `metadata`, and the mechanical `lifecycle` — **cite
those**, never a guess from terminal text or how long a tab sat idle.

### 6. delegate — keep workflow logic out of Maxx

Put every task-specific decision in the **child's prompt**, a **named skill**,
or an **external command** the child runs — never expect Maxx to encode it.
Maxx stays a generic visible runtime: it spawns tabs and records the facts you
and the children declare. Keep child prompts self-contained (what to do, how to
verify, and to declare `complete`/`failed` with a summary when done) so the work
is reproducible and the supervisor only coordinates.

## Reading child state (explicit signals only)

Every state below arrives from an explicit declaration or a mechanical fact —
map it to an action, and never substitute terminal scraping or idle time.

| State                            | Explicit source                                                       | Means                                  | Your response                                                                                    |
| -------------------------------- | --------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `running`                        | child `set-state running`; or `list-tabs` hook `agent.state`          | a turn is in progress                  | keep watching; don't interrupt                                                                   |
| `needsInput`                     | child `set-state needsInput`; or hook `needsInput`                    | waiting on input/permission            | _intervene_ — `--action input`, or press a key                                                   |
| `idle`                           | `stream wait --all idle` (no member declared running); or hook `idle` | not currently working                  | check for a declared state/summary; decide the next step                                         |
| `blocked`                        | child `set-state blocked`                                             | child declared it is stuck             | read its summary; unblock, reassign, or escalate                                                 |
| `error` / `failed`               | child `set-state failed` / an `emit-event`; or hook `error`           | child declared a failure               | read the summary/event; retry or escalate                                                        |
| `complete`                       | child `set-state complete`                                            | child declared the work done           | collect the summary; archive/close                                                               |
| `exited` / `closed` / `archived` | Maxx-owned `lifecycle` / stream events                                | process ended or tab gone (mechanical) | a mechanical end only — pair it with a declared `complete`/`failed` before calling the work done |

## Prompt templates

Copy-paste and fill the angle-bracket parts. They work for Claude Code and
Codex; only the `--command` permission flags differ (see _spawn_).

**Fan out** — one child per unit of work, grouped:

```text
You are a worker tab supervised by another agent. Task: <one self-contained task>.
Working dir: <cwd>. When you finish, declare your result so the supervisor can read it
without watching your output:
  self=$(maxx +control sessions list | jq -r --arg s "$GHOSTTY_AGENT_SURFACE_ID" \
    '.result.sessions[]|select((.surface_id|ascii_downcase)==($s|ascii_downcase))|.session_id')
  maxx +control sessions set-summary "$self" --summary "<one line: what you did / found>"
  maxx +control sessions set-state   "$self" --state complete   # or failed
If you need a decision you cannot make, set-state needsInput with a summary naming the question, then wait.
Do not assume anything about sibling tabs.
```

**Progress check** — no prompting, just read declared facts:

```sh
maxx +control sessions list --group <group> \
  | jq '.result.sessions[] | {task:.metadata.task, state:.workflow_state, summary, lifecycle}'
```

**Request a summary** — ask a specific child to declare one:

```text
Wrap up now. Set-summary on your own session with one line covering what changed and how you verified it,
then set-state complete (or failed with the reason). Do not print the summary only to the terminal —
declare it via maxx +control so I can read it explicitly.
```

**Final synthesis** — combine declared results into one report:

```sh
maxx +control sessions list --group <group> \
  | jq -r '.result.sessions[] | "- \(.metadata.task // .title) [\(.workflow_state // "no state")]: \(.summary // "(no summary declared)")"'
# Then write the report from those declared lines + each child's events/metadata. Cite them.
```

**Close / archive** — clean up children you created:

```sh
maxx +control sessions archive "$child" --reason "work merged"   # close surface, keep the record + audit log
maxx +control sessions cancel  "$child"                          # cancel/close (idempotent)
```

## Permission modes for child workers

A child stalls forever if it hits an approval prompt you are not watching.
Choose a non-stalling mode for managed workers, and surface it explicitly. These
are the **launcher** `--command` values (no task text — deliver the prompt with
`--action input`, per _spawn_ above):

- **Claude Code:** `claude --permission-mode acceptEdits` (also `default`,
  `plan`, `dontAsk`).
- **Codex:** `codex --full-auto` (workspace-write + approval on failure), or
  `codex --sandbox workspace-write --ask-for-approval never`.

**Never** pass a bypass/danger mode (`claude --permission-mode
bypassPermissions`, `codex --dangerously-bypass-approvals-and-sandbox`) unless
the user explicitly asked for it. A stalled child is recoverable anyway: it
declares `needsInput` (or shows `needsInput` in `list-tabs`), and you answer with
`--action input` or a key press.

## Cleanup

Only archive/close tabs **you** created, or that the user told you to close.
`archive` keeps the session record and its audit log (readable via `get` /
`events`); `cancel`/`close` is idempotent. To rerun a child's recorded command in
a fresh surface, `sessions restart "$child" --last-command` — it keeps the stable
`session_id` (and reported metadata) but clears the per-run state/summary badge,
so re-declare for the new run.

## Notes

- The control API requires a running Maxx app and its per-user socket/token; it
  is not available from a non-Maxx shell.
- Group membership is one group per session; setting a new group leaves the old.
  Group and parent are opaque labels/edges — Maxx infers nothing from their text.
- See the **`maxx-tabs`** skill for single-tab basics and the full
  `maxx-agent-hook` reference.
