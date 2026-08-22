use crate::browser_runtime::BrowserRuntimeError;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::{mpsc, oneshot, Mutex};

#[async_trait]
pub trait HostBridge: Send + Sync {
    async fn request(&self, method: &str, params: Value) -> Result<Value, BrowserRuntimeError>;
}

pub struct SidecarHostBridge {
    outbound: mpsc::UnboundedSender<Value>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, BrowserRuntimeError>>>>,
    next_id: AtomicU64,
}

impl SidecarHostBridge {
    pub fn new(outbound: mpsc::UnboundedSender<Value>) -> Arc<Self> {
        Arc::new(Self {
            outbound,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        })
    }

    pub async fn resolve(
        &self,
        id: u64,
        result: Option<Value>,
        error: Option<BrowserRuntimeError>,
    ) {
        if let Some(sender) = self.pending.lock().await.remove(&id) {
            let _ = sender.send(match error {
                Some(error) => Err(error),
                None => Ok(result.unwrap_or(Value::Null)),
            });
        }
    }
}

#[async_trait]
impl HostBridge for SidecarHostBridge {
    async fn request(&self, method: &str, params: Value) -> Result<Value, BrowserRuntimeError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        self.outbound
            .send(json!({"type":"host_request","id":id,"method":method,"params":params}))
            .map_err(|_| {
                BrowserRuntimeError::new("host.disconnected", "desktop host disconnected")
            })?;
        match tokio::time::timeout(std::time::Duration::from_secs(120), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BrowserRuntimeError::new(
                "host.disconnected",
                "desktop host dropped the browser response",
            )),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(BrowserRuntimeError::new(
                    "host.timeout",
                    format!("desktop host did not finish {method} within 120 seconds"),
                ))
            }
        }
    }
}
