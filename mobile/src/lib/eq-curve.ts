/**
 * Pure maths for the fullscreen equalizer: the frequency response of the 5-band filter chain (so the
 * curve on screen is the real one, not a drawing), the log frequency axis, and spectrum binning.
 * Kept free of DOM/Web Audio so it can be unit-tested.
 */

export type EqFilterKind = 'lowshelf' | 'peaking' | 'highshelf';
export interface EqBandSpec {
  freq: number;
  type: EqFilterKind;
}

export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20000;
const OCTAVE_SPAN = Math.log(EQ_MAX_HZ / EQ_MIN_HZ);

/** Same Q the audio graph uses for peaking bands (shelves have a fixed slope in Web Audio). */
export const PEAKING_Q = 1.1;

/** Position of a frequency on the log axis, 0 (20 Hz) .. 1 (20 kHz). */
export const freqToUnit = (hz: number): number => Math.log(Math.max(hz, EQ_MIN_HZ) / EQ_MIN_HZ) / OCTAVE_SPAN;
export const unitToFreq = (unit: number): number => EQ_MIN_HZ * Math.exp(unit * OCTAVE_SPAN);

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/** RBJ audio-EQ-cookbook coefficients, matching what a Web Audio BiquadFilterNode computes. */
function coefficients(type: EqFilterKind, f0: number, gainDb: number, sampleRate: number): Biquad {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  if (type === 'peaking') {
    const alpha = sin / (2 * PEAKING_Q);
    return { b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A };
  }
  // Shelves use slope S = 1, as the Web Audio spec does.
  const alpha = (sin / 2) * Math.SQRT2;
  const k = 2 * Math.sqrt(A) * alpha;
  if (type === 'lowshelf') {
    return {
      b0: A * (A + 1 - (A - 1) * cos + k),
      b1: 2 * A * (A - 1 - (A + 1) * cos),
      b2: A * (A + 1 - (A - 1) * cos - k),
      a0: A + 1 + (A - 1) * cos + k,
      a1: -2 * (A - 1 + (A + 1) * cos),
      a2: A + 1 + (A - 1) * cos - k,
    };
  }
  return {
    b0: A * (A + 1 + (A - 1) * cos + k),
    b1: -2 * A * (A - 1 + (A + 1) * cos),
    b2: A * (A + 1 + (A - 1) * cos - k),
    a0: A + 1 - (A - 1) * cos + k,
    a1: 2 * (A - 1 - (A + 1) * cos),
    a2: A + 1 - (A - 1) * cos - k,
  };
}

/** Gain in dB of one band at frequency `hz`. */
export function bandResponseDb(band: EqBandSpec, gainDb: number, hz: number, sampleRate = 48000): number {
  if (Math.abs(gainDb) < 1e-6) return 0;
  const { b0, b1, b2, a0, a1, a2 } = coefficients(band.type, band.freq, gainDb, sampleRate);
  const w = (2 * Math.PI * hz) / sampleRate;
  const c1 = Math.cos(w);
  const c2 = Math.cos(2 * w);
  const num = b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * c1 + 2 * b0 * b2 * c2;
  const den = a0 * a0 + a1 * a1 + a2 * a2 + 2 * (a0 * a1 + a1 * a2) * c1 + 2 * a0 * a2 * c2;
  return 10 * Math.log10(Math.max(num, 1e-12) / Math.max(den, 1e-12));
}

/** Combined response of the whole chain (cascaded filters add in dB). */
export function totalResponseDb(bands: readonly EqBandSpec[], gains: readonly number[], hz: number, sampleRate = 48000): number {
  let sum = 0;
  for (let i = 0; i < bands.length; i++) sum += bandResponseDb(bands[i], gains[i] ?? 0, hz, sampleRate);
  return sum;
}

/** `points` log-spaced samples of the chain response across 20 Hz .. 20 kHz as `[unitX, dB]`. */
export function sampleCurve(bands: readonly EqBandSpec[], gains: readonly number[], points = 120): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const unit = i / (points - 1);
    out.push([unit, totalResponseDb(bands, gains, unitToFreq(unit))]);
  }
  return out;
}

/**
 * Collapses an FFT magnitude array (0..255 per bin) into `bars` log-spaced bars, each 0..1.
 * A bar is the loudest bin inside its band, which keeps narrow peaks visible at the low end where
 * several bars share one bin.
 */
export function binSpectrum(data: ArrayLike<number>, sampleRate: number, bars: number, out: Float32Array): void {
  const nyquist = sampleRate / 2;
  const binHz = nyquist / data.length;
  for (let i = 0; i < bars; i++) {
    const lo = unitToFreq(i / bars);
    const hi = unitToFreq((i + 1) / bars);
    const first = Math.min(data.length - 1, Math.max(0, Math.floor(lo / binHz)));
    const last = Math.min(data.length - 1, Math.max(first, Math.ceil(hi / binHz) - 1));
    let peak = 0;
    for (let bin = first; bin <= last; bin++) peak = Math.max(peak, data[bin]);
    out[i] = peak / 255;
  }
}
