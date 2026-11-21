import { useSyncExternalStore } from 'react';

type Listener = () => void;

export interface Store<T> {
  get(): T;
  set(p: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(l: Listener): () => void;
}

/** Tiny external store — no dependencies, selector-based subscriptions. */
export function createStore<T extends object>(init: T): Store<T> {
  let state = init;
  const subs = new Set<Listener>();
  return {
    get: () => state,
    set(p) {
      const next = typeof p === 'function' ? p(state) : p;
      let changed = false;
      for (const k in next) {
        if (!Object.is(next[k], state[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...next };
      subs.forEach((l) => l());
    },
    subscribe(l) {
      subs.add(l);
      return () => {
        subs.delete(l);
      };
    },
  };
}

export function useStore<T, S>(store: Store<T>, sel: (s: T) => S): S {
  const snap = () => sel(store.get());
  return useSyncExternalStore(store.subscribe, snap, snap);
}

const EXTRA_BACKUP_KEYS = ['resonance.shortcuts.v1', 'resonance.manual_lyrics.v1'];
const BACKUP_DELAY_MS = 6000;
const persistedStores = new Map<string, () => void>();
const dirtyBackupKeys = new Set<string>();
const backedUpValues = new Map<string, string>();
let backupTimer = 0;
const isSplashContext = () => typeof document !== 'undefined' && document.documentElement.dataset.splash === 'true';

const queueBackup = (key: string) => {
  dirtyBackupKeys.add(key);
  if (!backupTimer) backupTimer = window.setTimeout(() => void syncBackupToBackend(), BACKUP_DELAY_MS);
};

// The backend merges the entries it receives into the stored map, so a save ships only the keys that
// changed instead of every persisted key. A failed save puts its keys back in the queue.
const syncBackupToBackend = async () => {
  clearTimeout(backupTimer);
  backupTimer = 0;
  if (isSplashContext()) return;
  const keys = [...dirtyBackupKeys, ...EXTRA_BACKUP_KEYS];
  dirtyBackupKeys.clear();
  const entries: Record<string, string> = {};
  for (const k of keys) {
    try {
      const val = localStorage.getItem(k);
      if (val !== null && backedUpValues.get(k) !== val) entries[k] = val;
    } catch {
      /* ignore */
    }
  }
  if (Object.keys(entries).length === 0) return;
  try {
    const { backupFrontendState } = await import('./providers-api');
    await backupFrontendState(entries);
    for (const k in entries) backedUpValues.set(k, entries[k]);
  } catch {
    for (const k in entries) dirtyBackupKeys.add(k);
  }
};

export async function flushFrontendStateBackup(): Promise<void> {
  if (isSplashContext()) return;
  clearTimeout(backupTimer);
  backupTimer = 0;
  for (const save of persistedStores.values()) save();
  try {
    const { backupFrontendState } = await import('./providers-api');
    const entries: Record<string, string> = {};
    for (const k of [...persistedStores.keys(), ...EXTRA_BACKUP_KEYS]) {
      const val = localStorage.getItem(k);
      if (val !== null) {
        entries[k] = val;
        backedUpValues.set(k, val);
      }
    }
    if (Object.keys(entries).length > 0) {
      await backupFrontendState(entries);
    }
  } catch {
    /* ignore */
  }
}

export function persist<T extends object>(key: string, store: Store<T>, pick: (s: T) => Partial<T>, delay = 350, onError?: () => void) {
  const removeLegacyLastfmCredentials = (parsed: Record<string, unknown>) => {
    if (key === 'resonance.integrations.v1') {
      delete parsed.lastfmApiKey;
      delete parsed.lastfmSecret;
    }
    return parsed;
  };
  let hasLocal = false;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      hasLocal = true;
      const parsed = removeLegacyLastfmCredentials(JSON.parse(raw));
      store.set(parsed as Partial<T>);
      localStorage.setItem(key, JSON.stringify(parsed));
    }
  } catch {
    /* corrupted storage — ignore */
  }
  void import('./providers-api')
    .then(({ restoreFrontendState }) => restoreFrontendState())
    .then((entries) => {
      const raw = entries?.[key];
      if (!raw) return;
      if (!hasLocal) {
        const parsed = removeLegacyLastfmCredentials(JSON.parse(raw) as Record<string, unknown>);
        if (key === 'lyra.lib.v1') {
          delete parsed.spotifyLiked;
          delete parsed.spotifyPlaylists;
          delete parsed.spotifyPlaylistTracks;
          delete parsed.spotifyAuthorized;
          delete parsed.spotifyProfile;
        }
        if (key === 'lyra.ui.v1') {
          delete parsed.foldSpotify;
          if (parsed.favProvider !== 'all' && parsed.favProvider !== 'soundcloud' && parsed.favProvider !== 'youtube') {
            parsed.favProvider = 'all';
          }
        }
        const cleanedRaw = JSON.stringify(parsed);
        localStorage.setItem(key, cleanedRaw);
        store.set(parsed as Partial<T>);
        if (key === 'resonance.integrations.v1') {
          void import('./providers-api')
            .then(({ backupFrontendState }) => backupFrontendState({ [key]: cleanedRaw }));
        }
        return;
      }
      if (key === 'resonance.integrations.v1') {
        try {
          const backedUp = removeLegacyLastfmCredentials(JSON.parse(raw) as Record<string, unknown>);
          const cleanedRaw = JSON.stringify(backedUp);
          void import('./providers-api')
            .then(({ backupFrontendState }) => backupFrontendState({ [key]: cleanedRaw }));
        } catch {
          /* ignore */
        }
      }
      if (key === 'lyra.lib.v1') {
        try {
          const backedUp = JSON.parse(raw) as Record<string, unknown>;
          const current = store.get() as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          for (const field of ['ytmusicLiked', 'ytmusicPlaylists', 'soundcloudLiked', 'soundcloudPlaylists']) {
            const curArr = Array.isArray(current[field]) ? (current[field] as unknown[]) : [];
            const bakArr = Array.isArray(backedUp[field]) ? (backedUp[field] as unknown[]) : [];
            if (curArr.length === 0 && bakArr.length > 0) {
              patch[field] = bakArr;
            }
          }
          for (const objField of ['ytmusicPlaylistTracks', 'soundcloudPlaylistTracks', 'ytmusicPlaylistArt']) {
            const curObj = current[objField] && typeof current[objField] === 'object' ? (current[objField] as Record<string, unknown>) : {};
            const bakObj = backedUp[objField] && typeof backedUp[objField] === 'object' ? (backedUp[objField] as Record<string, unknown>) : {};
            if (Object.keys(curObj).length === 0 && Object.keys(bakObj).length > 0) {
              patch[objField] = bakObj;
            }
          }
          if (Object.keys(patch).length > 0) {
            store.set(patch as Partial<T>);
          }
        } catch {
          /* ignore */
        }
      }
    })
    .catch(() => {});
  let tm = 0;
  // The store fires on fields that are not persisted too (playhead, fade progress), so a save whose
  // payload is byte-identical must not rewrite the key or push the whole state to the backend again.
  let lastWritten: string | null = null;
  const save = () => {
    try {
      const serialized = JSON.stringify(pick(store.get()));
      if (serialized === lastWritten) return;
      lastWritten = serialized;
      localStorage.setItem(key, serialized);
      queueBackup(key);
    } catch {
      onError?.();
    }
  };
  persistedStores.set(key, save);
  store.subscribe(() => {
    clearTimeout(tm);
    tm = window.setTimeout(save, delay);
  });
  window.addEventListener('pagehide', save);
}

const mqCache = new Map<string, MediaQueryList>();
const mql = (q: string) => {
  let m = mqCache.get(q);
  if (!m) mqCache.set(q, (m = matchMedia(q)));
  return m;
};
export function useMedia(q: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = mql(q);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => mql(q).matches,
  );
}
export const MD = '(min-width: 768px)';
export const XL = '(min-width: 1200px)';

export const cx = (...a: (string | false | null | undefined | 0)[]) => a.filter(Boolean).join(' ');
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function fmtTime(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function shuffled<T>(a: T[]): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Polar "cookie / flower" shape in a 0..1 box — the M3 Expressive shape language. */
export function blobPath(n: number, amp: number, pts = 96) {
  const R = 0.5 / (1 + amp);
  let d = '';
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const r = R * (1 + amp * Math.cos(n * a));
    const x = 0.5 + r * Math.cos(a - Math.PI / 2);
    const y = 0.5 + r * Math.sin(a - Math.PI / 2);
    d += (i ? 'L' : 'M') + x.toFixed(4) + ' ' + y.toFixed(4);
  }
  return d + 'Z';
}
