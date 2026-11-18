import { createStore } from '../lib/util';
import { decodeCode, encodeCode, planSync, type HostState, type SharedTrack } from '../lib/listen-sync';
import { t } from '../lib/i18n';
import type { Track } from '../types';
import { registerTracks } from './library';
import { currentTrack, player, playQueue, realCurTime, seek, toggle } from './player';
import { snack } from './ui';

/**
 * Serverless "listen together": a WebRTC data channel set up by exchanging two codes
 * (invite → answer) through any messenger. The host leads; the guest mirrors its player.
 */
export type ListenStatus = 'idle' | 'preparing' | 'awaitingAnswer' | 'awaitingHost' | 'connected';

export const listen = createStore({
  role: null as 'host' | 'guest' | null,
  status: 'idle' as ListenStatus,
  /** Code to send to the other person (invite for host, answer for guest). */
  myCode: '',
  error: '',
  /** Guest: when the last host update arrived (ms). */
  lastSyncAt: 0,
});

const ICE: RTCConfiguration = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] };

let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let cleanup: (() => void)[] = [];

function waitIce(conn: RTCPeerConnection, ms = 4000): Promise<void> {
  if (conn.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      conn.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => conn.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, ms);
    conn.addEventListener('icegatheringstatechange', check);
  });
}

export function leaveSession() {
  for (const f of cleanup) f();
  cleanup = [];
  dc?.close();
  pc?.close();
  dc = null;
  pc = null;
  listen.set({ role: null, status: 'idle', myCode: '', error: '', lastSyncAt: 0 });
}

/** The data channel closes as soon as the other side leaves; ICE "disconnected" can take ~30 s. */
function watchClose(channel: RTCDataChannel) {
  channel.addEventListener('close', () => {
    if (dc !== channel) return;
    if (listen.get().status === 'connected') snack(t('listenEnded'));
    leaveSession();
  });
}

function fail(e: unknown) {
  leaveSession();
  listen.set({ error: e instanceof Error ? e.message : String(e) });
}

function newPeer() {
  leaveSession();
  pc = new RTCPeerConnection(ICE);
  pc.addEventListener('connectionstatechange', () => {
    const st = pc?.connectionState;
    if (st === 'failed' || st === 'closed' || st === 'disconnected') {
      if (listen.get().status === 'connected') snack(t('listenEnded'));
      leaveSession();
    }
  });
  return pc;
}

/* ---------------- host ---------------- */

function shareable(tr: Track | null): SharedTrack | null {
  if (!tr) return null;
  const { id, title, artist, album, cover, src, duration, nativeId, source } = tr;
  return { id, title, artist, album, cover: cover?.startsWith('https://') ? cover : undefined, src, duration, nativeId, source };
}

function hostSnapshot(): HostState {
  const s = player.get();
  return { type: 'state', track: shareable(currentTrack()), playing: s.playing, pos: realCurTime() };
}

function startBroadcast(channel: RTCDataChannel) {
  let last = '';
  const send = (force = false) => {
    if (channel.readyState !== 'open') return;
    const snap = hostSnapshot();
    const key = `${snap.track?.id}|${snap.playing}|${Math.round(snap.pos)}`;
    if (!force && key === last) return;
    last = key;
    channel.send(JSON.stringify(snap));
  };
  const unsub = player.subscribe(() => send());
  // Periodic heartbeat keeps the guest aligned after seeks and drift.
  const iv = window.setInterval(() => send(true), 2000);
  cleanup.push(unsub, () => clearInterval(iv));
  send(true);
}

export async function startHosting() {
  try {
    const conn = newPeer();
    listen.set({ role: 'host', status: 'preparing', error: '' });
    dc = conn.createDataChannel('sync', { ordered: true });
    watchClose(dc);
    dc.addEventListener('open', () => {
      listen.set({ status: 'connected', myCode: '' });
      snack(t('listenConnected'));
      startBroadcast(dc!);
    });
    await conn.setLocalDescription(await conn.createOffer());
    await waitIce(conn);
    listen.set({ status: 'awaitingAnswer', myCode: await encodeCode(conn.localDescription!.toJSON()) });
  } catch (e) {
    fail(e);
  }
}

export async function acceptAnswer(code: string) {
  try {
    if (!pc || listen.get().role !== 'host') throw new Error(t('listenBadCode'));
    const answer = await decodeCode(code);
    if (answer.type !== 'answer') throw new Error(t('listenBadCode'));
    await pc.setRemoteDescription(answer);
  } catch (e) {
    listen.set({ error: e instanceof Error && e.message !== 'bad code' ? e.message : t('listenBadCode') });
  }
}

/* ---------------- guest ---------------- */

let unsupportedWarned = '';

function applyHostState(remote: HostState) {
  const s = player.get();
  const cur = currentTrack();
  const actions = planSync({ trackId: cur?.id ?? null, playing: s.playing, pos: realCurTime() }, remote);
  for (const a of actions) {
    if (a.kind === 'load') {
      registerTracks([a.track as Track]);
      playQueue([a.track.id], 0);
      // Seek once the new stream has loaded, then mirror play/pause.
      const unsub = player.subscribe(() => {
        const st = player.get();
        if (st.state !== 'playing' && st.state !== 'paused') return;
        unsub();
        if (a.pos > 2) seek(a.pos);
        if (!a.playing && st.playing) toggle();
      });
      window.setTimeout(unsub, 20000);
    } else if (a.kind === 'seek') seek(a.pos);
    else if (a.kind === 'play' || a.kind === 'pause') toggle();
    else if (a.kind === 'unsupported' && unsupportedWarned !== a.track.id) {
      unsupportedWarned = a.track.id;
      snack(t('listenLocalTrack', { title: a.track.title }));
    }
  }
}

export async function joinSession(code: string) {
  try {
    const offer = await decodeCode(code).catch(() => {
      throw new Error(t('listenBadCode'));
    });
    if (offer.type !== 'offer') throw new Error(t('listenBadCode'));
    const conn = newPeer();
    listen.set({ role: 'guest', status: 'preparing', error: '' });
    conn.addEventListener('datachannel', (ev) => {
      dc = ev.channel;
      watchClose(dc);
      dc.addEventListener('open', () => {
        listen.set({ status: 'connected', myCode: '' });
        snack(t('listenConnected'));
      });
      dc.addEventListener('message', (m) => {
        try {
          const msg = JSON.parse(String(m.data)) as HostState;
          if (msg?.type === 'state') {
            listen.set({ lastSyncAt: Date.now() });
            applyHostState(msg);
          }
        } catch {
          /* ignore malformed messages */
        }
      });
    });
    await conn.setRemoteDescription(offer);
    await conn.setLocalDescription(await conn.createAnswer());
    await waitIce(conn);
    listen.set({ status: 'awaitingHost', myCode: await encodeCode(conn.localDescription!.toJSON()) });
  } catch (e) {
    fail(e);
  }
}
