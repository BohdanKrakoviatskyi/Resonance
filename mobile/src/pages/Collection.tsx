import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, IconButton, Loader, Segmented } from '../components/ui';
import { PlaylistCover } from '../components/Cover';
import { MobileTrackList } from '../components/TrackList';
import { shuffled, useStore } from '../lib/util';
import { t, tracksLabel, useLang } from '../lib/i18n';
import { parseYtMusicCollectionId } from '../lib/ytmusic-library';
import {
  getFavoriteIds,
  getTrack,
  library,
  loadSoundCloudPlaylistTracks,
  loadYtMusicPlaylistTracks,
} from '../state/library';
import { playQueue } from '../state/player';
import { go, openDialog, ui } from '../state/ui';
import type { Track } from '../types';

export default function Collection({ kind, id }: { kind: 'favorites' | 'playlist'; id?: string }) {
  useLang();
  const [filterQ, setFilterQ] = useState('');
  const [loadingRemote, setLoadingRemote] = useState(false);
  const favProvider = useStore(ui, (s) => s.favProvider);
  const lib = useStore(library, (s) => s);

  const parsedYt = parseYtMusicCollectionId(id);
  const isYtPl = parsedYt?.kind === 'playlist';
  const isScPl = Boolean(id && id.startsWith('scpl:'));
  const ytRawId = parsedYt?.kind === 'playlist' ? parsedYt.playlistId : '';
  const scPl = isScPl ? lib.soundcloudPlaylists.find((p) => `scpl:${p.id}` === id) : undefined;
  const localPl = !isYtPl && !isScPl && id ? lib.playlists.find((p) => p.id === id) : undefined;
  const ytPl = isYtPl ? lib.ytmusicPlaylists.find((p) => p.playlistId === ytRawId) : undefined;

  useEffect(() => {
    let active = true;
    if (isYtPl && ytRawId) {
      setLoadingRemote(true);
      void loadYtMusicPlaylistTracks(ytRawId).finally(() => {
        if (active) setLoadingRemote(false);
      });
    } else if (isScPl && scPl?.urn) {
      setLoadingRemote(true);
      void loadSoundCloudPlaylistTracks(scPl.urn).finally(() => {
        if (active) setLoadingRemote(false);
      });
    }
    return () => {
      active = false;
    };
  }, [isYtPl, ytRawId, isScPl, scPl?.urn]);

  let title = t('favorites');
  let tracks: Track[] = [];
  let artworkUrl: string | undefined;

  if (kind === 'favorites') {
    tracks = getFavoriteIds(favProvider)
      .map((tid) => getTrack(tid))
      .filter((tr): tr is Track => Boolean(tr));
  } else if (isYtPl) {
    title = ytPl?.title ?? t('playlist');
    artworkUrl = lib.ytmusicPlaylistArt[ytRawId] ?? ytPl?.artworkUrl ?? undefined;
    tracks = lib.ytmusicPlaylistTracks[ytRawId] ?? [];
  } else if (isScPl && scPl) {
    title = scPl.name;
    artworkUrl = scPl.artworkUrl;
    tracks = lib.soundcloudPlaylistTracks[scPl.urn] ?? [];
  } else if (localPl) {
    title = localPl.name;
    artworkUrl = localPl.artworkUrl;
    tracks = localPl.ids.map((tid) => getTrack(tid)).filter((tr): tr is Track => Boolean(tr));
  }

  const q = filterQ.trim().toLowerCase();
  const visibleTracks = q
    ? tracks.filter((tr) => tr.title.toLowerCase().includes(q) || tr.artist.toLowerCase().includes(q))
    : tracks;

  return (
    <div className="flex flex-col gap-4 px-4 pb-8 pt-3">
      <div className="flex items-center justify-between">
        <IconButton
          icon="arrow_back"
          label={t('back')}
          variant="tonal"
          size="sm"
          tip={false}
          onClick={() => go({ name: 'library' })}
        />
        {localPl && (
          <div className="flex items-center gap-1">
            <IconButton
              icon="edit"
              label={t('rename')}
              size="sm"
              tip={false}
              onClick={() => openDialog({ kind: 'rename', id: localPl.id })}
            />
            <IconButton
              icon="delete"
              label={t('delete')}
              size="sm"
              tip={false}
              onClick={() => openDialog({ kind: 'delete', id: localPl.id })}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-4">
        {kind === 'favorites' ? (
          <div className="grid h-24 w-24 shrink-0 place-items-center rounded-3xl bg-primary text-on-primary shadow-md">
            <Icon name="favorite" fill size={40} />
          </div>
        ) : (
          <PlaylistCover
            p={localPl ?? { id: id ?? 'pl', name: title, ids: [], created: 0, artworkUrl }}
            className="h-24 w-24 shrink-0 rounded-3xl"
          />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="headline line-clamp-2 text-2xl font-extrabold">{title}</h1>
          <p className="mt-1 text-xs text-on-surface-variant">{tracksLabel(tracks.length)}</p>
        </div>
      </div>

      {tracks.length > 0 && (
        <div className="flex gap-2.5">
          <Button
            variant="filled"
            icon="play_arrow"
            className="flex-1 justify-center"
            onClick={() => void playQueue(visibleTracks, 0, true)}
          >
            {t('play')}
          </Button>
          <Button
            variant="tonal"
            icon="shuffle"
            className="flex-1 justify-center"
            onClick={() => void playQueue(shuffled(visibleTracks), 0, true)}
          >
            {t('shuffle')}
          </Button>
        </div>
      )}

      {kind === 'favorites' && (
        <Segmented
          size="sm"
          value={favProvider}
          onChange={(v) => ui.set({ favProvider: v })}
          options={[
            { value: 'all', label: t('favoritesAll') },
            { value: 'youtube', label: 'YouTube' },
            { value: 'soundcloud', label: 'SoundCloud' },
          ]}
        />
      )}

      {tracks.length > 6 && (
        <div className="flex items-center gap-2 rounded-2xl bg-sc px-3.5 py-1">
          <Icon name="search" size={18} className="text-on-surface-variant" />
          <input
            type="search"
            value={filterQ}
            onChange={(e) => setFilterQ(e.target.value)}
            placeholder={kind === 'favorites' ? t('favoritesSearchPlaceholder') : t('playlistSearchPlaceholder')}
            className="h-9 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
      )}

      {loadingRemote && tracks.length === 0 ? (
        <div className="grid place-items-center py-14">
          <Loader />
        </div>
      ) : (
        <MobileTrackList
          tracks={visibleTracks}
          emptyText={kind === 'favorites' ? t('favoritesEmptyText') : t('playlistEmptyText')}
        />
      )}
    </div>
  );
}
