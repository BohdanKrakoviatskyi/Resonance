use std::path::PathBuf;

pub fn purge_retired_spotify_storage() {
    for account in ["oauth_tokens", "oauth_tokens_v1"] {
        if let Ok(entry) = keyring::Entry::new("com.resonance.spotify", account) {
            let _ = entry.delete_credential();
        }
    }
    let mut candidate_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(app_dir) = crate::backend::store::app_data_dir() {
        candidate_dirs.push(app_dir);
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        let base = PathBuf::from(home).join("Library/Application Support/com.resonance.app");
        candidate_dirs.push(base);
    }
    #[cfg(target_os = "linux")]
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        candidate_dirs.push(PathBuf::from(home).join(".config/com.resonance.app"));
        candidate_dirs.push(PathBuf::from(home).join(".local/share/com.resonance.app"));
    }
    #[cfg(target_os = "windows")]
    if let Some(appdata) = std::env::var_os("APPDATA").filter(|h| !h.is_empty()) {
        candidate_dirs.push(PathBuf::from(appdata).join("com.resonance.app"));
    }

    for dir in candidate_dirs {
        for file_name in [
            "spotify_config.json",
            "spotify_imports.json",
            "spotify_profile_cache.json",
            "spotify.json",
        ] {
            let _ = std::fs::remove_file(dir.join(file_name));
        }
        let _ = std::fs::remove_dir_all(dir.join("spotify-webview"));
    }
}
