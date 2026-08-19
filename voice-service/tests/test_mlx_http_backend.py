from __future__ import annotations

import io
import json
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from voice_service.backend import (
    BackendError,
    CancellationToken,
    SynthesisRequest,
    TranscriptionRequest,
)
from voice_service.mlx_http_backend import MlxHttpBackend
from voice_service.registry import VoiceProfile, VoiceReference


class MlxHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests = []
    response_body = b"\x01\x02\x03\x04"
    transcription_payload = {"text": "recognized speech"}
    response_status = 200

    def log_message(self, format, *args):
        del format, args

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.__class__.requests.append((self.path, dict(self.headers), body))
        if self.path.endswith("/audio/transcriptions"):
            payload = json.dumps(self.transcription_payload).encode("utf-8")
            content_type = "application/json"
        elif self.path.endswith("/audio/speech"):
            payload = self.response_body
            content_type = "audio/pcm"
        else:
            payload = b"not found"
            content_type = "text/plain"
        self.send_response(self.response_status if self.path.startswith("/v1/") else 404)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)


class MlxHttpBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MlxHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join(timeout=2)
        cls.server.server_close()

    def setUp(self):
        MlxHandler.requests = []
        MlxHandler.response_body = b"\x01\x02\x03\x04"
        MlxHandler.transcription_payload = {"text": "recognized speech"}
        MlxHandler.response_status = 200

    @staticmethod
    def reference() -> VoiceReference:
        profile = VoiceProfile(
            id="scarlett",
            name="Scarlett",
            model="qwen3-tts-base",
            reference_audio="scarlett/reference.wav",
            reference_text="scarlett/reference.md",
            language="en",
        )
        return VoiceReference(
            voice=profile,
            audio_path=Path("/voice-data/scarlett/reference.wav"),
            text_path=Path("/voice-data/scarlett/reference.md"),
            transcript="Reference words.",
        )

    def test_tts_forwards_registered_reference_and_streams_pcm_metadata(self):
        backend = MlxHttpBackend(self.base_url, timeout_seconds=2, tts_sample_rate=24_000, tts_channels=1)
        stream = backend.synthesize(
            SynthesisRequest("hello", self.reference(), "pcm", 1.0), CancellationToken()
        )
        self.assertEqual(b"".join(stream), MlxHandler.response_body)
        self.assertEqual(stream.metadata.sample_rate, 24_000)
        self.assertEqual(stream.metadata.channels, 1)
        path, headers, body = MlxHandler.requests[0]
        self.assertEqual(path, "/v1/audio/speech")
        self.assertEqual(headers["Content-Type"], "application/json")
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(payload["model"], "qwen3-tts-base")
        self.assertEqual(payload["voice"], "scarlett")
        self.assertEqual(payload["ref_audio"], "/voice-data/scarlett/reference.wav")
        self.assertEqual(payload["ref_text"], "Reference words.")
        self.assertTrue(payload["stream"])

    def test_tts_accept_header_matches_non_pcm_format(self):
        backend = MlxHttpBackend(self.base_url, timeout_seconds=2)
        stream = backend.synthesize(
            SynthesisRequest("hello", self.reference(), "wav", 1.0), CancellationToken()
        )
        self.assertEqual(b"".join(stream), MlxHandler.response_body)
        self.assertEqual(MlxHandler.requests[0][1]["Accept"], "audio/wav")

    def test_batch_transcription_sends_audio_model_and_language(self):
        backend = MlxHttpBackend(self.base_url, timeout_seconds=2)
        text = backend.transcribe(
            TranscriptionRequest(b"RIFF-test-audio", "whisper-local", "en"), CancellationToken()
        )
        self.assertEqual(text, "recognized speech")
        path, headers, body = MlxHandler.requests[0]
        self.assertEqual(path, "/v1/audio/transcriptions")
        self.assertIn("multipart/form-data; boundary=", headers["Content-Type"])
        self.assertIn(b'name="model"', body)
        self.assertIn(b"whisper-local", body)
        self.assertIn(b'name="language"', body)
        self.assertIn(b"\r\n\r\nRIFF-test-audio\r\n", body)

    def test_streaming_session_buffers_pcm_and_emits_only_final_event(self):
        backend = MlxHttpBackend(self.base_url, timeout_seconds=2)
        cancellation = CancellationToken()
        session = backend.start_session("whisper-local", "en", cancellation)
        self.assertEqual(tuple(session.accept_audio(b"\x01\x00")), ())
        self.assertEqual(tuple(session.accept_audio(b"\x02\x00")), ())
        events = tuple(session.finish())
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].type, "transcript.done")
        self.assertTrue(events[0].final)
        self.assertEqual(events[0].sequence, 1)
        _, _, body = MlxHandler.requests[0]
        wav_offset = body.index(b"RIFF")
        with wave.open(io.BytesIO(body[wav_offset:]), "rb") as handle:
            self.assertEqual(handle.getframerate(), 16_000)
            self.assertEqual(handle.getnchannels(), 1)
            self.assertEqual(handle.getsampwidth(), 2)
            self.assertEqual(handle.readframes(2), b"\x01\x00\x02\x00")

    def test_streaming_wav_header_does_not_consume_pcm_audio_bound(self):
        backend = MlxHttpBackend(self.base_url, timeout_seconds=2, max_transcription_bytes=2)
        session = backend.start_session("whisper-local", None, CancellationToken())
        session.accept_audio(b"\x01\x00")
        self.assertEqual(tuple(session.finish())[0].text, "recognized speech")

    def test_cancellation_before_tts_and_after_buffering_does_not_call_provider(self):
        cancellation = CancellationToken()
        cancellation.cancel()
        backend = MlxHttpBackend(self.base_url, timeout_seconds=2)
        stream = backend.synthesize(SynthesisRequest("hello", self.reference(), "pcm", 1.0), cancellation)
        self.assertEqual(tuple(stream), ())
        session_cancel = CancellationToken()
        session = backend.start_session("whisper-local", None, session_cancel)
        session.accept_audio(b"\x00\x00")
        session.cancel()
        self.assertEqual(tuple(session.finish()), ())
        self.assertEqual(MlxHandler.requests, [])

    def test_bounds_and_protocol_errors_are_explicit(self):
        backend = MlxHttpBackend(self.base_url, timeout_seconds=2, max_tts_bytes=2, max_transcription_bytes=2)
        MlxHandler.response_body = b"too large"
        with self.assertRaises(BackendError) as tts_error:
            tuple(backend.synthesize(SynthesisRequest("x", self.reference(), "pcm", 1.0), CancellationToken()))
        self.assertEqual(tts_error.exception.code, "backend_protocol_error")
        with self.assertRaises(BackendError) as audio_error:
            backend.transcribe(TranscriptionRequest(b"123", "model", None), CancellationToken())
        self.assertEqual(audio_error.exception.code, "transcription_protocol_error")
        session = backend.start_session("model", None, CancellationToken())
        with self.assertRaises(BackendError):
            session.accept_audio(b"\x00\x00\x00\x00")

    def test_http_and_json_failures_are_not_silent(self):
        backend = MlxHttpBackend(self.base_url, timeout_seconds=2)
        MlxHandler.response_status = 503
        with self.assertRaises(BackendError) as http_error:
            backend.transcribe(TranscriptionRequest(b"audio", "model", None), CancellationToken())
        self.assertEqual(http_error.exception.code, "transcription_failed")
        MlxHandler.response_status = 200
        MlxHandler.transcription_payload = {"unexpected": "shape"}
        with self.assertRaises(BackendError) as json_error:
            backend.transcribe(TranscriptionRequest(b"audio", "model", None), CancellationToken())
        self.assertEqual(json_error.exception.code, "transcription_protocol_error")

    def test_base_url_must_be_loopback_and_environment_settings_apply(self):
        with self.assertRaises(ValueError):
            MlxHttpBackend("http://example.test:8000")
        with mock.patch.dict(
            "os.environ",
            {
                "MLX_AUDIO_BASE_URL": self.base_url,
                "MLX_AUDIO_TTS_SAMPLE_RATE": "22050",
                "MLX_AUDIO_TTS_CHANNELS": "2",
            },
            clear=False,
        ):
            backend = MlxHttpBackend()
        stream = backend.synthesize(SynthesisRequest("x", self.reference(), "pcm", 1.0), CancellationToken())
        self.assertEqual(stream.metadata.sample_rate, 22_050)
        self.assertEqual(stream.metadata.channels, 2)


if __name__ == "__main__":
    unittest.main()
