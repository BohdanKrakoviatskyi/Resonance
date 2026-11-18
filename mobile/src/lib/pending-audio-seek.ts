export type PendingAudioSeek = { trackId: string; seconds: number };

export function createPendingAudioSeek(trackId: string, seconds: number, providerPlayback = false): PendingAudioSeek | null {
  return !providerPlayback && trackId && seconds > 0 ? { trackId, seconds } : null;
}

export function pendingAudioSeekFor(pending: PendingAudioSeek | null, trackId: string): number | null {
  return pending?.trackId === trackId ? pending.seconds : null;
}
