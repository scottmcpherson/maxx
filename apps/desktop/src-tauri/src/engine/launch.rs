//! Port of `ProviderProfiles` launch resolution + `ProviderExecutableLocator`:
//! profile-isolated executable, home, environment and augmented PATH. GUI apps
//! inherit a deliberately small PATH, so the resolved candidates mirror the
//! Swift `ProviderLaunchEnvironment`.

use maxx_core::contract::ChatProvider;
use maxx_core::persist::ProviderProfile;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct LaunchConfiguration {
    pub executable: PathBuf,
    pub home: PathBuf,
    pub environment: HashMap<String, String>,
}

pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    PathBuf::from(path)
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Search order mirrors `ProviderExecutableLocator`: configured path first,
/// then well-known CLI install locations under the profile home, then the
/// inherited PATH.
pub fn locate_executable(provider: ChatProvider, home: &Path) -> Result<PathBuf, String> {
    let name = provider.executable_name();
    let mut candidates: Vec<PathBuf> = vec![
        home.join(".local/bin").join(name),
        home.join(".bun/bin").join(name),
        home.join(".cargo/bin").join(name),
        home.join("bin").join(name),
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
        PathBuf::from("/usr/bin").join(name),
    ];
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            candidates.push(PathBuf::from(dir).join(name));
        }
    }
    candidates
        .into_iter()
        .find(|c| is_executable(c))
        .ok_or_else(|| {
            format!(
                "The {} CLI ({name}) was not found. Install it or set an executable path in the provider profile.",
                provider.display_name()
            )
        })
}

/// Port of `ProviderLaunchEnvironment.resolved`.
pub fn resolved_environment(
    mut environment: HashMap<String, String>,
    executable: &Path,
    home: &Path,
) -> HashMap<String, String> {
    let inherited: Vec<String> = environment
        .get("PATH")
        .map(|p| p.split(':').map(String::from).collect())
        .unwrap_or_default();
    let mut candidates: Vec<String> = vec![
        executable
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        home.join(".local/bin").to_string_lossy().to_string(),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
        "/usr/sbin".into(),
        "/sbin".into(),
    ];
    candidates.extend(inherited);
    let mut seen = std::collections::HashSet::new();
    let path = candidates
        .into_iter()
        .filter(|c| !c.is_empty() && seen.insert(c.clone()))
        .collect::<Vec<_>>()
        .join(":");
    environment.insert("PATH".into(), path);
    environment
}

/// Port of `ProviderProfileRegistry.launchConfiguration`: profile executable,
/// home, and environment never cross profile boundaries.
pub fn launch_configuration(profile: &ProviderProfile) -> Result<LaunchConfiguration, String> {
    if !profile.is_enabled {
        return Err(format!(
            "The provider profile {} is disabled. Enable it in Settings to run a turn.",
            profile.display_name
        ));
    }
    let home = profile
        .home_directory
        .as_deref()
        .map(expand_tilde)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "No home directory available".to_string())?;

    let executable = if let Some(configured) = &profile.executable_path {
        let configured = expand_tilde(configured);
        if !is_executable(&configured) {
            return Err(format!(
                "The configured provider executable is not runnable: {}",
                configured.display()
            ));
        }
        configured
    } else {
        locate_executable(profile.provider, &home)?
    };

    let mut environment: HashMap<String, String> = std::env::vars().collect();
    if profile.home_directory.is_some() {
        environment.insert("HOME".into(), home.to_string_lossy().to_string());
    }
    for (key, value) in &profile.environment {
        environment.insert(key.clone(), value.clone());
    }
    let environment = resolved_environment(environment, &executable, &home);
    Ok(LaunchConfiguration {
        executable,
        home,
        environment,
    })
}
