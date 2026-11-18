use std::sync::Mutex;
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<ResonanceMobile<R>, String> {
    Ok(ResonanceMobile {
        state: Mutex::new(MobileAudioState {
            current_index: -1,
            repeat_mode: "off".to_string(),
            ..Default::default()
        }),
        _marker: std::marker::PhantomData,
    })
}

pub struct ResonanceMobile<R: Runtime> {
    state: Mutex<MobileAudioState>,
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> ResonanceMobile<R> {
    pub async fn set_queue(&self, req: SetQueueRequest) -> Result<MobileAudioState, String> {
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        if let Some(item) = req.items.get(req.start_index) {
            st.current_index = req.start_index as i32;
            st.track_id = Some(item.id.clone());
            st.duration_ms = item.duration_ms;
            st.position_ms = req.start_position_ms;
            st.playing = req.auto_play;
        } else {
            st.current_index = -1;
            st.track_id = None;
            st.playing = false;
        }
        Ok(st.clone())
    }

    pub async fn play(&self) -> Result<MobileAudioState, String> {
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        st.playing = true;
        Ok(st.clone())
    }

    pub async fn pause(&self) -> Result<MobileAudioState, String> {
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        st.playing = false;
        Ok(st.clone())
    }

    pub async fn seek(&self, req: SeekRequest) -> Result<MobileAudioState, String> {
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        st.position_ms = req.position_ms;
        Ok(st.clone())
    }

    pub async fn skip_to(&self, req: SkipToRequest) -> Result<MobileAudioState, String> {
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        st.current_index = req.index as i32;
        st.position_ms = 0;
        st.playing = req.auto_play;
        Ok(st.clone())
    }

    pub async fn next(&self) -> Result<MobileAudioState, String> {
        let st = self.state.lock().map_err(|e| e.to_string())?;
        Ok(st.clone())
    }

    pub async fn prev(&self) -> Result<MobileAudioState, String> {
        let st = self.state.lock().map_err(|e| e.to_string())?;
        Ok(st.clone())
    }

    pub async fn get_state(&self) -> Result<MobileAudioState, String> {
        let st = self.state.lock().map_err(|e| e.to_string())?;
        Ok(st.clone())
    }

    pub async fn set_eq(&self, _req: SetEqRequest) -> Result<(), String> {
        Ok(())
    }

    pub async fn set_audio_config(&self, _req: SetAudioConfigRequest) -> Result<(), String> {
        Ok(())
    }

    pub async fn set_repeat_shuffle(&self, req: SetRepeatShuffleRequest) -> Result<MobileAudioState, String> {
        let mut st = self.state.lock().map_err(|e| e.to_string())?;
        st.repeat_mode = req.repeat_mode;
        st.shuffle_enabled = req.shuffle_enabled;
        Ok(st.clone())
    }

    pub async fn clear_auth_cookies(&self, _req: ClearAuthCookiesRequest) -> Result<(), String> {
        Ok(())
    }

    pub async fn start_ytmusic_login(&self) -> Result<YtAuthCaptureResult, String> {
        Err("Interactive mobile WebView sign-in is only available on Android/iOS; paste cookies manually in dev mode.".to_string())
    }

    pub async fn start_soundcloud_login(&self) -> Result<ScAuthCaptureResult, String> {
        Err("Interactive mobile WebView sign-in is only available on Android/iOS; paste your OAuth token manually in dev mode.".to_string())
    }
}
