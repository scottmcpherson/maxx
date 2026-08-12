use maxx_core::contract::ChatProvider;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use uuid::Uuid;

pub type BrowserTabId = Uuid;
pub type BrowserObservationId = Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserUiReveal {
    pub thread_id: Uuid,
    pub tab_id: BrowserTabId,
}

/// Server-side grants carried by a browser session. Tool discovery and tool
/// execution use the same grants so unsupported operations fail closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserCapability {
    Observe,
    Navigate,
    Interact,
    Evaluate,
    Debug,
    Trace,
    Emulate,
    Storage,
    Files,
}

impl BrowserCapability {
    pub const ALL: [Self; 9] = [
        Self::Observe,
        Self::Navigate,
        Self::Interact,
        Self::Evaluate,
        Self::Debug,
        Self::Trace,
        Self::Emulate,
        Self::Storage,
        Self::Files,
    ];
}

/// Authority derived from a Maxx-owned provider session. None of these fields
/// are accepted from MCP tool arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionScope {
    pub project_id: Uuid,
    pub thread_id: Uuid,
    pub provider: ChatProvider,
    pub provider_instance_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub agent_id: Option<Uuid>,
    pub capabilities: HashSet<BrowserCapability>,
    pub assigned_tabs: HashSet<BrowserTabId>,
    /// Server-derived roots from which this provider session may upload files.
    /// They are never accepted as MCP arguments or returned by status tools.
    #[serde(default)]
    pub file_roots: Vec<PathBuf>,
}

impl BrowserSessionScope {
    pub fn full_access(
        project_id: Uuid,
        thread_id: Uuid,
        provider: ChatProvider,
        provider_instance_id: Uuid,
    ) -> Self {
        Self {
            project_id,
            thread_id,
            provider,
            provider_instance_id,
            provider_session_id: None,
            agent_id: None,
            capabilities: BrowserCapability::ALL.into_iter().collect(),
            assigned_tabs: HashSet::new(),
            file_roots: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
    pub mobile: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElement {
    pub reference: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub value: Option<String>,
    pub disabled: bool,
    pub focused: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleEntry {
    pub id: String,
    pub level: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub stack: Option<String>,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNetworkEntry {
    pub id: String,
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub failure: Option<String>,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserArtifactRef {
    pub id: Uuid,
    pub uri: String,
    pub mime_type: String,
    pub byte_length: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserArtifactContent {
    pub id: Uuid,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub observation_id: BrowserObservationId,
    pub document_generation: u64,
    pub tab_id: BrowserTabId,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub viewport: BrowserViewport,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub focused_element: Option<String>,
    pub visible_text: String,
    pub elements: Vec<BrowserElement>,
    pub console_errors: Vec<BrowserConsoleEntry>,
    pub failed_requests: Vec<BrowserNetworkEntry>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub screenshot: Option<BrowserArtifactRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabSummary {
    pub id: BrowserTabId,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub selected: bool,
    pub control_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub controller_session_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum BrowserOperation {
    Status,
    ListTabs,
    OpenTab {
        url: Option<String>,
    },
    SelectTab {
        tab_id: BrowserTabId,
    },
    CloseTab {
        tab_id: BrowserTabId,
    },
    Navigate {
        tab_id: BrowserTabId,
        url: String,
    },
    GoBack {
        tab_id: BrowserTabId,
    },
    GoForward {
        tab_id: BrowserTabId,
    },
    Reload {
        tab_id: BrowserTabId,
    },
    Snapshot {
        tab_id: BrowserTabId,
        #[serde(default)]
        include_screenshot: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        since_observation_id: Option<BrowserObservationId>,
    },
    Click {
        tab_id: BrowserTabId,
        reference: String,
    },
    Fill {
        tab_id: BrowserTabId,
        reference: String,
        value: String,
    },
    Press {
        tab_id: BrowserTabId,
        key: String,
    },
    Hover {
        tab_id: BrowserTabId,
        reference: String,
    },
    Scroll {
        tab_id: BrowserTabId,
        delta_x: f64,
        delta_y: f64,
    },
    Drag {
        tab_id: BrowserTabId,
        from_reference: String,
        to_reference: String,
    },
    Wait {
        tab_id: BrowserTabId,
        condition: String,
        timeout_ms: u64,
    },
    Evaluate {
        tab_id: BrowserTabId,
        expression: String,
    },
    Screenshot {
        tab_id: BrowserTabId,
        full_page: bool,
    },
    ConsoleList {
        tab_id: BrowserTabId,
    },
    ConsoleGet {
        tab_id: BrowserTabId,
        entry_id: String,
    },
    NetworkList {
        tab_id: BrowserTabId,
    },
    NetworkGet {
        tab_id: BrowserTabId,
        request_id: String,
    },
    TraceStart {
        tab_id: BrowserTabId,
    },
    TraceStop {
        tab_id: BrowserTabId,
    },
    Resize {
        tab_id: BrowserTabId,
        width: u32,
        height: u32,
    },
    Emulate {
        tab_id: BrowserTabId,
        device: String,
    },
    Storage {
        tab_id: BrowserTabId,
        command: String,
        #[serde(default)]
        value: Value,
    },
    HandleDialog {
        tab_id: BrowserTabId,
        accept: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        prompt_text: Option<String>,
    },
    Upload {
        tab_id: BrowserTabId,
        reference: String,
        paths: Vec<String>,
    },
    Downloads {
        tab_id: BrowserTabId,
    },
}

impl BrowserOperation {
    pub fn tool_name(&self) -> &'static str {
        match self {
            Self::Status => "browser_status",
            Self::ListTabs => "browser_list_tabs",
            Self::OpenTab { .. } => "browser_open_tab",
            Self::SelectTab { .. } => "browser_select_tab",
            Self::CloseTab { .. } => "browser_close_tab",
            Self::Navigate { .. } => "browser_navigate",
            Self::GoBack { .. } => "browser_go_back",
            Self::GoForward { .. } => "browser_go_forward",
            Self::Reload { .. } => "browser_reload",
            Self::Snapshot { .. } => "browser_snapshot",
            Self::Click { .. } => "browser_click",
            Self::Fill { .. } => "browser_fill",
            Self::Press { .. } => "browser_press",
            Self::Hover { .. } => "browser_hover",
            Self::Scroll { .. } => "browser_scroll",
            Self::Drag { .. } => "browser_drag",
            Self::Wait { .. } => "browser_wait",
            Self::Evaluate { .. } => "browser_evaluate",
            Self::Screenshot { .. } => "browser_screenshot",
            Self::ConsoleList { .. } => "browser_console_list",
            Self::ConsoleGet { .. } => "browser_console_get",
            Self::NetworkList { .. } => "browser_network_list",
            Self::NetworkGet { .. } => "browser_network_get",
            Self::TraceStart { .. } => "browser_trace_start",
            Self::TraceStop { .. } => "browser_trace_stop",
            Self::Resize { .. } => "browser_resize",
            Self::Emulate { .. } => "browser_emulate",
            Self::Storage { .. } => "browser_storage",
            Self::HandleDialog { .. } => "browser_handle_dialog",
            Self::Upload { .. } => "browser_upload",
            Self::Downloads { .. } => "browser_downloads",
        }
    }

    pub fn required_capability(&self) -> BrowserCapability {
        match self {
            Self::Status | Self::ListTabs | Self::Snapshot { .. } | Self::Screenshot { .. } => {
                BrowserCapability::Observe
            }
            Self::OpenTab { .. }
            | Self::SelectTab { .. }
            | Self::CloseTab { .. }
            | Self::Navigate { .. }
            | Self::GoBack { .. }
            | Self::GoForward { .. }
            | Self::Reload { .. } => BrowserCapability::Navigate,
            Self::Click { .. }
            | Self::Fill { .. }
            | Self::Press { .. }
            | Self::Hover { .. }
            | Self::Scroll { .. }
            | Self::Drag { .. }
            | Self::Wait { .. }
            | Self::HandleDialog { .. } => BrowserCapability::Interact,
            Self::Evaluate { .. } => BrowserCapability::Evaluate,
            Self::ConsoleList { .. }
            | Self::ConsoleGet { .. }
            | Self::NetworkList { .. }
            | Self::NetworkGet { .. } => BrowserCapability::Debug,
            Self::TraceStart { .. } | Self::TraceStop { .. } => BrowserCapability::Trace,
            Self::Resize { .. } | Self::Emulate { .. } => BrowserCapability::Emulate,
            Self::Storage { .. } => BrowserCapability::Storage,
            Self::Upload { .. } | Self::Downloads { .. } => BrowserCapability::Files,
        }
    }

    pub fn target_tab(&self) -> Option<BrowserTabId> {
        match self {
            Self::Status | Self::ListTabs | Self::OpenTab { .. } => None,
            Self::SelectTab { tab_id }
            | Self::CloseTab { tab_id }
            | Self::Navigate { tab_id, .. }
            | Self::GoBack { tab_id }
            | Self::GoForward { tab_id }
            | Self::Reload { tab_id }
            | Self::Snapshot { tab_id, .. }
            | Self::Click { tab_id, .. }
            | Self::Fill { tab_id, .. }
            | Self::Press { tab_id, .. }
            | Self::Hover { tab_id, .. }
            | Self::Scroll { tab_id, .. }
            | Self::Drag { tab_id, .. }
            | Self::Wait { tab_id, .. }
            | Self::Evaluate { tab_id, .. }
            | Self::Screenshot { tab_id, .. }
            | Self::ConsoleList { tab_id }
            | Self::ConsoleGet { tab_id, .. }
            | Self::NetworkList { tab_id }
            | Self::NetworkGet { tab_id, .. }
            | Self::TraceStart { tab_id }
            | Self::TraceStop { tab_id }
            | Self::Resize { tab_id, .. }
            | Self::Emulate { tab_id, .. }
            | Self::Storage { tab_id, .. }
            | Self::HandleDialog { tab_id, .. }
            | Self::Upload { tab_id, .. }
            | Self::Downloads { tab_id } => Some(*tab_id),
        }
    }

    pub fn is_mutating(&self) -> bool {
        !matches!(
            self,
            Self::Status
                | Self::ListTabs
                | Self::Snapshot { .. }
                | Self::Screenshot { .. }
                | Self::ConsoleList { .. }
                | Self::ConsoleGet { .. }
                | Self::NetworkList { .. }
                | Self::NetworkGet { .. }
                | Self::Downloads { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOperationResult {
    pub tab_id: Option<BrowserTabId>,
    pub control_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub observation_id: Option<BrowserObservationId>,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub artifacts: Vec<BrowserArtifactRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code}: {message}")]
pub struct BrowserRuntimeError {
    pub code: String,
    pub message: String,
}

impl BrowserRuntimeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn unsupported(operation: &BrowserOperation) -> Self {
        Self::new(
            "browser.unsupported",
            format!(
                "{} is not supported by this browser engine",
                operation.tool_name()
            ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_has_a_tool_and_capability() {
        let tab_id = Uuid::new_v4();
        let operations = [
            BrowserOperation::Status,
            BrowserOperation::ListTabs,
            BrowserOperation::OpenTab { url: None },
            BrowserOperation::SelectTab { tab_id },
            BrowserOperation::Navigate {
                tab_id,
                url: "https://example.com".into(),
            },
            BrowserOperation::Snapshot {
                tab_id,
                include_screenshot: true,
                since_observation_id: None,
            },
            BrowserOperation::Click {
                tab_id,
                reference: "e1".into(),
            },
            BrowserOperation::Evaluate {
                tab_id,
                expression: "document.title".into(),
            },
            BrowserOperation::NetworkList { tab_id },
            BrowserOperation::TraceStart { tab_id },
            BrowserOperation::Resize {
                tab_id,
                width: 800,
                height: 600,
            },
            BrowserOperation::Storage {
                tab_id,
                command: "list".into(),
                value: Value::Null,
            },
            BrowserOperation::Upload {
                tab_id,
                reference: "e2".into(),
                paths: vec!["/tmp/example".into()],
            },
        ];

        for operation in operations {
            assert!(operation.tool_name().starts_with("browser_"));
            assert!(BrowserCapability::ALL.contains(&operation.required_capability()));
        }
    }
}
