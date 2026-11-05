import { createStore, persist } from '../lib/util';
import { viewTransition } from '../lib/motion';

export type Route =
  | { name: 'home' }
  | { name: 'search'; q: string }
  | { name: 'favorites' }
  | { name: 'playlist'; id: string }
  | { name: 'appearance' }
  | { name: 'providers' };

export type Dialog = { kind: 'create'; trackId?: string } | { kind: 'rename'; id: string } | { kind: 'delete'; id: string };
export interface Snack { id: number; text: string; action?: { label: string; run: () => void } }

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const seg = path.split('/');
  switch (seg[0]) {
    case 'search':
      return { name: 'search', q: new URLSearchParams(qs ?? '').get('q') ?? '' };
    case 'favorites':
      return { name: 'favorites' };
    case 'playlist':
      return seg[1] ? { name: 'playlist', id: decodeURIComponent(seg[1]) } : { name: 'home' };
    case 'appearance':
      return { name: 'appearance' };
    case 'providers':
      return { name: 'providers' };
    default:
      return { name: 'home' };
  }
}

export function toHash(r: Route) {
  switch (r.name) {
    case 'search':
      return r.q ? `#/search?q=${encodeURIComponent(r.q)}` : '#/search';
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
  sidebar: true,
  panel: true,
  tab: 'lyrics' as 'lyrics' | 'queue',
  immersive: false,
  drawer: false,
  npDrawer: false,
  dialog: null as Dialog | null,
  snack: null as Snack | null,
  foldYtMusic: false,
  foldSoundCloud: false,
  foldLocal: false,
});
persist('lyra.ui.v1', ui, (s) => ({
  sidebar: s.sidebar,
  panel: s.panel,
  tab: s.tab,
  foldYtMusic: s.foldYtMusic,
  foldSoundCloud: s.foldSoundCloud,
  foldLocal: s.foldLocal,
}));

window.addEventListener('hashchange', () => ui.set({ route: parse(), drawer: false }));

export function go(r: Route, replace = false) {
  const h = toHash(r);
  if (replace) {
    history.replaceState(null, '', h);
    ui.set({ route: r });
  } else if (location.hash !== h) location.hash = h;
  else ui.set({ route: r, drawer: false });
}

let sid = 0;
export function snack(text: string, action?: Snack['action']) {
  ui.set({ snack: { id: ++sid, text, action } });
}

export function setImmersive(v: boolean) {
  if (ui.get().immersive === v) return;
  viewTransition(() => ui.set({ immersive: v, npDrawer: false, drawer: false }));
}

export const openDialog = (d: Dialog) => ui.set({ dialog: d });
