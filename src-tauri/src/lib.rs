pub mod attachments;
pub mod browser_runtime;
pub mod commands;
pub mod engine;
pub mod media;
pub mod menu;
pub mod notify;
pub mod state;
#[cfg(desktop)]
pub mod tray;
pub mod updater;
pub mod voice;
pub mod window;

use std::sync::Arc;

use browser_runtime::{BrowserRuntime, LazyManagedChromeEngine, ManagedChromeConfig};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    voice::VoiceState::install_crypto_provider();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Replaces Tauri's implicit macOS default menu. `menu::build` must keep
        // the Edit submenu — it is what routes Cmd+C/V/X/A/Z into the webview.
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![
            commands::workspace_snapshot,
            commands::active_turns,
            commands::add_project,
            commands::remove_project,
            commands::add_thread,
            commands::add_thread_with_runtime,
            commands::remove_thread,
            commands::update_thread,
            commands::update_profiles,
            commands::update_agents,
            commands::import_agent_image,
            attachments::authorize_image_previews,
            commands::start_side_thread,
            commands::send_agent_prompt,
            commands::send_prompt,
            commands::cancel_turn,
            commands::resolve_request,
            commands::provider_health,
            commands::list_provider_models,
            media::resolve_media_source,
            browser_runtime::browser_ui_tabs,
            browser_runtime::browser_ui_open_tab,
            browser_runtime::browser_ui_select_tab,
            browser_runtime::browser_ui_close_tab,
            browser_runtime::browser_ui_navigate,
            browser_runtime::browser_ui_back,
            browser_runtime::browser_ui_forward,
            browser_runtime::browser_ui_reload,
            browser_runtime::browser_ui_resize,
            browser_runtime::browser_ui_start_frame_stream,
            browser_runtime::browser_ui_stop_frame_stream,
            browser_runtime::browser_ui_artifact,
            browser_runtime::browser_ui_input,
            menu::set_shortcut_accelerators,
            updater::check_for_updates,
            voice::voice_status,
            voice::update_voice_settings,
            voice::voice_start,
            voice::voice_send_audio,
            voice::voice_stop,
        ])
        .setup(|app| {
            let browser_root = state::workspace_path().with_file_name("browser-runtime");
            let browser_config = ManagedChromeConfig::bundled(
                app.path().resource_dir()?,
                browser_root.join("chrome-profile"),
            )?;
            let browser_engine = LazyManagedChromeEngine::new(browser_config);
            let browser_runtime = tauri::async_runtime::block_on(BrowserRuntime::start(
                browser_engine,
                browser_root.join("artifacts"),
            ))?;
            let mut browser_ui_reveals = browser_runtime.subscribe_ui_reveals();
            let browser_window = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(reveal) = browser_ui_reveals.recv().await {
                    let _ = browser_window.emit("browser://reveal", reveal);
                }
            });
            app.manage(Arc::new(state::AppState::load(browser_runtime.clone())));
            app.manage(browser_runtime);
            app.manage(Arc::new(voice::VoiceState::default()));

            let handle = app.handle().clone();
            #[cfg(desktop)]
            tray::build(&handle)?;
            Ok(())
        })
        // Closing the main window hides it instead of destroying it, so the app
        // stays reachable from the tray. Nothing here touches the exit path:
        // Cmd+Q and the tray's Quit item still terminate normally.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == crate::window::MAIN_LABEL {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Maxx");

    app.run(|_app, _event| {
        // Clicking the Dock icon after the window was hidden. tao answers
        // `applicationShouldHandleReopen` with `has_visible_windows`, which is
        // false here, so AppKit skips its own restore behaviour and merely
        // reports the event: without this arm the app comes to the front with
        // no window at all and only the tray can bring it back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            tray::show_main_window(_app);
        }
    });
}
