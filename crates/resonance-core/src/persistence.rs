use std::collections::HashMap;
use std::path::PathBuf;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::backend::Backend;
use crate::backend::store::app_data_dir;
use crate::matching::ManualLyricsChoice;
use crate::models::{
    Appearance, CrossfadeCurve, EqPreset, FavProvider, NormalizationTarget, Playlist, RepeatMode,
    SoundCloudPlaylist, Track, YtMusicPlaylist,
};
use crate::shortcuts::ShortcutBindings;

pub const KEY_LIBRARY: &str = "lyra.lib.v1";
pub const KEY_UI: &str = "lyra.ui.v1";
pub const KEY_APPEARANCE: &str = "lyra.app.v1";
pub const KEY_BG_IMAGE_LEGACY: &str = "lyra.bgimg.v1";
pub const KEY_PLAYER: &str = "lyra.player.v1";
pub const KEY_SHORTCUTS: &str = "resonance.shortcuts.v1";
pub const KEY_MANUAL_LYRICS: &str = "resonance.manual_lyrics.v1";
pub const KEY_UPDATER: &str = "lyra.updater.v1";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryPersisted {
    pub favorites: Vec<String>,
    pub disliked: Vec<String>,
    pub playlists: Vec<Playlist>,
    pub recent: Vec<String>,
    pub catalog: HashMap<String, Track>,
    pub soundcloud_liked: Vec<Track>,
    pub soundcloud_playlists: Vec<SoundCloudPlaylist>,
    pub soundcloud_playlist_tracks: HashMap<String, Vec<Track>>,
    pub ytmusic_liked: Vec<Track>,
    pub ytmusic_playlists: Vec<YtMusicPlaylist>,
    pub ytmusic_playlist_tracks: HashMap<String, Vec<Track>>,
    pub ytmusic_playlist_art: HashMap<String, String>,
    pub ytmusic_authorized: bool,
    pub ytmusic_account_name: String,
    pub ytmusic_account_handle: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiPersisted {
    pub sidebar_collapsed: bool,
    pub panel_open: bool,
    pub fav_provider: FavProvider,
    pub fold_local: bool,
    pub fold_youtube: bool,
    pub fold_soundcloud: bool,
}

impl Default for UiPersisted {
    fn default() -> Self {
        Self {
            sidebar_collapsed: false,
            panel_open: false,
            fav_provider: FavProvider::All,
            fold_local: false,
            fold_youtube: false,
            fold_soundcloud: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerPersisted {
    pub volume: f32,
    pub muted: bool,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    pub normalization_enabled: bool,
    pub normalization_target: NormalizationTarget,
    pub crossfade_enabled: bool,
    pub crossfade_duration: f64,
    pub crossfade_curve: CrossfadeCurve,
    pub eq_enabled: bool,
    pub eq_preset: EqPreset,
    pub eq_bands: [f32; 5],
}

impl Default for PlayerPersisted {
    fn default() -> Self {
        Self {
            volume: 0.72,
            muted: false,
            shuffle: false,
            repeat: RepeatMode::Off,
            normalization_enabled: true,
            normalization_target: NormalizationTarget::Normal,
            crossfade_enabled: false,
            crossfade_duration: 6.0,
            crossfade_curve: CrossfadeCurve::EqualPower,
            eq_enabled: false,
            eq_preset: EqPreset::Flat,
            eq_bands: [0.0; 5],
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdaterPersisted {
    pub available: bool,
    pub latest_version: String,
    pub release_url: String,
    pub download_url: String,
    pub notes: String,
}

#[derive(Clone, Debug, Default)]
pub struct AppPersistedState {
    pub library: LibraryPersisted,
    pub ui: UiPersisted,
    pub appearance: Appearance,
    pub player: PlayerPersisted,
    pub shortcuts: ShortcutBindings,
    pub manual_lyrics: HashMap<String, ManualLyricsChoice>,
    pub updater: UpdaterPersisted,
    pub custom_bg_image_path: Option<PathBuf>,
}

pub fn bg_image_file_path() -> PathBuf {
    let dir = app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    dir.join("bg-image.bin")
}

pub fn save_bg_image_bytes(bytes: &[u8]) -> Result<PathBuf, String> {
    let path = bg_image_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn remove_bg_image_file() {
    let _ = std::fs::remove_file(bg_image_file_path());
}

fn migrate_legacy_data_url_bg(entries: &HashMap<String, String>) -> Option<PathBuf> {
    let path = bg_image_file_path();
    if path.exists() {
        return Some(path);
    }
    let data_url = entries.get(KEY_BG_IMAGE_LEGACY)?;
    let (_, b64) = data_url.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    save_bg_image_bytes(&bytes).ok()
}

pub async fn load_all_state(backend: &Backend) -> AppPersistedState {
    let raw = backend
        .call("frontend.restore", serde_json::Value::Null)
        .await
        .ok()
        .and_then(|v| serde_json::from_value::<HashMap<String, String>>(v).ok())
        .unwrap_or_default();

    let mut state = AppPersistedState::default();

    if let Some(s) = raw.get(KEY_LIBRARY)
        && let Ok(parsed) = serde_json::from_str::<LibraryPersisted>(s) {
            state.library = parsed;
        }
    if let Some(s) = raw.get(KEY_UI)
        && let Ok(parsed) = serde_json::from_str::<UiPersisted>(s) {
            state.ui = parsed;
        }
    if let Some(s) = raw.get(KEY_APPEARANCE)
        && let Ok(parsed) = serde_json::from_str::<Appearance>(s) {
            state.appearance = parsed;
        }
    if let Some(s) = raw.get(KEY_PLAYER)
        && let Ok(mut parsed) = serde_json::from_str::<PlayerPersisted>(s) {
            parsed.volume = parsed.volume.clamp(0.0, 1.0);
            parsed.crossfade_duration = parsed.crossfade_duration.clamp(1.0, 12.0);
            for b in &mut parsed.eq_bands {
                *b = b.clamp(-12.0, 12.0);
            }
            state.player = parsed;
        }
    if let Some(s) = raw.get(KEY_SHORTCUTS)
        && let Ok(mut parsed) = serde_json::from_str::<ShortcutBindings>(s) {
            parsed.sanitize();
            state.shortcuts = parsed;
        }
    if let Some(s) = raw.get(KEY_MANUAL_LYRICS)
        && let Ok(parsed) = serde_json::from_str::<HashMap<String, ManualLyricsChoice>>(s) {
            state.manual_lyrics = parsed;
        }
    if let Some(s) = raw.get(KEY_UPDATER)
        && let Ok(parsed) = serde_json::from_str::<UpdaterPersisted>(s) {
            state.updater = parsed;
        }
    state.custom_bg_image_path = migrate_legacy_data_url_bg(&raw);
    state
}

pub async fn save_all_state(backend: &Backend, state: &AppPersistedState) -> Result<(), String> {
    let mut entries = HashMap::new();
    entries.insert(
        KEY_LIBRARY.to_string(),
        serde_json::to_string(&state.library).map_err(|e| e.to_string())?,
    );
    entries.insert(
        KEY_UI.to_string(),
        serde_json::to_string(&state.ui).map_err(|e| e.to_string())?,
    );
    entries.insert(
        KEY_APPEARANCE.to_string(),
        serde_json::to_string(&state.appearance).map_err(|e| e.to_string())?,
    );
    entries.insert(
        KEY_PLAYER.to_string(),
        serde_json::to_string(&state.player).map_err(|e| e.to_string())?,
    );
    entries.insert(
        KEY_SHORTCUTS.to_string(),
        serde_json::to_string(&state.shortcuts).map_err(|e| e.to_string())?,
    );
    entries.insert(
        KEY_MANUAL_LYRICS.to_string(),
        serde_json::to_string(&state.manual_lyrics).map_err(|e| e.to_string())?,
    );
    entries.insert(
        KEY_UPDATER.to_string(),
        serde_json::to_string(&state.updater).map_err(|e| e.to_string())?,
    );

    backend
        .call(
            "frontend.backup",
            serde_json::json!({ "entries": entries }),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_library_ignores_retired_spotify_fields() {
        let legacy = r#"{
            "favorites": ["sc:1"],
            "disliked": [],
            "playlists": [],
            "spotifyLiked": [{"id": "old"}],
            "spotifyAuthorized": true
        }"#;
        let parsed: LibraryPersisted = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.favorites, vec!["sc:1"]);
    }
}
