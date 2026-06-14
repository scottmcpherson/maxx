# Maxx Control API

The Maxx Control API is a **local, token-authenticated** control surface that
lets trusted scripts, local automation, and webhook runners **outside** an
existing Maxx tab create and manage Maxx tabs/sessions safely.

Maxx is the terminal-native runtime/control plane: it provides explicit,
observable control over terminal tabs and sessions. It is **not** a workflow
brain. External orchestrators decide _what_ should happen and speak to Maxx
through explicit API calls.

## No-inference guarantee

The API never scrapes or regexes terminal output and never guesses workflow
semantics from process names, branch names, paths, idle time, or similar
signals. Every meaningful action comes from an explicit API request and declared
metadata. The only Maxx-owned lifecycle signal is derived from explicit session
state — whether the surface still exists and whether its child process has
exited (a kernel-reported fact) — never from terminal contents.

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

The raw JSON response is printed to stdout; the exit code is `0` on success and
`1` on any error.

> A flag value that begins with `+` must use the `--flag=value` form
> (e.g. `--command=+foo`); the space-separated form is intercepted by Maxx's
> `+action` CLI detection. The socket protocol (and the Python client below) has
> no such restriction.

## Methods

The `method` field mirrors the proposed REST shape:

| Method            | REST equivalent                          | Purpose                                           |
| ----------------- | ---------------------------------------- | ------------------------------------------------- |
| `sessions.create` | `POST /control/v1/sessions`              | Create a tab/session from explicit inputs.        |
| `sessions.get`    | `GET /control/v1/sessions/{id}`          | Explicit lifecycle state + declared metadata.     |
| `sessions.list`   | `GET /control/v1/sessions`               | List API-created sessions.                        |
| `sessions.update` | `PATCH /control/v1/sessions/{id}`        | Update caller-owned `status`/`metadata` only.     |
| `sessions.action` | `POST /control/v1/sessions/{id}/actions` | `focus`, `input`, `interrupt`, `cancel`, `close`. |

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

| Code                 | Meaning                                                    |
| -------------------- | ---------------------------------------------------------- |
| `invalid_request`    | Malformed input, bad limits, or a disallowed update field. |
| `unauthorized`       | Missing or wrong capability token.                         |
| `not_found`          | No API-created session with that id.                       |
| `already_ended`      | The session was canceled or its surface no longer exists.  |
| `unsupported_action` | Unknown action name.                                       |
| `internal`           | Unexpected server-side failure.                            |

## Identifiers & ownership

- `session_id` is a **stable UUID** minted per session, distinct from the surface
  UUID, the UI title, the PID, the working directory, the branch, or the command
  text. Use it for all later operations.
- `surface_id` is the underlying terminal surface; exposed for correlation only.
- `status` and `metadata` are **caller-owned**. `lifecycle` is **Maxx-owned**.
- The API only ever lists/controls **API-created** sessions. The user's
  manually-opened terminals are never reachable through it.

### Limits

- `title` ≤ 256 chars, `status` ≤ 128 chars, `command` ≤ 4096 chars.
- `metadata`: ≤ 32 keys; keys match `[A-Za-z0-9_.-]` and ≤ 64 chars; values ≤
  1024 chars.
- `env`: ≤ 256 `KEY=VALUE` entries; keys match `[A-Za-z0-9_]`.

`sessions.update` uses **merge** semantics for metadata (provided keys overwrite
or add) and only accepts `status`/`metadata` — any attempt to set server-owned
fields is rejected with `invalid_request`. `sessions.action cancel`/`close` is
**idempotent**.

## Not in scope (yet)

- A streaming `GET /control/v1/events` long-poll channel. The create/get/list/
  update/action surface covers the current acceptance criteria.
- A broad remote-control story. The control channel is local-first by design;
  any remote story must be designed explicitly with its own trust boundaries.
