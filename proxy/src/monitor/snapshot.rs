//! Immutable dashboard read models. Process-local clocks and mutable accounting
//! stay in the monitor store; viewers receive elapsed durations and computed rates.
use super::{
    ActiveRequest, CompletedRequest, EndpointKind, MonitorState, RequestStatus, SessionSummary,
    Throughput,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime},
};

pub const PROTOCOL_VERSION: u32 = 1;

fn default_snapshot_at() -> SystemTime {
    SystemTime::now()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorResponse {
    pub version: u32,
    pub snapshot: MonitorSnapshot,
}

impl From<MonitorState> for MonitorResponse {
    fn from(state: MonitorState) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            snapshot: state.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum SnapshotUpdate {
    Live(MonitorSnapshot),
    Disconnected {
        snapshot: MonitorSnapshot,
        error: String,
    },
}

impl SnapshotUpdate {
    pub fn snapshot(&self) -> &MonitorSnapshot {
        match self {
            Self::Live(snapshot) | Self::Disconnected { snapshot, .. } => snapshot,
        }
    }

    pub fn connection_error(&self) -> Option<&str> {
        match self {
            Self::Live(_) => None,
            Self::Disconnected { error, .. } => Some(error),
        }
    }

    pub(super) fn updated(self, result: Result<MonitorSnapshot, String>) -> Self {
        match result {
            Ok(snapshot) => Self::Live(snapshot),
            Err(error) => {
                let snapshot = match self {
                    Self::Live(snapshot) | Self::Disconnected { snapshot, .. } => snapshot,
                };
                Self::Disconnected { snapshot, error }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorSnapshot {
    pub started_at: SystemTime,
    #[serde(default = "default_snapshot_at")]
    pub snapshot_at: SystemTime,
    pub uptime: Duration,
    pub sessions: Vec<SessionSnapshot>,
    pub active: Vec<ActiveSnapshot>,
    pub recent: Vec<CompletedSnapshot>,
}

impl From<MonitorState> for MonitorSnapshot {
    fn from(state: MonitorState) -> Self {
        Self {
            started_at: state.started_at,
            snapshot_at: SystemTime::now(),
            uptime: state.uptime,
            sessions: state.sessions.into_iter().map(Into::into).collect(),
            active: state.active.into_iter().map(Into::into).collect(),
            recent: state.recent.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveSnapshot {
    pub request_id: String,
    pub session_id: Option<String>,
    pub session_seq: Option<u64>,
    pub project: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub requested_model: Option<String>,
    pub resolved_model: Option<String>,
    pub effort: Option<String>,
    pub endpoint: EndpointKind,
    pub started_at: SystemTime,
    pub generation_started_at: Option<SystemTime>,
    pub generation_finished_at: Option<SystemTime>,
    pub generation_duration: Option<Duration>,
    pub status: RequestStatus,
    pub streamed_bytes: u64,
    pub stream_chunks: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub error: Option<String>,
    pub traffic_capture_path: Option<PathBuf>,
    elapsed: Duration,
    throughput: Throughput,
}

impl ActiveSnapshot {
    pub fn elapsed(&self) -> Duration {
        self.elapsed
    }
    pub fn rate(&self) -> Throughput {
        self.throughput.clone()
    }
}

impl From<ActiveRequest> for ActiveSnapshot {
    fn from(value: ActiveRequest) -> Self {
        let throughput = value.rate();
        let elapsed = value.elapsed();
        Self {
            request_id: value.request_id,
            session_id: value.session_id,
            session_seq: value.session_seq,
            project: value.project,
            provider: value.provider,
            model: value.model,
            requested_model: value.requested_model,
            resolved_model: value.resolved_model,
            effort: value.effort,
            endpoint: value.endpoint,
            started_at: value.started_at,
            generation_started_at: value.generation_started_at,
            generation_finished_at: value.generation_finished_at,
            generation_duration: value.generation_duration,
            status: value.status,
            streamed_bytes: value.streamed_bytes,
            stream_chunks: value.stream_chunks,
            input_tokens: value.input_tokens,
            output_tokens: value.output_tokens,
            error: value.error,
            traffic_capture_path: value.traffic_capture_path,
            elapsed,
            throughput,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompletedSnapshot {
    pub request_id: String,
    pub session_id: Option<String>,
    pub session_seq: Option<u64>,
    pub project: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub requested_model: Option<String>,
    pub resolved_model: Option<String>,
    pub effort: Option<String>,
    pub endpoint: EndpointKind,
    pub started_at: SystemTime,
    pub generation_started_at: Option<SystemTime>,
    pub generation_finished_at: Option<SystemTime>,
    pub generation_duration: Option<Duration>,
    pub status: RequestStatus,
    pub streamed_bytes: u64,
    pub stream_chunks: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub error: Option<String>,
    pub traffic_capture_path: Option<PathBuf>,
    pub finished_at: SystemTime,
    pub http_status: Option<u16>,
    pub latency: Duration,
    throughput: Throughput,
}

impl CompletedSnapshot {
    pub fn rate(&self) -> Throughput {
        self.throughput.clone()
    }
}

impl From<CompletedRequest> for CompletedSnapshot {
    fn from(value: CompletedRequest) -> Self {
        let throughput = value.rate();
        Self {
            request_id: value.request_id,
            session_id: value.session_id,
            session_seq: value.session_seq,
            project: value.project,
            provider: value.provider,
            model: value.model,
            requested_model: value.requested_model,
            resolved_model: value.resolved_model,
            effort: value.effort,
            endpoint: value.endpoint,
            started_at: value.started_at,
            generation_started_at: value.generation_started_at,
            generation_finished_at: value.generation_finished_at,
            generation_duration: value.generation_duration,
            status: value.status,
            streamed_bytes: value.streamed_bytes,
            stream_chunks: value.stream_chunks,
            input_tokens: value.input_tokens,
            output_tokens: value.output_tokens,
            error: value.error,
            traffic_capture_path: value.traffic_capture_path,
            finished_at: value.finished_at,
            http_status: value.http_status,
            latency: value.latency,
            throughput,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub session_id: Option<String>,
    pub project: Option<String>,
    pub active_count: usize,
    pub request_count: usize,
    pub failure_count: usize,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub requested_model: Option<String>,
    pub resolved_model: Option<String>,
    pub effort: Option<String>,
    pub last_seen: SystemTime,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub output_token_samples: Vec<(SystemTime, u64)>,
    pub generation_duration: Duration,
    pub last_status: String,
    throughput: Throughput,
}

impl SessionSnapshot {
    pub fn rate(&self) -> Throughput {
        self.throughput.clone()
    }
}

impl From<SessionSummary> for SessionSnapshot {
    fn from(value: SessionSummary) -> Self {
        let throughput = value.rate();
        Self {
            session_id: value.session_id,
            project: value.project,
            active_count: value.active_count,
            request_count: value.request_count,
            failure_count: value.failure_count,
            provider: value.provider,
            model: value.model,
            requested_model: value.requested_model,
            resolved_model: value.resolved_model,
            effort: value.effort,
            last_seen: value.last_seen,
            input_tokens: value.input_tokens,
            output_tokens: value.output_tokens,
            output_token_samples: value.output_token_samples,
            generation_duration: value.generation_duration,
            last_status: value.last_status,
            throughput,
        }
    }
}

impl SessionSnapshot {
    pub fn label(&self) -> String {
        self.session_id
            .clone()
            .unwrap_or_else(|| "no-session".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::MonitorHandle;

    #[test]
    fn snapshot_round_trip_preserves_accounting_without_process_clocks() {
        let monitor = MonitorHandle::default();
        monitor.request_started(
            "active",
            Some("session".into()),
            Some(2),
            EndpointKind::Messages,
        );
        monitor.provider_selected("active", "codex", "gpt-6-astra", Some("high".into()));
        monitor.stream_progress("active", 40, 1, Some(8), Some(3));
        monitor.request_started(
            "done",
            Some("session".into()),
            Some(1),
            EndpointKind::CountTokens,
        );
        monitor.request_completed("done", 200, Some(11), None);
        let snapshot = MonitorSnapshot::from(monitor.snapshot());
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("instant"));
        let decoded: MonitorSnapshot = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, snapshot);
        assert_eq!(decoded.snapshot_at, snapshot.snapshot_at);
        assert_eq!(decoded.uptime, snapshot.uptime);
        assert_eq!(decoded.active[0].elapsed(), snapshot.active[0].elapsed());
        assert_eq!(decoded.active[0].rate(), snapshot.active[0].rate());
        assert_eq!(decoded.sessions[0].rate(), snapshot.sessions[0].rate());
        assert_eq!(decoded.recent[0].http_status, Some(200));
    }

    // The status line hook reads these fields through the relay; the relay and hook tests import the same file
    const MODEL_CONTRACT: &str = include_str!("../../tests/fixtures/model-contract.mjs");

    // Every field the fixture names must be in `actual` with the same value; other fields are free
    fn assert_json_subset(expected: &serde_json::Value, actual: &serde_json::Value, path: &str) {
        match expected {
            serde_json::Value::Object(fields) => {
                for (key, value) in fields {
                    let field = actual
                        .get(key)
                        .unwrap_or_else(|| panic!("{path}.{key} is missing in {actual}"));
                    assert_json_subset(value, field, &format!("{path}.{key}"));
                }
            }
            serde_json::Value::Array(items) => {
                let actual_items = actual
                    .as_array()
                    .unwrap_or_else(|| panic!("{path} is not an array"));
                assert_eq!(actual_items.len(), items.len(), "{path} length");
                for (index, (item, actual_item)) in items.iter().zip(actual_items).enumerate() {
                    assert_json_subset(item, actual_item, &format!("{path}[{index}]"));
                }
            }
            _ => assert_eq!(actual, expected, "{path}"),
        }
    }

    #[test]
    fn monitor_response_names_requested_and_resolved_model_separately() {
        let monitor = MonitorHandle::default();
        monitor.request_started(
            "r-contract",
            Some("sid-contract".into()),
            Some(1),
            EndpointKind::Messages,
        );
        monitor.provider_selected("r-contract", "codex", "opus", None);
        monitor.model_resolved("r-contract", "gpt-6-sol");

        let actual = serde_json::to_value(MonitorResponse::from(monitor.snapshot())).unwrap();
        let (_, contract) = MODEL_CONTRACT.split_once("export default").unwrap();
        let contract: serde_json::Value = serde_json::from_str(contract).unwrap();

        assert_json_subset(&contract["monitor"], &actual, "$");
    }

    #[test]
    fn snapshot_deserialization_accepts_legacy_and_newer_fields() {
        let snapshot: MonitorSnapshot = MonitorHandle::default().snapshot().into();
        let mut legacy = serde_json::to_value(&snapshot).unwrap();
        legacy.as_object_mut().unwrap().remove("snapshot_at");
        let decoded: MonitorSnapshot = serde_json::from_value(legacy).unwrap();
        assert!(decoded.snapshot_at >= snapshot.started_at);

        let mut newer = serde_json::to_value(&snapshot).unwrap();
        newer
            .as_object_mut()
            .unwrap()
            .insert("future_field".into(), serde_json::json!(true));
        let decoded: MonitorSnapshot = serde_json::from_value(newer).unwrap();
        assert_eq!(decoded.snapshot_at, snapshot.snapshot_at);
    }

    #[test]
    fn session_from_a_proxy_without_model_fields_decodes_them_as_absent() {
        let monitor = MonitorHandle::default();
        monitor.request_started("r1", Some("s1".into()), None, EndpointKind::Messages);
        monitor.provider_selected("r1", "codex", "opus", None);
        let mut legacy = serde_json::to_value(MonitorSnapshot::from(monitor.snapshot())).unwrap();
        for list in ["sessions", "active"] {
            let entry = legacy[list][0].as_object_mut().unwrap();
            entry.remove("requested_model");
            entry.remove("resolved_model");
        }

        let decoded: MonitorSnapshot = serde_json::from_value(legacy).unwrap();

        assert_eq!(decoded.sessions[0].model.as_deref(), Some("opus"));
        assert_eq!(decoded.sessions[0].requested_model, None);
        assert_eq!(decoded.active[0].resolved_model, None);
    }
}
