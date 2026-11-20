import type { Track } from '../types';

export type YtMusicTrack = {
  videoId: string;
  title: string;
  artist?: string;
  artists?: string[];
  artworkUrl?: string | null;
  durationSeconds?: number | null;
  available?: boolean;
  setVideoId?: string | null;
};

export type YtMusicPlaylist = {
  playlistId: string;
  title: string;
  artworkUrl?: string | null;
  trackCount: number;
  tracks?: YtMusicTrack[];
};

export type YtMusicProfile = { name?: string; handle?: string; picture?: string };

/**
 * Music artwork URLs (googleusercontent) carry the requested crop size in the
 * URL ("...=w120-h120-l90-rj"), which is whatever the API page offered — often
 * 120–226 px, far below the size covers are shown at. The stored image is much
 * larger, so rewriting the size segment to the 544×544 crop YouTube Music
 * itself uses for large art gets real detail instead of a blurry upscale.
 */
export const YTM_ARTWORK_PX = 544;

export function upscaleYtmArtwork(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (!url.includes('googleusercontent.com')) return url;
  return url.replace(/=w(\d+)-h(\d+)/, (match, w, h) =>
    Math.max(Number(w), Number(h)) >= YTM_ARTWORK_PX ? match : `=w${YTM_ARTWORK_PX}-h${YTM_ARTWORK_PX}`,
  );
}
export type YtMusicLibrary = {
  profile: YtMusicProfile;
  playlists: YtMusicPlaylist[];
  likedSongs: YtMusicTrack[];
};

export function mapYtMusicTrack(track: YtMusicTrack, occurrenceId?: string): Track {
  const videoId = String(track.videoId || '').trim();
  const artist = track.artist || track.artists?.filter(Boolean).join(', ') || 'YouTube Music';
  const duration = Number(track.durationSeconds) || 0;
  const fallbackCover = videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : undefined;
  const artwork = upscaleYtmArtwork(track.artworkUrl) || fallbackCover;
  return {
    id: occurrenceId ? `yt:${videoId}~${encodeURIComponent(occurrenceId)}` : `yt:${videoId}`,
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
    ...(track.setVideoId ? { setVideoId: track.setVideoId } : {}),
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
    ? upscaleYtmArtwork(firstTrackArt.artworkUrl) ||
      (firstTrackArt.videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(firstTrackArt.videoId)}/hqdefault.jpg` : null)
    : null;
  return {
    ...playlist,
    artworkUrl: upscaleYtmArtwork(playlist.artworkUrl) || fallbackArt || null,
    trackCount,
  };
}

export function mapYtMusicTracks(tracks: YtMusicTrack[], preserveOccurrences = false): Track[] {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  if (preserveOccurrences) {
    for (const track of tracks) {
      const id = String(track.videoId || '').trim();
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const occurrences = new Map<string, number>();
  const seenOccurrences = new Set<string>();
  return tracks.flatMap((track) => {
    const videoId = String(track.videoId || '').trim();
    if (!videoId) return [];
    if (!preserveOccurrences) {
      if (seen.has(videoId)) return [];
      seen.add(videoId);
      return [mapYtMusicTrack(track)];
    }
    const setVideoId = String(track.setVideoId || '').trim();
    const ordinal = occurrences.get(videoId) ?? 0;
    occurrences.set(videoId, ordinal + 1);
    const key = setVideoId ? `${videoId}:${setVideoId}` : `${videoId}:occurrence:${ordinal}`;
    if (seenOccurrences.has(key)) return [];
    seenOccurrences.add(key);
    const occurrenceId = (counts.get(videoId) ?? 0) > 1 ? setVideoId || `occurrence-${ordinal}` : undefined;
    return [mapYtMusicTrack(track, occurrenceId)];
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
