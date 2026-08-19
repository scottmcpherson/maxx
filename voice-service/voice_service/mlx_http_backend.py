"""stdlib HTTP adapter for a local MLX Audio API server.

The standalone Voice Service owns the public, provider-neutral API.  This
adapter is the concrete bridge to an operator-managed ``mlx_audio.server``
running on the same machine.  It deliberately keeps model and reference paths
on that machine: the registry resolves them before they are sent to MLX
Audio, and the adapter never accepts a remote or credential-bearing base URL.

Use it with ``voice-service serve`` as
``--backend voice_service.mlx_http_backend:MlxHttpBackend``. The adapter reads
``MLX_AUDIO_BASE_URL`` (default ``http://127.0.0.1:8000``),
``MLX_AUDIO_TTS_SAMPLE_RATE`` (default ``24000``),
``MLX_AUDIO_TTS_CHANNELS`` (default ``1``), and
``MLX_AUDIO_HTTP_TIMEOUT_SECONDS`` (default ``600``). PCM and timeout aliases
are also accepted for deployments that use shorter environment names.
"""

from __future__ import annotations

import http.client
import io
import ipaddress
import json
import os
import socket
import uuid
import wave
from typing import Any, Dict, Iterable, Iterator, Optional, Tuple
from urllib.parse import urlsplit

from .backend import (
    AudioMetadata,
    AudioStream,
    BackendError,
    CancellationToken,
    SynthesisBackend,
    SynthesisRequest,
    TranscriptEvent,
    TranscriptionBackend,
    TranscriptionRequest,
    TranscriptionSession,
)


DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_TIMEOUT_SECONDS = 600.0
DEFAULT_TTS_SAMPLE_RATE = 24_000
DEFAULT_TTS_CHANNELS = 1
DEFAULT_MAX_TTS_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_TRANSCRIPTION_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_TEXT_BYTES = 100_000
DEFAULT_READ_CHUNK_BYTES = 64 * 1024
MAX_ERROR_BYTES = 4 * 1024
PCM_SAMPLE_RATE = 16_000
PCM_CHANNELS = 1
PCM_SAMPLE_WIDTH = 2
TTS_ACCEPT_TYPES = {
    "pcm": "audio/pcm",
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "flac": "audio/flac",
}


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("%s must be a positive integer" % name)
    return value


def _positive_float(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) <= 0:
        raise ValueError("%s must be a positive number" % name)
    return float(value)


def _env_positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("%s must be a positive integer" % name) from exc
    return _positive_int(value, name)


def _env_positive_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError("%s must be a positive number" % name) from exc
    return _positive_float(value, name)


def _env_positive_int_aliases(names: Tuple[str, ...], default: int) -> int:
    for name in names:
        if os.getenv(name) is not None:
            return _env_positive_int(name, default)
    return default


def _env_positive_float_aliases(names: Tuple[str, ...], default: float) -> float:
    for name in names:
        if os.getenv(name) is not None:
            return _env_positive_float(name, default)
    return default


def _is_loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _parse_base_url(value: str) -> Tuple[str, str, Optional[int], str]:
    """Validate a loopback HTTP URL and return scheme, host, port, path root."""

    raw = value.strip()
    if not raw:
        raise ValueError("MLX Audio base URL must not be empty")
    parsed = urlsplit(raw)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("MLX Audio base URL must use http:// or https://")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("MLX Audio base URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("MLX Audio base URL must not contain a query or fragment")
    host = parsed.hostname
    if not host or not _is_loopback_host(host):
        raise ValueError("MLX Audio base URL must resolve to loopback")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("MLX Audio base URL has an invalid port") from exc
    path = parsed.path.rstrip("/")
    if path == "/v1":
        path = ""
    return parsed.scheme, host, port, path


def _request_path(base_path: str, suffix: str) -> str:
    if not suffix.startswith("/"):
        suffix = "/" + suffix
    return (base_path + suffix) or "/"


def _wav_pcm16(audio: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(PCM_CHANNELS)
        handle.setsampwidth(PCM_SAMPLE_WIDTH)
        handle.setframerate(PCM_SAMPLE_RATE)
        handle.writeframes(audio)
    return output.getvalue()


def _multipart(fields: Dict[str, str], audio: bytes) -> Tuple[bytes, str]:
    boundary = "--------------------------" + uuid.uuid4().hex
    marker = boundary.encode("ascii")
    chunks = []
    for name, value in fields.items():
        chunks.extend(
            (
                b"--" + marker + b"\r\n",
                b'Content-Disposition: form-data; name="' + name.encode("ascii") + b'"\r\n\r\n',
                value.encode("utf-8"),
                b"\r\n",
            )
        )
    chunks.extend(
        (
            b"--" + marker + b"\r\n",
            b'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n',
            b"Content-Type: audio/wav\r\n\r\n",
            audio,
            b"\r\n--" + marker + b"--\r\n",
        )
    )
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary


class MlxHttpBackend(SynthesisBackend, TranscriptionBackend):
    """Bridge Voice Service requests to a loopback MLX Audio HTTP server.

    ``MLX_AUDIO_BASE_URL`` defaults to ``http://127.0.0.1:8000``.  The
    ``MLX_AUDIO_TTS_SAMPLE_RATE`` and ``MLX_AUDIO_TTS_CHANNELS`` environment
    variables control the metadata advertised for raw PCM output; the defaults
    match the usual MLX Audio 24 kHz mono output.  Constructor arguments make
    these deployment settings testable without changing process environment.
    """

    name = "mlx-audio-http"

    def __init__(
        self,
        base_url: Optional[str] = None,
        timeout_seconds: Optional[float] = None,
        tts_sample_rate: Optional[int] = None,
        tts_channels: Optional[int] = None,
        max_tts_bytes: int = DEFAULT_MAX_TTS_BYTES,
        max_transcription_bytes: int = DEFAULT_MAX_TRANSCRIPTION_BYTES,
        max_text_bytes: int = DEFAULT_MAX_TEXT_BYTES,
    ) -> None:
        self._scheme, self._host, self._port, self._base_path = _parse_base_url(
            base_url
            if base_url is not None
            else os.getenv("MLX_AUDIO_BASE_URL", os.getenv("MLX_AUDIO_URL", DEFAULT_BASE_URL))
        )
        self._timeout = _positive_float(
            timeout_seconds
            if timeout_seconds is not None
            else _env_positive_float_aliases(
                ("MLX_AUDIO_HTTP_TIMEOUT_SECONDS", "MLX_AUDIO_TIMEOUT_SECONDS", "MLX_AUDIO_TIMEOUT"),
                DEFAULT_TIMEOUT_SECONDS,
            ),
            "timeout_seconds",
        )
        self._tts_sample_rate = _positive_int(
            tts_sample_rate
            if tts_sample_rate is not None
            else _env_positive_int_aliases(
                ("MLX_AUDIO_TTS_SAMPLE_RATE", "MLX_AUDIO_PCM_SAMPLE_RATE", "MLX_AUDIO_SAMPLE_RATE"),
                DEFAULT_TTS_SAMPLE_RATE,
            ),
            "tts_sample_rate",
        )
        self._tts_channels = _positive_int(
            tts_channels
            if tts_channels is not None
            else _env_positive_int_aliases(
                ("MLX_AUDIO_TTS_CHANNELS", "MLX_AUDIO_PCM_CHANNELS", "MLX_AUDIO_CHANNELS"),
                DEFAULT_TTS_CHANNELS,
            ),
            "tts_channels",
        )
        self._max_tts_bytes = _positive_int(max_tts_bytes, "max_tts_bytes")
        self._max_transcription_bytes = _positive_int(
            max_transcription_bytes, "max_transcription_bytes"
        )
        self._max_text_bytes = _positive_int(max_text_bytes, "max_text_bytes")

    def _connection(self) -> http.client.HTTPConnection:
        connection_type = http.client.HTTPSConnection if self._scheme == "https" else http.client.HTTPConnection
        return connection_type(self._host, self._port, timeout=self._timeout)

    def _open(
        self,
        method: str,
        suffix: str,
        body: bytes,
        headers: Dict[str, str],
        cancellation: CancellationToken,
        kind: str,
    ) -> Tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        if cancellation.cancelled:
            raise BackendError("request was cancelled", "%s_failed" % kind)
        connection = self._connection()
        try:
            connection.request(method, _request_path(self._base_path, suffix), body=body, headers=headers)
            response = connection.getresponse()
        except (OSError, socket.timeout, http.client.HTTPException, ValueError) as exc:
            connection.close()
            raise BackendError("MLX Audio is unavailable", "%s_unavailable" % kind) from exc
        if response.status < 200 or response.status >= 300:
            try:
                response.read(MAX_ERROR_BYTES)
            except (OSError, socket.timeout, http.client.HTTPException):
                pass
            response.close()
            connection.close()
            raise BackendError(
                "MLX Audio returned HTTP %d" % response.status,
                "%s_failed" % kind,
            )
        return connection, response

    def _response_bytes(
        self,
        connection: http.client.HTTPConnection,
        response: http.client.HTTPResponse,
        cancellation: CancellationToken,
        maximum: int,
        kind: str,
    ) -> bytes:
        try:
            declared = response.getheader("Content-Length")
            if declared:
                try:
                    if int(declared) > maximum:
                        raise BackendError(
                            "MLX Audio response exceeded the configured limit",
                            "%s_protocol_error" % kind,
                        )
                except ValueError as exc:
                    raise BackendError(
                        "MLX Audio returned an invalid content length",
                        "%s_protocol_error" % kind,
                    ) from exc
            output = bytearray()
            while True:
                if cancellation.cancelled:
                    return b""
                chunk = response.read(DEFAULT_READ_CHUNK_BYTES)
                if not chunk:
                    return bytes(output)
                output.extend(chunk)
                if len(output) > maximum:
                    raise BackendError("MLX Audio response exceeded the configured limit", "%s_protocol_error" % kind)
        except BackendError:
            raise
        except (OSError, socket.timeout, http.client.HTTPException) as exc:
            raise BackendError("MLX Audio response could not be read", "%s_failed" % kind) from exc
        finally:
            response.close()
            connection.close()

    def synthesize(
        self, request: SynthesisRequest, cancellation: CancellationToken
    ) -> AudioStream:
        if len(request.text.encode("utf-8")) > self._max_text_bytes:
            raise BackendError("synthesis input is too long", "backend_protocol_error")
        if len(request.reference.transcript.encode("utf-8")) > self._max_text_bytes:
            raise BackendError("reference transcript is too long", "backend_protocol_error")
        if request.response_format not in ("pcm", "wav", "mp3", "opus", "aac", "flac"):
            raise BackendError("requested audio format is unsupported", "backend_protocol_error")
        payload = {
            "model": request.reference.voice.model,
            "input": request.text,
            "voice": request.reference.voice.id,
            "response_format": request.response_format,
            "stream": True,
            "speed": request.speed,
            "lang_code": request.reference.voice.language,
            "ref_audio": str(request.reference.audio_path),
            "ref_text": request.reference.transcript,
        }
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        metadata = (
            AudioMetadata(self._tts_sample_rate, self._tts_channels)
            if request.response_format == "pcm"
            else None
        )
        return AudioStream(
            self._stream_tts(body, request.response_format, cancellation),
            metadata=metadata,
        )

    def _stream_tts(
        self, body: bytes, response_format: str, cancellation: CancellationToken
    ) -> Iterator[bytes]:
        connection = None
        response = None
        total = 0
        yielded = False
        try:
            if cancellation.cancelled:
                return
            connection, response = self._open(
                "POST",
                "/v1/audio/speech",
                body,
                {
                    "Content-Type": "application/json",
                    "Accept": TTS_ACCEPT_TYPES[response_format],
                    "Content-Length": str(len(body)),
                },
                cancellation,
                "backend",
            )
            declared = response.getheader("Content-Length")
            if declared:
                try:
                    if int(declared) > self._max_tts_bytes:
                        raise BackendError("MLX Audio response exceeded the configured limit", "backend_protocol_error")
                except ValueError as exc:
                    raise BackendError("MLX Audio returned an invalid content length", "backend_protocol_error") from exc
            while True:
                if cancellation.cancelled:
                    return
                try:
                    chunk = response.read(DEFAULT_READ_CHUNK_BYTES)
                except (OSError, socket.timeout, http.client.HTTPException) as exc:
                    raise BackendError("MLX Audio response could not be read", "backend_failed") from exc
                if not chunk:
                    break
                total += len(chunk)
                if total > self._max_tts_bytes:
                    raise BackendError("MLX Audio response exceeded the configured limit", "backend_protocol_error")
                yielded = True
                yield chunk
            if not yielded and not cancellation.cancelled:
                raise BackendError("MLX Audio produced no audio", "backend_empty")
        finally:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()

    def transcribe(self, request: TranscriptionRequest, cancellation: CancellationToken) -> str:
        return self._transcribe_request(
            request.audio, request.model, request.language, cancellation, allow_wav_overhead=False
        )

    def _transcribe_wav(
        self,
        audio: bytes,
        model: str,
        language: Optional[str],
        cancellation: CancellationToken,
    ) -> str:
        if cancellation.cancelled:
            return ""
        return self._transcribe_request(audio, model, language, cancellation, allow_wav_overhead=True)

    def _transcribe_request(
        self,
        audio: bytes,
        model: str,
        language: Optional[str],
        cancellation: CancellationToken,
        allow_wav_overhead: bool,
    ) -> str:
        if not audio:
            raise BackendError("audio is empty", "audio_empty")
        maximum = self._max_transcription_bytes
        if allow_wav_overhead and audio.startswith(b"RIFF"):
            maximum += 44
        if len(audio) > maximum:
            raise BackendError("transcription audio exceeded the configured limit", "transcription_protocol_error")
        fields = {"model": self._field(model, "model")}
        if language is not None:
            fields["language"] = self._field(language, "language")
        body, content_type = _multipart(fields, audio)
        connection = None
        response = None
        try:
            connection, response = self._open(
                "POST",
                "/v1/audio/transcriptions",
                body,
                {"Content-Type": content_type, "Content-Length": str(len(body))},
                cancellation,
                "transcription",
            )
            raw = self._response_bytes(
                connection, response, cancellation, self._max_text_bytes * 4, "transcription"
            )
            if cancellation.cancelled:
                return ""
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise BackendError("MLX Audio returned invalid transcription JSON", "transcription_protocol_error") from exc
            text = payload.get("text") if isinstance(payload, dict) else None
            if not isinstance(text, str):
                raise BackendError("MLX Audio returned invalid transcription data", "transcription_protocol_error")
            if len(text.encode("utf-8")) > self._max_text_bytes:
                raise BackendError("MLX Audio transcription exceeded the configured limit", "transcription_protocol_error")
            return text
        finally:
            # _response_bytes closes these on the normal path; close is safe a
            # second time and is required when JSON validation fails first.
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()

    @staticmethod
    def _field(value: str, name: str) -> str:
        if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > 256:
            raise BackendError("transcription %s is invalid" % name, "transcription_protocol_error")
        return value.strip()

    def start_session(
        self, model: str, language: Optional[str], cancellation: CancellationToken
    ) -> TranscriptionSession:
        return _BufferedTranscriptionSession(
            self,
            self._field(model, "model"),
            self._field(language, "language") if language is not None else None,
            cancellation,
            self._max_transcription_bytes,
        )


class _BufferedTranscriptionSession(TranscriptionSession):
    """Buffer the provider-neutral PCM stream and make one final STT request."""

    def __init__(
        self,
        backend: MlxHttpBackend,
        model: str,
        language: Optional[str],
        cancellation: CancellationToken,
        maximum: int,
    ) -> None:
        self._backend = backend
        self._model = model
        self._language = language
        self._cancellation = cancellation
        self._maximum = maximum
        self._audio = bytearray()
        self._finished = False

    def accept_audio(self, audio: bytes) -> Iterable[TranscriptEvent]:
        if self._finished or self._cancellation.cancelled:
            return ()
        if not isinstance(audio, (bytes, bytearray, memoryview)):
            raise BackendError("audio must be bytes", "transcription_protocol_error")
        chunk = bytes(audio)
        if not chunk or len(chunk) % 2:
            raise BackendError("audio must contain non-empty PCM16 samples", "transcription_protocol_error")
        if len(self._audio) + len(chunk) > self._maximum:
            raise BackendError("transcription audio exceeded the configured limit", "transcription_protocol_error")
        self._audio.extend(chunk)
        # This adapter intentionally emits no fake interim text. MLX Audio's
        # standard HTTP endpoint is batch-oriented; the final request below is
        # the only authoritative transcript event.
        return ()

    def finish(self) -> Iterable[TranscriptEvent]:
        if self._finished or self._cancellation.cancelled:
            return ()
        self._finished = True
        if not self._audio:
            raise BackendError("audio is empty", "audio_empty")
        text = self._backend._transcribe_wav(
            _wav_pcm16(bytes(self._audio)), self._model, self._language, self._cancellation
        )
        self._audio.clear()
        if self._cancellation.cancelled:
            return ()
        return (TranscriptEvent("transcript.done", text, True, 1),)

    def cancel(self) -> None:
        self._finished = True
        self._audio.clear()


# ``load_backend('voice_service.mlx_http_backend:MlxHttpBackend')`` instantiates
# this class after reading the environment, so importing the module alone does
# not fail because an operator has not configured the local MLX service yet.
