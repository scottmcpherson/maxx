//! Background turn notifications.
//!
//! A turn can run for minutes, so the interesting moment is the one the user is
//! not looking at. When a turn reaches a terminal state and the main window is
//! not the focused window, post a native notification naming the thread.
//!
//! Only *outcomes* are worth interrupting for: `Cancelled` and `Interrupted`
//! are things the user (or a restart) just did, and re-announcing them is
//! noise.
//!
//! Delivery caveat on macOS: in a dev-profile run the plugin posts as
//! `com.apple.Terminal`, so notifications carry Terminal's name and are
//! suppressed if Terminal is muted. Only a bundled build posts as Maxx.

use maxx_core::contract::ProviderTurnTerminalState;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

/// Longest thread title we put in a notification before eliding.
const MAX_TITLE_LEN: usize = 64;

/// True when a finished turn deserves a notification.
pub fn should_notify(terminal: Option<ProviderTurnTerminalState>, window_focused: bool) -> bool {
    if window_focused {
        return false;
    }
    matches!(
        terminal,
        Some(ProviderTurnTerminalState::Completed) | Some(ProviderTurnTerminalState::Failed)
    )
}

pub fn notification_body(terminal: Option<ProviderTurnTerminalState>) -> &'static str {
    match terminal {
        Some(ProviderTurnTerminalState::Failed) => "Turn failed.",
        _ => "Turn completed.",
    }
}

/// Thread titles are free-form user/prompt text, so clamp them to something a
/// notification can actually show.
pub fn notification_title(thread_title: &str) -> String {
    let trimmed = thread_title.trim();
    if trimmed.is_empty() {
        return "Maxx".to_string();
    }
    if trimmed.chars().count() <= MAX_TITLE_LEN {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(MAX_TITLE_LEN - 1).collect();
    format!("{}…", head.trim_end())
}

fn main_window_focused<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(crate::window::MAIN_LABEL)
        .map(|window| window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

/// Post the notification for a finished turn, if it qualifies.
///
/// `.show()` returns immediately and swallows delivery failures, so there is
/// nothing useful to report back to the caller.
pub fn turn_finished<R: Runtime>(
    app: &AppHandle<R>,
    thread_title: &str,
    terminal: Option<ProviderTurnTerminalState>,
) {
    if !should_notify(terminal, main_window_focused(app)) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title(notification_title(thread_title))
        .body(notification_body(terminal))
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focused_window_never_notifies() {
        for terminal in [
            ProviderTurnTerminalState::Completed,
            ProviderTurnTerminalState::Failed,
            ProviderTurnTerminalState::Cancelled,
            ProviderTurnTerminalState::Interrupted,
        ] {
            assert!(!should_notify(Some(terminal), true));
        }
    }

    #[test]
    fn background_completion_and_failure_notify() {
        assert!(should_notify(
            Some(ProviderTurnTerminalState::Completed),
            false
        ));
        assert!(should_notify(
            Some(ProviderTurnTerminalState::Failed),
            false
        ));
    }

    #[test]
    fn user_initiated_endings_are_silent() {
        assert!(!should_notify(
            Some(ProviderTurnTerminalState::Cancelled),
            false
        ));
        assert!(!should_notify(
            Some(ProviderTurnTerminalState::Interrupted),
            false
        ));
    }

    /// A stream that ends without a terminal event is a dropped connection, not
    /// a result worth announcing.
    #[test]
    fn missing_terminal_state_is_silent() {
        assert!(!should_notify(None, false));
    }

    #[test]
    fn body_distinguishes_failure() {
        assert_eq!(
            notification_body(Some(ProviderTurnTerminalState::Failed)),
            "Turn failed."
        );
        assert_eq!(
            notification_body(Some(ProviderTurnTerminalState::Completed)),
            "Turn completed."
        );
    }

    #[test]
    fn blank_title_falls_back_to_the_app_name() {
        assert_eq!(notification_title("   "), "Maxx");
    }

    #[test]
    fn long_titles_are_elided_on_a_char_boundary() {
        let title = "é".repeat(200);
        let shown = notification_title(&title);
        assert_eq!(shown.chars().count(), MAX_TITLE_LEN);
        assert!(shown.ends_with('…'));
    }

    #[test]
    fn short_titles_pass_through_trimmed() {
        assert_eq!(notification_title("  Fix the parser  "), "Fix the parser");
    }
}
