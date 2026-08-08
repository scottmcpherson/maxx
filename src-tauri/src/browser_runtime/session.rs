use super::{BrowserCapability, BrowserRuntimeError, BrowserSessionScope, BrowserTabId};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const DEFAULT_ABSOLUTE_LIFETIME: Duration = Duration::from_secs(8 * 60 * 60);

/// Plaintext credential returned exactly once to a provider adapter. It does
/// not implement `Debug` or `Serialize`, preventing accidental log/transcript
/// exposure through ordinary diagnostics.
pub struct BrowserCredential {
    pub session_id: Uuid,
    pub bearer_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedBrowserSession {
    pub session_id: Uuid,
    pub scope: BrowserSessionScope,
}

struct SessionRecord {
    session_id: Uuid,
    scope: BrowserSessionScope,
    issued_at: Instant,
    last_used_at: Instant,
    idle_timeout: Duration,
    absolute_lifetime: Duration,
}

impl SessionRecord {
    fn is_expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last_used_at) >= self.idle_timeout
            || now.saturating_duration_since(self.issued_at) >= self.absolute_lifetime
    }
}

/// Cryptographic bearer-token registry. The map key is the SHA-256 hash of the
/// token; plaintext tokens are never retained after issuance.
#[derive(Default)]
pub struct BrowserSessionRegistry {
    records: Mutex<HashMap<[u8; 32], SessionRecord>>,
    thread_tabs: Mutex<HashMap<Uuid, HashSet<BrowserTabId>>>,
}

impl BrowserSessionRegistry {
    pub fn issue(&self, scope: BrowserSessionScope) -> BrowserCredential {
        self.issue_at(
            scope,
            Instant::now(),
            DEFAULT_IDLE_TIMEOUT,
            DEFAULT_ABSOLUTE_LIFETIME,
        )
    }

    fn issue_at(
        &self,
        mut scope: BrowserSessionScope,
        now: Instant,
        idle_timeout: Duration,
        absolute_lifetime: Duration,
    ) -> BrowserCredential {
        if let Some(tabs) = self
            .thread_tabs
            .lock()
            .expect("browser thread tab mutex poisoned")
            .get(&scope.thread_id)
        {
            scope.assigned_tabs.extend(tabs.iter().copied());
        }
        let mut bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let token_hash = token_hash(&token);
        let session_id = Uuid::new_v4();
        self.records
            .lock()
            .expect("browser session registry mutex poisoned")
            .insert(
                token_hash,
                SessionRecord {
                    session_id,
                    scope,
                    issued_at: now,
                    last_used_at: now,
                    idle_timeout,
                    absolute_lifetime,
                },
            );
        BrowserCredential {
            session_id,
            bearer_token: token,
        }
    }

    pub fn authenticate(
        &self,
        authorization: &str,
        capability: BrowserCapability,
        tab_id: Option<BrowserTabId>,
    ) -> Result<AuthenticatedBrowserSession, BrowserRuntimeError> {
        self.authenticate_at(authorization, Some(capability), tab_id, Instant::now())
    }

    /// Authenticates request identity before MCP dispatch. Capability and tab
    /// authorization are enforced after the typed operation is known.
    pub fn authenticate_any(
        &self,
        authorization: &str,
    ) -> Result<AuthenticatedBrowserSession, BrowserRuntimeError> {
        self.authenticate_at(authorization, None, None, Instant::now())
    }

    fn authenticate_at(
        &self,
        authorization: &str,
        capability: Option<BrowserCapability>,
        tab_id: Option<BrowserTabId>,
        now: Instant,
    ) -> Result<AuthenticatedBrowserSession, BrowserRuntimeError> {
        let token = authorization.strip_prefix("Bearer ").ok_or_else(|| {
            BrowserRuntimeError::new(
                "browser.unauthorized",
                "missing Bearer authorization for the browser session",
            )
        })?;
        if token.is_empty() || token.contains(char::is_whitespace) {
            return Err(BrowserRuntimeError::new(
                "browser.unauthorized",
                "invalid browser bearer token",
            ));
        }
        let hash = token_hash(token);
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        let expired = records
            .get(&hash)
            .is_some_and(|record| record.is_expired(now));
        if expired {
            records.remove(&hash);
            return Err(BrowserRuntimeError::new(
                "browser.session-expired",
                "the browser session has expired",
            ));
        }
        let record = records.get_mut(&hash).ok_or_else(|| {
            BrowserRuntimeError::new(
                "browser.unauthorized",
                "unknown or revoked browser bearer token",
            )
        })?;
        if let Some(capability) = capability {
            if !record.scope.capabilities.contains(&capability) {
                return Err(BrowserRuntimeError::new(
                    "browser.capability-denied",
                    format!("the browser session does not grant {capability:?}"),
                ));
            }
        }
        if let Some(tab_id) = tab_id {
            if !record.scope.assigned_tabs.contains(&tab_id) {
                return Err(BrowserRuntimeError::new(
                    "browser.tab-denied",
                    "the browser tab is not assigned to this provider session",
                ));
            }
        }
        record.last_used_at = now;
        Ok(AuthenticatedBrowserSession {
            session_id: record.session_id,
            scope: record.scope.clone(),
        })
    }

    pub fn assign_tab(
        &self,
        session_id: Uuid,
        tab_id: BrowserTabId,
    ) -> Result<(), BrowserRuntimeError> {
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        let record = records
            .values_mut()
            .find(|record| record.session_id == session_id)
            .ok_or_else(|| {
                BrowserRuntimeError::new(
                    "browser.unauthorized",
                    "browser session is no longer active",
                )
            })?;
        record.scope.assigned_tabs.insert(tab_id);
        self.thread_tabs
            .lock()
            .expect("browser thread tab mutex poisoned")
            .entry(record.scope.thread_id)
            .or_default()
            .insert(tab_id);
        Ok(())
    }

    pub fn assign_tab_to_thread(&self, thread_id: Uuid, tab_id: BrowserTabId) {
        self.thread_tabs
            .lock()
            .expect("browser thread tab mutex poisoned")
            .entry(thread_id)
            .or_default()
            .insert(tab_id);
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        for record in records.values_mut() {
            if record.scope.thread_id == thread_id {
                record.scope.assigned_tabs.insert(tab_id);
            }
        }
    }

    pub fn remove_tab(&self, tab_id: BrowserTabId) {
        for tabs in self
            .thread_tabs
            .lock()
            .expect("browser thread tab mutex poisoned")
            .values_mut()
        {
            tabs.remove(&tab_id);
        }
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        for record in records.values_mut() {
            record.scope.assigned_tabs.remove(&tab_id);
        }
    }

    pub fn bind_provider_session(&self, session_id: Uuid, provider_session_id: String) -> bool {
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        let Some(record) = records
            .values_mut()
            .find(|record| record.session_id == session_id)
        else {
            return false;
        };
        record.scope.provider_session_id = Some(provider_session_id);
        true
    }

    pub fn revoke_session(&self, session_id: Uuid) -> bool {
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        let before = records.len();
        records.retain(|_, record| record.session_id != session_id);
        records.len() != before
    }

    pub fn revoke_thread(&self, thread_id: Uuid) -> usize {
        self.thread_tabs
            .lock()
            .expect("browser thread tab mutex poisoned")
            .remove(&thread_id);
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        let before = records.len();
        records.retain(|_, record| record.scope.thread_id != thread_id);
        before - records.len()
    }

    pub fn tabs_for_thread(&self, thread_id: Uuid) -> HashSet<BrowserTabId> {
        self.thread_tabs
            .lock()
            .expect("browser thread tab mutex poisoned")
            .get(&thread_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn revoke_provider_instance(&self, provider_instance_id: Uuid) -> usize {
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        let before = records.len();
        records.retain(|_, record| record.scope.provider_instance_id != provider_instance_id);
        before - records.len()
    }

    pub fn remove_expired(&self) -> usize {
        let now = Instant::now();
        let mut records = self
            .records
            .lock()
            .expect("browser session registry mutex poisoned");
        let before = records.len();
        records.retain(|_, record| !record.is_expired(now));
        before - records.len()
    }
}

fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use maxx_core::contract::ChatProvider;

    fn scope() -> BrowserSessionScope {
        BrowserSessionScope::full_access(
            Uuid::new_v4(),
            Uuid::new_v4(),
            ChatProvider::Codex,
            Uuid::new_v4(),
        )
    }

    #[test]
    fn token_is_random_and_plaintext_is_not_retained() {
        let registry = BrowserSessionRegistry::default();
        let first = registry.issue(scope());
        let second = registry.issue(scope());
        assert_ne!(first.bearer_token, second.bearer_token);
        assert_eq!(first.bearer_token.len(), 43);

        let records = registry.records.lock().expect("registry");
        assert_eq!(records.len(), 2);
        assert!(!format!("{}", records.len()).contains(&first.bearer_token));
    }

    #[test]
    fn authorization_capability_and_tab_scope_fail_closed() {
        let registry = BrowserSessionRegistry::default();
        let mut scope = scope();
        scope.capabilities = [BrowserCapability::Observe].into_iter().collect();
        let allowed_tab = Uuid::new_v4();
        scope.assigned_tabs.insert(allowed_tab);
        let credential = registry.issue(scope);
        let header = format!("Bearer {}", credential.bearer_token);

        assert!(registry
            .authenticate(&header, BrowserCapability::Observe, Some(allowed_tab))
            .is_ok());
        assert_eq!(
            registry
                .authenticate(&header, BrowserCapability::Navigate, Some(allowed_tab))
                .expect_err("capability denied")
                .code,
            "browser.capability-denied"
        );
        assert_eq!(
            registry
                .authenticate(&header, BrowserCapability::Observe, Some(Uuid::new_v4()))
                .expect_err("tab denied")
                .code,
            "browser.tab-denied"
        );
        assert_eq!(
            registry
                .authenticate("Bearer wrong", BrowserCapability::Observe, None)
                .expect_err("token denied")
                .code,
            "browser.unauthorized"
        );
    }

    #[test]
    fn sessions_expire_and_revoke_by_server_owned_scope() {
        let registry = BrowserSessionRegistry::default();
        let now = Instant::now();
        let expiring_scope = scope();
        let thread_id = expiring_scope.thread_id;
        let credential = registry.issue_at(
            expiring_scope,
            now,
            Duration::from_secs(2),
            Duration::from_secs(10),
        );
        let header = format!("Bearer {}", credential.bearer_token);

        assert_eq!(
            registry
                .authenticate_at(
                    &header,
                    Some(BrowserCapability::Observe),
                    None,
                    now + Duration::from_secs(2)
                )
                .expect_err("expired")
                .code,
            "browser.session-expired"
        );

        let mut other_scope = scope();
        other_scope.thread_id = thread_id;
        let other = registry.issue(other_scope);
        assert_eq!(registry.revoke_thread(thread_id), 1);
        assert!(registry
            .authenticate(
                &format!("Bearer {}", other.bearer_token),
                BrowserCapability::Observe,
                None
            )
            .is_err());
    }

    #[test]
    fn thread_tabs_follow_fresh_credentials_and_are_removed_globally() {
        let registry = BrowserSessionRegistry::default();
        let scope = scope();
        let thread_id = scope.thread_id;
        let tab_id = Uuid::new_v4();
        registry.assign_tab_to_thread(thread_id, tab_id);

        let credential = registry.issue(scope);
        let header = format!("Bearer {}", credential.bearer_token);
        assert!(registry
            .authenticate(&header, BrowserCapability::Observe, Some(tab_id))
            .is_ok());
        assert_eq!(
            registry.tabs_for_thread(thread_id),
            [tab_id].into_iter().collect()
        );

        registry.remove_tab(tab_id);
        assert!(registry
            .authenticate(&header, BrowserCapability::Observe, Some(tab_id))
            .is_err());
        assert!(registry.tabs_for_thread(thread_id).is_empty());
    }

    #[test]
    fn tabs_remain_isolated_between_threads() {
        let registry = BrowserSessionRegistry::default();
        let first_thread = Uuid::new_v4();
        let second_thread = Uuid::new_v4();
        let first_tab = Uuid::new_v4();
        let second_tab = Uuid::new_v4();

        registry.assign_tab_to_thread(first_thread, first_tab);
        registry.assign_tab_to_thread(second_thread, second_tab);

        assert_eq!(
            registry.tabs_for_thread(first_thread),
            [first_tab].into_iter().collect()
        );
        assert_eq!(
            registry.tabs_for_thread(second_thread),
            [second_tab].into_iter().collect()
        );
    }
}
