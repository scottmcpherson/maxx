//! Provider-native slash command and skill discovery for the GUI composer.
//!
//! Catalogs are resolved for an exact provider profile and working directory.
//! Maxx never substitutes guessed commands: every returned entry comes from a
//! live headless protocol/API or an installed skill manifest.

use maxx_core::contract::ChatProvider;
use maxx_core::persist::ProviderProfile;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::time::{timeout, Instant};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderCommandKind {
    Command,
    Skill,
    Prompt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommandOption {
    pub id: String,
    pub name: String,
    pub invocation: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    pub kind: ProviderCommandKind,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub argument_hint: Option<String>,
    pub provider: ChatProvider,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderCommandCatalogSource {
    Live,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommandCatalog {
    pub items: Vec<ProviderCommandOption>,
    pub source: ProviderCommandCatalogSource,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

pub async fn resolve_commands_for_profile(
    profile: &ProviderProfile,
    working_directory: Option<&str>,
) -> ProviderCommandCatalog {
    let result = discover_commands(profile, working_directory).await;
    match result {
        Ok(items) if !items.is_empty() => ProviderCommandCatalog {
            items: dedupe_and_sort(items),
            source: ProviderCommandCatalogSource::Live,
            error: None,
        },
        Ok(_) => ProviderCommandCatalog {
            items: Vec::new(),
            source: ProviderCommandCatalogSource::Unavailable,
            error: Some(format!(
                "{} did not advertise commands or user-invocable skills for this project.",
                profile.provider.display_name()
            )),
        },
        Err(error) => ProviderCommandCatalog {
            items: Vec::new(),
            source: ProviderCommandCatalogSource::Unavailable,
            error: Some(safe_error(&error)),
        },
    }
}

async fn discover_commands(
    profile: &ProviderProfile,
    working_directory: Option<&str>,
) -> Result<Vec<ProviderCommandOption>, String> {
    let configuration = super::launch::launch_configuration(profile)?;
    let cwd = resolve_working_directory(working_directory)?;
    let executable = configuration.executable;
    let environment = configuration.environment;
    let home = configuration.home;
    match profile.provider {
        ChatProvider::Codex => discover_codex(&executable, &environment, cwd.as_deref()).await,
        ChatProvider::Claude => discover_claude(&executable, &environment, cwd.as_deref()).await,
        ChatProvider::Grok => discover_grok(&executable, &environment, cwd.as_deref()).await,
        ChatProvider::Cursor => {
            discover_acp(
                ChatProvider::Cursor,
                &executable,
                &environment,
                cwd.as_deref(),
            )
            .await
        }
        ChatProvider::Opencode => {
            discover_opencode(&executable, &environment, cwd.as_deref()).await
        }
        ChatProvider::Pi => discover_pi(&executable, &environment, cwd.as_deref()).await,
        ChatProvider::Hermes => {
            let mut items = discover_acp(
                ChatProvider::Hermes,
                &executable,
                &environment,
                cwd.as_deref(),
            )
            .await?;
            items.extend(discover_hermes_skills(&home, &environment));
            Ok(items)
        }
    }
}

fn resolve_working_directory(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = super::launch::expand_tilde(value);
    let metadata = std::fs::metadata(&path).map_err(|error| {
        format!("Could not access the command discovery project folder: {error}")
    })?;
    if !metadata.is_dir() {
        return Err("The command discovery working path is not a folder.".into());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn safe_error(error: &str) -> String {
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
    let mut characters = flattened.chars();
    let bounded = characters.by_ref().take(320).collect::<String>();
    if characters.next().is_some() {
        format!("{bounded}…")
    } else if bounded.is_empty() {
        "Provider command discovery failed.".into()
    } else {
        bounded
    }
}

fn command_option(
    provider: ChatProvider,
    name: &str,
    invocation: String,
    description: Option<String>,
    kind: ProviderCommandKind,
    source: impl Into<String>,
    scope: Option<String>,
    argument_hint: Option<String>,
) -> Option<ProviderCommandOption> {
    let name = name.trim().trim_start_matches(['/', '$']);
    if name.is_empty() {
        return None;
    }
    let source = source.into();
    Some(ProviderCommandOption {
        id: format!(
            "{}:{}:{}:{}",
            provider.raw_value(),
            match kind {
                ProviderCommandKind::Command => "command",
                ProviderCommandKind::Skill => "skill",
                ProviderCommandKind::Prompt => "prompt",
            },
            source.to_ascii_lowercase().replace(' ', "-"),
            name.to_ascii_lowercase()
        ),
        name: name.to_string(),
        invocation,
        display_name: humanize(name),
        description: description.filter(|value| !value.trim().is_empty()),
        kind,
        source,
        scope,
        argument_hint: argument_hint.filter(|value| !value.trim().is_empty()),
        provider,
    })
}

fn humanize(value: &str) -> String {
    value
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn dedupe_and_sort(items: Vec<ProviderCommandOption>) -> Vec<ProviderCommandOption> {
    let mut seen = HashSet::new();
    let mut items = items
        .into_iter()
        .filter(|item| seen.insert(item.invocation.to_ascii_lowercase()))
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        let kind = |item: &ProviderCommandOption| match item.kind {
            ProviderCommandKind::Command => 0,
            ProviderCommandKind::Prompt => 1,
            ProviderCommandKind::Skill => 2,
        };
        kind(left).cmp(&kind(right)).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        })
    });
    items
}

async fn spawn_json_process(
    executable: &Path,
    arguments: &[&str],
    environment: &HashMap<String, String>,
    cwd: Option<&str>,
) -> Result<(Child, ChildStdin, tokio::io::Lines<BufReader<ChildStdout>>), String> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .envs(environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or("Provider catalog stdin unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Provider catalog stdout unavailable")?;
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut buffer = [0u8; 4096];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        });
    }
    Ok((child, stdin, BufReader::new(stdout).lines()))
}

async fn write_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|error| error.to_string())?;
    stdin.flush().await.map_err(|error| error.to_string())
}

fn response_matches(value: &Value, id: i64) -> bool {
    value.get("id").is_some_and(|value| {
        value.as_i64() == Some(id)
            || value.as_u64() == Some(id as u64)
            || value.as_str() == Some(&id.to_string())
    })
}

async fn read_response(
    reader: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    id: i64,
    label: &str,
) -> Result<Value, String> {
    while let Ok(Some(line)) = reader.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !response_matches(&value, id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(label)
                .to_string());
        }
        return Ok(value);
    }
    Err(format!("{label} connection closed"))
}

async fn stop_child(mut child: Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn discover_codex(
    executable: &Path,
    environment: &HashMap<String, String>,
    cwd: Option<&str>,
) -> Result<Vec<ProviderCommandOption>, String> {
    let (child, mut stdin, mut reader) =
        spawn_json_process(executable, &["app-server", "--stdio"], environment, None).await?;
    write_json(
        &mut stdin,
        &json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {"name": "maxx", "title": "Maxx", "version": "1.0"},
                "capabilities": {"experimentalApi": true}
            }
        }),
    )
    .await?;
    timeout(
        Duration::from_secs(12),
        read_response(&mut reader, 1, "Codex initialize"),
    )
    .await
    .map_err(|_| "Codex initialize timed out".to_string())??;
    write_json(&mut stdin, &json!({"method": "initialized"})).await?;
    write_json(
        &mut stdin,
        &json!({
            "method": "skills/list",
            "id": 2,
            "params": {"cwds": cwd.into_iter().collect::<Vec<_>>(), "forceReload": false}
        }),
    )
    .await?;
    let response = timeout(
        Duration::from_secs(20),
        read_response(&mut reader, 2, "Codex skills/list"),
    )
    .await
    .map_err(|_| "Codex skills/list timed out".to_string())??;
    stop_child(child).await;
    let entries = response
        .pointer("/result/data")
        .and_then(Value::as_array)
        .ok_or("Codex skills/list omitted result.data")?;
    let mut items = Vec::new();
    for skill in entries
        .iter()
        .filter_map(|entry| entry.get("skills").and_then(Value::as_array))
        .flatten()
    {
        if skill.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(name) = skill.get("name").and_then(Value::as_str) else {
            continue;
        };
        let description = skill
            .pointer("/interface/shortDescription")
            .or_else(|| skill.get("shortDescription"))
            .or_else(|| skill.get("description"))
            .and_then(Value::as_str)
            .map(str::to_string);
        items.extend(command_option(
            ChatProvider::Codex,
            name,
            format!("${name}"),
            description,
            ProviderCommandKind::Skill,
            "Codex skill",
            skill
                .get("scope")
                .and_then(Value::as_str)
                .map(str::to_string),
            None,
        ));
    }
    Ok(items)
}

async fn discover_claude(
    executable: &Path,
    environment: &HashMap<String, String>,
    cwd: Option<&str>,
) -> Result<Vec<ProviderCommandOption>, String> {
    // `/help` is handled synthetically by Claude's headless client (zero model
    // turns and zero token usage) but still emits the authoritative system/init
    // catalog. `--no-session-persistence` keeps discovery from creating chat
    // history.
    let mut command = Command::new(executable);
    command
        .args([
            "--print",
            "/help",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "acceptEdits",
            "--no-session-persistence",
        ])
        .envs(environment)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "Claude command discovery timed out".to_string())?
        .map_err(|error| error.to_string())?;
    let init = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| {
            value.get("type").and_then(Value::as_str) == Some("system")
                && value.get("subtype").and_then(Value::as_str) == Some("init")
        })
        .ok_or("Claude did not emit its system/init command catalog")?;
    let skill_names = init
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    let terminal_only = init
        .get("terminal_slash_commands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    let commands = init
        .get("slash_commands")
        .and_then(Value::as_array)
        .ok_or("Claude system/init omitted slash_commands")?;
    Ok(commands
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| !terminal_only.contains(name))
        .filter_map(|name| {
            let kind = if skill_names.contains(name) {
                ProviderCommandKind::Skill
            } else {
                ProviderCommandKind::Command
            };
            command_option(
                ChatProvider::Claude,
                name,
                format!("/{name}"),
                None,
                kind,
                if kind == ProviderCommandKind::Skill {
                    "Claude skill"
                } else {
                    "Claude command"
                },
                None,
                None,
            )
        })
        .collect())
}

async fn discover_pi(
    executable: &Path,
    environment: &HashMap<String, String>,
    cwd: Option<&str>,
) -> Result<Vec<ProviderCommandOption>, String> {
    let (child, mut stdin, mut reader) = spawn_json_process(
        executable,
        &["--mode", "rpc", "--no-session", "--offline"],
        environment,
        cwd,
    )
    .await?;
    write_json(&mut stdin, &json!({"type": "get_commands", "id": "maxx"})).await?;
    let response = timeout(Duration::from_secs(20), async {
        while let Ok(Some(line)) = reader.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("type").and_then(Value::as_str) == Some("response")
                && value.get("command").and_then(Value::as_str) == Some("get_commands")
            {
                return Ok(value);
            }
        }
        Err("Pi connection closed before get_commands".to_string())
    })
    .await
    .map_err(|_| "Pi command discovery timed out".to_string())??;
    stop_child(child).await;
    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("Pi rejected get_commands".into());
    }
    let commands = response
        .pointer("/data/commands")
        .and_then(Value::as_array)
        .ok_or("Pi get_commands omitted data.commands")?;
    Ok(commands
        .iter()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?;
            let source = command
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("extension");
            let kind = match source {
                "skill" => ProviderCommandKind::Skill,
                "prompt" | "template" => ProviderCommandKind::Prompt,
                _ => ProviderCommandKind::Command,
            };
            command_option(
                ChatProvider::Pi,
                name,
                format!("/{name}"),
                command
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                kind,
                format!("Pi {source}"),
                command
                    .pointer("/sourceInfo/scope")
                    .or_else(|| command.get("location"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                None,
            )
        })
        .collect())
}

async fn discover_acp(
    provider: ChatProvider,
    executable: &Path,
    environment: &HashMap<String, String>,
    cwd: Option<&str>,
) -> Result<Vec<ProviderCommandOption>, String> {
    let arguments: &[&str] = match provider {
        ChatProvider::Grok => &["agent", "stdio"],
        ChatProvider::Cursor | ChatProvider::Hermes => &["acp"],
        _ => return Err("Unsupported ACP command catalog provider".into()),
    };
    let (child, mut stdin, mut reader) =
        spawn_json_process(executable, arguments, environment, cwd).await?;
    write_json(
        &mut stdin,
        &json!({
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
        read_response(&mut reader, 1, "ACP initialize"),
    )
    .await
    .map_err(|_| format!("{} ACP initialize timed out", provider.display_name()))??;
    write_json(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {"cwd": cwd.unwrap_or("/"), "mcpServers": []}
        }),
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut session_ready = false;
    let mut advertised: Option<Vec<Value>> = None;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = match timeout(remaining.min(Duration::from_secs(4)), reader.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) if session_ready => break,
            Err(_) => continue,
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if response_matches(&value, 2) {
            if let Some(error) = value.get("error") {
                return Err(error.to_string());
            }
            session_ready = true;
        }
        let update = value.pointer("/params/update");
        if update
            .and_then(|value| value.get("sessionUpdate"))
            .and_then(Value::as_str)
            == Some("available_commands_update")
        {
            advertised = update
                .and_then(|value| value.get("availableCommands"))
                .and_then(Value::as_array)
                .cloned();
            break;
        }
    }
    stop_child(child).await;
    let commands = advertised.ok_or_else(|| {
        format!(
            "{} ACP did not advertise GUI-compatible commands.",
            provider.display_name()
        )
    })?;
    Ok(commands
        .iter()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?;
            command_option(
                provider,
                name,
                format!("/{name}"),
                command
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                ProviderCommandKind::Command,
                format!("{} command", provider.display_name()),
                None,
                command
                    .pointer("/input/hint")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )
        })
        .collect())
}

async fn discover_grok(
    executable: &Path,
    environment: &HashMap<String, String>,
    cwd: Option<&str>,
) -> Result<Vec<ProviderCommandOption>, String> {
    let mut commands = discover_acp(ChatProvider::Grok, executable, environment, cwd).await?;
    let mut command = Command::new(executable);
    command
        .args(["inspect", "--json"])
        .envs(environment)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| "Grok skill discovery timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Ok(commands);
    }
    let report: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Grok inspect returned invalid JSON: {error}"))?;
    let mut skills = Vec::new();
    for skill in report
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if skill.get("userInvocable").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(name) = skill.get("name").and_then(Value::as_str) else {
            continue;
        };
        let invocation = skill
            .get("invocableAs")
            .and_then(Value::as_str)
            .unwrap_or(name);
        skills.extend(command_option(
            ChatProvider::Grok,
            name,
            format!("/{}", invocation.trim_start_matches('/')),
            skill
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            ProviderCommandKind::Skill,
            "Grok skill",
            skill
                .pointer("/source/type")
                .and_then(Value::as_str)
                .map(str::to_string),
            None,
        ));
    }
    let skill_invocations = skills
        .iter()
        .map(|skill| skill.invocation.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    commands
        .retain(|command| !skill_invocations.contains(&command.invocation.to_ascii_lowercase()));
    commands.extend(skills);
    Ok(commands)
}

async fn discover_opencode(
    executable: &Path,
    environment: &HashMap<String, String>,
    cwd: Option<&str>,
) -> Result<Vec<ProviderCommandOption>, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve an OpenCode discovery port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    let port_text = port.to_string();
    let arguments = ["serve", "--hostname", "127.0.0.1", "--port", &port_text];
    let (mut child, _stdin, _reader) =
        spawn_json_process(executable, &arguments, environment, cwd).await?;
    let base_url = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::new();
    let mut healthy = false;
    for _ in 0..40 {
        if opencode_get(&client, &base_url, "global/health", environment, None)
            .await
            .is_ok()
        {
            healthy = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if !healthy {
        stop_child(child).await;
        return Err("The OpenCode discovery server did not become healthy.".into());
    }
    let commands = opencode_get(&client, &base_url, "command", environment, cwd).await;
    let skills = opencode_get(&client, &base_url, "skill", environment, cwd).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    let commands = commands?;
    let mut items = commands
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?;
            let source = command
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("command");
            let kind = match source {
                "skill" => ProviderCommandKind::Skill,
                _ => ProviderCommandKind::Command,
            };
            command_option(
                ChatProvider::Opencode,
                name,
                format!("/{name}"),
                command
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                kind,
                format!("OpenCode {source}"),
                None,
                command.get("hints").and_then(Value::as_array).map(|hints| {
                    hints
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                }),
            )
        })
        .collect::<Vec<_>>();
    if let Ok(skills) = skills {
        for skill in skills.as_array().into_iter().flatten() {
            let Some(name) = skill.get("name").and_then(Value::as_str) else {
                continue;
            };
            items.extend(command_option(
                ChatProvider::Opencode,
                name,
                format!("/{name}"),
                skill
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                ProviderCommandKind::Skill,
                "OpenCode skill",
                Some("project".into()),
                None,
            ));
        }
    }
    Ok(items)
}

async fn opencode_get(
    client: &reqwest::Client,
    base_url: &str,
    path: &str,
    environment: &HashMap<String, String>,
    cwd: Option<&str>,
) -> Result<Value, String> {
    let mut request = client.get(format!("{base_url}/{path}"));
    if let Some(cwd) = cwd {
        request = request.header("x-opencode-directory", cwd);
    }
    if let Some(password) = environment
        .get("OPENCODE_SERVER_PASSWORD")
        .filter(|value| !value.is_empty())
    {
        request = request.basic_auth(
            environment
                .get("OPENCODE_SERVER_USERNAME")
                .cloned()
                .unwrap_or_else(|| "opencode".into()),
            Some(password),
        );
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("OpenCode {path} returned {}", response.status()));
    }
    response.json().await.map_err(|error| error.to_string())
}

fn discover_hermes_skills(
    home: &Path,
    environment: &HashMap<String, String>,
) -> Vec<ProviderCommandOption> {
    let hermes_home = environment
        .get("HERMES_HOME")
        .map(|value| {
            let path = super::launch::expand_tilde(value);
            if path.is_absolute() {
                path
            } else {
                home.join(path)
            }
        })
        .unwrap_or_else(|| home.join(".hermes"));
    let disabled = hermes_disabled_skills(&hermes_home.join("config.yaml"));
    let mut manifests = Vec::new();
    collect_skill_manifests(&hermes_home.join("skills"), 0, &mut manifests);
    manifests
        .into_iter()
        .filter_map(|path| {
            let source = std::fs::read_to_string(&path).ok()?;
            let metadata = skill_frontmatter(&source)?;
            let name = metadata.get("name")?.as_str()?.trim();
            if name.is_empty() || disabled.contains(name) {
                return None;
            }
            let user_invocable = metadata
                .get("user-invocable")
                .or_else(|| metadata.get("user_invocable"))
                .and_then(serde_yaml_ng::Value::as_bool)
                .unwrap_or(true);
            if !user_invocable {
                return None;
            }
            command_option(
                ChatProvider::Hermes,
                name,
                format!("/{name}"),
                metadata
                    .get("description")
                    .and_then(serde_yaml_ng::Value::as_str)
                    .map(str::to_string),
                ProviderCommandKind::Skill,
                "Hermes skill",
                Some("user".into()),
                None,
            )
        })
        .collect()
}

fn collect_skill_manifests(root: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth > 5 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            output.push(path);
        } else if path.is_dir()
            && !matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some(".git" | "node_modules" | ".hub")
            )
        {
            collect_skill_manifests(&path, depth + 1, output);
        }
    }
}

fn skill_frontmatter(source: &str) -> Option<serde_yaml_ng::Mapping> {
    let body = source.strip_prefix("---")?;
    let end = body.find("\n---")?;
    serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&body[..end])
        .ok()?
        .as_mapping()
        .cloned()
}

fn hermes_disabled_skills(path: &Path) -> HashSet<String> {
    let Ok(source) = std::fs::read_to_string(path) else {
        return HashSet::new();
    };
    let Ok(value) = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&source) else {
        return HashSet::new();
    };
    value
        .get("skills")
        .and_then(|skills| skills.get("disabled"))
        .and_then(serde_yaml_ng::Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(serde_yaml_ng::Value::as_str)
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_errors_are_flat_and_bounded() {
        let error = format!("bad\n{}", "x".repeat(500));
        let safe = safe_error(&error);
        assert!(!safe.contains('\n'));
        assert!(safe.chars().count() <= 321);
    }

    #[test]
    fn command_option_rejects_empty_names_and_uses_native_invocation() {
        assert!(command_option(
            ChatProvider::Codex,
            "",
            "$".into(),
            None,
            ProviderCommandKind::Skill,
            "Codex skill",
            None,
            None
        )
        .is_none());
        let item = command_option(
            ChatProvider::Codex,
            "$review",
            "$review".into(),
            Some("Review changes".into()),
            ProviderCommandKind::Skill,
            "Codex skill",
            Some("repo".into()),
            None,
        )
        .unwrap();
        assert_eq!(item.name, "review");
        assert_eq!(item.invocation, "$review");
    }

    #[test]
    fn dedupe_prefers_provider_commands_before_duplicate_skills() {
        let command = command_option(
            ChatProvider::Hermes,
            "help",
            "/help".into(),
            None,
            ProviderCommandKind::Command,
            "Hermes command",
            None,
            None,
        )
        .unwrap();
        let mut skill = command.clone();
        skill.kind = ProviderCommandKind::Skill;
        let result = dedupe_and_sort(vec![command.clone(), skill]);
        assert_eq!(result, vec![command]);
    }

    #[test]
    fn parses_skill_frontmatter_and_disabled_config() {
        let metadata = skill_frontmatter(
            "---\nname: test-skill\ndescription: Test it\nuser-invocable: true\n---\n# Test\n",
        )
        .unwrap();
        assert_eq!(
            metadata.get("name").and_then(serde_yaml_ng::Value::as_str),
            Some("test-skill")
        );

        let root = std::env::temp_dir().join(format!("maxx-command-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let config = root.join("config.yaml");
        std::fs::write(&config, "skills:\n  disabled:\n    - hidden\n").unwrap();
        assert!(hermes_disabled_skills(&config).contains("hidden"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[ignore = "requires the user's installed provider CLIs"]
    async fn live_installed_provider_catalogs_are_nonempty() {
        let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .expect("workspace root should resolve");
        let workspace_root = workspace_root
            .to_str()
            .expect("workspace root should be valid UTF-8");

        for provider in [
            ChatProvider::Codex,
            ChatProvider::Claude,
            ChatProvider::Grok,
            ChatProvider::Opencode,
            ChatProvider::Pi,
            ChatProvider::Hermes,
        ] {
            let profile = ProviderProfile::default_for(provider);
            let catalog = resolve_commands_for_profile(&profile, Some(workspace_root)).await;
            assert_eq!(
                catalog.source,
                ProviderCommandCatalogSource::Live,
                "{} catalog failed: {:?}",
                provider.display_name(),
                catalog.error
            );
            assert!(
                !catalog.items.is_empty(),
                "{} returned an empty catalog",
                provider.display_name()
            );
            let commands = catalog
                .items
                .iter()
                .filter(|item| item.kind == ProviderCommandKind::Command)
                .count();
            let skills = catalog
                .items
                .iter()
                .filter(|item| item.kind == ProviderCommandKind::Skill)
                .count();
            println!(
                "{}: {} items ({commands} commands, {skills} skills)",
                provider.display_name(),
                catalog.items.len()
            );
            if matches!(
                provider,
                ChatProvider::Claude | ChatProvider::Grok | ChatProvider::Hermes
            ) {
                assert!(
                    commands > 0,
                    "{} should advertise commands",
                    provider.display_name()
                );
                assert!(
                    skills > 0,
                    "{} should advertise skills",
                    provider.display_name()
                );
            }
            if provider == ChatProvider::Codex {
                assert!(skills > 0, "Codex should advertise skills/list entries");
            }
        }

        let cursor_profile = ProviderProfile::default_for(ChatProvider::Cursor);
        let cursor = resolve_commands_for_profile(&cursor_profile, Some(workspace_root)).await;
        if super::super::launch::locate_executable(ChatProvider::Cursor, &dirs::home_dir().unwrap())
            .is_ok()
        {
            assert_eq!(
                cursor.source,
                ProviderCommandCatalogSource::Live,
                "{:?}",
                cursor.error
            );
        } else {
            assert_eq!(cursor.source, ProviderCommandCatalogSource::Unavailable);
            assert!(cursor
                .error
                .as_deref()
                .is_some_and(|error| error.contains("not found")));
        }
    }
}
