use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::clients::{PersistedYtStreamEntry, ResolvedYtStream, is_valid_video_id, now_unix_secs};

const FLUSH_INTERVAL: Duration = Duration::from_secs(10);

/// A resolve elsewhere in the app must not rewrite the whole cache file, so writes go to one
/// worker thread that applies at most one save per `FLUSH_INTERVAL` and always converges on the
/// newest snapshot. The file keeps its plain JSON-array format.
enum SaveJob {
    Save(PathBuf, String),
    Clear(PathBuf),
}

fn saver_cell() -> &'static Mutex<Option<Sender<SaveJob>>> {
    static SAVER: OnceLock<Mutex<Option<Sender<SaveJob>>>> = OnceLock::new();
    SAVER.get_or_init(|| Mutex::new(None))
}

fn saver() -> Option<Sender<SaveJob>> {
    let mut guard = saver_cell().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = guard.as_ref() {
        return Some(tx.clone());
    }
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("yt-stream-cache".into())
        .spawn(move || save_worker(rx))
        .is_ok();
    if spawned {
        *guard = Some(tx.clone());
        Some(tx)
    } else {
        None
    }
}

fn apply(job: &SaveJob) {
    match job {
        SaveJob::Save(path, payload) => write_atomic(path, payload),
        SaveJob::Clear(path) => {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn save_worker(rx: Receiver<SaveJob>) {
    while let Ok(first) = rx.recv() {
        // Hold the first job, then keep only the newest arrival for FLUSH_INTERVAL, so a burst of
        // resolves costs one write instead of one per track. Order is preserved: the last one wins.
        let mut latest = first;
        let deadline = Instant::now() + FLUSH_INTERVAL;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(job) => latest = job,
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
            }
        }
        apply(&latest);
    }
}

fn write_atomic(path: &Path, payload: &str) {
    static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    if std::fs::write(&tmp, payload).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

pub fn load_persisted_stream_cache(path: &Path) -> HashMap<String, ResolvedYtStream> {
    let mut map = HashMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return map;
    };
    let Ok(entries) = serde_json::from_str::<Vec<PersistedYtStreamEntry>>(&raw) else {
        return map;
    };
    let now_unix = now_unix_secs();
    for entry in entries {
        if is_valid_video_id(&entry.video_id) && !entry.level_label.contains("WEB_REMIX")
            && let Some(r) = entry.to_resolved(now_unix) {
                map.insert(entry.video_id, r);
            }
    }
    map
}

pub fn save_persisted_stream_cache(path: &Path, cache: &HashMap<String, ResolvedYtStream>) {
    let now_unix = now_unix_secs();
    let entries: Vec<PersistedYtStreamEntry> = cache
        .iter()
        .filter(|(_, v)| !v.is_expired())
        .filter(|(_, v)| v.expire_unix.is_none_or(|exp| now_unix + 900 < exp))
        .map(|(k, v)| PersistedYtStreamEntry::from_resolved(k, v))
        .collect();
    let Ok(serialized) = serde_json::to_string(&entries) else {
        return;
    };
    match saver() {
        Some(tx) => {
            let _ = tx.send(SaveJob::Save(path.to_path_buf(), serialized));
        }
        None => write_atomic(path, &serialized),
    }
}

pub fn clear_persisted_stream_cache(path: &Path) {
    match saver() {
        Some(tx) => {
            let _ = tx.send(SaveJob::Clear(path.to_path_buf()));
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// `None` means the header cannot be honoured (suffix or unparsable range) and must be
/// answered with 416 instead of guessing a start offset.
pub fn parse_byte_range(header: Option<&str>) -> Option<(u64, Option<u64>)> {
    let Some(h) = header.and_then(|s| s.strip_prefix("bytes=")) else {
        return Some((0, None));
    };
    let Some((start_s, end_s)) = h.split_once('-') else {
        return Some((0, None));
    };
    let start_s = start_s.trim();
    if start_s.is_empty() {
        return None;
    }
    let Ok(start) = start_s.parse::<u64>() else {
        return Some((0, None));
    };
    Some((start, end_s.trim().parse::<u64>().ok()))
}

#[cfg(test)]
mod byte_range_tests {
    use super::parse_byte_range;

    #[test]
    fn rejects_suffix_ranges_instead_of_reading_them_as_zero() {
        assert_eq!(parse_byte_range(None), Some((0, None)));
        assert_eq!(parse_byte_range(Some("bytes=0-1023")), Some((0, Some(1023))));
        assert_eq!(parse_byte_range(Some("bytes=2097152-")), Some((2097152, None)));
        assert_eq!(parse_byte_range(Some("bytes=-65536")), None);
        assert_eq!(parse_byte_range(Some("bytes=garbage")), Some((0, None)));
    }
}
