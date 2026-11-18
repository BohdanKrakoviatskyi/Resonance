//! Local audio files: folder scanning, tag reading and an id → path registry.
//!
//! The HTTP relay serves only ids registered here, so the webview can never ask it for an
//! arbitrary path on disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;
use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::yt::proxy::YtStreamProxy;

pub const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "oga", "opus", "m4a", "aac", "webm"];
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    /// Seconds.
    pub duration: f64,
    pub has_cover: bool,
}

fn registry() -> &'static Mutex<HashMap<String, PathBuf>> {
    static R: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn lookup(id: &str) -> Option<PathBuf> {
    registry().lock().ok()?.get(id).cloned()
}

pub fn file_id(path: &Path) -> String {
    let mut h = Sha1::new();
    h.update(path.to_string_lossy().as_bytes());
    h.finalize().iter().take(10).map(|b| format!("{b:02x}")).collect()
}

pub fn is_valid_id(id: &str) -> bool {
    id.len() == 20 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("ogg" | "oga" | "opus") => "audio/ogg",
        Some("m4a" | "aac") => "audio/mp4",
        Some("webm") => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
}

fn collect(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            // Skip hidden folders (".git", "._resources" …).
            if !e.file_name().to_string_lossy().starts_with('.') {
                collect(&p, depth + 1, out);
            }
        } else if ft.is_file() && is_audio(&p) {
            out.push(p);
            if out.len() >= MAX_FILES {
                return;
            }
        }
    }
}

/// "Artist - Title.mp3" → (Some(artist), title); anything else → (None, stem).
pub fn split_file_name(stem: &str) -> (Option<String>, String) {
    // Strip a leading track number only when a separator follows it ("03 - x", "01. x"), never "2Pac".
    static NUM: OnceLock<regex::Regex> = OnceLock::new();
    // "03 Song" (zero-padded) or "3. Song" / "3 - Song" / "3_Song"; never "99 Problems".
    let num = NUM.get_or_init(|| regex::Regex::new(r"^(?:\d{1,3}\s*[.\-_)]\s*|0\d{1,2}\s+)").expect("track number pattern"));
    let cleaned = num.replace(stem, "");
    let base = if cleaned.trim().is_empty() { stem } else { cleaned.as_ref() };
    match base.split_once(" - ") {
        Some((a, t)) if !a.trim().is_empty() && !t.trim().is_empty() => (Some(a.trim().to_string()), t.trim().to_string()),
        _ => (None, base.trim().to_string()),
    }
}

fn read_track(path: &Path) -> LocalTrack {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let (file_artist, file_title) = split_file_name(&stem);
    let mut t = LocalTrack {
        id: file_id(path),
        path: path.to_string_lossy().into_owned(),
        title: file_title,
        artist: file_artist.unwrap_or_default(),
        album: None,
        duration: 0.0,
        has_cover: false,
    };
    if let Ok(tagged) = lofty::read_from_path(path) {
        t.duration = tagged.properties().duration().as_secs_f64();
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(v) = tag.title().filter(|s| !s.trim().is_empty()) {
                t.title = v.trim().to_string();
            }
            if let Some(v) = tag.artist().filter(|s| !s.trim().is_empty()) {
                t.artist = v.trim().to_string();
            }
            t.album = tag.album().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            t.has_cover = !tag.pictures().is_empty();
        }
    }
    if t.artist.is_empty() {
        // Fall back to the parent folder name ("Artist/Album/track.mp3" is a common layout).
        t.artist = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Unknown artist".into());
    }
    t
}

/// Embedded cover art (first picture) as (mime, bytes).
pub fn cover_bytes(path: &Path) -> Option<(String, Vec<u8>)> {
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let mime = pic.mime_type().map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".into());
    Some((mime, pic.data().to_vec()))
}

/// Scans folders, registers every file and returns their metadata. Blocking work runs off the async runtime.
#[tauri::command]
pub async fn local_scan(folders: Vec<String>) -> Result<Vec<LocalTrack>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        for f in &folders {
            let p = PathBuf::from(f);
            if p.is_dir() {
                collect(&p, 0, &mut files);
            }
        }
        let tracks: Vec<LocalTrack> = files.iter().map(|p| read_track(p)).collect();
        if let Ok(mut reg) = registry().lock() {
            reg.clear();
            for (t, p) in tracks.iter().zip(files) {
                reg.insert(t.id.clone(), p);
            }
        }
        tracks
    })
    .await
    .map_err(|e| e.to_string())
}

/// Base URL of the relay for local files: `{base}/local/{id}` and `{base}/local-cover/{id}`, plus `?t=` token.
#[tauri::command]
pub async fn local_base_url(proxy: tauri::State<'_, YtStreamProxy>) -> Result<(String, String), String> {
    let port = proxy.ensure_server_port().await?;
    Ok((format!("http://127.0.0.1:{port}"), proxy.token.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_artist_and_title_from_file_names() {
        assert_eq!(split_file_name("Daft Punk - One More Time"), (Some("Daft Punk".into()), "One More Time".into()));
        assert_eq!(split_file_name("03 - Song"), (None, "Song".into()));
        assert_eq!(split_file_name("01. Artist - Song"), (Some("Artist".into()), "Song".into()));
        assert_eq!(split_file_name("Plain"), (None, "Plain".into()));
        assert_eq!(split_file_name("2Pac - Changes"), (Some("2Pac".into()), "Changes".into()));
        assert_eq!(split_file_name("99 Problems"), (None, "99 Problems".into()));
        assert_eq!(split_file_name("07 Intro"), (None, "Intro".into()));
    }

    #[test]
    fn ids_are_stable_and_valid() {
        let a = file_id(Path::new("C:/Music/a.mp3"));
        assert_eq!(a, file_id(Path::new("C:/Music/a.mp3")));
        assert_ne!(a, file_id(Path::new("C:/Music/b.mp3")));
        assert!(is_valid_id(&a));
        assert!(!is_valid_id("../../etc/passwd"));
    }

    fn write_wav(path: &Path, seconds: u32) {
        let rate = 8000u32;
        let data_len = rate * seconds * 2;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&1u16.to_le_bytes()); // mono
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 2).to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        b.resize(b.len() + data_len as usize, 0);
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn scans_folder_reads_duration_and_registers_ids() {
        let dir = std::env::temp_dir().join(format!("resonance-local-test-{}", std::process::id()));
        let sub = dir.join("Album");
        let hidden = dir.join(".hidden");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(&hidden).unwrap();
        write_wav(&sub.join("01 - Some Artist - Song.wav"), 1);
        write_wav(&hidden.join("skip.wav"), 1);
        std::fs::write(sub.join("cover.jpg"), b"x").unwrap();

        let tracks = tauri::async_runtime::block_on(local_scan(vec![dir.to_string_lossy().into_owned()])).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(tracks.len(), 1, "hidden folders and non-audio files are skipped");
        let t = &tracks[0];
        assert_eq!(t.artist, "Some Artist");
        assert_eq!(t.title, "Song");
        assert!((t.duration - 1.0).abs() < 0.05, "duration {}", t.duration);
        assert!(!t.has_cover);
        assert!(lookup(&t.id).is_some());
    }

    #[test]
    fn filters_audio_extensions() {
        assert!(is_audio(Path::new("x.FLAC")));
        assert!(!is_audio(Path::new("cover.jpg")));
        assert_eq!(content_type(Path::new("a.m4a")), "audio/mp4");
    }
}
