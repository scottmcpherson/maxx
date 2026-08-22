use super::{AccessPreset, Capability};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const PAIRING_CODE_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_CODE_LENGTH: usize = 8;
const PAIRING_TTL_SECONDS: u64 = 5 * 60;
const ATTEMPT_WINDOW_SECONDS: u64 = 60;
const MAX_ATTEMPTS_PER_WINDOW: u32 = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInvitation {
    pub code: String,
    pub expires_at: u64,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone)]
struct AttemptWindow {
    started_at: u64,
    attempts: u32,
}

#[derive(Default)]
struct PairingState {
    invitation: Option<PairingInvitation>,
    code_hash: String,
    attempts: HashMap<IpAddr, AttemptWindow>,
}

#[derive(Default)]
pub struct PairingManager {
    state: Mutex<PairingState>,
}

impl PairingManager {
    pub fn create(&self, preset: AccessPreset) -> Result<PairingInvitation, String> {
        let code = generate_pairing_code();
        let invitation = PairingInvitation {
            code: format_pairing_code(&code),
            expires_at: unix_time().saturating_add(PAIRING_TTL_SECONDS),
            capabilities: preset.capabilities(),
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Pairing state is unavailable".to_string())?;
        state.code_hash = pairing_code_hash(&code);
        state.invitation = Some(invitation.clone());
        state.attempts.clear();
        Ok(invitation)
    }

    pub fn current(&self) -> Option<PairingInvitation> {
        let mut state = self.state.lock().ok()?;
        if state
            .invitation
            .as_ref()
            .is_some_and(|invitation| invitation.expires_at <= unix_time())
        {
            clear_invitation(&mut state);
        }
        state.invitation.clone()
    }

    pub fn cancel(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Pairing state is unavailable".to_string())?;
        clear_invitation(&mut state);
        Ok(())
    }

    pub fn redeem(&self, source: IpAddr, code: &str) -> Result<Vec<Capability>, String> {
        let now = unix_time();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Pairing state is unavailable".to_string())?;
        let Some(invitation) = state.invitation.clone() else {
            return Err("Generate a pairing code on the host first".into());
        };
        if invitation.expires_at <= now {
            clear_invitation(&mut state);
            return Err("The pairing code expired".into());
        }
        let attempts = state.attempts.entry(source).or_insert(AttemptWindow {
            started_at: now,
            attempts: 0,
        });
        if now.saturating_sub(attempts.started_at) >= ATTEMPT_WINDOW_SECONDS {
            *attempts = AttemptWindow {
                started_at: now,
                attempts: 0,
            };
        }
        if attempts.attempts >= MAX_ATTEMPTS_PER_WINDOW {
            return Err("Too many pairing attempts. Wait one minute and try again".into());
        }
        attempts.attempts += 1;
        if !constant_time_eq(
            pairing_code_hash(code).as_bytes(),
            state.code_hash.as_bytes(),
        ) {
            return Err("The pairing code is invalid".into());
        }
        let capabilities = invitation.capabilities;
        clear_invitation(&mut state);
        Ok(capabilities)
    }
}

pub fn generate_device_credential() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("maxx_device_{}", hex_encode(&bytes))
}

pub fn credential_hash(credential: &str) -> String {
    let digest = Sha256::digest(format!("maxx-host-credential:v1:{credential}").as_bytes());
    format!("v1:{}", hex_encode(&digest))
}

pub fn credential_hash_is_valid(value: &str) -> bool {
    value.strip_prefix("v1:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn generate_pairing_code() -> String {
    let mut random = [0u8; PAIRING_CODE_LENGTH];
    rand::thread_rng().fill_bytes(&mut random);
    random
        .iter()
        .map(|byte| PAIRING_CODE_ALPHABET[usize::from(*byte) % PAIRING_CODE_ALPHABET.len()] as char)
        .collect()
}

pub fn normalize_pairing_code(code: &str) -> String {
    code.trim()
        .to_ascii_uppercase()
        .chars()
        .map(|character| match character {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .filter(|character| PAIRING_CODE_ALPHABET.contains(&(*character as u8)))
        .collect()
}

fn format_pairing_code(code: &str) -> String {
    let normalized = normalize_pairing_code(code);
    format!("{}-{}", &normalized[..4], &normalized[4..])
}

fn pairing_code_hash(code: &str) -> String {
    let digest =
        Sha256::digest(format!("maxx-pairing-code:v1:{}", normalize_pairing_code(code)).as_bytes());
    hex_encode(&digest)
}

fn clear_invitation(state: &mut PairingState) {
    state.invitation = None;
    state.code_hash.clear();
    state.attempts.clear();
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invitation_is_short_lived_single_use_and_human_friendly() {
        let manager = PairingManager::default();
        let invitation = manager.create(AccessPreset::Standard).unwrap();
        assert_eq!(invitation.code.len(), 9);
        assert_eq!(invitation.code.chars().nth(4), Some('-'));
        assert_eq!(
            manager.redeem("127.0.0.1".parse().unwrap(), &invitation.code),
            Ok(Capability::standard())
        );
        assert!(manager
            .redeem("127.0.0.1".parse().unwrap(), &invitation.code)
            .is_err());
    }

    #[test]
    fn client_credentials_have_a_valid_domain_separated_hash() {
        let credential = generate_device_credential();
        assert!(credential.starts_with("maxx_device_"));
        let hash = credential_hash(&credential);
        assert!(credential_hash_is_valid(&hash));
        assert!(!hash.contains(&credential));
    }

    #[test]
    fn pairing_attempts_are_rate_limited_per_source() {
        let manager = PairingManager::default();
        manager.create(AccessPreset::Standard).unwrap();
        let source = "100.64.0.8".parse().unwrap();
        for _ in 0..MAX_ATTEMPTS_PER_WINDOW {
            assert_eq!(
                manager.redeem(source, "WRONG"),
                Err("The pairing code is invalid".into())
            );
        }
        assert!(manager
            .redeem(source, "WRONG")
            .unwrap_err()
            .contains("Too many"));
    }
}
