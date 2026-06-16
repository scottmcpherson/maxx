---
name: maxx-tabs
description: Open and manage tabs in the Maxx terminal. New tabs default to starting a Claude Code or Codex session, optionally with an initial prompt; existing tabs can be listed (with agent status), renamed, prompted, and closed. Use when the user asks to open or create a new tab, terminal, session, thread, or window (e.g. "open a new tab", "create a tab and have it do …", "start another session/agent to do …"), or to inspect, rename, message, or close tabs/sessions, or to orchestrate work across multiple tabs.
---

<!-- managed by maxx-agent-hook; do not edit (reinstalled from Maxx settings) -->

# Maxx terminal tabs

This session is running inside the Maxx terminal. The `maxx-agent-hook`
CLI (already on PATH in Maxx terminals) can open new tabs in the running
app and run commands in them.

## What to run in the new tab

Unless the user explicitly names a different command, a new tab starts a new
agent session: the same CLI you are running as. "Create a new tab" from a
Claude Code session means a tab running `claude`; from a Codex session it
means a tab running `codex`.

New session with nothing specific to do:

```sh
maxx-agent-hook new-tab --title "Claude session" -- claude
```

New session for a task ("create a tab and have it do …") — pass the task as
the initial prompt, quoted as a single argument:

```sh
maxx-agent-hook new-tab --title "Fix auth bug" -- claude "<prompt>"
```

Add any CLI flags the user asks for (model, permission mode, etc.) before
the prompt. Use `codex` instead when running as Codex or when the user asks
for it.

### Permission mode of the new session

Everything after `--` is passed to the agent CLI verbatim, so set the new
session's autonomy with that CLI's own flags:

- Claude Code: `--permission-mode default|plan|acceptEdits|auto|dontAsk|bypassPermissions`

  ```sh
  maxx-agent-hook new-tab --title "Fix auth bug" -- claude --permission-mode acceptEdits "<prompt>"
  ```

- Codex: `--sandbox read-only|workspace-write|danger-full-access`,
  `--ask-for-approval untrusted|on-failure|on-request|never`, the
  `--full-auto` shorthand (workspace-write + approval on failure), and
  `--dangerously-bypass-approvals-and-sandbox` (no sandbox, no approvals —
  only when the user explicitly asks for it)

  ```sh
  maxx-agent-hook new-tab --title "Add CSV export" -- codex --full-auto "<prompt>"
  ```

Rules:

- If the user names a mode (or says "same mode as this session" and you know
  how this session was launched), pass it through.
- If the user didn't specify one, pass no permission flags. Maxx then
  applies the "Agent tab permission mode" configured in its Settings
  automatically; without that setting the new session gets the agent's
  normal defaults. Explicit flags always win over the setting.
- For unattended workers you will manage yourself, suggest a mode that won't
  stall on approval prompts (Claude Code `--permission-mode acceptEdits`,
  Codex `--full-auto`) — but never pass a bypass/danger mode the user didn't
  explicitly ask for. A stalled worker is recoverable anyway: `list-tabs`
  shows `needsInput` and `send --key enter` answers its prompt.

Run something other than an agent session only when the user explicitly
names it (a plain shell tab, `htop`, a build, a server, …):

```sh
maxx-agent-hook new-tab --title "API server" -- npm run dev
```

## How it works

The new tab opens in the same window, starts the user's shell, and runs the
command as if it had been typed. The tab stays open after the command exits.
On success it prints JSON with the new tab, terminal, and window ids.

Always pass `--title` with a short, meaningful name (2–4 words). Name the
task when there is one ("Fix auth bug", not "Claude session"); fall back to
the session name only for a bare new tab.

Options (must come before `--`):

- `--title <name>`: short name for the new tab, shown in the tab bar and
  sidebar
- `--cwd <dir>`: working directory for the new tab (defaults to the current
  working directory, so omit it to spawn work in the same project)
- `--new-window`: open a new window instead of a tab in the current window
- `--env KEY=VALUE`: extra environment variables (repeatable)
- `--exec`: run the command directly instead of typing it into a shell; the
  tab closes when the command exits unless `--wait` is also given
- `--wait`: with `--exec`, keep the tab open after the command exits

Everything after `--` is passed as plain arguments with no shell
interpretation — a bare `>`, `|`, or `&&` is quoted and loses its meaning.
For redirects, pipes, or command chains, wrap the whole thing in a shell:

```sh
maxx-agent-hook new-tab --title "Build and log" -- zsh -c 'make 2>&1 | tee build.log'
```

## Manage existing tabs

List all windows, tabs, and terminals as JSON:

```sh
maxx-agent-hook list-tabs
```

Each terminal includes its foreground `pid` and `process` (e.g. `claude`,
`codex`, or a shell when the agent has exited), plus an `agent` object with
the last reported activity state when an agent has run there: `running`,
`needsInput`, `error`, or `idle`. Use this to check on sessions you spawned —
`"process": "claude"` with `"state": "needsInput"` means that session is
waiting for input.

Rename a tab (the name shows in the tab bar and sidebar):

```sh
maxx-agent-hook rename-tab <tab-id> <new name>
```

Use `current` as the tab id to rename the tab this session is running in —
e.g. when the user says "rename this tab":

```sh
maxx-agent-hook rename-tab current <new name>
```

(Your own terminal id is `$GHOSTTY_AGENT_SURFACE_ID`; match it against
`list-tabs` terminal ids — case-insensitively — if you ever need to find
your own tab or window explicitly.)

Type a prompt or command into an existing tab's terminal and submit it:

```sh
maxx-agent-hook send <terminal-id> <text>
```

This pastes the text and presses Enter — use it to prompt an agent session
running in another tab, or to run a command in another tab's shell. Pass
`--no-enter` before the terminal id to type without submitting. Give the
session a moment to act, then check on it with `list-tabs`.

Menu and permission prompts inside a session respond to key presses, not
pasted text. To answer them, press keys instead:

```sh
maxx-agent-hook send --key enter <terminal-id>
```

`--key` presses a single named key (`enter`, `arrowUp`, `arrowDown`, `tab`,
`escape`, digits like `digit1`/`digit2`, …) — e.g. `--key enter` confirms
the highlighted option of a permission prompt.

Close a tab:

```sh
maxx-agent-hook close-tab <tab-id>
```

Closing is immediate and does not ask for confirmation — it kills whatever
is running in the tab. Only close tabs you created, or tabs the user
explicitly asked to close.

`new-tab` prints the ids of the tab and terminal it created; keep them when
you plan to manage the tab later, and use `list-tabs` to rediscover them.

## Supervising several child tabs

For more than ad-hoc multi-tab work — fanning a task out across child tabs,
tracking explicit per-child state/metadata, grouping them, and waiting on or
summarizing the group — use the **`maxx-supervisor-workflows`** skill. It drives
the control API (`maxx +control`), which gives each child a stable session id
plus explicit state, metadata, parent/group, and watch/wait primitives. This
skill stays focused on opening and managing individual tabs.

## Notes

- Only works inside Maxx terminals: it requires `GHOSTTY_AGENT_SURFACE_ID`
  in the environment. If that variable is missing, tell the user this only
  works from a Maxx tab.
- Don't use this for quick shell commands you could run yourself; use it when
  the user wants a separate, visible tab or session.
