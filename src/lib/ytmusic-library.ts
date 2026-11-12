import type { Track } from '../types';

export type YtMusicTrack = {
  videoId: string;
  title: string;
  artist?: string;
  artists?: string[];
  artworkUrl?: string | null;
  durationSeconds?: number | null;
  available?: boolean;
};

export type YtMusicPlaylist = {
  playlistId: string;
  title: string;
  artworkUrl?: string | null;
  trackCount: number;
  tracks?: YtMusicTrack[];
};

export type YtMusicProfile = { name?: string; handle?: string; picture?: string };
export type YtMusicLibrary = {
  profile: YtMusicProfile;
  playlists: YtMusicPlaylist[];
  likedSongs: YtMusicTrack[];
};

export function mapYtMusicTrack(track: YtMusicTrack): Track {
  const videoId = String(track.videoId || '').trim();
  const artist = track.artist || track.artists?.filter(Boolean).join(', ') || 'YouTube Music';
  const duration = Number(track.durationSeconds) || 0;
  const fallbackCover = videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : undefined;
  const artwork = track.artworkUrl || fallbackCover;
  return {
    id: `yt:${videoId}`,
    title: track.title || 'Unknown title',
    artist,
    cover: artwork,
    thumb: artwork,
    src: `https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    duration,
    fullDuration: duration || undefined,
    nativeId: videoId,
    playback: 'direct',
    source: 'youtube',
  };
}

export function normalizeYtMusicPlaylist(playlist: YtMusicPlaylist): YtMusicPlaylist {
  const rawCount = Number(playlist.trackCount);
  const trackCount =
    Number.isFinite(rawCount) && rawCount > 0
      ? Math.round(rawCount)
      : Array.isArray(playlist.tracks) && playlist.tracks.length > 0
      ? playlist.tracks.length
      : Number.isFinite(rawCount) && rawCount >= 0
      ? Math.round(rawCount)
      : 0;
  const firstTrackArt = playlist.tracks?.find((t) => Boolean(t?.artworkUrl || t?.videoId));
  const fallbackArt = firstTrackArt
    ? firstTrackArt.artworkUrl ||
      (firstTrackArt.videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(firstTrackArt.videoId)}/hqdefault.jpg` : null)
    : null;
  return {
    ...playlist,
    artworkUrl: playlist.artworkUrl || fallbackArt || null,
    trackCount,
  };
}

export function mapYtMusicTracks(tracks: YtMusicTrack[]): Track[] {
  const seen = new Set<string>();
  return tracks.flatMap((track) => {
    const id = String(track.videoId || '').trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [mapYtMusicTrack(track)];
  });
}

export const YTMUSIC_LIKED_ID = 'ytliked';

export const ytmusicPlaylistId = (playlistId: string) => `ytpl:${playlistId}`;

export type YtMusicCollection =
  | { kind: 'playlist'; playlistId: string }
  | { kind: 'liked' };

export function parseYtMusicCollectionId(id?: string): YtMusicCollection | null {
  if (id === YTMUSIC_LIKED_ID) return { kind: 'liked' };
  if (id?.startsWith('ytpl:') && id.length > 5) return { kind: 'playlist', playlistId: id.slice(5) };
  return null;
}
