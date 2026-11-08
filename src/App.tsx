import { Fragment, useCallback, useEffect, useRef } from 'react';

import { Sidebar } from './components/Sidebar';
import { MiniPlayer } from './components/MiniPlayer';
import { NowPlaying } from './components/NowPlaying';
import { Immersive } from './components/Immersive';
import { Background, SvgDefs } from './components/Background';
import { Drawer, Overlays } from './components/Overlays';
import { IconButton } from './components/ui';
import { MD, useMedia, useStore, XL } from './lib/util';
import { t, useLang } from './lib/i18n';
import { loadSoundCloudLibrary, loadYtMusicLibrary } from './state/library';
import { checkForUpdates } from './state/updater';
import { handleWindowShortcut } from './state/shortcut-runtime';
import { routeKey, ui, type Route } from './state/ui';
import Home from './pages/Home';
import Search from './pages/Search';
import Collection from './pages/Collection';
import Settings from './pages/Settings';
import Appearance from './pages/Appearance';
import Providers from './pages/Providers';
import Shortcuts from './pages/Shortcuts';

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'search':
      return <Search q={route.q} />;
    case 'favorites':
      return <Collection kind="favorites" />;
    case 'playlist':
      return <Collection kind="playlist" id={route.id} />;
    case 'settings':
      return <Settings />;
    case 'appearance':
      return <Appearance />;
    case 'providers':
      return <Providers />;
    case 'shortcuts':
      return <Shortcuts />;
    default:
      return <Home />;
  }
}

function Center({ isMd }: { isMd: boolean }) {
  const route = useStore(ui, (s) => s.route);
  const key = routeKey(route);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [key]);
  return (
    <main className="panel panel-center">
      {!isMd && <IconButton icon="menu" label={t('menu')} variant="glass" className="fab-menu" onClick={() => ui.set({ drawer: true })} />}
      <div ref={scroller} className="center-scroll">
        <div key={key} className="page-enter">
          <Page route={route} />
        </div>
      </div>
      <MiniPlayer />
    </main>
  );
}

function useShortcuts() {
  useEffect(() => {
    window.addEventListener('keydown', handleWindowShortcut);
    return () => window.removeEventListener('keydown', handleWindowShortcut);
  }, []);
}

export default function App() {
  const lang = useLang();
  const isMd = useMedia(MD);
  const isXl = useMedia(XL);
  const immersive = useStore(ui, (s) => s.immersive);
  const drawer = useStore(ui, (s) => s.drawer);
  const npDrawer = useStore(ui, (s) => s.npDrawer);
  const closeDrawer = useCallback(() => ui.set({ drawer: false }), []);
  const closeNp = useCallback(() => ui.set({ npDrawer: false }), []);
  useShortcuts();

  useEffect(() => {
    void loadSoundCloudLibrary();
    void loadYtMusicLibrary();
    void checkForUpdates(true);
    const timer = window.setInterval(() => void checkForUpdates(), 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (isMd && drawer) closeDrawer();
    if (isXl && npDrawer) closeNp();
  }, [isMd, isXl, drawer, npDrawer, closeDrawer, closeNp]);

  useEffect(() => {
    const root = document.documentElement;
    if (immersive) root.dataset.immersive = '';
    else delete root.dataset.immersive;
  }, [immersive]);

  return (
    <Fragment key={lang}>
      <Background />
      <SvgDefs />
      <div className="shell" data-hidden={immersive} aria-hidden={immersive}>
        {isMd && <Sidebar mode="inline" />}
        <Center isMd={isMd} />
        {isXl && <NowPlaying mode="inline" />}
      </div>
      {!isMd && (
        <Drawer open={drawer} onClose={closeDrawer} side="left">
          <Sidebar mode="drawer" />
        </Drawer>
      )}
      {!isXl && (
        <Drawer open={npDrawer} onClose={closeNp} side="right">
          <NowPlaying mode="drawer" />
        </Drawer>
      )}
      <Immersive />
      <Overlays />
    </Fragment>
  );
}
