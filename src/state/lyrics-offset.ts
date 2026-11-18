import { createStore, persist, useStore } from '../lib/util';

/** Per-track lyrics timing shift in seconds. Positive = lines appear later. */
export const lyricsOffsets = createStore({ byTrack: {} as Record<string, number> });

export const LYRICS_OFFSET_STEP = 0.25;
const LIMIT = 30;

export const getLyricsOffset = (trackId: string): number => lyricsOffsets.get().byTrack[trackId] ?? 0;
export const useLyricsOffset = (trackId: string): number => useStore(lyricsOffsets, (s) => s.byTrack[trackId] ?? 0);

export function setLyricsOffset(trackId: string, seconds: number) {
  const v = Math.round(Math.max(-LIMIT, Math.min(LIMIT, seconds)) * 100) / 100;
  lyricsOffsets.set((s) => {
    const byTrack = { ...s.byTrack };
    if (v === 0) delete byTrack[trackId];
    else byTrack[trackId] = v;
    return { byTrack };
  });
}

export const nudgeLyricsOffset = (trackId: string, delta: number) => setLyricsOffset(trackId, getLyricsOffset(trackId) + delta);

persist('resonance.lyrics_offset.v1', lyricsOffsets, (s) => ({ byTrack: s.byTrack }));
