import { invokeAbortable, shareInflight, type Inflight } from './ipc';
import type { YtMusicLibrary, YtMusicPlaylist } from './ytmusic-library';
import type { YouTubeTrack, YtMusicAuthHeaders, YtMusicAuthStatus, YtStreamResolveOptions, YtStreamResolveResult } from './providers-api';

export type YtSearchSuggestions = {
  queries: string[];
  tracks: YouTubeTrack[];
};

export type YtCacheClearResult = {
  audioFilesDeleted: number;
  audioBytesFreed: number;
  streamEntriesCleared: number;
};

const inflightPlaylists = new Map<string, Inflight<YtMusicPlaylist>>();
const inflightStreams = new Map<string, Inflight<YtStreamResolveResult>>();

export function ytAuthStatus(signal?: AbortSignal): Promise<YtMusicAuthStatus> {
  return invokeAbortable('yt_auth_status', {}, signal);
}

export function ytAuthSave(headers: YtMusicAuthHeaders, signal?: AbortSignal): Promise<YtMusicAuthStatus> {
  return invokeAbortable('yt_auth_save', { headers }, signal);
}

export function ytAuthLogout(signal?: AbortSignal): Promise<YtMusicAuthStatus> {
  return invokeAbortable('yt_auth_logout', {}, signal);
}

export function ytLibraryCached(signal?: AbortSignal): Promise<YtMusicLibrary | null> {
  return invokeAbortable('yt_library_cached', {}, signal);
}

export function ytLibrarySync(signal?: AbortSignal): Promise<YtMusicLibrary> {
  return invokeAbortable('yt_library_sync', {}, signal);
}

export function ytPlaylistCached(playlistId: string, signal?: AbortSignal): Promise<YtMusicPlaylist | null> {
  return invokeAbortable('yt_playlist_tracks_cached', { playlistId }, signal);
}

export function ytPlaylistSync(playlistId: string, signal?: AbortSignal): Promise<YtMusicPlaylist> {
  return shareInflight(
    inflightPlaylists,
    playlistId,
    (runSignal) => invokeAbortable<YtMusicPlaylist>('yt_playlist_tracks_sync', { playlistId }, runSignal),
    signal,
  );
}

export function ytPlaylistArt(playlistId: string, signal?: AbortSignal): Promise<string | null> {
  return invokeAbortable('yt_playlist_artwork', { playlistId }, signal);
}

export function ytSearchTracks(query: string, signal?: AbortSignal): Promise<YouTubeTrack[]> {
  return invokeAbortable('search_yt_tracks', { query }, signal);
}

export function ytSearchSuggestions(query: string, signal?: AbortSignal): Promise<YtSearchSuggestions> {
  return invokeAbortable('yt_search_suggestions', { query }, signal);
}

export function ytRadio(videoId: string, signal?: AbortSignal): Promise<YouTubeTrack[]> {
  return invokeAbortable<YouTubeTrack[]>('yt_radio_tracks', { videoId }, signal).then((r) => (Array.isArray(r) ? r : []));
}

export function ytResolveStream(videoId: string, options?: AbortSignal | YtStreamResolveOptions): Promise<YtStreamResolveResult> {
  const opts: YtStreamResolveOptions = options && 'aborted' in options ? { signal: options } : (options ?? {});
  const key = [videoId, opts.requestId, opts.clickTsMs, opts.priority ?? true].join('|');
  return shareInflight(
    inflightStreams,
    key,
    (runSignal) =>
      invokeAbortable<YtStreamResolveResult>(
        'resolve_yt_stream_url',
        {
          videoId,
          requestId: opts.requestId,
          clickTsMs: opts.clickTsMs,
          priority: opts.priority ?? true,
        },
        runSignal,
      ),
    opts.signal,
  );
}

export type ExternalPlaylistTrack = {
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  artworkUrl?: string;
  nativeId?: string;
};

export type ExternalPlaylistResponse = {
  source: 'youtube' | 'spotify' | 'deezer' | 'apple_music';
  title: string;
  artworkUrl?: string;
  tracks: ExternalPlaylistTrack[];
};

export function ytClearNativeCache(signal?: AbortSignal): Promise<YtCacheClearResult> {
  return invokeAbortable('yt_clear_cache', {}, signal);
}

export function fetchExternalPlaylist(url: string, signal?: AbortSignal): Promise<ExternalPlaylistResponse> {
  return invokeAbortable('fetch_external_playlist', { url }, signal);
}
