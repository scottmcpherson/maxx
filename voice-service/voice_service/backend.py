"""Provider-neutral synthesis boundary for the local Voice Service."""

from __future__ import annotations

import hashlib
import importlib
import io
import math
import struct
import wave
from dataclasses import dataclass
from typing import Any, Iterable, Iterator, List, Optional, Union

from .registry import VoiceReference


class BackendError(RuntimeError):
    """A synthesis backend cannot satisfy a request."""

    def __init__(self, message: str, code: str = "backend_unavailable") -> None:
        super().__init__(message)
        self.code = code


class CancellationToken:
    """Thread-safe cancellation signal passed through a streaming request."""

    def __init__(self) -> None:
        import threading

        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()


@dataclass(frozen=True)
class SynthesisRequest:
    text: str
    reference: VoiceReference
    response_format: str
    speed: float


@dataclass(frozen=True)
class AudioMetadata:
    """Metadata required to play raw PCM without guessing device settings."""

    sample_rate: int
    channels: int
    sample_format: str = "s16le"

    def __post_init__(self) -> None:
        if self.sample_rate < 1 or self.channels < 1 or self.sample_format != "s16le":
            raise ValueError("audio metadata must describe positive PCM16 s16le settings")

    def headers(self) -> dict:
        return {
            "X-Maxx-Audio-Sample-Rate": str(self.sample_rate),
            "X-Maxx-Audio-Channels": str(self.channels),
            "X-Maxx-Audio-Sample-Format": self.sample_format,
        }


@dataclass(frozen=True)
class AudioStream:
    """Encoded audio chunks plus optional playback metadata."""

    chunks: Iterable[bytes]
    metadata: Optional[AudioMetadata] = None

    def __iter__(self) -> Iterator[bytes]:
        return iter(self.chunks)


class SynthesisBackend:
    """Minimal interface implemented by MLX Audio or another TTS engine."""

    name = "unconfigured"

    def synthesize(
        self, request: SynthesisRequest, cancellation: CancellationToken
    ) -> Union[Iterable[bytes], AudioStream]:
        raise NotImplementedError


@dataclass(frozen=True)
class TranscriptionRequest:
    """Provider-neutral batch transcription request."""

    audio: bytes
    model: str
    language: Optional[str]


@dataclass(frozen=True)
class TranscriptEvent:
    """Normalized interim or final transcription event."""

    type: str
    text: str
    final: bool
    sequence: int

    def as_dict(self) -> dict:
        return {
            "type": self.type,
            "text": self.text,
            "final": self.final,
            "sequence": self.sequence,
        }


class TranscriptionSession:
    """Incremental STT session consumed by the WebSocket transport."""

    def accept_audio(self, audio: bytes) -> Iterable[TranscriptEvent]:
        raise NotImplementedError

    def finish(self) -> Iterable[TranscriptEvent]:
        raise NotImplementedError

    def cancel(self) -> None:
        """Release provider resources; safe to call more than once."""

        return None


class TranscriptionBackend:
    """Provider-neutral batch and streaming STT boundary."""

    name = "unconfigured"

    def transcribe(self, request: TranscriptionRequest, cancellation: CancellationToken) -> str:
        raise NotImplementedError

    def start_session(
        self, model: str, language: Optional[str], cancellation: CancellationToken
    ) -> TranscriptionSession:
        raise NotImplementedError


class UnconfiguredBackend(SynthesisBackend):
    """Explicitly fail until an operator selects a real backend."""

    name = "unconfigured"

    def synthesize(
        self, request: SynthesisRequest, cancellation: CancellationToken
    ) -> Union[Iterable[bytes], AudioStream]:
        raise BackendError("no synthesis backend is configured", "backend_unavailable")


class UnconfiguredTranscriptionBackend(TranscriptionBackend):
    """Explicitly fail until an STT backend is selected."""

    name = "unconfigured"

    def transcribe(self, request: TranscriptionRequest, cancellation: CancellationToken) -> str:
        raise BackendError("no transcription backend is configured", "transcription_unavailable")

    def start_session(
        self, model: str, language: Optional[str], cancellation: CancellationToken
    ) -> TranscriptionSession:
        raise BackendError("no transcription backend is configured", "transcription_unavailable")


class DeterministicTranscriptionSession(TranscriptionSession):
    def __init__(self, text: str, partials: List[str], cancellation: CancellationToken) -> None:
        self._text = text
        self._partials = partials
        self._cancellation = cancellation
        self._frame_count = 0
        self._sequence = 0
        self._finished = False

    def accept_audio(self, audio: bytes) -> Iterable[TranscriptEvent]:
        if self._finished or self._cancellation.cancelled:
            return iter(())
        self._frame_count += 1
        if self._partials:
            index = min(self._frame_count - 1, len(self._partials) - 1)
            text = self._partials[index]
        else:
            text = self._text[: max(1, min(len(self._text), self._frame_count))]
        self._sequence += 1
        return iter((TranscriptEvent("transcript.partial", text, False, self._sequence),))

    def finish(self) -> Iterable[TranscriptEvent]:
        if self._finished or self._cancellation.cancelled:
            return iter(())
        self._finished = True
        self._sequence += 1
        return iter((TranscriptEvent("transcript.done", self._text, True, self._sequence),))

    def cancel(self) -> None:
        self._finished = True


class DeterministicTranscriptionBackend(TranscriptionBackend):
    """Explicit fixture backend for batch and WebSocket STT tests."""

    name = "deterministic-stt"

    def __init__(self, text: str = "deterministic transcript", partials: Optional[List[str]] = None) -> None:
        if not text:
            raise ValueError("deterministic transcription text must not be empty")
        self.text = text
        self.partials = list(partials or [])

    def transcribe(self, request: TranscriptionRequest, cancellation: CancellationToken) -> str:
        if cancellation.cancelled:
            return ""
        if not request.audio:
            raise BackendError("audio is empty", "audio_empty")
        return self.text

    def start_session(
        self, model: str, language: Optional[str], cancellation: CancellationToken
    ) -> TranscriptionSession:
        return DeterministicTranscriptionSession(self.text, self.partials, cancellation)


class MlxAudioBackend(SynthesisBackend, TranscriptionBackend):
    """Adapter for an MLX Audio engine supplied by the host application.

    ``engine.synthesize`` is deliberately injected instead of imported here;
    MLX model packages and their locations vary by deployment. The engine gets
    the resolved reference files only after registry validation, and can yield
    encoded audio chunks as soon as they are available.

    The callable must accept these keyword arguments and return an iterable of
    ``bytes`` chunks::

        synthesize(text, model, voice_id, reference_audio, reference_text,
                   language, response_format, speed, cancellation)
    """

    name = "mlx-audio"

    def __init__(self, engine: Any) -> None:
        method = getattr(engine, "synthesize", None)
        if not callable(method):
            raise TypeError("MLX Audio engine must expose synthesize()")
        self._engine = engine

    def synthesize(self, request: SynthesisRequest, cancellation: CancellationToken) -> AudioStream:
        if cancellation.cancelled:
            return iter(())
        result = self._engine.synthesize(
            text=request.text,
            model=request.reference.voice.model,
            voice_id=request.reference.voice.id,
            reference_audio=request.reference.audio_path,
            reference_text=request.reference.transcript,
            language=request.reference.voice.language,
            response_format=request.response_format,
            speed=request.speed,
            cancellation=cancellation,
        )
        if isinstance(result, AudioStream):
            chunks = result.chunks
            metadata = result.metadata
        else:
            chunks = result
            metadata = getattr(result, "metadata", None)
        return AudioStream(_checked_chunks(chunks, cancellation), metadata=metadata)

    def transcribe(self, request: TranscriptionRequest, cancellation: CancellationToken) -> str:
        method = getattr(self._engine, "transcribe", None)
        if not callable(method):
            raise BackendError("MLX Audio engine does not provide transcription", "transcription_unavailable")
        try:
            value = method(
                audio=request.audio,
                model=request.model,
                language=request.language,
                cancellation=cancellation,
            )
        except BackendError:
            raise
        except Exception as exc:
            raise BackendError("transcription backend failed: %s" % exc, "transcription_failed") from exc
        if not isinstance(value, str):
            raise BackendError("transcription backend returned non-text data", "transcription_protocol_error")
        return value

    def start_session(
        self, model: str, language: Optional[str], cancellation: CancellationToken
    ) -> TranscriptionSession:
        method = getattr(self._engine, "start_transcription_session", None)
        if not callable(method):
            raise BackendError("MLX Audio engine does not provide streaming transcription", "transcription_unavailable")
        try:
            session = method(model=model, language=language, cancellation=cancellation)
        except BackendError:
            raise
        except Exception as exc:
            raise BackendError("transcription session failed to start", "transcription_failed") from exc
        if not all(callable(getattr(session, name, None)) for name in ("accept_audio", "finish", "cancel")):
            raise BackendError("transcription backend returned an invalid session", "transcription_protocol_error")
        return session


class DeterministicWavBackend(SynthesisBackend):
    """Small explicit fixture backend for tests and local HTTP smoke checks.

    It is never selected implicitly by the service. The generated tone is
    deterministic per voice ID and lets tests verify streaming and selection
    without downloading an MLX model.
    """

    name = "deterministic-wav"

    def __init__(self, chunk_size: int = 256) -> None:
        if chunk_size < 1:
            raise ValueError("chunk_size must be positive")
        self.chunk_size = chunk_size

    def synthesize(self, request: SynthesisRequest, cancellation: CancellationToken) -> AudioStream:
        if request.response_format not in ("wav", "pcm"):
            raise BackendError("deterministic backend supports only wav or pcm", "format_unsupported")
        wav_bytes = _tone_wav(request.reference.voice.id)
        payload = wav_bytes if request.response_format == "wav" else wav_bytes[44:]
        metadata = AudioMetadata(sample_rate=8_000, channels=1) if request.response_format == "pcm" else None
        return AudioStream(
            _checked_chunks(
                (payload[index : index + self.chunk_size] for index in range(0, len(payload), self.chunk_size)),
                cancellation,
            ),
            metadata=metadata,
        )


def _checked_chunks(chunks: Iterable[Any], cancellation: CancellationToken) -> Iterator[bytes]:
    try:
        for chunk in chunks:
            if cancellation.cancelled:
                return
            if not isinstance(chunk, (bytes, bytearray, memoryview)):
                raise BackendError("synthesis backend yielded a non-byte chunk", "backend_protocol_error")
            data = bytes(chunk)
            if data:
                yield data
    except BackendError:
        raise
    except Exception as exc:
        raise BackendError("synthesis backend failed: %s" % exc, "backend_failed") from exc


def _tone_wav(voice_id: str) -> bytes:
    digest = hashlib.sha256(voice_id.encode("utf-8")).digest()
    frequency = 220 + digest[0]
    sample_rate = 8_000
    duration = 0.08
    samples = int(sample_rate * duration)
    payload = bytearray()
    for index in range(samples):
        value = int(8_000 * math.sin(2 * math.pi * frequency * index / sample_rate))
        payload.extend(struct.pack("<h", value))
    output = io.BytesIO()
    with wave.open(output, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(bytes(payload))
    return output.getvalue()


def load_backend(spec: str) -> Any:
    """Load an explicitly selected backend.

    ``deterministic`` is a development fixture. A production backend uses
    ``module.path:object`` and may wrap an MLX Audio engine.
    """

    if spec == "deterministic":
        return DeterministicWavBackend()
    if not spec or ":" not in spec:
        raise BackendError("backend must be 'deterministic' or module:object", "backend_invalid")
    module_name, object_name = spec.split(":", 1)
    if not module_name or not object_name:
        raise BackendError("backend must be 'deterministic' or module:object", "backend_invalid")
    try:
        target = importlib.import_module(module_name)
        value: Any = target
        for part in object_name.split("."):
            value = getattr(value, part)
        backend = value() if isinstance(value, type) else value
    except (ImportError, AttributeError, TypeError) as exc:
        raise BackendError("unable to load backend %s: %s" % (spec, exc), "backend_invalid") from exc
    if not callable(getattr(backend, "synthesize", None)):
        raise BackendError("backend %s does not implement SynthesisBackend" % spec, "backend_invalid")
    return backend


def load_transcription_backend(spec: str) -> TranscriptionBackend:
    """Load an explicit STT backend or the deterministic test fixture."""

    if spec == "deterministic-stt":
        return DeterministicTranscriptionBackend()
    if not spec or ":" not in spec:
        raise BackendError("transcription backend must be 'deterministic-stt' or module:object", "backend_invalid")
    module_name, object_name = spec.split(":", 1)
    try:
        target = importlib.import_module(module_name)
        value: Any = target
        for part in object_name.split("."):
            value = getattr(value, part)
        backend = value() if isinstance(value, type) else value
    except (ImportError, AttributeError, TypeError) as exc:
        raise BackendError("unable to load transcription backend %s: %s" % (spec, exc), "backend_invalid") from exc
    if not callable(getattr(backend, "transcribe", None)) or not callable(getattr(backend, "start_session", None)):
        raise BackendError("backend %s does not implement TranscriptionBackend" % spec, "backend_invalid")
    return backend
