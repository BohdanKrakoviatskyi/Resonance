//! Last.fm scrobbling: signed API calls and session storage.
//!
//! The password is used once for `auth.getMobileSession` and never stored; the resulting
//! session key lives in the OS keyring. API key/secret come from the user's Last.fm API account.

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const API: &str = "https://ws.audioscrobbler.com/2.0/";
const KEYRING_SERVICE: &str = "com.resonance.lastfm";
const KEYRING_ACCOUNT: &str = "session";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastfmSession {
    pub name: String,
    pub key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleItem {
    pub artist: String,
    pub track: String,
    pub album: Option<String>,
    /// Seconds.
    pub duration: Option<u32>,
    /// Unix seconds when playback of the track started.
    pub timestamp: i64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Last.fm signature: md5 of all params sorted by name, concatenated as name+value, plus the secret.
pub fn sign(params: &[(String, String)], secret: &str) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut h = Md5::new();
    for (k, v) in sorted {
        h.update(k.as_bytes());
        h.update(v.as_bytes());
    }
    h.update(secret.as_bytes());
    hex(&h.finalize())
}

async fn call(mut params: Vec<(String, String)>, secret: &str) -> Result<Value, String> {
    let sig = sign(&params, secret);
    params.push(("api_sig".into(), sig));
    params.push(("format".into(), "json".into()));
    let res = reqwest::Client::new()
        .post(API)
        .form(&params)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let body: Value = res.json().await.map_err(|e| format!("bad response: {e}"))?;
    if let Some(code) = body.get("error").and_then(Value::as_i64) {
        let msg = body.get("message").and_then(Value::as_str).unwrap_or("error");
        // 9 = invalid session: the user revoked access; drop our key so the UI asks to log in again.
        if code == 9 {
            let _ = clear_session();
        }
        return Err(format!("lastfm {code}: {msg}"));
    }
    Ok(body)
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

fn load_session() -> Option<LastfmSession> {
    let raw = entry().ok()?.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

fn clear_session() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn session_key() -> Result<String, String> {
    load_session().map(|s| s.key).ok_or_else(|| "not logged in to Last.fm".to_string())
}

fn kv(k: &str, v: impl Into<String>) -> (String, String) {
    (k.to_string(), v.into())
}

#[tauri::command]
pub async fn lastfm_login(api_key: String, secret: String, username: String, password: String) -> Result<String, String> {
    let body = call(
        vec![kv("method", "auth.getMobileSession"), kv("api_key", api_key), kv("username", username), kv("password", password)],
        &secret,
    )
    .await?;
    let s = body.get("session").ok_or("no session in response")?;
    let session = LastfmSession {
        name: s.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        key: s.get("key").and_then(Value::as_str).ok_or("no session key")?.to_string(),
    };
    entry()?.set_password(&serde_json::to_string(&session).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(session.name)
}

#[tauri::command]
pub fn lastfm_status() -> Option<String> {
    load_session().map(|s| s.name)
}

#[tauri::command]
pub fn lastfm_logout() -> Result<(), String> {
    clear_session()
}

#[tauri::command]
pub async fn lastfm_now_playing(api_key: String, secret: String, item: ScrobbleItem) -> Result<(), String> {
    let mut p = vec![
        kv("method", "track.updateNowPlaying"),
        kv("api_key", api_key),
        kv("sk", session_key()?),
        kv("artist", item.artist),
        kv("track", item.track),
    ];
    if let Some(a) = item.album.filter(|a| !a.trim().is_empty()) {
        p.push(kv("album", a));
    }
    if let Some(d) = item.duration.filter(|d| *d > 0) {
        p.push(kv("duration", d.to_string()));
    }
    call(p, &secret).await.map(|_| ())
}

/// Submits up to 50 scrobbles in one batch (the API maximum). Returns how many were accepted.
#[tauri::command]
pub async fn lastfm_scrobble(api_key: String, secret: String, items: Vec<ScrobbleItem>) -> Result<u32, String> {
    if items.is_empty() {
        return Ok(0);
    }
    let mut p = vec![kv("method", "track.scrobble"), kv("api_key", api_key), kv("sk", session_key()?)];
    for (i, it) in items.into_iter().take(50).enumerate() {
        p.push(kv(&format!("artist[{i}]"), it.artist));
        p.push(kv(&format!("track[{i}]"), it.track));
        p.push(kv(&format!("timestamp[{i}]"), it.timestamp.to_string()));
        if let Some(a) = it.album.filter(|a| !a.trim().is_empty()) {
            p.push(kv(&format!("album[{i}]"), a));
        }
        if let Some(d) = it.duration.filter(|d| *d > 0) {
            p.push(kv(&format!("duration[{i}]"), d.to_string()));
        }
    }
    let body = call(p, &secret).await?;
    Ok(body
        .pointer("/scrobbles/@attr/accepted")
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_sorted_params_with_secret() {
        let p = vec![kv("method", "auth.getMobileSession"), kv("api_key", "k")];
        // md5("api_keykmethodauth.getMobileSessions")
        let expected = hex(&Md5::digest(b"api_keykmethodauth.getMobileSessions"));
        assert_eq!(sign(&p, "s"), expected);
        assert_eq!(expected.len(), 32);
        // Known vector: md5("abc").
        assert_eq!(sign(&[kv("a", "b")], "c"), "900150983cd24fb0d6963f7d28e17f72");
    }
}
