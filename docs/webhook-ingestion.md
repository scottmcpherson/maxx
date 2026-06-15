# Maxx Webhook Ingestion

Webhook ingestion is a small, local-first HTTP listener that turns an external
webhook into a visible Maxx tab launch. It is the network front door to the same
pipeline the [automation trigger runner](./automation-runner.md) exposes for
polling and local scripts: a request is parsed by a configured
[connector adapter](./connector-adapters.md) and launched through the
[Control API](./control-api.md).

Maxx stays the visible terminal-native runtime/control plane, never the workflow
brain. The listener accepts a request only on an explicitly configured route,
validates the transport, parses the opaque payload with the route's configured
adapter, and launches exactly the configured command. Maxx never decides what a
Linear/GitHub/CI event _means_ — the route mapping and the launched command own
that. See [the no-inference rule](./no-inference.md).

## The product boundary

- Maxx owns the **transport and the launch**: binding a local socket, validating
  the request (method, content type, size, signature), and starting an explicit
  command in a normal visible tab through the Control API.
- The **upstream system and the operator's route config** own workflow meaning:
  which event maps to which command, and what that command does with the payload.
- Maxx treats every payload as **opaque event data**. It validates transport
  safety (size, content type, configured secret) and copies only the explicit
  fields the connector adapter lifts. It never scrapes terminal output, nor
  guesses from process names, branch names, paths, idle time, or tab titles.

## Quick start

1. Write a config file (`webhook.json`):

   ```json
   {
     "bind": "127.0.0.1:8787",
     "routes": [
       {
         "path": "/hooks/linear-issue",
         "source": "linear",
         "command": "codex resume --prompt-file $MAXX_WEBHOOK_PAYLOAD_FILE",
         "title": "${issue.identifier}: ${title}",
         "caller": "trusted-automation",
         "prompt_delivery": "file",
         "auth": {
           "mode": "hmac",
           "secret_env": "MAXX_WEBHOOK_SECRET",
           "header": "X-Webhook-Signature",
           "prefix": "sha256="
         }
       }
     ]
   }
   ```

2. Export the secret and start the listener (the running Maxx app serves the
   control socket the launches target):

   ```sh
   export MAXX_WEBHOOK_SECRET=$(openssl rand -hex 32)
   ghostty +webhook serve --config webhook.json
   # maxx webhook listening on http://127.0.0.1:8787 (1 route(s))
   ```

3. Deliver a signed request. The signature is the lowercase hex HMAC-SHA256 of
   the **raw request body** using the secret:

   ```sh
   body='{"action":"create","type":"Issue","data":{"id":"evt-1","identifier":"MAX-9","title":"Webhook ingestion","url":"https://linear.app/x/MAX-9"}}'
   sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$MAXX_WEBHOOK_SECRET" | awk '{print $2}')
   curl -sS -X POST http://127.0.0.1:8787/hooks/linear-issue \
     -H 'Content-Type: application/json' \
     -H "X-Webhook-Signature: sha256=$sig" \
     -d "$body"
   # {"ok":true,"outcome":"launched","session_id":"SID-..."}
   ```

A new visible tab appears in Maxx running the configured command, with the raw
payload available to it.

> JSON, not TOML. The issue that introduced this feature sketched a TOML config;
> the implementation uses JSON to match Maxx's existing JSON-based
> control/connector tooling and reuse the same parser. The route-to-command model
> is identical.

## Configuration

Top-level fields:

| Field            | Required | Default           | Meaning                                        |
| ---------------- | -------- | ----------------- | ---------------------------------------------- |
| `bind`           | no       | `127.0.0.1:8787`  | `host:port` (or `[ipv6]:port`) to listen on.   |
| `max_body_bytes` | no       | `1048576` (1 MiB) | Default request-body cap; routes may override. |
| `routes`         | yes      | —                 | At least one route.                            |

Each route:

| Field             | Required | Default        | Meaning                                                                  |
| ----------------- | -------- | -------------- | ------------------------------------------------------------------------ |
| `path`            | yes      | —              | Exact request path that selects this route (must start with `/`).        |
| `source`          | yes      | —              | Connector adapter that parses the payload (`linear`, `github`).          |
| `command`         | yes      | —              | Command to run. **No `${...}` placeholders** (see security note below).  |
| `title`           | no       | event title    | Tab title (templated).                                                   |
| `cwd`             | no       | —              | Working directory (templated).                                           |
| `env`             | no       | —              | Extra env entries `[{ "key", "value" }]` (values templated).             |
| `prompt_delivery` | no       | `env`          | How the connector prompt reaches the command: `env`, `stdin`, or `file`. |
| `caller`          | no       | trusted-local  | Policy source the launch is attributed to (not templated).               |
| `group`           | no       | —              | Supervisor group label (templated).                                      |
| `trigger`         | no       | `path`         | Display name recorded as the trigger.                                    |
| `max_body_bytes`  | no       | global default | Per-route body cap.                                                      |
| `dedup_header`    | no       | —              | Request header carrying a per-delivery id for dedup (see below).         |
| `auth`            | yes      | —              | Authentication (below).                                                  |

`${field}` placeholders in `title`, `cwd`, `group`, and `env` values are filled
**only** from explicit event fields (e.g. `${title}`, `${issue.identifier}`,
`${repo.full_name}`, `${url}`). A required placeholder the payload does not
provide fails the request (HTTP 422); use `${field?}` for an optional one.
`caller` is deliberately not templated — a policy identity is a fixed deployment
decision, never derived from an untrusted payload. See
[connector adapters](./connector-adapters.md) for the field set each source
provides and the templating rules.

> **Security: `command` must not contain `${...}` placeholders.** Maxx launches a
> tab by shell-evaluating the command string, so interpolating a
> provider-controlled field (an issue/PR title or body — values an attacker can
> often set) directly into `command` would be a shell-injection vector even
> behind a valid signature. The config validator rejects any `${` in `command`.
> Get payload data to the command the safe way instead: put it in a templated
> `env` value and reference it as a **quoted** shell variable
> (`"command": "claude \"$ISSUE\"", "env": [{"key": "ISSUE", "value": "${title}"}]`)
> — the shell does not re-tokenize an expanded variable — or read
> `$MAXX_WEBHOOK_PAYLOAD_FILE` / the connector prompt. A plain `$VAR` (no braces)
> in `command` is a normal shell reference and is left untouched.

### Authentication

`auth.mode` is one of:

- **`hmac`** — HMAC-SHA256 over the raw request body, lowercase hex, compared in
  constant time against the configured header (case-insensitive). The standard
  GitHub/Linear signature scheme.
- **`token`** — a shared secret compared in constant time against the configured
  header. A simple bearer-style check for relays that cannot sign bodies.
- **`none`** — no authentication. **Permitted only on a loopback bind.** Starting
  `serve` with a `none` route on a non-loopback bind is refused, so a local
  command launcher is never exposed off-host.

| `auth` field | Required for    | Meaning                                                     |
| ------------ | --------------- | ----------------------------------------------------------- |
| `mode`       | always          | `hmac`, `token`, or `none`.                                 |
| `secret_env` | `hmac`, `token` | Name of the env var holding the secret/HMAC key.            |
| `header`     | `hmac`, `token` | Request header carrying the signature/token.                |
| `prefix`     | no              | Literal prefix stripped before comparison (e.g. `sha256=`). |

Secrets are read from the environment **at startup** and never written to disk or
logged. `serve` **fails closed**: if a route's `secret_env` is unset or empty,
the listener refuses to start.

## Delivering the payload to the command

The launched command receives the event two ways, both explicit and documented:

- **Raw payload file** — the exact request body is written to a `0600` temp file
  and its path is passed as `MAXX_WEBHOOK_PAYLOAD_FILE`. This is the recommended
  mechanism for arbitrary provider payloads (the example command reads it). Files
  are uniquely named per launch and swept after a day.
- **Connector prompt** — the adapter assembles a prompt/context string from
  explicit fields, delivered per the route's `prompt_delivery`: as
  `MAXX_CONNECTOR_PROMPT` (`env`), streamed to the command's stdin (`stdin`), or
  as a `0600` file referenced by `MAXX_CONNECTOR_PROMPT_FILE` (`file`).

Maxx never interpolates untrusted payload content into the command line itself —
pass the payload through these mechanisms and let the command decide what it
means.

## Responses and behavior

The listener answers with a tiny JSON body that never echoes the payload or any
secret:

| Status | When                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| `200`  | Launched (`{"ok":true,"outcome":"launched","session_id":…}`) or a suppressed duplicate (`"outcome":"duplicate"`). |
| `401`  | Missing/invalid signature **or an unknown route** (the two are intentionally indistinguishable — see below).      |
| `405`  | Method is not `POST` (only returned once the caller is authenticated).                                            |
| `413`  | Body exceeds the route's cap (post-auth) or the global read cap.                                                  |
| `415`  | `Content-Type` is not `application/json` (post-auth).                                                             |
| `422`  | A required template field was absent from the payload.                                                            |
| `400`  | Payload is not valid JSON / not a supported event.                                                                |
| `500`  | Server-side problem (e.g. a configured secret is unavailable).                                                    |
| `502`  | The launch was attempted but the Control API rejected it.                                                         |

**Route privacy.** Authentication runs _before_ any route-specific rejection, and
an unknown path returns the **same** `401` as a known path with a bad/missing
signature. So an unauthenticated caller cannot enumerate configured routes (which
may encode provider/project names or act as part of a tunnel secret); the
finer-grained `405`/`415`/`413`/`200` codes appear only after the caller proves
the route's secret. Use `+webhook validate` to see your own routes.

**Duplicate suppression.** Webhook dedup keys on a **per-delivery id** read from a
route-configured `dedup_header` (e.g. `"dedup_header": "X-GitHub-Delivery"` or
`"Linear-Delivery"`), persisted in `<control-dir>/webhook-seen.json` (override
with `--state-file`, disable globally with `--no-dedup`). A redelivery of the
**same** delivery id returns `200 duplicate` and launches nothing, so provider
retries are safe — while distinct events for the same issue/PR still launch.
Without a `dedup_header` (or when a request omits it) dedup is **off** and every
request launches: the adapters set `event.id` to the _object_ id (the issue/PR),
so keying on it would wrongly drop later legitimate events for the same object.
The store is bounded by count, age, and size.

**Logging.** Each request logs one redacted line (method, path, status, outcome,
source, event id, session id, error code) under the `webhook` scope. The body,
secret, and signature are never logged.

## Tunnels and relays

The listener is loopback-only by default. To receive provider webhooks, place a
tunnel or relay in front of it — the event-to-command model does not change:

```sh
# ngrok
ngrok http 8787
# Cloudflare Tunnel
cloudflared tunnel --url http://127.0.0.1:8787
# Tailscale Funnel
tailscale funnel 8787
```

Point the provider's webhook at `https://<tunnel-host>/hooks/linear-issue` and
configure the provider to send the matching signature header. A relay service can
likewise forward normalized events to the local listener; from Maxx's side it is
just another HTTP client that must present a valid signature.

> **Always keep a signature on a tunneled route.** A tunnel exposes the listener
> to the public internet; an unauthenticated (`none`) route is for loopback
> testing only and is refused on non-loopback binds for exactly this reason.

## Relationship to `+runner` and `+connector`

- [`+connector resolve`](./connector-adapters.md) turns a payload into a
  `sessions.create` request and stops (pure, offline).
- [`+runner`](./automation-runner.md) executes one event from a poll check or a
  local script.
- `+webhook serve` is the long-lived HTTP front end: it authenticates and reads
  a request, then dispatches through the **same** runner pipeline — same dedup,
  prompt delivery, provenance (`runner.*` / `connector.*` metadata), policy
  `caller`, and visible-tab launch. Inspect, stop, or restart a launched tab with
  the usual tab/session controls.
