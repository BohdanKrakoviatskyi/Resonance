import { rpc } from './backend';
import type { YtMusicLibrary, YtMusicPlaylist } from './ytmusic-library';
import {
  ytAuthLogout,
  ytAuthSave,
  ytAuthStatus,
  ytClearNativeCache,
  ytLibraryCached,
  ytLibrarySync,
  ytPlaylistArt,
  ytPlaylistCached,
  ytPlaylistSync,
  ytRadio,
  ytResolveStream,
  ytSearchSuggestions,
  ytSearchTracks,
} from './yt-api';

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

export type SoundCloudAuthStatus = { authorized: boolean; profile?: SoundCloudProfile };
export type SoundCloudSearchTrack = {
  id: number;
  urn: string;
  title: string;
  permalinkUrl: string;
  artworkUrl: string;
  duration: number;
  user: { username: string; avatarUrl: string };
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

export type YtMusicAuthProfile = { name?: string; handle?: string; picture?: string };
export type YtMusicAuthStatus = { authorized: boolean; profile?: YtMusicAuthProfile };
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

export type YtResolveAttemptTiming = { method: string; outcome: string; durationMs: number };
export type YtStreamResolveResult = { url: string; cacheHit?: boolean; resolveMs?: number; attempts?: YtResolveAttemptTiming[] };
export type YtStreamResolveOptions = { requestId?: number; clickTsMs?: number; priority?: boolean; preferSidecar?: boolean; signal?: AbortSignal };
export type CacheClearResult = { audioFilesDeleted: number; audioBytesFreed: number; lyricsEntriesCleared: number; streamEntriesCleared: number };

export const soundCloudAuthStatus = (signal?: AbortSignal): Promise<SoundCloudAuthStatus> => rpc('auth.status', {}, signal);
export const soundCloudSetClientId = (clientId: string, signal?: AbortSignal): Promise<unknown> => rpc('settings.update', { clientId }, signal);
export const soundCloudAuthLogin = (token: string, signal?: AbortSignal): Promise<SoundCloudAuthStatus> => rpc('auth.login', { token }, signal);
export const soundCloudAuthRefresh = (signal?: AbortSignal): Promise<SoundCloudAuthStatus> => rpc('auth.refresh', {}, signal);
export const soundCloudAuthLogout = (signal?: AbortSignal): Promise<SoundCloudAuthStatus> => rpc('auth.logout', {}, signal);
export const searchSoundCloudTracks = (query: string, signal?: AbortSignal): Promise<SoundCloudSearchTrack[]> => rpc('search.tracks', { query }, signal);
export const soundCloudRelatedTracks = (trackId: number, signal?: AbortSignal): Promise<SoundCloudSearchTrack[]> => rpc('track.related', { trackId }, signal);
export const soundCloudTracksMine = (signal?: AbortSignal): Promise<SoundCloudTrackCard[]> => rpc('tracks.mine', {}, signal);
export const soundCloudPlaylistsMine = (signal?: AbortSignal): Promise<SoundCloudPlaylistCard[]> => rpc('playlists.mine', {}, signal);
export const soundCloudPlaylistTracks = (playlistUrn: string, signal?: AbortSignal): Promise<SoundCloudTrackCard[]> => rpc('playlist.tracks', { playlistUrn }, signal);
export const soundCloudTrackLyrics = (params: { trackId: number; title: string; artist: string; durationMs: number }, signal?: AbortSignal): Promise<SoundCloudLyrics> => rpc('track.lyrics', params, signal);

export const ytMusicAuthStatus = ytAuthStatus;
export const ytMusicAuthSave = ytAuthSave;
export const ytMusicAuthLogout = ytAuthLogout;
export const ytMusicLibraryCached = (signal?: AbortSignal): Promise<YtMusicLibrary | null> => ytLibraryCached(signal);
export const ytMusicLibrarySync = ytLibrarySync;
export const ytMusicPlaylistCached = (playlistId: string, signal?: AbortSignal): Promise<YtMusicPlaylist | null> => ytPlaylistCached(playlistId, signal);
export const ytMusicPlaylistTracks = ytPlaylistSync;
export const ytMusicPlaylistArtwork = ytPlaylistArt;
export const searchYtDlpTracks = ytSearchTracks;
export const ytMusicSearchSuggestions = ytSearchSuggestions;
export const ytRadioTracks = ytRadio;
export const ytDlpTrackStream = ytResolveStream;

export async function clearCache(signal?: AbortSignal): Promise<CacheClearResult> {
  const [goRes, ytRes] = await Promise.all([
    rpc<CacheClearResult>('cache.clear', {}, signal).catch(() => ({ audioFilesDeleted: 0, audioBytesFreed: 0, lyricsEntriesCleared: 0, streamEntriesCleared: 0 })),
    ytClearNativeCache(signal).catch(() => ({ audioFilesDeleted: 0, audioBytesFreed: 0, streamEntriesCleared: 0 })),
  ]);
  return {
    audioFilesDeleted: goRes.audioFilesDeleted + ytRes.audioFilesDeleted,
    audioBytesFreed: goRes.audioBytesFreed + ytRes.audioBytesFreed,
    lyricsEntriesCleared: goRes.lyricsEntriesCleared,
    streamEntriesCleared: goRes.streamEntriesCleared + ytRes.streamEntriesCleared,
  };
}

export type ResolvedSoundCloudPlaylist = {
  title: string;
  artworkUrl?: string;
  tracks: SoundCloudTrackCard[];
};

export type ResolvedSoundCloudLikes = {
  username: string;
  avatarUrl?: string;
  artworkUrl?: string;
  tracks: SoundCloudTrackCard[];
};

export const soundCloudResolvePlaylist = (url: string, signal?: AbortSignal): Promise<ResolvedSoundCloudPlaylist> =>
  rpc('resolve.playlist', { url }, signal);
export const soundCloudUserLikesByInput = (input: string, signal?: AbortSignal): Promise<ResolvedSoundCloudLikes> =>
  rpc('user.likes.by.input', { input }, signal);

export const backupFrontendState = (entries: Record<string, string>, signal?: AbortSignal): Promise<Record<string, string>> => rpc('frontend.backup', { entries }, signal);
export const restoreFrontendState = (signal?: AbortSignal): Promise<Record<string, string>> => rpc('frontend.restore', {}, signal);
