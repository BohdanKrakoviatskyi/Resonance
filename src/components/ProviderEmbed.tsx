import { useEffect, useRef } from 'react';
import { publishProviderState, registerProviderControls } from '../lib/provider-player';
import type { Track } from '../types';

type YouTubePlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  destroy(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
};
type YouTubeAPI = { Player: new (element: HTMLElement, options: { videoId: string; width: string; height: number; playerVars: Record<string, number>; events: Record<string, (event: { target: YouTubePlayer; data?: number }) => void> }) => YouTubePlayer; PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number } };

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: YouTubeAPI;
  }
}

let youtubeApi: Promise<YouTubeAPI> | undefined;

function loadYouTubeApi(): Promise<YouTubeAPI> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  youtubeApi ??= new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      if (window.YT?.Player) resolve(window.YT);
    };
    const element = Object.assign(document.createElement('script'), { id: 'youtube-iframe-api', src: 'https://www.youtube.com/iframe_api', async: true });
    element.addEventListener('error', () => {
      element.remove();
      youtubeApi = undefined;
      reject(new Error('Could not load youtube-iframe-api'));
    }, { once: true });
    document.head.append(element);
  });
  return youtubeApi;
}

export function usesProviderEmbed(track: Track) {
  return track.source === 'youtube' && track.playback !== 'direct';
}

export function ProviderEmbed({ track }: { track: Track }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!usesProviderEmbed(track) || !host.current || !track.nativeId) return;
    const videoId = track.nativeId;
    const duration = track.duration;
    let disposed = false;
    let endedSent = false;
    let timer: number | undefined;
    let player: YouTubePlayer | undefined;
    const el = host.current;
    let unregister = () => {};
    const clearTimer = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const report = (playing: boolean, loading: boolean, position = 0, length = duration, ended = false) => {
      if (disposed) return;
      if (playing) endedSent = false;
      const endedNow = ended && !endedSent;
      if (endedNow) endedSent = true;
      publishProviderState({ playing, loading, position, duration: length, ended: endedNow });
    };
    const destroyPlayer = () => {
      clearTimer();
      const current = player;
      player = undefined;
      if (current) {
        try { current.destroy(); } catch {}
      }
      el.replaceChildren();
    };

    if (track.source === 'youtube') {
      report(false, true, 0);
      loadYouTubeApi().then((YT) => {
        if (disposed) return;
        const isActive = (state: number) => state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING;
        const sample = (target: YouTubePlayer) => {
          const state = target.getPlayerState();
          const length = target.getDuration();
          report(state === YT.PlayerState.PLAYING, state === YT.PlayerState.BUFFERING, target.getCurrentTime(), Number.isFinite(length) && length > 0 ? length : duration, state === YT.PlayerState.ENDED);
          return state;
        };
        const tick = () => {
          if (player && !isActive(sample(player))) clearTimer();
        };
        const syncTimer = (state: number) => {
          if (!isActive(state)) return clearTimer();
          if (timer === undefined) timer = window.setInterval(tick, 500);
        };
        const mount = document.createElement('div');
        el.append(mount);
        player = new YT.Player(mount, {
          videoId, width: '100%', height: 270,
          playerVars: { autoplay: 0, controls: 1, playsinline: 1 },
          events: {
            onReady: ({ target }) => {
              if (disposed) return;
              unregister = registerProviderControls({
                play: () => target.playVideo(), pause: () => target.pauseVideo(),
                seek: (seconds) => target.seekTo(seconds, true), setVolume: (volume) => target.setVolume(volume * 100),
                destroy: destroyPlayer,
              });
              syncTimer(sample(target));
            },
            onStateChange: ({ target }) => {
              if (disposed) return;
              syncTimer(sample(target));
            },
            onError: () => {
              if (disposed) return;
              clearTimer();
              report(false, false, 0);
            },
          },
        });
      }).catch(() => report(false, false));
    }

    return () => {
      disposed = true;
      unregister();
      unregister = () => {};
      destroyPlayer();
    };
  }, [track.id, track.nativeId, track.source]);
  return usesProviderEmbed(track) ? <div ref={host} className="provider-embed mt-4 min-h-[200px] w-full overflow-hidden rounded-2xl bg-surface-container-low" aria-label={`${track.source} player`} /> : null;
}
