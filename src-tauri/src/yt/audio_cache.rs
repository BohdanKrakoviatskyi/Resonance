use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Notify, Semaphore};

use super::clients::{app_data_root_dir, is_valid_video_id};

const MAX_DISK_CACHE_BYTES: u64 = 3 << 30; // 3 GiB
const HEAD_PREFETCH_BYTES: u64 = 256 * 1024; // 256 KiB instant-start warm-up
const MAX_CONCURRENT_WRITES: usize = 3;

#[derive(Debug, Clone)]
pub struct CachedAudioMeta {
    pub path: PathBuf,
    pub total_bytes: u64,
    pub content_type: String,
}

pub struct ActiveCacheWrite {
    pub path: PathBuf,
    pub temp_path: PathBuf,
    pub total_bytes: u64,
    pub content_type: String,
    written: Mutex<u64>,
    finished: Mutex<Option<Result<(), String>>>,
    notify: Notify,
}

impl ActiveCacheWrite {
    pub fn written_bytes(&self) -> u64 {
        *self.written.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_done(&self) -> Option<Result<(), String>> {
        self.finished.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Progressive disk cache + 256 KiB memory head cache for instant playback and seeks.
pub struct AudioCache {
    dir: PathBuf,
    head_cache: Mutex<HashMap<String, (String, Vec<u8>, u64)>>,
    active: Mutex<HashMap<String, Arc<ActiveCacheWrite>>>,
    write_slots: Arc<Semaphore>,
}

impl AudioCache {
    pub fn new() -> Self {
        let dir = app_data_root_dir().join("yt-audio-cache");
        let _ = std::fs::create_dir_all(&dir);
        prune_orphans(&dir);
        Self {
            dir,
            head_cache: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            write_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_WRITES)),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn head_bytes(&self, video_id: &str) -> Option<(String, Vec<u8>, u64)> {
        let map = self.head_cache.lock().ok()?;
        map.get(video_id).cloned()
    }

    pub fn store_head_bytes(&self, video_id: &str, content_type: &str, bytes: &[u8], total: u64) {
        if bytes.is_empty() || bytes.len() > HEAD_PREFETCH_BYTES as usize * 2 {
            return;
        }
        if let Ok(mut map) = self.head_cache.lock() {
            if map.len() >= 32 && !map.contains_key(video_id)
                && let Some(k) = map.keys().next().cloned() {
                    map.remove(&k);
                }
            map.insert(
                video_id.to_string(),
                (content_type.to_string(), bytes.to_vec(), total),
            );
        }
    }

    pub fn lookup_complete(&self, video_id: &str) -> Option<CachedAudioMeta> {
        if !is_valid_video_id(video_id) {
            return None;
        }
        for (ext, mime) in [
            ("webm", "audio/webm"),
            ("m4a", "audio/mp4"),
            ("opus", "audio/webm"),
            ("mp3", "audio/mpeg"),
            ("ogg", "audio/ogg"),
        ] {
            let path = self.dir.join(format!("{video_id}.{ext}"));
            let done = self.dir.join(format!("{video_id}.{ext}.done"));
            if !done.is_file() {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&path)
                && meta.is_file() && meta.len() > 64 * 1024 {
                    touch_if_old(&path);
                    return Some(CachedAudioMeta {
                        path,
                        total_bytes: meta.len(),
                        content_type: mime.to_string(),
                    });
                }
        }
        None
    }

    pub fn register_full_download(
        &self,
        video_id: &str,
        content_type: &str,
        total_bytes: u64,
    ) -> Option<Arc<ActiveCacheWrite>> {
        if total_bytes == 0 || !is_valid_video_id(video_id) {
            return None;
        }
        if self.lookup_complete(video_id).is_some() {
            return None;
        }
        let Ok(mut active) = self.active.lock() else {
            return None;
        };
        if active.contains_key(video_id) {
            return None;
        }
        let ext = ext_for_mime(content_type);
        let path = self.dir.join(format!("{video_id}.{ext}"));
        let temp_path = self.dir.join(format!("{video_id}.{ext}.part"));
        let entry = Arc::new(ActiveCacheWrite {
            path,
            temp_path,
            total_bytes,
            content_type: content_type.to_string(),
            written: Mutex::new(0),
            finished: Mutex::new(None),
            notify: Notify::new(),
        });
        active.insert(video_id.to_string(), entry.clone());
        Some(entry)
    }

    pub async fn append_chunk(
        &self,
        video_id: &str,
        entry: &Arc<ActiveCacheWrite>,
        offset: u64,
        data: &[u8],
    ) {
        if offset == 0 && !data.is_empty() {
            let cap = data.len().min(HEAD_PREFETCH_BYTES as usize);
            self.store_head_bytes(video_id, &entry.content_type, &data[..cap], entry.total_bytes);
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&entry.temp_path)
            .await
            && file.seek(std::io::SeekFrom::Start(offset)).await.is_ok()
                && file.write_all(data).await.is_ok()
            {
                let end = offset + data.len() as u64;
                if let Ok(mut w) = entry.written.lock()
                    && end > *w {
                        *w = end;
                    }
                entry.notify.notify_waiters();
            }
    }

    pub async fn finalize_download(&self, video_id: &str, entry: &Arc<ActiveCacheWrite>, ok: bool) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(video_id);
        }
        let entry = entry.clone();
        let dir = self.dir.clone();
        let _ = tokio::task::spawn_blocking(move || finish_cache_write(&dir, &entry, ok)).await;
    }

    pub fn clear_all(&self) -> (usize, u64) {
        if let Ok(mut head) = self.head_cache.lock() {
            head.clear();
        }
        let mut deleted = 0usize;
        let mut bytes_freed = 0u64;
        let busy_ids: std::collections::HashSet<String> = self
            .active
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        if let Ok(entries) = std::fs::read_dir(&self.dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let id = name.split('.').next().unwrap_or("");
                if busy_ids.contains(id) || is_pinned(&self.dir, &name) {
                    continue;
                }
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                if std::fs::remove_file(e.path()).is_ok() {
                    deleted += 1;
                    bytes_freed += size;
                }
            }
        }
        (deleted, bytes_freed)
    }

    pub fn write_slots(&self) -> &Arc<Semaphore> {
        &self.write_slots
    }

    /// Marks a complete file as downloaded for offline use: never evicted, kept by "clear cache".
    pub fn pin(&self, video_id: &str) -> Option<u64> {
        let meta = self.lookup_complete(video_id)?;
        std::fs::write(self.dir.join(format!("{video_id}.pin")), b"1").ok()?;
        Some(meta.total_bytes)
    }

    pub fn unpin(&self, video_id: &str) {
        if is_valid_video_id(video_id) {
            let _ = std::fs::remove_file(self.dir.join(format!("{video_id}.pin")));
        }
    }

    /// Downloaded (pinned and complete) ids with their sizes.
    pub fn pinned(&self) -> Vec<(String, u64)> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let id = name.strip_suffix(".pin")?.to_string();
                let meta = self.lookup_complete(&id)?;
                Some((id, meta.total_bytes))
            })
            .collect()
    }
}

impl Default for AudioCache {
    fn default() -> Self {
        Self::new()
    }
}

fn is_pinned(dir: &Path, file_name: &str) -> bool {
    let id = file_name.split('.').next().unwrap_or("");
    !id.is_empty() && dir.join(format!("{id}.pin")).is_file()
}

pub fn ext_for_mime(mime: &str) -> &'static str {
    let lower = mime.to_ascii_lowercase();
    if lower.contains("mp4") || lower.contains("m4a") {
        "m4a"
    } else if lower.contains("ogg") {
        "ogg"
    } else if lower.contains("mpeg") || lower.contains("mp3") {
        "mp3"
    } else {
        "webm"
    }
}

fn touch_if_old(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path)
        && let Ok(mod_time) = meta.modified()
            && mod_time.elapsed().unwrap_or_default() >= Duration::from_secs(3600) {
                let _ = filetime_touch(path);
            }
}

fn filetime_touch(path: &Path) -> std::io::Result<()> {
    let f = std::fs::OpenOptions::new().write(true).open(path)?;
    f.set_modified(SystemTime::now())
}

fn prune_orphans(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".part") || name.ends_with(".meta") {
            let _ = std::fs::remove_file(&path);
        } else if name.ends_with(".done") {
            let main_path = PathBuf::from(name.trim_end_matches(".done"));
            if !dir.join(main_path).is_file() {
                let _ = std::fs::remove_file(&path);
            }
        } else if let Some(id) = name.strip_suffix(".pin") {
            // A pin without any finished file is stale.
            let has_file = ["webm", "m4a", "opus", "mp3", "ogg"].iter().any(|ext| dir.join(format!("{id}.{ext}.done")).is_file());
            if !has_file {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Blocking half of `AudioCache::finalize_download`: rename, `.done` marker, eviction.
fn finish_cache_write(dir: &Path, entry: &ActiveCacheWrite, ok: bool) {
    if ok
        && let Ok(meta) = std::fs::metadata(&entry.temp_path)
            && meta.len() >= entry.total_bytes && std::fs::rename(&entry.temp_path, &entry.path).is_ok() {
                let done = PathBuf::from(format!("{}.done", entry.path.display()));
                let _ = std::fs::write(done, b"ok");
                enforce_disk_limit(dir, MAX_DISK_CACHE_BYTES);
                if let Ok(mut f) = entry.finished.lock() {
                    *f = Some(Ok(()));
                }
                entry.notify.notify_waiters();
                return;
            }
    let _ = std::fs::remove_file(&entry.temp_path);
    if let Ok(mut f) = entry.finished.lock() {
        *f = Some(Err("incomplete".to_string()));
    }
    entry.notify.notify_waiters();
}

fn enforce_disk_limit(dir: &Path, max_bytes: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total = 0u64;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".part") || name.ends_with(".done") || name.ends_with(".meta") || name.ends_with(".pin") {
            continue;
        }
        // Offline downloads neither count toward nor get evicted by the cache limit.
        if is_pinned(dir, &name) {
            continue;
        }
        if let Ok(meta) = e.metadata()
            && meta.is_file() {
                let len = meta.len();
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                total += len;
                files.push((e.path(), len, mtime));
            }
    }
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(_, _, m)| *m);
    for (path, len, _) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            let done = PathBuf::from(format!("{}.done", path.display()));
            let _ = std::fs::remove_file(done);
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod pin_tests {
    use super::*;

    #[test]
    fn eviction_skips_pinned_downloads() {
        let dir = std::env::temp_dir().join(format!("resonance-cache-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("aaaaaaaaaaa.webm");
        let pinned = dir.join("bbbbbbbbbbb.webm");
        std::fs::write(&old, vec![0u8; 1000]).unwrap();
        std::fs::write(&pinned, vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join("aaaaaaaaaaa.webm.done"), b"ok").unwrap();
        std::fs::write(dir.join("bbbbbbbbbbb.webm.done"), b"ok").unwrap();
        std::fs::write(dir.join("bbbbbbbbbbb.pin"), b"1").unwrap();
        // Make the pinned file the oldest, so plain LRU would delete it first.
        let f = std::fs::OpenOptions::new().write(true).open(&pinned).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(10)).unwrap();
        drop(f);

        enforce_disk_limit(&dir, 500);
        let pinned_kept = pinned.is_file();
        let old_removed = !old.is_file();

        prune_orphans(&dir);
        let pin_kept = dir.join("bbbbbbbbbbb.pin").is_file();
        std::fs::remove_dir_all(&dir).ok();

        assert!(pinned_kept, "pinned file must survive eviction");
        assert!(old_removed, "unpinned file over the limit is evicted");
        assert!(pin_kept, "pin with a finished file is not an orphan");
    }
}
