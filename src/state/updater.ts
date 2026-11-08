import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import pkg from '../../package.json';
import { createStore, flushFrontendStateBackup, persist } from '../lib/util';

export const APP_VERSION = pkg.version;
const GITHUB_RELEASES_API = 'https://api.github.com/repos/BohdanKrakoviatskyi/Resonance/releases/latest';
const GITHUB_RELEASES_URL = 'https://github.com/BohdanKrakoviatskyi/Resonance/releases/latest';
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 4500;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface UpdateState {
  checking: boolean;
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

export const updater = createStore<UpdateState>({
  checking: false,
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

function pickPlatformAsset(assets: ReleaseAsset[], fallbackUrl: string): string {
  if (!Array.isArray(assets) || !assets.length) return fallbackUrl;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) {
    const setup = assets.find((a) => /setup\.exe$|\.msi$|\.exe$/i.test(a.name));
    if (setup?.browser_download_url) return setup.browser_download_url;
  } else if (ua.includes('mac')) {
    const dmg = assets.find((a) => /\.dmg$|\.app\.tar\.gz$/i.test(a.name));
    if (dmg?.browser_download_url) return dmg.browser_download_url;
  } else if (ua.includes('linux')) {
    const pkgAsset = assets.find((a) => /\.appimage$|\.deb$|\.rpm$/i.test(a.name));
    if (pkgAsset?.browser_download_url) return pkgAsset.browser_download_url;
  }
  return fallbackUrl;
}

async function fetchLatestReleaseOnce(): Promise<{
  tag_name?: string;
  html_url?: string;
  body?: string;
  assets?: ReleaseAsset[];
}> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(GITHUB_RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    return (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      assets?: ReleaseAsset[];
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function checkForUpdates(force = false): Promise<UpdateState> {
  const cur = updater.get();
  if (cur.checking) return cur;
  // If an update was already found and remembered, don't search again unless forced.
  if (!force && cur.available && isNewerVersion(cur.latestVersion, APP_VERSION)) {
    return cur;
  }
  updater.set({ checking: true, error: '' });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await fetchLatestReleaseOnce();
      const latestVersion = (data.tag_name || APP_VERSION).replace(/^v/i, '').trim() || APP_VERSION;
      const releaseUrl = data.html_url || GITHUB_RELEASES_URL;
      const downloadUrl = pickPlatformAsset(data.assets ?? [], releaseUrl);
      const available = isNewerVersion(latestVersion, APP_VERSION);
      updater.set({
        checking: false,
        available,
        currentVersion: APP_VERSION,
        latestVersion,
        releaseUrl,
        downloadUrl,
        notes: data.body || '',
        error: '',
      });
      return updater.get();
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => window.setTimeout(r, 400));
      }
    }
  }

  // After 2-3 attempts with no release found, keep remembered update if any, otherwise treat current version as the latest.
  const latestRemembered = updater.get().latestVersion;
  const stillAvailable = isNewerVersion(latestRemembered, APP_VERSION);
  updater.set({
    checking: false,
    available: stillAvailable,
    currentVersion: APP_VERSION,
    latestVersion: stillAvailable ? latestRemembered : APP_VERSION,
    error: '',
  });
  return updater.get();
}

export async function startInstallNewVersion(): Promise<void> {
  await flushFrontendStateBackup();
  const { downloadUrl, releaseUrl } = updater.get();
  const target = downloadUrl || releaseUrl || GITHUB_RELEASES_URL;
  try {
    await open(target);
  } catch {
    window.open(target, '_blank', 'noopener,noreferrer');
  }
}

export async function runAppUninstall(): Promise<void> {
  await flushFrontendStateBackup();
  await invoke('uninstall_app');
}
