/** Last.fm scrobble rules, kept pure for tests. https://www.last.fm/api/scrobbling */

export interface ScrobbleItem {
  artist: string;
  track: string;
  album?: string;
  duration?: number;
  /** Unix seconds when playback started. */
  timestamp: number;
}

/** Seconds of actual listening required, or null if the track can never be scrobbled. */
export function scrobbleThreshold(durationSec: number): number | null {
  if (!(durationSec > 30)) return null;
  return Math.min(durationSec / 2, 240);
}

/**
 * Wall-clock delta to credit as listening time. Large jumps (sleep, a stalled tab) are ignored
 * so that leaving the app paused or suspended never counts as listening.
 */
export function creditedDelta(deltaSec: number): number {
  return deltaSec > 0 && deltaSec <= 2.5 ? deltaSec : 0;
}

/** YouTube auto-generated channels are named "Artist - Topic"; Last.fm wants just "Artist". */
export function cleanArtist(artist: string): string {
  return artist.replace(/\s+-\s+Topic$/i, '').trim();
}

/** Last.fm accepts timestamps up to 14 days old; older queued items would be rejected anyway. */
export function dropStale(queue: ScrobbleItem[], nowSec: number): ScrobbleItem[] {
  return queue.filter((q) => nowSec - q.timestamp < 14 * 86400 - 3600);
}
