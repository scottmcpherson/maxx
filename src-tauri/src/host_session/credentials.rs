use std::collections::HashMap;
use std::sync::Mutex;

const KEYCHAIN_SERVICE: &str = "com.maxx.app.host-credential";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

pub trait CredentialStore: Send + Sync {
    fn load(&self, host_id: &str) -> Result<Option<String>, String>;
    fn save(&self, host_id: &str, credential: &str) -> Result<(), String>;
    fn remove(&self, host_id: &str) -> Result<(), String>;
}

pub struct KeychainCredentialStore;

#[cfg(target_os = "macos")]
impl CredentialStore for KeychainCredentialStore {
    fn load(&self, host_id: &str) -> Result<Option<String>, String> {
        use security_framework::os::macos::keychain::SecKeychain;
        let keychain = SecKeychain::default()
            .map_err(|error| format!("Could not open the login Keychain: {error}"))?;
        match keychain.find_generic_password(KEYCHAIN_SERVICE, host_id) {
            Ok((password, _)) => String::from_utf8(password.as_ref().to_vec())
                .map(Some)
                .map_err(|_| "The stored Maxx host credential is invalid".to_string()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(format!("Could not read the Maxx host credential: {error}")),
        }
    }

    fn save(&self, host_id: &str, credential: &str) -> Result<(), String> {
        use security_framework::os::macos::keychain::SecKeychain;
        SecKeychain::default()
            .and_then(|keychain| {
                keychain.set_generic_password(KEYCHAIN_SERVICE, host_id, credential.as_bytes())
            })
            .map_err(|error| {
                format!("Could not save the Maxx host credential in Keychain: {error}")
            })
    }

    fn remove(&self, host_id: &str) -> Result<(), String> {
        use security_framework::os::macos::keychain::SecKeychain;
        let keychain = SecKeychain::default()
            .map_err(|error| format!("Could not open the login Keychain: {error}"))?;
        match keychain.find_generic_password(KEYCHAIN_SERVICE, host_id) {
            Ok((_, item)) => {
                item.delete();
                Ok(())
            }
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(format!(
                "Could not remove the Maxx host credential: {error}"
            )),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl CredentialStore for KeychainCredentialStore {
    fn load(&self, _host_id: &str) -> Result<Option<String>, String> {
        Err("Secure host credential storage is unavailable on this platform".into())
    }

    fn save(&self, _host_id: &str, _credential: &str) -> Result<(), String> {
        Err("Secure host credential storage is unavailable on this platform".into())
    }

    fn remove(&self, _host_id: &str) -> Result<(), String> {
        Err("Secure host credential storage is unavailable on this platform".into())
    }
}

#[derive(Default)]
pub struct MemoryCredentialStore {
    values: Mutex<HashMap<String, String>>,
}

impl CredentialStore for MemoryCredentialStore {
    fn load(&self, host_id: &str) -> Result<Option<String>, String> {
        self.values
            .lock()
            .map(|values| values.get(host_id).cloned())
            .map_err(|_| "Credential test store is unavailable".into())
    }

    fn save(&self, host_id: &str, credential: &str) -> Result<(), String> {
        self.values
            .lock()
            .map(|mut values| {
                values.insert(host_id.to_string(), credential.to_string());
            })
            .map_err(|_| "Credential test store is unavailable".into())
    }

    fn remove(&self, host_id: &str) -> Result<(), String> {
        self.values
            .lock()
            .map(|mut values| {
                values.remove(host_id);
            })
            .map_err(|_| "Credential test store is unavailable".into())
    }
}
