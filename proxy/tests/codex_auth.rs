use assert_cmd::Command;
use tempfile::TempDir;

/// Run a codex auth command with a temp config dir that isolates
/// from the real user config. Overrides HOME so the legacy config
/// fallback also resolves within the temp dir.
fn codex_cmd() -> (Command, TempDir) {
    let temp = TempDir::new().unwrap();
    let mut cmd = Command::cargo_bin("claude-code-proxy").unwrap();
    cmd.args(["codex", "auth", "status"]);
    cmd.env("CCP_CONFIG_DIR", temp.path());
    cmd.env("HOME", temp.path());
    cmd.env("CCP_CODEX_AUTH_SOURCE", "proxy");
    (cmd, temp)
}

#[test]
fn codex_auth_status_reads_stored_auth() -> Result<(), Box<dyn std::error::Error>> {
    let (mut cmd, temp) = codex_cmd();
    let auth_dir = temp.path().join("codex");
    std::fs::create_dir_all(&auth_dir)?;
    std::fs::write(
        auth_dir.join("auth.json"),
        r#"{"access":"a","refresh":"r","expires":4102444800000,"accountId":"acct_1"}"#,
    )?;
    let output = cmd.assert().success().get_output().stdout.clone();
    let out = String::from_utf8(output)?;
    let lines: Vec<_> = out.lines().collect();
    assert_eq!(lines.len(), 3, "{out}");
    assert_eq!(lines[0], "Account: acct_1");
    assert!(
        lines[1].starts_with("Expires: 2100-01-01T00:00:00.000Z (in "),
        "{out}"
    );
    assert!(lines[1].ends_with("s)"), "{out}");
    assert!(lines[2].starts_with("Storage: "), "{out}");
    assert!(!out.contains("Auth path:"));
    assert!(!out.contains("Authenticated: true"));
    Ok(())
}

#[test]
fn codex_auth_status_reads_legacy_account_id_key() -> Result<(), Box<dyn std::error::Error>> {
    let (mut cmd, temp) = codex_cmd();
    let auth_dir = temp.path().join("codex");
    std::fs::create_dir_all(&auth_dir)?;
    std::fs::write(
        auth_dir.join("auth.json"),
        r#"{"access":"a","refresh":"r","expires":4102444800000,"account_id":"acct_2"}"#,
    )?;
    let output = cmd.assert().success().get_output().stdout.clone();
    let out = String::from_utf8(output)?;
    let lines: Vec<_> = out.lines().collect();
    assert_eq!(lines.len(), 3, "{out}");
    assert_eq!(lines[0], "Account: acct_2");
    Ok(())
}

#[test]
fn codex_auth_status_no_auth() -> Result<(), Box<dyn std::error::Error>> {
    let (mut cmd, _temp) = codex_cmd();
    let output = cmd.output()?;
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8(output.stdout)?, "Not authenticated\n");
    Ok(())
}

#[test]
fn codex_auth_status_shows_storage_path() -> Result<(), Box<dyn std::error::Error>> {
    let (mut cmd, temp) = codex_cmd();
    let auth_dir = temp.path().join("codex");
    std::fs::create_dir_all(&auth_dir)?;
    std::fs::write(
        auth_dir.join("auth.json"),
        r#"{"access":"a","refresh":"r","expires":4102444800000,"accountId":"acct_3"}"#,
    )?;
    let output = cmd.assert().success().get_output().stdout.clone();
    let out = String::from_utf8(output)?;
    assert!(out.contains("Storage:"), "{out}");
    assert!(!out.contains("Auth path:"), "{out}");
    Ok(())
}

#[test]
fn codex_auth_status_no_account_id_shows_none() -> Result<(), Box<dyn std::error::Error>> {
    let (mut cmd, temp) = codex_cmd();
    let auth_dir = temp.path().join("codex");
    std::fs::create_dir_all(&auth_dir)?;
    std::fs::write(
        auth_dir.join("auth.json"),
        r#"{"access":"a","refresh":"r","expires":4102444800000}"#,
    )?;
    let output = cmd.output()?;
    let out = String::from_utf8(output.stdout)?;
    assert!(output.status.success());
    assert!(out.contains("Account: (none)"), "{out}");
    assert!(!out.contains("Auth path:"), "{out}");
    assert!(!out.contains("Authenticated: true"), "{out}");
    Ok(())
}

#[test]
fn codex_auth_status_expired_auth_shows_negative_seconds() -> Result<(), Box<dyn std::error::Error>>
{
    let (mut cmd, temp) = codex_cmd();
    let auth_dir = temp.path().join("codex");
    std::fs::create_dir_all(&auth_dir)?;
    std::fs::write(
        auth_dir.join("auth.json"),
        r#"{"access":"a","refresh":"r","expires":946684800000,"accountId":"acct_1"}"#,
    )?;
    let output = cmd.assert().success().get_output().stdout.clone();
    let out = String::from_utf8(output)?;
    let lines: Vec<_> = out.lines().collect();
    assert_eq!(lines.len(), 3, "{out}");
    assert!(lines[0].starts_with("Account:"));
    assert!(
        lines[1].starts_with("Expires: 2000-01-01T00:00:00.000Z (in -"),
        "{out}"
    );
    assert!(lines[2].starts_with("Storage: "), "{out}");
    Ok(())
}

/// A codex auth command reading Codex CLI's own sign-in from a temp
/// `CODEX_HOME`, isolated from the real proxy and Codex CLI credentials.
fn codex_cli_source_cmd(action: &str) -> (Command, TempDir) {
    let temp = TempDir::new().unwrap();
    let mut cmd = Command::cargo_bin("claude-code-proxy").unwrap();
    cmd.args(["codex", "auth", action]);
    cmd.env("CCP_CONFIG_DIR", temp.path());
    cmd.env("HOME", temp.path());
    cmd.env("CCP_CODEX_AUTH_SOURCE", "codex-cli");
    cmd.env("CODEX_HOME", temp.path().join("codex-home"));
    (cmd, temp)
}

fn write_codex_cli_auth(temp: &TempDir) -> std::path::PathBuf {
    use base64::Engine;
    let encode = |json: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    let access = format!(
        "{}.{}.sig",
        encode(r#"{"alg":"none"}"#),
        encode(r#"{"exp":4102444800}"#)
    );
    let home = temp.path().join("codex-home");
    std::fs::create_dir_all(&home).unwrap();
    let auth = home.join("auth.json");
    std::fs::write(
        &auth,
        format!(
            r#"{{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{{"id_token":"x.e30.sig","access_token":"{access}","refresh_token":"r","account_id":"acct_cli"}},"last_refresh":"2026-10-01T00:00:00Z"}}"#
        ),
    )
    .unwrap();
    auth
}

#[test]
fn codex_cli_source_status_reads_codex_cli_sign_in() -> Result<(), Box<dyn std::error::Error>> {
    let (mut cmd, temp) = codex_cli_source_cmd("status");
    let auth = write_codex_cli_auth(&temp);
    let output = cmd.assert().success().get_output().stdout.clone();
    let out = String::from_utf8(output)?;
    let lines: Vec<_> = out.lines().collect();
    assert_eq!(lines.len(), 3, "{out}");
    assert_eq!(lines[0], "Account: acct_cli");
    assert!(
        lines[1].starts_with("Expires: 2100-01-01T00:00:00.000Z (in "),
        "{out}"
    );
    assert_eq!(lines[2], format!("Storage: {}", auth.display()));
    Ok(())
}

#[test]
fn codex_cli_source_status_without_sign_in_says_how_to_sign_in()
-> Result<(), Box<dyn std::error::Error>> {
    let (mut cmd, _temp) = codex_cli_source_cmd("status");
    let output = cmd.output()?;
    assert_eq!(output.status.code(), Some(2));
    let out = String::from_utf8(output.stdout)?;
    assert!(out.contains("Run: codex login"), "{out}");
    Ok(())
}

/// `codex auth source` with a temp config dir and no source environment.
fn codex_auth_source_cmd(temp: &TempDir, source: Option<&str>) -> Command {
    let mut cmd = Command::cargo_bin("claude-code-proxy").unwrap();
    cmd.args(["codex", "auth", "source"]);
    cmd.args(source);
    cmd.env("CCP_CONFIG_DIR", temp.path());
    cmd.env("HOME", temp.path());
    cmd.env_remove("CCP_CODEX_AUTH_SOURCE");
    cmd
}

#[test]
fn codex_auth_source_saves_and_shows_source() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    let config = temp.path().join("config.json");
    std::fs::write(&config, r#"{"port":19000}"#)?;

    let out = codex_auth_source_cmd(&temp, None)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let out = String::from_utf8(out)?;
    assert!(out.starts_with("Source: codex-cli\n"), "{out}");
    assert!(out.contains("Sign in with: codex login"), "{out}");

    let out = codex_auth_source_cmd(&temp, Some("proxy"))
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let out = String::from_utf8(out)?;
    assert!(out.contains("Source: proxy\n"), "{out}");
    assert!(
        out.contains("Sign in with: claude-code-proxy codex auth login"),
        "{out}"
    );
    let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&config)?)?;
    assert_eq!(saved["port"], 19000);
    assert_eq!(saved["codex"]["authSource"], "proxy");

    let output = codex_auth_source_cmd(&temp, Some("chatgpt")).output()?;
    assert!(!output.status.success());
    Ok(())
}

#[test]
fn codex_auth_source_reports_env_override() -> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDir::new()?;
    let out = codex_auth_source_cmd(&temp, Some("codex-cli"))
        .env("CCP_CODEX_AUTH_SOURCE", "proxy")
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let out = String::from_utf8(out)?;
    assert!(out.contains("Source: proxy\n"), "{out}");
    assert!(
        out.contains("CCP_CODEX_AUTH_SOURCE overrides config.json"),
        "{out}"
    );
    Ok(())
}

#[test]
fn codex_cli_source_logout_runs_codex_cli() -> Result<(), Box<dyn std::error::Error>> {
    // The proxy binary stands in for Codex CLI: it rejects `logout`, which
    // shows the command ran, and the real Codex CLI sign-in is never touched.
    let (mut cmd, temp) = codex_cli_source_cmd("logout");
    cmd.env(
        "CCP_CODEX_CLI",
        assert_cmd::cargo::cargo_bin("claude-code-proxy"),
    );
    let auth = write_codex_cli_auth(&temp);
    let output = cmd.output()?;
    assert!(!output.status.success());
    let err = String::from_utf8(output.stderr)?;
    assert!(err.contains("`codex logout` failed"), "{err}");
    assert!(auth.exists());
    Ok(())
}

#[test]
fn codex_cli_source_login_without_codex_cli_says_so() -> Result<(), Box<dyn std::error::Error>> {
    let (mut cmd, temp) = codex_cli_source_cmd("login");
    cmd.env("CCP_CODEX_CLI", temp.path().join("missing-codex"));
    let output = cmd.output()?;
    assert!(!output.status.success());
    let err = String::from_utf8(output.stderr)?;
    assert!(err.contains("Could not run `codex login`"), "{err}");
    Ok(())
}
