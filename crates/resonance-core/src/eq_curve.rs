use std::f64::consts::SQRT_2;

use crate::models::EqPreset;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EqFilterKind {
    Lowshelf,
    Peaking,
    Highshelf,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqBandSpec {
    pub freq: f64,
    pub label: &'static str,
    pub kind: EqFilterKind,
}

pub const EQ_BANDS: [EqBandSpec; 5] = [
    EqBandSpec { freq: 60.0, label: "60Hz", kind: EqFilterKind::Lowshelf },
    EqBandSpec { freq: 230.0, label: "230Hz", kind: EqFilterKind::Peaking },
    EqBandSpec { freq: 910.0, label: "910Hz", kind: EqFilterKind::Peaking },
    EqBandSpec { freq: 3600.0, label: "3.6kHz", kind: EqFilterKind::Peaking },
    EqBandSpec { freq: 14000.0, label: "14kHz", kind: EqFilterKind::Highshelf },
];

pub fn preset_gains(preset: EqPreset) -> Option<[f32; 5]> {
    match preset {
        EqPreset::Flat => Some([0.0, 0.0, 0.0, 0.0, 0.0]),
        EqPreset::BassBoost => Some([6.5, 4.0, 0.0, -1.0, 1.5]),
        EqPreset::Vocal => Some([-2.0, -1.0, 4.5, 3.5, 1.0]),
        EqPreset::Rock => Some([4.5, 2.0, -1.5, 3.0, 4.5]),
        EqPreset::Electronic => Some([5.5, 2.5, -1.0, 2.5, 5.0]),
        EqPreset::Custom => None,
    }
}

pub const EQ_MIN_HZ: f64 = 20.0;
pub const EQ_MAX_HZ: f64 = 20_000.0;
pub const PEAKING_Q: f64 = 1.1;

fn octave_span() -> f64 {
    (EQ_MAX_HZ / EQ_MIN_HZ).ln()
}

pub fn freq_to_unit(hz: f64) -> f64 {
    (hz.max(EQ_MIN_HZ) / EQ_MIN_HZ).ln() / octave_span()
}

pub fn unit_to_freq(unit: f64) -> f64 {
    EQ_MIN_HZ * (unit * octave_span()).exp()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BiquadCoeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a0: f64,
    pub a1: f64,
    pub a2: f64,
}

/// RBJ audio-EQ-cookbook coefficients, matching Web Audio BiquadFilterNode.
pub fn coefficients(kind: EqFilterKind, f0: f64, gain_db: f64, sample_rate: f64) -> BiquadCoeffs {
    let a = 10.0_f64.powf(gain_db / 40.0);
    let w0 = (2.0 * std::f64::consts::PI * f0) / sample_rate;
    let cos = w0.cos();
    let sin = w0.sin();
    match kind {
        EqFilterKind::Peaking => {
            let alpha = sin / (2.0 * PEAKING_Q);
            BiquadCoeffs {
                b0: 1.0 + alpha * a,
                b1: -2.0 * cos,
                b2: 1.0 - alpha * a,
                a0: 1.0 + alpha / a,
                a1: -2.0 * cos,
                a2: 1.0 - alpha / a,
            }
        }
        EqFilterKind::Lowshelf => {
            let alpha = (sin / 2.0) * SQRT_2;
            let k = 2.0 * a.sqrt() * alpha;
            BiquadCoeffs {
                b0: a * ((a + 1.0) - (a - 1.0) * cos + k),
                b1: 2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                b2: a * ((a + 1.0) - (a - 1.0) * cos - k),
                a0: (a + 1.0) + (a - 1.0) * cos + k,
                a1: -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                a2: (a + 1.0) + (a - 1.0) * cos - k,
            }
        }
        EqFilterKind::Highshelf => {
            let alpha = (sin / 2.0) * SQRT_2;
            let k = 2.0 * a.sqrt() * alpha;
            BiquadCoeffs {
                b0: a * ((a + 1.0) + (a - 1.0) * cos + k),
                b1: -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                b2: a * ((a + 1.0) + (a - 1.0) * cos - k),
                a0: (a + 1.0) - (a - 1.0) * cos + k,
                a1: 2.0 * ((a - 1.0) - (a + 1.0) * cos),
                a2: (a + 1.0) - (a - 1.0) * cos - k,
            }
        }
    }
}

pub fn band_response_db(band: EqBandSpec, gain_db: f64, hz: f64, sample_rate: f64) -> f64 {
    if gain_db.abs() < 1e-6 {
        return 0.0;
    }
    let c = coefficients(band.kind, band.freq, gain_db, sample_rate);
    let w = (2.0 * std::f64::consts::PI * hz) / sample_rate;
    let c1 = w.cos();
    let c2 = (2.0 * w).cos();
    let num = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 + 2.0 * (c.b0 * c.b1 + c.b1 * c.b2) * c1 + 2.0 * c.b0 * c.b2 * c2;
    let den = c.a0 * c.a0 + c.a1 * c.a1 + c.a2 * c.a2 + 2.0 * (c.a0 * c.a1 + c.a1 * c.a2) * c1 + 2.0 * c.a0 * c.a2 * c2;
    10.0 * (num.max(1e-12) / den.max(1e-12)).log10()
}

pub fn total_response_db(bands: &[EqBandSpec], gains: &[f32], hz: f64, sample_rate: f64) -> f64 {
    bands
        .iter()
        .enumerate()
        .map(|(i, b)| band_response_db(*b, f64::from(gains.get(i).copied().unwrap_or(0.0)), hz, sample_rate))
        .sum()
}

pub fn sample_curve(bands: &[EqBandSpec], gains: &[f32], points: usize) -> Vec<(f64, f64)> {
    let n = points.max(2);
    (0..n)
        .map(|i| {
            let unit = i as f64 / (n - 1) as f64;
            (unit, total_response_db(bands, gains, unit_to_freq(unit), 48_000.0))
        })
        .collect()
}

pub fn bin_spectrum(data: &[u8], sample_rate: f64, bars: usize, out: &mut [f32]) {
    if data.is_empty() || bars == 0 || sample_rate <= 0.0 {
        out.fill(0.0);
        return;
    }
    let nyquist = sample_rate / 2.0;
    let bin_hz = nyquist / data.len() as f64;
    for (i, slot) in out.iter_mut().take(bars).enumerate() {
        let lo = unit_to_freq(i as f64 / bars as f64);
        let hi = unit_to_freq((i + 1) as f64 / bars as f64);
        let first = ((lo / bin_hz).floor() as isize).clamp(0, (data.len() - 1) as isize) as usize;
        let last = ((hi / bin_hz).ceil() as isize - 1).clamp(first as isize, (data.len() - 1) as isize) as usize;
        let peak = data[first..=last].iter().copied().max().unwrap_or(0);
        *slot = f32::from(peak) / 255.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_curve_is_zero_db() {
        let curve = sample_curve(&EQ_BANDS, &[0.0; 5], 64);
        assert!(curve.iter().all(|(_, db)| db.abs() < 1e-9));
    }

    #[test]
    fn bass_boost_peaks_at_low_frequencies() {
        let gains = preset_gains(EqPreset::BassBoost).unwrap();
        let sub_bass = total_response_db(&EQ_BANDS, &gains, 25.0, 48_000.0);
        let corner = total_response_db(&EQ_BANDS, &gains, 60.0, 48_000.0);
        let mid = total_response_db(&EQ_BANDS, &gains, 910.0, 48_000.0);
        assert!(sub_bass > 5.5, "expected sub_bass > 5.5 dB, got {sub_bass}");
        assert!(corner > 3.0, "expected corner > 3.0 dB, got {corner}");
        assert!(mid.abs() < 1.5, "expected mid near 0 dB, got {mid}");
    }

    #[test]
    fn freq_unit_round_trip() {
        for hz in [20.0, 60.0, 230.0, 910.0, 3600.0, 14000.0, 20000.0] {
            let rt = unit_to_freq(freq_to_unit(hz));
            assert!((rt - hz).abs() < 1e-6);
        }
    }
}
