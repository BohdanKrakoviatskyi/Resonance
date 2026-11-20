import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { Background } from './components/Background';
import { Icon, type IconName } from './components/Icon';
import { type Vars } from './components/ui';
import { MobileMiniPlayer } from './components/MobileMiniPlayer';
import { PageHeader } from './components/PageHeader';
import { NowPlayingSheet } from './components/NowPlayingSheet';
import { EqSheet } from './components/EqSheet';
import { MobileOverlays } from './components/MobileOverlays';
import { cx, useStore } from './lib/util';
import { t, useLang } from './lib/i18n';
import { loadSoundCloudLibrary, loadYtMusicLibrary } from './state/library';
import { useCurrentTrack } from './state/player';
import { consumeBackPress, go, routeKey, snack, ui, type Route } from './state/ui';
import { checkForUpdate, installUpdate } from './lib/update';
import Home from './pages/Home';
import Search from './pages/Search';
import Library from './pages/Library';
import Collection from './pages/Collection';
import Settings from './pages/Settings';
import Providers from './pages/Providers';
import AudioSettings from './pages/AudioSettings';
import Appearance from './pages/Appearance';

function ActivePage({ route }: { route: Route }) {
  switch (route.name) {
    case 'search':
      return <Search />;
    case 'library':
      return <Library />;
    case 'favorites':
      return <Collection kind="favorites" />;
    case 'playlist':
      return <Collection kind="playlist" id={route.id} />;
    case 'settings':
      return <Settings />;
    case 'providers':
      return <Providers />;
    case 'audio':
      return <AudioSettings />;
    case 'appearance':
      return <Appearance />;
    default:
      return <Home />;
  }
}

type TabItem = {
  id: 'home' | 'search' | 'library' | 'settings';
  icon: IconName;
  labelKey: 'home' | 'search' | 'collection' | 'settings';
};

const TABS: TabItem[] = [
  { id: 'home', icon: 'home', labelKey: 'home' },
  { id: 'search', icon: 'search', labelKey: 'search' },
  { id: 'library', icon: 'library_music', labelKey: 'collection' },
  { id: 'settings', icon: 'settings', labelKey: 'settings' },
];

function activeTabFor(route: Route): TabItem['id'] {
  switch (route.name) {
    case 'search':
      return 'search';
    case 'library':
    case 'favorites':
    case 'playlist':
      return 'library';
    case 'settings':
    case 'providers':
    case 'audio':
    case 'appearance':
    case 'shortcuts':
      return 'settings';
    default:
      return 'home';
  }
}

export default function App() {
  useLang();
  const route = useStore(ui, (s) => s.route);
  const hasTrack = Boolean(useCurrentTrack());
  const key = routeKey(route);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeTab = activeTabFor(route);
  const activeIdx = Math.max(0, TABS.findIndex((tab) => tab.id === activeTab));
  const sectionKey = TABS.find((tab) => tab.id === activeTab)?.labelKey ?? 'home';

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [key]);

  useEffect(() => {
    void loadSoundCloudLibrary();
    void loadYtMusicLibrary();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void checkForUpdate()
      .then((update) => {
        if (cancelled || !update) return;
        snack(t('updateAvailableVer', { version: update.version }), {
          label: t('updateInstallAction'),
          run: () => {
            void installUpdate(update).catch((e: unknown) =>
              snack(t('updateFailed', { reason: e instanceof Error ? e.message : String(e) })),
            );
          },
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void onBackButtonPress(() => {
      consumeBackPress();
    })
      .then((handle) => {
        unlisten = () => void handle.unregister();
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  return (
    <>
      <Background />
      <div className="app-shell fixed inset-0 flex flex-col overflow-hidden text-on-surface">
        <PageHeader title={t(sectionKey)} />
        <main
          ref={scrollerRef}
          className={cx(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain',
            hasTrack
              ? 'pb-[calc(var(--safe-bottom,0px)+148px)]'
              : 'pb-[calc(var(--safe-bottom,0px)+84px)]',
          )}
        >
          <div key={key} className="page-enter">
            <ActivePage route={route} />
          </div>
        </main>

        {/* Floating Glass Bottom Chrome (MiniPlayer + Dock).
            absolute, а не fixed: якорь — сам шелл, единственный источник правды о нижней
            кромке. fixed цеплялся к layout viewport, который WebView меняет при клавиатуре
            и edge-to-edge, из-за чего док отрывался от низа и уезжал вместе со скроллом. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 px-3 pb-[calc(var(--safe-bottom,0px)+8px)]">
          <MobileMiniPlayer />

          <nav
            aria-label="Primary"
            className="mobile-dock panel pointer-events-auto relative grid grid-cols-4 items-center p-1.5"
            style={{ '--dock-idx': activeIdx } as Vars}
          >
            <span aria-hidden="true" className="mobile-dock-pill" />

            {TABS.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-ripple
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => go({ name: tab.id })}
                  className={cx(
                    'mobile-dock-item sl relative z-10 flex flex-col items-center justify-center gap-0.5 rounded-[20px] py-1.5',
                    selected ? 'text-on-secondary-container' : 'text-on-surface-variant',
                  )}
                >
                  <Icon
                    name={tab.icon}
                    fill={selected}
                    size={22}
                    className={cx('transition-transform duration-300', selected && '-translate-y-[1px] scale-105')}
                  />
                  <span
                    className={cx(
                      'text-[10.5px] leading-tight tracking-tight transition-all duration-200',
                      selected ? 'font-extrabold opacity-100' : 'font-semibold opacity-78',
                    )}
                  >
                    {t(tab.labelKey)}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      <NowPlayingSheet />
      <EqSheet />
      <MobileOverlays />
    </>
  );
}
