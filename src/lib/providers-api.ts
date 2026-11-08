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

export function ytMusicPlaylistTracks(playlistId: string, signal?: AbortSignal): Promise<YtMusicPlaylist> {
  return ytMusicRpc('playlist.tracks', { playlistId }, signal);
}

export function ytMusicPlaylistArtwork(playlistId: string, signal?: AbortSignal): Promise<string | null> {
  return ytMusicRpc('playlist.artwork', { playlistId }, signal);
}

export function searchYtDlpTracks(query: string, signal?: AbortSignal): Promise<YouTubeTrack[]> {
  return rpc('yt.dlp.search', { query }, signal);
}

export function ytDlpTrackStream(videoId: string, signal?: AbortSignal): Promise<{ url: string }> {
  return rpc('yt.dlp.stream', { videoId }, signal);
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
