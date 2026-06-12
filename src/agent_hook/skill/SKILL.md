---
name: mosttly-tabs
description: Open a new tab or window in the Mosttly terminal — by default starting a new Claude Code or Codex session in it, optionally with an initial prompt — or run any command there. Use when the user asks to open or create a new tab, terminal, session, thread, or window (e.g. "open a new tab", "create a tab and have it do …", "start another session/agent to do …").
---

<!-- managed by ghostty-agent-hook; do not edit (reinstalled from Mosttly settings) -->

# Mosttly terminal tabs

This session is running inside the Mosttly terminal. The `ghostty-agent-hook`
CLI (already on PATH in Mosttly terminals) can open new tabs in the running
app and run commands in them.

## What to run in the new tab

Unless the user explicitly names a different command, a new tab starts a new
agent session: the same CLI you are running as. "Create a new tab" from a
Claude Code session means a tab running `claude`; from a Codex session it
means a tab running `codex`.

New session with nothing specific to do:

```sh
ghostty-agent-hook new-tab --title "Claude session" -- claude
```

New session for a task ("create a tab and have it do …") — pass the task as
the initial prompt, quoted as a single argument:

```sh
ghostty-agent-hook new-tab --title "Fix auth bug" -- claude "<prompt>"
```

Add any CLI flags the user asks for (model, permission mode, etc.) before
the prompt. Use `codex` instead when running as Codex or when the user asks
for it.

Run something other than an agent session only when the user explicitly
names it (a plain shell tab, `htop`, a build, a server, …):

```sh
ghostty-agent-hook new-tab --title "API server" -- npm run dev
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
ghostty-agent-hook new-tab --title "Build and log" -- zsh -c 'make 2>&1 | tee build.log'
```

## Notes

- Only works inside Mosttly terminals: it requires `GHOSTTY_AGENT_SURFACE_ID`
  in the environment. If that variable is missing, tell the user this only
  works from a Mosttly tab.
- Don't use this for quick shell commands you could run yourself; use it when
  the user wants a separate, visible tab or session.
