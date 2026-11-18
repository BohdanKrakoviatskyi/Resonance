/** Pure helpers that turn player state into a Discord presence payload. */

export interface PresenceInput {
  id: string;
  title: string;
  artist: string;
  album?: string;
  cover?: string;
  src?: string;
  playing: boolean;
  /** Seconds into the track. */
  position: number;
  /** Track length in seconds; 0 when unknown. */
  duration: number;
}

export interface PresencePayload {
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  url: string | null;
  startMs: number | null;
  endMs: number | null;
}

const https = (u?: string) => (u && /^https:\/\//i.test(u) ? u : null);

export function buildPresence(p: PresenceInput, now: number): PresencePayload {
  const timed = p.playing && p.duration > 0;
  const startMs = timed ? Math.round(now - p.position * 1000) : null;
  return {
    title: p.title,
    artist: p.artist,
    album: p.album?.trim() || null,
    coverUrl: https(p.cover),
    url: https(p.src),
    startMs,
    endMs: timed && startMs !== null ? startMs + Math.round(p.duration * 1000) : null,
  };
}

/**
 * Identity of a presence update. Discord rate-limits activity updates (~5 per 20 s), so we only
 * resend when something visible changes: track, play state, or a seek that moves the bar > 2 s.
 */
export function presenceKey(p: PresenceInput, now: number): string {
  if (!p.playing) return `${p.id}|paused`;
  const start = Math.round((now - p.position * 1000) / 2000);
  return `${p.id}|${start}|${Math.round(p.duration)}`;
}
