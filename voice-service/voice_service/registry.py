"""Stable, file-backed named voice registry.

The registry intentionally stores only paths relative to ``voice_data_dir``.
That keeps voice IDs and registry files portable when a project is moved.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Mapping, Optional, Tuple


VOICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class RegistryError(ValueError):
    """A registry is missing, malformed, or contains an unsafe entry."""

    def __init__(self, message: str, code: str = "registry_invalid") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class VoiceProfile:
    id: str
    name: str
    model: str
    reference_audio: str
    reference_text: str
    language: str

    def public_dict(self) -> Dict[str, str]:
        """Return the API-safe representation (no filesystem paths)."""

        return {
            "id": self.id,
            "name": self.name,
            "model": self.model,
            "language": self.language,
        }

    def registry_dict(self) -> Dict[str, str]:
        return {
            "id": self.id,
            "name": self.name,
            "model": self.model,
            "reference_audio": self.reference_audio,
            "reference_text": self.reference_text,
            "language": self.language,
        }


@dataclass(frozen=True)
class VoiceReference:
    """Resolved reference data handed to a synthesis backend."""

    voice: VoiceProfile
    audio_path: Path
    text_path: Path
    transcript: str


def _non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RegistryError("voice field %r must be a non-empty string" % field)
    return value.strip()


def validate_voice_id(value: str) -> str:
    value = _non_empty_string(value, "id")
    if not VOICE_ID_RE.fullmatch(value):
        raise RegistryError(
            "voice id must match [a-z0-9][a-z0-9_-]{0,63}: %s" % value,
            code="voice_id_invalid",
        )
    return value


def slugify_voice_id(name: str) -> str:
    """Create a deterministic stable ID from a display name."""

    value = _non_empty_string(name, "name").lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    if not value:
        raise RegistryError("voice name does not produce a valid stable id", "voice_id_invalid")
    return validate_voice_id(value)


def _relative_path(value: Any, field: str) -> str:
    value = _non_empty_string(value, field)
    # Registry files are portable across the supported hosts. Reject both POSIX
    # absolute paths and Windows-looking paths rather than normalizing them.
    if "\\" in value or Path(value).is_absolute() or re.match(r"^[A-Za-z]:", value):
        raise RegistryError("voice field %r must be a relative path" % field, "path_invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise RegistryError("voice field %r must not escape voice data" % field, "path_invalid")
    normalized = path.as_posix()
    if normalized in ("", "."):
        raise RegistryError("voice field %r must name a file" % field, "path_invalid")
    return normalized


def _profile_from_mapping(raw: Any) -> VoiceProfile:
    if not isinstance(raw, Mapping):
        raise RegistryError("each voice entry must be an object")
    return VoiceProfile(
        id=validate_voice_id(raw.get("id")),
        name=_non_empty_string(raw.get("name"), "name"),
        model=_non_empty_string(raw.get("model"), "model"),
        reference_audio=_relative_path(raw.get("reference_audio"), "reference_audio"),
        reference_text=_relative_path(raw.get("reference_text"), "reference_text"),
        language=_non_empty_string(raw.get("language", "en"), "language"),
    )


class VoiceRegistry:
    """JSON registry plus a separately configured root for voice data."""

    def __init__(self, registry_path: Path, voice_data_dir: Path) -> None:
        self.registry_path = Path(registry_path)
        self.voice_data_dir = Path(voice_data_dir)
        self._voices: Dict[str, VoiceProfile] = {}
        self.reload()

    def reload(self) -> None:
        if not self.registry_path.exists():
            self._voices = {}
            return
        try:
            with self.registry_path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RegistryError("unable to read voice registry: %s" % exc, "registry_unreadable") from exc
        if not isinstance(raw, Mapping) or not isinstance(raw.get("voices"), list):
            raise RegistryError("voice registry must contain a voices array")

        voices: Dict[str, VoiceProfile] = {}
        for item in raw["voices"]:
            profile = _profile_from_mapping(item)
            if profile.id in voices:
                raise RegistryError("duplicate voice id: %s" % profile.id, "voice_id_duplicate")
            voices[profile.id] = profile
        self._voices = voices

    def list(self) -> List[VoiceProfile]:
        return sorted(self._voices.values(), key=lambda voice: voice.id)

    def get(self, voice_id: str) -> VoiceProfile:
        if not isinstance(voice_id, str) or voice_id not in self._voices:
            raise RegistryError("unknown voice: %s" % voice_id, "voice_not_found")
        return self._voices[voice_id]

    def resolve_reference(self, voice_id: str) -> VoiceReference:
        profile = self.get(voice_id)
        root = self.voice_data_dir.resolve()
        audio_path = (root / profile.reference_audio).resolve()
        text_path = (root / profile.reference_text).resolve()
        for path, label in ((audio_path, "reference audio"), (text_path, "reference transcript")):
            try:
                path.relative_to(root)
            except ValueError as exc:
                raise RegistryError("%s escapes voice data directory" % label, "path_invalid") from exc
            if not path.exists() or not path.is_file():
                raise RegistryError("%s is missing for voice %s" % (label, profile.id), "reference_missing")
        try:
            with wave.open(str(audio_path), "rb") as audio:
                if audio.getnchannels() < 1 or audio.getsampwidth() < 1 or audio.getframerate() < 1 or audio.getnframes() < 1:
                    raise RegistryError("reference audio is invalid for voice %s" % profile.id, "reference_invalid")
        except RegistryError:
            raise
        except (EOFError, wave.Error, OSError) as exc:
            raise RegistryError("reference audio is invalid for voice %s" % profile.id, "reference_invalid") from exc
        try:
            transcript = text_path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            raise RegistryError("reference transcript cannot be read for voice %s" % profile.id, "reference_invalid") from exc
        if not transcript:
            raise RegistryError("reference transcript is empty for voice %s" % profile.id, "reference_invalid")
        return VoiceReference(profile, audio_path, text_path, transcript)

    def add(self, profile: VoiceProfile, replace: bool = False) -> None:
        if profile.id in self._voices and not replace:
            raise RegistryError("voice id already exists: %s" % profile.id, "voice_id_duplicate")
        updated = dict(self._voices)
        updated[profile.id] = profile
        self._write(updated)
        self._voices = updated

    def _write(self, voices: Mapping[str, VoiceProfile]) -> None:
        parent = self.registry_path.parent
        parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "voices": [voices[key].registry_dict() for key in sorted(voices)]}
        temporary: Optional[str] = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=str(parent), prefix=".voices.", suffix=".tmp", delete=False
            ) as handle:
                temporary = handle.name
                json.dump(payload, handle, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.registry_path)
            temporary = None
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass


def profile_from_values(
    voice_id: str,
    name: str,
    model: str,
    reference_audio: str,
    reference_text: str,
    language: str = "en",
) -> VoiceProfile:
    """Build and validate a profile for callers such as the registration CLI."""

    return _profile_from_mapping(
        {
            "id": voice_id,
            "name": name,
            "model": model,
            "reference_audio": reference_audio,
            "reference_text": reference_text,
            "language": language,
        }
    )
