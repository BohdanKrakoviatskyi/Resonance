import { createStore, persist } from '../lib/util';

export type Route =
  | { name: 'home' }
  | { name: 'search' }
  | { name: 'library' }
  | { name: 'favorites' }
  | { name: 'playlist'; id: string }
  | { name: 'settings' }
  | { name: 'appearance' }
  | { name: 'providers' }
  | { name: 'shortcuts' }
  | { name: 'audio' };

export type Dialog =
  | { kind: 'create'; trackId?: string; initialTab?: 'scratch' | 'import' }
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'import-review' }
  | { kind: 'clear-cache' }
  | { kind: 'add-to-playlist'; trackId: string };

export interface Snack {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [path] = h.split('?');
  const seg = path.split('/');
  switch (seg[0]) {
    case 'search':
      return { name: 'search' };
    case 'library':
      return { name: 'library' };
    case 'favorites':
      return { name: 'favorites' };
    case 'playlist':
      return seg[1] ? { name: 'playlist', id: decodeURIComponent(seg[1]) } : { name: 'library' };
    case 'settings':
      return { name: 'settings' };
    case 'appearance':
      return { name: 'appearance' };
    case 'providers':
      return { name: 'providers' };
    case 'audio':
      return { name: 'audio' };
    default:
      return { name: 'home' };
  }
}

export function toHash(r: Route) {
  switch (r.name) {
    case 'playlist':
      return `#/playlist/${encodeURIComponent(r.id)}`;
    case 'home':
      return '#/';
    default:
      return `#/${r.name}`;
  }
}

export const routeKey = (r: Route) => (r.name === 'playlist' ? 'pl:' + r.id : r.name);

export const ui = createStore({
  route: parse(),
  searchOpen: false,
  searchQ: '',
  sidebar: false,
  panel: false,
  tab: 'lyrics' as 'lyrics' | 'queue',
  immersive: false,
  drawer: false,
  npDrawer: false,
  nowPlayingOpen: false,
  nowPlayingTab: 'artwork' as 'artwork' | 'lyrics' | 'queue',
  eqSheetOpen: false,
  trackMenuId: null as string | null,
  dialog: null as Dialog | null,
  snack: null as Snack | null,
  foldYtMusic: false,
  foldSoundCloud: false,
  foldLocal: false,
  favProvider: 'all' as 'all' | 'soundcloud' | 'youtube',
});

persist('resonance.mobile.ui.v1', ui, (s) => ({
  nowPlayingTab: s.nowPlayingTab,
  foldYtMusic: s.foldYtMusic,
  foldSoundCloud: s.foldSoundCloud,
  foldLocal: s.foldLocal,
  favProvider: s.favProvider,
}));

window.addEventListener('hashchange', () => {
  ui.set({ route: parse() });
});

export function go(r: Route, replace = false) {
  const h = toHash(r);
  if (replace) {
    history.replaceState(null, '', h);
    ui.set({ route: r, nowPlayingOpen: false });
  } else if (location.hash !== h) {
    location.hash = h;
    ui.set({ route: r, nowPlayingOpen: false });
  } else {
    ui.set({ route: r, nowPlayingOpen: false });
  }
}

export function openSearch(q = '') {
  ui.set({ searchQ: q, nowPlayingOpen: false });
  go({ name: 'search' });
}

export function closeSearch() {
  ui.set({ searchQ: '' });
}

let sid = 0;
export function snack(text: string, action?: Snack['action']) {
  ui.set({ snack: { id: ++sid, text, action } });
}

export function setImmersive(v: boolean) {
  ui.set({ immersive: v, nowPlayingOpen: v });
}

export const openDialog = (d: Dialog) => ui.set({ dialog: d });

export function openTrackMenu(trackId: string) {
  ui.set({ trackMenuId: trackId });
}

export function closeTrackMenu() {
  ui.set({ trackMenuId: null });
}

/** Handles Android hardware/gesture back button cleanly; returns true if handled inside the app. */
export function consumeBackPress(): boolean {
  const s = ui.get();
  if (s.dialog) {
    ui.set({ dialog: null });
    return true;
  }
  if (s.trackMenuId) {
    ui.set({ trackMenuId: null });
    return true;
  }
  if (s.eqSheetOpen) {
    ui.set({ eqSheetOpen: false });
    return true;
  }
  if (s.nowPlayingOpen) {
    ui.set({ nowPlayingOpen: false });
    return true;
  }
  switch (s.route.name) {
    case 'appearance':
    case 'providers':
    case 'audio':
    case 'shortcuts':
      go({ name: 'settings' }, true);
      return true;
    case 'playlist':
    case 'favorites':
      go({ name: 'library' }, true);
      return true;
    case 'search':
    case 'library':
    case 'settings':
      go({ name: 'home' }, true);
      return true;
    default:
      return false;
  }
}
