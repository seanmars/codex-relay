//! The Codex models the signed-in ChatGPT account may use, as the Codex
//! backend lists them. This is the same list Codex CLI fetches for `/model`
//! (and caches in `~/.codex/models_cache.json`).

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;

use super::auth::manager::CodexAuthManager;
use super::auth::token_store::StoredAuth;
use crate::auth::AuthStorage;

/// The Codex CLI version the list is asked for: the backend may leave out
/// models an older client cannot run. `CCP_CODEX_CLIENT_VERSION` overrides it.
pub const DEFAULT_CLIENT_VERSION: &str = "0.163.0";

#[derive(Debug, Deserialize)]
pub struct CodexModels {
    #[serde(default)]
    pub models: Vec<CodexModel>,
}

#[derive(Debug, Deserialize)]
pub struct CodexModel {
    pub slug: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// `list` for the models a picker shows; `hide` for internal ones
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub default_reasoning_level: Option<String>,
    #[serde(default)]
    pub supported_reasoning_levels: Vec<ReasoningLevel>,
    #[serde(default)]
    pub additional_speed_tiers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReasoningLevel {
    pub effort: String,
}

impl CodexModel {
    pub fn is_listed(&self) -> bool {
        self.visibility.as_deref() != Some("hide")
    }
}

/// The models endpoint beside the Responses endpoint, so `codex.baseUrl`
/// (and `CCP_CODEX_BASE_URL`) move both.
pub fn models_url(responses_url: &str, client_version: &str) -> String {
    let base = responses_url.trim_end_matches('/');
    let base = base.strip_suffix("/responses").unwrap_or(base);
    format!("{base}/models?client_version={client_version}")
}

pub fn client_version() -> String {
    std::env::var("CCP_CODEX_CLIENT_VERSION")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_VERSION.to_string())
}

/// GETs the models list. A 401 refreshes the sign-in once and asks again.
pub async fn fetch_models<S: AuthStorage<StoredAuth>>(
    client: &reqwest::Client,
    url: &str,
    user_agent: &str,
    manager: &CodexAuthManager<S>,
) -> Result<String> {
    let auth = manager.get_auth().await?;
    let mut resp = send_models_request(client, url, user_agent, &auth).await?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let auth = manager.force_refresh(&auth.access).await?;
        resp = send_models_request(client, url, user_agent, &auth).await?;
    }
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|err| anyhow!("Failed to read the Codex models response: {err}"))?;
    if !status.is_success() {
        let detail: String = body.chars().take(200).collect();
        bail!("Codex models request failed: {status}: {detail}");
    }
    Ok(body)
}

async fn send_models_request(
    client: &reqwest::Client,
    url: &str,
    user_agent: &str,
    auth: &StoredAuth,
) -> Result<reqwest::Response> {
    let mut request = client
        .get(url)
        .bearer_auth(&auth.access)
        .header(http::header::ACCEPT, "application/json");
    if !user_agent.is_empty() {
        request = request.header(http::header::USER_AGENT, user_agent);
    }
    if let Some(account_id) = &auth.account_id {
        request = request.header("ChatGPT-Account-Id", account_id);
    }
    request
        .send()
        .await
        .map_err(|err| anyhow!("Codex models request failed: {err}"))
}

fn context_text(tokens: Option<u64>) -> String {
    match tokens {
        Some(n) if n >= 1000 => format!("{}k", n / 1000),
        Some(n) => n.to_string(),
        None => "-".into(),
    }
}

fn reasoning_text(model: &CodexModel) -> String {
    let levels: Vec<&str> = model
        .supported_reasoning_levels
        .iter()
        .map(|level| level.effort.as_str())
        .collect();
    if levels.is_empty() {
        return "-".into();
    }
    match &model.default_reasoning_level {
        Some(default) => format!("{} (default {default})", levels.join("/")),
        None => levels.join("/"),
    }
}

/// The account's models next to what the proxy routes: `accepted` is the
/// proxy's own list of base Codex model ids.
pub fn format_models(models: &CodexModels, accepted: &[&str], full: bool) -> String {
    let shown: Vec<&CodexModel> = models
        .models
        .iter()
        .filter(|model| full || model.is_listed())
        .collect();
    let rows: Vec<[String; 5]> = shown
        .iter()
        .map(|model| {
            let speed = if model.additional_speed_tiers.is_empty() {
                "-".to_string()
            } else {
                model.additional_speed_tiers.join(",")
            };
            let proxy = if accepted.contains(&model.slug.as_str()) {
                "yes"
            } else {
                "no"
            };
            let slug = if model.is_listed() {
                model.slug.clone()
            } else {
                format!("{} (hidden)", model.slug)
            };
            [
                slug,
                context_text(model.context_window),
                reasoning_text(model),
                speed.to_string(),
                proxy.to_string(),
            ]
        })
        .collect();
    let header = ["MODEL", "CONTEXT", "REASONING", "SPEED", "PROXY"].map(String::from);
    let mut widths = header.clone().map(|cell| cell.len());
    for row in &rows {
        for (width, cell) in widths.iter_mut().zip(row) {
            *width = (*width).max(cell.len());
        }
    }
    let line = |cells: &[String; 5]| {
        let mut out = String::new();
        for (i, (cell, width)) in cells.iter().zip(widths).enumerate() {
            if i + 1 == cells.len() {
                out.push_str(cell);
            } else {
                out.push_str(&format!("{cell:<width$}  "));
            }
        }
        out.push('\n');
        out
    };

    let mut out = line(&header);
    for row in &rows {
        out.push_str(&line(row));
    }
    let not_listed: Vec<&str> = accepted
        .iter()
        .copied()
        .filter(|id| !models.models.iter().any(|model| model.slug == *id))
        .collect();
    if !not_listed.is_empty() {
        out.push_str(&format!(
            "\nThe proxy also accepts, but this account's list does not have: {}\n",
            not_listed.join(", ")
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::InMemoryAuthStore;
    use crate::providers::codex::auth::token_store::CodexTokenStore;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const BODY: &str = r#"{"models":[
        {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","visibility":"list","context_window":500000,
         "default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}],
         "additional_speed_tiers":["fast"],"unknown_field":1},
        {"slug":"gpt-new","visibility":"list","context_window":272000},
        {"slug":"codex-auto-review","visibility":"hide"}
    ]}"#;

    #[test]
    fn models_url_sits_beside_the_responses_endpoint() {
        assert_eq!(
            models_url("https://chatgpt.com/backend-api/codex/responses", "0.1.0"),
            "https://chatgpt.com/backend-api/codex/models?client_version=0.1.0"
        );
        assert_eq!(
            models_url("http://127.0.0.1:9/codex/", "0.1.0"),
            "http://127.0.0.1:9/codex/models?client_version=0.1.0"
        );
    }

    #[test]
    fn format_marks_what_the_proxy_accepts_and_hides_internal_models() {
        let models: CodexModels = serde_json::from_str(BODY).unwrap();
        let text = format_models(&models, &["gpt-6.1-sol", "gpt-5.2"], false);
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].starts_with("MODEL"), "{text}");
        assert!(
            lines[1].starts_with("gpt-6.1-sol")
                && lines[1].contains("500k")
                && lines[1].contains("low/high (default low)")
                && lines[1].contains("fast")
                && lines[1].ends_with("yes"),
            "{text}"
        );
        assert!(
            lines[2].starts_with("gpt-new") && lines[2].ends_with("no"),
            "{text}"
        );
        assert!(!text.contains("codex-auto-review"), "{text}");
        assert!(
            text.contains("this account's list does not have: gpt-5.2"),
            "{text}"
        );

        let full = format_models(&models, &["gpt-6.1-sol"], true);
        assert!(full.contains("codex-auto-review (hidden)"), "{full}");
    }

    fn respond(stream: &mut std::net::TcpStream, status: &str, body: &str) {
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
    }

    fn read_request(stream: &mut std::net::TcpStream) -> String {
        let mut request = [0u8; 8192];
        let read = stream.read(&mut request).unwrap();
        String::from_utf8_lossy(&request[..read]).to_ascii_lowercase()
    }

    #[tokio::test]
    async fn fetch_models_sends_account_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            respond(&mut stream, "200 OK", r#"{"models":[]}"#);
            request
        });
        let store = CodexTokenStore::new(InMemoryAuthStore::new());
        store
            .save_auth(StoredAuth {
                access: "access-1".into(),
                refresh: "refresh".into(),
                expires: u64::MAX,
                account_id: Some("acct_1".into()),
            })
            .unwrap();
        let manager = CodexAuthManager::new(store);

        let body = fetch_models(
            &reqwest::Client::new(),
            &models_url(&format!("http://{addr}/codex/responses"), "9.9.9"),
            "claude-code-proxy/test",
            &manager,
        )
        .await
        .unwrap();

        let request = server.join().unwrap();
        assert_eq!(body, r#"{"models":[]}"#);
        assert!(
            request.starts_with("get /codex/models?client_version=9.9.9 "),
            "{request}"
        );
        assert!(
            request.contains("authorization: bearer access-1"),
            "{request}"
        );
        assert!(request.contains("chatgpt-account-id: acct_1"), "{request}");
    }
}
