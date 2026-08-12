use serde::Serialize;
use serde_json::Value;

/// Process-neutral event sink. The desktop host receives these over the
/// sidecar protocol; no UI framework types cross into the runtime.
pub trait EventSink: Send + Sync {
    fn emit_value(&self, event: &str, payload: Value);
}

pub fn emit<T: Serialize>(sink: &dyn EventSink, event: &str, payload: &T) {
    match serde_json::to_value(payload) {
        Ok(value) => sink.emit_value(event, value),
        Err(error) => log::error!("could not serialize {event}: {error}"),
    }
}
