//! Download and decode SoundCloud streams into mono 16 kHz PCM for local lyric recognition.

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use m3u8_rs::{KeyMethod, Playlist};
use reqwest::{Client, header::RANGE};
use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    errors::Error as SymphoniaError,
    formats::{FormatOptions, TrackType},
    io::MediaSourceStream,
    meta::MetadataOptions,
};
use url::Url;

const MAX_PLAYLIST_BYTES: usize = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES: usize = 128 * 1024 * 1024;
const MAX_AUDIO_SECONDS: usize = 10 * 60;
const TARGET_RATE: usize = 16_000;

fn checked_url(base: &Url, reference: &str) -> Result<Url, String> {
    let url = base
        .join(reference)
        .map_err(|e| format!("invalid SoundCloud segment URL: {e}"))?;
    if url.scheme() != "https"
        || !super::stream::is_soundcloud_media_host(url.host_str().unwrap_or_default())
    {
        return Err("SoundCloud returned a segment URL outside its trusted media hosts".into());
    }
    Ok(url)
}

fn ensure_current(generation: &AtomicU64, expected: u64) -> Result<(), String> {
    if generation.load(Ordering::SeqCst) != expected {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}

async fn fetch_body(
    client: &Client,
    url: &Url,
    range: Option<(u64, u64)>,
    max: usize,
    generation: &AtomicU64,
    expected: u64,
) -> Result<Vec<u8>, String> {
    ensure_current(generation, expected)?;
    let mut request = client.get(url.clone());
    if let Some((start, end)) = range {
        request = request.header(RANGE, format!("bytes={start}-{end}"));
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("SoundCloud audio request failed: {e}"))?;
    let final_url = response.url();
    if final_url.scheme() != "https"
        || !super::stream::is_soundcloud_media_host(final_url.host_str().unwrap_or_default())
    {
        return Err("SoundCloud redirected audio to an untrusted host".into());
    }
    let response = response
        .error_for_status()
        .map_err(|e| format!("SoundCloud audio request failed: {e}"))?;
    ensure_current(generation, expected)?;
    if let Some(length) = response.content_length()
        && length as usize > max {
            return Err("SoundCloud audio exceeds the local recognition size limit".into());
        }
    let mut body = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("could not read SoundCloud audio: {e}"))?
    {
        ensure_current(generation, expected)?;
        if body
            .len()
            .checked_add(chunk.len())
            .is_none_or(|len| len > max)
        {
            return Err("SoundCloud audio exceeds the local recognition size limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    ensure_current(generation, expected)?;
    Ok(body)
}

fn append_range(out: &mut Vec<u8>, bytes: &[u8], offset: u64, length: u64) -> Result<(), String> {
    let start = usize::try_from(offset).map_err(|_| "invalid HLS byte range")?;
    let length = usize::try_from(length).map_err(|_| "invalid HLS byte range")?;
    let end = start.checked_add(length).ok_or("invalid HLS byte range")?;
    let slice = bytes
        .get(start..end)
        .ok_or("SoundCloud returned a truncated HLS byte range")?;
    if out
        .len()
        .checked_add(slice.len())
        .is_none_or(|len| len > MAX_AUDIO_BYTES)
    {
        return Err("SoundCloud audio exceeds the local recognition size limit".into());
    }
    out.extend_from_slice(slice);
    Ok(())
}

async fn fetch_hls(
    client: &Client,
    url: &Url,
    generation: &AtomicU64,
    expected: u64,
) -> Result<Vec<u8>, String> {
    let playlist_bytes =
        fetch_body(client, url, None, MAX_PLAYLIST_BYTES, generation, expected).await?;
    let (playlist, playlist_url) = match m3u8_rs::parse_playlist_res(&playlist_bytes)
        .map_err(|e| format!("invalid SoundCloud HLS playlist: {e:?}"))?
    {
        Playlist::MediaPlaylist(playlist) => (playlist, url.clone()),
        Playlist::MasterPlaylist(master) => {
            let variant = master
                .variants
                .iter()
                .filter(|v| !v.is_i_frame)
                .max_by_key(|v| v.average_bandwidth.unwrap_or(v.bandwidth))
                .ok_or("SoundCloud HLS playlist has no audio variants")?;
            let variant_url = checked_url(url, &variant.uri)?;
            let variant_bytes = fetch_body(
                client,
                &variant_url,
                None,
                MAX_PLAYLIST_BYTES,
                generation,
                expected,
            )
            .await?;
            let playlist = match m3u8_rs::parse_playlist_res(&variant_bytes)
                .map_err(|e| format!("invalid SoundCloud HLS variant playlist: {e:?}"))?
            {
                Playlist::MediaPlaylist(playlist) => playlist,
                Playlist::MasterPlaylist(_) => {
                    return Err("nested SoundCloud HLS master playlist is unsupported".into());
                }
            };
            (playlist, variant_url)
        }
    };
    if playlist.segments.iter().any(|segment| {
        segment
            .key
            .as_ref()
            .is_some_and(|key| key.method != KeyMethod::None)
    }) {
        return Err(
            "encrypted SoundCloud HLS streams are not supported for local recognition".into(),
        );
    }

    let mut output = Vec::new();
    let mut map_range_cache: Option<(String, Vec<u8>)> = None;
    let mut map_written = false;
    let mut previous_range_end: Option<u64> = None;
    let mut media_range_url: Option<String> = None;
    for segment in &playlist.segments {
        let segment_url = checked_url(&playlist_url, &segment.uri)?;
        if let Some(map) = &segment.map {
            let map_url = checked_url(&playlist_url, &map.uri)?;
            let map_key = map_url.as_str().to_owned();
            if map_range_cache
                .as_ref()
                .is_none_or(|(key, _)| key != &map_key)
            {
                let bytes = fetch_body(
                    client,
                    &map_url,
                    None,
                    MAX_AUDIO_BYTES,
                    generation,
                    expected,
                )
                .await?;
                map_range_cache = Some((map_key.clone(), bytes));
            }
            if !map_written {
                let (_, bytes) = map_range_cache
                    .as_ref()
                    .ok_or("missing HLS initialization section")?;
                if let Some(range) = &map.byte_range {
                    append_range(&mut output, bytes, range.offset.unwrap_or(0), range.length)?;
                } else {
                    if output
                        .len()
                        .checked_add(bytes.len())
                        .is_none_or(|len| len > MAX_AUDIO_BYTES)
                    {
                        return Err(
                            "SoundCloud audio exceeds the local recognition size limit".into()
                        );
                    }
                    output.extend_from_slice(bytes);
                }
                map_written = true;
            }
        }
        let range = if let Some(byte_range) = &segment.byte_range {
            let offset = if let Some(offset) = byte_range.offset {
                offset
            } else if media_range_url.as_deref() == Some(segment_url.as_str()) {
                previous_range_end.unwrap_or(0)
            } else {
                0
            };
            let end = offset
                .checked_add(byte_range.length)
                .and_then(|value| value.checked_sub(1))
                .ok_or("invalid HLS byte range")?;
            media_range_url = Some(segment_url.as_str().to_owned());
            previous_range_end = Some(end.saturating_add(1));
            Some((offset, end))
        } else {
            media_range_url = None;
            previous_range_end = None;
            None
        };
        let bytes = fetch_body(
            client,
            &segment_url,
            range,
            MAX_AUDIO_BYTES.saturating_sub(output.len()),
            generation,
            expected,
        )
        .await?;
        if output
            .len()
            .checked_add(bytes.len())
            .is_none_or(|len| len > MAX_AUDIO_BYTES)
        {
            return Err("SoundCloud audio exceeds the local recognition size limit".into());
        }
        output.extend_from_slice(&bytes);
    }
    if output.is_empty() {
        return Err("SoundCloud HLS playlist contains no audio segments".into());
    }
    Ok(output)
}

fn decode_audio(
    bytes: Vec<u8>,
    generation: Arc<AtomicU64>,
    expected: u64,
) -> Result<Vec<f32>, String> {
    let source = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes)), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &Default::default(),
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("could not read SoundCloud audio: {e}"))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("SoundCloud stream has no audio track")?;
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .ok_or("SoundCloud audio has no codec information")?
        .audio()
        .ok_or("SoundCloud stream has no audio codec")?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported SoundCloud audio codec: {e}"))?;
    let mut mono = Vec::new();
    let mut source_rate = 0usize;
    loop {
        ensure_current(&generation, expected)?;
        if generation.load(Ordering::SeqCst) != expected {
            return Err("cancelled".into());
        }
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) | Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(error) => {
                return Err(format!(
                    "SoundCloud audio stream could not be demuxed: {error}"
                ));
            }
        };
        if packet.track_id != track_id {
            continue;
        }
        let audio = match decoder.decode(&packet) {
            Ok(audio) => audio,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(error) => return Err(format!("SoundCloud audio decoding failed: {error}")),
        };
        let rate = audio.spec().rate() as usize;
        let channels = audio.spec().channels().count().max(1);
        if rate == 0 {
            continue;
        }
        source_rate = rate;
        let mut interleaved = vec![0.0f32; audio.frames() * channels];
        audio.copy_to_slice_interleaved(&mut interleaved);
        for frame in interleaved.chunks_exact(channels) {
            mono.push(frame.iter().sum::<f32>() / channels as f32);
            if mono.len() >= MAX_AUDIO_SECONDS * rate {
                break;
            }
        }
        if mono.len() >= MAX_AUDIO_SECONDS * rate {
            break;
        }
    }
    if mono.is_empty() || source_rate == 0 {
        return Err("SoundCloud stream did not contain decodable audio".into());
    }
    if source_rate == TARGET_RATE {
        return Ok(mono);
    }
    let target_len = mono.len().saturating_mul(TARGET_RATE) / source_rate;
    if target_len < 16_000 {
        return Err("SoundCloud audio is too short for recognition".into());
    }
    let mut resampled = Vec::with_capacity(target_len);
    for index in 0..target_len {
        let pos = index as f64 * source_rate as f64 / TARGET_RATE as f64;
        let left = pos.floor() as usize;
        let frac = (pos - left as f64) as f32;
        let a = mono[left.min(mono.len() - 1)];
        let b = mono[(left + 1).min(mono.len() - 1)];
        resampled.push(a + (b - a) * frac);
    }
    Ok(resampled)
}

pub async fn analysis_audio_to_pcm(
    http: Client,
    url: Url,
    is_hls: bool,
    generation: Arc<AtomicU64>,
    expected: u64,
) -> Result<Vec<f32>, String> {
    let bytes = if is_hls {
        fetch_hls(&http, &url, &generation, expected).await?
    } else {
        fetch_body(&http, &url, None, MAX_AUDIO_BYTES, &generation, expected).await?
    };
    ensure_current(&generation, expected)?;
    tokio::task::spawn_blocking(move || decode_audio(bytes, generation, expected))
        .await
        .map_err(|e| format!("audio decoding task failed: {e}"))?
}
