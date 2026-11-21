pub mod backend;
pub mod mobile_paths;
pub mod playlist_import;
pub mod yt;

use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use tauri_plugin_resonance_mobile::{
    ClearAuthCookiesRequest, MobileAudioState, ResonanceMobileExt, ScAuthCaptureResult,
    SeekRequest, SetAudioConfigRequest, SetEqRequest, SetQueueRequest, SetRepeatShuffleRequest,
    SkipToRequest,
};

use backend::{Backend, backend_rpc};
use playlist_import::fetch_external_playlist;
use yt::identity::save_ytmusic_credentials;
use yt::music_api::{
    fetch_account_profile, fetch_yt_playlist_tracks, search_yt_tracks, yt_radio_tracks,
    yt_search_suggestions,
};
use yt::proxy::{YtStreamProxy, frontend_log, get_local_proxy_info, resolve_yt_stream_url};
use yt::store::{
    YtAuthStatusDto, YtStore, yt_auth_logout, yt_auth_save, yt_auth_status, yt_clear_cache,
    yt_library_cached, yt_library_sync, yt_playlist_artwork, yt_playlist_tracks_cached,
    yt_playlist_tracks_sync,
};

#[tauri::command]
async fn start_ytmusic_login(
    app: AppHandle,
    proxy: tauri::State<'_, YtStreamProxy>,
) -> Result<YtAuthStatusDto, String> {
    let captured = app.resonance_mobile().start_ytmusic_login().await?;
    let cookie = captured.cookie.trim().to_string();
    let auth_user = if captured.auth_user.trim().is_empty() {
        "0".to_string()
    } else {
        captured.auth_user.trim().to_string()
    };
    let profile = fetch_account_profile(&proxy.browse_http, &cookie, &auth_user).await?;
    let mut headers = HashMap::new();
    headers.insert("Cookie".to_string(), cookie);
    headers.insert("X-Goog-AuthUser".to_string(), auth_user);
    let p_clone = profile.clone();
    tokio::task::spawn_blocking(move || save_ytmusic_credentials(&headers, &p_clone))
        .await
        .map_err(|e| e.to_string())??;
    Ok(YtAuthStatusDto {
        authorized: true,
        profile: Some(profile),
    })
}

#[tauri::command]
async fn start_soundcloud_login(
    app: AppHandle,
    backend: tauri::State<'_, Backend>,
) -> Result<ScAuthCaptureResult, String> {
    let mut captured = app.resonance_mobile().start_soundcloud_login().await?;
    if let Ok(resolved_cid) = backend.ensure_client_id(&captured.client_id).await {
        captured.client_id = resolved_cid;
    }
    Ok(captured)
}

#[tauri::command]
async fn mobile_clear_auth_cookies(app: AppHandle, provider: String) -> Result<(), String> {
    app.resonance_mobile()
        .clear_auth_cookies(ClearAuthCookiesRequest { provider })
        .await
}

#[tauri::command]
async fn mobile_update_install(app: AppHandle, url: String) -> Result<(), String> {
    app.resonance_mobile().install_update(url).await
}

#[tauri::command]
async fn mobile_audio_set_queue(
    app: AppHandle,
    req: SetQueueRequest,
) -> Result<MobileAudioState, String> {
    app.resonance_mobile().set_queue(req).await
}

#[tauri::command]
async fn mobile_audio_play(app: AppHandle) -> Result<MobileAudioState, String> {
    app.resonance_mobile().play().await
}

#[tauri::command]
async fn mobile_audio_pause(app: AppHandle) -> Result<MobileAudioState, String> {
    app.resonance_mobile().pause().await
}

#[tauri::command]
async fn mobile_audio_seek(
    app: AppHandle,
    position_ms: u64,
) -> Result<MobileAudioState, String> {
    app.resonance_mobile().seek(SeekRequest { position_ms }).await
}

#[tauri::command]
async fn mobile_audio_skip_to(
    app: AppHandle,
    index: usize,
    auto_play: bool,
) -> Result<MobileAudioState, String> {
    app.resonance_mobile()
        .skip_to(SkipToRequest { index, auto_play })
        .await
}

#[tauri::command]
async fn mobile_audio_next(app: AppHandle) -> Result<MobileAudioState, String> {
    app.resonance_mobile().next().await
}

#[tauri::command]
async fn mobile_audio_prev(app: AppHandle) -> Result<MobileAudioState, String> {
    app.resonance_mobile().prev().await
}

#[tauri::command]
async fn mobile_audio_get_state(app: AppHandle) -> Result<MobileAudioState, String> {
    app.resonance_mobile().get_state().await
}

#[tauri::command]
async fn mobile_audio_set_eq(
    app: AppHandle,
    enabled: bool,
    gains_db: Vec<f32>,
) -> Result<(), String> {
    app.resonance_mobile()
        .set_eq(SetEqRequest { enabled, gains_db })
        .await
}

#[tauri::command]
async fn mobile_audio_set_config(
    app: AppHandle,
    normalization_enabled: bool,
    normalization_target: String,
    crossfade_enabled: bool,
    crossfade_duration_ms: u64,
    crossfade_curve: String,
) -> Result<(), String> {
    app.resonance_mobile()
        .set_audio_config(SetAudioConfigRequest {
            normalization_enabled,
            normalization_target,
            crossfade_enabled,
            crossfade_duration_ms,
            crossfade_curve,
        })
        .await
}

#[tauri::command]
async fn mobile_audio_set_repeat_shuffle(
    app: AppHandle,
    repeat_mode: String,
    shuffle_enabled: bool,
) -> Result<MobileAudioState, String> {
    app.resonance_mobile()
        .set_repeat_shuffle(SetRepeatShuffleRequest {
            repeat_mode,
            shuffle_enabled,
        })
        .await
}

#[tauri::command]
fn mobile_cache_get_limit() -> u64 {
    mobile_paths::cache_limit_bytes()
}

#[tauri::command]
fn mobile_cache_set_limit(
    proxy: tauri::State<'_, YtStreamProxy>,
    bytes: u64,
) -> u64 {
    mobile_paths::set_cache_limit_bytes(bytes);
    proxy.audio_cache.enforce_current_limit();
    mobile_paths::cache_limit_bytes()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("failed to build async runtime");
    tauri::async_runtime::set(runtime.handle().clone());
    std::mem::forget(runtime);

    tauri::Builder::default()
        .plugin(tauri_plugin_resonance_mobile::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| mobile_paths::data_dir());
            let cache_dir = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| mobile_paths::cache_dir());
            mobile_paths::init(data_dir, cache_dir);

            let backend = Backend::new();
            let proxy = YtStreamProxy::new();
            proxy.attach_backend(backend.clone());
            let yt_store = YtStore::new();

            let backend_warm = backend.clone();
            app.manage(backend);
            app.manage(proxy.clone());
            app.manage(yt_store);

            tauri::async_runtime::spawn(async move {
                let _ = proxy.ensure_server_port().await;
            });
            tauri::async_runtime::spawn(async move {
                let _ = backend_warm.ensure_client_id("").await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_rpc,
            get_local_proxy_info,
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
            start_ytmusic_login,
            start_soundcloud_login,
            mobile_clear_auth_cookies,
            mobile_audio_set_queue,
            mobile_audio_play,
            mobile_audio_pause,
            mobile_audio_seek,
            mobile_audio_skip_to,
            mobile_audio_next,
            mobile_audio_prev,
            mobile_audio_get_state,
            mobile_audio_set_eq,
            mobile_audio_set_config,
            mobile_audio_set_repeat_shuffle,
            mobile_update_install,
            mobile_cache_get_limit,
            mobile_cache_set_limit
        ])
        .run(tauri::generate_context!())
        .expect("error while running resonance mobile application");
}
