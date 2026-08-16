//! Standards-compatible stdio transport for ACP agents that do not advertise
//! direct Streamable HTTP MCP support.
//!
//! The bridge is a second mode of the Maxx executable. The ACP client launches
//! it with an endpoint and bearer token in the child environment; JSON-RPC is
//! relayed between newline-delimited stdio and Maxx's loopback HTTP gateway.

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const BRIDGE_ARGUMENT: &str = "--browser-mcp-stdio";
pub const ENDPOINT_ENV: &str = "MAXX_BROWSER_ENDPOINT";
pub const TOKEN_ENV: &str = "MAXX_BROWSER_TOKEN";
pub const HOST_TOOL_BRIDGE_ARGUMENT: &str = "--maxx-host-tool-stdio";
pub const HOST_TOOL_ENDPOINT_ENV: &str = "MAXX_HOST_TOOL_ENDPOINT";
pub const HOST_TOOL_TOKEN_ENV: &str = "MAXX_HOST_TOOL_TOKEN";

pub fn requested() -> bool {
    std::env::args()
        .any(|argument| argument == BRIDGE_ARGUMENT || argument == HOST_TOOL_BRIDGE_ARGUMENT)
}

pub fn run_from_environment() -> Result<(), String> {
    let generic = std::env::args().any(|argument| argument == HOST_TOOL_BRIDGE_ARGUMENT);
    let endpoint_env = if generic {
        HOST_TOOL_ENDPOINT_ENV
    } else {
        ENDPOINT_ENV
    };
    let token_env = if generic {
        HOST_TOOL_TOKEN_ENV
    } else {
        TOKEN_ENV
    };
    let endpoint = std::env::var(endpoint_env)
        .map_err(|_| format!("{endpoint_env} is required for the MCP bridge"))?;
    let bearer_token = std::env::var(token_env)
        .map_err(|_| format!("{token_env} is required for the MCP bridge"))?;
    validate_endpoint(&endpoint)?;

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("could not start MCP bridge runtime: {error}"))?
        .block_on(run(endpoint, bearer_token))
}

async fn run(endpoint: String, bearer_token: String) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut session_id: Option<String> = None;
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();

    while let Some(line) = input
        .next_line()
        .await
        .map_err(|error| format!("could not read browser MCP stdio: {error}"))?
    {
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(error) => {
                write_message(
                    &mut output,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": null,
                        "error": {"code": -32700, "message": format!("invalid JSON: {error}")}
                    }),
                )
                .await?;
                continue;
            }
        };

        match relay(
            &client,
            &endpoint,
            &bearer_token,
            session_id.as_deref(),
            &message,
        )
        .await
        {
            Ok(response) => {
                if let Some(id) = response.session_id {
                    session_id = Some(id);
                }
                for message in response.messages {
                    write_message(&mut output, &message).await?;
                }
            }
            Err(error) => {
                if let Some(id) = message.get("id") {
                    write_message(
                        &mut output,
                        &json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {"code": -32603, "message": error}
                        }),
                    )
                    .await?;
                } else {
                    eprintln!("browser MCP bridge request failed: {error}");
                }
            }
        }
    }

    if let Some(session_id) = session_id {
        let _ = client
            .delete(&endpoint)
            .header(AUTHORIZATION, format!("Bearer {bearer_token}"))
            .header("mcp-session-id", session_id)
            .send()
            .await;
    }
    Ok(())
}

struct RelayResponse {
    session_id: Option<String>,
    messages: Vec<Value>,
}

async fn relay(
    client: &reqwest::Client,
    endpoint: &str,
    bearer_token: &str,
    session_id: Option<&str>,
    message: &Value,
) -> Result<RelayResponse, String> {
    let mut request = client
        .post(endpoint)
        .header(AUTHORIZATION, format!("Bearer {bearer_token}"))
        .header(ACCEPT, "application/json, text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .json(message);
    if let Some(session_id) = session_id {
        request = request.header("mcp-session-id", session_id);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("browser MCP gateway is unreachable: {error}"))?;
    let status = response.status();
    let response_session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let body = response
        .text()
        .await
        .map_err(|error| format!("could not read browser MCP gateway response: {error}"))?;

    if !status.is_success() {
        return Err(format!("browser MCP gateway returned HTTP {status}"));
    }
    let messages = parse_response_messages(&content_type, &body)?;
    Ok(RelayResponse {
        session_id: response_session_id,
        messages,
    })
}

fn parse_response_messages(content_type: &str, body: &str) -> Result<Vec<Value>, String> {
    if body.trim().is_empty() {
        return Ok(Vec::new());
    }
    if content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
    {
        return body
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .filter(|data| !data.is_empty() && *data != "[DONE]")
            .map(|data| {
                serde_json::from_str(data)
                    .map_err(|error| format!("invalid browser MCP event payload: {error}"))
            })
            .collect();
    }
    serde_json::from_str(body)
        .map(|message| vec![message])
        .map_err(|error| format!("invalid browser MCP JSON response: {error}"))
}

async fn write_message(output: &mut tokio::io::Stdout, message: &Value) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(message)
        .map_err(|error| format!("could not encode browser MCP response: {error}"))?;
    encoded.push(b'\n');
    output
        .write_all(&encoded)
        .await
        .map_err(|error| format!("could not write browser MCP stdio: {error}"))?;
    output
        .flush()
        .await
        .map_err(|error| format!("could not flush browser MCP stdio: {error}"))
}

fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(endpoint)
        .map_err(|error| format!("invalid browser MCP endpoint: {error}"))?;
    let loopback = url
        .host_str()
        .map(|host| host.trim_start_matches('[').trim_end_matches(']'))
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .is_some_and(|address| address.is_loopback());
    if url.scheme() != "http" || !loopback || url.path() != "/mcp" {
        return Err("browser MCP bridge only accepts http://<loopback>/mcp endpoints".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_and_sse_gateway_responses() {
        let message = json!({"jsonrpc":"2.0","id":1,"result":{}});
        assert_eq!(
            parse_response_messages("application/json", &message.to_string()).unwrap(),
            vec![message.clone()]
        );
        let sse = format!("event: message\ndata: {message}\n\n");
        assert_eq!(
            parse_response_messages("text/event-stream; charset=utf-8", &sse).unwrap(),
            vec![message]
        );
        assert!(parse_response_messages("application/json", "")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn bridge_rejects_non_loopback_endpoints() {
        validate_endpoint("http://127.0.0.1:43123/mcp").unwrap();
        validate_endpoint("http://[::1]:43123/mcp").unwrap();
        assert!(validate_endpoint("https://127.0.0.1:43123/mcp").is_err());
        assert!(validate_endpoint("http://example.com/mcp").is_err());
        assert!(validate_endpoint("http://127.0.0.1:43123/other").is_err());
    }
}
