use serde::{Deserialize, Serialize};

pub const PROTOCOL_NAME: &str = "maxx-environment";
pub const PROTOCOL_VERSION: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    WorkspaceRead,
    WorkspaceWrite,
    AgentRun,
    TerminalControl,
    BrowserControl,
    SettingsManage,
    VoiceControl,
}

impl Capability {
    pub fn standard() -> Vec<Self> {
        vec![
            Self::WorkspaceRead,
            Self::WorkspaceWrite,
            Self::AgentRun,
            Self::TerminalControl,
            Self::BrowserControl,
        ]
    }

    pub fn full() -> Vec<Self> {
        let mut capabilities = Self::standard();
        capabilities.extend([Self::SettingsManage, Self::VoiceControl]);
        capabilities
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccessPreset {
    Standard,
    Full,
}

impl AccessPreset {
    pub fn capabilities(self) -> Vec<Capability> {
        match self {
            Self::Standard => Capability::standard(),
            Self::Full => Capability::full(),
        }
    }
}

pub fn required_capability(method: &str) -> Option<Capability> {
    match method {
        "workspace_snapshot"
        | "active_turns"
        | "git_status"
        | "home_folder"
        | "list_folder"
        | "read_media"
        | "load_media"
        | "provider_health"
        | "list_provider_models"
        | "list_provider_commands"
        | "resolve_media_source" => Some(Capability::WorkspaceRead),
        "create_folder"
        | "git_commit"
        | "git_push"
        | "add_project"
        | "remove_project"
        | "add_thread"
        | "add_thread_with_runtime"
        | "remove_thread"
        | "update_thread"
        | "upload_media"
        | "authorize_image_previews" => Some(Capability::WorkspaceWrite),
        "send_prompt" | "steer_prompt" | "start_side_thread" | "send_agent_prompt"
        | "cancel_turn" | "resolve_request" => Some(Capability::AgentRun),
        "terminal_support" | "terminal_start" | "terminal_status" | "terminal_input"
        | "terminal_resize" | "terminal_read" | "terminal_stop" => {
            Some(Capability::TerminalControl)
        }
        "browser_ui_tabs"
        | "browser_ui_open_tab"
        | "browser_ui_select_tab"
        | "browser_ui_close_tab"
        | "browser_ui_reorder_tabs"
        | "browser_ui_navigate"
        | "browser_ui_back"
        | "browser_ui_forward"
        | "browser_ui_reload"
        | "browser_ui_artifact" => Some(Capability::BrowserControl),
        "update_profiles"
        | "update_title_generation_runtime"
        | "update_agents"
        | "import_agent_image" => Some(Capability::SettingsManage),
        "voice_status"
        | "update_voice_settings"
        | "voice_start"
        | "voice_send_audio"
        | "voice_stop" => Some(Capability::VoiceControl),
        _ => None,
    }
}

pub fn has_capability(capabilities: &[Capability], capability: Capability) -> bool {
    capabilities.contains(&capability)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_remote_methods_are_denied_until_classified() {
        assert_eq!(
            required_capability("workspace_snapshot"),
            Some(Capability::WorkspaceRead)
        );
        assert_eq!(
            required_capability("browser_ui_navigate"),
            Some(Capability::BrowserControl)
        );
        assert_eq!(
            required_capability("steer_prompt"),
            Some(Capability::AgentRun)
        );
        assert_eq!(required_capability("host_connect"), None);
        assert_eq!(
            required_capability("terminal_input"),
            Some(Capability::TerminalControl)
        );
        assert_eq!(
            required_capability("git_status"),
            Some(Capability::WorkspaceRead)
        );
        assert_eq!(
            required_capability("git_commit"),
            Some(Capability::WorkspaceWrite)
        );
        assert_eq!(
            required_capability("git_push"),
            Some(Capability::WorkspaceWrite)
        );
        assert_eq!(
            required_capability("list_provider_commands"),
            Some(Capability::WorkspaceRead)
        );
        assert_eq!(required_capability("future_unreviewed_method"), None);
    }
}
