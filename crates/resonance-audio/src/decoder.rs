use anyhow::{Context, Result, anyhow};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions, CODEC_ID_NULL_AUDIO};
use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::common::Tier;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::{Hint, Probe};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Time;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeRead {
    Frames(usize),
    EndOfStream,
}

pub struct DecodedStream {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<symphonia::core::units::TimeBase>,
    src_rate: u32,
    src_channels: usize,
    dst_rate: u32,
    duration_sec: Option<f64>,
    position_sec: f64,
    src_stereo: Vec<f32>,
    src_frame_pos: f64,
    packet_scratch: Vec<f32>,
    eof: bool,
}

fn build_codec_registry() -> CodecRegistry {
    let mut registry = CodecRegistry::new();
    symphonia::default::register_enabled_codecs(&mut registry);
    registry.register_audio_decoder_at_tier::<symphonia_opus::OpusDecoder>(Tier::Fallback);
    registry
}

fn build_probe() -> Probe {
    let mut probe = Probe::default();
    symphonia::default::register_enabled_formats(&mut probe);
    probe
}

impl DecodedStream {
    pub fn open(
        source: Box<dyn MediaSource>,
        ext_hint: Option<&str>,
        dst_rate: u32,
    ) -> Result<Self> {
        let mut hint = Hint::new();
        if let Some(ext) = ext_hint {
            hint.with_extension(ext);
        }

        let mss = MediaSourceStream::new(source, Default::default());
        let probe = build_probe();
        let format = probe
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .context("unable to probe audio stream format")?;

        let (track_id, time_base, audio_params, src_rate, src_channels, duration_sec) = {
            let track = format
                .default_track(TrackType::Audio)
                .ok_or_else(|| anyhow!("no supported audio track found"))?;

            let track_id = track.id;
            let time_base = track.time_base;
            let Some(CodecParameters::Audio(audio_params)) = &track.codec_params else {
                return Err(anyhow!("selected track has no audio codec parameters"));
            };
            if audio_params.codec == CODEC_ID_NULL_AUDIO {
                return Err(anyhow!("unknown audio codec"));
            }

            let src_rate = audio_params.sample_rate.unwrap_or(dst_rate).max(8000);
            let src_channels = audio_params
                .channels
                .as_ref()
                .map(|c| c.count())
                .unwrap_or(2)
                .max(1);

            let duration_sec = track
                .num_frames
                .and_then(|frames| {
                    let base = audio_params.sample_rate.unwrap_or(src_rate);
                    if base > 0 {
                        Some(frames as f64 / base as f64)
                    } else {
                        None
                    }
                })
                .or_else(|| {
                    time_base.and_then(|tb| {
                        format
                            .media_info()
                            .duration
                            .and_then(|d| tb.calc_duration(d))
                            .map(|t| t.as_secs_f64())
                    })
                });

            (
                track_id,
                time_base,
                audio_params.clone(),
                src_rate,
                src_channels,
                duration_sec,
            )
        };

        let codecs = build_codec_registry();
        let decoder = codecs
            .make_audio_decoder(&audio_params, &AudioDecoderOptions::default())
            .context("failed to initialize audio decoder")?;

        Ok(Self {
            format,
            decoder,
            track_id,
            time_base,
            src_rate,
            src_channels,
            dst_rate: dst_rate.max(8000),
            duration_sec,
            position_sec: 0.0,
            src_stereo: Vec::new(),
            src_frame_pos: 0.0,
            packet_scratch: Vec::new(),
            eof: false,
        })
    }

    pub fn duration_sec(&self) -> Option<f64> {
        self.duration_sec
    }

    pub fn position_sec(&self) -> f64 {
        self.position_sec
    }

    pub fn set_dst_rate(&mut self, dst_rate: u32) {
        self.dst_rate = dst_rate.max(8000);
    }

    pub fn seek(&mut self, target_sec: f64) -> Result<()> {
        let clamped = target_sec.max(0.0);
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::try_from_secs_f64(clamped).unwrap_or_default(),
                    track_id: Some(self.track_id),
                },
            )
            .context("seek failed")?;
        self.decoder.reset();
        self.src_stereo.clear();
        self.src_frame_pos = 0.0;
        self.eof = false;
        self.position_sec = self
            .time_base
            .and_then(|tb| tb.calc_time(seeked.actual_ts))
            .map(|t| t.as_secs_f64())
            .unwrap_or(clamped);
        Ok(())
    }

    fn decode_next_packet(&mut self) -> Result<bool> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => {
                    self.eof = true;
                    return Ok(false);
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(e) => return Err(e.into()),
            };

            if packet.track_id != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(buf) => buf,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(e) => return Err(e.into()),
            };

            let spec = decoded.spec().clone();
            let rate = spec.rate();
            if rate > 0 {
                self.src_rate = rate;
            }
            let ch = spec.channels().count().max(1);
            self.src_channels = ch;

            self.packet_scratch.clear();
            decoded.copy_to_vec_interleaved(&mut self.packet_scratch);
            if self.packet_scratch.is_empty() {
                continue;
            }

            // Normalize to interleaved stereo [L, R, ...] in src_stereo
            let consume_idx = (self.src_frame_pos.floor() as usize) * 2;
            if consume_idx > 0 && consume_idx <= self.src_stereo.len() {
                self.src_stereo.drain(..consume_idx);
                self.src_frame_pos -= (consume_idx / 2) as f64;
            } else if consume_idx >= self.src_stereo.len() {
                self.src_stereo.clear();
                self.src_frame_pos = 0.0;
            }

            let frames = self.packet_scratch.len() / ch;
            self.src_stereo.reserve(frames * 2);
            for f in 0..frames {
                let base = f * ch;
                let l = self.packet_scratch[base];
                let r = if ch >= 2 { self.packet_scratch[base + 1] } else { l };
                self.src_stereo.push(l);
                self.src_stereo.push(r);
            }

            if let Some(t) = self.time_base.and_then(|tb| tb.calc_time(packet.pts)) {
                self.position_sec = t.as_secs_f64();
            }
            return Ok(true);
        }
    }

    /// Fill `out` with stereo interleaved `f32` samples (`out.len()` must be even).
    pub fn read_stereo_frames(&mut self, out: &mut [f32]) -> Result<DecodeRead> {
        let max_frames = out.len() / 2;
        if max_frames == 0 {
            return Ok(DecodeRead::Frames(0));
        }

        let mut written_frames = 0usize;
        while written_frames < max_frames {
            let avail_frames = self.src_stereo.len() / 2;
            let step = self.src_rate as f64 / self.dst_rate as f64;

            if avail_frames >= 2 && self.src_frame_pos + 1.0 < avail_frames as f64 {
                while written_frames < max_frames {
                    let avail = self.src_stereo.len() / 2;
                    let idx0 = self.src_frame_pos.floor() as usize;
                    if idx0 + 1 >= avail {
                        break;
                    }
                    let frac = (self.src_frame_pos - idx0 as f64) as f32;
                    let l0 = self.src_stereo[idx0 * 2];
                    let r0 = self.src_stereo[idx0 * 2 + 1];
                    let l1 = self.src_stereo[(idx0 + 1) * 2];
                    let r1 = self.src_stereo[(idx0 + 1) * 2 + 1];

                    out[written_frames * 2] = l0 + (l1 - l0) * frac;
                    out[written_frames * 2 + 1] = r0 + (r1 - r0) * frac;
                    written_frames += 1;
                    self.src_frame_pos += step;
                }
                continue;
            }

            if self.eof {
                // Flush the very last sample if one remains cleanly
                let avail = self.src_stereo.len() / 2;
                let idx0 = self.src_frame_pos.floor() as usize;
                if idx0 < avail && written_frames < max_frames {
                    out[written_frames * 2] = self.src_stereo[idx0 * 2];
                    out[written_frames * 2 + 1] = self.src_stereo[idx0 * 2 + 1];
                    written_frames += 1;
                    self.src_frame_pos += step;
                    continue;
                }
                break;
            }

            if !self.decode_next_packet()? {
                break;
            }
        }

        if written_frames == 0 && self.eof {
            Ok(DecodeRead::EndOfStream)
        } else {
            self.position_sec += written_frames as f64 / self.dst_rate as f64;
            Ok(DecodeRead::Frames(written_frames))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;
    use std::io::Cursor;

    fn make_wav(sample_rate: u32, freq_hz: f32, secs: f32) -> Vec<u8> {
        let frames = (sample_rate as f32 * secs) as u32;
        let data_bytes = frames * 4;
        let mut wav = Vec::with_capacity(44 + data_bytes as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&2u16.to_le_bytes()); // stereo
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        for i in 0..frames {
            let s = ((TAU * freq_hz * (i as f32 / sample_rate as f32)).sin() * 16000.0) as i16;
            wav.extend_from_slice(&s.to_le_bytes());
            wav.extend_from_slice(&s.to_le_bytes());
        }
        wav
    }

    #[test]
    fn decodes_and_resamples_wav_and_seeks() {
        let wav = make_wav(44_100, 440.0, 0.5);
        let mut dec = DecodedStream::open(Box::new(Cursor::new(wav)), Some("wav"), 48_000).unwrap();
        let mut buf = vec![0.0f32; 2048];
        let DecodeRead::Frames(n) = dec.read_stereo_frames(&mut buf).unwrap() else {
            panic!("expected decoded frames");
        };
        assert!(n > 0);
        assert!(dec.duration_sec().unwrap_or(0.0) > 0.45);
        dec.seek(0.25).unwrap();
        assert!(dec.position_sec() >= 0.2);
    }
}
