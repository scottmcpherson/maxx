"""HTTP API for the standalone local Voice Service."""

from __future__ import annotations

import json
import base64
import binascii
import hashlib
import itertools
import ipaddress
import logging
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, Optional, Tuple
from urllib.parse import parse_qs, urlsplit

from .backend import (
    AudioMetadata,
    BackendError,
    CancellationToken,
    SynthesisBackend,
    SynthesisRequest,
    TranscriptEvent,
    TranscriptionBackend,
    TranscriptionRequest,
    TranscriptionSession,
    UnconfiguredBackend,
    UnconfiguredTranscriptionBackend,
)
from .multipart import MultipartError, parse_multipart
from .registry import RegistryError, VoiceRegistry
from .websocket import WebSocketProtocolError, read_frame, write_frame


MAX_REQUEST_BYTES = 1_048_576
MAX_TRANSCRIPTION_BYTES = 16 * 1024 * 1024
MAX_TRANSCRIPTION_FIELD_BYTES = 256
MAX_WS_AUDIO_BYTES = 16 * 1024 * 1024
MAX_WS_AUDIO_FRAMES = 4_096
CONTENT_TYPES = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "pcm": "audio/pcm",
}
LOGGER = logging.getLogger("maxx.voice_service")
_BACKEND_ERROR_MESSAGES = {
    "backend_unavailable": "synthesis backend unavailable",
    "backend_invalid": "synthesis backend configuration is invalid",
    "backend_failed": "synthesis backend failed",
    "backend_protocol_error": "synthesis backend returned invalid audio",
    "format_unsupported": "requested audio format is unsupported",
    "transcription_unavailable": "transcription backend unavailable",
    "transcription_failed": "transcription backend failed",
    "transcription_protocol_error": "transcription backend returned invalid data",
    "audio_empty": "audio is empty",
    "audio_metadata_unavailable": "raw PCM playback metadata is unavailable",
    "backend_empty": "synthesis backend produced no audio",
}
_SAFE_ERROR_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _backend_service_error(kind: str, error: BackendError) -> "ServiceError":
    code = error.code if isinstance(error.code, str) and _SAFE_ERROR_CODE.fullmatch(error.code) else "backend_failed"
    if code not in _BACKEND_ERROR_MESSAGES:
        code = "transcription_failed" if kind == "transcription" else "backend_failed"
    LOGGER.error("%s backend failure code=%s error_type=%s", kind, code, type(error).__name__)
    return ServiceError(503, _BACKEND_ERROR_MESSAGES[code], code)


def _log_backend_failure(kind: str, error: Optional[BaseException] = None) -> None:
    error_type = type(error).__name__ if error is not None else "unknown"
    LOGGER.error("%s backend failure error_type=%s", kind, error_type)


def _is_loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class ServiceError(Exception):
    def __init__(self, status: int, message: str, code: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


class VoiceService:
    """Coordinates registry resolution and an injected synthesis backend."""

    def __init__(
        self,
        registry: VoiceRegistry,
        backend: SynthesisBackend,
        transcription_backend: Optional[TranscriptionBackend] = None,
    ) -> None:
        self.registry = registry
        self.backend = backend
        if transcription_backend is not None:
            self.transcription_backend = transcription_backend
        elif callable(getattr(backend, "transcribe", None)) and callable(getattr(backend, "start_session", None)):
            self.transcription_backend = backend
        else:
            self.transcription_backend = UnconfiguredTranscriptionBackend()

    def health(self) -> Dict[str, Any]:
        synthesis_ready = not isinstance(self.backend, UnconfiguredBackend) and getattr(self.backend, "name", "") != "unconfigured"
        transcription_ready = not isinstance(self.transcription_backend, UnconfiguredTranscriptionBackend) and getattr(
            self.transcription_backend, "name", ""
        ) != "unconfigured"
        return {
            "status": "ok" if synthesis_ready else "degraded",
            "ready": synthesis_ready,
            "synthesis_ready": synthesis_ready,
            "transcription_ready": transcription_ready,
            "service": "maxx-voice-service",
            "api_version": "1",
            "backend": getattr(self.backend, "name", type(self.backend).__name__),
            "transcription_backend": getattr(
                self.transcription_backend, "name", type(self.transcription_backend).__name__
            ),
            "voice_count": len(self.registry.list()),
        }

    def voices(self) -> Dict[str, Any]:
        # Deliberately omit reference paths. Clients select the stable ID only.
        data = [profile.public_dict() for profile in self.registry.list()]
        return {"object": "list", "data": data}

    def synthesize(self, payload: Any, cancellation: CancellationToken) -> Tuple[str, Iterable[bytes]]:
        request = _parse_speech_request(payload)
        try:
            reference = self.registry.resolve_reference(request["voice"])
        except RegistryError as exc:
            status = 404 if exc.code == "voice_not_found" else 422
            raise ServiceError(status, str(exc), exc.code) from exc
        if request["model"] != reference.voice.model:
            raise ServiceError(
                HTTPStatus.BAD_REQUEST,
                "model %r is not registered for voice %s" % (request["model"], reference.voice.id),
                "model_voice_mismatch",
            )
        synthesis = SynthesisRequest(
            text=request["input"],
            reference=reference,
            response_format=request["response_format"],
            speed=request["speed"],
        )
        try:
            chunks = self.backend.synthesize(synthesis, cancellation)
        except BackendError as exc:
            raise _backend_service_error("synthesis", exc) from exc
        except Exception as exc:
            _log_backend_failure("synthesis", exc)
            raise ServiceError(503, "synthesis backend failed", "backend_failed") from exc
        if request["response_format"] == "pcm" and not isinstance(getattr(chunks, "metadata", None), AudioMetadata):
            raise ServiceError(
                503,
                _BACKEND_ERROR_MESSAGES["audio_metadata_unavailable"],
                "audio_metadata_unavailable",
            )
        return CONTENT_TYPES[request["response_format"]], chunks

    def transcribe_batch(
        self, fields: Dict[str, bytes], cancellation: CancellationToken
    ) -> str:
        request = _parse_transcription_fields(fields)
        try:
            text = self.transcription_backend.transcribe(request, cancellation)
        except BackendError as exc:
            raise _backend_service_error("transcription", exc) from exc
        except Exception as exc:
            _log_backend_failure("transcription", exc)
            raise ServiceError(503, "transcription backend failed", "transcription_failed") from exc
        if not isinstance(text, str):
            raise ServiceError(503, "transcription backend returned non-text data", "transcription_protocol_error")
        return text

    def start_transcription_session(
        self, model: str, language: Optional[str], cancellation: CancellationToken
    ) -> TranscriptionSession:
        if not model or len(model.encode("utf-8")) > MAX_TRANSCRIPTION_FIELD_BYTES:
            raise ServiceError(400, "model must be a non-empty short string", "invalid_request")
        if language is not None and len(language.encode("utf-8")) > MAX_TRANSCRIPTION_FIELD_BYTES:
            raise ServiceError(400, "language is too long", "invalid_request")
        try:
            session = self.transcription_backend.start_session(model, language, cancellation)
        except BackendError as exc:
            raise _backend_service_error("transcription", exc) from exc
        except Exception as exc:
            _log_backend_failure("transcription", exc)
            raise ServiceError(503, "transcription session failed to start", "transcription_failed") from exc
        if not all(callable(getattr(session, name, None)) for name in ("accept_audio", "finish", "cancel")):
            raise ServiceError(503, "transcription backend returned an invalid session", "transcription_protocol_error")
        return session


def _decode_field(fields: Dict[str, bytes], name: str, required: bool = True) -> Optional[str]:
    value = fields.get(name)
    if value is None:
        if required:
            raise ServiceError(400, "missing required multipart field: %s" % name, "invalid_request")
        return None
    if len(value) > MAX_TRANSCRIPTION_FIELD_BYTES:
        raise ServiceError(400, "multipart field is too long: %s" % name, "invalid_request")
    try:
        decoded = value.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise ServiceError(400, "multipart field must be UTF-8: %s" % name, "invalid_request") from exc
    if required and not decoded:
        raise ServiceError(400, "multipart field must not be empty: %s" % name, "invalid_request")
    return decoded


def _parse_transcription_fields(fields: Dict[str, bytes]) -> TranscriptionRequest:
    audio = fields.get("file")
    if audio is None:
        raise ServiceError(400, "missing required multipart field: file", "invalid_request")
    if not audio:
        raise ServiceError(400, "audio file must not be empty", "audio_empty")
    if len(audio) > MAX_TRANSCRIPTION_BYTES:
        raise ServiceError(413, "audio file is too large", "audio_too_large")
    model = _decode_field(fields, "model")
    language = _decode_field(fields, "language", required=False)
    assert model is not None
    return TranscriptionRequest(audio=audio, model=model, language=language)


def _parse_transcription_query(query: str) -> Tuple[str, Optional[str]]:
    try:
        values = parse_qs(query, keep_blank_values=True, strict_parsing=True)
    except ValueError as exc:
        raise ServiceError(400, "transcription query is malformed", "invalid_request") from exc
    if any(key not in ("model", "language") for key in values):
        raise ServiceError(400, "only model and language are accepted", "invalid_request")
    models = values.get("model", [])
    if len(models) != 1 or not models[0].strip():
        raise ServiceError(400, "a single model query parameter is required", "invalid_request")
    languages = values.get("language", [])
    if len(languages) > 1 or (languages and not languages[0].strip()):
        raise ServiceError(400, "language must be a single non-empty value", "invalid_request")
    model = models[0].strip()
    language = languages[0].strip() if languages else None
    if len(model.encode("utf-8")) > MAX_TRANSCRIPTION_FIELD_BYTES or (
        language is not None and len(language.encode("utf-8")) > MAX_TRANSCRIPTION_FIELD_BYTES
    ):
        raise ServiceError(400, "transcription query field is too long", "invalid_request")
    return model, language


def _parse_speech_request(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ServiceError(400, "request body must be a JSON object", "invalid_request")
    required = ("model", "input", "voice")
    missing = [key for key in required if key not in payload]
    if missing:
        raise ServiceError(400, "missing required field(s): %s" % ", ".join(missing), "invalid_request")
    for key in required:
        if not isinstance(payload[key], str) or not payload[key].strip():
            raise ServiceError(400, "%s must be a non-empty string" % key, "invalid_request")
    text = payload["input"]
    if len(text) > 100_000:
        raise ServiceError(413, "input is too long", "input_too_large")
    response_format = payload.get("response_format", "mp3")
    if not isinstance(response_format, str) or response_format not in CONTENT_TYPES:
        raise ServiceError(400, "unsupported response_format", "format_unsupported")
    speed = payload.get("speed", 1.0)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.25 <= float(speed) <= 4.0:
        raise ServiceError(400, "speed must be a number between 0.25 and 4.0", "invalid_request")
    stream = payload.get("stream", False)
    if not isinstance(stream, bool):
        raise ServiceError(400, "stream must be a boolean", "invalid_request")
    return {
        "model": payload["model"].strip(),
        "input": text,
        "voice": payload["voice"].strip(),
        "response_format": response_format,
        "speed": float(speed),
        "stream": stream,
    }


def _validated_audio_chunks(chunks: Iterable[bytes]) -> Iterable[bytes]:
    for chunk in chunks:
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise BackendError("synthesis backend yielded a non-byte chunk", "backend_protocol_error")
        value = bytes(chunk)
        if value:
            yield value


class _RequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    service: VoiceService

    def log_message(self, format: str, *args: Any) -> None:
        # Request bodies can contain user text. Keep the reference service
        # quiet by default and avoid putting content into logs.
        return

    def _json(self, status: int, payload: Dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _error(self, exc: ServiceError) -> None:
        self._json(
            exc.status,
            {"error": {"message": exc.message, "type": exc.code, "code": exc.code}},
        )

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/v1/audio/transcriptions/stream":
            if self._is_websocket_upgrade():
                self._handle_transcription_websocket(parsed.query)
            else:
                self.close_connection = True
                self._error(ServiceError(426, "WebSocket upgrade is required", "upgrade_required"))
            return
        if parsed.path == "/health" and not parsed.query:
            health = self.service.health()
            self._json(200 if health["ready"] else 503, health)
            return
        if parsed.path == "/v1/audio/voices" and not parsed.query:
            try:
                self._json(200, self.service.voices())
            except RegistryError as exc:
                self._error(ServiceError(500, str(exc), exc.code))
            return
        self._json(404, {"error": {"message": "route not found", "type": "not_found", "code": "not_found"}})

    def do_POST(self) -> None:
        if self.path == "/v1/audio/transcriptions":
            self._handle_transcription_batch()
            return
        if self.path != "/v1/audio/speech":
            self._json(404, {"error": {"message": "route not found", "type": "not_found", "code": "not_found"}})
            return
        try:
            payload = self._read_json()
            cancellation = CancellationToken()
            content_type, chunks = self.service.synthesize(payload, cancellation)
            stream = bool(payload.get("stream", False)) if isinstance(payload, dict) else False
            if stream:
                self._stream_audio(content_type, chunks, cancellation)
            else:
                self._buffer_audio(content_type, chunks, cancellation)
        except ServiceError as exc:
            self._error(exc)
        except (BrokenPipeError, ConnectionResetError):
            # A disconnected client is the cancellation signal for a stream.
            return
        except Exception:
            self._error(ServiceError(500, "internal voice service error", "internal_error"))

    def _handle_transcription_batch(self) -> None:
        cancellation = CancellationToken()
        try:
            body = self._read_body(MAX_TRANSCRIPTION_BYTES)
            fields = parse_multipart(self.headers.get("Content-Type", ""), body)
            text = self.service.transcribe_batch(fields, cancellation)
            encoded = json.dumps({"text": text}, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)
        except MultipartError as exc:
            self._error(ServiceError(400, str(exc), "invalid_multipart"))
        except ServiceError as exc:
            self._error(exc)
        except (BrokenPipeError, ConnectionResetError):
            cancellation.cancel()
        except Exception:
            self._error(ServiceError(500, "internal voice service error", "internal_error"))

    def _is_websocket_upgrade(self) -> bool:
        upgrade = self.headers.get("Upgrade", "").strip().lower()
        connection = {item.strip().lower() for item in self.headers.get("Connection", "").split(",")}
        return upgrade == "websocket" and "upgrade" in connection

    def _handle_transcription_websocket(self, query: str) -> None:
        cancellation: Optional[CancellationToken] = None
        session: Optional[TranscriptionSession] = None
        try:
            model, language = _parse_transcription_query(query)
            cancellation = CancellationToken()
            session = self.service.start_transcription_session(model, language, cancellation)
            self._websocket_handshake()
            # The HTTP request is complete after the upgrade; the WebSocket
            # loop owns this socket and must not let BaseHTTPRequestHandler
            # parse a second HTTP request after the client closes.
            self.close_connection = True
        except ServiceError as exc:
            if cancellation is not None:
                cancellation.cancel()
            if session is not None:
                try:
                    session.cancel()
                except Exception:
                    pass
            self.close_connection = True
            self._error(exc)
            return
        except Exception:
            if cancellation is not None:
                cancellation.cancel()
            if session is not None:
                try:
                    session.cancel()
                except Exception:
                    pass
            self.close_connection = True
            self._error(ServiceError(400, "invalid WebSocket handshake", "handshake_invalid"))
            return

        assert cancellation is not None
        assert session is not None
        self.connection.settimeout(60.0)
        self._last_transcription_sequence = 0
        frame_count = 0
        audio_bytes = 0
        finished = False
        try:
            while True:
                try:
                    fin, opcode, payload = read_frame(self.rfile)
                except EOFError:
                    cancellation.cancel()
                    return
                except (TimeoutError, OSError):
                    self._send_transcription_error(1011, "transcription stream timed out", "stream_timeout")
                    return
                if opcode == 9:  # ping
                    write_frame(self.wfile, 10, payload)
                    continue
                if opcode == 10:  # pong
                    continue
                if opcode == 8:  # close
                    if len(payload) == 1:
                        raise WebSocketProtocolError(1002, "invalid close frame")
                    write_frame(self.wfile, 8, payload[:125])
                    return
                if opcode == 1:
                    if not fin:
                        raise WebSocketProtocolError(1002, "fragmented control messages are not supported")
                    self._handle_transcription_control(payload, frame_count, session, cancellation)
                    finished = True
                    try:
                        self._send_transcription_events(session.finish())
                    except BackendError as exc:
                        service_error = _backend_service_error("transcription", exc)
                        self._send_transcription_error(1011, service_error.message, service_error.code)
                        return
                    except Exception:
                        self._send_transcription_error(1011, "transcription backend failed", "transcription_failed")
                        return
                    self._send_websocket_close(1000, "")
                    return
                if opcode != 2 or not fin:
                    raise WebSocketProtocolError(1002, "stream accepts complete binary PCM16 frames only")
                if finished:
                    raise WebSocketProtocolError(1002, "audio arrived after audio.done")
                if not payload:
                    raise WebSocketProtocolError(1002, "audio frames must not be empty")
                if len(payload) % 2:
                    raise WebSocketProtocolError(1003, "audio frames must contain PCM16 samples")
                frame_count += 1
                audio_bytes += len(payload)
                if frame_count > MAX_WS_AUDIO_FRAMES or audio_bytes > MAX_WS_AUDIO_BYTES:
                    raise WebSocketProtocolError(1009, "transcription stream audio limit exceeded")
                try:
                    self._send_transcription_events(session.accept_audio(payload))
                except BackendError as exc:
                    service_error = _backend_service_error("transcription", exc)
                    self._send_transcription_error(1011, service_error.message, service_error.code)
                    return
                except Exception:
                    self._send_transcription_error(1011, "transcription backend failed", "transcription_failed")
                    return
        except WebSocketProtocolError as exc:
            self._send_transcription_error(exc.code, exc.message, "protocol_error")
        except (BrokenPipeError, ConnectionResetError, EOFError):
            cancellation.cancel()
        finally:
            cancellation.cancel()
            try:
                session.cancel()
            except Exception:
                pass

    def _handle_transcription_control(
        self,
        payload: bytes,
        frame_count: int,
        session: TranscriptionSession,
        cancellation: CancellationToken,
    ) -> None:
        try:
            message = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WebSocketProtocolError(1007, "control message must be valid JSON") from exc
        if not isinstance(message, dict) or message.get("type") != "audio.done":
            raise WebSocketProtocolError(1002, "expected an audio.done control message")
        if "sequence" in message and message["sequence"] != frame_count:
            raise WebSocketProtocolError(1002, "audio frame sequence is out of order")
        if frame_count == 0:
            raise WebSocketProtocolError(1003, "audio.done requires at least one PCM16 frame")
        if cancellation.cancelled:
            raise WebSocketProtocolError(1001, "transcription stream was cancelled")

    def _send_transcription_events(self, events: Iterable[TranscriptEvent]) -> None:
        try:
            iterator = iter(events)
            for event in iterator:
                if not isinstance(event, TranscriptEvent):
                    raise BackendError("transcription backend yielded an invalid event", "transcription_protocol_error")
                if event.type not in ("transcript.partial", "transcript.done") or not isinstance(event.text, str):
                    raise BackendError("transcription backend yielded an invalid event", "transcription_protocol_error")
                if event.type == "transcript.partial" and event.final:
                    raise BackendError("partial transcription event cannot be final", "transcription_protocol_error")
                if event.type == "transcript.done" and not event.final:
                    raise BackendError("final transcription event must be marked final", "transcription_protocol_error")
                if not isinstance(event.sequence, int) or event.sequence <= self._last_transcription_sequence:
                    raise BackendError("transcription backend yielded an invalid event", "transcription_protocol_error")
                self._last_transcription_sequence = event.sequence
                write_frame(self.wfile, 1, json.dumps(event.as_dict(), separators=(",", ":")).encode("utf-8"))
        except BackendError:
            raise
        except Exception as exc:
            raise BackendError("transcription backend failed", "transcription_failed") from exc

    def _send_transcription_error(self, close_code: int, message: str, code: str) -> None:
        try:
            payload = json.dumps(
                {"type": "error", "event": "transcript.error", "code": code, "message": message},
                separators=(",", ":"),
            ).encode("utf-8")
            write_frame(self.wfile, 1, payload)
            self._send_websocket_close(close_code, message)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _send_websocket_close(self, code: int, reason: str) -> None:
        reason_bytes = reason.encode("utf-8")[:123].decode("utf-8", "ignore").encode("utf-8")
        write_frame(self.wfile, 8, code.to_bytes(2, "big") + reason_bytes)

    def _websocket_handshake(self) -> None:
        if self.headers.get("Sec-WebSocket-Version") != "13":
            raise ServiceError(426, "Sec-WebSocket-Version 13 is required", "handshake_invalid")
        key = self.headers.get("Sec-WebSocket-Key", "")
        try:
            decoded = base64.b64decode(key, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ServiceError(400, "Sec-WebSocket-Key is invalid", "handshake_invalid") from exc
        if len(decoded) != 16:
            raise ServiceError(400, "Sec-WebSocket-Key is invalid", "handshake_invalid")
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()

    def _read_body(self, maximum: int) -> bytes:
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except ValueError as exc:
            raise ServiceError(400, "Content-Length must be an integer", "invalid_request") from exc
        if length < 0:
            raise ServiceError(411, "Content-Length is required", "length_required")
        if length > maximum:
            raise ServiceError(413, "request body is too large", "request_too_large")
        chunks = bytearray()
        while len(chunks) < length:
            chunk = self.rfile.read(length - len(chunks))
            if not chunk:
                raise ServiceError(400, "request body is truncated", "invalid_request")
            chunks.extend(chunk)
        return bytes(chunks)

    def _read_json(self) -> Any:
        try:
            raw = self._read_body(MAX_REQUEST_BYTES)
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise ServiceError(400, "request body must be valid JSON", "invalid_request") from exc
        return payload

    def _buffer_audio(self, content_type: str, chunks: Iterable[bytes], cancellation: CancellationToken) -> None:
        try:
            audio = b"".join(_validated_audio_chunks(chunks))
        except BackendError as exc:
            raise _backend_service_error("synthesis", exc) from exc
        except Exception as exc:
            _log_backend_failure("synthesis", exc)
            raise ServiceError(503, "synthesis backend failed", "backend_failed") from exc
        if cancellation.cancelled:
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if content_type == CONTENT_TYPES["pcm"]:
            metadata = getattr(chunks, "metadata", None)
            if isinstance(metadata, AudioMetadata):
                for name, value in metadata.headers().items():
                    self.send_header(name, value)
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(audio)

    def _stream_audio(self, content_type: str, chunks: Iterable[bytes], cancellation: CancellationToken) -> None:
        try:
            iterator = iter(chunks)
            first = None
            for candidate in iterator:
                if not isinstance(candidate, (bytes, bytearray, memoryview)):
                    raise BackendError("synthesis backend yielded a non-byte chunk", "backend_protocol_error")
                candidate = bytes(candidate)
                if candidate:
                    first = candidate
                    break
            if first is None:
                raise StopIteration
        except StopIteration as exc:
            raise ServiceError(503, _BACKEND_ERROR_MESSAGES["backend_empty"], "backend_empty") from exc
        except BackendError as exc:
            raise _backend_service_error("synthesis", exc) from exc
        except Exception as exc:
            _log_backend_failure("synthesis", exc)
            raise ServiceError(503, "synthesis backend failed", "backend_failed") from exc
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if content_type == CONTENT_TYPES["pcm"]:
            metadata = getattr(chunks, "metadata", None)
            if isinstance(metadata, AudioMetadata):
                for name, value in metadata.headers().items():
                    self.send_header(name, value)
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            for chunk in itertools.chain((first,), iterator):
                if cancellation.cancelled:
                    break
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    raise BackendError("synthesis backend yielded a non-byte chunk", "backend_protocol_error")
                chunk = bytes(chunk)
                if not chunk:
                    continue
                self.wfile.write(("%x\r\n" % len(chunk)).encode("ascii"))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            if not cancellation.cancelled:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            cancellation.cancel()
        except BackendError as exc:
            _log_backend_failure("synthesis stream terminated", exc)
            cancellation.cancel()


class VoiceHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self, address: Tuple[str, int], service: VoiceService, allow_remote_without_auth: bool = False
    ) -> None:
        host = address[0]
        if not _is_loopback_host(host) and not allow_remote_without_auth:
            raise ValueError(
                "refusing non-loopback bind without authentication; use loopback or "
                "--allow-remote-without-auth only on a trusted network"
            )
        if not _is_loopback_host(host) and allow_remote_without_auth:
            LOGGER.critical(
                "UNAUTHENTICATED VOICE SERVICE BIND on %s; audio and transcription endpoints are exposed",
                host,
            )
        self.service = service

        class Handler(_RequestHandler):
            pass

        Handler.service = service
        super().__init__(address, Handler)


def serve(
    service: VoiceService,
    host: str = "127.0.0.1",
    port: int = 8765,
    allow_remote_without_auth: bool = False,
) -> None:
    """Serve until interrupted."""

    server = VoiceHTTPServer((host, port), service, allow_remote_without_auth=allow_remote_without_auth)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
