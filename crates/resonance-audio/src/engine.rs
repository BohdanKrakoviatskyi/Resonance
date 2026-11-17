use std::collections::VecDeque;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use resonance_core::crossfade_plan::{compute_crossfade_pair, pos_to_volume};
use resonance_core::models::{CrossfadeCurve, EqPreset, NormalizationTarget, PlaybackStatus};

use crate::decoder::{DecodeRead, DecodedStream};
use crate::dsp::{LoudnessAndLimiter, SpectrumTap, StereoEqChain};
use crate::stream_source::open_media_source;

const RING_MAX_SAMPLES: usize = 48_000 * 2 * 2; // 2s stereo ring per deck

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioSnapshot {
    pub status: PlaybackStatus,
    pub position: f64,
    pub duration: f64,
    pub track_generation: u64,
    pub ended_generation: u64,
    pub crossfade_started_generation: u64,
    pub is_crossfading: bool,
    pub preview_active: bool,
    pub error: Option<String>,
}

struct DeckSlot {
    generation: u64,
    paused: bool,
    ring: VecDeque<f32>,
    eof: bool,
    position_sec: f64,
    duration_sec: Option<f64>,
    cancel: Arc<AtomicBool>,
    gain: f32,
    seek_tx: Option<std::sync::mpsc::Sender<f64>>,
    error: Option<String>,
}

impl DeckSlot {
    fn new(generation: u64, paused: bool) -> Self {
        Self {
            generation,
            paused,
            ring: VecDeque::with_capacity(48_000 * 2),
            eof: false,
            position_sec: 0.0,
            duration_sec: None,
            cancel: Arc::new(AtomicBool::new(false)),
            gain: 1.0,
            seek_tx: None,
            error: None,
        }
    }

    fn cancel_thread(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

struct CrossfadeRuntime {
    started_at: Instant,
    duration_sec: f64,
    curve: CrossfadeCurve,
}

struct SharedMixer {
    sample_rate: f64,
    primary: Option<DeckSlot>,
    incoming: Option<DeckSlot>,
    preview: Option<DeckSlot>,
    crossfade: Option<CrossfadeRuntime>,
    volume_pos: f32,
    muted: bool,
    eq: StereoEqChain,
    norm: LoudnessAndLimiter,
    spectrum: SpectrumTap,
    last_ended_gen: u64,
    last_xfade_gen: u64,
    last_error: Option<String>,
    fft_scratch: Vec<f32>,
}

impl SharedMixer {
    fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            primary: None,
            incoming: None,
            preview: None,
            crossfade: None,
            volume_pos: 0.72,
            muted: false,
            eq: StereoEqChain::new(sample_rate),
            norm: LoudnessAndLimiter::new(sample_rate as f32),
            spectrum: SpectrumTap::new(sample_rate),
            last_ended_gen: 0,
            last_xfade_gen: 0,
            last_error: None,
            fft_scratch: vec![0.0; 2048],
        }
    }

    fn render_callback(&mut self, output: &mut [f32]) {
        let frames = output.len() / 2;
        if frames == 0 {
            return;
        }
        output.fill(0.0);

        if let Some(ref mut prev) = self.preview {
            if !prev.paused {
                let mut i = 0;
                while i < frames {
                    if prev.ring.len() >= 2 {
                        let l = prev.ring.pop_front().unwrap_or(0.0);
                        let r = prev.ring.pop_front().unwrap_or(0.0);
                        output[i * 2] = l;
                        output[i * 2 + 1] = r;
                        prev.position_sec += 1.0 / self.sample_rate;
                    } else {
                        break;
                    }
                    i += 1;
                }
                if prev.eof && prev.ring.is_empty() {
                    self.preview = None;
                }
            }
            return;
        }

        // Advance crossfade gains if active
        if let Some(ref xf) = self.crossfade {
            let p = (xf.started_at.elapsed().as_secs_f64() / xf.duration_sec.max(0.05)).clamp(0.0, 1.0);
            let (from_gain, to_gain) = compute_crossfade_pair(p, xf.curve);
            if let Some(ref mut pr) = self.primary {
                pr.gain = from_gain;
            }
            if let Some(ref mut inc) = self.incoming {
                inc.gain = to_gain;
            }
            if p >= 1.0 {
                if let Some(mut old) = self.primary.take() {
                    old.cancel_thread();
                }
                if let Some(mut inc) = self.incoming.take() {
                    inc.gain = 1.0;
                    self.primary = Some(inc);
                }
                self.crossfade = None;
            }
        }

        let master_vol = if self.muted { 0.0 } else { pos_to_volume(self.volume_pos) };

        let mut promote_incoming = false;
        let mut primary_finished_gen = None;

        for f in 0..frames {
            let mut sum_l = 0.0f32;
            let mut sum_r = 0.0f32;
            let mut any_active = false;

            if let Some(ref mut pr) = self.primary
                && !pr.paused {
                    if pr.ring.len() >= 2 {
                        let l = pr.ring.pop_front().unwrap_or(0.0);
                        let r = pr.ring.pop_front().unwrap_or(0.0);
                        sum_l += l * pr.gain;
                        sum_r += r * pr.gain;
                        pr.position_sec += 1.0 / self.sample_rate;
                        any_active = true;
                    } else if pr.eof {
                        primary_finished_gen = Some(pr.generation);
                        if self.incoming.is_some() {
                            promote_incoming = true;
                        }
                    }
                }

            if let Some(ref mut inc) = self.incoming
                && !inc.paused {
                    if inc.ring.len() >= 2 {
                        let l = inc.ring.pop_front().unwrap_or(0.0);
                        let r = inc.ring.pop_front().unwrap_or(0.0);
                        sum_l += l * inc.gain;
                        sum_r += r * inc.gain;
                        inc.position_sec += 1.0 / self.sample_rate;
                        any_active = true;
                    } else if inc.eof && self.primary.is_none() {
                        primary_finished_gen = Some(inc.generation);
                    }
                }

            if any_active {
                let (eq_l, eq_r) = self.eq.process_stereo_frame(sum_l, sum_r);
                let (nl, nr) = self.norm.process_stereo_frame(eq_l, eq_r);
                output[f * 2] = nl * master_vol;
                output[f * 2 + 1] = nr * master_vol;
                if f * 2 + 1 < self.fft_scratch.len() {
                    self.fft_scratch[f * 2] = nl;
                    self.fft_scratch[f * 2 + 1] = nr;
                }
            } else if f * 2 + 1 < self.fft_scratch.len() {
                self.fft_scratch[f * 2] = 0.0;
                self.fft_scratch[f * 2 + 1] = 0.0;
            }
        }

        let cap = (frames * 2).min(self.fft_scratch.len());
        self.spectrum.try_push_stereo(&self.fft_scratch[..cap], self.sample_rate);

        if promote_incoming {
            if let Some(mut old) = self.primary.take() {
                old.cancel_thread();
            }
            if let Some(mut inc) = self.incoming.take() {
                inc.gain = 1.0;
                self.primary = Some(inc);
            }
            self.crossfade = None;
        } else if let Some(ended_gen) = primary_finished_gen {
            if let Some(ref err) = self.primary.as_ref().and_then(|p| p.error.clone()) {
                self.last_error = Some(err.clone());
            }
            self.primary = None;
            self.last_ended_gen = ended_gen;
        }
    }
}

pub struct AudioEngine {
    rt: tokio::runtime::Handle,
    http: reqwest::Client,
    mixer: Arc<Mutex<SharedMixer>>,
    _stream: Option<cpal::Stream>,
    generation_seq: AtomicU64,
}

impl AudioEngine {
    pub fn new(rt: tokio::runtime::Handle, http: reqwest::Client) -> Self {
        let host = cpal::default_host();
        let (stream, sample_rate) = Self::build_output_stream(&host)
            .unwrap_or_else(|e| {
                log::warn!("cpal output init failed (running muted headless fallback): {e}");
                (None, 48_000.0)
            });

        let mixer = Arc::new(Mutex::new(SharedMixer::new(sample_rate)));
        let _stream = if let Some((device, config)) = stream {
            let mixer_cb = mixer.clone();
            match device.build_output_stream(
                config,
                move |data: &mut [f32], _| {
                    if let Ok(mut guard) = mixer_cb.try_lock() {
                        guard.render_callback(data);
                    } else {
                        data.fill(0.0);
                    }
                },
                |err| log::error!("cpal stream error: {err}"),
                None,
            ) {
                Ok(s) => {
                    if let Err(e) = s.play() {
                        log::error!("cpal stream play failed: {e}");
                    }
                    Some(s)
                }
                Err(e) => {
                    log::error!("cpal build_output_stream failed: {e}");
                    None
                }
            }
        } else {
            None
        };

        Self {
            rt,
            http,
            mixer,
            _stream,
            generation_seq: AtomicU64::new(1),
        }
    }

    fn build_output_stream(host: &cpal::Host) -> Result<(Option<(cpal::Device, cpal::StreamConfig)>, f64)> {
        let device = host
            .default_output_device()
            .ok_or_else(|| anyhow!("no default output audio device"))?;
        let supported = device.default_output_config()?;
        let rate = supported.sample_rate() as f64;
        let config = cpal::StreamConfig {
            channels: 2,
            sample_rate: supported.sample_rate(),
            buffer_size: cpal::BufferSize::Default,
        };
        Ok((Some((device, config)), rate))
    }

    fn spawn_decode_worker(
        &self,
        src: String,
        generation: u64,
        target_slot: DeckTarget,
        initial_seek: Option<f64>,
        start_paused: bool,
    ) {
        let cancel = Arc::new(AtomicBool::new(false));
        let (seek_tx, seek_rx) = std::sync::mpsc::channel::<f64>();
        let sample_rate = {
            let mut m = self.mixer.lock().unwrap();
            let mut slot = DeckSlot::new(generation, start_paused);
            slot.cancel = cancel.clone();
            slot.seek_tx = Some(seek_tx);
            if let Some(s) = initial_seek {
                slot.position_sec = s.max(0.0);
            }
            match target_slot {
                DeckTarget::Primary => {
                    if let Some(mut old) = m.primary.take() {
                        old.cancel_thread();
                    }
                    if let Some(mut inc) = m.incoming.take() {
                        inc.cancel_thread();
                    }
                    m.crossfade = None;
                    m.last_error = None;
                    m.primary = Some(slot);
                }
                DeckTarget::Incoming => {
                    if let Some(mut old) = m.incoming.take() {
                        old.cancel_thread();
                    }
                    m.incoming = Some(slot);
                }
                DeckTarget::Preview => {
                    if let Some(mut old) = m.preview.take() {
                        old.cancel_thread();
                    }
                    m.preview = Some(slot);
                }
            }
            m.sample_rate as u32
        };

        let rt = self.rt.clone();
        let http = self.http.clone();
        let mixer = self.mixer.clone();

        std::thread::Builder::new()
            .name(format!("res-decode-{generation}"))
            .spawn(move || {
                let opened = open_media_source(&rt, &http, &src, cancel.clone()).and_then(|(media, ext)| {
                    DecodedStream::open(media, ext.as_deref(), sample_rate)
                });
                let mut dec = match opened {
                    Ok(d) => d,
                    Err(e) => {
                        let msg = format!("{e}");
                        if let Ok(mut m) = mixer.lock() {
                            let slot = match target_slot {
                                DeckTarget::Primary => m.primary.as_mut(),
                                DeckTarget::Incoming => m.incoming.as_mut(),
                                DeckTarget::Preview => m.preview.as_mut(),
                            };
                            if let Some(s) = slot.filter(|s| s.generation == generation) {
                                s.error = Some(msg.clone());
                                s.eof = true;
                            }
                            if target_slot == DeckTarget::Primary {
                                m.last_error = Some(msg);
                            }
                        }
                        return;
                    }
                };

                if let Some(sec) = initial_seek.filter(|&v| v > 0.25) {
                    let _ = dec.seek(sec);
                }

                if let Ok(mut m) = mixer.lock() {
                    let slot = match target_slot {
                        DeckTarget::Primary => m.primary.as_mut(),
                        DeckTarget::Incoming => m.incoming.as_mut(),
                        DeckTarget::Preview => m.preview.as_mut(),
                    };
                    if let Some(s) = slot.filter(|s| s.generation == generation) {
                        s.duration_sec = dec.duration_sec();
                    }
                }

                let mut scratch = vec![0.0f32; 4096 * 2];
                while !cancel.load(Ordering::Relaxed) {
                    while let Ok(target) = seek_rx.try_recv() {
                        if let Ok(()) = dec.seek(target)
                            && let Ok(mut m) = mixer.lock() {
                                let slot = match target_slot {
                                    DeckTarget::Primary => m.primary.as_mut(),
                                    DeckTarget::Incoming => m.incoming.as_mut(),
                                    DeckTarget::Preview => m.preview.as_mut(),
                                };
                                if let Some(s) = slot.filter(|s| s.generation == generation) {
                                    s.ring.clear();
                                    s.position_sec = dec.position_sec();
                                    s.eof = false;
                                }
                            }
                    }

                    let ring_len = {
                        let Ok(m) = mixer.lock() else { break };
                        let slot = match target_slot {
                            DeckTarget::Primary => m.primary.as_ref(),
                            DeckTarget::Incoming => m.incoming.as_ref(),
                            DeckTarget::Preview => m.preview.as_ref(),
                        };
                        let Some(s) = slot.filter(|s| s.generation == generation) else {
                            break;
                        };
                        s.ring.len()
                    };

                    if ring_len >= RING_MAX_SAMPLES {
                        std::thread::sleep(Duration::from_millis(12));
                        continue;
                    }

                    match dec.read_stereo_frames(&mut scratch) {
                        Ok(DecodeRead::Frames(frames)) if frames > 0 => {
                            let Ok(mut m) = mixer.lock() else { break };
                            let slot = match target_slot {
                                DeckTarget::Primary => m.primary.as_mut(),
                                DeckTarget::Incoming => m.incoming.as_mut(),
                                DeckTarget::Preview => m.preview.as_mut(),
                            };
                            if let Some(s) = slot.filter(|s| s.generation == generation) {
                                s.ring.extend(&scratch[..frames * 2]);
                            } else {
                                break;
                            }
                        }
                        Ok(DecodeRead::EndOfStream) | Ok(DecodeRead::Frames(_)) => {
                            if let Ok(mut m) = mixer.lock() {
                                let slot = match target_slot {
                                    DeckTarget::Primary => m.primary.as_mut(),
                                    DeckTarget::Incoming => m.incoming.as_mut(),
                                    DeckTarget::Preview => m.preview.as_mut(),
                                };
                                if let Some(s) = slot.filter(|s| s.generation == generation) {
                                    s.eof = true;
                                }
                            }
                            break;
                        }
                        Err(e) => {
                            if let Ok(mut m) = mixer.lock() {
                                let slot = match target_slot {
                                    DeckTarget::Primary => m.primary.as_mut(),
                                    DeckTarget::Incoming => m.incoming.as_mut(),
                                    DeckTarget::Preview => m.preview.as_mut(),
                                };
                                if let Some(s) = slot.filter(|s| s.generation == generation) {
                                    s.error = Some(format!("{e}"));
                                    s.eof = true;
                                }
                            }
                            break;
                        }
                    }
                }
            })
            .expect("spawn audio decode thread");
    }

    pub fn play(&self, src: impl Into<String>, start_at_sec: Option<f64>) -> u64 {
        let next_gen = self.generation_seq.fetch_add(1, Ordering::Relaxed);
        self.spawn_decode_worker(src.into(), next_gen, DeckTarget::Primary, start_at_sec, false);
        next_gen
    }

    pub fn crossfade_to(
        &self,
        src: impl Into<String>,
        duration_sec: f64,
        curve: CrossfadeCurve,
    ) -> u64 {
        let next_gen = self.generation_seq.fetch_add(1, Ordering::Relaxed);
        self.spawn_decode_worker(src.into(), next_gen, DeckTarget::Incoming, None, false);
        if let Ok(mut m) = self.mixer.lock() {
            m.crossfade = Some(CrossfadeRuntime {
                started_at: Instant::now(),
                duration_sec: duration_sec.clamp(0.5, 12.0),
                curve,
            });
            if let Some(ref pr) = m.primary {
                m.last_xfade_gen = pr.generation;
            }
        }
        next_gen
    }

    pub fn pause(&self) {
        if let Ok(mut m) = self.mixer.lock() {
            if let Some(ref mut pr) = m.primary {
                pr.paused = true;
            }
            if let Some(ref mut inc) = m.incoming {
                inc.paused = true;
            }
        }
    }

    pub fn resume(&self) {
        if let Ok(mut m) = self.mixer.lock() {
            if let Some(ref mut pr) = m.primary {
                pr.paused = false;
            }
            if let Some(ref mut inc) = m.incoming {
                inc.paused = false;
            }
        }
    }

    pub fn stop(&self) {
        if let Ok(mut m) = self.mixer.lock() {
            if let Some(mut pr) = m.primary.take() {
                pr.cancel_thread();
            }
            if let Some(mut inc) = m.incoming.take() {
                inc.cancel_thread();
            }
            m.crossfade = None;
        }
    }

    pub fn seek(&self, sec: f64) {
        if let Ok(m) = self.mixer.lock()
            && let Some(ref pr) = m.primary
                && let Some(ref tx) = pr.seek_tx {
                    let _ = tx.send(sec.max(0.0));
                }
    }

    pub fn set_volume(&self, pos: f32, muted: bool) {
        if let Ok(mut m) = self.mixer.lock() {
            m.volume_pos = pos.clamp(0.0, 1.0);
            m.muted = muted;
        }
    }

    pub fn set_eq(&self, enabled: bool, _preset: EqPreset, bands: [f32; 5]) {
        if let Ok(mut m) = self.mixer.lock() {
            let sr = m.sample_rate;
            m.eq.update(enabled, bands, sr);
        }
    }

    pub fn set_normalization(&self, enabled: bool, target: NormalizationTarget) {
        if let Ok(mut m) = self.mixer.lock() {
            let sr = m.sample_rate as f32;
            m.norm.configure(enabled, target, sr);
        }
    }

    pub fn start_preview(&self, src: impl Into<String>) -> u64 {
        let next_gen = self.generation_seq.fetch_add(1, Ordering::Relaxed);
        self.pause();
        self.spawn_decode_worker(src.into(), next_gen, DeckTarget::Preview, None, false);
        next_gen
    }

    pub fn stop_preview(&self) {
        if let Ok(mut m) = self.mixer.lock()
            && let Some(mut prev) = m.preview.take() {
                prev.cancel_thread();
            }
    }

    pub fn read_spectrum_bars(&self, out: &mut [f32]) {
        let tap = {
            let Ok(m) = self.mixer.lock() else {
                out.fill(0.0);
                return;
            };
            m.spectrum.clone()
        };
        tap.read_bars(out.len(), out);
    }

    pub fn snapshot(&self) -> AudioSnapshot {
        let Ok(m) = self.mixer.lock() else {
            return AudioSnapshot::default();
        };
        let preview_active = m.preview.is_some();
        let is_crossfading = m.crossfade.is_some();
        if let Some(ref pr) = m.primary {
            let status = if pr.error.is_some() {
                PlaybackStatus::Error
            } else if pr.paused {
                PlaybackStatus::Paused
            } else if pr.ring.is_empty() && !pr.eof {
                PlaybackStatus::Loading
            } else {
                PlaybackStatus::Playing
            };
            AudioSnapshot {
                status,
                position: pr.position_sec,
                duration: pr.duration_sec.unwrap_or(0.0),
                track_generation: pr.generation,
                ended_generation: m.last_ended_gen,
                crossfade_started_generation: m.last_xfade_gen,
                is_crossfading,
                preview_active,
                error: pr.error.clone().or_else(|| m.last_error.clone()),
            }
        } else {
            AudioSnapshot {
                status: if m.last_error.is_some() {
                    PlaybackStatus::Error
                } else {
                    PlaybackStatus::Idle
                },
                position: 0.0,
                duration: 0.0,
                track_generation: 0,
                ended_generation: m.last_ended_gen,
                crossfade_started_generation: m.last_xfade_gen,
                is_crossfading,
                preview_active,
                error: m.last_error.clone(),
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DeckTarget {
    Primary,
    Incoming,
    Preview,
}
