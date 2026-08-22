//! Port of `JSONRPCProcessClient`: JSON-RPC 2.0 over a JSON-line process.
//! Responses resolve pending requests; notifications and server→client
//! requests are forwarded to the session's incoming channel in order.

use super::process::JsonLineProcess;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};

pub struct JsonRpcClient {
    process: Arc<JsonLineProcess>,
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    /// Notifications and server-initiated requests, in arrival order.
    pub incoming: Mutex<mpsc::Receiver<Value>>,
}

impl JsonRpcClient {
    pub fn new(process: Arc<JsonLineProcess>) -> Arc<Self> {
        let (incoming_tx, incoming_rx) = mpsc::channel::<Value>(1024);
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let client = Arc::new(Self {
            process: process.clone(),
            next_id: AtomicI64::new(1),
            pending: pending.clone(),
            incoming: Mutex::new(incoming_rx),
        });

        tokio::spawn(async move {
            loop {
                let line = {
                    let mut lines = process.lines.lock().await;
                    lines.recv().await
                };
                let Some(Ok(line)) = line else { break };
                let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                let object = match value.as_object() {
                    Some(o) => o,
                    None => continue,
                };
                let has_id = object.contains_key("id");
                let is_response = !object.contains_key("method")
                    && (object.contains_key("result") || object.contains_key("error"));
                if has_id && is_response {
                    let key = id_key(&object["id"]);
                    if let Some(sender) = pending.lock().await.remove(&key) {
                        let result = if let Some(error) = object.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("JSON-RPC error")
                                .to_string())
                        } else {
                            Ok(object.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                        continue;
                    }
                }
                let _ = incoming_tx.send(value).await;
            }
            // Connection closed: fail all pending requests.
            for (_, sender) in pending.lock().await.drain() {
                let _ = sender.send(Err("provider connection closed".into()));
            }
        });
        client
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let key = id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(key.clone(), tx);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if let Err(e) = self.process.send(&message).await {
            self.pending.lock().await.remove(&key);
            return Err(e);
        }
        rx.await
            .map_err(|_| "provider connection closed".to_string())?
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = if params.is_null() {
            json!({"jsonrpc": "2.0", "method": method})
        } else {
            json!({"jsonrpc": "2.0", "method": method, "params": params})
        };
        self.process.send(&message).await
    }

    pub async fn respond(&self, native_id: &Value, result: Value) -> Result<(), String> {
        self.process
            .send(&json!({"jsonrpc": "2.0", "id": native_id, "result": result}))
            .await
    }

    pub async fn respond_error(
        &self,
        native_id: &Value,
        code: i64,
        message: &str,
    ) -> Result<(), String> {
        self.process
            .send(&json!({
                "jsonrpc": "2.0",
                "id": native_id,
                "error": {"code": code, "message": message}
            }))
            .await
    }

    pub fn process(&self) -> Arc<JsonLineProcess> {
        self.process.clone()
    }

    pub async fn shutdown(&self) {
        self.process.shutdown().await;
    }
}

fn id_key(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
