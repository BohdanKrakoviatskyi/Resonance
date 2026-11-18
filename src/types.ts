export type Source = 'soundcloud' | 'youtube' | 'local';

export interface LyricLine {
  t: number;
  text: string;
  gap?: boolean;
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
  preview?: boolean;
  playback?: 'direct';
  source: Source;
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
