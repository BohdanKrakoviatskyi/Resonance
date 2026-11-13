import { createStore, persist } from '../lib/util';
import { viewTransition } from '../lib/motion';
import {
  clampLyricsOffset,
  resolveEffectiveLyricsOffset,
  updateTrackLyricsOffsetsMap,
} from '../lib/lyrics-match';

export type Route =
  | { name: 'home' }
  | { name: 'favorites' }
  | { name: 'playlist'; id: string }
  | { name: 'settings' }
  | { name: 'appearance' }
  | { name: 'providers' }
  | { name: 'shortcuts' }
  | { name: 'audio' };

export type Dialog =
  | { kind: 'create'; trackId?: string }
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'update' }
  | { kind: 'update-uninstall' }
  | { kind: 'uninstall' }
  | { kind: 'clear-cache' };
export interface Snack { id: number; text: string; action?: { label: string; run: () => void } }

function parse(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [path] = h.split('?');
  const seg = path.split('/');
  switch (seg[0]) {
    case 'favorites':
      return { name: 'favorites' };
    case 'playlist':
      return seg[1] ? { name: 'playlist', id: decodeURIComponent(seg[1]) } : { name: 'home' };
    case 'settings':
      return { name: 'settings' };
    case 'appearance':
      return { name: 'appearance' };
    case 'providers':
      return { name: 'providers' };
    case 'shortcuts':
      return { name: 'shortcuts' };
    case 'audio':
      return { name: 'audio' };
    default:
      return { name: 'home' };
  }
}

function parseSearch(): { searchOpen: boolean; searchQ: string } {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  if (path.split('/')[0] === 'search') {
    return { searchOpen: true, searchQ: new URLSearchParams(qs ?? '').get('q') ?? '' };
  }
  return { searchOpen: false, searchQ: '' };
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
  searchOpen: parseSearch().searchOpen,
  searchQ: parseSearch().searchQ,
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
  favProvider: 'soundcloud' as 'soundcloud' | 'youtube',
  scaleSlowedLyrics: false,
  showLyricsDebugInfo: false,
  lyricsOffsets: {} as Record<string, number>,
  lyricsLiveDraft: null as { trackId: string; offsetSec: number } | null,
});
persist('lyra.ui.v1', ui, (s) => ({
  sidebar: s.sidebar,
  panel: s.panel,
  tab: s.tab,
  foldYtMusic: s.foldYtMusic,
  foldSoundCloud: s.foldSoundCloud,
  foldLocal: s.foldLocal,
  favProvider: s.favProvider,
  scaleSlowedLyrics: s.scaleSlowedLyrics,
  showLyricsDebugInfo: s.showLyricsDebugInfo,
  lyricsOffsets: s.lyricsOffsets,
}));

if (ui.get().favProvider !== 'soundcloud' && ui.get().favProvider !== 'youtube') {
  ui.set({ favProvider: 'soundcloud' });
}

window.addEventListener('hashchange', () => {
  const s = parseSearch();
  ui.set({ route: parse(), searchOpen: s.searchOpen, searchQ: s.searchQ, drawer: false });
});

export function go(r: Route, replace = false) {
  const h = toHash(r);
  if (replace) {
    history.replaceState(null, '', h);
    ui.set({ route: r, searchOpen: false, searchQ: '', drawer: false });
  } else if (location.hash !== h) location.hash = h;
  else ui.set({ route: r, searchOpen: false, searchQ: '', drawer: false });
}

/** Search is an element of the home page, not a separate route. */
export function openSearch(q = '') {
  if (location.hash !== '#/') history.replaceState(null, '', '#/');
  ui.set({ route: { name: 'home' }, searchOpen: true, searchQ: q, drawer: false });
}

export function closeSearch() {
  ui.set({ searchOpen: false, searchQ: '' });
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

export function getTrackLyricsOffset(trackId: string | null | undefined): number {
  if (!trackId) return 0;
  const val = ui.get().lyricsOffsets?.[trackId];
  return typeof val === 'number' && Number.isFinite(val) ? clampLyricsOffset(val) : 0;
}

export function getEffectiveTrackLyricsOffset(trackId: string | null | undefined): number {
  const s = ui.get();
  return resolveEffectiveLyricsOffset(s.lyricsOffsets, trackId, s.lyricsLiveDraft);
}

export function setLiveTrackLyricsOffset(trackId: string, offsetSec: number) {
  if (!trackId) return;
  ui.set({
    lyricsLiveDraft: {
      trackId,
      offsetSec: clampLyricsOffset(offsetSec),
    },
  });
}

export function clearLiveTrackLyricsOffset(trackId?: string) {
  const draft = ui.get().lyricsLiveDraft;
  if (!draft) return;
  if (!trackId || draft.trackId === trackId) {
    ui.set({ lyricsLiveDraft: null });
  }
}

export function setTrackLyricsOffset(trackId: string, offsetSec: number) {
  if (!trackId) return;
  const snapped = clampLyricsOffset(offsetSec);
  const next = updateTrackLyricsOffsetsMap(ui.get().lyricsOffsets, trackId, snapped);
  ui.set({
    lyricsOffsets: next,
    lyricsLiveDraft: { trackId, offsetSec: snapped },
  });
}

export function adjustTrackLyricsOffset(trackId: string, deltaSec: number) {
  if (!trackId) return;
  setLiveTrackLyricsOffset(trackId, getEffectiveTrackLyricsOffset(trackId) + deltaSec);
}
