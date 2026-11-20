use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use super::clients::{PersistedYtStreamEntry, ResolvedYtStream, is_valid_video_id, now_unix_secs};

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
    static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);
    let now_unix = now_unix_secs();
    let entries: Vec<PersistedYtStreamEntry> = cache
        .iter()
        .filter(|(_, v)| !v.is_expired())
        .filter(|(_, v)| v.expire_unix.is_none_or(|exp| now_unix + 900 < exp))
        .map(|(k, v)| PersistedYtStreamEntry::from_resolved(k, v))
        .collect();
    if let Ok(serialized) = serde_json::to_string(&entries) {
        let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
        if std::fs::write(&tmp, serialized).is_ok()
            && std::fs::rename(&tmp, path).is_err() {
                let _ = std::fs::remove_file(&tmp);
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
