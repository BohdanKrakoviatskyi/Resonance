import { invoke } from '@tauri-apps/api/core';
import { createStore, persist } from '../lib/util';
import { buildPresence, presenceKey, type PresenceInput } from '../lib/presence-plan';
import { DISCORD_APPLICATION_ID } from '../lib/discord-config';
import { cleanArtist, creditedDelta, dropStale, scrobbleThreshold, type ScrobbleItem } from '../lib/scrobble-plan';
import { currentTrack, dur, player, realCurTime } from './player';

export const integrations = createStore({
  discordEnabled: false,
  /** Last error from the Discord bridge, for the settings page. Not persisted. */
  discordError: '' as string,

  lastfmEnabled: false,
  /** Logged-in username; the session key itself stays in the OS keyring. Not persisted. */
  lastfmUser: null as string | null,
  /** Scrobbles waiting for network or login. */
  lastfmQueue: [] as ScrobbleItem[],
  lastfmError: '' as string,
  lastfmScrobbled: 0,
});

persist('resonance.integrations.v1', integrations, (s) => ({
  discordEnabled: s.discordEnabled,
  lastfmEnabled: s.lastfmEnabled,
  lastfmQueue: s.lastfmQueue,
  lastfmScrobbled: s.lastfmScrobbled,
}));

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let lastKey = '';

function send(clientId: string, track: ReturnType<typeof buildPresence> | null) {
  invoke('discord_set_presence', { clientId, track })
    .then(() => integrations.get().discordError && integrations.set({ discordError: '' }))
    .catch((e) => integrations.set({ discordError: String(e) }));
}

function syncDiscord() {
  const { discordEnabled } = integrations.get();
  const track = currentTrack();
  const s = player.get();
  if (!discordEnabled || !track || s.state === 'idle' || s.state === 'error') {
    if (lastKey !== 'clear') {
      lastKey = 'clear';
      send(DISCORD_APPLICATION_ID, null);
    }
    return;
  }
  const now = Date.now();
  const input: PresenceInput = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    cover: track.cover,
    playing: s.playing,
    position: realCurTime(),
    duration: dur(),
  };
  const key = `${DISCORD_APPLICATION_ID}|${presenceKey(input, now)}`;
  if (key === lastKey) return;
  lastKey = key;
  send(DISCORD_APPLICATION_ID, buildPresence(input, now));
}

/* ---------------- Last.fm ---------------- */

const lastfmReady = () => {
  const s = integrations.get();
  return s.lastfmEnabled && !!s.lastfmUser;
};

export async function lastfmLogin() {
  const name = await invoke<string>('lastfm_login');
  integrations.set({ lastfmUser: name, lastfmEnabled: true, lastfmError: '' });
  void flushScrobbles();
}

export async function lastfmLogout() {
  await invoke('lastfm_logout').catch(() => {});
  integrations.set({ lastfmUser: null });
}

let flushing = false;
export async function flushScrobbles() {
  if (flushing || !lastfmReady()) return;
  const queue = dropStale(integrations.get().lastfmQueue, Date.now() / 1000);
  if (!queue.length) return;
  flushing = true;
  const batch = queue.slice(0, 50);
  try {
    const accepted = await invoke<number>('lastfm_scrobble', { items: batch });
    // Last.fm принимает подряд с начала пачки; остаток остаётся в очереди до следующей попытки.
    const sent = batch.slice(0, accepted);
    if (!sent.length) {
      integrations.set({ lastfmError: 'Last.fm accepted 0 scrobbles' });
      return;
    }
    integrations.set((s) => ({
      lastfmQueue: s.lastfmQueue.filter((q) => !sent.includes(q)),
      lastfmScrobbled: s.lastfmScrobbled + sent.length,
      lastfmError: '',
    }));
  } catch (e) {
    const msg = String(e);
    // Rejected session: the backend already dropped the key, ask the user to log in again.
    if (msg.includes('lastfm 9')) integrations.set({ lastfmUser: null });
    integrations.set({ lastfmError: msg });
  } finally {
    flushing = false;
  }
}

interface ListenSession {
  trackId: string;
  item: ScrobbleItem;
  listened: number;
  threshold: number | null;
  sent: boolean;
  lastT: number;
}
let listen: ListenSession | null = null;
let lastTick = performance.now();

function tickLastfm() {
  const now = performance.now();
  const delta = (now - lastTick) / 1000;
  lastTick = now;
  if (!lastfmReady()) return;
  const track = currentTrack();
  const s = player.get();
  if (!track || track.preview) return;
  const t = realCurTime();
  const restarted = listen?.trackId === track.id && listen.sent && t < 3 && listen.lastT > 10;
  if (!listen || listen.trackId !== track.id || restarted) {
    const d = dur();
    listen = {
      trackId: track.id,
      item: {
        artist: cleanArtist(track.artist),
        track: track.title,
        album: track.album || undefined,
        duration: d > 0 ? Math.round(d) : undefined,
        timestamp: Math.floor(Date.now() / 1000 - t),
      },
      listened: 0,
      threshold: scrobbleThreshold(d),
      sent: false,
      lastT: t,
    };
    if (s.playing) {
      invoke('lastfm_now_playing', { item: listen.item }).catch(() => {});
    }
  }
  listen.lastT = t;
  if (listen.threshold === null) {
    // Duration arrives after the stream loads.
    const d = dur();
    listen.threshold = scrobbleThreshold(d);
    if (d > 0) listen.item.duration = Math.round(d);
  }
  if (!s.playing || listen.sent || listen.threshold === null) return;
  listen.listened += creditedDelta(delta);
  if (listen.listened >= listen.threshold) {
    listen.sent = true;
    const item = { ...listen.item };
    integrations.set((st) => ({ lastfmQueue: [...st.lastfmQueue, item].slice(-500) }));
    void flushScrobbles();
  }
}

export function initIntegrations() {
  if (!inTauri()) return;
  player.subscribe(syncDiscord);
  integrations.subscribe(syncDiscord);
  // Catches seeks and late-arriving durations; presenceKey keeps this from spamming Discord.
  window.setInterval(syncDiscord, 3000);
  syncDiscord();

  invoke<string | null>('lastfm_status')
    .then((name) => integrations.set({ lastfmUser: name ?? null }))
    .then(() => flushScrobbles())
    .catch(() => {});
  window.setInterval(tickLastfm, 1000);
  window.setInterval(() => void flushScrobbles(), 120_000);
  window.addEventListener('online', () => void flushScrobbles());
}
