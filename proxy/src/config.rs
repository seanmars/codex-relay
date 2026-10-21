use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AliasProvider {
    Codex,
    Kimi,
}

impl AliasProvider {
    pub fn as_str(&self) -> &str {
        match self {
            AliasProvider::Codex => "codex",
            AliasProvider::Kimi => "kimi",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub bind_address: String,
    pub port: u16,
    pub alias_provider: AliasProvider,
    pub log_verbose: bool,
    pub log_stderr: bool,
    pub config_dir: PathBuf,
}

#[derive(Deserialize)]
struct FileConfig {
    #[serde(rename = "bindAddress")]
    pub bind_address: Option<String>,
    pub port: Option<u16>,
    #[serde(rename = "aliasProvider")]
    pub alias_provider: Option<String>,
    #[serde(rename = "autoReviewModel")]
    pub auto_review_model: Option<String>,
    pub log: Option<FileLog>,
    pub kimi: Option<KimiConfig>,
    pub codex: Option<CodexConfig>,
    pub cursor: Option<CursorConfig>,
    pub grok: Option<GrokConfig>,
    pub opencode: Option<OpenCodeConfig>,
}

#[derive(Deserialize, Clone)]
struct CodexConfig {
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "originator")]
    pub originator: Option<String>,
    #[serde(rename = "userAgent")]
    pub user_agent: Option<String>,
    #[serde(rename = "previousResponseId")]
    pub previous_response_id: Option<bool>,
    #[serde(rename = "serverCompaction")]
    pub server_compaction: Option<bool>,
    #[serde(rename = "responsesApi")]
    pub responses_api: Option<bool>,
    #[serde(rename = "imagesApi")]
    pub images_api: Option<bool>,
    #[serde(rename = "imagesBaseUrl")]
    pub images_base_url: Option<String>,
    #[serde(rename = "transcriptionsApi")]
    pub transcriptions_api: Option<bool>,
    #[serde(rename = "serviceTier")]
    pub service_tier: Option<String>,
    #[serde(rename = "reasoningSummary")]
    pub reasoning_summary: Option<String>,
    #[serde(rename = "effort")]
    pub effort: Option<String>,
    #[serde(rename = "model")]
    pub model: Option<String>,
    pub transport: Option<String>,
    #[serde(rename = "headerTimeoutMs")]
    pub header_timeout_ms: Option<u64>,
    #[serde(rename = "authSource")]
    pub auth_source: Option<String>,
}

#[derive(Deserialize, Clone)]
struct CursorConfig {
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "clientVersion")]
    pub client_version: Option<String>,
    #[serde(rename = "agentBundle")]
    pub agent_bundle: Option<String>,
}

#[derive(Deserialize, Clone)]
struct KimiConfig {
    #[serde(rename = "userAgent")]
    pub user_agent: Option<String>,
    #[serde(rename = "oauthHost")]
    pub oauth_host: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
}

#[derive(Deserialize, Clone)]
struct GrokConfig {
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
    #[serde(rename = "clientVersion")]
    pub client_version: Option<String>,
}

#[derive(Deserialize, Clone)]
struct OpenCodeConfig {
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
}

#[derive(Deserialize)]
struct FileLog {
    pub verbose: Option<bool>,
    pub stderr: Option<bool>,
}

fn parse_alias(raw: &str) -> Option<AliasProvider> {
    match raw {
        "codex" => Some(AliasProvider::Codex),
        "kimi" => Some(AliasProvider::Kimi),
        _ => None,
    }
}

/// The `config.json` the settings come from: the config dir's own, else the
/// one left in the dir used before the platform fix (`paths::pre_fix_config_file`).
fn config_file_to_read(config_dir: &Path, deps: &paths::DirResolverEnv) -> PathBuf {
    let path = config_dir.join("config.json");
    if path.exists() {
        return path;
    }
    paths::pre_fix_config_file(config_dir, deps)
        .filter(|old| old.exists())
        .unwrap_or(path)
}

fn read_file_config(config_dir: &Path) -> Option<FileConfig> {
    read_file_config_with(config_dir, &paths::DirResolverEnv::default())
}

fn read_file_config_with(config_dir: &Path, deps: &paths::DirResolverEnv) -> Option<FileConfig> {
    let raw = fs::read_to_string(config_file_to_read(config_dir, deps)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Resolves dirs from `env` alone, so a test can hand in the env it wants
/// instead of changing the process env that tests running in parallel read
fn resolver_env(env: &HashMap<String, String>) -> paths::DirResolverEnv {
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .cloned()
        .unwrap_or_else(|| "/".to_string());
    paths::DirResolverEnv {
        platform: std::env::consts::OS.to_string(),
        env: env.clone(),
        home,
    }
}

/// The `config.json` of the config dir `env` resolves to
fn file_config_for_env(env: &HashMap<String, String>) -> Option<FileConfig> {
    let deps = resolver_env(env);
    read_file_config_with(&paths::resolve_config_dir(&deps), &deps)
}

pub fn load_config() -> LoadedConfig {
    load_config_from_env(&paths::DirResolverEnv::default())
}

pub fn load_config_for_env(env: &HashMap<String, String>) -> LoadedConfig {
    load_config_from_env(&resolver_env(env))
}

fn load_config_from_env(deps: &paths::DirResolverEnv) -> LoadedConfig {
    let env = &deps.env;
    let config_dir = paths::resolve_config_dir(deps);
    let file = read_file_config_with(&config_dir, deps);

    let mut out = LoadedConfig {
        bind_address: "127.0.0.1".to_string(),
        port: 8970,
        alias_provider: AliasProvider::Codex,
        log_verbose: false,
        log_stderr: false,
        config_dir: config_dir.clone(),
    };

    if let Some(raw) = env.get("CCP_BIND_ADDRESS") {
        out.bind_address = raw.clone();
    } else if let Some(bind_address) = file.as_ref().and_then(|f| f.bind_address.clone()) {
        out.bind_address = bind_address;
    }

    if let Some(raw) = env.get("CCP_ALIAS_PROVIDER") {
        if let Some(alias) = parse_alias(raw) {
            out.alias_provider = alias;
        }
    } else if let Some(alias_provider) = file
        .as_ref()
        .and_then(|f| f.alias_provider.as_deref())
        .and_then(parse_alias)
    {
        out.alias_provider = alias_provider;
    }

    if let Some(raw) = env.get("PORT") {
        if let Ok(port) = raw.parse::<u16>() {
            out.port = port;
        }
    } else if let Some(port) = file.as_ref().and_then(|f| f.port) {
        out.port = port;
    }

    if env.contains_key("CCP_LOG_VERBOSE") {
        out.log_verbose = true;
    } else if let Some(value) = file
        .as_ref()
        .and_then(|f| f.log.as_ref().and_then(|v| v.verbose))
    {
        out.log_verbose = value;
    }

    if env.contains_key("CCP_LOG_STDERR") {
        out.log_stderr = true;
    } else if let Some(value) = file
        .as_ref()
        .and_then(|f| f.log.as_ref().and_then(|v| v.stderr))
    {
        out.log_stderr = value;
    }

    out
}

pub fn config_path() -> PathBuf {
    paths::config_dir().join("config.json")
}

pub fn port() -> u16 {
    load_config().port
}

pub fn bind_address() -> String {
    load_config().bind_address
}

pub fn alias_provider() -> AliasProvider {
    load_config().alias_provider
}

pub fn log_verbose() -> bool {
    load_config().log_verbose
}

pub fn log_stderr() -> bool {
    load_config().log_stderr
}

pub fn config_override_summary_lines(cfg: &LoadedConfig) -> Vec<String> {
    let file = read_file_config(&cfg.config_dir);
    let env: HashMap<_, _> = std::env::vars().collect();
    let mut out = Vec::new();
    if env.contains_key("CCP_BIND_ADDRESS") {
        out.push("bindAddress (env)".to_string());
    }
    if env.contains_key("PORT") {
        out.push("port (env)".to_string());
    }
    if env.contains_key("CCP_ALIAS_PROVIDER") {
        out.push("aliasProvider (env)".to_string());
    }
    if env.contains_key("CCP_LOG_VERBOSE") {
        out.push("log.verbose (env)".to_string());
    }
    if env.contains_key("CCP_LOG_STDERR") {
        out.push("log.stderr (env)".to_string());
    }
    if env.contains_key("CCP_CODEX_RESPONSES_API") {
        out.push("codex.responsesApi (env)".to_string());
    }
    if env.contains_key("CCP_CODEX_IMAGES_API") {
        out.push("codex.imagesApi (env)".to_string());
    }
    if env.contains_key("CCP_CODEX_IMAGES_BASE_URL") {
        out.push("codex.imagesBaseUrl (env)".to_string());
    }
    if env.contains_key("CCP_CODEX_TRANSCRIPTIONS_API") {
        out.push("codex.transcriptionsApi (env)".to_string());
    }
    if env.contains_key("CCP_KIMI_OAUTH_HOST") {
        out.push("kimi.oauthHost (env)".to_string());
    }
    if env.contains_key("CCP_KIMI_BASE_URL") {
        out.push("kimi.baseUrl (env)".to_string());
    }
    if env.contains_key("CCP_CURSOR_BASE_URL") {
        out.push("cursor.baseUrl (env)".to_string());
    }
    if env.contains_key("CCP_CURSOR_CLIENT_VERSION") {
        out.push("cursor.clientVersion (env)".to_string());
    }
    if env.contains_key("CCP_KIMI_USER_AGENT") {
        out.push("kimi.userAgent (env)".to_string());
    }
    if env.contains_key("CCP_GROK_BASE_URL") {
        out.push("grok.baseUrl (env)".to_string());
    }
    if env.contains_key("CCP_GROK_CLIENT_VERSION") {
        out.push("grok.clientVersion (env)".to_string());
    }
    if env.contains_key("CCP_OPENCODE_API_KEY") {
        out.push("opencode.apiKey (env)".to_string());
    } else if env.contains_key("OPENCODE_API_KEY") {
        out.push("opencode.apiKey (OpenCode env)".to_string());
    }
    if env.contains_key("CCP_OPENCODE_BASE_URL") {
        out.push("opencode.baseUrl (env)".to_string());
    }
    if env
        .get("CCP_CODEX_REASONING_SUMMARY")
        .is_some_and(|raw| !raw.is_empty())
    {
        out.push("CCP_CODEX_REASONING_SUMMARY (env)".to_string());
    }
    if env.contains_key("CCP_CODEX_SERVER_COMPACTION") {
        out.push("CCP_CODEX_SERVER_COMPACTION (env)".to_string());
    }
    if env
        .get("CCP_AUTO_REVIEW_MODEL")
        .is_some_and(|raw| !raw.is_empty())
    {
        out.push("CCP_AUTO_REVIEW_MODEL (env)".to_string());
    }
    if let Some(file_cfg) = file {
        if let Some(bind_address) = file_cfg.bind_address {
            out.push(format!("bindAddress: {bind_address}"));
        }
        if let Some(p) = file_cfg.port {
            out.push(format!("port: {p}"));
        }
        if let Some(alias) = file_cfg.alias_provider {
            out.push(format!("aliasProvider: {alias}"));
        }
        if file_cfg
            .auto_review_model
            .is_some_and(|model| !model.is_empty())
        {
            out.push("autoReviewModel (config)".to_string());
        }
        if let Some(log) = file_cfg.log {
            if let Some(v) = log.verbose {
                out.push(format!("log.verbose: {v}"));
            }
            if let Some(v) = log.stderr {
                out.push(format!("log.stderr: {v}"));
            }
        }
        if let Some(opencode) = file_cfg.opencode {
            if opencode.api_key.is_some_and(|raw| !raw.is_empty()) {
                out.push("opencode.apiKey (config)".to_string());
            }
            if let Some(url) = opencode.base_url.filter(|raw| !raw.is_empty()) {
                out.push(format!("opencode.baseUrl: {url}"));
            }
        }
        if let Some(codex) = file_cfg.codex {
            if codex
                .reasoning_summary
                .is_some_and(|value| !value.is_empty())
            {
                out.push("codex.reasoningSummary (config)".to_string());
            }
            if let Some(enabled) = codex.server_compaction {
                out.push(format!("codex.serverCompaction: {enabled}"));
            }
            if codex.responses_api == Some(true) {
                out.push("codex.responsesApi: true".to_string());
            }
            if codex.images_api == Some(true) {
                out.push("codex.imagesApi: true".to_string());
            }
            if codex.images_base_url.is_some() {
                out.push("codex.imagesBaseUrl (config)".to_string());
            }
            if codex.transcriptions_api == Some(true) {
                out.push("codex.transcriptionsApi: true".to_string());
            }
            if let Some(ms) = codex.header_timeout_ms {
                out.push(format!("codex.headerTimeoutMs: {ms}"));
            }
        }
    }
    out
}

pub fn grok_base_url() -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_GROK_BASE_URL") {
        return raw.clone();
    }
    if let Some(grok) = read_file_config(&paths::config_dir()).and_then(|f| f.grok)
        && let Some(url) = grok.base_url
    {
        return url;
    }
    "https://cli-chat-proxy.grok.com/v1".to_string()
}

pub fn grok_client_version() -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_GROK_CLIENT_VERSION") {
        return raw.clone();
    }
    if let Some(grok) = read_file_config(&paths::config_dir()).and_then(|f| f.grok)
        && let Some(version) = grok.client_version
    {
        return version;
    }
    "0.2.93".to_string()
}

// ---------------------------------------------------------------------------
// Grok tool-image policy (CCP_GROK_TOOL_IMAGE)
// ---------------------------------------------------------------------------

/// How the Grok translator treats Anthropic `image` blocks (tool results and
/// top-level user messages). `omit` is the safe default: degrade to the L1
/// placeholder string. `reattach` keeps the placeholder in the tool output and
/// additionally appends a user message carrying the images as `input_image`
/// data URLs. `inline` sends the tool output itself as an array of
/// `input_text` + `input_image` parts (string-only outputs still serialize as
/// plain strings). `reject` restores the pre-L1 hard error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrokToolImageMode {
    Omit,
    Reattach,
    Inline,
    Reject,
}

pub fn parse_grok_tool_image_mode(raw: Option<&str>) -> GrokToolImageMode {
    match raw.map(str::trim) {
        Some("reattach") => GrokToolImageMode::Reattach,
        Some("inline") => GrokToolImageMode::Inline,
        Some("reject") => GrokToolImageMode::Reject,
        // Any unknown/empty value degrades to the safe default.
        _ => GrokToolImageMode::Omit,
    }
}

pub fn grok_tool_image_mode() -> GrokToolImageMode {
    parse_grok_tool_image_mode(std::env::var("CCP_GROK_TOOL_IMAGE").ok().as_deref())
}

/// Warn once at startup when an unknown mode was requested. Called from the
/// Grok provider constructor rather than per request.
pub fn warn_grok_tool_image_mode_once(log: &crate::logging::Logger) {
    match std::env::var("CCP_GROK_TOOL_IMAGE")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some(other) if !matches!(other, "" | "omit" | "reattach" | "inline" | "reject") => {
            let mut fields = serde_json::Map::new();
            fields.insert(
                "value".to_string(),
                serde_json::Value::String(other.to_string()),
            );
            log.warn(
                "unrecognized CCP_GROK_TOOL_IMAGE value; falling back to omit",
                Some(fields),
            );
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Grok hosted-search policy (CCP_GROK_HOSTED_SEARCH)
// ---------------------------------------------------------------------------

/// Whether the Grok translator replaces caller search tools with xAI-hosted
/// search and requires hosted tool use on explicit search turns.
///
/// The disabled policy preserves caller tools, instructions, and tool choice.
/// It adds `x_search` only to X-specific turns because the caller has no
/// equivalent access to xAI's X index.
///
/// The enabled policy favors xAI-hosted search and citations. Hosted tools
/// replace caller search implementations, matching turns receive search
/// guidance, and explicit search turns use `tool_choice: required`.
///
/// Set `CCP_GROK_HOSTED_SEARCH` to `1`, `on`, or `true` to enable this policy.
pub fn parse_grok_hosted_search(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1" | "on" | "true"))
}

pub fn grok_hosted_search() -> bool {
    parse_grok_hosted_search(std::env::var("CCP_GROK_HOSTED_SEARCH").ok().as_deref())
}

// ---------------------------------------------------------------------------
// Grok hosted-search block shape (CCP_GROK_SEARCH_BLOCKS)
// ---------------------------------------------------------------------------

/// How a hosted search that xAI ran is reported to the client.
///
/// `Text` projects the search query into a standard `text` block.
///
/// `Native` preserves the Anthropic server-tool shape: `server_tool_use`
/// followed by `web_search_tool_result` or `x_search_tool_result`. Select this
/// shape for clients that consume hosted-tool blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrokSearchBlocks {
    Text,
    Native,
}

pub fn parse_grok_search_blocks(raw: Option<&str>) -> GrokSearchBlocks {
    match raw.map(str::trim) {
        Some("native") => GrokSearchBlocks::Native,
        // Text is the compatibility-safe fallback for empty or unknown values.
        _ => GrokSearchBlocks::Text,
    }
}

pub fn grok_search_blocks() -> GrokSearchBlocks {
    parse_grok_search_blocks(std::env::var("CCP_GROK_SEARCH_BLOCKS").ok().as_deref())
}

struct ResolvedOpenCodeConfig {
    api_key: Option<String>,
    api_key_source: Option<&'static str>,
    base_url: String,
}

fn resolve_opencode_config(
    env: &HashMap<String, String>,
    config_dir: &Path,
) -> ResolvedOpenCodeConfig {
    let file = read_file_config(config_dir).and_then(|file| file.opencode);
    let file_key = file
        .as_ref()
        .and_then(|config| config.api_key.as_ref())
        .filter(|value| !value.is_empty());
    let (api_key, api_key_source) = if let Some(value) = env
        .get("CCP_OPENCODE_API_KEY")
        .filter(|value| !value.is_empty())
    {
        (Some(value.clone()), Some("CCP_OPENCODE_API_KEY"))
    } else if let Some(value) = env
        .get("OPENCODE_API_KEY")
        .filter(|value| !value.is_empty())
    {
        (Some(value.clone()), Some("OPENCODE_API_KEY"))
    } else if let Some(value) = file_key {
        (Some(value.clone()), Some("config.json"))
    } else {
        (None, None)
    };
    let base_url = env
        .get("CCP_OPENCODE_BASE_URL")
        .filter(|value| !value.is_empty())
        .cloned()
        .or_else(|| {
            file.as_ref()
                .and_then(|config| config.base_url.as_ref())
                .filter(|value| !value.is_empty())
                .cloned()
        })
        .unwrap_or_else(|| "https://opencode.ai/zen/go/v1".to_string());

    ResolvedOpenCodeConfig {
        api_key,
        api_key_source,
        base_url,
    }
}

pub fn opencode_api_key() -> Option<String> {
    let env: HashMap<_, _> = std::env::vars().collect();
    resolve_opencode_config(&env, &paths::config_dir()).api_key
}

pub fn opencode_api_key_source() -> Option<&'static str> {
    let env: HashMap<_, _> = std::env::vars().collect();
    resolve_opencode_config(&env, &paths::config_dir()).api_key_source
}

pub fn opencode_base_url() -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    resolve_opencode_config(&env, &paths::config_dir()).base_url
}

pub fn is_verbose() -> bool {
    log_verbose()
}

pub fn kimi_oauth_host() -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_KIMI_OAUTH_HOST") {
        return raw.clone();
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(kimi) = file.kimi
        && let Some(host) = kimi.oauth_host
    {
        return host;
    }
    "https://auth.kimi.com".to_string()
}

pub fn kimi_base_url() -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_KIMI_BASE_URL") {
        return raw.clone();
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(kimi) = file.kimi
        && let Some(url) = kimi.base_url
    {
        return url;
    }
    "https://api.kimi.com/coding/v1".to_string()
}

pub fn kimi_user_agent(default: &str) -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_KIMI_USER_AGENT") {
        return raw.clone();
    }
    if let Some(raw) = env.get("CCP_USER_AGENT") {
        return raw.clone();
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(kimi) = file.kimi
        && let Some(ua) = kimi.user_agent
    {
        return ua;
    }
    default.to_string()
}

// ---------------------------------------------------------------------------
// Codex config
// ---------------------------------------------------------------------------

pub fn codex_base_url(default: &str) -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CODEX_BASE_URL") {
        return raw.clone();
    }
    if let Some(raw) = env.get("CLAUDE_CODE_PROXY_CODEX_BASE_URL") {
        return raw.clone();
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(codex) = file.codex
        && let Some(url) = codex.base_url
    {
        return url;
    }
    default.to_string()
}

pub fn codex_originator(default: &str) -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CODEX_ORIGINATOR") {
        return raw.clone();
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(codex) = file.codex
        && let Some(val) = codex.originator
    {
        return val;
    }
    default.to_string()
}

pub fn codex_user_agent(default: &str) -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CODEX_USER_AGENT") {
        return raw.clone();
    }
    if let Some(raw) = env.get("CCP_USER_AGENT") {
        return raw.clone();
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(codex) = file.codex
        && let Some(ua) = codex.user_agent
    {
        return ua;
    }
    default.to_string()
}

pub fn codex_previous_response_id() -> bool {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CODEX_PREVIOUS_RESPONSE_ID") {
        return matches!(raw.to_ascii_lowercase().as_str(), "1" | "true" | "yes");
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(codex) = file.codex
        && let Some(val) = codex.previous_response_id
    {
        return val;
    }
    false
}

pub fn codex_server_compaction() -> bool {
    codex_server_compaction_for_env(&std::env::vars().collect())
}

fn codex_server_compaction_for_env(env: &HashMap<String, String>) -> bool {
    if let Some(raw) = env.get("CCP_CODEX_SERVER_COMPACTION") {
        match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => return true,
            "0" | "false" | "no" | "off" => return false,
            _ => {}
        }
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(enabled) = codex.server_compaction
    {
        return enabled;
    }
    false
}

pub fn codex_responses_api() -> bool {
    codex_responses_api_for_env(&std::env::vars().collect())
}

fn codex_responses_api_for_env(env: &HashMap<String, String>) -> bool {
    if let Some(raw) = env.get("CCP_CODEX_RESPONSES_API") {
        return matches!(raw.to_ascii_lowercase().as_str(), "1" | "true" | "yes");
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(enabled) = codex.responses_api
    {
        return enabled;
    }
    false
}

pub fn codex_images_api() -> bool {
    codex_images_api_for_env(&std::env::vars().collect())
}

fn codex_images_api_for_env(env: &HashMap<String, String>) -> bool {
    if let Some(raw) = env.get("CCP_CODEX_IMAGES_API") {
        return matches!(raw.to_ascii_lowercase().as_str(), "1" | "true" | "yes");
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(enabled) = codex.images_api
    {
        return enabled;
    }
    false
}

pub fn codex_transcriptions_api() -> bool {
    codex_transcriptions_api_for_env(&std::env::vars().collect())
}

fn codex_transcriptions_api_for_env(env: &HashMap<String, String>) -> bool {
    if let Some(raw) = env.get("CCP_CODEX_TRANSCRIPTIONS_API") {
        return matches!(raw.to_ascii_lowercase().as_str(), "1" | "true" | "yes");
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(enabled) = codex.transcriptions_api
    {
        return enabled;
    }
    false
}

pub fn codex_images_base_url() -> String {
    codex_images_base_url_for_env(&std::env::vars().collect())
}

fn codex_images_base_url_for_env(env: &HashMap<String, String>) -> String {
    if let Some(raw) = env.get("CCP_CODEX_IMAGES_BASE_URL") {
        return raw.clone();
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(url) = codex.images_base_url
    {
        return url;
    }
    "https://chatgpt.com/backend-api/codex".to_string()
}

pub fn codex_service_tier() -> Option<String> {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CODEX_SERVICE_TIER") {
        return Some(raw.clone());
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(codex) = file.codex
    {
        return codex.service_tier;
    }
    None
}

pub fn codex_effort() -> Option<String> {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CODEX_EFFORT") {
        return Some(raw.clone());
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(codex) = file.codex
    {
        return codex.effort;
    }
    None
}

pub fn codex_reasoning_summary() -> Option<String> {
    codex_reasoning_summary_for_env(&std::env::vars().collect())
}

fn codex_reasoning_summary_for_env(env: &HashMap<String, String>) -> Option<String> {
    if let Some(raw) = env
        .get("CCP_CODEX_REASONING_SUMMARY")
        .filter(|raw| !raw.is_empty())
    {
        return Some(raw.clone());
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(summary) = codex.reasoning_summary.filter(|raw| !raw.is_empty())
    {
        return Some(summary);
    }
    None
}

pub fn codex_model() -> Option<String> {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CODEX_MODEL") {
        return Some(raw.clone());
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(codex) = file.codex
    {
        return codex.model;
    }
    None
}

pub fn auto_review_model() -> Option<String> {
    auto_review_model_for_env(&std::env::vars().collect())
}

fn auto_review_model_for_env(env: &HashMap<String, String>) -> Option<String> {
    if let Some(raw) = env
        .get("CCP_AUTO_REVIEW_MODEL")
        .filter(|raw| !raw.is_empty())
    {
        return Some(raw.clone());
    }
    file_config_for_env(env)
        .and_then(|file| file.auto_review_model)
        .filter(|model| !model.is_empty())
}

// ---------------------------------------------------------------------------
// Codex transport config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexTransport {
    Http,
    WebSocket,
    Auto,
}

impl CodexTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexTransport::Http => "http",
            CodexTransport::WebSocket => "websocket",
            CodexTransport::Auto => "auto",
        }
    }
}

fn parse_codex_transport(raw: &str) -> Option<CodexTransport> {
    match raw {
        "http" => Some(CodexTransport::Http),
        "websocket" => Some(CodexTransport::WebSocket),
        "auto" => Some(CodexTransport::Auto),
        _ => None,
    }
}

pub fn codex_transport() -> CodexTransport {
    codex_transport_for_env(&std::env::vars().collect())
}

fn codex_transport_for_env(env: &HashMap<String, String>) -> CodexTransport {
    if let Some(raw) = env.get("CCP_CODEX_TRANSPORT")
        && let Some(transport) = parse_codex_transport(raw)
    {
        return transport;
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(transport) = codex.transport.as_deref().and_then(parse_codex_transport)
    {
        return transport;
    }
    CodexTransport::WebSocket
}

/// How long an HTTP-transport request waits for the Codex response headers.
///
/// Codex withholds the response head until the model produces its first
/// output, so the wait tracks how much reasoning the request asks for rather
/// than the health of the connection. A large request to a high-effort model
/// can hold the head for minutes, and the timeout firing fails the request
/// outright, so the default is generous. Lower it only where a request that
/// slow is better failed than waited out. Values below
/// `CODEX_MIN_HEADER_TIMEOUT_MS` are ignored rather than clamped, so a typo
/// does not hide behind a working default.
pub const CODEX_DEFAULT_HEADER_TIMEOUT_MS: u64 = 300_000;
pub const CODEX_MIN_HEADER_TIMEOUT_MS: u64 = 1_000;

pub fn codex_header_timeout_ms() -> u64 {
    codex_header_timeout_ms_for_env(&std::env::vars().collect())
}

fn codex_header_timeout_ms_for_env(env: &HashMap<String, String>) -> u64 {
    if let Some(ms) = env
        .get("CCP_CODEX_HEADER_TIMEOUT_MS")
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|ms| *ms >= CODEX_MIN_HEADER_TIMEOUT_MS)
    {
        return ms;
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(ms) = codex
            .header_timeout_ms
            .filter(|ms| *ms >= CODEX_MIN_HEADER_TIMEOUT_MS)
    {
        return ms;
    }
    CODEX_DEFAULT_HEADER_TIMEOUT_MS
}

/// Which ChatGPT sign-in Codex requests use: the proxy's own (`proxy`), or
/// Codex CLI's `auth.json`, refreshed in place (`codex-cli`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexAuthSource {
    Proxy,
    CodexCli,
}

impl CodexAuthSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexAuthSource::Proxy => "proxy",
            CodexAuthSource::CodexCli => "codex-cli",
        }
    }
}

fn parse_codex_auth_source(raw: &str) -> Option<CodexAuthSource> {
    match raw {
        "proxy" => Some(CodexAuthSource::Proxy),
        "codex-cli" => Some(CodexAuthSource::CodexCli),
        _ => None,
    }
}

/// Value parser for `codex auth source`, which names the accepted values.
pub fn parse_codex_auth_source_arg(raw: &str) -> Result<CodexAuthSource, String> {
    parse_codex_auth_source(raw)
        .ok_or_else(|| format!("expected \"proxy\" or \"codex-cli\", got \"{raw}\""))
}

pub fn codex_auth_source() -> CodexAuthSource {
    codex_auth_source_for_env(&std::env::vars().collect())
}

fn codex_auth_source_for_env(env: &HashMap<String, String>) -> CodexAuthSource {
    if let Some(raw) = env.get("CCP_CODEX_AUTH_SOURCE")
        && let Some(source) = parse_codex_auth_source(raw)
    {
        return source;
    }
    if let Some(file) = file_config_for_env(env)
        && let Some(codex) = file.codex
        && let Some(source) = codex
            .auth_source
            .as_deref()
            .and_then(parse_codex_auth_source)
    {
        return source;
    }
    CodexAuthSource::CodexCli
}

/// Writes `codex.authSource` into `config.json` and keeps every other key.
/// A `config.json` that is not a JSON object is refused, not replaced. The
/// keys of a `config.json` still in the pre-fix dir move along to the config dir.
pub fn save_codex_auth_source(source: CodexAuthSource) -> anyhow::Result<PathBuf> {
    save_codex_auth_source_for_env(source, &std::env::vars().collect())
}

fn save_codex_auth_source_for_env(
    source: CodexAuthSource,
    env: &HashMap<String, String>,
) -> anyhow::Result<PathBuf> {
    let deps = resolver_env(env);
    let config_dir = paths::resolve_config_dir(&deps);
    let path = config_dir.join("config.json");
    let source_path = config_file_to_read(&config_dir, &deps);
    let mut root = match fs::read_to_string(&source_path) {
        Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|err| anyhow::anyhow!("{} is not valid JSON: {err}", source_path.display()))?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(err) => {
            return Err(anyhow::anyhow!(
                "Failed to read {}: {err}",
                source_path.display()
            ));
        }
    };
    let codex = root
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("{} is not a JSON object", path.display()))?
        .entry("codex")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("\"codex\" in {} is not a JSON object", path.display()))?;
    codex.insert("authSource".into(), source.as_str().into());
    crate::auth::write_atomically(&path.to_string_lossy(), &root)?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Cursor config
// ---------------------------------------------------------------------------

pub fn cursor_base_url() -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CURSOR_BASE_URL") {
        return raw.clone();
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(cursor) = file.cursor
        && let Some(url) = cursor.base_url
    {
        return url;
    }
    "https://api2.cursor.sh".to_string()
}

pub fn cursor_client_version() -> String {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CURSOR_CLIENT_VERSION") {
        return raw.clone();
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(cursor) = file.cursor
        && let Some(version) = cursor.client_version
    {
        return version;
    }
    detect_cursor_agent_version().unwrap_or_else(|| "cli-2026.07.23-e383d2b".to_string())
}

fn detect_cursor_agent_version() -> Option<String> {
    let output = std::process::Command::new("cursor-agent")
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?;
    let version = version.lines().next()?.trim();
    if version.is_empty() {
        return None;
    }
    Some(if version.starts_with("cli-") {
        version.to_string()
    } else {
        format!("cli-{version}")
    })
}

pub fn cursor_agent_bundle() -> Option<String> {
    let env: HashMap<_, _> = std::env::vars().collect();
    if let Some(raw) = env.get("CCP_CURSOR_AGENT_BUNDLE") {
        return Some(raw.clone());
    }
    let config_dir = paths::config_dir();
    if let Some(file) = read_file_config(&config_dir)
        && let Some(cursor) = file.cursor
        && let Some(bundle) = cursor.agent_bundle
    {
        return Some(bundle);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests hand the `_for_env` accessors an env of their own and never touch
    // the process env: other tests read config through it while these run
    fn config_env(config: &tempfile::TempDir) -> HashMap<String, String> {
        HashMap::from([(
            "CCP_CONFIG_DIR".to_string(),
            config.path().to_string_lossy().into_owned(),
        )])
    }

    // Before the platform fix Windows kept config.json under ~/.config; it is
    // still read from there, and the next save moves its keys to %APPDATA%
    #[cfg(windows)]
    #[test]
    fn windows_reads_and_moves_a_config_left_in_the_pre_fix_dir() {
        let root = tempfile::TempDir::new().unwrap();
        let env = HashMap::from([
            (
                "HOME".to_string(),
                root.path().to_string_lossy().into_owned(),
            ),
            (
                "APPDATA".to_string(),
                root.path().join("AppData").to_string_lossy().into_owned(),
            ),
        ]);
        let old_dir = root.path().join(".config").join("claude-code-proxy");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::write(old_dir.join("config.json"), r#"{"port":19001}"#).unwrap();

        assert_eq!(load_config_for_env(&env).port, 19001);
        let saved = save_codex_auth_source_for_env(CodexAuthSource::Proxy, &env).unwrap();
        assert_eq!(
            saved,
            root.path()
                .join("AppData")
                .join("claude-code-proxy")
                .join("config.json")
        );
        let moved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&saved).unwrap()).unwrap();
        assert_eq!(moved["port"], 19001);
        assert_eq!(moved["codex"]["authSource"], "proxy");

        // From now on the config dir's own file is the one read
        std::fs::write(old_dir.join("config.json"), r#"{"port":19002}"#).unwrap();
        assert_eq!(load_config_for_env(&env).port, 19001);
    }

    #[test]
    fn opencode_config_reads_file_and_env_precedence() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"opencode":{"apiKey":"file-key","baseUrl":"https://file.example/v1"}}"#,
        )
        .unwrap();
        let mut env = HashMap::new();
        let resolved = resolve_opencode_config(&env, config.path());
        assert_eq!(resolved.api_key.as_deref(), Some("file-key"));
        assert_eq!(resolved.api_key_source, Some("config.json"));
        assert_eq!(resolved.base_url, "https://file.example/v1");

        env.insert("OPENCODE_API_KEY".into(), "standard-key".into());
        let resolved = resolve_opencode_config(&env, config.path());
        assert_eq!(resolved.api_key.as_deref(), Some("standard-key"));
        assert_eq!(resolved.api_key_source, Some("OPENCODE_API_KEY"));

        env.insert("CCP_OPENCODE_API_KEY".into(), "ccp-key".into());
        env.insert(
            "CCP_OPENCODE_BASE_URL".into(),
            "https://env.example/v1".into(),
        );
        let resolved = resolve_opencode_config(&env, config.path());
        assert_eq!(resolved.api_key.as_deref(), Some("ccp-key"));
        assert_eq!(resolved.api_key_source, Some("CCP_OPENCODE_API_KEY"));
        assert_eq!(resolved.base_url, "https://env.example/v1");
    }

    #[test]
    fn bind_address_defaults_to_loopback() {
        let config = tempfile::TempDir::new().unwrap();
        let env = config_env(&config);

        assert_eq!(load_config_for_env(&env).bind_address, "127.0.0.1");
    }

    #[test]
    fn bind_address_reads_config_and_env_takes_precedence() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"bindAddress":"192.0.2.10"}"#,
        )
        .unwrap();
        let mut env = config_env(&config);

        assert_eq!(load_config_for_env(&env).bind_address, "192.0.2.10");
        env.insert("CCP_BIND_ADDRESS".to_string(), "0.0.0.0".to_string());
        assert_eq!(load_config_for_env(&env).bind_address, "0.0.0.0");
    }

    #[test]
    fn codex_transport_defaults_to_websocket() {
        let config = tempfile::TempDir::new().unwrap();
        let env = config_env(&config);
        assert_eq!(codex_transport_for_env(&env), CodexTransport::WebSocket);
    }

    #[test]
    fn codex_transport_reads_env() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);
        env.insert("CCP_CODEX_TRANSPORT".to_string(), "auto".to_string());
        assert_eq!(codex_transport_for_env(&env), CodexTransport::Auto);
    }

    #[test]
    fn codex_transport_env_websocket() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);
        env.insert("CCP_CODEX_TRANSPORT".to_string(), "websocket".to_string());
        assert_eq!(codex_transport_for_env(&env), CodexTransport::WebSocket);
    }

    #[test]
    fn codex_transport_invalid_env_falls_back_to_websocket() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);
        env.insert("CCP_CODEX_TRANSPORT".to_string(), "invalid".to_string());
        assert_eq!(codex_transport_for_env(&env), CodexTransport::WebSocket);
    }

    #[test]
    fn codex_transport_empty_env_falls_back_to_websocket() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);
        env.insert("CCP_CODEX_TRANSPORT".to_string(), String::new());
        assert_eq!(codex_transport_for_env(&env), CodexTransport::WebSocket);
    }

    #[test]
    fn codex_auth_source_defaults_reads_file_and_env_precedence() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);

        assert_eq!(codex_auth_source_for_env(&env), CodexAuthSource::CodexCli);
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"authSource":"proxy"}}"#,
        )
        .unwrap();
        assert_eq!(codex_auth_source_for_env(&env), CodexAuthSource::Proxy);
        env.insert("CCP_CODEX_AUTH_SOURCE".to_string(), "codex-cli".to_string());
        assert_eq!(codex_auth_source_for_env(&env), CodexAuthSource::CodexCli);
        env.insert("CCP_CODEX_AUTH_SOURCE".to_string(), "invalid".to_string());
        assert_eq!(codex_auth_source_for_env(&env), CodexAuthSource::Proxy);
        assert_eq!(CodexAuthSource::CodexCli.as_str(), "codex-cli");
    }

    #[test]
    fn save_codex_auth_source_keeps_other_keys() {
        let config = tempfile::TempDir::new().unwrap();
        let env = config_env(&config);
        let path = config.path().join("config.json");

        assert_eq!(
            save_codex_auth_source_for_env(CodexAuthSource::CodexCli, &env).unwrap(),
            path
        );
        assert_eq!(codex_auth_source_for_env(&env), CodexAuthSource::CodexCli);

        std::fs::write(&path, r#"{"port":19000,"codex":{"model":"gpt-6"}}"#).unwrap();
        save_codex_auth_source_for_env(CodexAuthSource::CodexCli, &env).unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["port"], 19000);
        assert_eq!(saved["codex"]["model"], "gpt-6");
        assert_eq!(saved["codex"]["authSource"], "codex-cli");

        save_codex_auth_source_for_env(CodexAuthSource::Proxy, &env).unwrap();
        assert_eq!(codex_auth_source_for_env(&env), CodexAuthSource::Proxy);

        std::fs::write(&path, "not json").unwrap();
        assert!(save_codex_auth_source_for_env(CodexAuthSource::CodexCli, &env).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
    }

    #[test]
    fn codex_header_timeout_defaults_overrides_and_floors() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);

        assert_eq!(
            codex_header_timeout_ms_for_env(&env),
            CODEX_DEFAULT_HEADER_TIMEOUT_MS
        );
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"headerTimeoutMs":600000}}"#,
        )
        .unwrap();
        assert_eq!(codex_header_timeout_ms_for_env(&env), 600_000);
        env.insert(
            "CCP_CODEX_HEADER_TIMEOUT_MS".to_string(),
            "120000".to_string(),
        );
        assert_eq!(codex_header_timeout_ms_for_env(&env), 120_000);
        env.remove("CCP_CODEX_HEADER_TIMEOUT_MS");
        // Below the floor is ignored, not clamped: a value that small is a typo,
        // and clamping it would hide the typo behind a working default.
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"headerTimeoutMs":5}}"#,
        )
        .unwrap();
        assert_eq!(
            codex_header_timeout_ms_for_env(&env),
            CODEX_DEFAULT_HEADER_TIMEOUT_MS
        );
        env.insert("CCP_CODEX_HEADER_TIMEOUT_MS".to_string(), "0".to_string());
        assert_eq!(
            codex_header_timeout_ms_for_env(&env),
            CODEX_DEFAULT_HEADER_TIMEOUT_MS
        );
    }

    #[test]
    fn parse_codex_transport_variants() {
        assert_eq!(parse_codex_transport("http"), Some(CodexTransport::Http));
        assert_eq!(
            parse_codex_transport("websocket"),
            Some(CodexTransport::WebSocket)
        );
        assert_eq!(parse_codex_transport("auto"), Some(CodexTransport::Auto));
        assert_eq!(parse_codex_transport(""), None);
        assert_eq!(parse_codex_transport("HTTP"), None);
        assert_eq!(parse_codex_transport("ws"), None);
    }

    #[test]
    fn codex_transport_as_str() {
        assert_eq!(CodexTransport::Http.as_str(), "http");
        assert_eq!(CodexTransport::WebSocket.as_str(), "websocket");
        assert_eq!(CodexTransport::Auto.as_str(), "auto");
    }

    #[test]
    fn log_env_presence_enables_legacy_verbose_and_stderr() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);
        env.insert("CCP_LOG_VERBOSE".to_string(), "0".to_string());
        env.insert("CCP_LOG_STDERR".to_string(), String::new());

        let loaded = load_config_for_env(&env);
        assert!(loaded.log_verbose);
        assert!(loaded.log_stderr);
    }

    #[test]
    fn log_config_values_apply_without_env() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"log":{"verbose":true,"stderr":true}}"#,
        )
        .unwrap();
        let env = config_env(&config);

        let loaded = load_config_for_env(&env);
        assert!(loaded.log_verbose);
        assert!(loaded.log_stderr);
    }

    #[test]
    fn codex_responses_api_defaults_to_disabled() {
        let config = tempfile::TempDir::new().unwrap();
        let env = config_env(&config);

        assert!(!codex_responses_api_for_env(&env));
    }

    #[test]
    fn codex_responses_api_reads_config_and_env_takes_precedence() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"responsesApi":true}}"#,
        )
        .unwrap();
        let mut env = config_env(&config);

        assert!(codex_responses_api_for_env(&env));
        env.insert("CCP_CODEX_RESPONSES_API".to_string(), "false".to_string());
        assert!(!codex_responses_api_for_env(&env));
    }

    #[test]
    fn codex_responses_api_accepts_enabled_env_values() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);

        for value in ["1", "true", "TRUE", "yes"] {
            env.insert("CCP_CODEX_RESPONSES_API".to_string(), value.to_string());
            assert!(codex_responses_api_for_env(&env), "{value}");
        }
    }

    #[test]
    fn codex_images_api_defaults_to_disabled_and_env_overrides_config() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"imagesApi":true,"imagesBaseUrl":"https://chatgpt.com/backend-api/codex-custom"}}"#,
        )
        .unwrap();
        let mut env = config_env(&config);

        assert!(codex_images_api_for_env(&env));
        assert_eq!(
            codex_images_base_url_for_env(&env),
            "https://chatgpt.com/backend-api/codex-custom"
        );
        env.insert("CCP_CODEX_IMAGES_API".to_string(), "false".to_string());
        env.insert(
            "CCP_CODEX_IMAGES_BASE_URL".to_string(),
            "https://chatgpt.com/backend-api/codex".to_string(),
        );
        assert!(!codex_images_api_for_env(&env));
        assert_eq!(
            codex_images_base_url_for_env(&env),
            "https://chatgpt.com/backend-api/codex"
        );
    }

    #[test]
    fn codex_transcriptions_api_defaults_to_disabled_and_env_overrides_config() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"transcriptionsApi":true}}"#,
        )
        .unwrap();
        let mut env = config_env(&config);

        assert!(codex_transcriptions_api_for_env(&env));
        env.insert(
            "CCP_CODEX_TRANSCRIPTIONS_API".to_string(),
            "false".to_string(),
        );
        assert!(!codex_transcriptions_api_for_env(&env));
    }

    #[test]
    fn codex_reasoning_summary_reads_config() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"reasoningSummary":"off"}}"#,
        )
        .unwrap();
        let env = config_env(&config);

        assert_eq!(
            codex_reasoning_summary_for_env(&env).as_deref(),
            Some("off")
        );
    }

    #[test]
    fn codex_reasoning_summary_env_overrides_config_and_empty_falls_through() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"reasoningSummary":"off"}}"#,
        )
        .unwrap();
        let mut env = config_env(&config);

        env.insert(
            "CCP_CODEX_REASONING_SUMMARY".to_string(),
            "auto".to_string(),
        );
        assert_eq!(
            codex_reasoning_summary_for_env(&env).as_deref(),
            Some("auto")
        );
        env.insert("CCP_CODEX_REASONING_SUMMARY".to_string(), String::new());
        assert_eq!(
            codex_reasoning_summary_for_env(&env).as_deref(),
            Some("off")
        );
    }

    #[test]
    fn auto_review_model_reads_top_level_config_and_env_takes_precedence() {
        let config = tempfile::TempDir::new().unwrap();
        std::fs::write(
            config.path().join("config.json"),
            r#"{"autoReviewModel":"grok-4.5"}"#,
        )
        .unwrap();
        let mut env = config_env(&config);

        assert_eq!(auto_review_model_for_env(&env).as_deref(), Some("grok-4.5"));
        env.insert(
            "CCP_AUTO_REVIEW_MODEL".to_string(),
            "gpt-5.6-terra".to_string(),
        );
        assert_eq!(
            auto_review_model_for_env(&env).as_deref(),
            Some("gpt-5.6-terra")
        );
        env.insert("CCP_AUTO_REVIEW_MODEL".to_string(), String::new());
        assert_eq!(auto_review_model_for_env(&env).as_deref(), Some("grok-4.5"));
    }

    #[test]
    fn codex_server_compaction_defaults_and_overrides() {
        let config = tempfile::TempDir::new().unwrap();
        let mut env = config_env(&config);

        assert!(!codex_server_compaction_for_env(&env));
        env.insert("CCP_CODEX_SERVER_COMPACTION".to_string(), "on".to_string());
        assert!(codex_server_compaction_for_env(&env));
        env.remove("CCP_CODEX_SERVER_COMPACTION");
        std::fs::write(
            config.path().join("config.json"),
            r#"{"codex":{"serverCompaction":true}}"#,
        )
        .unwrap();
        assert!(codex_server_compaction_for_env(&env));
        env.insert(
            "CCP_CODEX_SERVER_COMPACTION".to_string(),
            "false".to_string(),
        );
        assert!(!codex_server_compaction_for_env(&env));
    }
}
