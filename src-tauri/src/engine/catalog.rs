//! Provider model catalog sourced exclusively from live provider discovery.

use maxx_core::contract::ChatProvider;
use maxx_core::persist::ProviderProfile;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderModelOption {
    pub model: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(rename = "isDefault", default)]
    pub is_default: bool,
    /// Effort values reported by the provider for this specific model.
    #[serde(
        rename = "effortLevels",
        skip_serializing_if = "Vec::is_empty",
        default
    )]
    pub effort_levels: Vec<String>,
}

/// Whether live discovery succeeded. An unavailable catalog always has an
/// empty model list; Maxx never substitutes guessed provider models.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderModelCatalogSource {
    Live,
    Unavailable,
}

/// A model catalog plus enough provenance for the UI to explain discovery
/// failures without presenting fabricated fallback entries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderModelCatalog {
    pub models: Vec<ProviderModelOption>,
    pub source: ProviderModelCatalogSource,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

/// Resolve models for a profile while preserving the legacy convenience return
/// used by non-IPC callers.
pub async fn list_models_for_profile(
    profile: &ProviderProfile,
    working_directory: Option<&str>,
) -> Vec<ProviderModelOption> {
    resolve_models_for_profile(profile, working_directory)
        .await
        .models
}

/// Resolve models for IPC. Discovery failures return an explicitly unavailable,
/// empty catalog instead of models invented by Maxx.
pub async fn resolve_models_for_profile(
    profile: &ProviderProfile,
    working_directory: Option<&str>,
) -> ProviderModelCatalog {
    match discover_models(profile, working_directory).await {
        Ok(models) if !models.is_empty() => ProviderModelCatalog {
            models,
            source: ProviderModelCatalogSource::Live,
            error: None,
        },
        Ok(_) => ProviderModelCatalog {
            models: Vec::new(),
            source: ProviderModelCatalogSource::Unavailable,
            error: Some("Provider model discovery returned no models.".to_string()),
        },
        Err(error) => ProviderModelCatalog {
            models: Vec::new(),
            source: ProviderModelCatalogSource::Unavailable,
            error: Some(safe_discovery_error(&error)),
        },
    }
}

/// Discovery errors can originate in child processes. Collapse control
/// characters and bound their size before the string crosses the IPC boundary,
/// while retaining the actionable underlying message.
fn safe_discovery_error(error: &str) -> String {
    const MAX_CHARS: usize = 320;
    let flattened = error
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flattened.is_empty() {
        return "Provider model discovery failed.".to_string();
    }
    let mut characters = flattened.chars();
    let bounded = characters.by_ref().take(MAX_CHARS).collect::<String>();
    if characters.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}

async fn discover_models(
    profile: &ProviderProfile,
    working_directory: Option<&str>,
) -> Result<Vec<ProviderModelOption>, String> {
    let configuration = super::launch::launch_configuration(profile)?;
    let executable = configuration.executable;
    let env = configuration.environment;
    match profile.provider {
        ChatProvider::Grok => discover_grok(&executable, &env, working_directory).await,
        ChatProvider::Claude => discover_claude(&executable, &env, working_directory).await,
        ChatProvider::Cursor => discover_cursor_list(&executable, &env, working_directory).await,
        ChatProvider::Opencode => discover_opencode(&executable, &env, working_directory).await,
        ChatProvider::Pi => discover_pi(&executable, &env, working_directory).await,
        ChatProvider::Codex => discover_codex(&executable, &env).await,
        ChatProvider::Hermes => discover_hermes(&executable, &env, working_directory).await,
    }
}

/// Live CLI discovery for Grok (`grok models`).
async fn discover_grok(
    executable: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
    working_directory: Option<&str>,
) -> Result<Vec<ProviderModelOption>, String> {
    let mut command = Command::new(executable);
    command
        .args(["--no-auto-update", "models"])
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = working_directory {
        command.current_dir(cwd);
    }
    let output = timeout(Duration::from_secs(12), command.output())
        .await
        .map_err(|_| "Grok model discovery timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Grok models exited {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    parse_grok_models(&String::from_utf8_lossy(&output.stdout))
}

pub fn parse_grok_models(stdout: &str) -> Result<Vec<ProviderModelOption>, String> {
    let mut default_model: Option<String> = None;
    let mut reading = false;
    let mut parsed: Vec<(String, bool)> = Vec::new();
    for raw in stdout.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("Default model:") {
            let value = rest.trim();
            if !value.is_empty() {
                default_model = Some(value.to_string());
            }
            continue;
        }
        if line == "Available models:" {
            reading = true;
            continue;
        }
        if !reading {
            continue;
        }
        let body = line
            .strip_prefix('*')
            .or_else(|| line.strip_prefix('-'))
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(mut model) = body.map(str::to_string) else {
            continue;
        };
        let marked = model.ends_with("(default)");
        if marked {
            model = model.trim_end_matches("(default)").trim().to_string();
        }
        if !model.is_empty() {
            parsed.push((model, marked));
        }
    }
    if parsed.is_empty() {
        return Err("Grok did not return model entries".into());
    }
    let mut seen = std::collections::HashSet::new();
    let models: Vec<_> = parsed
        .into_iter()
        .filter(|(model, _)| seen.insert(model.to_ascii_lowercase()))
        .map(|(model, marked)| {
            let is_default = marked
                || default_model
                    .as_ref()
                    .is_some_and(|d| d.eq_ignore_ascii_case(&model));
            ProviderModelOption {
                display_name: humanize_model_id(&model),
                model,
                description: None,
                is_default,
                effort_levels: Vec::new(),
            }
        })
        .collect();
    Ok(models)
}

async fn discover_cursor_list(
    executable: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
    working_directory: Option<&str>,
) -> Result<Vec<ProviderModelOption>, String> {
    let mut command = Command::new(executable);
    command
        .arg("--list-models")
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = working_directory {
        command.current_dir(cwd);
    }
    let output = timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "Cursor model discovery timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Cursor --list-models failed".into());
    }
    parse_cursor_list_models(&String::from_utf8_lossy(&output.stdout))
}

pub fn parse_cursor_list_models(stdout: &str) -> Result<Vec<ProviderModelOption>, String> {
    let mut models = Vec::new();
    for raw in stdout.lines() {
        let line = raw.trim();
        if line.is_empty() || line.eq_ignore_ascii_case("Available models") {
            continue;
        }
        // "id - Display Name" or "id - Display (current, default)"
        let Some((id, rest)) = line.split_once(" - ") else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        let display = rest.split(" (").next().unwrap_or(rest).trim().to_string();
        let is_default = rest.to_ascii_lowercase().contains("default")
            || id.eq_ignore_ascii_case("auto")
            || id.eq_ignore_ascii_case("default");
        models.push(ProviderModelOption {
            model: id.to_string(),
            display_name: if display.is_empty() {
                humanize_model_id(id)
            } else {
                display
            },
            description: None,
            is_default,
            effort_levels: Vec::new(),
        });
    }
    if models.is_empty() {
        return Err("Cursor returned no models".into());
    }
    Ok(models)
}

async fn discover_opencode(
    executable: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
    working_directory: Option<&str>,
) -> Result<Vec<ProviderModelOption>, String> {
    let mut command = Command::new(executable);
    command
        .arg("models")
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = working_directory {
        command.current_dir(cwd);
    }
    let output = timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "OpenCode model discovery timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("opencode models failed".into());
    }
    parse_opencode_models(&String::from_utf8_lossy(&output.stdout))
}

pub fn parse_opencode_models(stdout: &str) -> Result<Vec<ProviderModelOption>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for raw in stdout.lines() {
        let line = raw.trim();
        if line.is_empty() || line.ends_with(':') || line.contains(' ') || !line.contains('/') {
            continue;
        }
        if !seen.insert(line.to_ascii_lowercase()) {
            continue;
        }
        let is_default = models.is_empty();
        models.push(ProviderModelOption {
            model: line.to_string(),
            display_name: line.to_string(),
            description: None,
            is_default,
            effort_levels: Vec::new(),
        });
    }
    if models.is_empty() {
        return Err("OpenCode returned no models".into());
    }
    Ok(models)
}

async fn discover_pi(
    executable: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
    working_directory: Option<&str>,
) -> Result<Vec<ProviderModelOption>, String> {
    let mut models_command = Command::new(executable);
    models_command
        .arg("--list-models")
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = working_directory {
        models_command.current_dir(cwd);
    }
    let output = timeout(Duration::from_secs(15), models_command.output())
        .await
        .map_err(|_| "Pi model discovery timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("pi --list-models failed".into());
    }

    // Pi's model table reports whether each model supports thinking, while its
    // live help output reports the installed CLI's accepted thinking levels.
    // Failure to read help must not fabricate capabilities or discard models.
    let mut help_command = Command::new(executable);
    help_command
        .arg("--help")
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = working_directory {
        help_command.current_dir(cwd);
    }
    let effort_levels = match timeout(Duration::from_secs(10), help_command.output()).await {
        Ok(Ok(help)) if help.status.success() => {
            parse_pi_effort_levels(&String::from_utf8_lossy(&help.stdout))
        }
        _ => Vec::new(),
    };
    parse_pi_models(&String::from_utf8_lossy(&output.stdout), &effort_levels)
}

/// Parse the installed Pi CLI's accepted thinking values from `pi --help`.
pub fn parse_pi_effort_levels(stdout: &str) -> Vec<String> {
    let marker = "set thinking level:";
    let Some(values) = stdout.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        lower
            .find(marker)
            .map(|index| line[index + marker.len()..].trim())
    }) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    values
        .split(',')
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
        })
        .filter(|value| seen.insert(value.to_ascii_lowercase()))
        .map(str::to_string)
        .collect()
}

pub fn parse_pi_models(
    stdout: &str,
    discovered_effort_levels: &[String],
) -> Result<Vec<ProviderModelOption>, String> {
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut thinking_column: Option<usize> = None;
    for raw in stdout.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.is_empty() {
            continue;
        }
        if columns[0].eq_ignore_ascii_case("provider") {
            thinking_column = columns
                .iter()
                .position(|column| column.eq_ignore_ascii_case("thinking"));
            continue;
        }
        let identifier = if columns[0].contains('/') {
            columns[0].to_string()
        } else if columns.len() >= 2 {
            format!("{}/{}", columns[0], columns[1])
        } else {
            continue;
        };
        if !identifier.contains('/') || !seen.insert(identifier.to_ascii_lowercase()) {
            continue;
        }
        let display = identifier
            .split_once('/')
            .map(|(_, m)| m.to_string())
            .unwrap_or_else(|| identifier.clone());
        let is_default = models.is_empty();
        let supports_effort = thinking_column
            .and_then(|index| columns.get(index))
            .is_some_and(|value| value.eq_ignore_ascii_case("yes"));
        models.push(ProviderModelOption {
            model: identifier,
            display_name: display,
            description: None,
            is_default,
            effort_levels: if supports_effort {
                discovered_effort_levels.to_vec()
            } else {
                Vec::new()
            },
        });
    }
    if models.is_empty() {
        return Err("Pi returned no models".into());
    }
    Ok(models)
}

/// Live Claude discovery via stream-json control channel `list_models`.
async fn discover_claude(
    executable: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
    working_directory: Option<&str>,
) -> Result<Vec<ProviderModelOption>, String> {
    let mut command = Command::new(executable);
    command
        .args([
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
            "--no-session-persistence",
            "--tools",
            "",
        ])
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = working_directory {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("Claude stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Claude stdout unavailable")?;
    // Drain stderr so the pipe never fills.
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match tokio::io::AsyncReadExt::read(&mut stderr, &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }

    let request_id = "maxx-list-models";
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "list_models" }
    });
    let mut line = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stdin.write_all(&line).await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    // Close stdin after the request so some Claude builds can settle.
    drop(stdin);

    let mut reader = BufReader::new(stdout).lines();
    let collect = async {
        let mut matched: Option<String> = None;
        while let Ok(Some(line)) = reader.next_line().await {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                if value.get("type").and_then(|t| t.as_str()) == Some("control_response") {
                    let resp = value.get("response");
                    let id = resp
                        .and_then(|r| r.get("request_id"))
                        .and_then(|v| v.as_str());
                    if id == Some(request_id) {
                        matched = Some(line);
                        break;
                    }
                }
            }
        }
        matched.ok_or_else(|| "Claude list_models did not return a control_response".to_string())
    };
    let response_line = timeout(Duration::from_secs(20), collect)
        .await
        .map_err(|_| "Claude model discovery timed out".to_string())??;
    let _ = child.kill().await;
    let _ = child.wait().await;
    parse_claude_list_models_response(&response_line)
}

/// Parse a Claude `control_response` JSON line for `list_models`.
pub fn parse_claude_list_models_response(line: &str) -> Result<Vec<ProviderModelOption>, String> {
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("invalid Claude catalog JSON: {e}"))?;
    let response = value
        .get("response")
        .ok_or("Claude control_response missing response")?;
    let subtype = response
        .get("subtype")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if subtype != "success" {
        let err = response
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Claude model discovery failed");
        return Err(err.to_string());
    }
    let models = response
        .get("response")
        .and_then(|r| r.get("models"))
        .and_then(|m| m.as_array())
        .ok_or("Claude response did not include models")?;
    parse_claude_model_array(models)
}

/// Normalize Claude model objects into picker options (pure).
pub fn parse_claude_model_array(
    models: &[serde_json::Value],
) -> Result<Vec<ProviderModelOption>, String> {
    if models.is_empty() {
        return Err("Claude returned an empty model list".into());
    }
    let has_default_alias = models.iter().any(|m| {
        m.get("value")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("default"))
    });

    let mut options = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for model in models {
        let value = model
            .get("value")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if value.is_empty() || !seen.insert(value.to_ascii_lowercase()) {
            continue;
        }
        let resolved = model
            .get("resolvedModel")
            .or_else(|| model.get("resolved_model"))
            .and_then(|v| v.as_str())
            .unwrap_or(&value);
        let display_name = model
            .get("displayName")
            .or_else(|| model.get("display_name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if value.eq_ignore_ascii_case("default") {
                    "Default".into()
                } else {
                    humanize_model_id(resolved)
                }
            });
        let description = model
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let effort_levels = model
            .get("supportedEffortLevels")
            .or_else(|| model.get("supported_effort_levels"))
            .and_then(|levels| levels.as_array())
            .map(|levels| unique_strings(levels.iter().filter_map(|level| level.as_str())))
            .unwrap_or_default();
        let supports_effort = model
            .get("supportsEffort")
            .or_else(|| model.get("supports_effort"))
            .and_then(|supported| supported.as_bool())
            .unwrap_or(!effort_levels.is_empty());
        // Prefer the explicit "default" alias as the sole default when present.
        let is_default = if has_default_alias {
            value.eq_ignore_ascii_case("default")
        } else {
            false
        };
        options.push(ProviderModelOption {
            model: value,
            display_name,
            description,
            is_default,
            effort_levels: if supports_effort {
                effort_levels
            } else {
                Vec::new()
            },
        });
    }
    if options.is_empty() {
        return Err("Claude catalog produced no selectable models".into());
    }
    if !options.iter().any(|o| o.is_default) {
        options[0].is_default = true;
    }
    Ok(options)
}

/// Live Codex discovery via `codex app-server` + `model/list`.
async fn discover_codex(
    executable: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
) -> Result<Vec<ProviderModelOption>, String> {
    let mut command = Command::new(executable);
    command
        .arg("app-server")
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("Codex stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Codex stdout unavailable")?;
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            loop {
                match tokio::io::AsyncReadExt::read(&mut stderr, &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }

    let mut reader = BufReader::new(stdout).lines();

    async fn write_json(
        stdin: &mut tokio::process::ChildStdin,
        value: &serde_json::Value,
    ) -> Result<(), String> {
        let mut line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        line.push(b'\n');
        stdin.write_all(&line).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn read_response_with_id(
        reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
        id: i64,
    ) -> Result<serde_json::Value, String> {
        while let Ok(Some(line)) = reader.next_line().await {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(resp_id) = value.get("id") else {
                continue;
            };
            let matches = resp_id.as_i64() == Some(id)
                || resp_id.as_u64() == Some(id as u64)
                || resp_id.as_str() == Some(&id.to_string());
            if matches {
                if let Some(error) = value.get("error") {
                    let message = error
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Codex model/list error");
                    return Err(message.to_string());
                }
                return Ok(value);
            }
        }
        Err("Codex connection closed before model list response".into())
    }

    write_json(
        &mut stdin,
        &serde_json::json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "maxx",
                    "title": "Maxx",
                    "version": "1.0"
                }
            }
        }),
    )
    .await?;
    let _ = timeout(
        Duration::from_secs(12),
        read_response_with_id(&mut reader, 1),
    )
    .await
    .map_err(|_| "Codex initialize timed out".to_string())??;

    write_json(&mut stdin, &serde_json::json!({ "method": "initialized" })).await?;

    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    let mut request_id: i64 = 2;
    loop {
        let params = if let Some(c) = &cursor {
            serde_json::json!({
                "cursor": c,
                "includeHidden": false,
                "limit": 100
            })
        } else {
            serde_json::json!({
                "cursor": null,
                "includeHidden": false,
                "limit": 100
            })
        };
        write_json(
            &mut stdin,
            &serde_json::json!({
                "method": "model/list",
                "id": request_id,
                "params": params
            }),
        )
        .await?;
        let response = timeout(
            Duration::from_secs(15),
            read_response_with_id(&mut reader, request_id),
        )
        .await
        .map_err(|_| "Codex model/list timed out".to_string())??;
        let result = response
            .get("result")
            .ok_or("Codex model/list missing result")?;
        let page_models = parse_codex_model_list_result(result)?;
        models.extend(page_models);
        cursor = result
            .get("nextCursor")
            .or_else(|| result.get("next_cursor"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        request_id += 1;
        if cursor.is_none() {
            break;
        }
        if request_id > 20 {
            break;
        }
    }

    drop(stdin);
    let _ = child.kill().await;
    let _ = child.wait().await;

    if models.is_empty() {
        return Err("Codex returned no models".into());
    }
    Ok(models)
}

/// Live discovery for Hermes. `hermes` has no model-list subcommand, but its
/// ACP server reports `models.availableModels` in the `session/new` result, so
/// discovery is a short-lived ACP handshake: initialize, session/new, parse.
async fn discover_hermes(
    executable: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
    working_directory: Option<&str>,
) -> Result<Vec<ProviderModelOption>, String> {
    let mut command = Command::new(executable);
    command
        .arg("acp")
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = working_directory {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("Hermes stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Hermes stdout unavailable")?;
    let mut reader = BufReader::new(stdout).lines();

    async fn write_json(
        stdin: &mut tokio::process::ChildStdin,
        value: &serde_json::Value,
    ) -> Result<(), String> {
        let mut line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        line.push(b'\n');
        stdin.write_all(&line).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn read_response_with_id(
        reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
        id: i64,
    ) -> Result<serde_json::Value, String> {
        while let Ok(Some(line)) = reader.next_line().await {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(|v| v.as_i64()) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Hermes ACP error");
                return Err(message.to_string());
            }
            return Ok(value);
        }
        Err("Hermes connection closed before session/new response".into())
    }

    write_json(
        &mut stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "maxx", "title": "Maxx", "version": "1.0"}
            }
        }),
    )
    .await?;
    timeout(
        Duration::from_secs(12),
        read_response_with_id(&mut reader, 1),
    )
    .await
    .map_err(|_| "Hermes initialize timed out".to_string())??;

    write_json(
        &mut stdin,
        &serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {
                "cwd": working_directory.unwrap_or("/"),
                "mcpServers": []
            }
        }),
    )
    .await?;
    let response = timeout(
        Duration::from_secs(20),
        read_response_with_id(&mut reader, 2),
    )
    .await
    .map_err(|_| "Hermes session/new timed out".to_string())??;

    drop(stdin);
    let _ = child.kill().await;
    let _ = child.wait().await;

    let result = response
        .get("result")
        .ok_or("Hermes session/new missing result")?;
    parse_hermes_session_models(result)
}

/// Parse the `models` block of a Hermes ACP `session/new` result (pure).
pub fn parse_hermes_session_models(
    result: &serde_json::Value,
) -> Result<Vec<ProviderModelOption>, String> {
    let models = result
        .get("models")
        .ok_or("Hermes session/new reported no models")?;
    let available = models
        .get("availableModels")
        .and_then(|v| v.as_array())
        .ok_or("Hermes session/new missing models.availableModels")?;
    let routable_custom_aliases: std::collections::HashSet<&str> = available
        .iter()
        .filter_map(|entry| entry.get("modelId").and_then(|v| v.as_str()))
        .filter_map(|model| model.strip_prefix("custom:"))
        .collect();
    let reported_current = models.get("currentModelId").and_then(|v| v.as_str());
    let current = reported_current
        .and_then(|model| {
            available
                .iter()
                .filter_map(|entry| entry.get("modelId").and_then(|v| v.as_str()))
                .find(|candidate| candidate.strip_prefix("custom:") == Some(model))
        })
        .or(reported_current);
    let parsed: Vec<ProviderModelOption> = available
        .iter()
        .filter_map(|entry| {
            let model = entry.get("modelId").and_then(|v| v.as_str())?.to_string();
            if routable_custom_aliases.contains(model.as_str()) {
                return None;
            }
            let display_name = entry
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&model)
                .to_string();
            Some(ProviderModelOption {
                is_default: current == Some(model.as_str()),
                description: entry
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                model,
                display_name,
                effort_levels: Vec::new(),
            })
        })
        .collect();
    if parsed.is_empty() {
        return Err("Hermes returned no models".into());
    }
    Ok(parsed)
}

/// Parse a Codex `model/list` result object (pure).
pub fn parse_codex_model_list_result(
    result: &serde_json::Value,
) -> Result<Vec<ProviderModelOption>, String> {
    let data = result
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("Codex model/list result missing data array")?;
    if data.is_empty() {
        return Ok(Vec::new());
    }
    let mut options = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in data {
        let model = entry
            .get("model")
            .or_else(|| entry.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if model.is_empty() || !seen.insert(model.to_ascii_lowercase()) {
            continue;
        }
        let display_name = entry
            .get("displayName")
            .or_else(|| entry.get("display_name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| humanize_model_id(&model));
        let description = entry
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let is_default = entry
            .get("isDefault")
            .or_else(|| entry.get("is_default"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let effort_levels = entry
            .get("supportedReasoningEfforts")
            .or_else(|| entry.get("supported_reasoning_efforts"))
            .and_then(|levels| levels.as_array())
            .map(|levels| {
                unique_strings(levels.iter().filter_map(|level| {
                    level.as_str().or_else(|| {
                        level
                            .get("reasoningEffort")
                            .or_else(|| level.get("reasoning_effort"))
                            .and_then(|value| value.as_str())
                    })
                }))
            })
            .unwrap_or_default();
        options.push(ProviderModelOption {
            model,
            display_name,
            description,
            is_default,
            effort_levels,
        });
    }
    if !options.is_empty() && !options.iter().any(|o| o.is_default) {
        options[0].is_default = true;
    }
    Ok(options)
}

fn unique_strings<'a>(values: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.to_ascii_lowercase()))
        .map(str::to_string)
        .collect()
}

fn humanize_model_id(model: &str) -> String {
    let leaf = model.rsplit('/').next().unwrap_or(model);
    let cleaned = leaf.split('[').next().unwrap_or(leaf);
    cleaned
        .split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|part| {
            if part.chars().next().is_some_and(|c| c.is_ascii_digit()) || part.len() <= 2 {
                part.to_string()
            } else {
                let mut chars = part.chars();
                match chars.next() {
                    Some(c) => format!("{}{}", c.to_ascii_uppercase(), chars.as_str()),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Smoke helper: exercise spawn of a short-lived CLI for catalog (used in unit tests with fakes).
#[allow(dead_code)]
pub async fn run_catalog_command(
    executable: &std::path::Path,
    args: &[&str],
    stdin_line: Option<&str>,
) -> Result<String, String> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(if stdin_line.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    if let (Some(line), Some(mut stdin)) = (stdin_line, child.stdin.take()) {
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    }
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let mut reader = BufReader::new(stdout).lines();
    let mut collected = String::new();
    let read = async {
        while let Ok(Some(line)) = reader.next_line().await {
            collected.push_str(&line);
            collected.push('\n');
        }
        Ok::<_, String>(())
    };
    timeout(Duration::from_secs(10), read)
        .await
        .map_err(|_| "catalog command timed out".to_string())??;
    let _ = child.kill().await;
    Ok(collected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hermes_parser_reads_session_models_and_marks_current_default() {
        let result = serde_json::json!({
            "sessionId": "abc",
            "models": {
                "currentModelId": "xai-oauth:grok-4.5",
                "availableModels": [
                    {
                        "modelId": "xai-oauth:grok-build-0.1",
                        "name": "grok-build-0.1",
                        "description": "Provider: xAI Grok OAuth (SuperGrok / Premium+)"
                    },
                    {
                        "modelId": "xai-oauth:grok-4.5",
                        "name": "grok-4.5",
                        "description": "Provider: xAI Grok OAuth (SuperGrok / Premium+)"
                    }
                ]
            }
        });
        let models = parse_hermes_session_models(&result).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].model, "xai-oauth:grok-build-0.1");
        assert_eq!(models[0].display_name, "grok-build-0.1");
        assert!(!models[0].is_default);
        assert!(models[1].is_default);
    }

    #[test]
    fn hermes_parser_prefers_routable_named_custom_provider_choice() {
        let result = serde_json::json!({
            "sessionId": "abc",
            "models": {
                "currentModelId": "xai-oauth:grok-4.5",
                "availableModels": [
                    {
                        "modelId": "ollama-spark:qwen3.6-35b-a3b:bf16",
                        "name": "Ollama on DGX Spark · qwen3.6-35b-a3b:bf16",
                        "description": "Provider: Ollama on DGX Spark"
                    },
                    {
                        "modelId": "custom:ollama-spark:qwen3.6-35b-a3b:bf16",
                        "name": "qwen3.6-35b-a3b:bf16",
                        "description": "Provider: Ollama on DGX Spark"
                    }
                ]
            }
        });

        let models = parse_hermes_session_models(&result).unwrap();

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model, "custom:ollama-spark:qwen3.6-35b-a3b:bf16");
        assert_eq!(models[0].display_name, "qwen3.6-35b-a3b:bf16");
    }

    #[test]
    fn hermes_parser_rejects_missing_models_block() {
        let result = serde_json::json!({"sessionId": "abc"});
        assert!(parse_hermes_session_models(&result).is_err());
    }

    #[test]
    fn grok_parser_reads_default_and_entries() {
        let sample = r#"
You are logged in.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  * grok-composer-2.5-fast
"#;
        let models = parse_grok_models(sample).unwrap();
        assert_eq!(models.len(), 2);
        assert!(models[0].is_default);
        assert_eq!(models[0].model, "grok-4.5");
        assert_eq!(models[1].model, "grok-composer-2.5-fast");
        assert!(models.iter().all(|model| model.effort_levels.is_empty()));
    }

    #[test]
    fn cursor_parser_reads_id_and_display() {
        let sample = r#"
Available models

auto - Auto (current, default)
gpt-5.3-codex-high-fast - Codex 5.3 High Fast
composer-2.5 - Composer 2.5
"#;
        let models = parse_cursor_list_models(sample).unwrap();
        assert!(models[0].is_default);
        assert_eq!(models[0].model, "auto");
        assert_eq!(models[1].display_name, "Codex 5.3 High Fast");
    }

    #[test]
    fn opencode_parser_keeps_provider_slash_model() {
        let sample = "openai/gpt-4o\nanthropic/claude-sonnet-4\nnot a model\n";
        let models = parse_opencode_models(sample).unwrap();
        assert_eq!(models.len(), 2);
        assert!(models[0].is_default);
    }

    #[test]
    fn pi_parsers_attach_cli_reported_effort_only_to_thinking_models() {
        let help = "  --thinking <level>  Set thinking level: tiny, regular, enormous\n";
        let levels = parse_pi_effort_levels(help);
        assert_eq!(levels, ["tiny", "regular", "enormous"]);

        let table = r#"
provider model context max-out thinking images
vendor thinker 100K 10K yes no
vendor plain 100K 10K no no
"#;
        let models = parse_pi_models(table, &levels).unwrap();
        assert_eq!(models[0].effort_levels, levels);
        assert!(models[1].effort_levels.is_empty());
    }

    #[test]
    fn claude_parser_reads_live_style_list_models() {
        let response = r#"{
          "type": "control_response",
          "response": {
            "subtype": "success",
            "request_id": "maxx-list-models",
            "response": {
              "models": [
                {
                  "value": "default",
                  "resolvedModel": "claude-opus-4-8[1m]",
                  "displayName": "Default (recommended)",
                  "description": "Opus 4.8 with 1M context · Best for everyday, complex tasks",
                  "supportsEffort": true,
                  "supportedEffortLevels": ["brief", "deep"]
                },
                {
                  "value": "opus[1m]",
                  "resolvedModel": "claude-opus-4-8[1m]",
                  "displayName": "Opus",
                  "description": "Opus 4.8 with 1M context · Best for everyday, complex tasks"
                },
                {
                  "value": "claude-fable-5[1m]",
                  "resolvedModel": "claude-fable-5",
                  "displayName": "Fable",
                  "description": "Fable 5 · Most capable for your hardest and longest-running tasks"
                },
                {
                  "value": "sonnet",
                  "resolvedModel": "claude-sonnet-5",
                  "displayName": "Sonnet",
                  "description": "Sonnet 5 · Efficient for routine tasks"
                },
                {
                  "value": "haiku",
                  "resolvedModel": "claude-haiku-4-5-20251001",
                  "displayName": "Haiku",
                  "description": "Haiku 4.5 · Fastest for quick answers"
                }
              ]
            }
          }
        }"#;
        let models = parse_claude_list_models_response(response).unwrap();
        assert_eq!(models.len(), 5);
        assert!(models.iter().any(|m| m.model == "default" && m.is_default));
        assert_eq!(models[0].effort_levels, ["brief", "deep"]);
        assert!(models[1].effort_levels.is_empty());
        assert!(models.iter().any(|m| m.model == "claude-fable-5[1m]"
            && m.display_name == "Fable"
            && m.description
                .as_deref()
                .is_some_and(|d| d.contains("Fable 5"))));
        assert!(models
            .iter()
            .any(|m| m.model == "haiku" && m.display_name == "Haiku"));
        // Not the old static-only Sonnet/Opus/Default trio — richer set.
        assert!(models.iter().any(|m| m.display_name.contains("Default")));
        assert!(models
            .iter()
            .any(|m| m.model.contains("fable") || m.display_name == "Fable"));
    }

    #[test]
    fn claude_parser_empty_or_error_fails() {
        assert!(parse_claude_list_models_response(
            r#"{"type":"control_response","response":{"subtype":"error","request_id":"x","error":"nope"}}"#
        )
        .is_err());
        assert!(parse_claude_model_array(&[]).is_err());
    }

    #[test]
    fn codex_parser_reads_model_list_page() {
        let result = serde_json::json!({
            "data": [
                {
                    "model": "gpt-5.6-sol",
                    "displayName": "GPT-5.6-Sol",
                    "description": "Latest frontier agentic coding model.",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "quick", "description": "Fast" },
                        { "reasoningEffort": "thorough", "description": "Deep" }
                    ],
                    "isDefault": true
                },
                {
                    "model": "gpt-5.6-terra",
                    "displayName": "GPT-5.6-Terra",
                    "description": "Balanced agentic coding model for everyday work.",
                    "isDefault": false
                },
                {
                    "id": "gpt-5.4-mini",
                    "displayName": "GPT-5.4-Mini",
                    "description": "Small, fast model.",
                    "isDefault": false
                }
            ],
            "nextCursor": null
        });
        let models = parse_codex_model_list_result(&result).unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].model, "gpt-5.6-sol");
        assert!(models[0].is_default);
        assert_eq!(models[0].display_name, "GPT-5.6-Sol");
        assert_eq!(models[0].effort_levels, ["quick", "thorough"]);
        assert!(models[1].effort_levels.is_empty());
        assert!(models[0]
            .description
            .as_deref()
            .unwrap()
            .contains("frontier"));
        assert_eq!(models[2].model, "gpt-5.4-mini");
        // More than a lone Default fallback.
        assert!(models.len() > 1);
    }

    #[test]
    fn codex_parser_marks_first_default_when_none_flagged() {
        let result = serde_json::json!({
            "data": [
                { "model": "a", "displayName": "A" },
                { "model": "b", "displayName": "B" }
            ]
        });
        let models = parse_codex_model_list_result(&result).unwrap();
        assert!(models[0].is_default);
        assert!(!models[1].is_default);
    }

    #[test]
    fn list_models_for_profile_is_empty_when_discovery_cannot_run() {
        let profile = ProviderProfile {
            id: uuid::Uuid::nil(),
            provider: ChatProvider::Claude,
            display_name: "Claude".into(),
            executable_path: Some("/nonexistent/claude-binary-for-catalog-test".into()),
            server_url: None,
            home_directory: None,
            environment: Default::default(),
            color_hex: "#000".into(),
            is_enabled: true,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let models = rt.block_on(list_models_for_profile(&profile, None));
        assert!(models.is_empty());
    }

    #[test]
    fn catalog_status_reports_unavailable_and_safe_underlying_error() {
        // Profile with a nonsense executable forces discovery failure.
        let profile = ProviderProfile {
            id: uuid::Uuid::nil(),
            provider: ChatProvider::Claude,
            display_name: "Claude".into(),
            executable_path: Some("/nonexistent/claude-binary-for-catalog-status-test".into()),
            server_url: None,
            home_directory: None,
            environment: Default::default(),
            color_hex: "#000".into(),
            is_enabled: true,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let catalog = rt.block_on(resolve_models_for_profile(&profile, None));
        assert_eq!(catalog.source, ProviderModelCatalogSource::Unavailable);
        assert!(catalog.models.is_empty());
        let error = catalog
            .error
            .expect("unavailable catalog explains discovery failure");
        assert!(error.contains("not runnable"));
        assert!(!error.chars().any(char::is_control));

        let serialized = serde_json::to_value(ProviderModelCatalog {
            models: vec![],
            source: ProviderModelCatalogSource::Live,
            error: None,
        })
        .unwrap();
        assert_eq!(serialized["source"], "live");
        assert!(serialized.get("error").is_none());
    }

    #[test]
    fn discovery_errors_are_flattened_and_bounded_for_ipc() {
        let unsafe_message = format!("first\n\u{1b}[31msecond {}", "x".repeat(400));
        let safe = safe_discovery_error(&unsafe_message);
        assert!(!safe.chars().any(char::is_control));
        assert!(safe.starts_with("first [31msecond"));
        assert!(safe.chars().count() <= 321);
        assert!(safe.ends_with('…'));
    }

    /// Live CLI probe — runs only when MAX_LIVE_CATALOG=1 so default CI stays offline-fast.
    #[tokio::test]
    async fn live_claude_and_codex_discovery_when_enabled() {
        if std::env::var("MAX_LIVE_CATALOG").ok().as_deref() != Some("1") {
            return;
        }
        let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
        // Prefer a full login shell PATH for finding CLIs.
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".into(), path);
        }

        if let Ok(claude) = which_bin("claude") {
            let models = discover_claude(&claude, &env, None)
                .await
                .expect("claude live discovery");
            assert!(
                models.len() > 3,
                "expected richer Claude list than static trio, got {:?}",
                models.iter().map(|m| &m.model).collect::<Vec<_>>()
            );
            assert!(
                models
                    .iter()
                    .any(|m| m.display_name.to_ascii_lowercase().contains("fable")
                        || m.model.to_ascii_lowercase().contains("fable")
                        || m.display_name.to_ascii_lowercase().contains("haiku")
                        || m.model.to_ascii_lowercase().contains("haiku")
                        || models.len() >= 4),
                "live Claude list should include current aliases when available: {:?}",
                models
            );
            assert!(
                models.iter().any(|model| !model.effort_levels.is_empty()),
                "Claude should preserve provider-reported per-model effort levels: {:?}",
                models
            );
            eprintln!(
                "live claude models: {}",
                models
                    .iter()
                    .map(|m| format!("{} ({})", m.display_name, m.model))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }

        if let Ok(codex) = which_bin("codex") {
            let models = discover_codex(&codex, &env)
                .await
                .expect("codex live discovery");
            assert!(
                models.len() > 1,
                "expected multiple Codex models, got {:?}",
                models
            );
            assert!(
                models.iter().any(|m| m.display_name != "Default"),
                "Codex live list should not be only Default"
            );
            assert!(
                models.iter().any(|model| !model.effort_levels.is_empty()),
                "Codex should preserve provider-reported per-model effort levels: {:?}",
                models
            );
            eprintln!(
                "live codex models: {}",
                models
                    .iter()
                    .map(|m| format!("{} ({})", m.display_name, m.model))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }

    fn which_bin(name: &str) -> Result<std::path::PathBuf, ()> {
        let path = std::env::var_os("PATH").ok_or(())?;
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(())
    }
}
