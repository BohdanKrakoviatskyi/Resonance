/**
 * Pure maths for the interactive 5-band equalizer: exact RBJ biquad frequency response
 * of the 5-band filter chain across 20 Hz .. 20 kHz.
 */

export type EqFilterKind = 'lowshelf' | 'peaking' | 'highshelf';
export interface EqBandSpec {
  freq: number;
  type: EqFilterKind;
}

export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20000;
const OCTAVE_SPAN = Math.log(EQ_MAX_HZ / EQ_MIN_HZ);

export const PEAKING_Q = 1.1;

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

function coefficients(type: EqFilterKind, f0: number, gainDb: number, sampleRate: number): Biquad {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  if (type === 'peaking') {
    const alpha = sin / (2 * PEAKING_Q);
    return { b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A };
  }
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

export function totalResponseDb(bands: readonly EqBandSpec[], gains: readonly number[], hz: number, sampleRate = 48000): number {
  let sum = 0;
  for (let i = 0; i < bands.length; i++) sum += bandResponseDb(bands[i], gains[i] ?? 0, hz, sampleRate);
  return sum;
}

export function sampleCurve(bands: readonly EqBandSpec[], gains: readonly number[], points = 120): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const unit = i / (points - 1);
    out.push([unit, totalResponseDb(bands, gains, unitToFreq(unit))]);
  }
  return out;
}
