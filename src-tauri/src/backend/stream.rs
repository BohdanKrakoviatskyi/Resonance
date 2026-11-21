//! `track.stream`: picks the best playable SoundCloud transcoding and resolves it to a CDN URL.
//! Port of the Go sidecar's `playback.go`.

use serde_json::Value;
use url::Url;

use super::soundcloud::Sc;
use super::types::TrackStreamResult;
use super::util::*;

#[derive(Debug, Clone, Default)]
pub struct Transcoding {
    pub url: String,
    pub preset: String,
    pub protocol: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Default)]
pub struct TranscodingChoice {
    pub url: String,
    pub protocol: String,
    pub preview: bool,
    pub hls: bool,
    pub quality: String,
    pub bitrate: u32,
}

fn parse_transcoding(v: &Value) -> Transcoding {
    let format = v.get("format").cloned().unwrap_or(Value::Null);
    Transcoding { url: vs(v, "url"), preset: vs(v, "preset"), protocol: vs(&format, "protocol"), mime_type: vs(&format, "mime_type") }
}

pub fn is_soundcloud_media_host(host: &str) -> bool {
    let host = host.trim().to_lowercase();
    host.ends_with(".sndcdn.com") || host.ends_with(".soundcloud.cloud")
}

/// Orders the available streams: AAC HLS (highest bitrate first), other HLS, progressive, previews.
pub fn transcoding_choices(transcodings: &[Transcoding], preview_url: &str) -> Vec<TranscodingChoice> {
    let (mut aac_hls, mut other_hls, mut progressive, mut previews) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for transcoding in transcodings {
        if transcoding.url.trim().is_empty() {
            continue;
        }
        let protocol = transcoding.protocol.trim().to_lowercase();
        let preset = transcoding.preset.to_lowercase();
        let mime = transcoding.mime_type.to_lowercase();
        let info = format!("{preset} {mime} {}", transcoding.url.to_lowercase());
        let is_preview = info.contains("preview");
        let is_hls = protocol.contains("hls");
        let is_aac = info.contains("aac");
        let mut choice = TranscodingChoice { url: transcoding.url.clone(), protocol: protocol.clone(), hls: is_hls, preview: is_preview, ..Default::default() };
        if is_preview {
            choice.quality = "Превью".into();
            previews.push(choice);
            continue;
        }
        if is_hls && is_aac {
            let bitrate = aac_bitrate_kbps(transcoding);
            choice.bitrate = bitrate;
            choice.quality = if bitrate > 0 { format!("AAC {bitrate} kbps") } else { "AAC HLS".into() };
            aac_hls.push(choice);
        } else if is_hls {
            choice.quality = transcoding.preset.clone();
            other_hls.push(choice);
        } else if protocol == "progressive" {
            choice.quality = "Progressive".into();
            progressive.push(choice);
        }
    }
    aac_hls.sort_by_key(|c| std::cmp::Reverse(c.bitrate)); // stable
    let mut choices = aac_hls;
    choices.extend(other_hls);
    choices.extend(progressive);
    choices.extend(previews);
    if !preview_url.is_empty() {
        choices.push(TranscodingChoice {
            url: preview_url.to_string(),
            protocol: "preview".into(),
            preview: true,
            hls: preview_url.to_lowercase().contains(".m3u8"),
            quality: "Превью MP3".into(),
            bitrate: 0,
        });
    }
    choices
}

/// Prefer full progressive streams, with complete HLS streams as a local-decoding fallback.
/// Short previews and encrypted streams are never used for recognition.
fn analysis_transcoding_choices(transcodings: &[Transcoding]) -> Vec<TranscodingChoice> {
    let choices = transcoding_choices(transcodings, "");
    let mut progressive: Vec<_> = choices.iter().filter(|choice| !choice.hls && !choice.preview).cloned().collect();
    progressive.extend(choices.into_iter().filter(|choice| {
        choice.hls && !choice.preview && !choice.protocol.contains("encrypted")
    }));
    progressive
}

fn aac_bitrate_kbps(transcoding: &Transcoding) -> u32 {
    let value = format!("{} {}", transcoding.preset, transcoding.url).to_lowercase();
    let Some(start) = value.find("aac_") else { return 0 };
    let digits: String = value[start + 4..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().unwrap_or(0)
}

impl Sc {
    pub async fn track_stream(&self, track_urn: &str) -> BResult<TrackStreamResult> {
        self.track_stream_inner(track_urn, false).await
    }

    pub async fn track_analysis_stream(&self, track_urn: &str) -> BResult<TrackStreamResult> {
        self.track_stream_inner(track_urn, true).await
    }

    async fn track_stream_inner(&self, track_urn: &str, for_analysis: bool) -> BResult<TrackStreamResult> {
        self.require_token()?;
        let track_urn = track_urn.trim();
        if track_urn.is_empty() {
            return Err(BErr::msg("у трека отсутствует URN"));
        }
        let endpoint = self
            .v2_url(&format!("/tracks/{}", path_escape(track_urn)), &[])
            .map_err(|e| BErr::msg(format!("не удалось сформировать запрос метаданных трека: {e}")))?;
        let track = self.get_json(&endpoint).await.map_err(|e| e.context(|d| format!("не удалось получить потоки трека из SoundCloud: {d}")))?;
        let transcodings: Vec<Transcoding> = track
            .get("media")
            .and_then(|media| varr(media, "transcodings"))
            .map(|items| items.iter().map(parse_transcoding).collect())
            .unwrap_or_default();
        let choices = if for_analysis {
            analysis_transcoding_choices(&transcodings)
        } else {
            transcoding_choices(&transcodings, &vs(&track, "preview_mp3_128_url"))
        };
        if choices.is_empty() {
            log::warn!("track.stream stage=unavailable track_urn={track_urn:?} transcoding_count={}", transcodings.len());
            return Err(BErr::msg("SoundCloud не предоставил для этого трека AAC HLS-поток или превью"));
        }

        let mut last_err: Option<BErr> = None;
        let mut has_unsupported_drm = false;
        for (index, choice) in choices.iter().enumerate() {
            if choice.protocol.contains("encrypted-hls") {
                // Encrypted HLS needs FairPlay/Widevine/PlayReady; the HTML audio + hls.js player
                // has no DRM licence flow.
                has_unsupported_drm = true;
                log::info!("track.stream stage=unsupported_drm track_urn={track_urn:?} protocol={:?}", choice.protocol);
                continue;
            }
            // Choices are already ordered by preference, and the player uses only the primary one,
            // so the first transcoding that resolves wins instead of resolving every alternative.
            let resolved_url = match self.resolve_transcoding(&choice.url).await {
                Ok(url) => url,
                Err(e) => {
                    log::warn!("track.stream stage=fallback track_urn={track_urn:?} attempt={}/{} protocol={:?} error={e}", index + 1, choices.len(), choice.protocol);
                    last_err = Some(e);
                    continue;
                }
            };
            let valid = Url::parse(&resolved_url).ok().is_some_and(|u| u.scheme() == "https" && u.host_str().is_some_and(is_soundcloud_media_host));
            if !valid {
                let e = BErr::msg("SoundCloud не вернул корректную CDN-ссылку аудиопотока");
                log::warn!("track.stream stage=fallback track_urn={track_urn:?} attempt={}/{} error={e}", index + 1, choices.len());
                last_err = Some(e);
                continue;
            }
            return Ok(TrackStreamResult {
                url: resolved_url,
                preview: choice.preview,
                hls: choice.hls,
                quality: choice.quality.clone(),
                alternatives: Vec::new(),
            });
        }
        if has_unsupported_drm {
            return Err(BErr::msg("этот трек доступен только в DRM-защищённом потоке SoundCloud, который текущий плеер не поддерживает"));
        }
        // A refused session is not a property of this track: report it as itself.
        if let Some(e) = last_err.clone().filter(|e| e.is_auth()) {
            return Err(e);
        }
        let cause = last_err.map(|e| e.to_string()).unwrap_or_else(|| "<nil>".into());
        Err(BErr::msg(format!("не удалось получить ни один доступный поток SoundCloud: {cause}")))
    }

    async fn resolve_transcoding(&self, transcoding_url: &str) -> BResult<String> {
        let parsed = Url::parse(transcoding_url).ok().filter(|u| u.scheme() == "https").ok_or_else(|| BErr::msg("SoundCloud вернул некорректную ссылку транскодирования"))?;
        let host = parsed.host_str().unwrap_or("");
        if host.eq_ignore_ascii_case("api-v2.soundcloud.com") {
            let endpoint = self.v2_from_absolute(transcoding_url).map_err(|e| BErr::msg(format!("SoundCloud вернул некорректную ссылку транскодирования: {e}")))?;
            let resolved = self.get_json(&endpoint).await.map_err(|e| e.context(|d| format!("не удалось получить CDN-ссылку SoundCloud: {d}")))?;
            return Ok(vs(&resolved, "url"));
        }
        if is_soundcloud_media_host(host) {
            // Preview/HLS URLs can already point straight at the media CDN.
            return Ok(transcoding_url.to_string());
        }
        Err(BErr::msg("SoundCloud вернул ссылку потока с неизвестного домена"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcoding(preset: &str, protocol: &str, mime: &str, url: &str) -> Transcoding {
        Transcoding { url: url.into(), preset: preset.into(), protocol: protocol.into(), mime_type: mime.into() }
    }

    #[test]
    fn full_streams_are_prioritised_over_preview_hls() {
        let choices = transcoding_choices(
            &[
                transcoding("aac_160k_preview", "hls", "audio/mp4", "https://api-v2.soundcloud.com/preview/aac"),
                transcoding("aac_160k", "hls", "audio/mp4", "https://api-v2.soundcloud.com/media/aac"),
            ],
            "",
        );
        assert_eq!(choices.len(), 2);
        assert!(!choices[0].preview, "full HLS stream must come before the preview");
        assert!(choices[1].preview);
    }

    #[test]
    fn preview_is_recognised_from_the_url() {
        let choices = transcoding_choices(&[transcoding("aac_160k", "hls", "audio/mp4", "https://api-v2.soundcloud.com/media/preview/aac")], "");
        assert_eq!(choices.len(), 1);
        assert!(choices[0].preview);
    }

    #[test]
    fn aac_streams_sort_by_bitrate_and_label_it() {
        let choices = transcoding_choices(
            &[
                transcoding("aac_96k", "hls", "audio/mp4", "https://x/96"),
                transcoding("aac_256k", "hls", "audio/mp4", "https://x/256"),
                transcoding("mp3_standard", "progressive", "audio/mpeg", "https://x/mp3"),
            ],
            "https://cdn.sndcdn.com/p.m3u8",
        );
        let labels: Vec<_> = choices.iter().map(|c| c.quality.as_str()).collect();
        assert_eq!(labels, ["AAC 256 kbps", "AAC 96 kbps", "Progressive", "Превью MP3"]);
        assert!(choices[3].hls && choices[3].preview);
    }

    #[test]
    fn analysis_uses_only_full_progressive_streams() {
        let streams = [
            transcoding("aac_160k", "hls", "audio/mp4", "https://x/full-hls"),
            transcoding("mp3_standard", "progressive", "audio/mpeg", "https://x/full-mp3"),
            transcoding("mp3_preview", "progressive", "audio/mpeg", "https://x/preview"),
        ];
        let choices = analysis_transcoding_choices(&streams);
        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0].url, "https://x/full-mp3", "prefer progressive audio when available");
        assert_eq!(choices[1].url, "https://x/full-hls", "keep a full HLS stream as fallback");
        let hls_only = analysis_transcoding_choices(&streams[..1]);
        assert_eq!(hls_only.len(), 1);
        assert!(hls_only[0].hls, "full HLS stream is the fallback when no progressive stream exists");
    }

    #[test]
    fn media_hosts_are_restricted_to_soundcloud_cdns() {
        assert!(is_soundcloud_media_host("cf-hls-media.sndcdn.com"));
        assert!(is_soundcloud_media_host("x.soundcloud.cloud"));
        assert!(!is_soundcloud_media_host("sndcdn.com.evil.test"));
    }
}
