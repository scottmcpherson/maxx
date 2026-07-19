import Foundation
import os

// User-authored agent profiles (cross-provider subagents).
//
// A profile is a named bundle of create-time inputs — `command`, `agent_type`,
// `env`, and `metadata` — so a caller can spawn a well-known agent (Claude Code,
// Codex, an OpenRouter-backed model, a local runner, …) by name rather than
// repeating its full invocation. `sessions.create --profile <name>` expands the
// profile; explicit caller-supplied fields always override the profile's.
//
// This is deliberately a *read-only, user-authored* config file (like
// `control-policy.json`), not an API-managed durable registry: profiles are the
// user's own definitions, so Maxx never writes this file and the Control API
// never mutates it. Maxx stores and applies exactly what the file says and never
// infers a profile from a command, path, or process name (see docs/no-inference.md).

/// One agent profile: create-time inputs applied when a session names it.
///
/// Every field is optional so a profile can specify only what it needs. `env`
/// values may hold secrets (API keys), so they are applied to the spawned
/// process but — like every create-time `--env` — never persisted to the session
/// registry, and never returned by `profiles.list` (only the key names are).
struct ControlAgentProfile: Equatable {
    var command: String?
    var agentType: String?
    /// `KEY=VALUE` environment entries, applied at spawn only.
    var env: [String]
    var metadata: [String: ControlJSONValue]

    init(
        command: String? = nil,
        agentType: String? = nil,
        env: [String] = [],
        metadata: [String: ControlJSONValue] = [:]
    ) {
        self.command = command
        self.agentType = agentType
        self.env = env
        self.metadata = metadata
    }
}

/// Errors surfaced while loading the profiles file. A load failure never breaks
/// the control plane: the caller falls back to "no profiles", so an absent or
/// malformed file simply means `--profile` names nothing.
enum ControlProfileError: Error, LocalizedError, Equatable {
    case fileTooLarge
    case unsupportedVersion(Int)
    case tooManyProfiles
    case invalidProfileName(String)

    var errorDescription: String? {
        switch self {
        case .fileTooLarge:
            return "profiles file exceeds \(ControlProfileStore.maxFileBytes) bytes"
        case let .unsupportedVersion(version):
            return "unsupported profiles file version \(version)"
        case .tooManyProfiles:
            return "profiles file has more than \(ControlProfileStore.maxProfiles) profiles"
        case let .invalidProfileName(name):
            return "invalid profile name '\(name)'"
        }
    }
}

/// Loads the user-authored agent profiles file.
///
/// Location: `MAXX_PROFILES_FILE` if set, else
/// `~/Library/Application Support/<bundle-id>/agent-profiles.json` — a persistent,
/// user-owned config path (NOT the `/tmp` control runtime directory), so profiles
/// survive reboots and are managed by the user, never by Maxx.
///
/// Accepted JSON, either shape:
///   * a versioned envelope: `{ "version": 1, "profiles": { "<name>": {…} } }`
///   * a bare map: `{ "<name>": { "command": "…", "agent_type": "…",
///     "env": ["K=V"], "metadata": {…} } }`
struct ControlProfileStore {
    static let maxFileBytes = 256 * 1024
    static let maxProfiles = 128
    static let currentVersion = 1

    let fileURL: URL?

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx",
        category: "ControlProfileStore")

    static func defaultFileURL(
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL? {
        if let override = environment["MAXX_PROFILES_FILE"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: false)
        }
        guard let base = fileManager.urls(
            for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let bundleID = Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx"
        return base
            .appendingPathComponent(bundleID, isDirectory: true)
            .appendingPathComponent("agent-profiles.json", isDirectory: false)
    }

    /// Load the profiles map, or an empty map on any problem (absent / too large /
    /// unreadable / malformed). Never throws to the control plane — a bad file just
    /// means no profiles are available.
    func load() -> [String: ControlAgentProfile] {
        guard let fileURL else { return [:] }
        do {
            return try loadThrowing(fileURL: fileURL)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain
            && error.code == NSFileReadNoSuchFileError {
            return [:]  // No profiles file: the common case.
        } catch {
            Self.logger.error(
                "failed to load agent profiles at \(fileURL.path, privacy: .public): \(String(describing: error), privacy: .public); no profiles available")
            return [:]
        }
    }

    /// The throwing core, exposed for tests and offline validation.
    func loadThrowing(fileURL: URL) throws -> [String: ControlAgentProfile] {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        if let size = attrs[.size] as? NSNumber, size.intValue > Self.maxFileBytes {
            throw ControlProfileError.fileTooLarge
        }
        let data = try Data(contentsOf: fileURL, options: [.mappedIfSafe])
        return try Self.profiles(from: data)
    }

    static func profiles(from data: Data) throws -> [String: ControlAgentProfile] {
        guard data.count <= maxFileBytes else { throw ControlProfileError.fileTooLarge }
        let decoder = JSONDecoder()
        let file = try decoder.decode(ProfilesFile.self, from: data)
        if let version = file.version, version != currentVersion {
            throw ControlProfileError.unsupportedVersion(version)
        }
        let raw = file.profiles ?? file.bareProfiles
        guard raw.count <= maxProfiles else { throw ControlProfileError.tooManyProfiles }

        var result: [String: ControlAgentProfile] = [:]
        for (name, entry) in raw {
            guard isValidProfileName(name) else {
                throw ControlProfileError.invalidProfileName(name)
            }
            result[name] = ControlAgentProfile(
                command: entry.command,
                agentType: entry.agentType,
                env: entry.env ?? [],
                metadata: entry.metadata ?? [:])
        }
        return result
    }

    /// Profile names share the namespaced-token rules used for agent types/groups,
    /// so a name is a stable opaque token Maxx never derives meaning from.
    static func isValidProfileName(_ name: String) -> Bool {
        guard !name.isEmpty, name.count <= 128 else { return false }
        return ControlValidation.isValidNamespacedName(name)
    }
}

/// The on-disk JSON shape. Accepts both the versioned envelope (`version` +
/// `profiles`) and a bare top-level map of name → entry, decoded via a custom
/// initializer so an unknown top-level key set does not fail the whole decode.
private struct ProfilesFile: Decodable {
    var version: Int?
    var profiles: [String: ProfileEntry]?
    var bareProfiles: [String: ProfileEntry] = [:]

    private enum CodingKeys: String, CodingKey {
        case version, profiles
    }

    init(from decoder: Decoder) throws {
        // Try the envelope shape first.
        if let container = try? decoder.container(keyedBy: CodingKeys.self),
           container.contains(.profiles) {
            version = try container.decodeIfPresent(Int.self, forKey: .version)
            profiles = try container.decodeIfPresent(
                [String: ProfileEntry].self, forKey: .profiles)
            return
        }
        // Otherwise the whole document is the profiles map.
        bareProfiles = try decoder.singleValueContainer()
            .decode([String: ProfileEntry].self)
    }
}

private struct ProfileEntry: Decodable {
    var command: String?
    var agentType: String?
    var env: [String]?
    var metadata: [String: ControlJSONValue]?

    enum CodingKeys: String, CodingKey {
        case command
        case agentType = "agent_type"
        case env, metadata
    }
}
