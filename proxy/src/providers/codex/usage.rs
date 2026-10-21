//! The ChatGPT account's Codex allowance, as ChatGPT's `/wham/usage` reports
//! it. This is the same source Codex CLI reads for the limits in its `/status`.

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;
use serde_json::Value;

use super::auth::manager::CodexAuthManager;
use super::auth::token_store::StoredAuth;
use crate::auth::AuthStorage;

pub const CODEX_USAGE_ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Debug, Deserialize)]
pub struct CodexUsage {
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default)]
    pub rate_limit: Option<RateLimit>,
    #[serde(default)]
    pub credits: Option<Credits>,
}

#[derive(Debug, Deserialize)]
pub struct RateLimit {
    /// `false` once the account's allowance is used up.
    #[serde(default)]
    pub allowed: Option<bool>,
    #[serde(default)]
    pub primary_window: Option<UsageWindow>,
    #[serde(default)]
    pub secondary_window: Option<UsageWindow>,
}

#[derive(Debug, Deserialize)]
pub struct UsageWindow {
    #[serde(default)]
    pub used_percent: f64,
    #[serde(default)]
    pub limit_window_seconds: i64,
    /// Unix seconds; 0 when the response does not say.
    #[serde(default)]
    pub reset_at: i64,
    #[serde(default)]
    pub reset_after_seconds: i64,
}

#[derive(Debug, Deserialize)]
pub struct Credits {
    #[serde(default)]
    pub has_credits: bool,
    #[serde(default)]
    pub unlimited: bool,
    /// A decimal string such as `"12.5"`.
    #[serde(default)]
    pub balance: Option<Value>,
}

/// The raw `/wham/usage` body. A 401 refreshes the access token once and asks
/// again, as a Codex request does.
pub async fn fetch_usage<S: AuthStorage<StoredAuth>>(
    client: &reqwest::Client,
    url: &str,
    user_agent: &str,
    manager: &CodexAuthManager<S>,
) -> Result<String> {
    let auth = manager.get_auth().await?;
    let mut resp = send_usage_request(client, url, user_agent, &auth).await?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let auth = manager.force_refresh(&auth.access).await?;
        resp = send_usage_request(client, url, user_agent, &auth).await?;
    }
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|err| anyhow!("Failed to read the Codex usage response: {err}"))?;
    if !status.is_success() {
        let detail: String = body.chars().take(200).collect();
        bail!("Codex usage request failed: {status}: {detail}");
    }
    Ok(body)
}

async fn send_usage_request(
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
        .map_err(|err| anyhow!("Codex usage request failed: {err}"))
}

pub fn format_usage(usage: &CodexUsage, now_secs: i64) -> String {
    let mut out = format!(
        "Plan: {}\n",
        usage.plan_type.as_deref().unwrap_or("unknown")
    );
    if let Some(rate_limit) = &usage.rate_limit {
        let windows = [&rate_limit.primary_window, &rate_limit.secondary_window];
        for window in windows.into_iter().flatten() {
            out.push_str(&format_window(window, now_secs));
            out.push('\n');
        }
        match rate_limit.allowed {
            Some(true) => out.push_str("Allowed: yes\n"),
            Some(false) => out.push_str("Allowed: no (usage limit reached)\n"),
            None => {}
        }
    }
    if let Some(credits) = &usage.credits {
        if credits.unlimited {
            out.push_str("Credits: unlimited\n");
        } else if credits.has_credits
            && let Some(balance) = credits.balance.as_ref().map(balance_text)
        {
            out.push_str(&format!("Credits: {balance}\n"));
        }
    }
    out
}

fn format_window(window: &UsageWindow, now_secs: i64) -> String {
    let name = window_name(window.limit_window_seconds);
    let used = format_percent(window.used_percent);
    let resets_at = if window.reset_at > 0 {
        Some(window.reset_at)
    } else if window.reset_after_seconds > 0 {
        Some(now_secs + window.reset_after_seconds)
    } else {
        None
    };
    match resets_at {
        Some(at) => format!(
            "{name} limit: {used}% used, resets {} (in {})",
            format_utc(at),
            format_remaining(at - now_secs)
        ),
        None => format!("{name} limit: {used}% used"),
    }
}

fn window_name(seconds: i64) -> String {
    const HOUR: i64 = 60 * 60;
    const DAY: i64 = 24 * HOUR;
    match seconds {
        s if s > 0 && s % DAY == 0 => format!("{}-day", s / DAY),
        s if s > 0 && s % HOUR == 0 => format!("{}-hour", s / HOUR),
        s if s > 0 => format!("{s}-second"),
        _ => "Usage".to_string(),
    }
}

fn format_percent(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded:.1}")
    }
}

fn format_utc(unix_secs: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(unix_secs)
        .ok()
        .and_then(|dt| {
            let fmt = time::format_description::parse_borrowed::<2>(
                "[year]-[month]-[day]T[hour]:[minute]:[second]Z",
            )
            .ok()?;
            dt.format(&fmt).ok()
        })
        .unwrap_or_else(|| "invalid".to_string())
}

fn format_remaining(seconds: i64) -> String {
    if seconds <= 0 {
        return "now".to_string();
    }
    let days = seconds / 86_400;
    let hours = seconds % 86_400 / 3_600;
    let minutes = seconds % 3_600 / 60;
    match (days, hours) {
        (0, 0) => format!("{}m", minutes.max(1)),
        (0, _) => format!("{hours}h {minutes}m"),
        _ => format!("{days}d {hours}h"),
    }
}

fn balance_text(balance: &Value) -> String {
    match balance {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::InMemoryAuthStore;
    use crate::providers::codex::auth::token_store::CodexTokenStore;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const NOW: i64 = 1_790_000_000;

    fn sample() -> CodexUsage {
        serde_json::from_value(serde_json::json!({
            "plan_type": "plus",
            "rate_limit": {
                "allowed": true,
                "limit_reached": false,
                "primary_window": {
                    "used_percent": 42.25,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 7980,
                    "reset_at": NOW + 7980
                },
                "secondary_window": {
                    "used_percent": 10,
                    "limit_window_seconds": 604800,
                    "reset_after_seconds": 0,
                    "reset_at": NOW + 3 * 86_400 + 3_600
                }
            },
            "credits": {"has_credits": true, "unlimited": false, "balance": "12.5"},
            "unknown_field": {"ignored": true}
        }))
        .unwrap()
    }

    #[test]
    fn format_usage_lists_windows_status_and_credits() {
        let text = format_usage(&sample(), NOW);
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0], "Plan: plus");
        assert_eq!(
            lines[1],
            format!(
                "5-hour limit: 42.3% used, resets {} (in 2h 13m)",
                format_utc(NOW + 7980)
            )
        );
        assert_eq!(
            lines[2],
            format!(
                "7-day limit: 10% used, resets {} (in 3d 1h)",
                format_utc(NOW + 3 * 86_400 + 3_600)
            )
        );
        assert_eq!(lines[3], "Allowed: yes");
        assert_eq!(lines[4], "Credits: 12.5");
        assert_eq!(lines.len(), 5);
    }

    #[test]
    fn format_usage_reports_a_used_up_account() {
        let usage: CodexUsage = serde_json::from_value(serde_json::json!({
            "rate_limit": {
                "allowed": false,
                "primary_window": {"used_percent": 100, "limit_window_seconds": 18000, "reset_after_seconds": 30}
            },
            "credits": {"has_credits": false, "unlimited": false, "balance": "0"}
        }))
        .unwrap();
        let text = format_usage(&usage, NOW);
        assert!(text.starts_with("Plan: unknown\n"), "{text}");
        assert!(
            text.contains("5-hour limit: 100% used, resets ") && text.contains("(in 1m)"),
            "{text}"
        );
        assert!(text.contains("Allowed: no (usage limit reached)"), "{text}");
        assert!(!text.contains("Credits"), "{text}");
    }

    #[test]
    fn window_without_reset_time_omits_it() {
        let window = UsageWindow {
            used_percent: 5.0,
            limit_window_seconds: 0,
            reset_at: 0,
            reset_after_seconds: 0,
        };
        assert_eq!(format_window(&window, NOW), "Usage limit: 5% used");
    }

    fn stored(access: &str) -> StoredAuth {
        StoredAuth {
            access: access.into(),
            refresh: "refresh".into(),
            expires: u64::MAX,
            account_id: Some("acct_1".into()),
        }
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
    async fn fetch_usage_sends_account_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            respond(&mut stream, "200 OK", r#"{"plan_type":"pro"}"#);
            request
        });
        let store = CodexTokenStore::new(InMemoryAuthStore::new());
        store.save_auth(stored("access-1")).unwrap();
        let manager = CodexAuthManager::new(store);

        let body = fetch_usage(
            &reqwest::Client::new(),
            &format!("http://{addr}/backend-api/wham/usage"),
            "claude-code-proxy/test",
            &manager,
        )
        .await
        .unwrap();

        let request = server.join().unwrap();
        assert_eq!(body, r#"{"plan_type":"pro"}"#);
        assert!(
            request.starts_with("get /backend-api/wham/usage "),
            "{request}"
        );
        assert!(
            request.contains("authorization: bearer access-1"),
            "{request}"
        );
        assert!(request.contains("chatgpt-account-id: acct_1"), "{request}");
        assert!(
            request.contains("user-agent: claude-code-proxy/test"),
            "{request}"
        );
    }

    #[tokio::test]
    async fn fetch_usage_refreshes_once_after_401() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            assert!(read_request(&mut stream).contains("bearer stale-access"));
            respond(&mut stream, "401 Unauthorized", r#"{"detail":"expired"}"#);

            let (mut stream, _) = listener.accept().unwrap();
            assert!(read_request(&mut stream).starts_with("post /oauth/token "));
            respond(
                &mut stream,
                "200 OK",
                r#"{"access_token":"fresh-access","refresh_token":"fresh-refresh","expires_in":3600}"#,
            );

            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            respond(&mut stream, "200 OK", r#"{"plan_type":"plus"}"#);
            request
        });
        let store = CodexTokenStore::new(InMemoryAuthStore::new());
        store.save_auth(stored("stale-access")).unwrap();
        let manager =
            CodexAuthManager::new_with_token_endpoint(store, format!("http://{addr}/oauth/token"));

        let body = fetch_usage(
            &reqwest::Client::new(),
            &format!("http://{addr}/backend-api/wham/usage"),
            "",
            &manager,
        )
        .await
        .unwrap();

        let retried = server.join().unwrap();
        assert_eq!(body, r#"{"plan_type":"plus"}"#);
        assert!(retried.contains("bearer fresh-access"), "{retried}");
        assert_eq!(
            manager.store.load_auth().unwrap().unwrap().access,
            "fresh-access"
        );
    }

    #[tokio::test]
    async fn fetch_usage_reports_upstream_errors() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&mut stream);
            respond(&mut stream, "403 Forbidden", r#"{"detail":"no plan"}"#);
        });
        let store = CodexTokenStore::new(InMemoryAuthStore::new());
        store.save_auth(stored("access-1")).unwrap();
        let manager = CodexAuthManager::new(store);

        let err = fetch_usage(
            &reqwest::Client::new(),
            &format!("http://{addr}/backend-api/wham/usage"),
            "",
            &manager,
        )
        .await
        .unwrap_err()
        .to_string();

        server.join().unwrap();
        assert!(err.contains("403"), "{err}");
        assert!(err.contains("no plan"), "{err}");
    }
}
