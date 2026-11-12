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

export async function ytMusicPlaylistTracks(playlistId: string, signal?: AbortSignal): Promise<YtMusicPlaylist> {
  try {
    const playlist = await invoke<YtMusicPlaylist>('fetch_yt_playlist_tracks', { playlistId });
    if (playlist?.tracks && playlist.tracks.length > 0) return playlist;
  } catch {
    // Fallback to ytmusic-worker (ytmusicapi / InnerTube browse) for playlists yt-dlp can't parse.
  }
  return ytMusicRpc<YtMusicPlaylist>('playlist.tracks', { playlistId }, signal);
}

export function ytMusicPlaylistArtwork(playlistId: string, signal?: AbortSignal): Promise<string | null> {
  return ytMusicRpc('playlist.artwork', { playlistId }, signal);
}

export async function searchYtDlpTracks(query: string, signal?: AbortSignal): Promise<YouTubeTrack[]> {
  try {
    const tracks = await invoke<YouTubeTrack[]>('search_yt_tracks', { query });
    if (tracks && tracks.length > 0) return tracks;
  } catch {
    // Fallback to sidecar yt-dlp search if Rust InnerTube search fails
  }
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
  signal?: AbortSignal;
};

export async function ytDlpTrackStream(
  videoId: string,
  options?: AbortSignal | YtStreamResolveOptions,
): Promise<YtStreamResolveResult> {
  const opts: YtStreamResolveOptions =
    options && 'aborted' in options ? { signal: options } : (options ?? {});
  const attempts: YtResolveAttemptTiming[] = [];
  const t0 = performance.now();
  try {
    const res = await invoke<YtStreamResolveResult>('resolve_yt_stream_url', {
      videoId,
      requestId: opts.requestId,
      clickTsMs: opts.clickTsMs,
      priority: opts.priority ?? true,
    });
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
  } catch (err) {
    attempts.push({
      method: 'rust_yt_proxy',
      outcome: `err: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Math.round(performance.now() - t0),
    });
  }
  const t1 = performance.now();
  try {
    const fallback = await rpc<{ url: string }>('yt.dlp.stream', { videoId }, opts.signal);
    const sidecarMs = Math.round(performance.now() - t1);
    attempts.push({
      method: 'sidecar: yt.dlp.stream',
      outcome: fallback?.url ? 'ok' : 'empty',
      durationMs: sidecarMs,
    });
    return {
      url: fallback.url,
      cacheHit: false,
      resolveMs: Math.round(performance.now() - t0),
      attempts,
    };
  } catch (err) {
    const sidecarMs = Math.round(performance.now() - t1);
    attempts.push({
      method: 'sidecar: yt.dlp.stream',
      outcome: `err: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: sidecarMs,
    });
    const error = err instanceof Error ? err : new Error(String(err));
    (error as Error & { attempts?: YtResolveAttemptTiming[] }).attempts = attempts;
    throw error;
  }
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
