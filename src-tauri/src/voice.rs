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

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use maxx_core::voice::{
    microphone_help, parse_grok_credential, SttServerEvent, Transcript, TranscriptStitcher,
    VoiceSettings, IDLE_TIMEOUT_SECS, NO_SPEECH_TIMEOUT_SECS,
};
use serde::Serialize;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::{Error as WsError, ProtocolError};
use tokio_tungstenite::tungstenite::Message;

use crate::events::{emit as emit_event, EventSink};
use crate::state::AppState;

/// Audio chunks buffered while a socket is being (re)established. At the
/// frontend's ~100 ms cadence this is about 25 seconds — far more than any
/// real connect, so in practice nothing is ever dropped; it only bounds a
/// pathological hang.
const BACKLOG_MAX_CHUNKS: usize = 256;

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
        message: String,
        hint: Option<String>,
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
}

struct ResolvedBearer {
    bearer: String,
    status: VoiceCredentialStatus,
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
        }),
    }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

struct ActiveSession {
    id: u64,
    audio: mpsc::Sender<Vec<u8>>,
    stop: mpsc::Sender<()>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct VoiceState {
    active: Mutex<Option<ActiveSession>>,
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
pub async fn voice_status(state: Arc<AppState>) -> Result<VoiceCredentialStatus, String> {
    let settings = state.workspace.lock().await.voice.clone();
    Ok(match resolve_bearer(&settings) {
        Ok(resolved) => resolved.status,
        Err(status) => status,
    })
}

pub async fn update_voice_settings(
    state: Arc<AppState>,
    settings: VoiceSettings,
) -> Result<VoiceSettings, String> {
    // Validate before storing so a bad endpoint is rejected at the point the
    // user typed it, not at the first attempt to dictate.
    settings.stt_ws_url()?;
    {
        let mut workspace = state.workspace.lock().await;
        workspace.voice = settings.clone();
    }
    state.save().await;
    Ok(settings)
}

/// Begin a dictation session. Returns its id immediately — the socket is still
/// connecting. The frontend starts capturing at once and audio buffers until
/// the socket is live, so the first word of an utterance is never clipped.
pub async fn voice_start(state: Arc<AppState>, voice: Arc<VoiceState>) -> Result<u64, String> {
    let settings = state.workspace.lock().await.voice.clone();
    if !settings.is_enabled {
        return Err("Voice input is turned off in Settings.".into());
    }
    // Fail fast on a missing credential rather than opening the microphone
    // and discovering it at connect.
    if let Err(status) = resolve_bearer(&settings) {
        return Err(status.detail);
    }
    let url = settings.stt_ws_url()?;

    stop_active(&voice).await;

    let id = voice.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>(BACKLOG_MAX_CHUNKS);
    let (stop_tx, stop_rx) = mpsc::channel::<()>(1);

    let task_events = state.events.clone();
    let task = tokio::spawn(async move {
        run_session(task_events, id, settings, url, audio_rx, stop_rx).await;
    });

    *voice.active.lock().await = Some(ActiveSession {
        id,
        audio: audio_tx,
        stop: stop_tx,
        task,
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
    chunk: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk.as_bytes())
        .map_err(|error| format!("bad audio chunk: {error}"))?;

    let active = voice.active.lock().await;
    let Some(current) = active.as_ref() else {
        return Ok(()); // Session already ended; the tail of a stopped capture.
    };
    if current.id != session {
        return Ok(()); // Superseded session — never mix into the current one.
    }
    // Never block the webview's IPC thread on a slow socket: dropping a chunk
    // costs a syllable, stalling costs the whole stream.
    if current.audio.try_send(bytes).is_err() {
        log::debug!("voice audio backlog full; dropped a chunk");
    }
    Ok(())
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
    mut audio_rx: mpsc::Receiver<Vec<u8>>,
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

        let bearer = match resolve_bearer(&settings) {
            Ok(resolved) => resolved.bearer,
            Err(status) => {
                voice_emit(
                    events.as_ref(),
                    VoiceEvent::Error {
                        session: id,
                        message: status.detail,
                        hint: None,
                    },
                );
                break;
            }
        };

        let socket = match connect(&url, &bearer).await {
            Ok(socket) => socket,
            Err(error) => {
                voice_emit(
                    events.as_ref(),
                    VoiceEvent::Error {
                        session: id,
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

async fn connect(url: &str, bearer: &str) -> Result<Socket, String> {
    let mut request = url
        .into_client_request()
        .map_err(|error| format!("bad speech-to-text URL: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {bearer}")
            .parse()
            .map_err(|_| "credential is not a valid header value".to_string())?,
    );
    request
        .headers_mut()
        .insert("x-grok-client-identifier", "maxx".parse().unwrap());

    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "Timed out connecting to the transcription service.".to_string())?
    .map_err(|error| match error {
        WsError::Http(response) if response.status().as_u16() == 401 => {
            "Transcription rejected the credential. Run `grok login`, or check XAI_API_KEY."
                .to_string()
        }
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
    audio_rx: &mut mpsc::Receiver<Vec<u8>>,
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
                let _ = sink.send(Message::Text(r#"{"type":"audio.done"}"#.into())).await;
            }

            chunk = audio_rx.recv(), if !draining => {
                match chunk {
                    // Channel closed (session dropped): end cleanly.
                    None => return PumpOutcome::Finished,
                    Some(chunk) => {
                        if sink.send(Message::Binary(chunk)).await.is_err() {
                            return PumpOutcome::Disconnected;
                        }
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
                        message: "Dictation stopped after two minutes of silence.".into(),
                        hint: None,
                    });
                } else {
                    // Silence here usually means the microphone never opened:
                    // macOS answers a denied grant with silence, not an error.
                    voice_emit(events, VoiceEvent::Error {
                        session: id,
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
}
