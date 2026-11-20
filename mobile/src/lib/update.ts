import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';

/**
 * Mobile updates are ordinary GitHub releases tagged `mobile-v<version>` carrying a signed APK.
 * Android cannot install silently, so `installUpdate` downloads the APK and opens the system
 * installer; the person confirms the last step themselves.
 */
const REPO = 'BohdanKrakoviatskyi/Resonance';
const MOBILE_TAG_PREFIX = 'mobile-v';

export type MobileUpdate = {
  version: string;
  apkUrl: string;
  notes: string;
};

type Release = {
  tag_name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
};

function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

export async function appVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return '0.0.0';
  }
}

export async function checkForUpdate(): Promise<MobileUpdate | null> {
  const current = await appVersion();
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=40`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) return null;
  const releases = (await response.json()) as Release[];
  let best: MobileUpdate | null = null;
  for (const release of releases) {
    const tag = release.tag_name ?? '';
    if (release.draft || release.prerelease || !tag.startsWith(MOBILE_TAG_PREFIX)) continue;
    const version = tag.slice(MOBILE_TAG_PREFIX.length);
    if (!isNewerVersion(version, current)) continue;
    const apk = release.assets?.find((asset) => (asset.name ?? '').toLowerCase().endsWith('.apk'));
    if (!apk?.browser_download_url) continue;
    if (!best || isNewerVersion(version, best.version)) {
      best = { version, apkUrl: apk.browser_download_url, notes: release.body ?? '' };
    }
  }
  return best;
}

export async function installUpdate(update: MobileUpdate): Promise<void> {
  await invoke('mobile_update_install', { url: update.apkUrl });
}
