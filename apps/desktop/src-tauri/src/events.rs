use serde::Serialize;
use serde_json::Value;

/// Process-neutral event sink. The desktop host receives these over the
/// sidecar protocol; no UI framework types cross into the runtime.
pub trait EventSink: Send + Sync {
    fn emit_value(&self, event: &str, payload: Value);

    /// Emit a short-lived event without persisting it in the host event
    /// journal. Voice interim/final text and future audio chunks are runtime
    /// data, not durable host state. The default keeps existing sinks working.
    fn emit_ephemeral(&self, event: &str, payload: Value) {
        self.emit_value(event, payload);
    }
}

pub fn emit<T: Serialize>(sink: &dyn EventSink, event: &str, payload: &T) {
    match serde_json::to_value(payload) {
        Ok(value) => sink.emit_value(event, value),
        Err(error) => log::error!("could not serialize {event}: {error}"),
    }
}

pub fn emit_ephemeral<T: Serialize>(sink: &dyn EventSink, event: &str, payload: &T) {
    match serde_json::to_value(payload) {
        Ok(value) => sink.emit_ephemeral(event, value),
        Err(error) => log::error!("could not serialize ephemeral {event}: {error}"),
    }
}
