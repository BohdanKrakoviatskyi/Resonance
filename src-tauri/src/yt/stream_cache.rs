use std::collections::HashMap;
use std::path::Path;

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
        if is_valid_video_id(&entry.video_id) && !entry.level_label.contains("WEB_REMIX") {
            if let Some(r) = entry.to_resolved(now_unix) {
                map.insert(entry.video_id, r);
            }
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
    if let Ok(serialized) = serde_json::to_string(&entries) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, serialized).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

pub fn parse_byte_range(header: Option<&str>) -> (u64, Option<u64>) {
    let Some(h) = header.and_then(|s| s.strip_prefix("bytes=")) else {
        return (0, None);
    };
    let Some((start_s, end_s)) = h.split_once('-') else {
        return (0, None);
    };
    let start = start_s.trim().parse::<u64>().unwrap_or(0);
    let end = end_s.trim().parse::<u64>().ok();
    (start, end)
}
