import Foundation
import os

/// Loader for user-configured Control API policy sources (MAX-16).
///
/// The persisted file only adds explicit sources; built-in source ids are
/// reserved so a malformed or surprising config cannot silently broaden the
/// safe defaults. Policy decisions remain a pure function of caller,
/// capability, and target after loading.
enum ControlPolicyConfigLoader {
    static let maxConfigBytes = 128 * 1024

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx",
        category: "ControlPolicyConfig")

    static func defaultPolicyURL(
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL? {
        if let override = environment["MAXX_CONTROL_POLICY_FILE"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: false)
        }

        guard let base = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            return nil
        }
        let bundleID = Bundle.main.bundleIdentifier ?? "com.scottmcpherson.maxx"
        return base
            .appendingPathComponent(bundleID, isDirectory: true)
            .appendingPathComponent("control-policy.json", isDirectory: false)
    }

    static func loadOrDefault(fileURL: URL? = defaultPolicyURL()) -> ControlPolicy {
        guard let fileURL else { return .default }
        do {
            return try load(from: fileURL)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain
            && error.code == NSFileReadNoSuchFileError {
            return .default
        } catch {
            logger.error(
                "failed to load control policy config at \(fileURL.path, privacy: .public): \(String(describing: error), privacy: .public); using built-in defaults")
            return .default
        }
    }

    static func load(from fileURL: URL) throws -> ControlPolicy {
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        if let size = attrs[.size] as? NSNumber, size.intValue > maxConfigBytes {
            throw ControlPolicyConfigError.fileTooLarge
        }

        let data = try Data(contentsOf: fileURL, options: [.mappedIfSafe])
        guard data.count <= maxConfigBytes else {
            throw ControlPolicyConfigError.fileTooLarge
        }
        return try policy(from: data)
    }

    static func policy(from data: Data) throws -> ControlPolicy {
        guard data.count <= maxConfigBytes else {
            throw ControlPolicyConfigError.fileTooLarge
        }

        let decoder = JSONDecoder()
        let file = try decoder.decode(ControlPolicyConfigFile.self, from: data)
        try file.validate()
        guard let sources = file.sources else {
            throw ControlPolicyConfigError.missingSources
        }
        let configured = try sources.map { try $0.policySource() }
        return ControlPolicy(sources: ControlPolicy.builtInSources + configured)
    }
}

enum ControlPolicyConfigError: Error, LocalizedError, Equatable {
    case fileTooLarge
    case unsupportedVersion(Int)
    case missingSources
    case tooManySources
    case invalidSourceID(String)
    case reservedSourceID(String)
    case duplicateSourceID(String)
    case overlappingCapability(String, String)

    var errorDescription: String? {
        switch self {
        case .fileTooLarge:
            return "policy config exceeds \(ControlPolicyConfigLoader.maxConfigBytes) bytes"
        case let .unsupportedVersion(version):
            return "unsupported policy config version \(version)"
        case .missingSources:
            return "policy config requires a sources array"
        case .tooManySources:
            return "policy config has too many sources"
        case let .invalidSourceID(id):
            return "invalid policy source id '\(id)'"
        case let .reservedSourceID(id):
            return "policy source id '\(id)' is reserved by Maxx"
        case let .duplicateSourceID(id):
            return "duplicate policy source id '\(id)'"
        case let .overlappingCapability(id, capability):
            return "source '\(id)' lists capability '\(capability)' in both allow and confirm"
        }
    }
}

private struct ControlPolicyConfigFile: Decodable {
    var version: Int?
    var sources: [ControlPolicySourceConfig]?

    func validate() throws {
        let effectiveVersion = version ?? 1
        guard effectiveVersion == 1 else {
            throw ControlPolicyConfigError.unsupportedVersion(effectiveVersion)
        }
        guard let sources else {
            throw ControlPolicyConfigError.missingSources
        }
        guard sources.count <= 128 else {
            throw ControlPolicyConfigError.tooManySources
        }

        var seen: Set<String> = []
        for source in sources {
            try source.validate()
            guard !ControlPolicy.builtInSourceIDs.contains(source.id) else {
                throw ControlPolicyConfigError.reservedSourceID(source.id)
            }
            guard seen.insert(source.id).inserted else {
                throw ControlPolicyConfigError.duplicateSourceID(source.id)
            }
        }
    }
}

private struct ControlPolicySourceConfig: Decodable {
    var id: String
    var kind: ControlSourceKind
    var allow: Set<ControlCapability>?
    var confirm: Set<ControlCapability>?
    var confirmScope: ControlConfirmScope?

    enum CodingKeys: String, CodingKey {
        case id, kind, allow, confirm
        case confirmScope = "confirm_scope"
    }

    func validate() throws {
        guard Self.validSourceID(id) else {
            throw ControlPolicyConfigError.invalidSourceID(id)
        }

        let allowed = allow ?? []
        let confirmed = confirm ?? []
        for capability in allowed.intersection(confirmed) {
            throw ControlPolicyConfigError.overlappingCapability(id, capability.rawValue)
        }
    }

    func policySource() throws -> ControlPolicySource {
        try validate()
        return ControlPolicySource(
            id: id,
            kind: kind,
            allow: allow ?? [],
            confirm: confirm ?? [],
            confirmScope: confirmScope ?? .always)
    }

    private static func validSourceID(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 128 else { return false }
        return id.allSatisfy { ch in
            ch.isASCII && (
                ch.isLetter || ch.isNumber ||
                    ch == "-" || ch == "_" || ch == "." || ch == ":" ||
                    ch == "/")
        }
    }
}
