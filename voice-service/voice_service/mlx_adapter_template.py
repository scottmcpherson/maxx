"""Concrete MLX Audio adapter template with provider-event normalization.

This module intentionally does not import MLX or select model paths. Deployments
inject their already-configured callables and can expose the resulting object
through ``module:object`` in the service CLI.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable, Iterator, Optional

from .backend import (
    AudioStream,
    BackendError,
    CancellationToken,
    MlxAudioBackend,
    TranscriptEvent,
    TranscriptionSession,
)


def normalize_audio_chunk(chunk: Any) -> bytes:
    """Accept encoded bytes or a bytes-like MLX buffer without guessing formats."""

    if isinstance(chunk, (bytes, bytearray, memoryview)):
        return bytes(chunk)
    to_bytes = getattr(chunk, "tobytes", None)
    if callable(to_bytes):
        value = to_bytes()
        if isinstance(value, bytes):
            return value
    raise BackendError("MLX adapter received an unsupported audio chunk", "backend_protocol_error")


def _event_values(value: Any) -> Iterable[Any]:
    if isinstance(value, (TranscriptEvent, dict)):
        return (value,)
    if value is None:
        return ()
    try:
        return iter(value)
    except TypeError as exc:
        raise BackendError("MLX adapter received invalid transcription events", "transcription_protocol_error") from exc


def normalize_transcript_events(values: Any, next_sequence: int) -> Iterator[TranscriptEvent]:
    """Normalize common provider dicts into the service event vocabulary."""

    sequence = next_sequence
    for value in _event_values(values):
        if isinstance(value, TranscriptEvent):
            text = value.text
            final = value.final
        elif isinstance(value, dict):
            text = value.get("text")
            if not isinstance(text, str):
                raise BackendError("MLX adapter received an event without text", "transcription_protocol_error")
            event_type = value.get("type")
            final = bool(value.get("final", value.get("is_final", event_type in ("final", "done", "transcript.done"))))
        else:
            raise BackendError("MLX adapter received invalid transcription events", "transcription_protocol_error")
        sequence += 1
        yield TranscriptEvent("transcript.done" if final else "transcript.partial", text, final, sequence)


class NormalizingTranscriptionSession(TranscriptionSession):
    def __init__(self, provider_session: Any) -> None:
        self._provider_session = provider_session
        self._sequence = 0

    def accept_audio(self, audio: bytes) -> Iterable[TranscriptEvent]:
        method = getattr(self._provider_session, "accept_audio", None) or getattr(self._provider_session, "push", None)
        if not callable(method):
            raise BackendError("MLX adapter session cannot accept audio", "transcription_protocol_error")
        try:
            values = method(audio)
        except BackendError:
            raise
        except Exception as exc:
            raise BackendError("MLX adapter transcription session failed", "transcription_failed") from exc
        events = tuple(normalize_transcript_events(values, self._sequence))
        if events:
            self._sequence = events[-1].sequence
        return events

    def finish(self) -> Iterable[TranscriptEvent]:
        method = getattr(self._provider_session, "finish", None) or getattr(self._provider_session, "close", None)
        if not callable(method):
            raise BackendError("MLX adapter session cannot finish", "transcription_protocol_error")
        try:
            values = method()
        except BackendError:
            raise
        except Exception as exc:
            raise BackendError("MLX adapter transcription session failed", "transcription_failed") from exc
        events = tuple(normalize_transcript_events(values, self._sequence))
        if events:
            self._sequence = events[-1].sequence
        return events

    def cancel(self) -> None:
        method = getattr(self._provider_session, "cancel", None) or getattr(self._provider_session, "close", None)
        if callable(method):
            method()


class MlxAudioEngineTemplate:
    """Callable bridge for a deployment's configured MLX engines.

    ``tts`` must return encoded chunks or ``AudioStream`` with metadata for
    raw PCM. ``stt`` returns text or ``{"text": text}``. ``streaming_stt``
    returns a provider session whose events are dicts or ``TranscriptEvent``.
    All model loading, credentials, and paths remain in the injected callables.
    """

    def __init__(
        self,
        tts: Callable[..., Any],
        stt: Callable[..., Any],
        streaming_stt: Callable[..., Any],
    ) -> None:
        self._tts = tts
        self._stt = stt
        self._streaming_stt = streaming_stt

    def synthesize(self, **kwargs: Any) -> AudioStream:
        try:
            result = self._tts(**kwargs)
        except BackendError:
            raise
        except Exception as exc:
            raise BackendError("MLX adapter synthesis failed", "backend_failed") from exc
        if isinstance(result, AudioStream):
            return AudioStream((_normalized_chunks(result.chunks)), result.metadata)
        metadata = getattr(result, "metadata", None)
        return AudioStream(_normalized_chunks(result), metadata)

    def transcribe(self, *, audio: bytes, model: str, language: Optional[str], cancellation: CancellationToken) -> str:
        try:
            result = self._stt(audio=audio, model=model, language=language, cancellation=cancellation)
        except BackendError:
            raise
        except Exception as exc:
            raise BackendError("MLX adapter transcription failed", "transcription_failed") from exc
        if isinstance(result, str):
            return result
        if isinstance(result, dict) and isinstance(result.get("text"), str):
            return result["text"]
        raise BackendError("MLX adapter returned invalid transcription", "transcription_protocol_error")

    def start_transcription_session(
        self, *, model: str, language: Optional[str], cancellation: CancellationToken
    ) -> NormalizingTranscriptionSession:
        try:
            session = self._streaming_stt(model=model, language=language, cancellation=cancellation)
        except BackendError:
            raise
        except Exception as exc:
            raise BackendError("MLX adapter transcription session failed", "transcription_failed") from exc
        return NormalizingTranscriptionSession(session)


def _normalized_chunks(chunks: Any) -> Iterator[bytes]:
    try:
        if isinstance(chunks, (bytes, bytearray, memoryview)):
            value = normalize_audio_chunk(chunks)
            if value:
                yield value
            return
        for chunk in chunks:
            value = normalize_audio_chunk(chunk)
            if value:
                yield value
    except BackendError:
        raise
    except Exception as exc:
        raise BackendError("MLX adapter returned invalid audio", "backend_protocol_error") from exc


def build_backend(
    tts: Callable[..., Any], stt: Callable[..., Any], streaming_stt: Callable[..., Any]
) -> MlxAudioBackend:
    """Build the combined backend passed to ``VoiceService``."""

    return MlxAudioBackend(MlxAudioEngineTemplate(tts, stt, streaming_stt))
