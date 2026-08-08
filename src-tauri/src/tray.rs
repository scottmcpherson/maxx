//! Menu-bar extra.
//!
//! The tray is the safety net for the "closing the window hides it" behaviour
//! installed by the `CloseRequested` arm of the builder's `.on_window_event`
//! handler in `lib.rs`: once the main window is hidden, the tray is the only
//! way back, so every entry point that can hide it must be paired with one
//! here.
//!
//! The icon is a macOS *template* image — pure black plus alpha — so AppKit
//! recolours it for light/dark menu bars and for the highlighted state. Passing
//! the full-colour app icon with `icon_as_template(true)` would render as a
//! black blob, because a template uses the alpha channel only.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::menu::{MenuAction, MENU_EVENT, MENU_ID_NEW_THREAD, MENU_ID_SETTINGS};

pub const TRAY_ID: &str = "maxx-tray";

const TRAY_ID_SHOW: &str = "tray_show";
const TRAY_ID_HIDE: &str = "tray_hide";
const TRAY_ID_NEW_THREAD: &str = "tray_new_thread";
const TRAY_ID_SETTINGS: &str = "tray_settings";
const TRAY_ID_QUIT: &str = "tray_quit";

/// Bring the main window back and give it keyboard focus.
///
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(crate::window::MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(crate::window::MAIN_LABEL) {
        let _ = window.hide();
    }
}

/// Left click toggles: hide only when the window is already the focused,
/// visible one, so a click from another app raises Maxx rather than hiding it.
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(crate::window::MAIN_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
    } else {
        show_main_window(app);
    }
}

/// Raise the window first: both of these open UI inside it, and the store
/// action is a no-op the user cannot see while the window is hidden.
fn forward_to_frontend<R: Runtime>(app: &AppHandle<R>, id: &str) {
    show_main_window(app);
    let _ = app.emit(MENU_EVENT, MenuAction { id: id.to_string() });
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_ID_SHOW, "Show Maxx", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, TRAY_ID_HIDE, "Hide Maxx", true, None::<&str>)?;
    let new_thread = MenuItem::with_id(app, TRAY_ID_NEW_THREAD, "New Thread", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, TRAY_ID_SETTINGS, "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_ID_QUIT, "Quit Maxx", true, Some("CmdOrCtrl+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &PredefinedMenuItem::separator(app)?,
            &new_thread,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .tooltip("Maxx")
        // macOS: with the menu shown on left click there is no click event to
        // toggle on. Right click still opens the menu.
        .show_menu_on_left_click(false)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_ID_SHOW => show_main_window(app),
            TRAY_ID_HIDE => hide_main_window(app),
            TRAY_ID_NEW_THREAD => forward_to_frontend(app, MENU_ID_NEW_THREAD),
            TRAY_ID_SETTINGS => forward_to_frontend(app, MENU_ID_SETTINGS),
            // The window is only ever hidden, never destroyed, so nothing
            // intercepts exit: this terminates the process directly. See the
            // "Closing the window does not orphan the app" section of
            // docs/native-integration.md for why `RunEvent::ExitRequested` +
            // `prevent_exit()` is deliberately not used.
            TRAY_ID_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // `TrayIconEvent` is `#[non_exhaustive]`; match only what we use.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    // The handle is retained by the manager's tray table when built through a
    // `Manager`; dropping an unretained `TrayIcon` removes the icon.
    builder.build(app)?;
    Ok(())
}
