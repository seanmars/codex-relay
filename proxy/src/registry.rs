use crate::{
    config::AliasProvider, provider::Provider,
    providers::codex::translate::model_allowlist::tier_model_variants,
};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

pub const ANTHROPIC_STYLE_ALIASES: &[&str] = &[
    "haiku",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "sonnet",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "opus",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "fable",
    "claude-fable-5",
];

pub(crate) const CODEX_MODELS: &[&str] = &[
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
];

pub struct Registry {
    alias_provider: AliasProvider,
    models: BTreeMap<String, Vec<String>>,
    handlers: BTreeMap<String, Arc<dyn Provider>>,
}

impl Registry {
    pub fn new(alias_provider: AliasProvider) -> Self {
        let mut models: BTreeMap<String, Vec<String>> = BTreeMap::new();
        models.insert("codex".into(), expand_codex_models());
        let mut handlers: BTreeMap<String, Arc<dyn Provider>> = BTreeMap::new();
        handlers.insert(
            "codex".into(),
            Arc::new(crate::providers::codex::CodexProvider::new()),
        );
        Self {
            alias_provider,
            models,
            handlers,
        }
    }

    pub fn with_default_alias() -> Self {
        Self::new(AliasProvider::Codex)
    }

    pub fn from_providers(
        alias_provider: AliasProvider,
        providers: impl IntoIterator<Item = Arc<dyn Provider>>,
    ) -> Self {
        let mut models = BTreeMap::new();
        let mut handlers = BTreeMap::new();
        for provider in providers {
            let name = provider.name().to_string();
            models.insert(name.clone(), provider.supported_models());
            handlers.insert(name, provider);
        }
        Self {
            alias_provider,
            models,
            handlers,
        }
    }

    pub fn list_provider_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.handlers.keys().cloned().collect();
        names.sort_unstable();
        names
    }

    pub fn provider(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.handlers.get(name).cloned()
    }

    pub fn supported_models_for(&self, provider: &str) -> Vec<String> {
        let mut models = self.models.get(provider).cloned().unwrap_or_default();
        if provider == self.alias_provider.as_str() {
            for alias in ANTHROPIC_STYLE_ALIASES {
                if !models.iter().any(|value| value == alias) {
                    models.push((*alias).to_string());
                }
            }
        }
        models.sort_unstable();
        models
    }

    pub fn all_supported_models(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for provider in self.handlers.keys() {
            for model in self.supported_models_for(provider) {
                out.push((model, provider.clone()));
            }
        }
        out
    }

    pub fn grouped_models(&self) -> BTreeMap<String, Vec<String>> {
        let mut out = BTreeMap::new();
        for provider in self.handlers.keys() {
            out.insert(provider.clone(), self.supported_models_for(provider));
        }
        out
    }

    pub fn provider_for_model(
        &self,
        raw_model: &str,
        session_affinity: Option<&AliasProvider>,
    ) -> Option<Arc<dyn Provider>> {
        let normalized = normalize_incoming_model(raw_model);
        if is_anthropic_alias(&normalized) {
            let target = session_affinity.unwrap_or(&self.alias_provider);
            return self.handlers.get(target.as_str()).cloned();
        }

        for (name, models) in &self.models {
            if models.iter().any(|candidate| candidate == &normalized) {
                return self.handlers.get(name).cloned();
            }
        }

        None
    }

    pub fn unknown_model_message(&self) -> String {
        let mut parts = Vec::new();
        for (provider, models) in self.grouped_models() {
            let mut models = models;
            models.sort_unstable();
            parts.push(format!("{}: {}", provider, models.join(", ")));
        }
        format!("Supported: {}.", parts.join("; "))
    }
}

pub fn normalize_incoming_model(model: &str) -> String {
    let suffix = "[1m]";
    if model.len() >= suffix.len() && model.to_ascii_lowercase().ends_with(suffix) {
        return model[..model.len() - suffix.len()].to_string();
    }
    model.to_string()
}

pub fn is_anthropic_alias(model: &str) -> bool {
    ANTHROPIC_STYLE_ALIASES.contains(&model)
}

fn expand_codex_models() -> Vec<String> {
    let mut set = HashSet::new();
    let mut out = Vec::new();
    for model in CODEX_MODELS {
        if set.insert((*model).to_string()) {
            out.push((*model).to_string());
        }
        for variant in tier_model_variants(model) {
            if set.insert(variant.clone()) {
                out.push(variant);
            }
        }
    }
    out.sort_unstable();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_model_trims_hint() {
        assert_eq!(normalize_incoming_model("gpt-5.4-fast[1m]"), "gpt-5.4-fast");
        assert_eq!(normalize_incoming_model("gpt-5.4-fast"), "gpt-5.4-fast");
    }

    #[test]
    fn ultrafast_variant_routes_to_codex_only_where_offered() {
        let registry = Registry::with_default_alias();
        for model in ["gpt-6-astra-ultrafast", "gpt-6.1-sol-ultrafast"] {
            assert_eq!(
                registry.provider_for_model(model, None).unwrap().name(),
                "codex"
            );
        }
        for model in ["gpt-6-sol-ultrafast", "gpt-6-luna-ultrafast"] {
            assert!(
                registry.provider_for_model(model, None).is_none(),
                "{model}"
            );
        }
    }

    #[test]
    fn claude_aliases_route_to_codex() {
        let registry = Registry::with_default_alias();
        for model in [
            "haiku",
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-fable-5",
        ] {
            let p = registry.provider_for_model(model, None);
            assert_eq!(p.expect("provider").name(), "codex", "{model}");
        }
    }

    #[test]
    fn unknown_models_route_nowhere() {
        let registry = Registry::with_default_alias();
        for model in ["grok-4.7", "kimi-k3", "cursor:gpt-5.5"] {
            assert!(
                registry.provider_for_model(model, None).is_none(),
                "{model}"
            );
        }
    }
}
