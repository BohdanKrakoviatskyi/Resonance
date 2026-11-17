use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use super::clients::{app_data_root_dir, registry_snapshot, user_app_support_dir};

const VISITOR_ENDPOINT: &str = "https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false";
const VISITOR_MAX_AGE_MS: u64 = 7 * 24 * 3_600_000;
const REROLL_WINDOW_MS: u64 = 6 * 3_600_000;
const REROLL_LIMIT: usize = 2;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredVisitor {
    value: String,
    saved_at_ms: u64,
}

pub struct VisitorIdentity {
    current: RwLock<Option<StoredVisitor>>,
    mint_lock: tokio::sync::Mutex<()>,
    rerolls: Mutex<VecDeque<u64>>,
    path: PathBuf,
}

impl Default for VisitorIdentity {
    fn default() -> Self {
        Self::new()
    }
}

impl VisitorIdentity {
    pub fn new() -> Self {
        let path = app_data_root_dir().join("visitor_id.json");
        let now = now_ms();
        let saved = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoredVisitor>(&bytes).ok())
            .filter(|s| !s.value.is_empty() && is_fresh(s.saved_at_ms, now));
        Self {
            current: RwLock::new(saved),
            mint_lock: tokio::sync::Mutex::new(()),
            rerolls: Mutex::new(VecDeque::new()),
            path,
        }
    }

    pub fn current(&self) -> Option<String> {
        let now = now_ms();
        self.current
            .read()
            .ok()?
            .as_ref()
            .filter(|s| is_fresh(s.saved_at_ms, now))
            .map(|s| s.value.clone())
    }

    pub async fn ensure(&self, http: &Client) -> Option<String> {
        if let Some(v) = self.current() {
            return Some(v);
        }
        let _guard = self.mint_lock.lock().await;
        if let Some(v) = self.current() {
            return Some(v);
        }
        let minted = mint_visitor_data(http).await?;
        self.store(minted.clone());
        Some(minted)
    }

    pub async fn reroll(&self, http: &Client) -> Option<String> {
        let allowed = {
            let Ok(mut q) = self.rerolls.lock() else {
                return None;
            };
            let now = now_ms();
            while q.front().is_some_and(|&t| now.saturating_sub(t) >= REROLL_WINDOW_MS) {
                q.pop_front();
            }
            if q.len() >= REROLL_LIMIT {
                return None;
            }
            q.push_back(now);
            true
        };
        if !allowed {
            return None;
        }
        let _guard = self.mint_lock.lock().await;
        let minted = mint_visitor_data(http).await?;
        self.store(minted.clone());
        Some(minted)
    }

    fn store(&self, value: String) {
        let entry = StoredVisitor {
            value,
            saved_at_ms: now_ms(),
        };
        if let Ok(mut w) = self.current.write() {
            *w = Some(entry.clone());
        }
        if let Ok(raw) = serde_json::to_vec(&entry) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, raw).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}

async fn mint_visitor_data(http: &Client) -> Option<String> {
    if let Some(vd) = mint_visitor_from_sw_js_data(http).await {
        return Some(vd);
    }
    let reg = registry_snapshot();
    let profile = reg
        .stream_ladder
        .first()
        .unwrap_or(&reg.web_remix);
    let body = json!({
        "context": {
            "client": {
                "clientName": profile.client_name,
                "clientVersion": profile.client_version,
                "hl": "en",
                "gl": "US"
            }
        }
    });
    let resp = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        http.post(VISITOR_ENDPOINT)
            .header("Content-Type", "application/json")
            .header("User-Agent", &profile.user_agent)
            .json(&body)
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    let data: Value = resp.json().await.ok()?;
    data.pointer("/responseContext/visitorData")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

async fn mint_visitor_from_sw_js_data(http: &Client) -> Option<String> {
    let resp = tokio::time::timeout(
        std::time::Duration::from_millis(1200),
        http.get("https://www.youtube.com/sw.js_data")
            .header(
                "User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
            )
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    extract_visitor_token(&body)
}

fn extract_visitor_token(raw: &str) -> Option<String> {
    let mut rest = raw;
    while let Some(idx) = rest.find("Cgt") {
        let candidate_slice = &rest[idx..];
        let token: String = candidate_slice
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '=')
            .collect();
        if token.len() >= 23 && token.len() <= 128 {
            return Some(token);
        }
        rest = &candidate_slice[3..];
    }
    None
}

#[derive(Debug, Clone)]
pub struct YtMusicCredentials {
    pub cookie: String,
    pub auth_user: String,
    pub profile: Option<YtMusicProfile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtMusicProfile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub handle: String,
    #[serde(default)]
    pub picture: String,
}

#[derive(Debug, Deserialize)]
struct StoredAuthFile {
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    profile: Option<YtMusicProfile>,
}

pub fn credentials_path() -> PathBuf {
    user_app_support_dir().join("ytmusic-auth.json")
}

pub fn read_ytmusic_credentials() -> Option<YtMusicCredentials> {
    let mut candidates = vec![credentials_path(), app_data_root_dir().join("ytmusic-auth.json")];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            PathBuf::from(&home)
                .join("Library/Application Support/Resonance/ytmusic-auth.json"),
        );
        candidates.push(PathBuf::from(&home).join(".config/Resonance/ytmusic-auth.json"));
    }
    for path in candidates {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<StoredAuthFile>(&raw) else {
            continue;
        };
        let mut cookie = String::new();
        let mut auth_user = "0".to_string();
        for (k, v) in &parsed.headers {
            if k.eq_ignore_ascii_case("cookie") {
                cookie = v.trim().to_string();
            } else if k.eq_ignore_ascii_case("x-goog-authuser") && !v.trim().is_empty() {
                auth_user = v.trim().to_string();
            }
        }
        if extract_cookie_value(&cookie, "__Secure-3PAPISID").is_some() {
            return Some(YtMusicCredentials {
                cookie,
                auth_user,
                profile: parsed.profile,
            });
        }
    }
    None
}

pub fn save_ytmusic_credentials(
    headers: &HashMap<String, String>,
    profile: &YtMusicProfile,
) -> Result<(), String> {
    let mut cookie = String::new();
    let mut auth_user = "0".to_string();
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("cookie") {
            cookie = v.trim().to_string();
        } else if k.eq_ignore_ascii_case("x-goog-authuser") {
            let trimmed = v.trim();
            if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
                auth_user = trimmed.to_string();
            }
        }
    }
    let sapisid = extract_cookie_value(&cookie, "__Secure-3PAPISID")
        .ok_or_else(|| "YouTube Music session cookie is missing. Please reconnect.".to_string())?;
    let auth_header = compute_sapisidhash(&sapisid, "https://music.youtube.com");

    let mut normalized_headers = HashMap::new();
    normalized_headers.insert("Accept".to_string(), "*/*".to_string());
    normalized_headers.insert("Authorization".to_string(), auth_header);
    normalized_headers.insert("Content-Type".to_string(), "application/json".to_string());
    normalized_headers.insert("X-Goog-AuthUser".to_string(), auth_user);
    normalized_headers.insert("x-origin".to_string(), "https://music.youtube.com".to_string());
    normalized_headers.insert("Cookie".to_string(), cookie);

    let path = credentials_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create credentials directory: {e}"))?;
    }
    let payload = serde_json::json!({
        "headers": normalized_headers,
        "profile": profile,
    });
    let serialized =
        serde_json::to_string(&payload).map_err(|e| format!("Failed to encode auth: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serialized).map_err(|e| format!("Failed to save auth: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to commit auth file: {e}"))?;
    Ok(())
}

pub fn delete_ytmusic_credentials() {
    let _ = std::fs::remove_file(credentials_path());
}

pub fn extract_cookie_value(cookie_header: &str, name: &str) -> Option<String> {
    cookie_header.split(';').find_map(|part| {
        let (k, v) = part.trim().split_once('=')?;
        if k.trim().eq_ignore_ascii_case(name) {
            let val = v.trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
        None
    })
}

pub fn compute_sapisidhash(sapisid: &str, origin: &str) -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let input = format!("{ts} {sapisid} {origin}");
    let digest = Sha1::digest(input.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("SAPISIDHASH {ts}_{hex}")
}

fn is_fresh(saved_at_ms: u64, now: u64) -> bool {
    now >= saved_at_ms && now - saved_at_ms < VISITOR_MAX_AGE_MS
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
