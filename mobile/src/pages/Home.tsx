import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
import { Cover } from '../components/Cover';
import { MobileTrackList } from '../components/TrackList';
import { useStore } from '../lib/util';
import { pick, t, useLang } from '../lib/i18n';
import { MOODS } from '../lib/moods';
import { getTrack, library } from '../state/library';
import { playQueue, playTrack } from '../state/player';
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
  const ytLiked = useStore(library, (s) => s.ytmusicLiked);
  const scLiked = useStore(library, (s) => s.soundcloudLiked);
  const ytAuth = useStore(library, (s) => s.ytmusicAuthorized);

  const recentTracks: Track[] = recentIds
    .map((id) => getTrack(id))
    .filter((tr): tr is Track => Boolean(tr))
    .slice(0, 12);

  const mixedFeed: Track[] = [...ytLiked.slice(0, 15), ...scLiked.slice(0, 15)];

  return (
    <div className="flex flex-col gap-6 px-4 pb-8 pt-3">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="display text-3xl">{t(greetingKey())}</h1>
          <p className="mt-1 text-sm text-on-surface-variant">{t('homeSubtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => go({ name: 'providers' })}
          className="sl flex shrink-0 items-center gap-1.5 rounded-full bg-sc-high px-3.5 py-2 text-xs font-bold"
        >
          <span className={`h-2 w-2 rounded-full ${ytAuth || scLiked.length > 0 ? 'bg-primary' : 'bg-on-surface-variant'}`} />
          <span>{pick('Сервисы', 'Providers')}</span>
        </button>
      </header>

      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => go({ name: 'favorites' })}
          className="sl flex items-center gap-3 rounded-2xl bg-sc-low p-3 text-left"
        >
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-container text-on-primary-container">
            <Icon name="favorite" fill />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{t('favorites')}</div>
            <div className="truncate text-xs text-on-surface-variant">{pick('Все лайки', 'Liked music')}</div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => openDialog({ kind: 'create', initialTab: 'import' })}
          className="sl flex items-center gap-3 rounded-2xl bg-sc-low p-3 text-left"
        >
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-secondary-container text-on-secondary-container">
            <Icon name="download" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{t('importTabImport')}</div>
            <div className="truncate text-xs text-on-surface-variant">Spotify / YT / SC</div>
          </div>
        </button>
      </div>

      <section>
        <h2 className="headline mb-2.5 text-base">{t('moods')}</h2>
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {MOODS.map((m) => (
            <button
              key={m.q}
              type="button"
              onClick={() => openSearch(m.q)}
              className="sl flex shrink-0 items-center gap-2 rounded-full bg-sc px-4 py-2 text-sm font-semibold"
            >
              <Icon name={m.icon as never} size={18} className="text-primary" />
              <span>{pick(m.ru, m.en)}</span>
            </button>
          ))}
        </div>
      </section>

      {recentTracks.length > 0 && (
        <section>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="headline text-lg">{t('recent')}</h2>
            <Button variant="text" onClick={() => void playQueue(recentTracks, 0, true)}>
              {t('play')}
            </Button>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
            {recentTracks.map((tr) => (
              <button
                key={tr.id}
                type="button"
                onClick={() => void playTrack(tr, recentTracks)}
                className="w-32 shrink-0 text-left"
              >
                <Cover src={tr.cover || tr.thumb} className="h-32 w-32 rounded-2xl" />
                <div className="mt-1.5 truncate text-sm font-bold">{tr.title}</div>
                <div className="truncate text-xs text-on-surface-variant">{tr.artist}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {mixedFeed.length > 0 ? (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="headline text-lg">{t('inLibrary')}</h2>
            <Button variant="tonal" icon="shuffle" onClick={() => void playQueue(mixedFeed, 0, true)}>
              {t('play')}
            </Button>
          </div>
          <MobileTrackList tracks={mixedFeed.slice(0, 20)} />
        </section>
      ) : (
        <section className="rounded-3xl bg-sc-low p-5 text-center">
          <Icon name="auto_awesome" size={34} className="mx-auto mb-2 text-primary" />
          <h3 className="headline text-base">{pick('Начните слушать прямо сейчас', 'Start listening right away')}</h3>
          <p className="mt-1 text-xs text-on-surface-variant">
            {pick(
              'Ищите любые треки из YouTube и SoundCloud без входа или подключите свои аккаунты в разделе Сервисы.',
              'Search any song across YouTube and SoundCloud immediately, or connect your accounts in Providers.',
            )}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="filled" icon="search" onClick={() => go({ name: 'search' })}>
              {t('findMusic')}
            </Button>
            <Button variant="tonal" onClick={() => go({ name: 'providers' })}>
              {pick('Сервисы', 'Providers')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
