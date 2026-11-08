import { clearCache, type CacheClearResult } from '../lib/providers-api';
import { clearPaletteCache } from '../lib/color';
import { library } from './library';

export interface AppCacheClearResult extends CacheClearResult {
  /** Number of Cache Storage buckets deleted (covers/images). */
  webCachesDeleted: number;
}

/** Deletes every Cache Storage bucket (artwork and other images served with
 *  long-lived cache headers). Guarded: some webviews lack the Cache API. */
export async function clearWebCache(): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  const names = await caches.keys().catch(() => [] as string[]);
  let deleted = 0;
  for (const name of names) {
    if (await caches.delete(name).catch(() => false)) deleted++;
  }
  return deleted;
}

/** Clears the whole app cache: backend audio/lyrics/stream caches, the
 *  browser cache holding covers, and in-memory playlist artwork. User data —
 *  accounts, playlists, library, settings — is never touched. */
export async function clearAppCache(signal?: AbortSignal): Promise<AppCacheClearResult> {
  // Backend first: if the sidecar is unreachable the dialog stays open and the
  // user can retry instead of half-clearing only the web side.
  const backend = await clearCache(signal);
  // In-memory artwork is dropped so covers are re-fetched on demand.
  library.set({ ytmusicPlaylistArt: {} });
  clearPaletteCache();
  const webCachesDeleted = await clearWebCache();
  return { ...backend, webCachesDeleted };
}
