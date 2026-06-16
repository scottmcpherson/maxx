---
layout: doc
title: Runner and Webhook Config Reference
description: Configuration entry points for Maxx runner, webhook, connector, and policy flows.
permalink: /docs/reference/runner-webhook-config/
section: reference
---

# Runner and Webhook Config Reference

This page is the quick index for files and options that connect external events
to visible Maxx tabs.

## Entry Points

| Surface              | Command                   | Full reference                           |
| -------------------- | ------------------------- | ---------------------------------------- |
| Connector resolution | `maxx +connector resolve` | [Connector adapters][connector-adapters] |
| One-shot runner      | `maxx +runner run`        | [Automation runner][automation-runner]   |
| Polling runner       | `maxx +runner poll`       | [Automation runner][automation-runner]   |
| Webhook listener     | `maxx +webhook serve`     | [Webhook ingestion][webhook-ingestion]   |
| Capability policy    | `maxx +control policy`  | [Control API][control-api]               |

[connector-adapters]: {{ '/connector-adapters.html' | relative_url }}
[automation-runner]: {{ '/automation-runner.html' | relative_url }}
[webhook-ingestion]: {{ '/webhook-ingestion.html' | relative_url }}
[control-api]: {{ '/control-api.html' | relative_url }}

## Important Environment Variables

| Variable                    | Purpose                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `MAXX_CONTROL_DIR`          | Selects the local control socket/token directory.                 |
| `MAXX_CONTROL_POLICY_FILE`  | Points a Maxx instance at a specific capability policy file.      |
| `MAXX_WEBHOOK_SECRET`       | Common environment source for webhook HMAC secrets.               |
| `MAXX_WEBHOOK_PAYLOAD_FILE` | Path used when prompt delivery writes the payload to a temp file. |

## Common Config Files

| File                  | Purpose                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `control-policy.json` | Defines explicit caller sources and allowed capabilities.                                            |
| `webhook.json`        | Defines listener bind address, routes, auth, connector source, command, caller, and prompt delivery. |
| Runner state file     | Stores deduplication records for runner and webhook deliveries.                                      |

## Boundary

Runner and webhook config selects an explicit action from explicit input fields.
It must not infer workflow meaning from branch names, paths, terminal output, or
idle time. See [the no-inference rule]({{ '/no-inference.html' | relative_url }}).
