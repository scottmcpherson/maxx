---
layout: doc
title: Claude/Codex Hooks and Skills
description: Configure Maxx's bundled hooks and skills for supported agent CLIs.
permalink: /docs/how-to/hooks-and-skills/
section: how-to
---

# Claude/Codex Hooks and Skills

Maxx ships a `maxx-agent-hook` helper and bundled skills for Claude Code and
Codex. The skills teach agents how to call Maxx's local control surface, while
the hook helper translates explicit agent lifecycle events into sidebar status.

## What Gets Installed

- `maxx-tabs`: open, list, rename, prompt, and close visible Maxx tabs. New
  tabs return a durable Control API `session_id` for follow-up work.
- `maxx-supervisor-workflows`: coordinate groups of child tabs from a parent
  session.
- Hook configuration for supported CLIs so Maxx can display agent-declared
  activity state.

Claude Code discovers personal skills under `~/.claude/skills` or
`$CLAUDE_CONFIG_DIR/skills`. Codex discovers user skills under `~/.agents/skills`.
Maxx writes managed skill files with an ownership marker so uninstall can remove
only the files it owns.

## Install from Maxx

Open Maxx Settings and use the Claude Code or Codex install controls. Settings
also expose default permission and sandbox modes for agent-spawned sessions;
explicit CLI flags still take precedence.

## Verify the Boundary

Supported agent status indicators come from explicit hook events, control API
declarations, or terminal-native mechanical facts such as bell/progress escape
sequences. They do not come from scraping terminal output.

`maxx-agent-hook new-tab` returns a `session_id` handle for the tab it creates,
but that handle is only a control/session identity. Child answers and workflow
results still need explicit declarations such as `set-summary`, metadata, or an
event payload.

See [the no-inference rule]({{ '/no-inference.html' | relative_url }}) for the
full product constraint.
