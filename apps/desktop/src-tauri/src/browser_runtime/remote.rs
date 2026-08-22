use super::{
    BrowserEngine, BrowserEngineContext, BrowserOperation, BrowserOperationResult,
    BrowserRuntimeError,
};
use crate::host::HostBridge;
use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct ElectronBrowserEngine {
    host: Arc<dyn HostBridge>,
}

impl ElectronBrowserEngine {
    pub fn new(host: Arc<dyn HostBridge>) -> Arc<Self> {
        Arc::new(Self { host })
    }
}

#[async_trait]
impl BrowserEngine for ElectronBrowserEngine {
    fn name(&self) -> &'static str {
        "electron_web_contents"
    }

    async fn execute(
        &self,
        context: BrowserEngineContext,
        operation: BrowserOperation,
    ) -> Result<BrowserOperationResult, BrowserRuntimeError> {
        context.control.ensure_current()?;
        let operation_name = operation.tool_name();
        let value = self
            .host
            .request(
                "browser.execute",
                json!({
                    "context": {
                        "sessionId": context.session_id,
                        "actionId": context.action_id,
                        "tabId": context.tab_id,
                        "controlEpoch": context.control.expected_epoch(),
                        "fileRoots": context.file_roots,
                    },
                    "operation": operation,
                }),
            )
            .await?;
        context.control.ensure_current()?;
        let raw_artifacts = value
            .get("artifacts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut result: BrowserOperationResult =
            serde_json::from_value(value).map_err(|error| {
                BrowserRuntimeError::new(
                    "host.invalid-response",
                    format!("desktop host returned an invalid browser result: {error}"),
                )
            })?;
        let mut persisted = Vec::new();
        for artifact in raw_artifacts {
            let Some(encoded) = artifact.get("dataBase64").and_then(Value::as_str) else {
                continue;
            };
            let bytes = STANDARD.decode(encoded).map_err(|error| {
                BrowserRuntimeError::new(
                    "host.invalid-artifact",
                    format!("desktop host returned invalid base64: {error}"),
                )
            })?;
            let mime_type = artifact
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            let extension = match mime_type {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "application/json" => "json",
                _ => "bin",
            };
            persisted.push(
                context.store_artifact(
                    &bytes,
                    mime_type,
                    extension,
                    artifact
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                )?,
            );
        }
        if !persisted.is_empty() {
            if operation_name == "browser_screenshot" || operation_name == "browser_trace_stop" {
                result.value = serde_json::to_value(&persisted[0]).unwrap_or(Value::Null);
            } else if operation_name == "browser_snapshot" {
                if let Some(object) = result.value.as_object_mut() {
                    object.insert(
                        "screenshot".into(),
                        serde_json::to_value(&persisted[0]).unwrap_or(Value::Null),
                    );
                }
            }
            result.artifacts = persisted;
        }
        Ok(result)
    }

    async fn interrupt(&self, tab_id: super::BrowserTabId) {
        let _ = self
            .host
            .request("browser.interrupt", json!({"tabId": tab_id}))
            .await;
    }
}
