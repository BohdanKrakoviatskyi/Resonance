import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useStore } from '../lib/util';
import { Icon } from '../components/Icon';
import { HRow, IconButton, Loader, Section, usePresence, type Vars } from '../components/ui';
import { PlaylistCover } from '../components/Cover';
import { MediaCard } from '../components/TrackList';
import { SearchResults } from './Search';

import { t, tracksLabel } from '../lib/i18n';
import { getTrack, library, loadYtMusicPlaylistArtwork } from '../state/library';
import { soundcloudPlaylistId } from '../lib/soundcloud-library';
import { ytmusicPlaylistId } from '../lib/ytmusic-library';

function YtMusicCoverCard({ playlistId, title, trackCount, artworkUrl, index }: { playlistId: string; title: string; trackCount: number; artworkUrl?: string | null; index: number }) {
  const artCache = useStore(library, (s) => s.ytmusicPlaylistArt);
  const art = playlistId in artCache ? artCache[playlistId] : undefined;
  useEffect(() => {
    if (!(playlistId in artCache)) void loadYtMusicPlaylistArtwork(playlistId);
  }, [playlistId, artCache]);
  return (
    <button
      type="button"
      data-ripple
      className="mcard sl anim-in"
      style={{ '--i': index } as Vars}
      onClick={() => go({ name: 'playlist', id: ytmusicPlaylistId(playlistId) })}
    >
      <PlaylistCover p={{ id: playlistId, name: title, ids: [], created: 0, artworkUrl: art ?? artworkUrl ?? undefined }} className="mcard-cover" />
      <span className="mcard-title">{title}</span>
      <span className="mcard-sub">{tracksLabel(trackCount)}</span>
    </button>
  );
}

import { closeSearch, go, openSearch, ui } from '../state/ui';
import type { Track } from '../types';

export default function Home() {
  const recent = useStore(library, (s) => s.recent);
  const soundcloudPlaylists = useStore(library, (s) => s.soundcloudPlaylists);
  const ytmusicPlaylists = useStore(library, (s) => s.ytmusicPlaylists);
  const ytmusicConnected = useStore(library, (s) => s.ytmusicAuthorized);
  const searchOpen = useStore(ui, (s) => s.searchOpen);
  const storedQ = useStore(ui, (s) => s.searchQ);
  const searchUi = usePresence(searchOpen, 300);
  const homeUi = usePresence(!searchOpen, 140);

  const [text, setText] = useState(storedQ);
  const [q, setQ] = useState(storedQ);
  const dockRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // sync external openSearch(q) / search hash
  useEffect(() => {
    if (!searchOpen) return;
    setText(storedQ);
    setQ(storedQ);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [storedQ, searchOpen]);

  // opening -> scroll to top of center column + focus
  useEffect(() => {
    if (!searchOpen) return;
    document.querySelector('.center-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);

  // clear query text after close transition settles
  useEffect(() => {
    if (searchOpen) return;
    dockRef.current?.blur();
    searchRef.current?.blur();
    const tm = setTimeout(() => {
      setText('');
      setQ('');
    }, 140);
    return () => clearTimeout(tm);
  }, [searchOpen]);

  // debounce typing -> query (mirrored to store so it survives re-renders)
  useEffect(() => {
    if (!searchOpen) return;
    const tm = setTimeout(() => {
      const trimmed = text.trim();
      setQ(trimmed);
      if (ui.get().searchQ !== trimmed) ui.set({ searchQ: trimmed });
    }, 320);
    return () => clearTimeout(tm);
  }, [text, searchOpen]);

  // Escape anywhere closes the inline search
  useEffect(() => {
    if (!searchOpen) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [searchOpen]);

  const close = () => {
    setText('');
    setQ('');
    closeSearch();
  };

  const onSearchAreaClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.closest('[data-ripple], button, a, input, textarea, select, label.search-bar, .track-row, .mcard, .card, [role="listitem"], [role="menu"], .menu, .hrow-btn, .section')) return;
    // allow empty areas inside sections? "пустому месту" - be a bit permissive but keep interactive safe
    if (el.closest('h1,h2,h3,p,header,.search-wrap')) return;
    close();
  };

  const h = new Date().getHours();
  const greet = h < 5 ? 'goodNight' : h < 12 ? 'goodMorning' : h < 18 ? 'goodAfternoon' : 'goodEvening';
  const recentTracks = recent.map((id) => getTrack(id)).filter((x): x is Track => !!x);
  const recentIds = recentTracks.map((x) => x.id);
  const hasSoundCloudLibrary = soundcloudPlaylists.length > 0;
  const arrows: [string, string] = [t('previous'), t('next')];

  return (
    <div className="page home-stage">
      {searchUi.mounted && (
        <div className="home-pane home-pane-search" data-open={searchUi.visible} aria-hidden={!searchUi.visible} onClick={onSearchAreaClick}>
          <div className="search-wrap">
            <label className="search-bar">
              <Icon name="search" className="text-on-surface-variant" />
              <input
                ref={searchRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    close();
                  }
                }}
                placeholder={t('searchPlaceholder')}
                aria-label={t('search')}
                enterKeyHint="search"
                tabIndex={searchUi.visible ? 0 : -1}
              />
              {text && q && text.trim() !== q ? <Loader size={26} /> : null}
              <IconButton icon="close" label={t('cancel')} tip={false} onClick={close} tabIndex={searchUi.visible ? 0 : -1} />
            </label>
          </div>
          <div className="home-search-results" onClick={onSearchAreaClick}>
            <SearchResults q={q} />
          </div>
        </div>
      )}

      {homeUi.mounted && (
        <div className="home-pane home-pane-main" data-open={homeUi.visible} aria-hidden={!homeUi.visible}>
          <div className="home-top">
            <header className="min-w-0">
              <h1 className="display text-[clamp(34px,6cqw,60px)]">{t(greet)}</h1>
              <p className="mt-2 text-lg text-on-surface-variant">{t('homeSubtitle')}</p>
            </header>
            <div className="home-search-dock">
              <label className="search-bar search-bar-dock">
                <Icon name="search" className="shrink-0 text-on-surface-variant" />
                <input
                  ref={dockRef}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    openSearch(e.target.value);
                  }}
                  onFocus={() => openSearch(text || storedQ)}
                  placeholder={t('searchPlaceholder')}
                  aria-label={t('search')}
                  enterKeyHint="search"
                  tabIndex={homeUi.visible ? 0 : -1}
                />
                {text && (
                  <IconButton
                    icon="close"
                    label={t('cancel')}
                    tip={false}
                    tabIndex={homeUi.visible ? 0 : -1}
                    onClick={close}
                  />
                )}
              </label>
              <IconButton
                icon="search"
                label={t('search')}
                variant="tonal"
                className="home-search-trigger"
                tabIndex={homeUi.visible ? 0 : -1}
                onClick={() => openSearch('')}
              />
            </div>
          </div>

          {hasSoundCloudLibrary && (
            <Section
              title={t('soundcloudLibrary')}
              subtitle={t('soundcloudLibrarySub')}
              i={2}
            >
              <HRow labels={arrows} cw={180}>
                {soundcloudPlaylists.map((p, i) => (
                  <button
                    key={`sclib:${p.id}`}
                    type="button"
                    data-ripple
                    className="mcard sl anim-in"
                    style={{ '--i': i } as Vars}
                    onClick={() => go({ name: 'playlist', id: soundcloudPlaylistId(p.id) })}
                  >
                    <PlaylistCover p={{ id: p.id, name: p.name, ids: [], created: 0, artworkUrl: p.artworkUrl }} className="mcard-cover" />
                    <span className="mcard-title">{p.name}</span>
                    <span className="mcard-sub">{tracksLabel(p.trackCount)}</span>
                  </button>
                ))}
              </HRow>
            </Section>
          )}

          {ytmusicConnected && ytmusicPlaylists.length > 0 && (
            <Section
              title={t('ytmusicLibrary')}
              subtitle={t('ytmusicLibrarySub')}
              i={3}
            >
              <HRow labels={arrows} cw={180}>
                {ytmusicPlaylists.map((p, i) => (
                  <YtMusicCoverCard key={`ytmusic-pl:${p.playlistId}`} playlistId={p.playlistId} title={p.title} trackCount={p.trackCount} artworkUrl={p.artworkUrl} index={i} />
                ))}
              </HRow>
            </Section>
          )}

          {recentTracks.length > 0 && (
            <Section title={t('recent')} i={4} action={<Icon name="history" className="text-on-surface-variant" size={26} />}>
              <HRow labels={arrows}>
                {recentTracks.map((tr, i) => (
                  <MediaCard key={tr.id} track={tr} list={recentIds} index={i} />
                ))}
              </HRow>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
