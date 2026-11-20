import { Icon } from '../components/Icon';
import { Button, IconButton } from '../components/ui';
import { PlaylistCover } from '../components/Cover';
import { useStore } from '../lib/util';
import { pick, t, tracksLabel, useLang } from '../lib/i18n';
import { ytmusicPlaylistId } from '../lib/ytmusic-library';
import { cancelPlaylistImport, importStore } from '../state/import';
import {
  getFavoriteIds,
  library,
  loadSoundCloudLibrary,
  loadYtMusicLibrary,
} from '../state/library';
import { go, openDialog } from '../state/ui';
import soundcloudLogo from '../assets/soundcloud.svg';
import youtubeMusicLogo from '../assets/youtube-music.svg';

export default function Library() {
  useLang();
  const playlists = useStore(library, (s) => s.playlists);
  const ytPlaylists = useStore(library, (s) => s.ytmusicPlaylists);
  const scPlaylists = useStore(library, (s) => s.soundcloudPlaylists);
  const ytArt = useStore(library, (s) => s.ytmusicPlaylistArt);
  const favCount = useStore(library, () => getFavoriteIds('all').length);
  const ytLoading = useStore(library, (s) => s.ytmusicLibraryLoading);
  const scLoading = useStore(library, (s) => s.soundcloudLibraryLoading);
  const imp = useStore(importStore, (s) => s);

  const refreshAll = () => {
    void loadSoundCloudLibrary(true);
    void loadYtMusicLibrary(true);
  };

  return (
    <div className="flex flex-col gap-5 px-4 pb-8 pt-3">
      <header className="flex items-center justify-between">
        <h1 className="display text-3xl">{t('collection')}</h1>
        <div className="flex items-center gap-1.5">
          <IconButton
            icon="refresh"
            label={t('providerRefresh')}
            variant="tonal"
            size="sm"
            tip={false}
            disabled={ytLoading || scLoading}
            onClick={refreshAll}
          />
          <Button
            variant="tonal"
            icon="download"
            onClick={() => openDialog({ kind: 'create', initialTab: 'import' })}
          >
            {t('importTabImport')}
          </Button>
          <IconButton
            icon="add"
            label={t('newPlaylist')}
            variant="filled"
            size="sm"
            tip={false}
            onClick={() => openDialog({ kind: 'create', initialTab: 'scratch' })}
          />
        </div>
      </header>

      {imp.active && (
        <div className="rounded-2xl bg-sc-high p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{imp.playlistName || t('importFetching')}</div>
              <div className="text-xs text-on-surface-variant">
                {imp.phase === 'matching'
                  ? t('importMatching', { done: imp.processed, total: imp.total })
                  : imp.phase === 'awaiting_decision'
                    ? t('importNeedsReviewSub', { count: imp.reviewItems.length })
                    : t('importFetching')}
              </div>
            </div>
            {imp.phase === 'awaiting_decision' ? (
              <Button variant="filled" onClick={() => openDialog({ kind: 'import-review' })}>
                {t('importReviewBtn')}
              </Button>
            ) : (
              <IconButton icon="close" label={t('cancel')} size="sm" tip={false} onClick={cancelPlaylistImport} />
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => go({ name: 'favorites' })}
        className="sl flex items-center gap-3.5 rounded-2xl bg-sc-low p-3 text-left"
      >
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-primary text-on-primary">
          <Icon name="favorite" fill size={26} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-extrabold">{t('favorites')}</div>
          <div className="text-xs text-on-surface-variant">{tracksLabel(favCount)}</div>
        </div>
        <Icon name="chevron_right" className="text-on-surface-variant" />
      </button>

      {playlists.length > 0 && (
        <section>
          <h2 className="headline mb-2 text-base">{t('yourPlaylists')}</h2>
          <div className="flex flex-col gap-1.5">
            {playlists.map((pl) => (
              <button
                key={pl.id}
                type="button"
                onClick={() => go({ name: 'playlist', id: pl.id })}
                className="sl flex items-center gap-3 rounded-2xl px-2 py-2 text-left"
              >
                <PlaylistCover p={pl} className="h-13 w-13 shrink-0 rounded-2xl" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-bold">{pl.name}</div>
                  <div className="text-xs text-on-surface-variant">{tracksLabel(pl.ids.length)}</div>
                </div>
                <Icon name="chevron_right" className="text-on-surface-variant" />
              </button>
            ))}
          </div>
        </section>
      )}

      {ytPlaylists.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <img src={youtubeMusicLogo} alt="" className="h-4 w-4" />
            <h2 className="headline text-base">{t('ytmusicLibrary')}</h2>
          </div>
          <div className="flex flex-col gap-1.5">
            {ytPlaylists.map((pl) => {
              const colId = ytmusicPlaylistId(pl.playlistId);
              const art = ytArt[pl.playlistId] ?? pl.artworkUrl ?? undefined;
              return (
                <button
                  key={pl.playlistId}
                  type="button"
                  onClick={() => go({ name: 'playlist', id: colId })}
                  className="sl flex items-center gap-3 rounded-2xl px-2 py-2 text-left"
                >
                  <PlaylistCover
                    p={{ id: pl.playlistId, name: pl.title, ids: [], created: 0, artworkUrl: art }}
                    className="h-13 w-13 shrink-0 rounded-2xl"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-bold">{pl.title}</div>
                    <div className="text-xs text-on-surface-variant">{tracksLabel(pl.trackCount)}</div>
                  </div>
                  <Icon name="chevron_right" className="text-on-surface-variant" />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {scPlaylists.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <img src={soundcloudLogo} alt="" className="h-4 w-4" />
            <h2 className="headline text-base">{t('soundcloudLibrary')}</h2>
          </div>
          <div className="flex flex-col gap-1.5">
            {scPlaylists.map((pl) => (
              <button
                key={pl.id}
                type="button"
                onClick={() => go({ name: 'playlist', id: `scpl:${pl.id}` })}
                className="sl flex items-center gap-3 rounded-2xl px-2 py-2 text-left"
              >
                <PlaylistCover
                  p={{ id: pl.id, name: pl.name, ids: [], created: 0, artworkUrl: pl.artworkUrl }}
                  className="h-13 w-13 shrink-0 rounded-2xl"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-bold">{pl.name}</div>
                  <div className="text-xs text-on-surface-variant">{tracksLabel(pl.trackCount)}</div>
                </div>
                <Icon name="chevron_right" className="text-on-surface-variant" />
              </button>
            ))}
          </div>
        </section>
      )}

      {playlists.length === 0 && ytPlaylists.length === 0 && scPlaylists.length === 0 && (
        <div className="rounded-3xl bg-sc-low p-5 text-center text-sm text-on-surface-variant">
          <p>{pick('Подключите YouTube Music или SoundCloud, либо импортируйте плейлист по ссылке.', 'Connect YouTube Music or SoundCloud, or import any playlist by URL.')}</p>
          <div className="mt-3 flex justify-center gap-2">
            <Button variant="filled" onClick={() => go({ name: 'providers' })}>
              {t('providers')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
