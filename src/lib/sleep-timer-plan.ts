/** Pure helpers for the sleep timer, kept free of DOM/player imports so they can be unit-tested. */

export const SLEEP_PRESETS_MIN = [5, 15, 30, 45, 60, 90] as const;
/** Volume ramps down over this window before playback stops. */
export const SLEEP_FADE_MS = 10_000;

export type SleepMode = { kind: 'off' } | { kind: 'at'; endsAt: number } | { kind: 'endOfTrack' };

/** Remaining milliseconds, or null when the timer is not time-based. */
export function remainingMs(mode: SleepMode, now: number): number | null {
  return mode.kind === 'at' ? Math.max(0, mode.endsAt - now) : null;
}

/** 1 → full volume, 0 → silent. Starts ramping SLEEP_FADE_MS before the deadline. */
export function fadeFactor(mode: SleepMode, now: number, fadeMs = SLEEP_FADE_MS): number {
  const left = remainingMs(mode, now);
  if (left === null || left >= fadeMs) return 1;
  return Math.max(0, left / fadeMs);
}

/** "1:05:09", "12:04", "0:09". */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
