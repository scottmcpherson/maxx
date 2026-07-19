import Foundation

/// A minimal, bounded JSON Schema subset for validating an agent-declared session
/// result (`set-result`).
///
/// This is the cross-provider equivalent of a structured-output contract: a
/// parent may declare, on a child session, the shape it expects the child's
/// answer to take. When a `result_schema` is declared, every `set-result` (over
/// the API or from a trusted agent-hook transcript capture) must supply a result
/// that parses as JSON and satisfies the schema, or it is rejected with
/// `invalid_request`.
///
/// The subset is deliberately small and dependency-free — enough to describe the
/// structured answers agents actually return, small enough to reason about and
/// bound. It is a *validation contract the agent declares*, never a heuristic
/// Maxx applies to terminal output, so it does not cross the no-inference line
/// (see docs/no-inference.md): Maxx only checks a declared value against a
/// declared schema.
///
/// Supported keywords (all optional; unknown keywords are ignored so the subset
/// can grow without rejecting forward-compatible schemas):
///   * `type`: one of `object`, `array`, `string`, `number`, `integer`,
///     `boolean`, `null`. `integer` also accepts a JSON number with no fraction;
///     `number` accepts both integers and doubles.
///   * `required`: an array of property-name strings (for `type: object`).
///   * `properties`: a map of property name → sub-schema (recursively validated).
///   * `items`: a sub-schema every array element must satisfy.
enum ControlResultSchema {
    /// Bound on schema nesting so a pathological schema cannot drive unbounded
    /// recursion. Schemas are already byte-capped; this bounds depth explicitly.
    static let maxDepth = 16

    static let knownTypes: Set<String> = [
        "object", "array", "string", "number", "integer", "boolean", "null",
    ]

    /// Validate that `schema` (parsed from the caller's schema text) is a
    /// well-formed schema in the supported subset. Throws `invalid_request` on a
    /// malformed schema so a caller never declares a contract Maxx cannot enforce.
    /// Only the keywords Maxx understands are structurally checked; unknown
    /// keywords are ignored (documented above), so a caller is never silently
    /// misled about an *understood* keyword while the subset stays extensible.
    static func validateSchema(_ schema: ControlJSONValue, depth: Int = 0) throws {
        guard depth <= maxDepth else {
            throw ControlError(
                .invalidRequest, "result_schema nesting exceeds \(maxDepth) levels")
        }
        guard case let .object(fields) = schema else {
            throw ControlError(.invalidRequest, "result_schema must be a JSON object")
        }
        if let typeValue = fields["type"] {
            guard case let .string(type) = typeValue, knownTypes.contains(type) else {
                throw ControlError(
                    .invalidRequest,
                    "result_schema 'type' must be one of \(knownTypes.sorted().joined(separator: ", "))")
            }
        }
        if let required = fields["required"] {
            guard case let .array(items) = required else {
                throw ControlError(
                    .invalidRequest, "result_schema 'required' must be an array of strings")
            }
            for item in items {
                guard case .string = item else {
                    throw ControlError(
                        .invalidRequest, "result_schema 'required' must be an array of strings")
                }
            }
        }
        if let properties = fields["properties"] {
            guard case let .object(props) = properties else {
                throw ControlError(
                    .invalidRequest, "result_schema 'properties' must be a JSON object")
            }
            for (_, sub) in props {
                try validateSchema(sub, depth: depth + 1)
            }
        }
        if let items = fields["items"] {
            try validateSchema(items, depth: depth + 1)
        }
    }

    /// Validate a result `value` against `schema`. Returns nil on success, or a
    /// human-readable reason for the first mismatch found (used in the error
    /// message). Pure; never consults anything but the two explicit values.
    static func mismatch(
        _ value: ControlJSONValue,
        schema: ControlJSONValue,
        path: String = "$",
        depth: Int = 0
    ) -> String? {
        // The schema was depth-validated at declare time; be lenient here rather
        // than reject an over-deep result value at a bound the schema respected.
        guard depth <= maxDepth else { return nil }
        guard case let .object(fields) = schema else { return nil }

        if let typeValue = fields["type"], case let .string(type) = typeValue,
           let reason = typeMismatch(value, type: type, path: path) {
            return reason
        }

        if case let .object(object) = value {
            if let required = fields["required"], case let .array(items) = required {
                for item in items {
                    if case let .string(key) = item, object[key] == nil {
                        return "\(path) is missing required property '\(key)'"
                    }
                }
            }
            if let properties = fields["properties"], case let .object(props) = properties {
                // Validate declared properties that are present; a missing one is
                // caught by `required` above (and is allowed when not required).
                for (key, sub) in props {
                    if let child = object[key],
                       let reason = mismatch(
                           child, schema: sub, path: "\(path).\(key)", depth: depth + 1) {
                        return reason
                    }
                }
            }
        }

        if case let .array(elements) = value, let itemsSchema = fields["items"] {
            for (index, element) in elements.enumerated() {
                if let reason = mismatch(
                    element, schema: itemsSchema, path: "\(path)[\(index)]", depth: depth + 1) {
                    return reason
                }
            }
        }

        return nil
    }

    /// Whether `value` satisfies a `type` keyword; returns a reason on mismatch.
    private static func typeMismatch(
        _ value: ControlJSONValue,
        type: String,
        path: String
    ) -> String? {
        let ok: Bool
        switch type {
        case "object": if case .object = value { ok = true } else { ok = false }
        case "array": if case .array = value { ok = true } else { ok = false }
        case "string": if case .string = value { ok = true } else { ok = false }
        case "boolean": if case .bool = value { ok = true } else { ok = false }
        case "null": if case .null = value { ok = true } else { ok = false }
        case "integer": if case .integer = value { ok = true } else { ok = false }
        case "number":
            switch value {
            case .integer, .number: ok = true
            default: ok = false
            }
        default:
            // An unknown type keyword passed schema validation only if we do not
            // understand it; treat it as unconstrained rather than a mismatch.
            ok = true
        }
        return ok ? nil : "\(path) must be of type '\(type)'"
    }
}
