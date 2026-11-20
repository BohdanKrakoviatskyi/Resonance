//! Last.fm desktop authorization, signed scrobbling API calls, and secure session storage.

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use tauri_plugin_opener::OpenerExt;

const API: &str = "https://ws.audioscrobbler.com/2.0/";
const API_KEY: &str = match option_env!("LASTFM_API_KEY") {
    Some(key) => key,
    None => "",
};
const API_SECRET: &str = match option_env!("LASTFM_API_SECRET") {
    Some(secret) => secret,
    None => "",
};

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

fn configured_api_key() -> Result<&'static str, String> {
    if API_KEY.is_empty() {
        Err("Last.fm API key is not configured for this build".into())
    } else {
        Ok(API_KEY)
    }
}

fn configured_secret() -> Result<&'static str, String> {
    if API_SECRET.is_empty() {
        Err("Last.fm signing secret is not configured for this build".into())
    } else {
        Ok(API_SECRET)
    }
}

async fn call(mut params: Vec<(String, String)>) -> Result<Value, String> {
    let sig = sign(&params, configured_secret()?);
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
        let msg = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("error");
        // 9 = invalid session: the user revoked access; drop our key so the UI asks to log in again.
        if code == 9 {
            let _ = clear_session().await;
        }
        return Err(format!("lastfm {code}: {msg}"));
    }
    Ok(body)
}

fn session_path() -> std::path::PathBuf {
    crate::yt::clients::user_app_support_dir().join("lastfm-session.json")
}

fn read_session_file(path: &Path) -> Option<LastfmSession> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_session_file(path: &Path, session: &LastfmSession) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".lastfm-session-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(&serde_json::to_vec(session).map_err(std::io::Error::other)?)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn delete_session_file(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Session files are read and written on a blocking thread: these run inside async commands, and
/// a per-track start must not pay for a disk read (or an fsync at login) on the executor.
async fn load_session() -> Option<LastfmSession> {
    let path = session_path();
    tokio::task::spawn_blocking(move || read_session_file(&path))
        .await
        .ok()
        .flatten()
}

async fn save_session(session: LastfmSession) -> Result<(), String> {
    let path = session_path();
    tokio::task::spawn_blocking(move || write_session_file(&path, &session))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

async fn clear_session() -> Result<(), String> {
    let path = session_path();
    tokio::task::spawn_blocking(move || delete_session_file(&path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

async fn session_key() -> Result<String, String> {
    load_session()
        .await
        .map(|s| s.key)
        .ok_or_else(|| "not logged in to Last.fm".to_string())
}

fn kv(k: &str, v: impl Into<String>) -> (String, String) {
    (k.to_string(), v.into())
}

fn authorization_url(api_key: &str, token: &str) -> Result<String, String> {
    let mut url = url::Url::parse("https://www.last.fm/api/auth/").map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("api_key", api_key)
        .append_pair("token", token);
    Ok(url.into())
}

fn parse_session(body: Value) -> Result<LastfmSession, String> {
    let session = body.get("session").ok_or("Last.fm returned no session")?;
    let name = session
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("Last.fm returned no username")?;
    let key = session
        .get("key")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("Last.fm returned no session key")?;
    Ok(LastfmSession {
        name: name.to_string(),
        key: key.to_string(),
    })
}

async fn fetch_authorized_session(token: &str) -> Result<LastfmSession, String> {
    let body = call(vec![
        kv("method", "auth.getSession"),
        kv("api_key", configured_api_key()?),
        kv("token", token),
    ])
    .await?;
    parse_session(body)
}

#[tauri::command]
pub async fn lastfm_login(app: tauri::AppHandle) -> Result<String, String> {
    configured_secret()?;
    let api_key = configured_api_key()?;
    let token_body = call(vec![kv("method", "auth.getToken"), kv("api_key", api_key)]).await?;
    let token = token_body
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("Last.fm returned no authorization token")?;
    app.opener()
        .open_url(authorization_url(api_key, token)?, None::<&str>)
        .map_err(|e| format!("could not open Last.fm in the default browser: {e}"))?;

    // Last.fm's desktop flow asks users to return to the app after granting access.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        match fetch_authorized_session(token).await {
            Ok(session) => {
                let name = session.name.clone();
                save_session(session).await?;
                return Ok(name);
            }
            Err(error)
                if error.contains("lastfm 14:") && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
            Err(error) if error.contains("lastfm 14:") => {
                return Err("Last.fm authorization timed out. Please try again.".into());
            }
            Err(error) => return Err(error),
        }
    }
}

#[tauri::command]
pub async fn lastfm_status() -> Option<String> {
    load_session().await.map(|s| s.name)
}

#[tauri::command]
pub async fn lastfm_logout() -> Result<(), String> {
    clear_session().await
}

#[tauri::command]
pub async fn lastfm_now_playing(item: ScrobbleItem) -> Result<(), String> {
    let mut p = vec![
        kv("method", "track.updateNowPlaying"),
        kv("api_key", configured_api_key()?),
        kv("sk", session_key().await?),
        kv("artist", item.artist),
        kv("track", item.track),
    ];
    if let Some(a) = item.album.filter(|a| !a.trim().is_empty()) {
        p.push(kv("album", a));
    }
    if let Some(d) = item.duration.filter(|d| *d > 0) {
        p.push(kv("duration", d.to_string()));
    }
    call(p).await.map(|_| ())
}

/// Submits up to 50 scrobbles in one batch (the API maximum). Returns how many were accepted.
#[tauri::command]
pub async fn lastfm_scrobble(items: Vec<ScrobbleItem>) -> Result<u32, String> {
    if items.is_empty() {
        return Ok(0);
    }
    let mut p = vec![
        kv("method", "track.scrobble"),
        kv("api_key", configured_api_key()?),
        kv("sk", session_key().await?),
    ];
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
    let body = call(p).await?;
    Ok(body
        .pointer("/scrobbles/@attr/accepted")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_use_owner_only_file_storage_for_all_builds() {
        let path =
            std::env::temp_dir().join(format!("resonance-lastfm-{}.json", uuid::Uuid::new_v4()));
        let session = LastfmSession {
            name: "test-user".into(),
            key: "test-key".into(),
        };

        write_session_file(&path, &session).unwrap();
        let loaded = read_session_file(&path).unwrap();
        assert_eq!(loaded.name, session.name);
        assert_eq!(loaded.key, session.key);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let updated = LastfmSession {
            name: "updated-user".into(),
            key: "updated-key".into(),
        };
        write_session_file(&path, &updated).unwrap();
        assert_eq!(read_session_file(&path).unwrap().key, updated.key);

        delete_session_file(&path).unwrap();
        assert!(read_session_file(&path).is_none());
    }

    #[test]
    fn configured_credentials_match_non_empty_build_environment_values() {
        let expected_key = option_env!("LASTFM_API_KEY").filter(|value| !value.is_empty());
        let expected_secret = option_env!("LASTFM_API_SECRET").filter(|value| !value.is_empty());

        assert_eq!(configured_api_key().ok(), expected_key);
        assert_eq!(configured_secret().ok(), expected_secret);
    }

    #[test]
    fn authorization_url_targets_lastfm_and_keeps_token_in_query() {
        let url = authorization_url("test-api-key", "token with spaces&symbols").unwrap();
        let url = url::Url::parse(&url).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("www.last.fm"));
        assert_eq!(url.path(), "/api/auth/");
        assert_eq!(
            query.get("api_key").map(String::as_str),
            Some("test-api-key")
        );
        assert_eq!(
            query.get("token").map(String::as_str),
            Some("token with spaces&symbols")
        );
    }

    #[test]
    fn session_response_requires_both_username_and_session_key() {
        let session = parse_session(serde_json::json!({
            "session": { "name": "resonance-user", "key": "session-key" }
        }))
        .unwrap();
        assert_eq!(session.name, "resonance-user");
        assert_eq!(session.key, "session-key");
        assert!(
            parse_session(serde_json::json!({ "session": { "name": "missing-key" } })).is_err()
        );
    }

    #[test]
    fn signs_sorted_params_with_secret() {
        let p = vec![
            kv("method", "auth.getSession"),
            kv("api_key", "k"),
            kv("token", "t"),
        ];
        // md5("api_keykmethodauth.getSessiontokents")
        let expected = hex(&Md5::digest(b"api_keykmethodauth.getSessiontokents"));
        assert_eq!(sign(&p, "s"), expected);
        assert_eq!(expected.len(), 32);
        // Known vector: md5("abc").
        assert_eq!(
            sign(&[kv("a", "b")], "c"),
            "900150983cd24fb0d6963f7d28e17f72"
        );
    }
}
