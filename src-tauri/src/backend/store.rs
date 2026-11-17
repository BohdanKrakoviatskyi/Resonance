//! Persistence for the native backend: data directory (with the one-time migration from the
//! pre-rename app), atomic secret files, input validators and the loaded `State`.
//!
//! The file layout is byte-compatible with what the Go sidecar wrote (`settings.json`,
//! `auth.json`, `history.json`, `frontend-state.json`), so an existing profile keeps working.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::GeneralPurpose;
use base64::engine::general_purpose::GeneralPurposeConfig;
use serde::Serialize;

use super::types::{APP_NAME, AuthState, Settings, TrackCard};

/// Where the app kept its files before the rename to Resonance. Only the migration reads it.
const LEGACY_APP_NAME: &str = "BetterSoundCloud";
pub const MAX_RECENT_TRACKS: usize = 20;

#[derive(Debug, Default)]
pub struct State {
    pub settings: Settings,
    pub auth: AuthState,
    pub history: Vec<TrackCard>,
    pub frontend_backup: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct Paths {
    pub settings: PathBuf,
    pub auth: PathBuf,
    pub history: PathBuf,
    pub frontend_backup: PathBuf,
}

impl Paths {
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            settings: dir.join("settings.json"),
            auth: dir.join("auth.json"),
            history: dir.join("history.json"),
            frontend_backup: dir.join("frontend-state.json"),
        }
    }
}

// ---- data directory ---------------------------------------------------------------------------

fn user_config_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| "%AppData% is not defined".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(|home| PathBuf::from(home).join("Library").join("Application Support"))
            .ok_or_else(|| "$HOME is not defined".to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            return Ok(PathBuf::from(xdg));
        }
        std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(|home| PathBuf::from(home).join(".config"))
            .ok_or_else(|| "neither $XDG_CONFIG_HOME nor $HOME are defined".to_string())
    }
}

pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("BSC_DATA_DIR") {
        if !configured.is_empty() {
            return Ok(PathBuf::from(configured));
        }
    }
    let config = user_config_dir()?;
    Ok(migrate_legacy_data_dir(config.join(APP_NAME), &config.join(LEGACY_APP_NAME)))
}

/// Copies the previous app name's files across, once. Each file is copied only when the new
/// location lacks it, so an interrupted run resumes and a migrated profile pays nothing. The old
/// directory is left in place (deleting it is the one irreversible step, and not worth taking).
/// Failures are logged and swallowed: a migration problem must not stop the app from starting.
fn migrate_legacy_data_dir(dir: PathBuf, legacy: &Path) -> PathBuf {
    let Ok(entries) = std::fs::read_dir(legacy) else {
        return dir;
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("data_dir stage=migrate_mkdir_failed dir={dir:?} error={e}");
        return dir;
    }
    let mut moved = 0;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            continue;
        }
        let target = dir.join(entry.file_name());
        if target.exists() {
            continue;
        }
        match std::fs::copy(entry.path(), &target) {
            Ok(_) => moved += 1,
            Err(e) => log::warn!("data_dir stage=migrate_copy_failed file={:?} error={e}", entry.file_name()),
        }
    }
    if moved > 0 {
        log::info!("data_dir stage=migrated from={legacy:?} to={dir:?} files={moved}");
    }
    dir
}

// ---- files ------------------------------------------------------------------------------------

/// Atomically writes a file that may hold a token: temp file in the same directory, 0600 on Unix
/// (on Windows the protection is the profile ACL behind %APPDATA%), fsync, rename into place.
pub fn write_secret_file_sync(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));

    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Same as [`write_secret_file_sync`] but off the async executor (backgrounds are megabytes).
pub async fn write_secret_file(path: &Path, data: Vec<u8>) -> std::io::Result<()> {
    let path = path.to_path_buf();
    match tokio::task::spawn_blocking(move || write_secret_file_sync(&path, &data)).await {
        Ok(result) => result,
        Err(e) => Err(std::io::Error::other(e.to_string())),
    }
}

pub fn remove_file_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

pub fn to_pretty_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(value).map_err(|e| e.to_string())
}

// ---- loading ----------------------------------------------------------------------------------

impl State {
    /// Loads everything from disk. A problem with one file never stops the backend: it falls back
    /// to defaults for that part, exactly like the sidecar did.
    pub fn load(paths: &Paths) -> Self {
        let mut state = State::default();
        match load_settings(paths) {
            Ok(settings) => state.settings = settings,
            Err(e) => log::warn!("local backend: settings state ignored: {e}"),
        }
        match load_auth(paths) {
            Ok(Some(auth)) => state.auth = auth,
            Ok(None) => {}
            Err(e) => log::warn!("local backend: auth state ignored: {e}"),
        }
        match load_history(paths) {
            Ok(history) => state.history = history,
            Err(e) => log::warn!("local backend: playback history ignored: {e}"),
        }
        if let Ok(data) = std::fs::read(&paths.frontend_backup) {
            if let Ok(map) = serde_json::from_slice::<HashMap<String, String>>(&data) {
                state.frontend_backup = map;
            }
        }
        state
    }
}

fn settings_are_valid(s: &Settings) -> bool {
    valid_accent(&s.accent)
        && (0..=100).contains(&s.volume)
        && (s.client_id.is_empty() || valid_client_id(&s.client_id))
        && valid_background_image(&s.background_image)
        && (0..=24).contains(&s.background_blur)
}

fn load_settings(paths: &Paths) -> Result<Settings, String> {
    let defaults = Settings::default();
    let data = match std::fs::read(&paths.settings) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            write_secret_file_sync(&paths.settings, &to_pretty_json(&defaults)?).map_err(|e| e.to_string())?;
            return Ok(defaults);
        }
        Err(e) => return Err(format!("read settings: {e}")),
    };
    // A corrupt or out-of-range file must not stop the app: keep a backup and use defaults.
    let loaded = serde_json::from_slice::<Settings>(&data).ok().filter(settings_are_valid);
    match loaded {
        Some(settings) => Ok(settings),
        None => {
            let mut backup = paths.settings.clone().into_os_string();
            backup.push(".bak");
            let _ = std::fs::rename(&paths.settings, PathBuf::from(backup));
            write_secret_file_sync(&paths.settings, &to_pretty_json(&defaults)?).map_err(|e| e.to_string())?;
            Ok(defaults)
        }
    }
}

fn load_auth(paths: &Paths) -> Result<Option<AuthState>, String> {
    let data = match std::fs::read(&paths.auth) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read auth: {e}")),
    };
    let loaded: AuthState = serde_json::from_slice(&data).map_err(|e| format!("parse auth: {e}"))?;
    if loaded.token.trim().is_empty() {
        return Err("saved auth token is empty".into());
    }
    Ok(Some(loaded))
}

fn load_history(paths: &Paths) -> Result<Vec<TrackCard>, String> {
    let data = match std::fs::read(&paths.history) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read history: {e}")),
    };
    let loaded: Vec<TrackCard> = serde_json::from_slice(&data).map_err(|e| format!("parse history: {e}"))?;
    let mut seen = std::collections::HashSet::new();
    let mut history = Vec::with_capacity(loaded.len().min(MAX_RECENT_TRACKS));
    for track in &loaded {
        if track.id <= 0 || track.title.trim().is_empty() || !seen.insert(track.id) {
            continue;
        }
        history.push(track.clone());
        if history.len() == MAX_RECENT_TRACKS {
            break;
        }
    }
    if history.len() != loaded.len() {
        write_secret_file_sync(&paths.history, &to_pretty_json(&history)?).map_err(|e| e.to_string())?;
    }
    Ok(history)
}

// ---- validators -------------------------------------------------------------------------------

pub fn valid_accent(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|c| c.is_ascii_hexdigit())
}

pub fn valid_client_id(value: &str) -> bool {
    (8..=128).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Largest animation accepted, in bytes of the original file. The table below stores a *character*
/// count of the data URL, so the two are derived from each other (base64 spends 4 characters on
/// every 3 bytes) instead of being two literals that could disagree.
const ANIMATED_FILE_BYTES: usize = 12 * 1024 * 1024;

fn max_animated_url_length() -> usize {
    "data:image/gif;base64,".len() + ANIMATED_FILE_BYTES.div_ceil(3) * 4
}

struct BackgroundFormat {
    prefix: &'static str,
    magic: &'static [u8],
    max_length: usize,
}

fn background_formats() -> [BackgroundFormat; 4] {
    [
        BackgroundFormat { prefix: "data:image/jpeg;base64,", magic: &[0xff, 0xd8, 0xff], max_length: 700_000 },
        BackgroundFormat { prefix: "data:image/png;base64,", magic: &[0x89, b'P', b'N', b'G'], max_length: 700_000 },
        BackgroundFormat { prefix: "data:image/webp;base64,", magic: b"RIFF", max_length: 700_000 },
        BackgroundFormat { prefix: "data:image/gif;base64,", magic: b"GIF8", max_length: max_animated_url_length() },
    ]
}

/// A background must be an image data URL whose bytes carry the declared signature, so a URL
/// labelled `image/jpeg` cannot smuggle an arbitrary payload through settings.
pub fn valid_background_image(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    for format in background_formats() {
        let Some(payload) = value.strip_prefix(format.prefix) else { continue };
        if value.len() > format.max_length {
            return false;
        }
        // Go's decoder skips line breaks; do the same so identical inputs stay valid.
        let cleaned: String = payload.chars().filter(|c| *c != '\r' && *c != '\n').collect();
        let engine = GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true));
        let Ok(image) = engine.decode(cleaned.as_bytes()) else { return false };
        if image.len() < format.magic.len() || &image[..format.magic.len()] != format.magic {
            return false;
        }
        // RIFF is shared by WAV, AVI and others, so WebP also needs its own marker at bytes 8-11.
        if format.prefix == "data:image/webp;base64," && (image.len() < 12 || &image[8..12] != b"WEBP") {
            return false;
        }
        // GIF87a and GIF89a are both real GIFs; the revision byte is deliberately ignored.
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    #[test]
    fn accent_and_client_id_validation() {
        assert!(valid_accent("#ff765d"));
        assert!(valid_accent("#FF765D"));
        assert!(!valid_accent("ff765d"));
        assert!(!valid_accent("#ff765"));
        assert!(!valid_accent("#gg765d"));
        assert!(valid_client_id("abcd1234"));
        assert!(!valid_client_id("short"));
        assert!(!valid_client_id("has space 123"));
    }

    #[test]
    fn background_requires_matching_signature() {
        use base64::Engine as _;
        let png = format!("data:image/png;base64,{}", STANDARD.encode([0x89, b'P', b'N', b'G', 1, 2, 3]));
        assert!(valid_background_image(&png));
        let lie = format!("data:image/jpeg;base64,{}", STANDARD.encode([0x89, b'P', b'N', b'G', 1, 2, 3]));
        assert!(!valid_background_image(&lie));
        let webp = format!("data:image/webp;base64,{}", STANDARD.encode(b"RIFF\0\0\0\0WEBPxx"));
        assert!(valid_background_image(&webp));
        let wav = format!("data:image/webp;base64,{}", STANDARD.encode(b"RIFF\0\0\0\0WAVEfmt "));
        assert!(!valid_background_image(&wav));
        assert!(valid_background_image(""));
        assert!(!valid_background_image("https://example.com/a.png"));
    }

    #[test]
    fn animated_ceiling_matches_file_limit() {
        // 12 MiB of file is 16 MiB of base64 plus the prefix.
        assert_eq!(max_animated_url_length(), "data:image/gif;base64,".len() + 16 * 1024 * 1024);
    }

    #[test]
    fn files_written_by_the_go_sidecar_still_load() {
        let dir = std::env::temp_dir().join(format!("resonance-store-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = Paths::in_dir(&dir);
        std::fs::write(&paths.settings, r##"{"accent":"#112233","volume":55,"clientId":"abcdef123456","backgroundImage":"","backgroundBlur":3}"##).unwrap();
        std::fs::write(
            &paths.auth,
            r#"{"token":"tok","profile":{"id":9,"username":"me","avatarUrl":"https://a/b.jpg","followersCount":4},"savedAt":"2026-01-02T03:04:05Z"}"#,
        )
        .unwrap();
        std::fs::write(
            &paths.history,
            r#"[{"id":5,"trackUrn":"soundcloud:tracks:5","title":"T","duration":10,"user":{"username":"u"}},{"id":5,"title":"dup"},{"id":0,"title":"bad"}]"#,
        )
        .unwrap();
        std::fs::write(&paths.frontend_backup, r#"{"k":"v"}"#).unwrap();

        let state = State::load(&paths);
        assert_eq!((state.settings.accent.as_str(), state.settings.volume, state.settings.background_blur), ("#112233", 55, 3));
        assert_eq!((state.auth.token.as_str(), state.auth.profile.id, state.auth.profile.followers_count), ("tok", 9, 4));
        assert_eq!(state.history.len(), 1, "duplicates and invalid entries are dropped on load");
        assert_eq!(state.frontend_backup.get("k").map(String::as_str), Some("v"));
    }

    #[test]
    fn corrupt_settings_are_backed_up_and_reset() {
        let dir = std::env::temp_dir().join(format!("resonance-store-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = Paths::in_dir(&dir);
        std::fs::write(&paths.settings, r#"{"accent":"nope","volume":55}"#).unwrap();
        let state = State::load(&paths);
        assert_eq!(state.settings, Settings::default());
        assert!(dir.join("settings.json.bak").exists());
    }
}
