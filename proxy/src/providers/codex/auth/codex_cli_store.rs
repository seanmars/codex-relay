//! Codex CLI's own ChatGPT sign-in, shared instead of copied.
//!
//! With `codex.authSource = "codex-cli"` the proxy reads `$CODEX_HOME/auth.json`
//! (default `~/.codex/auth.json`) and writes refreshed tokens back into it.
//! OpenAI rotates the refresh token on every refresh, so a second copy of the
//! sign-in would leave one side holding a spent refresh token. Every field the
//! proxy does not own is kept as Codex CLI wrote it.

use std::path::{Path, PathBuf};

use anyhow::{Result, anyhow, bail};
use serde_json::Value;

use super::jwt::{TokenResponse, extract_account_id, jwt_expiry_ms};
use super::token_store::StoredAuth;
use crate::auth::{AuthStorage, write_atomically};

const CREDENTIALS_STORE_KEY: &str = "cli_auth_credentials_store";

pub struct CodexCliAuthStore {
    home: PathBuf,
}

impl CodexCliAuthStore {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    fn auth_file(&self) -> PathBuf {
        self.home.join("auth.json")
    }

    fn config_file(&self) -> PathBuf {
        self.home.join("config.toml")
    }

    /// The sign-in as Codex CLI wrote it, or an error that says how to sign in.
    fn read_raw(&self) -> Result<Value> {
        let config = self.config_file();
        let mode = credentials_store_mode(&config)?;
        match mode.as_str() {
            "file" | "auto" => {}
            "keyring" => bail!(
                "Codex CLI keeps its sign-in in the system keyring ({CREDENTIALS_STORE_KEY} = \"keyring\" in {}), which claude-code-proxy does not read. Set it to \"file\", then run: codex login",
                config.display()
            ),
            "ephemeral" => bail!(
                "Codex CLI keeps its sign-in in its own memory ({CREDENTIALS_STORE_KEY} = \"ephemeral\" in {}), which no other program can read. Set it to \"file\", then run: codex login",
                config.display()
            ),
            other => bail!(
                "{CREDENTIALS_STORE_KEY} = \"{other}\" in {} is not a value Codex CLI knows",
                config.display()
            ),
        }

        let path = self.auth_file();
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if mode == "auto" {
                    bail!(
                        "Codex CLI is not signed in through {}. With {CREDENTIALS_STORE_KEY} = \"auto\" in {} it may keep its sign-in in the system keyring, which claude-code-proxy does not read. Set it to \"file\", then run: codex login",
                        path.display(),
                        config.display()
                    );
                }
                bail!(
                    "Codex CLI is not signed in: {} does not exist. Run: codex login",
                    path.display()
                );
            }
            Err(err) => return Err(anyhow!("Failed to read {}: {err}", path.display())),
        };
        let value: Value = serde_json::from_str(&raw)
            .map_err(|err| anyhow!("{} is not valid JSON: {err}", path.display()))?;
        if !value.is_object() {
            bail!("{} is not a JSON object", path.display());
        }
        Ok(value)
    }
}

impl AuthStorage<StoredAuth> for CodexCliAuthStore {
    fn load(&self) -> Result<Option<StoredAuth>> {
        let raw = self.read_raw()?;
        stored_auth_from_codex(&raw, &self.auth_file()).map(Some)
    }

    /// Writes rotated tokens back into Codex CLI's file. `expires` is not
    /// stored: Codex CLI keeps none, and `load` reads it from the access
    /// token. The refresh response's new `id_token` does not reach this store,
    /// so the one Codex CLI wrote stays; Codex CLI reads only identity claims
    /// from it.
    fn save(&self, value: StoredAuth) -> Result<()> {
        let path = self.auth_file();
        let mut raw = self.read_raw()?;
        let tokens = raw
            .get_mut("tokens")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| anyhow!("{} has no ChatGPT tokens to update", path.display()))?;
        tokens.insert("access_token".into(), Value::String(value.access));
        tokens.insert("refresh_token".into(), Value::String(value.refresh));
        if let Some(object) = raw.as_object_mut() {
            object.insert("last_refresh".into(), Value::String(now_rfc3339()?));
        }
        write_atomically(&path.to_string_lossy(), &raw)
    }

    /// Codex CLI owns this sign-in, so the proxy never deletes it; `codex
    /// logout` does. A refresh the server refuses still fails the request.
    fn clear(&self) -> Result<()> {
        Ok(())
    }

    fn path(&self) -> String {
        self.auth_file().to_string_lossy().into_owned()
    }
}

fn stored_auth_from_codex(raw: &Value, path: &Path) -> Result<StoredAuth> {
    if raw.get("auth_mode").and_then(Value::as_str) == Some("apikey") {
        bail!("Codex CLI is signed in with an API key, not a ChatGPT account. Run: codex login");
    }
    let tokens = raw.get("tokens");
    let field = |name: &str| {
        tokens
            .and_then(|tokens| tokens.get(name))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let access = field("access_token").ok_or_else(|| {
        anyhow!(
            "{} has no ChatGPT access token. Run: codex login",
            path.display()
        )
    })?;
    let refresh = field("refresh_token").unwrap_or_default();
    let account_id = field("account_id").or_else(|| {
        extract_account_id(&TokenResponse {
            id_token: field("id_token"),
            access_token: access.clone(),
            refresh_token: refresh.clone(),
            expires_in: None,
        })
    });
    // An access token without `exp` is used until the server refuses it.
    let expires = jwt_expiry_ms(&access).unwrap_or(u64::MAX);
    Ok(StoredAuth {
        access,
        refresh,
        expires,
        account_id,
    })
}

/// The top-level `cli_auth_credentials_store` value in Codex CLI's
/// `config.toml`, `"file"` when the file or the key is absent. A top-level TOML
/// key comes before the first table header, so the scan stops there.
fn credentials_store_mode(config: &Path) -> Result<String> {
    let raw = match std::fs::read_to_string(config) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok("file".into()),
        Err(err) => return Err(anyhow!("Failed to read {}: {err}", config.display())),
    };
    for line in raw.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        let Some(rest) = line.strip_prefix(CREDENTIALS_STORE_KEY) else {
            continue;
        };
        let Some(value) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.split('#').next().unwrap_or_default().trim();
        let value = value.trim_matches(|c| c == '"' || c == '\'');
        return Ok(if value.is_empty() {
            "file".into()
        } else {
            value.to_string()
        });
    }
    Ok("file".into())
}

fn now_rfc3339() -> Result<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|err| anyhow!("Failed to format the refresh time: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;

    fn jwt(claims: Value) -> String {
        let encode = |value: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        format!(
            "{}.{}.sig",
            encode(&json!({"alg": "none"})),
            encode(&claims)
        )
    }

    fn codex_home(auth: Option<Value>, config: Option<&str>) -> tempfile::TempDir {
        let home = tempfile::TempDir::new().unwrap();
        if let Some(auth) = auth {
            std::fs::write(
                home.path().join("auth.json"),
                serde_json::to_string_pretty(&auth).unwrap(),
            )
            .unwrap();
        }
        if let Some(config) = config {
            std::fs::write(home.path().join("config.toml"), config).unwrap();
        }
        home
    }

    fn chatgpt_auth(access: &str) -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": jwt(json!({"https://api.openai.com/auth": {"chatgpt_account_id": "acct_from_id"}})),
                "access_token": access,
                "refresh_token": "refresh-1",
                "account_id": "acct_1"
            },
            "last_refresh": "2026-10-01T00:00:00Z",
            "agent_identity": {"kept": true}
        })
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn load_maps_codex_cli_tokens() {
        let access = jwt(json!({"exp": 4102444800u64}));
        let home = codex_home(Some(chatgpt_auth(&access)), None);
        let store = CodexCliAuthStore::new(home.path().to_path_buf());

        let auth = store.load().unwrap().unwrap();
        assert_eq!(auth.access, access);
        assert_eq!(auth.refresh, "refresh-1");
        assert_eq!(auth.expires, 4_102_444_800_000);
        assert_eq!(auth.account_id.as_deref(), Some("acct_1"));
    }

    #[test]
    fn load_reads_account_id_from_id_token_when_tokens_omit_it() {
        let mut auth = chatgpt_auth(&jwt(json!({})));
        auth["tokens"].as_object_mut().unwrap().remove("account_id");
        let home = codex_home(Some(auth), None);
        let store = CodexCliAuthStore::new(home.path().to_path_buf());

        let auth = store.load().unwrap().unwrap();
        assert_eq!(auth.account_id.as_deref(), Some("acct_from_id"));
        assert_eq!(auth.expires, u64::MAX);
    }

    #[test]
    fn load_refuses_api_key_sign_in() {
        let home = codex_home(
            Some(json!({"auth_mode": "apikey", "OPENAI_API_KEY": "sk-test"})),
            None,
        );
        let err = CodexCliAuthStore::new(home.path().to_path_buf())
            .load()
            .unwrap_err()
            .to_string();
        assert!(err.contains("API key"), "{err}");
    }

    #[test]
    fn load_without_auth_file_says_how_to_sign_in() {
        let home = codex_home(None, None);
        let err = CodexCliAuthStore::new(home.path().to_path_buf())
            .load()
            .unwrap_err()
            .to_string();
        assert!(err.contains("Run: codex login"), "{err}");
    }

    #[test]
    fn load_refuses_keyring_and_ephemeral_stores() {
        for mode in ["keyring", "ephemeral"] {
            let config = format!("model = \"gpt-6-sol\"\n{CREDENTIALS_STORE_KEY} = \"{mode}\"\n");
            let home = codex_home(Some(chatgpt_auth("a")), Some(&config));
            let err = CodexCliAuthStore::new(home.path().to_path_buf())
                .load()
                .unwrap_err()
                .to_string();
            assert!(err.contains(mode), "{err}");
        }
    }

    #[test]
    fn auto_store_reads_auth_file_and_explains_a_missing_one() {
        let config = format!("{CREDENTIALS_STORE_KEY} = 'auto' # fall back to the file\n");
        let home = codex_home(Some(chatgpt_auth("a")), Some(&config));
        let store = CodexCliAuthStore::new(home.path().to_path_buf());
        assert_eq!(store.load().unwrap().unwrap().access, "a");

        std::fs::remove_file(home.path().join("auth.json")).unwrap();
        let err = store.load().unwrap_err().to_string();
        assert!(err.contains("system keyring"), "{err}");
    }

    #[test]
    fn credentials_store_key_inside_a_table_is_ignored() {
        let config = format!("[profiles.work]\n{CREDENTIALS_STORE_KEY} = \"keyring\"\n");
        let home = codex_home(Some(chatgpt_auth("a")), Some(&config));
        let store = CodexCliAuthStore::new(home.path().to_path_buf());
        assert_eq!(store.load().unwrap().unwrap().access, "a");
    }

    #[test]
    fn save_rotates_tokens_and_keeps_every_other_field() {
        let home = codex_home(Some(chatgpt_auth("old-access")), None);
        let store = CodexCliAuthStore::new(home.path().to_path_buf());
        let before = read_json(&home.path().join("auth.json"));

        store
            .save(StoredAuth {
                access: "new-access".into(),
                refresh: "refresh-2".into(),
                expires: 1,
                account_id: Some("acct_other".into()),
            })
            .unwrap();

        let after = read_json(&home.path().join("auth.json"));
        assert_eq!(after["tokens"]["access_token"], "new-access");
        assert_eq!(after["tokens"]["refresh_token"], "refresh-2");
        assert_eq!(after["tokens"]["account_id"], "acct_1");
        assert_eq!(after["tokens"]["id_token"], before["tokens"]["id_token"]);
        assert_eq!(after["auth_mode"], "chatgpt");
        assert_eq!(after["agent_identity"], json!({"kept": true}));
        assert!(after.get("expires").is_none());
        assert_ne!(after["last_refresh"], before["last_refresh"]);
        let last_refresh = after["last_refresh"].as_str().unwrap();
        assert!(
            time::OffsetDateTime::parse(
                last_refresh,
                &time::format_description::well_known::Rfc3339
            )
            .is_ok(),
            "{last_refresh}"
        );
    }

    #[test]
    fn clear_keeps_codex_cli_sign_in() {
        let home = codex_home(Some(chatgpt_auth("a")), None);
        let store = CodexCliAuthStore::new(home.path().to_path_buf());
        store.clear().unwrap();
        assert!(home.path().join("auth.json").exists());
    }
}
