---
layout: doc
title: Supervising Child Tabs
description: Coordinate visible child agent sessions in Maxx.
permalink: /docs/how-to/supervising-child-tabs/
section: how-to
---

# Supervising Child Tabs

Use Maxx supervision when one agent should coordinate several visible child
tabs. The parent agent can open child sessions, group them, prompt them, and
watch explicit events without hiding work in detached background processes.

## Workflow

1. Start the parent agent in a normal Maxx tab.
2. Ask the parent to create child tabs for distinct tasks.
3. Keep each child tab visible in the sidebar with a clear title and declared
   metadata.
4. Keep the `session_id` returned by `maxx-agent-hook new-tab` or
   `maxx +control sessions create`, and use it to prompt, interrupt, restart,
   inspect, or close child tabs when needed.
5. Treat completion or blockage as explicit agent-declared state, not inferred
   terminal output.

## Useful References

- [Control API]({{ '/control-api.html' | relative_url }})
- [Automation runner]({{ '/automation-runner.html' | relative_url }})
- [No-inference rule]({{ '/no-inference.html' | relative_url }})

## Operational Notes

Each drive or automation flow should use its own control directory when parallel
sessions must not share a socket:

```sh
MAXX_CONTROL_DIR=/tmp/maxx-control-my-task ./tools/zig build run
```

Pass the same `MAXX_CONTROL_DIR` to any control or runner commands for that
session.
