//! Voice dictation domain: persisted settings, the xAI streaming-STT wire
//! format, and the transcript stitching that turns a partial stream into text
//! the composer can show.
//!
//! Dictation only — microphone to prompt box. Nothing here starts a turn; the
//! user always reviews and sends.
//!
//! Everything in this module is pure. Sockets, credentials on disk and the
//! session state machine live in the app crate's `voice` module.

use serde::{Deserialize, Serialize};

/// Capture rate the STT endpoint is opened with. The frontend resamples to
/// this before sending, so it is also the contract for `voice_send_audio`.
pub const VOICE_SAMPLE_RATE: u32 = 16_000;

/// Silence after which a session with no transcript at all is torn down. A
/// denied microphone grant is indistinguishable from not speaking — macOS
/// hands back silence rather than an error — so a dead mic has to time out
/// instead of streaming forever.
pub const NO_SPEECH_TIMEOUT_SECS: u64 = 10;

/// Silence after the *last* transcript that ends a session. Dictation is a
/// toggle, so "left the microphone on" is a real cost: the socket bills for
/// connected audio whether or not anyone is talking.
pub const IDLE_TIMEOUT_SECS: u64 = 120;

// ---------------------------------------------------------------------------
// Persisted settings
// ---------------------------------------------------------------------------

/// Speech-to-text provider used by a voice session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SttProvider {
    Xai,
    OpenaiCompatible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceMode {
    Dictation,
    Conversation,
}

impl Default for VoiceMode {
    fn default() -> Self {
        Self::Dictation
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TtsProvider {
    OpenaiCompatible,
}

impl Default for TtsProvider {
    fn default() -> Self {
        Self::OpenaiCompatible
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnDetection {
    Manual,
    Automatic,
}

impl Default for TurnDetection {
    fn default() -> Self {
        Self::Automatic
    }
}

impl Default for SttProvider {
    fn default() -> Self {
        Self::Xai
    }
}

/// Voice settings as stored in `workspace.json`.
///
/// No credential is ever stored here. The bearer is resolved at each connect
/// from the Grok CLI's own credential file (opt-in) or the environment, so
/// this document stays free of secrets and safe to sync or inspect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct VoiceSettings {
    /// Master switch. Off until the user turns dictation on in Settings.
    #[serde(rename = "isEnabled")]
    pub is_enabled: bool,
    /// Opt-in to reading the bearer the Grok CLI stores in `~/.grok/auth.json`.
    /// Off by default: it is another product's credential, and reusing it is
    /// the user's call to make explicitly.
    #[serde(rename = "useGrokSignIn")]
    pub use_grok_sign_in: bool,
    /// STT provider selected for reviewed dictation.
    #[serde(rename = "sttProvider")]
    pub stt_provider: SttProvider,
    /// STT language code, or `auto`. Resolved to a concrete code at connect —
    /// the endpoint rejects `auto`.
    pub language: String,
    /// Provider API root. xAI requires HTTPS/WSS; the local OpenAI-compatible
    /// service may use HTTP/WS when it is intentionally configured that way.
    #[serde(rename = "sttApiBase")]
    pub stt_api_base: String,
    /// Model identifier sent to an OpenAI-compatible STT service.
    #[serde(rename = "sttModel")]
    pub stt_model: String,
    pub mode: VoiceMode,
    #[serde(rename = "ttsProvider")]
    pub tts_provider: TtsProvider,
    #[serde(rename = "ttsApiBase")]
    pub tts_api_base: String,
    #[serde(rename = "ttsModel")]
    pub tts_model: String,
    #[serde(rename = "voiceID")]
    pub voice_id: String,
    #[serde(rename = "inputDeviceID")]
    pub input_device_id: Option<String>,
    #[serde(rename = "outputDeviceID")]
    pub output_device_id: Option<String>,
    #[serde(rename = "speechHostID")]
    #[serde(default = "default_speech_host_id")]
    pub speech_host_id: String,
    #[serde(rename = "turnDetection")]
    pub turn_detection: TurnDetection,
    #[serde(rename = "allowInterruption")]
    #[serde(default = "default_allow_interruption")]
    pub allow_interruption: bool,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            is_enabled: false,
            use_grok_sign_in: false,
            stt_provider: SttProvider::Xai,
            language: DEFAULT_LANGUAGE.to_string(),
            stt_api_base: DEFAULT_API_BASE.to_string(),
            stt_model: String::new(),
            mode: VoiceMode::Dictation,
            tts_provider: TtsProvider::OpenaiCompatible,
            tts_api_base: String::new(),
            tts_model: String::new(),
            voice_id: String::new(),
            input_device_id: None,
            output_device_id: None,
            speech_host_id: "local".to_string(),
            turn_detection: TurnDetection::Automatic,
            allow_interruption: true,
        }
    }
}

pub const DEFAULT_API_BASE: &str = "https://api.x.ai";
pub const DEFAULT_LANGUAGE: &str = "en";
const XAI_STT_PATH: &str = "v1/stt";
const OPENAI_STT_STREAM_PATH: &str = "v1/audio/transcriptions/stream";

fn default_speech_host_id() -> String {
    "local".into()
}

fn default_allow_interruption() -> bool {
    true
}

/// Languages offered in Settings. `auto` resolves to [`DEFAULT_LANGUAGE`]
/// because the STT endpoint has no auto-detect mode.
pub const VOICE_LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("de", "German"),
    ("it", "Italian"),
    ("pt", "Portuguese"),
    ("nl", "Dutch"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("zh", "Chinese"),
    ("hi", "Hindi"),
    ("ru", "Russian"),
];

/// Resolve a stored language to the code sent on the wire.
pub fn language_for_api(language: &str) -> &str {
    let trimmed = language.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return DEFAULT_LANGUAGE;
    }
    VOICE_LANGUAGES
        .iter()
        .find(|(code, _)| code.eq_ignore_ascii_case(trimmed))
        .map(|(code, _)| *code)
        .unwrap_or(DEFAULT_LANGUAGE)
}

impl VoiceSettings {
    /// Streaming STT WebSocket URL, query parameters included.
    ///
    /// Refuses a plaintext base: the bearer travels in a request header, and
    /// no configuration mistake should be able to put it on the wire in clear.
    pub fn stt_ws_url(&self) -> Result<String, String> {
        match self.stt_provider {
            SttProvider::Xai => self.xai_stt_ws_url(),
            SttProvider::OpenaiCompatible => self.openai_stt_ws_url(),
        }
    }

    fn xai_stt_ws_url(&self) -> Result<String, String> {
        let base = self.stt_api_base.trim().trim_end_matches('/');
        let base = if base.is_empty() {
            DEFAULT_API_BASE
        } else {
            base
        };

        if starts_with_scheme(base, "http://") || starts_with_scheme(base, "ws://") {
            return Err(format!(
                "insecure xAI voice endpoint {base:?}: refusing to send a bearer token over \
                 a plaintext connection. Use https:// or wss://."
            ));
        }
        let host = strip_scheme(base, "https://")
            .or_else(|| strip_scheme(base, "wss://"))
            .unwrap_or(base);
        validate_endpoint_host(host, "xAI")?;

        // Proxy bases commonly already end in `/v1`; don't produce `/v1/v1/stt`.
        let path = match (host.ends_with("/v1"), XAI_STT_PATH.strip_prefix("v1/")) {
            (true, Some(tail)) => tail,
            _ => XAI_STT_PATH,
        };

        Ok(format!(
            "wss://{host}/{path}?sample_rate={rate}&encoding=pcm&interim_results=true\
             &language={language}&endpointing=400",
            rate = VOICE_SAMPLE_RATE,
            language = language_for_api(&self.language),
        ))
    }

    /// The local service exposes streaming STT as a documented extension to
    /// OpenAI's batch `/v1/audio/transcriptions` route. Standard OpenAI
    /// transcription is request/response and cannot provide interim results.
    fn openai_stt_ws_url(&self) -> Result<String, String> {
        let base = self.stt_api_base.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err(
                "Configure an OpenAI-compatible STT endpoint before starting dictation.".into(),
            );
        }
        let (scheme, host) = if let Some(host) = strip_scheme(base, "https://") {
            ("wss", host)
        } else if let Some(host) = strip_scheme(base, "http://") {
            ("ws", host)
        } else if let Some(host) = strip_scheme(base, "wss://") {
            ("wss", host)
        } else if let Some(host) = strip_scheme(base, "ws://") {
            ("ws", host)
        } else {
            ("ws", base)
        };
        validate_endpoint_host(host, "OpenAI-compatible STT")?;
        let path = if host.ends_with("/v1") {
            OPENAI_STT_STREAM_PATH
                .strip_prefix("v1/")
                .expect("stream path has a v1 prefix")
        } else {
            OPENAI_STT_STREAM_PATH
        };
        let model = percent_encode_query_component(self.stt_model.trim());
        Ok(format!(
            "{scheme}://{host}/{path}?sample_rate={rate}&encoding=pcm&interim_results=true&language={language}&model={model}",
            rate = VOICE_SAMPLE_RATE,
            language = language_for_api(&self.language),
            model = model,
        ))
    }

    /// HTTP endpoint for the OpenAI-compatible streaming TTS contract.
    /// `response_format=pcm` is selected by the Rust adapter so the renderer
    /// never has to guess how to decode provider output.
    pub fn tts_speech_url(&self) -> Result<String, String> {
        self.openai_tts_http_url("audio/speech")
    }

    /// HTTP endpoint for the Maxx voice-catalog extension.
    pub fn tts_voices_url(&self) -> Result<String, String> {
        self.openai_tts_http_url("audio/voices")
    }

    fn openai_tts_http_url(&self, suffix: &str) -> Result<String, String> {
        let base = self.tts_api_base.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err(
                "Configure an OpenAI-compatible TTS endpoint before using speech output.".into(),
            );
        }
        let (scheme, host) = if let Some(host) = strip_scheme(base, "https://") {
            ("https", host)
        } else if let Some(host) = strip_scheme(base, "http://") {
            ("http", host)
        } else {
            return Err("The OpenAI-compatible TTS endpoint must use http:// or https://.".into());
        };
        validate_endpoint_host(host, "OpenAI-compatible TTS")?;
        let path = if host.ends_with("/v1") {
            suffix.to_string()
        } else {
            format!("v1/{suffix}")
        };
        Ok(format!("{scheme}://{host}/{path}"))
    }
}

fn starts_with_scheme(value: &str, scheme: &str) -> bool {
    value
        .get(..scheme.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
}

fn strip_scheme<'a>(value: &'a str, scheme: &str) -> Option<&'a str> {
    starts_with_scheme(value, scheme).then(|| &value[scheme.len()..])
}

fn validate_endpoint_host(host: &str, provider: &str) -> Result<(), String> {
    let authority = host.split('/').next().unwrap_or_default();
    if authority.trim().is_empty()
        || authority.contains('@')
        || host.contains('?')
        || host.contains('#')
        || host.chars().any(char::is_whitespace)
    {
        return Err(format!(
            "The {provider} STT endpoint is invalid; use a host URL without credentials, query parameters, or fragments."
        ));
    }
    Ok(())
}

fn percent_encode_query_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Grok credential file
// ---------------------------------------------------------------------------

/// A bearer read out of the Grok CLI's credential store, with the non-secret
/// identity fields Settings shows so the user can see whose sign-in is in use.
#[derive(Debug, Clone, PartialEq)]
pub struct GrokCredential {
    pub bearer: String,
    pub email: Option<String>,
    pub expires_at: Option<String>,
}

/// Parse `~/.grok/auth.json`.
///
/// The file is a map keyed by issuer (`https://auth.x.ai::<client-id>`); we
/// take the first xAI entry that carries a token. This is another product's
/// private format with no compatibility promise, so every field is treated as
/// optional and a shape we don't recognise simply yields `None` — never an
/// error the user has to act on.
pub fn parse_grok_credential(source: &str) -> Option<GrokCredential> {
    let document: serde_json::Value = serde_json::from_str(source).ok()?;
    let entries = document.as_object()?;
    entries
        .iter()
        .filter(|(issuer, _)| issuer.starts_with("https://auth.x.ai"))
        .find_map(|(_, entry)| {
            let bearer = entry.get("key")?.as_str()?.trim();
            (!bearer.is_empty()).then(|| GrokCredential {
                bearer: bearer.to_string(),
                email: entry
                    .get("email")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                expires_at: entry
                    .get("expires_at")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            })
        })
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/// Server → client events on the STT socket.
///
/// The server also sends `words`, `start` and `duration`; dictation has no use
/// for them, and ignoring unknown fields keeps us forward-compatible.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum SttServerEvent {
    #[serde(rename = "transcript.created")]
    Created,
    #[serde(rename = "transcript.partial")]
    Partial {
        #[serde(default)]
        text: String,
        #[serde(default)]
        is_final: bool,
        #[serde(default)]
        speech_final: bool,
    },
    /// Local OpenAI-compatible services may use a distinct final event rather
    /// than xAI's `speech_final` flag.
    #[serde(rename = "transcript.final")]
    Final {
        #[serde(default)]
        text: String,
    },
    #[serde(rename = "transcript.done")]
    Done {
        #[serde(default)]
        text: String,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        message: String,
    },
    #[serde(other)]
    Unknown,
}

/// What the stitcher decided a partial means for the composer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transcript {
    /// Live preview. Replaces whatever the previous preview was.
    Interim(String),
    /// Utterance complete. Replaces the preview and freezes as real text.
    Final(String),
}

/// Turns the partial stream into preview and committed text.
///
/// The server emits two kinds of `is_final`. A *chunk* final (`is_final`
/// without `speech_final`) closes roughly three seconds of audio; showing only
/// the latest one would make a long unbroken sentence appear to reset every few
/// seconds, so chunk finals accumulate into a locked prefix that the live
/// preview is appended to.
///
/// A *speech* final (`speech_final`) ends the utterance, and the server sends
/// it as a clean single-pass re-transcription of the whole turn — better than
/// the stitched-together chunks. So the preview is built from the stitching but
/// the committed text always comes from `speech_final` alone, and the prefix
/// resets with it.
#[derive(Debug, Default)]
pub struct TranscriptStitcher {
    locked: String,
}

impl TranscriptStitcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one partial in. `None` when there is nothing worth showing.
    pub fn apply(&mut self, text: &str, is_final: bool, speech_final: bool) -> Option<Transcript> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }

        if speech_final {
            self.locked.clear();
            return Some(Transcript::Final(trimmed.to_string()));
        }

        if is_final {
            if !self.locked.is_empty() {
                self.locked.push(' ');
            }
            self.locked.push_str(trimmed);
            return Some(Transcript::Interim(self.locked.clone()));
        }

        Some(Transcript::Interim(if self.locked.is_empty() {
            trimmed.to_string()
        } else {
            format!("{} {trimmed}", self.locked)
        }))
    }

    /// Drop accumulated state, e.g. after a reconnect mid-session.
    pub fn reset(&mut self) {
        self.locked.clear();
    }
}

/// Guidance shown when a session ends without hearing anything. The most
/// likely cause by far is a microphone grant that was never given.
pub fn microphone_help() -> &'static str {
    "Check that Maxx has microphone access in System Settings → Privacy & Security → \
     Microphone, and that the right input device is selected in System Settings → Sound."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_are_off_and_opt_out() {
        let settings = VoiceSettings::default();
        assert!(!settings.is_enabled, "voice must be off until asked for");
        assert!(
            !settings.use_grok_sign_in,
            "reusing the Grok credential must be opt-in"
        );
    }

    #[test]
    fn ws_url_carries_the_capture_contract() {
        let url = VoiceSettings::default().stt_ws_url().unwrap();
        assert!(url.starts_with("wss://api.x.ai/v1/stt?"), "{url}");
        assert!(url.contains("sample_rate=16000"), "{url}");
        assert!(url.contains("encoding=pcm"), "{url}");
        assert!(url.contains("interim_results=true"), "{url}");
        assert!(url.contains("language=en"), "{url}");
    }

    #[test]
    fn ws_url_rejects_plaintext_bases() {
        for base in ["http://localhost:8080", "ws://localhost:8080", "HTTP://x"] {
            let settings = VoiceSettings {
                stt_api_base: base.into(),
                ..VoiceSettings::default()
            };
            assert!(
                settings.stt_ws_url().is_err(),
                "{base} must not be accepted"
            );
        }
    }

    #[test]
    fn ws_url_accepts_scheme_variants_and_dedupes_v1() {
        for base in [
            "api.x.ai",
            "wss://api.x.ai",
            "HTTPS://api.x.ai",
            "https://api.x.ai/",
        ] {
            let settings = VoiceSettings {
                stt_api_base: base.into(),
                ..VoiceSettings::default()
            };
            assert!(
                settings
                    .stt_ws_url()
                    .unwrap()
                    .starts_with("wss://api.x.ai/v1/stt?"),
                "{base}"
            );
        }

        let proxied = VoiceSettings {
            stt_api_base: "https://proxy.example.com/v1".into(),
            ..VoiceSettings::default()
        };
        assert!(proxied
            .stt_ws_url()
            .unwrap()
            .starts_with("wss://proxy.example.com/v1/stt?"));
    }

    #[test]
    fn openai_compatible_url_uses_the_streaming_extension() {
        let settings = VoiceSettings {
            stt_provider: SttProvider::OpenaiCompatible,
            stt_api_base: "http://127.0.0.1:8001/v1".into(),
            stt_model: "whisper large/v3".into(),
            ..VoiceSettings::default()
        };
        assert_eq!(
            settings.stt_ws_url().unwrap(),
            "ws://127.0.0.1:8001/v1/audio/transcriptions/stream?sample_rate=16000&encoding=pcm&interim_results=true&language=en&model=whisper%20large%2Fv3"
        );
    }

    #[test]
    fn openai_compatible_endpoint_requires_a_base() {
        let settings = VoiceSettings {
            stt_provider: SttProvider::OpenaiCompatible,
            stt_api_base: "   ".into(),
            ..VoiceSettings::default()
        };
        let error = settings.stt_ws_url().unwrap_err();
        assert!(error.contains("Configure an OpenAI-compatible STT endpoint"));
    }

    #[test]
    fn endpoint_rejects_embedded_credentials_and_query_secrets() {
        for base in [
            "https://token@example.com",
            "https://example.com?api_key=secret",
            "https://example.com/#token",
        ] {
            let settings = VoiceSettings {
                stt_api_base: base.into(),
                ..VoiceSettings::default()
            };
            assert!(settings.stt_ws_url().is_err(), "{base}");
        }
    }

    #[test]
    fn tts_urls_use_http_and_dedupe_v1() {
        let settings = VoiceSettings {
            tts_api_base: "http://127.0.0.1:8765/v1/".into(),
            ..VoiceSettings::default()
        };
        assert_eq!(
            settings.tts_speech_url().unwrap(),
            "http://127.0.0.1:8765/v1/audio/speech"
        );
        assert_eq!(
            settings.tts_voices_url().unwrap(),
            "http://127.0.0.1:8765/v1/audio/voices"
        );
    }

    #[test]
    fn tts_urls_reject_ws_and_missing_bases() {
        for base in ["", "ws://127.0.0.1:8765", "https://user@example.com"] {
            let settings = VoiceSettings {
                tts_api_base: base.into(),
                ..VoiceSettings::default()
            };
            assert!(settings.tts_speech_url().is_err(), "{base}");
        }
    }

    #[test]
    fn empty_api_base_falls_back_to_the_default() {
        let settings = VoiceSettings {
            stt_api_base: "   ".into(),
            ..VoiceSettings::default()
        };
        assert!(settings
            .stt_ws_url()
            .unwrap()
            .starts_with("wss://api.x.ai/"));
    }

    #[test]
    fn language_auto_and_unknown_resolve_to_a_catalog_code() {
        assert_eq!(language_for_api("auto"), "en");
        assert_eq!(language_for_api(""), "en");
        assert_eq!(language_for_api("kl"), "en");
        assert_eq!(language_for_api("JA"), "ja");
        assert_eq!(language_for_api(" fr "), "fr");
    }

    #[test]
    fn grok_credential_parses_the_issuer_keyed_shape() {
        let source = r#"{
            "https://auth.x.ai::b1a00492-073a": {
                "key": "token-value",
                "email": "person@example.com",
                "expires_at": "2026-08-02T20:25:31.501964Z",
                "refresh_token": "refresh-value"
            }
        }"#;
        let credential = parse_grok_credential(source).unwrap();
        assert_eq!(credential.bearer, "token-value");
        assert_eq!(credential.email.as_deref(), Some("person@example.com"));
        assert_eq!(
            credential.expires_at.as_deref(),
            Some("2026-08-02T20:25:31.501964Z")
        );
    }

    #[test]
    fn grok_credential_ignores_shapes_it_does_not_recognise() {
        assert!(parse_grok_credential("not json").is_none());
        assert!(parse_grok_credential("{}").is_none());
        assert!(parse_grok_credential(r#"{"https://auth.x.ai::a": {}}"#).is_none());
        assert!(parse_grok_credential(r#"{"https://auth.x.ai::a": {"key": "  "}}"#).is_none());
        // A non-xAI issuer is not ours to read.
        assert!(parse_grok_credential(r#"{"https://other.example": {"key": "t"}}"#).is_none());
    }

    #[test]
    fn server_events_parse_including_unknown_fields() {
        let created: SttServerEvent =
            serde_json::from_str(r#"{"type":"transcript.created","id":"abc"}"#).unwrap();
        assert_eq!(created, SttServerEvent::Created);

        let partial: SttServerEvent = serde_json::from_str(
            r#"{"type":"transcript.partial","text":"hello","words":[],"is_final":true,
                "speech_final":false,"start":0.0,"duration":0.5}"#,
        )
        .unwrap();
        assert_eq!(
            partial,
            SttServerEvent::Partial {
                text: "hello".into(),
                is_final: true,
                speech_final: false,
            }
        );

        let final_event: SttServerEvent =
            serde_json::from_str(r#"{"type":"transcript.final","text":"done"}"#).unwrap();
        assert_eq!(
            final_event,
            SttServerEvent::Final {
                text: "done".into()
            }
        );

        let provider_error: SttServerEvent = serde_json::from_str(
            r#"{"type":"error","event":"transcript.error","code":"stream_timeout","message":"timed out"}"#,
        )
        .unwrap();
        assert_eq!(
            provider_error,
            SttServerEvent::Error {
                message: "timed out".into()
            }
        );

        let done: SttServerEvent =
            serde_json::from_str(r#"{"type":"transcript.done","text":"hi","duration":0.5}"#)
                .unwrap();
        assert_eq!(done, SttServerEvent::Done { text: "hi".into() });

        let unknown: SttServerEvent =
            serde_json::from_str(r#"{"type":"transcript.something_new"}"#).unwrap();
        assert_eq!(unknown, SttServerEvent::Unknown);
    }

    #[test]
    fn stitcher_accumulates_chunk_finals_into_the_preview() {
        let mut stitcher = TranscriptStitcher::new();
        assert_eq!(
            stitcher.apply("open the", false, false),
            Some(Transcript::Interim("open the".into()))
        );
        assert_eq!(
            stitcher.apply("open the file", true, false),
            Some(Transcript::Interim("open the file".into()))
        );
        // A later non-final rides on top of the locked prefix rather than
        // replacing it — this is the "long sentence resets" bug.
        assert_eq!(
            stitcher.apply("and rename", false, false),
            Some(Transcript::Interim("open the file and rename".into()))
        );
        assert_eq!(
            stitcher.apply("and rename it", true, false),
            Some(Transcript::Interim("open the file and rename it".into()))
        );
    }

    #[test]
    fn speech_final_commits_the_server_retranscription_and_resets() {
        let mut stitcher = TranscriptStitcher::new();
        stitcher.apply("open the file", true, false);
        // Deliberately different from the stitched preview: the one-pass
        // re-transcription is what gets committed, not our accumulation.
        assert_eq!(
            stitcher.apply("Open the file.", true, true),
            Some(Transcript::Final("Open the file.".into()))
        );
        assert_eq!(
            stitcher.apply("next", false, false),
            Some(Transcript::Interim("next".into())),
            "prefix must not survive the commit"
        );
    }

    #[test]
    fn stitcher_ignores_blank_partials() {
        let mut stitcher = TranscriptStitcher::new();
        assert_eq!(stitcher.apply("", false, false), None);
        assert_eq!(stitcher.apply("   ", true, true), None);
    }

    #[test]
    fn reset_clears_accumulated_preview() {
        let mut stitcher = TranscriptStitcher::new();
        stitcher.apply("dropped", true, false);
        stitcher.reset();
        assert_eq!(
            stitcher.apply("fresh", false, false),
            Some(Transcript::Interim("fresh".into()))
        );
    }
}
