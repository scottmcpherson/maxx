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

| Method                     | REST equivalent                                | Purpose                                                         |
| -------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `sessions.create`          | `POST /control/v1/sessions`                    | Create a tab/session from explicit inputs.                     |
| `sessions.get`             | `GET /control/v1/sessions/{id}`                | Explicit lifecycle state + declared metadata.                  |
| `sessions.list`            | `GET /control/v1/sessions`                     | List API-created sessions; optional `metadata_filter`.         |
| `sessions.update`          | `PATCH /control/v1/sessions/{id}`              | Update caller-owned `status`/`metadata` only (metadata merges).|
| `sessions.action`          | `POST /control/v1/sessions/{id}/actions`       | `focus`, `input`, `interrupt` (`signal`), `cancel`, `close`.   |
| `sessions.wait`            | `GET /control/v1/sessions/{id}/wait`           | Block on a state/event/lifecycle until matched or timeout.     |
| `sessions.watch`           | `GET /control/v1/sessions/{id}/events`         | Stream lifecycle/event changes (newline-delimited).            |
| `sessions.archive`         | `POST /control/v1/sessions/{id}/archive`       | Close the surface, retain the record.                          |
| `sessions.restart`         | `POST /control/v1/sessions/{id}/restart`       | Replay the recorded/supplied command in a fresh surface.       |
| `sessions.events`          | `GET /control/v1/sessions/{id}/log`            | Read the audit log (declared states/events + lifecycle).       |
| `sessions.declare-state`   | `PUT /control/v1/sessions/{id}/state`          | Agent declares a lifecycle state (audited).                    |
| `sessions.emit-event`      | `POST /control/v1/sessions/{id}/emit`          | Agent emits a named event with optional JSON payload.          |
| `sessions.set-metadata`    | `PUT /control/v1/sessions/{id}/meta`           | Agent sets/merges one metadata key (`value` or `value_json`).  |
| `sessions.remove-metadata` | `DELETE /control/v1/sessions/{id}/meta`        | Agent removes one or more metadata keys (`key`/`keys`).        |
| `sessions.clear-metadata`  | `DELETE /control/v1/sessions/{id}/meta`        | Agent clears all metadata for the session.                     |
| `sessions.set-state`       | `PUT /control/v1/sessions/{id}/workflow-state` | Agent declares a validated workflow state for display.         |
| `sessions.set-summary`     | `PUT /control/v1/sessions/{id}/summary`        | Agent sets the human-readable summary shown with the state.    |

### Audit entries

`declare-state`, `emit-event`, the metadata verbs (`set-metadata` /
`remove-metadata` / `clear-metadata`), `set-state`, and `set-summary` append to a
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

| Code                 | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `invalid_request`    | Malformed input, bad limits, or a disallowed update field.             |
| `unauthorized`       | Missing or wrong capability token.                                     |
| `not_found`          | No API-created session with that id.                                   |
| `already_ended`      | The session was canceled or its surface no longer exists.              |
| `unsupported_action` | Unknown action name.                                                   |
| `unsupported`        | Operation not supported for this session (e.g. no command to restart). |
| `internal`           | Unexpected server-side failure.                                        |

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
- The API only ever lists/controls **API-created** sessions. The user's
  manually-opened terminals are never reachable through it.

### Limits

- `title` ≤ 256 chars, `status` ≤ 128 chars, `command` ≤ 4096 chars.
- `metadata`: ≤ 32 keys; keys match `[A-Za-z0-9_.-]` and ≤ 64 chars; each value's
  serialized (compact JSON) size ≤ 2048 bytes and the whole map ≤ 16384 bytes.
  Values may be any JSON (string, number, bool, null, array, object).
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

Each set/remove/clear records a `metadata`-kind audit entry (a removal carries
`message` `removed`, a clear uses `name` `*` with `message` `cleared`) and pushes
the updated map to the live surface atomically, so the UI/filtering never observe
a partially-applied change.

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

## Not in scope (yet)

- A broad remote-control story. The control channel is local-first by design;
  any remote story must be designed explicitly with its own trust boundaries.
