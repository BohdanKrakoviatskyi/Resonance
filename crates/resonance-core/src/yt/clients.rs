use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

const BUNDLED_CLIENTS_JSON: &str = include_str!("../../clients.json");
const REMOTE_CLIENTS_URL: &str =
    "https://raw.githubusercontent.com/BohdanKrakoviatskyi/Resonance/main/src-tauri/clients.json";
const REMOTE_CLIENTS_MAX_AGE_SECS: u64 = 12 * 3600;
const GATE_TTL: Duration = Duration::from_secs(30 * 60);
const FRESH_LINK_WINDOW: Duration = Duration::from_secs(5 * 60);
const STREAM_CACHE_TTL: Duration = Duration::from_secs(45 * 60);
const DISK_EXPIRE_SAFETY_MARGIN_SECS: u64 = 15 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientProfile {
    pub key: String,
    pub client_name: String,
    pub client_version: String,
    pub client_id: String,
    pub user_agent: String,
    #[serde(default)]
    pub os_name: Option<String>,
    #[serde(default)]
    pub os_version: Option<String>,
    #[serde(default)]
    pub device_make: Option<String>,
    #[serde(default)]
    pub device_model: Option<String>,
    #[serde(default)]
    pub android_sdk_version: Option<u32>,
    #[serde(default)]
    pub send_visitor_data: bool,
    #[serde(default)]
    pub send_cookie: bool,
    #[serde(default)]
    pub is_embedded: bool,
    #[serde(default = "default_hl")]
    pub hl: String,
    #[serde(default = "default_gl")]
    pub gl: String,
}

fn default_hl() -> String {
    "en".to_string()
}

fn default_gl() -> String {
    "US".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRegistry {
    #[serde(default)]
    pub schema_version: u32,
    pub stream_ladder: Vec<ClientProfile>,
    pub web_remix: ClientProfile,
    pub lyrics_timed: ClientProfile,
}

impl ClientProfile {
    pub fn context_value(&self, visitor_data: Option<&str>) -> Value {
        let mut client = json!({
            "clientName": self.client_name,
            "clientVersion": self.client_version,
            "hl": self.hl,
            "gl": self.gl,
        });
        if let Some(v) = &self.os_name {
            client["osName"] = json!(v);
        }
        if let Some(v) = &self.os_version {
            client["osVersion"] = json!(v);
        }
        if let Some(v) = &self.device_make {
            client["deviceMake"] = json!(v);
        }
        if let Some(v) = &self.device_model {
            client["deviceModel"] = json!(v);
        }
        if let Some(v) = self.android_sdk_version {
            client["androidSdkVersion"] = json!(v);
        }
        if self.send_visitor_data
            && let Some(vd) = visitor_data.filter(|s| !s.is_empty()) {
                client["visitorData"] = json!(vd);
            }
        json!({ "client": client })
    }
}

impl ClientRegistry {
    pub fn load() -> Self {
        let bundled: Self =
            serde_json::from_str(BUNDLED_CLIENTS_JSON).expect("bundled clients.json must be valid");
        let override_path = app_data_root_dir().join("clients.json");
        if let Ok(raw) = std::fs::read_to_string(&override_path)
            && let Some(parsed) = Self::parse_valid(&raw)
                && parsed.schema_version >= bundled.schema_version {
                    return parsed;
                }
        bundled
    }

    pub fn parse_valid(raw: &str) -> Option<Self> {
        let parsed = serde_json::from_str::<Self>(raw).ok()?;
        (!parsed.stream_ladder.is_empty()).then_some(parsed)
    }

    pub fn by_client_name(&self, name: &str) -> Option<&ClientProfile> {
        self.stream_ladder
            .iter()
            .chain([&self.web_remix, &self.lyrics_timed])
            .find(|c| c.client_name.eq_ignore_ascii_case(name) || c.key.eq_ignore_ascii_case(name))
    }

    pub fn user_agent_for_url(&self, url: &str, fallback_ua: &str) -> String {
        if let Some(c) = extract_query_param_str(url, "c") {
            if let Some(profile) = self.by_client_name(&c) {
                return profile.user_agent.clone();
            }
            if c.eq_ignore_ascii_case("TVHTML5") {
                return "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1".to_string();
            }
            if c.eq_ignore_ascii_case("WEB_EMBEDDED_PLAYER") || c.eq_ignore_ascii_case("WEB") {
                return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".to_string();
            }
        }
        fallback_ua.to_string()
    }
}

fn registry_cell() -> &'static RwLock<ClientRegistry> {
    static REG: OnceLock<RwLock<ClientRegistry>> = OnceLock::new();
    REG.get_or_init(|| RwLock::new(ClientRegistry::load()))
}

pub fn registry_snapshot() -> ClientRegistry {
    registry_cell()
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|e| e.into_inner().clone())
}

pub async fn refresh_remote_clients_if_stale(http: &Client) -> bool {
    let base = app_data_root_dir();
    let clients_path = base.join("clients.json");
    let stamp_path = base.join("clients_last_sync.txt");
    let now = now_unix_secs();

    if clients_path.is_file()
        && let Ok(raw) = std::fs::read_to_string(&stamp_path)
            && raw
                .trim()
                .parse::<u64>()
                .is_ok_and(|last| now.saturating_sub(last) < REMOTE_CLIENTS_MAX_AGE_SECS)
            {
                return false;
            }

    let _ = std::fs::write(&stamp_path, now.to_string());
    let Ok(resp) = tokio::time::timeout(Duration::from_secs(5), http.get(REMOTE_CLIENTS_URL).send()).await else {
        return false;
    };
    let Ok(resp) = resp.and_then(|r| r.error_for_status()) else {
        return false;
    };
    let Ok(body) = resp.text().await else {
        return false;
    };
    let Some(parsed) = ClientRegistry::parse_valid(&body) else {
        return false;
    };
    let bundled: ClientRegistry =
        serde_json::from_str(BUNDLED_CLIENTS_JSON).expect("bundled clients.json must be valid");
    if parsed.schema_version < bundled.schema_version {
        return false;
    }

    let tmp = clients_path.with_extension("json.tmp");
    if std::fs::write(&tmp, &body).is_ok() {
        let _ = std::fs::rename(tmp, &clients_path);
    }
    if let Ok(mut guard) = registry_cell().write() {
        *guard = parsed;
    }
    true
}

#[derive(Debug, Clone)]
pub struct ResolvedYtStream {
    pub direct_url: String,
    pub user_agent: String,
    pub extra_headers: HashMap<String, String>,
    pub mime_type: String,
    pub content_length: Option<u64>,
    pub itag: Option<u64>,
    pub lmt: Option<u64>,
    pub client_key: String,
    pub issued_at: Instant,
    pub expires_at: Instant,
    pub expire_unix: Option<u64>,
    pub ip_param: Option<String>,
    pub level_label: String,
}

impl ResolvedYtStream {
    pub fn is_expired(&self) -> bool {
        if Instant::now() >= self.expires_at {
            return true;
        }
        if let Some(exp_unix) = self.expire_unix {
            let now_unix = now_unix_secs();
            if now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS >= exp_unix {
                return true;
            }
        }
        false
    }

    pub fn link_age(&self) -> Duration {
        self.issued_at.elapsed()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedYtStreamEntry {
    pub video_id: String,
    pub direct_url: String,
    pub user_agent: String,
    pub extra_headers: HashMap<String, String>,
    pub mime_type: String,
    pub content_length: Option<u64>,
    #[serde(default)]
    pub itag: Option<u64>,
    #[serde(default)]
    pub lmt: Option<u64>,
    #[serde(default)]
    pub client_key: String,
    pub expire_unix: Option<u64>,
    pub saved_at_unix: u64,
    pub ip_param: Option<String>,
    pub level_label: String,
}

impl PersistedYtStreamEntry {
    pub fn from_resolved(video_id: &str, r: &ResolvedYtStream) -> Self {
        Self {
            video_id: video_id.to_string(),
            direct_url: r.direct_url.clone(),
            user_agent: r.user_agent.clone(),
            extra_headers: r.extra_headers.clone(),
            mime_type: r.mime_type.clone(),
            content_length: r.content_length,
            itag: r.itag,
            lmt: r.lmt,
            client_key: r.client_key.clone(),
            expire_unix: r.expire_unix,
            saved_at_unix: now_unix_secs(),
            ip_param: r.ip_param.clone(),
            level_label: r.level_label.clone(),
        }
    }

    pub fn to_resolved(&self, now_unix: u64) -> Option<ResolvedYtStream> {
        let remaining_secs = if let Some(exp) = self.expire_unix {
            if now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS >= exp {
                return None;
            }
            exp.saturating_sub(now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS)
        } else {
            let max_ttl = STREAM_CACHE_TTL.as_secs();
            let elapsed = now_unix.saturating_sub(self.saved_at_unix);
            if elapsed >= max_ttl {
                return None;
            }
            max_ttl - elapsed
        };

        let age = Duration::from_secs(now_unix.saturating_sub(self.saved_at_unix));
        Some(ResolvedYtStream {
            direct_url: self.direct_url.clone(),
            user_agent: self.user_agent.clone(),
            extra_headers: self.extra_headers.clone(),
            mime_type: self.mime_type.clone(),
            content_length: self.content_length,
            itag: self.itag.or_else(|| extract_query_param_u64(&self.direct_url, "itag")),
            lmt: self.lmt.or_else(|| extract_query_param_u64(&self.direct_url, "lmt")),
            client_key: if self.client_key.is_empty() {
                extract_query_param_str(&self.direct_url, "c").unwrap_or_default()
            } else {
                self.client_key.clone()
            },
            issued_at: Instant::now().checked_sub(age).unwrap_or_else(Instant::now),
            expires_at: Instant::now() + Duration::from_secs(remaining_secs),
            expire_unix: self.expire_unix,
            ip_param: self.ip_param.clone(),
            level_label: self.level_label.clone(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtResolveAttemptTiming {
    pub method: String,
    pub outcome: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtProxyStreamResponse {
    pub url: String,
    pub cache_hit: bool,
    pub resolve_ms: u64,
    pub attempts: Vec<YtResolveAttemptTiming>,
}

/// Remembers InnerTube clients recently refused by googlevideo or bot-walled by /player
/// so subsequent tracks skip dead unauthenticated clients for the gate TTL.
#[derive(Default)]
pub struct GateTracker {
    gates: Mutex<HashMap<String, Instant>>,
}

impl GateTracker {
    pub fn record_refusal(&self, client_key: &str, url: &str, link_age: Duration) {
        if client_key.is_empty() || link_age > FRESH_LINK_WINDOW {
            return;
        }
        if let Some(exp) = extract_query_param_u64(url, "expire")
            && exp <= now_unix_secs() {
                return;
            }
        if let Ok(mut map) = self.gates.lock() {
            map.insert(client_key.to_ascii_uppercase(), Instant::now() + GATE_TTL);
        }
    }

    pub fn record_player_gate(&self, client_key: &str, ttl: Duration) {
        if client_key.is_empty() {
            return;
        }
        if let Ok(mut map) = self.gates.lock() {
            map.insert(client_key.to_ascii_uppercase(), Instant::now() + ttl);
        }
    }

    pub fn is_gated(&self, client_key: &str) -> bool {
        let Ok(mut map) = self.gates.lock() else {
            return false;
        };
        let now = Instant::now();
        map.retain(|_, until| *until > now);
        map.contains_key(&client_key.to_ascii_uppercase())
    }

    pub fn clear(&self) {
        if let Ok(mut map) = self.gates.lock() {
            map.clear();
        }
    }

    pub fn ordered<'a>(&self, ladder: &'a [ClientProfile]) -> Vec<&'a ClientProfile> {
        let (open, gated): (Vec<_>, Vec<_>) =
            ladder.iter().partition(|c| !self.is_gated(&c.key));
        open.into_iter().chain(gated).collect()
    }

    pub fn open_only<'a>(&self, ladder: &'a [ClientProfile]) -> Vec<&'a ClientProfile> {
        ladder.iter().filter(|c| !self.is_gated(&c.key)).collect()
    }
}

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

pub fn app_data_root_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("Resonance");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".resonance");
    }
    std::env::temp_dir().join("Resonance")
}

pub fn user_app_support_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BSC_DATA_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("Resonance");
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Resonance");
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("Resonance");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("Resonance");
    }
    app_data_root_dir()
}

pub fn is_valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn extract_query_param_u64(raw_url: &str, key: &str) -> Option<u64> {
    extract_query_param_str(raw_url, key)?.parse::<u64>().ok()
}

pub fn extract_query_param_str(raw_url: &str, key: &str) -> Option<String> {
    let full = if raw_url.starts_with('/') {
        format!("http://localhost{raw_url}")
    } else {
        raw_url.to_string()
    };
    let parsed = Url::parse(&full).ok()?;
    for (k, v) in parsed.query_pairs() {
        if k == key {
            return Some(v.into_owned());
        }
    }
    None
}

pub fn expire_ttl(expire_unix: Option<u64>) -> Duration {
    let Some(exp) = expire_unix else {
        return STREAM_CACHE_TTL;
    };
    let now_unix = now_unix_secs();
    if exp > now_unix + DISK_EXPIRE_SAFETY_MARGIN_SECS + 60 {
        Duration::from_secs(exp - now_unix - DISK_EXPIRE_SAFETY_MARGIN_SECS)
    } else {
        Duration::from_secs(300)
    }
}
