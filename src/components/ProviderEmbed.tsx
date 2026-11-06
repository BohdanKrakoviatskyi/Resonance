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

function script(id: string, src: string): Promise<void> {
  const found = document.getElementById(id) as HTMLScriptElement | null;
  if (found?.dataset.loaded === 'true') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const element = found ?? Object.assign(document.createElement('script'), { id, src, async: true });
    element.addEventListener('load', () => { element.dataset.loaded = 'true'; resolve(); }, { once: true });
    element.addEventListener('error', () => reject(new Error(`Could not load ${id}`)), { once: true });
    if (!found) document.head.append(element);
  });
}

export function usesProviderEmbed(track: Track) {
  return track.source === 'youtube' && track.playback !== 'direct';
}

export function ProviderEmbed({ track }: { track: Track }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!usesProviderEmbed(track) || !host.current || !track.nativeId) return;
    let disposed = false;
    let unregister = () => {};
    let endedSent = false;
    let timer: number | undefined;
    let player: YouTubePlayer | undefined;
    let previousReady: (() => void) | undefined;
    let readyCallback: (() => void) | undefined;
    const clearTimer = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const report = (playing: boolean, loading: boolean, position = 0, duration = track.duration, ended = false) => {
      if (disposed) return;
      if (playing) endedSent = false;
      const endedNow = ended && !endedSent;
      if (endedNow) endedSent = true;
      publishProviderState({ playing, loading, position, duration, ended: endedNow });
    };

    if (track.source === 'youtube') {
      previousReady = window.onYouTubeIframeAPIReady;
      readyCallback = () => {
        previousReady?.();
        const YT = window.YT;
        if (disposed || !YT || !host.current) return;
        player = new YT.Player(host.current, {
          videoId: track.nativeId!, width: '100%', height: 270,
          playerVars: { autoplay: 0, controls: 1, playsinline: 1 },
          events: {
            onReady: ({ target }) => {
              if (disposed) {
                try { target.destroy(); } catch {}
                return;
              }
              timer = window.setInterval(() => {
                if (disposed) return;
                const state = target.getPlayerState();
                report(state === YT.PlayerState.PLAYING, state === YT.PlayerState.BUFFERING, target.getCurrentTime(), target.getDuration(), state === YT.PlayerState.ENDED);
              }, 500);
              unregister = registerProviderControls({
                play: () => target.playVideo(), pause: () => target.pauseVideo(),
                seek: (seconds) => target.seekTo(seconds, true), setVolume: (volume) => target.setVolume(volume * 100),
                destroy: () => { clearTimer(); try { target.destroy(); } catch {} },
              });
              report(false, false, target.getCurrentTime(), target.getDuration());
            },
            onStateChange: ({ target, data }) => {
              if (disposed) return;
              report(data === YT.PlayerState.PLAYING, data === YT.PlayerState.BUFFERING, target.getCurrentTime(), target.getDuration(), data === YT.PlayerState.ENDED);
            },
          },
        });
        void player;
      };
      window.onYouTubeIframeAPIReady = readyCallback;
      if (window.YT) readyCallback();
      else void script('youtube-iframe-api', 'https://www.youtube.com/iframe_api').catch(() => report(false, false));
    }

    return () => {
      disposed = true;
      clearTimer();
      unregister();
      unregister = () => {};
      if (readyCallback && window.onYouTubeIframeAPIReady === readyCallback) {
        window.onYouTubeIframeAPIReady = previousReady;
      }
      if (player) {
        try { player.destroy(); } catch {}
        player = undefined;
      }
    };
  }, [track.id, track.nativeId, track.source, track.duration]);
  return usesProviderEmbed(track) ? <div ref={host} className="provider-embed mt-4 min-h-[200px] w-full overflow-hidden rounded-2xl bg-surface-container-low" aria-label={`${track.source} player`} /> : null;
}
