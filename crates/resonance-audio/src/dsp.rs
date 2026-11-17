use std::sync::{Arc, Mutex};

use biquad::{Biquad, Coefficients, DirectForm2Transposed};
use resonance_core::eq_curve::{EQ_BANDS, bin_spectrum, coefficients as eq_coefficients};
use resonance_core::models::NormalizationTarget;
use rustfft::{FftPlanner, num_complex::Complex};

const FFT_SIZE: usize = 4096;
const SMOOTHING: f32 = 0.72;

#[derive(Clone)]
pub struct StereoEqChain {
    left: [DirectForm2Transposed<f32>; 5],
    right: [DirectForm2Transposed<f32>; 5],
    enabled: bool,
    gains: [f32; 5],
    sample_rate: f64,
}

fn make_biquad_coeffs(kind: resonance_core::eq_curve::EqFilterKind, f0: f64, gain_db: f64, sample_rate: f64) -> Coefficients<f32> {
    if gain_db.abs() < 1e-4 {
        return Coefficients {
            a1: 0.0,
            a2: 0.0,
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
        };
    }
    let c = eq_coefficients(kind, f0, gain_db, sample_rate);
    let inv_a0 = 1.0 / c.a0;
    Coefficients {
        b0: (c.b0 * inv_a0) as f32,
        b1: (c.b1 * inv_a0) as f32,
        b2: (c.b2 * inv_a0) as f32,
        a1: (c.a1 * inv_a0) as f32,
        a2: (c.a2 * inv_a0) as f32,
    }
}

impl StereoEqChain {
    pub fn new(sample_rate: f64) -> Self {
        let unity = Coefficients {
            a1: 0.0,
            a2: 0.0,
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
        };
        let filters = || std::array::from_fn(|_| DirectForm2Transposed::<f32>::new(unity));
        Self {
            left: filters(),
            right: filters(),
            enabled: false,
            gains: [0.0; 5],
            sample_rate,
        }
    }

    pub fn update(&mut self, enabled: bool, gains: [f32; 5], sample_rate: f64) {
        if self.enabled == enabled
            && (self.sample_rate - sample_rate).abs() < 1.0
            && self
                .gains
                .iter()
                .zip(gains.iter())
                .all(|(a, b)| (a - b).abs() < 1e-4)
        {
            return;
        }
        self.enabled = enabled;
        self.gains = gains;
        self.sample_rate = sample_rate;
        for (idx, band) in EQ_BANDS.iter().enumerate() {
            let db = if enabled { f64::from(gains[idx]) } else { 0.0 };
            let c = make_biquad_coeffs(band.kind, band.freq, db, sample_rate);
            self.left[idx].update_coefficients(c);
            self.right[idx].update_coefficients(c);
        }
    }

    pub fn process_stereo_frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        if !self.enabled {
            return (l, r);
        }
        let mut lo = l;
        let mut ro = r;
        for i in 0..5 {
            lo = self.left[i].run(lo);
            ro = self.right[i].run(ro);
        }
        (lo, ro)
    }
}

/// Three-tier compressor + brickwall `-1.0 dBFS` soft limiter matching `src/state/player.ts`.
pub struct LoudnessAndLimiter {
    enabled: bool,
    target: NormalizationTarget,
    comp_env: f32,
    limiter_env: f32,
    sample_rate: f32,
}

impl LoudnessAndLimiter {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            enabled: true,
            target: NormalizationTarget::Normal,
            comp_env: 0.0,
            limiter_env: 1.0,
            sample_rate: sample_rate.max(8000.0),
        }
    }

    pub fn configure(&mut self, enabled: bool, target: NormalizationTarget, sample_rate: f32) {
        self.enabled = enabled;
        self.target = target;
        self.sample_rate = sample_rate.max(8000.0);
    }

    pub fn process_stereo_frame(&mut self, mut l: f32, mut r: f32) -> (f32, f32) {
        if self.enabled {
            let (gain_db, thresh_db, ratio) = match self.target {
                NormalizationTarget::Quiet => (-6.5f32, -24.0f32, 1.5f32),
                NormalizationTarget::Normal => (-2.5f32, -22.0f32, 2.2f32),
                NormalizationTarget::Loud => (1.5f32, -20.0f32, 3.2f32),
            };
            let makeup = 10.0_f32.powf(gain_db / 20.0);
            l *= makeup;
            r *= makeup;

            let level = l.abs().max(r.abs());
            let atk = (-1.0 / (0.004 * self.sample_rate)).exp();
            let rel = (-1.0 / (0.180 * self.sample_rate)).exp();
            let coef = if level > self.comp_env { atk } else { rel };
            self.comp_env = coef * self.comp_env + (1.0 - coef) * level;

            if self.comp_env > 1e-6 {
                let env_db = 20.0 * self.comp_env.log10();
                if env_db > thresh_db {
                    let over = env_db - thresh_db;
                    let compressed_over = over / ratio;
                    let reduction_db = compressed_over - over;
                    let g = 10.0_f32.powf(reduction_db / 20.0);
                    l *= g;
                    r *= g;
                }
            }
        }

        // Brickwall -1.0 dBFS limiter (approx 0.89125)
        let ceiling = 0.891_25_f32;
        let peak = l.abs().max(r.abs());
        let desired_gain = if peak > ceiling { ceiling / peak } else { 1.0 };
        let atk = (-1.0 / (0.0005 * self.sample_rate)).exp();
        let rel = (-1.0 / (0.060 * self.sample_rate)).exp();
        let coef = if desired_gain < self.limiter_env { atk } else { rel };
        self.limiter_env = (coef * self.limiter_env + (1.0 - coef) * desired_gain).min(1.0);
        l *= self.limiter_env;
        r *= self.limiter_env;
        (l.clamp(-0.98, 0.98), r.clamp(-0.98, 0.98))
    }
}

struct SpectrumState {
    ring: [f32; FFT_SIZE],
    write_pos: usize,
    hann: Vec<f32>,
    smoothed_db: Vec<f32>,
    fft_scratch: Vec<Complex<f32>>,
    fft: Arc<dyn rustfft::Fft<f32>>,
    bytes_buf: Vec<u8>,
    sample_rate: f64,
}

#[derive(Clone)]
pub struct SpectrumTap {
    inner: Arc<Mutex<SpectrumState>>,
}

impl SpectrumTap {
    pub fn new(sample_rate: f64) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let hann = (0..FFT_SIZE)
            .map(|i| {
                0.5 * (1.0 - ((2.0 * std::f32::consts::PI * i as f32) / (FFT_SIZE - 1) as f32).cos())
            })
            .collect();
        let bins = FFT_SIZE / 2;
        Self {
            inner: Arc::new(Mutex::new(SpectrumState {
                ring: [0.0; FFT_SIZE],
                write_pos: 0,
                hann,
                smoothed_db: vec![0.0; bins],
                fft_scratch: vec![Complex::new(0.0, 0.0); FFT_SIZE],
                fft,
                bytes_buf: vec![0u8; bins],
                sample_rate,
            })),
        }
    }

    pub fn try_push_stereo(&self, interleaved: &[f32], sample_rate: f64) {
        let Ok(mut st) = self.inner.try_lock() else {
            return;
        };
        st.sample_rate = sample_rate;
        for frame in interleaved.as_chunks::<2>().0 {
            let mono = 0.5 * (frame[0] + frame[1]);
            let pos = st.write_pos;
            st.ring[pos] = mono;
            st.write_pos = (pos + 1) % FFT_SIZE;
        }
    }

    pub fn read_bars(&self, bars: usize, out: &mut [f32]) {
        let Ok(mut st) = self.inner.lock() else {
            out.fill(0.0);
            return;
        };
        let state = &mut *st;
        let wp = state.write_pos;
        for i in 0..FFT_SIZE {
            let s = state.ring[(wp + i) % FFT_SIZE] * state.hann[i];
            state.fft_scratch[i] = Complex::new(s, 0.0);
        }
        state.fft.process(&mut state.fft_scratch);

        let min_db = -90.0_f32;
        let max_db = -10.0_f32;
        let inv_span = 1.0 / (max_db - min_db);
        let norm_factor = 1.0 / (FFT_SIZE as f32 * 0.5);
        let bins = FFT_SIZE / 2;
        for i in 0..bins {
            let mag = (state.fft_scratch[i].norm() * norm_factor).max(1e-9);
            let db = 20.0 * mag.log10();
            let norm = ((db - min_db) * inv_span).clamp(0.0, 1.0);
            let prev = state.smoothed_db[i];
            let sm = SMOOTHING * prev + (1.0 - SMOOTHING) * norm;
            state.smoothed_db[i] = sm;
            state.bytes_buf[i] = (sm * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        bin_spectrum(&state.bytes_buf, state.sample_rate, bars, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use resonance_core::eq_curve::{freq_to_unit, preset_gains};
    use resonance_core::models::EqPreset;
    use std::f32::consts::TAU;

    #[test]
    fn bass_boost_increases_low_freq_energy() {
        let mut eq = StereoEqChain::new(48_000.0);
        let gains = preset_gains(EqPreset::BassBoost).unwrap();
        eq.update(true, gains, 48_000.0);

        let mut in_pow = 0.0f32;
        let mut out_pow = 0.0f32;
        for i in 0..4800 {
            let s = (TAU * 35.0 * (i as f32 / 48_000.0)).sin() * 0.2;
            let (ol, _) = eq.process_stereo_frame(s, s);
            if i >= 2400 {
                in_pow += s * s;
                out_pow += ol * ol;
            }
        }
        assert!(out_pow > in_pow * 3.0);
    }

    #[test]
    fn limiter_prevents_overdrive_clipping() {
        let mut norm = LoudnessAndLimiter::new(48_000.0);
        norm.configure(true, NormalizationTarget::Loud, 48_000.0);
        let mut max_peak = 0.0f32;
        for i in 0..4800 {
            let s = (TAU * 440.0 * (i as f32 / 48_000.0)).sin() * 4.0;
            let (ol, or) = norm.process_stereo_frame(s, s);
            if i > 240 {
                max_peak = max_peak.max(ol.abs()).max(or.abs());
            }
        }
        assert!(max_peak <= 0.92, "expected limited <= 0.92, got {max_peak}");
    }

    #[test]
    fn spectrum_tap_detects_1khz_tone() {
        let tap = SpectrumTap::new(48_000.0);
        let mut buf = Vec::with_capacity(FFT_SIZE * 2);
        for i in 0..FFT_SIZE {
            let s = (TAU * 1000.0 * (i as f32 / 48_000.0)).sin() * 0.5;
            buf.push(s);
            buf.push(s);
        }
        tap.try_push_stereo(&buf, 48_000.0);
        let mut bars = [0.0f32; 72];
        tap.read_bars(72, &mut bars);
        let peak_idx = bars
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap()
            .0;
        let expected_idx = (freq_to_unit(1000.0) * 72.0) as isize;
        assert!((peak_idx as isize - expected_idx).abs() <= 2);
    }
}
