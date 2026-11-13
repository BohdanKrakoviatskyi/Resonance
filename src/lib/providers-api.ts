import { invoke } from '@tauri-apps/api/core';
import { rpc } from './sidecar';
import { ytMusicRpc } from './ytmusic-sidecar';
import type { YtMusicLibrary, YtMusicPlaylist } from './ytmusic-library';

export type SoundCloudProfile = {
  id: number;
  username: string;
  fullName?: string;
  permalinkUrl?: string;
  avatarUrl?: string;
  city?: string;
  country?: string;
  followersCount?: number;
  trackCount?: number;
  likesCount?: number;
};

export type SoundCloudAuthStatus = {
  authorized: boolean;
  profile?: SoundCloudProfile;
};


export type SoundCloudSearchTrack = {
  id: number;
  urn: string;
  title: string;
  permalinkUrl: string;
  artworkUrl: string;
  duration: number;
  user: {
    username: string;
    avatarUrl: string;
  };
};

export type SoundCloudTrackCard = {
  id: number;
  trackUrn: string;
  title: string;
  permalinkUrl?: string;
  artworkUrl?: string;
  duration: number;
  user: { username: string };
};

export type SoundCloudPlaylistCard = {
  id: string;
  urn: string;
  title: string;
  permalinkUrl: string;
  artworkUrl: string;
  trackCount: number;
  user: { username: string };
};

export type SoundCloudLyrics = {
  trackId: number;
  lines: { id: string; text: string; startMs: number }[];
  sourceUrl?: string;
  isSynced: boolean;
};


export type YtMusicAuthProfile = {
  name?: string;
  handle?: string;
  picture?: string;
};

export type YtMusicAuthStatus = {
  authorized: boolean;
  profile?: YtMusicAuthProfile;
};

export type YtMusicAuthHeaders = Record<string, string>;

export type YouTubeTrack = {
  nativeId: string;
  source: string;
  urn: string;
  title: string;
  permalink?: string;
  artworkUrl?: string;
  durationMs: number;
  viewCount?: number;
  likeCount?: number;
  categoryId?: string;
  channelId?: string;
  subscriberCount?: number;
  artist: string;
  publishedAt?: string;
};

export function soundCloudAuthStatus(signal?: AbortSignal): Promise<SoundCloudAuthStatus> {
  return rpc('auth.status', {}, signal);
}

export function soundCloudSetClientId(clientId: string, signal?: AbortSignal): Promise<unknown> {
  return rpc('settings.update', { clientId }, signal);
}

export function soundCloudAuthLogin(token: string, signal?: AbortSignal): Promise<SoundCloudAuthStatus> {
  return rpc('auth.login', { token }, signal);
}

export function soundCloudAuthRefresh(signal?: AbortSignal): Promise<SoundCloudAuthStatus> {
  return rpc('auth.refresh', {}, signal);
}

export function soundCloudAuthLogout(signal?: AbortSignal): Promise<SoundCloudAuthStatus> {
  return rpc('auth.logout', {}, signal);
}

export function searchSoundCloudTracks(query: string, signal?: AbortSignal): Promise<SoundCloudSearchTrack[]> {
  return rpc('search.tracks', { query }, signal);
}

export function soundCloudRelatedTracks(trackId: number, signal?: AbortSignal): Promise<SoundCloudSearchTrack[]> {
  return rpc('track.related', { trackId }, signal);
}

export function soundCloudTracksMine(signal?: AbortSignal): Promise<SoundCloudTrackCard[]> {
  return rpc('tracks.mine', {}, signal);
}

export function soundCloudPlaylistsMine(signal?: AbortSignal): Promise<SoundCloudPlaylistCard[]> {
  return rpc('playlists.mine', {}, signal);
}

export function soundCloudPlaylistTracks(playlistUrn: string, signal?: AbortSignal): Promise<SoundCloudTrackCard[]> {
  return rpc('playlist.tracks', { playlistUrn }, signal);
}

export function soundCloudTrackLyrics(params: { trackId: number; title: string; artist: string; durationMs: number }, signal?: AbortSignal): Promise<SoundCloudLyrics> {
  return rpc('track.lyrics', params, signal);
}


export function ytMusicAuthStatus(signal?: AbortSignal): Promise<YtMusicAuthStatus> {
  return ytMusicRpc('auth.status', {}, signal);
}

export function ytMusicAuthSave(headers: YtMusicAuthHeaders, signal?: AbortSignal): Promise<YtMusicAuthStatus> {
  return ytMusicRpc('auth.save', { headers }, signal);
}

export function ytMusicAuthLogout(signal?: AbortSignal): Promise<YtMusicAuthStatus> {
  return ytMusicRpc('auth.logout', {}, signal);
}

export function ytMusicLibrarySync(signal?: AbortSignal): Promise<YtMusicLibrary> {
  return ytMusicRpc('library.sync', {}, signal);
}

type Inflight<T> = { promise: Promise<T>; controller: AbortController; refs: number };
const inflightPlaylists = new Map<string, Inflight<YtMusicPlaylist>>();
const inflightTrackStreams = new Map<string, Inflight<YtStreamResolveResult>>();
const inflightSidecarStreams = new Map<string, Inflight<YtStreamResolveResult>>();

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

// Tauri invoke() takes no AbortSignal, so the caller unblocks on abort while invoke settles in the background.
function invokeAbortable<T>(cmd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  const call = invoke<T>(cmd, args);
  if (!signal) return call;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    call.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

// Concurrent callers share one run. The run is aborted only once every waiter has left, so one aborted waiter never fails the others.
function shareInflight<T>(
  map: Map<string, Inflight<T>>,
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let shared = map.get(key);
  if (!shared) {
    const controller = new AbortController();
    const promise: Promise<T> = run(controller.signal).finally(() => {
      if (map.get(key)?.promise === promise) map.delete(key);
    });
    shared = { promise, controller, refs: 0 };
    map.set(key, shared);
  }
  shared.refs++;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
      if (--shared.refs === 0) {
        shared.controller.abort();
        if (map.get(key) === shared) map.delete(key);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (value) => { signal?.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal?.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

export async function ytMusicPlaylistTracks(playlistId: string, signal?: AbortSignal): Promise<YtMusicPlaylist> {
  return shareInflight(inflightPlaylists, playlistId, async (runSignal) => {
    try {
      const playlist = await invokeAbortable<YtMusicPlaylist>('fetch_yt_playlist_tracks', { playlistId }, runSignal);
      // Rust returns an error for unparseable playlists, so a well-formed tracks array (even empty) is authoritative.
      if (Array.isArray(playlist?.tracks)) return playlist;
    } catch {
      throwIfAborted(runSignal);
      // Fallback to ytmusic-worker (ytmusicapi / InnerTube browse) for playlists yt-dlp can't parse.
    }
    return ytMusicRpc<YtMusicPlaylist>('playlist.tracks', { playlistId }, runSignal);
  }, signal);
}

export function ytMusicPlaylistArtwork(playlistId: string, signal?: AbortSignal): Promise<string | null> {
  return ytMusicRpc('playlist.artwork', { playlistId }, signal);
}

export async function searchYtDlpTracks(query: string, signal?: AbortSignal): Promise<YouTubeTrack[]> {
  try {
    const tracks = await invokeAbortable<YouTubeTrack[]>('search_yt_tracks', { query }, signal);
    if (Array.isArray(tracks)) return tracks;
  } catch {
    throwIfAborted(signal);
    // Fallback to sidecar yt-dlp search if Rust InnerTube search fails
  }
  throwIfAborted(signal);
  return rpc('yt.dlp.search', { query }, signal);
}

export type YtResolveAttemptTiming = {
  method: string;
  outcome: string;
  durationMs: number;
};

export type YtStreamResolveResult = {
  url: string;
  cacheHit?: boolean;
  resolveMs?: number;
  attempts?: YtResolveAttemptTiming[];
};

export type YtStreamResolveOptions = {
  requestId?: number;
  clickTsMs?: number;
  priority?: boolean;
  preferSidecar?: boolean;
  signal?: AbortSignal;
};

// Rust errors that a sidecar retry cannot fix (matched by message prefix).
const NON_RECOVERABLE_RUST_ERRORS = ['Некорректный ID видео YouTube.'];

function withAttempts(err: unknown, attempts: YtResolveAttemptTiming[]): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  (error as Error & { attempts?: YtResolveAttemptTiming[] }).attempts = attempts;
  return error;
}

export async function ytDlpTrackStream(
  videoId: string,
  options?: AbortSignal | YtStreamResolveOptions,
): Promise<YtStreamResolveResult> {
  const opts: YtStreamResolveOptions =
    options && 'aborted' in options ? { signal: options } : (options ?? {});
  throwIfAborted(opts.signal);

  if (opts.preferSidecar) {
    return ytDlpSidecarStream(videoId, opts);
  }

  // Different requestId/clickTs produce different proxy URLs, so they are part of the key.
  const key = [videoId, opts.requestId, opts.clickTsMs, opts.priority ?? true].join('|');
  return shareInflight(inflightTrackStreams, key, (runSignal) => resolveRustStream(videoId, { ...opts, signal: runSignal }), opts.signal);
}

async function resolveRustStream(videoId: string, opts: YtStreamResolveOptions): Promise<YtStreamResolveResult> {
  const attempts: YtResolveAttemptTiming[] = [];
  const t0 = performance.now();
  try {
    const res = await invokeAbortable<YtStreamResolveResult>('resolve_yt_stream_url', {
      videoId,
      requestId: opts.requestId,
      clickTsMs: opts.clickTsMs,
      priority: opts.priority ?? true,
    }, opts.signal);
    if (res?.url) {
      return {
        url: res.url,
        cacheHit: res.cacheHit,
        resolveMs: res.resolveMs ?? Math.round(performance.now() - t0),
        attempts: res.attempts?.length
          ? res.attempts
          : [{ method: 'rust_yt_proxy', outcome: 'ok', durationMs: Math.round(performance.now() - t0) }],
      };
    }
    attempts.push(...(res?.attempts ?? []), {
      method: 'rust_yt_proxy',
      outcome: 'empty',
      durationMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    throwIfAborted(opts.signal);
    const message = err instanceof Error ? err.message : String(err);
    attempts.push({
      method: 'rust_yt_proxy',
      outcome: `err: ${message}`,
      durationMs: Math.round(performance.now() - t0),
    });
    if (NON_RECOVERABLE_RUST_ERRORS.some((prefix) => message.startsWith(prefix))) {
      throw withAttempts(new Error(message), attempts);
    }
  }

  return ytDlpSidecarStream(videoId, opts, attempts, t0);
}

export async function ytDlpSidecarStream(
  videoId: string,
  options?: AbortSignal | YtStreamResolveOptions,
  priorAttempts: YtResolveAttemptTiming[] = [],
  startedAt = performance.now(),
): Promise<YtStreamResolveResult> {
  const opts: YtStreamResolveOptions =
    options && 'aborted' in options ? { signal: options } : (options ?? {});
  const attempts = [...priorAttempts];
  throwIfAborted(opts.signal);
  const t1 = performance.now();
  let fallback: { url: string } | undefined;
  try {
    fallback = await shareInflight(
      inflightSidecarStreams,
      videoId,
      (runSignal) => rpc<{ url: string }>('yt.dlp.stream', { videoId }, runSignal),
      opts.signal,
    );
  } catch (err) {
    if (opts.signal?.aborted) throw abortError();
    attempts.push({
      method: 'sidecar: yt.dlp.stream',
      outcome: `err: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Math.round(performance.now() - t1),
    });
    throw withAttempts(err, attempts);
  }
  const sidecarMs = Math.round(performance.now() - t1);
  if (!fallback?.url) {
    attempts.push({ method: 'sidecar: yt.dlp.stream', outcome: 'empty', durationMs: sidecarMs });
    throw withAttempts(new Error('yt-dlp sidecar returned no stream URL'), attempts);
  }
  attempts.push({ method: 'sidecar: yt.dlp.stream', outcome: 'ok', durationMs: sidecarMs });
  return {
    url: fallback.url,
    cacheHit: false,
    resolveMs: Math.round(performance.now() - startedAt),
    attempts,
  };
}

export type CacheClearResult = {
  audioFilesDeleted: number;
  audioBytesFreed: number;
  lyricsEntriesCleared: number;
  streamEntriesCleared: number;
};

export function clearCache(signal?: AbortSignal): Promise<CacheClearResult> {
  return rpc('cache.clear', {}, signal);
}

export function backupFrontendState(entries: Record<string, string>, signal?: AbortSignal): Promise<Record<string, string>> {
  return rpc('frontend.backup', { entries }, signal);
}

export function restoreFrontendState(signal?: AbortSignal): Promise<Record<string, string>> {
  return rpc('frontend.restore', {}, signal);
}
