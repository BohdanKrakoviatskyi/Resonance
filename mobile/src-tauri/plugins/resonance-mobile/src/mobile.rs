use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_resonance_mobile);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<ResonanceMobile<R>, String> {
    #[cfg(target_os = "android")]
    let handle = api
        .register_android_plugin("com.resonance.mobile.plugin", "ResonanceMobilePlugin")
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "ios")]
    let handle = api
        .register_ios_plugin(init_plugin_resonance_mobile)
        .map_err(|e| e.to_string())?;
    Ok(ResonanceMobile(handle))
}

pub struct ResonanceMobile<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> ResonanceMobile<R> {
    pub async fn set_queue(&self, req: SetQueueRequest) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("setQueue", req)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn play(&self) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("play", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn install_update(&self, url: String) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async("installUpdate", serde_json::json!({ "url": url }))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn pause(&self) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("pause", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn seek(&self, req: SeekRequest) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("seek", req)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn skip_to(&self, req: SkipToRequest) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("skipTo", req)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn next(&self) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("next", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn prev(&self) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("prev", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn get_state(&self) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("getState", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn set_eq(&self, req: SetEqRequest) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<serde_json::Value>("setEq", req)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub async fn set_audio_config(&self, req: SetAudioConfigRequest) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<serde_json::Value>("setAudioConfig", req)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub async fn set_repeat_shuffle(
        &self,
        req: SetRepeatShuffleRequest,
    ) -> Result<MobileAudioState, String> {
        self.0
            .run_mobile_plugin_async("setRepeatShuffle", req)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn clear_auth_cookies(&self, req: ClearAuthCookiesRequest) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<serde_json::Value>("clearAuthCookies", req)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub async fn start_ytmusic_login(&self) -> Result<YtAuthCaptureResult, String> {
        self.0
            .run_mobile_plugin_async("startYtMusicLogin", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn start_soundcloud_login(&self) -> Result<ScAuthCaptureResult, String> {
        self.0
            .run_mobile_plugin_async("startSoundCloudLogin", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }
}
