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

    /// Timeout defaults and the poll cadence for blocking wait/watch loops.
    private static let waitDefaultTimeoutMs = 30_000
    private static let maxTimeoutMs = 3_600_000  // 1 hour hard cap
    private static let pollIntervalMicros: useconds_t = 150_000  // 150 ms

    private func handleConnection(_ fd: Int32) {
        defer { Darwin.close(fd) }

        // Never let a write to a vanished client raise SIGPIPE and kill the app.
        setNoSigpipe(fd)

        // Bound how long a single connection can occupy a worker thread while we
        // read the request: a client that connects and never sends a full
        // request must not pin the thread (and exhaust the pool) indefinitely.
        // Blocking wait/watch loops do not read again, so this does not bound
        // their (separately capped) duration.
        setReadTimeout(fd, seconds: 5)

        guard let data = readRequest(fd) else {
            sendResponse(.failure(ControlError(.invalidRequest, "could not read request")), to: fd)
            return
        }

        let request: ControlRequest
        do {
            request = try JSONDecoder().decode(ControlRequest.self, from: data)
        } catch {
            sendResponse(.failure(ControlError(.invalidRequest, "invalid JSON request")), to: fd)
            return
        }

        guard authorize(request.token) else {
            Self.logger.warning(
                "denied control request: unauthorized (method=\(request.method.rawValue, privacy: .public))")
            sendResponse(.failure(ControlError(.unauthorized, "invalid or missing token")), to: fd)
            return
        }

        switch request.method {
        case .sessionsWait:
            handleWait(request, fd: fd)
        case .sessionsWatch:
            handleWatch(request, fd: fd)
        default:
            sendResponse(dispatch(request), to: fd)
        }
    }

    /// Single-shot dispatch: hop to the main actor, run the handler, log.
    private func dispatch(_ request: ControlRequest) -> ControlResponse {
        let response = DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                self.registry.handle(request, host: self.host)
            }
        }

        // Observability: log the method and outcome, never the params (which may
        // contain commands, env vars, or other secrets).
        if response.ok {
            Self.logger.info("control \(request.method.rawValue, privacy: .public): ok")
        } else {
            Self.logger.info(
                "control \(request.method.rawValue, privacy: .public): error \(response.error?.code ?? "?", privacy: .public)")
        }
        return response
    }

    // MARK: - Wait (blocking single response)

    /// Block until the wait condition is observed or the timeout elapses, then
    /// send exactly one response carrying the outcome. The poll runs on this
    /// connection's background thread, hopping to the main actor only for the
    /// brief condition check, so the UI is never blocked.
    private func handleWait(_ request: ControlRequest, fd: Int32) {
        let plan: ControlSessionRegistry.WaitPlan
        do {
            plan = try DispatchQueue.main.sync {
                try MainActor.assumeIsolated { try self.registry.beginWait(request.params) }
            }
        } catch let error as ControlError {
            Self.logger.info("control sessions.wait: error \(error.code.rawValue, privacy: .public)")
            sendResponse(.failure(error), to: fd)
            return
        } catch {
            sendResponse(.failure(ControlError(.internalError, "\(error)")), to: fd)
            return
        }

        let timeoutMs = min(request.params?.timeoutMs ?? Self.waitDefaultTimeoutMs, Self.maxTimeoutMs)
        let deadline = Date().addingTimeInterval(Double(max(0, timeoutMs)) / 1000.0)

        while true {
            let progress = DispatchQueue.main.sync {
                MainActor.assumeIsolated { self.registry.pollWait(plan, host: self.host) }
            }
            switch progress {
            case let .matched(view, event)?:
                Self.logger.info("control sessions.wait: ok")
                sendResponse(.success(.init(session: view, outcome: "matched", event: event)), to: fd)
                return
            case let .ended(view)?:
                Self.logger.info("control sessions.wait: ended")
                sendResponse(.success(.init(session: view, outcome: "ended")), to: fd)
                return
            case let .pending(view)?:
                if Date() >= deadline {
                    Self.logger.info("control sessions.wait: timeout")
                    sendResponse(.success(.init(session: view, outcome: "timeout")), to: fd)
                    return
                }
                if peerClosed(fd) { return }
                usleep(Self.pollIntervalMicros)
            case .none:
                sendResponse(.failure(ControlError(.notFound, "session no longer exists")), to: fd)
                return
            }
        }
    }

    // MARK: - Watch (streaming many responses)

    /// Stream newline-delimited ``ControlStreamMessage`` objects as lifecycle and
    /// events change, until the session ends, the (optional) timeout elapses, or
    /// the client disconnects.
    private func handleWatch(_ request: ControlRequest, fd: Int32) {
        let initial: (ControlSessionRegistry.WatchPlan, ControlStreamMessage)
        do {
            initial = try DispatchQueue.main.sync {
                try MainActor.assumeIsolated {
                    try self.registry.beginWatch(request.params, host: self.host)
                }
            }
        } catch let error as ControlError {
            Self.logger.info("control sessions.watch: error \(error.code.rawValue, privacy: .public)")
            sendResponse(.failure(error), to: fd)
            return
        } catch {
            sendResponse(.failure(ControlError(.internalError, "\(error)")), to: fd)
            return
        }

        Self.logger.info("control sessions.watch: streaming")
        var plan = initial.0
        if !writeStreamMessage(initial.1, to: fd) { return }

        // An explicit timeout caps the stream; otherwise it runs until the
        // session ends or the client disconnects.
        let deadline = request.params?.timeoutMs
            .map { Date().addingTimeInterval(Double(max(0, min($0, Self.maxTimeoutMs))) / 1000.0) }

        while true {
            let update = DispatchQueue.main.sync {
                MainActor.assumeIsolated { self.registry.pollWatch(plan, host: self.host) }
            }
            plan = update.plan
            // Stop the moment a write fails (the client disconnected).
            for message in update.messages where !writeStreamMessage(message, to: fd) {
                return
            }
            if update.ended {
                _ = writeStreamMessage(
                    ControlStreamMessage(type: "end", lifecycle: plan.lastLifecycle), to: fd)
                return
            }
            if let deadline, Date() >= deadline { return }
            if peerClosed(fd) { return }
            usleep(Self.pollIntervalMicros)
        }
    }

    /// Non-blocking check for an orderly peer shutdown (the client closed the
    /// connection). A peeked read of 0 bytes means EOF.
    private func peerClosed(_ fd: Int32) -> Bool {
        var byte: UInt8 = 0
        let n = recv(fd, &byte, 1, Int32(MSG_PEEK) | Int32(MSG_DONTWAIT))
        return n == 0
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
        writeAll(out, to: fd)
    }

    /// Encode and write one streaming message terminated by a newline. Returns
    /// false if the write failed (e.g. the client disconnected), signaling the
    /// streaming loop to stop.
    private func writeStreamMessage(_ message: ControlStreamMessage, to fd: Int32) -> Bool {
        guard var out = try? JSONEncoder().encode(message) else { return false }
        out.append(0x0A)
        return writeAll(out, to: fd)
    }

    /// Write all bytes. Returns false if the peer went away (write failed).
    /// SIGPIPE is disabled per-connection (``setNoSigpipe``) so a write to a
    /// disconnected client returns EPIPE here rather than killing the app.
    @discardableResult
    private func writeAll(_ data: Data, to fd: Int32) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            guard var pointer = raw.bindMemory(to: UInt8.self).baseAddress else { return true }
            var remaining = raw.count
            while remaining > 0 {
                let n = write(fd, pointer, remaining)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                if n == 0 { return false }
                pointer = pointer.advanced(by: n)
                remaining -= n
            }
            return true
        }
    }

    /// Disable SIGPIPE for this connection so writing to a disconnected client
    /// returns EPIPE instead of terminating the process. Essential for `watch`,
    /// which may write to a client that has gone away.
    private func setNoSigpipe(_ fd: Int32) {
        var on: Int32 = 1
        _ = setsockopt(
            fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
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
