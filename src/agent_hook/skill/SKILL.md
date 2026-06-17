---
name: maxx-agent
description: Open, manage, and supervise visible tabs in the Maxx terminal. Use when the user asks to open or create a new tab, terminal, session, thread, or window; start another Claude Code or Codex session; inspect, rename, message, or close tabs; or coordinate several child tabs through explicit Control API state, metadata, events, and summaries.
---

<!-- managed by maxx-agent; do not edit (reinstalled from Maxx settings) -->

# Maxx Agent

This session is running inside the Maxx terminal. The `maxx-agent` CLI is on
PATH in Maxx-created terminals and can open visible tabs in the running app.
The returned Control API `session_id` is the primary durable handle for any
follow-up.

This is the no-inference rule: Maxx is the visible terminal-native
runtime/control plane, not the workflow brain. Use only explicit facts: ids,
lifecycle, timestamps, and state/summary/metadata/events declared through the
Control API or hook path. Never derive a child's result by scraping terminal
output, reading process names, tab titles, cwd, branch names, PR URLs, or idle
time. If a status has no explicit declaration, ask the child to declare it or
report the gap.

## Open a Visible Tab

Unless the user names a different command, a new tab starts another session of
the same agent CLI you are running. Always give the tab a short meaningful
title.

```sh
maxx-agent new-tab --title "Claude session" -- claude
maxx-agent new-tab --title "Fix auth bug" -- claude "<prompt>"
maxx-agent new-tab --title "Add CSV export" -- codex --full-auto "<prompt>"
```

For non-agent work, run the command the user asked for:

```sh
maxx-agent new-tab --title "API server" -- npm run dev
```

`new-tab` opens a visible tab in the same window, keeps the parent tab active by
default, starts the user's shell, and runs the command as if typed. Use
`--focus` only when the user explicitly asks to switch to the child tab. With
`--exec`, it runs the command directly. On success it prints JSON:

```json
{
  "tab_id": "...",
  "terminal_id": "...",
  "window_id": "...",
  "session_id": "..."
}
```

Keep `session_id` for durable follow-up:

```sh
maxx +control sessions get <session-id>
maxx +control sessions action <session-id> --action submit --input "status?"
maxx +control sessions wait <session-id> --lifecycle exited --timeout 10m
```

Keep `terminal_id` only for low-level paste/key interactions through
`maxx-agent send`, such as permission menus that need a key press.

Options must come before `--`:

- `--title <name>`: short tab title shown in the tab bar and sidebar.
- `--cwd <dir>`: working directory for the new tab; defaults to the current
  directory.
- `--new-window`: open a new window instead of a tab.
- `--focus`: switch to the child tab/window after creating it; default is to
  leave the parent active.
- `--env KEY=VALUE`: extra environment variable for the new tab; repeatable.
- `--exec`: run the command directly instead of typing it into a shell.
- `--wait`: with `--exec`, keep the tab open after the command exits.

Everything after `--` is passed as plain arguments with no shell
interpretation. For redirects, pipes, or command chains, wrap the command in a
shell:

```sh
maxx-agent new-tab --title "Build log" -- zsh -c 'make 2>&1 | tee build.log'
```

## Permission Modes

Everything after `--` goes to the child CLI verbatim, so set autonomy with that
CLI's own flags:

- Claude Code: `--permission-mode default|plan|acceptEdits|auto|dontAsk|bypassPermissions`
- Codex: `--sandbox read-only|workspace-write|danger-full-access`,
  `--ask-for-approval untrusted|on-failure|on-request|never`, `--full-auto`,
  or `--dangerously-bypass-approvals-and-sandbox`

If the user did not specify a mode, pass no permission flags. Maxx applies the
Settings default for agent-spawned tabs when one is configured. Never pass a
bypass or danger mode unless the user explicitly requested it.

## Manage Existing Tabs

List all windows, tabs, and terminals as JSON:

```sh
maxx-agent list-tabs
```

Each terminal includes ids, foreground process details, and the last
agent-declared activity state when available. Use this for visible tab
management, not for deciding whether work succeeded.

Rename a tab:

```sh
maxx-agent rename-tab <tab-id> <new name>
maxx-agent rename-tab current <new name>
```

Send text to a terminal and press Enter:

```sh
maxx-agent send <terminal-id> <text>
```

Type without submitting:

```sh
maxx-agent send --no-enter <terminal-id> <text>
```

Press a menu/permission key:

```sh
maxx-agent send --key enter <terminal-id>
```

Close a tab only when you created it or the user explicitly asked:

```sh
maxx-agent close-tab <tab-id>
```

## When to Use `sessions create`

Use `maxx-agent new-tab` for normal visible child tab creation. It returns a
`session_id`, works for agent and non-agent commands, and is the simplest path
when you just need a visible tab plus a durable follow-up handle.

Use `maxx +control sessions create` when create-time structure materially
matters:

- set `parent`, `group`, `metadata`, or `agent-type` atomically at spawn time
- deliver untrusted or variable prompt text out of band with `--action submit`
- supervise several children and wait on explicit events or declarations
- restart, archive, or audit sessions through the Control API

Like `new-tab`, `sessions create` leaves the parent active by default. Pass
`--focus` only when the user explicitly asks to switch to the created session.

`sessions create --command` runs in the child's login shell. Do not interpolate
user-provided prompt text into `--command`; shell syntax inside the prompt would
be evaluated. Launch the agent as the command, then submit the task as literal
input.

## Advanced Supervision

Register the parent tab and keep its id:

```sh
parent_session=$(maxx +control sessions register-current \
  | jq -r .result.session.session_id)
```

Create a child with explicit relationships and metadata:

```sh
child=$(maxx +control sessions create \
  --title "Fix parser" \
  --cwd "$PWD" \
  --agent-type codex \
  --parent "$parent_session" \
  --group parser-work \
  --metadata role=worker \
  --metadata task=MAX-123 \
  --command 'codex --full-auto' \
  | jq -r .result.session.session_id)

maxx +control sessions action "$child" --action submit \
  --input 'Fix the parser overflow in src/parse.zig; run the parser tests. When done, declare a summary and state through maxx +control.'
```

Ask children to declare their own status from inside their tab:

```sh
self=$(maxx +control sessions register-current | jq -r .result.session.session_id)
maxx +control sessions set-summary "$self" --summary "Parser overflow fixed; parser tests pass"
maxx +control sessions set-state "$self" --state complete
maxx +control sessions set-metadata "$self" --key linear.issue --value MAX-123
maxx +control sessions emit-event "$self" --event tests.passed --payload-json '{"filter":"parser"}'
```

Watch and wait on explicit facts:

```sh
maxx +control sessions watch "$child" --json
maxx +control sessions wait "$child" --event tests.passed --timeout 30m
maxx +control sessions wait "$child" --lifecycle exited --timeout 1h
maxx +control stream wait --group parser-work --all declared:complete --timeout 1h
```

A mechanical `exited` event does not mean success. Pair it with a declared
`complete` or `failed` state and an agent-authored summary before reporting a
result.

Intervene only on explicit need:

```sh
maxx +control sessions action "$child" --action focus
maxx +control sessions action "$child" --action submit --input "Proceed with option 2."
maxx-agent send --key enter <terminal-id>
```

Synthesize from declared facts:

```sh
maxx +control sessions list --group parser-work \
  | jq '.result.sessions[] | {id:.session_id, state:.workflow_state, summary, metadata, lifecycle}'
maxx +control sessions events "$child"
```

Build your final report from declared `workflow_state`, `summary`, metadata,
events, and mechanical lifecycle. Do not use scrollback, titles, paths, process
names, or idle time as proof.

## Notes

- `maxx-agent` only works inside Maxx terminals because it needs
  `GHOSTTY_AGENT_SURFACE_ID`.
- To target a specific dev build, export `MAXX_CONTROL_DIR` and pass the same
  value to every `maxx +control` call.
- Use this skill only when the user wants a separate visible tab/session or a
  supervised multi-tab workflow. For quick shell commands you can run yourself,
  run them directly.
