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
const persistedStores = new Map<string, () => void>();
let backupTimer = 0;
const isSplashContext = () => typeof document !== 'undefined' && document.documentElement.dataset.splash === 'true';

const syncBackupToSidecar = () => {
  if (isSplashContext()) return;
  void import('./providers-api')
    .then(({ backupFrontendState }) => {
      const entries: Record<string, string> = {};
      for (const k of [...persistedStores.keys(), ...EXTRA_BACKUP_KEYS]) {
        try {
          const val = localStorage.getItem(k);
          if (val !== null) entries[k] = val;
        } catch {
          /* ignore */
        }
      }
      if (Object.keys(entries).length > 0) {
        return backupFrontendState(entries);
      }
    })
    .catch(() => {});
};

export async function flushFrontendStateBackup(): Promise<void> {
  if (isSplashContext()) return;
  for (const save of persistedStores.values()) save();
  try {
    const { backupFrontendState } = await import('./providers-api');
    const entries: Record<string, string> = {};
    for (const k of [...persistedStores.keys(), ...EXTRA_BACKUP_KEYS]) {
      const val = localStorage.getItem(k);
      if (val !== null) entries[k] = val;
    }
    if (Object.keys(entries).length > 0) {
      await backupFrontendState(entries);
    }
  } catch {
    /* ignore */
  }
}

export function persist<T extends object>(key: string, store: Store<T>, pick: (s: T) => Partial<T>, delay = 350, onError?: () => void) {
  let hasLocal = false;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      hasLocal = true;
      store.set(JSON.parse(raw));
    }
  } catch {
    /* corrupted storage — ignore */
  }
  if (!hasLocal) {
    void import('./providers-api')
      .then(({ restoreFrontendState }) => restoreFrontendState())
      .then((entries) => {
        const raw = entries?.[key];
        if (raw && !localStorage.getItem(key)) {
          localStorage.setItem(key, raw);
          store.set(JSON.parse(raw));
        }
      })
      .catch(() => {});
  }
  let tm = 0;
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(pick(store.get())));
      clearTimeout(backupTimer);
      backupTimer = window.setTimeout(syncBackupToSidecar, 1000);
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
