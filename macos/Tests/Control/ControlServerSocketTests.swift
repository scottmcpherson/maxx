import Darwin
import Foundation
import Testing

@testable import Ghostty

/// Tests for ``ControlServer/probeSocket(at:)``, the single-instance guard that
/// keeps a second Maxx launch from unlinking and rebinding the socket out from
/// under a live control server (which orphaned the listener and left every
/// client's `connect()` failing with `ECONNREFUSED`).
struct ControlServerSocketTests {
    /// Bind+listen a real Unix domain socket at `path`, returning the fd. The
    /// caller must `close` it.
    private static func makeListener(at path: String) -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        precondition(fd >= 0, "socket() failed")

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        precondition(bytes.count < capacity, "test path too long")
        withUnsafeMutablePointer(to: &addr.sun_path) { raw in
            raw.withMemoryRebound(to: UInt8.self, capacity: capacity) { dst in
                for (index, byte) in bytes.enumerated() { dst[index] = byte }
                dst[bytes.count] = 0
            }
        }

        unlink(path)
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        precondition(bound == 0, "bind() failed: \(errno)")
        precondition(listen(fd, 16) == 0, "listen() failed: \(errno)")
        return fd
    }

    /// Unique, short (`sun_path`-safe) scratch path per test.
    private static func scratchPath(_ tag: String) -> String {
        "/tmp/maxx-probe-\(getpid())-\(tag).sock"
    }

    @Test func absentWhenNothingAtPath() {
        let path = Self.scratchPath("absent")
        unlink(path)
        #expect(ControlServer.probeSocket(at: path) == .absent)
    }

    @Test func liveWhenServerIsListening() {
        let path = Self.scratchPath("live")
        let fd = Self.makeListener(at: path)
        defer {
            Darwin.close(fd)
            unlink(path)
        }
        #expect(ControlServer.probeSocket(at: path) == .live)
    }

    @Test func deadWhenSocketFileHasNoListener() {
        // Bind+listen, then close the listener but leave the socket node on disk:
        // exactly the orphaned-socket state a crashed second instance leaves
        // behind. Connecting to it yields ECONNREFUSED, so it must read as dead.
        let path = Self.scratchPath("dead")
        let fd = Self.makeListener(at: path)
        Darwin.close(fd)
        defer { unlink(path) }
        #expect(FileManager.default.fileExists(atPath: path))
        #expect(ControlServer.probeSocket(at: path) == .dead)
    }

    @Test func deadWhenNonSocketFileSquatsPath() {
        let path = Self.scratchPath("regular")
        FileManager.default.createFile(atPath: path, contents: Data("x".utf8))
        defer { unlink(path) }
        #expect(ControlServer.probeSocket(at: path) == .dead)
    }

    /// After a dead node is replaced by a fresh listener, the probe must flip
    /// back to `.live` — the recovery path a legitimate restart relies on.
    @Test func liveAfterRebindingOverDeadNode() {
        let path = Self.scratchPath("rebind")
        let stale = Self.makeListener(at: path)
        Darwin.close(stale)
        #expect(ControlServer.probeSocket(at: path) == .dead)

        let fresh = Self.makeListener(at: path)  // makeListener unlinks first
        defer {
            Darwin.close(fresh)
            unlink(path)
        }
        #expect(ControlServer.probeSocket(at: path) == .live)
    }
}
