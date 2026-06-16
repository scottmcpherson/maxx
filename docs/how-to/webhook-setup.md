---
layout: doc
title: Linear and GitHub Webhook Setup
description: Configure explicit Linear or GitHub events to launch visible Maxx tabs.
permalink: /docs/how-to/webhook-setup/
section: how-to
---

# Linear and GitHub Webhook Setup

Maxx can receive an explicit Linear or GitHub event and launch a visible local
tab through the same runner pipeline used by scripts and polls. The event source
does not become workflow truth inside Maxx; it is structured input for a
configured launch.

## Setup Outline

1. Define a connector source such as `linear` or `github`.
2. Add a route in `webhook.json` with a fixed path, command, caller, prompt
   delivery mode, and authentication settings.
3. Configure a capability-policy source for the webhook caller if it needs to
   spawn tabs or create groups.
4. Start `ghostty +webhook serve --config webhook.json` while Maxx is running.
5. Point the provider or relay at the local route through a trusted tunnel.

## Read Next

- [Webhook ingestion reference]({{ '/webhook-ingestion.html' | relative_url }})
- [Connector adapter reference]({{ '/connector-adapters.html' | relative_url }})
- [Automation runner reference]({{ '/automation-runner.html' | relative_url }})
- [Runner and webhook config reference]({{ '/docs/reference/runner-webhook-config/' | relative_url }})
