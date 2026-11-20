import type { Track } from '../types';
import { createStore } from '../lib/util';
import { t } from '../lib/i18n';
import { mapSoundCloudTrack, mapYouTubeTrack, searchTracks, trackStream, ytDlpTrackStream } from '../lib/api';
import { fetchExternalPlaylist } from '../lib/yt-api';
import {
  searchSoundCloudTracks,
  searchYtDlpTracks,
  soundCloudAuthStatus,
  soundCloudResolvePlaylist,
  soundCloudUserLikesByInput,
} from '../lib/providers-api';
import { matchExternalTrack, type ImportReviewReason, type SourceTrackInput } from '../lib/import-match';
import { syncKey } from '../lib/sync-key';
import { appendNewTracks, createImportedPlaylist, getTrack, library, registerTracks, setPlaylistSource } from './library';
import { go, openDialog, snack, ui } from './ui';
import { player } from './player';

export type ImportSourceKind =
  | 'youtube'
  | 'soundcloud'
  | 'soundcloud_likes'
  | 'spotify'
  | 'deezer'
  | 'apple_music'
  | 'yandex';

export type ImportPhase =
  | 'idle'
  | 'fetching'
  | 'matching'
  | 'awaiting_decision'
  | 'finalizing'
  | 'completed'
  | 'failed';

export interface ImportReviewItem {
  index: number;
  sourceTitle: string;
  sourceArtist: string;
  sourceDurationSec: number;
  sourceArtworkUrl?: string;
  reason: ImportReviewReason;
  score: number;
  selectedTrack: Track | null;
  candidates: Track[];
  accepted: boolean;
}

export interface ImportJobState {
  active: boolean;
  phase: ImportPhase;
  source: ImportSourceKind | null;
  playlistName: string;
  artworkUrl?: string;
  total: number;
  processed: number;
  matchedCount: number;
  skippedCount: number;
  currentTrackTitle: string;
  pendingTrackId?: string;
  orderedSlots: (Track | null)[];
  reviewItems: ImportReviewItem[];
  error?: string;
  createdPlaylistId?: string;
  /** Original link and mode, saved on the playlist for later syncs. */
  sourceUrl?: string;
  sourceMode?: 'playlist' | 'sc_likes';
  /** When set, new tracks are merged into this playlist instead of creating one. */
  targetPlaylistId?: string;
}

const INITIAL_STATE: ImportJobState = {
  active: false,
  phase: 'idle',
  source: null,
  playlistName: '',
  artworkUrl: undefined,
  total: 0,
  processed: 0,
  matchedCount: 0,
  skippedCount: 0,
  currentTrackTitle: '',
  pendingTrackId: undefined,
  orderedSlots: [],
  reviewItems: [],
  error: undefined,
  createdPlaylistId: undefined,
  sourceUrl: undefined,
  sourceMode: undefined,
  targetPlaylistId: undefined,
};

export const importStore = createStore<ImportJobState>({ ...INITIAL_STATE });

let activeAbort: AbortController | null = null;
let previewAudio: HTMLAudioElement | null = null;
let previewHls: { destroy(): void } | null = null;
let previewReqId = 0;

export const importPreview = createStore<{ trackId: string | null; playing: boolean; loading: boolean }>({
  trackId: null,
  playing: false,
  loading: false,
});

export function stopImportPreview() {
  previewReqId += 1;
  if (previewHls) {
    try {
      previewHls.destroy();
    } catch {}
    previewHls = null;
  }
  if (previewAudio) {
    try {
      previewAudio.pause();
      previewAudio.removeAttribute('src');
      previewAudio.load();
    } catch {}
    previewAudio = null;
  }
  importPreview.set({ trackId: null, playing: false, loading: false });
}

export async function toggleImportPreview(track: Track) {
  const cur = importPreview.get();
  if (cur.trackId === track.id) {
    if (previewAudio) {
      if (cur.playing) {
        previewAudio.pause();
        importPreview.set({ playing: false });
      } else {
        if (player.get().playing) {
          const { toggle } = await import('./player');
          toggle();
        }
        void previewAudio.play().catch(() => {});
        importPreview.set({ playing: true });
      }
      return;
    }
    stopImportPreview();
    return;
  }

  stopImportPreview();
  const reqId = previewReqId;
  importPreview.set({ trackId: track.id, playing: false, loading: true });

  if (player.get().playing) {
    const { toggle } = await import('./player');
    toggle();
  }

  try {
    let url = '';
    let isHls = false;
    if (track.source === 'youtube') {
      const videoId = track.nativeId || (track.id.startsWith('yt:') ? track.id.slice(3).split('~')[0] : '');
      const res = await ytDlpTrackStream(videoId, { priority: true });
      url = res.url;
    } else {
      const urn = track.nativeId || `soundcloud:tracks:${track.id.replace(/^sc:/, '')}`;
      const res = await trackStream(urn);
      url = res.url;
      isHls = res.hls;
    }
    if (reqId !== previewReqId) return;

    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.volume = Math.min(1, Math.max(0.1, player.get().volume));
    previewAudio = el;

    el.addEventListener('ended', () => {
      if (reqId === previewReqId) stopImportPreview();
    });
    el.addEventListener('error', () => {
      if (reqId === previewReqId) stopImportPreview();
    });

    if (isHls) {
      const HlsMod = await import('hls.js');
      const Hls = HlsMod.default;
      if (reqId !== previewReqId) return;
      if (Hls.isSupported()) {
        const hls = new Hls();
        previewHls = hls;
        hls.loadSource(url);
        hls.attachMedia(el);
        await new Promise<void>((resolve, reject) => {
          hls.on(Hls.Events.MANIFEST_PARSED, () => resolve());
          hls.on(Hls.Events.ERROR, (_e, data) => data.fatal && reject(new Error('HLS error')));
        });
      } else {
        el.src = url;
      }
    } else {
      el.src = url;
    }

    if (reqId !== previewReqId) return;
    await el.play();
    if (reqId !== previewReqId) return;
    importPreview.set({ trackId: track.id, playing: true, loading: false });
  } catch {
    if (reqId === previewReqId) {
      stopImportPreview();
      snack(t('cantPlay'));
    }
  }
}

export function detectImportSource(raw: string, mode: 'playlist' | 'sc_likes' = 'playlist'): { source: ImportSourceKind; label: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (mode === 'sc_likes') {
    if (trimmed.includes('soundcloud.com') || (!trimmed.includes('/') && !trimmed.includes('.'))) {
      return { source: 'soundcloud_likes', label: 'SoundCloud' };
    }
    try {
      const u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
        return { source: 'soundcloud_likes', label: 'SoundCloud' };
      }
    } catch {
      return null;
    }
    return null;
  }

  if (trimmed.startsWith('spotify:playlist:')) {
    return { source: 'spotify', label: 'Spotify' };
  }

  try {
    const withScheme = trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;
    const parsedUrl = new URL(withScheme);
    const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
    if (['youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) {
      return { source: 'youtube', label: 'YouTube Music' };
    }
    if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com') || host === 'snd.click') {
      const segs = parsedUrl.pathname.split('/').filter(Boolean);
      const isLikesUrl = segs.length >= 2 && segs[1].toLowerCase() === 'likes';
      const isUserRootUrl = segs.length === 1 && segs[0].toLowerCase() !== 'discover';
      if (isLikesUrl || isUserRootUrl) {
        return { source: 'soundcloud_likes', label: 'SoundCloud Likes' };
      }
      return { source: 'soundcloud', label: 'SoundCloud' };
    }
    if (host === 'open.spotify.com' || host === 'spotify.link' || host === 'spoti.fi') {
      return { source: 'spotify', label: 'Spotify' };
    }
    if (host === 'deezer.com' || host.endsWith('.deezer.com') || host === 'deezer.page.link' || host === 'link.deezer.com') {
      return { source: 'deezer', label: 'Deezer' };
    }
    if (['music.apple.com', 'geo.music.apple.com', 'itunes.apple.com'].includes(host) || host.endsWith('.music.apple.com')) {
      return { source: 'apple_music', label: 'Apple Music' };
    }
    if (/^music\.yandex\.(ru|com|by|kz|uz)$/.test(host)) {
      return { source: 'yandex', label: 'Яндекс Музыка' };
    }
  } catch {
    return null;
  }
  return null;
}

export function cancelPlaylistImport() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  stopImportPreview();
  const wasActive = importStore.get().active;
  importStore.set({ ...INITIAL_STATE });
  if (wasActive) {
    if (ui.get().dialog?.kind === 'import-review') {
      ui.set({ dialog: null });
    }
    snack(t('importCancelled'));
  }
}

function finalizeTracksAndSave(tracks: Track[], name: string, artworkUrl?: string, pendingTrackId?: string) {
  importStore.set({ phase: 'finalizing' });
  stopImportPreview();
  const { targetPlaylistId, sourceUrl, sourceMode } = importStore.get();

  if (targetPlaylistId) {
    const added = appendNewTracks(targetPlaylistId, tracks);
    importStore.set({ ...INITIAL_STATE, phase: 'completed', createdPlaylistId: targetPlaylistId });
    if (ui.get().dialog?.kind === 'import-review') ui.set({ dialog: null });
    snack(added ? t('syncAdded', { n: added }) : t('syncNothingNew'));
    return;
  }

  const createdId = createImportedPlaylist(name, tracks, artworkUrl, pendingTrackId);
  if (sourceUrl && sourceMode) setPlaylistSource(createdId, sourceUrl, sourceMode);
  importStore.set({
    ...INITIAL_STATE,
    phase: 'completed',
    createdPlaylistId: createdId,
  });

  if (ui.get().dialog?.kind === 'import-review') {
    ui.set({ dialog: null });
  }

  snack(t('importDoneToast', { name, count: tracks.length }), {
    label: t('importOpenPlaylist'),
    run: () => go({ name: 'playlist', id: createdId }),
  });

  if (!pendingTrackId) {
    go({ name: 'playlist', id: createdId });
  }
}

function existingTrackKeys(playlistId: string) {
  const pl = library.get().playlists.find((p) => p.id === playlistId);
  const ids = new Set(pl?.ids ?? []);
  const keys = new Set<string>();
  for (const id of ids) {
    const tr = getTrack(id);
    if (tr) keys.add(syncKey(tr.title, tr.artist));
  }
  return { ids, keys };
}

/** Pulls new tracks from the link the playlist was imported from. */
export function syncImportedPlaylist(playlistId: string) {
  const pl = library.get().playlists.find((p) => p.id === playlistId);
  if (!pl?.sourceUrl) return Promise.resolve();
  snack(t('syncStarted', { name: pl.name }));
  return startPlaylistImport({ input: pl.sourceUrl, mode: pl.sourceMode ?? 'playlist', targetPlaylistId: pl.id, customName: pl.name }).catch((e) =>
    snack(e instanceof Error ? e.message : String(e)),
  );
}

export async function startPlaylistImport(opts: {
  input: string;
  mode: 'playlist' | 'sc_likes';
  customName?: string;
  pendingTrackId?: string;
  targetPlaylistId?: string;
}) {
  if (importStore.get().active) {
    throw new Error(t('importAlreadyRunning'));
  }
  const detected = detectImportSource(opts.input, opts.mode);
  if (!detected) {
    throw new Error(opts.mode === 'sc_likes' ? t('importEnterUserFirst') : t('importUnsupportedLink'));
  }

  const ac = new AbortController();
  activeAbort = ac;

  importStore.set({
    ...INITIAL_STATE,
    active: true,
    phase: 'fetching',
    source: detected.source,
    playlistName: opts.customName?.trim() || detected.label,
    pendingTrackId: opts.pendingTrackId,
    sourceUrl: opts.input.trim(),
    sourceMode: opts.mode,
    targetPlaylistId: opts.targetPlaylistId,
  });

  try {
    let remoteTitle = '';
    let remoteArtwork: string | undefined;
    let directTracks: Track[] | null = null;
    let externalItems: SourceTrackInput[] = [];
    let scAuthorized = false;

    if (detected.source === 'soundcloud' || detected.source === 'soundcloud_likes') {
      const auth = await soundCloudAuthStatus(ac.signal).catch(() => ({ authorized: false }));
      scAuthorized = auth.authorized;

      if (detected.source === 'soundcloud_likes') {
        const res = await soundCloudUserLikesByInput(opts.input, ac.signal);
        remoteTitle = `${res.username} · ${t('soundcloudLiked')}`;
        remoteArtwork = res.artworkUrl || res.avatarUrl;
        const mapped = res.tracks.map(mapSoundCloudTrack);
        if (scAuthorized) {
          directTracks = mapped;
        } else {
          externalItems = mapped.map((tr) => ({
            title: tr.title,
            artist: tr.artist,
            durationMs: Math.round((tr.duration || 0) * 1000),
            artworkUrl: tr.cover,
          }));
        }
      } else {
        const res = await soundCloudResolvePlaylist(opts.input, ac.signal);
        remoteTitle = res.title;
        remoteArtwork = res.artworkUrl;
        const mapped = res.tracks.map(mapSoundCloudTrack);
        if (scAuthorized) {
          directTracks = mapped;
        } else {
          externalItems = mapped.map((tr) => ({
            title: tr.title,
            artist: tr.artist,
            durationMs: Math.round((tr.duration || 0) * 1000),
            artworkUrl: tr.cover,
          }));
        }
      }
    } else {
      const res = await fetchExternalPlaylist(opts.input, ac.signal);
      remoteTitle = res.title;
      remoteArtwork = res.artworkUrl;
      if (res.source === 'youtube') {
        directTracks = res.tracks
          .filter((tr) => tr.nativeId)
          .map((tr) =>
            mapYouTubeTrack({
              nativeId: tr.nativeId!,
              source: 'youtube',
              urn: `youtube:track:${tr.nativeId}`,
              title: tr.title,
              artist: tr.artist || 'YouTube Music',
              durationMs: tr.durationMs || 0,
              artworkUrl: tr.artworkUrl,
            }),
          );
      } else {
        const auth = await soundCloudAuthStatus(ac.signal).catch(() => ({ authorized: false }));
        scAuthorized = auth.authorized;
        externalItems = res.tracks;
      }
    }

    if (ac.signal.aborted) return;

    // Syncing: only tracks that are not in the playlist yet go through (slow) matching.
    if (opts.targetPlaylistId) {
      const existing = existingTrackKeys(opts.targetPlaylistId);
      if (directTracks !== null) directTracks = directTracks.filter((tr) => !existing.ids.has(tr.id) && !existing.keys.has(syncKey(tr.title, tr.artist)));
      externalItems = externalItems.filter((it) => !existing.keys.has(syncKey(it.title, it.artist)));
      if ((directTracks ?? externalItems).length === 0) {
        finalizeTracksAndSave([], '', undefined, undefined);
        return;
      }
    }

    const finalName = opts.customName?.trim() || remoteTitle || t('newPlaylist');
    importStore.set({
      playlistName: finalName,
      artworkUrl: remoteArtwork,
    });

    if (directTracks !== null) {
      if (directTracks.length === 0) {
        throw new Error(t('importNoCandidate'));
      }
      importStore.set({
        total: directTracks.length,
        processed: directTracks.length,
        matchedCount: directTracks.length,
      });
      finalizeTracksAndSave(directTracks, finalName, remoteArtwork, opts.pendingTrackId);
      return;
    }

    const total = externalItems.length;
    if (total === 0) {
      throw new Error(t('importNoCandidate'));
    }

    const slots: (Track | null)[] = new Array(total).fill(null);
    const reviewItems: ImportReviewItem[] = [];
    let processed = 0;
    let matchedCount = 0;
    let skippedCount = 0;
    let cursor = 0;

    importStore.set({
      phase: 'matching',
      total,
      processed: 0,
      matchedCount: 0,
      skippedCount: 0,
      currentTrackTitle: externalItems[0]?.title ?? '',
      orderedSlots: slots,
    });

    const CONCURRENCY = 3;
    const worker = async () => {
      while (!ac.signal.aborted) {
        const idx = cursor++;
        if (idx >= total) break;
        const item = externalItems[idx];
        importStore.set({ currentTrackTitle: item.title });
        try {
          const outcome = await matchExternalTrack(item, {
            searchYouTube: (q, sig) => searchYtDlpTracks(q, sig).then((items) => items.map(mapYouTubeTrack)),
            searchSoundCloud: scAuthorized
              ? (q, sig) => searchSoundCloudTracks(q, sig).then((items) => items.map(mapSoundCloudTrack))
              : undefined,
            signal: ac.signal,
          });
          if (ac.signal.aborted) return;

          if (outcome.reason === 'auto_matched' && outcome.best) {
            slots[idx] = outcome.best;
            matchedCount += 1;
          } else {
            skippedCount += 1;
            reviewItems.push({
              index: idx,
              sourceTitle: item.title,
              sourceArtist: item.artist,
              sourceDurationSec: Math.round((item.durationMs || 0) / 1000),
              sourceArtworkUrl: item.artworkUrl,
              reason: outcome.reason,
              score: outcome.score,
              selectedTrack: outcome.best,
              candidates: outcome.candidates,
              accepted: Boolean(outcome.best && outcome.score >= 52),
            });
          }
        } catch (err) {
          if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          skippedCount += 1;
          reviewItems.push({
            index: idx,
            sourceTitle: item.title,
            sourceArtist: item.artist,
            sourceDurationSec: Math.round((item.durationMs || 0) / 1000),
            sourceArtworkUrl: item.artworkUrl,
            reason: 'catalog_lookup_failed',
            score: 0,
            selectedTrack: null,
            candidates: [],
            accepted: false,
          });
        } finally {
          if (!ac.signal.aborted) {
            processed += 1;
            importStore.set({ processed, matchedCount, skippedCount });
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));
    if (ac.signal.aborted) return;

    reviewItems.sort((a, b) => a.index - b.index);
    for (const rv of reviewItems) {
      if (rv.candidates.length) registerTracks(rv.candidates);
    }

    if (reviewItems.length === 0) {
      const tracks = slots.filter((tr): tr is Track => Boolean(tr));
      finalizeTracksAndSave(tracks, finalName, remoteArtwork, opts.pendingTrackId);
      return;
    }

    importStore.set({
      phase: 'awaiting_decision',
      orderedSlots: slots,
      reviewItems,
      currentTrackTitle: '',
    });

    snack(t('importNeedsReview', { count: reviewItems.length }), {
      label: t('importReviewBtn'),
      run: () => openDialog({ kind: 'import-review' }),
    });
    if (!ui.get().dialog) {
      openDialog({ kind: 'import-review' });
    }
  } catch (err) {
    if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    importStore.set({
      active: false,
      phase: 'failed',
      error: msg,
    });
    snack(msg || t('importFailed'));
    throw err;
  } finally {
    if (activeAbort === ac) {
      activeAbort = null;
    }
  }
}

export function setReviewItemAccepted(index: number, accepted: boolean) {
  importStore.set((s) => ({
    reviewItems: s.reviewItems.map((it) => (it.index === index ? { ...it, accepted } : it)),
  }));
}

export function selectReviewItemCandidate(index: number, track: Track) {
  registerTracks([track]);
  importStore.set((s) => ({
    reviewItems: s.reviewItems.map((it) =>
      it.index === index
        ? {
            ...it,
            selectedTrack: track,
            accepted: true,
            candidates: it.candidates.some((c) => c.id === track.id) ? it.candidates : [track, ...it.candidates],
          }
        : it,
    ),
  }));
}

export function setAllReviewItemsAccepted(accepted: boolean) {
  importStore.set((s) => ({
    reviewItems: s.reviewItems.map((it) => ({
      ...it,
      accepted: accepted ? Boolean(it.selectedTrack) : false,
    })),
  }));
}

export async function searchManualReviewCandidates(query: string): Promise<Track[]> {
  const results = await searchTracks(query);
  registerTracks(results);
  return results;
}

export function applyReviewDecisions(skipAll = false) {
  const st = importStore.get();
  if (!st.active) return;

  const slots = st.orderedSlots.slice();
  if (!skipAll) {
    for (const item of st.reviewItems) {
      if (item.accepted && item.selectedTrack) {
        slots[item.index] = item.selectedTrack;
      }
    }
  }

  const finalTracks = slots.filter((tr): tr is Track => Boolean(tr));
  if (finalTracks.length === 0 && !st.pendingTrackId) {
    snack(t('importNoTracksSelected'));
    return;
  }

  finalizeTracksAndSave(finalTracks, st.playlistName, st.artworkUrl, st.pendingTrackId);
}
