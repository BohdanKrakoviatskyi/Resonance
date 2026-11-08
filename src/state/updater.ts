import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import pkg from '../../package.json';
import { createStore, flushFrontendStateBackup, persist } from '../lib/util';

export const APP_VERSION = pkg.version;
const GITHUB_RELEASES_URL = 'https://github.com/BohdanKrakoviatskyi/Resonance/releases/latest';
const CHECK_TIMEOUT_MS = 5000;

export interface UpdateState {
  checking: boolean;
  installing: boolean;
  progress: number;
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  downloadUrl: string;
  notes: string;
  error: string;
}

export function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .trim()
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

export function hasTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const updater = createStore<UpdateState>({
  checking: false,
  installing: false,
  progress: 0,
  available: false,
  currentVersion: APP_VERSION,
  latestVersion: APP_VERSION,
  releaseUrl: GITHUB_RELEASES_URL,
  downloadUrl: GITHUB_RELEASES_URL,
  notes: '',
  error: '',
});

persist('lyra.updater.v1', updater, (s) => ({
  available: s.available,
  latestVersion: s.latestVersion,
  releaseUrl: s.releaseUrl,
  downloadUrl: s.downloadUrl,
  notes: s.notes,
}));

// Reconcile persisted update state against current running version (e.g. right after upgrading).
const initial = updater.get();
if (!isNewerVersion(initial.latestVersion, APP_VERSION)) {
  updater.set({
    available: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
  });
} else {
  updater.set({
    available: true,
    currentVersion: APP_VERSION,
  });
}

let pendingUpdate: Update | null = null;

async function checkWithTimeout(timeoutMs = CHECK_TIMEOUT_MS): Promise<Update | null> {
  let timer = 0;
  try {
    return await Promise.race([
      check({ timeout: timeoutMs }),
      new Promise<null>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('Update check timeout')), timeoutMs);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

export async function checkForUpdates(force = false): Promise<UpdateState> {
  const cur = updater.get();
  if (cur.checking || cur.installing) return cur;
  if (import.meta.env.DEV || !hasTauriRuntime()) {
    updater.set({
      checking: false,
      available: false,
      currentVersion: APP_VERSION,
      latestVersion: APP_VERSION,
      error: '',
    });
    return updater.get();
  }
  if (!force && cur.available && isNewerVersion(cur.latestVersion, APP_VERSION) && pendingUpdate) {
    return cur;
  }

  updater.set({ checking: true, error: '' });

  try {
    const update = await checkWithTimeout(CHECK_TIMEOUT_MS);
    if (pendingUpdate && pendingUpdate !== update) {
      void pendingUpdate.close().catch(() => {});
    }
    pendingUpdate = update;

    if (update) {
      const latestVersion = (update.version || APP_VERSION).replace(/^v/i, '').trim() || APP_VERSION;
      const available = isNewerVersion(latestVersion, APP_VERSION) || update.available;
      updater.set({
        checking: false,
        available,
        currentVersion: APP_VERSION,
        latestVersion: available ? latestVersion : APP_VERSION,
        releaseUrl: GITHUB_RELEASES_URL,
        downloadUrl: GITHUB_RELEASES_URL,
        notes: update.body || '',
        error: '',
      });
    } else {
      updater.set({
        checking: false,
        available: false,
        currentVersion: APP_VERSION,
        latestVersion: APP_VERSION,
        notes: '',
        error: '',
      });
    }
  } catch {
    updater.set({
      checking: false,
      available: false,
      currentVersion: APP_VERSION,
      latestVersion: APP_VERSION,
      error: '',
    });
  }

  return updater.get();
}

export async function startInstallNewVersion(onProgress?: (progress: number) => void): Promise<void> {
  if (updater.get().installing) return;
  updater.set({ installing: true, progress: 0, error: '' });
  onProgress?.(0);

  try {
    await flushFrontendStateBackup();
    const update = pendingUpdate ?? (await checkWithTimeout(CHECK_TIMEOUT_MS));
    pendingUpdate = null;

    if (!update) {
      updater.set({
        installing: false,
        progress: 0,
        available: false,
        latestVersion: APP_VERSION,
      });
      return;
    }

    let downloaded = 0;
    let total = 0;

    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
        downloaded = 0;
        updater.set({ progress: 2 });
        onProgress?.(2);
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        const pct =
          total > 0
            ? Math.min(98, Math.max(2, Math.round((downloaded / total) * 100)))
            : Math.min(95, updater.get().progress + 3);
        updater.set({ progress: pct });
        onProgress?.(pct);
      } else if (event.event === 'Finished') {
        updater.set({ progress: 100 });
        onProgress?.(100);
      }
    });

    await relaunch();
  } catch (err) {
    updater.set({
      installing: false,
      progress: 0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function finishSplash(): Promise<void> {
  if (!hasTauriRuntime()) return;
  try {
    await invoke('finish_splash');
    return;
  } catch {
    /* fallback to Tauri window API */
  }
  try {
    const { getCurrentWindow, Window } = await import('@tauri-apps/api/window');
    const mainWin = await Window.getByLabel('main');
    await mainWin?.show();
    await mainWin?.setFocus();
    await getCurrentWindow().close();
  } catch {
    /* ignore */
  }
}

export async function runAppUninstall(): Promise<void> {
  await flushFrontendStateBackup();
  await invoke('uninstall_app');
}
