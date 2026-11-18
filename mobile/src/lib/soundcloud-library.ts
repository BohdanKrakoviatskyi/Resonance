export const SOUNDCLOUD_LIKED_ID = 'scliked';
export const soundcloudPlaylistId = (id: string) => `scpl:${id}`;

export type SoundCloudCollection =
  | { kind: 'playlist'; playlistId: string }
  | { kind: 'liked' };

export function parseSoundCloudCollectionId(id?: string): SoundCloudCollection | null {
  if (id === SOUNDCLOUD_LIKED_ID) return { kind: 'liked' };
  if (id?.startsWith('scpl:') && id.length > 5) return { kind: 'playlist', playlistId: id.slice(5) };
  return null;
}
