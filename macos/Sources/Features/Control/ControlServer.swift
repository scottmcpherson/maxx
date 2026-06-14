import Darwin
import Foundation
import os
import Security

/// Local, token-authenticated server backing the external Maxx Control API.
///
/// Listens on a Unix domain socket and speaks newline-delimited JSON (see
/// ``ControlRequest`` / ``ControlResponse``). The socket lives in a `0700`
/// per-user directory and is itself `0600`, so only the user can connect; a
/// capability token provides defense-in-depth and authorizes cross-process
/// callers such as webhook runners.
///
/// Threading: socket I/O happens on background dispatch queues. The actual
/// session mutation hops to the main actor (where the terminal UI lives) via
/// ``ControlSessionRegistry``.
final class ControlServer {
    static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx",
        category: "ControlServer")

    /// Cap on a single request to avoid unbounded memory from a bad client.
    private static let maxRequestBytes = 1 << 20  // 1 MiB

    private let registry: ControlSessionRegistry
    private let host: ControlSessionHost
    private let token: String

    private let acceptQueue = DispatchQueue(
        label: "com.scottmcpherson.maxx.control.accept", qos: .utility)
    private let connectionQueue = DispatchQueue(
        label: "com.scottmcpherson.maxx.control.conn", qos: .utility, attributes: .concurrent)

    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?

    init(registry: ControlSessionRegistry, host: ControlSessionHost) {
        self.registry = registry
        self.host = host
        self.token = Self.generateToken()
    }

    // MARK: - Lifecycle

    /// Start listening. Logs and returns on failure rather than throwing so a
    /// control-API problem can never prevent the app from launching.
    func start() {
        do {
            try startThrowing()
            Self.logger.info(
                "control server listening at \(ControlPaths.socket.path, privacy: .public)")
        } catch {
            Self.logger.error(
                "failed to start control server: \(String(describing: error), privacy: .public)")
        }
    }

    func stop() {
        acceptSource?.cancel()
        acceptSource = nil
        listenFD = -1
        unlink(ControlPaths.socket.path)
    }

    private func startThrowing() throws {
        try prepareDirectory()
        try writeToken()

        let fd = try makeListeningSocket(at: ControlPaths.socket.path)
        listenFD = fd

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: acceptQueue)
        source.setEventHandler { [weak self] in self?.acceptPending() }
        source.setCancelHandler { Darwin.close(fd) }
        source.resume()
        acceptSource = source
    }

    // MARK: - Setup helpers

    private func prepareDirectory() throws {
        let dir = ControlPaths.directory
        try FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        // Tighten perms even if the directory already existed.
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700], ofItemAtPath: dir.path)

        // The directory lives in a world-writable location (/tmp). Before we
        // write a secret into it, verify it is a real directory we own with no
        // group/other access and is not a symlink planted by another local
        // user. Fail closed on any tampering rather than leak the token.
        var info = stat()
        guard lstat(dir.path, &info) == 0 else {
            throw ControlServerError.posix("lstat", errno)
        }
        let isDirectory = (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR)
        let ownedByUs = info.st_uid == getuid()
        let noGroupOrOther = (info.st_mode & mode_t(S_IRWXG | S_IRWXO)) == 0
        guard isDirectory, ownedByUs, noGroupOrOther else {
            throw ControlServerError.insecureDirectory(dir.path)
        }
    }

    private func writeToken() throws {
        // Create the token file with restrictive permissions atomically and
        // refuse to follow a symlink, closing the window where a freshly written
        // secret is briefly world-readable or redirected. `O_EXCL` after
        // `unlink` ensures we create a fresh regular file in our own 0700 dir.
        let path = ControlPaths.token.path
        unlink(path)
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ControlServerError.posix("open token", errno) }
        defer { Darwin.close(fd) }

        let bytes = Array(token.utf8)
        var offset = 0
        while offset < bytes.count {
            let n = bytes[offset...].withUnsafeBytes { buffer in
                Darwin.write(fd, buffer.baseAddress!, buffer.count)
            }
            if n < 0 {
                if errno == EINTR { continue }
                throw ControlServerError.posix("write token", errno)
            }
            if n == 0 { break }
            offset += n
        }
    }

    private func makeListeningSocket(at path: String) throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ControlServerError.posix("socket", errno) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else {
            Darwin.close(fd)
            throw ControlServerError.pathTooLong(path)
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { rawPtr in
            rawPtr.withMemoryRebound(to: UInt8.self, capacity: capacity) { dst in
                for (index, byte) in pathBytes.enumerated() { dst[index] = byte }
                dst[pathBytes.count] = 0
            }
        }

        // Remove any stale socket from a previous run before binding.
        unlink(path)

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(fd, sockPtr, size)
            }
        }
        guard bound == 0 else {
            let err = errno
            Darwin.close(fd)
            throw ControlServerError.posix("bind", err)
        }

        // Restrict the socket node to the owner.
        chmod(path, 0o600)

        guard listen(fd, 16) == 0 else {
            let err = errno
            Darwin.close(fd)
            throw ControlServerError.posix("listen", err)
        }

        return fd
    }

    // MARK: - Accept / connection handling

    /// Accept a single pending connection. The dispatch read source is
    /// level-triggered, so it re-fires while more connections are queued; this
    /// keeps us off the variadic `fcntl` path and avoids a blocking accept when
    /// nothing is pending.
    private func acceptPending() {
        let clientFD = accept(listenFD, nil, nil)
        if clientFD < 0 { return }
        connectionQueue.async { [weak self] in
            guard let self else { Darwin.close(clientFD); return }
            self.handleConnection(clientFD)
        }
    }

    private func handleConnection(_ fd: Int32) {
        defer { Darwin.close(fd) }

        // Bound how long a single connection can occupy a worker thread: a
        // client that connects and never sends a full request must not pin the
        // thread (and exhaust the pool) indefinitely.
        setReadTimeout(fd, seconds: 5)

        let response: ControlResponse
        if let data = readRequest(fd) {
            response = makeResponse(for: data)
        } else {
            response = .failure(ControlError(.invalidRequest, "could not read request"))
        }
        sendResponse(response, to: fd)
    }

    private func makeResponse(for data: Data) -> ControlResponse {
        let request: ControlRequest
        do {
            request = try JSONDecoder().decode(ControlRequest.self, from: data)
        } catch {
            return .failure(ControlError(.invalidRequest, "invalid JSON request"))
        }

        guard authorize(request.token) else {
            Self.logger.warning(
                "denied control request: unauthorized (method=\(request.method.rawValue, privacy: .public))")
            return .failure(ControlError(.unauthorized, "invalid or missing token"))
        }

        // Hop to the main actor to mutate session/terminal state.
        let response = DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                self.registry.handle(request, host: self.host)
            }
        }

        // Observability: log the method and outcome, never the params (which may
        // contain commands, env vars, or other secrets).
        if response.ok {
            Self.logger.info(
                "control \(request.method.rawValue, privacy: .public): ok")
        } else {
            Self.logger.info(
                "control \(request.method.rawValue, privacy: .public): error \(response.error?.code ?? "?", privacy: .public)")
        }
        return response
    }

    private func authorize(_ provided: String?) -> Bool {
        Self.tokensMatch(provided, token)
    }

    /// Constant-time token comparison. A missing or wrong-length token always
    /// fails. Exposed (non-private) so the authorization rule can be unit tested.
    static func tokensMatch(_ provided: String?, _ expected: String) -> Bool {
        guard let provided else { return false }
        let lhs = Array(provided.utf8)
        let rhs = Array(expected.utf8)
        guard lhs.count == rhs.count else { return false }
        var diff: UInt8 = 0
        for index in lhs.indices { diff |= lhs[index] ^ rhs[index] }
        return diff == 0
    }

    // MARK: - Socket I/O

    private func setReadTimeout(_ fd: Int32, seconds: Int) {
        var tv = timeval(tv_sec: seconds, tv_usec: 0)
        _ = setsockopt(
            fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    /// Read a single request: bytes up to the first newline, or until EOF.
    private func readRequest(_ fd: Int32) -> Data? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(fd, &buffer, buffer.count)
            if n < 0 {
                if errno == EINTR { continue }
                return nil
            }
            if n == 0 { break }  // EOF (peer closed / half-closed write).
            data.append(contentsOf: buffer[0..<n])
            if data.count > Self.maxRequestBytes { return nil }
            if let newline = data.firstIndex(of: 0x0A) {
                return data[..<newline]
            }
        }
        return data.isEmpty ? nil : data
    }

    private func sendResponse(_ response: ControlResponse, to fd: Int32) {
        guard var out = try? JSONEncoder().encode(response) else { return }
        out.append(0x0A)
        out.withUnsafeBytes { raw in
            guard var pointer = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            var remaining = raw.count
            while remaining > 0 {
                let n = write(fd, pointer, remaining)
                if n < 0 {
                    if errno == EINTR { continue }
                    return
                }
                if n == 0 { return }
                pointer = pointer.advanced(by: n)
                remaining -= n
            }
        }
    }

    // MARK: - Token generation

    private static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            for index in bytes.indices { bytes[index] = UInt8.random(in: .min ... .max) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

enum ControlServerError: Error, CustomStringConvertible {
    case posix(String, Int32)
    case pathTooLong(String)
    case insecureDirectory(String)

    var description: String {
        switch self {
        case let .posix(call, code):
            return "\(call) failed: \(String(cString: strerror(code)))"
        case let .pathTooLong(path):
            return "control socket path is too long for sockaddr_un: \(path)"
        case let .insecureDirectory(path):
            return "control directory is not a private directory owned by this user: \(path)"
        }
    }
}
