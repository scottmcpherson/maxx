---
layout: doc
title: Maxx Documentation
description: Start here for Maxx setup, agent workflows, control APIs, and architecture notes.
permalink: /docs/
section: docs
---

# Maxx Documentation

Maxx documentation lives in this repository and publishes through GitHub Pages.
The repository docs are the canonical source of truth for fork-specific Maxx
behavior; external notes, chats, and wikis should link back here instead of
replacing it.

<div class="section-grid">
  <a class="section-card" href="{{ '/docs/getting-started/' | relative_url }}">
    <h2>Getting started</h2>
    <p>Install Maxx, build from source, and open your first visible agent tab.</p>
  </a>
  <a class="section-card" href="{{ '/docs/how-to/' | relative_url }}">
    <h2>How-to</h2>
    <p>Configure Claude/Codex hooks and skills, supervise child tabs, and wire Linear or GitHub triggers.</p>
  </a>
  <a class="section-card" href="{{ '/docs/reference/' | relative_url }}">
    <h2>Reference</h2>
    <p>Control API, connector adapters, automation runner, webhook ingestion, and config references.</p>
  </a>
  <a class="section-card" href="{{ '/docs/explanation/' | relative_url }}">
    <h2>Explanation</h2>
    <p>The no-inference rule, trust boundaries, and security model behind Maxx's control plane.</p>
  </a>
</div>

## Common Paths

- [Install and build Maxx]({{ '/docs/getting-started/install/' | relative_url }})
- [Open a first agent tab]({{ '/docs/getting-started/first-agent-tab/' | relative_url }})
- [Configure Claude/Codex hooks and skills]({{ '/docs/how-to/hooks-and-skills/' | relative_url }})
- [Supervise child tabs]({{ '/docs/how-to/supervising-child-tabs/' | relative_url }})
- [Set up Linear/GitHub webhooks]({{ '/docs/how-to/webhook-setup/' | relative_url }})
- [Read the Control API reference]({{ '/control-api.html' | relative_url }})
- [Read the no-inference rule]({{ '/no-inference.html' | relative_url }})

## Editing Docs

Most deeper documentation is Markdown. Make content changes in this repository,
review them in pull requests, and let GitHub Pages publish from the existing
`docs/` site root.
