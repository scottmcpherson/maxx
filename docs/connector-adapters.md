# Maxx Connector Adapter Layer

The connector adapter layer lets configured external trigger sources — starting
with **Linear** and **GitHub** — turn a structured event payload into a visible
Maxx tab launch, while keeping Maxx strictly a terminal-native runtime/control
plane. Maxx owns visible tab orchestration and process launch; it never reasons
about the workflow. The connector layer is the thin, typed seam between an
external system's payload and the [Control API](./control-api.md)'s tab-launch
primitive.

A connector turns _“this event happened in Linear/GitHub”_ into _“open a visible
tab running this command with this context.”_ What that command then **does**
with the context is entirely the launched agent's job (its prompt, skill, or
upstream connector configuration) — never Maxx's.

## The product boundary

- Maxx owns **visible runtime/control-plane** responsibilities: opening a tab,
  launching a process with an explicit command/cwd/env, showing provenance, and
  exposing normal tab controls (review, stop, restart, detach).
- The connector layer only **resolves** an explicit payload into an explicit
  launch request. It assigns no Maxx meaning to an "issue", "pull request",
  "branch", "worktree", or "test" — those are just payload fields to copy.
- Workflow reasoning lives **downstream**, in the launched command.

## No-inference rule

This is the load-bearing constraint, enforced by design and asserted in tests.
An adapter and the resolver MUST NOT:

- infer workflow intent from branch names, file paths, process names, tab
  titles, idle time, or any other incidental signal;
- scrape, regex, or otherwise interpret terminal output;
- attach Maxx domain meaning to source concepts.

An adapter MAY only read fields the payload states **explicitly**. Identifying
which explicit object a payload carries (e.g. GitHub's `pull_request` vs `issue`
key) is structural parsing of the payload's own shape — that is the adapter's
job — not inference of intent from runtime state.

## Pieces

| Piece                        | File                                     | Responsibility                                                         |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `Adapter`                    | `src/connector/Adapter.zig`              | The source-adapter interface.                                          |
| `TriggerEvent`               | `src/connector/Event.zig`                | Normalized, source-agnostic event of explicit fields.                  |
| `Predicate`                  | `src/connector/Predicate.zig`            | Exact checks over explicit event fields before launch side effects.    |
| `LaunchTemplate` / `resolve` | `src/connector/Template.zig`             | Per-connector launch config and its resolution into a `LaunchRequest`. |
| `linear`, `github`           | `src/connector/linear.zig`, `github.zig` | Starter adapters.                                                      |

## The adapter interface

An adapter is a small value:

```zig
pub const adapter: Adapter = .{
    .name = "linear",
    .description = "Linear issue/event webhook payloads",
    .parseFn = parse,
};

fn parse(alloc: Allocator, payload: []const u8) Adapter.Error!TriggerEvent { ... }
```

`parse`'s entire job is to validate the payload shape just enough to copy the
explicit fields a launch needs, assemble the prompt/context by concatenating
those fields, and return a `TriggerEvent`. It raises a clear, typed error on bad
input:

- `InvalidPayload` — not valid JSON, or not a JSON object.
- `MissingField` — a required field was absent or the wrong type.
- `UnsupportedEventType` — the payload isn't one this adapter handles.

### Adding a new source adapter

1. Create `src/connector/<name>.zig` exposing `pub const adapter: Adapter`.
2. Implement `parse` to copy explicit payload fields into a `TriggerEvent`
   (`source`, `id`, `type`, `title`, optional `url`/`prompt`, and extra
   `fields`). Read only what the payload states; never infer.
3. Append it to `adapters` in `src/connector/connector.zig`.
4. Add fixture-based tests (a representative payload, plus negative tests for
   missing required fields and unsupported types).

## TriggerEvent

The normalized event. Every field is an explicit value copied from the payload:

| Field    | Meaning                                                       |
| -------- | ------------------------------------------------------------- |
| `source` | Connector name (`linear`, `github`).                          |
| `id`     | Stable source id for the event (provenance/de-dup).           |
| `type`   | The source's own event/trigger type, verbatim.                |
| `title`  | Human-facing tab title.                                       |
| `url`    | Canonical source URL, when the payload provides one.          |
| `prompt` | Prompt/context text, assembled from explicit fields.          |
| `fields` | Extra explicit string or boolean fields, dotted keys (e.g. `issue.identifier`). |

`lookup` renders fields as strings for template placeholders. Predicate
evaluation uses the typed value, so `equals_bool` only matches a boolean field;
a string value `"true"` is not treated as boolean `true`.

## Built-in adapter fields

The built-in adapters expose these extra fields when the payload explicitly
provides them. Missing or wrong-typed fields stay absent.

| Source   | Field                     | Type    | Source payload field                                      |
| -------- | ------------------------- | ------- | --------------------------------------------------------- |
| `linear` | `action`                  | string  | top-level `action`                                        |
| `linear` | `issue.id`                | string  | `data.id`                                                 |
| `linear` | `issue.identifier`        | string  | `data.identifier`                                         |
| `linear` | `issue.url`               | string  | `data.url`, falling back to top-level `url`               |
| `linear` | `issue.state.id`          | string  | `data.state.id`                                           |
| `linear` | `issue.state.name`        | string  | `data.state.name`                                         |
| `linear` | `issue.state.type`        | string  | `data.state.type`                                         |
| `linear` | `team.key`                | string  | `data.team.key`                                           |
| `github` | `action`                  | string  | top-level `action`                                        |
| `github` | `object.type`             | string  | structural object key: `issue` or `pull_request`          |
| `github` | `repo.full_name`          | string  | `repository.full_name`                                    |
| `github` | `number`                  | string  | object `number`                                           |
| `github` | `issue.number`            | string  | `issue.number` for issue payloads                         |
| `github` | `pull_request.number`     | string  | `pull_request.number` for pull request payloads           |
| `github` | `pull_request.merged`     | boolean | `pull_request.merged`, only when present as a JSON bool    |

These are copied fields, not workflow interpretations. For example, a route may
compare `issue.state.name` to `Todo`, but Maxx does not decide what Todo means.

## Launch templates

A `LaunchTemplate` is the configuration half of a connector — how to turn a
`TriggerEvent` into a visible tab:

| Field             | Meaning                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `command`         | Command to run (required, templated).                                             |
| `cwd`             | Working directory (optional, templated; only when explicitly set).                |
| `title`           | Tab title (optional, templated; defaults to the event title).                     |
| `env`             | Extra `KEY=VALUE` entries (values templated).                                     |
| `prompt_delivery` | `env` (default), `stdin`, or `file`.                                              |
| `caller`          | Policy source identity, emitted as `params.caller` (optional, **not** templated). |
| `group`           | Supervisor group label, emitted as `params.group` (optional, templated).          |

### Placeholders

Templated fields use `${field}` placeholders filled **only** from explicit event
fields: `${source}`, `${id}`, `${type}`, `${title}`, `${url}`, `${prompt}`, plus
any adapter field such as `${issue.identifier}` or `${repo.full_name}`.

- `${name}` is required — a missing/empty value is an error naming the field.
- `${name?}` is optional — a missing value resolves to the empty string.
- A `$` not immediately followed by `{` is a literal dollar sign.

### Prompt delivery

The resolved `prompt` reaches the launched command per `prompt_delivery`:

- `env` — exposed as `MAXX_CONNECTOR_PROMPT`.
- `stdin` — streamed to stdin by the runner.
- `file` — written to a temp file by the runner; its path is passed via
  `MAXX_CONNECTOR_PROMPT_FILE`.

### Caller and group

Two optional fields make a resolved launch complete for an autonomous
webhook-runner flow, so the runner injects **only** the per-call capability
token and never has to splice fields into the JSON:

- **`caller`** — the [capability-policy](./control-api.md#capability-policy)
  source the launch is attributed to (e.g. `trusted-automation`), emitted as
  `params.caller`. Without it, a connector launch runs as the trusted
  first-party local source — usually wrong for a webhook origin, which should
  carry its own narrower identity. The caller is **not templated**: a policy
  source is a fixed deployment decision, never derived from the (potentially
  untrusted) event payload, so a webhook can't choose the identity it runs as.
- **`group`** — a supervisor group label, emitted as `params.group`, so the new
  tab joins a coordination group at create time (no separate `set-group` call,
  no JSON surgery). It **is templated** from explicit event fields — a group is
  an opaque coordination token, so `--group issue-${issue.identifier}` is the
  intended use. A `sessions.create` that sets `group` is gated by the control
  server on **both** `tabs:spawn` and `groups:create`; the group is checked
  before the surface is spawned, so a denied group never leaves a stray tab. A
  group that templates to empty is omitted (matching the server's "empty group
  means no group" rule).

  Mind the interaction between `caller` and `group`: the built-in
  `trusted-automation` source has only `tabs:spawn` and `state:set`, so a
  `--group` launch sent `--as trusted-automation` is **rejected**
  (`unauthorized`, no tab spawned). A grouped webhook launch therefore needs a
  configured policy source granted **both** `tabs:spawn` and `groups:create`
  (the default first-party local source already holds both). See the
  [Control API capability policy](./control-api.md#capability-policy).

## Resolution and provenance

`connector.resolve(alloc, template, event, opts)` substitutes placeholders and
returns a `LaunchRequest`: the concrete `command`, `cwd`, `title`, `env`,
`prompt`/`prompt_delivery`, and connector provenance `metadata`. Provenance uses
reserved, explicit keys shown on the launched tab:

- `connector` — the source name.
- `connector.event_id` — the source event id.
- `connector.event_type` — the source event type.
- `connector.url` — the source URL, when provided.
- `connector.launched_at` — launch timestamp, when the caller supplies one.

`LaunchRequest.writeControlRequest` emits the Control API's
`{ token?, method, params }` request envelope for `sessions.create`, including
`params.caller` and `params.group` when those were configured. The
**token is supplied by the runner** (the per-call capability token it reads from
the control directory); `resolve` runs offline and omits it, and the control
server rejects a tokenless request — so `launch` becomes sendable only once the
runner injects the token. Caller and group, by contrast, are resolved offline
and baked into `params` here, so the runner never edits the JSON to attribute or
group the launch.

For `.env` delivery the prompt rides in `params.env` (`MAXX_CONNECTOR_PROMPT`).
For `.stdin`/`.file` delivery the prompt is **not** in the control request — the
runner delivers it out of band using the resolved `prompt` and `prompt_delivery`.
So `launch` (`params`) alone is not the whole launch; consumers must also read
`prompt`/`prompt_delivery`.

## CLI

```
maxx +connector list
maxx +connector resolve --source linear --command claude \
    --cwd /repo --title '${issue.identifier}: ${title}' \
    --env KEY='${source}' --payload event.json

# Attribute the launch to a webhook policy source (ungrouped).
maxx +connector resolve --source linear --command claude \
    --as trusted-automation --payload event.json

# Group the launch for supervisor coordination. A grouped create needs both
# tabs:spawn AND groups:create; the default local source has both. The built-in
# `trusted-automation` has only tabs:spawn/state:set, so pairing --as
# trusted-automation with --group would be rejected — a grouped webhook launch
# needs a configured source granted both capabilities (see below).
maxx +connector resolve --source linear --command claude \
    --group 'issue-${issue.identifier}' --payload event.json
```

`resolve` reads a payload (from `--payload <file>`, or stdin when omitted/`-`),
parses it with the named adapter, resolves the launch, and prints the **resolve
envelope**: the normalized `event`, the `prompt_delivery` mode, the resolved
`prompt`, and the `launch` (`sessions.create`) control request. A runner
consumes the whole envelope — it injects the capability token into `launch` and,
for `stdin`/`file` delivery, hands the `prompt` to the launched command out of
band. `launch.params` alone is therefore not sufficient.

## The runner

This layer **resolves** a launch; it does not **execute** one. Execution is the
[automation trigger runner](./automation-runner.md) (`maxx +runner`) — kept
separate so the resolution logic stays pure and exhaustively testable. The runner
owns: injecting the per-call capability token into the control request, sending
`sessions.create` to a running Maxx, delivering the prompt for `stdin`/`file`
modes, suppressing duplicates on the explicit event id, and receiving events from
poll/script/webhook-relay triggers. The `resolve` envelope is the complete input
the runner needs: the policy `caller` and supervisor `group` are already resolved
into `params`, so the runner adds only the capability token and the act of
sending.

Fetching payloads over the network (with the associated auth) and the
upstream-relay/webhook-listener transport remain outside both layers — the
runner's contract is local and explicit: it consumes a structured payload, it
does not reach out for one.
