//! Native macOS WidgetKit bridge (see docs/macos-widget.md).
//!
//! The widget extension runs in a separate process and only reads data: the frontend
//! pushes the current track state through the `widget_update_now_playing` command, this
//! module atomically writes `now_playing.json` + `artwork.jpg` under
//! `~/Library/Application Support/Resonance/widget/` and asks WidgetKit to reload its
//! timelines via a tiny Swift bridge (macos-widget/reload-bridge). Everything
//! platform-specific is `#[cfg(target_os = "macos")]`; on other OSes the command is a
//! validated no-op so the frontend call can never break Windows/Linux builds.

use serde::{Deserialize, Serialize};

pub const PAYLOAD_VERSION: u32 = 1;

#[cfg(target_os = "macos")]
const WIDGET_DIR_SUFFIX: &str = "Library/Application Support/Resonance/widget";
/// The widget extension runs sandboxed; its own container is the one location it can
/// always read. The (unsandboxed) app mirrors the snapshot there — best effort.
#[cfg(target_os = "macos")]
const WIDGET_CONTAINER_SUFFIX: &str =
    "Library/Containers/com.resonance.app.widget/Data/Library/Application Support/Resonance/widget";
#[cfg(target_os = "macos")]
const JSON_FILE: &str = "now_playing.json";
#[cfg(target_os = "macos")]
pub const ARTWORK_FILE: &str = "artwork.jpg";
#[cfg(target_os = "macos")]
const MAX_ARTWORK_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT_LEN: usize = 512;

/// Payload sent by the frontend; serialized to the widget as `now_playing.json`
/// (camelCase keys, see the contract in docs/macos-widget.md).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingPayload {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub is_playing: bool,
    #[serde(default)]
    pub duration_sec: f64,
    #[serde(default)]
    pub position_sec: f64,
    #[serde(default)]
    pub updated_at: i64,
    /// JPEG (already downscaled by the frontend), base64-encoded. Sent only when the
    /// cover changes; the widget keeps reading the previously written `artwork.jpg`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork_base64: Option<String>,
    /// Accent color of the active M3 theme, `#RRGGBB`.
    #[serde(default)]
    pub accent_color: String,
}

fn default_version() -> u32 {
    PAYLOAD_VERSION
}

fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}

fn validate(payload: &NowPlayingPayload) -> Result<(), String> {
    if payload.version != PAYLOAD_VERSION {
        return Err(format!("unsupported widget payload version {}", payload.version));
    }
    if payload.title.len() > MAX_TEXT_LEN || payload.artist.len() > MAX_TEXT_LEN {
        return Err("widget payload text is too long".to_string());
    }
    if !payload.duration_sec.is_finite() || payload.duration_sec < 0.0 {
        return Err("widget payload durationSec must be a non-negative number".to_string());
    }
    if !payload.position_sec.is_finite() || payload.position_sec < 0.0 {
        return Err("widget payload positionSec must be a non-negative number".to_string());
    }
    if !payload.accent_color.is_empty() && !is_hex_color(&payload.accent_color) {
        return Err("widget payload accentColor must be #RRGGBB".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::path::{Path, PathBuf};

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct NowPlayingFile<'a> {
        version: u32,
        title: &'a str,
        artist: &'a str,
        is_playing: bool,
        duration_sec: f64,
        position_sec: f64,
        updated_at: i64,
        artwork_file: Option<&'a str>,
        accent_color: &'a str,
    }

    pub(super) fn update(payload: NowPlayingPayload) -> Result<(), String> {
        let mut changed = false;
        let dirs = widget_dirs();
        if dirs.is_empty() {
            return Err("HOME environment variable is not set".to_string());
        }
        // The primary dir must succeed; the container mirror is best effort (it may not
        // exist until the system first launches the widget).
        let (primary, mirrors) = dirs.split_first().expect("dirs is non-empty");
        changed |= write_now_playing(primary, &payload)?;
        for dir in mirrors {
            match write_now_playing(dir, &payload) {
                Ok(wrote) => changed |= wrote,
                Err(err) => log::warn!("widget container write skipped: {err}"),
            }
        }
        if changed {
            reload_widget_timelines();
        }
        Ok(())
    }

    /// Primary shared dir plus (best effort) the widget's own sandbox container.
    fn widget_dirs() -> Vec<PathBuf> {
        let home = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .map(PathBuf::from);
        match home {
            Some(home) => vec![
                home.join(WIDGET_DIR_SUFFIX),
                home.join(WIDGET_CONTAINER_SUFFIX),
            ],
            None => Vec::new(),
        }
    }

    /// Writes the JSON snapshot and (when provided) the artwork. Returns whether
    /// anything changed — unchanged content must not trigger a widget reload.
    pub(super) fn write_now_playing(dir: &Path, payload: &NowPlayingPayload) -> Result<bool, String> {
        validate(payload)?;
        std::fs::create_dir_all(dir).map_err(|e| format!("failed to create widget dir: {e}"))?;

        if let Some(artwork) = payload.artwork_base64.as_deref().filter(|a| !a.is_empty()) {
            write_artwork(dir, artwork)?;
        }
        let artwork_file = if dir.join(ARTWORK_FILE).exists() { Some(ARTWORK_FILE) } else { None };

        let file = NowPlayingFile {
            version: payload.version,
            title: &payload.title,
            artist: &payload.artist,
            is_playing: payload.is_playing,
            duration_sec: payload.duration_sec,
            position_sec: payload.position_sec,
            updated_at: payload.updated_at,
            artwork_file,
            accent_color: &payload.accent_color,
        };
        let json = serde_json::to_string(&file)
            .map_err(|e| format!("failed to serialize widget payload: {e}"))?;
        let path = dir.join(JSON_FILE);
        if std::fs::read_to_string(&path).is_ok_and(|prev| prev == json) {
            return Ok(false);
        }
        atomic_write(&path, json.as_bytes())?;
        Ok(true)
    }

    fn write_artwork(dir: &Path, base64_artwork: &str) -> Result<(), String> {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_artwork.trim())
            .map_err(|e| format!("invalid artwork base64: {e}"))?;
        if bytes.len() > MAX_ARTWORK_BYTES {
            return Err(format!("artwork is too large: {} bytes", bytes.len()));
        }
        if !is_jpeg(&bytes) {
            return Err("artwork must be a JPEG image".to_string());
        }
        let path = dir.join(ARTWORK_FILE);
        if std::fs::read(&path).is_ok_and(|prev| prev == bytes) {
            return Ok(());
        }
        atomic_write(&path, &bytes)
    }

    /// Temp file + rename, so the widget never observes a partially written file.
    fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, data).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("failed to move into {}: {e}", path.display())
        })
    }

    fn is_jpeg(bytes: &[u8]) -> bool {
        bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
    }

    #[cfg(not(resonance_no_swift_bridge))]
    unsafe extern "C" {
        fn resonance_widget_reload() -> i32;
    }

    /// Implemented in macos-widget/reload-bridge: WidgetCenter.shared.reloadAllTimelines().
    fn reload_widget_timelines() {
        #[cfg(not(resonance_no_swift_bridge))]
        {
            // SAFETY: the symbol is provided by the Swift static library linked in build.rs.
            let rc = unsafe { resonance_widget_reload() };
            if rc != 0 {
                log::warn!("widget timeline reload failed with code {rc}");
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub(super) fn update(payload: NowPlayingPayload) -> Result<(), String> {
        // No-op outside macOS, but still validate so the payload contract stays honest.
        validate(&payload)
    }
}

/// Called by the player store (debounced) on track/play/seek changes.
pub async fn widget_update_now_playing(payload: NowPlayingPayload) -> Result<(), String> {
    imp::update(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload() -> NowPlayingPayload {
        NowPlayingPayload {
            version: PAYLOAD_VERSION,
            title: "Song".to_string(),
            artist: "Artist".to_string(),
            is_playing: true,
            duration_sec: 215.0,
            position_sec: 42.0,
            updated_at: 1_731_744_000,
            artwork_base64: None,
            accent_color: "#6750A4".to_string(),
        }
    }

    #[test]
    fn payload_serializes_with_widget_contract() {
        let json = serde_json::to_string(&sample_payload()).expect("serialize payload");
        assert!(json.contains("\"version\":1"), "{json}");
        assert!(json.contains("\"title\":\"Song\""), "{json}");
        assert!(json.contains("\"isPlaying\":true"), "{json}");
        assert!(json.contains("\"durationSec\":215.0"), "{json}");
        assert!(json.contains("\"positionSec\":42.0"), "{json}");
        assert!(json.contains("\"updatedAt\":1731744000"), "{json}");
        assert!(json.contains("\"accentColor\":\"#6750A4\""), "{json}");
        assert!(!json.contains("artwork"), "{json}");
    }

    #[test]
    fn payload_deserializes_minimal_json() {
        let payload: NowPlayingPayload =
            serde_json::from_str(r##"{"title":"T","accentColor":"#ABCDEF"}"##).expect("deserialize payload");
        assert_eq!(payload.version, PAYLOAD_VERSION);
        assert!(!payload.is_playing);
        assert_eq!(payload.duration_sec, 0.0);
        assert_eq!(payload.artwork_base64, None);
    }

    #[test]
    fn validation_rejects_bad_payloads() {
        let mut p = sample_payload();
        p.version = 2;
        assert!(validate(&p).is_err());

        let mut p = sample_payload();
        p.accent_color = "6750A4".to_string();
        assert!(validate(&p).is_err());

        let mut p = sample_payload();
        p.duration_sec = -1.0;
        assert!(validate(&p).is_err());

        let mut p = sample_payload();
        p.position_sec = f64::NAN;
        assert!(validate(&p).is_err());

        let mut p = sample_payload();
        p.title = "x".repeat(MAX_TEXT_LEN + 1);
        assert!(validate(&p).is_err());

        assert!(validate(&sample_payload()).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn writes_json_and_artwork_and_skips_unchanged() {
        use base64::Engine as _;

        let dir = std::env::temp_dir().join(format!("resonance-widget-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x10, 0x20, 0x30];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        let mut payload = sample_payload();
        payload.artwork_base64 = Some(encoded);

        assert!(matches!(imp::write_now_playing(&dir, &payload), Ok(true)));
        let json = std::fs::read_to_string(dir.join("now_playing.json")).expect("json written");
        assert!(json.contains("\"artworkFile\":\"artwork.jpg\""), "{json}");
        assert_eq!(std::fs::read(dir.join("artwork.jpg")).expect("artwork written"), jpeg);
        assert!(!dir.join("now_playing.tmp").exists(), "no temp file leftovers");

        // Identical payload must not report a change (no widget reload).
        assert!(matches!(imp::write_now_playing(&dir, &payload), Ok(false)));

        // Without artwork bytes the previously written file is still referenced.
        payload.artwork_base64 = None;
        payload.position_sec = 43.0;
        assert!(matches!(imp::write_now_playing(&dir, &payload), Ok(true)));
        let json = std::fs::read_to_string(dir.join("now_playing.json")).expect("json rewritten");
        assert!(json.contains("\"artworkFile\":\"artwork.jpg\""), "{json}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_non_jpeg_artwork() {
        use base64::Engine as _;

        let dir = std::env::temp_dir().join(format!("resonance-widget-test-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create dir");

        let png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
        let mut payload = sample_payload();
        payload.artwork_base64 = Some(encoded);
        assert!(imp::write_now_playing(&dir, &payload).is_err());
        assert!(!dir.join("artwork.jpg").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
