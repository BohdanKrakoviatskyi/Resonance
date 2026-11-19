import Peer, { type DataConnection } from 'peerjs';
import { invoke } from '@tauri-apps/api/core';
import { createStore } from '../lib/util';
import { createRoomCode, normalizeRoomCode, parseHostState, peerIdForRoom, planSync, type HostState, type SharedTrack } from '../lib/listen-sync';
import { t } from '../lib/i18n';
import type { Track } from '../types';
import { registerTracks } from './library';
import { currentTrack, player, playQueue, realCurTime, seek, toggle, setPlaybackControlLock, withRemotePlayback } from './player';
import { snack } from './ui';

export type ListenStatus = 'idle' | 'preparing' | 'awaitingGuest' | 'awaitingHost' | 'connected';

export const listen = createStore({
  role: null as 'host' | 'guest' | null,
  status: 'idle' as ListenStatus,
  /** Short room code shared with the guest. */
  myCode: '',
  error: '',
  /** Guest: when the last host update arrived (ms). */
  lastSyncAt: 0,
});

let peer: Peer | null = null;
let connection: DataConnection | null = null;
let cleanup: (() => void)[] = [];
let unsupportedWarned = '';
let diagnosticSession = '';

function logListen(event: string, details = '') {
  const message = `[ListenTogether][${diagnosticSession || 'no-session'}] ${event}${details ? ` ${details}` : ''}`;
  console.info(message);
  if (import.meta.env.DEV) void invoke('frontend_log', { message }).catch(() => {});
}

function safeError(error: unknown, peerId?: string) {
  const failure = error as { type?: string; message?: string };
  const message = (failure.message || String(error))
    .replace(peerId || '\u0000', '[peer-id]')
    .replace(/resonance-[a-z0-9-]+/gi, '[peer-id]')
    .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '[peer-id]');
  return `type=${failure.type || 'unknown'} message=${JSON.stringify(message)}`;
}

function watchIce(channel: DataConnection, label: string) {
  channel.on('iceStateChanged', (state) => logListen(`${label}.ice`, `state=${state}`));
}

function peerDebugLog(level: number, ...parts: unknown[]) {
  const message = parts.map((part) => {
    if (part instanceof Error) return `${part.name}: ${part.message}`;
    if (part && typeof part === 'object') {
      return JSON.stringify(part, (key, value: unknown) =>
        /^(candidate|sdp|token|id|peer|connectionId)$/i.test(key) ? '[redacted]' : value,
      );
    }
    return String(part);
  }).join(' ')
    .replace(/resonance-[a-z0-9-]+/gi, '[peer-id]')
    .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '[peer-id]')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[redacted]');
  const levelName = level === 1 ? 'error' : level === 2 ? 'warn' : 'info';
  logListen(`peer.debug.${levelName}`, message.slice(0, 1000));
}

function clearListeners() {
  for (const fn of cleanup) fn();
  cleanup = [];
}

export function leaveSession() {
  const oldConnection = connection;
  const oldPeer = peer;
  clearListeners();
  connection = null;
  peer = null;
  setPlaybackControlLock(false);
  listen.set({ role: null, status: 'idle', myCode: '', error: '', lastSyncAt: 0 });
  oldConnection?.close();
  oldPeer?.destroy();
}

function finishSession(message?: string) {
  const wasConnected = listen.get().status === 'connected';
  leaveSession();
  if (message && wasConnected) snack(message);
}

function fail(error: unknown) {
  const failure = error as { type?: string; message?: string };
  logListen('session.failed', `${safeError(error)} status=${listen.get().status}`);
  const userMessage = failure.type === 'peer-unavailable'
    ? t('listenRoomNotFound')
    : failure.type === 'unavailable-id'
      ? t('listenRoomBusy')
      : failure.message || t('listenConnectionError');
  leaveSession();
  listen.set({ error: userMessage });
}

function hostSnapshot(): HostState {
  return { type: 'state', track: shareable(currentTrack()), playing: player.get().playing, pos: realCurTime() };
}

function shareable(track: Track | null): SharedTrack | null {
  if (!track) return null;
  const { id, title, artist, album, cover, src, duration, nativeId, source } = track;
  return { id, title, artist, album, cover: cover?.startsWith('https://') ? cover : undefined, src, duration, nativeId, source };
}

function startBroadcast(channel: DataConnection) {
  let last = '';
  const send = (force = false) => {
    if (!channel.open) return;
    const snapshot = hostSnapshot();
    const key = `${snapshot.track?.id}|${snapshot.playing}|${Math.round(snapshot.pos)}`;
    if (!force && key === last) return;
    last = key;
    void channel.send(snapshot);
  };
  const unsubscribe = player.subscribe(() => send());
  const interval = window.setInterval(() => send(true), 2000);
  cleanup.push(unsubscribe, () => clearInterval(interval));
  send(true);
}

function applyHostState(remote: HostState) {
  const state = player.get();
  const current = currentTrack();
  const actions = planSync({ trackId: current?.id ?? null, playing: state.playing, pos: realCurTime() }, remote);
  for (const action of actions) {
    if (action.kind === 'load') {
      registerTracks([action.track as Track]);
      withRemotePlayback(() => playQueue([action.track.id], 0));
      // Seek after the stream has loaded, then mirror the host's play/pause state.
      let unsubscribe = () => {};
      unsubscribe = player.subscribe(() => {
        const next = player.get();
        if (next.state !== 'playing' && next.state !== 'paused') return;
        unsubscribe();
        withRemotePlayback(() => {
          if (action.pos > 2) seek(action.pos);
          if (!action.playing && next.playing) toggle();
        });
      });
      const timeout = window.setTimeout(unsubscribe, 20000);
      cleanup.push(() => { clearTimeout(timeout); unsubscribe(); });
    } else if (action.kind === 'seek') withRemotePlayback(() => seek(action.pos));
    else if (action.kind === 'play' || action.kind === 'pause') withRemotePlayback(() => toggle());
    else if (action.kind === 'unsupported' && unsupportedWarned !== action.track.id) {
      unsupportedWarned = action.track.id;
      snack(t('listenLocalTrack', { title: action.track.title }));
    }
  }
}

function acceptGuest(channel: DataConnection) {
  logListen('host.guest-offer', `status=${listen.get().status}`);
  watchIce(channel, 'host.connection');
  if (listen.get().status === 'connected' || connection) {
    logListen('host.guest-rejected', 'reason=already-connected');
    channel.close();
    return;
  }
  connection = channel;
  channel.on('open', () => {
    if (connection !== channel) return;
    logListen('host.connection.open');
    listen.set({ status: 'connected' });
    snack(t('listenConnected'));
    startBroadcast(channel);
  });
  channel.on('close', () => {
    logListen('host.connection.close', `open=${channel.open}`);
    if (connection === channel) finishSession(t('listenEnded'));
  });
  channel.on('error', (error) => {
    logListen('host.connection.error', safeError(error));
    if (connection === channel) fail(error);
  });
}

function makePeer(id?: string): Peer {
  logListen('peer.create', `requestedId=${Boolean(id)}`);
  const options = { debug: import.meta.env.DEV ? 3 : 0, logFunction: peerDebugLog };
  const instance = id ? new Peer(id, options) : new Peer(options);
  peer = instance;
  instance.on('open', () => logListen('peer.open'));
  instance.on('error', (error) => {
    logListen('peer.error', safeError(error));
    if (peer === instance && error.type !== 'unavailable-id') fail(error);
  });
  instance.on('disconnected', () => {
    logListen('peer.disconnected', `status=${listen.get().status}`);
    if (peer === instance && listen.get().status !== 'connected') fail(new Error(t('listenConnectionError')));
  });
  instance.on('close', () => logListen('peer.close'));
  return instance;
}

function waitForPeerOpen(instance: Peer, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      logListen('peer.open.timeout', `timeoutMs=${timeoutMs}`);
      instance.off('open', onOpen);
      instance.off('error', onError);
      reject(new Error(t('listenConnectionError')));
    }, timeoutMs);
    const onOpen = (id: string) => {
      clearTimeout(timer);
      instance.off('error', onError);
      resolve(id);
    };
    const onError = (error: Error & { type?: string }) => {
      if (error.type === 'unavailable-id') {
        clearTimeout(timer);
        instance.off('open', onOpen);
        reject(error);
      }
    };
    instance.on('open', onOpen);
    instance.on('error', onError);
  });
}

export async function startHosting() {
  diagnosticSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  logListen('host.start');
  leaveSession();
  listen.set({ role: 'host', status: 'preparing', error: '' });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = createRoomCode();
      const instance = makePeer(peerIdForRoom(code));
      try {
        await waitForPeerOpen(instance);
        instance.on('connection', acceptGuest);
        logListen('host.ready');
        listen.set({ status: 'awaitingGuest', myCode: code });
        return;
      } catch (error) {
        instance.destroy();
        if ((error as { type?: string }).type !== 'unavailable-id' || attempt === 4) throw error;
      }
    }
  } catch (error) {
    fail(error);
  }
}

export async function joinSession(rawCode: string) {
  diagnosticSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  logListen('guest.start');
  const code = normalizeRoomCode(rawCode);
  if (!code) {
    listen.set({ error: t('listenBadCode') });
    return;
  }
  leaveSession();
  setPlaybackControlLock(true);
  listen.set({ role: 'guest', status: 'preparing', error: '' });
  try {
    const instance = makePeer();
    await waitForPeerOpen(instance);
    logListen('guest.peer.ready');
    const remote = instance.connect(peerIdForRoom(code), { reliable: true, label: 'listen-together' });
    connection = remote;
    watchIce(remote, 'guest.connection');
    remote.on('open', () => {
      if (connection !== remote) return;
      logListen('guest.connection.open');
      listen.set({ status: 'connected' });
      snack(t('listenConnected'));
    });
    remote.on('data', (value) => {
      if (connection !== remote) return;
      logListen('guest.data');
      const snapshot = parseHostState(value);
      if (!snapshot) return;
      listen.set({ lastSyncAt: Date.now() });
      applyHostState(snapshot);
    });
    remote.on('close', () => {
      logListen('guest.connection.close', `open=${remote.open}`);
      if (connection === remote) finishSession(t('listenEnded'));
    });
    remote.on('error', (error) => {
      logListen('guest.connection.error', safeError(error));
      if (connection === remote) fail(error);
    });
    logListen('guest.connect.requested');
    const timeout = window.setTimeout(() => {
      if (listen.get().status === 'preparing') {
        logListen('guest.connect.timeout', 'timeoutMs=25000');
        fail(new Error(t('listenConnectionError')));
      }
    }, 25000);
    cleanup.push(() => clearTimeout(timeout));
  } catch (error) {
    fail(error);
  }
}
