from __future__ import annotations

import http.client
import io
import json
import base64
import socket
import struct
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
from unittest import mock

from voice_service.backend import (
    AudioMetadata,
    AudioStream,
    BackendError,
    CancellationToken,
    DeterministicTranscriptionBackend,
    DeterministicWavBackend,
    SynthesisRequest,
    TranscriptEvent,
    TranscriptionBackend,
    TranscriptionRequest,
    TranscriptionSession,
    UnconfiguredBackend,
)
from voice_service.cli import register_voice
from voice_service.mlx_adapter_template import build_backend
from voice_service.multipart import MultipartError, parse_multipart
from voice_service.registry import RegistryError, VoiceRegistry
from voice_service.server import ServiceError, VoiceHTTPServer, VoiceService, serve
from voice_service.websocket import WebSocketProtocolError, read_frame


def make_wav(path: Path, value: int = 0) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8_000)
        handle.writeframes((value.to_bytes(2, "little", signed=True)) * 80)


def multipart_body(fields: dict, file_bytes: bytes) -> tuple:
    boundary = b"voice-test-boundary"
    chunks = []
    for name, value in fields.items():
        chunks.extend(
            [
                b"--" + boundary + b"\r\n",
                b'Content-Disposition: form-data; name="' + name.encode("ascii") + b'"\r\n\r\n',
                value.encode("utf-8"),
                b"\r\n",
            ]
        )
    chunks.extend(
        [
            b"--" + boundary + b"\r\n",
            b'Content-Disposition: form-data; name="file"; filename="sample.pcm"\r\n',
            b"Content-Type: application/octet-stream\r\n\r\n",
            file_bytes,
            b"\r\n--" + boundary + b"--\r\n",
        ]
    )
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary.decode("ascii")


def client_frame(opcode: int, payload: bytes, masked: bool = True) -> bytes:
    mask = b"\x01\x02\x03\x04"
    length = len(payload)
    if length < 126:
        header = bytes((0x80 | opcode, (0x80 if masked else 0) | length))
    elif length <= 0xFFFF:
        header = bytes((0x80 | opcode, (0x80 if masked else 0) | 126)) + struct.pack("!H", length)
    else:
        header = bytes((0x80 | opcode, (0x80 if masked else 0) | 127)) + struct.pack("!Q", length)
    if not masked:
        return header + payload
    return header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload))


def read_server_frame(sock: socket.socket) -> tuple:
    header = sock.recv(2)
    if len(header) != 2:
        raise AssertionError("missing WebSocket frame")
    length = header[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", sock.recv(8))[0]
    payload = b""
    while len(payload) < length:
        chunk = sock.recv(length - len(payload))
        if not chunk:
            raise AssertionError("truncated WebSocket frame")
        payload += chunk
    return header[0] & 0x0F, payload


class TrackingSession(TranscriptionSession):
    def __init__(self, cancelled: threading.Event) -> None:
        self.cancelled = cancelled
        self.sequence = 0

    def accept_audio(self, audio: bytes):
        self.sequence += 1
        return (TranscriptEvent("transcript.partial", "partial", False, self.sequence),)

    def finish(self):
        self.sequence += 1
        return (TranscriptEvent("transcript.done", "final", True, self.sequence),)

    def cancel(self) -> None:
        self.cancelled.set()


class TrackingBackend(TranscriptionBackend):
    name = "tracking-stt"

    def __init__(self) -> None:
        self.cancelled = threading.Event()

    def transcribe(self, request: TranscriptionRequest, cancellation: CancellationToken) -> str:
        return "batch"

    def start_session(self, model, language, cancellation):
        return TrackingSession(self.cancelled)


class FailingBackend(DeterministicWavBackend):
    name = "failing"

    def synthesize(self, request, cancellation):
        raise BackendError("secret /private/model/path", "backend_failed")


class FailingStreamBackend(DeterministicWavBackend):
    name = "failing-stream"

    def synthesize(self, request, cancellation):
        def chunks():
            raise BackendError("secret /private/model/path", "backend_failed")
            yield b"never"

        return AudioStream(chunks())


class NoMetadataBackend(DeterministicWavBackend):
    name = "no-metadata"

    def synthesize(self, request, cancellation):
        return AudioStream((b"\x00\x00",))


class SecretTranscriptionBackend(TranscriptionBackend):
    name = "secret-stt"

    def transcribe(self, request, cancellation):
        raise BackendError("secret /private/stt/model", "transcription_failed")

    def start_session(self, model, language, cancellation):
        raise BackendError("secret /private/stt/model", "transcription_failed")


class OneByteStream(io.BytesIO):
    def read(self, length=-1):
        return super().read(1 if length > 0 else length)


class VoiceServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "project"
        self.root.mkdir()
        self.sources = self.root / "sources"
        self.sources.mkdir()
        self.registry_path = self.root / "voice-registry.json"
        self.voice_data_dir = self.root / "voice-data"
        self._register("Scarlett", "scarlett", 100)
        self._register("Milo", "milo", 200)

    def tearDown(self) -> None:
        if hasattr(self, "http_server"):
            self.http_server.shutdown()
            self.http_thread.join(timeout=2)
            self.http_server.server_close()
        self.temp_dir.cleanup()

    def _register(self, name: str, voice_id: str, sample: int) -> None:
        audio = self.sources / (voice_id + ".wav")
        transcript = self.sources / (voice_id + ".md")
        make_wav(audio, sample)
        transcript.write_text("Reference for %s." % name, encoding="utf-8")
        register_voice(
            registry_path=self.registry_path,
            voice_data_dir=self.voice_data_dir,
            audio_source=audio,
            transcript_source=transcript,
            name=name,
            model="qwen3-tts-base",
            voice_id=voice_id,
            consent=True,
        )

    def _service(self) -> VoiceService:
        return VoiceService(VoiceRegistry(self.registry_path, self.voice_data_dir), DeterministicWavBackend(chunk_size=17))

    def _start_http(self, service: VoiceService = None) -> str:
        self.http_server = VoiceHTTPServer(("127.0.0.1", 0), service or self._service())
        self.http_thread = threading.Thread(target=self.http_server.serve_forever, daemon=True)
        self.http_thread.start()
        return "http://127.0.0.1:%d" % self.http_server.server_address[1]

    def test_serve_handles_keyboard_interrupt_and_closes_server(self) -> None:
        fake_server = mock.Mock()
        fake_server.serve_forever.side_effect = KeyboardInterrupt
        with mock.patch("voice_service.server.VoiceHTTPServer", return_value=fake_server):
            serve(self._service())
        fake_server.server_close.assert_called_once_with()

    def test_two_voices_are_discoverable_and_selected_independently(self) -> None:
        service = self._service()
        self.assertEqual([voice.id for voice in service.registry.list()], ["milo", "scarlett"])
        result = service.voices()
        self.assertEqual([voice["id"] for voice in result["data"]], ["milo", "scarlett"])
        self.assertNotIn("reference_audio", result["data"][0])

        for voice_id in ("scarlett", "milo"):
            content_type, chunks = service.synthesize(
                {
                    "model": "qwen3-tts-base",
                    "input": "Hello %s" % voice_id,
                    "voice": voice_id,
                    "response_format": "wav",
                },
                CancellationToken(),
            )
            self.assertEqual(content_type, "audio/wav")
            self.assertTrue(b"".join(chunks).startswith(b"RIFF"))

    def test_relocation_and_restart_preserve_ids_and_relative_registry(self) -> None:
        original = json.loads(self.registry_path.read_text(encoding="utf-8"))
        self.assertTrue(all(not Path(item["reference_audio"]).is_absolute() for item in original["voices"]))
        moved = Path(self.temp_dir.name) / "moved-project"
        shutil.move(str(self.root), str(moved))
        restarted = VoiceRegistry(moved / "voice-registry.json", moved / "voice-data")
        self.assertEqual([voice.id for voice in restarted.list()], ["milo", "scarlett"])
        self.assertTrue(restarted.resolve_reference("scarlett").audio_path.is_file())

    def test_missing_and_unknown_voice_are_explicit_errors(self) -> None:
        service = self._service()
        with self.assertRaises(ServiceError) as unknown:
            service.synthesize(
                {"model": "qwen3-tts-base", "input": "hi", "voice": "missing", "response_format": "wav"},
                CancellationToken(),
            )
        self.assertEqual(unknown.exception.code, "voice_not_found")
        (self.voice_data_dir / "scarlett" / "reference.wav").unlink()
        with self.assertRaises(ServiceError) as missing:
            service.synthesize(
                {"model": "qwen3-tts-base", "input": "hi", "voice": "scarlett", "response_format": "wav"},
                CancellationToken(),
            )
        self.assertEqual(missing.exception.code, "reference_missing")
        (self.voice_data_dir / "scarlett" / "reference.wav").write_text("not wav", encoding="utf-8")
        with self.assertRaises(ServiceError) as invalid:
            service.synthesize(
                {"model": "qwen3-tts-base", "input": "hi", "voice": "scarlett", "response_format": "wav"},
                CancellationToken(),
            )
        self.assertEqual(invalid.exception.code, "reference_invalid")

    def test_model_mismatch_and_malformed_request_do_not_fallback(self) -> None:
        service = self._service()
        with self.assertRaises(ServiceError) as mismatch:
            service.synthesize(
                {"model": "other-model", "input": "hi", "voice": "scarlett", "response_format": "wav"},
                CancellationToken(),
            )
        self.assertEqual(mismatch.exception.code, "model_voice_mismatch")
        with self.assertRaises(ServiceError) as malformed:
            service.synthesize({"model": "qwen3-tts-base", "input": "hi"}, CancellationToken())
        self.assertEqual(malformed.exception.code, "invalid_request")

    def test_streaming_http_and_health(self) -> None:
        base = self._start_http()
        with urllib.request.urlopen(base + "/health") as response:
            health = json.loads(response.read().decode("utf-8"))
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["voice_count"], 2)
        with urllib.request.urlopen(base + "/v1/audio/voices") as response:
            self.assertEqual([item["id"] for item in json.loads(response.read())["data"]], ["milo", "scarlett"])

        connection = http.client.HTTPConnection(self.http_server.server_address[0], self.http_server.server_address[1])
        body = json.dumps(
            {
                "model": "qwen3-tts-base",
                "input": "stream this",
                "voice": "milo",
                "response_format": "wav",
                "stream": True,
            }
        )
        connection.request("POST", "/v1/audio/speech", body=body, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Transfer-Encoding"), "chunked")
        self.assertTrue(response.read().startswith(b"RIFF"))
        connection.close()

    def test_health_is_degraded_when_synthesis_is_unconfigured(self) -> None:
        service = VoiceService(VoiceRegistry(self.registry_path, self.voice_data_dir), UnconfiguredBackend())
        health = service.health()
        self.assertEqual(health["status"], "degraded")
        self.assertFalse(health["ready"])
        self.assertFalse(health["synthesis_ready"])
        self.assertFalse(health["transcription_ready"])

        base = self._start_http(service)
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(base + "/health")
        self.assertEqual(raised.exception.code, 503)

    def test_pcm_requires_backend_metadata(self) -> None:
        service = VoiceService(VoiceRegistry(self.registry_path, self.voice_data_dir), NoMetadataBackend())
        with self.assertRaises(ServiceError) as raised:
            service.synthesize(
                {"model": "qwen3-tts-base", "input": "raw", "voice": "milo", "response_format": "pcm"},
                CancellationToken(),
            )
        self.assertEqual(raised.exception.code, "audio_metadata_unavailable")

    def test_remote_bind_requires_explicit_dangerous_opt_in(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-loopback"):
            VoiceHTTPServer(("0.0.0.0", 0), self._service())

    def test_multipart_rejects_non_multipart_and_non_ascii_boundary(self) -> None:
        with self.assertRaises(MultipartError):
            parse_multipart("multipart/form-dataevil; boundary=x", b"--x--")
        with self.assertRaises(MultipartError):
            parse_multipart('multipart/form-data; boundary="é"', b"")

    def test_websocket_exact_reads_and_close_validation(self) -> None:
        self.assertEqual(read_frame(OneByteStream(b"\x82\x80\x01\x02\x03\x04")), (True, 2, b""))
        mask = b"\x01\x02\x03\x04"
        payload = b"\x03\xec"  # reserved close code 1004
        wire = b"\x88\x82" + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        with self.assertRaises(WebSocketProtocolError):
            read_frame(io.BytesIO(wire))
        invalid_utf8 = b"\x03\xe8\xff"  # 1000 plus an invalid UTF-8 reason
        wire = b"\x88\x83" + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(invalid_utf8))
        with self.assertRaises(WebSocketProtocolError):
            read_frame(io.BytesIO(wire))

    def test_replace_failure_preserves_old_references_and_registry(self) -> None:
        old_registry = self.registry_path.read_bytes()
        old_audio = (self.voice_data_dir / "scarlett" / "reference.wav").read_bytes()
        old_text = (self.voice_data_dir / "scarlett" / "reference.md").read_bytes()
        new_audio = self.sources / "replacement.wav"
        new_text = self.sources / "replacement.md"
        make_wav(new_audio, 900)
        new_text.write_text("Replacement reference.", encoding="utf-8")
        with mock.patch.object(VoiceRegistry, "add", side_effect=OSError("registry unavailable")):
            with self.assertRaises(OSError):
                register_voice(
                    registry_path=self.registry_path,
                    voice_data_dir=self.voice_data_dir,
                    audio_source=new_audio,
                    transcript_source=new_text,
                    name="Scarlett replacement",
                    model="qwen3-tts-base",
                    voice_id="scarlett",
                    consent=True,
                    replace=True,
                )
        self.assertEqual(self.registry_path.read_bytes(), old_registry)
        self.assertEqual((self.voice_data_dir / "scarlett" / "reference.wav").read_bytes(), old_audio)
        self.assertEqual((self.voice_data_dir / "scarlett" / "reference.md").read_bytes(), old_text)

    def test_pcm_response_declares_backend_metadata(self) -> None:
        base = self._start_http()
        body = json.dumps(
            {
                "model": "qwen3-tts-base",
                "input": "raw pcm",
                "voice": "milo",
                "response_format": "pcm",
            }
        )
        request = urllib.request.Request(
            base + "/v1/audio/speech", data=body.encode("utf-8"), headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.headers["X-Maxx-Audio-Sample-Rate"], "8000")
            self.assertEqual(response.headers["X-Maxx-Audio-Channels"], "1")
            self.assertEqual(response.headers["X-Maxx-Audio-Sample-Format"], "s16le")
            self.assertTrue(response.read())

    def test_mlx_adapter_normalizes_audio_and_transcript_events(self) -> None:
        class ProviderSession:
            def push(self, audio):
                return [{"text": "partial", "is_final": False}]

            def close(self):
                return [{"text": "final", "type": "done"}]

            def cancel(self):
                return None

        backend = build_backend(
            lambda **kwargs: AudioStream((memoryview(b"encoded"),), AudioMetadata(16_000, 2)),
            lambda **kwargs: {"text": "batch"},
            lambda **kwargs: ProviderSession(),
        )
        reference = VoiceRegistry(self.registry_path, self.voice_data_dir).resolve_reference("milo")
        result = backend.synthesize(SynthesisRequest("hello", reference, "wav", 1.0), CancellationToken())
        self.assertEqual(list(result), [b"encoded"])
        self.assertEqual(result.metadata, AudioMetadata(16_000, 2))
        session = backend.start_session("whisper-local", None, CancellationToken())
        self.assertEqual(session.accept_audio(b"\x00\x00")[0].as_dict(), {
            "type": "transcript.partial", "text": "partial", "final": False, "sequence": 1
        })
        self.assertEqual(session.finish()[0].as_dict(), {
            "type": "transcript.done", "text": "final", "final": True, "sequence": 2
        })

    def test_backend_errors_are_sanitized_and_first_stream_failure_is_503(self) -> None:
        base = self._start_http(
            VoiceService(VoiceRegistry(self.registry_path, self.voice_data_dir), FailingBackend())
        )
        body = json.dumps(
            {"model": "qwen3-tts-base", "input": "hello", "voice": "milo", "response_format": "wav"}
        ).encode("utf-8")
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(
                urllib.request.Request(
                    base + "/v1/audio/speech", data=body, headers={"Content-Type": "application/json"}
                )
            )
        payload = raised.exception.read()
        self.assertEqual(raised.exception.code, 503)
        self.assertNotIn(b"/private/model/path", payload)
        self.assertEqual(json.loads(payload)["error"]["code"], "backend_failed")

        self.http_server.shutdown()
        self.http_thread.join(timeout=2)
        self.http_server.server_close()
        base = self._start_http(
            VoiceService(VoiceRegistry(self.registry_path, self.voice_data_dir), FailingStreamBackend())
        )
        body = json.dumps(
            {
                "model": "qwen3-tts-base",
                "input": "hello",
                "voice": "milo",
                "response_format": "wav",
                "stream": True,
            }
        ).encode("utf-8")
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(
                urllib.request.Request(
                    base + "/v1/audio/speech", data=body, headers={"Content-Type": "application/json"}
                )
            )
        self.assertEqual(raised.exception.code, 503)

    def test_cancellation_stops_stream(self) -> None:
        reference = VoiceRegistry(self.registry_path, self.voice_data_dir).resolve_reference("milo")
        cancellation = CancellationToken()
        cancellation.cancel()
        chunks = DeterministicWavBackend().synthesize(
            SynthesisRequest("hello", reference, "wav", 1.0), cancellation
        )
        self.assertEqual(list(chunks), [])

    def test_batch_transcription_multipart_and_unconfigured_error(self) -> None:
        base = self._start_http(
            VoiceService(
                VoiceRegistry(self.registry_path, self.voice_data_dir),
                DeterministicWavBackend(),
                DeterministicTranscriptionBackend(text="hello batch"),
            )
        )
        body, content_type = multipart_body({"model": "whisper-local", "language": "en"}, b"\x00\x00\x01\x00")
        request = urllib.request.Request(
            base + "/v1/audio/transcriptions",
            data=body,
            headers={"Content-Type": content_type},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            self.assertEqual(json.loads(response.read()), {"text": "hello batch"})

    def test_batch_transcription_requires_explicit_backend(self) -> None:
        base = self._start_http()
        body, content_type = multipart_body({"model": "whisper-local"}, b"\x00\x00")
        request = urllib.request.Request(
            base + "/v1/audio/transcriptions",
            data=body,
            headers={"Content-Type": content_type},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as raised:
            urllib.request.urlopen(request)
        self.assertEqual(raised.exception.code, 503)
        self.assertEqual(json.loads(raised.exception.read())["error"]["code"], "transcription_unavailable")

    def test_transcription_backend_errors_are_sanitized(self) -> None:
        service = VoiceService(
            VoiceRegistry(self.registry_path, self.voice_data_dir),
            DeterministicWavBackend(),
            SecretTranscriptionBackend(),
        )
        with self.assertRaises(ServiceError) as raised:
            service.transcribe_batch({"file": b"\x00\x00", "model": b"whisper-local"}, CancellationToken())
        self.assertEqual(raised.exception.code, "transcription_failed")
        self.assertNotIn("/private/stt/model", raised.exception.message)

    def test_streaming_transcription_partial_and_final_events(self) -> None:
        service = VoiceService(
            VoiceRegistry(self.registry_path, self.voice_data_dir),
            DeterministicWavBackend(),
            DeterministicTranscriptionBackend(text="hello world", partials=["hel", "hello"]),
        )
        self._start_http(service)
        sock = socket.create_connection(self.http_server.server_address, timeout=3)
        key = base64.b64encode(b"0123456789abcdef").decode("ascii")
        sock.sendall(
            (
                "GET /v1/audio/transcriptions/stream?model=whisper-local&language=en HTTP/1.1\r\n"
                "Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n" % key
            ).encode("ascii")
        )
        handshake = b""
        while b"\r\n\r\n" not in handshake:
            handshake += sock.recv(1024)
        self.assertIn(b"101 Switching Protocols", handshake)
        sock.sendall(client_frame(2, b"\x00\x00"))
        event_type, payload = read_server_frame(sock)
        self.assertEqual(event_type, 1)
        self.assertEqual(json.loads(payload), {"type": "transcript.partial", "text": "hel", "final": False, "sequence": 1})
        sock.sendall(client_frame(2, b"\x01\x00"))
        self.assertEqual(json.loads(read_server_frame(sock)[1])["text"], "hello")
        sock.sendall(client_frame(1, json.dumps({"type": "audio.done", "sequence": 2}).encode("utf-8")))
        event_type, payload = read_server_frame(sock)
        self.assertEqual(event_type, 1)
        self.assertEqual(json.loads(payload), {"type": "transcript.done", "text": "hello world", "final": True, "sequence": 3})
        self.assertEqual(read_server_frame(sock)[0], 8)
        sock.close()

    def test_streaming_transcription_rejects_unmasked_and_oversized_frames(self) -> None:
        service = VoiceService(
            VoiceRegistry(self.registry_path, self.voice_data_dir),
            DeterministicWavBackend(),
            DeterministicTranscriptionBackend(),
        )
        self._start_http(service)

        def connect() -> socket.socket:
            sock = socket.create_connection(self.http_server.server_address, timeout=3)
            key = base64.b64encode(b"fedcba9876543210").decode("ascii")
            sock.sendall(
                (
                    "GET /v1/audio/transcriptions/stream?model=whisper-local HTTP/1.1\r\n"
                    "Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n" % key
                ).encode("ascii")
            )
            handshake = b""
            while b"\r\n\r\n" not in handshake:
                handshake += sock.recv(1024)
            return sock

        sock = connect()
        sock.sendall(client_frame(2, b"\x00\x00", masked=False))
        self.assertEqual(json.loads(read_server_frame(sock)[1])["type"], "error")
        sock.close()

        sock = connect()
        # The server rejects this 65537-byte frame from its length before it
        # attempts to read the body, so the test remains bounded.
        sock.sendall(bytes((0x82, 0xFF)) + struct.pack("!Q", 65_537))
        event_type, payload = read_server_frame(sock)
        self.assertEqual(event_type, 1)
        self.assertEqual(json.loads(payload)["code"], "protocol_error")
        sock.close()

    def test_streaming_transcription_disconnect_cancels_session(self) -> None:
        backend = TrackingBackend()
        self._start_http(
            VoiceService(VoiceRegistry(self.registry_path, self.voice_data_dir), DeterministicWavBackend(), backend)
        )
        sock = socket.create_connection(self.http_server.server_address, timeout=3)
        key = base64.b64encode(b"abcdefghijklmnop").decode("ascii")
        sock.sendall(
            (
                "GET /v1/audio/transcriptions/stream?model=whisper-local HTTP/1.1\r\n"
                "Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n" % key
            ).encode("ascii")
        )
        handshake = b""
        while b"\r\n\r\n" not in handshake:
            handshake += sock.recv(1024)
        sock.sendall(client_frame(2, b"\x00\x00"))
        read_server_frame(sock)
        sock.close()
        self.assertTrue(backend.cancelled.wait(timeout=2))

    def test_registration_requires_consent_and_valid_wav(self) -> None:
        audio = self.sources / "bad.wav"
        audio.write_text("not a wav", encoding="utf-8")
        transcript = self.sources / "bad.md"
        transcript.write_text("text", encoding="utf-8")
        with self.assertRaises(RegistryError) as consent:
            register_voice(
                registry_path=self.registry_path,
                voice_data_dir=self.voice_data_dir,
                audio_source=audio,
                transcript_source=transcript,
                name="Bad",
                model="qwen3-tts-base",
                consent=False,
            )
        self.assertEqual(consent.exception.code, "consent_required")
        with self.assertRaises(RegistryError) as invalid:
            register_voice(
                registry_path=self.registry_path,
                voice_data_dir=self.voice_data_dir,
                audio_source=audio,
                transcript_source=transcript,
                name="Bad",
                model="qwen3-tts-base",
                consent=True,
            )
        self.assertEqual(invalid.exception.code, "reference_invalid")


if __name__ == "__main__":
    unittest.main()
