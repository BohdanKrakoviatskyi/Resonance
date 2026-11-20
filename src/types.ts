export type Source = 'soundcloud' | 'youtube' | 'local';

export interface LyricWord {
  /** Start, seconds. */
  t: number;
  /** Duration, seconds. */
  d: number;
  /** Includes its trailing space, so joining words yields the line. */
  text: string;
}

export interface LyricLine {
  t: number;
  text: string;
  gap?: boolean;
  /** Word timing for karaoke highlighting, when the source provides it. */
  words?: LyricWord[];
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  cover?: string;
  thumb?: string;
  src: string;
  duration: number;
  fullDuration?: number;
  nativeId?: string;
  /** YT Music playlist occurrence ID required to remove one specific playlist entry. */
  setVideoId?: string;
  preview?: boolean;
  playback?: 'direct';
  source: Source;
  /** Real performer from provider metadata (SoundCloud publisher_metadata), when the uploader differs. */
  metaArtist?: string;
  lyrics?: LyricLine[];
}

export type PlaylistSection = 'local' | 'youtube' | 'soundcloud';

export interface Playlist {
  id: string;
  name: string;
  ids: string[];
  created: number;
  artworkUrl?: string;
  section?: PlaylistSection;
  /** Link the playlist was imported from; enables "Update from source". */
  sourceUrl?: string;
  sourceMode?: 'playlist' | 'sc_likes';
  syncedAt?: number;
}

export interface SoundCloudPlaylist {
  id: string;
  urn: string;
  name: string;
  artworkUrl?: string;
  permalinkUrl?: string;
  trackCount: number;
  username: string;
}
