# Maxx Control API

The Maxx Control API is a **local, token-authenticated** control surface that
lets trusted scripts, local automation, and webhook runners **outside** an
existing Maxx tab create and manage Maxx tabs/sessions safely.

Maxx is the terminal-native runtime/control plane: it provides explicit,
observable control over terminal tabs and sessions. It is **not** a workflow
brain. External orchestrators decide _what_ should happen and speak to Maxx
through explicit API calls.

## The control-plane / agent-declaration boundary

The API surface splits cleanly into two halves, and that split is the load-
bearing design constraint:

- **Control plane (runtime primitives).** Verbs that observe and control what
  Maxx can know as a terminal runtime: session identity, process liveness,
  focus, `wait`, `watch`, `interrupt`, `archive`, and `restart`. These are
  `maxxctl`-style operations.
- **Agent declarations (workflow semantics).** Verbs an agent or orchestrator
  uses to **declare** workflow-relevant facts Maxx then stores and replays
  verbatim: `declare-state`, `emit-event`, and the agent-reported metadata verbs
  (`set-metadata`, `remove-metadata`, `clear-metadata`). These are
  `maxx-agent-hook`-style operations.

Maxx never originates or interprets the semantic facts; it only records the ones
an agent declares and reports the runtime facts it can directly observe. Both
halves share the same `maxx +control` CLI and socket here, but the conceptual
boundary is preserved by the verb groups (and could be split into two binaries
without changing the protocol).

## No-inference guarantee

The API never scrapes or regexes terminal output and never guesses workflow
semantics from process names, branch names, paths, idle time, or similar
signals. Every meaningful action comes from an explicit API request and declared
metadata. The only Maxx-owned lifecycle signal is derived from explicit session
state — whether the surface still exists and whether its child process has
exited (a kernel-reported fact) — never from terminal contents.

Put another way, Maxx shows only **mechanical facts** (things it owns or
observes as a terminal runtime) and **agent-declared facts** (workflow meaning
declared through an explicit API call, hook event, or metadata field). It never
derives **workflow truth** — _complete_, _blocked_, _tests passed_, _PR created_
— from incidental signals. This is the no-inference rule; the canonical
statement, the allowed/prohibited sources, and the tests that lock it down live
in [`no-inference.md`](no-inference.md).

## Transport & trust boundary

- **Unix domain socket**, created by the running Maxx app at
  `/tmp/maxx-control-<uid>/control.sock` (override the directory with
  `MAXX_CONTROL_DIR`). The directory is `0700` and the socket is `0600`, so only
  the local user can connect. There is no network surface.
- **Capability token**: the app writes a random token to
  `/tmp/maxx-control-<uid>/token` (`0600`). Every request must present it. This
  is defense-in-depth on top of the filesystem boundary and authorizes
  cross-process callers such as webhook runners.
- **Wire protocol**: newline-delimited JSON. Connect, write one request object
  followed by a newline (or half-close the write side), and read one response
  object terminated by a newline.

## Capability policy

On top of the token gate, every request is evaluated against a typed
**capability policy** before any side effect runs. A request resolves to a
caller **source** and a requested **capability**; the policy returns **allow**,
**deny**, or **confirm**.

- **Capabilities** are typed values with stable names: `tabs:list`, `tabs:spawn`,
  `tabs:restart`, `tabs:focus`, `tabs:close`, `input:send`, `keys:press`,
  `state:set`, `metadata:set`, `groups:create`, plus `output:read`, `groups:list`,
  and `automation:trigger`. The last three are part of the model but have no
  method behind them yet, so they are reported **unavailable** and always denied
  (`output:read` is additionally privacy-sensitive and requires an explicit
  opt-in even once a readback subsystem exists). `groups:create` became
  implemented with the structured event stream (MAX-7).
- **Sources** have a `kind` (`local`, `external`, `webhook`, `token`) and an
  allowlist (`allow`) plus a confirm-list (`confirm`). A request names its source
  with `--as <source>` (wire field `caller`); when omitted it is attributed to
  the trusted first-party local source — the capability token already proves a
  same-user local caller.
- **Safe defaults**: unknown sources are denied; external/webhook/token sources
  cannot mutate terminal state unless a capability is explicitly allowlisted;
  output/captured-line reads require explicit opt-in; an unlisted _mutation_ by a
  local source defaults to **confirm**.

Decisions are **no-inference**: they depend only on the explicit caller,
capability, and target — never on terminal output, captured lines, process
names, branch names, paths, or idle time.

### Built-in sources

| Source                | Kind     | May…                                           |
| --------------------- | -------- | ---------------------------------------------- |
| `local-cli` (default) | local    | every implemented capability, no confirmation. |
| `local-prompt`        | local    | read freely; **confirm** every mutation.       |
| `trusted-automation`  | webhook  | `tabs:spawn` and `state:set` only.             |
| `readonly-external`   | external | `tabs:list` only; no mutation, no output read. |

These built-ins are all subsets of `local-cli`, so claiming one via `--as` only
_reduces_ a caller's privileges. Credential-bound external/webhook sources that
are _more_ privileged than the default — and the secure key storage and rotation
they require — are explicit follow-up work.

### Confirmation

When the policy returns **confirm**, the response is `ok:false` with code
`confirmation_required` and a human-readable prompt that names the source, the
requested action, the target, and the consequence. Re-send the request with
`--confirm` (wire field `confirm: true`) to approve it. A source configured with
`once_per_source` is prompted only on its first use of a capability for the
lifetime of the app/control session.

### Diagnostics

`policy check` evaluates a `(source, capability, target)` and reports the
decision **without performing any action** — useful for debugging an
integration's permissions:

```bash
maxx +control policy check --as readonly-external --capability tabs:close
maxx +control policy check --as readonly-external --capability output:read
maxx +control policy check --capability tabs:spawn   # the default local source
```

Every allow/deny/confirm decision (including `policy check`) is written to the
unified log under the `ControlPolicy` category with the source, capability,
target, and reason — never the request params.

Metadata writes are gated by `metadata:set`: `sessions.set-metadata`,
`sessions.remove-metadata`, `sessions.clear-metadata`, and a metadata-only
`sessions.update` all require it. A `sessions.update` that also sets `status` is
gated by `state:set` instead (status is the same state field `declare-state`
writes and `wait --state` matches; it is the stronger gate when both are
present), so neither field is a way around the other's capability.

**Create-time metadata is the deliberate exception.** A `metadata` object passed
to `sessions.create` rides under `tabs:spawn`, **not** `metadata:set`. It is part
of the atomic spawn request — an explicit caller declaration captured as the tab
is created (e.g. a connector attaching `connector.*` provenance) — not the
post-create agent-metadata write surface that `metadata:set` gates. So a webhook
source allowed to `tabs:spawn` but not `metadata:set` can still stamp provenance
at create time, yet cannot mutate metadata afterward. The metadata is still
validated and stored verbatim; it arrives in the `watch` snapshot rather than as
a separate audit entry.

## CLI

The `ghostty`/`maxx` binary ships a `+control` action that handles the token and
socket for you:

```bash
maxx +control sessions create \
  --title "Run release checks" \
  --cwd /path/to/repo \
  --command "zig build test -Dtest-filter=release" \
  --metadata workflow=release-checks \
  --metadata request_id=abc123

maxx +control sessions get <session_id>
maxx +control sessions list
maxx +control sessions update <session_id> --status waiting_for_review
maxx +control sessions action <session_id> --action focus
maxx +control sessions action <session_id> --action input --input $'echo hi\n'
maxx +control sessions cancel <session_id>
```

### Lifecycle control (`maxxctl` half)

```bash
maxx +control sessions wait <session_id> --state tests:passed --timeout 5m
maxx +control sessions wait <session_id> --event pr.merged --timeout 30s --since 12
maxx +control sessions wait <session_id> --lifecycle exited --timeout 10m
maxx +control sessions watch <session_id> --json
maxx +control sessions action <session_id> --action interrupt --signal SIGTERM
maxx +control sessions archive <session_id> --reason "run complete"
maxx +control sessions restart <session_id> --last-command
maxx +control sessions restart <session_id> --command "zig build test"
maxx +control sessions events <session_id> --since 0
```

### Agent declarations (`maxx-agent-hook` half)

```bash
maxx +control sessions declare-state <session_id> --state tests:passed --message "all green" --source ci-agent
maxx +control sessions emit-event <session_id> --event pr.opened --payload-json '{"pr":123}'
```

### Agent-reported metadata

Namespaced key → arbitrary JSON value an agent attaches to a session. Maxx
stores, displays (a metadata chip on the tab), and filters it verbatim, and
never interprets a key as workflow state.

```bash
# Set/merge one key (string value, or a structured value via --value-json).
maxx +control sessions set-metadata <session_id> --key linear.issue --value MAX-4
maxx +control sessions set-metadata <session_id> --key pr.url --value https://github.com/org/repo/pull/456
maxx +control sessions set-metadata <session_id> --key cleanup.command --value 'git worktree remove ../wt'
maxx +control sessions set-metadata <session_id> --key run --value-json '{"id":"run_abc","attempts":[1,2]}'

# Merge several string keys at once via create/update.
maxx +control sessions update <session_id> --metadata repo=org/repo --metadata branch=codex/agent-metadata-api

# Remove one or more keys, or clear them all.
maxx +control sessions remove-metadata <session_id> --key branch --key run
maxx +control sessions clear-metadata <session_id>

# List only sessions whose metadata matches every filter (key present, or key=value).
maxx +control sessions list --filter repo=org/repo --filter linear.issue
```

### Agent-declared workflow state (displayed)

A small, validated workflow state an agent declares for **human-facing display**:
Maxx shows it as a badge on the tab and a one-line summary. This is distinct from
the free-form `declare-state` above (machine coordination for `wait`) and from
the Maxx-owned `lifecycle` (process liveness).

```bash
maxx +control sessions set-state <session_id> --state running
maxx +control sessions set-state <session_id> --state needsInput --source release-agent
maxx +control sessions set-state <session_id> --state blocked
maxx +control sessions set-state <session_id> --state complete
maxx +control sessions set-state <session_id> --state failed
maxx +control sessions set-summary <session_id> --summary "Waiting on user confirmation for release notes wording."
```

`set-state` accepts exactly one of `running`, `needsInput`, `blocked`,
`complete`, or `failed`; any other value is rejected with `invalid_request` and
the current declared state is left unchanged. `set-summary` is independent of
`set-state`, so an agent can update the displayed text without changing status.
Both record an audit entry and are surfaced in `get` / `list` / `watch`.

### Agent type and parent (persisted)

An agent declares its type explicitly; Maxx stores it verbatim and persists it
across restarts (MAX-5). A session can also be created under an explicit parent.

```bash
maxx +control sessions set-agent-type <session_id> --agent-type claude-code
maxx +control sessions create --command "zig build test" --agent-type codex
maxx +control sessions create --command "zig build" --parent <parent_session_id>
```

`--agent-type` is validated as an opaque token (Maxx never derives meaning from
its text) and recorded with a source and timestamp. `--parent` must reference a
known `session_id`; the persisted edge is mechanical, never inferred.

### Structured event stream (`stream` / `event`)

A **cross-resource, cursor-addressed event bus** for supervisor agents. Where
`sessions watch`/`wait` follow one session, `stream watch`/`wait` follow tab,
session, and group activity together, with a process-wide monotonic cursor so a
supervisor can resume after a dropped connection (and is told, via a `reset`,
when its cursor predates what Maxx still retains). Maxx emits its own
mechanical lifecycle events (create/focus/close/process-exit and group
membership changes); agents declare workflow-relevant events explicitly. Maxx
never infers either.

```bash
# Group sessions for coordination (also accepted as `sessions create --group`).
maxx +control sessions set-group <session_id> --group release
maxx +control sessions set-group <session_id>            # (no --group) leaves the group

# Stream every event as newline-delimited JSON, filtered and resumable.
maxx +control stream watch
maxx +control stream watch --group release
maxx +control stream watch --session <session_id>
maxx +control stream watch --tab <surface_id>
maxx +control stream watch --since <cursor> --timeout 10m

# Block until a specific event is observed on the stream (optionally filtered).
maxx +control stream wait --group release --event deploy.done --timeout 30m
maxx +control stream wait --session <session_id> --event tests.green

# Block until every member of a group satisfies a condition.
maxx +control stream wait --group release --all exited
maxx +control stream wait --group release --all idle
maxx +control stream wait --group release --all declared:complete

# Declare a structured event (shorthand for `sessions emit-event`).
maxx +control event emit --session <session_id> --type declared.status --json '{"step":3,"of":7}'
```

All of these are subject to the capability policy above: `stream watch` /
`stream wait` are gated by `tabs:list` (the same read capability as observing
sessions), enforced before the long-lived stream begins; `sessions set-group`
and `sessions create --group` are gated by `groups:create` (a `create --group`
needs both `tabs:spawn` and `groups:create`); and `event emit` is gated by
`state:set` like the other declaration verbs. A `--as <source>` / `--confirm`
applies to these exactly as to any other request.

`stream watch` first prints a `hello` line carrying the current `cursor` and the
envelope `schema`, then one `{"type":"event","event":{…}}` line per matching
event, and a final `{"type":"end"}` when a single-session filter's session ends
(otherwise it runs until `--timeout` or the caller disconnects). `--since
<cursor>` replays retained events after that cursor; if the cursor predates the
retained window the `hello` line carries `"reset": true` and `"dropped_through":
<cursor>` so the supervisor knows a gap occurred rather than silently missing it.

`stream wait` prints one response whose `result.outcome` is `matched`, `timeout`,
or `ended`; on a `--event` match it also carries the `stream_event` envelope, and
on a `--group --all` match the satisfying member `sessions`. `--all` takes
`idle`, `exited`, or `declared:<state>`:

- `exited` — every member's Maxx-owned `lifecycle` has left `running`
  (`exited`/`closed`/`archived`). Purely mechanical.
- `declared:<state>` — every member's agent-declared `workflow_state` equals
  `<state>` (one of `running`/`needsInput`/`blocked`/`complete`/`failed`).
- `idle` — no member is currently declared `running`. A member that declared any
  non-running state, or has not declared one, counts as idle; only an explicit
  `running` declaration is "busy". This is defined entirely on explicit
  declarations — Maxx never guesses idleness from output or timing.

The raw JSON response is printed to stdout. Exit codes are stable so scripts can
branch on them:

| Exit | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| `0`  | Success, or `wait` observed its condition (`matched`).            |
| `1`  | Generic error (transport, usage, validation).                     |
| `2`  | `wait` timed out before the condition held.                       |
| `3`  | Missing target — no session with that id (`not_found`).           |
| `4`  | `wait` target ended (session became terminal) before matching.    |
| `5`  | Unsupported operation for this session (e.g. nothing to restart). |
| `6`  | Confirmation required — re-send with `--confirm` to approve.      |

`wait` blocks until its condition holds, then prints a single response whose
`result.outcome` is `matched`, `timeout`, or `ended`. `watch` streams one JSON
object per line (`snapshot`, then `event` / `lifecycle`, then a final `end`)
until the session ends or the caller disconnects; pass `--timeout` to cap it.
Durations accept `ms`/`s`/`m`/`h` suffixes (a bare number is seconds).

> A flag value that begins with `+` must use the `--flag=value` form
> (e.g. `--command=+foo`); the space-separated form is intercepted by Maxx's
> `+action` CLI detection. The socket protocol (and the Python client below) has
> no such restriction.

## Methods

The `method` field mirrors the proposed REST shape:

| Method                     | REST equivalent                                | Purpose                                                                             |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `sessions.create`          | `POST /control/v1/sessions`                    | Create a tab/session from explicit inputs.                                          |
| `sessions.get`             | `GET /control/v1/sessions/{id}`                | Explicit lifecycle state + declared metadata.                                       |
| `sessions.list`            | `GET /control/v1/sessions`                     | List API-created sessions; optional `metadata_filter`.                              |
| `sessions.update`          | `PATCH /control/v1/sessions/{id}`              | Update caller-owned `status`/`metadata` only (metadata merges).                     |
| `sessions.action`          | `POST /control/v1/sessions/{id}/actions`       | `focus`, `input`, `interrupt` (`signal`), `cancel`, `close`.                        |
| `sessions.wait`            | `GET /control/v1/sessions/{id}/wait`           | Block on a state/event/lifecycle until matched or timeout.                          |
| `sessions.watch`           | `GET /control/v1/sessions/{id}/events`         | Stream lifecycle/event changes (newline-delimited).                                 |
| `sessions.archive`         | `POST /control/v1/sessions/{id}/archive`       | Close the surface, retain the record.                                               |
| `sessions.restart`         | `POST /control/v1/sessions/{id}/restart`       | Replay the recorded/supplied command in a fresh surface.                            |
| `sessions.events`          | `GET /control/v1/sessions/{id}/log`            | Read the audit log (declared states/events + lifecycle).                            |
| `sessions.declare-state`   | `PUT /control/v1/sessions/{id}/state`          | Agent declares a lifecycle state (audited).                                         |
| `sessions.emit-event`      | `POST /control/v1/sessions/{id}/emit`          | Agent emits a named event with optional JSON payload.                               |
| `sessions.set-metadata`    | `PUT /control/v1/sessions/{id}/meta`           | Agent sets/merges one metadata key (`value` or `value_json`).                       |
| `sessions.remove-metadata` | `DELETE /control/v1/sessions/{id}/meta`        | Agent removes one or more metadata keys (`key`/`keys`).                             |
| `sessions.clear-metadata`  | `DELETE /control/v1/sessions/{id}/meta`        | Agent clears all metadata for the session.                                          |
| `sessions.set-state`       | `PUT /control/v1/sessions/{id}/workflow-state` | Agent declares a validated workflow state for display.                              |
| `sessions.set-summary`     | `PUT /control/v1/sessions/{id}/summary`        | Agent sets the human-readable summary shown with the state.                         |
| `sessions.set-agent-type`  | `PUT /control/v1/sessions/{id}/agent-type`     | Agent declares its type (e.g. `claude-code`); persisted, never inferred.            |
| `sessions.set-group`       | `PUT /control/v1/sessions/{id}/group`          | Set/clear group membership (Maxx-owned membership event).                           |
| `stream.watch`             | `GET /control/v1/stream`                       | Stream the cross-resource event bus (filtered, resumable).                          |
| `stream.wait`              | `GET /control/v1/stream/wait`                  | Block on a stream event or a group-wide condition.                                  |
| `policy.check`             | `GET /control/v1/policy/check`                 | Evaluate a (source, capability, target); report allow/deny/confirm, no side effect. |

### Audit entries

`declare-state`, `emit-event`, the metadata mutations (`set-metadata` /
`remove-metadata` / `clear-metadata`, and the metadata merge in `update`),
`set-state`, and `set-summary` append to a
per-session, append-only audit log. Each entry is fully auditable and
carries a monotonic `seq`, a `kind` (`state` / `event` / `metadata` /
`workflow-state` / `summary`, plus `lifecycle` for the `archive` / `restart`
actions Maxx records itself), the declared `name` (the affected metadata key, or
`*` for a clear; a metadata removal/clear also carries `message`
`removed`/`cleared`), the
`source` (agent-supplied, or `maxx` for runtime entries), the `created_at`
timestamp, the `session_id` and `surface_id`, and the foreground `pid` observed
at record time. `wait`, `watch`, and `events` all read from this one log — never
from terminal output.

### Request

```json
{
  "token": "<capability token>",
  "method": "sessions.create",
  "params": {
    "title": "Run release checks",
    "cwd": "/path/to/repo",
    "command": "zig build test",
    "env": ["CI=1"],
    "metadata": { "workflow": "release-checks", "request_id": "abc123" },
    "status": "created",
    "location": "tab"
  }
}
```

### Response

```json
{
  "ok": true,
  "result": {
    "session": {
      "session_id": "2B0E…",
      "surface_id": "9F1C…",
      "title": "Run release checks",
      "command": "zig build test",
      "cwd": "/path/to/repo",
      "status": "created",
      "lifecycle": "running",
      "metadata": { "workflow": "release-checks", "request_id": "abc123" },
      "created_at": "2026-06-14T12:00:00Z",
      "pid": 41234
    }
  }
}
```

Errors are predictable and documented:

```json
{
  "ok": false,
  "error": { "code": "not_found", "message": "no session with id …" }
}
```

| Code                    | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `invalid_request`       | Malformed input, bad limits, or a disallowed update field.                |
| `unauthorized`          | Missing/wrong token, or the policy denied this capability for the source. |
| `confirmation_required` | The policy requires confirmation; re-send with `confirm: true`.           |
| `not_found`             | No API-created session with that id.                                      |
| `already_ended`         | The session was canceled or its surface no longer exists.                 |
| `unsupported_action`    | Unknown action name.                                                      |
| `unsupported`           | Operation not supported for this session (e.g. no command to restart).    |
| `internal`              | Unexpected server-side failure.                                           |

## Identifiers & ownership

- `session_id` is a **stable UUID** minted per session, distinct from the surface
  UUID, the UI title, the PID, the working directory, the branch, or the command
  text. Use it for all later operations.
- `surface_id` is the underlying terminal surface; exposed for correlation only.
- `status` and `metadata` are **caller/agent-owned**. `lifecycle` is **Maxx-owned**.
  `metadata` is an **agent-reported** map of namespaced keys → arbitrary JSON
  values (see [Agent-reported metadata](#agent-reported-metadata)); Maxx stores,
  displays, and filters it verbatim and never reads a key as workflow state.
- `workflow_state` and `summary` are **agent-declared for display** (`set-state` /
  `set-summary`): Maxx records and shows them verbatim and never infers them.
  They are intentionally separate from the free-form `status`, and from the
  Maxx-owned `lifecycle`, so the UI presents them as agent-provided rather than
  Maxx-derived. `workflow_state` is one of `running`, `needsInput`, `blocked`,
  `complete`, `failed`; the response also carries `workflow_state_at` /
  `workflow_state_source` and `summary_at` / `summary_source`.
- `group` is an optional, caller-supplied **group label** for supervisor
  coordination (`set-group`, or `create --group`). It is an opaque token (no
  meaning is inferred from its text); a session belongs to at most one group at a
  time, and membership changes are recorded as Maxx-owned stream events.
- The API only ever lists/controls **API-created** sessions. The user's
  manually-opened terminals are never reachable through it.

### Limits

- `title` ≤ 256 chars, `status` ≤ 128 chars, `command` ≤ 4096 chars.
- `metadata`: ≤ 32 keys; keys match `[A-Za-z0-9_.-]` and ≤ 64 chars; each value's
  serialized (compact JSON) size ≤ 2048 bytes and the whole map ≤ 16384 bytes.
  Values may be any JSON (string, number, bool, null, array, object). JSON
  integers are preserved exactly across the full `Int64` range (so external ids,
  timestamps, and run numbers never lose precision); fractional numbers use
  IEEE-754 double precision.
- `env`: ≤ 256 `KEY=VALUE` entries; keys match `[A-Za-z0-9_]`.
- `summary` (`set-summary`) ≤ 1024 chars; `set-state` accepts only the fixed
  workflow vocabulary above.

`sessions.update` uses **merge** semantics for metadata (provided keys overwrite
or add) and only accepts `status`/`metadata` — any attempt to set server-owned
fields is rejected with `invalid_request`. `sessions.action cancel`/`close` is
**idempotent**.

## Agent-reported metadata

`metadata` is a generic, agent-owned store: a map of **namespaced keys** to
**arbitrary JSON values** an agent or orchestrator attaches to a session so Maxx
can store, display, and filter it — without inferring any of it. Maxx does not
scrape terminal output, parse process names, or read branch names/paths/idle
time to populate it; every entry comes from an explicit API call. No key is
treated as authoritative workflow state, and unknown keys round-trip verbatim
with no normalization, so new keys need no app change to appear in `get` / `list`
/ `watch` and in the metadata chip on the tab.

Representative keys: `linear.issue`, `pr.url`, `repo`, `branch`, `run.id`,
`cleanup.command` — but any `[A-Za-z0-9_.-]` key is accepted.

Operations:

- **Set / merge** — `set-metadata` sets one key (`value` for a plain string, or
  `value_json` for a structured value); `create` / `update` accept a whole
  `metadata` object and merge it (provided keys overwrite or add).
- **Remove** — `remove-metadata` drops the keys named by `key` and/or `keys`
  (absent keys are ignored; at least one key must be named).
- **Clear** — `clear-metadata` removes the entire map in one atomic step.
- **Read** — `get` / `list` / `watch` echo the full map verbatim.
- **Filter** — `list` accepts `metadata_filter`, an array of `{key, value?}`
  constraints that all must hold (AND). A `key`-only constraint requires the key
  to be present; a `key` + `value` constraint requires the value to equal it,
  compared as a string (a bare string compares as itself; other values as their
  compact JSON, e.g. `3`, `true`, `[1,2]`).

Every post-create metadata mutation records a `metadata`-kind audit entry per
affected key — `set-metadata`, the per-key merges from `update`,
`remove-metadata` (each carries `message` `removed`), and `clear-metadata` (one
entry, `name` `*`, `message` `cleared`) — so a `watch`/`events` consumer observes
the change no matter which verb made it. (Metadata supplied at `create` time
arrives in the `watch` snapshot instead.) Each mutation also pushes the updated
map to the live surface atomically, so the UI/filtering never observe a
partially-applied change.

**Persistence.** Metadata is scoped to the **session record's lifetime** in the
registry. It survives `archive` and `restart` (a restart keeps the stable
`session_id`, so the reported metadata stays attached — unlike the per-run
`workflow_state` / `summary` badge, which a restart clears). It is removed only
by an explicit `remove-metadata` / `clear-metadata`, or when the session record
itself is gone. There is no separate session export/restore mechanism, so no
stale metadata is ever restored from a previous run.

## Lifecycle, wait, watch, archive, restart

- `wait` takes **exactly one** of `--state`, `--event`, or `--lifecycle`.
  `--state` is **level-triggered**: it matches the session's _current_ declared
  state (the `status` field, also settable via `update`/`create`), so it returns
  immediately if the session is already in that state. `--event` is
  **edge-triggered**: it matches a newly emitted event, excluding entries already
  present when the wait begins (pass `--since <seq>` to anchor the baseline to a
  sequence you already observed). `--lifecycle` matches a Maxx-owned lifecycle
  value. The default timeout is 30s, capped at 1h. Note `restart` keeps the
  caller-owned `status`, so re-declare or use an event to observe a fresh run.
- `watch` first emits a `snapshot`, then an `event` line per new audit entry and
  a `lifecycle` line per Maxx-owned transition, ending with a final `end` line.
  It runs until the session reaches a terminal lifecycle, the optional
  `--timeout` elapses, or the caller disconnects.
- `archive` closes the surface but keeps the record (and its full audit log)
  retrievable via `get` / `list` / `events`; lifecycle becomes `archived`. It is
  idempotent.
- `restart` replays the session's recorded command (or a `--command` you supply)
  in a fresh surface while keeping the stable `session_id`, increments
  `restart_count`, and revives an archived/closed session. A session created with
  no command and no supplied command returns `unsupported`. A restart begins a
  fresh run, so it clears the agent-declared `workflow_state`/`summary` (the new
  surface starts with no badge; re-declare for the new run); the free-form
  `status` is kept.
- `interrupt` sends Ctrl-C through the tty by default; `--signal <name>` delivers
  a specific signal (`SIGINT`/`SIGTERM`/`SIGKILL`/`SIGHUP`/`SIGQUIT`) to the
  foreground process via the explicit process-control path — never by
  synthesizing terminal input.

## The persistent session registry (MAX-5)

The session registry is durable: it survives an app restart so Maxx keeps a
mechanical view of sessions and the facts agents declared on them. This persists
the registry; it does **not** persist or revive the terminal processes, which die
with the app.

**What is persisted.** Each record stores its stable `session_id` and
`surface_id`, the optional `parent_id` (a persisted parent association), `group`,
the declared `agent_type`, `title`, `command`, `cwd`, caller-owned `status`, the
agent-reported `metadata`, the agent-declared `workflow_state` / `summary` (with
their sources/timestamps), the mechanical lifecycle flags (`archived`,
`restart_count`, last-observed lifecycle), the audit log, and the
`created_at` / `updated_at` / `last_seen_at` timestamps. `updated_at` is bumped on
any change; `last_seen_at` is the last time Maxx mechanically observed the
surface still existing (used for retention).

**Where.** A single versioned JSON document, `registry.json`, in the same
per-user control directory as the socket and token (honoring `MAXX_CONTROL_DIR`),
written `0600` inside the `0700` directory — the registry can carry
agent-declared metadata, so it gets the same private-to-the-user hardening. It
survives an app restart and is cleared on reboot along with the rest of the
runtime directory (no live session survives a reboot either). Writes are atomic
(temp file + rename) and happen on every mutation, plus a flush on app
termination.

**Read safety.** The control directory lives in world-writable `/tmp`, so the
registry is read **only after** the server validates that directory as ours, a
real directory (not a symlink), and `0700` with no group/other access — the same
check that gates the token and socket. The registry is loaded after that check,
never in a constructor that runs before it, so a file another local user planted
in an insecure directory is never decoded. The read is also size-capped (16 MiB,
far above any retention-bounded registry) so a corrupt or oversized file is
skipped rather than slurped whole at launch. Writes are gated symmetrically: the
registry persists nothing until that post-validation load has run, so a flush on
a startup that refused the directory (an insecure/symlinked `MAXX_CONTROL_DIR`)
cannot write a snapshot into — or clobber a registry in — the refused directory.

**Restart rehydration.** On launch the registry loads its records. A restored
record is **detached** from any live surface: it reads as `closed` with no `pid`
and is flagged `restored: true` (a mechanical fact about this run, not an
inference about the work). The detachment is a safety boundary — with macOS
window restoration a freshly rebuilt, user-owned surface can reuse a persisted
`surface_id`, and the control API must never adopt, observe, signal, or close a
surface it did not create this run — so a restored record resolves no surface and
its actions return `already_ended` until it is restarted. A restored record is
fully listable/readable via `get` / `list` / `events`, and — because its
`command` is persisted — is `restart`-able: a restart spawns a fresh surface,
revives the record (`restored`
clears, lifecycle returns to `running`), and increments `restart_count`.

**Declared fields.** `agent_type` is an explicit agent self-declaration
(`set-agent-type`, or `--agent-type` at `create`), stored verbatim like all
declared facts and never inferred from the command, process name, branch, path, or
title. `parent` is supplied at `create` time as a known `session_id`; the edge is
verified (`not_found` for an unknown id, `invalid_request` for a non-UUID) and
persisted, but never inferred from naming or spawn order. Both `set-agent-type`
and a `--group`/`--parent` association are gated by the same capabilities as the
other declaration/group verbs (`state:set` and `groups:create`). The
`groups:create` check runs **before** the parent id is resolved, so a caller that
lacks it gets `unauthorized` whether or not the id exists — the parent lookup
never becomes a session-existence oracle.

**Retention.** Deterministic and bounded so the file cannot grow without limit.
The age cutoff retires only records observed **terminal** (closed or archived):
a record older than 14 days (by `max(updated_at, last_seen_at)`) is dropped, but
a record that may still be live (last-observed lifecycle `running`/`exited`) is
never aged out, since its `last_seen_at` can lag during a long idle stretch and
dropping it would lose a still-existing tab's record. A count cap (newest 500) is
a hard backstop applied to everything. The same policy runs on save and on load.

**No inference on load.** Rehydration replays exactly what was stored and nothing
more. A record whose mechanical fields (command, cwd, title) happen to read like
completion signals never comes back with a guessed `workflow_state`, `summary`, or
`agent_type` — only explicitly declared facts survive, verbatim. See
[`no-inference.md`](no-inference.md).

## The structured event stream contract (MAX-7)

Maxx is the **visible terminal-native runtime/control plane, not the workflow
brain.** The event stream reflects that split exactly: Maxx emits the mechanical
runtime facts it owns, agents declare the workflow facts they own, and the
envelope tags every event with which is which (`source_kind`). A supervisor
composes coordination from these explicit events and never has to scrape terminal
output, match process or branch names, or time idle gaps.

### The event bus

Every event is appended to an in-memory, append-only bus with a **process-wide
monotonic `cursor`** (starting at 1; stable for the run, never reused, survives
session restarts). The bus is bounded (default 10,000 events) with oldest-first
eviction; a `--since` cursor that predates the retained window is reported as a
retention miss (`reset`/`dropped_through`) rather than silently skipped. The bus
is a **superset** of the per-session audit logs: every per-session audit entry
appears on it, plus the Maxx-owned mechanical events below that have no
per-session entry. Durable history is intentionally out of scope for v1, but the
cursor contract does not preclude adding it later. The cursor is in-memory and
resets when the Maxx app restarts (the bus is not persisted); a `--since` from a
previous run is therefore beyond the current cursor and is reported as a `reset`
(the stream replays what it retains rather than blocking past the stale cursor).

### The envelope

Each `stream.watch` `event` message and each `stream.wait --event` match carries
a schema-versioned envelope:

```json
{
  "schema": 1,
  "cursor": 42,
  "seq": 3,
  "source_kind": "agent",
  "kind": "event",
  "name": "deploy.done",
  "source": "release-agent",
  "message": null,
  "payload": { "version": "1.4.0" },
  "created_at": "2026-06-14T12:00:00Z",
  "resource_kind": "session",
  "session_id": "2B0E…",
  "surface_id": "9F1C…",
  "group": "release",
  "pid": 41234
}
```

- `schema` — envelope version; bump only on an incompatible change. Pin the
  version you understand.
- `cursor` — global position; pass back as `--since` to resume.
- `seq` — the per-session audit sequence when the event is also in a session's
  audit log; omitted for bus-only mechanical events.
- `source_kind` — `maxx` (a mechanical runtime fact Maxx owns) or `agent` (a fact
  an agent declared). The load-bearing ownership tag.
- `kind` — `lifecycle` for Maxx-owned events; `state`/`event`/`metadata`/
  `workflow-state`/`summary` for agent-declared ones.
- `resource_kind` — currently always `session`; reserved so future tab-/group-
  scoped events stay additive.
- `group` — the group this event pertains to (the session's current group, or the
  affected group for `group.joined`/`group.left`); omitted when none.

**Post-create** metadata mutations — `set-metadata`, `remove-metadata`,
`clear-metadata`, and the metadata merge in `sessions.update` — flow onto this
stream as `kind: metadata` events that carry the affected key in `name` and reuse
the generic `message`/`payload` fields. The envelope adds no
metadata-value-specific fields, so it stays uniform and workflow-neutral: a
supervisor learns _which_ key changed from the stream and reads the full map
verbatim via `get` / `list` / `watch`.

**Create-time metadata does not produce a stream event.** A `metadata` object
supplied to `sessions.create` is stored on the session and pushed to the surface,
but the only events a create emits are the mechanical `created` (and optional
`group.joined`) below — there is no `kind: metadata` event for it. So a
supervisor must not `stream.watch`/`stream.wait` for a create-time `connector.*`
metadata event: that metadata is available immediately from the create response,
`sessions.get`, `sessions.list`, and the per-session `watch` snapshot, while a
grouped connector launch is observed on the stream via `created` + `group.joined`.

### Events Maxx owns (`source_kind: maxx`, `kind: lifecycle`)

| `name`         | When                                                          |
| -------------- | ------------------------------------------------------------- |
| `created`      | A session/tab was created (its command, if any, was started). |
| `focused`      | A session was focused via the API.                            |
| `closed`       | A session was canceled/closed, or its surface vanished.       |
| `exited`       | The session's child process exited (kernel-reported).         |
| `archived`     | A session was archived.                                       |
| `restarted`    | A session's command was restarted in a fresh surface.         |
| `group.joined` | A session joined a group (`message`/`group` name the group).  |
| `group.left`   | A session left a group.                                       |

These derive only from explicit API actions and kernel-reported process/surface
state — never from terminal output, process names, branch names, paths, tab
titles, prompts, or idle time. `created` covers command start; `exited` covers
command/process exit. Process-exit and surface-vanished events are reconciled
when the stream (or a `get`/`list`/`events` read) next observes the kernel state.

### Events agents own (`source_kind: agent`)

`declare-state`, `emit-event`, `set-metadata`, `set-state`, and `set-summary`
(see above) flow onto the stream verbatim. Maxx validates the envelope (name
characters, payload is well-formed JSON within the size limit, source length) and
routes it, but assigns no meaning to the agent's `type`/`payload`.

### Example supervisor flow

A supervisor launches a batch of jobs as a group, follows progress without
reading any terminal text, and blocks until they all finish:

```bash
G=release-2026-06-14
for repo in a b c; do
  id=$(maxx +control sessions create --command "./ci.sh $repo" --group "$G" \
        | jq -r .result.session.session_id)
  # each job declares its own milestones:
  #   maxx +control event emit --session "$id" --type tests.green
  #   maxx +control sessions set-state "$id" --state complete   (or failed)
done

# Follow everything in the group as structured JSON (resumable via --since):
maxx +control stream watch --group "$G" &

# Block until every job's process has exited, then inspect declared outcomes:
maxx +control stream wait --group "$G" --all exited --timeout 1h
maxx +control sessions list | jq '.result.sessions[] | {id:.session_id, state:.workflow_state}'
```

Nothing here inspects terminal contents: coordination rides entirely on Maxx's
mechanical `exited` events and the agents' explicit `set-state` declarations.

## Not in scope (yet)

- A broad remote-control story. The control channel is local-first by design;
  any remote story must be designed explicitly with its own trust boundaries.
