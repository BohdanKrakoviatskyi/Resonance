import { invoke } from '@tauri-apps/api/core';
import { createStore, persist } from '../lib/util';
import { buildPresence, presenceKey, type PresenceInput } from '../lib/presence-plan';
import { currentTrack, dur, player, realCurTime } from './player';

export const integrations = createStore({
  discordEnabled: false,
  /** Application ID from https://discord.com/developers/applications. */
  discordClientId: '',
  /** Last error from the Discord bridge, for the settings page. Not persisted. */
  discordError: '' as string,
});

persist('resonance.integrations.v1', integrations, (s) => ({
  discordEnabled: s.discordEnabled,
  discordClientId: s.discordClientId,
}));

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const isValidDiscordId = (id: string) => /^\d{17,20}$/.test(id.trim());

let lastKey = '';

function send(clientId: string, track: ReturnType<typeof buildPresence> | null) {
  invoke('discord_set_presence', { clientId, track })
    .then(() => integrations.get().discordError && integrations.set({ discordError: '' }))
    .catch((e) => integrations.set({ discordError: String(e) }));
}

function syncDiscord() {
  const { discordEnabled, discordClientId } = integrations.get();
  const id = discordClientId.trim();
  const track = currentTrack();
  const s = player.get();
  if (!discordEnabled || !isValidDiscordId(id) || !track || s.state === 'idle' || s.state === 'error') {
    if (lastKey !== 'clear') {
      lastKey = 'clear';
      send(id, null);
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
    src: track.src,
    playing: s.playing,
    position: realCurTime(),
    duration: dur(),
  };
  const key = `${id}|${presenceKey(input, now)}`;
  if (key === lastKey) return;
  lastKey = key;
  send(id, buildPresence(input, now));
}

export function initIntegrations() {
  if (!inTauri()) return;
  player.subscribe(syncDiscord);
  integrations.subscribe(syncDiscord);
  // Catches seeks and late-arriving durations; presenceKey keeps this from spamming Discord.
  window.setInterval(syncDiscord, 3000);
  syncDiscord();
}
