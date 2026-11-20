export interface AutoCrossfadePlan {
  fromDuration: number;
  fadeSec: number;
  startFraction: number;
}

export interface AutoCrossfadeDecision {
  shouldPreload: boolean;
  shouldStart: boolean;
}

/**
 * Decides whether to preload the inactive deck or trigger auto-crossfade for a playing track.
 * Clamps the effective fade window so remaining <= fadeSec is always reachable even near track end.
 */
export function evaluateAutoCrossfadeTrigger(opts: {
  duration: number;
  currentTime: number;
  fadeSec: number;
  paused: boolean;
  ended: boolean;
  preloadedAlready: boolean;
  preparingAlready: boolean;
  preloadAheadSec: number;
}): AutoCrossfadeDecision {
  const { duration, currentTime, fadeSec, paused, ended, preloadedAlready, preparingAlready, preloadAheadSec } = opts;
  if (paused || ended || !isFinite(duration) || duration <= 0 || !isFinite(currentTime) || currentTime < 1 || fadeSec <= 0) {
    return { shouldPreload: false, shouldStart: false };
  }
  const remaining = duration - currentTime;
  const shouldPreload =
    !preloadedAlready &&
    remaining > fadeSec + 0.5 &&
    remaining <= Math.max(fadeSec + 8, preloadAheadSec);
  const shouldStart =
    !preparingAlready &&
    remaining > 0.25 &&
    remaining <= fadeSec + 0.35;
  return { shouldPreload, shouldStart };
}

/**
 * Resolves the fade duration and start progress ratio for an automatic end-of-track crossfade.
 * Uses `Math.min(elDuration, trackDuration)` when WebKit pads/doubles the element duration.
 */
export function planAutoCrossfade(opts: {
  baseFadeSec: number;
  elDuration: number;
  metaDuration: number;
  currentTime: number;
}): AutoCrossfadePlan {
  const { baseFadeSec, elDuration, metaDuration, currentTime } = opts;
  const validEl = isFinite(elDuration) && elDuration > 0 ? elDuration : 0;
  const validMeta = isFinite(metaDuration) && metaDuration > 0 ? metaDuration : 0;
  const fromDuration =
    validEl > 0 && validMeta > 0 && validEl >= validMeta * 1.7
      ? validMeta
      : validEl || validMeta;
  const remaining = fromDuration > 0 ? Math.max(0.2, fromDuration - Math.max(0, currentTime)) : baseFadeSec;
  const fadeSec = Math.max(0.2, Math.min(baseFadeSec, remaining));
  const startFraction = fromDuration > 0 ? Math.min(1, Math.max(0.05, currentTime / fromDuration)) : 0.92;
  return { fromDuration, fadeSec, startFraction };
}

/**
 * Checks whether an incoming deck failure should abort crossfade and fall back to the still-playing outgoing deck.
 */
export function canFallbackToOutgoingDeck(fromPaused: boolean, fromEnded: boolean, fromSrc: string): boolean {
  return Boolean(fromSrc) && !fromPaused && !fromEnded;
}
