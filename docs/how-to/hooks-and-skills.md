---
layout: doc
title: Claude/Codex Hooks and Skills
description: Configure Maxx's bundled hooks and skills for supported agent CLIs.
permalink: /docs/how-to/hooks-and-skills/
section: how-to
---

# Claude/Codex Hooks and Skills

Maxx ships a `maxx-agent` helper and one bundled skill for Claude Code and
Codex. The skill teaches agents how to call Maxx's local control surface, while
the helper translates explicit agent lifecycle events into sidebar status.

## What Gets Installed

- `maxx-agent`: open, list, rename, prompt, and close visible Maxx tabs, then
  use the returned durable Control API `session_id` for follow-up work.
- Advanced `maxx +control` guidance inside the same skill for coordinating
  groups of child tabs from a parent session.
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

`maxx-agent new-tab` returns a `session_id` handle for the tab it creates,
and the child can expose an explicit answer through `sessions set-result`.
Parents should retrieve that answer with `sessions get <session_id>` and read
`result`, `result_source`, and `result_at`. Workflow state still needs explicit
declarations such as `set-state`, `set-summary`, metadata, or event payloads.

See [the no-inference rule]({{ '/no-inference.html' | relative_url }}) for the
full product constraint.
