//! Offline downloads for YouTube Music tracks.
//!
//! A download is a full, un-ranged read of the track through the local relay, which already
//! writes complete streams to the disk cache; the finished file is then pinned so the cache
//! limit and "clear cache" never remove it.

use serde::Serialize;

use crate::yt::audio_cache::AudioCache;
use crate::yt::clients::is_valid_video_id;
use crate::yt::proxy::YtStreamProxy;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineItem {
    pub video_id: String,
    pub bytes: u64,
}

#[tauri::command]
pub async fn offline_download(proxy: tauri::State<'_, YtStreamProxy>, video_id: String) -> Result<u64, String> {
    download(&proxy, &video_id).await
}

pub async fn download(proxy: &YtStreamProxy, video_id: &str) -> Result<u64, String> {
    let id = video_id.trim().to_string();
    if !is_valid_video_id(&id) {
        return Err("Invalid track id.".into());
    }
    if let Some(bytes) = proxy.audio_cache.pin(&id) {
        return Ok(bytes);
    }
    // Make sure a stream URL is resolved, then pull the whole file through the relay.
    proxy.get_or_resolve_stream(&id, false, false, None).await?;
    let port = proxy.ensure_server_port().await?;
    let url = format!("http://127.0.0.1:{port}/yt-stream/{id}?t={}", proxy.token);
    let mut resp = reqwest::Client::new()
        .get(&url)
        .header("Origin", "tauri://localhost")
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status().as_u16()));
    }
    while resp.chunk().await.map_err(|e| format!("download interrupted: {e}"))?.is_some() {}
    // The relay finalizes the cache file right after the last byte; give the rename a moment.
    for _ in 0..20 {
        if let Some(bytes) = proxy.audio_cache.pin(&id) {
            return Ok(bytes);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("download did not complete".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn remove_deletes_the_cached_file() {
        let cache = crate::yt::audio_cache::AudioCache::new();
        let id = "offlinetest";
        let audio = cache.dir().join(format!("{id}.webm"));
        let done = cache.dir().join(format!("{id}.webm.done"));
        std::fs::write(&audio, vec![0u8; 128 * 1024]).unwrap();
        std::fs::write(&done, b"ok").unwrap();
        assert!(cache.pin(id).is_some());

        super::remove_cached(&cache, id);

        assert!(!audio.exists(), "audio bytes are deleted");
        assert!(!done.exists(), "done marker is deleted");
        assert!(!cache.dir().join(format!("{id}.pin")).exists(), "pin is deleted");
        assert!(!cache.pinned().iter().any(|(v, _)| v == id));
    }

    /// Network test against real YouTube: `cargo test --lib offline -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_download_pins_and_unpins() {
        let proxy = crate::yt::proxy::YtStreamProxy::new();
        let id = "jNQXAC9IVRw"; // "Me at the zoo", 19 s
        let bytes = tauri::async_runtime::block_on(super::download(&proxy, id)).expect("download");
        println!("downloaded {bytes} bytes");
        assert!(bytes > 64 * 1024);
        assert!(proxy.audio_cache.pinned().iter().any(|(v, _)| v == id));
        proxy.audio_cache.unpin(id);
        assert!(!proxy.audio_cache.pinned().iter().any(|(v, _)| v == id));
    }
}

#[tauri::command]
pub fn offline_remove(proxy: tauri::State<'_, YtStreamProxy>, video_id: String) {
    remove_cached(&proxy.audio_cache, video_id.trim());
}

/// Unpins a download and deletes its cached audio plus the `.done` marker, so the bytes leave the disk.
fn remove_cached(cache: &AudioCache, video_id: &str) {
    let path = cache.lookup_complete(video_id).map(|meta| meta.path);
    cache.unpin(video_id);
    if let Some(path) = path {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}.done", path.display()));
    }
}

#[tauri::command]
pub fn offline_list(proxy: tauri::State<'_, YtStreamProxy>) -> Vec<OfflineItem> {
    proxy.audio_cache.pinned().into_iter().map(|(video_id, bytes)| OfflineItem { video_id, bytes }).collect()
}
