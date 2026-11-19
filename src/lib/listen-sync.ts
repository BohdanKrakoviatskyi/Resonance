/** Pure parts of "Listen together": room codes and the guest's sync decisions. */

export interface SharedTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  cover?: string;
  src: string;
  duration: number;
  nativeId?: string;
  source: 'youtube' | 'soundcloud' | 'local';
}

export interface HostState {
  type: 'state';
  track: SharedTrack | null;
  playing: boolean;
  /** Seconds into the track when the message was sent. */
  pos: number;
}

export function parseHostState(value: unknown): HostState | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Partial<HostState>;
  if (message.type !== 'state' || typeof message.playing !== 'boolean' || typeof message.pos !== 'number' || !Number.isFinite(message.pos)) return null;
  if (message.track === null) return { type: 'state', track: null, playing: message.playing, pos: Math.max(0, message.pos) };
  const track = message.track as Partial<SharedTrack> | undefined;
  if (!track || typeof track.id !== 'string' || !track.id || typeof track.title !== 'string' || typeof track.artist !== 'string' || typeof track.src !== 'string' || typeof track.duration !== 'number' || !Number.isFinite(track.duration) || track.duration < 0 || !['youtube', 'soundcloud', 'local'].includes(String(track.source))) return null;
  if (track.source === 'local') {
    if (!/^local:[a-f0-9]{20}$/i.test(track.id) || track.src !== track.id || typeof track.nativeId !== 'string' || !/^[a-f0-9]{20}$/i.test(track.nativeId) || `local:${track.nativeId}` !== track.id) return null;
  } else {
    let src: URL;
    try { src = new URL(track.src); } catch { return null; }
    if (src.protocol !== 'https:' || !src.hostname || src.username || src.password) return null;
  }
  return { type: 'state', track: track as SharedTrack, playing: message.playing, pos: Math.max(0, message.pos) };
}

export interface GuestView {
  trackId: string | null;
  playing: boolean;
  pos: number;
}

export type SyncAction =
  | { kind: 'load'; track: SharedTrack; pos: number; playing: boolean }
  | { kind: 'seek'; pos: number }
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'unsupported'; track: SharedTrack };

/** Allowed drift before the guest seeks; smaller corrections are audible as stutter. */
export const MAX_DRIFT_SEC = 1.5;
/** Rough one-way latency compensation applied to the host position. */
export const LATENCY_SEC = 0.15;

export function planSync(local: GuestView, remote: HostState): SyncAction[] {
  if (!remote.track) return local.playing ? [{ kind: 'pause' }] : [];
  // Local files exist only on the host's disk; pause any stale guest track.
  if (remote.track.source === 'local') return [
    ...(local.playing ? [{ kind: 'pause' as const }] : []),
    { kind: 'unsupported', track: remote.track },
  ];
  const target = remote.pos + (remote.playing ? LATENCY_SEC : 0);
  if (local.trackId !== remote.track.id) return [{ kind: 'load', track: remote.track, pos: target, playing: remote.playing }];
  const out: SyncAction[] = [];
  if (Math.abs(local.pos - target) > MAX_DRIFT_SEC) out.push({ kind: 'seek', pos: target });
  if (remote.playing && !local.playing) out.push({ kind: 'play' });
  if (!remote.playing && local.playing) out.push({ kind: 'pause' });
  return out;
}

const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_CODE_PATTERN = /^[0-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/** Accept the shareable room code in either case, tolerating spaces around it. */
export function normalizeRoomCode(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(normalized) ? normalized : null;
}

/** PeerJS IDs are lower-case and prefix the user-facing code to avoid reserved IDs. */
export function peerIdForRoom(code: string): string {
  const normalized = normalizeRoomCode(code);
  if (!normalized) throw new Error('bad room code');
  return `resonance-${normalized.toLowerCase()}`;
}

/** Generate a human-readable 4-digit/4-character room code. */
export function createRoomCode(random?: () => number): string {
  if (random) {
    const digits = Array.from({ length: 4 }, () => Math.floor(random() * 10)).join('');
    const suffix = Array.from({ length: 4 }, () => ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)]).join('');
    return `${digits}-${suffix}`;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const digits = Array.from(bytes.slice(0, 4), (value) => value % 10).join('');
  const suffix = Array.from(bytes.slice(4), (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join('');
  return `${digits}-${suffix}`;
}
