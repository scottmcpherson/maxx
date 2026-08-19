//! Voice dictation: microphone audio from the webview, streamed to xAI's
//! speech-to-text endpoint, transcripts pushed back as `voice://event`.
//!
//! Capture itself lives in the frontend — WebKit already owns an audio stack
//! and `getUserMedia`, so there is no CoreAudio code here. What Rust owns is
//! everything the webview must not: the credential, the socket, and the
//! session state machine.
//!
//! Only one dictation session can exist at a time (there is one microphone).
//! Each is issued a monotonic id; audio chunks name their session so a late
//! chunk from a stopped session is dropped rather than mixed into the next one.
//!
//! The session is a toggle, not a hold, which drives three design points a
//! push-to-talk implementation would not need:
//!   * a socket may outlive the server's connection cap, so a benign close
//!     while still listening transparently reconnects;
//!   * "left the microphone on" is a real cost, so an idle timer ends a
//!     session that has stopped hearing speech;
//!   * stopping drains rather than aborts, so the last thing said still lands.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use maxx_core::voice::{
    microphone_help, parse_grok_credential, SttProvider, SttServerEvent, Transcript,
    TranscriptStitcher, VoiceSettings, IDLE_TIMEOUT_SECS, NO_SPEECH_TIMEOUT_SECS,
};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::{Error as WsError, ProtocolError};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::events::{emit_ephemeral as emit_event, EventSink};
use crate::state::AppState;

/// Audio chunks buffered while a socket is being (re)established. At the
/// frontend's ~100 ms cadence this is about 25 seconds — far more than any
/// real connect, so in practice nothing is ever dropped; it only bounds a
/// pathological hang.
const BACKLOG_MAX_CHUNKS: usize = 256;
const MAX_AUDIO_CHUNK_BYTES: usize = 16 * 1024;
/// Audio IPC requests are allowed to arrive a little out of order because
/// local and remote JSON dispatch each run requests concurrently. Keep the
/// acceptance window and bytes bounded so a missing sequence cannot turn into
/// an unbounded allocation.
const AUDIO_REORDER_WINDOW: u64 = 8;
const AUDIO_REORDER_MAX_BYTES: usize = 64 * 1024;

const MAX_TTS_TEXT_BYTES: usize = 100_000;
const MAX_TTS_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TTS_CATALOG_BYTES: usize = 1 * 1024 * 1024;
const MAX_TTS_ERROR_BYTES: usize = 64 * 1024;
const MAX_TTS_READ_BYTES: usize = 256 * 1024;
const TTS_QUEUE_CAPACITY: usize = 32;
const TTS_PROVIDER_CHUNK_BYTES: usize = 64 * 1024;
const TTS_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TTS_READ_TIMEOUT: Duration = Duration::from_secs(30);
const TTS_MAX_SESSIONS: usize = 32;
/// A renderer phrase normally drains continuously. If it disappears after
/// `voice_tts_start`, this bounds the producer's wait on the full queue.
const TTS_SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Also bound a renderer that keeps a session open without completing or
/// cancelling it, even if it performs occasional reads.
const TTS_SESSION_LIFETIME: Duration = Duration::from_secs(5 * 60);

/// How long to keep reading after the user stops, waiting for the trailing
/// `speech_final`. Pressing stop must not discard the last sentence.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

/// Reconnect attempts before a session gives up. A toggle session can outlive
/// the server's connection cap; a hot loop would be worse than stopping.
const MAX_RECONNECTS: u32 = 3;

const XAI_API_KEY_ENV: &str = "XAI_API_KEY";

// ---------------------------------------------------------------------------
// Events to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceSessionState {
    Connecting,
    Listening,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoiceEvent {
    State {
        session: u64,
        state: VoiceSessionState,
    },
    /// Live preview. Replaces the previous preview for this session.
    Interim { session: u64, text: String },
    /// Utterance complete. Freezes into the draft.
    Final { session: u64, text: String },
    Error {
        session: u64,
        code: String,
        message: String,
        hint: Option<String>,
    },
    Telemetry {
        session: u64,
        metric: String,
        value: u64,
    },
}

fn voice_emit(events: &dyn EventSink, event: VoiceEvent) {
    emit_event(events, "voice://event", &event);
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/// Where a bearer came from. Shown in Settings so the user can see which
/// credential dictation will actually use.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCredentialStatus {
    /// `grokSignIn`, `environment`, or `none`.
    pub source: String,
    /// Human-readable detail — the signed-in address, or why nothing resolved.
    pub detail: String,
    pub available: bool,
    pub provider: SttProvider,
    pub endpoint: String,
    pub model: String,
}

struct ResolvedBearer {
    bearer: String,
    status: VoiceCredentialStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProviderTestResult {
    pub provider: SttProvider,
    pub endpoint: String,
    pub model: String,
    pub ok: bool,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalog {
    pub voices: Vec<VoiceCatalogEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalogEntry {
    pub id: String,
    pub name: String,
    pub model: String,
    pub language: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTtsDescriptor {
    pub session: u64,
    pub mime_type: String,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTtsError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTtsReadResult {
    pub chunks: Vec<VoiceTtsChunk>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTtsChunk {
    pub sequence: u64,
    pub chunk: String,
}

#[derive(Debug, Deserialize)]
struct RawVoiceCatalog {
    object: String,
    data: Vec<RawVoiceCatalogEntry>,
}

#[derive(Debug, Deserialize)]
struct RawVoiceCatalogEntry {
    id: String,
    name: String,
    model: String,
    language: String,
}

#[derive(Debug, Deserialize)]
struct ProviderErrorEnvelope {
    error: ProviderErrorBody,
}

#[derive(Debug, Deserialize)]
struct ProviderErrorBody {
    message: Option<String>,
    code: Option<String>,
    #[serde(rename = "type")]
    error_type: Option<String>,
}

/// Hand-written so a log line, a panic message or an `unwrap` in a test can
/// never print the token. Deriving `Debug` here would make the secret one
/// stray `{:?}` away from a log file.
impl std::fmt::Debug for ResolvedBearer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedBearer")
            .field("bearer", &"<redacted>")
            .field("status", &self.status)
            .finish()
    }
}

fn grok_auth_path() -> Option<std::path::PathBuf> {
    Some(dirs::home_dir()?.join(".grok").join("auth.json"))
}

/// Resolve the bearer for an STT connection.
///
/// The Grok sign-in is tried first when the user opted in, then `XAI_API_KEY`.
/// Resolution happens per connection, never once at startup: these tokens
/// rotate, and a session that reconnects an hour later must not present the
/// token it captured when it began.
fn resolve_bearer(settings: &VoiceSettings) -> Result<ResolvedBearer, VoiceCredentialStatus> {
    if settings.use_grok_sign_in {
        if let Some(path) = grok_auth_path() {
            match std::fs::read_to_string(&path) {
                Ok(source) => {
                    if let Some(credential) = parse_grok_credential(&source) {
                        let detail = credential
                            .email
                            .clone()
                            .map(|email| format!("Signed in as {email}"))
                            .unwrap_or_else(|| "Using your Grok sign-in".to_string());
                        return Ok(ResolvedBearer {
                            bearer: credential.bearer,
                            status: VoiceCredentialStatus {
                                source: "grokSignIn".into(),
                                detail,
                                available: true,
                                provider: settings.stt_provider,
                                endpoint: settings.stt_api_base.clone(),
                                model: settings.stt_model.clone(),
                            },
                        });
                    }
                    log::warn!("grok auth.json present but not in a shape we recognise");
                }
                Err(error) => {
                    log::debug!("grok auth.json unreadable: {error}");
                }
            }
        }
    }

    match std::env::var(XAI_API_KEY_ENV) {
        Ok(key) if !key.trim().is_empty() => Ok(ResolvedBearer {
            bearer: key.trim().to_string(),
            status: VoiceCredentialStatus {
                source: "environment".into(),
                detail: format!("Using {XAI_API_KEY_ENV}"),
                available: true,
                provider: settings.stt_provider,
                endpoint: settings.stt_api_base.clone(),
                model: settings.stt_model.clone(),
            },
        }),
        _ => Err(VoiceCredentialStatus {
            source: "none".into(),
            detail: if settings.use_grok_sign_in {
                "No Grok sign-in found. Run `grok login`, or set XAI_API_KEY.".into()
            } else {
                "Turn on “Use my Grok sign-in”, or set XAI_API_KEY.".into()
            },
            available: false,
            provider: settings.stt_provider,
            endpoint: settings.stt_api_base.clone(),
            model: settings.stt_model.clone(),
        }),
    }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

struct ActiveSession {
    id: u64,
    audio: mpsc::Sender<AudioChunk>,
    stop: mpsc::Sender<()>,
    task: JoinHandle<()>,
    audio_reorder: AudioReorderBuffer,
    overflow_reported: bool,
    events: Arc<dyn EventSink>,
}

struct AudioChunk {
    sequence: u64,
    bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
enum AudioIngressError {
    Sequence(String),
    ReorderFull(String),
    QueueFull,
    Closed,
}

impl AudioIngressError {
    fn message(&self) -> String {
        match self {
            Self::Sequence(message) | Self::ReorderFull(message) => message.clone(),
            Self::QueueFull => "voice audio queue is full; transcription cannot keep up".into(),
            Self::Closed => "voice transcription session is no longer accepting audio".into(),
        }
    }
}

#[derive(Default)]
struct AudioReorderBuffer {
    next_sequence: u64,
    pending: BTreeMap<u64, AudioChunk>,
    pending_bytes: usize,
}

impl AudioReorderBuffer {
    fn accept(
        &mut self,
        audio: &mpsc::Sender<AudioChunk>,
        sequence: u64,
        bytes: Vec<u8>,
    ) -> Result<(), AudioIngressError> {
        // A prior contiguous run may have been held by a full channel. Try it
        // first on every request so queue recovery also flushes staged audio.
        self.flush(audio)?;

        if sequence < self.next_sequence {
            return Err(AudioIngressError::Sequence(format!(
                "audio sequence {sequence} is stale or duplicated; next expected sequence is {}",
                self.next_sequence
            )));
        }
        if sequence.saturating_sub(self.next_sequence) >= AUDIO_REORDER_WINDOW {
            return Err(AudioIngressError::Sequence(format!(
                "audio sequence {sequence} is too far ahead; next expected sequence is {} and the reorder window is {AUDIO_REORDER_WINDOW}",
                self.next_sequence
            )));
        }
        if self.pending.contains_key(&sequence) {
            return Err(AudioIngressError::Sequence(format!(
                "audio sequence {sequence} is duplicated while waiting for sequence {}",
                self.next_sequence
            )));
        }

        if sequence == self.next_sequence {
            match audio.try_send(AudioChunk { sequence, bytes }) {
                Ok(()) => {
                    self.next_sequence = self.next_sequence.saturating_add(1);
                    self.flush(audio)
                }
                Err(mpsc::error::TrySendError::Full(_)) => Err(AudioIngressError::QueueFull),
                Err(mpsc::error::TrySendError::Closed(_)) => Err(AudioIngressError::Closed),
            }
        } else {
            if self.pending_bytes.saturating_add(bytes.len()) > AUDIO_REORDER_MAX_BYTES {
                return Err(AudioIngressError::ReorderFull(format!(
                    "voice audio reorder buffer is full; missing sequence {} must arrive before more audio can be accepted",
                    self.next_sequence
                )));
            }
            self.pending_bytes += bytes.len();
            self.pending
                .insert(sequence, AudioChunk { sequence, bytes });
            Ok(())
        }
    }

    fn flush(&mut self, audio: &mpsc::Sender<AudioChunk>) -> Result<(), AudioIngressError> {
        loop {
            let sequence = self.next_sequence;
            let Some(chunk) = self.pending.remove(&sequence) else {
                return Ok(());
            };
            self.pending_bytes = self.pending_bytes.saturating_sub(chunk.bytes.len());
            match audio.try_send(chunk) {
                Ok(()) => self.next_sequence = self.next_sequence.saturating_add(1),
                Err(mpsc::error::TrySendError::Full(chunk)) => {
                    self.pending_bytes += chunk.bytes.len();
                    self.pending.insert(sequence, chunk);
                    return Err(AudioIngressError::QueueFull);
                }
                Err(mpsc::error::TrySendError::Closed(_)) => return Err(AudioIngressError::Closed),
            }
        }
    }
}

struct TtsSession {
    frame_bytes: usize,
    cancel: CancellationToken,
    reader: Mutex<TtsReadState>,
    task: Mutex<Option<JoinHandle<()>>>,
    created_at: Instant,
    last_activity: StdMutex<Instant>,
}

struct TtsReadState {
    receiver: mpsc::Receiver<TtsMessage>,
    pending: Vec<u8>,
    next_sequence: i64,
    terminal: Option<TtsTerminal>,
}

enum TtsMessage {
    Audio(Vec<u8>),
    Done,
    Error(VoiceTtsError),
}

enum TtsTerminal {
    Done,
    Error(VoiceTtsError),
}

#[derive(Default)]
pub struct VoiceState {
    active: Mutex<Option<ActiveSession>>,
    tts_sessions: Mutex<HashMap<u64, Arc<TtsSession>>>,
    next_id: AtomicU64,
}

impl VoiceState {
    /// Install rustls' ring provider. rustls 0.23 refuses to pick a backend on
    /// its own, and the failure would otherwise surface as an opaque TLS error
    /// at the first connect.
    pub fn install_crypto_provider() {
        // `Err` means another component already installed one — equally fine.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Whether dictation can currently connect, and with which credential.
/// Drives the Settings status row; never returns the token itself.
pub async fn voice_status(
    state: Arc<AppState>,
    settings_override: Option<VoiceSettings>,
) -> Result<VoiceCredentialStatus, String> {
    let settings = match settings_override {
        Some(settings) => settings,
        None => state.workspace.lock().await.voice.clone(),
    };
    if settings.stt_provider == SttProvider::OpenaiCompatible {
        if settings.stt_api_base.trim().is_empty() {
            return Ok(VoiceCredentialStatus {
                source: "none".into(),
                detail: "Configure an OpenAI-compatible STT endpoint before testing dictation."
                    .into(),
                available: false,
                provider: settings.stt_provider,
                endpoint: settings.stt_api_base,
                model: settings.stt_model,
            });
        }
        if settings.stt_ws_url().is_err() {
            return Ok(VoiceCredentialStatus {
                source: "none".into(),
                detail: "The OpenAI-compatible STT endpoint is invalid.".into(),
                available: false,
                provider: settings.stt_provider,
                endpoint: settings.stt_api_base,
                model: settings.stt_model,
            });
        }
        return Ok(VoiceCredentialStatus {
            source: "none".into(),
            detail: "OpenAI-compatible STT is configured; no credential is required by Maxx."
                .into(),
            available: true,
            provider: settings.stt_provider,
            endpoint: settings.stt_api_base,
            model: settings.stt_model,
        });
    }
    if let Err(detail) = settings.stt_ws_url() {
        return Ok(VoiceCredentialStatus {
            source: "none".into(),
            detail,
            available: false,
            provider: settings.stt_provider,
            endpoint: settings.stt_api_base,
            model: settings.stt_model,
        });
    }
    Ok(match resolve_bearer(&settings) {
        Ok(resolved) => resolved.status,
        Err(status) => status,
    })
}

/// Open and close the selected provider's streaming STT connection. This is a
/// real transport check, not a settings-only validation, and never returns a
/// credential or raw provider response body.
pub async fn voice_test_stt(
    state: Arc<AppState>,
    settings_override: Option<VoiceSettings>,
) -> Result<VoiceProviderTestResult, String> {
    let settings = match settings_override {
        Some(settings) => settings,
        None => state.workspace.lock().await.voice.clone(),
    };
    if settings.stt_provider == SttProvider::OpenaiCompatible
        && settings.stt_model.trim().is_empty()
    {
        return Ok(VoiceProviderTestResult {
            provider: settings.stt_provider,
            endpoint: settings.stt_api_base,
            model: settings.stt_model,
            ok: false,
            code: "stt_model_missing".into(),
            message: "Choose an STT model before testing the OpenAI-compatible service.".into(),
        });
    }
    let endpoint = match settings.stt_ws_url() {
        Ok(endpoint) => endpoint,
        Err(message) => {
            return Ok(VoiceProviderTestResult {
                provider: settings.stt_provider,
                endpoint: settings.stt_api_base,
                model: settings.stt_model,
                ok: false,
                code: "stt_endpoint_invalid".into(),
                message,
            });
        }
    };
    let bearer = match settings.stt_provider {
        SttProvider::Xai => match resolve_bearer(&settings) {
            Ok(resolved) => Some(resolved.bearer),
            Err(status) => {
                return Ok(VoiceProviderTestResult {
                    provider: settings.stt_provider,
                    endpoint,
                    model: settings.stt_model,
                    ok: false,
                    code: "credential_missing".into(),
                    message: status.detail,
                });
            }
        },
        SttProvider::OpenaiCompatible => None,
    };
    match connect(&endpoint, bearer.as_deref(), settings.stt_provider).await {
        Ok(mut socket) => {
            let _ = socket.close(None).await;
            Ok(VoiceProviderTestResult {
                provider: settings.stt_provider,
                endpoint,
                model: settings.stt_model,
                ok: true,
                code: "ok".into(),
                message: "The streaming STT endpoint accepted a connection.".into(),
            })
        }
        Err(error) => Ok(VoiceProviderTestResult {
            provider: settings.stt_provider,
            endpoint,
            model: settings.stt_model,
            ok: false,
            code: "stt_connection_failed".into(),
            message: error,
        }),
    }
}

pub async fn update_voice_settings(
    state: Arc<AppState>,
    settings: VoiceSettings,
) -> Result<VoiceSettings, String> {
    // Validate before storing so a bad endpoint is rejected at the point the
    // user typed it, not at the first attempt to dictate.
    validate_voice_settings_for_save(&settings)?;
    {
        let mut workspace = state.workspace.lock().await;
        workspace.voice = settings.clone();
    }
    state.save().await;
    Ok(settings)
}

fn validate_voice_settings_for_save(settings: &VoiceSettings) -> Result<(), String> {
    if settings.stt_provider == SttProvider::Xai || !settings.stt_api_base.trim().is_empty() {
        settings.stt_ws_url()?;
    }
    // Incomplete TTS setup is valid while the form is being filled in, but a
    // nonempty endpoint must already be structurally safe to persist.
    if !settings.tts_api_base.trim().is_empty() {
        settings.tts_voices_url()?;
    }
    Ok(())
}

/// Discover stable voice IDs from the selected OpenAI-compatible service.
/// Reference paths and other provider-private fields are intentionally not
/// copied into the Maxx contract.
pub async fn voice_list_voices(
    state: Arc<AppState>,
    settings_override: Option<VoiceSettings>,
) -> Result<Vec<VoiceCatalogEntry>, String> {
    let settings = voice_settings(&state, settings_override).await;
    let endpoint = settings.tts_voices_url()?;
    let client = tts_http_client()?;
    let response = tokio::time::timeout(TTS_CONNECT_TIMEOUT, client.get(endpoint).send())
        .await
        .map_err(|_| "Timed out connecting to the voice catalog.".to_string())?
        .map_err(|error| format!("Could not reach the voice catalog: {error}"))?;
    let body = response_body_or_error(response, MAX_TTS_CATALOG_BYTES, "voice catalog").await?;
    Ok(parse_voice_catalog(&body)?.voices)
}

/// Start one independent streaming TTS phrase. Multiple sessions may coexist;
/// each has its own bounded queue and cancellation token, so sequential
/// sentence requests cannot mix bytes with one another.
pub async fn voice_tts_start(
    state: Arc<AppState>,
    voice: Arc<VoiceState>,
    settings_override: Option<VoiceSettings>,
    text: String,
    requested_voice: Option<String>,
) -> Result<VoiceTtsDescriptor, String> {
    let settings = voice_settings(&state, settings_override).await;
    let endpoint = settings.tts_speech_url()?;
    let model = require_nonempty(&settings.tts_model, "Choose a TTS model before speaking.")?;
    if text.trim().is_empty() {
        return Err("Speech text cannot be empty.".into());
    }
    if text.len() > MAX_TTS_TEXT_BYTES {
        return Err(format!(
            "Speech text is too long (maximum is {MAX_TTS_TEXT_BYTES} bytes)."
        ));
    }
    let voice_id = requested_voice
        .and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        })
        .or_else(|| {
            let value = settings.voice_id.trim().to_string();
            (!value.is_empty()).then_some(value)
        })
        .ok_or_else(|| "Choose a voice before speaking.".to_string())?;
    if voice_id.len() > 256 {
        return Err("Voice ID is too long.".into());
    }
    if voice.tts_sessions.lock().await.len() >= TTS_MAX_SESSIONS {
        return Err("Too many speech phrases are active; cancel one and try again.".into());
    }

    let body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice_id,
        "response_format": "pcm",
        "stream": true,
    });
    let client = tts_http_client()?;
    let response = tokio::time::timeout(
        TTS_CONNECT_TIMEOUT,
        client.post(endpoint).json(&body).send(),
    )
    .await
    .map_err(|_| "Timed out connecting to the speech service.".to_string())?
    .map_err(|error| format!("Could not reach the speech service: {error}"))?;
    if !response.status().is_success() {
        return Err(provider_response_error(response, "speech synthesis").await);
    }
    let metadata = parse_pcm_metadata(response.headers())?;
    let frame_bytes = metadata.channels as usize * 2;
    let session_id = voice.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = CancellationToken::new();
    let (sender, receiver) = mpsc::channel(TTS_QUEUE_CAPACITY);
    let producer_cancel = cancel.clone();
    let created_at = Instant::now();
    let task = tokio::spawn(stream_tts_response(
        response,
        sender,
        producer_cancel,
        frame_bytes,
    ));
    let session = Arc::new(TtsSession {
        frame_bytes,
        cancel,
        reader: Mutex::new(TtsReadState {
            receiver,
            pending: Vec::new(),
            next_sequence: -1,
            terminal: None,
        }),
        task: Mutex::new(Some(task)),
        created_at,
        last_activity: StdMutex::new(created_at),
    });
    let mut sessions = voice.tts_sessions.lock().await;
    if sessions.len() >= TTS_MAX_SESSIONS {
        drop(sessions);
        cancel_tts_session(&session).await;
        return Err("Too many speech phrases are active; cancel one and try again.".into());
    }
    sessions.insert(session_id, session.clone());
    spawn_tts_session_cleanup(&voice, session_id, &session);
    Ok(VoiceTtsDescriptor {
        session: session_id,
        mime_type: metadata.content_type,
        sample_rate: metadata.sample_rate,
        channels: metadata.channels,
    })
}

/// Read ordered PCM chunks. `after_sequence` is the last delivered chunk
/// sequence, not a byte cursor, and is checked before consuming the queue.
pub async fn voice_tts_read(
    voice: Arc<VoiceState>,
    session_id: u64,
    after_sequence: i64,
    max_bytes: usize,
) -> Result<VoiceTtsReadResult, String> {
    let session = voice
        .tts_sessions
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "Speech session is no longer active.".to_string())?;
    if max_bytes == 0 || max_bytes > MAX_TTS_READ_BYTES {
        return Err(format!(
            "maxBytes must be between 1 and {MAX_TTS_READ_BYTES}."
        ));
    }
    if session.cancel.is_cancelled() {
        return Ok(cancelled_tts_read_result());
    }
    *session
        .last_activity
        .lock()
        .expect("TTS activity lock poisoned") = Instant::now();
    let mut state = session.reader.lock().await;
    if after_sequence != state.next_sequence {
        return Err(format!(
            "speech sequence {after_sequence} is out of order; expected {}",
            state.next_sequence
        ));
    }
    let limit = max_bytes - max_bytes % session.frame_bytes;
    if limit == 0 {
        return Err(format!(
            "maxBytes must hold at least one PCM frame ({} bytes).",
            session.frame_bytes
        ));
    }
    let mut chunks = Vec::new();
    let mut bytes_read = 0usize;
    while bytes_read < limit && state.terminal.is_none() {
        if session.cancel.is_cancelled() {
            return Ok(cancelled_tts_read_result());
        }
        if state.pending.is_empty() {
            let message = if chunks.is_empty() {
                tokio::select! {
                    biased;
                    _ = session.cancel.cancelled() => return Ok(cancelled_tts_read_result()),
                    message = state.receiver.recv() => message,
                }
            } else {
                if session.cancel.is_cancelled() {
                    return Ok(cancelled_tts_read_result());
                }
                match state.receiver.try_recv() {
                    Ok(message) => Some(message),
                    Err(mpsc::error::TryRecvError::Empty) => None,
                    Err(mpsc::error::TryRecvError::Disconnected) => None,
                }
            };
            if session.cancel.is_cancelled() {
                return Ok(cancelled_tts_read_result());
            }
            let Some(message) = message else {
                if chunks.is_empty() {
                    state.terminal = Some(TtsTerminal::Error(VoiceTtsError {
                        code: "tts_stream_closed".into(),
                        message: "The speech service closed the audio stream unexpectedly.".into(),
                    }));
                }
                break;
            };
            match message {
                TtsMessage::Audio(bytes) => state.pending = bytes,
                TtsMessage::Done => state.terminal = Some(TtsTerminal::Done),
                TtsMessage::Error(error) => state.terminal = Some(TtsTerminal::Error(error)),
            }
        }
        if state.pending.is_empty() {
            continue;
        }
        let remaining = limit - bytes_read;
        let byte_count = state.pending.len().min(remaining);
        let byte_count = byte_count - byte_count % session.frame_bytes;
        if byte_count == 0 {
            return Err("The speech service returned an incomplete PCM frame.".into());
        }
        let bytes = state.pending.drain(..byte_count).collect::<Vec<_>>();
        if session.cancel.is_cancelled() {
            return Ok(cancelled_tts_read_result());
        }
        bytes_read += byte_count;
        let sequence = state.next_sequence.saturating_add(1);
        state.next_sequence = sequence;
        chunks.push(VoiceTtsChunk {
            sequence: sequence as u64,
            chunk: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    if session.cancel.is_cancelled() {
        return Ok(cancelled_tts_read_result());
    }
    let terminal = state.terminal.take();
    let done = terminal.is_some() && state.pending.is_empty();
    let error = match terminal {
        Some(TtsTerminal::Error(error)) => Some(format!("{}: {}", error.code, error.message)),
        _ => None,
    };
    if done {
        drop(state);
        let _ = remove_tts_session_if_current(&voice, session_id, &session).await;
    }
    Ok(VoiceTtsReadResult {
        chunks,
        done,
        error,
    })
}

fn cancelled_tts_read_result() -> VoiceTtsReadResult {
    VoiceTtsReadResult {
        chunks: Vec::new(),
        done: true,
        error: None,
    }
}

/// Cancel an active phrase. Cancellation is idempotent so a stale renderer
/// stop cannot affect a newer phrase or report a spurious failure.
pub async fn voice_tts_cancel(voice: Arc<VoiceState>, session_id: u64) -> Result<(), String> {
    let Some(session) = voice.tts_sessions.lock().await.remove(&session_id) else {
        return Ok(());
    };
    cancel_tts_session(&session).await;
    Ok(())
}

fn spawn_tts_session_cleanup(voice: &Arc<VoiceState>, session_id: u64, session: &Arc<TtsSession>) {
    let voice = Arc::clone(voice);
    let session = Arc::downgrade(session);
    tokio::spawn(cleanup_tts_session(
        voice,
        session_id,
        session,
        TTS_SESSION_IDLE_TIMEOUT,
        TTS_SESSION_LIFETIME,
    ));
}

async fn cleanup_tts_session(
    voice: Arc<VoiceState>,
    session_id: u64,
    session: Weak<TtsSession>,
    idle_timeout: Duration,
    lifetime: Duration,
) {
    loop {
        let Some(session) = session.upgrade() else {
            return;
        };
        let now = Instant::now();
        let last_activity = *session
            .last_activity
            .lock()
            .expect("TTS activity lock poisoned");
        let idle = now.saturating_duration_since(last_activity);
        let age = now.saturating_duration_since(session.created_at);
        if idle >= idle_timeout || age >= lifetime {
            if remove_tts_session_if_current(&voice, session_id, &session).await {
                cancel_tts_session(&session).await;
            }
            return;
        }
        let until_idle = idle_timeout.saturating_sub(idle);
        let until_expiry = lifetime.saturating_sub(age);
        tokio::time::sleep(until_idle.min(until_expiry)).await;
    }
}

async fn remove_tts_session_if_current(
    voice: &VoiceState,
    session_id: u64,
    expected: &Arc<TtsSession>,
) -> bool {
    let mut sessions = voice.tts_sessions.lock().await;
    let is_current = sessions
        .get(&session_id)
        .is_some_and(|current| Arc::ptr_eq(current, expected));
    if is_current {
        sessions.remove(&session_id);
    }
    is_current
}

async fn cancel_tts_session(session: &Arc<TtsSession>) {
    session.cancel.cancel();
    if let Some(task) = session.task.lock().await.take() {
        task.abort();
        let _ = task.await;
    }
}

async fn voice_settings(
    state: &Arc<AppState>,
    settings_override: Option<VoiceSettings>,
) -> VoiceSettings {
    match settings_override {
        Some(settings) => settings,
        None => state.workspace.lock().await.voice.clone(),
    }
}

fn require_nonempty(value: &str, message: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(message.into())
    } else {
        Ok(value.to_string())
    }
}

#[derive(Debug, Clone)]
struct PcmMetadata {
    sample_rate: u32,
    channels: u16,
    content_type: String,
}

fn tts_http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(TTS_CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("Could not initialize the speech HTTP client: {error}"))
}

fn parse_pcm_metadata(headers: &reqwest::header::HeaderMap) -> Result<PcmMetadata, String> {
    let content_type = required_header(headers, "content-type")?;
    let media_type = content_type
        .split(';')
        .next()
        .map(str::trim)
        .unwrap_or_default();
    if !media_type.eq_ignore_ascii_case("audio/pcm") {
        return Err("Speech service returned a non-PCM audio content type.".into());
    }
    let sample_rate = parse_positive_header(headers, "x-maxx-audio-sample-rate", 8_000, 192_000)?;
    // Renderer playback accepts mono or stereo PCM only; keep the transport
    // contract bounded to the same maximum as the frontend decoder.
    let channels = parse_positive_header(headers, "x-maxx-audio-channels", 1, 2)? as u16;
    let sample_format = required_header(headers, "x-maxx-audio-sample-format")?;
    if !sample_format.eq_ignore_ascii_case("s16le") {
        return Err("Speech service must return little-endian signed 16-bit PCM.".into());
    }
    Ok(PcmMetadata {
        sample_rate,
        channels,
        content_type: "audio/pcm".into(),
    })
}

fn required_header(headers: &reqwest::header::HeaderMap, name: &str) -> Result<String, String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Speech service omitted required {name} metadata."))
}

fn parse_positive_header(
    headers: &reqwest::header::HeaderMap,
    name: &str,
    minimum: u32,
    maximum: u32,
) -> Result<u32, String> {
    let raw = required_header(headers, name)?;
    let value = raw
        .parse::<u32>()
        .map_err(|_| format!("Speech service returned invalid {name} metadata."))?;
    if !(minimum..=maximum).contains(&value) {
        return Err(format!(
            "Speech service returned out-of-range {name} metadata."
        ));
    }
    Ok(value)
}

fn parse_voice_catalog(body: &[u8]) -> Result<VoiceCatalog, String> {
    let raw: RawVoiceCatalog = serde_json::from_slice(body)
        .map_err(|_| "Voice catalog response was malformed JSON.".to_string())?;
    if raw.object != "list" {
        return Err("Voice catalog response did not declare an object list.".into());
    }
    let mut data = Vec::with_capacity(raw.data.len());
    for entry in raw.data {
        if entry.id.trim().is_empty()
            || entry.name.trim().is_empty()
            || entry.model.trim().is_empty()
            || entry.language.trim().is_empty()
            || entry.id.len() > 256
            || entry.name.len() > 512
            || entry.model.len() > 256
            || entry.language.len() > 64
        {
            return Err("Voice catalog contained an invalid voice entry.".into());
        }
        data.push(VoiceCatalogEntry {
            id: entry.id,
            name: entry.name,
            model: entry.model,
            language: entry.language,
        });
    }
    Ok(VoiceCatalog { voices: data })
}

async fn response_body_or_error(
    response: Response,
    maximum: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(provider_response_error(response, label).await);
    }
    read_response_bytes(response, maximum, label).await
}

async fn read_response_bytes(
    response: Response,
    maximum: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = tokio::time::timeout(TTS_READ_TIMEOUT, stream.next())
        .await
        .map_err(|_| format!("Timed out reading the {label}."))?
        .transpose()
        .map_err(|error| format!("Could not read the {label}: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(format!("The {label} exceeded its maximum size."));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn provider_response_error(response: Response, label: &str) -> String {
    let status = response.status();
    let body = read_response_bytes(response, MAX_TTS_ERROR_BYTES, label)
        .await
        .unwrap_or_default();
    let parsed = serde_json::from_slice::<ProviderErrorEnvelope>(&body).ok();
    let message = parsed
        .as_ref()
        .and_then(|error| error.error.message.as_deref())
        .filter(|message| !message.trim().is_empty())
        .map(safe_provider_message)
        .unwrap_or_else(|| "The speech service rejected the request.".into());
    let code = parsed
        .as_ref()
        .and_then(|error| {
            error
                .error
                .code
                .as_deref()
                .or(error.error.error_type.as_deref())
        })
        .filter(|code| is_safe_provider_code(code))
        .unwrap_or("http_error");
    format!("{label} failed ({}; {code}): {message}", status.as_u16())
}

fn safe_provider_message(message: &str) -> String {
    let mut value = message.trim().chars().take(512).collect::<String>();
    value.retain(|character| !character.is_control());
    if value.is_empty() {
        "The speech service rejected the request.".into()
    } else {
        value
    }
}

fn is_safe_provider_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 64
        && code.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
}

async fn stream_tts_response(
    response: Response,
    sender: mpsc::Sender<TtsMessage>,
    cancel: CancellationToken,
    frame_bytes: usize,
) {
    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    let mut total = 0usize;
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return,
            next = tokio::time::timeout(TTS_READ_TIMEOUT, stream.next()) => next,
        };
        let next = match next {
            Err(_) => {
                send_tts_error(
                    &sender,
                    &cancel,
                    "tts_read_timeout",
                    "Timed out while reading speech audio.",
                )
                .await;
                return;
            }
            Ok(next) => next,
        };
        let Some(result) = next else { break };
        let chunk = match result {
            Ok(chunk) => chunk,
            Err(error) => {
                send_tts_error(
                    &sender,
                    &cancel,
                    "tts_stream_failed",
                    &format!("Could not read speech audio: {error}"),
                )
                .await;
                return;
            }
        };
        total = total.saturating_add(chunk.len());
        if total > MAX_TTS_RESPONSE_BYTES {
            send_tts_error(
                &sender,
                &cancel,
                "tts_response_too_large",
                "Speech audio exceeded the maximum response size.",
            )
            .await;
            return;
        }
        pending.extend_from_slice(&chunk);
        let complete = pending.len() - pending.len() % frame_bytes;
        let mut offset = 0;
        while offset < complete {
            let mut end = (offset + TTS_PROVIDER_CHUNK_BYTES).min(complete);
            end -= end.saturating_sub(offset) % frame_bytes;
            if end == offset {
                break;
            }
            if !send_tts_message(
                &sender,
                &cancel,
                TtsMessage::Audio(pending[offset..end].to_vec()),
            )
            .await
            {
                return;
            }
            offset = end;
        }
        if complete > 0 {
            pending.drain(..complete);
        }
    }
    if !pending.is_empty() {
        send_tts_error(
            &sender,
            &cancel,
            "tts_pcm_misaligned",
            "Speech service returned an incomplete PCM16 frame.",
        )
        .await;
        return;
    }
    if total == 0 {
        send_tts_error(
            &sender,
            &cancel,
            "tts_audio_empty",
            "Speech service returned no audio.",
        )
        .await;
        return;
    }
    let _ = send_tts_message(&sender, &cancel, TtsMessage::Done).await;
}

async fn send_tts_message(
    sender: &mpsc::Sender<TtsMessage>,
    cancel: &CancellationToken,
    message: TtsMessage,
) -> bool {
    tokio::select! {
        _ = cancel.cancelled() => false,
        result = sender.send(message) => result.is_ok(),
    }
}

async fn send_tts_error(
    sender: &mpsc::Sender<TtsMessage>,
    cancel: &CancellationToken,
    code: &str,
    message: &str,
) {
    let _ = send_tts_message(
        sender,
        cancel,
        TtsMessage::Error(VoiceTtsError {
            code: code.into(),
            message: message.into(),
        }),
    )
    .await;
}

/// Begin a dictation session. Returns its id immediately — the socket is still
/// connecting. The frontend starts capturing at once and audio buffers until
/// the socket is live, so the first word of an utterance is never clipped.
pub async fn voice_start(
    state: Arc<AppState>,
    voice: Arc<VoiceState>,
    settings_override: Option<VoiceSettings>,
) -> Result<u64, String> {
    let settings = match settings_override {
        Some(settings) => settings,
        None => state.workspace.lock().await.voice.clone(),
    };
    if !settings.is_enabled {
        return Err("Voice input is turned off in Settings.".into());
    }
    // Fail fast on a missing credential rather than opening the microphone
    // and discovering it at connect. Local OpenAI-compatible services do not
    // require a Maxx-managed credential.
    if settings.stt_provider == SttProvider::Xai {
        if let Err(status) = resolve_bearer(&settings) {
            return Err(status.detail);
        }
    } else if settings.stt_model.trim().is_empty() {
        return Err("Choose an STT model for the OpenAI-compatible provider.".into());
    }
    let url = settings.stt_ws_url()?;

    stop_active(&voice).await;

    let id = voice.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (audio_tx, audio_rx) = mpsc::channel::<AudioChunk>(BACKLOG_MAX_CHUNKS);
    let (stop_tx, stop_rx) = mpsc::channel::<()>(1);

    let task_events = state.events.clone();
    let session_events = task_events.clone();
    let task = tokio::spawn(async move {
        run_session(task_events, id, settings, url, audio_rx, stop_rx).await;
    });

    *voice.active.lock().await = Some(ActiveSession {
        id,
        audio: audio_tx,
        stop: stop_tx,
        task,
        audio_reorder: AudioReorderBuffer::default(),
        overflow_reported: false,
        events: session_events,
    });
    Ok(id)
}

/// Hand one chunk of 16 kHz mono PCM16 to the session.
///
/// Base64 rather than a raw IPC body: at ~32 kB/s the encoding overhead is
/// irrelevant, and it keeps the command signature ordinary enough to carry the
/// session id alongside the audio.
pub async fn voice_send_audio(
    voice: Arc<VoiceState>,
    session: u64,
    sequence: u64,
    chunk: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk.as_bytes())
        .map_err(|error| format!("bad audio chunk: {error}"))?;
    if bytes.len() > MAX_AUDIO_CHUNK_BYTES {
        return Err(format!(
            "audio chunk is too large ({} bytes; maximum is {MAX_AUDIO_CHUNK_BYTES})",
            bytes.len()
        ));
    }

    let mut active = voice.active.lock().await;
    let Some(current) = active.as_mut() else {
        return Ok(()); // Session already ended; the tail of a stopped capture.
    };
    if current.id != session {
        return Ok(()); // Superseded session — never mix into the current one.
    }
    // Never block the webview's IPC thread on a slow socket. Unlike the old
    // implementation, overflow is surfaced as an error and telemetry event;
    // a syllable is never silently discarded.
    match current
        .audio_reorder
        .accept(&current.audio, sequence, bytes)
    {
        Ok(()) => {
            current.overflow_reported = false;
            Ok(())
        }
        Err(AudioIngressError::QueueFull) => {
            if !current.overflow_reported {
                current.overflow_reported = true;
                voice_emit_error(
                    current,
                    "audio_queue_overflow",
                    "Voice audio is arriving faster than the transcription service can consume it."
                        .into(),
                );
                voice_emit(
                    current.events.as_ref(),
                    VoiceEvent::Telemetry {
                        session,
                        metric: "audio_queue_overflow".into(),
                        value: BACKLOG_MAX_CHUNKS as u64,
                    },
                );
            }
            Err(AudioIngressError::QueueFull.message())
        }
        Err(AudioIngressError::Sequence(message)) => {
            voice_emit_error(current, "audio_sequence_out_of_order", message.clone());
            Err(message)
        }
        Err(AudioIngressError::Closed) => {
            let message = AudioIngressError::Closed.message();
            voice_emit_error(current, "audio_queue_closed", message.clone());
            Err(message)
        }
        Err(AudioIngressError::ReorderFull(message)) => {
            // Kept separate from queue overflow internally, but exposed with
            // the same bounded-backpressure behavior to the caller.
            voice_emit_error(current, "audio_reorder_overflow", message.clone());
            Err(message)
        }
    }
}

fn voice_emit_error(session: &ActiveSession, code: &str, message: String) {
    voice_emit(
        session.events.as_ref(),
        VoiceEvent::Error {
            session: session.id,
            code: code.into(),
            message,
            hint: None,
        },
    );
}

pub async fn voice_stop(voice: Arc<VoiceState>, session: u64) -> Result<(), String> {
    let active = voice.active.lock().await;
    if let Some(current) = active.as_ref() {
        if current.id == session {
            let _ = current.stop.try_send(());
        }
    }
    Ok(())
}

/// Signal any running session to stop and wait for it to finish.
async fn stop_active(voice: &Arc<VoiceState>) {
    let previous = voice.active.lock().await.take();
    if let Some(session) = previous {
        let _ = session.stop.try_send(());
        // Bounded: a wedged socket must not block the next session forever.
        let _ = tokio::time::timeout(DRAIN_TIMEOUT + Duration::from_secs(1), session.task).await;
    }
}

// ---------------------------------------------------------------------------
// Session task
// ---------------------------------------------------------------------------

/// Why the pump over one socket returned.
enum PumpOutcome {
    /// User stopped, or a watchdog fired. The session is over.
    Finished,
    /// Socket went away while still listening — reconnect and continue.
    Disconnected,
    /// Unrecoverable; already reported.
    Failed,
}

async fn run_session(
    events: Arc<dyn EventSink>,
    id: u64,
    settings: VoiceSettings,
    url: String,
    mut audio_rx: mpsc::Receiver<AudioChunk>,
    mut stop_rx: mpsc::Receiver<()>,
) {
    let mut backlog: VecDeque<Vec<u8>> = VecDeque::new();
    let mut heard_speech = false;
    let mut reconnects = 0;

    loop {
        voice_emit(
            events.as_ref(),
            VoiceEvent::State {
                session: id,
                state: VoiceSessionState::Connecting,
            },
        );

        let bearer = match settings.stt_provider {
            SttProvider::Xai => match resolve_bearer(&settings) {
                Ok(resolved) => Some(resolved.bearer),
                Err(status) => {
                    voice_emit(
                        events.as_ref(),
                        VoiceEvent::Error {
                            session: id,
                            code: "credential_missing".into(),
                            message: status.detail,
                            hint: None,
                        },
                    );
                    break;
                }
            },
            SttProvider::OpenaiCompatible => None,
        };

        let socket = match connect(&url, bearer.as_deref(), settings.stt_provider).await {
            Ok(socket) => socket,
            Err(error) => {
                voice_emit(
                    events.as_ref(),
                    VoiceEvent::Error {
                        session: id,
                        code: "stt_connection_failed".into(),
                        message: error,
                        hint: None,
                    },
                );
                break;
            }
        };

        voice_emit(
            events.as_ref(),
            VoiceEvent::State {
                session: id,
                state: VoiceSessionState::Listening,
            },
        );

        let outcome = pump(
            events.as_ref(),
            id,
            socket,
            &mut audio_rx,
            &mut stop_rx,
            &mut backlog,
            &mut heard_speech,
        )
        .await;

        match outcome {
            PumpOutcome::Finished | PumpOutcome::Failed => break,
            PumpOutcome::Disconnected => {
                reconnects += 1;
                if reconnects > MAX_RECONNECTS {
                    voice_emit(
                        events.as_ref(),
                        VoiceEvent::Error {
                            session: id,
                            code: "stt_reconnect_exhausted".into(),
                            message: "Lost the transcription connection.".into(),
                            hint: Some("Check your network and start dictation again.".into()),
                        },
                    );
                    break;
                }
                log::info!("voice session {id} reconnecting ({reconnects}/{MAX_RECONNECTS})");
            }
        }
    }

    voice_emit(
        events.as_ref(),
        VoiceEvent::State {
            session: id,
            state: VoiceSessionState::Stopped,
        },
    );
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(url: &str, bearer: Option<&str>, provider: SttProvider) -> Result<Socket, String> {
    let mut request = url
        .into_client_request()
        .map_err(|error| format!("bad speech-to-text URL: {error}"))?;
    if let Some(bearer) = bearer {
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {bearer}")
                .parse()
                .map_err(|_| "credential is not a valid header value".to_string())?,
        );
    }
    if provider == SttProvider::Xai {
        request
            .headers_mut()
            .insert("x-grok-client-identifier", "maxx".parse().unwrap());
    }

    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "Timed out connecting to the transcription service.".to_string())?
    .map_err(|error| match error {
        WsError::Http(response) if response.status().as_u16() == 401 => match provider {
            SttProvider::Xai => {
                "Transcription rejected the credential. Run `grok login`, or check XAI_API_KEY."
                    .to_string()
            }
            SttProvider::OpenaiCompatible =>
                "The OpenAI-compatible STT service rejected the request. Check its authentication settings."
                    .to_string(),
        },
        other => format!("Could not reach the transcription service: {other}"),
    })?;
    Ok(socket)
}

/// Drive one socket until the session ends or the connection drops.
#[allow(clippy::too_many_arguments)]
async fn pump(
    events: &dyn EventSink,
    id: u64,
    socket: Socket,
    audio_rx: &mut mpsc::Receiver<AudioChunk>,
    stop_rx: &mut mpsc::Receiver<()>,
    backlog: &mut VecDeque<Vec<u8>>,
    heard_speech: &mut bool,
) -> PumpOutcome {
    let (mut sink, mut stream) = socket.split();
    // A fresh socket transcribes a fresh turn; carrying the previous socket's
    // accumulated preview across a reconnect would duplicate text.
    let mut stitcher = TranscriptStitcher::new();

    // Whatever arrived while connecting goes out first, in order.
    while let Some(chunk) = backlog.pop_front() {
        if sink.send(Message::Binary(chunk)).await.is_err() {
            return PumpOutcome::Disconnected;
        }
    }

    let mut draining = false;
    let mut drain_deadline = Instant::now();
    let mut last_transcript = Instant::now();
    let started = Instant::now();
    let mut sent_frames = 0_u64;

    loop {
        let watchdog = if draining {
            drain_deadline.saturating_duration_since(Instant::now())
        } else if *heard_speech {
            Duration::from_secs(IDLE_TIMEOUT_SECS).saturating_sub(last_transcript.elapsed())
        } else {
            Duration::from_secs(NO_SPEECH_TIMEOUT_SECS).saturating_sub(started.elapsed())
        };

        tokio::select! {
            biased;

            // Stop wins over pending audio: the user has let go, and anything
            // still queued belongs to speech they have already finished.
            stopped = stop_rx.recv(), if !draining => {
                if stopped.is_none() {
                    return PumpOutcome::Finished;
                }
                draining = true;
                drain_deadline = Instant::now() + DRAIN_TIMEOUT;
                let done = format!(r#"{{"type":"audio.done","sequence":{sent_frames}}}"#);
                let _ = sink.send(Message::Text(done.into())).await;
            }

            chunk = audio_rx.recv(), if !draining => {
                match chunk {
                    // Channel closed (session dropped): end cleanly.
                    None => return PumpOutcome::Finished,
                    Some(chunk) => {
                        log::trace!("voice session {id} sending audio sequence {}", chunk.sequence);
                        if sink.send(Message::Binary(chunk.bytes)).await.is_err() {
                            return PumpOutcome::Disconnected;
                        }
                        sent_frames = sent_frames.saturating_add(1);
                    }
                }
            }

            message = stream.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<SttServerEvent>(&text) {
                            Ok(SttServerEvent::Partial { text, is_final, speech_final }) => {
                                if let Some(transcript) =
                                    stitcher.apply(&text, is_final, speech_final)
                                {
                                    *heard_speech = true;
                                    last_transcript = Instant::now();
                                    voice_emit(events, match transcript {
                                        Transcript::Interim(text) =>
                                            VoiceEvent::Interim { session: id, text },
                                        Transcript::Final(text) =>
                                            VoiceEvent::Final { session: id, text },
                                    });
                                }
                            }
                            Ok(SttServerEvent::Final { text }) => {
                                let trimmed = text.trim();
                                if !trimmed.is_empty() {
                                    *heard_speech = true;
                                    last_transcript = Instant::now();
                                    voice_emit(events, VoiceEvent::Final {
                                        session: id,
                                        text: trimmed.to_string(),
                                    });
                                }
                                stitcher.reset();
                            }
                            Ok(SttServerEvent::Done { text }) => {
                                let trimmed = text.trim();
                                if !trimmed.is_empty() {
                                    *heard_speech = true;
                                    last_transcript = Instant::now();
                                    voice_emit(events, VoiceEvent::Final {
                                        session: id,
                                        text: trimmed.to_string(),
                                    });
                                }
                                if draining {
                                    return PumpOutcome::Finished;
                                }
                            }
                            Ok(SttServerEvent::Error { message }) => {
                                voice_emit(events, VoiceEvent::Error {
                                    session: id,
                                    code: "stt_provider_error".into(),
                                    message,
                                    hint: None,
                                });
                                return PumpOutcome::Failed;
                            }
                            Ok(SttServerEvent::Created) | Ok(SttServerEvent::Unknown) => {}
                            Err(error) => log::debug!("unparsed stt message: {error}"),
                        }
                    }
                    // Close/Ping/Pong/Binary: let the stream's end drive teardown.
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        return if draining || is_benign_disconnect(&error) {
                            if draining { PumpOutcome::Finished } else { PumpOutcome::Disconnected }
                        } else {
                            voice_emit(events, VoiceEvent::Error {
                                session: id,
                                code: "stt_connection_failed".into(),
                                message: format!("Transcription connection failed: {error}"),
                                hint: None,
                            });
                            PumpOutcome::Failed
                        };
                    }
                    None => {
                        return if draining {
                            PumpOutcome::Finished
                        } else {
                            PumpOutcome::Disconnected
                        };
                    }
                }
            }

            _ = tokio::time::sleep(watchdog) => {
                if draining {
                    // Server never sent the trailing final; stop anyway.
                    return PumpOutcome::Finished;
                }
                if *heard_speech {
                    voice_emit(events, VoiceEvent::Error {
                        session: id,
                        code: "stt_idle_timeout".into(),
                        message: "Dictation stopped after two minutes of silence.".into(),
                        hint: None,
                    });
                } else {
                    // Silence here usually means the microphone never opened:
                    // macOS answers a denied grant with silence, not an error.
                    voice_emit(events, VoiceEvent::Error {
                        session: id,
                        code: "stt_no_speech".into(),
                        message: "No speech detected. Dictation stopped.".into(),
                        hint: Some(microphone_help().to_string()),
                    });
                }
                return PumpOutcome::Finished;
            }
        }
    }
}

/// A socket torn down without a closing handshake is what ending a turn looks
/// like — reporting it would put a "connection lost" error on every session.
fn is_benign_disconnect(error: &WsError) -> bool {
    matches!(
        error,
        WsError::ConnectionClosed
            | WsError::AlreadyClosed
            | WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(use_grok: bool) -> VoiceSettings {
        VoiceSettings {
            is_enabled: true,
            use_grok_sign_in: use_grok,
            ..VoiceSettings::default()
        }
    }

    /// Both credential paths in one test: the environment variable is process
    /// global, so splitting these would let them race each other.
    ///
    /// The first half guards the promise the Settings copy makes — with the
    /// opt-in off, the Grok credential file is never consulted, whatever it
    /// happens to contain on the machine running the test.
    #[test]
    fn bearer_resolution_honours_the_opt_in_and_the_environment() {
        let previous = std::env::var(XAI_API_KEY_ENV).ok();

        std::env::remove_var(XAI_API_KEY_ENV);
        let status = resolve_bearer(&settings(false)).unwrap_err();
        assert_eq!(status.source, "none");
        assert!(!status.available);
        assert!(status.detail.contains("Grok sign-in"), "{}", status.detail);

        std::env::set_var(XAI_API_KEY_ENV, "  test-key  ");
        let resolved = resolve_bearer(&settings(false)).unwrap();
        assert_eq!(resolved.bearer, "test-key", "must be trimmed");
        assert_eq!(resolved.status.source, "environment");
        assert!(resolved.status.available);

        match previous {
            Some(value) => std::env::set_var(XAI_API_KEY_ENV, value),
            None => std::env::remove_var(XAI_API_KEY_ENV),
        }
    }

    #[test]
    fn benign_disconnects_are_not_reported_as_failures() {
        assert!(is_benign_disconnect(&WsError::ConnectionClosed));
        assert!(is_benign_disconnect(&WsError::AlreadyClosed));
        assert!(is_benign_disconnect(&WsError::Protocol(
            ProtocolError::ResetWithoutClosingHandshake
        )));
        assert!(!is_benign_disconnect(&WsError::Utf8));
    }

    #[tokio::test]
    async fn audio_reorder_accepts_small_jitter_and_flushes_contiguously() {
        let (sender, mut receiver) = mpsc::channel(8);
        let mut reorder = AudioReorderBuffer::default();
        reorder.accept(&sender, 1, b"one".to_vec()).unwrap();
        assert!(receiver.try_recv().is_err());
        reorder.accept(&sender, 0, b"zero".to_vec()).unwrap();
        assert_eq!(receiver.recv().await.unwrap().bytes, b"zero");
        assert_eq!(receiver.recv().await.unwrap().bytes, b"one");
        let stale = reorder
            .accept(&sender, 0, b"duplicate".to_vec())
            .unwrap_err();
        assert!(matches!(stale, AudioIngressError::Sequence(message) if message.contains("stale")));

        reorder.accept(&sender, 3, b"three".to_vec()).unwrap();
        let duplicate = reorder
            .accept(&sender, 3, b"duplicate".to_vec())
            .unwrap_err();
        assert!(
            matches!(duplicate, AudioIngressError::Sequence(message) if message.contains("duplicated"))
        );
        let far_ahead = reorder
            .accept(&sender, 2 + AUDIO_REORDER_WINDOW, b"far".to_vec())
            .unwrap_err();
        assert!(
            matches!(far_ahead, AudioIngressError::Sequence(message) if message.contains("far ahead"))
        );
    }

    #[tokio::test]
    async fn audio_reorder_is_bounded_and_reports_queue_backpressure() {
        let (sender, mut receiver) = mpsc::channel(1);
        let mut reorder = AudioReorderBuffer::default();
        reorder
            .accept(&sender, 0, vec![0; MAX_AUDIO_CHUNK_BYTES])
            .unwrap();
        let full = reorder
            .accept(&sender, 1, vec![1; MAX_AUDIO_CHUNK_BYTES])
            .unwrap_err();
        assert_eq!(full, AudioIngressError::QueueFull);
        drop(receiver.recv().await);
        reorder
            .accept(&sender, 1, vec![1; MAX_AUDIO_CHUNK_BYTES])
            .unwrap();

        let (sender, _receiver) = mpsc::channel(8);
        let mut reorder = AudioReorderBuffer::default();
        for sequence in 1..=4 {
            reorder
                .accept(
                    &sender,
                    sequence,
                    vec![sequence as u8; MAX_AUDIO_CHUNK_BYTES],
                )
                .unwrap();
        }
        let bounded = reorder.accept(&sender, 5, vec![5; 1]).unwrap_err();
        assert!(matches!(bounded, AudioIngressError::ReorderFull(_)));
    }

    #[test]
    fn catalog_parser_rejects_malformed_entries_without_fallback() {
        let catalog = parse_voice_catalog(
            br#"{"object":"list","data":[{"id":"scarlett","name":"Scarlett","model":"qwen3-tts-base","language":"en"}]}"#,
        )
        .unwrap();
        assert_eq!(catalog.voices[0].id, "scarlett");
        assert!(parse_voice_catalog(
            br#"{"object":"list","data":[{"id":"","name":"x","model":"m","language":"en"}]}"#
        )
        .is_err());
        assert!(parse_voice_catalog(br#"{"object":"catalog","data":[]}"#).is_err());
        assert!(parse_voice_catalog(br#"not-json"#).is_err());
    }

    #[test]
    fn pcm_metadata_requires_declared_s16le_format_and_bounds() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("content-type", "audio/pcm".parse().unwrap());
        headers.insert("x-maxx-audio-sample-rate", "16000".parse().unwrap());
        headers.insert("x-maxx-audio-channels", "1".parse().unwrap());
        headers.insert("x-maxx-audio-sample-format", "s16le".parse().unwrap());
        let metadata = parse_pcm_metadata(&headers).unwrap();
        assert_eq!(metadata.sample_rate, 16_000);
        assert_eq!(metadata.channels, 1);
        headers.remove("x-maxx-audio-channels");
        assert!(parse_pcm_metadata(&headers).is_err());
        headers.insert("x-maxx-audio-channels", "1".parse().unwrap());
        headers.insert("x-maxx-audio-sample-format", "f32le".parse().unwrap());
        assert!(parse_pcm_metadata(&headers).is_err());
    }

    #[test]
    fn saving_voice_settings_validates_nonempty_tts_endpoint_but_allows_incomplete_form() {
        let mut settings = VoiceSettings::default();
        assert!(validate_voice_settings_for_save(&settings).is_ok());
        settings.tts_api_base = "file:///tmp/voice".into();
        assert!(validate_voice_settings_for_save(&settings).is_err());
        settings.tts_api_base = "http://127.0.0.1:8000/v1".into();
        assert!(validate_voice_settings_for_save(&settings).is_ok());
    }

    #[tokio::test]
    async fn abandoned_tts_session_is_removed_and_producer_is_cancelled() {
        let voice = Arc::new(VoiceState::default());
        let session_id = 41;
        let cancel = CancellationToken::new();
        let (_sender, receiver) = mpsc::channel(TTS_QUEUE_CAPACITY);
        let producer = tokio::spawn(async {
            futures_util::future::pending::<()>().await;
        });
        let session = Arc::new(TtsSession {
            frame_bytes: 2,
            cancel: cancel.clone(),
            reader: Mutex::new(TtsReadState {
                receiver,
                pending: Vec::new(),
                next_sequence: -1,
                terminal: None,
            }),
            task: Mutex::new(Some(producer)),
            created_at: Instant::now(),
            last_activity: StdMutex::new(Instant::now()),
        });
        voice
            .tts_sessions
            .lock()
            .await
            .insert(session_id, session.clone());

        cleanup_tts_session(
            voice.clone(),
            session_id,
            Arc::downgrade(&session),
            Duration::ZERO,
            Duration::from_secs(60),
        )
        .await;

        assert!(!voice.tts_sessions.lock().await.contains_key(&session_id));
        assert!(cancel.is_cancelled());
        assert!(session.task.lock().await.is_none());
    }

    #[tokio::test]
    async fn abandoned_tts_cleanup_does_not_remove_a_replacement_session() {
        let voice = Arc::new(VoiceState::default());
        let session_id = 42;
        let make_session = || async {
            let cancel = CancellationToken::new();
            let (_sender, receiver) = mpsc::channel(TTS_QUEUE_CAPACITY);
            let producer = tokio::spawn(async {
                futures_util::future::pending::<()>().await;
            });
            Arc::new(TtsSession {
                frame_bytes: 2,
                cancel,
                reader: Mutex::new(TtsReadState {
                    receiver,
                    pending: Vec::new(),
                    next_sequence: -1,
                    terminal: None,
                }),
                task: Mutex::new(Some(producer)),
                created_at: Instant::now(),
                last_activity: StdMutex::new(Instant::now()),
            })
        };
        let old = make_session().await;
        let replacement = make_session().await;
        voice
            .tts_sessions
            .lock()
            .await
            .insert(session_id, replacement.clone());

        cleanup_tts_session(
            voice.clone(),
            session_id,
            Arc::downgrade(&old),
            Duration::ZERO,
            Duration::from_secs(60),
        )
        .await;

        let current = voice
            .tts_sessions
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .unwrap();
        assert!(Arc::ptr_eq(&current, &replacement));
        assert!(!old.cancel.is_cancelled());
        cancel_tts_session(&old).await;
        cancel_tts_session(&replacement).await;
    }

    #[tokio::test]
    async fn in_flight_tts_read_returns_no_chunks_after_cancellation() {
        let voice = Arc::new(VoiceState::default());
        let session_id = 43;
        let cancel = CancellationToken::new();
        let (_sender, receiver) = mpsc::channel(TTS_QUEUE_CAPACITY);
        let producer = tokio::spawn(async {
            futures_util::future::pending::<()>().await;
        });
        let session = Arc::new(TtsSession {
            frame_bytes: 2,
            cancel,
            reader: Mutex::new(TtsReadState {
                receiver,
                pending: Vec::new(),
                next_sequence: -1,
                terminal: None,
            }),
            task: Mutex::new(Some(producer)),
            created_at: Instant::now(),
            last_activity: StdMutex::new(Instant::now()),
        });
        voice
            .tts_sessions
            .lock()
            .await
            .insert(session_id, session.clone());

        // Hold the reader at the in-flight boundary, then cancel and release
        // it. The read must observe cancellation before it can drain audio.
        let reader_guard = session.reader.lock().await;
        let read_voice = voice.clone();
        let read =
            tokio::spawn(async move { voice_tts_read(read_voice, session_id, -1, 4096).await });
        tokio::task::yield_now().await;
        voice_tts_cancel(voice.clone(), session_id).await.unwrap();
        drop(reader_guard);

        let result = tokio::time::timeout(Duration::from_secs(1), read)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(result.chunks.is_empty());
        assert!(result.done);
        assert!(result.error.is_none());
    }

    async fn loopback_tts_url() -> Option<(String, JoinHandle<()>)> {
        use axum::body::Body;
        use axum::http::header::{HeaderName, HeaderValue, CONTENT_TYPE};
        use axum::http::StatusCode;
        use axum::response::Response as HttpResponse;
        use axum::routing::post;
        use axum::Router;
        use futures_util::stream;
        use std::convert::Infallible;
        use tokio::net::TcpListener;

        let app = Router::new().route(
            "/v1/audio/speech",
            post(|| async {
                let chunks = stream::iter(vec![
                    Ok::<_, Infallible>(vec![1, 0, 2, 0]),
                    Ok::<_, Infallible>(vec![3, 0, 4, 0]),
                ]);
                let mut response = HttpResponse::new(Body::from_stream(chunks));
                *response.status_mut() = StatusCode::OK;
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static("audio/pcm"));
                response.headers_mut().insert(
                    HeaderName::from_static("x-maxx-audio-sample-rate"),
                    HeaderValue::from_static("16000"),
                );
                response.headers_mut().insert(
                    HeaderName::from_static("x-maxx-audio-channels"),
                    HeaderValue::from_static("1"),
                );
                response.headers_mut().insert(
                    HeaderName::from_static("x-maxx-audio-sample-format"),
                    HeaderValue::from_static("s16le"),
                );
                response
            }),
        );
        let listener = match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return None,
            Err(error) => panic!("could not bind loopback test server: {error}"),
        };
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Some((format!("http://{address}"), task))
    }

    struct RecordingEvents {
        values: std::sync::Mutex<Vec<serde_json::Value>>,
        notify: tokio::sync::Notify,
    }

    impl RecordingEvents {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                values: std::sync::Mutex::new(Vec::new()),
                notify: tokio::sync::Notify::new(),
            })
        }
    }

    impl EventSink for RecordingEvents {
        fn emit_value(&self, _event: &str, payload: serde_json::Value) {
            self.values.lock().unwrap().push(payload);
            self.notify.notify_waiters();
        }
    }

    async fn loopback_stt_url(expected_audio: Vec<u8>) -> Option<(String, JoinHandle<()>)> {
        use futures_util::{SinkExt, StreamExt};
        use tokio::net::TcpListener;
        use tokio_tungstenite::accept_async;

        let listener = match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return None,
            Err(error) => panic!("could not bind loopback STT fixture: {error}"),
        };
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    Message::Binary(payload) => {
                        assert_eq!(payload.as_slice(), expected_audio.as_slice());
                        socket
                            .send(Message::Text(
                                r#"{"type":"transcript.partial","text":"known hello","is_final":false,"speech_final":false}"#
                                    .into(),
                            ))
                            .await
                            .unwrap();
                    }
                    Message::Text(text) => {
                        let control: serde_json::Value =
                            serde_json::from_str(text.as_ref()).unwrap();
                        assert_eq!(
                            control.get("type").and_then(|value| value.as_str()),
                            Some("audio.done")
                        );
                        assert_eq!(
                            control.get("sequence").and_then(|value| value.as_u64()),
                            Some(1)
                        );
                        socket
                            .send(Message::Text(
                                r#"{"type":"transcript.final","text":"known hello"}"#.into(),
                            ))
                            .await
                            .unwrap();
                        socket
                            .send(Message::Text(
                                r#"{"type":"transcript.done","text":"known hello"}"#.into(),
                            ))
                            .await
                            .unwrap();
                        let _ = socket.close(None).await;
                        break;
                    }
                    Message::Ping(payload) => {
                        socket.send(Message::Pong(payload)).await.unwrap();
                    }
                    _ => {}
                }
            }
        });
        Some((format!("ws://{address}"), task))
    }

    #[tokio::test]
    async fn loopback_stt_accepts_ordered_pcm_and_drains_final_on_stop() {
        let expected_audio = vec![0, 0, 1, 0, 2, 0, 3, 0];
        let Some((url, fixture)) = loopback_stt_url(expected_audio.clone()).await else {
            return;
        };
        let socket = connect(&url, None, SttProvider::OpenaiCompatible)
            .await
            .unwrap();
        let (audio_sender, mut audio_receiver) = mpsc::channel(4);
        let (stop_sender, mut stop_receiver) = mpsc::channel(1);
        let events = RecordingEvents::new();
        let pump_events = events.clone();
        let pump_task = tokio::spawn(async move {
            let mut backlog = VecDeque::new();
            let mut heard_speech = false;
            pump(
                pump_events.as_ref(),
                99,
                socket,
                &mut audio_receiver,
                &mut stop_receiver,
                &mut backlog,
                &mut heard_speech,
            )
            .await
        });

        audio_sender
            .send(AudioChunk {
                sequence: 0,
                bytes: expected_audio,
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if events.values.lock().unwrap().iter().any(|value| {
                    value.get("kind").and_then(|kind| kind.as_str()) == Some("interim")
                }) {
                    break;
                }
                events.notify.notified().await;
            }
        })
        .await
        .expect("known PCM should produce an interim transcript");
        stop_sender.send(()).await.unwrap();

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), pump_task)
                .await
                .unwrap()
                .unwrap(),
            PumpOutcome::Finished
        ));
        fixture.await.unwrap();
        let values = events.values.lock().unwrap();
        assert!(values.iter().any(|value| {
            value.get("kind").and_then(|kind| kind.as_str()) == Some("interim")
                && value.get("text").and_then(|text| text.as_str()) == Some("known hello")
        }));
        assert!(values.iter().any(|value| {
            value.get("kind").and_then(|kind| kind.as_str()) == Some("final")
                && value.get("text").and_then(|text| text.as_str()) == Some("known hello")
        }));
    }

    #[tokio::test]
    async fn loopback_tts_stream_delivers_ordered_audio_before_done() {
        let Some((base, server)) = loopback_tts_url().await else {
            return;
        };
        let response = Client::new()
            .post(format!("{base}/v1/audio/speech"))
            .send()
            .await
            .unwrap();
        let (sender, mut receiver) = mpsc::channel(TTS_QUEUE_CAPACITY);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(stream_tts_response(response, sender, cancel, 2));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            TtsMessage::Audio(ref bytes) if bytes == &[1, 0, 2, 0]
        ));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            TtsMessage::Audio(ref bytes) if bytes == &[3, 0, 4, 0]
        ));
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            TtsMessage::Done
        ));
        task.await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn tts_stream_cancellation_stops_before_audio_is_enqueued() {
        let Some((base, server)) = loopback_tts_url().await else {
            return;
        };
        let response = Client::new()
            .post(format!("{base}/v1/audio/speech"))
            .send()
            .await
            .unwrap();
        let (sender, mut receiver) = mpsc::channel(TTS_QUEUE_CAPACITY);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let task = tokio::spawn(stream_tts_response(response, sender, cancel, 2));
        assert!(
            tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .is_none()
        );
        task.await.unwrap();
        server.abort();
    }
}
