//! Scoped host capabilities injected into provider-native sessions.
//!
//! Provider adapters receive the same neutral description regardless of the
//! harness.  The adapter is responsible only for translating that description
//! into its native MCP configuration; the endpoint and credential remain
//! ephemeral and are never persisted in a turn request or workspace.

use std::fmt;

/// One authenticated, Maxx-owned MCP server available to a provider session.
#[derive(Clone, PartialEq, Eq)]
pub struct HostToolAccess {
    pub name: String,
    pub endpoint: String,
    pub bearer_token: String,
}

impl HostToolAccess {
    pub fn new(
        name: impl Into<String>,
        endpoint: impl Into<String>,
        bearer_token: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            endpoint: endpoint.into(),
            bearer_token: bearer_token.into(),
        }
    }

    /// Environment variable used by provider-native configuration files.
    /// Keep the existing browser variable stable while giving every other
    /// host tool a deterministic, collision-free variable.
    pub fn token_environment_variable(&self) -> String {
        if self.name == "maxx_browser" {
            return "MAXX_BROWSER_TOKEN".into();
        }
        let suffix = self
            .name
            .strip_prefix("maxx_")
            .unwrap_or(self.name.as_str())
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect::<String>();
        format!("MAXX_{}_TOKEN", suffix.trim_matches('_'))
    }
}

impl fmt::Debug for HostToolAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostToolAccess")
            .field("name", &self.name)
            .field("endpoint", &self.endpoint)
            .field("bearer_token", &"[REDACTED]")
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_environment_names_are_stable_and_debug_redacts_credentials() {
        let browser = HostToolAccess::new("maxx_browser", "http://127.0.0.1/mcp", "secret");
        assert_eq!(browser.token_environment_variable(), "MAXX_BROWSER_TOKEN");
        let automation = HostToolAccess::new(
            "maxx_automations",
            "http://127.0.0.1:43124/mcp",
            "automation-secret",
        );
        assert_eq!(
            automation.token_environment_variable(),
            "MAXX_AUTOMATIONS_TOKEN"
        );
        assert!(!format!("{automation:?}").contains("automation-secret"));
    }
}
