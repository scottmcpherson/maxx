import Foundation

/// Filesystem locations for the external Maxx Control API.
///
/// The control surface is intentionally local-only: a Unix domain socket plus a
/// capability token, both inside a per-user directory created with `0700`
/// permissions. This mirrors the well-trodden tmux approach
/// (`/tmp/tmux-<uid>/default`) and keeps the rendezvous path short enough to fit
/// in a `sockaddr_un.sun_path` (104 bytes on Darwin), which a path under
/// `~/Library/Application Support` would not reliably do.
///
/// The Zig CLI (`maxx +control`) derives the exact same paths so the two can
/// rendezvous without any shared configuration. Both honor `MAXX_CONTROL_DIR`.
enum ControlPaths {
    /// The directory holding the control socket and token file.
    ///
    /// Defaults to `/tmp/maxx-control-<uid>`. Override with the
    /// `MAXX_CONTROL_DIR` environment variable (used by tests and advanced
    /// setups). The directory is created `0700` by the server.
    static var directory: URL {
        if let override = ProcessInfo.processInfo.environment["MAXX_CONTROL_DIR"],
           !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }

        let uid = getuid()
        return URL(fileURLWithPath: "/tmp/maxx-control-\(uid)", isDirectory: true)
    }

    /// The Unix domain socket the control server listens on.
    static var socket: URL {
        directory.appendingPathComponent("control.sock", isDirectory: false)
    }

    /// The capability token file. Written `0600`; readable only by the user.
    static var token: URL {
        directory.appendingPathComponent("token", isDirectory: false)
    }
}
