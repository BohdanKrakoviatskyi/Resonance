import { Icon } from '../components/Icon';
import { Button, IconButton, Shape, type Vars } from '../components/ui';
import { Cover, PlaylistCover } from '../components/Cover';
import { MobileTrackList } from '../components/TrackList';
import { cx, useStore } from '../lib/util';
import { pick, t, tracksLabel, useLang } from '../lib/i18n';
import { MOODS } from '../lib/moods';
import { ytmusicPlaylistId } from '../lib/ytmusic-library';
import { getFavoriteIds, getTrack, library } from '../state/library';
import { playQueue, playTrack, player, toggle } from '../state/player';
import { go, openDialog, openSearch } from '../state/ui';
import type { Track } from '../types';

function greetingKey() {
  const h = new Date().getHours();
  if (h < 5) return 'goodNight' as const;
  if (h < 12) return 'goodMorning' as const;
  if (h < 18) return 'goodAfternoon' as const;
  return 'goodEvening' as const;
}

export default function Home() {
  useLang();
  const recentIds = useStore(library, (s) => s.recent);
  const playlists = useStore(library, (s) => s.playlists);
  const ytPlaylists = useStore(library, (s) => s.ytmusicPlaylists);
  const scPlaylists = useStore(library, (s) => s.soundcloudPlaylists);
  const ytArt = useStore(library, (s) => s.ytmusicPlaylistArt);
  const ytLiked = useStore(library, (s) => s.ytmusicLiked);
  const scLiked = useStore(library, (s) => s.soundcloudLiked);
  const favCount = useStore(library, () => getFavoriteIds('all').length);
  const curId = useStore(player, (s) => s.queue[s.index]);
  const playing = useStore(player, (s) => s.playing);

  const recentTracks: Track[] = recentIds
    .map((id) => getTrack(id))
    .filter((tr): tr is Track => Boolean(tr))
    .slice(0, 12);

  // Interleave SoundCloud and YouTube Music liked tracks so both services shine equally
  const mixedFeed: Track[] = [];
  const maxFeed = Math.max(ytLiked.length, scLiked.length);
  for (let i = 0; i < maxFeed && mixedFeed.length < 24; i++) {
    if (i < scLiked.length) mixedFeed.push(scLiked[i]);
    if (i < ytLiked.length) mixedFeed.push(ytLiked[i]);
  }

  const heroTrack: Track | undefined = recentTracks[0] ?? mixedFeed[0];
  const heroQueue = recentTracks.length > 0 ? recentTracks : mixedFeed;

  return (
    <div className="flex flex-col gap-6 px-4 pb-8 pt-3">
      {/* Clean Header — No hanging Providers badge */}
      <header className="anim-in flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="display text-[clamp(30px,8vw,42px)]">{t(greetingKey())}</h1>
          <p className="mt-1 text-sm text-on-surface-variant">{t('homeSubtitle')}</p>
        </div>
        <IconButton
          icon="search"
          label={t('search')}
          variant="tonal"
          tip={false}
          onClick={() => go({ name: 'search' })}
        />
      </header>

      {/* Featured Track Hero Card (like Desktop Home) */}
      {heroTrack && (
        <section
          className="anim-in relative flex items-center justify-between gap-4 overflow-hidden rounded-[32px] p-5 text-on-primary-container shadow-lg"
          style={{
            '--i': 1,
            background:
              'radial-gradient(125% 145% at 0% 0%, var(--md-primary-container), color-mix(in oklab, var(--md-tertiary-container) 84%, transparent))',
          } as Vars}
        >
          <div className="relative z-10 min-w-0 flex-1">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-on-primary-container/12 px-3 text-xs font-bold">
              <Icon name="auto_awesome" size={15} fill />
              {t('featured')}
            </span>
            <h2 className="display mt-2.5 line-clamp-2 text-2xl leading-tight">{heroTrack.title}</h2>
            <p className="mt-1 truncate text-sm font-medium opacity-80">{heroTrack.artist}</p>
            <div className="mt-4 flex items-center gap-2">
              <Button
                variant="filled"
                icon={curId === heroTrack.id && playing ? 'pause' : 'play_arrow'}
                onClick={() =>
                  curId === heroTrack.id ? toggle() : void playTrack(heroTrack, heroQueue)
                }
              >
                {curId === heroTrack.id && playing ? t('pause') : t('play')}
              </Button>
            </div>
          </div>

          <div className="relative h-28 w-28 shrink-0">
            <Shape
              n={9}
              amp={0.08}
              className="spin-slow absolute -inset-3 h-[calc(100%+24px)] w-[calc(100%+24px)] text-primary/35"
            />
            <Cover
              src={heroTrack.cover || heroTrack.thumb}
              className="h-full w-full -rotate-3 rounded-[24px] shadow-2xl"
            />
          </div>
        </section>
      )}

      {/* Quick Recent Grid */}
      {recentTracks.length > 0 && (
        <section className="anim-in" style={{ '--i': 2 } as Vars}>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="headline text-lg">{t('recent')}</h2>
            <button
              type="button"
              onClick={() => void playQueue(recentTracks, 0, true)}
              className="text-xs font-bold text-primary active:opacity-75"
            >
              {t('play')}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {recentTracks.slice(0, 6).map((tr) => {
              const isCur = curId === tr.id;
              return (
                <button
                  key={tr.id}
                  type="button"
                  data-ripple
                  data-current={isCur}
                  onClick={() => (isCur ? toggle() : void playTrack(tr, recentTracks))}
                  className="quick sl !p-1.5 !pr-2.5"
                >
                  <Cover src={tr.thumb || tr.cover} className="h-12 w-12 shrink-0 rounded-[14px]" />
                  <div className="min-w-0 flex-1">
                    <div className={cx('truncate text-xs font-bold', isCur && 'text-primary')}>{tr.title}</div>
                    <div className="truncate text-[11px] text-on-surface-variant">{tr.artist}</div>
                  </div>
                  {isCur && (
                    <span className={cx('eq shrink-0', playing && 'on')}>
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Playlists Shelf with Clean "+" Create / Import Trigger */}
      <section className="anim-in" style={{ '--i': 3 } as Vars}>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <h2 className="headline text-lg">{t('yourPlaylists')}</h2>
          <button
            type="button"
            data-ripple
            onClick={() => openDialog({ kind: 'create', initialTab: 'import' })}
            className="sl inline-flex h-8 items-center gap-1 rounded-full bg-on-surface/8 px-3 text-xs font-bold text-primary active:scale-95"
            aria-label={t('newPlaylist')}
          >
            <Icon name="add" size={18} />
            <span>{t('importTabImport')}</span>
          </button>
        </div>

        <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
          {/* Favorites Card */}
          <button
            type="button"
            data-ripple
            onClick={() => go({ name: 'favorites' })}
            className="mcard sl !w-36 shrink-0 !p-2"
          >
            <div className="cover fav-cover mcard-cover">
              <Icon name="favorite" fill size={44} />
            </div>
            <div className="mcard-title !mt-2 !text-sm">{t('favorites')}</div>
            <div className="mcard-sub !text-xs">{tracksLabel(favCount)}</div>
          </button>

          {/* Local / Imported Playlists */}
          {playlists.map((pl) => (
            <button
              key={pl.id}
              type="button"
              data-ripple
              onClick={() => go({ name: 'playlist', id: pl.id })}
              className="mcard sl !w-36 shrink-0 !p-2"
            >
              <PlaylistCover p={pl} className="mcard-cover" />
              <div className="mcard-title !mt-2 !text-sm">{pl.name}</div>
              <div className="mcard-sub !text-xs">{tracksLabel(pl.ids.length)}</div>
            </button>
          ))}

          {/* SoundCloud Playlists */}
          {scPlaylists.slice(0, 8).map((pl) => (
            <button
              key={`sc-${pl.id}`}
              type="button"
              data-ripple
              onClick={() => go({ name: 'playlist', id: `scpl:${pl.id}` })}
              className="mcard sl !w-36 shrink-0 !p-2"
            >
              <PlaylistCover
                p={{ id: pl.id, name: pl.name, ids: [], created: 0, artworkUrl: pl.artworkUrl }}
                className="mcard-cover"
              />
              <div className="mcard-title !mt-2 !text-sm">{pl.name}</div>
              <div className="mcard-sub !text-xs">SoundCloud · {tracksLabel(pl.trackCount)}</div>
            </button>
          ))}

          {/* YouTube Music Playlists */}
          {ytPlaylists.slice(0, 8).map((pl) => {
            const art = ytArt[pl.playlistId] ?? pl.artworkUrl ?? undefined;
            return (
              <button
                key={`yt-${pl.playlistId}`}
                type="button"
                data-ripple
                onClick={() => go({ name: 'playlist', id: ytmusicPlaylistId(pl.playlistId) })}
                className="mcard sl !w-36 shrink-0 !p-2"
              >
                <PlaylistCover
                  p={{ id: pl.playlistId, name: pl.title, ids: [], created: 0, artworkUrl: art }}
                  className="mcard-cover"
                />
                <div className="mcard-title !mt-2 !text-sm">{pl.title}</div>
                <div className="mcard-sub !text-xs">YouTube · {tracksLabel(pl.trackCount)}</div>
              </button>
            );
          })}

          {/* Minimal "+" Tile at end of shelf */}
          <button
            type="button"
            data-ripple
            onClick={() => openDialog({ kind: 'create', initialTab: 'scratch' })}
            className="mcard sl !w-36 shrink-0 !p-2"
          >
            <div className="mcard-cover grid place-items-center bg-on-surface/6 text-on-surface-variant ring-1 ring-inset ring-outline-variant/40">
              <Icon name="add" size={34} />
            </div>
            <div className="mcard-title !mt-2 !text-sm">{t('newPlaylist')}</div>
            <div className="mcard-sub !text-xs">{pick('Создать или импорт', 'Create or import')}</div>
          </button>
        </div>
      </section>

      {/* Moods with Organic M3 Shapes */}
      <section className="anim-in" style={{ '--i': 4 } as Vars}>
        <h2 className="headline mb-2.5 text-lg">{t('moods')}</h2>
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {MOODS.map((m, i) => (
            <button
              key={m.q}
              type="button"
              data-ripple
              onClick={() => openSearch(m.q)}
              className="sl flex shrink-0 items-center gap-2 rounded-full bg-on-surface/7 py-1.5 pl-2 pr-4 text-sm font-semibold ring-1 ring-inset ring-outline-variant/35 active:scale-95"
            >
              <Shape n={5 + (i % 4)} amp={0.11} className="h-7 w-7 text-secondary-container">
                <Icon name={m.icon as never} fill size={16} className="text-on-secondary-container" />
              </Shape>
              <span>{pick(m.ru, m.en)}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Library Feed or Clean Empty Prompt */}
      {mixedFeed.length > 0 ? (
        <section className="anim-in" style={{ '--i': 5 } as Vars}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="headline text-lg">{t('inLibrary')}</h2>
            <Button variant="tonal" icon="shuffle" onClick={() => void playQueue(mixedFeed, 0, true)}>
              {t('play')}
            </Button>
          </div>
          <MobileTrackList tracks={mixedFeed} />
        </section>
      ) : (
        <section className="card anim-in !p-5 text-center" style={{ '--i': 5 } as Vars}>
          <Shape n={8} amp={0.09} className="spin-slow mx-auto mb-2 h-16 w-16 text-secondary-container">
            <Icon name="music_note" fill size={28} className="text-on-secondary-container" />
          </Shape>
          <h3 className="headline text-base">
            {pick('Начните слушать прямо сейчас', 'Start listening right away')}
          </h3>
          <p className="mt-1 text-xs text-on-surface-variant">
            {pick(
              'Ищите любые треки из YouTube и SoundCloud без входа или подключите свои аккаунты в настройках.',
              'Search any song across YouTube and SoundCloud immediately, or connect your accounts in Settings.',
            )}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="filled" icon="search" onClick={() => go({ name: 'search' })}>
              {t('findMusic')}
            </Button>
            <Button variant="tonal" icon="add" onClick={() => openDialog({ kind: 'create', initialTab: 'import' })}>
              {t('importTabImport')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
