"""Reusable local Voice Service components."""

from .backend import (
    AudioMetadata,
    AudioStream,
    BackendError,
    CancellationToken,
    DeterministicWavBackend,
    MlxAudioBackend,
    SynthesisBackend,
    SynthesisRequest,
    TranscriptEvent,
    TranscriptionBackend,
    TranscriptionRequest,
    TranscriptionSession,
    DeterministicTranscriptionBackend,
    UnconfiguredTranscriptionBackend,
    UnconfiguredBackend,
)
from .registry import RegistryError, VoiceProfile, VoiceReference, VoiceRegistry
from .server import VoiceHTTPServer, VoiceService, serve

__all__ = [
    "BackendError",
    "AudioMetadata",
    "AudioStream",
    "CancellationToken",
    "DeterministicWavBackend",
    "DeterministicTranscriptionBackend",
    "MlxAudioBackend",
    "RegistryError",
    "SynthesisBackend",
    "SynthesisRequest",
    "TranscriptEvent",
    "TranscriptionBackend",
    "TranscriptionRequest",
    "TranscriptionSession",
    "UnconfiguredBackend",
    "UnconfiguredTranscriptionBackend",
    "VoiceHTTPServer",
    "VoiceProfile",
    "VoiceReference",
    "VoiceRegistry",
    "VoiceService",
    "serve",
]
