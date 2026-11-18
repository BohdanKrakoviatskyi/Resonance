use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileQueueItem {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_url: Option<String>,
    pub stream_url: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetQueueRequest {
    pub items: Vec<MobileQueueItem>,
    pub start_index: usize,
    pub auto_play: bool,
    #[serde(default)]
    pub start_position_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekRequest {
    pub position_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipToRequest {
    pub index: usize,
    pub auto_play: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEqRequest {
    pub enabled: bool,
    pub gains_db: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAudioConfigRequest {
    pub normalization_enabled: bool,
    pub normalization_target: String,
    pub crossfade_enabled: bool,
    pub crossfade_duration_ms: u64,
    pub crossfade_curve: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRepeatShuffleRequest {
    pub repeat_mode: String,
    pub shuffle_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearAuthCookiesRequest {
    pub provider: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAudioState {
    pub playing: bool,
    pub buffering: bool,
    pub current_index: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub repeat_mode: String,
    pub shuffle_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtAuthCaptureResult {
    pub cookie: String,
    #[serde(default = "default_auth_user")]
    pub auth_user: String,
}

fn default_auth_user() -> String {
    "0".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScAuthCaptureResult {
    #[serde(default)]
    pub client_id: String,
    pub token: String,
    #[serde(default)]
    pub datadome: Option<String>,
}
