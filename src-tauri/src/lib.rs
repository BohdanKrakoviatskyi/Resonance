pub mod auth_windows;
pub mod backend;
pub mod discord;
pub mod lastfm;
pub mod local;
pub mod yandex_import;
pub mod lyrics_words;
pub mod offline;
pub mod transcribe;
pub mod playlist_import;
pub mod yt;

use tauri::{AppHandle, Emitter, Manager};

use backend::{Backend, backend_rpc};
use auth_windows::{SoundCloudLoginState, YtMusicLoginState, soundcloud_auth_capture, start_soundcloud_login, start_ytmusic_login};
use playlist_import::fetch_external_playlist;
use yt::music_api::{fetch_yt_playlist_tracks, search_yt_tracks, yt_radio_tracks, yt_search_suggestions};
use yt::proxy::{YtStreamProxy, frontend_log, resolve_yt_stream_url};
use yt::store::{
    YtStore, yt_auth_logout, yt_auth_save, yt_auth_status, yt_clear_cache, yt_library_cached,
    yt_library_sync, yt_playlist_artwork, yt_playlist_tracks_cached, yt_playlist_tracks_sync,
};

#[tauri::command]
async fn uninstall_app(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for candidate in ["uninstall.exe", "unins000.exe"] {
                    let uninstaller = dir.join(candidate);
                    if uninstaller.exists() {
                        std::process::Command::new(&uninstaller)
                            .current_dir(dir)
                            .spawn()
                            .map_err(|e| format!("could not launch uninstaller: {e}"))?;
                        app.exit(0);
                        return Ok(());
                    }
                }
            }
        }
        let ps_script = r#"
$paths = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$item = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Resonance*' -and $_.UninstallString } | Select-Object -First 1
if ($item) {
  Start-Process cmd.exe -ArgumentList '/c', $item.UninstallString
} else {
  Start-Process 'ms-settings:appsfeatures'
}
"#;
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps_script])
            .spawn();
        app.exit(0);
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Uninstaller is only supported on desktop builds.".to_string())
    }
}

fn purge_retired_spotify_storage(app: &AppHandle) {
    for account in ["oauth_tokens", "oauth_tokens_v1"] {
        if let Ok(entry) = keyring::Entry::new("com.resonance.spotify", account) {
            let _ = entry.delete_credential();
        }
    }
    if let Ok(config_dir) = app.path().app_config_dir() {
        for file_name in ["spotify_config.json", "spotify_imports.json", "spotify_profile_cache.json", "spotify.json"] {
            let _ = std::fs::remove_file(config_dir.join(file_name));
        }
        let _ = std::fs::remove_dir_all(config_dir.join("spotify-webview"));
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        for file_name in ["spotify_config.json", "spotify_imports.json", "spotify_profile_cache.json", "spotify.json"] {
            let _ = std::fs::remove_file(data_dir.join(file_name));
        }
        let _ = std::fs::remove_dir_all(data_dir.join("spotify-webview"));
    }
}

#[tauri::command]
async fn finish_splash(app: AppHandle) -> Result<(), String> {
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    if let Some(splash_window) = app.get_webview_window("splash") {
        let _ = splash_window.close();
    }
    Ok(())
}

#[tauri::command]
async fn restart_app(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe) = std::env::current_exe() {
            let app_bundle = exe
                .ancestors()
                .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
                .map(|p| p.to_path_buf());
            if let Some(bundle_path) = app_bundle {
                let _ = std::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg("sleep 0.7 && open -a \"$1\"")
                    .arg("sh")
                    .arg(&bundle_path)
                    .spawn();
                app.exit(0);
                return Ok(());
            }
        }
    }
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(YtMusicLoginState::default())
        .manage(SoundCloudLoginState::default())
        .manage(YtStreamProxy::default())
        .manage(YtStore::default())
        .manage(Backend::new())
        .manage(discord::DiscordPresence::default())
        .manage(transcribe::WhisperWorker::default())
        .setup(|app| {
            purge_retired_spotify_storage(app.handle());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let proxy = app_handle.state::<YtStreamProxy>();
                let _ = proxy.ensure_server_port().await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "splash" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(main_window) = window.app_handle().get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
            }
            if window.label() == "soundcloud-login" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                // Whether the user cancelled or capture succeeded, no capture
                // can be pending for a closed window.
                let login_state = window.app_handle().state::<SoundCloudLoginState>();
                if let Ok(mut pending) = login_state.pending.lock() {
                    *pending = false;
                }
                let _ = window.emit("soundcloud-login-cancelled", ());
            }
            if window.label() == "ytmusic-login" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<YtMusicLoginState>();
                let pending = state.nonce.lock().map(|mut n| n.take().is_some()).unwrap_or(false);
                if pending {
                    let _ = window.emit("ytmusic-login-cancelled", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_soundcloud_login,
            soundcloud_auth_capture,
            start_ytmusic_login,
            uninstall_app,
            finish_splash,
            restart_app,
            resolve_yt_stream_url,
            frontend_log,
            search_yt_tracks,
            yt_search_suggestions,
            yt_radio_tracks,
            fetch_yt_playlist_tracks,
            yt_auth_status,
            yt_auth_save,
            yt_auth_logout,
            yt_library_cached,
            yt_library_sync,
            yt_playlist_tracks_cached,
            yt_playlist_tracks_sync,
            yt_playlist_artwork,
            yt_clear_cache,
            fetch_external_playlist,
            discord::discord_set_presence,
            lastfm::lastfm_login,
            lastfm::lastfm_status,
            lastfm::lastfm_logout,
            lastfm::lastfm_now_playing,
            lastfm::lastfm_scrobble,
            local::local_scan,
            local::local_base_url,
            lyrics_words::lyrics_word_synced,
            yt::lyrics_ytm::ytm_lyrics,
            offline::offline_download,
            offline::offline_remove,
            offline::offline_list,
            transcribe::whisper_models,
            transcribe::whisper_download,
            transcribe::whisper_cancel_download,
            transcribe::whisper_delete,
            transcribe::whisper_transcribe,
            transcribe::whisper_cancel,
            backend_rpc
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::auth_windows::{domain_applies_to, is_music_youtube_library_url, is_music_youtube_url, path_applies_to};

    #[test]
    fn accepts_only_music_youtube_https_urls() {
        assert!(is_music_youtube_url(&"https://music.youtube.com/library".parse().unwrap()));
        assert!(!is_music_youtube_url(&"http://music.youtube.com/".parse().unwrap()));
        assert!(!is_music_youtube_url(&"https://www.youtube.com/".parse().unwrap()));
        assert!(!is_music_youtube_url(&"https://music.youtube.com.evil.test/".parse().unwrap()));
    }

    #[test]
    fn accepts_only_the_music_youtube_library_page() {
        assert!(is_music_youtube_library_url(&"https://music.youtube.com/library".parse().unwrap()));
        assert!(is_music_youtube_library_url(&"https://music.youtube.com/library/playlists".parse().unwrap()));
        assert!(!is_music_youtube_library_url(&"https://music.youtube.com/".parse().unwrap()));
        assert!(!is_music_youtube_library_url(&"https://music.youtube.com.evil.test/library".parse().unwrap()));
        assert!(!is_music_youtube_library_url(&"http://music.youtube.com/library".parse().unwrap()));
    }

    #[test]
    fn cookie_domain_and_path_checks() {
        assert!(domain_applies_to("youtube.com", "music.youtube.com"));
        assert!(domain_applies_to(".youtube.com", "music.youtube.com"));
        assert!(!domain_applies_to("com", "music.youtube.com"));
        assert!(path_applies_to(Some("/"), "/library"));
        assert!(!path_applies_to(Some("/admin"), "/library"));
    }
}
