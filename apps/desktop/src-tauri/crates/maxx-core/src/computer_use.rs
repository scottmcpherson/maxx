use crate::contract::ChatProvider;
use serde::{Deserialize, Serialize};

/// User-owned policy for Maxx's bundled native-desktop control surface.
///
/// Ordinary observation and input stay available whenever the master switch is
/// on. The booleans below represent capabilities with wider data or destructive
/// effects, so they remain explicit and default off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub disabled_providers: Vec<ChatProvider>,
    #[serde(default = "enabled_by_default")]
    pub launch_applications: bool,
    #[serde(default = "enabled_by_default")]
    pub foreground_control: bool,
    #[serde(default)]
    pub clipboard: bool,
    #[serde(default)]
    pub browser_automation: bool,
    #[serde(default)]
    pub browser_file_transfer: bool,
    #[serde(default)]
    pub trajectory_recording: bool,
    #[serde(default)]
    pub trajectory_replay: bool,
    #[serde(default)]
    pub process_termination: bool,
    #[serde(default)]
    pub existing_browser_profiles: bool,
}

const fn enabled_by_default() -> bool {
    true
}

impl Default for ComputerUseSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            disabled_providers: Vec::new(),
            launch_applications: true,
            foreground_control: true,
            clipboard: false,
            browser_automation: false,
            browser_file_transfer: false,
            trajectory_recording: false,
            trajectory_replay: false,
            process_termination: false,
            existing_browser_profiles: false,
        }
    }
}

impl ComputerUseSettings {
    pub fn provider_enabled(&self, provider: ChatProvider) -> bool {
        self.enabled && !self.disabled_providers.contains(&provider)
    }

    pub fn normalize(&mut self) {
        self.disabled_providers.sort();
        self.disabled_providers.dedup();
        if !self.browser_automation {
            self.browser_file_transfer = false;
            self.existing_browser_profiles = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_globally_useful_without_sensitive_extras() {
        let settings = ComputerUseSettings::default();
        assert!(!settings.enabled);
        assert!(settings.launch_applications);
        assert!(settings.foreground_control);
        assert!(settings.disabled_providers.is_empty());
        assert!(!settings.clipboard);
        assert!(!settings.browser_automation);
        assert!(!settings.browser_file_transfer);
        assert!(!settings.trajectory_recording);
        assert!(!settings.trajectory_replay);
        assert!(!settings.process_termination);
        assert!(!settings.existing_browser_profiles);
    }

    #[test]
    fn normalization_deduplicates_providers() {
        let mut settings = ComputerUseSettings {
            disabled_providers: vec![ChatProvider::Pi, ChatProvider::Pi],
            ..Default::default()
        };
        settings.normalize();
        assert_eq!(settings.disabled_providers, vec![ChatProvider::Pi]);
    }

    #[test]
    fn normalization_clears_browser_dependent_capabilities() {
        let mut settings = ComputerUseSettings {
            browser_file_transfer: true,
            existing_browser_profiles: true,
            ..Default::default()
        };
        settings.normalize();
        assert!(!settings.browser_file_transfer);
        assert!(!settings.existing_browser_profiles);
    }
}
