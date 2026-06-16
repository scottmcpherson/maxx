---
layout: doc
title: First Agent Tab
description: Start a visible Claude Code or Codex workflow in Maxx.
permalink: /docs/getting-started/first-agent-tab/
section: getting-started
---

# First Agent Tab

Maxx works best when agent work stays visible in normal terminal tabs. The
optional Maxx skills teach Claude Code and Codex how to open, name, list, prompt,
and close tabs through Maxx's local control surface.

## Start Manually

1. Open Maxx.
2. Open a tab in the project directory you want the agent to work in.
3. Start your agent CLI normally, such as `codex` or `claude`.
4. Keep delegated work in visible tabs so you can inspect output, interrupt, or
   close sessions with normal terminal controls.

## Add Tab Control

Install the bundled Claude Code or Codex skills from Maxx Settings. With the
skills installed, a parent agent can use Maxx's local control API to open child
tabs and can report explicit workflow state back to Maxx.

The skills use explicit control requests and hook events. Maxx never infers
whether work is done, blocked, or ready from terminal text, branch names, or idle
time.

## Next Steps

- [Configure Claude/Codex hooks and skills]({{ '/docs/how-to/hooks-and-skills/' | relative_url }})
- [Supervise child tabs]({{ '/docs/how-to/supervising-child-tabs/' | relative_url }})
- [Read the no-inference rule]({{ '/no-inference.html' | relative_url }})
