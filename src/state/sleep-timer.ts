import { createStore } from '../lib/util';
import { fadeFactor, remainingMs, SLEEP_FADE_MS, type SleepMode } from '../lib/sleep-timer-plan';
import { player, setVolume, toggle } from './player';

/** Not persisted on purpose: a sleep timer should never survive an app restart. */
export const sleepTimer = createStore({ mode: { kind: 'off' } as SleepMode });

let ticker: number | null = null;
let fadeTimeout: number | null = null;
let unsubIndex: (() => void) | null = null;
/** Volume before the fade started; restored after we pause or when the timer is cancelled. */
let savedVolume: number | null = null;

function restoreVolume() {
  if (savedVolume !== null) setVolume(savedVolume);
  savedVolume = null;
}

function stopWatchers() {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  if (fadeTimeout !== null) clearTimeout(fadeTimeout);
  fadeTimeout = null;
  unsubIndex?.();
  unsubIndex = null;
}

function finish() {
  stopWatchers();
  if (player.get().playing) toggle();
  restoreVolume();
  sleepTimer.set({ mode: { kind: 'off' } });
}

function tick() {
  const { mode } = sleepTimer.get();
  if (mode.kind !== 'at') return;
  const now = Date.now();
  if (now >= mode.endsAt) return finish();
  const f = fadeFactor(mode, now, SLEEP_FADE_MS);
  if (f < 1) {
    if (savedVolume === null) savedVolume = player.get().volume;
    setVolume(savedVolume * f);
  }
}

/** One timeout for the wait before the ramp; the 250 ms ticker runs only inside the fade window. */
function watchFade() {
  const { mode } = sleepTimer.get();
  if (mode.kind !== 'at') return;
  const left = remainingMs(mode, Date.now()) ?? 0;
  if (left > SLEEP_FADE_MS) {
    fadeTimeout = window.setTimeout(watchFade, left - SLEEP_FADE_MS);
    return;
  }
  fadeTimeout = null;
  ticker = window.setInterval(tick, 250);
  tick();
}

export function setSleepTimer(next: { minutes: number } | 'endOfTrack' | 'off') {
  stopWatchers();
  restoreVolume();
  if (next === 'off') {
    sleepTimer.set({ mode: { kind: 'off' } });
    return;
  }
  if (next === 'endOfTrack') {
    const s0 = player.get();
    const startId = s0.queue[s0.index];
    const startRequestId = s0.requestId;
    sleepTimer.set({ mode: { kind: 'endOfTrack' } });
    unsubIndex = player.subscribe(() => {
      const s = player.get();
      // A new track started (the request id changes even when repeat-one restarts the same track,
      // with or without crossfade), a different track became current (auto-next, manual skip),
      // or the queue ran out.
      if (s.requestId !== startRequestId || s.queue[s.index] !== startId || s.state === 'idle') finish();
    });
    return;
  }
  sleepTimer.set({ mode: { kind: 'at', endsAt: Date.now() + next.minutes * 60_000 } });
  watchFade();
}
