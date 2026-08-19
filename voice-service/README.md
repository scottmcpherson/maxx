# Maxx Voice Service

This is the local speech service for Phases 1 and 2. It owns a portable
named-voice registry and exposes OpenAI-compatible TTS and STT. It does not
contain a model, credentials, reference recordings, or machine-specific paths.

## Install and run

The service uses only the Python standard library. From this directory:

```sh
python3 -m pip install --user .
voice-service register \
  --name Scarlett \
  --model qwen3-tts-base \
  --audio /path/to/scarlett.wav \
  --transcript /path/to/scarlett-transcript.md \
  --registry ./voice-registry.json \
  --voice-data-dir ./voice-data \
  --consent
voice-service serve \
  --registry ./voice-registry.json \
  --voice-data-dir ./voice-data \
  --backend your_backend_module:backend \
  --stt-backend your_stt_module:backend
```

The package does not bundle provider runtimes, models, or voice artifacts;
operators must handle their licensing and consent obligations separately.
See [LICENSING.md](LICENSING.md).

The service binds to loopback by default and refuses non-loopback binds without
authentication. `--allow-remote-without-auth` is an explicit, dangerous escape
hatch for a trusted network only; it emits a strong runtime warning. The
service does not provide authentication or TLS yet.

`--consent` is mandatory. Registration validates a readable WAV with samples
and a non-empty UTF-8 transcript, then copies both files beneath the configured
voice-data directory. IDs are stable slugs by default; pass `--id` when a
specific stable ID is required. Registry paths are always relative, so moving
the project and restarting the service does not change IDs.

For a deterministic local HTTP smoke test, use `--backend deterministic`
explicitly. This fixture emits a short WAV tone and is not a speech model.
There is no implicit fallback when a backend or reference file is missing.

## Backend contract

Inject `MlxAudioBackend` with an object exposing the TTS method below. The same
adapter may also expose `transcribe` and `start_transcription_session`; when
it does, omit `--stt-backend` and the combined adapter handles both routes.

```python
def synthesize(
    *, text, model, voice_id, reference_audio, reference_text,
    language, response_format, speed, cancellation
):
    yield encoded_audio_bytes
```

The service resolves the selected voice before invoking this method. The
backend receives the registered model and resolved reference files, and may
yield encoded chunks as MLX Audio produces them. It can check
`cancellation.cancelled` between chunks. Model loading and model paths remain
outside this service.

For a concrete bridge, see
`voice_service/mlx_adapter_template.py`. Inject configured TTS/STT callables
with `build_backend(...)`; the template normalizes bytes-like audio and common
provider transcript dictionaries without selecting model paths or credentials.

The provider-neutral STT methods are:

```python
def transcribe(request, cancellation) -> str:
    # request.audio, request.model, request.language

def start_transcription_session(model, language, cancellation):
    # returns accept_audio(bytes), finish(), and cancel()
```

`deterministic-stt` is an explicit test backend. If STT is not configured,
the service returns a structured `503 transcription_unavailable` error; it
never silently uses another provider.

`GET /health` returns `status: "ok"` and HTTP 200 only when synthesis is
configured. It returns `status: "degraded"`, `ready: false`, and HTTP 503 when
synthesis is unconfigured. STT readiness is reported separately because STT
is optional for Phase 1 TTS use.

## HTTP API

```text
GET  /health
GET  /v1/audio/voices
POST /v1/audio/speech
POST /v1/audio/transcriptions
GET  /v1/audio/transcriptions/stream (WebSocket upgrade)
```

Voice discovery returns an OpenAI-style `{ "object": "list", "data": [...] }`
payload containing stable `id`, display `name`, `model`, and `language` only.
Speech accepts `model`, `input`, `voice`, optional `response_format` (`mp3`,
`opus`, `aac`, `flac`, `wav`, or `pcm`), `speed`, and `stream`. The requested
model must be the model registered for the requested voice. Unknown voices,
invalid references, model mismatches, unsupported formats, and unavailable
backends return structured errors; they never select another voice.

`stream: true` uses HTTP chunked transfer encoding. A disconnected client
cancels the backend iterator. `stream: false` buffers the result and returns a
normal OpenAI-compatible audio response.

Streaming TTS preflights the first non-empty backend chunk before sending HTTP
200. A backend failure before that chunk is a structured 503. A provider
failure after headers have been sent terminates the chunked response without a
terminal chunk; clients must treat an incomplete chunked stream as failed.

For `response_format: "pcm"`, the selected backend must return playback
metadata. Responses include `X-Maxx-Audio-Sample-Rate`,
`X-Maxx-Audio-Channels`, and `X-Maxx-Audio-Sample-Format: s16le`; the service
never guesses these values. The deterministic backend declares its actual
8,000 Hz mono format.

Batch STT uses the OpenAI multipart shape:

```text
file=<audio bytes>&model=<model id>&language=<optional language>
```

The response is `{ "text": "..." }`. Uploads are bounded and are never
written to disk. Batch transcription is synchronous: a client disconnect
cannot cancel a backend call already in progress. Use the WebSocket route when
provider-level streaming cancellation is required.

The streaming STT extension uses a WebSocket URL with the model in the query:

```text
ws://127.0.0.1:8765/v1/audio/transcriptions/stream?model=whisper-local&language=en
```

Client-to-server frames must be masked RFC 6455 binary frames containing
complete, ordered PCM16 samples (even byte length). Send a final text frame
`{ "type": "audio.done", "sequence": <binary-frame-count> }`; the sequence
field is optional but, when present, must match. The service emits JSON text
frames such as:

```json
{"type":"transcript.partial","text":"hello","final":false,"sequence":1}
{"type":"transcript.done","text":"hello world","final":true,"sequence":2}
```

Malformed, unmasked, fragmented, out-of-order, oversized, or post-`audio.done`
frames produce a JSON `{ "type": "error", ... }` event followed by a close
frame. Disconnecting the client cancels the provider session.

Open WebUI can use the service URL as its OpenAI-compatible TTS endpoint and
select the `id` returned by `/v1/audio/voices`; it does not need reference
audio or transcript paths.

## Tests

```sh
python3 -m unittest discover -s tests -v
```

The deterministic suite covers two independent voices, relocation and
restart, malformed and missing references, explicit errors, HTTP discovery and
speech, streaming, cancellation, consent-gated registration, batch STT,
streaming STT event semantics, masking and sequence validation, protocol
limits, disconnect cancellation, readiness, secure binding, transactional
replacement, sanitized failures, and raw PCM metadata.
