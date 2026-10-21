use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// `std::env::consts::OS` on the platforms with dirs of their own.
pub const WINDOWS: &str = "windows";
pub const MACOS: &str = "macos";

#[derive(Debug, Clone)]
pub struct DirResolverEnv {
    pub platform: String,
    pub env: HashMap<String, String>,
    pub home: String,
}

impl Default for DirResolverEnv {
    fn default() -> Self {
        Self {
            platform: std::env::consts::OS.into(),
            env: std::env::vars().collect(),
            home: std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| "/".to_string()),
        }
    }
}

pub fn resolve_config_dir(deps: &DirResolverEnv) -> PathBuf {
    if let Some(override_dir) = deps.env.get("CCP_CONFIG_DIR") {
        return Path::new(override_dir).to_path_buf();
    }

    if deps.platform == WINDOWS {
        let appdata = deps
            .env
            .get("APPDATA")
            .cloned()
            .unwrap_or_else(|| format!("{}\\AppData\\Roaming", deps.home));
        return join_with_sep(&appdata, &["claude-code-proxy"], true);
    }

    if deps.platform == MACOS {
        return join_with_sep(&deps.home, &[".config", "claude-code-proxy"], false);
    }

    xdg_config_dir(deps)
}

fn xdg_config_dir(deps: &DirResolverEnv) -> PathBuf {
    let base = deps.env.get("XDG_CONFIG_HOME").cloned().unwrap_or_else(|| {
        join_with_sep(&deps.home, &[".config"], false)
            .to_string_lossy()
            .into_owned()
    });
    join_with_sep(&base, &["claude-code-proxy"], false)
}

/// Until the platform names matched `std::env::consts::OS`, Windows and macOS
/// resolved the config dir as Linux does (XDG). While the default config dir
/// has no `config.json`, the file from that old dir is read in its place.
/// Only for the default dir: an explicit `CCP_CONFIG_DIR` has no old dir.
pub fn pre_fix_config_file(config_dir: &Path, deps: &DirResolverEnv) -> Option<PathBuf> {
    if deps.platform != WINDOWS && deps.platform != MACOS {
        return None;
    }
    if deps.env.contains_key("CCP_CONFIG_DIR") || resolve_config_dir(deps) != config_dir {
        return None;
    }
    let old = xdg_config_dir(deps);
    (old != config_dir).then(|| old.join("config.json"))
}

pub fn resolve_state_dir(deps: &DirResolverEnv) -> PathBuf {
    if deps.platform == WINDOWS {
        let local = deps
            .env
            .get("LOCALAPPDATA")
            .cloned()
            .unwrap_or_else(|| format!("{}\\AppData\\Local", deps.home));
        return join_with_sep(&local, &["claude-code-proxy"], true);
    }

    let base = deps.env.get("XDG_STATE_HOME").cloned().unwrap_or_else(|| {
        join_with_sep(&deps.home, &[".local", "state"], false)
            .to_string_lossy()
            .into_owned()
    });
    join_with_sep(&base, &["claude-code-proxy"], false)
}

pub fn legacy_config_dir(deps: &DirResolverEnv) -> PathBuf {
    join_with_sep(&deps.home, &[".config", "claude-code-proxy"], false)
}

pub fn config_dir() -> PathBuf {
    resolve_config_dir(&DirResolverEnv::default())
}

pub fn state_dir() -> PathBuf {
    resolve_state_dir(&DirResolverEnv::default())
}

pub fn codex_auth_file(deps: &DirResolverEnv) -> PathBuf {
    resolve_config_dir(deps).join("codex").join("auth.json")
}

/// Codex CLI's home, where its own `auth.json` and `config.toml` live:
/// `CODEX_HOME`, else `~/.codex`, as Codex CLI resolves it.
pub fn resolve_codex_cli_home(deps: &DirResolverEnv) -> PathBuf {
    if let Some(home) = deps.env.get("CODEX_HOME").filter(|home| !home.is_empty()) {
        return Path::new(home).to_path_buf();
    }
    join_with_sep(&deps.home, &[".codex"], false)
}

pub fn codex_cli_home() -> PathBuf {
    resolve_codex_cli_home(&DirResolverEnv::default())
}

pub fn kimi_auth_file(deps: &DirResolverEnv) -> PathBuf {
    resolve_config_dir(deps).join("kimi").join("auth.json")
}

pub fn cursor_auth_file(deps: &DirResolverEnv) -> PathBuf {
    resolve_config_dir(deps).join("cursor").join("auth.json")
}

pub fn kimi_device_id_file(deps: &DirResolverEnv) -> PathBuf {
    resolve_config_dir(deps).join("kimi").join("device_id")
}

pub fn log_file() -> PathBuf {
    resolve_state_dir(&DirResolverEnv::default()).join("proxy.log")
}

pub fn provider_auth_file(provider: &str) -> PathBuf {
    let deps = DirResolverEnv::default();
    resolve_config_dir(&deps).join(provider).join("auth.json")
}

pub fn provider_legacy_auth_file(provider: &str) -> PathBuf {
    let deps = DirResolverEnv::default();
    legacy_config_dir(&deps).join(provider).join("auth.json")
}

fn join_with_sep(base: &str, parts: &[&str], win32: bool) -> PathBuf {
    let sep = if win32 { '\\' } else { '/' };
    let mut out = String::new();
    for part in std::iter::once(base).chain(parts.iter().copied()) {
        if !out.is_empty() && !out.ends_with(['/', '\\']) {
            out.push(sep);
        }
        out.push_str(part);
    }
    Path::new(&out).to_path_buf()
}

pub fn resolve_config_dir_for_env(
    platform: &str,
    home: &str,
    env: &HashMap<String, String>,
) -> PathBuf {
    resolve_config_dir(&DirResolverEnv {
        platform: platform.to_string(),
        env: env.clone(),
        home: home.to_string(),
    })
}

pub fn resolve_state_dir_for_env(
    platform: &str,
    home: &str,
    env: &HashMap<String, String>,
) -> PathBuf {
    resolve_state_dir(&DirResolverEnv {
        platform: platform.to_string(),
        env: env.clone(),
        home: home.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deps(env: &[(&str, &str)]) -> DirResolverEnv {
        DirResolverEnv {
            platform: "linux".into(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            home: "/home/me".into(),
        }
    }

    #[test]
    fn codex_cli_home_prefers_codex_home() {
        assert_eq!(
            resolve_codex_cli_home(&deps(&[("CODEX_HOME", "/opt/codex")])),
            PathBuf::from("/opt/codex")
        );
    }

    fn platform_deps(platform: &str, home: &str, env: &[(&str, &str)]) -> DirResolverEnv {
        DirResolverEnv {
            platform: platform.into(),
            ..deps(env)
        }
        .with_home(home)
    }

    impl DirResolverEnv {
        fn with_home(mut self, home: &str) -> Self {
            self.home = home.into();
            self
        }
    }

    // The tests above pass platform names by hand; these take the one this
    // build really reports, which is what once failed to match any branch
    #[cfg(windows)]
    #[test]
    fn this_platform_takes_the_windows_branch() {
        let mut deps = DirResolverEnv::default();
        deps.env.remove("CCP_CONFIG_DIR");
        deps.env
            .insert("APPDATA".into(), r"C:\Users\u\AppData\Roaming".into());
        deps.env
            .insert("LOCALAPPDATA".into(), r"C:\Users\u\AppData\Local".into());
        assert_eq!(
            resolve_config_dir(&deps),
            PathBuf::from(r"C:\Users\u\AppData\Roaming\claude-code-proxy")
        );
        assert_eq!(
            resolve_state_dir(&deps),
            PathBuf::from(r"C:\Users\u\AppData\Local\claude-code-proxy")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_platform_takes_the_macos_branch() {
        let mut deps = DirResolverEnv::default().with_home("/Users/u");
        deps.env.remove("CCP_CONFIG_DIR");
        deps.env.insert("XDG_CONFIG_HOME".into(), "/x".into());
        assert_eq!(
            resolve_config_dir(&deps),
            PathBuf::from("/Users/u/.config/claude-code-proxy")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_platform_takes_the_xdg_branch() {
        let mut deps = DirResolverEnv::default();
        deps.env.remove("CCP_CONFIG_DIR");
        deps.env.insert("XDG_CONFIG_HOME".into(), "/x".into());
        assert_eq!(
            resolve_config_dir(&deps),
            PathBuf::from("/x/claude-code-proxy")
        );
    }

    #[test]
    fn pre_fix_config_file_points_windows_at_the_old_xdg_dir() {
        let deps = platform_deps(
            WINDOWS,
            r"C:\Users\u",
            &[("APPDATA", r"C:\Users\u\AppData\Roaming")],
        );
        let config_dir = resolve_config_dir(&deps);
        assert_eq!(
            pre_fix_config_file(&config_dir, &deps),
            Some(PathBuf::from(
                r"C:\Users\u/.config/claude-code-proxy/config.json"
            ))
        );
    }

    #[test]
    fn pre_fix_config_file_points_macos_at_xdg_config_home() {
        let deps = platform_deps(MACOS, "/Users/u", &[("XDG_CONFIG_HOME", "/x")]);
        let config_dir = resolve_config_dir(&deps);
        assert_eq!(
            pre_fix_config_file(&config_dir, &deps),
            Some(PathBuf::from("/x/claude-code-proxy/config.json"))
        );
        // Without XDG_CONFIG_HOME the old and new dirs are one: nothing to fall back to
        let deps = platform_deps(MACOS, "/Users/u", &[]);
        assert_eq!(pre_fix_config_file(&resolve_config_dir(&deps), &deps), None);
    }

    #[test]
    fn pre_fix_config_file_is_none_for_linux_overrides_and_other_dirs() {
        let deps = platform_deps("linux", "/home/me", &[]);
        assert_eq!(pre_fix_config_file(&resolve_config_dir(&deps), &deps), None);

        let deps = platform_deps(WINDOWS, r"C:\Users\u", &[("CCP_CONFIG_DIR", r"D:\ccp")]);
        assert_eq!(pre_fix_config_file(Path::new(r"D:\ccp"), &deps), None);

        let deps = platform_deps(WINDOWS, r"C:\Users\u", &[("APPDATA", r"C:\AppData")]);
        assert_eq!(pre_fix_config_file(Path::new(r"D:\elsewhere"), &deps), None);
    }

    #[test]
    fn codex_cli_home_defaults_to_dot_codex() {
        assert_eq!(
            resolve_codex_cli_home(&deps(&[])),
            PathBuf::from("/home/me/.codex")
        );
        assert_eq!(
            resolve_codex_cli_home(&deps(&[("CODEX_HOME", "")])),
            PathBuf::from("/home/me/.codex")
        );
    }
}
