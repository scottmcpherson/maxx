export type ProviderDiagnosticEvent = {
  kind: string;
  payload: {
    title?: unknown;
    rawType?: unknown;
  };
  nativeReference?: {
    protocolName?: unknown;
    eventType?: unknown;
  };
};

/** Non-fatal provider notices that are useful for debugging, not conversation. */
export function isProviderDiagnostic(event: ProviderDiagnosticEvent): boolean {
  if (event.kind !== "warning") return false;

  if (event.payload.title === "Unknown provider event") return true;

  const source = event.nativeReference;
  if (source?.protocolName === "codex-app-server" && source.eventType === "warning") {
    return true;
  }

  return source?.protocolName === "claude-stream-json"
    && source.eventType === "rate_limit_event"
    && event.payload.rawType === "allowed_warning";
}
