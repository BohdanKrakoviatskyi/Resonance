#[derive(Clone, Debug, PartialEq)]
pub struct PendingAudioSeek {
    pub track_id: String,
    pub seconds: f64,
}

pub fn create_pending_audio_seek(
    track_id: &str,
    seconds: f64,
    provider_playback: bool,
) -> Option<PendingAudioSeek> {
    if !provider_playback && !track_id.is_empty() && seconds > 0.0 && seconds.is_finite() {
        Some(PendingAudioSeek {
            track_id: track_id.to_string(),
            seconds,
        })
    } else {
        None
    }
}

pub fn pending_audio_seek_for(pending: Option<&PendingAudioSeek>, track_id: &str) -> Option<f64> {
    pending.filter(|p| p.track_id == track_id).map(|p| p.seconds)
}
