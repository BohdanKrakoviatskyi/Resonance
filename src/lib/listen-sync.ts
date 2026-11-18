/** Pure parts of "Listen together": invite-code encoding and the guest's sync decisions. */

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
  // Local files exist only on the host's disk.
  if (remote.track.source === 'local') return [{ kind: 'unsupported', track: remote.track }];
  const target = remote.pos + (remote.playing ? LATENCY_SEC : 0);
  if (local.trackId !== remote.track.id) return [{ kind: 'load', track: remote.track, pos: target, playing: remote.playing }];
  const out: SyncAction[] = [];
  if (Math.abs(local.pos - target) > MAX_DRIFT_SEC) out.push({ kind: 'seek', pos: target });
  if (remote.playing && !local.playing) out.push({ kind: 'play' });
  if (!remote.playing && local.playing) out.push({ kind: 'pause' });
  return out;
}

const PREFIX = 'RSN1.';

function toB64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** SDP → short-ish copyable code (deflate + base64url). */
export async function encodeCode(sdp: RTCSessionDescriptionInit): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify({ t: sdp.type, s: sdp.sdp }));
  return PREFIX + toB64Url(await pipe(raw, new CompressionStream('deflate-raw')));
}

export async function decodeCode(code: string): Promise<RTCSessionDescriptionInit> {
  const trimmed = code.trim().replace(/\s+/g, '');
  if (!trimmed.startsWith(PREFIX)) throw new Error('bad code');
  const json = new TextDecoder().decode(await pipe(fromB64Url(trimmed.slice(PREFIX.length)), new DecompressionStream('deflate-raw')));
  const v = JSON.parse(json) as { t?: string; s?: string };
  if ((v.t !== 'offer' && v.t !== 'answer') || typeof v.s !== 'string') throw new Error('bad code');
  return { type: v.t, sdp: v.s };
}
