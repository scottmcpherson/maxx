fn main() {
    env_logger::init();
    if std::env::args().any(|argument| argument == "--sidecar") {
        if let Err(error) = maxx_lib::sidecar::run() {
            eprintln!("Maxx sidecar failed: {error}");
            std::process::exit(1);
        }
    } else if maxx_lib::browser_runtime::requested() {
        if let Err(error) = maxx_lib::browser_runtime::run_from_environment() {
            eprintln!("browser MCP bridge failed: {error}");
            std::process::exit(1);
        }
    } else {
        eprintln!("Maxx is launched by its Electron desktop host.");
        std::process::exit(2);
    }
}
