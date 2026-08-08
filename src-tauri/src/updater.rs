//! Update checking.
//!
//! The check runs entirely in Rust — the webview is never granted the updater
//! permissions, so a page cannot ask the app to install anything. Results are
//! pushed to the frontend as [`UPDATE_STATUS_EVENT`].
//!
//! Shipping this end to end needs a signing keypair and a hosted manifest,
//! neither of which can live in the repository. Until `plugins.updater` in
//! `tauri.conf.json` carries a real `pubkey` and `endpoints`, a check reports
//! [`UpdateStatus::Unconfigured`] instead of failing with a confusing network
//! error. See `docs/native-integration.md`.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

pub const UPDATE_STATUS_EVENT: &str = "updater://status";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateStatus {
    Checking,
    UpToDate {
        version: String,
    },
    Available {
        version: String,
        notes: Option<String>,
    },
    /// No endpoint/pubkey configured yet — an expected state, not an error.
    Unconfigured {
        detail: String,
    },
    Failed {
        message: String,
    },
}

/// Reads `plugins.updater` out of the resolved Tauri config.
///
/// The plugin itself refuses to load without that block, so its absence here
/// means the app was built with a config this module has not seen; treat it the
/// same as an empty one.
fn configured_endpoints<R: Runtime>(app: &AppHandle<R>) -> Option<(usize, bool)> {
    let value = app.config().plugins.0.get("updater")?;
    let endpoints = value
        .get("endpoints")
        .and_then(|v| v.as_array())
        .map(|v| v.iter().filter(|e| !is_blank(e)).count())
        .unwrap_or(0);
    let has_pubkey = value.get("pubkey").map(|v| !is_blank(v)).unwrap_or(false);
    Some((endpoints, has_pubkey))
}

fn is_blank(value: &serde_json::Value) -> bool {
    match value.as_str() {
        Some(text) => text.trim().is_empty(),
        None => false,
    }
}

/// Why a check cannot run yet, or `None` when the config looks complete.
pub fn unconfigured_reason(endpoints: usize, has_pubkey: bool) -> Option<String> {
    match (endpoints, has_pubkey) {
        (0, false) => Some(
            "No update endpoint or public key is configured (plugins.updater in tauri.conf.json)."
                .to_string(),
        ),
        (0, true) => Some(
            "No update endpoint is configured (plugins.updater.endpoints in tauri.conf.json)."
                .to_string(),
        ),
        (_, false) => Some(
            "No update signing public key is configured (plugins.updater.pubkey in tauri.conf.json)."
                .to_string(),
        ),
        _ => None,
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, status: UpdateStatus) {
    let _ = app.emit(UPDATE_STATUS_EVENT, status);
}

/// Fire-and-forget check, used by the "Check for Updates…" menu item.
pub fn check_in_background<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let status = check(&app).await;
        emit(&app, status);
    });
}

/// Runs a real check and returns what it found. Never panics and never
/// installs — deciding to install is the user's, and this app has no UI for it
/// yet (see the docs).
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> UpdateStatus {
    let current = app.package_info().version.to_string();
    let (endpoints, has_pubkey) = configured_endpoints(app).unwrap_or((0, false));
    if let Some(detail) = unconfigured_reason(endpoints, has_pubkey) {
        return UpdateStatus::Unconfigured { detail };
    }

    emit(app, UpdateStatus::Checking);

    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;
        match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => UpdateStatus::Available {
                    version: update.version.clone(),
                    notes: update.body.clone(),
                },
                Ok(None) => UpdateStatus::UpToDate { version: current },
                Err(error) => UpdateStatus::Failed {
                    message: error.to_string(),
                },
            },
            Err(error) => UpdateStatus::Failed {
                message: error.to_string(),
            },
        }
    }
    #[cfg(not(desktop))]
    {
        UpdateStatus::Unconfigured {
            detail: format!("Updates are only supported on desktop (current {current})."),
        }
    }
}

/// Frontend-triggered equivalent of the menu item.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateStatus, String> {
    Ok(check(&app).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_endpoint_and_key_is_unconfigured() {
        let reason = unconfigured_reason(0, false).expect("unconfigured");
        assert!(reason.contains("endpoint"));
        assert!(reason.contains("public key"));
    }

    #[test]
    fn missing_endpoint_alone_is_reported_alone() {
        let reason = unconfigured_reason(0, true).expect("unconfigured");
        assert!(reason.contains("endpoints"));
        assert!(!reason.contains("public key"));
    }

    #[test]
    fn missing_pubkey_alone_is_reported_alone() {
        let reason = unconfigured_reason(2, false).expect("unconfigured");
        assert!(reason.contains("pubkey"));
    }

    #[test]
    fn fully_configured_runs_the_check() {
        assert_eq!(unconfigured_reason(1, true), None);
    }

    #[test]
    fn blank_strings_do_not_count_as_configuration() {
        assert!(is_blank(&serde_json::json!("")));
        assert!(is_blank(&serde_json::json!("   ")));
        assert!(!is_blank(&serde_json::json!(
            "https://example.test/updates"
        )));
    }

    #[test]
    fn status_serializes_with_a_state_tag() {
        let json = serde_json::to_value(UpdateStatus::UpToDate {
            version: "0.1.0".into(),
        })
        .unwrap();
        assert_eq!(json["state"], "upToDate");
        assert_eq!(json["version"], "0.1.0");
    }
}
