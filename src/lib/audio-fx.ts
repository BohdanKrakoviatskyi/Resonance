/** Playback effects (speed / pitch / reverb) and their presets. Pure, so it can be unit-tested. */

export type FxPreset = 'off' | 'slowedReverb' | 'nightcore' | 'custom';

export interface FxSettings {
  /** 0.5 … 1.5 */
  speed: number;
  /** true: time-stretch (pitch unchanged); false: vinyl-style, pitch follows speed. */
  keepPitch: boolean;
  /** Wet mix 0 … 1. */
  reverb: number;
}

export const FX_OFF: FxSettings = { speed: 1, keepPitch: true, reverb: 0 };

export const FX_PRESETS: Record<Exclude<FxPreset, 'custom'>, FxSettings> = {
  off: FX_OFF,
  slowedReverb: { speed: 0.85, keepPitch: false, reverb: 0.4 },
  nightcore: { speed: 1.25, keepPitch: false, reverb: 0 },
};

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 1.5;

export function clampFx(fx: Partial<FxSettings>): FxSettings {
  const speed = Number.isFinite(fx.speed) ? Math.min(SPEED_MAX, Math.max(SPEED_MIN, fx.speed as number)) : 1;
  const reverb = Number.isFinite(fx.reverb) ? Math.min(1, Math.max(0, fx.reverb as number)) : 0;
  return { speed: Math.round(speed * 100) / 100, keepPitch: fx.keepPitch !== false, reverb: Math.round(reverb * 100) / 100 };
}

/** Which preset the settings correspond to, so the UI can highlight it. */
export function detectPreset(fx: FxSettings): FxPreset {
  for (const [name, p] of Object.entries(FX_PRESETS) as [Exclude<FxPreset, 'custom'>, FxSettings][]) {
    if (p.speed === fx.speed && p.keepPitch === fx.keepPitch && p.reverb === fx.reverb) return name;
  }
  return 'custom';
}

export const fxIsNeutral = (fx: FxSettings) => fx.speed === 1 && fx.reverb === 0;

/** Semitone shift heard when pitch follows speed. */
export const semitones = (fx: FxSettings) => (fx.keepPitch ? 0 : 12 * Math.log2(fx.speed));

/**
 * Stereo impulse response: decorrelated noise with an exponential tail and a short pre-delay,
 * which sounds like a medium hall without shipping an audio file.
 */
export function makeImpulse(sampleRate: number, seconds = 2.8, decay = 3.2, seed = 1): [Float32Array, Float32Array] {
  const len = Math.max(1, Math.floor(sampleRate * seconds));
  const pre = Math.floor(sampleRate * 0.012);
  let s = seed >>> 0 || 1;
  const rand = () => {
    // xorshift32: deterministic, so tests and both decks get identical reverbs.
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
  const ch = [new Float32Array(len), new Float32Array(len)] as [Float32Array, Float32Array];
  for (let i = pre; i < len; i++) {
    const env = Math.pow(1 - (i - pre) / (len - pre), decay);
    ch[0][i] = (rand() * 2 - 1) * env;
    ch[1][i] = (rand() * 2 - 1) * env;
  }
  return ch;
}
