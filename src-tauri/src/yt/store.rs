use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::clients::{app_data_root_dir, now_unix_secs};
use super::identity::{
    YtMusicProfile, delete_ytmusic_credentials, read_ytmusic_credentials, save_ytmusic_credentials,
};
use super::music_api::{YtMusicLibraryDto, fetch_account_profile, fetch_playlist_tracks_native, sync_library};
use super::music_parse::YtMusicPlaylistDto;
use super::proxy::YtStreamProxy;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtAuthStatusDto {
    pub authorized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<YtMusicProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtCacheClearDto {
    pub audio_files_deleted: usize,
    pub audio_bytes_freed: u64,
    pub stream_entries_cleared: usize,
}

#[derive(Clone)]
pub struct YtStore {
    // None when the database could not be opened or initialized; init_error
    // carries the reason so commands can report it instead of silently
    // losing every write.
    conn: Option<Arc<Mutex<Connection>>>,
    init_error: Option<String>,
}

impl Default for YtStore {
    fn default() -> Self {
        Self::new()
    }
}

impl YtStore {
    pub fn new() -> Self {
        let dir = app_data_root_dir();
        let _ = std::fs::create_dir_all(&dir);
        let db_path: PathBuf = dir.join("yt_music.db");
        let conn = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                return Self {
                    conn: None,
                    init_error: Some(format!("Could not open YouTube Music database: {e}")),
                };
            }
        };
        if let Err(e) = conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS kv_cache (
               key TEXT PRIMARY KEY,
               json TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );",
        ) {
            return Self {
                conn: None,
                init_error: Some(format!("Could not initialize YouTube Music database: {e}")),
            };
        }
        Self {
            conn: Some(Arc::new(Mutex::new(conn))),
            init_error: None,
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        let conn = self
            .conn
            .as_ref()
            .ok_or_else(|| self.init_error.clone().unwrap_or_else(|| "YouTube Music database unavailable".to_string()))?;
        conn.lock().map_err(|e| format!("YouTube Music database lock failed: {e}"))
    }

    pub fn get_json<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Result<Option<T>, String> {
        let guard = self.lock()?;
        let raw: Option<String> = guard
            .query_row("SELECT json FROM kv_cache WHERE key = ?1", params![key], |row| row.get(0))
            .ok();
        match raw {
            None => Ok(None),
            Some(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|e| format!("Could not parse cached YouTube Music data: {e}")),
        }
    }

    pub fn put_json<T: Serialize>(&self, key: &str, value: &T) -> Result<(), String> {
        let raw = serde_json::to_string(value)
            .map_err(|e| format!("Could not encode YouTube Music data: {e}"))?;
        let guard = self.lock()?;
        guard
            .execute(
                "INSERT INTO kv_cache (key, json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
                params![key, raw, now_unix_secs() as i64],
            )
            .map_err(|e| format!("Could not save YouTube Music data: {e}"))?;
        Ok(())
    }

    pub fn clear_prefix(&self, prefix: &str) -> Result<(), String> {
        let guard = self.lock()?;
        guard
            .execute("DELETE FROM kv_cache WHERE key LIKE ?1", params![format!("{prefix}%")])
            .map_err(|e| format!("Could not clear YouTube Music cache: {e}"))?;
        Ok(())
    }

    pub fn clear_all(&self) -> Result<(), String> {
        let guard = self.lock()?;
        guard
            .execute("DELETE FROM kv_cache", [])
            .map_err(|e| format!("Could not clear YouTube Music cache: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn yt_auth_status() -> Result<YtAuthStatusDto, String> {
    let creds = tokio::task::spawn_blocking(read_ytmusic_credentials)
        .await
        .ok()
        .flatten();
    Ok(match creds {
        Some(c) => YtAuthStatusDto {
            authorized: true,
            profile: c.profile,
        },
        None => YtAuthStatusDto {
            authorized: false,
            profile: None,
        },
    })
}

#[tauri::command]
pub async fn yt_auth_save(
    proxy: tauri::State<'_, YtStreamProxy>,
    headers: HashMap<String, String>,
) -> Result<YtAuthStatusDto, String> {
    let mut cookie = String::new();
    let mut auth_user = "0".to_string();
    for (k, v) in &headers {
        if k.eq_ignore_ascii_case("cookie") {
            cookie = v.trim().to_string();
        } else if k.eq_ignore_ascii_case("x-goog-authuser") && !v.trim().is_empty() {
            auth_user = v.trim().to_string();
        }
    }
    let profile = fetch_account_profile(&proxy.browse_http, &cookie, &auth_user).await?;
    let p_clone = profile.clone();
    tokio::task::spawn_blocking(move || save_ytmusic_credentials(&headers, &p_clone))
        .await
        .map_err(|e| e.to_string())??;
    Ok(YtAuthStatusDto {
        authorized: true,
        profile: Some(profile),
    })
}

#[tauri::command]
pub async fn yt_auth_logout(store: tauri::State<'_, YtStore>) -> Result<YtAuthStatusDto, String> {
    let s = store.inner().clone();
    tokio::task::spawn_blocking(move || {
        delete_ytmusic_credentials();
        s.clear_all()
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(YtAuthStatusDto {
        authorized: false,
        profile: None,
    })
}

#[tauri::command]
pub async fn yt_library_cached(store: tauri::State<'_, YtStore>) -> Result<Option<YtMusicLibraryDto>, String> {
    let s = store.inner().clone();
    tokio::task::spawn_blocking(move || s.get_json::<YtMusicLibraryDto>("library"))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn yt_library_sync(
    proxy: tauri::State<'_, YtStreamProxy>,
    store: tauri::State<'_, YtStore>,
) -> Result<YtMusicLibraryDto, String> {
    let lib = sync_library(&proxy.browse_http).await?;
    let s = store.inner().clone();
    let lib_clone = lib.clone();
    tokio::task::spawn_blocking(move || s.put_json("library", &lib_clone))
        .await
        .map_err(|e| e.to_string())??;
    Ok(lib)
}

#[tauri::command]
pub async fn yt_playlist_tracks_cached(
    store: tauri::State<'_, YtStore>,
    playlist_id: String,
) -> Result<Option<YtMusicPlaylistDto>, String> {
    let clean_id = playlist_id.trim().strip_prefix("VL").unwrap_or(playlist_id.trim()).to_string();
    let s = store.inner().clone();
    tokio::task::spawn_blocking(move || s.get_json::<YtMusicPlaylistDto>(&format!("pl:{clean_id}")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn yt_playlist_tracks_sync(
    proxy: tauri::State<'_, YtStreamProxy>,
    store: tauri::State<'_, YtStore>,
    playlist_id: String,
) -> Result<YtMusicPlaylistDto, String> {
    let pl = fetch_playlist_tracks_native(&proxy.browse_http, &playlist_id).await?;
    let key = format!("pl:{}", pl.playlist_id);
    let s = store.inner().clone();
    let pl_clone = pl.clone();
    tokio::task::spawn_blocking(move || s.put_json(&key, &pl_clone))
        .await
        .map_err(|e| e.to_string())??;
    Ok(pl)
}

#[tauri::command]
pub async fn yt_playlist_artwork(
    proxy: tauri::State<'_, YtStreamProxy>,
    store: tauri::State<'_, YtStore>,
    playlist_id: String,
) -> Result<Option<String>, String> {
    let clean_id = playlist_id.trim().strip_prefix("VL").unwrap_or(playlist_id.trim()).to_string();
    let s = store.inner().clone();
    let cached_art = tokio::task::spawn_blocking({
        let s = s.clone();
        let key = format!("pl:{clean_id}");
        move || s.get_json::<YtMusicPlaylistDto>(&key).map(|p| p.and_then(|pl| pl.artwork_url))
    })
    .await
    .map_err(|e| e.to_string())??;
    if cached_art.is_some() {
        return Ok(cached_art);
    }
    let pl = fetch_playlist_tracks_native(&proxy.browse_http, &clean_id).await?;
    let art = pl.artwork_url.clone();
    tokio::task::spawn_blocking(move || s.put_json(&format!("pl:{clean_id}"), &pl))
        .await
        .map_err(|e| e.to_string())??;
    Ok(art)
}

#[tauri::command]
pub async fn yt_clear_cache(
    proxy: tauri::State<'_, YtStreamProxy>,
    store: tauri::State<'_, YtStore>,
) -> Result<YtCacheClearDto, String> {
    let (audio_files_deleted, audio_bytes_freed, stream_entries_cleared) =
        proxy.clear_all_caches().await;
    let s = store.inner().clone();
    tokio::task::spawn_blocking(move || s.clear_prefix("pl:"))
        .await
        .map_err(|e| e.to_string())??;
    Ok(YtCacheClearDto {
        audio_files_deleted,
        audio_bytes_freed,
        stream_entries_cleared,
    })
}
