// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if maxx_lib::browser_runtime::requested() {
        if let Err(error) = maxx_lib::browser_runtime::run_from_environment() {
            eprintln!("browser MCP bridge failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    maxx_lib::run();
}
