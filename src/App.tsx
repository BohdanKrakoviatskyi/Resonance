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
import { checkForUpdates, startInstallNewVersion } from './state/updater';
import { handleWindowShortcut } from './state/shortcut-runtime';
import { navigateRouteHistory, routeKey, snack, ui, type Route } from './state/ui';
import Home from './pages/Home';
import Collection from './pages/Collection';
import Settings from './pages/Settings';
import Appearance from './pages/Appearance';
import Providers from './pages/Providers';
import Shortcuts from './pages/Shortcuts';
import AudioSettings from './pages/AudioSettings';
import Integrations from './pages/Integrations';

function Page({ route }: { route: Route }) {
  switch (route.name) {
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
    case 'audio':
      return <AudioSettings />;
    case 'integrations':
      return <Integrations />;
    default:
      return <Home />;
  }
}

function Center({ isMd }: { isMd: boolean }) {
  const route = useStore(ui, (s) => s.route);
  const searchOpen = useStore(ui, (s) => s.searchOpen);
  const key = routeKey(route);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [key, searchOpen]);
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

function useMacTrackpadNavigation() {
  useEffect(() => {
    if (!navigator.platform.startsWith('Mac')) return;

    let deltaX = 0;
    let deltaY = 0;
    let gestureHandled = false;
    let resetTimer = 0;

    const resetGesture = () => {
      deltaX = 0;
      deltaY = 0;
      gestureHandled = false;
    };

    const onWheel = (event: WheelEvent) => {
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(resetGesture, 180);

      if (gestureHandled || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
      const state = ui.get();
      if (state.dialog || state.immersive || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.2) return;

      let element = event.target instanceof Element ? event.target : null;
      while (element) {
        const style = getComputedStyle(element);
        const canScrollX = element.scrollWidth > element.clientWidth + 1 && /auto|scroll/.test(style.overflowX);
        if (canScrollX && (event.deltaX < 0 ? element.scrollLeft > 0 : element.scrollLeft + element.clientWidth < element.scrollWidth - 1)) return;
        element = element.parentElement;
      }

      const direction = event.deltaX < 0 ? 'back' : 'forward';
      event.preventDefault();
      deltaX += event.deltaX;
      deltaY += event.deltaY;
      if (Math.abs(deltaX) < 70 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
      gestureHandled = true;
      navigateRouteHistory(direction);
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.clearTimeout(resetTimer);
    };
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
  useMacTrackpadNavigation();

  useEffect(() => {
    void loadSoundCloudLibrary();
    void loadYtMusicLibrary();
    const runBgCheck = () => {
      void checkForUpdates(true).then((st) => {
        if (st.available) {
          snack(`${t('updateAvailable')}: v${st.latestVersion}`, {
            label: t('updateInstallBtn'),
            run: () => void startInstallNewVersion(),
          });
        }
      });
    };
    const timer = window.setInterval(runBgCheck, 30 * 60 * 1000);
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
    <>
      <Background />
      <SvgDefs />
      <Fragment key={lang}>
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
    </>
  );
}
