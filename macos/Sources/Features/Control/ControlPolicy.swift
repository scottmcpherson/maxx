import Foundation

// The capability / policy enforcement model for the Maxx Control API (MAX-11).
//
// Maxx is the terminal-native runtime/control plane, not the workflow brain.
// External agents, scripts, services, and automations decide *intent*; Maxx
// exposes explicit terminal-control surfaces and enforces *what each caller is
// allowed to do*. This file is that enforcement layer.
//
// No-inference rule (load-bearing): a policy decision is a pure function of the
// explicit inputs — the resolved caller source, the requested capability, and
// the target object. It never consults terminal output, captured lines, process
// names, branch names, filesystem paths, idle time, or any other ambient
// terminal signal. The `evaluate(source:capability:target:)` signature has no
// access to a surface/host precisely so this guarantee is expressed as a type
// boundary, not just a convention.

// MARK: - Capabilities

/// A typed terminal-control capability.
///
/// Capabilities are modeled as typed values (not free-form strings) with stable
/// raw names for API/config serialization. The vocabulary intentionally covers
/// the full surface described in MAX-11 — including capabilities Maxx does not
/// yet implement a method for (`output:read`, `groups:list`, `automation:trigger`).
/// Those exist in the model but are reported as *unavailable* and therefore
/// always denied, so the policy contract is complete and forward-compatible: when
/// the underlying feature lands, only `isImplemented` flips. (`groups:create`
/// became implemented with MAX-7.)
enum ControlCapability: String, CaseIterable, Codable, Sendable {
    /// Enumerate / read API-created sessions (tabs) and their audit log.
    case tabsList = "tabs:list"
    /// Spawn a new tab/session.
    case tabsSpawn = "tabs:spawn"
    /// Restart a session's command in a fresh surface.
    case tabsRestart = "tabs:restart"
    /// Bring a session's surface to the foreground.
    case tabsFocus = "tabs:focus"
    /// Close / cancel / archive a session's surface.
    case tabsClose = "tabs:close"
    /// Send input text to a session.
    case inputSend = "input:send"
    /// Press keys / deliver a signal (Ctrl-C, SIGTERM, …) to the foreground
    /// process. In Maxx today this is the `interrupt` action.
    case keysPress = "keys:press"
    /// Read terminal output / captured lines. Privacy-sensitive; see below.
    case outputRead = "output:read"
    /// Declare workflow state / events for a session (`declare-state`,
    /// `set-state`, `set-summary`, `emit-event`).
    case stateSet = "state:set"
    /// Set caller-owned metadata on a session.
    case metadataSet = "metadata:set"
    /// List tab groups.
    case groupsList = "groups:list"
    /// Create a tab group.
    case groupsCreate = "groups:create"
    /// Fire a webhook / automation trigger.
    case automationTrigger = "automation:trigger"

    /// True when a method actually exists for this capability in this build.
    ///
    /// `groups:create` became implemented with MAX-7 (`sessions.set-group` and
    /// `sessions create --group`); `metadata:set` is implemented and enforced as
    /// of MAX-4 (set/remove/clear-metadata and metadata-only updates — see
    /// `ControlPolicyMapping`). Output readback, group *listing*, and automation
    /// triggers remain part of the policy vocabulary but have no method behind
    /// them yet, so the evaluator reports them as unavailable (denied) regardless
    /// of allowlists.
    var isImplemented: Bool {
        switch self {
        case .tabsList, .tabsSpawn, .tabsRestart, .tabsFocus, .tabsClose,
             .inputSend, .keysPress, .stateSet, .metadataSet, .groupsCreate:
            return true
        case .outputRead, .groupsList, .automationTrigger:
            return false
        }
    }

    /// A read-only observation capability (vs. a state mutation).
    var isRead: Bool {
        switch self {
        case .tabsList, .outputRead, .groupsList:
            return true
        default:
            return false
        }
    }

    /// Privacy-sensitive capabilities require an *explicit* opt-in: they are
    /// never granted by a kind-based default, only by an explicit allowlist entry
    /// (and even then remain denied while `isImplemented` is false). Reading
    /// terminal output is the canonical example.
    var isSensitive: Bool {
        switch self {
        case .outputRead:
            return true
        default:
            return false
        }
    }

    /// The set of capabilities with a real method behind them. Used to grant the
    /// trusted first-party local source everything it can actually do.
    static let allImplemented: Set<ControlCapability> =
        Set(allCases.filter(\.isImplemented))

    /// Verb phrase for a user-facing confirmation prompt ("… is requesting to
    /// <phrase> <target>").
    var actionPhrase: String {
        switch self {
        case .tabsList: return "list"
        case .tabsSpawn: return "spawn"
        case .tabsRestart: return "restart"
        case .tabsFocus: return "focus"
        case .tabsClose: return "close"
        case .inputSend: return "send input to"
        case .keysPress: return "press keys / signal"
        case .outputRead: return "read output from"
        case .stateSet: return "set workflow state on"
        case .metadataSet: return "set metadata on"
        case .groupsList: return "list groups in"
        case .groupsCreate: return "create a group in"
        case .automationTrigger: return "trigger automation in"
        }
    }

    /// A short consequence clause for the confirmation prompt, so the user
    /// understands the impact before approving.
    var consequence: String {
        switch self {
        case .tabsSpawn, .tabsRestart:
            return "this starts a new process"
        case .tabsClose:
            return "this ends the session and its process"
        case .inputSend:
            return "this writes to the terminal as if typed"
        case .keysPress:
            return "this can interrupt or kill the running process"
        case .tabsFocus:
            return "this changes which tab is frontmost"
        case .stateSet, .metadataSet:
            return "this changes control-plane state shown in the UI"
        case .outputRead:
            return "this exposes terminal contents to the caller"
        default:
            return "this affects terminal state"
        }
    }
}

// MARK: - Sources

/// The kind of caller a source represents. Trust is configured per source; it is
/// never derived from process names, paths, or other ambient signals.
enum ControlSourceKind: String, Codable, Sendable {
    /// First-party / same-user local caller (e.g. the `maxx +control` CLI).
    case local
    /// An external process or agent.
    case external
    /// A webhook / automation origin. Modeled separately so triggers get their
    /// own capabilities rather than inheriting broad terminal control.
    case webhook
    /// A token/key-based identity.
    case token
}

/// How often a `confirm` capability must be confirmed for a source.
enum ControlConfirmScope: String, Codable, Sendable {
    /// Confirm every time the capability is exercised.
    case always
    /// Confirm once; subsequent uses of the same capability by the same source
    /// are allowed for the lifetime of this app/control session.
    case oncePerSource = "once_per_source"
}

/// A configured policy source: an explicit caller identity and the capabilities
/// it may use, optionally gated by confirmation.
struct ControlPolicySource: Sendable {
    let id: String
    let kind: ControlSourceKind
    /// Capabilities allowed without confirmation.
    let allow: Set<ControlCapability>
    /// Capabilities allowed but requiring confirmation.
    let confirm: Set<ControlCapability>
    /// Confirmation cadence for this source's `confirm` capabilities.
    let confirmScope: ControlConfirmScope

    init(
        id: String,
        kind: ControlSourceKind,
        allow: Set<ControlCapability> = [],
        confirm: Set<ControlCapability> = [],
        confirmScope: ControlConfirmScope = .always
    ) {
        self.id = id
        self.kind = kind
        self.allow = allow
        self.confirm = confirm
        self.confirmScope = confirmScope
    }
}

/// The result of resolving a caller claim against the policy.
enum ControlResolvedSource: Sendable {
    case known(ControlPolicySource)
    case unknown(String)

    /// The source identifier, configured or claimed.
    var id: String {
        switch self {
        case let .known(source): return source.id
        case let .unknown(id): return id
        }
    }

    var kind: ControlSourceKind? {
        switch self {
        case let .known(source): return source.kind
        case .unknown: return nil
        }
    }
}

// MARK: - Targets

/// The object a control request acts on, used only to render a precise
/// confirmation prompt / audit line. Carries the caller-supplied target id
/// verbatim; the policy never loads the session or inspects its state.
enum ControlTarget: Sendable {
    case session(String)
    case newSurface(String)
    case collection
    case none

    var description: String {
        switch self {
        case let .session(id): return "session \(id)"
        case let .newSurface(location): return "a new \(location)"
        case .collection: return "the session list"
        case .none: return "the control plane"
        }
    }
}

// MARK: - Decision

/// The outcome of a policy evaluation.
enum ControlPolicyDecision: Equatable, Sendable {
    case allow
    /// Denied, with a stable human-readable reason for logs/diagnostics.
    case deny(String)
    /// Allowed only after explicit user confirmation; carries the prompt text
    /// naming the source, action, target, and consequence.
    case confirm(String)
}

/// A default disposition for capabilities a source does not explicitly list.
enum ControlPolicyDisposition: String, Codable, Sendable {
    case allow
    case deny
    case confirm
}

// MARK: - Policy

/// The policy: global defaults plus a set of configured sources. Pure and
/// value-typed so it is trivially unit-testable and carries no app state.
struct ControlPolicy: Sendable {
    /// Default dispositions applied when a source does not explicitly list a
    /// capability. Mirrors the documented MAX-11 shape:
    /// `unknownSource: deny`, `externalSource: deny`, `localMutation: confirm`.
    struct Defaults: Sendable {
        /// Disposition for a caller that resolves to no configured source.
        var unknownSource: ControlPolicyDisposition
        /// Disposition for an unlisted capability on an external/webhook/token
        /// source (the "external callers cannot mutate by default" rule).
        var externalSource: ControlPolicyDisposition
        /// Disposition for an unlisted *mutation* on a local source.
        var localMutation: ControlPolicyDisposition
        /// Disposition for an unlisted *read* on a local source.
        var localRead: ControlPolicyDisposition

        init(
            unknownSource: ControlPolicyDisposition = .deny,
            externalSource: ControlPolicyDisposition = .deny,
            localMutation: ControlPolicyDisposition = .confirm,
            localRead: ControlPolicyDisposition = .allow
        ) {
            self.unknownSource = unknownSource
            self.externalSource = externalSource
            self.localMutation = localMutation
            self.localRead = localRead
        }
    }

    var defaults: Defaults
    var sources: [String: ControlPolicySource]

    /// The source a request is attributed to when it makes no explicit `caller`
    /// claim. The control socket's capability token already proves a same-user,
    /// first-party local caller, so an unclaimed request is the trusted local
    /// CLI.
    static let defaultSourceID = "local-cli"

    init(defaults: Defaults = .init(), sources: [ControlPolicySource]) {
        self.defaults = defaults
        self.sources = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0) })
    }

    /// Resolve a caller claim to a configured source. An omitted claim resolves
    /// to the trusted first-party local source; an unrecognized claim resolves to
    /// `.unknown` (and falls under the deny-by-default rule).
    func resolve(_ claim: String?) -> ControlResolvedSource {
        let id = (claim?.isEmpty == false ? claim! : Self.defaultSourceID)
        if let source = sources[id] { return .known(source) }
        return .unknown(id)
    }

    /// Evaluate a single request. PURE: depends only on the explicit `source`,
    /// `capability`, and `target` — never on terminal output, process state, or
    /// any ambient signal. (`target` is used solely to phrase the result.)
    func evaluate(
        source: ControlResolvedSource,
        capability: ControlCapability,
        target: ControlTarget
    ) -> ControlPolicyDecision {
        // A capability with no implementation behind it is unavailable and
        // always denied, even if a source explicitly allowlists it. This keeps
        // privacy-sensitive readback and not-yet-built features off until they
        // ship; flipping `isImplemented` is the only change needed later.
        guard capability.isImplemented else {
            return .deny(
                "capability '\(capability.rawValue)' is not available in this build")
        }

        switch source {
        case let .unknown(id):
            return dispose(
                defaults.unknownSource,
                source: id, kind: nil, capability: capability, target: target,
                denyReason: "unknown source '\(id)' is not in the policy")

        case let .known(configured):
            // Explicit allowlist wins.
            if configured.allow.contains(capability) {
                return .allow
            }
            if configured.confirm.contains(capability) {
                return .confirm(prompt(configured.id, configured.kind, capability, target))
            }

            // Not explicitly listed → fall back to a kind-based default.
            // Sensitive capabilities require an explicit opt-in and are never
            // granted by a default.
            if capability.isSensitive {
                return .deny(
                    "capability '\(capability.rawValue)' is sensitive and requires explicit opt-in for source '\(configured.id)'")
            }

            switch configured.kind {
            case .local:
                let disposition = capability.isRead ? defaults.localRead : defaults.localMutation
                return dispose(
                    disposition,
                    source: configured.id, kind: configured.kind,
                    capability: capability, target: target,
                    denyReason: "source '\(configured.id)' is not allowed '\(capability.rawValue)'")
            case .external, .webhook, .token:
                return dispose(
                    defaults.externalSource,
                    source: configured.id, kind: configured.kind,
                    capability: capability, target: target,
                    denyReason: "external source '\(configured.id)' is not allowed '\(capability.rawValue)' by default")
            }
        }
    }

    /// Turn a default disposition into a concrete decision, supplying the deny
    /// reason / confirmation prompt text.
    private func dispose(
        _ disposition: ControlPolicyDisposition,
        source: String,
        kind: ControlSourceKind?,
        capability: ControlCapability,
        target: ControlTarget,
        denyReason: String
    ) -> ControlPolicyDecision {
        switch disposition {
        case .allow: return .allow
        case .deny: return .deny(denyReason)
        case .confirm: return .confirm(prompt(source, kind, capability, target))
        }
    }

    /// Build a user-facing confirmation prompt that names the source, the
    /// requested action, the target, and the consequence (AC: "Confirmation
    /// prompts clearly identify the caller/source, requested action, target, and
    /// consequence").
    private func prompt(
        _ source: String,
        _ kind: ControlSourceKind?,
        _ capability: ControlCapability,
        _ target: ControlTarget
    ) -> String {
        let kindLabel = kind.map { " (\($0.rawValue))" } ?? ""
        return "Source '\(source)'\(kindLabel) is requesting to "
            + "\(capability.actionPhrase) \(target.description) "
            + "[\(capability.rawValue)]. \(capability.consequence). Approve?"
    }
}

// MARK: - Built-in default policy

extension ControlPolicy {
    /// Maxx's built-in default policy.
    ///
    /// Design under the current single-token transport: a valid capability token
    /// proves a same-user, first-party local caller. The default trusted source
    /// `local-cli` is therefore granted every implemented capability without
    /// confirmation, so existing first-party/local flows keep working unchanged
    /// (AC: "Existing first-party/local flows continue to work").
    ///
    /// The remaining built-in sources are all strict *subsets* of `local-cli`,
    /// so a token holder claiming one of them via `--as` can only *reduce* its
    /// own privileges, never escalate. They exist to (a) demonstrate and exercise
    /// the deny / confirmation / external-read paths end-to-end and (b) document
    /// the intended config shape. Credential-bound external/webhook sources that
    /// are *more* privileged than the default — and the secure key storage /
    /// rotation they require — are explicit follow-up work (see MAX-11 risks).
    static let `default` = ControlPolicy(
        defaults: .init(
            unknownSource: .deny,
            externalSource: .deny,
            localMutation: .confirm,
            localRead: .allow),
        sources: [
            // Trusted first-party CLI: full implemented surface, no friction.
            ControlPolicySource(
                id: "local-cli",
                kind: .local,
                allow: ControlCapability.allImplemented),

            // A local source that confirms every mutation — demonstrates the
            // confirmation path. Reads flow without a prompt.
            ControlPolicySource(
                id: "local-prompt",
                kind: .local,
                allow: [.tabsList],
                confirm: [
                    .tabsSpawn, .tabsRestart, .tabsFocus, .tabsClose,
                    .inputSend, .keysPress, .stateSet,
                ],
                confirmScope: .always),

            // A webhook/automation origin with its own narrow allowlist: it may
            // spawn tabs and declare state, nothing else. Any other capability
            // (input, close, output) falls to the external deny default.
            ControlPolicySource(
                id: "trusted-automation",
                kind: .webhook,
                allow: [.tabsSpawn, .stateSet]),

            // A read-only external caller: may observe sessions but cannot mutate
            // them and cannot read terminal output.
            ControlPolicySource(
                id: "readonly-external",
                kind: .external,
                allow: [.tabsList]),
        ])
}

// MARK: - Method → capability mapping

/// Maps a control request to the capability it exercises and the target it acts
/// on. Kept separate from the wire protocol and the registry so the enforcement
/// choke point and the `policy.check` diagnostic share one source of truth.
enum ControlPolicyMapping {
    /// The capability a method (and, for `sessions.action`, its sub-action)
    /// requires. Returns `nil` for requests that are intentionally *ungated*:
    ///
    ///   * `policy.check` — read-only policy introspection, no side effect.
    ///   * `sessions.action` with a missing/unknown action — left to the handler
    ///     to reject with its existing error, so error semantics are unchanged.
    ///   * a no-op `sessions.update` that writes neither `status` nor `metadata`.
    static func capability(
        for method: ControlMethod,
        params: ControlRequest.Params?
    ) -> ControlCapability? {
        switch method {
        case .sessionsList, .sessionsGet, .sessionsEvents, .sessionsWait, .sessionsWatch,
             .streamWatch, .streamWait:
            // Observing the cross-resource event stream is the same read
            // capability as listing/observing sessions.
            return .tabsList
        case .sessionsCreate:
            return .tabsSpawn
        case .sessionsSetGroup, .sessionsSetParent:
            // Assigning/clearing group membership (`set-group`, MAX-7) or a parent
            // edge (`set-parent`, MAX-6) is the group-mutation capability: both are
            // explicit association edges between sessions. `create --group` /
            // `create --parent` enforce it as a secondary check on top of
            // `tabs:spawn`. Enforced before any session/parent lookup, so a denied
            // caller cannot use it as a session-existence oracle.
            return .groupsCreate
        case .sessionsRestart:
            return .tabsRestart
        case .sessionsArchive:
            return .tabsClose
        case .sessionsAction:
            switch params?.action ?? "" {
            case "focus": return .tabsFocus
            case "input": return .inputSend
            case "interrupt": return .keysPress
            case "cancel", "close": return .tabsClose
            default: return nil
            }
        case .sessionsDeclareState, .sessionsEmitEvent, .sessionsSetState, .sessionsSetSummary,
             .sessionsSetAgentType:
            // Declaring the agent type (MAX-5) is an agent self-declaration, gated
            // like the other declared-fact verbs by `state:set`.
            return .stateSet
        case .sessionsUpdate:
            // `update` writes caller-owned `status` and/or `metadata`. A `status`
            // write is a state mutation — the same field `declare-state` writes
            // and `wait --state` matches — so it is gated by `state:set` (the
            // stronger gate when both are present). A metadata-only update is
            // gated by `metadata:set` (MAX-4). A no-op update gates on nothing.
            if params?.status != nil { return .stateSet }
            return params?.metadata != nil ? .metadataSet : nil
        case .sessionsSetMetadata, .sessionsRemoveMetadata, .sessionsClearMetadata:
            // The agent-reported metadata write surface (MAX-4) is gated by
            // `metadata:set`.
            return .metadataSet
        case .policyCheck:
            return nil
        }
    }

    /// The target a method acts on, for confirmation/audit phrasing only.
    static func target(
        for method: ControlMethod,
        params: ControlRequest.Params?
    ) -> ControlTarget {
        switch method {
        case .sessionsList:
            return .collection
        case .sessionsCreate:
            let location = params?.location ?? "tab"
            return .newSurface(location == "window" ? "window" : "tab")
        default:
            if let id = params?.id, !id.isEmpty { return .session(id) }
            return .none
        }
    }
}
