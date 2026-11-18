import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { Background } from './components/Background';
import { Icon, type IconName } from './components/Icon';
import { MobileMiniPlayer } from './components/MobileMiniPlayer';
import { NowPlayingSheet } from './components/NowPlayingSheet';
import { EqSheet } from './components/EqSheet';
import { MobileOverlays } from './components/MobileOverlays';
import { cx, useStore } from './lib/util';
import { t, useLang } from './lib/i18n';
import { loadSoundCloudLibrary, loadYtMusicLibrary } from './state/library';
import { consumeBackPress, go, routeKey, ui, type Route } from './state/ui';
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
  const key = routeKey(route);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeTab = activeTabFor(route);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [key]);

  useEffect(() => {
    void loadSoundCloudLibrary();
    void loadYtMusicLibrary();
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
      <div className="fixed inset-0 flex flex-col overflow-hidden text-on-surface">
        <main
          ref={scrollerRef}
          className="min-h-0 flex-1 overflow-y-auto pt-[env(safe-area-inset-top,0px)]"
        >
          <div key={key} className="page-enter">
            <ActivePage route={route} />
          </div>
        </main>

        <div className="shrink-0">
          <MobileMiniPlayer />
          <nav
            aria-label="Primary"
            className="flex items-center justify-around border-t border-outline-variant/25 bg-sc/90 px-2 pb-[calc(env(safe-area-inset-bottom,0px)+6px)] pt-1.5 backdrop-blur-xl"
          >
            {TABS.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => go({ name: tab.id })}
                  className="flex min-w-[68px] flex-col items-center gap-0.5 py-1"
                >
                  <span
                    className={cx(
                      'grid h-8 w-16 place-items-center rounded-full transition-colors duration-200',
                      selected ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant',
                    )}
                  >
                    <Icon name={tab.icon} fill={selected} size={22} />
                  </span>
                  <span
                    className={cx(
                      'text-[11px] font-bold',
                      selected ? 'text-on-surface' : 'text-on-surface-variant',
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
