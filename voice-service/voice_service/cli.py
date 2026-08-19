"""Command-line entry points for registration and serving."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import wave
from pathlib import Path
from typing import Optional, Sequence

from .backend import BackendError, load_backend, load_transcription_backend
from .registry import RegistryError, VoiceProfile, VoiceRegistry, profile_from_values, slugify_voice_id
from .server import VoiceService, serve


def _validate_wav(path: Path) -> None:
    if not path.exists() or not path.is_file():
        raise RegistryError("reference audio does not exist: %s" % path, "reference_invalid")
    try:
        with wave.open(str(path), "rb") as handle:
            if handle.getnchannels() < 1 or handle.getsampwidth() < 1 or handle.getframerate() < 1 or handle.getnframes() < 1:
                raise RegistryError("reference audio must contain WAV samples", "reference_invalid")
    except RegistryError:
        raise
    except (wave.Error, OSError) as exc:
        raise RegistryError("reference audio is not a valid WAV file: %s" % path, "reference_invalid") from exc


def _validate_transcript(path: Path) -> None:
    if not path.exists() or not path.is_file():
        raise RegistryError("reference transcript does not exist: %s" % path, "reference_invalid")
    try:
        value = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as exc:
        raise RegistryError("reference transcript must be readable UTF-8: %s" % path, "reference_invalid") from exc
    if not value:
        raise RegistryError("reference transcript must not be empty", "reference_invalid")


def _copy_atomically(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(destination.parent), prefix=".voice.", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            with source.open("rb") as source_handle:
                shutil.copyfileobj(source_handle, handle)
            handle.flush()
        Path(temporary).replace(destination)
        temporary = None
    finally:
        if temporary:
            try:
                Path(temporary).unlink()
            except OSError:
                pass


def _write_bytes_atomically(destination: Path, value: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(dir=str(destination.parent), prefix=".registry.", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(destination)
        temporary = None
    finally:
        if temporary:
            try:
                Path(temporary).unlink()
            except OSError:
                pass


def _remove_file(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def register_voice(
    *,
    registry_path: Path,
    voice_data_dir: Path,
    audio_source: Path,
    transcript_source: Path,
    name: str,
    model: str,
    voice_id: Optional[str] = None,
    language: str = "en",
    consent: bool = False,
    replace: bool = False,
) -> VoiceProfile:
    """Validate and register a voice, copying references under voice data.

    Consent is intentionally a required argument rather than an implicit
    policy. Callers must make the user's authorization explicit.
    """

    if not consent:
        raise RegistryError(
            "voice registration requires explicit consent confirmation (--consent)",
            "consent_required",
        )
    audio_source = Path(audio_source)
    transcript_source = Path(transcript_source)
    _validate_wav(audio_source)
    _validate_transcript(transcript_source)
    stable_id = voice_id or slugify_voice_id(name)
    stable_id = stable_id.strip().lower()
    profile = profile_from_values(
        stable_id,
        name,
        model,
        "%s/reference.wav" % stable_id,
        "%s/reference.md" % stable_id,
        language,
    )
    registry = VoiceRegistry(Path(registry_path), Path(voice_data_dir))
    if profile.id in {voice.id for voice in registry.list()} and not replace:
        raise RegistryError("voice id already exists: %s" % profile.id, "voice_id_duplicate")
    registry.voice_data_dir.mkdir(parents=True, exist_ok=True)
    audio_destination = registry.voice_data_dir / profile.reference_audio
    transcript_destination = registry.voice_data_dir / profile.reference_text
    audio_destination.parent.mkdir(parents=True, exist_ok=True)
    transcript_destination.parent.mkdir(parents=True, exist_ok=True)
    if not replace and (audio_destination.exists() or transcript_destination.exists()):
        raise RegistryError("voice reference files already exist for %s" % profile.id, "voice_id_duplicate")
    old_registry = registry.registry_path.read_bytes() if registry.registry_path.exists() else None
    stage_dir = Path(tempfile.mkdtemp(prefix=".voice-stage-", dir=str(registry.voice_data_dir)))
    staged_audio = stage_dir / "reference.wav"
    staged_transcript = stage_dir / "reference.md"
    backups = {}
    try:
        # Stage and validate copies before moving any existing user data.
        _copy_atomically(audio_source, staged_audio)
        _copy_atomically(transcript_source, staged_transcript)
        for destination in (audio_destination, transcript_destination):
            if destination.exists() or destination.is_symlink():
                backup = stage_dir / ("old-" + destination.name)
                destination.replace(backup)
                backups[destination] = backup
        staged_audio.replace(audio_destination)
        staged_transcript.replace(transcript_destination)
        registry.add(profile, replace=replace)
    except Exception:
        # Restore both files and the registry, including when --replace was
        # used. A failed registration must not destroy the prior voice.
        _remove_file(audio_destination)
        _remove_file(transcript_destination)
        for destination, backup in backups.items():
            if backup.exists():
                backup.replace(destination)
        if old_registry is None:
            _remove_file(registry.registry_path)
        else:
            _write_bytes_atomically(registry.registry_path, old_registry)
        try:
            registry.reload()
        except RegistryError:
            pass
        raise
    finally:
        shutil.rmtree(str(stage_dir), ignore_errors=True)
    return profile


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="voice-service", description="Standalone Maxx local Voice Service")
    commands = parser.add_subparsers(dest="command", required=True)

    register = commands.add_parser("register", help="validate and register a named custom voice")
    register.add_argument("--name", required=True, help="display name")
    register.add_argument("--id", dest="voice_id", help="stable ID (defaults to a slug of --name)")
    register.add_argument("--model", required=True, help="model identifier used by the synthesis backend")
    register.add_argument("--language", default="en")
    register.add_argument("--audio", type=Path, required=True, help="source WAV file")
    register.add_argument("--transcript", type=Path, required=True, help="UTF-8 transcript file")
    register.add_argument("--registry", type=Path, default=Path("voice-registry.json"))
    register.add_argument("--voice-data-dir", type=Path, default=Path("voice-data"))
    register.add_argument("--consent", action="store_true", help="confirm the user has rights and consent to use this voice")
    register.add_argument("--replace", action="store_true", help="replace an existing voice with the same stable ID")

    serve_parser = commands.add_parser("serve", help="run the HTTP service")
    serve_parser.add_argument("--registry", type=Path, required=True)
    serve_parser.add_argument("--voice-data-dir", type=Path, required=True)
    serve_parser.add_argument("--backend", required=True, help="deterministic or module:object")
    serve_parser.add_argument(
        "--stt-backend",
        help="deterministic-stt or module:object; omit only when --backend exposes STT too",
    )
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8765)
    serve_parser.add_argument(
        "--allow-remote-without-auth",
        action="store_true",
        help="DANGEROUS: allow unauthenticated non-loopback binding on a trusted network",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "register":
            profile = register_voice(
                registry_path=args.registry,
                voice_data_dir=args.voice_data_dir,
                audio_source=args.audio,
                transcript_source=args.transcript,
                name=args.name,
                model=args.model,
                voice_id=args.voice_id,
                language=args.language,
                consent=args.consent,
                replace=args.replace,
            )
            print("registered voice %s (%s)" % (profile.id, profile.name))
            return 0
        registry = VoiceRegistry(args.registry, args.voice_data_dir)
        backend = load_backend(args.backend)
        transcription_backend = load_transcription_backend(args.stt_backend) if args.stt_backend else None
        serve(
            VoiceService(registry, backend, transcription_backend),
            host=args.host,
            port=args.port,
            allow_remote_without_auth=args.allow_remote_without_auth,
        )
        return 0
    except (RegistryError, BackendError, OSError, ValueError) as exc:
        print("voice-service: %s" % exc, file=sys.stderr)
        return 2
