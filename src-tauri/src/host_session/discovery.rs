use serde::Serialize;
use serde_json::Value;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleNode {
    pub name: String,
    pub dns_name: String,
    pub addresses: Vec<String>,
    pub online: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleDiscovery {
    pub installed: bool,
    pub running: bool,
    pub self_node: Option<TailscaleNode>,
    pub peers: Vec<TailscaleNode>,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfEndpoint {
    pub bind: SocketAddr,
    pub share_address: String,
}

pub fn tailscale_discovery() -> TailscaleDiscovery {
    let result = run_status_json();
    if !result.ran {
        return TailscaleDiscovery {
            error: "Tailscale is not installed".into(),
            ..TailscaleDiscovery::default()
        };
    }
    let Ok(value) = serde_json::from_str::<Value>(&result.stdout) else {
        return TailscaleDiscovery {
            installed: true,
            error: "Tailscale is installed but its status is unavailable".into(),
            ..TailscaleDiscovery::default()
        };
    };
    let running = value.get("BackendState").and_then(Value::as_str) == Some("Running");
    let self_node = value.get("Self").and_then(node_from_value);
    let mut peers: Vec<TailscaleNode> = value
        .get("Peer")
        .and_then(Value::as_object)
        .map(|peers| peers.values().filter_map(node_from_value).collect())
        .unwrap_or_default();
    peers.sort_by(|left, right| {
        right
            .online
            .cmp(&left.online)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    TailscaleDiscovery {
        installed: true,
        running,
        self_node,
        peers,
        error: if running {
            String::new()
        } else {
            "Tailscale is not connected".into()
        },
    }
}

pub fn self_endpoint(port: u16) -> Result<SelfEndpoint, String> {
    let status = tailscale_discovery();
    if !status.running {
        return Err(if status.error.is_empty() {
            "Connect Tailscale before allowing Maxx environments".into()
        } else {
            status.error
        });
    }
    let node = status
        .self_node
        .ok_or_else(|| "Tailscale did not report this Mac's address".to_string())?;
    let ip = node
        .addresses
        .iter()
        .filter_map(|address| address.parse::<IpAddr>().ok())
        .find(|ip| is_tailscale_ip(*ip))
        .ok_or_else(|| "Tailscale did not report a protected address for this Mac".to_string())?;
    let share_host = if node.dns_name.is_empty() {
        ip.to_string()
    } else {
        node.dns_name
    };
    Ok(SelfEndpoint {
        bind: SocketAddr::new(ip, port),
        share_address: format_host_port(&share_host, port),
    })
}

pub async fn resolve_endpoint(
    input: &str,
    default_port: u16,
) -> Result<(SocketAddr, String), String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter a Tailscale device name or address".into());
    }
    if let Ok(address) = input.parse::<SocketAddr>() {
        ensure_protected(address.ip())?;
        return Ok((address, address.to_string()));
    }
    if let Ok(ip) = input.parse::<IpAddr>() {
        ensure_protected(ip)?;
        let address = SocketAddr::new(ip, default_port);
        return Ok((address, address.to_string()));
    }
    let (host, port) = split_host_port(input, default_port)?;
    let addresses = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|error| format!("Could not resolve {host} through Tailscale: {error}"))?;
    let address = addresses
        .into_iter()
        .find(|address| is_protected_ip(address.ip()))
        .ok_or_else(|| format!("{host} did not resolve to a Tailscale address"))?;
    Ok((address, format_host_port(&host, port)))
}

pub fn is_protected_ip(ip: IpAddr) -> bool {
    ip.is_loopback() || is_tailscale_ip(ip)
}

fn ensure_protected(ip: IpAddr) -> Result<(), String> {
    if is_protected_ip(ip) {
        Ok(())
    } else {
        Err("Maxx environment connections must use Tailscale or loopback".into())
    }
}

fn is_tailscale_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_tailscale_v4(ip),
        IpAddr::V6(ip) => is_tailscale_v6(ip),
    }
}

fn is_tailscale_v4(ip: Ipv4Addr) -> bool {
    (u32::from(ip) & 0xffc0_0000) == 0x6440_0000
}

fn is_tailscale_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
}

fn split_host_port(input: &str, default_port: u16) -> Result<(String, u16), String> {
    if let Some(host) = input
        .strip_prefix('[')
        .and_then(|value| value.split_once(']'))
    {
        let port = host
            .1
            .strip_prefix(':')
            .map(|value| value.parse::<u16>())
            .transpose()
            .map_err(|_| "The environment port is invalid".to_string())?
            .unwrap_or(default_port);
        return Ok((host.0.to_string(), port));
    }
    if let Some((host, port)) = input.rsplit_once(':') {
        if !host.contains(':') && !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Ok((
                host.to_string(),
                port.parse::<u16>()
                    .map_err(|_| "The environment port is invalid".to_string())?,
            ));
        }
    }
    Ok((input.to_string(), default_port))
}

fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn node_from_value(value: &Value) -> Option<TailscaleNode> {
    let name = value
        .get("HostName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let dns_name = value
        .get("DNSName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_string();
    if name.is_empty() && dns_name.is_empty() {
        return None;
    }
    Some(TailscaleNode {
        name: if name.is_empty() {
            dns_name.clone()
        } else {
            name
        },
        dns_name,
        addresses: value
            .get("TailscaleIPs")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        online: value
            .get("Online")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

struct CliResult {
    ran: bool,
    stdout: String,
}

fn run_status_json() -> CliResult {
    for candidate in [
        "tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
    ] {
        if candidate.starts_with('/') && !Path::new(candidate).exists() {
            continue;
        }
        if let Ok(output) = Command::new(candidate).args(["status", "--json"]).output() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            if stdout.trim_start().starts_with('{') {
                return CliResult { ran: true, stdout };
            }
            return CliResult {
                ran: true,
                stdout: String::new(),
            };
        }
    }
    CliResult {
        ran: false,
        stdout: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_sorts_tailnet_nodes() {
        let value: Value = serde_json::from_str(
            r#"{
                "HostName":"mini",
                "DNSName":"mini.example.ts.net.",
                "TailscaleIPs":["100.64.0.8"],
                "Online":true
            }"#,
        )
        .unwrap();
        let node = node_from_value(&value).unwrap();
        assert_eq!(node.dns_name, "mini.example.ts.net");
        assert_eq!(node.addresses, vec!["100.64.0.8"]);
    }

    #[test]
    fn protects_connection_addresses() {
        assert!(is_protected_ip("100.64.0.1".parse().unwrap()));
        assert!(is_protected_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_protected_ip("192.168.1.2".parse().unwrap()));
        assert_eq!(split_host_port("mini.tail.ts.net", 7422).unwrap().1, 7422);
        assert_eq!(
            split_host_port("mini.tail.ts.net:9000", 7422).unwrap().1,
            9000
        );
    }
}
