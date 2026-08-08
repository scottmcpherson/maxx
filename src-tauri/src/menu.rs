//! Native application menu.
//!
//! On macOS the Edit submenu is load-bearing rather than decorative. Tauri
//! installs `Menu::default` when `Builder::menu` is never called, and that
//! default is what gives the app Cmd+C/V/X/A/Z today: muda creates the
//! predefined clipboard items as nil-targeted `NSMenuItem`s, so their selectors
//! travel the responder chain into the `WKWebView`. Calling `Builder::menu`
//! replaces the default wholesale — omitting Edit here would silently kill
//! copy and paste app-wide.
//!
//! Custom items carry no behaviour in Rust: they emit [`MENU_EVENT`] and the
//! zustand store performs the action, so there is exactly one implementation of
//! "new thread" / "toggle sidebar" / … rather than a native and a web copy.

use serde::Serialize;
use tauri::menu::{
    AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Runtime};

/// Menu item ids, forwarded to the frontend verbatim as `MenuAction.id`.
pub const MENU_ID_SETTINGS: &str = "settings";
pub const MENU_ID_CHECK_UPDATES: &str = "check_updates";
pub const MENU_ID_NEW_THREAD: &str = "new_thread";
pub const MENU_ID_SEARCH: &str = "search";
pub const MENU_ID_TOGGLE_SIDEBAR: &str = "toggle_sidebar";
pub const MENU_ID_TOGGLE_BROWSER: &str = "toggle_browser";
pub const MENU_ID_ZOOM_IN: &str = "zoom_in";
pub const MENU_ID_ZOOM_OUT: &str = "zoom_out";
pub const MENU_ID_ZOOM_RESET: &str = "zoom_reset";

/// Tauri event carrying a menu activation to the webview.
pub const MENU_EVENT: &str = "menu://action";

#[derive(Clone, Serialize)]
pub struct MenuAction {
    pub id: String,
}

/// Ids handled entirely in the frontend. Anything not listed here either has a
/// predefined native behaviour or is handled in [`on_event`] directly.
const FORWARDED_IDS: &[&str] = &[
    MENU_ID_SETTINGS,
    MENU_ID_NEW_THREAD,
    MENU_ID_SEARCH,
    MENU_ID_TOGGLE_SIDEBAR,
    MENU_ID_TOGGLE_BROWSER,
    MENU_ID_ZOOM_IN,
    MENU_ID_ZOOM_OUT,
    MENU_ID_ZOOM_RESET,
];

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let settings = MenuItem::with_id(
        app,
        MENU_ID_SETTINGS,
        "Settings…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let check_updates = MenuItem::with_id(
        app,
        MENU_ID_CHECK_UPDATES,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let new_thread = MenuItem::with_id(
        app,
        MENU_ID_NEW_THREAD,
        "New Thread",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let search = MenuItem::with_id(app, MENU_ID_SEARCH, "Search…", true, Some("CmdOrCtrl+K"))?;
    // No *static* accelerator: both bindings are user-remappable in Settings →
    // Keyboard Shortcuts, so the frontend installs the live binding as a key
    // equivalent through [`set_shortcut_accelerators`] instead. That indirection
    // is load-bearing rather than cosmetic — a `keydown` listener in the app's
    // webview cannot see a key pressed while the browser pane's child webview
    // holds first responder, and only a menu key equivalent can.
    let toggle_sidebar = MenuItem::with_id(
        app,
        MENU_ID_TOGGLE_SIDEBAR,
        "Toggle Sidebar",
        true,
        None::<&str>,
    )?;
    let toggle_browser = MenuItem::with_id(
        app,
        MENU_ID_TOGGLE_BROWSER,
        "Toggle Right Sidebar",
        true,
        None::<&str>,
    )?;
    let zoom_in = MenuItem::with_id(app, MENU_ID_ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, MENU_ID_ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(
        app,
        MENU_ID_ZOOM_RESET,
        "Actual Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;

    // The first submenu becomes the macOS application menu; its title has to be
    // the product name and Settings… belongs directly under About.
    let mut app_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = Vec::new();
    let about_item = PredefinedMenuItem::about(app, None, Some(about))?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    #[cfg(target_os = "macos")]
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    app_items.push(&about_item);
    app_items.push(&check_updates);
    app_items.push(&sep1);
    app_items.push(&settings);
    app_items.push(&sep2);
    // Services / Show All are macOS-only in muda and error out elsewhere.
    #[cfg(target_os = "macos")]
    let services = PredefinedMenuItem::services(app, None)?;
    #[cfg(target_os = "macos")]
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    #[cfg(target_os = "macos")]
    {
        app_items.push(&services);
        app_items.push(&sep3);
    }
    app_items.push(&hide);
    app_items.push(&hide_others);
    #[cfg(target_os = "macos")]
    app_items.push(&show_all);
    app_items.push(&sep4);
    app_items.push(&quit);
    let app_menu = Submenu::with_items(app, package.name.clone(), true, &app_items)?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_thread,
            &search,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // REQUIRED. Without these the webview loses Cmd+Z / Shift+Cmd+Z / Cmd+X /
    // Cmd+C / Cmd+V / Cmd+A entirely — see the module docs.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let mut view_items: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        vec![&toggle_sidebar, &toggle_browser];
    let view_sep1 = PredefinedMenuItem::separator(app)?;
    #[cfg(target_os = "macos")]
    let view_sep2 = PredefinedMenuItem::separator(app)?;
    view_items.push(&view_sep1);
    view_items.push(&zoom_in);
    view_items.push(&zoom_out);
    view_items.push(&zoom_reset);
    #[cfg(target_os = "macos")]
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    #[cfg(target_os = "macos")]
    {
        view_items.push(&view_sep2);
        view_items.push(&fullscreen);
    }
    let view_menu = Submenu::with_items(app, "View", true, &view_items)?;

    // The magic ids are what make Tauri call `set_as_windows_menu_for_nsapp` /
    // `set_as_help_menu_for_nsapp`, giving the native window list and the Help
    // search field.
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            // Labelled "Zoom" by muda on macOS.
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Forward the activation to the webview; the zustand store does the work.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if id == MENU_ID_CHECK_UPDATES {
        crate::updater::check_in_background(app.clone());
        return;
    }
    if FORWARDED_IDS.contains(&id) {
        // Raise the window first, for the same reason `tray::forward_to_frontend`
        // does: ⌘W only hides it (see the `CloseRequested` arm in lib.rs) while
        // macOS keeps the menu bar live, so every one of these would otherwise
        // mutate state the user cannot see.
        #[cfg(desktop)]
        crate::tray::show_main_window(app);
        let _ = app.emit(MENU_EVENT, MenuAction { id: id.to_string() });
    }
}

/// Rebinds the key equivalents of the two user-remappable View items.
///
/// `None` clears the accelerator, which is also what an unmappable binding
/// resolves to on the frontend (`menuAcceleratorFor`). An accelerator muda
/// cannot parse is dropped rather than failing the whole call, so one bad
/// binding never costs the other item its shortcut.
#[tauri::command]
pub fn set_shortcut_accelerators(
    app: AppHandle,
    toggle_sidebar: Option<String>,
    toggle_browser: Option<String>,
) -> Result<(), String> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let items = menu.items().map_err(|e| e.to_string())?;
    for kind in items {
        let MenuItemKind::Submenu(submenu) = kind else {
            continue;
        };
        for child in submenu.items().map_err(|e| e.to_string())? {
            let MenuItemKind::MenuItem(item) = child else {
                continue;
            };
            let accelerator = match item.id().as_ref() {
                MENU_ID_TOGGLE_SIDEBAR => toggle_sidebar.as_deref(),
                MENU_ID_TOGGLE_BROWSER => toggle_browser.as_deref(),
                _ => continue,
            };
            if item.set_accelerator(accelerator).is_err() {
                let _ = item.set_accelerator(None::<&str>);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_ids_exclude_natively_handled_items() {
        assert!(!FORWARDED_IDS.contains(&MENU_ID_CHECK_UPDATES));
    }

    #[test]
    fn forwarded_ids_are_unique() {
        let mut seen = FORWARDED_IDS.to_vec();
        seen.sort_unstable();
        let count = seen.len();
        seen.dedup();
        assert_eq!(seen.len(), count);
    }

    /// The frontend switches on these strings; drifting them silently breaks
    /// every custom menu item.
    #[test]
    fn forwarded_ids_match_the_frontend_contract() {
        assert_eq!(
            FORWARDED_IDS,
            &[
                "settings",
                "new_thread",
                "search",
                "toggle_sidebar",
                "toggle_browser",
                "zoom_in",
                "zoom_out",
                "zoom_reset",
            ]
        );
    }
}
